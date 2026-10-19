# SAD-141 — implementation issue index

Tracking map for the revision 2 plan (`SAD-141-one-click-product-saving.md`, posted to Linear as parts 1 and 2).
All 23 issues live in project **PPHunt** (team SAD), are parented to **SAD-141**, state **Todo**, and carry one
label per phase (`sad-141-p0` … `sad-141-p6`).

| # | Issue | Title | Effort | Depends on |
|---|---|---|---|---|
| P0.1 | SAD-274 | Message contract: 6 new types across the 3 registries + sync guard | ~2 h | — |
| P0.2 | SAD-275 | Dexie v2: `snapshots` table, cascade deletes, migration test | ~2 h | — |
| P0.3 | SAD-276 | Settings: quick save behavior and auto-download | ~2 h | — |
| P0.4 | SAD-277 | Data layer: quick-save upsert, snapshots, move, history-only collections | ~4 h | P0.2 |
| P1.1 | SAD-278 | Manifest: `contextMenus`, shared match patterns, host-permission alignment | ~2 h | — |
| P1.2 | SAD-279 | Context-menu registration and click routing via `dispatchToAmazonTab` | ~3 h | P1.1 |
| P1.3 | SAD-280 | Right-click target capture and element-to-card resolver | ~4 h | P0.1, P1.1 |
| P1.4 | SAD-281 | Minimal end-to-end menu save into History plus toast | ~4 h | P0.1, P0.4, P1.3 |
| P2.1 | SAD-282 | `CardObserver`: discovery, debounce, IntersectionObserver, cleanup | ~3 h | P1.4 |
| P2.2 | SAD-283 | Card button UI: shadow DOM, six states, dark mode, accessibility | ~5 h | P1.4, P2.1 |
| P2.3 | SAD-284 | Duplicate-job prevention and job state wiring | ~3 h | P2.2, P1.4 |
| P3.1 | SAD-285 | Collection resolution: dedicated pointer, labels, no-join guard | ~4 h | P0.4, P1.4 |
| P3.2 | SAD-286 | Settings UI plus Current badge and Make current | ~4 h | P0.3, P3.1 |
| P3.3 | SAD-287 | Ask Every Time dialog, `ASSIGN_SAVED_PRODUCT`, cross-collection move | ~5 h | P3.1, P3.2, P2.2 |
| P4.1 | SAD-295 | Offscreen document: entrypoint, typed client, race-safe creation | ~4 h | P0.1 |
| P4.2 | SAD-288 | Enrichment fetch guards and typed outcomes | ~5 h | P4.1, P1.1 |
| P4.3 | SAD-296 | Merge policy, `enrichmentStatus`, bounded concurrency | ~4 h | P0.4, P4.2 |
| P4.4 | SAD-289 | Job store, `storage.session` mirror, worker-restart recovery | ~4 h | P4.3 |
| P5.1 | SAD-290 | Export builder in offscreen: columns, filename, XLSX budget | ~4 h | P0.2, P4.1 |
| P5.2 | SAD-291 | Export service: download seam, blob revoke, D10 permission gate | ~4 h | P5.1 |
| P6.1 | SAD-292 | Documentation: README permissions, ARCHITECTURE flow, CHANGELOG | ~3 h | P5.2 |
| P6.2 | SAD-293 | Manual browser QA matrix and recorded results | ~5 h | P1.4, P5.2 |
| P6.3 | SAD-294 | Regression, performance, accessibility gate and epic close-out | ~3 h | P6.1, P6.2 |

## Phase gates (Linear blocking relations)

`SAD-277 → SAD-281` · `SAD-281 → SAD-282` · `SAD-284 → SAD-285` · `SAD-287 → SAD-295` ·
`SAD-289 → SAD-290` · `SAD-291 → SAD-292`

## Conventions used in every issue

- **Goal** — the single outcome, one paragraph.
- **Tasks** — unchecked checklist, each item names the file it touches.
- **Acceptance criteria** — observable behaviour, not implementation detail.
- **Depends on** — issue identifiers, mirrored by the phase gates above.
- Exit gate for the phase as a whole: `npm run verify` plus `npm run check:dead-exports`
  (the second is **not** part of `verify`).

## Facts worth re-checking while implementing

- `amazon.co.za` is in `AMAZON_MARKETPLACE_DOMAINS` (`utils/amazon-url.ts:15`) and `currency.ts:28`
  but in neither `AMAZON_MATCH_PATTERNS` (`amazon.content.ts:19`) nor `host_permissions`
  (`wxt.config.ts:31`). Verified again on 2026-10-19; fixed in P1.1.
- `host_permissions` lists 10 marketplaces, the content script matches 22 — so
  `dispatchToAmazonTab()`'s `scripting.executeScript` re-injection (`handler.ts:126`) fails after an
  SW restart on the other 12. Same fix.
- `addProducts()` dedupes by `(sessionKey, asin)` against existing rows and is fill-only — hence the
  separate `upsertProductFromQuickSave()` for volatile refresh (P0.4).
- `getActiveSession()` returns the newest `collecting`/`paused` session globally and
  `hydrateActiveCollection()` falls back to it — hence "no `sessions` row" for one-click collections
  (P0.4, P3.1, and `tests/quick-save-collection-lifecycle.test.ts`).
- `deleteHistory()` already tolerates a missing session row (`db/history.ts:49`).
- `<base href>` injection before offscreen parsing is **inert** with today's parsers: a jsdom probe
  returns `imageUrl: null` for relative `src` with *and* without the tag, and `asin`/`price`/`title`
  are unaffected. Keep it as insurance only; do not treat it as a fix.
- `HistoryEntry` already renders `max(entry.collectedCount, live count)`; the completion handler still
  uses `active.lastCollectedCount` (`handler.ts:387`) — P3.1 switches that to `getProductCountBySession`.

## Open decision

**D10** — ship `downloads` (deterministic, one install-time warning) or the no-permission offscreen
anchor path (unverified without a user gesture). Recorded as a gate inside **SAD-291**; do not
pre-commit to either side.

## Progress

All completed work sits in **In Review** (not Done) until the epic's browser QA in `SAD-293` confirms
it on live Amazon; `SAD-294` closes the epic. One issue is in review at a time.

| Issue | State | Commit | Automated evidence |
|---|---|---|---|
| P0.1 `SAD-274` | In Review | `0226e7f` | tsc clean · 426/49 · build 1.76 MB · dead-exports clean |
| P0.2 `SAD-275` | In Review | `0e1233c` (`e230d48` test nit) | tsc clean · 433/50 |
| P0.3 `SAD-276` | In Review | `c100d9b` | tsc clean · 440/51 · `npm run verify` green · audit 0 |
| P0.4 `SAD-277` | In Review | `216e8a6` | tsc clean · 461/52 · build 1.76 MB |
| P1.1 `SAD-278` | In Review | `a5699b4` | tsc clean · 469/53 · manifest: 23 Amazon hosts, `contextMenus` |
| P1.2 `SAD-279` | In Review | `f6dff5f` | tsc clean · 485/54 · 16 registration tests |
| P1.3 `SAD-280` | In Review | `0522884` | tsc clean · 502/55 · 17 resolver tests, incl. parser agreement |
| P1.4 `SAD-281` | In Review | `0441fdc` | tsc clean · 533/58 · build 1.77 MB · 14 pipeline tests |
| P2.1 `SAD-282` | In Review | `2c2b41d` | tsc clean · 548/59 · 15 observer tests (churn, IO, teardown) |
| P2.2 `SAD-283` | In Review | `94e7642` | tsc clean · 568/60 · 20 button tests (states, a11y, cleanup) |
| P2.3 `SAD-284` | In Review | `1fcc22d` | tsc clean · 584/62 · build 1.79 MB · 14 layer tests, dedupe + unlock |
| P3.1 `SAD-285` | In Review | `c56d22b` | tsc clean · 595/62 · 11 resolution tests (reuse, new, ask, no-join) |
| P3.2 `SAD-286` | In Review | `8a8cdda` + `315f1c0` | tsc clean · 605/62 · 6 UI tests + 5 helper tests |
| P3.3 `SAD-287` | In Review | `a0866f3` | tsc clean · 637/67 · build 1.80 MB · 32 tests (move, answer, dialog) |
| P4.1 `SAD-295` | In Review | see below | tsc clean · 675/69 · build 1.83 MB · 36 tests (parse, blob, create race) |

Baseline has moved 385/48 → **675/69** (+290 tests, +21 files). The behaviour is selectable in the
panel, the current collection is visible and editable in History, the Ask dialog can move a saved row
between collections without losing its snapshots, and both entry points write through one pipeline
into a history-only collection that cannot adopt a full-page run. The offscreen document exists and is
race-safe, so parsing and blob minting have somewhere to happen. **P4.2 (`SAD-288`) is next**: the
enrichment fetch guards that feed it. No issue is marked Done: the acceptance criteria that need a browser are deferred to
`SAD-293`, and every completion comment says so explicitly.

## Ticket hygiene

The 23 planned issues are `SAD-274` … `SAD-296`. `SAD-297` … `SAD-302` were created in error while
resuming the session (they duplicated P4.4, P5.1, P5.2 and P6.1–P6.3) and are **archived** — the
live set is unchanged. Nothing references the archived numbers.
