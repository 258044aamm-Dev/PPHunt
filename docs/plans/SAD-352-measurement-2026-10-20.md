# SAD-352 — Phase 1 measurement, session 1 (2026-10-20)

First live measurement of right-click/card enrichment, taken with the Step 1a
diagnostics (`32c11fc`). Source: service-worker console lines supplied by the
owner from a real Chrome session on amazon.com (deals pages). Chrome version
and connection type were **not recorded** this session — capture them next run.

## Session summary

- **23 save jobs, 23 enrichment outcomes** (paired by `jobId`; outcomes
  interleave in the console because enrichment concurrency is 2).
- Triggers: 3 × `context-menu`, 20 × `card-button`. All 23 `pageType: 'category'`
  (`amazon.com/deals…`) — **no search-page saves yet** (sample gap, see below).
- Outcomes: **14 `complete`, 9 `partial`, 0 `failed`, 0 `skipped`**, every fetch
  `httpStatus: 200`.
- `htmlBytes`: min 1,996,736 · median 2,398,759 · max 2,660,445 (89% of the
  3,000,000-char cap). No size rejections.
- 21 distinct ASINs; both repeats were deterministic (`B0FLCP2X8L` complete
  twice, `B0BXYKQBDC` partial twice) — `partial` is a per-product property of
  the parsed page, not flakiness.
- Limitation: the pasted console objects were collapsed, so `fieldsChanged`,
  `missingDetailFields`, `snapshotCreated` and `ms` were **not captured** this
  session. Step 1a.1 converts the outcome line to one-line JSON to fix that.

| # | ASIN | Trigger | Outcome | htmlBytes |
|---|---|---|---|---|
| 1 | B0GKMCP4JY | context-menu | complete | 2,479,314 |
| 2 | B0BXYKQBDC | context-menu | partial | 2,052,096 |
| 3 | B0FLCP2X8L | context-menu | complete | 2,559,424 |
| 4 | B0FLCP2X8L | card-button | complete | 2,267,599 |
| 5 | B07HC2WHS1 | card-button | complete | 2,218,947 |
| 6 | B09DT8PPPJ | card-button | complete | 2,623,170 |
| 7 | B0D16L5F2M | card-button | complete | 2,402,643 |
| 8 | B0BXYKQBDC | card-button | partial | 2,315,902 |
| 9 | B0D7N2KWLH | card-button | partial | 2,068,458 |
| 10 | B0D71BKD7Q | card-button | partial | 2,522,002 |
| 11 | B0DWV55DXH | card-button | complete | 2,660,445 |
| 12 | B0B6G9TPNQ | card-button | complete | 2,409,663 |
| 13 | B09BD8GZ8L | card-button | partial | 1,996,736 |
| 14 | B09BVXT8TJ | card-button | partial | 2,195,127 |
| 15 | B0G66ZJG3Y | card-button | complete | 2,484,429 |
| 16 | B01LW1983J | card-button | complete | 2,576,526 |
| 17 | B0DDCQ534S | card-button | partial | 2,051,725 |
| 18 | B0946MVWGD | card-button | complete | 2,589,289 |
| 19 | B0F5977GWC | card-button | complete | 2,398,759 |
| 20 | B0D7NXSQ44 | card-button | complete | 2,161,892 |
| 21 | B0DJ2WDQKT | card-button | partial | 2,169,537 |
| 22 | B0DKVDZXSN | card-button | complete | 2,450,851 |
| 23 | B0DH1MKVQV | card-button | partial | 2,264,658 |

## Hypothesis verdicts after session 1 (plan §7)

| # | Verdict | Evidence |
|---|---|---|
| H1 fetch refused/challenged | **Refuted for this session/network** | 23/23 HTTP 200 with full-size bodies; no `captcha`/`blocked`/`not-found`/`timeout` |
| H2 >3 MB cap | **Not observed** (not refuted in general) | Max 2.66 MB of 3.00 MB cap; keep watching the tail |
| H3 ASIN mismatch | **Not observed** | 0 mismatches in 23 |
| H4 sparse static parse / silent "complete" | **Open — now the main suspect** | 9/23 (39%) `partial`: parse succeeded (title is required by the parser) but `price === null` in the fetched static HTML. Which fields remain blank after merge is **unknown** until the expanded (`missingDetailFields`) run lands |
| H5 breaker skips | **Refuted for this session** | 0 `skipped`, including rapid sequences |
| H6 worker suspension | **Not observed** | 23 jobs → 23 outcomes (caveat: SW DevTools attached during capture keeps the worker alive) |
| H7 offscreen unavailable | **Refuted (Chrome)** | Every fetched page parsed (`complete`/`partial`, never `ENRICH_PARSE_FAILED`) |
| H8 page-type misclassification | **Not observed** | All jobs correctly `pageType: 'category'` |

## Sandbox re-parse of 4 sampled ASINs (indicative only — different PDP variant)

The same day, from the audit sandbox (desktop UA, no cookies), 2 `partial` and
2 `complete` ASINs were fetched and run through the production `parsePdpHtml`:

- All four parsed **with** brand, seller, availability, BSR, rating/reviews and
  features — including the two the owner's browser reported `partial`.
- The two `partial` ASINs yielded non-null but suspicious prices (`0.09`,
  `7.94` against list prices `49.99`, `29.99` — consistent with a per-unit
  price being picked up), while the owner's parses had `price === null`.
- Sandbox HTML sizes differ materially from the owner's for the same ASIN
  (e.g. `B0BXYKQBDC`: owner 2.05–2.32 M vs sandbox 2.74 M chars): Amazon is
  serving a different PDP variant (geo/session), so the sandbox **cannot
  reproduce or refute** the owner's `partial` cause. It only re-confirms that
  when a full buybox is present in static HTML, the parser extracts the fields.
- `description` was empty in 3 of 4 sandbox parses (features present in all):
  description appears to be commonly absent from static PDP HTML for these
  layouts, independent of status.

## What Gate 1 still needs (session 2)

1. Expanded outcome fields (`fieldsChanged`, `missingDetailFields`) — enabled
   by Step 1a.1's one-line JSON log; re-save a small targeted set: the two
   repeat-deterministic ASINs (`B0BXYKQBDC` partial, `B0FLCP2X8L` complete)
   plus **search-page** saves (session 1 was deals/category only, and the
   search-card parser supplies a different starting field set).
2. Chrome version + connection type recorded with the run.
3. Owner's check of the saved rows themselves (History/Preview) for a
   `complete` save — do brand/seller/BSR actually show for e.g. `B0GKMCP4JY`?
   This separates "merged but not seen" from "never merged".

---

## Session 2 (2026-10-20, zip build `b73db24`, one-line JSON outcomes)

Source: full JSON outcome lines supplied by the owner from the unpacked zip
build in Chrome on amazon.com (deals pages; the expanded save-job lines all
show `pageType: 'category'`, `triggeredBy: 'context-menu'` for the tail of the
session). Chrome version still not recorded. The two ASINs requested by name
in session 1's follow-up were not in this batch; two session-1 ASINs repeat
with the same status (`B09BD8GZ8L`, `B0DDCQ534S` — both `partial` again).

### Totals (42 enrichment outcomes)

| Outcome | n | Notes |
|---|---|---|
| `failed` — `captcha` | 2 | The **first two attempts of the session** (`ms` 357/264 — tiny interstitial pages, HTTP 200). Both ASINs (`B00AHAWWO0`, `B07MJL8NXR`) were saved again **later in the same session and enriched successfully** (`partial`). Transient, and below the 3-strike breaker, so no `skipped` followed. |
| `failed` — `parse-failed` (fetch layer) | 1 | `B0CBTZSS9F`, HTTP 200, `ms` 2317, no `htmlBytes` (rejected inside `fetchPdpHtml`). Candidates by code: non-HTML content type, declared/decoded size > 3,000,000, or body-read error. **Not yet distinguishable** — session 2's log carried no fetch `message` (Step 1a.2 adds it). Timing (2.3 s, like full-size reads) is consistent with the size cap but does not prove it. |
| `complete` | 14 | 36% of the 39 parsed |
| `partial` | 25 | 64% of the 39 parsed (session 1: 39% — different sample, same order of problem) |

- `htmlBytes` (parsed outcomes): 1,779,497 – **2,853,572** (95% of the cap).
- Enrichment wall time: ~1.8–4.0 s per parsed save.
- No `skipped`, no `asin-mismatch`, no `row-missing`, no currency mismatch.

### Field pattern — the buybox family is the story

Per-field, across the 39 parsed outcomes (`fieldsChanged` = merged from the
PDP; `missingDetailFields` = still empty on the row **after** merge, i.e.
neither card nor PDP supplied it):

- **Almost always delivered by enrichment:** `brand`, `bestSellersRank` (38/39
  changed), `rating`, `reviewCount`, `imageUrl`, `features` (39/39), and
  `availability` in most. So for a typical save the row *does* gain the PDP's
  brand/BSR/features — enrichment is functioning.
- **The `partial` fingerprint:** in the overwhelming majority of partials,
  `missingDetailFields` contains `discountPercentage`, **`seller`**,
  **`delivery`** and `pastMonthSales` *together*, and `fieldsChanged` never
  contains them. `partial` itself means the parsed detail's `price` was
  `null` (title is mandatory for a parse). Price + discount + seller +
  delivery + monthly-sales are exactly the **buybox/offer block** of a PDP:
  in the HTML the owner's cookieless fetch receives, that block is either
  absent or not matched by the current selectors, while the rest of the page
  (title/brand/reviews/BSR/features) parses fine. The listing price the user
  saw survives on the row (fill-only policy), so `price` does not appear in
  `missingDetailFields` — the visible blanks are Seller / Delivery /
  Discount / Monthly Sales.
- **Rarely delivered by anyone, regardless of status:** `badge` (missing in
  39/39 — the PDP parser never sets it and these cards didn't either),
  `coupon` (changed once), `dealBadge` (never), `warrantyDescription*`
  (present in 5), and `description` (missing in most outcomes including 11 of
  14 `complete`). This matters for the Phase 2A core-set decision: a
  "complete = no core field missing" rule that includes `description` would
  reclassify nearly every save as partial.
- Three `complete` outcomes still lack `availability`; one lacks `seller`.
  "Complete" (title+price) materially overstates completeness, as §5.3 said —
  but field data now shows which fields can honestly be required.
- Same-ASIN cross-check with the sandbox probe (session 1 doc): the sandbox's
  US-variant parse of `B09BD8GZ8L` extracted seller + delivery; the owner's
  browser parse of the same ASIN (twice) extracted neither. Same parser,
  different served HTML — the fetched variant, not buybox parsing in the
  abstract, is the variable.

### Updated verdicts

| # | Verdict now |
|---|---|
| H1 fetch refusal | **Occasional, transient** (2/42, both self-recovered on manual re-save). Not the systemic cause. No automatic retry exists today; a captcha'd save stays card-only unless the user re-saves. |
| H2 size cap | **Possibly 1/42** (the fetch-layer `parse-failed`); plus a 2.85 MB success at 95% of the cap. Needs the fetch `message` (Step 1a.2) to settle. A 3 MB → 5 MB alignment (2B) is cheap insurance either way. |
| H4 sparse static parse | **Confirmed, narrowed:** the static HTML the cookieless fetch receives frequently yields no parseable buybox family (price/discount/seller/delivery/monthly-sales). Open sub-question: nodes *absent* from that HTML (→ only a live-page read can get them: Phase 3 territory) vs *present but unmatched* by current selectors in this variant (→ Phase 2E selector work). `detailPresentFields` (Step 1a.2) + a from-the-PDP-itself save of the same ASIN (live-DOM parity) distinguishes them. |
| H5/H7/H8/H3 | Still refuted/not observed. |
| H0 genuine absence | Likely for `badge`/`coupon`/`dealBadge`/often `description`/`warranty` on these PDPs; not plausible as the whole explanation for seller/delivery on retail offers the owner can see in the buybox. |

### Gate 1 — provisional decision (finalises after the micro-test below)

1. **2A (honest `complete`)** — justified by data. Proposed core set from this
   distribution: `brand, seller, availability, bestSellersRank, features`
   (deliberately **excluding** `description` — absent from most static PDPs).
2. **2B (size cap 3 MB → 5 MB)** — justified as cheap insurance (95%-of-cap
   success + one probable cap rejection).
3. **2E vs Phase 3** — pending the micro-test: if a from-PDP save of a partial
   ASIN yields seller/delivery, the live page has what the fetch lacks →
   background-tab fallback (Phase 3 / Gate 2) is the structural fix; if the
   live parse also lacks them, it is selector work (2E) on a shared parser.
4. Not authorised by this data: header/UA variants (fetch layer is healthy),
   breaker retune (no skips), tab-side cookie fetch (unchanged rejection).

**Micro-test (session 3, 3 saves):** with Step 1a.2's build — (a) re-save
`B0CBTZSS9F` (reads the fetch `message`); (b) re-save any one fingerprint
`partial` ASIN from its card (reads `detailPresentFields`); (c) open that same
ASIN's PDP and right-click-save **on the PDP**, then report whether its
History row shows Seller/Delivery (live-DOM parity). Plus the Chrome version.
