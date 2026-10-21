# SAD-383 — Rating and rating count: the plan

> **Ticket:** [SAD-383](https://linear.app/sad-mod/issue/SAD-383/rating-and-rating-count) · Priority 1 · `Bug` · Amazon engine only
> **Status: PLAN ONLY.** No `src/` file has been touched. The only files added by this
> investigation are this plan, its evidence record and five captured fixtures.
> **Baseline measured in this sandbox (2026-10-21):** `tsc --noEmit` clean ·
> `wxt build` 2.00 MB · **106 files / 1227 tests green** (after the build — see §2).
> **Evidence:** `docs/plans/SAD-383-evidence-2026-10-21.md` + `docs/plans/SAD-383-fixtures/`.
> Every claim below carries the §number it came from.

---

## 1. The ticket, restated as one testable sentence

> **A product collected by a run must end up carrying the same `rating` and
> `reviewCount` a right-click save of that product ends up carrying, on every Amazon
> listing surface, and turning the fix off must leave a collection run byte-identical
> to today.**

That is deliberately narrower than "collections should be as complete as saves" —
SAD-379 owns that, and this ticket must not re-open it (§9).

---

## 2. Baseline — the tree this starts from

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `npx wxt build` | OK, 2.00 MB |
| `npx vitest run` **after** build | **1227 passed / 106 files** |
| `npx vitest run` before build | 1 suite error (`manifest-permissions`, missing `dist/…/manifest.json`) — ordering artefact, not a defect |

Every step in §10 must end at **1227 + the new tests**, with the build run first.
The repo's own gate is `npm run verify` (`tsc` → `vitest` → `wxt build` → `npm audit`);
run `wxt build` before `vitest` when working step-by-step.

---

## 3. Root cause — what is actually broken (measured, not inferred)

**Card-level rating extraction is not the bug.** It was executed against today's live
Amazon HTML with this repo's real parsers (evidence §2):

| Surface | Cards parsed | `rating` | `reviewCount` |
|---|---|---|---|
| `/gp/bestsellers/kitchen` (live) | 30 | **30/30** | **30/30** |
| `/deals` (live, ProductCard *and* carousel variants) | — | **the card prints no rating at all** | same |
| `/dp/<asin>` (the source a save uses) | 1 | 4.6 | 142,457 |
| `/s?k=` (operator's own log, SAD-370 §3.2) | 154 | 0.96 coverage | — |

So the same card produces:

* **a save** → rating present, because the save pipeline continues into
  `enrichSavedProduct` (`background/enrich-saved-product.ts:36-37`) and reads the
  product page;
* **a collection** → rating absent, because that stage is reachable only through
  SAD-379's switch, which ships **off** (`constants/defaults.ts:39`,
  `background/handler.ts:583-588`).

That single asymmetry explains the ticket exactly: *"ratings are extracted when using the
context menu or the per-product icon, but not in Collection Mode, in either manual or
automatic mode."* Manual vs automatic is irrelevant because no parser branches on mode.

Two secondary defects make the symptom worse and keep it invisible:

| # | Defect | Proof |
|---|---|---|
| **D1** | A listing layout with no rating node (the `/deals` grid) can never yield a rating from the card; only the product page has the value | evidence §2.2 |
| **D2** | The parse cache freezes a card as complete once `asin+title+price+imageUrl` exist, so a reviews row that hydrates afterwards is never re-read for the rest of the run | evidence §4: pass2 `null`, fresh cache `4.5` |
| **D3** | Drift telemetry tracks `rating`/`reviewCount` but never threshold-checks them, and the card report cannot distinguish "layout has no rating node" from "node present, parser refused it" | `scraper/drift-telemetry.ts:117-129`, `scraper/card-diagnostics.ts:144-158` |

---

## 4. Decisions (locked with the operator, 2026-10-21)

| # | Question | Answer | Consequence |
|---|---|---|---|
| Q1 | Where does the bug reproduce? | **All listing surfaces** | The fix must not be layout-specific; it must be value-driven ("rating missing on this row"). |
| Q2 | Which layer? | **Both — card first, product page as the backstop** | Card extraction stays primary and unchanged (§5); a product-page-derived value fills only what the card could not supply. |
| Q3 | Network budget per run | **As many products as the run collected** | No per-run cap on the backfill; the shared circuit breaker is the only brake (§7.4). |
| Q4 | Adjacent defects | **All three** (extraction, cache freeze, diagnostics) | D2 and D3 are in scope (§7.5, §7.6). |

### 4.1 The one deliberate behaviour change — read this before approving

SAD-379 promised *"with the switch off (the default) a collection run is byte-identical to
before: no fetch, no queue, no storage write."* SAD-383 **breaks that sentence on purpose**,
because doing nothing is precisely the bug: a `/deals` collection can never produce a
rating without a request.

* The new setting `backfillCollectedRatings` therefore defaults to **`true`**.
* SAD-379's `enrichCollectedProducts` stays **`false`** and keeps its exact meaning
  (full PDP enrichment). The two are independent; neither implies the other.
* Flipping `backfillCollectedRatings` off restores today's behaviour exactly, and that is
  a test, not a promise (§10, Step 4 proof).

If the operator prefers opt-in, it is a **one-constant change** (`DEFAULT_RATING_BACKFILL`
in `constants/defaults.ts`). Say so before Step 4 and nothing else in the plan moves.

---

## 5. What this plan deliberately does **not** change

| Thing | Why it stays |
|---|---|
| `AMAZON_SELECTORS.cardFields.rating` / `.reviewCount` | They already win on every captured layout that prints a rating (30/30). Adding selectors would be guessing — the thing this ticket forbids. |
| `parseAmazonSearchCard` / `parseAmazonCategoryCard` | Byte-identical output. Step 1 changes only *when* a cached card is re-parsed, never what a parse returns. |
| `enrichSavedProduct`, `mergeDetailIntoStored`, `enrichment-pump` | Untouched. SAD-379's pipeline is not re-used, re-ordered or re-scoped (§7.3 explains why a separate path is smaller *and* safer than broadening that one). |
| `addProducts` / `enrichStoredProductFields` | Untouched. The new write is a separate, additive function. |
| DB schema / indexes | No new table, no version bump. `[sessionKey+asin]` already exists (`db/database.ts:22`). |
| Export, preview table, settings UI semantics | `rating`/`reviewCount` columns and `enabledFields` already exist; they simply start receiving values. |
| Temu engine | Out of scope by the ticket. No shared code is edited. |
| Message protocol | Untouched except two **optional** fields on the drift report (§7.6), which old messages still validate without. |

---

## 6. Design in one picture

```
PRODUCTS_COLLECTED  (per batch, during the run)
   │
   ▼
processProductsCollected()                              handler.ts:443
   ├─ validateAndNormalize → addProducts()              handler.ts:579   [unchanged]
   ├─ SAD-379 enrichment block                          handler.ts:583   [unchanged]
   └─ if settings.backfillCollectedRatings              ← NEW, 4 lines
          enqueueRatingBackfill(productsMissingRating, sessionKey)
                │
                ▼
   rating-backfill.ts   (NEW, ~95 lines, background-only)
     · one queue, one serial runner, never blocks pendingProductsChain
     · dedupe per (sessionKey, asin)  → a re-sent batch cannot redo work
     · no cap (Q3); drains on the first `skipped` (breaker open / no permission)
     · a failure is never a collection error
                │
                ▼
   rating-fetch.ts      (NEW, ~95 lines)
     GET .../average-customer-review/popover/?asin=<ASIN>    3 KB, not 2.6 MB  [evidence §3]
       · same circuit breaker as enrichment (isCircuitOpen / recordEnrichmentOutcome)
       · credentials:'omit', 8 s timeout, 64 KB cap, looksLikeChallenge()
       · guard: reviewCount >= 1 && rating > 0   ← non-existent ASINs answer 200/0.0  [evidence §3]
                │
                ▼
   offscreen  OFFSCREEN_PARSE_RATING  (new request type, reuses the existing DOMParser host)
     · [data-hook="acr-average-stars-rating-text"]  → parseRating()
     · [data-hook="total-review-count"]             → parseReviewCount()
                │
                ▼
   db/products.ts  backfillProductRating()   (NEW, ~18 lines)
     · by [sessionKey+asin]; FILL-ONLY: never overwrites a card-derived value
     · no snapshot written (collections do not create listing history — SAD-379 Q3)
```

---

## 7. The changes, file by file

### 7.1 `scraper/parse-cache.ts` — stop freezing a card before its rating arrives (D2)

Today `isComplete()` (`parse-cache.ts:16-26`) decides completeness from
`asin + title + price + imageUrl`. A card that hydrates its reviews row a moment later is
answered from the cache forever (evidence §4).

Fix: keep the *completeness* rule (it still means "safe to freeze"), and add a cheap
**DOM signature** to the entry so an unsatisfied card is re-read when, and only when, its
subtree actually changed.

```ts
interface CacheEntry {
  product: ScrapedAmazonProduct;
  /** Cheap change detector: node count + text length. Never inspects values. */
  signature: number;
}

/** Changes when Amazon injects/removes a subtree (e.g. a late reviews row). */
private signatureOf(element: Element): number {
  return (element.getElementsByTagName('*').length * 31) ^ (element.textContent?.length ?? 0);
}

public get(element: Element): ScrapedAmazonProduct | undefined {
  return this.cache.get(element)?.product;
}

public set(element: Element, product: ScrapedAmazonProduct | null): void {
  if (this.isComplete(product)) {
    this.cache.set(element, { product, signature: this.signatureOf(element) });
  }
}

public getOrParse(element, parser): ScrapedAmazonProduct | null {
  const entry = this.cache.get(element);
  if (entry) {
    // A card with both values is settled: never re-parsed (today's cost).
    const settled =
      entry.product.rating !== null && entry.product.rating !== undefined &&
      entry.product.reviewCount !== null && entry.product.reviewCount !== undefined;
    if (settled || this.signatureOf(element) === entry.signature) return entry.product;
  }
  const parsed = parser(element);
  if (this.isComplete(parsed)) {
    this.cache.set(element, { product: parsed, signature: this.signatureOf(element) });
  }
  return parsed;
}
```

Why this shape:

* **No behaviour change for settled cards** — a card that has a rating is still parsable
  exactly once per `Element`, so the SAD-359 performance numbers do not move.
* **No behaviour change for incomplete cards** — they were never cached and still are not.
* **Bounded** — a static `/deals` card (no rating, no changes) is re-parsed **zero** times
  after the first pass. Only an actual DOM change buys a re-parse.
* Cost of a signature on 160 cards × ~120 nodes is a few thousand property reads per pass.

### 7.2 `background/rating-fetch.ts` — the cheap, verified rating source (new)

```ts
/**
 * SAD-383: the two numbers a listing card sometimes cannot print.
 *
 * Measured 2026-10-21 (docs/plans/SAD-383-evidence-2026-10-21.md §3): this endpoint
 * returns the same rating/review count as the product page in ~3 KB instead of
 * ~2.6 MB, needs no cookies, and answers 200 with `0.0 / 0 global ratings` for an
 * ASIN that does not exist — hence the `reviewCount >= 1` guard below.
 */
import { AMAZON_MARKETPLACE_DOMAINS, isAmazonUrl } from '../utils/amazon-url';
import {
  isCircuitOpen,
  looksLikeChallenge,
  recordEnrichmentOutcome,
} from './enrichment-fetch';

export const RATING_FETCH_TIMEOUT_MS = 8_000;
export const MAX_RATING_HTML_BYTES = 64 * 1024;

export type RatingFetchOutcome =
  | { status: 'ok'; html: string }
  | { status: 'skipped'; reason: 'not-amazon' | 'circuit-open' }
  | { status: 'failed'; reason: 'http' | 'captcha' | 'too-large' | 'network' };

export function ratingPopoverUrl(productUrl: string, asin: string): string {
  const origin = new URL(productUrl).origin;
  return `${origin}/gp/customer-reviews/widgets/average-customer-review/popover/?ie=UTF8&asin=${encodeURIComponent(asin)}`;
}

export async function fetchRatingPopover(
  productUrl: string,
  asin: string,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RatingFetchOutcome> { /* host → breaker → one fetch → cap → challenge */ }
```

Rules it inherits from `enrichment-fetch.ts` (so the two cannot diverge):

* the breaker key is the **marketplace host**, the same one `fetchPdpHtml` uses — a
  captcha on product pages also pauses rating fetches, and vice versa;
* `credentials: 'omit'` — a signed-in session is neither used nor leaked;
* **no retry.** The payload is 3 KB; a retry buys nothing and a second request during a
  soft block is what turns it into a hard one. The breaker already retries later runs.
* one `recordEnrichmentOutcome(host, kind)` per attempt, so the existing counters mean
  what they already mean.

### 7.3 `offscreen/` — parse the popover with the parser we already trust (new request type)

The service worker has no `DOMParser` (the same reason SAD-296 added the offscreen
parser), so the popover body is parsed where every other HTML body is parsed.

`offscreen/protocol.ts`:

```ts
export interface OffscreenParseRatingRequest {
  type: 'OFFSCREEN_PARSE_RATING';
  requestId: string;
  html: string;
}
export type OffscreenParseRatingResponse =
  | { ok: true; rating: number | null; reviewCount: number | null }
  | OffscreenError;
```

`offscreen/parse.ts`:

```ts
/**
 * SAD-383: the popover's own hooks. `data-hook` is locale-invariant, so the
 * localized text is passed to the *existing* parseRating/parseReviewCount —
 * no new number parsing, and `4,6 von 5 Sternen` / `142.457 Sternebewertungen`
 * keep working through the same code path as every card.
 */
const ACR_HOOKS = {
  ratingText: '[data-hook="acr-average-stars-rating-text"]',
  ratingAlt: '[data-hook="average-stars-rating-anywhere"]',
  reviewCount: '[data-hook="total-review-count"]',
} as const;

export function parseRatingPopoverHtml(html: string): {
  rating: number | null;
  reviewCount: number | null;
} {
  if (looksLikeChallenge(html)) return { rating: null, reviewCount: null };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ratingText =
    safeQuerySelector(doc, ACR_HOOKS.ratingText)?.textContent ??
    safeQuerySelector(doc, ACR_HOOKS.ratingAlt)?.getAttribute('aria-label') ??
    null;
  const countText = safeQuerySelector(doc, ACR_HOOKS.reviewCount)?.textContent ?? null;
  return { rating: parseRating(ratingText), reviewCount: parseReviewCount(countText) };
}
```

`offscreen/handlers.ts` gains one `case 'OFFSCREEN_PARSE_RATING':` next to
`OFFSCREEN_PARSE_PRODUCT` (line 115) with the same size guard style.

### 7.4 `background/rating-backfill.ts` — the queue (new)

Deliberately a **separate** module rather than a mode inside `enrichment-pump.ts`:
the pump's queue semantics (ordering, cap, drain, snapshot job ids) are SAD-379's
tested contract, and a second job type inside it would change behaviour that ticket
promises. Two small modules beat one module with two personalities.

```ts
/**
 * SAD-383: fill the two fields a listing card may not print, for the rows a run
 * just stored. Mirrors `enrichment-pump.ts`'s rules (never blocks the run, never
 * twice per ASIN, drains on `skipped`, a failure is never a collection error) and
 * shares the enrichment circuit breaker through `rating-fetch.ts`.
 */
import { backfillProductRating } from '../db/products';
import { fetchRatingPopover } from './rating-fetch';
import { parseRatingViaOffscreen } from './offscreen';

export interface RatingBackfillDeps {
  fetchRating?: typeof fetchRatingPopover;
  parseRating?: typeof parseRatingViaOffscreen;
  write?: typeof backfillProductRating;
}

/** The ticket's trigger, in one predicate — used by the handler and by the pump. */
export function needsRatingBackfill(product: {
  rating?: number | null;
  reviewCount?: number | null;
}): boolean {
  return product.rating == null || product.reviewCount == null;
}

export function enqueueRatingBackfill(
  products: readonly { asin?: string | null; url?: string | null; rating?: number | null; reviewCount?: number | null }[],
  sessionKey: string,
  deps: RatingBackfillDeps = {},
): void;
export function resetRatingBackfillForTests(): void;
```

Runner rules (each one is a test in §10 Step 3):

1. serial — one request in flight, never awaited by the caller;
2. `${sessionKey}::${asin}` dedupe — an `updatedExisting` batch re-sends the whole run;
3. on `{status:'skipped'}` → `queue.length = 0` (host out of service for a minute);
4. `try/catch` around every item — a failure leaves the row untouched;
5. after a successful parse, `write()` fills only what is still null; if it reports zero
   changed fields nothing is logged.

### 7.5 `db/products.ts` — a fill-only write (new, additive)

```ts
/**
 * SAD-383: fill-only write of the two fields a listing card may not carry.
 *
 * Fill-only on purpose: a card that did print a rating is the value the user saw,
 * and a background request must never overwrite it (the same rule
 * `enrichStoredProductFields` applies to the rest of the nullable fields).
 * No snapshot: collections do not create listing history (SAD-379 Q3).
 */
export async function backfillProductRating(
  sessionKey: string,
  asin: string,
  values: { rating: number | null; reviewCount: number | null },
): Promise<string[]> {
  const row = await db.products
    .where('[sessionKey+asin]')
    .equals([sessionKey, asin])
    .first();
  if (!row || row.id === undefined) return [];

  const patch: Partial<Product> = {};
  if (row.rating == null && values.rating != null) patch.rating = values.rating;
  if (row.reviewCount == null && values.reviewCount != null) patch.reviewCount = values.reviewCount;

  const changed = Object.keys(patch);
  if (changed.length > 0) await db.products.update(row.id, patch);
  return changed;
}
```

### 7.6 `background/handler.ts` — four lines of wiring

```diff
  import { enqueueCollectionEnrichment, resetCollectionEnrichment } from './enrichment-pump';
+ import { enqueueRatingBackfill, needsRatingBackfill } from './rating-backfill';
+ import { fetchRatingPopover } from './rating-fetch';

       if (validProducts.length > 0) {
         await addProducts(validProducts, active.sessionKey);

         const enrichCollected = getEnrichCollectedSettings();
         if (enrichCollected.enabled && deps.enrich) {
           enqueueCollectionEnrichment(validProducts, active.sessionKey, { … });
         }
+
+        // SAD-383: the fields a listing card may not print. Independent of the
+        // SAD-379 switch above; off → zero requests, identical to today.
+        const settings = await getSettings();
+        if (settings.backfillCollectedRatings) {
+          enqueueRatingBackfill(validProducts.filter(needsRatingBackfill), active.sessionKey, {
+            fetchRating: deps.fetchRating ?? fetchRatingPopover,
+          });
+        }
       }
```

`processProductsCollected`'s deps grow by one optional member
(`deps.fetchRating`), matching how `deps.enrich` was added in SAD-379; every existing
caller keeps compiling because the object is defaulted.

### 7.7 Settings — one boolean

| Layer | Change |
|---|---|
| `constants/defaults.ts` | `export const DEFAULT_RATING_BACKFILL = true;` + add to `DEFAULT_AMAZON_SETTINGS` |
| `schemas/settings.ts` | `backfillCollectedRatings: z.boolean().default(DEFAULT_RATING_BACKFILL)` in `AmazonSettingsSchema` **and** as `.optional()` in `PartialAmazonSettingsSchema` |
| `types/index.ts` | `backfillCollectedRatings: boolean` on `AppSettings` |
| `db/settings.ts` | no change — `parseStoredSettingsSafe` merges over defaults (the SAD-349/357/379 precedent), so no `settingsVersion` bump |
| `ui/components/CollectionEnrichment.tsx` | one checkbox above the existing one: *"Fill missing ratings from the product page"*, with a truthful sub-line: *"One small request per product that did not show a rating on the listing. Off means a collected rating is only ever what the card printed."* |

### 7.8 Drift telemetry + card report — make the next regression visible (D3)

**a. Presence, not just value.** `extractCardRatingAndReviewsWithTier` already walks the
candidate selectors; return whether a *node* was found:

```ts
export type TieredValue<T> = { value: T; tier: AmazonExtractionTier; nodeSeen?: boolean };
```

(optional, so every existing consumer and test compiles unchanged).

**b. Telemetry counts presence** — `recordCardExtraction(fieldTiers, presence?)` gains
`{ ratingNode?: boolean; reviewNode?: boolean }`, and `getReport()` adds:

```ts
const ratingNodes = this.ratingNodesSeen / Math.max(1, this.cardsExtracted);
if (this.cardsExtracted > 0 && this.ratingNodesSeen > 0 && fieldCoverage.rating < 0.5) {
  driftReasons.push(
    `Rating nodes were present on ${Math.round(ratingNodes * 100)}% of cards but only ` +
    `${Math.round(fieldCoverage.rating * 100)}% parsed — the rating selector or parser has drifted.`,
  );
}
// No rating node anywhere on this layout ⇒ the card cannot carry it. That is an
// honest layout fact, not drift: no reason is added and isDriftDetected stays false.
```

The same treatment for `reviewCount`. This is what turns the operator's
`rating:0, isDriftDetected:false` line (`SAD-370` §3.3) into a signal, **and** keeps
`/deals` from crying wolf.

**c. Message boundary.** `AmazonDriftReportSchema` (`schemas/messages.ts:300-315`) lists
its keys explicitly, so two new fields must be added there as `.optional()` —
otherwise zod strips them in transit and the fix silently does nothing.

**d. Card report reasons.** `card-diagnostics.ts:144-158`:

```ts
nodeSeen ? 'rating node present but the value did not parse' : 'this card layout has no rating node'
```

(exact strings finalised in Step 2 together with `tests/card-diagnostics.test.ts`).

---

## 8. What this gives the operator, per surface

| Surface | Card supplies rating? | After SAD-383 |
|---|---|---|
| Search `/s?k=` | usually (0.96 in their log) | unchanged, **plus** D2 re-reads a card whose reviews row hydrated late |
| Bestsellers `/gp/bestsellers` | yes (30/30 measured) | unchanged — backfill never fires for these rows |
| Product page `/dp/` | yes (detail parse) | unchanged — nothing to backfill |
| Deals/ProductCard grid | **no node at all** | **fixed** — the 3 KB popover fills `rating` + `reviewCount` |

---

## 9. Non-regression obligations (each one becomes a test)

| # | Obligation | How it is proven |
|---|---|---|
| N1 | With `backfillCollectedRatings: false`, a `PRODUCTS_COLLECTED` batch performs **zero** fetch calls and writes **zero** extra fields | fetch mock `not.toHaveBeenCalled()` + row compared field-by-field with the pre-change expectation |
| N2 | SAD-379's `enrichCollectedProducts` semantics, storage payload and tests are untouched | `tests/collection-enrichment-*.test.ts` pass unmodified (its `toEqual({enabled, limit})` payload asserts keep passing — the new setting lives in the settings row, not that storage key) |
| N3 | A card that prints a rating is never overwritten by a background value | unit test on `backfillProductRating` + differential test (§10 Step 4) |
| N4 | Parsers return byte-identical products for an unchanged DOM | `tests/baseline-snapshot.test.ts` unmodified; a new test asserts one parse per settled card |
| N5 | A failed/throttled/captcha'd fetch never fails a collection, never surfaces a UI error, never writes a null | pump test + handler test with a rejecting fetch |
| N6 | Temu untouched | no shared file edited; `tests/temu-*.test.ts` unmodified |
| N7 | Re-collecting the same ASIN does not fetch it twice per run | dedupe test with two identical batches |
| N8 | A `0 global ratings` response is never written | guard test using `rating-popover.empty.real.html` |

---

## 10. Steps (one commit each, `SAD-383: … (step N)`, `npm run verify` green before each)

### Step 0 — record the evidence *(docs only)*
Files: `docs/plans/SAD-383-evidence-2026-10-21.md`, `docs/plans/SAD-383-fixtures/*`,
this plan. No `src/` change.
**Proof:** `git diff --stat` touches `docs/` only.

### Step 1 — re-parse a card whose DOM changed while its rating was missing (D2)
Files: `scraper/parse-cache.ts`.
Tests: `tests/parse-cache-rating-reparse.test.ts` — the exact probe from evidence §4
(pass1 `null` → row added → pass2 must be `4.5`), plus: a settled card is parsed **once**
across five passes; an unchanged rating-less card is parsed **once**; `clear()` still
empties the cache.
**Proof:** `tests/scraper-performance.test.ts` and `tests/baseline-snapshot.test.ts`
unmodified and green (no extraction change, no extra parse for settled cards).

### Step 2 — let the diagnostics see rating nodes (D3)
Files: `scraper/field-parsers.ts` (`nodeSeen`), `scraper/drift-telemetry.ts`,
`scraper/card-diagnostics.ts`, `schemas/messages.ts` (two optional keys).
Tests: `tests/drift-rating-coverage.test.ts` — fixtures from `SAD-383-fixtures/`:
bestsellers card ⇒ `rating` coverage 1.0, no drift; deals card ⇒ `ratingNodesSeen = 0`,
**no drift** (layout fact); a synthetic card whose `a-icon-alt` is replaced by
`<span>4.5</span>` ⇒ node seen, coverage 0 ⇒ **drift**. Plus card-report reason strings.
**Proof:** the drift line for a `/deals` sweep is `isDriftDetected:false` **before and
after** the change; only the new counter appears.

### Step 3 — the fetch, the parse, the write
Files: `background/rating-fetch.ts` (new), `offscreen/protocol.ts`,
`offscreen/parse.ts`, `background/offscreen.ts` (client), `offscreen/handlers.ts`,
`db/products.ts` (`backfillProductRating`).
Tests: `tests/rating-fetch.test.ts` (URL shape, `credentials:'omit'`, breaker skip, 64 KB
cap, challenge detection, **no retry**), `tests/rating-popover-parse.test.ts`
(the two captured payloads → `4.6/142457` and `0/0`), `tests/rating-backfill-write.test.ts`
(fill-only, missing row, index lookup).
**Proof:** no production code path calls any of it yet — `handler.ts` is untouched, so the
whole suite must be green with identical behaviour.

### Step 4 — the pump, the switch and the wiring
Files: `background/rating-backfill.ts` (new), `background/handler.ts`,
`constants/defaults.ts`, `schemas/settings.ts`, `types/index.ts`,
`ui/components/CollectionEnrichment.tsx`.
Tests: `tests/rating-backfill-pump.test.ts` (serial, dedupe, drain on `skipped`, failure
isolation), `tests/rating-backfill-wiring.test.ts` (mirrors
`collection-enrichment-wiring.test.ts`: real background listener, setting off ⇒ no fetch;
setting on ⇒ exactly one fetch for the product missing a rating and **none** for the one
that had it), `tests/rating-backfill-parity.test.ts` — the differential test this ticket
exists for:

> the same `/deals`-style card (no rating node) is put through **the save pipeline** and
> **the collection pipeline**; both end with `rating = 4.6`, `reviewCount = 142457`.

**Proof:** N1, N2, N5, N7 green.

### Step 5 — documentation and the final gate
Files: `CHANGELOG.md` (new `### Added` entry + an explicit amendment to the SAD-379
"byte-identical when off" sentence), `ARCHITECTURE.md` (collection pipeline diagram gains
the backfill stage), `PLAN.md` if it tracks feature status.
**Proof:** `npm run verify` (build **before** tests) → expect **1227 + new tests**, 0
failures; `npm run check:dead-exports` clean.

---

## 11. Falsification experiments — what would invalidate this plan

| # | If this is observed… | …then this plan is wrong, and here is what to do |
|---|---|---|
| F1 | The operator's failing page contains rating nodes **and** the card parser returns `null` for them | Capture that exact card (`SAD-383-fixtures/`), add the verified selector in Step 1 as a *card-level* fix. The rest of the plan still stands. |
| F2 | On their search-page collections, ratings are already present | The complaint is layout-specific after all; Step 4 is the whole ticket and Step 2 outranks Step 1. |
| F3 | The popover endpoint returns a different number than the product page in their marketplace | Use `fetchPdpHtml` + the existing offscreen PDP parser instead of the popover (same call site, ~30 lines swapped in `rating-fetch.ts`). |
| F4 | Their collections produce **no rows at all** on `/deals` | They are hitting the card-discovery defect in §12, not this ticket. Ratings cannot be fixed for rows that do not exist — open the separate ticket first. |
| F5 | Backfilling triggers captchas in their normal workload | Lower `DEFAULT_RATING_BACKFILL` to `false`, and/or add a per-run cap by reusing SAD-379's `'25' \| '50' \| 'all'` enum. One constant + one enum, no redesign. |

---

## 12. Out of scope — measured, and worth their own tickets

These were discovered while capturing evidence. Fixing them here would change card
discovery for **every** surface, which violates this ticket's non-influence rule.

1. **Every deal faceout on today's `/deals` is inside `.a-carousel-card`, and
   `parseAmazonCategoryPage` skips those unconditionally** (`category-page.ts:305`,
   `:318`). Measured: `deal faceouts=8, outsideCarousel=0` → the parser resolves **1**
   card (a banner) for the whole page. The carousel exclusion exists to suppress
   "related products" noise on search pages, so relaxing it is a cross-surface decision.
2. **`/b?node=` renders its tiles inside carousels too** (50 rating markers, 0
   `[data-asin]` nodes, 7 resolved "cards" that are all heroes). Same root cause.
3. `coupon`/`dealBadge` `0/70` and `description` `≈25%` on product pages — already
   sequenced by `SAD-370` §7; not rating work.

---

## 13. Open questions for the operator (do not block Steps 1-3)

1. **Does a `/deals` collection currently produce rows?** If it produces ~1 row per page,
   §12-1 is the real complaint and SAD-383 will look ineffective without it.
2. **Is `backfillCollectedRatings` default-on acceptable** (§4.1)? It is the one
   behaviour change in this ticket; one constant flips it.
3. **Should an existing collection be backfilled retroactively?** The plan says no
   (only rows stored by a run, while that run is alive). A retro-backfill is a separate,
   explicitly-triggered action.

---

## 14. Definition of done

- [ ] A `/deals`-layout collection and a right-click save of the same card produce the same
      `rating` and `reviewCount` (`tests/rating-backfill-parity.test.ts`).
- [ ] A search card whose reviews row hydrates after the first pass ends the run with its
      rating (Step 1 test).
- [ ] A rating printed by a card is never replaced by a fetched one (N3).
- [ ] Switching the new setting off reproduces today's behaviour exactly — zero requests,
      zero extra writes (N1).
- [ ] A layout with rating nodes but no parsed ratings now reports drift; a layout with no
      rating nodes does not (Step 2 tests).
- [ ] `npm run verify` green with the build before the tests; SAD-379's tests unmodified.
- [ ] `CHANGELOG.md` states the one behaviour change and scopes SAD-379's
      "byte-identical when off" claim to enrichment.
