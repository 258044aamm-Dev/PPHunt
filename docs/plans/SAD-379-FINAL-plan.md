# SAD-379 — FINAL PLAN: collection stores what a save stores

> **Status:** decision-complete, **plan only** — no `src/` file has been modified.
> **Supersedes for decisions:** `SAD-379-collection-vs-save-extraction-parity-plan.md`
> (root-cause investigation) and `SAD-379-collection-save-parity-implementation-plan.md`
> (first draft). Both stay in the repo as the evidence trail.
> **Related:** `SAD-370-extraction-gap-closure-plan.md` — the upstream work §7 sequences
> this behind.
> **Baseline (measured 2026-10-21):** `tsc --noEmit` clean · `wxt build` 1.99 MB ·
> **1193 tests / 101 files** green.

---

## 1. Goal, in one testable sentence

> A product collected by a run must end up **the same row** a right-click save of the
> same product on the same page ends up as — same pipeline, same attempt, same policy —
> and turning the feature on must change nothing except that outcome.

"Same" therefore means **same treatment**, not "fully populated". See §8 T3 for why that
distinction is load-bearing.

---

## 2. Root cause (settled; evidence in the investigation doc)

| Fact | Evidence |
|---|---|
| Collection and saves run the **same** card parsers and produce identical products | your log: `card` (80) and `collection-card` (74) reports are field-for-field and reason-for-reason identical — 7/24 extracted, same tiers |
| The save pipeline has a **second stage** collection lacks | `background/save-job.ts:330` → `enrichSavedProduct`; collection's `processProductsCollected` (`handler.ts:429-591`) ends at `addProducts` |
| That stage is passed in from exactly two places | `handler.ts:863` (`SAVE_PRODUCT`) and `save-job-recovery.ts:199` — never a collection branch |
| What it is worth, measured | **+12 fields median** per save (7 → 19); collected rows stayed at 7 |
| Manual vs automatic mode is irrelevant | `mode` only drives scrolling (`amazon.content.ts:478`); no parser branches on it |

**Root cause:** enrichment is a **save-only pipeline stage**. Nothing in the card parser
is worse.

---

## 3. Decisions (locked 2026-10-21)

| # | Decision | Answer |
|---|---|---|
| Q1 | Default state | **Off / opt-in** |
| Q2 | Cap per run | **Configurable:** `25` / `50` / `all`, default **`50`** |
| Q3 | Listing snapshots for collections | **No** |
| Q4 | Per-row "details fetched" feedback | **Later** (not this ticket) |
| Q5 | Sequencing vs SAD-370 | **SAD-370 first** |

---

## 4. Final design

### 4.1 One new module, three wiring edits, two settings

```
PRODUCTS_COLLECTED (per batch, during the run)
   │
   ▼
processProductsCollected()                        handler.ts:429   [unchanged logic]
   ├─ validateAndNormalize… → addProducts()        handler.ts:560   [unchanged]
   └─ if enabled → enqueueCollectionEnrichment()    ← NEW: 5 lines
             │
             ▼
   enrichment-pump.ts  (NEW, ~70 lines, background-only)
     · one queue, one serial runner — never blocks pendingProductsChain
     · dedupe per (sessionKey, asin)     → later batches cannot redo work
     · deterministic jobId               → snapshot write stays idempotent
     · run cap                            → '25' | '50' | 'all'
     · drains on first `skipped`          → breaker-open stops the queue
             │
             ▼
   enrichSavedProduct({ jobId, asin, productUrl, sessionKey })     [UNCHANGED]
     fetch → offscreen parse → mergeDetailIntoStored → db.update → detail snapshot
```

No new extraction, merge, snapshot or diagnostics code: `enrichSavedProduct` already
ownes all of it, and already self-throttles to 2 in flight
(`MAX_CONCURRENT_ENRICHMENTS`, `enrich-saved-product.ts:27`).

### 4.2 Settings (one cached reader for both values)

Following the repo's own diagnostics-switch pattern
(`utils/diagnostics-flag.ts` + `constants/diagnostics.ts`):

```ts
// utils/enrich-collected-flag.ts (new, ~25 lines)
export interface EnrichCollectedSettings { enabled: boolean; limit: number }
export function getEnrichCollectedSettings(): EnrichCollectedSettings;  // sync, cached
export function subscribeEnrichCollected(): () => void;                // storage.onChanged
// 'all' → Number.POSITIVE_INFINITY, '25' → 25, '50' → 50
```

| Setting | Type | Default | Reason |
|---|---|---|---|
| `enrichCollectedProducts` | `boolean` | `false` | every existing run and all 1193 tests stay identical until switched on |
| `enrichCollectedLimit` | `z.enum(['25','50','all'])` | `'50'` | house style for a bounded choice (`exportImages`, `quickSaveCollectionBehavior`, `schemas/settings.ts:107-110`); no `z.transform`, radio values map 1:1 |

No `settingsVersion` bump: the stored row is merged on parse, exactly as SAD-349/357
added their keys.

### 4.3 Final code — `background/enrichment-pump.ts`

```ts
/**
 * SAD-379: the collection pipeline's missing enrichment stage.
 *
 * The save pipeline calls `enrichSavedProduct` once per product. A collection
 * produces many products in batches and must not block on them, so this pump is
 * the only new machinery: one queue, one serial runner, one call to the same
 * function the save path uses.
 */
import { enrichSavedProduct } from './enrich-saved-product';

export interface EnrichmentPumpDeps {
  enrich?: typeof enrichSavedProduct;
  limit?: () => number;
}

interface Queued { asin: string; productUrl: string; sessionKey: string }

const queue: Queued[] = [];
const seen = new Set<string>();            // `${sessionKey}::${asin}`
const counts = new Map<string, number>(); // sessionKey → queued
let running = false;
let enrichImpl: typeof enrichSavedProduct = enrichSavedProduct;

/** Deterministic, so `appendSnapshot` (asin+jobId+source) stays idempotent. */
export function collectionEnrichmentJobId(sessionKey: string, asin: string): string {
  return `collect:${sessionKey}:${asin}`;
}

export function enqueueCollectionEnrichment(
  products: readonly { asin?: string | null; url?: string | null }[],
  sessionKey: string,
  deps: EnrichmentPumpDeps = {},
): void {
  if (deps.enrich) enrichImpl = deps.enrich;
  const limit = deps.limit?.() ?? Number.POSITIVE_INFINITY;

  for (const { asin, url } of products) {
    if (!asin || !url) continue;
    const key = `${sessionKey}::${asin}`;
    if (seen.has(key)) continue;                       // never twice per run
    if ((counts.get(sessionKey) ?? 0) >= limit) break; // cap
    seen.add(key);
    counts.set(sessionKey, (counts.get(sessionKey) ?? 0) + 1);
    queue.push({ asin, productUrl: url, sessionKey });
  }
  void run();
}

/** A finished run must not leak into the next one. */
export function resetCollectionEnrichment(sessionKey: string): void {
  counts.delete(sessionKey);
  for (const key of [...seen]) if (key.startsWith(`${sessionKey}::`)) seen.delete(key);
}

export function resetCollectionEnrichmentForTests(): void {
  queue.length = 0; seen.clear(); counts.clear(); running = false;
  enrichImpl = enrichSavedProduct;
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
        if (result.status === 'skipped') { queue.length = 0; break; }
      } catch {
        // A failed enrichment is never a collection error: the row keeps card
        // quality and the run continues.
      }
    }
  } finally {
    running = false;
  }
}
```

### 4.4 Final code — `background/handler.ts` (5 edits)

```diff
+import { enqueueCollectionEnrichment, resetCollectionEnrichment } from './enrichment-pump';
+import { getEnrichCollectedSettings } from '../utils/enrich-collected-flag';

  const processProductsCollected = async (
    payload: { products: unknown[]; totalCount: number; isNewBatch: boolean;
               extractionDiagnostics?: unknown[] },
    senderUrl?: string,
+   deps: { enrich?: typeof enrichSavedProduct } = {},
  ): Promise<void> => {
     …
     if (validProducts.length > 0) {
       await addProducts(validProducts, active.sessionKey);
+      // SAD-379: the save pipeline's enrichment stage, applied to a collection.
+      // Never awaited → progress and STOP_COLLECTION are unaffected.
+      const enrichCollected = getEnrichCollectedSettings();
+      if (enrichCollected.enabled && deps.enrich) {
+        enqueueCollectionEnrichment(validProducts, active.sessionKey, {
+          enrich: deps.enrich,
+          limit: () => enrichCollected.limit,
+        });
+      }
     }
```

```diff
 // router — the same dep the save path already gets (handler.ts:863)
-        void handleProductsCollected(validated.payload, sender?.tab?.url);
+        void handleProductsCollected(validated.payload, sender?.tab?.url, {
+          enrich: (input) => enrichSavedProduct(input),
+        });
```

Plus `resetCollectionEnrichment(sessionKey)` where a run ends:
`handleStopCollection` (after `clearActiveSession()`, ~`:426`), the `completed` branch of
`handleCollectionProgress` (~`:664`), and `startOrRetryCollection` (`:301`) so a new run
starts clean.

### 4.5 Final code — settings + UI

| File | Change |
|---|---|
| `constants/defaults.ts` | `DEFAULT_ENRICH_COLLECTED = false` · `DEFAULT_ENRICH_COLLECTED_LIMIT = '50'` · `ENRICH_COLLECTED_LIMIT_OPTIONS = ['25','50','all'] as const` |
| `schemas/settings.ts` | both keys in `AmazonSettingsSchema` (defaults above) + optional in `PartialAmazonSettingsSchema` |
| `ui/components/QuickSaveBehavior.tsx` or new `CollectionEnrichment.tsx` | one toggle + a 3-option cap control. Reuse the labelled `role="radiogroup"` already in `QuickSaveBehavior.tsx:46-66`; chip styling available from `TargetSelector.tsx:58-80` |

---

## 5. Change budget

| | Count |
|---|---|
| New source files | 2 (`enrichment-pump.ts`, `enrich-collected-flag.ts`) |
| Edited source files | 5 (`handler.ts`, `constants/defaults.ts`, `schemas/settings.ts`, 1 UI component, CHANGELOG/ARCHITECTURE) |
| New source lines | **~120** |
| New test lines | **~150** |
| Commits | **3** |
| Schema/message/protocol changes | 2 optional settings keys; **no message change** (the pump lives inside the worker) |
| Parser / selector / merge changes | **none** |

---

## 6. Tests

| File | Asserts |
|---|---|
| `tests/collection-enrichment-pump.test.ts` (new) | one enqueue per `(sessionKey, asin)`; later `updatedExisting` batches don't repeat; **`'25'` stops at 25, `'50'` at 50, `'all'` queues the run**; `skipped` drains; a throw keeps the queue alive; `reset` isolates runs |
| `tests/collection-enrichment-wiring.test.ts` (new) | setting off ⇒ `enrich` never called and stored rows deep-equal today's; on ⇒ called once per new ASIN with `{asin, productUrl, sessionKey, jobId}` and never awaited before `UPDATE_PROGRESS` |
| `tests/collection-save-parity.test.ts` (new — the ticket's proof) | same fixture through `PRODUCTS_COLLECTED` and `SAVE_PRODUCT`, same stubbed enrichment ⇒ **the two stored rows deep-equal** |
| `tests/settings-migration.test.ts` (existing) | a row stored without the new keys parses to `false` / `'50'` |
| the existing 1193 | must stay green **unchanged** |

---

## 7. Sequencing and gates

| Order | Work | Gate |
|---|---|---|
| **1** | **SAD-370 step 1** (3 MB cap → 5 MB, named size failure) | 9 previously-failing ASINs enrich; boundary tests pinned |
| **2** | **SAD-370 step 6a** (offerless PDPs report honestly) | rows byte-identical; statuses truthful |
| **3** | **SAD-379 step 1** (pump + 2 settings, off by default) | 1193 unchanged + new; setting off ⇒ zero behaviour change |
| **4** | **SAD-379 step 2** (toggle + cap in Settings) | UI test; live without reload |
| **5** | **SAD-379 step 3** (parity proof + docs) | differential test green; one live run shows collected rows reaching save quality |
| Later | SAD-370 steps 4-5 (description, coupon/badge) | improves what parity inherits, no SAD-379 change |

Steps 1-2 are prerequisites for a *meaningful* result, not for compilation (§8 T3).

---

## 8. Trade-off register — what we accept, what it costs, **and until when**

This is the part that decays if it is not written down. Each trade-off names its exit
trigger so nobody has to rediscover why it exists.

| # | Trade-off we accept | Cost to the user | **Until when** (exit trigger) | Removed by |
|---|---|---|---|---|
| **T1** | Parity is **off by default** | collection keeps producing 7-field rows until the switch is flipped | **Until the user enables it.** Permanent by design for existing users. Revisit only with evidence: count runs that enable it over one release; flip the default only if the great majority do | a follow-up release decision, not this ticket |
| **T2** | A **cap** (default 50) | products beyond the cap in one run stay at card quality | **Until the cap is raised or set to `All`.** No date — it is a user choice. Revisit if runs routinely hit the cap *and* the breaker stays silent | Settings; a later "prioritise what is on screen" policy |
| **T3** | Parity is **same treatment, not full data** | a collected row reaches the **median 19** fields a save reaches — not 24 | **Partly expiring:** the 3 MB fetch hole (`9/80`) closes with **SAD-370 step 1**; the offerless-PDP share (**42/70**) is **accepted permanently** by SAD-370's Q1 decision (report honestly, no recovery) | SAD-370 steps 1 + 6a |
| **T4** | The queue is **in-memory** | if MV3 suspends the worker mid-run, the remaining tail is never enriched (rows stay intact, nothing corrupts) | **Until suspension is observed in practice.** Exit trigger: with the switch on, a finished run leaves rows at 7 fields that had queued work. Then port the `job-store` + `save-job-recovery` pattern | future ticket (pattern already exists for saves) |
| **T5** | **Write policy is left un-unified** | re-collecting an ASIN does not refresh price/availability the way re-saving does; the price family keeps its first captured value | **Permanent by design** (`db/products.ts:12-16`: a full-page run must never mutate a row it already wrote). Note enrichment *does* refresh rating/review/coupon/bestSellersRank/etc. — only the price family is frozen | — (intentional) |
| **T6** | **No per-row feedback** (Q4) | rows fill in silently; a user cannot tell enrichment is running, or that it failed for a row | **Until the UI ticket.** Exit trigger: confusion reported, or a support question along the lines of "why did this row stop at card data" | future UI ticket |
| **T7** | **No listing snapshot** for collections (Q3) | stored history is thinner than a save's: a save leaves `listing` + `detail`, a collection leaves `detail` only — invisible today | **Permanent unless a history feature needs it.** Exit trigger: any feature that reads `db.snapshots` for price-over-time. Nothing reads it today (verified) | future ticket, 3 lines |
| **T8** | **Extra outbound traffic:** 1 request per enriched product | bounded by the cap (50 ≈ 60 s of work); a `skipped` drain stops the queue on the breaker | **Permanent, bounded.** Exit trigger: 429s or captchas at a materially higher rate than your saves already produce (your session: 80 enrichments, 1 captcha) | — (bounded by design) |
| **T9** | The pump runs **beside**, not inside, the collection chain | a row can be visible at card quality and fill in afterwards; ordering is not guaranteed | **Permanent by design** — the alternative (awaiting 2.4 s inside `pendingProductsChain`) would stall progress and STOP | — |
| **T10** | **No protocol change** — enrichment is worker-internal | a content script cannot observe per-product enrichment (no card-level spinner for collected items) | **Permanent until a card-level UI exists**; it is the reason the change is 120 lines instead of a message-schema migration | future UI ticket |
| **T11** | **Sequenced behind SAD-370** | parity ships later than it could | **Until SAD-370 steps 1 + 6a land** (recommended: immediately before) | order in §7 |

### 8.1 The three that are permanent, stated plainly

T5 (write policy), T8 (traffic) and T9 (ordering) are **design decisions, not debts**.
If any of those three is unacceptable to you, the design changes materially — say so
before step 1 and I will re-cut it. Everything else in the register has an expiry.

### 8.2 The one trade-off that is really a correctness question

**T4.** Losing the tail silently is the only item where the user-visible result could be
"the feature looks like it did not work". It is acceptable for a first release because
nothing corrupts and the trigger is measurable; it should not survive a second release if
the trigger fires.

---

## 9. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Breaker trips mid-run | drain on `skipped`; rows keep card data | turn the setting off |
| 300-product run = 300 requests | cap, default 50 | set cap to 25 |
| Worker suspended mid-pump | documented (T4) | setting off; the upgrade path is T4's ticket |
| Duplicate work between batches | `seen` keyed `(sessionKey, asin)` | — |
| A later batch erases an enriched value | impossible: `addProducts`/`enrichStoredProductFields` fills only nulls | — |
| Collection feels slower | pump is outside `pendingProductsChain`, unawaited | setting off |
| Any regression at all | the feature is **off by default**: the rollback is a no-op | — |

---

## 10. Definition of done

- [ ] `npm run verify` green: tsc + **1193 existing tests unchanged** + build + audit
- [ ] new tests from §6 green, including the differential parity test
- [ ] with the setting **off**, a collection run stores byte-identical rows to `main`
      (proved by test, and by one live run diffed against the same run on `main`)
- [ ] with the setting **on**, one live run on `/deals` shows
      `[PPHunt] enrichment outcome … "jobId":"collect:<sessionKey>:<asin>"` lines and
      collected rows reaching the same `fieldsChanged` a save produces
- [ ] cap honoured live at `25`, `50` and `all`
- [ ] toggling in Settings takes effect without a page reload
- [ ] `CHANGELOG.md`, `ARCHITECTURE.md`, `README.md` updated; Temu untouched
- [ ] the trade-off register in §8 is copied into `ARCHITECTURE.md` so the next reader
      knows what is deliberate

---

## 11. Explicitly not in this plan

- No change to any parser, selector, merge policy, product schema field, or message shape.
- No change to `addProducts`' fill-only policy.
- No listing snapshots, no per-row status UI, no durable queue (T4/T6/T7).
- No Temu work.
- No Amazon behaviour change of any kind while the setting is off.

---

## 12. Follow-up tickets this plan deliberately creates

| Ticket | Trigger to open it |
|---|---|
| Durable collection-enrichment queue (T4) | suspension losses observed |
| Per-row enrichment status in the panel (T6/T10) | user confusion, or a card-level UI pass |
| Listing snapshots for collected rows (T7) | any feature that reads `db.snapshots` |
| Default-on decision for `enrichCollectedProducts` (T1) | after one release of opt-in data |
| "Prioritise on-screen products" for the cap (T2) | runs routinely hitting the cap |

---

## 13. One-paragraph summary

Collection and saves already extract identically; the save path simply continues into a
stage collection never had — the product-page fetch, offscreen parse and 22-field merge
inside `enrichSavedProduct`, worth **+12 fields median** per product. The final plan adds
a ~70-line background pump that calls that same function, unawaited and deduped, for each
newly collected ASIN, gated by two new settings that default to **off** and a **50**-per-run
cap you can change to 25 or All. Total: **~120 source lines, ~150 test lines, 3 commits**,
no parser or protocol change, and zero behaviour difference until the switch is flipped.
Parity then means *the same treatment a save gets* — median 19 fields, not 24 — with the
3 MB fetch hole closing in SAD-370 step 1, the offerless-PDP share accepted permanently,
and eleven trade-offs written down in §8 with the ten that expire.

---

## 14. Implementation record (what actually shipped)

Three commits on `main`, in the order §7 set out. Every step was gated by
`tsc --noEmit` + `wxt build` + the whole `vitest` suite, and no existing test was
modified.

| Step | Commit | Content |
|---|---|---|
| 0 | `2745288` | the investigation, the decision record and this plan |
| 1 | `dd6306d` | `enrichment-pump.ts`, `enrich-collected-flag.ts`, the two settings, handler wiring, 20 tests |
| 2 | `fbab2bd` | the Settings UI (switch + 25/50/all), Restore Defaults mirror, 6 tests |
| 3 | *(this commit)* | the differential parity proof, the changelog, this record |

Final suite: **106 files / 1227 tests** (1193 pre-existing + 5 from upstream
SAD-378 + 29 new).

### Where the implementation departed from the plan, and why

1. **The dependency has to be passed on the envelope fast-path, not the switch.**
   §4.2 said "handler `:844`". That line is the `switch` case, and it is
   unreachable for a valid `PRODUCTS_COLLECTED`: the envelope fast-path at
   `handler.ts:791` handles the message and `return false`s first. A dep wired
   only at the switch would have been dead code that typechecks and never runs.
   Both sites now pass it; the fast-path is the live one.
2. **The settings are written immediately, not through the hook's debounce.**
   The plan assumed `useAmazonSettings().updateSettings`. Writing the step-2 test
   exposed an ordering hazard: a debounce queued before *Restore Defaults* lands
   *after* the reset and re-enables what the user just cleared. For a switch that
   causes extra outbound requests, a stale "on" after a reset is the wrong failure
   mode, so these two keys persist in the same tick as the `storage.local` mirror.
   (`QuickSaveBehavior` has the same latent shape through the debounced writer;
   not touched — out of scope.)
3. **A start-up settings read can no longer clobber a newer write**
   (`utils/enrich-collected-flag.ts`, epoch guard). Not in the plan. A worker
   booting while the user toggles the switch restored the stale value on read
   resolution; the guard drops a read that a write has superseded.
4. **`ENRICH_COLLECTED_LIMIT_OPTIONS` lives in `constants/defaults.ts`**, not in
   the schema, so the settings UI iterates the same tuple the schema validates
   against — one list, not two that can drift.

### The parity proof (`tests/collection-save-parity.test.ts`)

The ticket's acceptance criterion, stated differentially: one card, one ASIN, two
runs — a `SAVE_PRODUCT` job and a `PRODUCTS_COLLECTED` batch with the switch on —
through the real background listener, the real `enrichSavedProduct` and a single
canned PDP. The two rows are `toEqual` after removing only `id` and `sessionKey`
(identity and provenance, not product data), and both carry the detail-page
fields (`rating 4.6`, `reviewCount 1204`, `seller`, `description`, `weight`,
`warrantyDescription`) with the listing price (19.99) still winning over the
detail price. A second test asserts both pipelines write exactly one detail
snapshot; a third pins the off-by-default behaviour: the collected row keeps the
card-only shape and no snapshot is written.

### Trade-offs still open

T1–T4, T6, T7 and T10 expire exactly as §8 records; T5, T8, T9 and the
offerless-PDP share of T3 are permanent. The in-memory queue limitation (T4) is
now stated in the changelog as a known limitation rather than only in this plan.
