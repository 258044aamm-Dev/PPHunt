# SAD-386 — implementation record and verification

> Branch `feat/sad-386-deal-discount`, six steps, each with its own commit,
> `tsc` + build + full suite green before the commit. Plan:
> [`SAD-386-deal-discount-plan.md`](SAD-386-deal-discount-plan.md).

## 1. What shipped, step by step

| Step | Commit subject | Product data changes? | Tests added |
|---|---|---|---|
| 1 | normalise every discount form Amazon prints (and stop reading coupons as discounts) | yes — `discountPercentage` | `sad-386-discount-normalizer.test.ts` (6) |
| 2 | find the discount and deal badges the page actually renders | yes — both fields | `sad-386-card-deal.test.ts` (12) |
| 3 | read the product page's whole price area, not just the price | yes — both fields | `sad-386-pdp-scope.test.ts` (5) |
| 4 | let a hydrated badge reach the parser (cache TTL) | yes — both fields | `sad-386-cache-freshness.test.ts` (5) |
| 5 | say why a discount or deal was not extracted | **no** (diagnostics only) | `sad-386-diagnostics.test.ts` (8) |
| 6 | verification, capture tool, docs | no | `sad-386-workflow-parity.test.ts` (4) |

## 2. Root causes, as confirmed in code

| # | Cause | Where | Fixed in |
|---|---|---|---|
| 1 | normaliser refused U+2212/en-dash/em-dash minuses, `Save NN%`, bare `NN%` | `field-parsers.ts` `normalizeDiscountBadge` | step 1 |
| 2 | a coupon percentage was stored as the product discount | same function | step 1 |
| 3 | discount node guard was `children.length > 1`, dropping wrapped percentages | `field-parsers.ts` discount block | step 2 |
| 4 | deal badge only read from 7 card selectors; status-badge slot, bare `data-a-badge-type`, `dealBadge` class/id missed | `selectors.ts` + `field-parsers.ts` | step 2 |
| 5 | two divergent deal vocabularies (card vs PDP) | `field-parsers.ts`, `product-detail.ts` | step 2 |
| 6 | buybox loop stopped at the first scope with a price | `product-detail.ts` | step 3 |
| 7 | parse cache memoised a card permanently before hydration | `parse-cache.ts` | step 4 |
| 8 | diagnostics could not distinguish absent from unreadable for these two fields | `card-diagnostics.ts`, `product-detail.ts` | step 5 |

## 3. Bugs the new guard tests caught during implementation (all fixed, all pinned)

| Bug | Caught by | Fix |
|---|---|---|
| "Amazon's Choice" in the shared status-badge slot stored as a **deal** | `sad-386-card-deal.test.ts` | shared slot gated by the deal vocabulary |
| A product titled *"Deal Dash Board Game Deluxe Edition"* stored as a **deal** | same | title / review / delivery / coupon regions excluded from the text scan |
| On PDPs a derived `Deal` terminated the badge search, so a printed `Limited-time deal` was replaced by `Deal` | existing `pricing-deals-bsr.test.tsx` | collect the printed badge in a local before overriding |
| The new central-column scan read `-90%` and a deal label from a similar-items carousel | `sad-386-pdp-scope.test.ts` | scans take a `skip` hook; PDP passes `isInsideExcludedDetailSubtree` |

## 4. Decisions honoured

| Operator decision | Implementation |
|---|---|
| Deal = badge text + derived flag, no new column | `dealBadge` only; derived value is the canonical `Deal` |
| Discount printed-only | no percentage is computed from price/list price; the `/deals` grid keeps `discountPercentage` empty |
| Amazon only | no Temu file touched; `tests/temu-isolation.test.ts` green |
| Blocking live capture | Amazon answers this sandbox 503 (direct **and** via a reader proxy), so only markup-agnostic work plus fixtures already committed in the repo shipped; `scripts/sad-386-capture.mjs` is committed for a real browser |
| Struck list price counts as a deal (D5) | `TREAT_STRUCK_LIST_PRICE_AS_DEAL = true`, one line to flip |
| 2 s cache TTL (D6) | `DEFAULT_PARSE_CACHE_TTL_MS = 2000`, clock injectable, `Infinity` restores the old behaviour |
| Derived token text | `'Deal'` |

## 5. Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx wxt build` | OK, `dist/chrome-mv3` |
| `npx vitest run` | **1267 passed / 112 files** (baseline 1216 / 106) |
| `npm run verify` (tsc + vitest + wxt build + audit) | **passed**, `dist` 2.01 MB, `found 0 vulnerabilities` |
| Baseline at `a10e174` | **1216 tests / 106 files** |

The delta is +51 tests in 6 new files; no existing test was edited except where
this report records an intentional behaviour change (none: every existing
expectation still holds).

## 6. Regression protection

| Invariant | Proof |
|---|---|
| Every other product field unchanged | each step's fixtures deep-compare full products; the only fields that move are `discountPercentage` and `dealBadge` |
| Diagnostics changes are diagnostics-only | `sad-386-diagnostics.test.ts` deep-equals a product with and without a sink |
| 24-field report shape | asserted in `sad-386-diagnostics.test.ts` |
| `badge` ≠ `dealBadge` | asserted in both directions |
| Price selection unchanged | `sad-386-pdp-scope.test.ts` (first-wins price) + `pricing-deals-bsr.test.tsx` |
| Cache performance contract | `scraper-performance.test.ts` (10 tests incl. 480-card budget) |
| Temu untouched | `temu-isolation`, `temu-schemas`, `temu-scraper`, `temu-extraction-diagnostics` |
| Schema / DB / export / UI | no file under `db/`, `export/`, `ui/`, `schemas/` was modified by this branch |

## 7. What is NOT covered, and why

- **No new Amazon-specific product-page selector** (`detail.dealBadge`,
  `detail.discount`) ships in this branch. Amazon's markup could not be observed
  from here, and the plan forbids shipping a selector on a guess. Run
  `scripts/sad-386-capture.mjs` and the two registry keys can be added with
  evidence.
- **Discount stays empty where Amazon prints no percentage** — the operator's
  printed-only decision. On the `/deals` grid this is now visible as `Deal`
  (proven) but no `Discount`.
- **A live end-to-end measurement** (`npm run measure:diagnostics`) needs the
  same browser access; the harness command is unchanged and ready:
  `npm run build && npm run measure:diagnostics -- --flag on --asins <list>`.
