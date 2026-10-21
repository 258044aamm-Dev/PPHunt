# SAD-386 — Plan Only: `deal` and `discount` extraction, root cause and fix plan

> **Status: PLAN ONLY. No file under `src/` has been changed.**
> Repository: `github.com/MakeTheNewHistory/PPHunt`, cloned fresh in this sandbox at
> `a10e174` (main, SAD-379 merged). Everything below was produced *after* installing,
> building, type-checking, running the full suite, and **executing the repo's own
> parsers against probing DOM fixtures in this sandbox** — not by reading code and
> guessing what it does.
>
> Ticket (Linear SAD-386, Bug, priority 1, project PPHunt):
> *"Currently, the discount field is extracted inconsistently, while the deal field is
> never extracted. Please investigate the root cause of both issues, ensure that
> discount and deal data are extracted reliably, and verify the results across all
> supported extraction workflows and modes. Make sure the fix does not introduce
> regressions in existing functionality."*

---

## 0. Decisions taken (operator, 2026-10-21)

| # | Question | Decision | Consequence |
|---|---|---|---|
| **D1** | What does the "Deal" field mean? | **Existing `dealBadge` text *plus* a derived deal flag** — no new column | `dealBadge` keeps the printed badge text when one exists; when the page *proves a deal is running* but no badge text can be read, a canonical token is stored instead. No schema, DB, export or table change (the field is already `z.string()`) |
| **D2** | Compute `discountPercentage` when Amazon prints only a struck list price? | **No — printed-only** | A printed percentage is stored exactly as today's format (`"68% off"`); a page that prints no percentage keeps `discountPercentage` empty. §5 F1 documents what this deliberately leaves unextracted |
| **D3** | Engines in scope | **Amazon only** | Temu is untouched (`tests/temu-isolation.test.ts` must stay green). `src/lib/scraper/*` are 1–34-line re-export shims of the Amazon engine (verified: every file re-exports from `@/engines/amazon/scraper/*`), so there is exactly **one** parser to fix |
| **D4** | How to handle Amazon's real markup | **Blocking Phase 0 live capture** | No new Amazon-specific selector ships without a captured sample that contains the value. Fixes that are markup-*agnostic* (normalisation, scope loop, cache, diagnostics, derived flag) are not gated |

### 0.1 Two sub-decisions this plan needs confirmed before the matching step

| # | Question | Plan's recommendation | Why it matters |
|---|---|---|---|
| **D5** | Does a struck-through list price *alone* count as "a deal is running" (D1 wording lists "struck list price / deal label")? | **No — only deal-specific evidence: a deal label text (`Deal Price:`, `Limited time deal`, …) or a deal-specific container/attribute.** Ship it as one boolean in one function so flipping it later is a one-line change | A struck list price is how *every ordinary sale* renders. Using it would put "Deal" on most discounted rows, which is a data-quality regression, and it also contradicts **D2** (we would say "deal" while refusing to say "23% off" for the same two prices). Decide before step 2 |
| **D6** | Fix the parse-cache freeze (§5 F6) by giving cache entries a short TTL, or leave memoisation permanent? | **Amended at merge: no TTL — SAD-383's DOM-signature rule, extended to the price family** | Permanent memoisation is *measurably* why the same card yields a badge on one scroll pass and not on the next. **The original answer was a 2 s TTL. It was retracted when merging with `main`:** SAD-383 had since fixed the same class of bug in the same file with a DOM-signature rule, and the TTL was measured to fail `H-9a` (on a slow 480-card page it expires during the cold pass, so the warm pass re-parses every card). Two mechanisms for one problem were rejected in favour of one: keep SAD-383's rule, and re-read a settled card only when its text now carries a `%` or a deal label. See `SAD-386-merge-to-main-plan.md` §2 for the three measured variants |

---

## 1. Task restated, and what is explicitly out of scope

**SAD-386 (restated):** make the two price-adjacent badge fields reliable —
`discountPercentage` (the "Discount" column) and `dealBadge` (the "Deal" column) — on
**every extraction surface the extension actually uses**, without changing any other
field, any other engine, or any workflow that already works.

The surfaces ("workflows and modes") that must be covered, all read from code:

| # | Workflow / mode | Entry point | Parser reached | Touched by this plan? |
|---|---|---|---|---|
| W1 | Search-results collection | `amazon.content.ts` → `parseAmazonSearchResults` | `parseAmazonSearchCard` → `extractCardPricingAndDiscounts` | yes (cards) |
| W2 | Category / Best-Sellers / **`/deals`** collection | `parseAmazonCategoryPage` | `parseAmazonCategoryCard` → same pricing fn | yes (cards) |
| W3 | Product-page collection (collection started on a `/dp/` page) | `parseAmazonProductDetail` | detail buybox loop | yes (PDP) |
| W4 | One-click card save (card action button) | `content/save-product.ts:extractProductFromCard` (search first, category fallback) | W1/W2 parsers | yes (cards) |
| W5 | Right-click save (context menu) | `resolveSaveCandidate` → PDP parser or card parsers | W1/W2/W3 | yes |
| W6 | Background enrichment of a saved row | `background/enrich-saved-product.ts` → `fetchPdpHtml` → offscreen `parsePdpHtml` → `parseAmazonProductDetail` | W3 | yes (PDP) |
| W7 | Collection enrichment (SAD-379, off by default) | same enrichment stage, driven per collected row | W6 | yes (PDP) |
| W8 | Collection **mode** = `manual` vs `automatic` | `types/index.ts:31` | identical parser; mode only drives scroll/target | no code change, must be verified |
| W9 | Preview/table/export paths | `ui/table/columns.tsx`, `export/types.ts` | read-only consumers | no change; verified as invariants |

**Non-goals (deliberate):**

- No change to Temu (D3), to the DB schema, to message schemas, to settings shape, to
  exports, to the table, or to the diagnostics switch semantics.
- No computed discount percentage (D2), and no new product field (D1).
- No speculative selector. Every new selector is gated on Phase 0 evidence.
- No touching `rating`, `reviewCount`, `brand`, `seller`, `description`, `weight`,
  `variations`, `warrantyDescription`, `bestSellersRank` — all measured as working in
  SAD-359/SAD-370 and irrelevant to this ticket.

---

## 2. Evidence discipline

The brief says *no guessing*. Every claim below carries a tag, and the tag defines
exactly what the claim can prove:

| Tag | Source | What it proves |
|---|---|---|
| **[CODE]** | This clone, `file:line` | What the engine *can* do |
| **[PROBE]** | A throw-away vitest file executed in this sandbox against the **real** exported parsers (`extractCardPricingAndDiscounts`, `parseAmazonSearchResults`, `parseAmazonCategoryPage`, `parseAmazonProductDetail`, `AmazonParseCache`) | What the engine *actually does* for a given DOM — measured, not inferred. The probe was deleted after the run; its full source is in §13.1 so it can be re-run verbatim |
| **[BASE]** | Measured here: `npm ci` → `tsc --noEmit` → `wxt build` → `vitest run` | That this plan starts from a green tree, and what "green" means numerically |
| **[FIXTURE]** | Real markup committed in the repo (`tests/deal-page-images-sad351.test.tsx`, captured from a hydrated `amazon.com/deals` page on 2026-10-20) | What a real `/deals` card contains |
| **[HARNESS]** | `docs/plans/sad-359-measurement-2026-10-20.json` — 20 live PDPs measured by the repo's own harness | Which selectors win on live product pages |
| **[LOG]** | SAD-370's parsed console log (224 diagnostic reports, 80 enrichment outcomes) | What the engine *reported* in a real session |
| **[LIVE]** | Phase 0 capture (not yet run) | The only thing that can justify a **new Amazon-specific selector** |

---

## 3. Baseline measured in this sandbox **[BASE]**

| Check | Command | Result |
|---|---|---|
| Node | `node -v` | v20.20.2 (package asks ≥22 — warning only) |
| Install | `npm ci --no-audit --no-fund` | OK, 606 packages, `wxt prepare` clean |
| Typecheck | `npx tsc --noEmit` | **clean**, exit 0 |
| Build | `npx wxt build` | OK, `dist/chrome-mv3`, **2.00 MB** total |
| Tests (before build) | `npx vitest run` | **1216 passed / 105 of 106 files**; the only failure is `tests/manifest-permissions.test.ts` → `ENOENT dist/chrome-mv3/manifest.json` |
| Tests (after build) | `npx vitest run` on the manifest suites | **14 passed / 2 files** → full suite is green: **1216 tests, 106 files** |

**Rule for every step in §8:** `npx tsc --noEmit` clean, `npx wxt build` **then**
`npx vitest run` = **106 files / 1216 tests plus the new ones**, `npm run verify`
green before each commit. (`npm run verify` = `tsc && vitest && wxt build && audit`,
and `wxt build` runs *after* vitest there, so the manifest suite's ordering caveat is
handled by running the build first locally.)

---

## 4. Code map — the exact paths involved

### 4.1 Card surfaces (W1, W2, W4, W5)

```
parseAmazonSearchCard            scraper/search-results.ts:69
parseAmazonCategoryCard          scraper/category-page.ts:122
  └─ extractCardPricingAndDiscounts(card, pageUrl)   scraper/field-parsers.ts:857
       ├─ price       : tier1 JSON → tier2 `.a-price:not([data-a-strike])` → split parts
       │                → tier4 cardFields.sellingPrice (selectors.ts:246) → tier3 currency scan
       ├─ listPrice   : cardFields.listPrice (selectors.ts:263)
       ├─ discount    : cardFields.discount (selectors.ts:274)  → normalizeDiscountBadge  :838
       ├─ dealBadge   : cardFields.dealBadge  (selectors.ts:282) → deal lexicon gate        :1058
       │                → data-asinadattributesprops.dealString fallback                   :1078
       └─ coupon      : cardFields.coupon (selectors.ts:299)
  └─ validateAndNormalizeScrapedProduct          scraper/field-parsers.ts:1778
       copies discountPercentage / dealBadge only when truthy                       :1863-1868
  └─ recordCardDiagnostics (when the diagnostics switch is on)  scraper/card-diagnostics.ts:63
       discount :112-118      deal :120-126
  └─ AmazonParseCache.getOrParse  scraper/parse-cache.ts:15-25,43
```

### 4.2 Product-detail surface (W3, W5, W6, W7)

```
parseAmazonProductDetail         scraper/product-detail.ts:800
  ├─ buybox scope loop           :908-958   scopes = detail.buyboxScopes (selectors.ts:137, 10 entries)
  │     each scope → extractCardPricingAndDiscounts(scopeEl)
  │     ... then `if (price !== null) break;`                                    :957   ← see F4
  ├─ legacy price                :960-978
  ├─ JSON-LD price               :980-985
  ├─ listPrice fallback          :1010-1038
  ├─ discount fallback           :1043-1069  only `#corePriceDisplay…#corePrice_feature_div…#apex_desktop .savingsPercentage`
  ├─ dealBadge fallback          :1072-1094  iterates **cardFields.dealBadge** over the whole document
  ├─ coupon fallback             :1096-1119  iterates **cardFields.coupon**
  └─ candidate assembly          :1476-1488
detail selectors registry        selectors.ts:135-215  → keys: rootContainers, buyboxScopes,
    excludedSubtrees, title, brand, bsr, warrantyContainers, description, features,
    availability, delivery, seller, images      (no `discount`, no `dealBadge`)
```

### 4.3 Persistence → UI (read-only consumers; verified untouched)

```
card/PDP product → ScrapedProduct → (a) message → db.products.addProducts/products.ts:13-36 (fill-only backfill)
                                    (b) quick save → db/quick-save.ts:338,345 (+ snapshot:336-350)
                                    (c) enrichment  → background/enrich-saved-product.ts:34-70
UI: ui/table/columns.tsx:290 (Discount) / :311 (Deal) · ui/table/AmazonProductTable.tsx:172-173 (search filter)
Export: export/types.ts:62-63 (values), :129-130 (headers)
Settings toggles: schemas/settings.ts:29-30 · constants/defaults.ts:65-66 (both default **true**)
```

---

## 5. Findings — root causes, each with its evidence

### F1 — `discountPercentage` is *only ever* read from a printed percent node; nothing derives it. **[CODE] [PROBE P03]** *Confidence: certain.*

`extractCardPricingAndDiscounts` has exactly one discount source (`field-parsers.ts:1043-1056`)
and `parseAmazonProductDetail` has one fallback (`product-detail.ts:1043-1069`); a
repository-wide grep for arithmetic on `price`/`listPrice` producing a discount returns
nothing.

**Measured** on the real `/deals` card that the repo captured verbatim **[FIXTURE]**:

```
[P03] deals grid card parse
  => [{ asin: "B0FB59FN5M", price: 199.99, listPrice: 999.99,
        discount: null, deal: null, coupon: null, source: "category" }]
```

This is exactly what the operator's real session reported: on the `/deals` grid,
`listPrice` was extracted on **154/154** cards while `discountPercentage`, `dealBadge`
and `coupon` were `MISSING` on **154/154** **[LOG]**. Under **D2** this stays as is:
the row will show `No` for Discount because Amazon printed no percentage on that card.
*(If you ever want the deals grid to show a percentage, that is a one-function change —
it is recorded here so nobody later mistakes it for an oversight.)*

### F2 — The normaliser rejects formats Amazon actually prints, and accepts one it must not. **[CODE] [PROBE P01]** *Confidence: certain.*

`normalizeDiscountBadge` (`field-parsers.ts:838-849`) matches only
`/-\s*(\d{1,2})\s*%/` **ASCII hyphen** or `/\(?(\d{1,2})\s*%\s*off/i`, then rejects
`≤0`, `≥100`, and non-integers. Measured behaviour of the shipped function:

| Input | Output | Verdict |
|---|---|---|
| `-68%`, `( -68% )`, `-68 %`, `68% off`, `15% off with coupon` | `68% off` / `15% off` | works — **must not change** |
| `(−68%)`, `−13%`, `−35%` (U+2212 MINUS SIGN) | `undefined` | **bug**: the typographic minus Amazon serves on some layouts/locales |
| `(–68%)` (U+2013 EN DASH) | `undefined` | bug |
| `Save 68%` | `undefined` | bug (a real Amazon savings format) |
| `68%` (bare, in a savings node) | `undefined` | bug — a percent *inside* a proven savings node is a discount |
| `-100%` / `-0%` / `-35.5%` / `50%-off` | `undefined` | intentional range/format rules; keep, but they must be *reported* as parse-failures (F8) |
| `15% off with coupon` in a coupon span | `15% off` | **false positive** — see P02/G below |

**Measured false positive [PROBE P02 G]** — a card with no discount at all:

```
G_coupon_text_containing_percent_off => { price: 31.99, discount: "15% off" }
```

The card printed `Save 15% off with coupon`; the engine stored `15% off` as the
product's *discount*. This is a silent data-correctness bug in a field this ticket owns.

### F3 — Structural guards drop real percent/badge nodes. **[PROBE P02]** *Confidence: high (mechanism certain; live frequency = Phase 0).*

| Probe | Card shape | Result | Cause |
|---|---|---|---|
| B | percent as `[data-cy="price-recipe"] span.a-letter-space + span` containing `(−68%)` | `discount: undefined` | F2 (unicode minus) |
| C | badge in `<span data-component-type="s-status-badge-component"><span class="a-badge-text">Limited time deal</span>` | `deal: undefined` | `cardFields.dealBadge` (`selectors.ts:282`) has **no** status-badge entry, although `cardFields.statusBadge` (`:291`) uses exactly that container for "Amazon's Choice" |
| D | `<span data-a-badge-type="deal">Limited time deal</span>` (attribute on the text node itself) | `deal: undefined` | the listed selector is `[data-a-badge-type="deal"] .a-badge-text` — it needs a *descendant*; the bare attribute is not listed |
| H | percent wrapped: `<span><b>-68%</b><i></i></span>` | `discount: undefined` | `if (el.children.length > 1) continue;` (`field-parsers.ts:1048`) — a text-length guard would be correct; a child-count guard is not |
| E | module-CSS badge `div[data-deal-badge-automated="true"]` + `_c2Itd_discountText_…` | `discount: "38% off"`, `deal: "Limited time deal"` | works today — must keep working |
| A | classic `.savingsPercentage` + `[data-a-badge-type="deal"] .a-badge-text` | both | works today — must keep working |
| F | struck list price only, no percent text | `price`, `listPrice` only | F1/D2 |

### F4 — On a product page the buybox loop stops as soon as it finds a price, so later scopes are never read. **[CODE] [PROBE P07 B]** *Confidence: certain.*

`product-detail.ts:957` is `if (price !== null) break;` **inside** the loop that is
otherwise collecting `listPrice`, `discountPercentage`, `dealBadge` and `coupon` from
each scope. Whichever scope happens to contain the price decides whether the discount
is ever seen. Measured:

```
[P07] A_dealBadge_feature_div ........ price 329  discount "23% off"  deal "Limited time deal"
[P07] B_badge_in_promo_price_block ... price 329  discount null       deal null   ← percent (`(23% off)`)
[P07] C_badge_in_status_badge ........ price 329  discount "23% off"  deal null   ← badge present
[P07] D_price_recipe_badge ........... price 329  discount null       deal "Limited time deal"
[P07] E_listprice_only ............... price 329  listPrice 429       discount null
```

B is the clean reproduction: the price resolves from the first buybox scope, the loop
breaks, and the promo block that carries both the badge and the percentage is never
visited.

### F5 — The product-detail registry has no detail-scoped `dealBadge`/`discount` entries. **[CODE]**

`AMAZON_SELECTORS.detail` (`selectors.ts:135-215`) exposes 13 keys and **neither**
`dealBadge` nor `discount`; `product-detail.ts:1072` therefore iterates the *search-card*
list against a PDP document, and `:1043` hard-codes a single `.savingsPercentage`
selector. Combined with **[HARNESS]** (`dealBadge` 0/20, `coupon` 0/20) and **[LOG]**
(`dealBadge` 0/70) this is the structural reason "deal is never extracted" on product
pages, independent of which container Amazon actually uses — Phase 0 picks the
containers, this plan adds the registry keys.

### F6 — The parse cache freezes a card that was parsed *before* the badge/percent hydrated. **[CODE] [PROBE P04–P06]** *Confidence: certain.*

`AmazonParseCache.isComplete` (`parse-cache.ts:15-25`) memoises a card permanently once
`asin + title + price + imageUrl` exist. Badge and percentage hydrate later than those
four. Measured on one card, unchanged DOM:

```
[P04] first pass (before hydration)            discount null       deal null
[P05] re-parse after hydration, fresh parse    discount "68% off"  deal "Limited time deal"
[P06] re-parse after hydration, cache reused   discount null       deal null
```

This is the mechanical explanation of "**extracted inconsistently**": the same card,
same run, different answer depending on *when* in the scroll it was first parsed. It
also means a fix to the parsers alone would still be defeated during real collection.

### F7 — The deal lexicon is duplicated and has already diverged. **[CODE]**

Card gate (`field-parsers.ts:1066`): `deal|limited time|limited-time|lightning|black
friday|prime day|cyber monday|angebot|offre|oferta`.
PDP gate (`product-detail.ts:1078`): `deal|limited|lightning|prime day|black friday`
— no `cyber monday`, no locales. Two copies of a business rule that must not drift;
one constant fixes it.

### F8 — Diagnostics cannot tell "absent" from "present but unparseable" for these two fields. **[CODE]**

`price` has a dedicated honest path: `unparseablePriceTier`
(`field-parsers.ts:861`, reported at `card-diagnostics.ts:98-105`). `discountPercentage` and
`dealBadge` have none — `card-diagnostics.ts:112-126` can only say *"no discount
percentage present on the card"* even when a percent node existed and the parser refused
it. **Consequence: this ticket's own symptom is currently unmeasurable in production**,
and any "fix" would be unverifiable. Diagnostics-only change; no product is affected.

### F9 — On a deals page the card *does* print a deal label that nothing reads. **[FIXTURE] [PROBE P03]**

The captured card contains `Deal Price: $199.99`. No code path treats a deal *label* on
a card as deal evidence; `dealBadge` is badge-node-only. Under **D1** this label becomes
the derivation source for the derived flag (recommendation in D5 still open).

---

## 6. Falsified hypotheses — what this bug is *not*

Every one of these was checked because "deal never extracted" would also be explained
by a downstream drop. **None of them is the cause**, so no work is planned outside the
scraper.

| Hypothesis | Checked | Verdict |
|---|---|---|
| The message schema drops the fields | `schemas/product.ts:22-23` carries both; `schemas/scraped-product.ts` = `AmazonProductSchema.omit(id, collectedAt, sessionKey)` | **not the cause** |
| The validator drops them | `field-parsers.ts:1863-1868` copies both when truthy | **not the cause** |
| The DB backfill erases them | `db/products.ts:13-36` fills only when the stored value is `null`/`undefined` | **not the cause** |
| Dedup merge discards them | `scraper/dedup.ts:14-40` lists both as mergeable; nulls never overwrite values | **not the cause** |
| One-click save loses them | `db/quick-save.ts:338,345` writes both; `snapshotFromProduct` writes both | **not the cause** |
| Enrichment overwrites/erases them | `enrich-saved-product.ts:63-70` — `discountPercentage` is in the price family (fill-only) and `dealBadge` is detail-authoritative; nulls never erase | **not the cause** (worth knowing: a PDP percentage will *not* overwrite a card percentage — that is intentional, SAD-296) |
| The UI/export never render them | `ui/table/columns.tsx:290,311`; `export/types.ts:62-63,129-130`; both toggles default **true** (`constants/defaults.ts:65-66`) | **not the cause** |
| The search filter mis-handles them | `AmazonProductTable.tsx:172-173` reads both | **not the cause** |
| The `/deals` page isn't recognised as a category page | `page-detector.ts:29` maps `/deals` → category | **not the cause** |

---

## 7. Design principles every step must obey

1. **Additive, never reordering.** New selectors are appended *after* today's entries;
   a selector that wins today must still win tomorrow.
2. **No invented data.** A value is stored only when the page proves it; the derived
   deal token is a *statement of evidence*, not a guess, and it is labelled as derived
   in diagnostics (`FieldExtractionSource` already has `'derived'`,
   `extraction-diagnostics.ts:49-54`).
3. **Shared rules live once.** One deal lexicon constant, one normaliser, used by both
   the card and PDP paths (F7).
4. **Two lanes.** Extraction changes (product rows may change) and diagnostics changes
   (product rows must be byte-identical) never share a commit.
5. **Evidence-gated selectors.** Any new Amazon-specific selector is introduced only
   with a Phase 0 capture that contains the value (§8 Phase 0 acceptance).
6. **One step, one commit**, message `SAD-386 step N: …`, `npm run verify` green first.
7. **Every step ends with a same-fixture before/after diff** proving which other fields
   did or did not move.

---

## 8. Implementation plan

### Phase 0 — Live evidence capture (**blocking**, user-run, no source changes)

Purpose: turn F3/F5's "which container?" question into a measurement, and produce the
fixtures every selector step is tested against. Amazon answers this sandbox with
**HTTP 503** (verified: `curl https://www.amazon.com/s?k=laptop` → 503, 2,671 bytes), so
the capture must run inside a real browser profile — the same way
`scripts/sad-359-diagnostics-measurement.mjs` already drives the built extension.

**0.1 Deliverable script:** `scripts/sad-386-capture.mjs` (spike tool, not bundled, not
in CI — repo precedent: `scripts/sad-359-diagnostics-measurement.mjs`,
`scripts/temu-diagnostics-measurement.mjs`). It must:

1. Load `dist/chrome-mv3` with Playwright and open `https://www.amazon.com/` first
   (a fresh session's first `/s` request 503s), then:
   - a search URL that contains deal products (`/s?k=laptop&rh=p_n_deal_type:23566064011`
     — the deals filter fragment is documented by a third-party scraping skill and must
     be re-read from the left rail at run time, not trusted as a constant);
   - `https://www.amazon.com/deals`;
   - 5–6 `/dp/<ASIN>` pages from the search results that carry a deal badge.
2. For **10 search cards, 10 deals cards, 6 PDPs**, print one JSON line per card/page
   with the presence + `innerText` of each candidate container:

| Candidate | Why it is in the list |
|---|---|
| `[data-a-badge-type="deal"]`, `.a-badge-text`, `[data-deal-badge-automated="true"]` | current registry + F3 C/D |
| `[data-component-type="s-status-badge-component"]` | F3 C — the same slot that carries "Amazon's Choice" |
| `[id*="dealBadge" i]`, `[class*="dealBadge" i]`, `[class*="badge" i]` (first 10) | F5 |
| `#dealBadge_feature_div`, `#promoPriceBlockMessage_feature_div`, `#corePriceDisplay_desktop_feature_div`, `#corePrice_feature_div`, `#apex_desktop` | F4/F5 PDP scopes |
| every element whose `innerText` matches the deal lexicon and is ≤ 60 chars | the markup-agnostic fallback (§Phase 2) |
| `.savingsPercentage`, `[class*="saving" i]`, `[class*="discount" i]`, `[data-cy="price-recipe"] span` | F2/F3 discount candidates |

3. Write the raw `outerHTML` of each captured card/page section to
   `docs/plans/sad-386-evidence/*.html`, trimmed of telemetry attributes, exactly like
   SAD-351 did, and print a summary table.

**Accept:** for search cards and PDPs, the run records **at least 3 examples** where a
deal badge is visibly rendered on screen, and names the container Amazon used for it;
and at least 3 discount renderings including their exact characters (ASCII hyphen vs
U+2212 vs "Save NN%"). **If a value never appears in the capture, no selector for it is
added** — the corresponding step degrades to the markup-agnostic fallback plus an honest
diagnostic reason.

### Phase 1 — One discount normaliser (markup-agnostic; **no Phase 0 gate**)

| Item | Detail |
|---|---|
| **Why** | F2: Unicode minus, `Save NN%`, bare `NN%`, and the coupon false positive |
| **Files** | `scraper/field-parsers.ts` (`normalizeDiscountBadge` :838 + the discount block :1043-1056), new tests `tests/sad-386-discount-normalizer.test.ts` |
| **Change** | Accept `[-−–—]` (U+002D/U+2212/U+2013/U+2014) as a minus; accept optional wrapping parens/brackets; accept `Save\s*NN%`; accept bare `NN%` **only** via a new `{ allowBare: true }` flag that the callers set when the node is a proven savings node (`.savingsPercentage`, class/id/aria-label matching `/saving|discount/i`); reject any candidate whose source text matches `/coupon|voucher|save\s*[$€£₹]|with coupon/i`; keep the `0 < n < 100` integer rule |
| **Snippet** | see §13.2 — the function is ~25 lines and stays a pure function |
| **Must not move** | existing outputs for `-68%`, `( -68% )`, `-68 %`, `68% off`, `19% off`, `15% off with coupon` (the last one only when it is a *discount* node, see next row) |
| **Data consequence (intentional)** | the coupon false positive disappears: a card whose only percent is inside `Save 15% off with coupon` stores nothing. One fixture in the suite encodes the old behaviour and must be updated with a comment — the audit list is §9.2 |
| **Tests** | the 22-row table from [P01] pinned verbatim; plus `-100%`/`-0%`/`-35.5%` still rejected; plus the coupon guard; plus the four unicode variants |
| **Accept** | P01 table shows the 5 fixed rows and the 2 still-rejected-by-rule rows; no other exported behaviour changes |
| **Rollback** | single function |

### Phase 2 — Card-level discount and deal discovery

| Item | Detail |
|---|---|
| **Why** | F3 (child-count guard, status-badge slot, bare deal attribute) and F9 (a printed deal label is deal evidence) |
| **Files** | `scraper/field-parsers.ts` (discount block :1043, deal block :1058), `scraper/selectors.ts` (`cardFields.discount`, `cardFields.dealBadge` — **append only**), new `scraper/deal-evidence.ts` (one lexicon + one detector), `tests/sad-386-card-badges.test.ts` |
| **Change A — discount node discovery** | replace `if (el.children.length > 1) continue;` with a text guard (`text.length <= 32`, reject strings containing a currency token) and scan, in order: (1) today's `cardFields.discount` list, unchanged and first; (2) any leaf/short node inside the card's price area whose `class`/`id`/`aria-label` matches `/saving|discount/i`; (3) the sibling-of-`.a-letter-space` pattern already listed. Nothing new is *ordered ahead* of today's winners |
| **Change B — deal evidence detector** | new `detectDealEvidence(card): { text?: string; container?: string }`: (i) appended selectors — `[data-a-badge-type="deal"]` (bare), `[data-component-type="s-status-badge-component"] .a-badge-text`, `[id*="dealBadge" i]`, `[class*="dealBadge" i]`; (ii) a fallback scan for short nodes (≤ 60 chars) matching the shared lexicon `DEAL_LABEL_PATTERN`; (iii) a printed `Deal Price:`-style label inside the card's price block. All three feed the **same** gate, so no new selector can manufacture a false positive |
| **Change C — derived flag (D1)** | if a *label or container* is proven but no badge text is readable → `dealBadge = DERIVED_DEAL_LABEL` (`'Deal'`), recorded in diagnostics with `source: 'derived'`. See D5: a struck price alone does **not** count unless you flip one boolean |
| **Change D — lexicon** | `DEAL_LABEL_PATTERN` shared by card + PDP (fixes F7), containing today's card alternations ∪ today's PDP alternations ∪ `cyber monday`, `deal of the day`, `best deal`, `deal price`, `angebot`, `offre`, `oferta` |
| **Must not move** | price/listPrice/currency/coupon extraction; `badge` ("Amazon's Choice"/"Best Seller") — it must not steal a deal badge or vice versa (assert in tests both directions); every A/E-shape fixture from P02 keeps its exact current output |
| **Tests** | the 8 P02 shapes pinned as a table: A/E unchanged, B/H now extracted, C/D now extracted, F unchanged, G no longer invents a discount; plus "title containing the word *deal* is not a badge" and "delivery text containing *deal* is not a badge" |
| **Accept** | all 8 shapes behave as the table says; `tests/baseline-snapshot.test.ts` and `tests/amazon-search-widgets.test.ts` unchanged |
| **Rollback** | revert the two appended selector arrays + the detector module |

### Phase 3 — Product-page pricing/deal scope fixes

| Item | Detail |
|---|---|
| **Why** | F4 (premature `break`), F5 (no detail-scoped registry keys), P07 B/C |
| **Files** | `scraper/product-detail.ts` (:908-958 loop, :1043 discount, :1072 deal), `scraper/selectors.ts` (**new** `detail.discount` and `detail.dealBadge`), `tests/sad-386-pdp-badges.test.ts` |
| **Change A — loop** | remove `if (price !== null) break;` and break only when `price !== null && listPrice !== undefined && discountPercentage !== undefined && dealBadge !== undefined && coupon !== undefined`, or when the 10 scopes are exhausted. Cost: at most 10 scope scans, each already O(small) — assert the PDP parse budget in the test |
| **Change B — registry** | add `detail.discount` / `detail.dealBadge` (append-only, contents from Phase 0) and read them **before** falling back to `cardFields`, exactly as the file already does for the coupon/badge fallbacks |
| **Change C — buybox leaf scan** | inside each buybox scope, if no discount node matched, scan short leaf nodes for a percent whose text passes `normalizeDiscountBadge(..., { allowBare: true })` — this is what makes P07 B work without knowing Amazon's class names |
| **Must not move** | price tier/provenance (`priceScopeSelector`, `priceTier`, `unparseablePriceTier`), legacy/JSON-LD fallbacks, `isInsideExcludedDetailSubtree` exclusions, `complete ⇔ title && price` in `enrich-saved-product.ts:449` |
| **Tests** | the 5 P07 shapes: A unchanged, B discount **and** deal, C deal, D unchanged, E unchanged (D2); plus "a *similar-items* carousel badge is still ignored" (excluded-subtree test); plus "a PDP whose first scope has price and a later scope has the percent now yields both" |
| **Accept** | P07 table flips only where this plan says; `tests/pricing-deals-bsr.test.tsx` (the real-PDP fixture) unchanged |
| **Rollback** | one `break` condition + two optional registry keys |

### Phase 4 — Cache freshness (D6)

| Item | Detail |
|---|---|
| **Why** | F6 — a fix to the parsers is defeated while the cache freezes pre-hydration parses; this is the measured mechanism behind "inconsistent" |
| **Files** | `scraper/parse-cache.ts` (`isComplete` untouched; entries gain `{ at: number }`), `tests/scraper-performance.test.ts` (unchanged, must stay green), new `tests/sad-386-cache-freshness.test.ts` |
| **Change** | `AmazonParseCache` gains `ttlMs` (default `2000`) and an injectable clock. `getOrParse` returns a cached product only when `now - at <= ttlMs`; otherwise it re-parses and refreshes the entry. `clear()` unchanged, `get`/`set` unchanged |
| **Must not move** | the three existing performance invariants: *immediate* second pass = 0 extractions, incomplete cards keep re-parsing, 480-card budget `warm < cold/4` (all measured with an immediate second pass, so a 2 s TTL preserves them) |
| **Tests** | with a fake clock: pass 1 → 0 badge; hydrate DOM; pass at `t+100ms` → still cached (0 extractions); pass at `t+2500ms` → re-parsed, badge now present; and a 480-card pass at `t+2500ms` still inside a stated budget |
| **Accept** | P04-P06 reproduction now yields `{discount:"68% off", deal:"Limited time deal"}` on the third pass; performance suite green |
| **Rollback** | one default constant |

### Phase 5 — Diagnostics honesty (**diagnostics lane: product rows byte-identical**)

| Item | Detail |
|---|---|
| **Why** | F8 — without this the ticket's own symptom cannot be measured in the next session |
| **Files** | `scraper/field-parsers.ts` (add `unparseableDiscountNode` / `dealEvidenceOnly` to `CardPricingAndDiscounts`), `scraper/card-diagnostics.ts` (:112-126 → `parseFailed` when a node existed but was refused; `source: 'derived'` for the derived token), `scraper/product-detail.ts` (same two outcomes), `tests/card-diagnostics.test.ts`, `tests/extraction-diagnostics.test.ts` |
| **Must not move** | **24 fields per card report**, every field accounted for, `CARD_INAPPLICABLE_FIELDS` unchanged, the diagnostics switch still gating everything, Temu report shape untouched |
| **Proven as diagnostics-only** | a before/after test that deep-equals the returned product *with and without* a sink |
| **Tests** | report has 24 fields; a discount node the normaliser refuses reports `PARSE_FAILED` with a reason, not `MISSING`; a derived deal reports `EXTRACTED` with `source: 'derived'`; `--flag off` prints nothing |
| **Accept** | one re-run of the SAD-359 harness now separates "Amazon printed nothing" from "we could not read what it printed" for both fields |
| **Rollback** | revert the two reporters |

### Phase 6 — Verification across every workflow, and documentation

1. **Parity matrix run** (the ticket's "all supported extraction workflows and modes"):
   for each of W1–W8, one test asserts the same card/page fixture yields the same
   `discountPercentage`/`dealBadge` through **every** entry point that can reach it —
   collection parser, save parser, enrichment parser — plus `manual` and `automatic`
   modes. Pattern: `tests/collection-save-parity.test.ts` (SAD-379) already does exactly
   this for the field set; extend it rather than invent a new harness.
2. **Before/after measurement** with the repo harness:
   `npm run build` → `npm run measure:diagnostics -- --flag on --asins <the Phase 0 set>`
   → commit `docs/plans/SAD-386-measurement-<date>.md` with the per-field diff.
   **Expected, honest outcome:** `discountPercentage` rises only where Amazon *prints*
   a percentage (D2); `dealBadge` rises on pages where a badge or deal label exists.
   Predictions are stated before the run so a surprise is visible.
3. **CHANGELOG.md** — one `## [Unreleased] — Deal and discount extraction (SAD-386)`
   section with **Fixed / Changed / Unchanged** (Unchanged: Temu, DB schema, exports,
   settings, the 24-field report, all other fields).
4. **ARCHITECTURE.md** — one paragraph: the single lexicon constant, the TTL cache
   contract, and the `derived` provenance rule.
5. **`docs/plans/SAD-386-verification-report.md`** mirroring `SAD-360-verification-report.md`.
6. `npm run verify` green.

---

## 9. Regression protection — how "must not influence other features" is enforced

### 9.1 Invariants and their proofs

| Invariant | How it is proven |
|---|---|
| Every other field is byte-identical | each step runs the same fixture set before/after and deep-equals the product objects minus the two fields owned by this ticket |
| `badge` ≠ `dealBadge` | tests both directions: "Limited time deal" never becomes `badge`; "Amazon's Choice" never becomes `dealBadge` |
| Report still partitions 24 fields | `fields.length === 24`, counts sum to 24, on a search card, a deals card and a PDP |
| Temu untouched | `tests/temu-isolation.test.ts`, `temu-schemas`, `temu-scraper`, `temu-extraction-diagnostics` all green; no Temu file opened |
| Storage/DB/export/UI unchanged | no file under `db/`, `export/`, `ui/`, `schemas/` is edited by this ticket — asserted by the commit plan (§11) |
| Message schemas unchanged | `tests/message-schema-conformance.test.ts`, `tests/message-registry-sync.test.ts` |
| Cache performance contract | `tests/scraper-performance.test.ts` unchanged and green (0 re-parses on an immediate second pass; `warm < cold/4`) |
| Diagnostics switch still gates everything | `tests/diagnostics-setting.test.ts` + a `--flag off` harness run that prints nothing |
| No new permission / WAR entry | `tests/manifest-permissions.test.ts`, `tests/manifest-war.test.ts` (note: run `wxt build` **before** vitest) |
| Docs stay consistent | `tests/docs-consistency.test.ts` after the CHANGELOG/ARCHITECTURE edits |
| Collection cap unchanged | `tests/collection-diagnostics.test.ts` |

### 9.2 Tests that pin current values and must be **audited** (not assumed)

| Test | What it pins | Expected verdict |
|---|---|---|
| `tests/baseline-snapshot.test.ts` | full product JSON incl. `"discountPercentage": "68% off"`, `"dealBadge": "Limited-time deal"` | unchanged |
| `tests/pricing-deals-bsr.test.tsx` | PDP + search fixtures, CSV/Excel rows (`68% off`, `Limited-time deal`) | unchanged |
| `tests/amazon-search-widgets.test.ts` | 5 real-shaped widget cards incl. module-CSS badge and `-38%` | unchanged |
| `tests/error-diagnosis.test.tsx`, `tests/scroll-settings-wiring.test.ts` | `-40%` + `Limited-time deal` cards | unchanged |
| `tests/scraper-accuracy.test.tsx`, `tests/collection-save-parity.test.ts` | pricing parity tables | unchanged unless a fixture's only percent sits inside coupon text (Phase 1 consequence) |
| `tests/card-diagnostics.test.ts`, `tests/extraction-diagnostics.test.ts` | field sets, reasons | reasons extended in Phase 5; statuses on existing fixtures unchanged |
| `tests/table-v9-contract.test.tsx`, `tests/export-*` | columns/headers/values | unchanged |

**Rule:** any test that must change gets a one-line comment naming the ticket and the
reason. A silent expectation edit is treated as a regression.

---

## 10. Risk register

| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| Tuning the normaliser makes it accept a non-discount percentage (a rating, a coupon) | Medium | the coupon/currency guards, `allowBare` only inside proven savings nodes, and a 22-row table test | revert one function |
| The derived `'Deal'` token pollutes rows (D5 open) | Medium | default evidence = label/container only; struck price excluded unless you flip one boolean; a test asserts an ordinary sale with a strike price is **not** labelled a deal | flip the boolean / revert |
| Removing the buybox `break` slows PDP parsing | Low | bounded to 10 scopes; an existing budget test on PDP parsing pins the time | restore the `break` |
| TTL cache re-opens a performance regression on long collections | Low-Medium | TTL default 2 s, measured on the 480-card fixture at both cold and post-TTL passes | TTL → `Infinity` (today's behaviour) |
| A new selector steals a badge from a recommendation carousel | Medium | append-only ordering, the lexicon gate, and `isInsideExcludedDetailSubtree` | remove the appended entry |
| Phase 0 cannot reproduce a deal badge (Amazon A/B, region, or a logged-out page) | Medium | the run also captures the `/deals?deals-widget` grid and the operator's own session; if nothing renders, the ticket still ships Phases 1/3/4/5 and documents the unverified part | n/a |
| The operator's real session is non-US (23 marketplaces supported) | Medium | capture at least one non-US page; lexicon already carries `angebot/offre/oferta` | extend the lexicon only with captured labels |

---

## 11. Commit plan

| # | Message | Files | Gate |
|---|---|---|---|
| 0 | `docs(sad-386): investigation, root-cause evidence and fix plan` | this document | plan reviewed, **D5/D6 answered** |
| 1 | `SAD-386 step 0: capture live search/deals/PDP badge markup` | `scripts/sad-386-capture.mjs`, `docs/plans/sad-386-evidence/*.html`, `docs/plans/SAD-386-evidence-<date>.md`, `tests/fixtures/sad-386/*` | §8 Phase 0 acceptance table met |
| 2 | `SAD-386 step 1: normalise every discount form Amazon prints (and stop reading coupons as discounts)` | `field-parsers.ts`, `tests/sad-386-discount-normalizer.test.ts`, CHANGELOG | P01 table + coupon guard |
| 3 | `SAD-386 step 2: find the discount and deal badges the card actually renders` | `field-parsers.ts`, `selectors.ts`, new `deal-evidence.ts`, tests, CHANGELOG | P02 8-shape table; A/E unchanged |
| 4 | `SAD-386 step 3: read the product page's whole price area, not just the price` | `product-detail.ts`, `selectors.ts`, tests, CHANGELOG | P07 table; budget test |
| 5 | `SAD-386 step 4: let a hydrated badge reach the parser` | `parse-cache.ts`, tests, CHANGELOG | performance suite green |
| 6 | `SAD-386 step 5: say why a discount/deal was not extracted` (diagnostics lane) | `field-parsers.ts`, `card-diagnostics.ts`, `product-detail.ts`, tests, CHANGELOG | 24 fields; rows byte-identical |
| 7 | `SAD-386 step 6: verification across every workflow, measurement and docs` | `docs/plans/SAD-386-*.md`, `ARCHITECTURE.md`, CHANGELOG | `npm run verify` green |

Steps 2–5 touch product data; step 6 must be provable as diagnostics-only. No step
touches Temu, `db/`, `export/`, `ui/`, `schemas/`, settings, or the manifest.

---

## 12. What is still open

1. **D5** — does a struck-through list price alone mark a row as a deal? Plan recommendation: **no** (label/container evidence only). Answer before step 3.
2. ~~**D6** — 2 s cache TTL acceptable…?~~ **Resolved at merge:** the TTL was replaced by an extension of SAD-383's signature rule (see the D6 row above).
3. **Derived token wording** — `'Deal'` (recommended, neutral) vs `'Deal (derived)'` vs `'Limited time deal'`. Whatever is chosen becomes the only text the Deal column shows when no badge text exists.
4. **Phase 0 execution** — do you run `scripts/sad-386-capture.mjs` yourself (needs your browser profile), or should the plan commit the script and treat the capture as a separate operator task before step 3?

---

## 13. Appendix

### 13.1 The probe used for every [PROBE] claim (run, then deleted)

```ts
// tests/_probe-sad386.test.ts — executed with: npx vitest run tests/_probe-sad386.test.ts
import { describe, it } from 'vitest';
import { extractCardPricingAndDiscounts, normalizeDiscountBadge }
  from '@/engines/amazon/scraper/field-parsers';
import { AmazonParseCache, parseAmazonCategoryPage, parseAmazonSearchResults,
         parseAmazonProductDetail } from '@/engines/amazon/scraper';

const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const SEARCH_URL = 'https://www.amazon.com/s?k=laptop';
const DEALS_URL  = 'https://www.amazon.com/deals';
const PDP_URL    = 'https://www.amazon.com/dp/B0TEST0001';

// P01 — normaliser table (22 inputs)
normalizeDiscountBadge('-68%');            // "68% off"
normalizeDiscountBadge('(−68%)');          // undefined   ← U+2212
normalizeDiscountBadge('Save 68%');        // undefined
normalizeDiscountBadge('68%');             // undefined
normalizeDiscountBadge('15% off with coupon'); // "15% off"  ← false positive

// P02 — 8 card shapes (A classic, B unicode-minus sibling, C status-badge slot,
//       D bare [data-a-badge-type], E module CSS, F list price only,
//       G coupon text, H child-wrapped percent) → extractCardPricingAndDiscounts(card, SEARCH_URL)

// P03 — the real SAD-351 /deals card → parseAmazonCategoryPage(doc, DEALS_URL)
//       → { price 199.99, listPrice 999.99, discount null, deal null }

// P04–P06 — cache freshness: parse → append badge+percent to the same Element →
//           parseAmazonSearchResults(cache) vs parseAmazonSearchResults() (no cache)

// P07 — 5 PDP shapes (dealBadge_feature_div / promo block / status-badge /
//       price-recipe badge / list price only) → parseAmazonProductDetail(doc, PDP_URL)
```

### 13.2 The two snippets that carry most of the fix (shape, not final code)

```ts
// Phase 1 — one normaliser, shared. Pure function, no DOM.
const MINUS = '[-\\u2212\\u2013\\u2014]';               // ASCII, U+2212, U+2013, U+2014
const DISCOUNT_RE = new RegExp(
  `(?:${MINUS}\\s*(\\d{1,2})\\s*%)` +                    // -68%  −68%  (−68%)
  `|(?:(\\d{1,2})\\s*%\\s*off)` +                        // 68% off
  `|(?:save\\s*(\\d{1,2})\\s*%)` +                       // Save 68%
  `|(?:^\\s*\\(?\\s*(\\d{1,2})\\s*%\\s*\\)?\\s*$)`,      // bare 68% — only with allowBare
  'i',
);
const COUPON_TEXT = /coupon|voucher|rabatt|remise|save\s*[$€£₹]/i;

export function normalizeDiscountBadge(
  raw: string | null | undefined,
  options: { allowBare?: boolean } = {},
): string | undefined {
  const text = normalizeWhitespace(raw);
  if (!text || COUPON_TEXT.test(text)) return undefined;      // Phase 1: kill P02/G
  const m = DISCOUNT_RE.exec(text);
  const pct = m?.[1] ?? m?.[2] ?? m?.[3] ?? (options.allowBare ? m?.[4] : undefined);
  if (!pct) return undefined;
  const num = Number.parseInt(pct, 10);
  if (!Number.isFinite(num) || num <= 0 || num >= 100) return undefined;
  return `${num}% off`;
}
```

```ts
// Phase 2/3 — one deal-evidence detector, shared by cards and PDPs.
export const DEAL_LABEL_PATTERN =
  /limited[- ]time deal|lightning deal|deal of the day|best deal|prime big deal|deal price|black friday|cyber monday|prime day|angebot|offre|oferta|deal/i;

export const DERIVED_DEAL_LABEL = 'Deal';

/** Returns the printed badge text, or `DERIVED_DEAL_LABEL` when the page proves a
 *  deal is running without a readable badge. Returns undefined when nothing proves it. */
export function detectDealEvidence(root: Element): { value: string; derived: boolean } | undefined {
  for (const el of safeQuerySelectorAll(root, DEAL_CONTAINER_SELECTORS)) {   // appended registry
    const text = normalizeWhitespace(el.textContent);
    if (text && DEAL_LABEL_PATTERN.test(text) && text.length <= 60) return { value: text, derived: false };
    if (text && text.length <= 60) return { value: DERIVED_DEAL_LABEL, derived: true }; // container, no label
  }
  for (const el of safeQuerySelectorAll(root, 'span, div, p')) {              // markup-agnostic
    const text = normalizeWhitespace(el.textContent);
    if (!text || text.length > 60 || el.children.length > 2) continue;
    if (/\$|€|£|₹|\d+%/.test(text)) continue;                                 // prices are not badges
    if (DEAL_LABEL_PATTERN.test(text)) return { value: text, derived: false };
  }
  return undefined;   // D5: a struck list price alone deliberately does not qualify
}
```

### 13.3 File:line index used throughout this plan

`scraper/field-parsers.ts`: 838 `normalizeDiscountBadge` · 857 `extractCardPricingAndDiscounts` ·
1043 discount block · 1058 deal block · 1078 ad-props fallback · 1084 coupon block ·
1451 `extractCardBadge` · 1778 `validateAndNormalizeScrapedProduct` · 1863-1868 field copy.
`scraper/selectors.ts`: 246 sellingPrice · 263 listPrice · 274 discount · 282 dealBadge ·
291 statusBadge · 135-215 `detail` registry.
`scraper/product-detail.ts`: 908-958 buybox loop · 957 early break · 1043-1069 discount ·
1072-1094 dealBadge · 1476-1488 assembly.
`scraper/parse-cache.ts`: 15-25 `isComplete` · 43 `getOrParse`.
`scraper/card-diagnostics.ts`: 28 inapplicable fields · 98-105 price honesty · 112-126 discount/deal.
`scraper/extraction-diagnostics.ts`: 49-54 sources · 92-117 detail field list.
`background/enrich-saved-product.ts`: 34-54 `DETAIL_FIELDS` · 63-70 `FILL_ONLY_FIELDS` · 449 completeness.
`db/products.ts`: 13-36 fill-only backfill. `db/quick-save.ts`: 336-350 snapshot · 338,345 fields.
`export/types.ts`: 62-63, 129-130. `ui/table/columns.tsx`: 290, 311.
`constants/defaults.ts`: 65-66. `schemas/product.ts`: 22-23. `schemas/settings.ts`: 29-30.
`ui/table/AmazonProductTable.tsx`: 172-173. `scraper/page-detector.ts`: 29 (`/deals` → category).
`types/index.ts`: 31 `CollectionMode`.

### 13.4 One-paragraph summary

Both symptoms have concrete, reproducible causes and neither is a mystery. **Discount
is "inconsistent" for three reasons measured here:** its normaliser refuses the
typographic minus and the `Save NN%` forms Amazon prints (P01), it silently reads a
coupon as a discount (P02/G), and — decisively — the card cache freezes a card the
moment price and image exist, so a percentage that hydrates a moment later is never seen
(P04-P06); on product pages a second mechanism compounds it, because the buybox loop
stops scanning scopes as soon as it finds a price (P07/B). **Deal is "never extracted"**
because the card path only looks for a badge in containers the page does not use (P02/C,
D), the product page has no detail-scoped deal selectors at all (F5, with 0/20 and 0/70
independent measurements behind it), the deals grid prints a deal *label* that no code
reads (P03, matching the 154/154 log), and the cache can hide a badge that does exist.
The plan fixes the two lanes separately — product-affecting changes (normaliser, deal
evidence, PDP scope, cache freshness) and diagnostics-only changes (honest
`PARSE_FAILED`/`derived` provenance) — with every new Amazon selector gated behind a
live capture, and every other field, engine, export and workflow pinned by an existing
or new test.
