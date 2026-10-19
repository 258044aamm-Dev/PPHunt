# SAD-141 — manual QA matrix

**Status: not executed.** Every row below is a browser check. None of them has
been run: the work in this epic was done without a browser, and nothing in the
SAD-141 comments claims otherwise. This file exists so that SAD-293 can be filled
in line by line — the rule is that every row ends with an explicit result, never
a silent omission.

The **SAD-330 detail visibility** section near the bottom was added by SAD-339
and is also entirely unrun — it is scaffolding with the steps and expected
results written down, so the run records facts rather than impressions.

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
warning, and the panel toast). Record a result as
`pass (Chrome <version>)` / `fail (Chrome <version>)` / `not run` — and if a row
fails, file it as its own issue instead of leaving it in the table.

Build with `npm run build`, load `dist/chrome-mv3` unpacked, and have the side
panel open on Preview unless a row says otherwise.

| Check | Steps and expected result | Status | Closest automated evidence |
|---|---|---|---|
| Right-click a card on a search page → Preview shows Description and Features | Open a search-results page, right-click a card image → *Save Product Details*. Expected: the row appears in Preview with **Description** and **Features** columns present; populated when the listing card carries them, empty cells otherwise — but never a missing column. | TODO | `tests/table-v9-contract.test.tsx` (default column set), `tests/save-product.test.ts` |
| Right-click on a product-detail page → same | Open `/dp/<ASIN>`, right-click anywhere → *Save Product Details*. Expected: same columns; the PDP path fills both with the page's bullet points and prose. | TODO | `tests/save-job-enrichment.test.ts`, `tests/save-product.test.ts` (PDP branch) |
| Enrichment blocked → the warning toast shows and the row survives | Open the service worker's DevTools (`chrome://extensions` → *service worker*), set Network to **Offline**, then save a card. Expected: toast reads *"Saved, but the product details could not be fetched — details may be incomplete"*, the row is in History, and Preview shows it. Nothing is rolled back. | TODO | `tests/save-job-enrichment.test.ts` (network-error path), `tests/save-job-panel-feedback.test.tsx` (the panel toast) |
| Breaker open → the save is skipped with a warning, not a failure | Pick a marketplace that challenges the connection (e.g. `amazon.cn` from outside the region), save three products, then a fourth. Expected: the fourth reports `skipped / circuit-open` with the toast *"Saved, but the product page was not fetched — details may be incomplete"*, and the row still exists. | TODO | `tests/enrichment-fetch.test.ts` (threshold → `circuit-open`) |
| A second launch does not re-migrate settings | After one save (`settingsVersion` = 1), turn **Description** off in Settings → Data fields. Close the browser, reopen, reopen the panel. Expected: Description stays off, `settingsVersion` is still 1, and nothing is flipped back on. | TODO | `tests/settings-migration.test.ts` (idempotence, `>= 1` untouched) |
| Preview shows the columns in the Sidebar and the Overview | Compare the narrow sidebar view and the wide overview (Settings → Opening mode), then `/preview.html`. Expected: all three show the same default column set, including Description and Features. | TODO | `tests/table-v9-contract.test.tsx` (`getColumnsForSettings` identity) |
| A disabled field is absent from a real CSV and XLSX export | Settings → Data fields: turn **Best Sellers Rank** and **Monthly Sales** off, save a product, export CSV and XLSX. Expected: neither header and neither value appears in either file; `ASIN`, `Currency`, `URL`, `Source`, `Collected At` are still there. | TODO | `tests/scraper-accuracy.test.tsx` (SAD-345), `tests/export-builder.test.ts` |
| Right-click inside an embedded frame reports the frame, not a miss | On a page with a sponsored/deal iframe, right-click a product inside it → *Save Product Details*. Expected: *"This product is inside an embedded frame. Open the product page to save it."* — **not** *"No product found here"*. | TODO | `tests/context-menu-registration.test.ts` (SAD-344), `tests/save-product.test.ts` |
| Right-click, wait 30 s, then click Save | Open the menu, leave it for 30 s, then click *Save Product Details*. Expected: the product saves. Then navigate to a different page and repeat → nothing is saved and the same-page guard holds. | TODO | `tests/save-target-resolver.test.ts` (SAD-341) |

### What could not be run, and why

**Every row above**, for one stated reason: the environment that wrote this
section has no browser — no Chrome, no Edge, no Playwright/Puppeteer runtime — so
"load the unpacked build and click it" was not available. Nothing here is
blocked by the code; all of it is blocked by the absence of a machine with a
browser on it.

That is recorded rather than omitted, per the rule at the top of this file. The
closest automated evidence is named per row and is exactly that — the nearest
thing to browser evidence, not a substitute for it.

## Not covered anywhere yet

- Firefox: the manifest and the offscreen fallback are untested in a real profile.
- A page that reuses card DOM nodes for *different* products (virtualised lists
  that recycle elements) — the ASIN-keyed map would keep a stale button until the
  next mount.
- Multiple Amazon tabs saving at once (unit-tested for isolation, never observed).
