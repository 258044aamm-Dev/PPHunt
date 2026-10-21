# SAD-385 — PLAN: product weight and variation data in Collection Mode

> **Merged:** `main` at **`8d04f92`** (2026-10-21), via PR #5. The merge commit
> is `78b20fc` (SAD-385 onto `main` at `ec8467e`, SAD-384); `155cbe4` is the
> follow-up that deleted the in-memory run-end reconciliation in favour of
> SAD-384's durable queue. Gate at merge: tsc clean, 118 files / 1321 tests,
> build 2.01 MB, audit 0 vulnerabilities, CI `verify` green. Live Amazon
> verification (`SAD-385-live-verification-protocol.md`) is still unexecuted.

> **Status:** decision-complete and **shipped** — see the *Merged* note above.
> **Ticket:** [SAD-385 — Product weight and variation data](https://linear.app/sad-mod/issue/SAD-385/product-weight-and-variation-data)
> (Bug, priority 1, project PPHunt).
> **Predecessor this plan builds on:** SAD-379 (`docs/plans/SAD-379-FINAL-plan.md`) —
> the collection enrichment stage that already exists on `main` and is simply
> **switched off by default**.
> **Baseline measured in this workspace, 2026-10-21:** `npx vitest run` →
> **106 files, 1216 tests passed**, 1 file (`tests/manifest-permissions.test.ts`)
> skipped because `.output/chrome-mv3/manifest.json` does not exist until
> `wxt build` runs (`npm install` + `npx wxt prepare` were required first; the
> repo's `postinstall` does both).
> **Owner decisions taken 2026-10-21:** D1 = **no gate, collection always
> enriches**; D2 = **per-run limit kept, default `all`**; D3 (scope) = delegated
> to this plan → **the PDP size cap is in, the offerless-PDP reporting is out**
> (§13).

**Implementation decisions added 2026-10-21 (owner):** delivery is the branch
`feat/sad-385-collection-weight-variations` only (no PR from this workspace), and
**step 3 (the PDP size cap) is deferred to SAD-370 step 1** — this branch ships
steps 1, 2 and 4. Everything else below stands as written.

---

## 1. The ticket as one testable sentence

> A product collected by a Collection run — **Manual or Automatic** — ends up
> with the same `weight` and `variations` values the right-click / individual
> extraction of the same ASIN produces, with no change to any other field, to
> either extraction path, or to any other feature.

---

## 2. Root cause — established from code, not assumed

### 2.1 The two fields are product-detail-page data

| Field | Where it is produced | Card parsers | Evidence |
|---|---|---|---|
| `weight` | `extractDetailWeight()` — 4-tier waterfall over the PDP spec tables + `#aplus` | **never** | `scraper/product-detail.ts:375-472`; there is no `extractCardWeight` anywhere in the codebase |
| `variations` | `extractDetailVariations()` — 3-tier twister waterfall on the PDP | *attempted*, but measured **empty** | `scraper/product-detail.ts:674-790`; `extractCardVariations()` (`scraper/field-parsers.ts:500`) needs swatch markup — `docs/plans/SAD-370-extraction-gap-closure-plan.md:120-121` records `variations` **MISSING on 154/154 listing cards** and `weight` **declared card-inapplicable** |

### 2.2 Exactly one code path fetches a product page

`fetchPdpHtml` (`background/enrichment-fetch.ts:243`) is called from exactly one
place: `enrichSavedProduct` (`background/enrich-saved-product.ts:361`).
`grep -rn "fetchPdpHtml" src` returns only that file and its own module.

So the only question that matters is: **who calls `enrichSavedProduct`?**

| Entry point | Calls `enrichSavedProduct`? | Line |
|---|---|---|
| Right-click → Save Product (on a listing card) | **yes**, always | `background/save-job.ts:308-348` |
| Individual extraction icon on a card | **yes** — same `SAVE_PRODUCT` path | `handler.ts:900-910` |
| Right-click → Save Product **on a PDP** | not needed: `parseAmazonProductDetail` already ran on the live DOM (weight + variations included) | `background/save-job.ts:308-312` (`savedFromProductPage`) |
| **Collection run (Manual or Automatic)** | **only if `enrichCollectedProducts` is on** | `handler.ts:580-590` |

`handler.ts:583`:

```ts
const enrichCollected = getEnrichCollectedSettings();
if (enrichCollected.enabled && deps.enrich) {   // ← the gate
  enqueueCollectionEnrichment(validProducts, active.sessionKey, { … });
}
```

and the gate's factory value (`constants/defaults.ts:39`):

```ts
export const DEFAULT_ENRICH_COLLECTED = false;
```

**That is the whole root cause.** Collection mode does not extract *worse* — it
never asks Amazon for the page that carries those two fields. The repository
already pins this as intended behaviour in its own test
(`tests/collection-save-parity.test.ts:341-355`):

```ts
it('with the switch off the collected row keeps the card-only shape it always had', async () => {
  …
  expect(row?.weight).toBeUndefined();   // ← the reported bug, asserted as correct
```

### 2.3 Why "Manual Mode or Automatic Mode" changes nothing

`mode` never reaches an extractor. In the content script it only selects the
scroll driver (`entrypoints/amazon.content.ts:514` `if (currentMode === 'automatic')`,
plus the manual mutation-observer branch at `:614`); in the background it is
session metadata only (`handler.ts:274-340`, `:423`, `:667-691`). Both modes
funnel into the same `PRODUCTS_COLLECTED` → `processProductsCollected` →
`addProducts` → *(gate)*. The ticket's "regardless of whether Manual Mode or
Automatic Mode" is a correct observation of a single cause, not two bugs.

### 2.4 Three secondary causes that also cost these fields

| # | Cause | Measured | Where |
|---|---|---|---|
| S1 | The gate is **off by default**, so the stage never runs | factory default `false` | `constants/defaults.ts:39` |
| S2 | Even when on, the **per-run cap defaults to 50** — product 51..N of a long run stay card-quality | cap `'50'` | `constants/defaults.ts:49`, `handler.ts:587` |
| S3 | Even when enriched, the **3 MB PDP cap rejects the page** and the row keeps no weight *and* no variations, on **both** pipelines | **9 of 80 pages** in the owner's own session | `enrichment-fetch.ts:27`, `docs/plans/SAD-370-…:180-186` |

S3 is the "sometimes some product data is not extracted" half of the ticket
(9/80 = 11% of pages). The other measured PDP defect — 42/80 pages served
**without a featured offer** (`SAD-370 §3.4`) — does **not** affect
`variations`/`weight` (both were present on 38/42 of those pages), so it is not
part of this ticket (§13).

### 2.5 The owner's observation: "there are no settings in the settings UI"

The control exists on `main`:

* `engines/amazon/ui/components/SettingsOverlay.tsx:533-535`
  → `<SettingsSection title="COLLECTION ENRICHMENT"><AmazonCollectionEnrichment /></SettingsSection>`,
  rendered between **RIGHT-CLICK SAVE** (`:531`) and **EXPORT DEFAULTS** (`:537`);
* the shipped Amazon panel renders *that* overlay — `AmazonEngineApp.tsx:8,65`
  — and the side-panel shell renders `AmazonEngineApp` (`entrypoints/sidepanel/App.tsx:13`);
* `tests/collection-enrichment-settings-ui.test.tsx` renders it and passes in
  the suite run above.

So a missing section means **the loaded build predates SAD-379** (its commit is
`fbab2bd`, the newest on `main`, still `[Unreleased]` in `CHANGELOG.md`), or the
section is simply below the fold in the scrolling settings sheet. **Step 0 of
this plan is to confirm which**, because it decides whether the fix has to ship
a build or also fix an unreachable control.

Either way the fix is the same: **the setting stops being a gate**, so a user can
never again be in the dark about whether collection extraction is complete.

### 2.6 Why the tempting one-line fix is wrong

Flipping `DEFAULT_ENRICH_COLLECTED` to `true` does **not** work.
`updateSettings` writes the **whole validated row** back
(`db/settings.ts:190-215`), and `parseStoredSettings` only applies a schema
default when the key is **absent** (`db/settings.ts:30-55`). Every user who has
touched any setting since SAD-379 shipped therefore has `enrichCollectedProducts:
false` persisted, and the new default would never reach them. The gate has to be
**removed**, not re-defaulted.

---

## 3. Decisions (locked 2026-10-21 with the owner)

| # | Decision | Answer | Consequence |
|---|---|---|---|
| D1 | Is collection enrichment gated? | **No gate.** Every collected product is enriched. | `enrichCollectedProducts` is deleted from the schema, types, flag module and UI. |
| D2 | Per-run cap | **Kept as a control, default `'all'`** | `DEFAULT_ENRICH_COLLECTED_LIMIT = 'all'`; the 25/50 radios stay as an escape hatch for very long runs. |
| D3 | Scope of the secondary causes | **S3 in, offerless-PDP out** | the PDP size cap is raised to the parser's own limit (§7.3); the offerless-PDP signal stays SAD-370 step 6. |
| D4 | Manual vs Automatic | one code path, one fix | a mode-invariance regression test is added (§8.2 T2/T3) instead of mode-specific code. |
| D5 | Backfill of already-collected rows | **not in this ticket** | new runs are correct; existing sessions are untouched (follow-up ticket, §13). |

---

## 4. Design, in one picture

```
PRODUCTS_COLLECTED (batch, manual or automatic — identical)
   │
   ▼  processProductsCollected                       handler.ts:443
   ├─ validateAndNormalize… → addProducts()           handler.ts:560      [unchanged]
   └─ ALWAYS → enqueueCollectionEnrichment()          handler.ts:580      ← gate removed
            │                                            limit = getEnrichCollectedLimit()  (default ∞)
            ▼
       enrichment-pump.ts  (UNCHANGED mechanics: one queue, serial runner,
            │               dedupe per (sessionKey, asin), drains on `skipped`)
            ▼
       enrichSavedProduct({ jobId: collect:<session>:<asin>, … })   [UNCHANGED]
         fetchPdpHtml  ← cap raised 3 MB → 5 MB (§7.3)
         → offscreen parse → mergeDetailIntoStored → db.products.update
         → detail snapshot
   ⋯
   run ends (STOP or 'completed')
   └─ NEW: reconcile what the run still lacks → enqueue the missing rows   (§7.2)
        then resetCollectionEnrichment()            [ordering matters — §7.2.1]
```

Three ideas make this small:

1. **No new extraction.** `weight` and `variations` are already in
   `DETAIL_FIELDS` (`enrich-saved-product.ts:31-60`), already upgraded (they are
   **not** in `FILL_ONLY_FIELDS`), and already covered by
   `enrichStoredProductFields` (`db/products.ts:30-33`). Nothing about parsing,
   merging or the product schema changes.
2. **No new pipeline.** The pump shipped in SAD-379 and is proven by
   `tests/collection-enrichment-pump.test.ts` / `collection-save-parity.test.ts`.
   This ticket changes **who is allowed to call it**, not what it does.
3. **The state that matters is in the database.** The pump's queue is in memory;
   rows are durable. The run-end reconciliation (§7.2) turns "a suspended worker
   lost the tail" into "the next handler re-derives it from the rows".

---

## 5. Change budget

| Area | Added | Removed | Modified |
|---|---|---|---|
| settings (defaults, schema, types) | 2 lines | 3 lines | 3 lines |
| flag module (`utils/enrich-collected-flag.ts`) | 6 lines | 14 lines | 10 lines |
| `background/handler.ts` | ~22 lines | 4 lines | 3 lines |
| `enrichment-fetch.ts` (cap) | 2 lines | 1 line | — |
| UI (`CollectionEnrichment.tsx`, `SettingsOverlay.tsx`) | ~15 lines | ~35 lines | ~10 lines |
| **source total** | **≈45** | **≈57** | **≈26** |
| tests | ~190 lines (7 new cases, 20 rewritten) | ~40 | ~12 assertions |
| docs | CHANGELOG + ARCHITECTURE + this file | — | — |

Three "step" commits plus this plan, matching the repo's convention.

---

## 6. Regression firewall — what this ticket must not touch

Explicitly **out of the diff** (each proven unchanged by a test in §8.3):

* every parser (`search-results.ts`, `category-page.ts`, `product-detail.ts`,
  `field-parsers.ts`, `selectors.ts`) and the drift/diagnostics code;
* `enrichSavedProduct`, `mergeDetailIntoStored`, `DETAIL_FIELDS`,
  `FILL_ONLY_FIELDS` — so the price family still wins and a € row never gains a $
  price;
* `addProducts` / `enrichStoredProductFields` and their fill-only policy;
* the message schema (`schemas/messages.ts`) — no new message type; enrichment
  stays worker-internal;
* the save pipeline (`save-job.ts`, `save-job-recovery.ts`, `job-store.ts`) —
  right-click and the individual extraction icon keep byte-identical behaviour;
* the Temu engine (its own DB, its own handlers, no enrichment);
* `settingsVersion` — **no bump**, because a removed key is stripped by
  `z.object` and the retained key keeps its stored value (`db/settings.ts:30-55`).

---

## 7. Exact changes

### 7.1 Remove the gate

#### `src/engines/amazon/constants/defaults.ts`

```diff
-/** SAD-379: off by default. */
-export const DEFAULT_ENRICH_COLLECTED = false;
+/**
+ * SAD-385: collection enrichment is no longer optional — a collection always
+ * finishes the job a save finishes. Only the per-run budget is configurable.
+ */
@@
 export const ENRICH_COLLECTED_LIMIT_OPTIONS = ['25', '50', 'all'] as const;
-export const DEFAULT_ENRICH_COLLECTED_LIMIT: EnrichCollectedLimit = '50';
+export const DEFAULT_ENRICH_COLLECTED_LIMIT: EnrichCollectedLimit = 'all';
@@
-  // SAD-379: off by default — see DEFAULT_ENRICH_COLLECTED.
-  enrichCollectedProducts: DEFAULT_ENRICH_COLLECTED,
   enrichCollectedLimit: DEFAULT_ENRICH_COLLECTED_LIMIT,
```

#### `src/engines/amazon/schemas/settings.ts`

```diff
-  // SAD-379: the collection enrichment stage. Both keys are optional-with-default,
-  // so an existing stored row parses without a settingsVersion bump.
-  enrichCollectedProducts: z.boolean().default(DEFAULT_ENRICH_COLLECTED),
+  // SAD-385: the gate is gone; only the per-run budget remains. A stored row
+  // that still carries `enrichCollectedProducts` keeps it untouched in
+  // IndexedDB (z.object strips unknown keys) and nothing reads it.
   enrichCollectedLimit: z
@@
-  // SAD-379
-  enrichCollectedProducts: z.boolean().optional(),
   enrichCollectedLimit: z.enum(ENRICH_COLLECTED_LIMIT_OPTIONS).optional(),
```

#### `src/engines/amazon/types/index.ts` (`AmazonSettings`, `:188-196`)

```diff
-  /**
-   * SAD-379: run the save pipeline's enrichment stage for collected products
-   * (default off). With this false a collection run is byte-identical to the
-   * pre-SAD-379 behaviour.
-   */
-  enrichCollectedProducts: boolean;
-  /** SAD-379: per-run enrichment cap for a collection ('25' | '50' | 'all'). */
+  /** SAD-385: per-run enrichment budget for a collection ('25' | '50' | 'all'). */
   enrichCollectedLimit: EnrichCollectedLimit;
```

#### `src/engines/amazon/utils/enrich-collected-flag.ts`

The cache holds one value; the legacy stored shape is read without a migration.

```diff
-export interface EnrichCollectedSettings {
-  enabled: boolean;
-  limit: number;
-}
-export interface StoredEnrichCollected { enabled: boolean; limit: EnrichCollectedLimit; }
+export interface StoredEnrichCollected { limit: EnrichCollectedLimit }
@@
-let cached: StoredEnrichCollected = {
-  enabled: DEFAULT_ENRICH_COLLECTED,
-  limit: DEFAULT_ENRICH_COLLECTED_LIMIT,
-};
+let cached: StoredEnrichCollected = { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
@@
 export function readEnrichCollected(value: unknown): StoredEnrichCollected {
-  if (!value || typeof value !== 'object') return { enabled: …, limit: … };
-  …
+  if (!value || typeof value !== 'object') return { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
+  const record = value as Record<string, unknown>;
+  /**
+   * SAD-385: the stored value may still be SAD-379's `{ enabled, limit }`.
+   * `enabled: false` is the factory default — nobody chose it — so it falls
+   * through to the new default (`all`). A record with no `enabled` at all (the
+   * new writer's own shape) keeps whatever limit it carries.
+   */
+  if (isLimit(record.limit) && record.enabled !== false) return { limit: record.limit };
+  return { limit: DEFAULT_ENRICH_COLLECTED_LIMIT };
 }
@@
-/** Synchronous, cached read — cheap enough for every collection batch. */
-export function getEnrichCollectedSettings(): EnrichCollectedSettings {
-  return { enabled: cached.enabled, limit: resolveEnrichCollectedLimit(cached.limit) };
-}
+/** Synchronous, cached read — cheap enough for every collection batch. */
+export function getEnrichCollectedLimit(): number {
+  return resolveEnrichCollectedLimit(cached.limit);
+}
@@
-export async function setEnrichCollectedSettings(
-  settings: Partial<StoredEnrichCollected>,
-  browserLike: unknown = defaultBrowserLike(),
-): Promise<void> {
-  const next = readEnrichCollected({ ...cached, ...settings });
+export async function setEnrichCollectedLimit(
+  limit: EnrichCollectedLimit,
+  browserLike: unknown = defaultBrowserLike(),
+): Promise<void> {
+  const next: StoredEnrichCollected = { limit };
   epoch += 1;
   cached = next;
   …
 }
```

Everything else in that module (epoch guard, `storage.onChanged` subscription,
fail-closed default, `refreshEnrichCollected`) is **unchanged** — it already
guards the read/write race SAD-379's record documents.

`src/entrypoints/background.ts:35-36` needs **no change**: it already calls
`refreshEnrichCollected()` + `subscribeEnrichCollected()` on every worker start.

#### `src/engines/amazon/background/handler.ts`

```diff
-import { getEnrichCollectedSettings } from '../utils/enrich-collected-flag';
+import { getEnrichCollectedLimit } from '../utils/enrich-collected-flag';
@@ processProductsCollected (:580)
     if (validProducts.length > 0) {
       await addProducts(validProducts, active.sessionKey);
-      // SAD-379: run the save pipeline's enrichment stage for what this batch
-      // just wrote. Never awaited — progress and STOP_COLLECTION must not wait
-      // on a ~2.4 s product-page fetch.
-      const enrichCollected = getEnrichCollectedSettings();
-      if (enrichCollected.enabled && deps.enrich) {
+      // SAD-385: a collection always finishes what a save finishes. Weight and
+      // the full twister variations exist only on the product page, so this
+      // stage is the only way a collected row can carry them. Never awaited —
+      // progress and STOP_COLLECTION must not wait on a fetch.
+      if (deps.enrich) {
         enqueueCollectionEnrichment(validProducts, active.sessionKey, {
           enrich: deps.enrich,
-          limit: enrichCollected.limit,
+          limit: getEnrichCollectedLimit(),
         });
       }
     }
```

`deps.enrich` stays optional: it is the only thing that keeps the module usable
from callers that do not opt in (tests, and the "no enrich" contract asserted in
§8.2 T7). Both production call sites already pass it — the envelope fast-path
(`handler.ts:826-831`) and the switch case (`handler.ts:879-884`); **no routing
change is needed**, which is precisely what SAD-379's record warns about
(its §14, item 1).

### 7.2 Run-end reconciliation (the tail safety net)

Why it is needed now and was not before: with the gate removed and the default
budget `all`, a 200-product run can spend minutes in the pump, and the queue is
in memory (`enrichment-pump.ts:52-63`; documented as limitation T4). Before this
ticket almost nobody ran that path; now everybody does.

The rows are durable, so the tail is *derivable*. One local closure in the
controller (≈15 lines, `handler.ts`), placed next to `processProductsCollected`:

```ts
/**
 * SAD-385: the run-ending safety net.
 *
 * The pump's queue lives in memory, so an MV3 suspension mid-run drops whatever
 * was still queued and those rows would stay at card quality — which, for
 * weight and variations, looks exactly like the bug this ticket fixes. The rows
 * are the durable record: anything the session still has without a detail-only
 * field is queued once more, under the run's remaining budget. `seen` keeps a
 * product this worker already attempted from being fetched twice.
 */
const reconcileCollectionDetails = async (sessionKey: string): Promise<void> => {
  let rows: Product[];
  try {
    rows = await getProductsBySession(sessionKey);
  } catch {
    return; // a read failure costs the tail, never the run
  }
  const missing = rows.filter((row) => !row.weight || !row.variations);
  if (missing.length === 0) return;
  enqueueCollectionEnrichment(missing, sessionKey, {
    enrich: enrichSavedProduct,           // the same function, imported at :43
    limit: getEnrichCollectedLimit(),
  });
};
```

Call sites (both are run boundaries that already exist):

| Site | Insert | Order rule |
|---|---|---|
| `handleStopCollection` (`:433-438`) | `await reconcileCollectionDetails(active.sessionKey);` | **before** `resetCollectionEnrichment(active.sessionKey)` (`:436`) |
| `handleCollectionProgress`, `status === 'completed'` (`:697-699`) | same call | **before** `resetCollectionEnrichment(sessionKey)` (`:699`) |

#### 7.2.1 The ordering hazard, stated so it is not re-learned

`resetCollectionEnrichment()` clears `seen` **and** `counts`
(`enrichment-pump.ts:111-118`). Reconciling *after* it would (a) re-queue
products the run already attempted, and (b) re-open the budget to unlimited —
i.e. a 300-product run could fetch 300 pages twice. Reconciling *before* it means
the remaining budget still applies and already-attempted products are skipped.
This mirrors the two ordering hazards SAD-379's implementation record had to fix
after the fact (its §14, items 1-2).

Rows whose PDP genuinely has no weight (singleton products, spec-table-less
pages) will be re-queued **once per run** and then skipped, because `seen`
remembers the attempt for the life of that run — so the reconciliation is
idempotent within a run and self-limiting across the worker's lifetime.

### 7.3 Raise the PDP size cap to the parser's own limit (S3)

`src/engines/amazon/background/enrichment-fetch.ts:27`

```diff
-/** A fetched PDP is ~1-2 MB; anything larger is not a page we can trust. */
-export const MAX_PDP_HTML_BYTES = 3_000_000;
+/**
+ * SAD-385: aligned with the offscreen parser's own ceiling. The old 3 MB cap
+ * rejected 9 of 80 pages in the SAD-370 session as "too large to enrich from";
+ * pages of 2,996,709 bytes succeeded, so the cap — not the page — was the
+ * failure. Every rejected page lost `weight` *and* `variations` on both
+ * pipelines.
+ */
+export const MAX_PDP_HTML_BYTES = MAX_OFFSCREEN_HTML_LENGTH; // 5_000_000
```

with `import { MAX_OFFSCREEN_HTML_LENGTH } from '../offscreen/protocol';`
(`offscreen/protocol.ts:21`) — a pure-constant module with no imports, so there
is no cycle, and the two numbers can never drift apart. The exported name is
kept so `tests/enrichment-fetch.test.ts:195,210` keeps compiling and its
boundary assertions stay meaningful (they are written against the constant).

> If SAD-370 step 1 (`docs/plans/SAD-370-…:551`) lands first, **skip this step** —
> it is the same change. Do not ship both mechanically.

### 7.4 UI — one control instead of two

`src/engines/amazon/ui/components/CollectionEnrichment.tsx`

* delete the *Enrich collected products* checkbox and the `enabled`/`apply({enabled})`
  plumbing;
* keep the `role="radiogroup"` block exactly as it is — but no longer
  `aria-disabled`, and with `'all'` marked as the default in its description;
* the section now states the behaviour instead of offering it:

```tsx
<p className="font-serif text-xs text-ink-muted leading-relaxed">
  Every collected product is enriched from its product page — the same step a
  right-click save already runs. That page is the only place Amazon prints
  <span className="font-medium"> weight </span> and the full
  <span className="font-medium"> variation </span> list, so a listing card alone
  can never carry them. This costs one request per product; the run pauses
  itself if Amazon starts refusing requests.
</p>
```

* `apply` now persists one key:

```diff
-    void persistSettings({ enrichCollectedProducts: nextEnabled, enrichCollectedLimit: nextLimit });
-    void setEnrichCollectedSettings({ enabled: nextEnabled, limit: nextLimit });
+    void persistSettings({ enrichCollectedLimit: nextLimit });
+    void setEnrichCollectedLimit(nextLimit);
```

The immediate-write rule from SAD-379 (no debounce; the record's §14 item 2) is
kept verbatim: this switch still changes outbound traffic, so it must never be
re-enabled by a stale debounce after *Restore Defaults*.

`src/engines/amazon/ui/components/SettingsOverlay.tsx`

```diff
-    // SAD-379: the enrichment switch is mirrored into storage.local, and the
-    // IndexedDB reset above cannot reach that copy.
-    await setEnrichCollectedSettings({
-      enabled: DEFAULT_ENRICH_COLLECTED,
-      limit: DEFAULT_ENRICH_COLLECTED_LIMIT,
-    });
+    // SAD-385: the per-run budget is mirrored into storage.local, and the
+    // IndexedDB reset above cannot reach that copy.
+    await setEnrichCollectedLimit(DEFAULT_ENRICH_COLLECTED_LIMIT);
```

plus the import swap (`DEFAULT_ENRICH_COLLECTED` removed, `setEnrichCollectedLimit`
added). The section title stays `COLLECTION ENRICHMENT` and its position between
**RIGHT-CLICK SAVE** and **EXPORT DEFAULTS** stays — a moved control is a new
bug for anyone who learned where it was.

---

## 8. Test plan

### 8.1 Tests that must change (and why each change is a *strengthening*)

| File | Today | After |
|---|---|---|
| `tests/collection-save-parity.test.ts` (3) | test 1 sets `enabled: true` by hand; test 3 asserts `row.weight` is `undefined` with the switch off | test 1 runs **with default settings** and additionally asserts `variations`; test 3 is inverted into *"with default settings a collected row carries the detail-only fields"*, and a new test keeps the `deps.enrich`-absent contract |
| `tests/collection-enrichment-wiring.test.ts` (11) | asserts "off ⇒ `enrichSavedProduct` not called" | asserts "called for every batch, with the run's jobId", keeps every cap test, keeps one test that a caller without the `enrich` dep is untouched |
| `tests/collection-enrichment-settings-ui.test.tsx` (6) | `expect(row.enrichCollectedProducts).toBe(expected.enabled)` | asserts the persisted `enrichCollectedLimit` **and** the `storage.local` mirror `{ limit }` for each radio |

No test is deleted; each keeps its subject and asserts the new invariant.

### 8.2 New tests — `tests/sad-385-collection-detail-fields.test.ts`

Driven through the **real** background listener, the real `enrichSavedProduct`
and one canned PDP, exactly like `collection-save-parity.test.ts` (only the
network is mocked) — the same discipline the repo uses for SAD-379.

| # | Test | Assertion (the invariant, not the implementation) |
|---|---|---|
| T1 | *a manual-mode collection enriches what it collects* | `START_COLLECTION{mode:'manual'}` + `PRODUCTS_COLLECTED` → `enrichSavedProduct` called once, `jobId === 'collect:<sessionKey>:<asin>'` |
| T2 | *an automatic-mode collection enriches identically* | same with `mode:'automatic'`; the two recorded inputs are `toEqual` apart from `sessionKey` — **this is the ticket's "both modes" clause, proven not assumed** |
| T3 | *weight and variations reach the stored row* | `row.weight === '120 g'`, `row.variations === '2 sizes'`, and the listing price still wins (`row.price === 19.99`) |
| T4 | *the per-run limit still bounds the work* | limit `'25'`, 30 collected → exactly 25 calls; limit `'all'` → 30 |
| T5 | *a lost tail is reconciled at the run boundary* | 3 rows seeded (one already carrying `weight`), `STOP_COLLECTION` → exactly the 2 incomplete ASINs are queued |
| T6 | *a product is never fetched twice in one run* | re-sending the same batch (`isNewBatch: false`) → still one call |
| T7 | *a failing enrichment is never a collection error* | injected throw → run still reports `completed`, row unchanged |

### 8.3 Regression guards (existing suites that must stay green, unmodified)

`save-job-enrichment.test.ts`, `enrich-saved-product.test.ts`,
`enrichment-fetch.test.ts`, `collection-enrichment-pump.test.ts`,
`collection-save-parity.test.ts` (saves half), `settings-rapid-edits.test.tsx`,
`collection-tab-routing.test.tsx`, `product-categorization.test.tsx`,
`temu-*` (whole engine), `export-*`, and the card-scraper suites
(`scraper-accuracy`, `pricing-deals-bsr`, `warranty-description`).

Plus one new one-liner in `tests/enrichment-fetch.test.ts`:

```ts
it('SAD-385: the fetch cap can never be tighter than the parser that consumes it', () => {
  expect(MAX_PDP_HTML_BYTES).toBe(MAX_OFFSCREEN_HTML_LENGTH);
});
```

### 8.4 Gate for every commit

```
npx tsc --noEmit && npx vitest run && npx wxt build
```

Baseline to compare against (measured here, 2026-10-21): **1216 passed**. After
this work expect **≈1226** (7 new cases + net test-count changes in the three
rewritten files); the delta must be explainable line by line.

---

## 9. Live verification protocol (step 4, before the ticket is closed)

1. `npm run build` → reload the unpacked extension from `.output/chrome-mv3`
   at `chrome://extensions`. **First check:** Settings shows *COLLECTION
   ENRICHMENT* between *RIGHT-CLICK SAVE* and *EXPORT DEFAULTS* (§2.5).
2. Turn on **Settings → Diagnostics** (SAD-369) so the enrichment log is emitted.
3. **Manual run:** a category page, target 20, *Manual*. Scroll by hand.
4. **Automatic run:** a fresh session, target 20, *Automatic*.
5. In the service-worker console, for each collected ASIN expect one line
   `[PPHunt] enrichment outcome {"jobId":"collect:<sessionKey>:<asin>", …}` with
   `"fieldsChanged"` containing `weight` and/or `variations`, and
   `"missingDetailFields"` no longer listing them (§7.3's cap fix is visible as
   the disappearance of `"reason":"parse-failed"` / *"too large to enrich from"*).
6. **Parity check:** right-click-save one of those ASINs. Its
   `fieldsChanged` and its table row must match the collected row for `weight`
   and `variations`.
7. **Table check:** Settings → Data Fields → ensure *Weight* and *Variations* are
   on; confirm the values are visible in the preview table and in a CSV export.
8. **Cap check:** set the per-run limit to `25`, run a 40-product collection, and
   confirm exactly 25 `collect:` outcome lines — no more, no fewer.
9. **Regression sweep:** one right-click save on a search card, one on a PDP, one
   individual icon click, one export, one Tamu page load (Temu untouched).

Record the paste of step 5 + the outcome counts in
`docs/plans/SAD-385-live-verification-2026-10-2x.md`, as SAD-369/370/378 did.

---

## 10. Risk register

| Risk | Likelihood | Mitigation | Rollback / exit trigger |
|---|---|---|---|
| **Traffic: a 300-product run now makes 300 PDP requests** (previously ~0) | High (by design) | serial runner (one at a time), the existing host circuit breaker (3 captchas / 3×429 ⇒ 60 s cooldown, `enrichment-fetch.ts:28-32`), drain-on-`skipped` (`enrichment-pump.ts:156-162`), and the `25` cap for cautious users | Exit trigger: a live run produces ≥3 captchas. Then add a pacing constant between fetches (one constant + one `await`) — **not** before, because nothing in this session's data shows pacing is needed |
| **A captcha storm would also break saves** (same host, same breaker state) | Medium under the above | breaker is shared: the pump stops first, then the save path sees `circuit-open` and skips rather than fails | same as above; the cap is the user-facing brake |
| Run feels slower / table fills in late | Medium | rows appear at card quality immediately and upgrade in place; nothing is awaited by the message path (`handler.ts:628-640` ordering preserved) | documented in CHANGELOG under *Known behaviour* |
| Worker suspension loses the tail | Medium (now common) | §7.2 reconciliation at both run boundaries; rows never corrupted | if tails still observed: the durable-queue ticket (§13) |
| A stale `enrichCollectedProducts:false` keeps the old behaviour | **High if implemented as a default flip** | the key is removed, not re-defaulted (§2.6) | — |
| A user's deliberate SAD-379 limit of `25` is lost | Low | `readEnrichCollected` keeps any stored limit unless it was the factory `enabled:false` record (§7.1) | — |
| The 5 MB cap makes the offscreen parse slow on low-end machines | Low | the cap equals the offscreen limit that already exists; `MAX_OFFSCREEN_HTML_LENGTH` is unchanged, so no *new* page can be parsed that could not be before | revert one constant |
| Settings row grows a dead key | none | `z.object` strips it; nothing reads it; `settingsVersion` untouched | — |
| Temu regressions | none | no Temu file is in the diff; `temu-isolation.test.ts` stays green | — |

---

## 11. Commit plan

| # | Commit | Files | Gate |
|---|---|---|---|
| 0 | `docs(sad-385): root cause, decisions and implementation plan` | this file | — |
| 1 | `SAD-385 step 1: a collection always enriches — the gate is gone` | `defaults.ts`, `schemas/settings.ts`, `types/index.ts`, `utils/enrich-collected-flag.ts`, `background/handler.ts`, `ui/components/CollectionEnrichment.tsx`, `ui/components/SettingsOverlay.tsx`, 3 test files | tsc + vitest + build |
| 2 | `SAD-385 step 2: reconcile a run's lost enrichment tail at the run boundary` | `background/handler.ts`, new test file (T5/T6/T7) | tsc + vitest + build |
| 3 | `SAD-385 step 3: the PDP fetch cap equals the parser's ceiling` | `background/enrichment-fetch.ts`, `tests/enrichment-fetch.test.ts` | tsc + vitest + build |
| 4 | `SAD-385 step 4: live verification, changelog and architecture` | `docs/plans/SAD-385-live-verification-*.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `README.md` (if it lists settings) | `npm run verify` |

Steps 2 and 3 are independent of each other and can be reordered or, if the
owner prefers a smaller first release, **step 3 can be dropped without touching
step 1** — it is the only step that is not strictly required by the ticket.

---

## 12. Definition of done

- [ ] `npm run verify` green: `tsc --noEmit`, the whole `vitest` suite, `wxt build`, `npm audit --omit=dev`
- [ ] `npm run check:dead-exports` green (scan scope is `src/lib/**`; unaffected, but run it)
- [ ] T1-T7 green, including the **manual vs automatic** mode-invariance test and the **lost-tail** reconciliation test
- [ ] a collected row and a saved row of the same ASIN are `toEqual` apart from `id`/`sessionKey`, with `weight` **and** `variations` set
- [ ] with 30 products collected and the limit at `25`, exactly 25 fetches happen; at `all`, 30
- [ ] one live manual run and one live automatic run show `collect:` outcome lines carrying `weight`/`variations` (§9)
- [ ] right-click save, PDP save, individual icon, export and Temu behave exactly as on `main`
- [ ] no parser, selector, merge-policy, product-schema or message-schema change in the diff — reviewable by `git diff --stat`
- [ ] `CHANGELOG.md` states the behaviour change plainly, including the new traffic cost per run
- [ ] `ARCHITECTURE.md` §"Background enrichment" tells the next reader that collections now run the same stage, and the trade-off register is updated (T1, T2 and T4 of SAD-379 change status; T8 becomes unconditional)

---

## 13. Explicitly out of this plan

| Item | Why | Where it goes |
|---|---|---|
| **Offerless-PDP reporting** (42/80 pages parse as `partial`) | it does **not** cost `weight`/`variations` (both present on 38/42 of those pages) — it costs the buy-box family | SAD-370 step 6 |
| Backfill of already-collected rows | the ticket is about extraction completeness, not repair; a repair action needs its own UI and budget design | new ticket: *"Fill missing detail data for a saved session"* |
| Durable (persisted) enrichment queue | §7.2 makes the tail derivable from the rows, which is cheaper than a second job store | new ticket, only if tail loss is observed in the field |
| Per-row "details fetched" indicator | Q4 of SAD-379, still deferred | UI ticket |
| Any pacing delay between PDP fetches | no evidence it is needed yet; the breaker already stops a bad run | risk-register exit trigger (§10) |
| Temu parity | Temu has no enrichment stage at all | separate ticket if wanted |

---

## 14. Appendix — every claim, with its location

| Claim | Location |
|---|---|
| `weight` extraction waterfall (PDP only) | `src/engines/amazon/scraper/product-detail.ts:375-472`, called at `:1429`, assigned at `:1491` |
| `variations` extraction waterfall (PDP) | `src/engines/amazon/scraper/product-detail.ts:674-790`, called at `:1428`, assigned at `:1490` |
| Card-side variations attempt | `src/engines/amazon/scraper/field-parsers.ts:500-560`; used at `search-results.ts:108,169` and `category-page.ts:160,219` |
| Card measurement: variations 154/154 missing, weight card-inapplicable | `docs/plans/SAD-370-extraction-gap-closure-plan.md:120-121` |
| Only PDP fetch call site | `src/engines/amazon/background/enrich-saved-product.ts:361` (imports `fetchPdpHtml` at `:6`) |
| Save pipeline always enriches a listing card | `src/engines/amazon/background/save-job.ts:308-348` |
| PDP save needs no enrichment | `save-job.ts:308-312` (`savedFromProductPage`) |
| Collection gate | `src/engines/amazon/background/handler.ts:580-590` |
| Gate default off / cap default 50 | `src/engines/amazon/constants/defaults.ts:39`, `:47-49` |
| Both production call sites pass `enrich` | `handler.ts:826-831` (envelope fast-path), `:879-884` (switch case) |
| Pump mechanics (queue, dedupe, drain on skip, in-memory) | `src/engines/amazon/background/enrichment-pump.ts:52-162` |
| `resetCollectionEnrichment` clears `seen` + `counts` | `enrichment-pump.ts:111-118`; called at `handler.ts:309,436,699` |
| Mode only drives scrolling | `src/entrypoints/amazon.content.ts:514,614`; handler metadata at `:274-340` |
| Settings UI section exists | `src/engines/amazon/ui/components/SettingsOverlay.tsx:531-537`; rendered by `AmazonEngineApp.tsx:8,65` |
| Whole-row settings write (why a default flip cannot work) | `src/engines/amazon/db/settings.ts:30-55`, `:190-215` |
| Settings schema is a non-strict `z.object` | `src/engines/amazon/schemas/settings.ts:64`, `:122` |
| 3 MB fetch cap vs 5 MB parse cap | `src/engines/amazon/background/enrichment-fetch.ts:27`; `src/engines/amazon/offscreen/protocol.ts:21`; `offscreen/parse.ts:61` |
| 9/80 pages rejected by the size cap | `docs/plans/SAD-370-extraction-gap-closure-plan.md:180-186` |
| 42/80 offerless PDPs keep variations + weight | `docs/plans/SAD-370-extraction-gap-closure-plan.md:155-170` |
| Existing test pinning the old behaviour | `tests/collection-save-parity.test.ts:341-355` |
| Pump + wiring + parity suites that must stay green | `tests/collection-enrichment-pump.test.ts`, `tests/collection-enrichment-wiring.test.ts`, `tests/collection-save-parity.test.ts` |
| SAD-379's own ordering-hazard record | `docs/plans/SAD-379-FINAL-plan.md` §14, items 1-2 |

---

## 15. Implementation record — what shipped

Branch `feat/sad-385-collection-weight-variations`, four commits. Every step was
gated by `tsc --noEmit` + the whole `vitest` suite + `wxt build` +
`node scripts/check-dead-exports.mjs`.

| Step | Commit | Content | Suite |
|---|---|---|---|
| 0 | `97be10f` | this plan (root cause, decisions, firewall, tests, risks) | — |
| 1 | `76b8fe1` | the gate removed; `{ limit }` flag; UI switch gone; 3 suites re-cut | 106 / 1228 |
| 2 | `6ff9a4e` | run-end reconciliation + `tests/sad-385-collection-detail-fields.test.ts` | 107 / 1232 |
| 4 | *(this commit)* | CHANGELOG, ARCHITECTURE §"Collection Enrichment (SAD-385)", the live-verification protocol, this record | unchanged |

Baseline on `main` before the branch, measured in this workspace:
`tsc` clean · 106 files / **1216 passed**, one file skipped because
`.output/chrome-mv3/manifest.json` did not exist yet · `wxt build` 1.99 MB.

### Where the implementation departed from the plan, and why

1. **Step 3 (the PDP size cap) was dropped** by owner decision, 2026-10-21: it is
   the same change as SAD-370 step 1 and does not belong in two tickets. Its
   evidence stays in §7.3 and in the verification protocol's follow-ups.
2. **`reconciledSessionKeys` was not in the plan.** §7.2 reconciled on every
   run-boundary event, and a duplicate `completed` progress (or a Stop after a
   completion) would have queued the same tail a second time *after*
   `resetCollectionEnrichment()` had cleared the pump's dedupe set. A per-session
   guard makes the reconciliation idempotent; it is cleared when a run is
   (re)started, so a retried run reconciles again.
3. **The reconciliation is deliberately blocked by the pump's `seen` set within a
   single worker lifetime.** That is the correct behaviour for the case it
   targets (a suspension wipes `seen` along with the queue) and for the other
   case it does not (a drained queue means the breaker is open, so re-queueing
   immediately would only be skipped again). Stated here because it looks like an
   omission.
4. **One test-only correction.** `tests/collection-enrichment-settings-ui.test.tsx`
   now waits for the radio's rendered `checked` to catch up before clicking a
   *different* radio: clicking a radio the DOM already shows as selected fires no
   change event. The wait documents real browser behaviour rather than masking a
   defect — the settings row is written immediately; only the render lags by one
   live-query round-trip.

### Status of the SAD-379 trade-off register

| Item | Now |
|---|---|
| T1 (default off) | **resolved** — the switch is gone |
| T2 (per-run cap) | **superseded** — the cap stays, defaulting to `all` |
| T4 (in-memory queue loses the tail) | **mitigated** — reconciled at the run boundary, once per session; the durable queue is still the upgrade path if tails are observed in the field |
| T6 / T7 / T10 | unchanged, still deferred |
| T5 / T8 / T9 | unchanged and still deliberate: the price family stays frozen, traffic is one request per product, ordering between a row and its detail fields is not guaranteed |

### Still open for the ticket

Live verification (§9 and `SAD-385-live-verification-protocol.md`) has **not**
been run: this workspace has no browser, no installed extension and no Amazon
session. All automated evidence is green; the console-level confirmation has to
happen on a machine that can load the extension.
