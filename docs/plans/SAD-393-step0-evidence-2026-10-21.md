# SAD-393 — Step 0 evidence (2026-10-21)

Branch `fix/sad-393-warranty-badge` from `main` @ `2ec7eaf`. Plan:
`docs/plans/SAD-393-warranty-badge-plan.md` (§4 holds the planning-pass
captures; this file completes Step 0 and records the gate outcomes that
Steps 1–6 may build on). Capture tool: moli 1.1.18 (`moli fetch` rendered
DOM; `--disable-js` where noted), amazon.com unless stated. Survey scripts:
plan Appendix A.

## Owner decisions (2026-10-21, before Step 0)

| Gate | Decision |
|---|---|
| Scope | Amazon only · all workflows · fix `badge` (`dealBadge` measured working) · Steps 0–5 + 7 **plus Step 6a** |
| G1 badge text | Label only (`Best Seller`); supplementary category text is not stored |
| G2 fractional warranty | Store `1.5-year` (Raw always kept) |
| Branch base | From `main`; reconcile with SAD-387 when it lands |
| G6 / Step 6a | **Adopted:** `brand-and-rank` merges also fill the warranty pair (fill-only) from the already-fetched PDP. Fetch *eligibility* and request volume must not change. (6b PDP-badge / 6c read-time healing: **not adopted**.) |

## Badge — live breadth (search, first 30 cards each)

Planning-pass searches (earbuds/yoga/board games: 11 badged cards) are in
plan §4.3. Two more in Step 0, same method:

| Query | Badged | Old markup (`Overall Pick`) | rio capsule (`Best Seller`, `data-csa-c-content-id=BEST_SELLER`) |
|---|---|---|---|
| `coffee+maker` | 6 | 1 | 5 |
| `lego` | 2 | 1 | 1 |

**Population across 5 searches: 19 badged cards — Overall Pick 5 (all old
markup, all extract today), Best Seller 14 (all rio, all lost today).** No
other badge text and no other capsule `content-id` was observed, so Step 1
ships exactly the proven vocabulary/containers and nothing invented
(Amazon's Choice / New Release phrases stay in the existing vocabulary for
the old markup, unchanged).

- **Server-rendered, not JS-built:** a `--disable-js` earbuds dump contains
  the rio markup (`rio-badge-label` ×6, `amazonBadges` ×18). The Step 3 cache
  issue is therefore about *parse timing* (lazy card injection across
  collection passes), not badges appearing by hydration inside an
  already-parsed card — its live frequency remains unproven, the unit-level
  staleness (plan P-B4) stands, and Step 3 ships in its guarded form.
- **Category/deals card families:** Best Sellers (kitchen) renders **no**
  status badge in either markup (only `zg-bdg-text` rank, which is BSR) —
  honest absence for `parseAmazonCategoryCard` there. A `/deals` sample
  returned nothing from moli in this sandbox (recorded as failed capture,
  not evidence). No badge was found on any sampled PDP (8 PDPs incl.
  planning pass) — consistent with G5 staying closed.

## Warranty — Amazon Devices gate G3: CONFIRMED ×3

Same family shape on three devices — labelled row in
`table.a-bordered < div.content-grid-block < … < div#tech` (ancestry verified
from full-page dumps; only `#productOverview_feature_div` of today's 11
containers is even present):

| ASIN | Label (verbatim) | Value (verbatim, first sentence) | Expected token after fix |
|---|---|---|---|
| Kindle Paperwhite `B0CFPJYX7P` | `Warranty and Service` | `1-year limited warranty and service included. Optional 1-year, 2-year or 3-year…` | `1-year` |
| Echo Dot 5th Gen `B09B93ZDG4` | `Warranty and service` | `90-day limited warranty and service. Optional 1-year, 2-year, and 3-year…` | `90-day` |
| Fire TV Stick `B0C6W3D4RM` | `Warranty and service` | `90 day limited warranty and service included. Optional…` | `90-day` (rows-surveyed; Kindle/Echo fixtures carry the family) |

First-duration-wins keeps the *included* term on all three (the optional
extensions stay in Raw). G3 is therefore open for exactly: **container
`#tech`** + **label family `Warranty and Service`** (case-insensitive pattern
already). No other label/container has a captured occurrence — the
P-W1/P-W3 probe shapes (`Limited Warranty`, div-rows, `#aplus` rows) remain
unproven and **do not ship** (falsification rule).

## Non-.com: no evidence (G4 stays closed)

amazon.co.uk returned an empty shell and amazon.de a `Tut uns Leid!` page
to moli from this sandbox (0 cards both). English-only matching stays, per
SAD-349; the extension points (`AMAZON_WARRANTY_LABEL_PATTERN`, badge
vocabulary) remain single and documented.

## Fixtures (`docs/plans/SAD-393-fixtures/`, all verbatim real markup)

| File | Source | Proves |
|---|---|---|
| `search-card-rio-bestseller-deal.real.html` | SAD-387 branch captured card (`B0725WFLMB`) | rio Best Seller + printed deal on one card |
| `search-card-overall-pick.real.html` | earbuds search dump (`B0HDB173YV`) | old-markup badge parity |
| `pdp-kindle-warranty-table.real.html` | Kindle PDP dump | G3 family (`#tech` wrapper in tests) |
| `pdp-echo-warranty-table.real.html` | Echo Dot PDP dump | G3 lowercase label + 90-day first-wins |
| `pdp-dewalt-warranty-table.real.html` | Dewalt PDP dump | positive control (`3-year`) |
| `pdp-tozo-warranty-table.real.html` | TOZO PDP eval outerHTML | negative: cell says `TOZO`, no duration |
| `baseline-parse.json` | current parsers over the above (temp probe, deleted) | step-7 A/B baseline |

**Baseline outcomes (current code, matches live):** rio card
`badge=undefined, dealBadge="Limited time deal"` · Overall Pick card
`badge="Overall Pick"` · Kindle/Echo `warranty=undefined` (✗ — page states a
term) · Dewalt `3-year` ✓ · TOZO `undefined` (honest).

## Still needed from the owner

Example ASINs/URLs + marketplace where Warranty/Badge visibly exist but
PPHunt shows `No` (none on the issue). Population-level causes are proven
above; §10 acceptance keeps owner cases as a final checklist item.
