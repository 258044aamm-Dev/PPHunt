# SAD-391 — implementation record and review handoff

Issue: https://linear.app/sad-mod/issue/SAD-391/the-prime-and-sponsored-fields

Branch: `fix/sad-391-prime-sponsored` (cut from `main` @ `2ec7eaf`)

Plan: `docs/plans/SAD-391-prime-sponsored-plan.md` (decisions D1–D8 in §0, root
causes F1–F12 in §5). This record states what was actually shipped, what was
measured, and what is still open for the reviewer.

## Confirmed requirement

Owner decisions (asked through the interactive tool, not assumed):

- **D1** `isPrime` = Prime **badge** OR explicit Prime-eligibility **ingress**
  text ("Join Prime to get FREE delivery …", "Prime members get …",
  "Non-members get FREE delivery …"). The generic *FREE delivery* heuristic is
  dropped on cards and on the product page.
- **D4** Scope is everything: detectors, the quick-save re-save wipe, the
  delivery-recipe bugs that feed `isPrime`, PDP `isSponsored` from the ad URL,
  `isSponsored` in the diagnostics.
- **D5** No operator captures were required before starting; the live
  logged-out capture plus the real 2025 markup samples are the evidence base.
- **D6** `isSponsored` is sticky-true on re-save (same OR rule as `isPrime`).
- **D7** `isSponsored` becomes the 25th counted diagnostics field.
- **D8** The duplicate primary placement (same ASIN as ad and as ranked result)
  is recorded now.
- **O3** `tests/baseline-snapshot.test.ts` card `B0DEAL0001` is the one
  intentional snapshot change (`isPrime` true → false).

## Delivered in pushed steps

| Step | Commit | Content | Gate (tsc · vitest · wxt build) |
|---|---|---|---|
| 0 | `c1eb4bb` | Plan copied into the repo with §0.0 implementation decisions. | — |
| 1 | `d84d284` | Delivery recipe read structurally (`.udm-primary-delivery-message` + `.udm-secondary-delivery-message`, visible text only); availability no longer pre-empts delivery; three verbatim live fixtures; `tests/sad-391-delivery-recipe.test.ts` (9). | clean · 128 files, 1427 tests · OK |
| 2 | `cc86e72` | `isPrime` = badge ∨ ingress on cards (`extractCardPrimeSignal` → `'badge' | 'ingress' | null`) and PDP (`detail.primeScopes`); FREE-delivery heuristic and `data-csa-c-delivery-price="FREE"` proxy removed; anchored badge-label pattern; registry `2.0.0 → 2.1.0`; O3 snapshot; `tests/sad-391-prime-signal.test.ts` (21). | clean · 129 files, 1448 tests · OK |
| 3 | `37fb3c5` | Sponsored markers for 2025 markup + widget labels + nine localized words; one detector shared by collection and one-click save; `isSponsoredDetailUrl` (`sp_csd=`, `/ref=…_sspa`, `/sspa/click`) feeds the PDP `isSponsored`; D8 duplicate-primary placement; `tests/sad-391-sponsored.test.ts` (36). | clean · 130 files, 1484 tests · OK |
| 4 | `c93a00d` | `mergeScrapedProductFields` gains the `sourceHasListingContext` guard (no invented `Organic Search`, no `undefined` overwrite); quick-save applies the D6 sticky rule; `tests/sad-391-persistence.test.ts` (9). | clean · 131 files, 1493 tests · OK |
| 5 | `3525b64` | `DETAIL_DIAGNOSTIC_FIELDS` 24 → 25 (`isSponsored`); card/PDP diagnostics emit `isSponsored` and the `isPrime` reason (`prime badge` / `prime ingress`); pinned counts updated in seven existing suites; product rows byte-identical with or without a sink; `tests/sad-391-diagnostics.test.ts` (9). | clean · 132 files, 1502 tests · OK |
| 6 | this commit | Secondary-offer ingress scoping (below), fourth live fixture + test, CHANGELOG, this record, plan status. | `npm run verify` green: clean · 132 files, 1503 tests · OK · audit 0 (see "Final gate"). |

Baseline on `main` @ `2ec7eaf` before any change: tsc clean, 127 test files
(+1 skipped), 1415 tests, `wxt build` OK.

## Measured before / after on the live capture

Source: a verbatim logged-out, non-member `https://www.amazon.com/s?k=laptop`
page captured 2026-10-21 with `lexmount/moli` 1.1.18 (the only live capture the
sandbox obtained before Amazon rate-limited it). `parseSearchResults` was run
under jsdom on `main` @ `2ec7eaf` and on this branch; the page contains **no
`i.a-icon-prime` badge at all** (a signed-out visitor never gets one), 16
primary result cards and 17 sponsored widget tiles.

| Measure | `main` | branch | Why |
|---|---|---|---|
| rows parsed | 33 | 33 | unchanged |
| `isPrime === true` | **19** | **12** | 19 were the *FREE delivery* heuristic firing; 12 are the rows whose main delivery recipe prints the "Join Prime to get FREE delivery …" ingress |
| `isSponsored === true` | 17 | 17 | unchanged (all 17 widget tiles; the page had no in-grid Sponsored Products card) |
| `delivery` containing CSS/JS (`{color:` / `(function`) | **11** | **0** | F5: visible text only |
| "Only N left in stock" cards with no `delivery` | **4** | **0** | F5: availability no longer pre-empts delivery |

Per-row changes (every other row is identical):

| ASIN | `main` | branch | Evidence on the card |
|---|---|---|---|
| B0HK7LXM3G, B0H3KVQL3C, B0GV5P8LGC, B0HKGQS9S8 | Prime | — | "FREE delivery Tomorrow, Oct 22", empty UDM badge block, no ingress |
| B0GR6KJ72L, B0H9Y3978C, B0G2X8X3TQ | Prime | — | "FREE delivery <window> / Or fastest delivery …", no badge, no ingress |
| B0HKM2TJ6N | Prime | — | Sponsored Video tile, "FREE delivery Tomorrow, Oct 22", no badge, no ingress |
| B0GQB2F5NF | — | Prime | "Join Prime to get FREE delivery Fri, Oct 23" — on `main` the delivery text was lost to the "Only 7 left in stock" span, so the heuristic never saw it |
| 11 rows with "Join Prime …" in the main recipe | Prime | Prime | unchanged verdict, now for the right reason (`prime ingress`) and with a clean delivery string |

### The one new finding of Phase 6 — secondary-offer ingress (fixed in this step)

The first branch measurement reported 13 Prime rows. The 13th, **B0GPW3BJ6V**,
has a plain "FREE delivery Oct 26 - 28" featured offer ($695.00) *and* a "Get it
faster" secondary offer ($709.99) under `[data-cy="multi-offer-display"]` whose
own delivery block carries the "Join Prime to get FREE delivery Fri, Oct 23"
link. The row's price and delivery describe the featured offer, so the ingress
of a different offer must not make it Prime. `cardFields.primeIngress` is now
scoped to `[data-cy="delivery-recipe"]` (the text path already was); the card is
checked in verbatim as
`docs/plans/SAD-391-fixtures/search-card-secondary-offer-prime-ingress.real.html`
with a test in `tests/sad-391-prime-signal.test.ts`. Reviewer call-out: if the
owner prefers "any offer of the product is Prime-eligible" semantics, this is a
one-line selector change plus that test.

### Unchanged behaviour worth knowing when reading the table

Four primary cards (B0HJCRV1J6, B0GBX8HRTC, B0GR6KJ72L, B0H9Y3978C) also appear
as tiles inside a sponsored carousel/brand widget on the same page. As before
this ticket, the row keeps the primary card's own verdict (`isSponsored: false`,
organic ranking) and records the extra placement (`placements: ['Organic
Search','Sponsored Carousel']`, `sectionLabel`), which is how the Sponsored
filter finds them. This is SAD-370/379 behaviour and was not touched.

## Product isolation

- Only Amazon scraper/merge/quick-save/diagnostics code changed; the Temu engine,
  DB schema, exports, settings, table columns, sorting and filters are untouched
  (`git diff --stat main...HEAD` lists no source file outside
  `src/engines/amazon/{scraper,db,content,utils}`; the rest is tests, fixtures,
  `docs/plans/` and `CHANGELOG.md`).
- The enrichment patch whitelist still never writes `isSponsored`; a source
  without listing context cannot change `isSponsored`, `listingCategory` or
  `placements`.
- Diagnostics are a side channel: the parity test proves product rows are
  byte-identical with and without a diagnostics sink.
- Every pre-existing suite passes with its original assertions except the seven
  places that pinned the diagnostics count (24 → 25, D7) and the one deliberate
  snapshot (O3).

## Deviations from the plan (stated, not hidden)

- **Plan §4.4** (recompute `listingCategory` inside the quick-save *volatile*
  pass) was **not** done. The volatile pass stays listing-blind; the D6 sticky
  rule is applied once after the fill pass. Behaviour is covered by
  `tests/sad-391-persistence.test.ts` (sponsored re-save → `updatedFields ===
  ['collectedAt']`; organic → sponsored → `['collectedAt','isSponsored','placements']`).
- **Phase 0 captures** (signed-in badge markup, PDP ingress wording, F10
  frequency) were waived by D5. The signed-in UDM badge shape used in tests is
  the real 2025 sample from `rigwild/mcp-server-amazon` (`a-icon-prime-with-text`
  → `i.a-icon-prime[aria-label="Prime"]`), not a capture from this operator's
  account.
- The plan's commit granularity (7 commits) was followed as 6 pushed steps plus
  this documentation step; the D8 placement landed inside step 3.

## Final gate

`npm run verify` (= `tsc --noEmit && vitest run && wxt build && npm audit
--omit=dev`) on the final tree, 2026-10-21: **tsc clean · 132 test files passed
| 1 skipped (133) · 1503 tests passed · `wxt build` OK (2.03 MB) · `npm audit
--omit=dev` found 0 vulnerabilities · exit 0.** (The one skipped file is skipped
on `main` as well.)

## Manual verification matrix — **not run** (needs a live browser session)

The sandbox has no signed-in Amazon session and was rate-limited after the one
capture, so none of the rows below were executed. They are the acceptance checks
for the reviewer, verbatim from plan Phase 6.

| Workflow | Where to look | Expected |
|---|---|---|
| Collection on `/s?k=laptop` (logged out) | preview table, Prime/Sponsored/Delivery columns | Prime `Yes` exactly on the "Join Prime" cards; no `{color:` text in Delivery; Sponsored `Yes` on SB/SBV/carousel tiles and on any in-grid SP card; organic cards `No` |
| Same page, signed-in Prime member | same | Prime `Yes` on badge cards; diagnostics counts match the DOM counts |
| Collection on `/deals`, `/gp/bestsellers` | table | both `No` unless a marker exists — unchanged |
| One-click save of an SP card, then save it **again** | collection preview after each save | Sponsored stays `Yes`, placement unchanged (F7) |
| Save from a PDP opened through an ad (`…_sspa…sp_csd=`) vs. an organic link | table | `Yes` vs `No` |
| Background enrichment of a saved sponsored card | table after enrichment | Sponsored still `Yes`; Prime unchanged unless the PDP carried a badge/ingress |
| Export CSV/XLSX, sort by Prime/Sponsored, category filter "Sponsored" | export file, table | identical to the table; the D8 duplicate shows under the Sponsored filter via its placement |
| Temu page | table | unchanged |

## Still open after this branch

- Signed-in Prime-member capture (plan G0-a): confirms the badge path on a real
  account; today it rests on the external 2025 sample.
- Non-English PDP ingress wording (G0-b): only the English ingress regex exists.
- F10 frequency (how often the async Sponsored Products injection races the
  first parse) — mechanism handled by D8, frequency unmeasured.
- F12 duplicated widget heading in `sectionLabel` — cosmetic, separate ticket.

## Integration into MergeBranch

Landed in two phases, following the SAD-392/SAD-387 precedent (plan:
`docs/plans/SAD-391-merge-into-MergeBranch-plan.md`).

- **Base:** `MergeBranch@36589c3` (SAD-387/388/389/390/392/393 plus the
  parse-cache union repairs `6723b04`, `3676dfc`, `f3ffda9`) merged into this
  branch on top of `450a6a0`.
- **Conflicts (7 files / 12 hunks) and how they were resolved:**
  - `field-parsers.ts` — SAD-390's `extractCardDeliveryAndAvailability` (with
    SAD-392's clean stock-span read) is kept whole; SAD-391's structural read
    of `.udm-primary-delivery-message` / `.udm-secondary-delivery-message` is
    grafted ahead of its whole-block fallback so a signed-in card's badge text
    (*One-Day*) never prefixes Delivery. `visibleTextContent` and its two
    patterns are retired: `extractCleanElementText` is a tested superset.
  - `product-detail.ts` — both helper blocks kept; SAD-390's two-pass delivery
    loop (it already strips inline code, which is all the SAD-391 loop added).
  - Diagnostics universe on the merged tree is **PDP 25 / card 26**
    (`isSponsored` + SAD-393's card-only `badge`): pins and prose updated in
    `card-diagnostics.ts`, eight test files and `ARCHITECTURE.md`.
  - `CHANGELOG.md` — SAD-391 entry topmost above SAD-387/392/393; the
    "Delivery text" and "25th modelled field" bullets reworded for the merged
    tree.
- **Behaviour check:** the live `/s?k=laptop` replay (33 rows) is identical
  before and after the merge — Prime 12, Sponsored 17, 0 inline-code leaks,
  0 lost deliveries.

### Merge record (landed on `MergeBranch`)

| | |
|---|---|
| `MergeBranch` head before | `36589c3` |
| Phase A (reconciliation on the feature branch) | `5b344b9` plan · `c33cd82` `Merge MergeBranch into fix/sad-391-prime-sponsored` |
| Phase B merge commit | `5fa0926` `Merge fix/sad-391-prime-sponsored (SAD-391 Prime and Sponsored fields) into MergeBranch` — parents `36589c3` + `c33cd82`; no conflicts; tree byte-identical to `c33cd82` |
| `git diff --stat 36589c3..5fa0926` | 36 files, +2880 / −98 |
| Gate on the merged tree (local) | `tsc` clean · `check:dead-exports` clean · vitest **144 files / 1681 tests, 0 failed** · `wxt build` 2.06 MB · `npm audit --omit=dev` 0 vulnerabilities · manifest sanity OK |
| Live replay | `/s?k=laptop` capture, 33 rows identical to the branch: Prime 12, Sponsored 17, 0 inline-code leaks, 0 lost deliveries |
| CI | [run 39807999776](https://github.com/MakeTheNewHistory/PPHunt/actions/runs/39807999776) — `push` on `MergeBranch`, all 11 steps success |
| `main` | unchanged at `2ec7eaf` |
| Linear | SAD-391 stays **In Review** (manual browser matrix still open) |
