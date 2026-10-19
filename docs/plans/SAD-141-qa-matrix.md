# SAD-141 — manual QA matrix

**Status: not executed.** Every row below is a browser check. None of them has
been run: the work in this epic was done without a browser, and nothing in the
SAD-141 comments claims otherwise. This file exists so that SAD-293 can be filled
in line by line — the rule is that every row ends with an explicit result, never
a silent omission.

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

## Not covered anywhere yet

- Firefox: the manifest and the offscreen fallback are untested in a real profile.
- A page that reuses card DOM nodes for *different* products (virtualised lists
  that recycle elements) — the ASIN-keyed map would keep a stale button until the
  next mount.
- Multiple Amazon tabs saving at once (unit-tested for isolation, never observed).
