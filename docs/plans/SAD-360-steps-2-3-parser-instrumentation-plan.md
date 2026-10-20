# SAD-360 — Steps 2 & 3: parser instrumentation plan (Temu Engine)

> **Scope of this document: steps 2 and 3 only** (owner instruction, 2026-10-20).
> Step 2 = PDP instrumentation. Step 3 = shared-helper + card instrumentation.
> Steps 4 (message ride-along, seen-key ledger, service-worker logging) and 5
> (full verify/report) are **not designed here**; §13 records only the forward
> constraints this plan must respect so they stay implementable.
>
> Status: **PLAN ONLY. No source file is modified by this document.**
> Branch audited: `feat/temu-engine` @ `b826132` (steps 0–1 already committed).
> Plan written against `origin/main` `6f168df` + the three SAD-360 commits.

---

## 0. Baseline re-verified for this plan (measured, not quoted)

Run in a fresh clone of `feat/temu-engine` (`b826132`) before writing:

| Check | Command | Result |
|---|---|---|
| Dependencies | `npm ci --no-audit --no-fund` | exit 0 |
| Types | `npm run compile` (`tsc --noEmit`) | clean |
| Focused suites | `npx vitest run tests/temu-extraction-diagnostics.test.ts tests/temu-scraper.test.ts tests/temu-schemas.test.ts tests/temu-isolation.test.ts` | **61/61 passed** (38 + 9 + 8 + 6) |
| Build | `npm run build` (`wxt build`) | pass — 28 files, 1.97 MB, `content-scripts/temu.js` 133.69 kB |
| Full suite | `npx vitest run` | **89 files / 1084 tests passed** (matches the step-1 record exactly) |

Environment note: this audit ran on **Node v20.20.2**; the step-0 record used
v22.23.3 (WXT's stated minimum is 22). `wxt build` succeeded here anyway, but
the implementation steps should keep using Node ≥22 so results stay comparable
with the recorded baseline.

Already on the branch (do not redo):

| Commit | Content |
|---|---|
| `c7f3bda` | plan-only review, decisions D1–D8 |
| `d410326` | step-0 baseline + amendments A1–A3 |
| `b826132` | `src/engines/temu/scraper/extraction-diagnostics.ts` (254 lines) + `tests/temu-extraction-diagnostics.test.ts` (38 tests) |

The collector module is **not referenced by production code yet** — steps 2–3
are exactly the wiring that makes it referenced, without touching transport.

---

## 1. What steps 2 & 3 deliver

After step 3 the two Temu parsers can produce a per-product
`ExtractionDiagnosticsReport` **when a caller passes an optional collector**:

* PDP: `parseTemuProductDetail(document, url?, diagnostics?)` → 22 fields.
* Cards: `parseTemuSearchResults(document, pageUrl?, cache?, source?, diagnosticsByGoodsId?)`
  → 20 fields; `parseTemuCategoryPage` forwards it unchanged.

No message schema, background handler, content-script, DB, UI, export or
selector file changes in these two steps. Until step 4 wires transport, the
reports are reachable only from tests — production behaviour is byte-identical.

---

## 2. Files this plan touches (complete list)

| File | Change | Est. diff |
|---|---|---|
| `src/engines/temu/scraper/field-parsers.ts` (1062 L) | 6 exported helpers gain a trailing **optional** `diagnostics?: FieldDiagnosticsCollector`; candidate-evidence counters only | +130 / −10 |
| `src/engines/temu/scraper/product-detail.ts` (383 L) | optional 3rd param; evidence at the 22 merge points; `candidate` captured before validation; `applyValidationResults` call; JSON-LD rejection/malformed evidence; 2 private helpers gain the same optional param | +170 / −15 |
| `src/engines/temu/scraper/search-results.ts` (114 L) | optional 5th param `diagnosticsByGoodsId`; per-card collector in the cache-miss branch | +45 / −5 |
| `src/engines/temu/scraper/category-page.ts` (20 L) | forwarding-only 5th param | +3 / −1 |
| `tests/temu-diagnostics-pdp.test.ts` | **new** — step 2 fixtures + parity | ~420 |
| `tests/temu-diagnostics-cards.test.ts` | **new** — step 3 fixtures + parity | ~320 |
| this document | plan record | — |

**Untouched, verified by diff at the end of each step:** everything under
`src/engines/amazon/**`, `src/entrypoints/amazon.content.ts`,
`src/entrypoints/temu.content.ts`, `src/engines/temu/schemas/**`,
`src/engines/temu/background/**`, `src/engines/temu/db/**`,
`src/engines/temu/scraper/selectors.ts`, `src/engines/temu/ui/**`,
`src/engines/temu/export/**`, `wxt.config.ts`, `package.json`, `package-lock.json`.

Why no new module is needed: step 1 already ships every primitive required
(`createFieldDiagnosticsCollector`, `extracted/missing/parseFailed/partial/rescued/unknown`,
`entries()`, `applyValidationResults`, `summarizeFieldDiagnostics`,
`formatTemuExtractionDiagnosticsLog`). Steps 2–3 add **call sites only**.

---

## 3. The instrumentation contract (rules the implementation must obey)

These rules are derived from the collector's committed API and from the Amazon
precedent (`src/engines/amazon/scraper/product-detail.ts`), not invented here.

### R1 — Two layers of evidence, last write wins

* **Helpers record candidate-level evidence** inside the existing loops:
  * value produced → `extracted(field, { source, selector })`
  * no value **and** ≥1 candidate node existed → `parseFailed(field, '<static reason>', { source, selector })`
  * no value **and** zero candidates → `missing(field, '<static reason>', { source })`
* **The parser records the final merged outcome** after each source chain
  (`DOM → JSON-LD → og:*`), overwriting the helper's record when the final
  result comes from a later source.

The collector's `record()` is last-write-wins by design (`byField.set`), and
`entries()` exposes the live map precisely so a caller can read the prior
status before deciding to overwrite — both are step-1 behaviour, no change.

### R2 — Rescue vs. clean fallback

For a field whose final value comes from source *n* > 1:

```
prior = collector.entries().get(field)?.status
prior === 'PARSE_FAILED'  →  collector.rescued(field, '<static reason>', { source: <source n> })
                                 // ⇒ status PARTIAL: the DOM had the value but rejected it
otherwise                 →  collector.extracted(field, { source: <source n>, selector? })
```

Reference precedent, Amazon `product-detail.ts:995-1012`:
`partial('price', 'buybox present but no parseable DOM price; JSON-LD fallback used', { source: 'json-ld' })`
vs `extracted('price', { source: 'json-ld' })`.

### R3 — No value anywhere

Leave the helper's `PARSE_FAILED`/`MISSING` record untouched. Only if **no
record exists at all** (parser reached the merge with no helper evidence) does
the parser write `missing(field, '<static reason>', { source })`. Never write
`MISSING` when the parser did not complete the check — `build()` already fills
unreached fields with `UNKNOWN 'not attempted'`.

### R4 — Malformed JSON-LD never proves absence

`extractTemuJsonLdMetadata` currently swallows malformed blocks
(`product-detail.ts:374-376`). It will report `malformedJsonLd: true`. Rule,
**restricted to the ten fields that actually have a JSON-LD source**
(`title`, `description`, `imageUrl`, `price`, `currency`, `rating`,
`reviewCount`, `brand`, `seller`, `availability`):

* field has no value **and** has no DOM candidate evidence **and**
  `malformedJsonLd` → `unknown(field, 'malformed JSON-LD block; attribution unknown')`
  (per §11 of the existing plan: never report definitive absence without evidence).
* field has DOM candidate evidence → keep `PARSE_FAILED` (the DOM *is* evidence).
* fields with **no** JSON-LD source (`listPrice`, `discountPercentage`,
  `pastMonthSales`, `dealBadge`, `badge`, `coupon`, `delivery`,
  `bestSellersRank`, `features`, `isSponsored`, `isPrime`) are unaffected: a
  malformed block says nothing about them, so `MISSING` stays correct.

### R5 — Source vocabulary (no `api`)

| source | used for |
|---|---|
| `dom` | a DOM selector read; always carry the `selector` that was actually queried |
| `json-ld` | `application/ld+json` `Product`/`BreadcrumbList` |
| `url` | the `url` field when it came from the canonical link or the page URL |
| `derived` | computed/defaulted values: currency fallback, booleans, canonical URL built from `goodsId` |

Temu makes **zero** fetch/API calls — there is no `api` source (issue Req 2,
confirmed by reading the whole `src/engines/temu/` tree).

### R6 — Reasons are static strings

Never interpolate a title, price, URL, or HTML into `reason`. A test in each
file formats a real report and asserts that fixture values do not appear in the
line (extends the step-1 guarantee from the formatter to the call sites).

### R7 — No new DOM work

Instrumentation may only add **boolean/number bookkeeping** inside loops that
already run. Explicitly forbidden: extra `querySelector(All)` calls, extra
`Array.from`, extra regex scans, reordering of checks, or changing any return
value/ordering. This is what keeps the parity test (R8) meaningful.

### R8 — Parity is the acceptance gate

For every fixture, in both paths:

```ts
const without = parseTemuProductDetail(doc, url);
const collector = createFieldDiagnosticsCollector('product_detail');
const withDiag = parseTemuProductDetail(doc, url, collector);
expect(withDiag).toStrictEqual(without);   // deep equality, incl. null/undefined shape
```

Same for cards (array-equality) and for cache behaviour (a cached card must
still return the identical product object with a collector supplied).

---

## 4. PDP field matrix — 22 fields, exact outcome per evidence

Reference implementation file: `src/engines/temu/scraper/product-detail.ts`.
"Line" is the current line in `b826132`.

| # | Field | Current source chain (lines) | Evidence available today | Recording rule |
|---|---|---|---|---|
| 1 | `url` | `resolveTemuProductUrl(canonicalHref ?? baseUrl, goodsId, baseUrl)` (171) | `resolveTemuProductUrl` never returns `''` — it falls back to the origin (`temu-url.ts:116-149`) | Always `EXTRACTED`. `source:'url'` + `selector:'link[rel="canonical"]'` + reason `'resolved from the canonical link'` when `canonicalHref` exists, else `source:'derived'` + reason `'built from goodsId and page origin'`. The reason must not claim which internal branch of `resolveTemuProductUrl` ran |
| 2 | `title` | `h1[aria-label]`→`h1` text→JSON-LD `name`→`og:title` (78-87) | `titleEl` presence; `ldMeta.title`; og meta | DOM won → `EXTRACTED dom` + `TEMU_SELECTORS.productDetail.title`. `titleEl` exists but both reads empty → `PARSE_FAILED 'title element present but produced no text'`. JSON-LD rescue → `PARTIAL` if prior `PARSE_FAILED`, else `EXTRACTED json-ld`. og:title → same rule, `selector:'meta[property="og:title"]'`. Nothing → `MISSING 'no h1 title element, JSON-LD name, or og:title'` (or `UNKNOWN` per R4) |
| 3 | `price` | `extractTemuPricing(...).price ?? ldMeta.price` (103) | helper sees `[data-type="price"]` nodes and the heuristic fallback | Helper: parsed → `EXTRACTED dom ['[data-type="price"]' or 'heuristic leaf price node']`; candidates but unparsed → `PARSE_FAILED 'price node present but no parseable price'`; none → `MISSING 'no price node in the price scope'`. JSON-LD wins → R2 |
| 4 | `listPrice` | `extractTemuPricing(...).listPrice` (108) only — **no JSON-LD fallback** | `TEMU_SELECTORS.listing.listPrice` node count | parsed → `EXTRACTED dom`; candidates → `PARSE_FAILED 'list-price node present but no parseable value'`; none → `MISSING 'no original/list price node'`. Validator nulls `listPrice === price` (`field-parsers.ts:962-968`) → `applyValidationResults` turns it into `PARTIAL validated:false` |
| 5 | `discountPercentage` | same helper (109) | `[data-type="discount"]` + short-element scan | parsed → `EXTRACTED dom`; candidate (any `%` token) → `PARSE_FAILED 'discount node present but not a valid percentage'`; none → `MISSING 'no discount badge'` |
| 6 | `currency` | `domPricing.currency ?? ldMeta.currency ?? ('USD' if price/listPrice)` (104-107) | currency token travels with the price text | DOM token → `EXTRACTED dom`; JSON-LD → `EXTRACTED json-ld`; defaulted → `EXTRACTED derived`, reason `'defaulted to USD because a price was parsed'` (Amazon precedent: `product-detail.ts:1010`); no price at all → `MISSING 'no currency token and no price to derive from'` |
| 7 | `rating` | `extractTemuRatingAndReviews(...).rating ?? ldMeta.rating` (118) | rating nodes (`role=img`, aria "out of five stars") | parsed → `EXTRACTED dom`; nodes but no 0–5 value → `PARSE_FAILED 'rating element present but not a 0–5 value'`; none → `MISSING 'no rating element or JSON-LD aggregateRating'`; JSON-LD wins → R2 |
| 8 | `reviewCount` | `....reviewCount ?? ldMeta.reviewCount` (119) | rating region + review-ish candidate scan | parsed → `EXTRACTED dom`; review candidates but no count → `PARSE_FAILED 'review-count node present but not a count'`; none → `MISSING 'no review-count node or JSON-LD reviewCount'`; JSON-LD wins → R2 |
| 9 | `pastMonthSales` | `extractTemuSalesVolume(pdpScope)` (122) — no JSON-LD | `[data-type="saleTips"]` + leaf span scan | `EXTRACTED dom` / `PARSE_FAILED 'sales-tip node present but no sales token'` / `MISSING 'no sales-tip node'` |
| 10 | `imageUrl` | `extractTemuBestImageUrl(heroImgEl) ?? ldMeta.imageUrl ?? og:image` (125-135) | `heroImgEl` presence; `ldMeta.imageUrl`; og meta | hero URL → `EXTRACTED dom` + `TEMU_SELECTORS.productDetail.heroImage`; hero element but no http(s)/placeholder URL → `PARSE_FAILED 'hero image element present but no valid http(s) URL'`; JSON-LD/og wins → R2; none → `MISSING 'no hero image, JSON-LD image, or og:image'`. Validator drops non-http images (`field-parsers.ts:990-1003`) → `PARTIAL validated:false` |
| 11 | `brand` | `meta.brand ?? ldMeta.brand` (154) | `Brand:` label scan in metadata helper | helper match → `EXTRACTED dom`; label prefix present but empty → `PARSE_FAILED 'Brand label present but empty'`; none → `MISSING 'no Brand label or JSON-LD brand'`; JSON-LD wins → R2 |
| 12 | `seller` | `meta.seller ?? ldMeta.seller` (153) | `Sold by/Provided by/Shop/Store` label | same shape as #11 (`'no Sold by / Provided by / Shop / Store label or JSON-LD seller'`) |
| 13 | `availability` | `meta.availability ?? ldMeta.availability` (155) | stock phrases; JSON-LD `offer.availability` | helper match → `EXTRACTED dom`; JSON-LD string present but not InStock/OutOfStock → `PARSE_FAILED 'availability value present but not mapped'`; none → `MISSING 'no stock phrase or JSON-LD availability'` |
| 14 | `dealBadge` | `meta.dealBadge` (176) | deal keyword scan | `EXTRACTED dom` / `MISSING 'no deal marker found'` (keyword-driven: no candidate can be "rejected") |
| 15 | `badge` | `meta.badge` (183) | recognition keyword scan | `EXTRACTED dom` / `MISSING 'no recognition badge found'` |
| 16 | `coupon` | `meta.coupon` (182) | coupon keyword scan | `EXTRACTED dom` / `MISSING 'no coupon marker found'` |
| 17 | `delivery` | `meta.delivery` (184) | shipping keyword scan | `EXTRACTED dom` / `MISSING 'no shipping/delivery marker found'` |
| 18 | `bestSellersRank` | `meta.bestSellersRank` (180) | rank regex | `EXTRACTED dom` / `MISSING 'no best-seller rank text found'` |
| 19 | `description` | `ldMeta.description ?? meta[name=description]` (159-165) | JSON-LD description; page meta | JSON-LD → `EXTRACTED json-ld`; JSON-LD property present but empty after cleaning → `PARSE_FAILED 'JSON-LD description present but empty'`; meta → `EXTRACTED dom selector:'meta[name="description"]'`; none → `MISSING 'no JSON-LD description or meta description'` (R4 applies) |
| 20 | `features` | `extractTemuPdpFeatures(document)` (158, 218-239) | `li, tr` candidates inside `#goodsDetail/#leftContent/#rightContent` | non-empty → `EXTRACTED dom` + reason `'feature/spec list items'`; candidates existed but all filtered (length/dedup) → `PARSE_FAILED 'feature candidates rejected by length or dedup filters'`; zero candidates → `MISSING 'no feature/spec list nodes'` |
| 21 | `isSponsored` | `meta.isSponsored` (186) | `/^(Ad|Sponsored)$/` marker | D6: marker found → `EXTRACTED derived`; absent → `MISSING 'no Ad/Sponsored marker found'`. **Never** `validated:false` |
| 22 | `isPrime` | `meta.isPrime` (187) | `Local warehouse` marker | D6: found → `EXTRACTED derived`; absent → `MISSING 'no Local warehouse marker found'` |

**Envelope.** `goodsId` is not a field (D5). `collector.setGoodsId(goodsId)` is
called immediately after resolution (line 67), before the `if (!goodsId) return null`
guard at line 69, so a failed PDP still yields a report with `goodsId: null`
and 22 × `UNKNOWN 'not attempted'` (D7). `asin`/`source`/`categoryBreadcrumb`
are never recorded (D5; `record()` also rejects unknown field names).

---

## 5. Card field matrix — 20 fields

Reference: `src/engines/temu/scraper/search-results.ts:46-111` +
`field-parsers.ts`. `description`/`features` are excluded by
`CARD_DIAGNOSTIC_FIELDS` — no code may record them (the collector silently
drops them, but the tests assert their absence so a future edit can't sneak in
permanent `MISSING` noise).

| # | Field | Source chain (line) | Recording rule |
|---|---|---|---|
| 1 | `url` | `resolveTemuProductUrl(linkHref, goodsId, baseUrl)` (75) | `EXTRACTED`, `source:'url'` + reason `'resolved from the card product link'` when `linkHref` exists, else `'derived'` + `'built from goodsId and page origin'` |
| 2 | `title` | `extractTemuCardTitle(card, imageEl)` (65) — 4 DOM fallbacks | `EXTRACTED dom` + the winning selector (`[data-tooltip-title]`, `[data-tooltip^="goodName-"]`, `h1,h2,h3,h4`, `a[href*="-g-"]`, `img[alt]`); candidates but none accepted → `PARSE_FAILED 'title candidates present but all rejected'`; none → `MISSING 'no title tooltip, heading, link text, or image alt'` |
| 3 | `price` | `extractTemuPricing(card, 'USD')` (66) | as PDP #3 |
| 4 | `listPrice` | same | as PDP #4 |
| 5 | `discountPercentage` | same | as PDP #5 |
| 6 | `currency` | `pricing.currency` (81) | parsed token → `EXTRACTED dom`; no price at all → `MISSING 'no currency token and no price to derive from'` |
| 7 | `rating` | `extractTemuRatingAndReviews(card)` (68) | as PDP #7, but **no JSON-LD rescue** |
| 8 | `reviewCount` | same | as PDP #8 |
| 9 | `pastMonthSales` | `extractTemuSalesVolume(card)` (67) | as PDP #9 |
| 10 | `imageUrl` | `findBestTemuCardImage(card, goodsId, baseUrl)` (60-64) | `EXTRACTED dom` + winning selector (`img[data-js-main-img="true"]` / `img.goods-img-external` / `img[src*="kwcdn.com"]` / fallback `img`); `img` present but no valid URL → `PARSE_FAILED 'image element present but no valid http(s) URL'`; no `img` → `MISSING 'no image element in the card'` |
| 11-18 | `brand`, `seller`, `availability`, `dealBadge`, `badge`, `coupon`, `delivery`, `bestSellersRank` | `extractTemuCardMetadata(card)` (69) | same rules as PDP #11-18, no JSON-LD rescue |
| 19 | `isSponsored` | `meta.isSponsored` (90) | D6 |
| 20 | `isPrime` | `meta.isPrime` (91) | D6 |

Card-specific behaviours that the tests must pin:

* **Cache hit** (`search-results.ts:51-57`) → no collector is created → no
  report. Re-parsing the same card from cache must produce neither a product
  change nor a report.
* **Validation failure** (`validated === null`, line 103) → the report is
  **not** stored in the out-map (the product was not collected; §11 "logging
  eligibility must confirm actual persisted membership").
* **Deduplication inside one parse** (`seenGoodsIds`, line 49) → the second
  occurrence is skipped before parsing, so at most one report per goodsId.
* `source` label maps to stage: `'search' → 'search'`, `'category' → 'category'`
  (never `'detail'`; `TemuDiagnosticStage` excludes `'unknown'`).

---

## 6. Helper-by-helper change specification

§6.1–§6.6 are in `src/engines/temu/scraper/field-parsers.ts`;
§6.7–§6.8 are module-private helpers in `src/engines/temu/scraper/product-detail.ts`.

All signatures gain a **trailing optional** parameter, so every existing call
site and test keeps compiling and behaving identically. Only a type import is
added at the top of each file (no runtime import, no cycle:
`extraction-diagnostics.ts` imports only `../types`).

```ts
import type { FieldDiagnosticsCollector } from './extraction-diagnostics';
```

### 6.1 `extractTemuPricing` (439-590)

```ts
export function extractTemuPricing(
  container: Element,
  fallbackCurrency = 'USD',
  diagnostics?: FieldDiagnosticsCollector
): { price: number | null; currency: string | null;
     listPrice: number | null; discountPercentage: string | null }
```

Counters to add (no new queries):

* `sawPriceNode` — set inside the existing `priceNodes` loop when a node is not
  a strike/reference node; and inside the heuristic loop when a node's text
  matched the currency-shape regex at line 526 (`/US\$|CA\$|AU\$|[$€£¥]\s*\d/`).
  Track `priceSource` = `'[data-type="price"]'` or `'heuristic leaf price node'`
  for the winning branch.
* `sawListPriceNode` — `listPriceCandidates.length > 0` (line 540).
* `sawDiscountNode` — `discountCandidates.length > 0` or any short element whose
  text contains `%` in the 573-587 loop.

At the end, before `return`, record `price`, `listPrice`, `discountPercentage`
and (when non-null) `currency` exactly as in the matrix. **Do not** record
`currency` as `MISSING` here — the PDP may still default it to `USD`
(`derived`) and the card parser records the card-specific reason.

### 6.2 `extractTemuSalesVolume` (595-619)

Add `diagnostics?`. Track `sawSalesTip = saleTipNodes.length > 0 ||
<leaf scan saw a text matching /\d[\d,.]*\s*[KkMm]?\+?\s*sold\b/i>`. Record
`pastMonthSales` per matrix. Note the leaf scan (607-616) calls
`normalizeTemuSalesText`, so the "candidate existed" test is the same regex the
normalizer uses — no new regex.

### 6.3 `extractTemuRatingAndReviews` (624-690)

Add `diagnostics?`. Track `sawRatingNode` (line 632 loop) and
`sawReviewCandidate` (elements in the 658-686 scan whose aria matches
`/\b(?:reviews?|ratings?)\b/i` or whose text matches the parenthesized/`N reviews`
pattern at 676-678 — both already used by the code). Record `rating` and
`reviewCount` independently.

### 6.4 `extractTemuCardTitle` (360-415)

Add `diagnostics?`. Record the winning selector per fallback:
`[data-tooltip-title]` (365/370), `[data-tooltip^="goodName-"]` (379),
`h1,h2,h3,h4` (385), `a[href*="-g-"],[href*="goods.html"],[href*="goods_id="]` (393),
`img[alt]` (408). `sawTitleCandidate` = any of those queries returned a node.
No match + no candidate → `MISSING`; no match + candidate → `PARSE_FAILED`.

### 6.5 `findBestTemuCardImage` (755-802)

Add `diagnostics?` (4th param). Record `imageUrl` with the selector that won;
`sawImageEl = candidates.length > 0` inside `searchIn`. Do **not** change
`extractTemuBestImageUrl` — the PDP calls it directly and records at its own
call site (§7 #10), so one signature stays untouched.

### 6.6 `extractTemuCardMetadata` (807-936)

Add `diagnostics?`. Record all ten outputs inside/after the existing scan:

* booleans per D6 (`isSponsored`, `isPrime`);
* `dealBadge`, `badge`, `coupon`, `delivery`, `bestSellersRank` → `EXTRACTED dom`
  or `MISSING 'no <…> marker found'`;
* `brand`/`seller` → `EXTRACTED dom`, or `PARSE_FAILED` when the label prefix
  matched but the captured value cleaned to `null`
  (`/^Brand\s*[:：]\s*(.+)$/` and `/^(?:Sold\s+by|…)\s*[:：]?\s*(.+)$/` at 907-921
  already exist — add a prefix-only test, no new regex on new text);
* `availability` → `EXTRACTED dom` or `MISSING 'no stock phrase in the page metadata'`.

Because this helper runs on both paths, its records are candidate-level on PDP
(`brand`/`seller`/`availability` may be rescued by JSON-LD → R2) and final on
cards.

### 6.7 `extractTemuPdpFeatures` (private, 218-239)

Add `diagnostics?`: count `items` (line 225) as candidates, and whether any
survived the filters. Record per matrix #20.

### 6.8 `extractTemuJsonLdMetadata` (private, 245-383)

Two additive changes, both inside the existing loops (no new queries):

1. Signature `(document: Document, diagnostics?: FieldDiagnosticsCollector)`.
   Record **only rejections**, with `{ source: 'json-ld' }`:
   * `aggregateRating.ratingValue` present but `parseTemuRating` → null (329-332)
   * `reviewCount`/`ratingCount` present but `parseTemuReviewCount` → null (338-343)
   * `offers.price` present but `parseTemuPrice(...).value` → null (352-356)
   * `offer.availability` a string that matches neither `/InStock/i` nor `/OutOfStock/i` (365-371)
   * `item.name` / `item.description` present but `cleanTemuText` → null (295-301)
   Never record successes here — the caller owns the final outcome.
2. Return type gains `malformedJsonLd: boolean`, set in the existing
   `catch {}` at 374-376. Used only by R4.

`TemuJsonLdMetadata` is module-private (not exported), so this is contained.

---

## 7. Parser change specification

### 7.1 `parseTemuProductDetail` (`product-detail.ts:46-202`)

```ts
export function parseTemuProductDetail(
  document: Document,
  url?: string,
  diagnostics?: FieldDiagnosticsCollector   // NEW, optional, trailing
): TemuScrapedProduct | null
```

Ordered edit list (all additive):

1. `const diag = diagnostics;` — every call is `diag?.…`, so the no-argument
   path executes exactly the same code as today.
2. After goodsId resolution (67) / **before** the guard (69): `diag?.setGoodsId(goodsId)`.
3. `extractTemuJsonLdMetadata(document, diag)` (57).
4. Record `url` (§4 #1) and `title` (§4 #2) at 78-87.
5. `extractTemuPricing(priceScope, ldMeta.currency ?? 'USD', diag)` (94-95);
   then reconcile `price`/`currency` (103-107) per R2/R3.
6. `extractTemuRatingAndReviews(reviewScope, diag)` (114-116); reconcile (118-119).
7. `extractTemuSalesVolume(pdpScope, diag)` (122).
8. `imageUrl`: instrument the three-tier chain at 125-135 (hero → JSON-LD → og).
9. `extractTemuCardMetadata(pdpScope, diag)` (138-139); reconcile
   `seller`/`brand`/`availability` (153-155).
10. `extractTemuPdpFeatures(document, diag)` (158); `description` chain (159-165).
11. **Only structural refactor in this plan:** hoist the inline object literal
    (167-194) into `const candidate: TemuScrapedProduct = { … }`, then:

```ts
const normalized = validateAndNormalizeTemuScrapedProduct(candidate, baseUrl, 'detail');
if (diag && normalized) applyValidationResults(diag, candidate, normalized);
return normalized;
```

    This is required to give `applyValidationResults` both sides; the returned
    value and every field are unchanged (parity test F1–F10 proves it).
12. Leave the `catch` (198-201) as-is: an aborted parse leaves whatever was
    recorded; `build()` reports the rest as `UNKNOWN`, which is exactly Req 3's
    "parser aborted → UNKNOWN".

### 7.2 `parseTemuSearchResults` (`search-results.ts:21-114`)

```ts
export function parseTemuSearchResults(
  document: Document,
  pageUrl?: string,
  cache?: TemuParseCache,
  source: TemuProductSource = 'search',
  diagnosticsByGoodsId?: Map<string, ExtractionDiagnosticsReport>   // NEW, optional
): TemuScrapedProduct[]
```

Inside the per-card `try` (46-110):

* after the cache miss and `resolveSingleGoodsCardContainer` (59):
  `const diag = diagnosticsByGoodsId ? createFieldDiagnosticsCollector(stage) : undefined;`
  where `const stage = source === 'category' ? 'category' : 'search';`
  and `diag?.setGoodsId(goodsId);`
* pass `diag` as the last argument to `findBestTemuCardImage`,
  `extractTemuCardTitle`, `extractTemuPricing`, `extractTemuSalesVolume`,
  `extractTemuRatingAndReviews`, `extractTemuCardMetadata`;
* record `url` + `currency` at 75/81 per §5;
* after `validateAndNormalizeTemuScrapedProduct` (71-101):
  `if (diag && diagnosticsByGoodsId && validated) diagnosticsByGoodsId.set(validated.goodsId, diag.build());`
  — placed inside the existing `if (validated)` block (103-107), **not** before.
* cache-hit branch (51-57) stays untouched: no collector, no report.
* the outer `catch` (108-110) stays untouched.

### 7.3 `parseTemuCategoryPage` (`category-page.ts:13-20`)

Forwarding only:

```ts
export function parseTemuCategoryPage(
  document: Document,
  pageUrl?: string,
  source: TemuProductSource = 'category',
  cache?: TemuParseCache,
  diagnosticsByGoodsId?: Map<string, ExtractionDiagnosticsReport>
): TemuScrapedProduct[] {
  return parseTemuSearchResults(document, pageUrl, cache, source, diagnosticsByGoodsId);
}
```

---

## 8. Test plan

Two new files (one per step/commit), jsdom environment (default config),
`createDoc(html) = new DOMParser().parseFromString(html, 'text/html')` — the
existing `tests/temu-scraper.test.ts` idiom.

### 8.1 `tests/temu-diagnostics-pdp.test.ts` (step 2, ~26 tests)

Shared helpers:

```ts
function parse(html: string, url = PDP_URL) {
  const collector = createFieldDiagnosticsCollector('product_detail');
  const product = parseTemuProductDetail(createDoc(html), url, collector);
  return { product, report: collector.build(), byField: fieldMap(collector) };
}
function assertParity(html: string, url = PDP_URL) { /* with vs without collector */ }
```

| # | Fixture | Assertion |
|---|---|---|
| F1 | full PDP (h1[aria-label], `#goods_price` with price + priceText + discount, rating region, saleTips, hero img, `Brand:`/`Sold by`/`Local warehouse`/`Lightning deal`/coupon/`Only 3 left`/`#1 Best Seller in …`, `li` features, JSON-LD Product+Breadcrumb, meta description + og) | all 22 `EXTRACTED`; counts `{extracted:22, missing:0, parseFailed:0, partial:0, unknown:0}`; `source`/`selector` present where expected; **parity** |
| F2 | minimal PDP (title + price only) | title/price/currency/url extracted; the rest `MISSING` with field-specific reasons; no `UNKNOWN` (everything attempted); parity |
| F3 | `[data-type="price"]` with `Request a price` | `price: PARSE_FAILED`, reason contains no page text; parity |
| F4 | DOM empty, valid JSON-LD Product with price/rating/reviewCount/image/brand/seller/availability/description | those fields `EXTRACTED source:'json-ld'`; parity |
| F5 | garbage DOM price + valid JSON-LD price | `price: PARTIAL`, `source:'json-ld'`, reason mentions the DOM candidate was rejected; `validated` not `false` for it (value survived); parity |
| F6 | `<script type="application/ld+json">{oops` + no DOM price | `price: UNKNOWN` (R4), never `MISSING`; parity |
| F7 | URL with no goodsId, no canonical, no JSON-LD Product | product `null`; `report.goodsId === null`; 22 × `UNKNOWN 'not attempted'`; `formatTemuExtractionDiagnosticsLog(report)` renders |
| F8 | `data:` hero image + valid JSON-LD image | `imageUrl: PARTIAL` + `source:'json-ld'`; parity |
| F9 | `listPrice === price` in DOM | `listPrice: PARTIAL`, `validated:false` (validator drops it); parity |
| F10 | no `li`/`tr` in scope vs only `li` shorter than 4 chars | `features: MISSING` vs `PARSE_FAILED`; parity |
| F11 | `Title` element present with empty aria-label and no text, JSON-LD `name` | `title: PARTIAL` (rescue) |
| F12 | 0-star rating (`aria-label="0 out of five stars"`) | `rating: EXTRACTED` (legitimate zero never `validated:false`) |
| F13 | JSON-LD `aggregateRating.ratingValue: "N/A"` + no DOM rating | `rating: PARSE_FAILED source:'json-ld'` |
| F14 | `isSponsored`/`isPrime` absent vs present | `MISSING 'no … marker found'` vs `EXTRACTED`, never `validated:false` on `false` (D6) |
| F15 | every fixture in F1–F14 | **parity**: `toStrictEqual(without, withDiag)` |
| F16 | F1 report formatted | prefix `[PPHunt][Temu][Diagnostics] `, one line, no fixture title/price/brand string appears (R6) |

### 8.2 `tests/temu-diagnostics-cards.test.ts` (step 3, ~16 tests)

| # | Fixture | Assertion |
|---|---|---|
| C1 | full card (`data-tooltip-title`, `[data-type=price]`, `priceText`, discount, rating, saleTips, kwcdn img, `Local warehouse`, coupon, `Ad`) | 20 × `EXTRACTED`; counts partition to 20; parity |
| C2 | link + title only | remaining 18 `MISSING` with reasons; parity |
| C3 | price node with unparseable text | `price: PARSE_FAILED`; parity |
| C4 | card parsed twice with the same `TemuParseCache` | second call adds **no** entry to `diagnosticsByGoodsId`; product objects identical; parity |
| C5 | any card | report contains **no** `description`/`features` entries; exactly the 20 card fields |
| C6 | a card node with no resolvable `goodsId` (no `-g-`/`goods_id` link, no `goodContainer-` tooltip) | skipped before parsing (`search-results.ts:49`) → **no report**, no product; a `null`-id card never reaches the collector |
| C7 | duplicate card markup twice in one grid | one report (dedupe by `seenGoodsIds`) |
| C8 | `parseTemuCategoryPage` | reports present, `stage === 'category'`; parity |
| C9 | all C1–C8 | parity arrays `toStrictEqual` |

Regression gate for both files: the existing `tests/temu-scraper.test.ts`
(9), `tests/temu-schemas.test.ts` (8), `tests/temu-isolation.test.ts` (6) and
`tests/temu-extraction-diagnostics.test.ts` (38) must stay green **without edits**.

---

## 9. Verification & non-regression protocol (per step)

```bash
npm run compile                      # tsc --noEmit
npx vitest run tests/temu-*          # focused
npm run verify                       # tsc + full vitest + wxt build + audit
npm run check:dead-exports           # scans src/lib only — engines unaffected
git diff --stat origin/main -- src/engines/amazon src/entrypoints/amazon.content.ts   # must be EMPTY
git diff --stat origin/main          # must equal §2's file list exactly
```

Additional gates:

* **Amazon diff empty** (hard constraint, Req 5).
* **No schema/model diff**: `src/engines/temu/schemas/**`, `types/**`, `db/**`.
* **No selector diff**: `scraper/selectors.ts` byte-identical.
* **No transport diff**: `entrypoints/temu.content.ts`, `background/handler.ts`,
  `schemas/messages.ts` untouched (they belong to step 4).
* Built-artifact note: unlike step 0→1, the content bundle **will** change in
  step 3 (the parsers are imported by `temu.content.ts`); record the manifest
  and background chunks as unchanged instead of the whole file set.

---

## 10. Risks and mitigations

| Risk | Why it is real | Mitigation |
|---|---|---|
| Instrumenting shared `field-parsers.ts` changes card/PDP behaviour | the same helpers serve both paths | optional trailing param + R7 (no new DOM work, no reordering) + R8 parity on every fixture + full suite |
| A caller overwrites a `PARSE_FAILED` with `EXTRACTED`, hiding a rescue | R2 depends on reading `entries()` first | one shared reconcile helper used by both parsers; F5/F11 pin it |
| `MISSING` claimed without evidence | Req 3 forbids it | R3 + R4; F6 pins malformed JSON-LD → `UNKNOWN` |
| Value leakage into logs | Req 4 forbids titles/prices/HTML | reason strings are static literals; F16/C-class tests assert fixture values never appear |
| Silent card regressions from `diagnosticsByGoodsId` | map is new state in a hot loop | only allocated when a caller passes it (`undefined` in production until step 4); cache-hit branch untouched; C4/C7 |
| `listPrice`/`imageUrl` dropped by the validator misread as extraction failures | the validator nulls values post-extraction | `applyValidationResults` turns them into `PARTIAL validated:false` (F8/F9) |
| Report for a product the background later rejects | step-4 concern, not step 2–3 | parsers only build reports; eligibility is decided in the background (D8/A3) |

Performance note: every added counter is a boolean or integer assigned inside
an existing loop; no helper gains a query. The PDP parse gains one object
literal hoist and one `entries()` iteration (≤22 entries) when a collector is
present — zero when absent.

---

## 11. Execution checklist

**Step 2 — PDP instrumentation** (one commit)

1. `field-parsers.ts`: type import + `extractTemuPricing`, `extractTemuSalesVolume`,
   `extractTemuRatingAndReviews`, `extractTemuCardMetadata` optional params (§6).
2. `product-detail.ts`: signature, goodsId, JSON-LD evidence, the 22 merge
   points, `candidate` hoist, `applyValidationResults` (§7.1).
3. `tests/temu-diagnostics-pdp.test.ts` (F1–F16).
4. Gate: §9; then `git commit -m "SAD-360 step 2: record PDP field evidence from the existing extraction paths"`.

**Step 3 — shared-helper + card instrumentation** (one commit)

5. `field-parsers.ts`: `extractTemuCardTitle`, `findBestTemuCardImage` (§6.4-6.5).
6. `search-results.ts` + `category-page.ts` (§7.2-7.3).
7. `tests/temu-diagnostics-cards.test.ts` (C1–C9).
8. Gate: §9; then `git commit -m "SAD-360 step 3: record card field evidence and forward it from the category parser"`.

Each step ends with the same report the earlier steps used: files changed,
tests executed/counts, verification output, Amazon-diff result, known
limitations, and an explicit "later steps not started" line.

---

## 12. Definition of done for steps 2 & 3

* [ ] `tsc` clean; full vitest green (baseline **89 files / 1084 tests**, plus the new files).
* [ ] `wxt build` succeeds; `check:dead-exports` passes.
* [ ] Amazon diff empty; selector/schema/model/transport diffs empty.
* [ ] Every fixture proves parity with vs without a collector (both paths).
* [ ] 22 PDP / 20 card fields each reachable with a status; no field is ever
      `MISSING` on a card when it was simply not attempted.
* [ ] `UNKNOWN` appears only for malformed-JSON-LD attribution, no-goodsId PDP,
      and aborted parses.
* [ ] No extracted value, HTML, or unsupported field appears in any report.
* [ ] Production behaviour unchanged (nothing calls the new parameters yet).

---

## 13. Explicitly out of scope (steps 4–5) — forward constraints only

Not designed here, by owner instruction. Steps 2–3 must nevertheless leave
these possible without rework:

1. `ExtractionDiagnosticsReport` already carries `goodsId | null`, `stage`, and
   `fields` — enough for the A1 null-ID path and the A2 uniqueness key
   `(sessionId, goodsId, stage)`.
2. The card out-map is keyed by `goodsId`, so step 4 can align it with the
   bounded product batch it actually sends.
3. Reports are built **after** validation, so a product rejected by the
   parse-time validator never produces one; background-rejected products are
   still filtered in step 4 (D8).
4. No message/schema/background change is made now, so an older content script
   and a newer worker remain compatible in both directions.
5. Locked for step 4 (answer recorded today): the `storage.session` seen-key
   ledger **fails open** — if the read/write fails, the line is still logged and
   the duplicate risk is accepted and documented; persistence is unaffected
   either way.

---

## 14. Decisions recorded with this plan

| # | Question | Answer |
|---|---|---|
| P1 | Plan scope | **Steps 2 & 3 only** (this document); steps 4–5 deferred |
| P2 | Ledger failure mode (step 4) | **Fail open** — log anyway, document the duplicate risk |
| P3 | Deliverable location | New file `docs/plans/SAD-360-steps-2-3-parser-instrumentation-plan.md` |
| P4 | Linear action | **Short summary comment** on SAD-360; state/assignee unchanged |

Everything else in this document is derived from the code as it exists at
`b826132` — the collector API (step 1), the Amazon SAD-359 precedent for
status/source/reason wording, the existing helper internals, and the D1–D8 /
A1–A3 locks already recorded on the issue.

---

## 15. Step 2 implementation record (2026-10-20)

Implemented and verified; one design deviation from §6.8, recorded here rather
than silently absorbed.

**Deviation — JSON-LD rejections are evidence, not writes.**
The plan had `extractTemuJsonLdMetadata(document, diagnostics?)` write
`parseFailed(...)` directly into the collector. That was wrong, and the tests
caught it: JSON-LD is read *before* the DOM helpers, so a later DOM
`missing(...)` overwrote the JSON-LD `PARSE_FAILED` by last-write-wins, and both
"rejected structured value" and "malformed structured data" misreported as
`MISSING`. Final design instead:

* `TemuJsonLdMetadata` gains `malformedJsonLd: boolean` and
  `rejections: Map<TemuDiagnosticField, string>` (field → static reason).
* `extractTemuJsonLdMetadata(document)` stays a pure reader — no collector param.
* `recordAbsence(...)` resolves the precedence at the merge point:
  DOM `PARSE_FAILED` > JSON-LD rejection (`PARSE_FAILED`, `source:'json-ld'`) >
  malformed JSON-LD (`UNKNOWN`) > helper `MISSING` > parser `MISSING`.

This is strictly better than the planned version: evidence is collected in one
place and resolved once, and precedence is testable.

**Files changed:** `src/engines/temu/scraper/field-parsers.ts` (6 helpers),
`src/engines/temu/scraper/product-detail.ts` (parser + 2 private helpers),
new `tests/temu-diagnostics-pdp.test.ts` (22 tests),
new `tests/fixtures/temu-pdp-fixtures.ts` (14 shared PDP fixtures).

**Verification:** `tsc` clean · full suite **90 files / 1106 tests** ·
`wxt build` pass · dead-export guard pass · **Amazon diff empty** · no change to
`schemas/`, `background/`, `db/`, `types/`, `ui/`, `export/`, `entrypoints/`,
`selectors.ts`, `manifest`, or lockfile.

**Before/after replay (strongest non-regression evidence):** built a detached
worktree at `b826132` (pre-step-2), replayed all 14 fixtures through its parser,
then replayed the same fixtures through the instrumented parser **with** and
**without** a collector. Both comparisons are **byte-identical JSON**
(`diff` clean, no output).

---

## 16. Step 3 implementation record (2026-10-20)

**Files changed:** `src/engines/temu/scraper/field-parsers.ts`
(`extractTemuCardTitle`, `findBestTemuCardImage`),
`src/engines/temu/scraper/search-results.ts`,
`src/engines/temu/scraper/category-page.ts` (forwarding only),
new `tests/temu-diagnostics-cards.test.ts` (12 tests),
three card fixtures added to `tests/fixtures/temu-pdp-fixtures.ts`.

**Implemented exactly as planned, with two clarifications:**

1. `extractTemuBestImageUrl` still has an unchanged signature — the card path
   records at `findBestTemuCardImage`, the PDP path at its own call site (§2).
2. Cards also get `validated` flags: the inline candidate object in
   `parseTemuSearchResults` is hoisted so `applyValidationResults` runs, matching
   the PDP. Without it, Req 2's "passed the engine's existing validation checks"
   would be answered for PDPs only.

**Behaviour gates:** a report is written only inside the existing
`if (validated)` branch, so a card rejected by the parse-time validator, a cache
hit, a duplicate card and a goodsId-less node all produce **no** report.

**Verification:** `tsc` clean · full suite **91 files / 1118 tests** ·
`wxt build` pass · dead-export guard pass · **Amazon diff empty** · same
forbidden-area checks as step 2 (all clean).

**Before/after replay:** replayed 7 card scenarios (full, minimal, unparseable
price, duplicate grid, no-goodsId, mixed grid, category delegation) through the
`b826132` worktree and through the instrumented parser **with** and **without** a
collector. All three outputs are **byte-identical JSON**.

---

## 17. Step 4 implementation record (2026-10-20)

Authorized by the owner ("keep going") after steps 2–3. Built on D1–D8, A1–A3
and the recorded fail-open policy.

**Files changed**

| File | Change |
|---|---|
| `scraper/extraction-diagnostics.ts` | formatter/summary accept a structural report type (the wire keeps `field` a plain string) |
| `schemas/messages.ts` | `TemuFieldDiagnosticSchema`, `TemuDiagnosticsReportSchema`, optional `productDiagnostics` (max 200) |
| `constants/defaults.ts` | `TEMU_DIAGNOSTICS_LEDGER_KEY` |
| `background/diagnostics-ledger.ts` | **new** — in-memory + `storage.session` seen-key ledger, fail-open, capped |
| `background/handler.ts` | eligibility-gated logging, diagnostics-only branch, ledger wiring |
| `entrypoints/temu.content.ts` | per-page reports, bounded-to-sent attachment, A1 null-ID routing, A3 later-stage sends |
| `tests/temu-diagnostics-transport.test.ts` | **new** — 14 tests |
| `ARCHITECTURE.md`, `CHANGELOG.md` | documentation |

**Two bugs the tests caught**

1. The diagnostics-only path sat *after* the session-creation block, so a
   null-ID PDP report created a session row — a direct A1 violation. The whole
   branch now runs before any session/product/count/broadcast code.
2. The wire report type (`field: string`) did not satisfy the formatter's
   literal union. The formatter now takes a structural type; existing callers
   are unaffected.

**Logging eligibility (D8/A3) is a real check, not validation success:** the
background re-reads the session's persisted goodsIds after `upsertTemuProducts`
(which can still skip products at the target cap) and logs only reports whose
`goodsId` is present. `null`-ID reports bypass the membership check and require
`pageType === 'product_detail'`.

**Verification:** `tsc` clean · full suite **92 files / 1132 tests** ·
`wxt build` pass · dead-export guard pass · **Amazon diff empty** · docs
consistency suite green.

**Known limitations (carried into the step-5 report):** console output and the
ledger write cannot be atomic, so a crash between them can lose one line; a full
browser restart clears `storage.session` and the per-session keys with it (new
sessions get fresh keys anyway); the ledger is capped at 20 000 keys (oldest
evicted first).
