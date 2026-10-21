# SAD-380 — Temu Engine `listPrice` Extraction (＋ gated `discountPrice`): Detailed Implementation Plan

> **Status: PLAN ONLY (Step 0). No source code has been changed.**
> This document is the deliverable of the planning task. Implementation must not start
> until the gates in §8 (`G0`, `G1`) are closed with evidence.
>
> Linear: <https://linear.app/sad-mod/issue/SAD-380/the-existing-temu-engine-is-not-extracting-the-listprice-field>
> Team: Sad_mod · Project: PPHunt · Label: Bug · Priority: 1 (Urgent) · State at planning: Todo
> Title: "The existing Temu Engine is not extracting the `listPrice` field correctly"
> Codebase audited: `MakeTheNewHistory/PPHunt` @ `main` `23b3182` (cloned fresh for this plan);
> re-verified at Step 0 against `fbab2bd` — the Temu price path is unchanged between the two
> (`git diff 23b3182..fbab2bd -- src/engines/temu src/entrypoints/temu.content.ts` is empty), so
> every `file:line` citation below still holds. Working branch (owner-locked): `feat/temu-engine`,
> fast-forwarded to `fbab2bd` before the Step-0 commit.

---

## 0. How this plan was produced (anti-guessing audit)

Every claim below is tagged by evidence class:

| Tag | Meaning |
|---|---|
| **(R)** | Read directly from the code, with a `file:line` reference |
| **(T)** | Measured by running the project's own toolchain on the unmodified clone |
| **(U)** | Locked by the ticket owner's answers to the clarifying questions (§1) |
| **(W)** | External web lead — a *hypothesis to verify live*, never a fact about Temu's current DOM |
| **(H)** | Hypothesis that Step 1 (live capture) must prove or kill; the plan does not assume it |

What was actually done:

| Kind | What was done | Result |
|---|---|---|
| R | Full read of the Temu price path: `scraper/selectors.ts`, `scraper/field-parsers.ts` (`extractTemuPricing`, `isTemuReferenceOrStrikePriceNode`, `validateAndNormalizeTemuScrapedProduct`), `scraper/product-detail.ts`, `scraper/search-results.ts`, `scraper/category-page.ts`, `scraper/dedup.ts`, `scraper/parse-cache.ts`, `scraper/extraction-diagnostics.ts`, `utils/price-parser.ts`, `types/*`, `schemas/*`, `constants/defaults.ts`, `db/products.ts`, `db/database.ts`, `db/settings.ts`, `ui/table/columns.tsx`, `export/types.ts`, `export/excel.ts`, `src/lib/sorting/product-sorter.ts`, `src/entrypoints/temu.content.ts`, `tests/temu-scraper.test.ts`, `tests/fixtures/temu-pdp-fixtures.ts`, `tests/temu-diagnostics-*.test.ts`, `docs/plans/SAD-360-*`, `docs/plans/SAD-369-*`, `docs/plans/SAD-378-*` | §3–§6 |
| R | Amazon engine read **only as precedent** for the list-price rule (`src/engines/amazon/scraper/field-parsers.ts`, `product-detail.ts`, `selectors.ts`) | `listPrice > price` rule, §5, §9 |
| T | `npm install`, `npx wxt prepare`, `npx tsc --noEmit` on the **unmodified** clone | `tsc` clean (exit 0) |
| T | `npx vitest run` on the 9 Temu-focused suites (`temu-scraper`, `temu-diagnostics-pdp`, `temu-diagnostics-cards`, `temu-extraction-diagnostics`, `temu-schemas`, `temu-isolation`, `temu-diagnostics-measurement`, `temu-diagnostics-transport`, `price-parser-currency`) | **9 files / 137 tests, all green** — the bug is invisible to the current fixture set (§6) |
| R | Linear issue SAD-380 fetched via the Linear connector (description, comments, relations, attachments) | Description only; **0 comments, 0 relations, 0 attachments** — no example URLs, logs or screenshots exist on the ticket |
| W | Web search for how third-party Temu scrapers name/display prices (Apify actors, scraping guides) | Leads only (§6.3): struck price is commonly named `originalPrice` / `marketPrice` / `market_price` [1][2][3][4], and at least one documents a `priceRange {min,max}` variant [5]. **None of this is evidence about the DOM this extension sees.** |

### What is explicitly NOT known today (and must not be guessed)

1. The **live** Temu DOM shape for the struck/original price in 2026-10. `selectors.ts:2` claims
   verification "against live Temu US DOM (2026-10-17)" (R), but SAD-360's own verification report
   states live verification was **never executed** and every fixture claim is "jsdom-only evidence
   modelled on the selectors in `selectors.ts`" (R: `docs/plans/SAD-360-verification-report.md`,
   Known limitation 1). The tests therefore cannot distinguish "selectors are right" from
   "fixtures were written to match the selectors".
2. Whether Temu displays a **third distinct price** that could populate a new `discountPrice`
   field (see D3/G1, §8).
3. Any concrete failing `goodsId`/URL. The first live capture is the implementer's (D5); the
   owner will then supply their own examples for final validation (U).

---

## 1. Locked decisions (owner answers, 2026-10-21)

| ID | Decision | Source |
|---|---|---|
| **D1** | Symptom: **`listPrice` is always blank/null**, even when Temu shows a struck-through original price. (Not "wrong value" — wrong-value guards are still fixed as hardening, but the root-cause hunt targets total absence.) | (U) Q1 |
| **D2** | Surfaces in scope: **both** listing cards (search + category) **and** product detail pages (PDP). | (U) Q2 |
| **D3** | Scope includes **adding a new `discountPrice` field** — *but its definition is decided after the Step-1 live capture* (D3a). No schema change before gate `G1` (§8). | (U) Q3 + Q5 |
| **D4** | `listPrice` validation rule: owner delegated ("choose the best option"). **Chosen: a candidate must be `> price` when `price` is known** (Amazon precedent, §5); if `price` is unknown the candidate may stand. Step 1 must look for a legitimate counterexample (e.g. price ranges); if one is found, this decision is revisited *before* coding, not silently coded around. | (U) Q6 + (R) |
| **D5** | Evidence order: **implementer captures live first**, then the owner provides their own examples; final acceptance includes the owner's examples (§12). | (U) Q4 |
| **D6** | Locale scope: **US + other locales** (number formats such as `29,99 €`, currency codes, localized "original price" wording are in the Step-1 matrix — not post-hoc). | (U) Q7 |
| **D7** | Non-regression is a hard constraint: Amazon engine untouched, all other Temu fields byte-stable except the intended `listPrice`/`discountPrice` changes, diagnostics parity preserved (§11). | Ticket + (U) task instructions |
| **D8** | **Non-fabrication stays absolute**: never calculate a price that is not displayed (existing rule, R: `selectors.ts` header layer 4, `field-parsers.ts:142-144`, `field-parsers.ts:480-484`). `discountPrice` must never be derived as `listPrice − price` or copied from `price`. Missing ⇒ `null`. | (R) + ticket |

**Terminology trap the plan must respect (R):** there is **no `discountPrice` field anywhere in
the codebase today** (`grep -rn discountPrice src tests` ⇒ 0 hits). Today:

* `price` = current selling / discounted price (`types/product.ts:20`), table header "Price"
  (`ui/table/columns.tsx:174-175`), but the export-column settings label for the same field is
  already **"Discounted Price"** (`constants/defaults.ts:82`), and it labels `listPrice`
  **"Listing Price"** (`constants/defaults.ts:83`) while the table header says "List Price"
  (`columns.tsx:197`) and export says "List Price" (`export/types.ts:50`).
* `discountPercentage` = displayed badge string like `"68% off"` (never calculated).

So the issue text's "discounted price (`discountPrice`)" currently collides with the *label* of
`price`. If `discountPrice` becomes a real field (D3), `G1` must also lock unambiguous
labels for all three fields everywhere (§10) — otherwise users will read two different
"discounted price" columns.

---

## 2. The ticket, restated precisely

SAD-380 requires (R, Linear description): investigate thoroughly; establish the root cause from
code + diagnostic logs before changing anything; extract `listPrice` from the appropriate source;
distinguish `listPrice` / `price` / `discountPrice`; handle layout variations, missing list
prices, and different price-display formats; never assign one price field to another; preserve
every other field's behavior; validate against actual Temu pages after implementation.

With D1–D6, the precise job is:

> On both Temu cards and PDPs, in US and non-US locales, `listPrice` currently always ends up
> `null` (D1). Find out **which stage kills it** (selector miss → parse fail → candidate rejection
> → validator drop → cache/merge/display masking; §7 decision tree), fix extraction at that
> stage with the smallest change that is robust across the captured layout variants, add a
> `discountPrice` field **only** with an evidence-locked definition (G1), and prove no other
> field changed.

**Out of scope unless Step 1 proves otherwise:** Amazon engine, Temu CAPTCHA/scroll/session
logic, export *formats* (only the new column is added), overwriting previously stored `null`s by
migration (the existing null-fill merge already heals them on re-collection, §9.6).

---

## 3. Codebase map — how `listPrice` flows today (R)

```
temu.com page
  └─ src/entrypoints/temu.content.ts                      (page-type routing; diagnostics always collected & forwarded)
       ├─ PDP:    parseTemuProductDetail  ── priceScope = #goods_price ?? #rightContent/#goodsDetail/body
       └─ Cards:  parseTemuSearchResults / parseTemuCategoryPage(delegate) ── scope = single-goods card element
                     │
                     ▼
            extractTemuPricing(container, fallbackCurrency, diag?)     ← THE only pricing extractor (2 callers)
              1. price       ← [data-type="price"]  (+ srOnly, split spans, heuristic-leaf fallback)
              2. listPrice   ← TEMU_SELECTORS.listing.listPrice candidates, first parseable ≠ price wins
              3. discountPercentage ← [data-type="discount"] / %-badge scan
                     │  parseTemuPrice() = FIRST numeric token in the text
                     ▼
            validateAndNormalizeTemuScrapedProduct()   (rounds; drops listPrice if < 0, non-finite, or == price)
                     │
                     ├─ TemuDeduplicationEngine.mergeAndFilterNew()  (null-fill only; never overwrites)
                     ├─ TemuParseCache  (card complete ⇔ title+price+imageUrl present — listPrice NOT required)
                     ▼
            background handler → upsertTemuProducts() (null-fill only) → PPHuntTemuDB (Dexie, no price indexes)
                     │
                     ├─ Temu table column "List Price" (strikethrough, data-testid=product-list-price-<goodsId>)
                     ├─ Export CSV/XLSX/clipboard "List Price" (XLSX writes it as a number)
                     └─ Sort: TEMU_SORTABLE_FIELDS includes listPrice

Side channel (SAD-360): FieldDiagnosticsCollector → TEMU_PRODUCTS_COLLECTED.productDiagnostics
  → service-worker console "[PPHunt][Temu][Diagnostics]" one JSON line/product (22 PDP / 20 card fields,
    static reasons only, NEVER values/HTML) → scripts/temu-diagnostics-measurement.mjs verifies lines vs stored rows.
```

Key structural facts (R):

* **One extractor, two callers.** `extractTemuPricing` is called only from
  `product-detail.ts:242` (PDP) and `search-results.ts:82` (cards; category delegates at
  `category-page.ts:16-29`). A fix inside it covers D2's "both surfaces" at once — and a mistake
  inside it breaks both at once.
* **Downstream already supports `listPrice` end-to-end** (types `types/product.ts:24`,
  `types/index.ts:83`; Zod `schemas/product.ts:22`, `schemas/scraped-product.ts:20`; DB null-fill
  `db/products.ts:57`; dedup `scraper/dedup.ts:74`; column `columns.tsx:196-216` + settings gate
  `columns.tsx:751`; export `export/types.ts:50,79`, `export/excel.ts:354-356`; sort
  `src/lib/sorting/product-sorter.ts:40`; diagnostics field `extraction-diagnostics.ts:12`).
  **The bug is therefore extraction-side (or display-masking), not plumbing** — Step 1 must
  confirm the stored Dexie row is `null`, not merely the column hidden (§7, branch 5).
* **`listPrice` has no structured-data fallback.** PDP JSON-LD supplies `price` (offers.price)
  but `extractTemuJsonLdMetadata` has no list-price concept and `TemuJsonLdMetadata` has no such
  field; PDP assigns `const listPrice = domPricing.listPrice` (`product-detail.ts:255`). (R; also
  recorded in the SAD-360 instrumentation plan table #4.) If DOM extraction misses, PDP `listPrice`
  is unconditionally `null`.
* **The product type contract already distinguishes the three concepts the ticket names** —
  `price` (current/discounted), `listPrice` (original/reference), `discountPercentage` (badge
  string) (`types/product.ts:20-27`). D3's `discountPrice` is a *fourth* concept whose meaning
  does not exist yet (G1).

---

## 4. Current algorithm, in detail (R)

### 4.1 Selectors (`src/engines/temu/scraper/selectors.ts`)

* Listing `listPrice` (`:39-40`):
  `'[data-type="priceText"], [aria-label*="Original price" i], [aria-label*="Regular price" i], del, s'`
* Listing `sellingPrice` (`:35-36`), `unitPrice` (`:47`), PDP `sellingPrice` (`:83-84`), PDP
  `listPrice` (`:87-88`), PDP `discountPercentage` (`:91-92`) are **defined but never referenced**
  anywhere in `src/` or `tests/` (verified by grep). In particular the PDP list-price selector —
  `'#goods_price [data-type="priceText"], …, #rightContent del, #rightContent s'` — is dead code:
  PDP extraction goes through `extractTemuPricing`, which always uses the **listing** selector.
* Header future-proofing rule (`:4-7`): **hashed CSS-module classes are banned** in this file;
  only stable `data-*` / ARIA / role / semantic-ID hooks are allowed. Any new selector from
  Step 1 must obey it.

### 4.2 `extractTemuPricing` (`field-parsers.ts:486-714`)

1. **Selling price first** (`:508-569`): iterate `[data-type="price"]` nodes, skipping any inside
   a reference/strike node (`isTemuReferenceOrStrikePriceNode`, `:464-478`). Inside a price node:
   * If a `.srOnly` text matches `(original|regular|was|list) price … <currency><number>`
     (`:519-527`), that number is assigned to `listPrice` *en passant*.
   * `price = parseTemuPrice(srOnlyText ?? aria-label ?? elementText)` (`:529-539`) — i.e. the
     same dual-price string is then parsed for the selling price, relying on
     `parseTemuPrice` returning its **first** numeric token (`utils/price-parser.ts`, unanchored
     regex).
   * Split-spans fallback joins *all* descendant span texts (`:543-568`).
2. **Heuristic leaf fallback** for `price` if still `null` (`:572-597`): requires a currency
   symbol and rejects text containing `original|regular|was|save|coupon|unit`.
3. **List price** (`:600-618`): candidates = `container.querySelectorAll(listing.listPrice)`;
   skip candidates inside `[data-type="unitPrice"]/[data-type="discount"]`; read
   `aria-label ?? elementText`; **first** candidate that parses and `!== price` wins, then
   `break`. This overwrites any srOnly-derived `listPrice` from step 1 unconditionally.
4. **Discount badge** (`:620-650`) via listing selector + short-%-span scan.
5. **Diagnostics** (`:654-711`): `listPrice` ⇒ `EXTRACTED` (always reporting selector
   `listing.listPrice`, even when the value came from srOnly); candidates seen ⇒
   `PARSE_FAILED 'list-price node present but no parseable value'`; none ⇒
   `MISSING 'no original/list price node'`. `sawListPriceNode` is set in step 3 only, and only
   *after* the unit/discount skip.

### 4.3 Scopes (R)

* **Cards**: `container` = the single-goods card element from
  `resolveSingleGoodsCardContainer` (bounded ancestor walk, `field-parsers.ts` card section).
  Candidate pollution from neighbour products is therefore unlikely by construction.
* **PDP**: `container` = `#goods_price` if present, else `#rightContent`/`#goodsDetail`/`body`
  (`product-detail.ts:237-242`). There is **no second, wider pass** if `#goods_price` yields no
  list price — the dead PDP selector `:87-88` shows a `#rightContent del/s` fallback was once
  envisaged but never wired.

### 4.4 Validator (`field-parsers.ts:1281-1287`)

`listPrice` survives iff it is a finite number `>= 0` and (`price === null` or `!== price`);
rounded to 2dp. Note the asymmetry vs §5: **`< price` is accepted**.

### 4.5 Persistence & display masking points (R)

* `TemuParseCache` completeness = `title + price + imageUrl` only (`parse-cache.ts`): a card
  parsed before its list-price node hydrates is cached as "complete" and the same element will
  not be re-parsed; within that page session the `null` is sticky for that card element.
* Dedup merge and DB upsert are **null-fill only** (`dedup.ts`, `db/products.ts:74-79`): a stored
  `null` (D1's symptom) *will* be healed by a later correct extraction; a stored *wrong*
  non-null value would never be corrected. With D1 (always null), no data migration is needed
  for the fix to take effect on re-collection.
* Table/export visibility is settings-gated (`columns.tsx:751`, `export/types.ts:134-149`):
  if the owner's stored `defaultExportColumns` lacked `listPrice`, the column/export would be
  blank **even if extraction worked**. Step 1 must rule this in/out via the stored row +
  diagnostics line before touching the extractor (§7 branch 5). Note stored settings override
  defaults (`db/settings.ts:8-20`), so defaults in code do not prove what the owner's UI shows.

---

## 5. Amazon precedent (read-only reference) (R)

The Amazon engine — which may not be modified by this ticket — treats struck list price
differently in exactly the guards Temu lacks:

* Card: candidate accepted only if `parsed.value > price`, iterating an **ordered selector
  cascade** and continuing past rejected candidates
  (`src/engines/amazon/scraper/field-parsers.ts:1025-1041`).
* PDP: buybox-scoped pass, then a *separate* struck-price fallback selector, same `> price`
  rule, with a diagnostics reason that distinguishes "rejected (unparseable or not above selling
  price)" from absent (`src/engines/amazon/scraper/product-detail.ts:1012-1041`).
* Live Amazon measurement exists (`docs/plans/sad-359-measurement-2026-10-20.json`:
  18× `listPrice EXTRACTED`, 1× MISSING) — i.e. the Amazon rule is live-validated in this repo;
  Temu has **no** equivalent live artifact (the `sad-369-live-*.json` files are Amazon/side-panel
  runs; grep finds no Temu `listPrice` entries). This plan copies the *rule* (D4), not Amazon
  selectors or code.

---

## 6. Defect catalogue — what is provable from code vs what needs live proof

### 6.1 Code-provable defects/fragilities (R) — fix candidates regardless of which one fires live

| ID | Defect | Mechanism → symptom |
|---|---|---|
| **F1** | PDP list-price scope is single-shot and the PDP selector is dead (`product-detail.ts:237-242`, `selectors.ts:87-88`, `field-parsers.ts:601`) | List node outside `#goods_price` (but inside `#rightContent`, exactly what the dead selector anticipated) ⇒ never queried ⇒ PDP `listPrice = null`. Cannot explain card failures. |
| **F2** | First-match-wins with only a `!== price` filter (`field-parsers.ts:603-618`; validator `:1285`) | First parseable candidate that is merely *different* wins and stops the search: a candidate `< price` (unit price, coupon price, variant low-end, wrong node) is stored as `listPrice`, and a later correct candidate is never examined. Wrong-value class; D4 fixes the rule. |
| **F3** | srOnly dual-price string is parsed twice with first-token semantics (`:518-535`, `price-parser.ts`) | `"current …, original …"` ordering works today *by accident of order*: `price` = first token. Original-first ordering would assign the list price to `price`. No labelled-segment parsing exists. |
| **F4** | srOnly-derived `listPrice` is silently overwritten by step 3 (`:525` then `:612`) and misreported (`:672-676` always blames `listing.listPrice`) | Two sources, no precedence rule, wrong provenance in diagnostics — root-cause analysis from logs alone can be misled. |
| **F5** | Inconsistent "reference price" vocabulary across four places: selector aria (`Original/Regular`, `selectors.ts:40`), `isTemuReferenceOrStrikePriceNode` (`original/regular/was/list`, `:468-476`), srOnly regex (same four + requires a currency symbol, `:520`), heuristic price exclusion (`original/regular/was/save/coupon/unit` — no `list`, `:585`) | A node worded e.g. "Was price…" is treated as reference for *skipping* but is not a *candidate*; localized wording (D6) matches none of them. |
| **F6** | Candidate must match `priceText` / two English aria phrases / `del` / `s` — nothing else (`selectors.ts:40`) | If live Temu renders the struck price as a styled `span/div` (CSS `line-through`, no semantic hook), or under a different `data-type`, the candidate set is empty ⇒ `MISSING` ⇒ `null` on **both** surfaces. **Consistent with D1 — but unproven (H1).** |
| **F7** | `parseTemuPrice` accepts a **bare number with no currency token** (currency group optional, `price-parser.ts`) | Any `del/s/priceText` node whose text starts with digits can become a "price". Weakens wrong-value protection; the heuristic selling-price path (`:584`) is stricter (requires a symbol) than the list-price path. |
| **F8** | Nested candidate duplication not handled (selector can match an ancestor *and* its descendant, e.g. `del > [data-type="priceText"]`; `querySelectorAll` returns both) | Ancestor text is parsed first; if it concatenates multiple numbers, first-token wins. Usually benign, but combined with `break` it can lock in the wrong token. |
| **F9** | Diagnostics cannot express *why* a candidate was rejected (`:677-687`): `== price` rejection, `< price` (currently impossible), empty text, and unparseable text all collapse to `PARSE_FAILED 'no parseable value'`; skipped unit/discount candidates are not counted at all | SAD-380's "establish the root cause using diagnostic logs" is only partially satisfiable today; §9.5 adds static reasons (still value-free, per SAD-360 rules). |
| **F10** | Card parse-cache completeness ignores `listPrice` (`parse-cache.ts`) | Early `null` for a still-hydrating card is frozen for that element/session. Possible contributor on cards; cannot affect PDP. |
| **F11** | No fallback source at all for PDP `listPrice` (no JSON-LD field, no wider-scope pass, no SSR-state read) (`product-detail.ts:250-255`) | Any single DOM miss ⇒ `null`. Whether a fallback *should* exist depends on what Step 1 finds in JSON-LD/SSR payloads (H3) — do not invent one preemptively. |
| **F12** | Wide PDP fallback scope can pollute (if `#goods_price` absent, scope = `#rightContent/body`, `:237-239`; generic `del, s` candidates) | First struck price *anywhere* in scope (promotions, recommendations) could be misassigned. Wrong-value class; any scope-widening fix for F1 must not widen into recommendation rails. |

### 6.2 Existing test coverage — why CI is green while the feature is broken (R, T)

Current passing evidence covers only the *assumed* DOM:

* Search card with srOnly `"current price is: $11.49, original price is: $32.99"` +
  sibling `[data-type="priceText"]$32.99` ⇒ `32.99` (`tests/temu-scraper.test.ts:141,177`);
  card without ⇒ `null` (`:197`).
* Structural fallback `<del>$49.00</del>` ⇒ `49` (`:242`); none ⇒ `null` (`:249`).
* PDP `#goods_price[data-type="price"]` containing srOnly dual string + `priceText $69.98`
  ⇒ `69.98` (`:312-342`).
* FULL fixtures: `priceText US$29.99` sibling in `#goods_price` / card
  (`tests/fixtures/temu-pdp-fixtures.ts:54-56,268`); minimal ⇒ diagnostics `MISSING`
  (`tests/temu-diagnostics-pdp.test.ts:164`); list price equal to the (JSON-LD) price ⇒
  validator drop ⇒ `PARTIAL validated:false` (`LIST_PRICE_EQUAL_PDP`,
  `tests/temu-diagnostics-pdp.test.ts:226-234`); validator case `['listPrice', {price:9, listPrice:9}]`
  (`tests/temu-extraction-diagnostics.test.ts:158`).

**No test exists** (R, grep-verified) for: candidate `< price`; multiple candidates where the
first is wrong/equal and a later one is correct; list node outside `#goods_price`; original-first
srOnly ordering; aria-only original price; split-span list price; `<s>`-only; unit-price/coupon
impostors; PDP wide-scope pollution; comma-decimal/currency-suffix formats; localized aria
wording; cache-frozen `null`; `priceText` node present-but-unparseable diagnostics. Step 2 (§10)
adds exactly the subset Step 1 proves real, plus the invariant cases (F2/F7) that need no live DOM to justify.

### 6.3 External leads to verify or kill in Step 1 (W — not facts)

* Third-party Temu scrapers expose the struck price as `originalPrice` ("crossed-out price")
  alongside `price`/`priceText` (selling) [1], or as `marketPrice`/`marketPriceText` [2], or
  `market_price` "original / strike-through price" read from feed/API data [3][4].
  → **H3:** captured pages may carry a machine-readable original/market price in JSON-LD or SSR
  state under a stable key. Step 1 searches captured payloads for such keys; only a *found,
  goodsId-consistent* key may be used (F11).
* One actor documents `priceRange {min, max}` "when Temu shows a price range" [5].
  → **H4:** variant PDPs may show ranges; `parseTemuPrice` would silently take the low end for
  both fields. Step 1 includes a variant/range PDP in the matrix; the plan takes **no** range
  position until seen (this is also D4's counterexample watch).
* Their field naming (`priceText` = *selling* price as displayed [1]) does **not** prove the DOM
  attribute `[data-type="priceText"]` means the same thing — but it makes one Step-1 check
  mandatory: record, per captured product, whether the live `priceText` node's value equals the
  selling price, the struck price, or neither. If it equals the selling price on live pages, F2's
  `!==` filter would reject every candidate ⇒ `null` everywhere (**H2**, fully consistent with D1+D2).

### 6.4 Hypothesis ranking for "always null, both surfaces" (H — Step 1 decides)

| Rank | Hypothesis | Predicts (diagnostics) | Killed/confirmed by |
|---|---|---|---|
| H1 | Live struck-price node matches none of `listing.listPrice` (F6 selector drift since 2026-10-17) | `MISSING 'no original/list price node'` everywhere | Selector probe on live price scopes (§8.2) |
| H2 | Live `priceText` carries the *selling* price (or list node text == selling) ⇒ all candidates rejected by `!==`, validator | `PARSE_FAILED` (candidates seen, none accepted) | Candidate text vs visible selling/struck values (§8.2) |
| H5 | Candidates exist but their text needs split-span/aria handling the list path lacks (list path has no split fallback; element text concatenation usually saves it) | `PARSE_FAILED` | Captured candidate HTML replayed in jsdom |
| H6 | Extraction works; value is masked downstream (settings column off §4.5; cache F10 on cards) | `EXTRACTED` but UI/export blank; stored row non-null | Stored-row + settings inspection (§7 branch 5) |
| — | PDP-only causes (F1/F11/F12) | — | Cannot explain D2 alone; checked in the PDP rows of the matrix anyway |

---

## 7. Root-cause decision tree (use existing diagnostics first — no new code needed to start)

Per product, read the `[PPHunt][Temu][Diagnostics]` line in the **service-worker console**
(SAD-360: R) for `field:"listPrice"`, plus the stored `PPHuntTemuDB` row:

| # | Observation | Meaning | Next probe |
|---|---|---|---|
| 1 | `MISSING 'no original/list price node'` | Candidate selector matched nothing in scope (F6/H1), or node outside scope (F1 PDP) | Selector probe (§8.2): which nodes in/near the price scope carry the visible struck value, with what attributes/computed `line-through`? |
| 2 | `PARSE_FAILED 'list-price node present but no parseable value'` | Candidates exist; every one unparseable, empty, **or equal to `price`** (F9 conflates these; H2/H5) | Record each candidate's `aria-label`/text and its visible role; replay the scope HTML through `extractTemuPricing` in a fixture |
| 3 | `PARTIAL validated:false 'parsed but failed validation'` | Extractor produced a value the validator dropped (today only `== price`/invalid; F2) | Compare visible selling vs struck values; check the equal-price path (PDP JSON-LD price merge, R `LIST_PRICE_EQUAL_PDP` pattern) |
| 4 | `EXTRACTED` but stored row `null` | Contradiction — harness `verifyField` flags exactly this (`scripts/temu-diagnostics-measurement.mjs`, R) | Investigate merge/transport before touching the extractor |
| 5 | `EXTRACTED` and stored row non-null, but UI/export blank | Presentation only: `listPrice` absent from the owner's `defaultExportColumns` (§4.5) | Settings inspection; **no extractor change** for this branch |
| 6 | No diagnostics line at all for the product | Collection/diagnostics path issue, not pricing | Use SAD-360/SAD-369 transport checks; out of SAD-380 scope unless it blocks evidence |

**Stop rule:** no extraction code is written until every captured failing product is assigned to
exactly one branch and the branch's probe data is saved (gate `G0`, §8.4).

---

## 8. Step 1 — live capture & decision gates (before any fix)

### 8.1 Build & harness (existing tooling only) (R)

```bash
npm install && npx wxt prepare && npm run build
# Existing SAD-360 harness (drives a REAL manual collection; reports challenges, never defeats them):
xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npm run measure:diagnostics:temu -- --pdps <goodsId,...>
npm run measure:diagnostics:temu -- --listing "https://www.temu.com/search_result.html?search_key=earbuds"
```

If Temu challenges the automation environment (known limitation in the SAD-360 report), fall
back to **manual capture**: load the built extension in a real browser profile, run normal
collections, copy the diagnostics lines from the service-worker console, and export the stored
rows. CAPTCHA/challenge pages are recorded as such — never bypassed (existing product rule, R:
`scraper/captcha-detector.ts`).

### 8.2 Per-product capture record (the Step-1 artifact)

For each sampled product save **one record** (JSON artifact `docs/plans/sad-380-live-<date>.json`
+ a short MD summary, following the repo's measurement-artifact precedent):

* `goodsId`, URL, surface (`search|category|product_detail`), locale/domain + display currency.
* **Visible truth**: selling price, struck/original price (or "none shown"), discount badge —
  transcribed from what a human sees (screenshot optional; numbers required).
* The full diagnostics JSON line for that `goodsId`; the stored DB row's
  `price/listPrice/discountPercentage/currency`.
* **Selector probe** evaluated inside the extractor's actual scope element (card / `#goods_price`
  / PDP fallback scope): for each of `listing.listPrice`, the dead PDP selector,
  `[data-type="price"]`, `[data-type="unitPrice"]`, `[data-type="discount"]`, `del`, `s`, plus
  "any descendant whose computed `text-decoration` includes `line-through` and whose text
  contains a currency token": matched count and, per node, tag + `data-type` + `aria-label` +
  trimmed text. (This is a *discovery* probe run in DevTools/harness, not shipped code.)
* srOnly text(s) inside the price scope, verbatim.
* JSON-LD `offers` content and **SSR/inline-script key scan**: list any keys matching
  `(?i)(market|original|list|strike|retail|was).*price|price.*(market|original|list)` with their
  values for this `goodsId` (tests H3; keys are reported, not assumed).
* Sanitized price-scope HTML snippet (price container/card pricing subtree only; strip cookies,
  tokens, unrelated page data) — this becomes the Step-2 fixture source. Full-page HTML and any
  personal/session data are never committed.

### 8.3 Capture matrix (minimum; extend if a cell contradicts another)

| Dimension | Cells |
|---|---|
| Surface (D2) | search listing, category listing, PDP |
| Locale (D6) | US/USD `temu.com`; one GBP locale; one EUR comma-decimal locale (`29,99 €`-style). Record the exact domains used; if a locale is geo-blocked in the capture environment, say so in the artifact instead of substituting silently. |
| Price presentation | (a) discounted with visible struck price + % badge; (b) discounted without % badge; (c) no discount (no struck price — the `null`-is-correct control); (d) Lightning-deal / time-limited promo; (e) coupon-bearing; (f) variant PDP (size/colour SKUs; watch for price **ranges**, H4); (g) unit-price-bearing item (per-count/per-weight, the F2/F7 impostor control); (h) sold-out / price-on-request if encountered |
| Size | ≥ 5 products per surface×locale for cell (a); ≥ 2 for each other presentation cell on US; non-US at least cells (a)+(c) per surface. Stop expanding a cell when 3 consecutive products produce identical DOM structure + identical outcome branch (§7). |

### 8.4 Gates

* **G0 — root cause established.** Every captured (a)/(b)/(d) product with a visible struck price
  is assigned to a §7 branch with saved probe data, and the chosen hypothesis (H1/H2/H5/H6/F1…)
  reproduces in jsdom by replaying the sanitized snippet through the *unmodified*
  `extractTemuPricing` (fixture-first proof). Output: Step-1 MD addendum to this plan ("§14
  record" in house style) naming the exact failure stage(s) per surface/locale.
* **G1 — `discountPrice` definition locked (D3a).** From the capture, inventory **every distinct
  price value** Temu displays per product and its DOM source. Then, with the owner:
  * If a genuinely distinct third displayed price exists → define `discountPrice` := that value:
    source selector(s), relation invariants vs `price`/`listPrice` *as observed*, `null` when
    absent, never calculated (D8), plus final UI/export labels for all three fields (resolving
    the §1 collision).
  * If only two distinct prices exist (selling + struck) → **stop**: a new numeric field could
    only duplicate `price` or be calculated, both banned by D8. Present the capture evidence to
    the owner and re-confirm: drop the field, or redefine it as one of the §1 alternatives.
    *The schema in §10 is written for the first outcome and is deleted, not bent, if the second
    occurs.*
  * G1 also re-checks D4 (`> price`) against any range/variant observations (H4).

No Step-2/3 code (other than capture tooling notes and fixtures) before G0; no schema/UI/export
code before G1.

---

## 9. Target design for the extraction fix (finalized at G0; shape locked now)

Design principles: touch the single shared helper; keep return-shape changes additive; selectors
stay hash-free (§4.1); diagnostics gain *static* reasons only (SAD-360 value-free rule);
Amazon/shared code untouched except the one additive Temu sort entry **if** G1 adds the field (§10).

### 9.1 Candidate collection replaces first-match-wins (inside `extractTemuPricing` only)

Refactor step 3 (`field-parsers.ts:600-618`) into: **collect → normalize → filter → rank →
assign**, with price fields assigned mutually exclusively from one candidate pool:

1. **Collect** from the (capture-confirmed) selector set: current `listing.listPrice` entries
   that Step 1 proves real, plus any *semantic* source G0 proves (e.g. corrected `data-type`,
   aria wording incl. localized phrases found in capture, srOnly labelled segment, or an
   H3-confirmed SSR/JSON-LD key). On PDP, finally wire a **two-scope** search: `#goods_price`
   first; only if no accepted candidate, the `#rightContent` price-adjacent region (reviving the
   intent of the dead PDP selector) — explicitly **not** whole-`body` and not recommendation
   rails (F12). Implementation preference, in order:
   * (i) pass the PDP an ordered scope list / reuse the helper per scope and merge with
     first-scope-wins-per-field — smallest change, keeps card behavior identical; **or**
   * (ii) add an optional `listPriceSelector` parameter. Choose at G0 based on captured PDP
     structure; do not build both.
2. **Normalize**: per candidate read `aria-label` and element text as today; **de-duplicate
   ancestor/descendant pairs** (F8: keep the innermost node, or the one whose parsed value is
   used — one rule, fixture-tested); parse with `parseTemuPrice`.
3. **Filter** (continue, never break, on rejection): unparseable; inside
   `unitPrice/discount` (existing) plus any impostor scope Step 1 identifies (coupon/shipping —
   only if observed); **no currency token and no srOnly/label context** (F7 — exact strictness
   set at G0 so legitimate symbol-less formats in non-US locales are not broken, D6);
   `value <= price` when `price` known (D4/F2); value equal to an already-assigned
   `discountPrice` (post-G1 mutual exclusion).
4. **Rank** deterministically, e.g. explicit semantic sources (`priceText`/aria-original/srOnly
   segment) before generic `del/s`, earlier in document order within a rank. Ranking is the only
   place "which candidate wins" is decided — no other branch may assign `listPrice`.
5. **Assign** at most one `listPrice`. The srOnly path becomes a *candidate* in the same pool
   (fixes F4): parse the srOnly text as labelled segments — original segment ⇒ list candidate;
   remainder/first unlabelled segment ⇒ selling price (fixes F3 for both orderings). Keep the
   existing regex vocabulary plus only the localized/label variants Step 1 actually captures (F5:
   unify the four vocabularies into one shared constant used by selector-building, the
   reference-node test, and the segment parser).

### 9.2 What deliberately does not change in the helper

Selling-price cascade order, split-span fallback, heuristic leaf fallback, discount-badge
extraction and their diagnostics stay as-is **except** where the srOnly segment split (F3)
changes what text is fed to the selling parse — covered by dedicated fixtures proving identical
`price` on all pre-existing fixtures. `parseTemuPrice` itself is **not** modified unless G0
proves a format it cannot parse (it is also used for JSON-LD `price` in `product-detail.ts`);
any parser change ships with `price-parser` unit tests and a fixtures-parity replay.

### 9.3 Validator (`validateAndNormalizeTemuScrapedProduct`, `field-parsers.ts:1281-1287`)

Align with D4: keep iff finite, `>= 0`, and (`price === null || listPrice > price`); post-G1 add
the symmetric `discountPrice` invariants locked at G1 (e.g. of the form
`discountPrice < price` *only if observed* — not pre-invented here). Rounding unchanged.
Consequence to state in the changelog: a hitherto-accepted `listPrice < price` (possible under
F2) becomes `null` after the fix — intended correction, guarded by tests.

### 9.4 Fallback source (only if H3 confirmed)

If Step 1 finds a stable, goodsId-consistent machine-readable original price (JSON-LD offers
extension or SSR state), add it in `product-detail.ts` exactly the way `price` falls back to
JSON-LD (`:250` pattern + `recordFallback` diagnostics), i.e. DOM first, structured fallback
second, with `TemuJsonLdMetadata` gaining an optional field and `JSON_LD_FIELDS`/absence logic
updated so malformed-JSON-LD attribution stays correct. If H3 is not confirmed, this sub-section
is dropped — no speculative SSR scraping.

### 9.5 Diagnostics (SAD-360 contract preserved)

* Report the **actual winning source** (selector or `'srOnly labelled segment'` / `'json-ld'`),
  fixing F4's provenance.
* Split today's conflated `PARSE_FAILED` (F9) into static, value-free reasons, e.g.:
  `'list-price node present but no parseable value'` (kept), `'list-price candidates rejected:
  none above selling price'`, `'list-price candidates only in excluded (unit/discount) nodes'`.
  `sawListPriceNode` must count skipped/srOnly evidence so `MISSING` stays truthful.
* Ordering/precedence vs `applyValidationResults` (`extraction-diagnostics.ts:175-198`) stays:
  validator drops still surface as `PARTIAL validated:false`.
* Hard rules unchanged: diagnostics never change extraction output (parity-tested, §11),
  never contain values/HTML/selectors-beyond-whitelist, and failures are swallowed.
* Post-G1: `discountPrice` joins `DETAIL_DIAGNOSTIC_FIELDS` (22→23) and card fields (20→21);
  the wire schema needs **no** change (`field: z.string()`,
  `schemas/messages.ts:122,147`, R) and the measurement harness's `verifyField` is already
  generic over field names (R) — only count-asserting tests and docs (§10) move.

### 9.6 Cache / dedup / DB — default: no change (change only on G0 evidence)

* Parse cache (F10): do **not** add `listPrice` to `REQUIRED_HYDRATED_FIELDS` by default —
  products legitimately lacking a list price would then never cache (re-parse cost on every
  mutation pass; the cache exists for scroll performance, R `parse-cache.ts` header). Only if
  G0 shows list nodes hydrating materially later than price/image, consider the narrower fix
  (e.g. treat "discount badge present but list price missing" as incomplete) — with a
  performance fixture. Otherwise leave it.
* Dedup/DB null-fill: unchanged. With D1, previously stored `null`s heal on re-collection; no
  migration, no overwrite of non-null values (changing that would affect every field — a
  different ticket).
* Dexie: `products` indexes are `id/goodsId/asin/sessionId/collectedAt` composites only
  (`db/database.ts:29-31`, R) ⇒ adding a non-indexed optional field needs **no** version bump.

---

## 10. Conditional `discountPrice` footprint (executes only after G1) (R)

Mirror `listPrice`'s exact footprint; every file below was verified to reference `listPrice` today:

| Layer | File(s) | Change (additive, optional — SAD-349/357 "optional, no default" precedent) |
|---|---|---|
| Types | `src/engines/temu/types/product.ts`, `src/engines/temu/types/index.ts` | `discountPrice?: number \| null` with the G1-locked doc comment |
| Zod | `src/engines/temu/schemas/product.ts`, `src/engines/temu/schemas/scraped-product.ts` | `z.number().nonnegative().nullable().optional()` — old stored rows & old content-script payloads still validate |
| Extraction | `src/engines/temu/scraper/field-parsers.ts` (`extractTemuPricing` return + validator candidate), `scraper/product-detail.ts` (candidate object), `scraper/search-results.ts` (candidate object) | New return member, defaulting `null` at both candidate sites exactly as `listPrice` is threaded today |
| Selectors | `src/engines/temu/scraper/selectors.ts` | Only the G1-confirmed semantic selector(s); hash-free |
| Diagnostics | `src/engines/temu/scraper/extraction-diagnostics.ts` (`DETAIL_DIAGNOSTIC_FIELDS`) | 22→23 PDP / 20→21 card; static reasons as in §9.5 |
| Merge | `src/engines/temu/scraper/dedup.ts`, `src/engines/temu/db/products.ts` (`nullableFields`) | Add the key to both null-fill lists |
| Settings | `src/engines/temu/schemas/settings.ts` + `src/engines/temu/constants/defaults.ts` (default columns array ×2, `TEMU_ALL_EXPORT_COLUMNS`) | Fresh installs get the toggle per G1 label decision. **Existing users keep their stored column list** (stored overrides defaults, R §4.5) ⇒ field is available-but-off until toggled — intended, no forced migration; call it out in the changelog |
| Table | `src/engines/temu/ui/table/columns.tsx` (accessor + `temuColumns` + `getTemuColumnsForSettings`) | Column next to Price/List Price, `data-testid=product-discount-price-<goodsId>`, `null` ⇒ empty cell like `listPrice` |
| Export | `src/engines/temu/export/types.ts` (`TEMU_EXPORT_COLUMNS`, `FIELD_KEY_TO_HEADER`, defaults), `src/engines/temu/export/excel.ts` (numeric-cell special case like `:354-356`) | Header from G1 labels; CSV/clipboard flow through generically; missing ⇒ blank (numeric-field convention, R SAD-348 test in `temu-isolation.test.ts`) |
| Sort | `src/lib/sorting/product-sorter.ts` (`TEMU_SORTABLE_FIELDS` only) | Additive Temu entry; **Amazon arrays in the same shared file untouched** — diff-gated (§11) |
| Docs | `ARCHITECTURE.md`, `CHANGELOG.md`, this plan's §14 record | Field counts (23/21), labels, rule change (§9.3); `tests/docs-consistency.test.ts` must stay green |
| Tests | §11 list | Counts in `temu-diagnostics-pdp/cards`, `temu-extraction-diagnostics` (22/20 assertions located at R §6.2 greps), schemas, merge, export, columns, measurement fixtures |

Explicitly **not** touched: `src/engines/amazon/**`, `src/entrypoints/amazon.content.ts`,
Temu background message *shapes* beyond the additive field (wire diag schema unchanged, §9.5),
scroll/captcha/session code, `src/lib/**` legacy Amazon path.

---

## 11. Implementation steps (house step-commit style; each step = one reviewable commit)

| Step | Content | Files (max) | Gate to proceed |
|---|---|---|---|
| **0** | This plan | `docs/plans/SAD-380-…-plan.md` | Owner approves plan |
| **1** | Live capture per §8 (harness/manual), artifact JSON+MD, branch classification, G0 jsdom replay on unmodified code; G1 definition session | `docs/plans/sad-380-live-*.json`, plan §14 addendum | **G0 + G1 signed** (§8.4) |
| **2** | Failing-first fixtures from sanitized capture snippets + invariant cases (F2/F3/F7/F8…) added to `tests/fixtures/temu-pdp-fixtures.ts` / new test file `tests/temu-listprice-sad380.test.ts`; fixtures fail on `main` for the G0 branch reasons and pass for controls | tests only | New tests red for the right reason; existing 137 Temu tests still green |
| **3** | Extraction fix: candidate pool (§9.1), srOnly segment parsing, selector/vocabulary updates **limited to G0-proven sources**, validator D4 rule (§9.3), diagnostics reasons/provenance (§9.5). Structured fallback only if H3 (§9.4) | `field-parsers.ts`, `selectors.ts`, (`product-detail.ts` if scope/fallback needs it) | Step-2 tests green; **parity replay**: all pre-existing PDP/card fixtures byte-identical except intended `listPrice` deltas, with and without a diagnostics collector (SAD-360 precedent) |
| **4** | *(G1 only)* `discountPrice` plumbing per §10 (types→schemas→extraction→merge→settings→table→export→sort→diagnostics counts→docs) | §10 table | Schema back-compat tests (old row/payload without the field), export/table tests green |
| **5** | Live validation: rebuilt extension re-run over the §8.3 matrix **and the owner's then-provided examples** (D5); harness `verifyField` must report zero mismatches; full verify; `CHANGELOG.md`/`ARCHITECTURE.md`; Linear comment with evidence; §14 implementation record | docs + artifacts | §12 acceptance all checked |

Branch: follow the repo's recent convention (short-lived step commits, cf. SAD-378 steps 0–3 on
their working branch/`main`, SAD-360 on `feat/temu-engine`); the branch name is the owner's call
at Step 1 — this plan does not presume it. **No commit in Steps 2–4 may include Amazon paths**
(§11 guard enforces it mechanically).

### Regression & non-influence guards (apply at every step ≥ 2)

```bash
npx tsc --noEmit
npx vitest run tests/temu-scraper.test.ts tests/temu-diagnostics-pdp.test.ts \
  tests/temu-diagnostics-cards.test.ts tests/temu-extraction-diagnostics.test.ts \
  tests/temu-schemas.test.ts tests/temu-isolation.test.ts \
  tests/temu-diagnostics-measurement.test.ts tests/temu-diagnostics-transport.test.ts \
  tests/price-parser-currency.test.ts tests/docs-consistency.test.ts
npm run verify            # full: tsc + all vitest + wxt build + audit (final gate, Step 5)
npm run check:dead-exports
git diff --stat <step-base> -- src/engines/amazon src/entrypoints/amazon.content.ts   # MUST be empty
git diff <step-base> -- src/lib/sorting/product-sorter.ts   # only the TEMU_* entry, and only at Step 4
```

Plus: diagnostics on/off parity (products identical with/without collector), pre-existing
fixtures byte-parity except intended deltas (Step 3), old-row/old-payload schema acceptance
(Step 4), and a scroll/collection smoke check that card throughput is unchanged (candidate
queries are bounded to the same scopes; no new whole-document scans — `scraper-performance`
suite stays green).

### Test cases to add (Step 2; each maps to a defect/branch — add only G0-proven DOM variants + invariants)

1. G0's winning live structure(s), replayed: card, PDP-in-`#goods_price`, PDP-outside-`#goods_price` (F1).
2. Multiple candidates: first `== price`, second valid ⇒ valid wins; first `< price`, second valid ⇒ valid wins; all `<= price` ⇒ `null` + the new diagnostics reason (F2/D4).
3. srOnly original-first vs current-first ordering ⇒ same `{price, listPrice}` (F3); srOnly-only source ⇒ provenance reported as srOnly (F4).
4. Nested `del > priceText` duplication ⇒ single value (F8). `<s>`-only candidate (selector already allows — lock behavior).
5. Impostors: `unitPrice` node, coupon/shipping price (only if observed), recommendation-rail `del` outside PDP price region ⇒ never assigned (F7/F12).
6. No struck price shown ⇒ `null` + `MISSING` (control; protects D8). Node present, text unparseable ⇒ `null` + `PARSE_FAILED` (old reason).
7. Formats (D6): `US$1,249.00`, `29,99 €`, `£12.99`, symbol-less only if G0 proves legitimacy; localized aria wording exactly as captured (F5).
8. `price === null`, list candidate present ⇒ `listPrice` kept, currency derived as today (regression lock on R `product-detail.ts:251-255` behavior).
9. Validator: `<`, `==`, `>`, `0`, negative, `NaN` for `listPrice` (and post-G1 the full `discountPrice` invariant set + mutual exclusion: same node never feeds two fields).
10. Diagnostics counts/reasons incl. validator-drop ⇒ `PARTIAL validated:false`; harness `verifyField` cases for any new reason/field.
11. Post-G1: schema optional-field acceptance, dedup/DB null-fill for `discountPrice`, column render + settings gate, export CSV/XLSX(numeric)/clipboard, sort field, settings defaults vs stored-columns behavior (§10).

---

## 12. Acceptance criteria (ticket bullets → verifiable checks)

- [ ] Root cause named per surface/locale from captured evidence (G0 record), not inferred from code alone.
- [ ] For every captured product with a visible struck price: stored `listPrice` equals the visible value; for every control without one: `null`. (`EXTRACTED`/`MISSING` diagnostics agree; harness zero mismatches.)
- [ ] `listPrice` is never `<= price`, never the unit/coupon/shipping/other-product price, in fixtures or live validation (D4+F2/F7/F12 tests).
- [ ] `price` and `discountPercentage` outputs are unchanged on all pre-existing fixtures (byte-parity) — no field is ever assigned to another.
- [ ] Post-G1 only: `price`, `listPrice`, `discountPrice` are pairwise-distinguished per the locked definitions, each `null` (never calculated/copied) when its display source is absent.
- [ ] Layout/format robustness: §8.3 matrix cells (a)–(h) pass on live pages in US + GBP + EUR locales (or a cell is documented as inaccessible in the capture environment with owner sign-off).
- [ ] Owner-provided examples (D5) reproduce correctly in Step 5.
- [ ] `npm run verify` green; Amazon diff empty; `check:dead-exports` green; diagnostics on/off parity green.
- [ ] Changelog/architecture updated; Linear SAD-380 updated with root cause + validation evidence.

## 13. Risks & open items

| Risk / unknown | Mitigation in this plan |
|---|---|
| Temu blocks/datacenter-challenges the capture (SAD-360 limitation) | Manual real-browser capture fallback (§8.1); challenge recorded, never bypassed; locals matrix documents inaccessible cells |
| Struck price has **no** hash-free semantic hook on live pages (F6 worst case) | Probe includes computed-`line-through` discovery within the price scope; a *scoped structural* fallback (currency-bearing struck leaf inside the price container only, `> price`, impostor-filtered) is the pre-agreed last resort — still hash-free; needs its own pollution fixtures (F12) |
| `discountPrice` has no distinct live source | G1 stop-rule (§8.4): field is dropped/redefined with the owner instead of fabricated (D8) |
| Price-range PDPs (H4) contradict D4 or single-value fields | Matrix cell (f) + G1 re-check; range policy (low-end? null?) decided from capture, not here |
| Tightening to `> price` changes existing (wrong) non-null rows' future merges | Null-fill only (§9.6): old wrong values persist until re-collected under a new session — stated in changelog; with D1 (always null) impact is nil for the reporter |
| Existing users don't see the new column (stored settings) | Documented behavior (§10); SettingsOverlay already lists all available columns for opt-in (R `TEMU_ALL_EXPORT_COLUMNS` rendering) |
| Localized aria/srOnly wording beyond captured phrases (F5/D6) | Only captured phrases are coded; unknown locales degrade to `del/s/priceText` + `MISSING` diagnostics, which future captures can extend without redesign |

**Remaining owner inputs** (do not block Step 1): branch name; the promised examples for Step 5
(D5); G1 label choices if the field proceeds.

## 14. Implementation record

*(Empty in plan-only mode. Steps 1–5 append: capture artifact links, G0 branch verdict per
surface/locale, G1 definition as locked, commit SHAs, parity/verify outputs, live-validation
table — following the SAD-360/SAD-378 record format.)*

---

### References

* Repo evidence: all `file:line` citations above are against `main` `23b3182`.
* Prior plans: `docs/plans/SAD-360-temu-diagnostics-review-and-plan.md`,
  `docs/plans/SAD-360-steps-2-3-parser-instrumentation-plan.md` (listPrice row #4),
  `docs/plans/SAD-360-verification-report.md` (live-verification limitation),
  `docs/plans/SAD-378-preview-horizontal-scroll-plan.md` (plan/record format).
* Web leads (W — hypotheses only):
  [1] <https://apify.com/selleraim.com/temu-product-scraper> (`originalPrice`, `priceText` = displayed selling price, `priceRange`)
  [2] <https://apify.com/hypebridge/temu-scraper> (`marketPrice`/`marketPriceText`)
  [3] <https://apify.com/axlymxp/temu-product-scraper> (`market_price` "Original / strike-through price")
  [4] <https://apify.com/crw/temu-products-scraper> (`market_price` "Original/crossed-out price … from the API")
  [5] [1] field reference: `priceRange {min,max}` "when Temu shows a price range"
