# SAD-370 — Plan Only: closing the extraction gaps the console log documents

> **Status: PLAN ONLY — nothing in `src/` has been changed.**
> Repository state analysed: `5e24561` (main, SAD-369 merged) — cloned fresh and
> built in this sandbox before a single line of this plan was written.
> Ticket text: **derived from the attached console log**
> (`last-console-1792515244323.log`, 402 lines) per the operator's instruction of
> 2026-10-21, because no ticket body was supplied. §1 restates the derived task —
> if it is not the task you meant, everything downstream changes, so read §1 first.

---

## 0. Decisions taken (operator, 2026-10-21)

| Question | Decision | Effect on this plan |
|---|---|---|
| **Q1** — the 42 buy-box-less PDPs | **Accept + report honestly.** No recovery attempt in this ticket; the row keeps the listing price the user saw. | Phase 6a ships; **6b (retry / live-tab recovery) is dropped** and becomes a follow-up ticket if you ever want it. |
| **Q2** — how Phase 0 captures the fetched PDP HTML | **CDP interception of the service-worker request.** No debug hook, no production code. | §7 Phase 0.2 method (a) is now the method; (b) is removed as an option. |
| **Q3** — scope | **Both lanes:** extraction fixes *and* diagnostics honesty. | Phases 1-6 all in scope, in the order given (diagnostics-only phases carry the strictest proof burden). |
| **Q4** — card report field count | **Keep all 24 fields**, with layout-specific reasons (recommended; no answer given). | Phase 2 changes *reasons*, never the field set. If you want fields dropped instead, say so before Phase 2 — it invalidates the "every field is accounted for" contract and several existing tests. |

---

## 0.1 How this plan was produced (evidence discipline)

The brief said *"no guessing"*. So every claim below is tied to one of four
sources, and the source is named next to the claim:

| Tag | Source | What it can prove |
|---|---|---|
| **[LOG]** | The attached console log, parsed programmatically (224 diagnostic reports, 80 enrichment outcomes, 8 drift lines) | What the engine *reported* on the operator's session |
| **[CODE]** | The repository at `5e24561`, with `file:line` | What the engine *can* do, and why it produced that report |
| **[BASE]** | Measured in this sandbox today (`npm ci` → `tsc --noEmit` → `wxt build` → `vitest run`) | That the numbers in this plan start from a green tree |
| **[HARNESS]** | `docs/plans/sad-359-measurement-2026-10-20.json` — 20 real PDPs measured on 2026-10-20 by the repo's own harness | Which selectors actually win on live Amazon pages |
| **[FIXTURE]** | Markup captured verbatim from a hydrated `amazon.com/deals` page and committed in SAD-351 (`tests/deal-page-images-sad351.test.tsx:30-70`) | What a real deals card contains |

Anything that could only be settled by looking at **the raw HTML Amazon returned
during the operator's session** is *not* asserted here. It is listed as a
hypothesis (§5) with a named falsification experiment, and the fix it implies is
**gated** on that experiment (§7, Phase 0).

---

## 1. The task, restated

**SAD-370 (derived):** *Close the extraction gaps the console log documents, on
the two surfaces it covers — listing cards (the `/deals` grid) and fetched
product pages — without changing behaviour on the page types that already work.*

Concretely, the log shows three different kinds of defect, and the plan treats
them differently on purpose:

| # | What the log shows | Kind of defect | In scope? |
|---|---|---|---|
| A | 17 of 24 fields `MISSING` on **every** card report | Mostly **not a bug** — a `/deals` card does not carry those fields. The *report* is unreadable, not the parser | **Yes — diagnostics honesty** |
| B | 9 of 80 enrichments failed with *"The product page is too large to enrich from"* | Real defect — a size ceiling set below the live distribution | **Yes — extraction/enrichment** |
| C | `description` missing on 53/70 PDPs; `coupon` and `dealBadge` on **70/70**; `price`+`seller` `PARSE_FAILED` on 42/70 | Real defects **or** honest reports of pages that lack the data — must be separated by evidence before any selector is touched | **Yes — evidence-gated** |

### 1.1 Non-goals (explicitly out of scope)

- No change to the Temu engine, the UI, exports, DB schema, settings, or messaging
  semantics.
- No change to fields that work on the pages measured by **[HARNESS]**
  (`title`, `brand`, `rating`, `reviewCount`, `availability`, `features`,
  `imageUrl`, `bestSellersRank`, `variations`, `weight`, `warrantyDescription`).
- No speculative selectors: **not one** new selector ships without a captured
  sample of real markup that contains the value (§7 Phase 0).
- No change to what is **stored**. Diagnostics and reasons may become more
  precise; the product rows must stay byte-identical for every existing path.

---

## 2. Baseline — measured in this sandbox, not assumed **[BASE]**

| Check | Command | Result |
|---|---|---|
| Install | `npm ci --no-audit --no-fund` | OK, 606 packages, `wxt prepare` clean |
| Typecheck | `npx tsc --noEmit` | **clean** (exit 0) |
| Build | `npx wxt build` | OK, **1.99 MB**, `dist/chrome-mv3` |
| Tests | `npx vitest run` (after the build, so the gated manifest suites run) | **1193 passed / 101 files** |
| Node in sandbox | `node -v` | v20.20.2 (`package.json` asks for ≥22 — warn only, no failures) |

**Every step in §7 must end at 101 files / 1193 tests plus the new ones.** The
manifest suites (`tests/manifest-permissions.test.ts`,
`tests/manifest-war.test.ts`) read `dist/chrome-mv3/manifest.json`, so `wxt build`
must run **before** `vitest run` or that file reports a spurious suite failure —
that is exactly what happened on the first pass here (1182/100 before the build,
1193/101 after).

---

## 3. What the log actually says — measured, not eyeballed **[LOG]**

The log was parsed rather than read: 402 lines → **224 diagnostic reports**
(80 `card`, 74 `collection-card`, 70 `enrichment-parse`), **8 drift lines** and
**80 enrichment outcomes**.

### 3.1 Shape of the session

| Fact | Value | How it was established |
|---|---|---|
| Listing surface | **category page**, not search | all 8 drift lines carry `"stage":"category-page"` |
| Cards discovered | 100 → 112 → 124 → 136 → 160 across the scroll | `cardsInspected` in the drift lines |
| Collection runs | **2** (`150955176_1792515183643` = 50 lines, `…193353` = 24 lines) | grouped `collection-card` jobIds — and the 50/24 split **confirms** `COLLECTION_DIAGNOSTICS_LIMIT = 50` is enforced (`constants/defaults.ts:27`) |
| Distinct products | 56 unique ASINs across 74 collection reports | ASIN set |
| Card saves | 80 reports, 80 distinct jobIds | `card` stage |
| Enrichment | 80 outcomes: **28 complete / 42 partial / 10 failed** | `[PPHunt] enrichment outcome` lines |

### 3.2 The card report — identical on 154/154 cards

| Field | Status on every card | Tier recorded |
|---|---|---|
| `asin` | EXTRACTED | `tier2_semantic` (100%) |
| `url` | EXTRACTED | source `url` |
| `title` | EXTRACTED | `tier2_semantic` 151, `tier3_structural` 3 |
| `price` | EXTRACTED | `tier2_semantic` (100%) |
| `listPrice` | EXTRACTED | — |
| `currency` | EXTRACTED | — |
| `imageUrl` | EXTRACTED | `tier3_structural` 151, `tier1_json` 3 |
| `brand`, `discountPercentage`, `dealBadge`, `coupon`, `pastMonthSales`, `rating`, `reviewCount`, `availability`, `delivery`, `seller`, `bestSellersRank`, `variations`, `isPrime` | **MISSING (154/154 each)** | — |
| `description`, `features`, `weight`, `warrantyDescription` | MISSING (declared card-inapplicable) | — |

### 3.3 The drift line — the smoking gun

All 8 lines are the same shape (cumulative as the scroller loads cards):

```json
{"stage":"category-page","cardsInspected":160,"cardsExtracted":160,
 "fieldCoverage":{"asin":1,"title":1,"price":1,"rating":0,"reviewCount":0,"imageUrl":1},
 "tierBreakdown":{"tier1_json":3,"tier2_semantic":477,"tier3_structural":160,"tier4_selector":0,"missing":320},
 "isDriftDetected":false,"driftReasons":[]}
```

Two things follow arithmetically:

1. `tier2_semantic = 3N`, `tier3_structural = N`, `missing = 2N` for N cards —
   i.e. **per card: 3 × tier 2 (asin, title, price), 1 × tier 3 (image), 2 × missing
   (rating, reviewCount)**. There is no third pattern hiding in the aggregate.
2. **`isDriftDetected:false` while two tracked fields sit at 0%.** `getReport()`
   only threshold-checks `price` (<0.2) and `imageUrl` (<0.5)
   (`scraper/drift-telemetry.ts:137-160`); `rating` and `reviewCount` are
   tracked, printed, and then **ignored by the detector**. This is a provable
   diagnostics defect, independent of any DOM question.

### 3.4 The enrichment side — two disjoint clusters

Splitting the 70 parsed PDPs by `price` status produces two clean populations
with almost no overlap:

| Field (EXTRACTED) | price OK (n=28) | price `PARSE_FAILED` (n=42) |
|---|---|---|
| `price` | 28 | 0 |
| `listPrice` | 26 | **0** |
| `discountPercentage` | 27 | **0** |
| `seller` | 25 (+3 MISSING) | **0 — all 42 `PARSE_FAILED`** |
| `delivery` | 28 | **0** |
| `pastMonthSales` | 26 | 2 |
| `availability` | 28 | 42 |
| `rating` / `reviewCount` | 28 | 42 |
| `bestSellersRank` | 28 | 39 |
| `variations` | 28 | 38 |
| `description` | **2** | **15** |
| `coupon` | **0** | **0** |
| `dealBadge` | **0** | **0** |
| median `htmlBytes` | 2,662,366 | 2,538,944 |

The 42 are not a random sample of "hard pages": **the entire buy-box family
(price, list price, savings %, seller, delivery promise, "bought in past month")
is absent together**, while availability, rating, reviews, features, BSR,
variations and the hero image are all present. That is the signature of a PDP
served **without a populated featured offer**, not of a broken selector.

### 3.5 The 10 enrichment failures

| Reason | Count | ASINs |
|---|---|---|
| `parse-failed` / *"The product page is too large to enrich from"* | **9** | B0BRBDC16F, B0CYZD34VF, B0HHF8ZN6M, B0C1YZJJ5L, B0CYSR5JCG, B06XS1P6NG, B0BZSCS613, B0FG2B3VBT, B0F6LM8VH3 |
| `captcha` | 1 | B0CBTZSS9F |

Meanwhile pages of **2,996,709 bytes succeeded** — 3.3 kB below the cap. The cap
is `MAX_PDP_HTML_BYTES = 3_000_000` (`background/enrichment-fetch.ts:27`), so the
threshold is *inside* the live distribution of the operator's own traffic.

### 3.6 The same gaps, on a different day, in the repo's own measurements **[HARNESS]**

20 live PDPs, 2026-10-20, all `gate: ok`:

| Field | Extracted | Winning selector |
|---|---|---|
| `price`, `discountPercentage`, `listPrice` | 19/19 | `#corePriceDisplay_desktop_feature_div` |
| `seller` | 16/20 | `#sellerProfileTriggerId` (14), `#merchant-info a` (2) |
| `delivery` | 19/19 | `#mir-layout-DELIVERY_BLOCK-… span[data-csa-c-delivery-price]` |
| `description` | **5/20** | `#productDescription p` (4), `#productDescription span` (1) |
| `coupon` | **0/20** | — (never extracted) |
| `dealBadge` | **0/20** | — (never extracted) |
| `availability`, `rating`, `reviewCount`, `title`, `imageUrl` | 19-20/20 | `#availability span`, `#acrPopover`, `#acrCustomerReviewText`, `#productTitle`, `#landingImage` |

So `coupon = 0`, `dealBadge = 0` and `description ≈ 25%` are **not**
log-specific: they reproduce across 90 independent product pages measured on two
different days. That is the definition of a gap worth fixing.

---

## 4. Code map — the exact paths that produced these numbers **[CODE]**

### 4.1 Listing cards

```
amazon.content.ts:  extractCurrentPageProducts()  ─┬─ search  → parseAmazonSearchResults (search-results.ts:280)
                                                   └─ category → parseAmazonCategoryPage (category-page.ts:262)
                                                        └─ parseAmazonCategoryCard (category-page.ts:124)
                                                             ├─ extractCardAsinWithTier            field-parsers.ts:1121
                                                             ├─ extractCardTitleAndBrandWithTier   field-parsers.ts:1203
                                                             ├─ extractCardPricingAndDiscounts     field-parsers.ts:857
                                                             ├─ extractCardRatingAndReviewsWithTier field-parsers.ts:1338
                                                             ├─ extractCardImageWithTier            field-parsers.ts:1404
                                                             ├─ extractCardPastMonthSales           field-parsers.ts:1438
                                                             ├─ extractCardDeliveryAndAvailability field-parsers.ts:1467
                                                             ├─ extractCardSeller                  field-parsers.ts:1518
                                                             ├─ extractCardIsPrime                 field-parsers.ts:1543
                                                             └─ recordCardDiagnostics              card-diagnostics.ts:61
```

Saves reach the same parsers through
`save-product.ts:extractProductFromCard()` (search parser first, category parser
as fallback), from `amazon.content.ts` (card-icon) and the worker
(`background/save-job.ts:258` labels the line `card` vs `detail-page`).

### 4.2 Product pages

```
enrichment-fetch.ts:fetchPdp()          ── size cap :27, captcha probe :145, retries :214
  → background/offscreen.ts (client)    ── MAX_OFFSCREEN_HTML_LENGTH = 5_000_000  (offscreen/protocol.ts:21)
    → offscreen/parse.ts:parsePdpHtml() :52
      → scraper/product-detail.ts:parseAmazonProductDetail() :800
          price    :918-1010   (buyboxScopes loop → extractCardPricingAndDiscounts on the scope)
          dealBadge:1074       (reuses AMAZON_SELECTORS.cardFields.dealBadge)
          coupon   :1098       (reuses AMAZON_SELECTORS.cardFields.coupon)
          seller   :1285-1308
          description :1336-1380
          isPrime  :1432
  → enrich-saved-product.ts:mergeDetailFields()  :449  (complete ⇔ title && price != null)
```

### 4.3 Selector registry — what the PDP path can and cannot see

`AMAZON_SELECTORS.detail` (`selectors.ts:135-215`) ships lists for
`title, brand, bsr, warrantyContainers, twister, description, features,
availability, delivery, seller, images` — **and no `coupon` and no `dealBadge`
entry at all**. Both fields are served on the PDP path from the *card* registry
(`selectors.ts:220-340`), whose coupon list is `['.s-coupon-unclipped',
'[data-component-type="s-coupon-component"] …', '#couponBadgeRegularVpc',
'#vpcButton', 'span[class*="coupon" i]']` — i.e. **search-result markup**.

Likewise `AMAZON_SELECTORS.cardFields` has **no `seller` and no `availability`
list**: those two card fields are recovered only by bespoke leaf-node scans
(`field-parsers.ts:1467` and `:1518`).

---

## 5. Findings and hypotheses — with the test that can kill each one

### F1 — The log's listing was a `/deals` grid, and a `/deals` card carries ~6 fields. *Confidence: high.*
**[FIXTURE]** A real hydrated `product-card` (SAD-351, captured 2026-10-20) contains:
`data-asin`, an `<img class="a-amazon-image">` inside `<picture>`, a price block
(`Deal Price: $199.99` + struck `List: $999.99`) and a title `<p id="title-ASIN">`.
It contains **no** rating, review count, brand, seller, delivery, availability,
discount %, badge or variation control.
**[LOG]** matches this exactly: `imageUrl` was `tier3_structural` on 151/154
(what a `<picture>`/plain `<img>` yields — `field-parsers.ts:1404-1430`), `price`
was `tier2_semantic` on 154/154 (`Deal Price: $19.99` parses at
`field-parsers.ts:1055`), `listPrice` on 154/154 (the struck `List:` span).
→ **The 13 "missing" card fields are mostly the layout, not a defect.** Do **not**
add speculative rating/seller selectors to cards. *(Falsified if a captured
deals card in Phase 0 contains any of those nodes — then that one field becomes an
extraction ticket.)*

### F2 — The card report cannot say *which card* it describes. *Confidence: high (by inspection).*
`CardDiagnosticsInput` (`card-diagnostics.ts:43-60`) carries 15 extraction results
and no page type, no card kind, no layout. Two structurally different cards —
a search `s-search-result` and a deals `product-card` — produce byte-identical
reason strings ("no rating node found on the card"). The four
`CARD_INAPPLICABLE_FIELDS` (`card-diagnostics.ts:30`) are the *only* layout
knowledge in the report, and they encode the search-card layout.
→ A 17/24 MISSING report reads like 17 regressions. This is what made the log look
alarming, and it is the defect worth fixing first (diagnostics-only, §7 Phase 2).

### F3 — Drift detection ignores `rating`/`reviewCount`. *Confidence: certain.*
`drift-telemetry.ts:137-160` threshold-checks only `price` and `imageUrl`.
**[LOG]** proves the consequence: `rating:0, reviewCount:0, isDriftDetected:false`.
→ Fix is 3 lines + tests. Must not change search-page behaviour (rating 0.96 there).

### F4 — The 3 MB PDP cap rejects real pages. *Confidence: certain (the log contains the boundary on both sides).*
`enrichment-fetch.ts:27` vs the offscreen parser's own 5 MB limit
(`offscreen/protocol.ts:21`). 9/80 products (11%) lost **all** enrichment to a
limit no other layer needs. Failure is also mislabelled: `parse-failed` /
`ENRICH_FETCH_FAILED` for a *size* decision (`enrichment-fetch.ts:352-378`).
→ Small, mechanical, high-value.

### F5 — `coupon` and `dealBadge` are never extracted on a product page. *Confidence: high.*
**[HARNESS]** 0/20 and 0/20; **[LOG]** 0/70 and 0/70. **[CODE]** the PDP path has no
detail-scoped coupon/badge selectors (§4.3); it reuses search-card selectors, and
research on Amazon PDP markup puts the coupon badge under
`#couponBadgeAsinDetailPageCoupon`, `.couponBadge`, `#promoPriceBlockMessage_feature_div`
and `[data-feature-name="couponBadge"]` — none of which the card list contains.
Caveat to settle in Phase 0: coupon badges are frequently **injected client-side**
after load, so a background `fetch` may legitimately never see them. The fix must
therefore be *additive selectors + an honest reason* ("coupon badge is
client-rendered / not in fetched HTML"), not a promise that the number becomes 100%.

### F6 — `description` is a real, layout-dependent gap. *Confidence: medium-high.*
`AMAZON_SELECTORS.detail.description` = `#productDescription p`,
`#productDescription span`, `#productDescription`, `#bookDescription_feature_div`
(`selectors.ts:190-195`); JSON-LD is the only fallback. Missing on 53/70 **[LOG]**
and 14/20 **[HARNESS]**. Likely causes, to be separated by Phase 0:
(a) the text lives in `#productDescription_feature_div` / A+ modules with no
`#productDescription` node; (b) the text is genuinely absent; (c) it is present but
inside an excluded subtree (`product-detail.ts:40`).

### F7 — The 42 "`PARSE_FAILED`" PDPs are buy-box-less pages, not parse bugs. *Confidence: medium-high (needs the HTML to close).*
Signature in §3.4: whole buy-box family absent together, everything else present.
`buyboxScopeSeen` becomes `true` merely because `#apex_desktop` /
`#corePriceDisplay_desktop_feature_div` **exist** (`product-detail.ts:918-935`),
so an empty buy-box is filed as `PARSE_FAILED` ("node present but no parseable
price") and `seller` as "seller node present but rejected by the field parser"
(`product-detail.ts:1303`) when in fact the node is present and **empty**.
Phase 0 decides between:
- **H7a** the raw HTML has no featured offer (page genuinely offerless / hydrated later) → extract nothing; report `MISSING` with an offer-state reason;
- **H7b** the raw HTML *does* contain a price under another id → selector gap, one additive fix.
**[LOG] corroboration for H7a:** all 42 keep `availability` and `rating` and lose
`delivery` too; delivery/past-month/savings/seller all come from the same
buy-box module that is missing.

### F8 — Nothing in the log requires a change to card extraction. *Confidence: high.*
Every card field that the **[FIXTURE]** proves the layout carries
(`asin, title, price, listPrice, imageUrl, url, currency`) was extracted on
154/154 cards. There is no card-level extraction bug in this log.

### F9 — `isPrime` is a derived signal with a weak source on PDPs. *Confidence: medium.*
`product-detail.ts:1432-1444` derives it from a Prime icon or a `FREE delivery`
string; it is MISSING on 56/70 **[LOG]** and its low hit rate is expected on
buy-box-less pages. Recorded here so it is **not** mistaken for a regression;
out of scope unless Phase 0 shows a Prime marker in the captured HTML.

---

## 6. Design principles for every step

1. **Additive only.** New selectors are appended, never reordered ahead of a
   selector that wins today; new report keys are optional.
2. **Report what was observed.** `PARSE_FAILED` means "a node existed and the
   parser refused it". If a node exists but is *empty because the page has no
   offer*, the honest status is `MISSING` + a reason that names the page state.
3. **Two-lane changes.** Diagnostics-only steps (P2, P3, P6b) must be provable as
   diagnostics-only: same stored rows, with/without the change.
4. **One step, one commit**, message `SAD-370: … (step N)`, `npm run verify`
   green before each commit — the repo convention (`wxt build` first, then
   `vitest`).
5. **No step ships without its falsification experiment** (§7 Phase 0) recorded in
   `docs/plans/SAD-370-evidence-<date>.md`.

---

## 7. Implementation plan

### Phase 0 — Evidence capture (blocking; no source changes)

Purpose: convert H5/H6/H7 from hypotheses into measurements, and produce the
fixtures every later step is tested against.

**0.1 Capture `/deals` cards** (settles F1, F2)
- New spike tool `scripts/sad-370-evidence-capture.mjs` (not bundled, not in CI —
  same convention as `scripts/sad-359-diagnostics-measurement.mjs`).
- Launch Chromium with `dist/chrome-mv3`, open `https://www.amazon.com/deals`,
  scroll 8×, then for 10 cards write `outerHTML` to
  `docs/plans/sad-370-evidence/deals-card-<asin>.html` and print, per card,
  which of the 20 card fields a raw `querySelectorAll` can see.
- **Accept**: either the card contains the 13 "missing" nodes (→ F1 partially
  falsified, open extraction tickets) or it does not (→ F1 confirmed, Phase 2 only).

**0.2 Capture the fetched PDP HTML** (settles F5/F6/F7) — **method decided: CDP, no production code**
- Attach a CDP session to the extension's **service worker** target, enable `Network`,
  and save the response body of each PDP request while the harness drives a real
  save (the same `pphunt:command` path `scripts/sad-359-diagnostics-measurement.mjs`
  already uses at `:336-370`). The body is byte-for-byte what
  `parseAmazonProductDetail` receives, so a selector conclusion drawn from it is a
  conclusion about the production input.
- Implementation sketch (inside the Phase 0 spike script only):
  `browser.contexts()[0].serviceWorkers()[0]` → `newCDPSession(worker)` →
  `Network.enable` → collect `Network.responseReceived` for
  `resourceType === 'document'` + `Network.getResponseBody`. Fall back to
  `Fetch.enable` + `Fetch.getResponseBody` if the SW target exposes no
  `Network` domain when attached.
- **Accept**: the captured body's `length` matches the `htmlBytes` the extension
  logs for the same ASIN (`enrichment outcome`), which proves the capture is the
  real input and not a re-fetch.

Sample: **6 ASINs from cluster B** and **6 from cluster A** (§13), plus 2 of the 9
"too large" ASINs.
- **Accept**: for each ASIN, a recorded table of presence/absence for
  `#corePriceDisplay_desktop_feature_div`, `#apex_desktop`, `.a-price .a-offscreen`,
  `#tabular-buybox`, `#merchant-info` (and whether its text is empty),
  `#sellerProfileTriggerId`, `#promoPriceBlockMessage_feature_div`,
  `#couponBadgeAsinDetailPageCoupon`, `.couponBadge`, `#dealBadge_feature_div`,
  `#productDescription`, `#productDescription_feature_div`, `#aplus`, and whether
  any string matching `/coupon/i` or `/limited time deal/i` exists anywhere in the
  document. **This table is the gate for Phases 4-6.**

**0.3 Re-measure the live baseline with diagnostics on** (`npm run build`, then
`npm run measure:diagnostics -- --flag on --asins <the 12 sample ASINs>`), so the
"before" numbers come from the harness and not from a single session log.

**Deliverable:** `docs/plans/SAD-370-evidence-2026-10-2x.md` with the tables above
+ the captured fixtures committed under `tests/fixtures/sad-370/`. **No source
change may be planned on top of a hypothesis that Phase 0 did not confirm.**

---

### Phase 1 — Size cap and failure taxonomy (F4) — *no Phase 0 dependency*

| Item | Detail |
|---|---|
| **Why** | 9/80 enrichments (11%) were lost to a 3 MB ceiling while 2.99 MB pages passed; the parser below it accepts 5 MB |
| **Files** | `background/enrichment-fetch.ts` (`MAX_PDP_HTML_BYTES` → align with `offscreen/protocol.ts`'s 5 MB, imported rather than duplicated so the two can never drift), `EnrichmentFailureStatus` gains `'too-large'`, the two rejection sites (`:352`, `:371`) return it, `background/enrich-saved-product.ts` maps it to the outcome reason, `tests/enrichment-fetch.test.ts` |
| **Must not move** | 2,999,999-byte and 5,000,000-byte boundaries per test; captcha/403/429 handling; retry policy; the `status: 'failed'` surface in the UI |
| **Tests** | `size cap accepts a 4 MB body`, `size cap rejects 5 MB + 1`, `too-large is not reported as parse-failed`, and a replay test that the 6 captured "too large" pages now yield a parsed product |
| **Accept** | the 9 ASINs from §3.5 enrich; no existing `enrichment-fetch` test changes |
| **Rollback** | one constant + one enum member |

### Phase 2 — Card report gains layout context (F1, F2) — *diagnostics only*

| Item | Detail |
|---|---|
| **Why** | 154 identical 7/24 reports look like 17 regressions because the report does not say which card layout it came from |
| **Files** | `scraper/card-diagnostics.ts` (add `cardKind: 'search-card' \| 'deals-card' \| 'bestseller-card' \| 'browse-card' \| 'unknown'` to the report and a layout-aware applicability table replacing the hard-coded 4-field list), `scraper/search-results.ts` + `scraper/category-page.ts` (pass the kind they know), `scraper/extraction-diagnostics.ts` (optional `cardKind` on the report + one clause in the formatter), `background/handler.ts:476-497` and `background/save-job.ts:250` (pass-through), `schemas/messages.ts` (optional field, additive) |
| **Problem to solve** | the report must still carry **exactly 24 fields**, and every field must still be accounted for. Only the *reason* changes for fields the layout cannot carry, e.g. `"not carried by a deals grid card (verified: no rating node in any of 10 captured cards)"` |
| **Must not move** | stored products, the 50-line collection cap, the diagnostics switch, the Temu report shape |
| **Tests** | `tests/card-diagnostics.test.ts` + a new `tests/sad-370-card-layout.test.ts` replaying one captured deals card and one search card: 24 fields each, same statuses as today for the search card, new reasons for the deals card, `cardKind` present |
| **Accept** | a deals card report is readable without the log; no status flips on any existing fixture |

### Phase 3 — Drift detector learns the two silent fields (F3) — *diagnostics only*

| Item | Detail |
|---|---|
| **Files** | `scraper/drift-telemetry.ts` (`getReport()`: add `rating < 0.2` and `reviewCount < 0.2` reasons **only when the layout is expected to carry them**, or unconditionally but with a layout-aware message), `tests/drift-report-routing.test.ts` |
| **Risk** | firing on `/deals` where 0% is correct → so Phase 3 depends on Phase 2's `cardKind`: flag `rating:0` only for kinds that carry ratings, and otherwise emit an informational reason |
| **Tests** | `/deals` sweep → `isDriftDetected:false` (or a layout reason, per decision); synthetic search sweep with ratings stripped → `isDriftDetected:true` |
| **Accept** | the 8 log lines would now carry a truthful verdict |

### Phase 4 — PDP description (F6) — *gated on Phase 0.2*

| Item | Detail |
|---|---|
| **Precondition** | Phase 0.2 shows description text present in the fetched HTML for ≥4 of the 6 cluster-B samples, in a container not currently read |
| **Files** | `scraper/selectors.ts` (`detail.description`: append the confirmed containers **after** today's entries), `scraper/product-detail.ts:1336-1380` (unchanged logic — it already records which selector won), `tests/warranty-description.test.ts`-style fixture test |
| **Must not move** | JSON-LD rescue path; `descriptionRejectedSelector` semantics; the 24-field report shape |
| **Accept** | on the captured fixtures, description goes `MISSING → EXTRACTED`; on the 20 **[HARNESS]** products nothing that was extracted becomes absent |
| **If falsified** | no selector change; instead Phase 6b's honest reason ("PDP carries its description only in A+ modules absent from the fetched HTML") |

### Phase 5 — PDP coupon and deal badge (F5) — *gated on Phase 0.2*

| Item | Detail |
|---|---|
| **Files** | `scraper/selectors.ts` (**new** `detail.coupon` and `detail.dealBadge` lists, keeping the card lists untouched), `scraper/product-detail.ts:1074` + `:1098` (read the new detail lists, then fall back to the card lists exactly as today), tests |
| **Guard** | the coupon text must still match `/coupon\|voucher\|rabatt/i` before it is stored, and the badge text `/deal\|limited time\|lightning\|…/i` — so an additive selector cannot manufacture a false positive |
| **Must not move** | card coupon/badge extraction; export columns; `coupon`/`dealBadge` schema |
| **Accept** | ≥1 captured PDP with a coupon now yields it; every existing fixture unchanged |
| **If falsified (client-rendered only)** | ship no selector; instead F5 becomes a Phase 6b reason: `"coupon badge is not present in the fetched HTML (rendered after load)"` |

### Phase 6 — The buy-box-less PDPs (F7)

**6a — honest statuses (always ships).**
`product-detail.ts:1005` and `:1303`: when the buy-box scope exists but contains no
price/merchant text **and** `availability` + `rating` are present, report
`MISSING` with a reason naming the page state
(`"page served without a featured offer: buy-box container present but empty"`),
not `PARSE_FAILED`. Same for `seller`. `enrich-saved-product.ts:449` keeps
`complete ⇔ title && price`, so no row changes.
Tests: replay the 12 Phase 0 samples; assert statuses and that every stored row is
byte-identical.

**6b — recovery strategy — *dropped per Q1 (operator decision, 2026-10-21)*.**
SAD-370 makes no attempt to obtain an offer the page did not serve. The row keeps the
listing price the user saw, which is already the designed behaviour
(`enrich-saved-product.ts:63-67`). The rejected options, recorded so the decision can
be revisited with its trade-offs intact:
- *second fetch with `?th=1&psc=1`* — cheap, but an unverified gamble that doubles
  request volume on the 60% of pages that would need it;
- *parse the live tab* — highest fidelity, but couples enrichment to tab state and
  only helps the product that happens to be open.
If revisited, it becomes its own ticket with its own Phase 0.

### Phase 7 — Verification and documentation

1. `npm run verify` (tsc + vitest + wxt build + audit) green.
2. `npm run measure:diagnostics -- --flag on --asins <12 sample>` before/after diff
   table committed as `docs/plans/SAD-370-measurement-2026-10-2x.md`.
3. `CHANGELOG.md` — one `## [Unreleased] — SAD-370` section, sub-headed
   **Fixed** (size cap, drift verdict, description/coupon if confirmed) /
   **Changed** (card report reasons, offerless-PDP statuses) / **Unchanged**
   (stored rows, card extraction, Temu).
4. `ARCHITECTURE.md` — one paragraph on the two-lane diagnostics discipline and the
   `cardKind` field.
5. `docs/plans/SAD-370-verification-report.md` mirroring SAD-360's.

---

## 8. Regression protection — how "must not influence other features" is enforced

| Invariant | How it is proven |
|---|---|
| **Stored products unchanged** | every step adds a test that parses the same fixture with and without the change and deep-equals the resulting product object (the pattern SAD-369 used for card reports) |
| **Report still partitions 24 fields** | assert `fields.length === 24` and `counts` sum to 24 on both card kinds and on a PDP |
| **Temu untouched** | `tests/temu-isolation.test.ts` must stay green; no Temu file is opened in this ticket |
| **Message schema additive** | `tests/message-schema-conformance.test.ts` + `tests/message-registry-sync.test.ts` cover the new optional `cardKind`; an old content script still validates |
| **Diagnostics switch still gates everything** | `tests/diagnostics-setting.test.ts` + the `--flag off` harness run must print **nothing** |
| **Collection cap unchanged** | `tests/collection-diagnostics.test.ts` unchanged and green |
| **No new manifest permission / WAR entry** | `tests/manifest-permissions.test.ts`, `tests/manifest-war.test.ts` |
| **Docs consistency** | `tests/docs-consistency.test.ts` (version/plan pairing) green after the CHANGELOG edit |

---

## 9. Risk register

| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| Raising the size cap to 5 MB makes the offscreen parse slow or memory-heavy on low-end machines | Medium | Phase 1 keeps the offscreen limit as the single source; a timing test pins parse duration on a 4 MB fixture; the fetch already streams into a string today | one constant |
| A new PDP selector steals a value from the wrong node (e.g. a "similar item" coupon) | Medium | append-only ordering + the existing text gate; `isInsideExcludedDetailSubtree` still applies (`product-detail.ts:40`) | revert the appended entry |
| `cardKind` misclassifies a page and a real regression gets explained away | Medium | `cardKind` is derived from the detected page type + card class/`data-testid`, and `unknown` is always allowed; Phase 2 asserts search cards keep their current reasons | drop the field, keep 24-field report |
| Drift detector becomes noisy on legitimately sparse layouts | Medium | layout-aware thresholds (Phase 3), plus a `/deals` sweep test | revert the two conditions |
| Phase 0 cannot reproduce the 42 buy-box-less pages (different day, different A/B) | Medium | samples are the exact ASINs from the log; if the offer is back, F7 is recorded as transient and only 6a ships | n/a |
| Diagnostics changes leak into product data | Low | every report change sits behind the existing switch; two-lane tests | n/a |

---

## 10. What this plan deliberately does **not** do

- It does **not** add rating/review/brand/seller selectors to cards — the log's own
  fixture evidence says those fields are not on the card (F1). If Phase 0 finds
  them, that becomes one narrow, tested addition.
- It does **not** "fix" the 42 `PARSE_FAILED` PDPs by grabbing a price from
  somewhere else (e.g. a similar-items carousel). Silently substituting a different
  offer's price is the one thing the enrichment path is explicitly built to avoid
  (`enrich-saved-product.ts:63-67`: the price the user saw is never replaced).
- It does **not** touch `isPrime`, `variations`, `weight`, `warrantyDescription`,
  `bestSellersRank` — all of which behave exactly as measured.
- It does **not** re-architect the parsers, and it does not consolidate the
  search/category card duplication (a known, separate cleanup).

---

## 11. Step-by-step commit plan (for when implementation starts)

| # | Commit message | Files | Gate |
|---|---|---|---|
| 0 | `SAD-370 step 0: capture deals-card and fetched-PDP evidence` | `scripts/sad-370-evidence-capture.mjs`, `docs/plans/SAD-370-evidence-*.md`, `tests/fixtures/sad-370/*` | evidence tables recorded |
| 1 | `SAD-370 step 1: raise the PDP size cap to the parse cap and name the size failure` | `enrichment-fetch.ts`, `enrich-saved-product.ts`, tests, CHANGELOG | 9 ASINs enrich; boundaries pinned |
| 2 | `SAD-370 step 2: report the card layout in every card diagnostic` | `card-diagnostics.ts`, both card parsers, `extraction-diagnostics.ts`, `handler.ts`, `save-job.ts`, `messages.ts`, tests | 24 fields, statuses unchanged |
| 3 | `SAD-370 step 3: let the drift detector see rating and review coverage` | `drift-telemetry.ts`, tests | `/deals` sweep verdict truthful |
| 4 | `SAD-370 step 4: read the PDP description container the page actually uses` *(gated)* | `selectors.ts`, fixture tests | captured fixtures flip to EXTRACTED |
| 5 | `SAD-370 step 5: read PDP coupon and deal-badge markup` *(gated)* | `selectors.ts`, `product-detail.ts`, tests | no false positives on 28-sample |
| 6 | `SAD-370 step 6: report a buy-box-less product page as such` | `product-detail.ts`, `enrich-saved-product.ts`, tests | rows byte-identical |
| 7 | `SAD-370 step 7: verification report, changelog, architecture` | docs | `npm run verify` green |

---

## 12. Decisions — resolved 2026-10-21 (and the one still open)

| # | Decision | Answer | Where it lands in the plan |
|---|---|---|---|
| **Q1** | Buy-box-less PDPs | **Accept + report honestly** | Phase 6a ships; 6b dropped (§7) |
| **Q2** | Phase 0 capture method | **CDP interception of the service-worker request** | §7 Phase 0.2 |
| **Q3** | Scope | **Both lanes** — extraction *and* diagnostics honesty | Phases 1-6 all in scope |
| **Q4** | Card report field count | **Open** — recommendation: keep all 24 fields, change only the reasons | Phase 2; must be settled before step 2 |

## 13. Appendix — ASINs to use in Phase 0

**Cluster B (price `PARSE_FAILED`, 42)** — take the first six:
`B00AHAWWO0`, `B00JH98GR4`, `B079H53D2B`, `B07MJL8NXR`, `B07S98411N`, `B07W4SN7N7`
(full list: B08YBJJLGF, B095PP1GZR, B097RG67QB, B09BD8GZ8L, B09GTRVJQM, B09RTVD1GF,
B09W4S2ZX7, B0B2X92HDC, B0BJCVRT8K, B0BZR6YBHK, B0C1NQZDYH, B0C21ZLQNC, B0C25Y15TL,
B0C2C9NHZW, B0C6FCKQML, B0C7Y5C4HW, B0CM6VDKSQ, B0CNTRVZPW, B0CR5YH7YK, B0D38HHCG9,
B0D3D5LKG9, B0D71BKD7Q, B0D7N2KWLH, B0DB5T7NTL, B0DDCQ534S, B0DDCRRBX2, B0DGTMR754,
B0DH1MKVQV, B0DTKCN3Z4, B0F7RR3YC6, B0FD3GVSF1, B0FFLRPY3Q, B0FHWK3W1S, B0FVYCZ7F5,
B0GVTPKJVT, B0H4WXSXHS).

**Cluster A (price OK, 28)** — take six:
`B00AWWMWMU`, `B0157T2ENY`, `B07HC2WHS1`, `B07RY59C3W`, `B08FHPD83P`, `B09SYYRBVP`.

**"Too large" (9)** — take two: `B0BRBDC16F`, `B0CYZD34VF`.

**Listing surface:** `https://www.amazon.com/deals` (the drift lines in the log are
`category-page`; the deals grid is the category layout the repo has already
captured verbatim — see F1).

---

## 14. Summary in one paragraph

The log's most alarming number — 17 of 24 card fields missing on every card — is
not a parser failure: the operator was collecting the `/deals` grid, whose cards
carry price, list price, title, image and ASIN and nothing else (**[FIXTURE]**,
**[LOG]** tier pattern, arithmetic in §3.3). The genuine defects the same log
proves are narrower and sharper: a 3 MB PDP fetch ceiling that silently rejected
9 of 80 products while 2.99 MB pages passed; a drift detector that reported
`false` with two fields at 0%; a card report that cannot say what kind of card it
came from; and a family of PDP fields that 90 independent product pages never
yielded (`coupon`, `dealBadge`, ~75% of `description`) because the product-page
path has no detail-scoped selectors for them. The plan fixes the certain ones
immediately, and gates every selector change behind a Phase 0 capture of the real
markup — so nothing ships on a guess, and no working path is touched.
