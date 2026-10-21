# SAD-391 — Plan Only: `isPrime` and `isSponsored` extraction, root cause and fix plan

| | |
|---|---|
| Linear | **SAD-391** "The Prime and Sponsored fields" — team SAD · project PPHunt · label Bug · priority 1-Urgent · state Todo · assignee MakeTheNewHistory · no comments/attachments |
| Repo | `MakeTheNewHistory/PPHunt` · `main` @ `2ec7eaf` (2026-10-21, "Merge branch 'feat/temu-engine' — SAD-380/381") |
| Mode | Written as **plan only** (no source file modified at that time; probes run from scratch files moved out of the repo, §13.1). **Status 2026-10-21: implemented** on branch `fix/sad-391-prime-sponsored` in steps 0–6 — see `docs/plans/SAD-391-implementation-record.md` for the per-step commits, the measured before/after on the live capture, the stated deviations (plan §4.4 not done; Phase 0 waived by D5) and the manual matrix that still needs a live browser session. |
| Reference tool | `lexmount/moli` v1.1.18 (headless browser CLI) — used to reproduce the live Amazon DOM the extension actually sees (§2.2). |
| Date | 2026-10-21 |

---

## 0. Decisions taken (operator, 2026-10-21)

Asked through the interactive question tool before this plan was written; these are binding for every step below.

| # | Question | Decision |
|---|---|---|
| D1 | What should **Prime = Yes** mean? | **Badge OR explicit Prime-eligibility text.** `true` when the Prime badge is present, *or* when Amazon prints a Prime-specific delivery message ("Join Prime to get FREE delivery …", "Or Non-members get FREE delivery …"). The generic **"FREE delivery" heuristic is dropped** (it is provably wrong in both directions, §5 F1). |
| D2 | What is observed in the field? | **Not sure / reported by someone else.** → The plan cannot weight fixes by a user-observed symptom; it fixes every defect that the code and the live DOM prove, and adds the diagnostics needed to *see* these two fields in future runs (Phase 5). |
| D3 | Is the browser signed in to a Prime account during runs? | **Usually logged out / varies.** → The Prime *badge* will usually **not** be in the DOM (§5 F3); the Prime-eligibility *ingress* text is the signal that actually appears for this operator (7/16 live cards, §5 F4). Both must be read. |
| D4 | Scope beyond the two detectors | **Everything:** detectors + the quick-save re-save wipe + the delivery-text bugs that feed `isPrime` + PDP `isSponsored` from the URL + `isSponsored` in the SAD-359 diagnostics. |

### 0.0 Implementation-round decisions (operator, 2026-10-21, before the branch was cut)

| # | Question | Decision |
|---|---|---|
| D5 | Phase 0 operator captures | **Proceed with the existing evidence** (real 2025 UDM badge sample + legacy badge + the live non-member ingress text; PDP uses the same English ingress regex). A signed-in capture can be added later as an extra fixture. |
| D6 | Re-save of a sponsored product from an organic card | **Sticky:** once `isSponsored` is `true` a later save never flips it to `false` (same OR rule as `isPrime`); placements still record the later `Organic Search`. |
| D7 | Diagnostics | **Add `isSponsored` as a counted field (24 → 25)**, update the pinned counts and docs wording in the same commit. |
| D8 | Same-page duplicate (sponsored ad card + organic card, same ASIN) | **Implement now:** append `Sponsored Search` to the kept row's placements without re-parsing; `isSponsored` of the first card unchanged. |

Branch: `fix/sad-391-prime-sponsored` (from `main` @ `2ec7eaf`). Commit style: `SAD-391 step N: …`.

### 0.1 Sub-decisions this plan needs confirmed before the matching step (defaults stated; not guessed, flagged)

| # | Open point | Default used in this plan | Where it bites |
|---|---|---|---|
| O1 | A product that appears **both** as an in-grid Sponsored Products card **and** as an organic card (same ASIN, same page). Today: first card wins; the second is skipped without even recording a placement (§5 F10). | Keep `isSponsored` of the first-seen card, but **record the second placement** (`placements: ['Organic Search','Sponsored Search']`) so the Sponsored filter/badge still finds it — consistent with how widget duplicates are already modelled (`tests/product-categorization.test.tsx:192-232`). | Phase 3 step 3.4 |
| O2 | Should the **diagnostics field count** change from 24 to 25 when `isSponsored` is added (Temu already models it, `src/engines/temu/scraper/…:29`)? 12 test assertions pin `24`. | Yes — bump to 25 and update the pinned counts in one commit (Phase 5). Alternative: log it as a non-counted context line (no count change). | Phase 5 |
| O3 | `tests/baseline-snapshot.test.ts:103` pins `isPrime: true` for a card whose *only* Prime evidence is "FREE delivery Tomorrow, Oct 17". Under D1 it becomes `false`. | Update the snapshot deliberately (this is the decided behaviour change, not a regression) and say so in the commit message. | Phase 2, §9.2 |

---

## 1. Task restated, and what is explicitly out of scope

**In scope**

1. Find out why `isPrime` and `isSponsored` do not return what the page shows, on every path the extension extracts from: search-result cards, category/bestseller/deals cards, the product page (PDP) saved from the tab, and the cookieless PDP fetched by background enrichment.
2. Make both fields **reliable** under D1–D4: no false `Yes` from unrelated text, no `No` for a product that carries a Prime marker/ingress or a Sponsored marker, and no *later* loss of a correctly-extracted value (re-save, dedup, enrichment).
3. Make them **observable**: both fields reported in the per-field diagnostics so the next regression is measurable instead of anecdotal.
4. Prove nothing else moved: tsc, the full vitest suite, `wxt build`, and the workflow matrix in §8 Phase 6.

**Out of scope (named so they are not done by accident)**

- Any change to the Temu engine (`src/engines/temu/**`) — it has its own detectors and diagnostics.
- UI/column/export rendering of the two fields (`columns.tsx:628-664`, `export/types.ts:76-77`) — verified to render whatever the row holds (§6 H5); they are consumers, not causes.
- The cosmetic duplicated widget heading in `sectionLabel` ("Premium Laptops Built to PerformPremium Laptops Built to Perform", §5 F12) — recorded, separate ticket.
- Making background enrichment send cookies to see the Prime badge — a privacy/behaviour change far outside a bug fix; the plan handles its absence instead (F6).

---

## 2. Evidence discipline

Every claim carries one of these tags. Anything without a tag is a design choice, labelled as such.

| Tag | Meaning | Where it lives |
|---|---|---|
| **[CODE]** | Read from the source at `2ec7eaf`; `file:line` given. | `/home/user/PPHunt` |
| **[LIVE]** | Measured on the real Amazon search DOM captured with moli in this sandbox: `https://www.amazon.com/s?k=laptop`, 2026-10-21, **logged out**, 1.79 MB, 16 primary cards + 11 widgets. | `/home/user/sad391-evidence/search-laptop.html` (+ raw `moli-search2.json`) |
| **[FIXTURE]** | Real Amazon markup saved from public repositories (dates stated), used only where the sandbox session could not obtain the markup. | `/home/user/sad391-evidence/crawl4ai-amazon-product.html` (2025-06 US Sponsored Products card, ASIN B081XSYZMS); the UDM Prime-badge sample quoted in F3 (rigwild/mcp-server-amazon, 2025-06) |
| **[PROBE Pnn]** | A vitest/jsdom script run against the **production parsers** of this repo; code in §13.1. | `/home/user/sad391-evidence/scratch/` |
| **[LOG]** | The operator's own measurements already committed in `docs/plans/` (SAD-359/370/379). | `docs/plans/SAD-370-…`, `SAD-379-…`, `sad-359-measurement-2026-10-20.json` |
| **[EXT]** | Independent implementations of the same detection (reference extensions/scrapers), used to cross-check semantics, never as the sole basis. | `/home/user/sad391-evidence/amazon_filter_popup.js`, `knockoff-styles.css`, grep.app hits listed in §13.4 |
| **[BASE]** | Baseline commands run in this sandbox. | `/home/user/sad391-evidence/baseline.log` |

### 2.1 What the moli reproduction established

- A plain `curl` of `/s?k=laptop` returns **503**; moli's first load returns the AWS WAF challenge (202). With a persistent profile (`-P`), `--delay-ms ≥ 12000`, one `--eval` click on the "Continue shopping" interstitial, and then a **real search-form submit from the homepage** (`form#nav-search-bar-form`), moli delivers the genuine search page **[LIVE]**. Recipe: `moli fetch -P <profile> -A "<desktop Chrome UA>" --dump json --wait load --delay-ms 6000 -t 120000 --eval-file nav-search.js https://www.amazon.com/` (file in `sad391-evidence/nav-search.js`).
- After that one success the sandbox IP was rate-limited: every later search navigation (form submit, direct URL with Referer, even `service-worker.js`) returned 503. **A second capture (and any signed-in capture) must be made by the operator — Phase 0 gives the exact commands, including `moli import --chrome-profile-dir` to reuse a signed-in Chrome session.**
- The session was a **non-member** (`nav_cs_primelink_nonmember` in the nav) — exactly D3's situation — so the capture shows what the operator's extension sees: **zero** `i.a-icon-prime`, **zero** `[aria-label*="Prime"]` inside cards, every `.udm-badge-block` empty, and the Prime *ingress* text on 7/16 cards.
- The logged-out session was served **no in-grid Sponsored Products cards** (only Sponsored Brand/Video widgets and two `aspa-asin-ajax-lazy-loader` placeholders). In-grid SP markup is therefore evidenced by the 2025 **[FIXTURE]** and cross-checked against four independent detectors **[EXT]**.

---

## 3. Baseline measured in this sandbox **[BASE]**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `npx vitest run` | **128 test files passed, 1 skipped; 1416 tests passed, 3 skipped** — *one* of those files/tests was this plan's probe, so the repo's own baseline is **127 + 1 skipped files / 1415 + 3 skipped tests** (re-run after Phase 0 to pin the exact number; the probe is no longer in `tests/`). Duration 160 s. |
| `npx wxt build` | OK, 2.03 MB total |
| `git status` | clean |

---

## 4. Code map — the exact paths involved

### 4.1 Where the two booleans are produced

| Surface | Producer | File:line **[CODE]** |
|---|---|---|
| Search card | `extractCardIsPrime(card, delivery)` / `extractCardIsSponsored(card)` | `src/engines/amazon/scraper/search-results.ts:102-104`; functions in `field-parsers.ts:1685-1701` and `:1703-1782` |
| Category / bestsellers / deals card | same two functions | `category-page.ts:156-159` |
| Save-from-card context (`listingCategory`, used for the saved snapshot's placement) | a **separate** selector string `SPONSORED_HINT_SELECTOR` | `content/save-product.ts:33-34, 72-74` |
| Product page (tab save **and** background enrichment) | inline `isPrime` expression; `isSponsored: false` literal | `product-detail.ts:1529-1541`, `:1565` |
| Selector registry (v2.0.0) | `cardFields.prime` (4 entries), `cardFields.sponsored` (4 entries), `cardFields.delivery` | `selectors.ts:338-343`, `:344-349`, `:350-353`; PDP delivery `:197-201` |
| Delivery/availability text that `isPrime` depends on | `extractCardDeliveryAndAvailability` | `field-parsers.ts:1609-1658` |

### 4.2 Where they can be changed afterwards (merge/persist)

| Stage | Behaviour today **[CODE]** | File:line |
|---|---|---|
| Same-page dedup (search parse) | primary+primary duplicate → `continue` (no parse, no placement); widget duplicate → `mergeScrapedProductFields(existing, parsed, {preferSource: isPrimary && !existing.isPrimary})` | `search-results.ts:389-416` |
| Cross-batch dedup (collection run) | `mergeAndFilterNew` → `mergeScrapedProductFields(target, source)` (no preferSource) | `dedup.ts:233-285` |
| `mergeScrapedProductFields` | `isPrime`: OR (`:101-104`); `placements`: union (`:106-123`); `listingCategory`: recomputed from source when `preferSource` (`:125-137`); `isSponsored`: **assigned from source whenever `preferSource` and the values differ — `undefined` counts as a value** (`:144-147`) | `dedup.ts:45-150` |
| One-click save upsert (second save of the same ASIN into the same collection) | fill pass, then a "volatile" pass with `preferSource: true` whose source object (`pickVolatile`) **has no `isSponsored`/`listingCategory`/`placements` keys** | `db/quick-save.ts:22-35, 69-87, 160-171` |
| Collection-run writes | `addProducts` enrich: `isPrime` OR only; never touches `isSponsored` | `db/products.ts:63-66` |
| Background PDP enrichment | whitelist patch + `isPrime` OR; `isSponsored` never patched; fetch is `credentials: 'omit'` | `background/enrich-saved-product.ts:154-186`; `background/enrichment-fetch.ts:289` |
| Parse cache | a card is frozen once `asin/title/price/imageUrl` exist; re-parsed only on signature change *and* (rating missing or price-family evidence) | `scraper/parse-cache.ts:70-140` |
| Mutation re-scrape | any added node under `.s-main-slot` → debounced re-scrape (300 ms / 2 s max) | `entrypoints/amazon.content.ts:323-361` |

### 4.3 Read-only consumers (verified untouched by this plan)

Schema defaults `false` (`schemas/product.ts:38-39`); types optional booleans (`types/product.ts:26-27`); settings toggles default `true` (`schemas/settings.ts:40-41`, `constants/defaults.ts:90-91`); table cells `Prime`/`Yes`/`No` (`ui/table/columns.tsx:628-664`, column gating `:951-952`); export `Yes`/`No` (`export/types.ts:76-77, 143-144, 238-239`); sort keys (`src/lib/sorting/product-sorter.ts:29-30, 45-46`); category filter (`utils/listing-category.ts:16-28, 52-76, 93+`); diagnostics field list (`scraper/extraction-diagnostics.ts:93-118`, `isPrime` exclusion `:243-263`; `card-diagnostics.ts:53, 247-253`).

---

## 5. Findings — root causes, each with its evidence

### F1 — `isPrime` is, in practice, "the card mentions FREE delivery". **[CODE] [LIVE] [FIXTURE] [PROBE P01, P02]** *Confidence: certain.*

`field-parsers.ts:1697-1699`: `if (deliveryText && /\bFREE delivery\b/i.test(deliveryText)) return true;` — and the selector branch above it almost never fires for this operator (F3). Measured:

- **[LIVE]** 16 primary cards, 0 badges: the production parser returns `isPrime: true` for **11/16**, all via this regex (P01). Among them `B0H3KHVZS2` "FREE delivery Oct 28 - 29 / Or fastest delivery Tue, Oct 27" and `B0GR6KJ72L` "FREE delivery Oct 28 - Nov 4" — the slow-window + paid-fastest pattern of merchant-fulfilled offers, not Prime.
- **[FIXTURE] [PROBE P02]** the real 2025 Sponsored card prints *"FREE delivery Thu, Jun 19 **to Malaysia** on $49 of eligible items"* → production parser: `isPrime: true`. Free international shipping over a basket threshold is unrelated to Prime.
- **[EXT]** both reference implementations treat free-delivery text as **not** Prime (`amazon_filter_popup.js` ≈ L469-476 reads `.udm-primary-delivery-message` only to classify "free delivery, non-Prime"; four scrapers on grep.app use the badge only).
- The same proxy is used on the PDP (`product-detail.ts:1533-1535`): `#mir-layout-DELIVERY_BLOCK [data-csa-c-delivery-price="FREE"]` is the *shipping price* attribute ("FREE" or a number — Discount-Bandit, fairgame **[EXT]**), plus the same `/\bFREE delivery\b/` regex on `delivery`. The operator's SAD-359 harness reported `isPrime: EXTRACTED (derived)` on **19/19** measured PDPs (`sad-359-measurement-2026-10-20.json`) **[LOG]** — consistent with the proxy firing on every page that prints "FREE delivery"; the report cannot say whether a badge was present because derived fields carry no selector (fixed by Phase 5.4).

### F2 — The wildcard `[aria-label*="Prime" i]` matches the product **title**. **[LIVE] [PROBE P03]** *Confidence: certain (mechanism); frequency query-dependent.*

`extractCardIsPrime` appends `'[aria-label*="Prime" i]'` to the registry list (`field-parsers.ts:1689-1692`). **[LIVE]** 16/16 cards carry `h2[aria-label="<full product title>"]` and most carry `span.title-differentiators[aria-label="…"]`. Any title containing "prime" as a substring — *Primer*, *Primera*, "Prime Video", "Optimus Prime" — flips the card to `Yes`. **P03**: a synthetic card built from the live structure, title "Rust-Oleum 2X Ultra Cover **Primer** Spray", delivery "$6.99 delivery Oct 28 - 30", no badge → production `extractCardIsPrime` = **true**. The sponsored side has the same shape (`span[aria-label*="Sponsored" i]`, `selectors.ts:347`; `[aria-label*="Sponsored" i]` in `save-product.ts:34`) but the title must contain "sponsored", which is rare; it is tightened in the same step for consistency.

### F3 — The real Prime badge is only rendered for signed-in Prime members, and one registry entry can never match it. **[LIVE] [FIXTURE] [EXT]** *Confidence: high.*

- Current card markup (UDM, 2025) **[FIXTURE]**: `<div class="a-row a-color-base udm-badge-block"><i class="a-icon-wrapper a-icon-prime-with-text …"><i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i><span class="a-icon-text">One-Day</span></i></div>`; legacy/p13n markup **[EXT]**: `<i class="a-icon a-icon-prime a-icon-small" aria-label="Prime"><span class="a-icon-alt">Prime</span></i>`.
- **[LIVE]** every one of the 16 cards has the slot — `[data-cy="delivery-recipe"] … .udm-delivery-block > .udm-badge-block` — and in this non-member session it is the empty `<div class="a-column a-span12"></div>` on 16/16. Amazon renders the badge per viewer; the operator "usually logged out" (D3) will not get it, and the cookieless enrichment fetch never will (F6).
- Registry **[CODE]** `selectors.ts:339-342`: `i.a-icon-prime` ✔ matches both shapes; `[aria-label="Amazon Prime" i]` ✘ never matches (the attribute is `"Prime"`); `[data-testid*="prime-badge"]` — no evidence on any Amazon surface examined; `#bbop-sbbop-container` is a PDP buy-box id in a *card* list. The reference extension additionally accepts `img[alt*="Prime" i]` **[EXT]**; no card-level evidence for an `<img>` badge was found, and `*=` on `alt` would re-introduce F2 (the live nav has `<img alt="TNF on Prime">`), so if added it must be exact-match and card-scoped.

### F4 — The Prime-eligibility ingress that non-members *do* get is not modelled. **[LIVE]** *Confidence: certain for US desktop; other locales = Phase 0.*

Per card `.udm-primary-delivery-message` is one of:

| Pattern (live text, `<style>/<script>` stripped) | Cards | Meaning |
|---|---|---|
| `Join Prime to get FREE delivery <date>` (+ secondary `Or Non-members get FREE delivery <later date>`) | 7/16 — B0HK88DFX6, B0HGFTXXXM, B0HJCRV1J6, B0GBX8HRTC, B0GQ9R7MRZ, B0GQB2F5NF, B0CK9JSM3G | Prime-eligible offer shown to a non-member (`a.udm-sfx-prime-signup-trigger` > `span.prime-brand-color` "Join Prime"; ingressId `pdm_prime_upsell`) |
| `FREE delivery <date>` (+ optional `Or fastest delivery …`) | 9/16 | No Prime statement at all |

D1 makes the first row a `Yes` signal. Today it is `Yes` only *by accident* — the regex matches the "FREE delivery" inside the sentence — and only when F5 has not already discarded the text (B0GQB2F5NF is Prime-eligible and comes out **`false`**).

### F5 — The delivery recipe loses or pollutes the text that `isPrime` is derived from. **[CODE] [LIVE] [PROBE P01]** *Confidence: certain.*

`extractCardDeliveryAndAvailability` (`field-parsers.ts:1616-1639`):

1. takes the **first** `[aria-label]` in the delivery recipe (`:1624`). **[LIVE]** when a stock warning exists it is `span[aria-label="Only 7 left in stock - order soon."]`, which fails `/delivery/`; the text fallback is then skipped because `availability` is already set (`:1630`) → `delivery = undefined` → `isPrime = false`. 4/16 live cards (B0GQB2F5NF, B0H3KHVZS2, B0GPW3BJ6V, B0HHMVMLKZ).
2. otherwise uses `deliveryBlock.textContent` (`:1631`), which **[LIVE]** includes the inline `<style>` and `<script>` of the Join-Prime ingress → 6/16 rows store `delivery = ".prime-brand-color {color: #0064f9; }Join Prime(function(f){…"` (visible in the Delivery column and the export).

### F6 — On the product page the Prime signal is a shipping-price proxy, and enrichment can never see a badge. **[CODE] [LOG] [EXT]** *Confidence: high.*

`enrichment-fetch.ts:289` fetches the PDP with `credentials: 'omit'` → Amazon renders the non-member page → no badge, only the FREE-shipping proxy (F1). The operator's own numbers match: `isPrime` MISSING **154/154** `/deals` cards and **56/70** PDPs (SAD-370 §F9, `docs/plans/SAD-370-extraction-gap-closure-plan.md:339-343`), MISSING **80/80** card saves, gained by enrichment on **14/80** (`SAD-379-…parity-plan.md:136-182`) — and those 14 are FREE-shipping matches, not Prime. SAD-370 explicitly deferred this ("out of scope unless Phase 0 shows a Prime marker"); SAD-391 is that ticket. The PDP must read the same two signals as the card: badge (`i.a-icon-prime` inside the buy-box/delivery block) **or** Prime ingress text in `#mir-layout-DELIVERY_BLOCK*` / `#deliveryBlockMessage`; the exact non-member PDP ingress wording is **unverified here → Phase 0 item**.

### F7 — A second one-click save of the same product **erases `isSponsored`** and relabels it organic. **[CODE] [PROBE P04]** *Confidence: certain.*

`upsertProductFromQuickSave` (`db/quick-save.ts:165-171`) runs `mergeScrapedProductFields(merged, pickVolatile(incoming), { preferSource: true })`. `pickVolatile` (`:69-87`) returns `{asin,url,source}` + the 12 volatile fields — **no `isSponsored`, no `listingCategory`, no `placements`**. In `mergeScrapedProductFields`: `:144-147` `if (preferSource && target.isSponsored !== source.isSponsored) target.isSponsored = source.isSponsored;` → `undefined`; `:125-131` `nextCategory = source.listingCategory ?? resolveListingCategory(source)` → `'organic'`; `:106-123` adds the source's placement `'Organic Search'`. **P04** (real Dexie layer, `fake-indexeddb` as in `tests/quick-save-data-layer.test.ts`): save #1 `{isSponsored:true, listingCategory:'sponsored'}` → row correct; save #2 of the **same** sponsored payload → `updatedFields = ["collectedAt","isSponsored","listingCategory","placements"]`, row = `{isSponsored: <absent>, listingCategory:'organic', placements:['Organic Search','Sponsored Search']}`. The default `quickSaveCollectionBehavior` is `'current'` (`constants/defaults.ts:115-116`), i.e. the collection pointer is reused (`background/collections.ts:99-116`), so any repeated save of an ASIN in a browsing session takes this path. Table/export then show **No**.

### F8 — The PDP hard-codes `isSponsored: false` although the URL carries the ad evidence. **[CODE] [LIVE] [FIXTURE]** *Confidence: certain (URL shape); design choice to use it.*

`product-detail.ts:1565`. Every Sponsored destination URL in both captures carries `sp_csd=<…>` **and** a `ref=…_sspa` code (`ref=sr_1_1_sspa`, `ref=sxin_15_pa_sp_search_thematic_sspa`, `ref=sxbs_pa_sp_search_thematic_btf_sspa`); organic links carry `ref=sr_1_N` and never `sp_csd` (36 + 4 anchors inspected). A tab save on a PDP opened from an ad therefore *can* be classified; the enrichment fetch uses the canonical `/dp/<ASIN>` URL and stays `false` (never downgrades a card's `true` — `enrich-saved-product.ts` whitelist).

### F9 — Nothing reports `isSponsored`, and the save path has a divergent detector. **[CODE]** *Confidence: certain.*

`DETAIL_DIAGNOSTIC_FIELDS` (`extraction-diagnostics.ts:93-118`) and `recordCardDiagnostics` (`card-diagnostics.ts:247-253`) model `isPrime` as a derived boolean (D6) but not `isSponsored`; the Temu engine already models both (`tests/temu-extraction-diagnostics.test.ts:193-212`). `save-product.ts:33-34` keeps its own 3-selector `SPONSORED_HINT_SELECTOR` for the saved snapshot's `listingCategory`, so a card's `isSponsored` and its placement can disagree (e.g. `/sspa/click`-only cards: detector `true`, hint `organic`).

### F10 — Async Sponsored Products injection + "first primary card wins" drops the sponsored placement. **[CODE] [LIVE]** *Confidence: medium (mechanism certain, frequency unmeasured → Phase 0).*

**[LIVE]** the main slot holds two `span[data-component-type="aspa-asin-ajax-lazy-loader"]` placeholders: in-grid SP cards arrive by AJAX after the organic grid. The mutation watcher does re-scrape (`amazon.content.ts:335-361`), and a new element is never served from the parse cache, so detection itself is fine (§6 H3). But in `parseAmazonSearchResults` a primary card whose ASIN was already seen on a primary card is skipped outright (`search-results.ts:393-396`) — no `placements` entry, so a product that is organic *and* sponsored on the same page is invisible to the Sponsored filter/badge in the tab-parse path, while the cross-batch path does record it (`dedup.ts:106-123`). The two paths disagree.

### F11 — The Sponsored detector is sound on real 2025 markup; it only lacks a few extra markers and locale labels. **[FIXTURE] [EXT] [PROBE P02]** *Confidence: high.*

**P02** on the real SP card (wrapped in its `s-search-result` shell): `isSponsored: true` with and without the `AdHolder` class, via `.puis-sponsored-label-text` text "Sponsored" and `/sspa/click`. A "Featured from Amazon brands" tile that reuses `.puis-sponsored-label-text` with a different label (documented in `knockoff-styles.css` **[EXT]**) → `false` ✔ — the `empty-or-/sponsored/` guard (`field-parsers.ts:1740-1748`) holds and must be kept. Markers present on the fixture and used by other detectors that the registry does not list: `div[data-component-type="s-impression-counter"].s-featured-result-item`, `[data-ad-feedback-label-id]` (morphe-patches **[EXT]**), `data-a-popover` `sp-info-popover-<ASIN>`, and the localized inner `aria-label`s (`Gesponsert`, `Sponsorisé`, `Sponsorizzato`, `Patrocinado`, `Gesponsord`, `Sponsrad`, `Sponsorowane`, `Sponsorlu`, `スポンサー`) — the current leaf-text regex covers 5 of these 10.

### F12 — (cosmetic, out of scope) widget heading duplicated in `sectionLabel`. **[LIVE]**

3 Sponsored-Brand tiles report `sectionLabel: "Premium Laptops Built to PerformPremium Laptops Built to Perform"` (heading text read from two responsive copies). Not a Prime/Sponsored correctness issue; separate ticket.

---

## 6. Falsified hypotheses — what this bug is *not*

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | "The Prime selectors are stale; the modern badge is not matched." | **False.** `i.a-icon-prime` matches both the UDM and the legacy badge. The problem is that the badge is absent for this operator (F3) and that the fallbacks over-match (F1, F2). | [FIXTURE] [EXT] |
| H2 | "Sponsored detection fails on current in-grid ad cards." | **False** on the only real 2025 SP card available — `true` by two independent markers. | [PROBE P02] |
| H3 | "The parse cache / mutation debounce hides late-injected ad cards." | **False** for detection — injected cards are new Elements, never cached; the watcher re-scrapes on any `.s-main-slot` insertion. Only the duplicate-skip (F10) loses information. | [CODE] parse-cache.ts, amazon.content.ts:335-361 |
| H4 | "Values are dropped by validation/schema." | **False.** Both schema fields are `boolean().optional().default(false)`; booleans pass through `validateAndNormalize…` unchanged; `applyValidationResults` skips `isPrime` on purpose. | [CODE] |
| H5 | "The table/export shows the wrong thing." | **False.** Cells and CSV read the row boolean directly (`Boolean(info.getValue())`). | [CODE] columns.tsx:631, :650; export/types.ts:76-77 |
| H6 | "Dedup ORs away a correct `false`." | **Partly.** `isPrime` OR is by design and fine; the real loss is F7 (`undefined` written through `preferSource`) and F10 (placement never recorded). | [PROBE P04] |
| H7 | "Collection diagnostics would have shown it." | **False** — `isSponsored` is not a diagnostics field (F9), and `isPrime` is reported `EXTRACTED` whenever the *proxy* fires. | [CODE] [LOG] |

---

## 7. Design principles every step must obey

1. **Two signals, nothing else, on every surface.** `isPrime = badge ∨ primeIngress`. The generic FREE-delivery regex and the `data-csa-c-delivery-price="FREE"` proxy are removed from the Prime decision (D1). `delivery` text itself is still extracted and shown — it is a different field.
2. **Scoped selectors.** No `*=` match on `aria-label`/`alt` for either field. Prime: element-scoped (`i.a-icon-prime`, `.a-icon-prime-with-text`, `[aria-label="Prime" i]`, `[aria-label="Amazon Prime" i]`); Sponsored: label-scoped (inside `.puis-sponsored-label-text`, `.s-widget-sponsored-label-text`, `.sponsored-brand-label-info-desktop`) as the knockoff rule does.
3. **Never write "no information" as a value.** A merge source without a boolean leaves the target boolean alone; `listingCategory` is recomputed only from a source that carries sponsorship information.
4. **Never downgrade.** PDP/enrichment never sets `isSponsored: false` over a card's `true`; `isPrime` OR stays.
5. **Additive registry.** New selectors are appended; the version string is bumped (`AMAZON_SELECTOR_REGISTRY_VERSION`, `selectors.ts:10`) so drift telemetry can tell the two generations apart.
6. **One detector per field.** `save-product.ts` stops owning its own sponsored selector and calls `extractCardIsSponsored`.
7. **Diagnostics lane is separate.** Phase 5 must leave product rows byte-identical (it only adds report entries) and is its own commit.
8. **Tests pin behaviour, including the decided change.** The one snapshot that encodes the old semantics (O3) is changed in the same commit as the semantics, with the reason in the message.
9. **No Temu changes; no UI changes.**

---

## 8. Implementation plan

Phases are ordered so each is independently shippable and reviewable; Phases 1–4 carry the bug fix, Phase 5 the observability, Phase 6 the proof.

### Phase 0 — Live evidence capture (operator-run, **no source changes**; blocks only the parts marked ⛔)

Why: the sandbox could obtain one logged-out search page and no PDP; the two markups still unverified are (a) the Prime badge/ingress on a **signed-in Prime** search page and (b) the **PDP** delivery block for a non-member and for a member. Everything not marked ⛔ is fully evidenced and can start immediately.

Commands (run on the operator's machine with moli ≥ 1.1.18; Chrome closed for the import):

```bash
# 0.1 reuse the real browser session (brings cookies → signed-in / Prime view)
moli import -P ~/.moli-pphunt --chrome-profile-dir "$HOME/.config/google-chrome/Default" --includes cookies
# 0.2 search page, member view (repeat with a second query; keep the raw json)
moli fetch -P ~/.moli-pphunt -A "<your desktop UA>" --dump json --wait load --delay-ms 6000 -t 120000 \
  --eval-file nav-search.js https://www.amazon.com/ > search-member-laptop.json
# 0.3 the same two queries from a fresh, logged-out profile
moli fetch -P ~/.moli-anon -A "<your desktop UA>" --dump json --wait load --delay-ms 12000 -t 120000 \
  --eval-file nav-search.js https://www.amazon.com/ > search-anon-laptop.json
# 0.4 one PDP in each state (pick an ASIN that showed the badge in 0.2)
moli fetch -P ~/.moli-pphunt --dump json --wait load --delay-ms 6000 https://www.amazon.com/dp/<ASIN> > pdp-member.json
moli fetch -P ~/.moli-anon   --dump json --wait load --delay-ms 12000 https://www.amazon.com/dp/<ASIN> > pdp-anon.json
```
(`nav-search.js` = `sad391-evidence/nav-search.js`; if the WAF interstitial appears, run the file once more — it clicks "Continue shopping" and resubmits. If moli is unavailable, DevTools → right-click `<div class="s-main-slot">` → *Copy outerHTML* is equivalent.)

Record, per capture, with the analysis script in §13.1 (`_sad391-analyze-search.mjs`): cards; `.udm-badge-block` non-empty count; `i.a-icon-prime` count and its `aria-label`; ingress count (`.udm-sfx-prime-signup-trigger` / "Join Prime" / "Non-members"); in-grid SP cards (`.puis-sponsored-label-text` inside `s-search-result`) and how many of their ASINs also appear organically (→ O1/F10 frequency); PDP: `#mir-layout-DELIVERY_BLOCK*` text and any `a-icon-prime` under `#buybox`/`#desktop_buybox`/`#apex_desktop`.

Gates: ⛔ **G0-a** the member badge markup confirms (or corrects) the UDM sample before Phase 2's badge selectors are final; ⛔ **G0-b** the PDP ingress wording before Phase 2.3; **G0-c** F10 frequency decides whether 3.4 is implemented now or deferred. Save the captures under `docs/plans/SAD-391-fixtures/*.real.html` (SAD-383 convention) — they become the real-markup tests of Phase 6.

### Phase 1 — Delivery recipe hardening (feeds `isPrime`; also fixes the visible `delivery` garbage) — **no gate**

File: `field-parsers.ts:1609-1658` (`extractCardDeliveryAndAvailability`).

1.1 Read the UDM structure first, text second: `primary = card.querySelector('[data-cy="delivery-recipe"] .udm-primary-delivery-message')`, `secondary = … .udm-secondary-delivery-message`; `delivery = clean(primary) [+ ' ' + clean(secondary)]` where `clean()` is `normalizeWhitespace` over a clone with `style, script` removed (or a text walk that skips those tags). Keep today's `[aria-label]`/`textContent` branches as the **fallback** for non-UDM layouts (the existing tests use `span[aria-label="FREE delivery …"]` — `tests/baseline-snapshot.test.ts:65`, `amazon-search-widgets.test.ts:88,195,346`, `pricing-deals-bsr.test.tsx:71`, `sad-386-card-deal.test.ts:167` — and must keep passing unchanged).
1.2 Decouple availability from delivery: the stock-warning span is read into `availability` as today, but it no longer pre-empts the delivery read (drop the `else if (!availability)` coupling at `:1630`; skip `[aria-label]` candidates that match the stock regex when looking for delivery).
1.3 Return an additional, **internal** `primeIngress: boolean` (or a `deliveryBlock` element reference) so Phase 2 does not re-query; the public `{delivery, availability}` shape stays (new optional key only).

Acceptance (unit, new file `tests/sad-391-delivery-recipe.test.ts`): on the live-derived card HTML, B0GQB2F5NF (stock warning) yields `delivery: "Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26"` and `availability: "Only 7 left in stock - order soon."`; no returned `delivery` contains `{color:` or `(function`; the aria-label fallback still returns `"FREE delivery Tomorrow, Oct 17"` for the legacy fixture.

### Phase 2 — `isPrime` = badge ∨ Prime ingress (D1) — card and PDP

2.1 Registry (`selectors.ts:338-343`, bump `AMAZON_SELECTOR_REGISTRY_VERSION` → `2.1.0`):
```
prime: [
  '.udm-badge-block i.a-icon-prime',            // UDM card badge (2025+)          [FIXTURE]
  'i.a-icon-prime', '.a-icon-prime-with-text',   // legacy/p13n + wrapper variant   [EXT]
  '[aria-label="Prime" i]', '[aria-label="Amazon Prime" i]',   // exact, not *=
  '[data-testid*="prime-badge"]',                // kept, harmless
  '#bbop-sbbop-container',                       // PDP buy-box (cards never have it; kept for the PDP loop)
],
primeIngress: [
  '.udm-sfx-prime-signup-trigger', '.prime-brand-color',      // "Join Prime" link   [LIVE]
],
```
plus an exported `PRIME_INGRESS_TEXT = /\b(?:Join Prime|Prime members? get|Non-members get FREE delivery)\b/i` (English; locale variants appended as Phase 0 shows them — never a bare "Prime" word match).

2.2 `extractCardIsPrime(card, delivery)` (`field-parsers.ts:1685-1701`): iterate the registry only (remove the appended `'[aria-label*="Prime" i]'`), then `primeIngress` selectors inside the delivery recipe, then `PRIME_INGRESS_TEXT` on the **cleaned** delivery text from Phase 1. **Delete** the `/\bFREE delivery\b/` branch. Signature unchanged (callers at `search-results.ts:103`, `category-page.ts:158` untouched). Optionally expose `extractCardPrimeSignal(card, delivery): 'badge' | 'ingress' | null` and have `extractCardIsPrime` wrap it — gives Phase 5 the `reason` for free.

2.3 PDP (`product-detail.ts:1529-1541`): same two signals — badge selectors scoped to `#buybox, #desktop_buybox, #apex_desktop, #deliveryBlockMessage, #mir-layout-DELIVERY_BLOCK, #bbop-sbbop-container` (**not** the page-wide `i.a-icon-prime`, which can hit a sponsored carousel tile; apply the existing `isInsideExcludedDetailSubtree` guard, `product-detail.ts:47`, exactly as the delivery/price reads do), plus `PRIME_INGRESS_TEXT` on the already-extracted `delivery` (`:1357-1372`). Remove `[data-csa-c-delivery-price="FREE"]` and the FREE-delivery regex from the Prime decision. ⛔ G0-b for the exact PDP ingress wording; until then the English regex above is used (it is already what the search card prints).

2.4 Diagnostics reason strings: `missing('isPrime', 'no Prime badge or Prime ingress found')` on both surfaces (text change only; count unchanged).

Tests: new `tests/sad-391-prime-signal.test.ts` — (a) UDM badge sample → `true`; (b) legacy `<i class="a-icon a-icon-prime a-icon-small" aria-label="Prime">` → `true`; (c) live "Join Prime" card (with the inline `<style>/<script>`) → `true`; (d) live "FREE delivery Tomorrow, Oct 22" card without ingress → **`false`**; (e) the Malaysia fixture → **`false`**; (f) the Primer-title card → **`false`**; (g) PDP: badge in `#desktop_buybox` → `true`, carousel-only badge → `false`, `data-csa-c-delivery-price="FREE"` alone → `false`. Audit/update: `tests/baseline-snapshot.test.ts:103` (O3 → `false`); all other `isPrime: true` expectations in parser tests have an `a-icon-prime` element and stay green (`scraper-accuracy.test.tsx:171/213, :250/299`, `baseline-snapshot.test.ts:148/184, :208/238, :365/386, :426/477`, `amazon-search-widgets.test.ts:90/262`).

### Phase 3 — `isSponsored`: tighten, extend, unify, and classify the PDP

3.1 Registry (`selectors.ts:344-349`): replace `'span[aria-label*="Sponsored" i]'` with the label-scoped form `'.puis-sponsored-label-text [aria-label*="Sponsored" i], .s-widget-sponsored-label-text, .sponsored-brand-label-info-desktop'`; append `'.s-featured-result-item'`, `'[data-ad-feedback-label-id]'`, `'[data-a-popover*="sp-info-popover" i]'` **[FIXTURE] [EXT]**. Keep `.puis-sponsored-label-text` **with** the existing empty-or-/sponsored/ text guard (F11) — it is what keeps "Featured from Amazon brands" tiles organic.
3.2 `extractCardIsSponsored` (`field-parsers.ts:1703-1782`): extend both regexes to the 10 locale labels (`Sponsored|Gesponsert|Sponsorisé|Sponsorizzato|Patrocinado|Gesponsord|Sponsrad|Sponsorowane|Sponsorlu|スポンサー`); no structural change — the order of checks is already right (container → link → label → leaf → widget).
3.3 `save-product.ts:33-34, 72-74`: delete `SPONSORED_HINT_SELECTOR`; `context.listingCategory = extractCardIsSponsored(card) ? 'sponsored' : 'organic'`. (Pure consolidation; the saved snapshot's placement now agrees with the row's boolean.)
3.4 Duplicate placement (O1, gated by **G0-c**): in `search-results.ts:393-396`, when a primary card is skipped as a duplicate, run only `extractCardIsSponsored(card)`; if `true`, append `'Sponsored Search'` to the existing entry's `placements` (via the existing union helper) — no re-parse, `isSponsored` of the first card unchanged. Mirrors `dedup.ts:106-123`.
3.5 PDP `isSponsored` (`product-detail.ts:1565`): `isSponsored: isSponsoredDetailUrl(activeUrl)` with `isSponsoredDetailUrl = (u) => /[?&]sp_csd=/.test(u) || /\/ref=[^/?#]*_sspa\b/.test(u) || /\/sspa\/click/.test(u)` **[LIVE] [FIXTURE]**, applied to the **page URL** (`activeUrl`), never to the normalised `url` field (`resolveProductUrl` strips the query). Enrichment passes the canonical URL → `false`, and its patch whitelist already never writes `isSponsored` (`enrich-saved-product.ts:154-186`), so a card's `true` survives.

Tests: extend `tests/sad-391-sponsored.test.ts` — real SP fixture → `true` (with/without `AdHolder`); FAB tile → `false`; title-only "sponsored" substring → `false`; each locale label → `true`; `[data-ad-feedback-label-id]`-only card → `true`; PDP URL cases (`…/ref=sr_1_1_sspa?…&sp_csd=…` → `true`; `…/ref=sr_1_3?…` → `false`; canonical `/dp/ASIN` → `false`); save-product context equals detector on the same card; duplicate primary records the placement (3.4).

### Phase 4 — Persistence: stop erasing what was extracted (F7, part of F10)

4.1 `dedup.ts:144-147`: `if (preferSource && typeof source.isSponsored === 'boolean' && target.isSponsored !== source.isSponsored) { … }`.
4.2 `dedup.ts:125-137`: recompute `listingCategory` under `preferSource` only when the source carries sponsorship information (`source.listingCategory !== undefined || typeof source.isSponsored === 'boolean'`); otherwise fall through to the fill-only branch.
4.3 `dedup.ts:106-123`: do not synthesise a placement for a source that has neither `placements`, `sectionLabel`, `listingCategory` nor a boolean `isSponsored` (the `pickVolatile` object) — `resolveProductPlacements` is called only when the source has listing context.
4.4 `db/quick-save.ts:69-87`: additionally carry `isSponsored`, `listingCategory`, `sectionLabel`, `placements` **when present** on the incoming product into the volatile refresh object — so a re-save *with* new information updates (sponsored → organic reflects what was clicked last; placements union), and a re-save *without* leaves the row alone. (4.1–4.3 make the engine safe even if another caller forgets this; 4.4 makes the quick-save semantics explicit.)
4.5 No change to `db/products.ts:63-66` or `enrich-saved-product.ts` (they already never write `isSponsored`).

Tests: `tests/quick-save-data-layer.test.ts` — add the P04 scenario as a regression test ("second save of a sponsored product keeps isSponsored/listingCategory; updatedFields contains only collectedAt"), an organic re-save after a sponsored save (expected under 4.4: `isSponsored` follows the latest save, placements `['Sponsored Search','Organic Search']` — confirm with operator if they prefer "sticky true"), and the pure `mergeScrapedProductFields` cases (`undefined` source boolean is a no-op). Existing `tests/amazon-engine-v2.test.tsx:540-625`, `product-categorization.test.tsx` must stay green (they exercise the widget-vs-primary `preferSource` path with booleans present).

### Phase 5 — Diagnostics honesty (**diagnostics lane: product rows byte-identical**) — O2

5.1 `extraction-diagnostics.ts:93-118`: append `'isSponsored'`; `:262-263` skip it exactly like `isPrime` (D6).
5.2 `card-diagnostics.ts:53, 247-253`: add `isSponsored: boolean` to the input and record `extracted('isSponsored', {source:'derived'})` / `missing('isSponsored', 'no Sponsored marker found', {source:'derived'})`; the single caller (`search-results.ts` / `category-page.ts` diagnostics block) passes the already-computed boolean.
5.3 `product-detail.ts`: same pair next to the `isPrime` lines (`:1536-1540`), reason `'no sponsored URL marker'` when `false`.
5.4 With `extractCardPrimeSignal` from 2.2, record `reason: 'badge' | 'ingress'` on `isPrime` EXTRACTED entries (optional key, no count change).
5.5 Update the pinned 24 → 25 in: `tests/card-diagnostics.test.ts:85,121,155`, `extraction-diagnostics.test.ts:160,445,464`, `offscreen-handlers.test.ts:119`, `save-product.test.ts:157,205,288`, `card-icon-save-diagnostics.test.tsx:120`, `collection-diagnostics-e2e.test.tsx:152`; and the "24 modelled fields" wording in `card-diagnostics.ts` header comment and `docs/plans/SAD-359-*`/`SAD-369-*` where it is stated as current behaviour. `scripts/sad-359-diagnostics-measurement.mjs` is count-agnostic (verify).

### Phase 6 — Verification across every workflow, and documentation

Automated: `npm run verify` (tsc → vitest → wxt build → audit) must pass; new tests from Phases 1–5 (~5 files); the Phase 0 captures added as `*.real.html` fixtures with one assertion table each (ASIN → expected `isPrime`, `isSponsored`, `delivery`).

Manual matrix (one row per workflow, both signed-in states if Phase 0 provided them; record in `docs/plans/SAD-391-verification-report.md` as SAD-386 did):

| Workflow | Where to look | Expected |
|---|---|---|
| Collection on `/s?k=laptop` (logged out) | preview table, Prime/Sponsored columns, Delivery column | Prime `Yes` exactly on the "Join Prime" cards; no `{color:` text in Delivery; Sponsored `Yes` on SB/SBV/carousel tiles and on any in-grid SP card; organic cards `No` |
| Same page, signed-in Prime member | same | Prime `Yes` on badge cards; counts reported by the diagnostics summary match the DOM counts from the Phase 0 script |
| Collection on `/deals`, `/gp/bestsellers` | table | both `No` unless a marker exists (deals faceouts carry none, `docs/plans/SAD-383-fixtures/deals-card.real.html`) — unchanged from today |
| One-click save of an SP card, then save it **again** | collection preview after each save | Sponsored stays `Yes`, placement unchanged (F7) |
| Save from a PDP opened through an ad (`…_sspa…sp_csd=`) vs. through an organic link | table | `Yes` vs `No` |
| Background enrichment of a saved sponsored card | table after enrichment finishes | Sponsored still `Yes`; Prime unchanged unless the PDP carried a badge/ingress |
| Export CSV/XLSX, sort by Prime/Sponsored, category filter "Sponsored" | export file, table | values identical to the table; the F10 duplicate shows under the Sponsored filter via its placement |
| Temu page | table | unchanged (no Temu code touched) |

Docs: `CHANGELOG.md` entry "Prime and Sponsored extraction (SAD-391)"; a short note in `docs/plans/SAD-391-implementation-record.md` with the before/after counts from the Phase 0 captures; this plan copied to `docs/plans/SAD-391-prime-sponsored-plan.md`.

---

## 9. Regression protection — how "must not influence other features" is enforced

### 9.1 Invariants and their proofs

| Invariant | Proof |
|---|---|
| No field other than `isPrime`, `isSponsored`, `delivery` (cleanup only), `availability` (decoupling only), `listingCategory`/`placements` (no longer erased) changes value for any existing fixture | `tests/baseline-snapshot.test.ts` diff limited to O3's one key; the full suite otherwise unchanged |
| `delivery` for every legacy fixture is byte-identical | the aria-label fallback is kept (Phase 1.1); fixtures listed there |
| Product rows are byte-identical across Phase 5 | Phase 5 touches only the collectors; run the SAD-369 collection e2e before/after and diff the emitted rows |
| Rendering/export untouched | no file under `ui/`, `export/` in the diff (§1 out of scope) |
| Temu untouched | no file under `engines/temu/` in the diff |
| Performance | Phase 3.4 adds one `extractCardIsSponsored` call per *duplicate* primary card only; Phase 1 replaces one `textContent` read with one scoped query — both O(1) per card; the 480-card budget measured in SAD-386 is unaffected (re-measure with the SAD-378 scroll harness if desired) |

### 9.2 Tests that pin current values and must be **audited** (not assumed)

| Test | Pins | Action |
|---|---|---|
| `tests/baseline-snapshot.test.ts:103` | `isPrime: true` from FREE-delivery text only | **Change to `false`** (O3), same commit as Phase 2 |
| `tests/baseline-snapshot.test.ts:98`, `pricing-deals-bsr.test.tsx:107,184`, `amazon-search-widgets.test.ts:261,371` | exact `delivery` strings from aria-label fixtures | must stay identical (Phase 1 fallback) |
| `tests/scraper-accuracy.test.tsx:164-220` | `isSponsored: true` via `<span class="puis-sponsored-label-text">Sponsored</span>`, `isPrime: true` via `<i class="a-icon-prime" aria-label="Amazon Prime">`, `availability` from `.a-color-price` in the delivery recipe | unchanged; confirms Phase 1.2 keeps `.a-color-price` availability |
| `tests/amazon-search-widgets.test.ts`, `product-categorization.test.tsx` | widget/organic duplicates keep `isSponsored:false` + placements | unchanged (Phase 4 only guards `undefined`) |
| `tests/quick-save-data-layer.test.ts:137-152` | `isPrime` OR on re-save | unchanged; new cases added |
| 12 diagnostics count assertions (Phase 5.5) | `24` | → `25` in the Phase 5 commit only |
| `tests/collection-save-parity.test.ts` | card parse vs save parse identical fields | still identical (both call the same detectors; 3.3 removes the only divergence) |

---

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Prime `Yes` rate drops sharply for logged-out users (from ~69 % FREE-delivery matches to ~44 % ingress matches on the live page) and is read as a regression | High | Medium | It is the decided semantics (D1); CHANGELOG states it; Phase 0 numbers documented; diagnostics now say *why* (`badge`/`ingress`) |
| Locale ingress wording differs (`.de`, `.co.uk`, `.co.jp`) → `isPrime` under-reports outside `.com` | Medium | Low–Medium | selectors (`.udm-sfx-prime-signup-trigger`, `.prime-brand-color`) are locale-independent; text regex is additive per Phase 0 capture |
| Signed-in badge markup differs from the 2025 sample | Low | Low | ⛔ G0-a before finalising 2.1; `i.a-icon-prime` alone already covers both known generations |
| A Sponsored-only URL heuristic mislabels a PDP reached by a non-ad `sspa` redirect | Low | Low | three independent markers required one-of; enrichment never writes it; covered by tests |
| Phase 4 changes alter widget/primary merges | Low | Medium | guards only act on `undefined`; existing categorization tests pin the boolean paths |
| Diagnostics count change breaks an external consumer of the report | Low | Low | O2 default; alternative (non-counted entry) listed |

---

## 11. Commit plan

1. `fix(amazon): read UDM delivery message structurally; keep availability from pre-empting delivery (SAD-391 F5)` — Phase 1 + tests.
2. `fix(amazon): isPrime = Prime badge or Prime ingress, drop FREE-delivery proxy (SAD-391 F1-F4, F6)` — Phase 2 + registry bump + baseline-snapshot O3 + tests.
3. `fix(amazon): sponsored markers, locale labels, single detector for saves, PDP sponsored URL (SAD-391 F8, F9b, F11)` — Phase 3.1–3.3, 3.5 + tests.
4. `fix(amazon): record Sponsored placement for duplicate primary cards (SAD-391 F10)` — Phase 3.4, only after G0-c.
5. `fix(amazon): never write undefined isSponsored/listingCategory on preferSource merges; quick-save carries listing context (SAD-391 F7)` — Phase 4 + tests.
6. `feat(diagnostics): report isSponsored and the Prime signal source (SAD-391 F9a)` — Phase 5 + the 12 count updates.
7. `docs: SAD-391 plan, fixtures, verification report, changelog` — Phase 6.

Each commit passes `npm run verify` on its own; 4 and 6 are droppable without affecting the others.

---

## 12. What is still open

*(Status after implementation: O1–O3 were decided — O1 as D8, O2 as D7, O3 applied; D6 made `isSponsored` sticky-true. Phase 6 added one finding not in this plan: a Prime ingress inside the "Get it faster" secondary-offer block (`[data-cy="multi-offer-display"]`) is deliberately **not** read — see the implementation record.)*

- **G0-a/b/c** (Phase 0): signed-in badge markup, PDP ingress wording, F10 frequency.
- ~~**O1–O3** defaults above; in particular whether a later *organic* re-save should flip a previously sponsored row (Phase 4.4) or whether `isSponsored` should be "sticky true" like `isPrime`.~~ Decided: D6 sticky-true; §4.4 recompute not implemented (volatile pass stays listing-blind).
- Whether `extractCardPrimeSignal`'s reason should also surface in the UI tooltip later (not in this ticket).
- F12 (duplicated widget heading) — new ticket.

---

## 13. Appendix

### 13.1 The probes used for every [PROBE] claim (run from `tests/_probe/` / `scripts/`, then **moved out of the repo**; `git status` clean)

All files are in `/home/user/sad391-evidence/scratch/`:

| Id | File | What it did | Result |
|---|---|---|---|
| P01 | `sad391-live-search.test.ts` + `_sad391-analyze-search.mjs` | production `parseAmazonSearchResults` on `search-laptop.html` | 33 products; primary `isPrime` 11/16 `true` (all via FREE-delivery regex), 4 `false` only because `delivery` was lost to the stock warning; 6 rows with `<style>/<script>` text in `delivery`; `isSponsored` 0/16 primaries, 17/17 widget tiles |
| P02 | `sad391-sp-fixture.test.ts` | real 2025 SP card (crawl4ai) wrapped in its `s-search-result` shell; FAB tile | `isSponsored: true` (with/without `AdHolder`); `isPrime: true` from "FREE delivery … to Malaysia on $49 …" (false positive); FAB tile `false` |
| P03 | `sad391-aria-fp.test.ts` | card with `h2[aria-label="… Primer Spray …"]`, paid delivery | `isPrime: true` (false positive via `[aria-label*="Prime" i]`) |
| P04 | `sad391-resave.test.ts` | `upsertProductFromQuickSave` twice with the same sponsored payload (real Dexie + fake-indexeddb); pure `mergeScrapedProductFields` with a source lacking `isSponsored` | save #2 → `updatedFields ["collectedAt","isSponsored","listingCategory","placements"]`, `isSponsored` gone, `listingCategory 'organic'`; pure merge `changed=true`, same effect |
| P05 | `_sad391-analyze-sponsored.mjs`, `_sad391-analyze-aspa.mjs` | DOM census of the live page: sponsored labels, `/sspa/click` references (46; 36 anchor `href`s, all inside carousel tiles), widget wrappers, the two `aspa-asin-ajax-lazy-loader` spans, raw delivery-recipe HTML | basis of F3, F4, F10 |
| P06 | inline (`/tmp/udm.mjs`, `_tmp_aria*.mjs`) | per-card UDM message table (F4) and `aria-label` census (F2): `h2[aria-label]` 16/16 | tables in F2/F4 |

### 13.2 The shapes that carry most of the fix (shape, not final code)

```ts
// field-parsers.ts — Phase 1/2
export function extractCardDeliveryAndAvailability(card) {
  const recipe = safeQuerySelector(card, '[data-cy="delivery-recipe"]');
  const primary = recipe && safeQuerySelector(recipe, '.udm-primary-delivery-message');
  const secondary = recipe && safeQuerySelector(recipe, '.udm-secondary-delivery-message');
  const stock = recipe && findStockWarning(recipe);              // .a-color-price | [aria-label~=stock]
  const availability = stock ?? legacyAvailability(card);        // unchanged regexes
  const delivery = primary
    ? joinNonEmpty(textWithoutStyleScript(primary), textWithoutStyleScript(secondary))
    : legacyDeliveryFromAriaOrText(recipe, { ignore: stock });   // existing branches, minus the coupling
  const primeIngress = Boolean(recipe && (
    safeQuerySelector(recipe, AMAZON_SELECTORS.cardFields.primeIngress.join(',')) ||
    (delivery && PRIME_INGRESS_TEXT.test(delivery))));
  return { delivery, availability, primeIngress };
}

export function extractCardPrimeSignal(card, delivery, primeIngress?) {
  for (const s of AMAZON_SELECTORS.cardFields.prime) if (safeQuerySelector(card, s)) return 'badge';
  if (primeIngress ?? (delivery && PRIME_INGRESS_TEXT.test(delivery))) return 'ingress';
  return null;
}
export const extractCardIsPrime = (card, delivery, primeIngress?) =>
  extractCardPrimeSignal(card, delivery, primeIngress) !== null;
```

```ts
// dedup.ts — Phase 4 (only the guarded lines)
if (preferSource && typeof source.isSponsored === 'boolean' && target.isSponsored !== source.isSponsored) { … }
const sourceHasListingContext =
  source.listingCategory !== undefined || typeof source.isSponsored === 'boolean' ||
  Boolean(source.sectionLabel) || (source.placements?.length ?? 0) > 0;
// placements union and listingCategory recompute run only when sourceHasListingContext
```

```ts
// product-detail.ts — Phase 3.5
const isSponsored = isSponsoredDetailUrl(activeUrl);   // sp_csd= | /ref=…_sspa | /sspa/click
```

### 13.3 File:line index used throughout this plan (at `2ec7eaf`)

`selectors.ts` 10 (version), 338-343 (prime), 344-349 (sponsored), 350-353 (card delivery), 197-201 (PDP delivery) · `field-parsers.ts` 1609-1658 (delivery/availability), 1685-1701 (isPrime), 1703-1782 (isSponsored), 1843 (`extractCardListingCategoryAndSection`) · `search-results.ts` 96-112 (card fields), 389-416 (dedup loop; 393-396 first-primary-wins) · `category-page.ts` 156-159 · `product-detail.ts` 1357-1372 (delivery), 1529-1541 (isPrime), 1565 (`isSponsored:false`) · `dedup.ts` 45-150 (`mergeScrapedProductFields`; 101-104 isPrime, 106-123 placements, 125-137 listingCategory, 144-147 isSponsored), 233-285 (`mergeAndFilterNew`) · `db/quick-save.ts` 22-35, 69-87, 160-171 · `db/products.ts` 63-66 · `background/enrich-saved-product.ts` 154-186 · `background/enrichment-fetch.ts` 289 · `background/collections.ts` 99-116 · `content/save-product.ts` 33-34, 72-74 · `scraper/parse-cache.ts` 70-140 · `entrypoints/amazon.content.ts` 323-361 · `scraper/extraction-diagnostics.ts` 93-118, 243-263 · `scraper/card-diagnostics.ts` 53, 247-253 · `utils/listing-category.ts` 16-28, 52-76 · `ui/table/columns.tsx` 628-664, 951-952 · `export/types.ts` 76-77, 143-144, 238-239 · `schemas/product.ts` 38-39 · `schemas/settings.ts` 40-41 · `constants/defaults.ts` 90-91 · `src/lib/sorting/product-sorter.ts` 29-30, 45-46.

### 13.4 External cross-checks consulted **[EXT]**

miguelglopes/amazon_filter `popup.js` (Prime = `[aria-label="Amazon Prime"]` | `i.a-icon-prime, .a-icon-prime` | `img[alt*="Prime" i]`; free-delivery text ≠ Prime) · Shpigford/knockoff `styles.css` (SP tile = `s-search-result:has(.puis-sponsored-label-text :is([aria-label*="Sponsored" i], …9 locales))`; widget rows = `.s-widget:has(.s-widget-sponsored-label-text, .sponsored-brand-label-info-desktop)`; FAB-tile caveat) · unclecode/crawl4ai `amazon_example/product.html` (the SP card fixture) · rigwild/mcp-server-amazon `mocks/getCartContent.html` (UDM badge) · IBM/watson-online-store data (legacy badge with `aria-label="Prime"`) · rushiranpise/morphe-patches (`[data-ad-feedback-label-id]`) · theonlyanil/amzpy, fwilldev/portasplit-tracker, zach22-1999/amazon-skills (badge-only Prime detection) · Cybrarist/Discount-Bandit, Hari-Nagarajan/fairgame (`data-csa-c-delivery-price` = shipping price).

### 13.5 One-paragraph summary

`isPrime` is wrong because it is not a Prime detector: for a logged-out operator the badge is never in the DOM, the registry's wildcard `[aria-label*="Prime"]` matches product titles, and the fallback turns any "FREE delivery" sentence — including merchant-fulfilled and international shipping — into `Yes`, while the one genuine non-member Prime signal ("Join Prime to get FREE delivery") is only hit by accident and is lost whenever a stock warning precedes it. `isSponsored` is detected correctly on real ad markup, but a second one-click save of the same product silently erases it (an `undefined` written through a `preferSource` merge), product pages always say `No` even when the URL proves the ad click, same-page organic/sponsored duplicates lose their sponsored placement, and neither field is visible in the diagnostics. The plan replaces the Prime decision with "badge or Prime ingress" on cards and PDPs (D1), hardens the delivery read it depends on, tightens and localises the sponsored markers, unifies the save-path detector, classifies PDPs from the URL, makes merges ignore absent booleans, and adds both fields to the diagnostics — in seven independently verifiable commits, with one deliberately updated snapshot and a Phase 0 operator capture (via `moli import` of the real browser session) gating only the signed-in badge and PDP wording.

### 13.6 `nav-search.js` used by the moli recipe (Phase 0; edit the query string)

```js
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let b = document.querySelector('form[action*="validateCaptcha"] button');
  if (b) { b.click(); await sleep(8000); }
  // Use the real search box so the request looks like a user search
  const box = document.querySelector('#twotabsearchtextbox');
  const form = document.querySelector('form#nav-search-bar-form');
  if (box && form) {
    box.value = 'laptop';
    form.submit();
    await sleep(12000);
  } else {
    location.href = '/s?k=laptop';
    await sleep(12000);
  }
  return location.href;
})()
```
Rules learned the hard way: one navigation per `--eval` run (a second navigation inside the same script makes moli report "Runtime.evaluate … is no longer pending"); run with a persistent `-P` profile so the WAF/interstitial cookies survive; keep ≥ 30 s between runs — the sandbox IP was 503-blocked after a handful of searches.
