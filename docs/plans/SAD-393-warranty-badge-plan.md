# SAD-393 — Plan Only: "The warranty and badge fields" are not extracted as expected

> **Status: PLAN ONLY — no application code changed.** This document is the only
> file added by the SAD-393 planning pass. Temporary probe tests used to prove
> the findings below were deleted after they ran; Appendix B describes them so
> they can be recreated verbatim.
>
> Issue: https://linear.app/sad-mod/issue/SAD-393/the-warranty-and-badge-fields
> *"The warranty and badge fields are not being extracted as expected. Please
> investigate the root cause of the extraction issues, identify why the expected
> data is missing or incorrect, and implement a reliable fix. Verify that both
> fields return accurate, properly formatted data without affecting other fields
> or existing functionality."*
> Priority 1 · Label `Bug` · Project PPHunt · State Todo · No comments,
> attachments, relations, or example ASINs on the issue (checked via Linear
> 2026-10-21).
>
> Repository state analysed: `main` @ `2ec7eaf` ("Merge branch
> 'feat/temu-engine' — SAD-380 … SAD-381"). Live evidence was captured
> 2026-10-21 with [moli](https://github.com/lexmount/moli) `1.1.18`
> (prebuilt binary; see Appendix A) against amazon.com.

---

## 0. Verdict in one page

**Which "badge" is broken (the owner left this open — measured answer):**
`badge` (the **Badge** column: Best Seller / Overall Pick / Amazon's Choice) is
broken. `dealBadge` (the **Deal** column) extracted on every badged live card
sampled — once as printed text, otherwise as SAD-386's derived `Deal`. Deal
*text quality* (countdown templates) is already owned by SAD-387 (in review,
branch `fix/sad-387-deal-countdown`); SAD-393 must not duplicate it and must be
implemented on top of it (§11).

**Root causes, ranked by evidence strength** (full detail in §5):

| # | Field | Root cause | Evidence |
|---|---|---|---|
| RC-B1 | `badge` | Amazon moved status badges to a new capsule (`amazonBadges` / `rio-badge-*` inside `.puis-status-badge-container`). Neither of the two `statusBadge` selectors matches it. **Best Seller badges are lost 8/8 in live samples; Overall Pick still uses the old markup and works 3/3.** | Live moli capture + real-parser replay (§4.3, L-S) |
| RC-B4 | `badge` | The parse cache (SAD-383/386 freshness rules) never re-reads a settled card for a late-injected status badge: its "settled" and "evidence" predicates know rating + price-family only, and `badge` is in neither. | Unit probes P-B4a/P-B4b (live *frequency* unproven — §4.4) |
| RC-W1 | warranty | Whole PDP families publish the warranty outside today's containers/labels. Proven case: Kindle (Amazon Devices) states `Warranty and Service → 1-year limited warranty…` in `#tech` (`table.a-bordered`); today's container list lacks `#tech` **and** the label pattern rejects `Warranty and Service`. Diagnostics consequently report a false *"no warranty row in the detail tables"*. | Live moli capture + real-parser replay (§4.3, L-Kindle) |
| RC-W2 | warranty | Fractional durations are **garbled, not just missed**: `1.5 years` normalizes to `5-year`. Wrong data is worse than missing data; this is a must-fix regardless of live frequency (currently unknown). | Unit probe P-W2 |
| RC-B2/B3, RC-W3 | both | Narrow matching: curly-apostrophe `Amazon’s Choice` and one-word `Bestseller` fail the badge vocabulary; same-selector first-match lets a deal node shadow a status node; `Five (5) Year`, `2–year` (en dash / U+2011) fail the warranty normalizer. | Unit probes; live relevance TBD §4.4 |
| RC-B5 | `badge` | Diagnostics blindness: `badge` is the only modelled card field never recorded (no EXTRACTED/MISSING/PARSE_FAILED), so today's tooling cannot distinguish "no badge on card" from "badge present but unread". | Code + probe P-B6 |
| — | both | **By-design absences that must not be "fixed" by fabrication:** listing cards never carry warranty; PDP parser never produces `badge`; the `brand-and-rank` enrichment scope deliberately discards warranty; many PDPs genuinely publish no duration (TOZO's warranty cell literally says `TOZO`; AirPods publish no warranty row) so `No` is honest there. | Code + live samples §4.3 |

**Fix shape (details §7):** additive, vocabulary-gated selectors for the rio
capsule; badge diagnostics following the SAD-383 `nodeSeen` precedent; a
badge-aware cache-freshness predicate that preserves the SAD-383/386
performance contracts; evidence-gated warranty container/label additions
(`#tech`, `Warranty and Service` family); warranty normalizer correctness
(fraction garble first). Everything else — schemas, merges, UI, exports,
settings — already carries both fields correctly today and stays untouched
(§3, §6). Two policy questions are left as owner gates, not assumptions:
warranty inside the `brand-and-rank` enrichment scope (G6) and read-time
healing of already-stored garbled warranty tokens (G7).

---

## 1. Baseline — measured in this sandbox, not assumed

At `2ec7eaf`, after `npm install --no-audit --no-fund`:

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **clean** |
| Targeted suites (warranty, pricing/deals, SAD-386 ×3, enrich, collection-save-parity, card/extraction diagnostics) | `npx vitest run <9 files>` | **131 passed** |
| Build | `npx wxt build` | OK, 2.03 MB |
| Full suite (after build, so the gated manifest suite runs) | `npx vitest run` | **1418 passed — 127 files passed, 1 skipped (128)** |
| Dead-export guard | `node scripts/check-dead-exports.mjs` | *"all src/lib exports have consumers (42 files scanned)"* |

**The pass bar for SAD-393 is therefore: ≥1418 passing (plus its own new
tests), 128 files accounted for, `tsc` clean, build OK, dead-export guard
green.** Anything less is a regression or a skipped build (the SAD-349 §0
lesson).

Remote branches that interact with this work (checked, §11):
`fix/sad-387-deal-countdown` (5 commits, touches `field-parsers.ts`,
`product-detail.ts`, `deal-evidence.ts`, `columns.tsx`, `export/types.ts`, adds
`utils/deal-text.ts` + real fixtures), `fix/sad-388-preview-scroll-jitter`
(touches both `columns.tsx` files), `fix/sad-389-monthly-sales-coupon`
(no commits ahead of `main` at time of writing).

---

## 2. Scope decisions (from clarifying questions — not guessed)

| Question | Decision (owner, 2026-10-21) |
|---|---|
| Which engine(s)? | **Amazon only.** Temu stays byte-identical. (Temu has a `badge` field with its own parser, and **no warranty field at all** in type/schema/selectors — a Temu warranty would be a new-field feature, explicitly not this ticket. Same precedent as SAD-349 §1/§1.1.) |
| Which "badge"? | **Owner unsure — investigate both and report.** Measured answer: `badge` is broken, `dealBadge` is not (§0/§5). SAD-393 fixes `badge`; `dealBadge` gets measurement + non-regression coverage only. |
| Which workflow(s)? | **All** — Collection Mode (search/category/deals), one-click saves (right-click + card button, incl. PDP enrichment), and collecting on a PDP itself. Parity across workflows is therefore an acceptance criterion (§10). |
| Symptom? | **Intermittent** — sometimes missing on products that show the data. No example ASINs/URLs were supplied. The intermittency is consistent with what was found: badge outcome depends on which of two badge markups Amazon renders per card; warranty outcome depends on PDP family. |
| How to use moli? (owner instruction, interpreted) | As the **live reproduction/capture tool**: moli's rendered-DOM fetch + `--eval`/survey scripts + `--dump html` (and `--disable-js` to approximate the static enrichment fetch) — per its `skills/moli-webfetch` skill. **No moli code enters PPHunt.** Precision note: moli 1.1.18's wait flag is `--wait`, not `--wait-until` (verified via `moli fetch --help`). |

Assumptions carried (flagged, reversible at the Step 0 gates §7):

- **Stored formats unchanged:** `badge` stores the page's label text
  (`Best Seller`, `Overall Pick`, …); warranty stores the compact token +
  verbatim raw pair (SAD-349). No new product fields ⇒ **no DB migration, no
  schema change** (descriptive fields are unindexed — SAD-349 §2.5 verified
  reasoning still applies).
- **English-only label/vocabulary matching stays** (SAD-349 decision A), unless
  Step 0 captures produce verified non-English evidence *and* the owner opens
  that gate. The structural parts of this plan (capsule containers) are
  language-agnostic; only the final vocabulary gate is English.
- Plan deliverable follows repo convention: this file under `docs/plans/`.

---

## 3. How the two fields flow today (verified)

Canonical code lives in `src/engines/amazon/**`; `src/lib/**` are re-export
shims and must not be edited (SAD-349 §2.1). All line refs at `2ec7eaf`;
full gate index in Appendix C.

### 3.1 `badge` — listing-card-only

```
parseAmazonSearchCard   (scraper/search-results.ts:102,167) ─┐ extractCardBadge
parseAmazonCategoryCard (scraper/category-page.ts:155,217)  ─┘ (scraper/field-parsers.ts:1593)
   → AMAZON_SELECTORS.cardFields.statusBadge (scraper/selectors.ts:291) — exactly 2 selectors:
       '[data-component-type="s-status-badge-component"] .a-badge-text'
       '.a-badge-label-inner'
     each read with querySelector (FIRST match only), text gated by
     /best seller|amazon's choice|overall pick|popular|new release|most wished/i
   → candidate.badge → validateAndNormalizeScrapedProduct keeps it (field-parsers.ts, raw.badge)
   → merges: dedup MERGEABLE_NULLABLE_FIELDS · db/products nullableKeys ·
     quick-save QUICK_SAVE_VOLATILE_FIELDS (refreshable) — all already include badge
   → UI: badgeColumn 'Badge' (ui/table/columns.tsx:486), absent ⇒ "No"
   → export: 'Badge': p.badge || 'No' (export/types.ts:71)
```

- The **PDP parser never sets `badge`** (`product-detail.ts` candidate assembly
  has no badge assignment — probe P-B5), yet `DETAIL_FIELDS` in
  `background/enrich-saved-product.ts:31` lists `'badge'` (a dead whitelist
  entry: enrichment can never backfill it — and
  `collectMissingDetailFields` reports it missing forever). Shipping detail
  objects fabricated in tests *can* carry it (`tests/collection-save-parity.test.ts`
  mocks the offscreen parse with `badge: 'Amazon’s Choice'` — which is how a
  curly-apostrophe value entered the repo without any real extractor producing
  it).
- **Diagnostics:** `CardDiagnosticsInput` (`scraper/card-diagnostics.ts:39`)
  has no badge field and `recordCardDiagnostics` never records it; both card
  parsers compute `badge` but do not pass it in. `DETAIL_DIAGNOSTIC_FIELDS`
  (`scraper/extraction-diagnostics.ts:93`, 24 fields) deliberately excludes it
  (comment :88). Card reports also pin 24 fields mirroring that list
  (`tests/card-diagnostics.test.ts:85,155`). Any diagnostics change must deal
  with this 24-field symmetry deliberately (§7 Step 2).
- **Parse cache:** cards are memoized once asin/title/price/image exist;
  re-parse after DOM change is allowed only when rating fields are missing
  (SAD-383) or price-family evidence (`%`/deal vocabulary) appears (SAD-386) —
  `scraper/parse-cache.ts:39/49/63`, gates at :112/:121. `badge` participates
  in none of these predicates (RC-B4).
- Settings: `enabledFields.badge` (default true) gates **display/export only**
  (`columns.tsx` `!== false`; `export/types.ts:233`), never extraction.

### 3.2 `warrantyDescription` (+`warrantyDescriptionRaw`) — PDP-only (SAD-349)

```
parseAmazonProductDetail (scraper/product-detail.ts:1523,1593)
   → extractDetailWarranty (:340): walk detail.warrantyContainers (selectors.ts:162, 11 containers)
     → iterDetailSpecRows (:302): tr,li rows; header 'th, .a-text-bold, td:first-child strong, td:first-child b'
     → label must match AMAZON_WARRANTY_LABEL_PATTERN (selectors.ts:26, English, whole-label anchored)
     → normalizeWarrantyDescription (field-parsers.ts:334): 'lifetime' first, else
       WARRANTY_DURATION_RE (:297) digits 1-3 or spelled numbers + English units → "N-unit"
     → diagnostics EXTRACTED / PARSE_FAILED (label seen, no duration) / MISSING
   → candidate pair (both or neither) → validateAndNormalize keeps pair together
   → merges: dedup · db/products · enrich DETAIL_FIELDS (authoritative, not fill-only) — all include the pair
   → UI: 'Warranty' column (columns.tsx:822), absent ⇒ "No", raw as tooltip/expand
   → export: 'Warranty Description' + 'Warranty Details', absent ⇒ "No" (export/types.ts:91-92)
```

Paths that can ever produce warranty today:

| Workflow | Warranty source | `badge` source |
|---|---|---|
| Collection on search/category/deals | Card parse: never. Then collection enrichment pump (`background/enrichment-pump.ts`) fetches PDPs: **full** scope within budget (`enrichCollectedLimit`, default `'all'` — `constants/defaults.ts:63`) merges warranty; beyond budget, `brand-and-rank` scope merges **only brand/BSR** (`enrich-saved-product.ts:137`) — warranty parsed then discarded (probe P-W4). Enrichment fetch can also skip/fail silently (permission, per-host circuit breaker `enrichment-fetch.ts:33`, >MAX HTML, ASIN mismatch in `offscreen/parse.ts`). | Card parse only (`extractCardBadge`); enrichment can never add it (PDP parser doesn't produce it). |
| Collection started on PDP / save on PDP | Direct live `parseAmazonProductDetail` (`amazon.content.ts` detail branch; `content/save-product.ts:125`). | Never (PDP parser). |
| One-click save from card (right-click / card button) | Card parse (`content/save-product.ts:36` search-then-category) writes the row; background enrichment then fetches the canonical PDP cookieless, parses **statically** via offscreen `parsePdpHtml` → same `parseAmazonProductDetail` on a `DOMParser` document (no JS hydration), merges `DETAIL_FIELDS`. | Card parse at save time only; frozen thereafter except quick-save volatile refresh on a fresh re-save. |

So the two fields fail in *opposite* halves of the system: `badge` can only be
won or lost at the listing card, warranty only at the PDP (live or fetched).

### 3.3 What already works and must not move

Schemas (`schemas/product.ts:35,51-52`), normalizer pass-through, all merge
whitelists, quick-save snapshot policy, columns, exports, settings toggles and
their contract tests already carry both fields end-to-end — SAD-349 built that
for warranty and the badge pipeline predates it. **No step in §7 needs to touch
them**, except where a step explicitly says so. That is the cheapest
non-regression guarantee available.

---

## 4. Evidence

### 4.1 Code-audit findings (file:line at `2ec7eaf`)

- **F1.** `extractCardBadge` tries each selector with `safeQuerySelector`
  (first match) and returns on the first vocabulary hit
  (`field-parsers.ts:1593ff`). `.a-badge-label-inner` is shared with the deal
  badge (`[data-a-badge-type="deal"] … .a-badge-label-inner`).
- **F2.** Badge vocabulary is a straight-apostrophe English list; `normalizeWhitespace`
  (`field-parsers.ts:81`) strips zero-width/bidi marks but does not fold `’`→`'`.
- **F3.** `parse-cache.ts` freshness predicates ignore `badge`
  (`hasBadgeFamilyFields` = discount/deal/listPrice — the name is about the
  *deal* badge family, SAD-386).
- **F4.** Warranty containers/labels/units are English-only by design
  (SAD-349): 11 containers (`selectors.ts:162`), anchored label pattern
  (`:26`), duration regex with `\d{1,3}` quantities (`field-parsers.ts:297`).
- **F5.** Warranty row iteration is limited to `tr, li` + 4 header shapes
  (`product-detail.ts:302`). `#aplus` is read for *weight*
  (`extractDetailWeight:458`) but is not a warranty container.
- **F6.** Diagnostics coverage is asymmetric: warranty has full
  EXTRACTED/PARSE_FAILED/MISSING on PDPs and a card-inapplicable entry on
  cards (`card-diagnostics.ts:28`); `badge` has nothing anywhere.
- **F7.** `mergeDetailIntoStored` `brand-and-rank` scope returns after
  brand/BSR (`enrich-saved-product.ts:137`); pump assigns that scope to
  over-budget jobs whose brand/BSR is missing (`enrichment-pump.ts` enqueue).
  The PDP HTML for those jobs is fetched and fully parsed either way.
- **F8.** Card fixture tests that pin `badge` use hand-authored *old* markup
  (`tests/pricing-deals-bsr.test.tsx` `s-status-badge-component` +
  `Amazon's Choice`, straight apostrophe; `tests/sad-386-card-deal.test.ts`
  same). The suite therefore cannot see selector drift — the SAD-386 lesson
  ("measured on the repo's own real fixture") applies here: only captured
  markup is evidence.
- **F9.** The only captured *real* search cards in the repo live on the
  unmerged SAD-387 branch (`docs/plans/SAD-387-fixtures/*.real.html`); one of
  them carries a `Best Seller` rio capsule plus a deal `.a-badge-label-inner`
  — i.e. drift evidence already existed in the project's own branches, and
  SAD-387's fixtures should be reused rather than recaptured where possible.

### 4.2 Hypothesis probes (temporary vitest files, run, then deleted)

27 assertions, all stating *current* behaviour — a pass confirms the
hypothesis (Appendix B recreates them):

| Probe | Result (confirmed) |
|---|---|
| P-B1 real SAD-387 fixture card | `.rio-badge-label` text = `Best Seller`; `extractCardBadge` ⇒ `undefined`; full search parse ⇒ `badge: undefined`, `dealBadge: 'Limited time deal'` |
| P-B2 vocabulary | `"Amazon's Choice"` ✓ extracted · `'Amazon’s Choice'` (U+2019) ✗ · `'Bestseller'` ✗ · `'#1 Best Seller'` ✓ |
| P-B3 first-match shadowing | deal `.a-badge-label-inner` before a status one ⇒ `undefined` |
| P-B4a cache, discount present | inject old-markup badge after first parse ⇒ cached parse still `undefined`, fresh parse `'Best Seller'` |
| P-B4b cache, rating present, no price-family | same staleness (badge text has no `%`/deal vocabulary) |
| P-B5 PDP | parsed product has **no `badge` key** even with badge markup on page |
| P-B6 diagnostics | card report fields (24) contain `dealBadge` + `warrantyDescription`, **not `badge`** |
| P-W1 labels | `Manufacturer's Warranty` ✓ · `Limited Warranty` ✗ · `Warranty Length` ✗ · `Guarantee` ✗ · `Garantie`+`2 Jahre` ✗ · English label + `2 Jahre` ✗ (labels beyond the first are *pattern-limit probes*, not observed live — §4.4) |
| P-W2 normalizer | `1.5 years` ⇒ **`5-year`** · `Five (5) Year` ⇒ `null` · `One (1) Year` ⇒ `null` · `2–year`/`2‑year` ⇒ `null` · `3-yr` ⇒ `3-year` · lifetime precedence & first-duration-wins behave as documented |
| P-W3 shapes | div-rows in a known container ✗ · `#aplus` rows ✗ · feature-bullets ✗ (last is SAD-349 by-design; first two are iterator limits, shapes unverified live) |
| P-W4 scope | `brand-and-rank` merge drops a parsed warranty; full merge keeps it |

### 4.3 Live captures with moli (2026-10-21, moli 1.1.18, amazon.com)

Method: `moli fetch` with the Appendix A `--eval-file` survey scripts
(rendered DOM), `--dump html` captures replayed through the **real parsers**
in vitest, and one `--disable-js` dump replayed through the real offscreen
`parsePdpHtml` to approximate the enrichment transport. No CAPTCHA was served
to this sandbox via moli (in contrast to the plain-fetch 503s recorded by
SAD-386/SAD-338 — moli is a real browser runtime).

**Search pages** — first 30 cards of each of 3 searches (76 cards analysed;
11 showed a status badge):

| Page | Badged cards | Outcome with today's code |
|---|---|---|
| `s?k=wireless+earbuds` (16 cards) | 3: `Overall Pick`×1 (old), `Best Seller`×2 (rio, 1 also has deal) | Overall Pick ✓ · both Best Seller ✗ |
| `s?k=yoga+mat` (48, first 30) | 4: `Overall Pick`×1 (old; inners `[Overall Pick, Limited time deal]` — order saves it), `Best Seller`×3 (rio) | Overall Pick ✓ · Best Seller ✗×3 |
| `s?k=board+games` (48, first 30) | 4: `Overall Pick`×1 (old), `Best Seller`×3 (rio) | Overall Pick ✓ · Best Seller ✗×3 |

Parser replay of the earbuds dump (L-S): 23 products parsed; the 3 badged
ASINs → `B0HDB173YV badge="Overall Pick", dealBadge="Deal"` (derived),
`B0FQFB8FMG badge=undefined, dealBadge="Deal"` (derived),
`B09FT58QQP badge=undefined, dealBadge="Limited time deal"` (printed).

The rio shape (verbatim from capture; also in the SAD-387 fixture):

```html
<div class="… puis-status-badge-container s-grid-status-badge-container-dark">
  <div id="amazonBadges-capsule-view" data-csa-c-slot-id="amazonBadges-search-badge"
       data-csa-c-content-id="BEST_SELLER" data-csa-c-component="amazonBadges-search-badge-desktop">
    <div id="BEST_SELLER" class="… rio-badge-component">
      <div aria-label="Best Sellerin Bed Pillow Pillowcases" class="… rio-badge-supplementary-group" role="group">
        <span class="rio-badge-label rio-badge-style-BEST_SELLER …"><span aria-label="Best Seller">Best Seller</span></span>
        <span class="… rio-badge-supplementary-text rio-hidden">in Bed Pillow Pillowcases</span>
```

Notes: the capsule's own `aria-label` concatenates without a space
(`Best Sellerin …`) — never parse that; `.rio-badge-label` text is clean. The
supplementary text repeats the BSR category. `data-csa-c-content-id` values
observed live: **only `BEST_SELLER`** — do not invent an enum mapping for
other badge types without captures (§4.4).

**Product pages (6):**

| ASIN | What the page publishes | Today's outcome |
|---|---|---|
| Dewalt drill `B00ET5VMTU` | `Manufacturer Warranty Description → 3 Year Limited Warranty` (expander tables) | ✅ `3-year` — **positive control**, both rendered parse *and* static no-JS offscreen parse (L-Dewalt) |
| Kindle Paperwhite `B0CFPJYX7P` | `Warranty and Service → 1-year limited warranty and service included…` in `div#tech.content-grid…` `< table.a-bordered`, label cell `<td><p><strong>`; only 1 of today's 11 containers even present (`#productOverview_feature_div`, not an ancestor of the row) | ❌ `undefined`; diagnostics `MISSING "no warranty row in the detail tables"` — wrong: the row exists, in an unwalked container, under an unmatched label. (Header shape *is* compatible: `td:first-child strong` matches `p>strong`.) |
| TOZO earbuds `B09FT58QQP` | `Warranty Description → TOZO` (brand string, no duration) | ⚪ honest `No` (label seen, no duration ⇒ PARSE_FAILED on PDP) |
| AirPods Pro 3 `B0FQFB8FMG` | no warranty row in any spec table (25 row labels, none warranty); only AppleCare attach-modal templates + "extended warranty coverage" bullet prose | ⚪ honest `No` |
| Bedsure pillowcases `B0725WFLMB` | only `Warranty & Support … click here` boilerplate (`#productSpecifications_dp_warranty_and_support`) | ⚪ honest `No` (boilerplate rejection working) |
| Owala bottle `B0BZYCJK89` | only `Manufacturer’s warranty can be requested from customer service…` boilerplate | ⚪ honest `No` |

No status-badge markup (old or rio) was found on any sampled PDP.

**Failures/limits of this capture pass (recorded honestly):**
amazon.co.uk returned an empty shell to moli in this sandbox (title `""`,
0 cards — consent/blank), so **no non-.com evidence exists yet**; one AirPods
fetch returned empty stdout (retry succeeded). Moli `--dump html` serializes
the *post-JS* DOM: it is faithful for the content-script (live) parses, and
only an approximation of the cookieless enrichment fetch (different
transport/UA/cookies — SAD-352's seven exits still apply there).

### 4.4 What is **not** proven (Step 0 must settle — no guessing past this line)

1. Which other badge types ship in the capsule (`content-id` values and label
   texts for e.g. Amazon's Choice / New Release / climate or marketplace
   variants), and whether `Overall Pick` also migrates to rio on some layouts.
2. Badge markup on **category / Best Sellers / deals** card families (the
   `parseAmazonCategoryCard` path) and whether badges ever render on PDPs.
3. Whether late badge hydration (RC-B4) actually happens on live pages, or
   badges are server-rendered with the card (a mutation-timing capture, not a
   DOM snapshot, decides this).
4. Frequency of Kindle-style `#tech` tables across Amazon Devices PDPs, and
   which other PDP families publish warranty rows outside the 11 containers
   or under labels other than today's pattern (`Limited Warranty`, div-rows,
   `#aplus` rows are so far *invented probes*, not captures).
5. Live frequency of fractional / parenthesized / typographic-dash durations.
6. Any non-.com behaviour (labels, badge texts, marketplace badge systems).
7. The owner's own failing products — **still needed**: example ASINs/URLs +
   marketplace where Warranty/Badge visibly exist but PPHunt shows `No`.
   Without them, "intermittent" is explained at the population level (§4.3)
   but no specific user case is verified fixed. Step 0 below treats supplying
   ≥3 such ASINs as an operator input, and the implementation is not "done"
   until they pass (§10).

---

## 5. Root causes

**Badge (`badge`)**
- **RC-B1 — selector drift to the rio capsule (primary, live-proven).**
  Best Seller moved; Overall Pick (so far) didn't. Explains intermittency
  exactly: depends on badge type/layout, not on product or workflow.
- **RC-B2 — vocabulary too narrow (unit-proven).** Curly apostrophe and
  one-word forms fail. Live `.com` samples printed straight text in old
  markup, so impact is likely marketplace/legacy-dependent.
- **RC-B3 — first-match on a shared class (unit-proven).**
  `.a-badge-label-inner` is read once (`querySelector`); a deal node in that
  position ends the search. Live yoga card shows both texts under this class.
- **RC-B4 — cache freshness ignores badges (unit-proven, live frequency
  unknown).** A settled card is never re-read for badge evidence.
- **RC-B5 — no diagnostics (code-proven).** The failure above was invisible to
  the SAD-359/369 diagnostic system; that is itself part of the bug (the
  SAD-352 lesson: discarded outcomes hide which exit produced the blank).
- **RC-B6 — PDP/enrichment can never supply `badge` (code-proven, by design
  today).** Whether it *should* depends on §4.4(2)'s PDP survey.

**Warranty (`warrantyDescription` pair)**
- **RC-W1 — unwalked containers + unmatched labels on entire PDP families
  (live-proven for Kindle/Devices).** Container list and label pattern are
  the two gates; both fail for `#tech`/`Warranty and Service`.
- **RC-W2 — fractional quantities garble (unit-proven):** `\d{1,3}` matches
  the `5` in `1.5 years` (word boundary after `.`) ⇒ stores `5-year`.
  Existing stored rows with such a source keep the wrong token under
  fill-only merges (Raw text is preserved — see gate G7).
- **RC-W3 — normalizer narrowness (unit-proven):** parenthesized
  `(5) Year` forms and typographic dashes between quantity and unit.
- **RC-W4 — other labels/locales (unproven).** Pattern limits measured;
  live occurrences not yet captured. English-only was a deliberate SAD-349
  decision; expanding it needs captures, not translations from memory
  (precedent: SAD-349 §3, SAD-380 captures).
- **RC-W5 — iterator shape limits (code-proven, live shapes unproven).**
- **Not root causes:** by-design scope/budget behaviour and honest absence
  (§3.2, §4.3 PDP table). Any "fix" that turns TOZO/AirPods-style pages into
  values would be fabrication — out of bounds (house rule: *fields the page
  cannot provide stay empty*).

**Deal (`dealBadge`)**: not a SAD-393 defect on the sampled evidence
(printed or SAD-386-derived on all badged cards). Its known text-quality
issue is SAD-387's. SAD-393 changes must still prove the SAD-386 negative
contract: a status badge is never reported as a deal
(`tests/sad-386-card-deal.test.ts`).

---

## 6. Guardrails (how every step avoids influencing other features)

1. **Additive selectors only.** New selectors append to existing lists;
   existing entries and their order never move (SAD-386 precedent). A step
   that cannot prove a new selector with a captured fixture ships without it.
2. **Page wording wins, vocabulary gates.** Any new badge/warranty candidate
   must pass the same kind of text gate as today; capsule `content-id` may
   *locate* a node but the stored value is the page's label text
   (`deal-evidence.ts` rule 1 precedent). Never store aria-concatenations.
3. **No fabrication, no derivation inventiveness.** No new derived values
   (badge has no struck-price-style derivation); warranty still requires a
   real duration/lifetime in the cell; boilerplate rejection stays structural.
4. **Token+Raw invariant** for warranty everywhere (SAD-349): any normalizer
   change keeps `warrantyDescriptionRaw` verbatim and pair-atomic.
5. **Merge/schema/UI/export contracts untouched** unless a step names them:
   no new fields, no column order/size changes, no settings keys → the
   hard-pinned contract suites should need **zero** edits except the
   diagnostics-count pins named in Step 2.
6. **Performance contracts:** warm parse-cache pass stays no-work for settled
   cards (`tests/scraper-performance.test.ts` + SAD-386 cache tests are the
   gate); diagnostics-off stays allocation-free (SAD-369 pattern).
7. **Amazon-only diff.** `git diff` for `src/engines/temu` must be empty at
   every step; `src/lib` shims untouched (dead-export guard is the check).
8. **One commit per step** (house style `SAD-393 step N: …`), each step
   independently green and revertible; policy changes (Step 6) are *separate*
   commits after their gate, never bundled with selector work.

---

## 7. Implementation plan

### Step 0 — Evidence completion & decision gates *(no src changes)*

**Capture pack** (moli first; residential-browser fallback à la
`scripts/sad-386-capture.mjs` for whatever moli/sandbox can't reach):

- Searches on amazon.com: ≥5 query families likely to cover badge types
  (electronics, home, toys/books, grocery, tools) + a Best Sellers category
  page + a `/deals` page; save **trimmed** badged-card HTML (SAD-383/387
  fixture style) to `docs/plans/SAD-393-fixtures/`, incl. the SAD-387
  branch's two real cards once that merges. Survey script: Appendix A.1,
  committed as `scripts/sad-393-capture.mjs` **only if** the team wants it
  kept (spike-tool convention — not bundled, not CI).
- PDPs: the §4.3 six ± ≥4 Amazon Devices (`#tech` check: Echo/Fire/Kindle
  variants), ≥4 tools/appliances/electronics with spec tables, plus the
  owner's failing ASINs (§4.4.7). For each: rendered dump + `--disable-js`
  dump; record per-ASIN container/label/value via Appendix A.2/A.3.
- Badge-hydration timing probe (RC-B4 frequency): via moli CDP server
  (`moli serve` + Playwright `connectOverCDP`, moli-cdp skill) or
  Playwright/Chromium: MutationObserver timestamping when capsule nodes
  appear relative to price/image, on 2 search pages. If badges are always in
  the server HTML, Step 3 shrinks to a regression test with no behaviour
  change; if they hydrate late, Step 3 ships as designed.
- One non-.com marketplace sample (operator-run if the sandbox keeps getting
  consent shells).

**Decision gates to close at Step 0** (recommendations are defaults if the
owner doesn't override; none blocks Steps 1–5 except where noted):

| Gate | Question | Recommendation |
|---|---|---|
| G1 | Badge stored text for rio: label only (`Best Seller`) or + supplementary (`Best Seller in Yoga Mats`)? | **Label only** — matches existing stored values/column width; category already carried by BSR. Raw-less field, so longer text would be a format change. |
| G2 | Fractional warranty token: `1.5-year` vs reject-to-null? | **`1.5-year`** (Raw preserved anyway; rejecting discards real coverage). Must-fix either way: never `5-year`. |
| G3 | Add `#tech` container + `Warranty and Service` label family? | **Yes iff Step 0 shows them on ≥2 Devices PDPs** with no cross-product leakage (excluded-subtree rules apply). |
| G4 | Any non-English labels/vocabulary? | Only with verified captures + owner opt-in; else deferred (single extension points already exist). |
| G5 | PDP `badge` extraction? | Only if a PDP badge is captured; else document listing-only and clean up the dead `DETAIL_FIELDS` entry in Step 6. |
| G6 | Warranty in `brand-and-rank` scope? | See Step 6 — separate policy gate. |
| G7 | Heal already-stored garbled tokens (`1.5 years`→`5-year`) at display/export (SAD-387 step-3 precedent: clean at read from `Raw`)? | Only if Step 0/owner data suggests fractional sources occur; the preserved Raw makes a read-time re-normalize safe and migration-free. |

*Falsification rule (from SAD-386): a selector/label with zero captured
occurrences does not ship.*

### Step 1 — Read the badge Amazon actually renders (`badge` extractor)

- **Files:** `src/engines/amazon/scraper/selectors.ts` (append to
  `cardFields.statusBadge`: rio capsule selectors proven in fixtures, e.g.
  `.rio-badge-label` and/or a capsule-scoped variant — final list comes from
  Step 0 fixtures, appended after the two existing entries),
  `src/engines/amazon/scraper/field-parsers.ts` (`extractCardBadge`).
- **Changes:** iterate **all** matches per selector (`safeQuerySelectorAll`),
  not first-match; skip nodes inside `[data-a-badge-type="deal"]` (the deal
  badge's own subtree — kills RC-B3 shadowing structurally); vocabulary check
  on an apostrophe-folded copy (`’`→`'`) while storing the page's original
  (whitespace-normalized) text; keep the existing five phrases, extend only
  with captured texts; supplementary rio text is never read (G1). No other
  function signature changes (diagnostics shape is Step 2).
- **Tests:** new `tests/sad-393-badge.test.ts` replaying the trimmed real
  fixtures (Best Seller rio ± deal, Overall Pick old ± deal-after) through
  `parseAmazonSearchCard`/`parseAmazonCategoryCard`; unit cases for P-B2/P-B3;
  the SAD-386 negatives (status badge never becomes `dealBadge`; deal text
  never becomes `badge`) re-asserted against the shared card.
- **Must not move:** `extractCardPricingAndDiscounts`, `deal-evidence.ts`,
  card candidate assembly, columns/exports, `badge` schema/settings.
- **Verify:** targeted suites (§9) green; before/after replay table on the
  Step 0 fixture pack shows only `badge` changing (`git stash` A/B replay —
  the differential trick from SAD-386 verification).

### Step 2 — Make `badge` visible to diagnostics

- **Files:** `field-parsers.ts` (badge extractor gains a `nodeSeen`-style
  result — follow the SAD-383 `TieredValue` precedent so existing callers
  keep compiling), `scraper/card-diagnostics.ts` (`CardDiagnosticsInput.badge`
  + record EXTRACTED / PARSE_FAILED *node present but text not a status
  badge* / MISSING), `search-results.ts` + `category-page.ts` (pass it
  through — recording only, products byte-identical).
- **24-field symmetry decision:** card reports go 24 → 25 fields. Update the
  pins in `tests/card-diagnostics.test.ts` deliberately (D3 comment amended:
  card universe = detail universe + `badge`), *unless* G5 adds PDP badge
  extraction, in which case `DETAIL_DIAGNOSTIC_FIELDS` gains `badge` too and
  both go to 25 (`tests/extraction-diagnostics.test.ts` pins amended
  likewise). The count change is the *point* of those contract tests — treat
  as reviewed churn, not regression (SAD-349 §2.4).
- **Must not move:** diagnostics-off path (no collector ⇒ identical products,
  zero added cost), `CARD_INAPPLICABLE_FIELDS` contents (warranty stays a
  card-inapplicable field), transport/log formats.
- **Verify:** `card-diagnostics`, `extraction-diagnostics`,
  `collection-diagnostics*`, `card-icon-save-diagnostics`, diagnostics
  settings suites green.

### Step 3 — Let a late-hydrated badge reach the parser (parse cache)

*(Ships only in the form Step 0's timing probe justifies.)*

- **Files:** `src/engines/amazon/scraper/parse-cache.ts` only.
- **Changes (mirror SAD-386 step 4 exactly):** rename/extend the
  "evidence" predicate so a settled-but-badgeless card is re-read when its
  (changed) subtree now shows badge evidence — capsule/rio node presence or
  badge vocabulary — and treat an already-extracted `badge` as settling (add
  `product.badge` to the settled check alongside — not inside — the
  price-family predicate, keeping names honest). Signature gating and the
  "unchanged card is never re-parsed" guarantee stay; no TTL (measured dead
  end, SAD-386).
- **Tests:** extend the pattern of `tests/sad-386-cache-freshness.test.ts` +
  `tests/parse-cache-rating-reparse.test.ts`: P-B4a/P-B4b become passing
  regression tests; a no-badge-anywhere card still parses exactly once
  (parser call count), and `tests/scraper-performance.test.ts` stays green.
- **Must not move:** rating/deal freshness behaviour (their tests unchanged),
  cache completeness definition for other fields.

### Step 4 — Walk the containers/labels the evidence proved (warranty reach)

- **Files:** `selectors.ts` (`detail.warrantyContainers` — append proven
  containers, candidate `#tech` per G3; `AMAZON_WARRANTY_LABEL_PATTERN` —
  extend for proven labels, candidate `Warranty and Service` family),
  `product-detail.ts` **only if** Step 0 proves a new row shape (then the
  narrowest `iterDetailSpecRows` extension, shared with weight/BSR callers —
  re-run their suites).
- **Guardrails:** pattern stays whole-label anchored; new containers respect
  `isInsideExcludedDetailSubtree`; diagnostics must then report the *found*
  selector (today's false Kindle "no warranty row" reason becomes EXTRACTED
  with `selector: '#tech'` — assert it).
- **Tests:** extend `tests/warranty-description.test.tsx` with trimmed real
  fixtures: Dewalt (still `3-year`), Kindle (now `1-year`, Raw =
  `1-year limited warranty and service included…` verbatim — note the cell
  also mentions optional 2/3-year extensions; first-duration-wins keeps the
  included term, assert the Raw keeps the full sentence), TOZO/AirPods
  (still honest `undefined`), boilerplate cases unchanged.
- **Must not move:** feature-bullets/description scanning stays **out**
  (SAD-349 decision stands unless the owner reopens it explicitly — prose
  scanning is how boilerplate gets stored).

### Step 5 — Warranty normalizer correctness

- **Files:** `field-parsers.ts` (`normalizeWarrantyDescription` +
  `WARRANTY_DURATION_RE` only).
- **Changes:** (a) **garble fix first:** quantity matching must not start
  mid-number — guard against a preceding digit/`.`/`,` and, per G2, accept
  `\d+(?:\.\d+)?` emitting `1.5-year`; (b) accept parenthesized
  `Word (N) unit` / `(N) unit` forms; (c) fold typographic dashes
  (U+2010–U+2015, U+2212 — the SAD-386 discount set) **inside this function
  only**, never in the shared `normalizeWhitespace`; (d) keep
  lifetime-first and first-duration-wins semantics *explicitly* (documented
  SAD-349 trade-offs; changing them is a separate owner decision).
- **Tests:** the P-W2 table becomes assertions in
  `tests/warranty-description.test.tsx`; every pre-existing SAD-349 case
  (incl. all boilerplate rejections) passes **unchanged**.
- **Must not move:** stored-token format for all currently-correct inputs
  (snapshot the existing 22-case table as the regression contract).

### Step 6 — Policy-level items *(conditional, each behind its gate)*

a) **Warranty in the `brand-and-rank` scope (G6).** Fact base: over-budget
   collection rows already pay a PDP fetch+parse when brand/BSR is missing;
   the warranty is parsed and then discarded by the merge (F7/P-W4). Options:
   (i) keep policy, document that over-budget rows show `No` even after a
   fallback fetch; (ii) add the warranty pair (fill-only) to that scope's
   merge — **zero extra requests**, but the scope name/persisted
   `JobSchema` enum (`enrichment-pump.ts`) and README/ARCHITECTURE wording
   must be updated honestly (precedents: SAD-384 independent brand/rank
   fallback, SAD-383 rating backfill). *Eligibility must not change* under
   (ii): a missing warranty alone never triggers a fetch beyond budget —
   that would be a network-policy change requiring its own decision.
   Tests: `collection-enrichment-pump`, `enrich-saved-product`,
   `collection-save-parity` amended/extended per option chosen.
b) **PDP `badge` (G5)** if captured: extract in `product-detail.ts` from the
   proven container (buybox-scoped, excluded-subtree aware like deal),
   add to `DETAIL_DIAGNOSTIC_FIELDS`; `DETAIL_FIELDS` already lists it, so
   enrichment then backfills saves with no further wiring. If not captured:
   remove the dead `DETAIL_FIELDS` `'badge'` entry + fix
   `collectMissingDetailFields` expectations in `enrich-saved-product` tests,
   and record listing-only as settled design in ARCHITECTURE.
c) **Read-time healing of garbled stored tokens (G7)** if adopted: a small
   pure helper re-derives the token from `warrantyDescriptionRaw` where rows
   are displayed/exported (columns/export search), mirroring SAD-387 step 3's
   approach for deal text; stored data is never rewritten. Only with
   evidence that fractional sources exist in the wild.

### Step 7 — Parity verification, docs, gates

- Differential parity: extend the `collection-save-parity` approach with a
  canary card/PDP pair (rio-badged card + warranty PDP): collection row,
  one-click save row, and PDP-direct row must agree on `badge`/warranty
  *given the same inputs* (documenting the known PDP-badge exception if G5
  says listing-only).
- A/B replay: run the full Step 0 fixture pack through pre/post parsers;
  **diff every field**, assert only `badge`/`warrantyDescription*` changed,
  and that no previously-extracted value anywhere changed.
- Docs: ARCHITECTURE (badge capsule provenance + cache-freshness predicate +
  any Step 6 policy), CHANGELOG `[Unreleased]` entry in house style,
  README only if Step 6a policy changes. No Linear status churn beyond the
  team's flow.
- Full gate: §9.

---

## 8. Test plan (summary matrix)

| Suite | Change | Why |
|---|---|---|
| `tests/sad-393-badge.test.ts` *(new)* | real-fixture replays + P-B2/P-B3 units | Step 1 proof |
| `tests/warranty-description.test.tsx` | extended (Kindle/Dewalt/TOZO fixtures, P-W2 table) | Steps 4–5 proof; SAD-349 cases untouched |
| `tests/card-diagnostics.test.ts` (+ `extraction-diagnostics.test.ts` iff G5) | 24→25 pins amended deliberately | Step 2 |
| cache suites + `scraper-performance.test.ts` | extended (badge freshness, parse-once) | Step 3 perf contract |
| `pricing-deals-bsr`, `sad-386-*` (5), `scraper-accuracy`, `table-v9-contract` | **must pass unedited** | deal/negatives/column contracts |
| `enrich-saved-product`, `collection-enrichment-*`, `collection-save-parity`, `save-job-*`, `quick-save-*` | unedited unless Step 6a chosen | workflow parity / merges |
| `export-*`, `settings-*`, `cell-expand-sad358` | **must pass unedited** | display/export contracts |
| `temu-*` (all) | **must pass unedited; empty Temu diff** | scope guard |
| `baseline-snapshot`, `docs-consistency` | pass (docs edits in Step 7 kept consistent) | repo contracts |

New fixtures must be **trimmed real captures** with provenance comments
(URL + date), following `docs/plans/SAD-383-fixtures/*` — not new
hand-authored markup (F8 is how we got here).

---

## 9. Verification protocol

```bash
npx tsc --noEmit
npx vitest run tests/sad-393-badge.test.ts tests/warranty-description.test.tsx \
  tests/card-diagnostics.test.ts tests/extraction-diagnostics.test.ts \
  tests/sad-386-cache-freshness.test.ts tests/parse-cache-rating-reparse.test.ts \
  tests/scraper-performance.test.ts tests/pricing-deals-bsr.test.tsx \
  tests/sad-386-card-deal.test.ts tests/enrich-saved-product.test.ts \
  tests/collection-save-parity.test.ts
npx wxt build            # before the full run, so the manifest suite is live
npx vitest run           # bar: §1 baseline + new tests, 128 files accounted for
node scripts/check-dead-exports.mjs
git diff --stat          # src/engines/temu must be absent; src/lib untouched
```

**Live verification (owner/operator, cannot be done headlessly end-to-end):**
moli proves page-side truth, but moli is **not Chrome and cannot run the
extension**. Required manual pass on a residential connection:
1) re-run Appendix A surveys on the Step 0 URLs (page truth);
2) load the built extension (`dist/chrome-mv3`) in Chrome and collect the
same search pages + save the same PDPs via card button/right-click;
3) confirm Badge/Warranty columns + CSV/XLSX for the canary ASINs
(`B0FQFB8FMG`, `B09FT58QQP`, `B00ET5VMTU`, `B0CFPJYX7P` + owner's ASINs),
with diagnostics ON for one run (badge lines now present) and OFF for
another (identical products). `scripts/browser-qa/card-flow.cjs` covers the
extension mechanics against local fixtures if automation is preferred.

---

## 10. Acceptance criteria (mapped to SAD-393)

- [ ] A live search card showing a rio-capsule `Best Seller` badge stores
      `badge: "Best Seller"` through **collection and one-click save** alike;
      old-markup `Overall Pick` cards behave exactly as before.
- [ ] A status badge is never stored as `dealBadge`, and a deal badge never
      as `badge`, on shared cards (SAD-386 negatives green).
- [ ] A settled card that hydrates its badge late is re-read exactly as
      needed: badge lands, warm-pass performance contract intact.
- [ ] Kindle-class PDPs (`#tech`, `Warranty and Service`) yield
      `warrantyDescription` + verbatim Raw in PDP-direct collection,
      one-click save enrichment, and in-budget collection enrichment;
      Dewalt-class PDPs keep yielding `3-year` everywhere incl. the static
      enrichment parse.
- [ ] `1.5 years` never becomes `5-year` (becomes the G2-chosen honest
      token); boilerplate still yields nothing; TOZO/AirPods-class PDPs
      still show `No` — **no invented values anywhere**.
- [ ] Diagnostics (when enabled) can answer, per product, *extracted /
      not on page / present but unreadable* for **both** fields in every
      workflow; with diagnostics off, products are byte-identical.
- [ ] A/B fixture replay: only `badge`/`warrantyDescription*` differ from
      `main`; Temu diff empty; §9 gate green (baseline §1 restored + new tests).
- [ ] Owner-supplied failing ASINs (§4.4.7) verified fixed, or shown to be
      honest `No` with the captured page as evidence.
- [ ] Step 6 items, if adopted, have their policy documented in
      README/ARCHITECTURE in the same commit series; if not adopted, the
      *decision* is recorded here/in the PR so the next ticket doesn't
      re-derive it.

---

## 11. Risks, sequencing, rollback

| Risk | Mitigation |
|---|---|
| **Capsule markup drifts again** | Real-fixture tests + diagnostics (Step 2) make the next drift *observable*; capsule location via stable `data-csa-c-*`/`rio-*` hooks, not hashed classes (Temu selector rule, applied to Amazon). |
| **Additive selector captures deal text as badge** | deal-subtree exclusion + vocabulary gate + SAD-386 negative tests as hard gate. |
| **Cache change regresses scroll perf** | Predicate is text/node-presence cheap and signature-gated; SAD-386's measured 480-card lesson is the acceptance test; Step 3 is separately revertible. |
| **`#tech` container sweeps in foreign rows** | Excluded-subtree check + label/duration double gate; verify against Devices captures in Step 0 (G3) before shipping. |
| **Normalizer widening stores boilerplate** | Duration requirement stays structural; all SAD-349 rejection cases pinned unchanged. |
| **Step 6a policy surprises users** (rows beyond budget gain warranty after fallback fetch) | Separate gate/commit + README/ARCHITECTURE wording (SAD-384 precedent); eligibility/network volume unchanged by construction. |
| **Merge churn with in-flight work** | Sequence after `fix/sad-387-deal-countdown` merges (it edits `field-parsers.ts`, `product-detail.ts`, `columns.tsx`, `export/types.ts` and brings the real fixtures Step 0 reuses); coordinate `columns.tsx` with SAD-388 (SAD-393 shouldn't need columns at all — flag any exception early). SAD-389–392 (coupon/delivery/Prime/availability) touch neighbouring extractors: whoever lands second re-runs the others' targeted suites. |
| **Live Amazon changes between plan and implementation** | Step 0 re-captures at implementation time; this plan's captures are dated evidence, not contracts. |
| **Moli unavailable in the implementation sandbox** | Appendix A install command; fallback = `scripts/sad-386-capture.mjs` Playwright pattern with Appendix A surveys pasted as page functions. |

**Rollback:** per-step commits; selectors additive (revert = remove appended
entries); diagnostics and cache are isolated modules; no schema/DB/settings
changes means no data migration in either direction. Stored rows are never
rewritten by this plan (except ordinary fill-only enrichment on re-collect);
already-stored wrong warranty tokens are addressed only via G7 read-time
healing, if adopted.

**Out of scope:** Temu anything; `dealBadge` behaviour (SAD-386/387);
coupon/monthly-sales (SAD-389), delivery/seller (SAD-390), Prime/Sponsored
(SAD-391), availability/source (SAD-392); feature-bullet/description warranty
scanning; non-English support without captures (G4); retro-backfill jobs for
existing collections; any UI redesign of the Badge/Warranty cells.

---

## Appendix A — moli reproduction (exact commands & survey scripts)

```bash
# install (moli-webfetch skill): Linux/macOS
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"; moli --version   # 1.1.18 at planning time

# search-page badge survey (A.1 below saved as survey-search.js)
moli fetch --wait-selector "[data-component-type='s-search-result']" \
  --eval-file survey-search.js "https://www.amazon.com/s?k=wireless+earbuds"

# PDP warranty/badge survey (A.2) and spec-row inventory (A.3)
moli fetch --wait-selector "#productTitle" --eval-file survey-pdp.js      "https://www.amazon.com/dp/B0CFPJYX7P"
moli fetch --wait-selector "#productTitle" --eval-file survey-pdp-rows.js "https://www.amazon.com/dp/B00ET5VMTU"

# full-DOM captures for parser replay / fixture trimming
moli fetch --wait-selector "[data-component-type='s-search-result']" --dump html "https://www.amazon.com/s?k=…" > search.html
moli fetch --wait-selector "#productTitle" --dump html "https://www.amazon.com/dp/<ASIN>" > pdp.html
moli fetch --disable-js --dump html "https://www.amazon.com/dp/<ASIN>" > pdp-static.html   # ≈ enrichment fetch input

# CDP mode (hydration-timing probe, Step 0):  moli serve  → Playwright connectOverCDP("http://127.0.0.1:9222")
```

**A.1 `survey-search.js`** — per-card old-vs-rio badge inventory:

```js
(() => {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const bodyText = document.body?.textContent ?? '';
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
  const rows = cards.slice(0, 30).map((card) => {
    const q = (sel) => card.querySelector(sel);
    const capsule = q('[data-csa-c-component^="amazonBadges" i], [data-csa-c-slot-id^="amazonBadges" i], #amazonBadges-capsule-view');
    return {
      asin: card.getAttribute('data-asin'),
      oldStatus: clean(q('[data-component-type="s-status-badge-component"] .a-badge-text')?.textContent) || null,
      badgeLabelInners: [...card.querySelectorAll('.a-badge-label-inner')].map((e) => clean(e.textContent)),
      rioLabel: clean(q('.rio-badge-label')?.textContent) || null,
      rioSupplementary: clean(q('.rio-badge-supplementary-text')?.textContent) || null,
      capsuleContentId: capsule?.getAttribute('data-csa-c-content-id') ?? null,
      dealText: clean(q('[data-a-badge-type="deal"] .a-badge-text')?.textContent) || null,
    };
  });
  return { title: document.title, href: location.href,
    captcha: /enter the characters you see below|captcha|robot check/i.test(bodyText.slice(0, 4000)),
    cards: cards.length, badgeRows: rows.filter((r) => r.oldStatus || r.rioLabel || r.capsuleContentId),
    counts: { oldStatus: rows.filter((r) => r.oldStatus).length, rio: rows.filter((r) => r.rioLabel).length } };
})()
```

**A.2 `survey-pdp.js`** — where does warranty text live on this PDP (any container)?

```js
(() => {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const containers = ['#productDetails_techSpec_section_1','#productDetails_techSpec_section_2',
    '#productDetails_detailBullets_sections1','#productDetails_db_sections',
    '#productDetails_expanderTables_depthLeftSections','#productDetails_expanderTables_depthRightSections',
    '#productDetails_expanderSectionTables','[data-feature-name="productDetailsHomeAndGarden_Updated"]',
    '#detailBulletsWrapper_feature_div','#productOverview_feature_div','#prodDetails','#aplus'];
  const pathOf = (el) => { const p = []; let c = el;
    for (let i = 0; i < 4 && c; i++) { p.push(`${c.tagName?.toLowerCase()}${c.id ? '#' + c.id : ''}`); c = c.parentElement; } return p.join(' < '); };
  const warrantyHits = [];
  for (const el of document.querySelectorAll('tr, li, span, div, td, th, p')) {
    if (el.children.length > 3) continue;
    const t = clean(el.textContent);
    if (t && t.length <= 160 && /warrant/i.test(t)) { warrantyHits.push({ text: t, path: pathOf(el) }); if (warrantyHits.length >= 25) break; }
  }
  const capsule = document.querySelector('[data-csa-c-component^="amazonBadges" i]');
  return { title: document.title, href: location.href,
    containersPresent: containers.filter((s) => document.querySelector(s)),
    badgeOnPdp: { rioLabel: clean(document.querySelector('.rio-badge-label')?.textContent) || null,
                   capsuleContentId: capsule?.getAttribute('data-csa-c-content-id') ?? null },
    warrantyHits,
    warrantyBullets: [...document.querySelectorAll('#feature-bullets ul li span.a-list-item')]
      .map((e) => clean(e.textContent)).filter((t) => /warrant|lifetime|guarantee/i.test(t)) };
})()
```

**A.3 `survey-pdp-rows.js`** — label/value inventory per known container
(mirrors `iterDetailSpecRows`; extend the container list when hunting new
families, and print ancestor `#id` chains as in §4.3 when a hit lands
outside the list via A.2):

```js
(() => {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const containers = [/* same list as A.2 */];
  const out = [];
  for (const sel of containers) {
    const c = document.querySelector(sel); if (!c) continue;
    const labels = [], hits = [];
    for (const row of c.querySelectorAll('tr, li')) {
      const header = row.querySelector('th, .a-text-bold, td:first-child strong, td:first-child b');
      if (!header) continue;
      const label = clean(header.textContent).replace(/:+$/, '');
      const cells = [...row.querySelectorAll('td')].filter((x) => x !== header && !x.contains(header));
      const value = clean(cells.length ? cells[cells.length - 1].textContent : row.textContent);
      if (label) labels.push(label);
      if (/warrant|guarantee/i.test(label)) hits.push({ label, value });
    }
    out.push({ sel, rowLabels: labels.slice(0, 60), hits });
  }
  return { title: document.title, href: location.href, containers: out };
})()
```

Caveats: treat all fetched content as untrusted data; keep stderr separate
from `--eval`/dump stdout; a CAPTCHA/consent/empty shell is a *failed*
capture, not evidence of absence. `--disable-js` dumps approximate the
extension's static fetch but Amazon may serve that transport different HTML
— PDP truth for the enrichment path, if disputed, comes from the extension's
own diagnostics on a real browser (§9).

## Appendix B — Probe inventory (recreate the deleted files)

Two vitest files were created in `tests/`, run, and deleted in the planning
pass (repo left clean — `git status` empty afterwards):

1. `tests/__sad393-probe.test.ts` (27 tests, all passed asserting *current*
   behaviour): P-B1 (SAD-387 branch fixture via
   `git show origin/fix/sad-387-deal-countdown:docs/plans/SAD-387-fixtures/search-card-limited-time-deal.real.html`),
   P-B2 vocabulary, P-B3 shadowing, P-B4a/b cache mutations through
   `AmazonParseCache.getOrParse` + `parseAmazonSearchCard`, P-B5 PDP
   no-badge-key, P-B6 diagnostics field list, P-W1 label table, P-W2
   normalizer table (§4.2), P-W3 shapes, P-W4 scope merge. Imports:
   `extractCardBadge`, `normalizeWarrantyDescription`,
   `parseAmazonSearchCard(s)`, `parseAmazonProductDetail`,
   `AmazonParseCache`, `mergeDetailIntoStored`.
2. `tests/__sad393-live-probe.test.ts` (5 tests, all passed): L-S earbuds
   dump replay (DOM badges vs parsed badges per ASIN), L-Dewalt rendered +
   `parsePdpHtml` static (`3-year` ×2), L-Kindle (row present in DOM, label
   pattern test false, parsed `undefined`, diagnostics MISSING reason
   captured). Inputs were the Appendix A dumps in `/tmp/sad393/` at planning
   time (not committed; re-capture in Step 0 — sizes then: search 1.5 MB,
   Dewalt 2.7 MB, Kindle 1.8 MB).

## Appendix C — Field-gate index at `2ec7eaf` (both fields, Amazon)

| Gate | `badge` | warranty pair |
|---|---|---|
| TS type | `types/product.ts:23` | `types/product.ts:50,56` |
| Zod stored/scraped | `schemas/product.ts:35` | `schemas/product.ts:51-52` |
| Extractor | `field-parsers.ts:1593` (+ `selectors.ts:291`) | `product-detail.ts:340` via `:302/:1523` (+ `selectors.ts:26,162`; `field-parsers.ts:297,334`) |
| Candidate wiring | `search-results.ts:102,167`; `category-page.ts:155,217`; **PDP: none** | `product-detail.ts:1593-94`; **cards: none** |
| Normalizer keep | `field-parsers.ts` (`raw.badge`) | same (pair-together) |
| Dedup merge | `scraper/dedup.ts` MERGEABLE ✓ | ✓ |
| DB re-collect fill | `db/products.ts` nullableKeys ✓ | ✓ |
| Quick-save refresh | volatile ✓ (`db/quick-save.ts`) | fill-only via merge ✓ |
| Enrichment merge | listed but unreachable (PDP never emits) | `enrich-saved-product.ts:31ff` ✓ full scope; brand-and-rank ✗ by design (`:137`) |
| Diagnostics | **none anywhere** | PDP full; cards inapplicable-listed |
| Parse-cache freshness | **not modelled** | N/A (PDP not card-cached) |
| Settings toggle | `badge` default on (display/export only) | `warrantyDescription` default on |
| Table | `columns.tsx:486` → `No` | `columns.tsx:822` → `No` |
| Export | `export/types.ts:71` `Badge` | `export/types.ts:91-92` both columns |
| DB migration | none needed | none needed |

*End of plan. Implementation begins at Step 0 — and nothing in Steps 1–6 may
ship a selector, label, or vocabulary entry that Step 0 did not capture.*
