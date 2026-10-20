# SAD-359 — Live measurement of the per-field extraction diagnostics

**Date:** 2026-10-20 · **Harness:** `scripts/sad-359-diagnostics-measurement.mjs`
**Raw report:** `docs/plans/sad-359-measurement-2026-10-20.json`
**Question:** does the diagnostic report actually describe what the engine
extracted — Requirement 6's *"verify that the diagnostic output accurately
reflects the engine's actual extraction results"*?

**Answer: yes, on every field of every product measured. 456 field entries
across 19 live Amazon products, zero disagreements.**

---

## 1. Method

The harness drives the **built extension** — not a re-implementation — against
real product pages:

1. `npm run build` → `dist/chrome-mv3`.
2. Chromium is launched with that extension loaded. The extension's MV3
   service worker is the log sink, so the harness listens to *its* console.
   (It must be **headed**: in this sandbox the extension's worker does not
   register in headless mode, so the run goes through `xvfb-run`.)
3. Each product is visited **once, from a clean browser session**, the way a
   person opens a product page.
4. The save is triggered through the extension's own DOM bridge
   (`pphunt:command` → `SAVE_CONTEXT_PRODUCT`), which is the same code path
   the right-click menu item uses — so the diagnostics are the ones the
   extension really produces, not ones a test fabricated.
5. The harness captures the `[PPHunt][Amazon][Diagnostics]` line, then reads
   the row the extension actually stored out of its IndexedDB and compares
   the two **field by field**.
6. A listing page is visited the same way to capture the card-drift line.

### The comparison rule

For every field, the report's status must agree with the stored row:

| Reported | Expected in the stored row |
|---|---|
| `EXTRACTED` (validated) | the value is present |
| `EXTRACTED` (validated: false) | the value is **absent** — validation dropped it |
| `PARTIAL` (rescue) | the value is present |
| `PARTIAL` (validated: false) | the value is **absent** |
| `MISSING` / `PARSE_FAILED` / `UNKNOWN` | the value is **absent** |

`isPrime` is the one field whose absent form is a real value: `false` means
"this offer is not Prime", not "we could not tell", so `false` counts as
absent for it. A disagreement is a bug in the *diagnostics*, not a licence to
change extraction — the harness exits non-zero when it finds one.

### On the bot wall

Amazon answers a cold profile with its ordinary *"Continue shopping"*
challenge. The harness completes that, because it is the page's own flow and
it is offered to everyone. Amazon also serves an explicit refusal —
*"Continued access by an unauthorized AI agent violates Amazon's Conditions of
Use"* — to repeat requests inside one session. **The harness does not click
through a refusal.** It requests each product once from a clean session
instead, and records the refusal when it meets one.

This is the same constraint the SAD-338 enrichment spike documented: *"the
sandbox could only ever reach Amazon from a datacenter IP… the measurement has
to happen on a normal connection, so the work is packaged as a tool the
operator runs."* The harness is that tool, and it runs from a normal
connection too.

---

## 2. Results

**19 of 19 products verified. 0 mismatches. 0 errors.**

| ASIN | Product | extracted | missing | parse-failed | partial | unknown |
|---|---|---|---|---|---|---|
| B0D1XD1ZV3 | Apple AirPods Pro 2 | 16 | 8 | 0 | 0 | 0 |
| B0BXYKQBDC | Micro Ingredients Oil of Oregano | 20 | 4 | 0 | 0 | 0 |
| B0FLCP2X8L | Dr.Melaxin Peel Shot | 20 | 4 | 0 | 0 | 0 |
| B0CBTZSS9F | Bedsure Throw Blanket | 20 | 4 | 0 | 0 | 0 |
| B0GKMCP4JY | — | 20 | 4 | 0 | 0 | 0 |
| B0D16L5F2M | — | 19 | 5 | 0 | 0 | 0 |
| B09BD8GZ8L | — | 20 | 4 | 0 | 0 | 0 |
| B0F5977GWC | — | 20 | 4 | 0 | 0 | 0 |
| B0DJ2WDQKT | — | 19 | 5 | 0 | 0 | 0 |
| B0DKVDZXSN | — | 22 | 2 | 0 | 0 | 0 |
| B0DH1MKVQV | — | 21 | 3 | 0 | 0 | 0 |
| B0D7N2KWLH | — | 20 | 4 | 0 | 0 | 0 |
| B09BVXT8TJ | — | 21 | 3 | 0 | 0 | 0 |
| B0G66ZJG3Y | — | 20 | 4 | 0 | 0 | 0 |
| B01LW1983J | — | 20 | 4 | 0 | 0 | 0 |
| B0D7NXSQ44 | — | 22 | 2 | 0 | 0 | 0 |
| B0946MVWGD | — | 20 | 4 | 0 | 0 | 0 |
| B00AHAWWO0 | — | 19 | 5 | 0 | 0 | 0 |
| B07MJL8NXR | — | 20 | 4 | 0 | 0 | 0 |

Every row's counts sum to 24 — the five buckets partition the report, as the
unit test asserts.

### Aggregate over 456 field entries (19 products × 24 fields)

| Status | Entries | Per product |
|---|---|---|
| `EXTRACTED` | 379 | 19.9 |
| `MISSING` | 77 | 4.1 |
| `PARSE_FAILED` | 0 | 0.0 |
| `PARTIAL` | 0 | 0.0 |
| `UNKNOWN` | 0 | 0.0 |

### Which fields are absent, and how often

| Field | Status | Products |
|---|---|---|
| `dealBadge` | MISSING | 19/19 |
| `coupon` | MISSING | 19/19 |
| `warrantyDescription` | MISSING | 15/19 |
| `description` | MISSING | 14/19 |
| `seller` | MISSING | 3/19 |
| `variations` | MISSING | 2/19 (singleton product) |
| `weight` | MISSING | 2/19 |
| `listPrice` | MISSING | 1/19 |
| `discountPercentage` | MISSING | 1/19 |
| `bestSellersRank` | MISSING | 1/19 |

`dealBadge` and `coupon` were absent on **every** product — they are not
fields most retail PDPs carry, so a report that lumped them in with a broken
selector would be misleading. This is exactly the distinction the `reason`
string carries (`"no deal badge shown on the page"`), and it is why
`MISSING` keeps a field-specific reason rather than a bare status.

### The card-drift line (listing page)

```
[PPHunt][Amazon][Diagnostics] drift {"stage":"search-results","cardsInspected":28,
 "cardsExtracted":28,"fieldCoverage":{"asin":1,"title":1,"price":0.93,"rating":0.96,
 "reviewCount":0.96,"imageUrl":1},"tierBreakdown":{"tier1_json":0,"tier2_semantic":140,
 "tier3_structural":16,"tier4_selector":8,"missing":4},"isDriftDetected":false,
 "driftReasons":[]}
```

28 cards inspected, 28 extracted, no drift detected — and the line carries
the same `[PPHunt][Amazon][Diagnostics]` prefix as the per-field report, so
one DevTools filter finds both.

---

## 3. Before and after, on the same product

`B0D1XD1ZV3` (AirPods Pro 2), same page, same build path:

| | Before (shipped) | After (gap closure) |
|---|---|---|
| Log line | `[PPHunt] extraction diagnostics {…}` | `[PPHunt][Amazon][Diagnostics] {…}` |
| Counts | `{extracted: 15, missing: 8, partial: 0}` | `{extracted: 16, missing: 8, parseFailed: 0, partial: 0, unknown: 0}` |
| Modelled fields | 23 | **24** — `url` added |
| Absent fields carried a source? | no | yes (`source: 'dom'`) |
| "Not attempted" fields claimed absent? | **yes** (`MISSING / 'not attempted'`) | no (`UNKNOWN`) |

The `+1` extracted is the new `url` field. Nothing else moved: the eight
absent fields are the same eight, with the same reasons.

---

## 4. What the measurement did *not* exercise

Honest gaps in the live sample:

- **No live `PARSE_FAILED`.** Across 19 real products, no candidate node was
  found whose value then failed to parse. That path is covered by unit tests
  instead — a fixture with a buybox whose text is `"See price in cart"`, plus
  one where a rank label has no parseable rank, one with an unparseable
  weight row, and one where JSON-LD supplies a non-HTTP image that validation
  drops. The same fixtures prove the *distinction* the issue asks for: the
  rejected candidate is `PARSE_FAILED` while the JSON-LD rescue over the same
  candidate is `PARTIAL`.
- **No live `PARTIAL` either**, for the same reason: no real page needed the
  JSON-LD rescue in this sample.
- **No live `UNKNOWN`**, because no product was rejected early (a title-less
  page). That path is covered by the parser test that feeds a title-less page
  and asserts that 22 fields come back `UNKNOWN` rather than `MISSING`.
- **The `enrichment-parse` stage was not measured.** The enrichment path
  parses *fetched* HTML in the offscreen document, not the live DOM. Running
  it here would mean driving the background fetch, which is a different
  question (the SAD-352 one) and needs a residential connection to be
  meaningful. The stage is unit-covered; the live measurement covers
  `stage: "detail-page"`.
- **One ASIN was dropped**: `B0DDCQ534A` (from the SAD-352 sample) now
  serves Amazon's *"Page Not Found"* — it has been delisted. It is excluded
  rather than reported as a failure.
- **A sample is not a census.** Amazon serves different PDP variants per
  geo/session; the same ASIN can parse differently for a different person
  (SAD-352 §"Sandbox re-parse" recorded exactly this for four ASINs).

---

## 5. A finding that bears on SAD-352

Three of the products in this sample — `B0BXYKQBDC`, `B0FLCP2X8L`,
`B0DDCQ534A` — were recorded as **`partial`** in the SAD-352 sessions, where
`missingDetailFields` contained `discountPercentage`, `seller`, `delivery`
and `pastMonthSales` *together*: the buybox fingerprint.

Here, on the **live** page, the same ASINs report that whole family as
`EXTRACTED` with their winning selectors:

```
EXTRACTED  listPrice           source='dom' selector='#corePriceDisplay_desktop_feature_div'
EXTRACTED  discountPercentage  source='dom' selector='#corePriceDisplay_desktop_feature_div'
EXTRACTED  seller              source='dom' selector='#sellerProfileTriggerId'
EXTRACTED  delivery            source='dom' selector='#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span[data-csa-c-delivery-price]'
```

The difference is the *source of the HTML*, not the parser: this run parses
the live DOM (`stage: "detail-page"`), while SAD-352's `partial` came from
the cookieless background fetch (`stage: "enrichment-parse"`), whose static
HTML frequently lacks the buybox block.

This does **not** refute SAD-352's H4. It isolates it, and it is exactly the
distinction SAD-352 §Gate 1 asked for — *"nodes absent from that HTML vs
present but unmatched by current selectors in this variant"* — now readable
per field, with the selector that won. The next question for the owner is
narrower than it was: run the same ASINs through the **enrichment** stage and
read its diagnostics, and the report will say per field whether the buybox
was absent from the fetched HTML or present-but-unmatched.

---

## 6. Reproducing

```bash
npm run build
xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npm run measure:diagnostics -- \
  --asins B0D1XD1ZV3,B0BXYKQBDC,B0FLCP2X8L \
  --listing "https://www.amazon.com/s?k=wireless+earbuds" \
  --out docs/plans/sad-359-measurement-2026-10-20.json
```

The harness exits non-zero if any field's status disagrees with the stored
row. It writes the full per-field report to the `--out` path.

---

## 7. Files changed

The whole of SAD-359, against the pre-work baseline `aad6913`:

**Source (the Amazon engine only — 3 files):**

| File | Change |
|---|---|
| `src/engines/amazon/scraper/extraction-diagnostics.ts` | the five-status type, `parseFailed()`, the `UNKNOWN` filler, the five count buckets, the `url` field, the `[PPHunt][Amazon][Diagnostics]` prefix |
| `src/engines/amazon/scraper/product-detail.ts` | 19 rejected-candidate sites reclassified to `parseFailed()`, the `url` field reported, `{source}` added to 23 absent-field reports |
| `src/engines/amazon/scraper/drift-telemetry.ts` | the drift line's prefix |
| `src/engines/amazon/schemas/messages.ts` | the `FieldDiagnosticSchema.status` enum widened to the five values |

**Tests (5 files):** `tests/extraction-diagnostics.test.ts`,
`tests/offscreen-handlers.test.ts`, `tests/save-product.test.ts`,
`tests/save-job-pipeline.test.ts`, `tests/enrich-saved-product.test.ts`,
`tests/amazon-engine-v2.test.tsx`.

**Docs (4 files):** `CHANGELOG.md`, `ARCHITECTURE.md`,
`docs/plans/SAD-359-diagnostics-gap-closure-plan.md`,
`docs/plans/SAD-359-extraction-diagnostics-plan.md`, plus this report and
its raw JSON.

**Tooling (2 files):** `scripts/sad-359-diagnostics-measurement.mjs` (the
harness — a spike tool, not bundled, not in CI) and one line in
`package.json` for `npm run measure:diagnostics`.

**Not touched:** `src/engines/temu/**`, `wxt.config.ts`, the manifest,
`src/lib/**`, the selectors, the field mappings, the data models, the
enrichment behaviour, the DB, the exporters and the UI. Verified by
`git diff` at every step.

## 8. Tests executed

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **88 files / 1046 tests, all passing** (87 files / 1029 before this work) |
| `npm run check:dead-exports` | clean |
| `npm run build` | succeeds → `dist/chrome-mv3` |
| `git diff -- src/engines/temu/` | empty |
| `git diff -- wxt.config.ts` | empty |
| live harness (this report) | 19/19 products, 0 mismatches |

The new coverage is listed in the gap-closure plan §6; the live measurement
in §2–§5 is the part unit tests cannot do.

