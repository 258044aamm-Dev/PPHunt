# SAD-141 — manual QA matrix

**Status: partially executed.** The **SAD-330 detail visibility** section below
has real results from a Chromium 131.0.0.0 run (Playwright driving the unpacked
build against a local fixture). Every other table is still `TODO`: those rows
need live Amazon or native browser UI that automation cannot reach.

The rule is unchanged — every row ends with an explicit result, never a silent
omission.

The **SAD-330 detail visibility** section near the bottom was added by SAD-339.
Its rows that do not need native browser UI were executed; each one says how.

Legend

- **Auto** — the behaviour is covered by an automated test (file named); that is
  *not* a substitute for the manual check, only the closest evidence that exists.
- **TODO** — must be run by a human in Chrome and Edge and recorded with the
  browser version.

## How to run

```
npm run verify                 # tsc + vitest + build + npm audit
npm run check:dead-exports     # not part of verify
```

Load `dist/chrome-mv3` as an unpacked extension, open an Amazon page, and work
through the tables. Record `pass` / `fail` / `not run` plus the browser version
in the SAD-293 comment and in this table.

## Menu matrix

| Check | Status | Closest automated evidence |
|---|---|---|
| Item appears on a search-results page | TODO | `tests/context-menu-registration.test.ts` |
| Item appears on a deals page | TODO | `tests/context-menu-registration.test.ts` |
| Item appears on a bestsellers page | TODO | `tests/context-menu-registration.test.ts` |
| Item appears on a category page | TODO | `tests/context-menu-registration.test.ts` |
| Item appears on a product detail page | TODO | `tests/save-context-product.test.ts` |
| Item is absent on a non-Amazon page | TODO | `tests/manifest-permissions.test.ts` (pattern scope) |
| Item appears on each of the 23 marketplaces | TODO | `tests/manifest-permissions.test.ts` (list equality) |
| Native menu items are preserved (nothing removed by us) | TODO | registration only calls `remove(ourId)` |

## Card matrix

| Check | Status | Closest automated evidence |
|---|---|---|
| Button renders in light mode | TODO | `tests/card-action-button.test.ts` (styles exist, not colours) |
| Button renders in dark mode | TODO | — |
| 60-card page: one button per card | TODO | `tests/card-observer.test.ts`, `tests/card-action-layer.test.ts` |
| Infinite scroll ×3: no duplicates, new cards get buttons | TODO | `tests/card-observer.test.ts` (churn), `tests/card-action-layer.test.ts` |
| Sponsored carousel: button present, no navigation | TODO | `tests/card-action-button.test.ts` (no card link activation) |
| Card click still navigates | TODO | `tests/card-action-layer.test.ts` |
| Cart button still works | TODO | `tests/card-action-button.test.ts` (host does not cover the card) |

## Quick-save matrix

| Check | Status | Closest automated evidence |
|---|---|---|
| Double click on the same card → one job, one row | TODO | `tests/card-action-layer.test.ts`, `tests/save-job-pipeline.test.ts` |
| 10 rapid clicks across cards | TODO | `tests/card-action-layer.test.ts` (busy guard) |
| Retry after a failed save | TODO | `tests/card-action-button.test.ts`, `tests/save-job-pipeline.test.ts` |
| Service worker terminated mid-enrichment → card leaves spinner | TODO | `tests/job-store.test.ts`, `tests/save-job-recovery.test.ts` |
| Offline → save completes with a warning, row intact | TODO | `tests/enrichment-fetch.test.ts` (network error path) |
| CAPTCHA page → row intact, job reports `failed`/`skipped` | TODO | `tests/enrichment-fetch.test.ts`, `tests/enrich-saved-product.test.ts` |

## Collections

| Check | Status | Closest automated evidence |
|---|---|---|
| A — Add to Current accumulates in one collection | TODO | `tests/collection-resolution.test.ts` |
| B — New Collection per product | TODO | `tests/collection-resolution.test.ts` |
| C — Ask Every Time dialog | TODO | `tests/collection-choice-dialog.test.ts`, `tests/collection-choice-queue.test.ts` |
| C — Cancel keeps the product in its original collection | TODO | `tests/collection-choice-queue.test.ts` |
| Make current, then save again | TODO | `tests/collection-choice-queue.test.ts` |
| Delete the current collection, then save again | TODO | `tests/collection-resolution.test.ts` (stale pointer) |

## Export

| Check | Status | Closest automated evidence |
|---|---|---|
| CSV opens in Excel | TODO | `tests/export-builder.test.ts` (bytes/BOM), `tests/export-service.test.ts` |
| CSV opens in LibreOffice | TODO | — |
| XLSX opens in Excel | TODO | `tests/export-builder.test.ts` (workbook read back) |
| XLSX opens in LibreOffice | TODO | — |
| One click → exactly one file | TODO | `tests/export-service.test.ts`, `tests/toast.test.ts` |
| **D10**: offscreen `<a download>` without the `downloads` permission, Chrome | TODO | — |
| **D10**: same, Edge | TODO | — |

## Accessibility

| Check | Status | Closest automated evidence |
|---|---|---|
| Keyboard-only save (Tab to the button, Enter/Space) | TODO | `tests/card-action-button.test.ts` (native `<button>`) |
| Visible focus ring on the card button | TODO | `card-action-button.ts` `:focus-visible` rule |
| Visible focus ring in the Ask dialog | TODO | `collection-choice-dialog.ts` `:focus-visible` rule |
| `aria-live` announcements for save state | TODO | `tests/toast.test.ts` (`role="status"`, `aria-live="polite"`) |
| Dialog is announced and Escape cancels | TODO | `tests/collection-choice-dialog.test.ts` |
| `prefers-reduced-motion` honoured | TODO | `card-action-button.ts` media query |

## Performance (measured in jsdom — **not** a browser trace)

These numbers are from a throwaway benchmark run on this tree (60 cards, then
200 cards added in four batches of 50 through the real observer path). jsdom is
much slower than Chrome for DOM work, so they are an upper bound and a
regression signal, not evidence about long tasks:

| Measurement | Result |
|---|---|
| Mount 60 cards (one shadow host each) | ~240 ms |
| Add 200 cards in 4 batches | ~210 ms of work (1.81 s wall including the debounce waits) |
| Worst single batch (50 new cards + debounce) | ~61 ms of work |
| Hosts after churn | 260 — exactly one per card, no duplicates |

SAD-293 still needs the real trace: **no long task over 50 ms** while scrolling,
and memory returning to baseline after five navigations. Neither can be produced
outside a browser.

## SAD-330 detail visibility

Added for SAD-339. These rows check the *outcome* of the SAD-330 sub-issues
(default-on Description/Features, the settings migration, the enrichment
warning, and the panel toast).

**How the executed rows were run.** Playwright 1.49.1 driving Chromium
**131.0.0.0** (headless, `--load-extension=dist/chrome-mv3`, unpacked build of
`main`). Amazon URLs were served from a **local fixture** — a synthetic
search-results page with 60 cards, one card per ASIN — because this environment
cannot reach live Amazon. Fixture results are therefore evidence about the
extension's own behaviour, not about Amazon's markup. The runner **is** committed
as `scripts/browser-qa/card-flow.cjs` so the run is repeatable; it needs
Playwright, which is deliberately not a repository dependency (install with
`npm i --no-save playwright && npx playwright install chromium`).

Rows marked `not run` say what blocks them. `not run` is an explicit result, per
the rule at the top of this file.

| Check | Steps and expected result | Result | Closest automated evidence |
|---|---|---|---|
| A card save lands in Preview with Description and Features present | Click the per-card save control on a fixture card, then open Preview. Expected: the row appears and the table renders **Description** and **Features** columns — populated when the source carries them, empty cells otherwise, but never a missing column. | **pass** (Chromium 131.0.0.0, fixture) — 25 headers rendered; order `… Sponsored → URL → Description → Features → Source`; 1 product row, 1 snapshot (`source: listing`) | `tests/table-v9-contract.test.tsx`, `tests/save-product.test.ts` |
| Right-click a card on a search page → same result | Right-click a card image → *Save Product Details*. | **not run** (Chromium 131.0.0.0) — the context menu is native browser UI; Playwright cannot click it, and a synthetic `SAVE_CONTEXT_PRODUCT` message would not test the menu at all | `tests/save-product.test.ts` (resolution), `tests/context-menu-registration.test.ts` |
| Right-click on a product-detail page → same result | Open `/dp/<ASIN>`, right-click → *Save Product Details*. Expected: both columns populated from the page. | **not run** (Chromium 131.0.0.0) — same native-menu limitation, and it needs live Amazon markup to be meaningful | `tests/save-job-enrichment.test.ts` |
| Enrichment blocked → the save survives and says so | Set the network offline, then save a card. Expected: the row still exists, and the degraded state is shown. | **pass for the row, partial for the signal** (Chromium 131.0.0.0, fixture) — 1 product row and 1 snapshot written; the card control carried `data-partial="true"` from **1 ms** after the click until it reset at **2 227 ms**. The warning **toast** is not produced on the card path at all: `handleSaveJobUpdate` gates it on `pendingSaveJobId`, which only the right-click path sets. So the toast half of this row is **not run** and needs the native menu. | `tests/save-job-enrichment.test.ts`, `tests/save-job-panel-feedback.test.tsx` |
| Breaker open → the save is skipped with a warning, not a failure | Pick a marketplace that challenges the connection, save three products, then a fourth. | **not run** (Chromium 131.0.0.0) — requires live Amazon to produce real challenge responses; the fixture cannot fabricate the breaker state without editing production code | `tests/enrichment-fetch.test.ts` (threshold → `circuit-open`) |
| A second launch does not re-migrate settings | After one save (`settingsVersion` = 1), turn **Description** off, close and reopen, reopen the panel. Expected: Description stays off and nothing is flipped back on. | **not run** (Chromium 131.0.0.0) — the automated half is already covered by the migration test; the manual half needs the settings UI toggle and a real browser restart | `tests/settings-migration.test.ts` (idempotence, `>= 1` untouched) |
| Preview shows the columns in the Sidebar and the Overview | Switch the Preview view mode between **Sidebar** and **Overview**. Expected: both keep the same default column set. | **pass** (Chromium 131.0.0.0, fixture) — Sidebar 26 headers, Overview 26 headers, both containing Description and Features | `tests/table-v9-contract.test.tsx` |
| `/preview.html` shows the columns | Open the standalone preview page for the saved session. | **pass** (Chromium 131.0.0.0, fixture) — same 25 headers, same order | `tests/table-v9-contract.test.tsx` |
| The side **panel** surface shows the columns | Open the real side panel from the toolbar. | **not run** (Chromium 131.0.0.0) — `chrome.sidePanel.open()` requires a user gesture; automation cannot open it | `tests/save-job-panel-feedback.test.tsx` |
| A disabled field is absent from a real CSV and XLSX export | Turn **Best Sellers Rank** and **Monthly Sales** off, save a product, export CSV and XLSX. Expected: neither header nor value appears. | **not run** (Chromium 131.0.0.0) — the download path was not driven; the column derivation is pinned by the SAD-345 unit test | `tests/scraper-accuracy.test.tsx` (SAD-345), `tests/export-builder.test.ts` |
| Right-click inside an embedded frame reports the frame, not a miss | Right-click a product inside a sponsored/deal iframe. | **not run** (Chromium 131.0.0.0) — needs the native menu and a real Amazon page with an iframe | `tests/context-menu-registration.test.ts` (SAD-344) |
| Right-click, wait 30 s, then click Save | Open the menu, leave it 30 s, click *Save Product Details*; then navigate and repeat. | **not run** (Chromium 131.0.0.0) — native menu | `tests/save-target-resolver.test.ts` (SAD-341) |

### Card and accessibility rows that this run did cover

These belong to the SAD-141 tables above but were executed in the same run, so
they are recorded here rather than left `TODO`:

| Check | Result |
|---|---|
| 60-card page: one button per card | **pass** (Chromium 131.0.0.0, fixture) — 60 controls, 60 distinct ASINs |
| Infinite scroll ×3: no duplicates, new cards get buttons | **pass** (Chromium 131.0.0.0, fixture) — after +60 cards in three batches: 120 controls, 120 distinct ASINs, no duplicate hosts |
| Keyboard-only: Tab reaches the save control | **pass** (Chromium 131.0.0.0, fixture) — focus lands on the control's shadow host |
| No extension console errors on a listing page | **pass** (Chromium 131.0.0.0, fixture) — zero console errors once the fixture's own remote images were stubbed |

### Observations that are not failures of these rows

- **The card save control never receives the stored theme.** `data-theme` was
  `null` on every mounted control, which is exactly what **SAD-331** describes:
  the layer accepts a `theme` option that `amazon.content.ts` never passes. Not
  re-filed — SAD-331 is already open.
- **The degraded-save signal on a card lasts about 2.2 s** and then the control
  resets to idle, while the row stays in History permanently. A user who is not
  watching that card misses it. This is a UX observation, not a failure of a
  SAD-330 acceptance criterion (the panel toast from SAD-343 covers the panel
  surface); it is recorded here so the decision is explicit rather than
  accidental.

## Not covered anywhere yet

- Firefox: the manifest and the offscreen fallback are untested in a real profile.
- A page that reuses card DOM nodes for *different* products (virtualised lists
  that recycle elements) — the ASIN-keyed map would keep a stale button until the
  next mount.
- Multiple Amazon tabs saving at once (unit-tested for isolation, never observed).
