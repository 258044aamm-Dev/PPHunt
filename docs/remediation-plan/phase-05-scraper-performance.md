# Phase 5 — Scraper Performance & Automatic Mode

**Issues addressed:** H‑9 (full-page re-parse) · M‑2 (over-broad card counter) · M‑7 (silent product drops)
**Estimated effort:** Large · **Prerequisites:** Phase 1 (currency), Phase 3 (scroll settings) · **Blocks:** nothing

> ⚠️ **This phase contains corrections to three claims in the investigation report.** See
> [`CORRECTIONS.md`](./CORRECTIONS.md) items 1–3 before implementing. The *findings* stand; two of
> the stated *mechanisms* were wrong.

---

## Step 5.1 — H‑9a: memoise per-card parsing

### Objective
Re-parsing an unchanged document must cost ~O(1) instead of O(all cards), without losing the
late-hydrating-field enrichment that dedup depends on.

### Root Cause
`parseCurrentPage()` (`amazon.content.ts`) re-parses **every** card on the page each time it is
called, and it is called from two independent triggers:
- the MutationObserver callback (`amazon.content.ts:83-108`, 300 ms trailing debounce)
- the scroll controller's `onNewProducts` callback (`amazon.content.ts:200-236`)

Measured cost (JSDOM, synthetic search page — JSDOM is slower than a native DOM, so treat the absolute
numbers as an upper bound and the **scaling** as the finding):

```
cards=  60  complete fields →   433 ms   (7.2 ms/card)
cards=  60  missing fields  →   479 ms   (8.0 ms/card)
cards= 240  complete fields → 1,138 ms   (4.7 ms/card)
cards= 240  missing fields  → 1,736 ms   (7.2 ms/card)
cards= 480  complete fields → 2,342 ms   (4.9 ms/card)
cards= 480  missing fields  → 3,310 ms   (6.9 ms/card)
```

**Critical constraint (risk R3).** `DeduplicationEngine.mergeAndFilterNew` (`dedup.ts:55-124`) relies
on already-seen cards being **re-parsed**, because Amazon hydrates images, ratings and BSR lazily —
a card first seen with `imageUrl: null` may be complete two ticks later. A naive "skip parsed cards"
cache would silently freeze those fields at `null` forever. The cache must therefore track
*completeness*, not just identity.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/scraper/parse-cache.ts` | **create** | `ParseCache` keyed on the card `Element`, storing `{ product, isComplete }` |
| `src/lib/scraper/search-results.ts` | modify | Consult/populate the cache in the card loop |
| `src/lib/scraper/category-page.ts` | modify | Same |
| `src/lib/scraper/product-detail.ts` | modify | Not cached (single product per page) — document why |
| `src/entrypoints/amazon.content.ts` | modify | Own the cache instance; clear it on `COLLECT_PRODUCTS` and on navigation |
| `tests/scraper-performance.test.ts` | **create** | Budget + O(1) re-parse + enrichment-preservation tests |

### Implementation Details

```ts
// src/lib/scraper/parse-cache.ts
import type { ScrapedProduct } from '@/types/common';

/** Fields that Amazon hydrates lazily; a card missing any of these is re-parsed next tick. */
const HYDRATING_FIELDS = ['imageUrl', 'rating', 'reviewCount', 'bestSellersRank'] as const;

export class ParseCache {
  private readonly entries = new WeakMap<Element, { product: ScrapedProduct; complete: boolean }>();

  get(card: Element): ScrapedProduct | undefined {
    const hit = this.entries.get(card);
    return hit?.complete ? hit.product : undefined;   // incomplete → force a re-parse
  }

  set(card: Element, product: ScrapedProduct): void {
    const complete = HYDRATING_FIELDS.every((f) => product[f] != null && product[f] !== '');
    this.entries.set(card, { product, complete });
  }

  /** WeakMap self-prunes detached nodes; this only exists for explicit resets. */
  clear(): void { /* replace the map instance */ }
}
```

`WeakMap` is the right structure: entries disappear with their DOM nodes, so no manual eviction is
needed as the user scrolls and Amazon recycles card elements. `clear()` replaces the internal map
instance (a `WeakMap` cannot be emptied in place).

Wire into `parseSearchResults` / `parseCategoryPage` at the top of the per-card loop:
```ts
for (const card of cards) {
  const cached = cache?.get(card);
  if (cached) { results.push(cached); continue; }
  const product = /* existing extraction */;
  if (product) { cache?.set(card, product); results.push(product); }
}
```
The `cache` parameter is optional so all existing tests and call sites keep working unchanged.

**Cache invalidation points** (in `amazon.content.ts`):
- `COLLECT_PRODUCTS` handler — a new run must not inherit the previous run's cache
- `RESUME_SCROLLING` — same
- SPA-style navigation within Amazon (the existing page-type detection already handles this)

### Dependencies and Order
- After Phase 1: the cached product carries a `currency` value, so caching before the currency fix
  would freeze corrupted values.
- After Phase 3: `resolvePageCurrency(baseUrl)` is computed once per parse invocation (Phase 1);
  caching must not accidentally hoist or re-run it per card.
- Before Step 5.2: the observer narrowing is only worth doing once the parse itself is cheap.

### Testing and Verification
1. **Budget test:** parse a 480-card fixture, assert total time under a generous budget (e.g. 4 s in
   JSDOM) and per-card cost under 10 ms. Use `testTimeout: 30000` — the default 5 s is not enough
   for the 480-card case, which is why an earlier probe appeared to hang.
2. **O(1) re-parse test (the one that proves the fix):** spy on the per-card extraction function;
   parse the same document twice; assert the spy is called N times on the first pass and **0** times
   on the second.
3. **Enforcement-preservation test (risk R3):** parse a fixture whose cards have `imageUrl: null`;
   mutate the DOM to add images; parse again; assert the second result **has** the images. Without
   the `complete` flag this test fails — it is the guard against the obvious wrong implementation.
4. **Regression:** `tests/baseline-snapshot.test.ts` (Phase 0) must be byte-identical.
   `scraper-accuracy`, `pricing-deals-bsr`, `preview-images-rownumbers-export` must pass unchanged —
   they all construct fresh documents per test, so the cache is empty on entry.
5. Manual (Phase 11, item 3): Chrome Performance profile on a real 480-result page.

---

## Step 5.2 — H‑9b: narrow the observer and remove quadratic card filtering

### Objective
Stop re-triggering full parses on unrelated DOM churn, and remove the O(N²) `Node.contains()` loops.

### Root Cause
**(a) Whole-document observer.** `amazon.content.ts:111-114`:
```ts
observer.observe(document.body, { childList: true, subtree: true });
```
Amazon pages mutate constantly — lazy images, carousels, ad beacons, hover popovers — so every burst
re-triggers a full parse. The debounce is **trailing-only and reset on every mutation**, so a
continuously mutating page can also *starve* collection indefinitely.

> **Correction to the investigation report:** the observer does **not** watch `attributes`, and the
> overlay host is appended to `document.documentElement` (`overlayHost.ts:104`), not `document.body`,
> so overlay renders do **not** retrigger parses. See `CORRECTIONS.md` item 2.

**(b) Quadratic container filtering.** `category-page.ts:51-53`:
```ts
const filteredCards = rawCards.filter(
  (card) => !rawCards.some((other) => other !== card && other.contains(card))
);
```
is O(N²) `Node.contains()` calls. `category-page.ts:61` and `:68-72` add two more `cards.some(contains)`
inner loops, and `discoverFallbackProductCards` (`field-parsers.ts:670-712`) repeats the pattern.

**(c) Redundant container resolution.** `field-parsers.ts:442` calls
`resolveSingleProductCardContainer(card, asin)` and `:462` calls it **again** on the result inside
`extractCardByHeuristics`. Each call walks up to 6 ancestors running `querySelectorAll('[data-asin]')`,
`querySelectorAll('a[href*="/dp/"]')` and `querySelectorAll('img')` at every level.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/amazon.content.ts` | modify | Observe the results container; add a leading-edge throttle and an idle guard |
| `src/lib/scraper/category-page.ts` | modify | Replace O(N²) `filter(some(contains))` with a single-pass ancestor `Set` |
| `src/lib/scraper/field-parsers.ts` | modify | Pass the resolved container into `extractCardByHeuristics`; add early exits |
| `src/lib/scraper/selectors.ts` | modify | Export a `resultsContainer` selector per page type |

### Implementation Details

**(a) Narrow the observer.**
```ts
const container =
  document.querySelector(SELECTORS.search.resultsContainer) ??
  document.querySelector(SELECTORS.category.resultsContainer) ??
  document.body;                       // fallback preserves today's behaviour
observer.observe(container, { childList: true, subtree: true });
```
Add `resultsContainer` to `selectors.ts` (e.g. `[data-component-type="s-search-results"]`,
`.zg-grid`, `#gridIndexRoot`) following the file's existing documented selector-table convention.
Falling back to `document.body` when no container matches is what keeps this safe on unrecognised
layouts.

Then make the debounce leading+trailing with a maximum wait, so churn cannot starve collection:
```ts
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 2000;
let firstMutationAt = 0;
// in the callback:
if (!firstMutationAt) firstMutationAt = Date.now();
if (debounceTimer) clearTimeout(debounceTimer);
const elapsed = Date.now() - firstMutationAt;
debounceTimer = setTimeout(run, Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - elapsed)));
```
Plus an idle guard: skip the parse entirely when `document.hidden` or when a collection is not active.

**(b) Single-pass ancestor filtering.**
```ts
// Replaces category-page.ts:51-53
function dropNestedCards(cards: Element[]): Element[] {
  const set = new Set(cards);
  return cards.filter((card) => {
    for (let p = card.parentElement; p; p = p.parentElement) {
      if (set.has(p)) return false;     // an ancestor is also a candidate → this one is nested
    }
    return true;
  });
}
```
This is O(N × depth) instead of O(N²), and depth is bounded (~20) while N can be 500+. Apply the same
helper at `category-page.ts:61, 68-72` and in `discoverFallbackProductCards`.

**(c) Resolve the container once.** Change `extractCardByHeuristics` to accept an already-resolved
container, and delete the second `resolveSingleProductCardContainer` call at `field-parsers.ts:462`.
Also add early exits to its three loops over `allEls` (`field-parsers.ts:554` and the rating/review
and brand/availability passes): break out once the target field is found, and hoist the single
`querySelectorAll('*')` result so it is materialised once, not per loop.

### Testing and Verification
1. Observer test: mount with a fixture containing `[data-component-type="s-search-results"]`; mutate a
   node **outside** it; assert no parse was triggered (spy on `parseCurrentPage`). Then mutate inside;
   assert exactly one parse after the debounce.
2. Starvation test: mutate continuously every 50 ms for 3 s; assert at least one parse happened
   (the `MAX_WAIT_MS` cap). **Fails today.**
3. `dropNestedCards` unit test: nested, sibling and deeply-nested candidate sets produce the same
   output as the current O(N²) implementation — assert equivalence on a generated fixture, which is
   the strongest available proof of no behaviour change.
4. Benchmark: the O(N²) → O(N·depth) change on a 480-card fixture; assert wall time drops.
5. **Regression:** `baseline-snapshot` byte-identical; all parser tests unchanged.

---

## Step 5.3 — M‑2: make `countProducts` count real product cards

### Objective
Automatic mode must stop scrolling when the real results are exhausted, and must not trigger
pointless full re-parses when only carousels changed.

### Root Cause
`amazon.content.ts:248-254`:
```ts
() => {
  // Count products in DOM across search, category, deals, and ASIN/dp links
  const cards = document.querySelectorAll(
    `${SELECTORS.search.productCard}, ${SELECTORS.category.productCard}, [data-asin]:not([data-asin=""]), a[href*="/dp/"]`
  );
  return cards.length;
}
```
The last two terms match recommendation carousels, "customers also bought" modules, sponsored slots
and footer links. Measured: **1,500 nodes on a 480-card page, in 92 ms**, and this runs on *every*
tick.

Two consequences follow, via `ScrollController.tick` (`scroll-controller.ts:98-137`):
- **Wasted work.** When the raw count grows, `tick` resets `staleCount = 0` and calls `onNewProducts`,
  which runs a full re-parse. If carousel content loaded but no new *real* products appeared, dedup
  yields 0 and the parse was pure waste — and `staleCount` was reset, delaying end-of-page detection.
- **Late or premature termination.** Because `staleCount` is reset by carousel churn, the
  `staleCount >= maxStale` exit (`maxWaitForNew / scrollInterval` = 10 ticks) can be postponed
  indefinitely on a page that keeps lazy-loading peripheral content.

> **Correction to the investigation report:** the report claimed `onNewProducts` early-returns on an
> empty batch and thereby "skips `staleCount++`". That is wrong — `staleCount++` happens in `tick`'s
> own `else` branch (`scroll-controller.ts:114-116`), never inside `onNewProducts`. The report also
> claimed automatic mode "never clicks `nextPage`"; there is no pagination code in
> `scroll-controller.ts` at all, so nothing was skipped. See `CORRECTIONS.md` item 3.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/amazon.content.ts` | modify | Narrow the `countProducts` selector |
| `src/lib/scraper/scroll-controller.ts` | modify | Only — optionally — let `onNewProducts` report "no real change" so `staleCount` is not reset |

### Implementation Details

**Minimal fix (recommended):** count only real cards.
```ts
() => document.querySelectorAll(
  `${SELECTORS.search.productCard}, ${SELECTORS.category.productCard}`
).length
```
This drops `[data-asin]` and `a[href*="/dp/"]`. **Verify first** that the deals and bestsellers page
types are covered by one of the two card selectors — if `parseDealsPage` relies on `[data-asin]`,
add a deals-specific card selector rather than reinstating the broad term. This is a 15-minute
investigation that must happen before the change, not after.

**Stronger fix (optional, only if the minimal one proves insufficient in manual testing):** change
`onNewProducts` to return a boolean and let `tick` decide:
```ts
onNewProducts: (count: number) => boolean   // true = real new products found
...
const foundReal = onNewProducts(currentCount);
if (foundReal) { this.staleCount = 0; ... } else { this.staleCount++; }
```
This decouples "the DOM grew" from "we found something", which is the actual semantic the controller
wants. It changes a public method signature on `ScrollController`, so it is gated behind manual
verification rather than shipped speculatively.

### Testing and Verification
1. **The reproducing test:** a fixture whose raw `a[href*="/dp/"]` count grows (simulating a
   carousel) while `parseCurrentPage` returns no new products → assert `onEndOfPage` fires within
   `maxWaitForNew / scrollInterval + margin` ticks. With the minimal fix this passes because the
   narrow count stops growing.
2. Assert `countProducts` no longer matches footer/carousel links: build a fixture with 10 real cards
   and 40 carousel links, assert the count is 10.
3. Selector-coverage test: for each page type (`search`, `category`, `deals`, `bestsellers`), assert
   `countProducts()` returns a number ≥ the count of products the corresponding parser extracts. A
   counter that under-counts would terminate collection early — this is the regression the minimal fix
   could introduce.
4. Manual (Phase 11, item 5): set target 500 on a search page with ~120 results in Automatic mode;
   confirm collection completes rather than scrolling forever.

---

## Step 5.4 — M‑7: stop dropping products silently

### Objective
When `ProductSchema.safeParse` rejects a product, the operator must be able to see it.

### Root Cause
`background.ts:270-283`:
```ts
const parsed = ProductSchema.safeParse(candidate);
if (parsed.success) { validatedProducts.push(parsed.data); }
// ← no else: no console.warn, no counter, no user notification
```
and at `:286`: `if (validatedProducts.length === 0) return;` — a whole batch can vanish without a
trace. The schema is strict in ways that can realistically fail: `url: z.string().url()`,
`imageUrl: z.string().url().nullable()`, `collectedAt: z.string().datetime()` (**Zod rejects `+HH:MM`
offsets unless `{ offset: true }`**), `rating: min(0).max(5)`, `reviewCount: int()`. The same pattern
exists in `validateAndNormalizeScrapedProduct` (`field-parsers.ts:1412-1414`), a bare
`catch { return null }` that swallows the exception as well.

This becomes more important after Phase 1, which adds a `currency` regex refinement — a rejection
there would otherwise be invisible.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/background.ts` | modify | Collect rejections, log, and surface a threshold breach |
| `src/lib/schemas/product.ts` | modify | `collectedAt: z.string().datetime({ offset: true })` |
| `src/lib/scraper/field-parsers.ts` | modify | Log inside the `catch` rather than swallowing |

### Implementation Details
```ts
const validatedProducts: Product[] = [];
const rejections: Array<{ asin?: string; issues: string[] }> = [];

for (const candidate of rawProducts) {
  const parsed = ProductSchema.safeParse(candidate);
  if (parsed.success) validatedProducts.push(parsed.data);
  else rejections.push({
    asin: typeof candidate?.asin === 'string' ? candidate.asin : undefined,
    issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
}

if (rejections.length > 0) {
  console.warn(`[BG] Dropped ${rejections.length}/${rawProducts.length} products`, rejections.slice(0, 5));
  if (rejections.length / Math.max(1, rawProducts.length) > REJECT_THRESHOLD) {
    // Surface to the UI as a non-fatal attention toast, not an error that stops collection
    void notifyRejectionRate(sessionKey, rejections.length, rawProducts.length);
  }
}
```
`REJECT_THRESHOLD` = 0.1. The notification path should reuse the existing `CONTENT_ERROR` channel
with a non-fatal code, or a new `UPDATE_PROGRESS` field — decide during implementation and keep it
consistent with Phase 3's `notifications` gate, so a user who disabled notifications does not get one.

`datetime({ offset: true })` is a one-word change that removes a whole class of silent rejection for
users east of Greenwich.

### Testing and Verification
1. Post a batch with one product carrying `collectedAt: '2026-10-16T12:00:00+06:00'` and one valid →
   assert **both** are now stored (the offset fix) — before the fix, assert the offset one is dropped
   and a warning is logged.
2. Post a batch with an invalid `rating: 9` → assert the valid products are still stored, a warning is
   logged, and the rejection is counted.
3. Post a batch where >10% are invalid → assert the non-fatal notification fires; assert it does
   **not** fire when `settings.notifications === false`.
4. Schema unit tests enumerating each strict field with a near-miss value, so future strictness
   changes are deliberate.
5. **Regression:** `if (validatedProducts.length === 0) return;` behaviour must be preserved — an
   all-invalid batch still writes nothing, but now logs.

---

## Phase 5 exit criteria

- [ ] A second parse of an unchanged document performs zero per-card extractions
- [ ] Cards with late-hydrating fields are still re-parsed until complete (risk R3 test passes)
- [ ] The observer targets the results container and cannot be starved by continuous churn
- [ ] No O(N²) `Node.contains()` loops remain in `category-page.ts` or `field-parsers.ts`
- [ ] `countProducts` counts real cards only, verified per page type
- [ ] Automatic mode terminates on an exhausted page (test + manual check)
- [ ] Schema rejections are logged, counted, and surfaced above a 10% threshold
- [ ] `tests/baseline-snapshot.test.ts` is byte-identical to Phase 0
- [ ] `tsc --noEmit` at **≤ 104** errors · `vitest run` at **≥ 151** passing · `wxt build` OK
