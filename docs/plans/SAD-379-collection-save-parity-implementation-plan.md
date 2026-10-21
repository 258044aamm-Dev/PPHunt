# SAD-379 — Implementation plan (Plan Only): make collection store what a save stores

> **Ticket:** [SAD-379](https://linear.app/sad-mod/issue/SAD-379/automatic-mode-and-manual-mode) · Priority 1 · `Bug`
> **Decision taken (2026-10-21):** "both engines" = **the collection pipeline and the
> save pipeline** (not Amazon/Temu). Goal: **make them the same.**
> **Status: PLAN ONLY.** No `src/` change has been made. Baseline: `tsc` clean,
> `wxt build` 1.99 MB, **1193 tests / 101 files** green.
> Investigation this builds on: `docs/plans/SAD-379-collection-vs-save-extraction-parity-plan.md`.

---

## 0. Review of the fast answer — three things it leaves open, one of them important

You said "make both engines the same", and confirmed it means collection ↔ save.
That fixes the *goal*. It does not fix the *definition*, and there is one expectation
I want to correct before a line is written.

### 0.1 "The same" is true at three levels. Only one of them is the data.

| Level | What "same" would mean | Today |
|---|---|---|
| **Data** | a collected row carries the same fields a saved row carries | 7 vs median 19 — **this is your complaint, and it is fixable** |
| **Write policy** | re-collecting refreshes price/rating like re-saving does | collection is strictly fill-only, save refreshes volatile fields — **a deliberate design choice, not a bug** (§4 G2) |
| **Stored history** | collection also writes snapshots | saves write 2 snapshots per product, collection 0 — **invisible to the UI** (§4 G3) |

The plan below makes the **data** identical (§2), recommends leaving write policy
alone (§5.1), and offers stored-history parity as an opt-in decision (§9 Q3).

### 0.2 Important: "the same" cannot mean "fully populated"

Even a right-click save does **not** end up complete today. Measured from your own log
(80 saves, `[MEASURED]` in the investigation):

| | Saves | Collection |
|---|---|---|
| fields after the card parse | 7 | 7 |
| fields after enrichment | **median 19** (min 7, max 23) | — (**stage absent**) |
| enrichment outcome | 28 `complete` / **42 `partial`** / 10 `failed` | n/a |

So **"the same" must be defined as "same pipeline, same attempt, same policy"** — not
"both reach 24/24". The reasons saves still fall short are already ticketed in
`SAD-370` (3 MB fetch cap rejecting 11% of pages; ~60% of PDPs served without a
featured offer). Making collection identical to save inherits exactly those limits,
which is the honest outcome — and it means SAD-370 and SAD-379 should ship in that
order for the visible result to be as good as it can be.

### 0.3 "Fast" — what that means concretely

The fast path needs **no new pipeline**: `enrichSavedProduct()` already does the fetch,
the offscreen parse, the 22-field merge, the row update by `[sessionKey+asin]`, the
detail snapshot and the diagnostics line, and it already throttles itself to 2 in
flight. The whole feature is **a small queue in the background handler plus one
setting** (§3). Estimated diff: **~120 lines of source + ~150 lines of tests**, three
commits.

### 0.4 Decisions taken (operator, 2026-10-21)

| # | Decision | Answer | Effect on this plan |
|---|---|---|---|
| **Q1** | Default state | **Off / opt-in** | as already written in §3.3 — every existing run and test is untouched |
| **Q2** | Cap per run | **Configurable** (25 / 50 / All) | **plan changed**: the cap becomes a second setting, not a constant (§3.3, §7.3) |
| **Q3** | Listing snapshots for collections | **No** | pump never calls `appendSnapshot` for the listing capture; only the detail snapshot `enrichSavedProduct` writes for free |
| **Q4** | Per-row "details fetched" feedback | **Later** | no UI step; §5.2 stands |
| **Q5** | Sequencing vs SAD-370 | **SAD-370 first** | new §10.1: SAD-379 starts after SAD-370 Phase 1 (+6a) lands |

---

## 1. What "same" means, made testable

| # | Acceptance criterion | How it is proved |
|---|---|---|
| A1 | For the same ASIN on the same page, the collected row and the saved row have **identical populated field sets** | differential test: run `PRODUCTS_COLLECTED` and `SAVE_PRODUCT` on the same fixture with the same stubbed enrichment, then deep-equal the two stored rows |
| A2 | The enrichment stage that runs for a save **also runs for a collected product**, via the same function, merge policy, and snapshot rule | `enrichSavedProduct` is the only caller-injected dep for both paths |
| A3 | With the setting off, a collection run is **byte-identical to today** | existing 1193 tests unchanged + a new test asserting `enrich` is never called |
| A4 | A failed/skipped enrichment leaves the collected row at card quality | reuse `enrich-saved-product.ts:22-24` guarantee + a test |
| A5 | Manual and automatic modes behave identically | both go through `processProductsCollected`; no mode branch is added |

---

## 2. The parity contract (canonical = what a save produces)

Whatever a save does, collection must do. Concretely, the four steps of the save
pipeline and their collection equivalent **after** this change:

| Step | Save path (canonical) | Collection today | Collection after |
|---|---|---|---|
| 1. Card/PDP parse | `parseAmazonSearchCard ?? parseAmazonCategoryCard` | `parseAmazonSearchResults` / `parseAmazonCategoryPage` → *same two functions* | unchanged |
| 2. Row write | `saveQuickProduct` → `upsertProductFromQuickSave` | `addProducts` (fill-only) | unchanged (§5.1) |
| 3. **Detail fetch + offscreen parse + 22-field merge** | `enrichSavedProduct` | **— missing —** | **`enrichSavedProduct`, per collected ASIN** |
| 4. Detail snapshot | `appendSnapshot(source:'detail')` | — | same call (comes free with step 3) |

Steps 3-4 are what SAD-379 is about. Step 3 is a single function call; step 4 is inside
it.

---

## 3. Fast-path design (recommended)

### 3.1 Shape

```
PRODUCTS_COLLECTED  (per batch, during the run)
      │
      ▼
processProductsCollected()                      handler.ts:429   [unchanged]
      ├─ validateAndNormalize… → addProducts()   handler.ts:560   [unchanged]
      └─ deps.enqueueEnrichment(validProducts, active.sessionKey)   ← NEW, 1 line
                │
                ▼
      enrichment-pump.ts (≈70 lines, background-only)                ← NEW FILE
        · one queue, one runner (never blocks pendingProductsChain)
        · dedupe per (sessionKey, asin)  → later batches can't repeat work
        · deterministic jobId            → snapshot write stays idempotent
        · stops the whole queue on `skipped:circuit-open`
        · cap per run
                │
                ▼
      enrichSavedProduct({ jobId, asin, productUrl, sessionKey })     [UNCHANGED]
        fetch → offscreen parse → mergeDetailIntoStored → db.update → snapshot
```

### 3.2 Why this is the minimal correct design

- **No new extraction code, no new merge logic.** `DETAIL_FIELDS`,
  `FILL_ONLY_FIELDS`, currency-mismatch protection, snapshot creation and the
  diagnostics line all come with `enrichSavedProduct`.
- **No risk of stalling the collection**: the pump is fire-and-forget, outside
  `pendingProductsChain` (`handler.ts:204`), so `STOP_COLLECTION` and progress
  messages never wait on a 2.4 s HTTP fetch.
- **No resurrection of deleted rows**: the function already looks the row up by
  `[sessionKey+asin]` and returns `failed/row-missing` rather than re-creating it.
- **No erasing of data**: the merge is non-null, detail-authoritative only for
  `DETAIL_FIELDS`, and the price family is fill-only (`enrich-saved-product.ts:120-160`).
- **Idempotent snapshots**: `appendSnapshot` dedupes on `(asin, jobId, source)`
  (`db/quick-save.ts:212-235`), so a deterministic `jobId` per `(sessionKey, asin)`
  makes a repeated pump harmless.

### 3.3 The settings gate (two settings, both off/neutral by default)

Follow the exact pattern the repo already uses for the diagnostics switch
(`utils/diagnostics-flag.ts` + `constants/diagnostics.ts`): values in `AmazonSettings`,
mirrored into `storage.local` for a **synchronous** cached read in the worker, with
`storage.onChanged` keeping them live. One reader returns both values, so the hot path
costs one storage read, not two:

```ts
// utils/enrich-collected-flag.ts (new, ~25 lines, modelled on diagnostics-flag.ts)
export interface EnrichCollectedSettings { enabled: boolean; limit: number }
export function getEnrichCollectedSettings(): EnrichCollectedSettings;   // cached, sync
export function subscribeEnrichCollected(): () => void;                 // storage.onChanged
// limit resolution: 'all' → Number.POSITIVE_INFINITY, '25' | '50' → 25 / 50
```

| Setting | Type | Default | Why |
|---|---|---|---|
| `enrichCollectedProducts` | `boolean` | **`false`** (Q1) | every existing collection run and all 1193 tests stay identical; parity starts the moment it is switched on |
| `enrichCollectedLimit` | `'25' \| '50' \| 'all'` (Q2) | **`'50'`** | bounds a 300-target run; the choice is shown in Settings rather than baked in |

**Cap as a string enum, not a number.** The house style for a bounded choice is a string
enum (`exportImages: z.enum(['auto','always','never'])`,
`quickSaveCollectionBehavior: z.enum(['current','new','ask'])` — `schemas/settings.ts:107-110`),
so the schema stays a plain `z.enum(['25','50','all'])`, the radio values map 1:1, and the
conversion lives in one place (`'all' → Infinity`) instead of a `z.transform`. The cap is
ignored while `enrichCollectedProducts` is off.

---

## 4. The parity gap, item by item (what this plan does and does not touch)

| # | Gap | Visible to you? | Stored difference? | In this plan |
|---|---|---|---|---|
| G1 | **No enrichment stage in collection** | **yes — the whole complaint** | 12 fields median | **fixed** (§3) |
| G2 | Write policy: collection is fill-only, save refreshes volatile fields | yes, but only on *re-collect* of an ASIN you already have | refresh semantics | **left alone** (§5.1) |
| G3 | Snapshots: save writes `listing` + `detail`, collection writes none | no — nothing in the UI or export reads `db.snapshots` (verified: no `db.snapshots` reference under `ui/`) | 2 rows/product | **optional** (§9 Q3) |
| G4 | Per-row status: save emits `SAVE_JOB_UPDATE` (`extracting → enriching → completed/partial/failed`); collection emits only aggregate progress | yes (no feedback that details are arriving) | none | **out of scope** (§5.2) |
| G5 | Durability: saves resume via `job-store` + `save-job-recovery`; a collection pump is in-memory | only after a worker suspension mid-run | none | **documented limitation**, later |
| G6 | `[PPHunt] enrichment outcome` lines appear only for saves | diagnostics only | none | **fixed for free** — the pump calls the same function, so the lines appear (gated by the diagnostics switch) |

**Checked and cleared (so it is not chased later):** the product's own `source` field is
*not* a divergence. `'listing' | 'detail'` is the **snapshot** source
(`types/index.ts:247`, `db/quick-save.ts:383`), while the product row's `source`
(`'search' | 'category' | 'detail'`) is set by the parser on both paths.

---

## 5. What stays deliberately different (and why)

### 5.1 Write policy — do not unify
`addProducts` is fill-only **on purpose**: *"a full-page run must never mutate a row it
already wrote"* (`db/products.ts:12-16`). Making collection refresh volatile fields like
a save would change what a re-collect does to a row the user already curated — and that
is the exact class of regression this ticket must avoid. Recommend: leave it, and say so
in the CHANGELOG.

### 5.2 No per-row status in this pass
Collection progress is aggregate (`UPDATE_PROGRESS`), not per-product. Adding per-row
`SAVE_JOB_UPDATE`-style feedback is a UI feature (toast/card states), not a data parity
fix. If you want it, it is §9 Q4 and a separate step.

### 5.3 Failure is silent, by design
If enrichment fails, the row keeps its card data and the run continues. That matches the
save path's contract (`enrich-saved-product.ts:22-24`) and must not become a collection
error.

---

## 6. Cost, measured (so "fast" is not "free")

| Quantity | Value | Source |
|---|---|---|
| Per-product enrichment | median **2.36 s**, p90 3.0 s | 80 live outcomes in your log |
| Concurrency | 2 in flight (`MAX_CONCURRENT_ENRICHMENTS`) | `enrich-saved-product.ts:27` |
| 50-product run | ≈ **60 s** of background work | derived (50 × 2.36 / 2) |
| 160-product run | ≈ **3.2 min** of background work | derived |
| Real precedent | your session already did **80 enrichments (≈194 s)** with 1 captcha | your log — i.e. this is not new load |
| Breaker | 3 captchas, or 3 × 429/60 s → **60 s host cooldown** | `enrichment-fetch.ts:28-30` |
| Expected completeness per product | **median +12 fields** (7 → 19), not +17 | your log |
| Extra outbound requests | **1 per collected product** (2 if the retry fires) | `enrichment-fetch.ts:214` |

**Cap (now configurable, Q2):** the default is **50 per run** — it matches
`COLLECTION_DIAGNOSTICS_LIMIT`, bounds a 300-target run to ~1 minute of extra work, and
stays inside what your session already proved Amazon tolerates. `25` is offered for
cautious users; `All` removes the platform cap and leaves only the run's own target, with
the breaker still protecting the host.

---

## 7. Code changes (proposed diff — not applied)

### 7.1 `src/engines/amazon/background/enrichment-pump.ts` (new, ~70 lines)

```ts
/**
 * SAD-379: the collection pipeline's missing enrichment stage.
 *
 * The save pipeline calls `enrichSavedProduct` once per product; a collection
 * produces many products in batches and must not block on them. This pump is
 * the only new machinery: one queue, one runner, one call to the same function.
 */
import { enrichSavedProduct } from './enrich-saved-product';

export interface EnrichmentPumpDeps {
  enrich?: typeof enrichSavedProduct;
  limit?: (sessionKey: string) => number;
}

interface Queued {
  asin: string;
  productUrl: string;
  sessionKey: string;
}

const queue: Queued[] = [];
const seen = new Set<string>();       // `${sessionKey}::${asin}` — never twice per run
const counts = new Map<string, number>(); // sessionKey → queued
let running = false;
let enrichImpl: typeof enrichSavedProduct = enrichSavedProduct;

/** Deterministic, so `appendSnapshot` stays idempotent (asin+jobId+source). */
export function collectionEnrichmentJobId(sessionKey: string, asin: string): string {
  return `collect:${sessionKey}:${asin}`;
}

export function enqueueCollectionEnrichment(
  products: readonly { asin?: string | null; url?: string | null }[],
  sessionKey: string,
  deps: EnrichmentPumpDeps = {},
): void {
  if (deps.enrich) enrichImpl = deps.enrich;
  const limit = deps.limit?.(sessionKey) ?? Number.POSITIVE_INFINITY;

  for (const product of products) {
    const asin = product.asin;
    const productUrl = product.url;
    if (!asin || !productUrl) continue;
    const key = `${sessionKey}::${asin}`;
    if (seen.has(key)) continue;                       // later batches can't redo work
    const used = counts.get(sessionKey) ?? 0;
    if (used >= limit) break;                          // cap per run
    seen.add(key);
    counts.set(sessionKey, used + 1);
    queue.push({ asin, productUrl, sessionKey });
  }
  void run();
}

/** Stops queueing for a finished run so a new run starts clean. */
export function resetCollectionEnrichment(sessionKey: string): void {
  counts.delete(sessionKey);
  for (const key of seen) if (key.startsWith(`${sessionKey}::`)) seen.delete(key);
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const result = await enrichImpl({
          jobId: collectionEnrichmentJobId(item.sessionKey, item.asin),
          asin: item.asin,
          productUrl: item.productUrl,
          sessionKey: item.sessionKey,
        });
        // The host is out of service for a minute: every remaining item would
        // be skipped for the same reason, so drain instead of hammering.
        if (result.status === 'skipped') {
          queue.length = 0;
          break;
        }
      } catch {
        // The row keeps card quality; a failed enrichment is never a collection error.
      }
    }
  } finally {
    running = false;
  }
}
```

### 7.2 `src/engines/amazon/background/handler.ts` (3 small edits)

```diff
+import { enqueueCollectionEnrichment, resetCollectionEnrichment } from './enrichment-pump';
+import { getEnrichCollectedSettings } from '../utils/enrich-collected-flag';

  const processProductsCollected = async (
    payload: { products: unknown[]; totalCount: number; isNewBatch: boolean;
               extractionDiagnostics?: unknown[] },
    senderUrl?: string,
+   deps: { enrich?: typeof enrichSavedProduct } = {},
  ): Promise<void> => {
     ...
     if (validProducts.length > 0) {
       await addProducts(validProducts, active.sessionKey);
+      // SAD-379: the save pipeline's enrichment stage, applied to a collection.
+      // Off by default (A3); never awaited, so progress/STOP are unaffected.
+      const enrichCollected = getEnrichCollectedSettings();
+      if (enrichCollected.enabled && deps.enrich) {
+        enqueueCollectionEnrichment(validProducts, active.sessionKey, {
+          enrich: deps.enrich,
+          limit: () => enrichCollected.limit,   // resolved from '25' | '50' | 'all'
+        });
+      }
     }
```

and in the router (`:844`), pass the same dep the save path gets (`:863`):

```diff
-        void handleProductsCollected(validated.payload, sender?.tab?.url);
+        void handleProductsCollected(validated.payload, sender?.tab?.url, {
+          enrich: (input) => enrichSavedProduct(input),
+        });
```

and clear the per-run counters where a run ends (`handleStopCollection:390`,
`handleCollectionProgress` completed branch `:654`, and `startOrRetryCollection` `:301`):

```diff
     activeCollection = null;
     await clearActiveSession();
+    resetCollectionEnrichment(sessionKey);
```

### 7.3 Settings (3 small edits)

| File | Change |
|---|---|
| `constants/defaults.ts` | `export const DEFAULT_ENRICH_COLLECTED = false;` · `export const DEFAULT_ENRICH_COLLECTED_LIMIT: EnrichCollectedLimit = '50';` · `export const ENRICH_COLLECTED_LIMIT_OPTIONS = ['25','50','all'] as const;` |
| `schemas/settings.ts` | `enrichCollectedProducts: z.boolean().default(DEFAULT_ENRICH_COLLECTED)` and `enrichCollectedLimit: z.enum(ENRICH_COLLECTED_LIMIT_OPTIONS).default(DEFAULT_ENRICH_COLLECTED_LIMIT)` in `AmazonSettingsSchema`, both optional in `PartialAmazonSettingsSchema`. No `settingsVersion` bump — the schema is merged, exactly as SAD-349/357 added their keys |
| `utils/enrich-collected-flag.ts` (new, ~25 lines) | the cached reader for **both** values, copied from `utils/diagnostics-flag.ts` (synchronous getter + `storage.onChanged` subscribe + `'all' → Infinity`) |
| `ui/components/QuickSaveBehavior.tsx` (or a sibling `CollectionEnrichment.tsx`) | one toggle, plus a 3-option cap control. **Two precedents already in the repo:** the labelled `role="radiogroup"` in `QuickSaveBehavior.tsx:46-66` (title + description per option) and the chip row driven by `TARGET_QUICK_SELECT` in `TargetSelector.tsx:58-80`. The cap is a settings choice, so the radiogroup pattern fits; the chip styling is available if you prefer it |

### 7.4 Nothing else changes

No parser, no selector, no merge policy, no schema field, no message shape (the pump
lives entirely inside the worker), no Temu file.

---

## 8. Tests (fast but sufficient)

| File | Test |
|---|---|
| `tests/collection-enrichment-pump.test.ts` (new) | enqueues once per `(sessionKey, asin)`; a later `updatedExisting` batch does not repeat; **each cap option is honoured (`'25'` stops at 25, `'50'` at 50, `'all'` queues the whole run)**; a `skipped` result drains the queue; a thrown enrichment leaves the queue alive; `reset` isolates runs |
| `tests/collection-enrichment-wiring.test.ts` (new) | setting **off** → `enrich` never called and the stored rows deep-equal today's (both cap values); setting **on** → called once per new ASIN with `{asin, productUrl, sessionKey, jobId}` and never awaited before `UPDATE_PROGRESS` |
| `tests/settings-migration.test.ts` (existing) | a row stored **without** the two new keys parses to `false` / `'50'` — proves the no-migration-bump claim |
| `tests/collection-save-parity.test.ts` (new — the ticket's proof) | same fixture through `PRODUCTS_COLLECTED` and `SAVE_PRODUCT`, same stubbed enrichment ⇒ **the two stored rows deep-equal** (A1) |
| `tests/enrich-saved-product.test.ts` | unchanged — proves the reused stage is not modified |
| existing 1193 | must stay green unchanged (A3) |

---

## 9. Decisions — resolved 2026-10-21

| # | Question | Answer | Landed in |
|---|---|---|---|
| **Q1** | Default state | **Off / opt-in** | §3.3 |
| **Q2** | Cap per run | **Configurable:** 25 / 50 / All, default 50 | §3.3, §6, §7.3 |
| **Q3** | Listing snapshots for collections | **No** — the detail snapshot only (free, inside `enrichSavedProduct`) | §4 G3, §7.1 |
| **Q4** | Per-row status feedback | **Later** | §5.2 |
| **Q5** | Sequencing | **SAD-370 first** | §10.1 |

Nothing blocks step 1 any more.

---

## 10. Step plan (three commits, each gated by `npm run verify`)

| # | Commit | Files | Gate |
|---|---|---|---|
| 1 | `SAD-379 step 1: add the collection enrichment pump (off by default)` | `enrichment-pump.ts`, `handler.ts`, `enrich-collected-flag.ts`, `constants/defaults.ts`, `schemas/settings.ts` (both keys), pump + wiring tests | 1193 tests unchanged + new tests; setting off ⇒ zero behaviour change; each cap option tested |
| 2 | `SAD-379 step 2: expose the toggle and the 25 / 50 / All cap in Amazon Settings` | `QuickSaveBehavior.tsx` (or a sibling `CollectionEnrichment.tsx`), CHANGELOG | UI test; both controls take effect without a reload |
| 3 | `SAD-379 step 3: parity proof and docs` | `collection-save-parity.test.ts`, `ARCHITECTURE.md`, `CHANGELOG.md`, a measurement note | the differential test is green; a live run shows collected rows reaching save quality |

Rough size: **~120 lines src, ~150 lines tests, 3 commits.** That is the "fast" version
of making the two pipelines the same.

### 10.1 Sequencing with SAD-370 (Q5: SAD-370 first)

SAD-379 does not need SAD-370 to compile, but its **visible outcome** does, because
collection inherits whatever the enrichment stage can achieve:

| SAD-370 phase | Needed by SAD-379? | Why |
|---|---|---|
| **Phase 1 — 3 MB fetch cap → 5 MB** | **yes, strongly** | 9/80 pages fail *before* parsing today (`enrichment-fetch.ts:27`); collected products would inherit that 11% hole |
| **Phase 6a — offerless PDPs reported honestly** | **yes, for a trustworthy measurement** | 42/70 PDPs currently report `PARSE_FAILED`; after 6a the parity log says what actually happened |
| Phases 2, 3 (card layout, drift verdict) | no | diagnostics-only, different files |
| Phases 4, 5 (description, coupon/badge) | no | they improve *which* fields a PDP yields, which SAD-379 then inherits for free |

**Recommended order:** SAD-370 steps 1 and 6 → SAD-379 steps 1-3 → SAD-370 steps 4-5.

**File-conflict analysis (if they ever run in parallel):** SAD-370 touches
`enrichment-fetch.ts`, `product-detail.ts`, `selectors.ts`, `card-diagnostics.ts`,
`drift-telemetry.ts`; SAD-379 touches `handler.ts`, the new `enrichment-pump.ts` + its
flag module, `schemas/settings.ts`, `constants/defaults.ts` and one UI component. The only
shared file is `CHANGELOG.md`, so two branches merge cleanly apart from the changelog.

**Live proof for step 3:** the parity signal is `[PPHunt] enrichment outcome` lines
appearing with a `collect:<sessionKey>:<asin>` jobId. One real run then shows, per
product, the same `fieldsChanged` a save produces — the acceptance test in the real
world, not only in a fixture.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Breaker trips mid-run, the rest of the run stays card-quality | pump drains on the first `skipped`; the rows keep card data; a later re-collect or save gets a fresh attempt |
| 300-product run = 300 requests | default cap 50; the cap is a visible setting with a `25` option, and the breaker still protects the host under `All` |
| Worker suspended mid-pump | documented: the queue is in-memory, so the tail is lost. Rows are intact; nothing can be corrupted. The `job-store` + `save-job-recovery` pattern is the upgrade path if this proves painful (G5) |
| Duplicate work across batches | `seen` set keyed `(sessionKey, asin)` |
| Interference with `addProducts` of a later batch | `addProducts`/`enrichStoredProductFields` is null-fill-only, so it cannot erase an enriched value |
| Slower perceived collection | the pump runs beside, not inside, `pendingProductsChain`; `STOP_COLLECTION` never awaits it |

---

## 12. Summary

Collection does not need a new extraction engine — it needs the **one stage it is
missing**. `enrichSavedProduct` already is that stage, complete with the merge policy,
the snapshot and the diagnostics; the save path calls it once per product, and collection
calls it zero times. This plan adds a small, off-by-default queue in the
background that calls the same function for each newly collected ASIN, unawaited, with
dedupe, breaker-drain, and a run cap you choose in Settings (25 / 50 / All, default 50). Result: for the same product on the same page, a collected row
and a saved row become the same row — with the same limits (median +12 fields, not a
guaranteed 24/24) that saves already have, and with zero change to any existing
behaviour until the switch is turned on.
