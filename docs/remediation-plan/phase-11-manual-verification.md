# Phase 11 — Manual Browser Verification & Release Checklist

**Issues addressed:** the 7 items the investigation could not verify in the sandbox
**Estimated effort:** Medium · **Prerequisites:** all code phases complete · **Blocks:** release

The sandbox has no browser binary, so seven findings were resolved by type contract, control-flow
reading and code inspection rather than by execution. **None of them can be closed by a test in this
repository.** Each is a discrete, time-boxed check below; record the result against each item.

Two of them (items 1 and 2) can invalidate a fix that has already been written, so they should be run
early — ideally as soon as their phase lands, not deferred to the end.

---

## Setup

```bash
cd /home/user/PPHunt
npm ci
npm run verify          # tsc, vitest, wxt build, audit — all must be green
```
Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select
`dist/chrome-mv3`.

Open two DevTools windows and keep them running for every check:
- the **service worker** console (`chrome://extensions` → PPHunt → "Inspect views: service worker")
- the **side panel** console (right-click the panel → Inspect)

Note the environment deviation: the sandbox runs Node 20.20.2 while `wxt@0.21.4` declares
`engines.node >= 22` (`EBADENGINE` warnings on install). CI uses Node 22. If any check below behaves
differently from CI, confirm the local Node version first.

---

## Item 1 — H‑2: does `scripting.executeScript({files})` accept a slash-less path?

**Why it matters.** Phase 2 Step 2.5 corrected `'content-scripts/amazon.js'` →
`'/content-scripts/amazon.js'` on the strength of WXT's generated type contract
(`.wxt/types/paths.d.ts:9`) and the `TS2820` error. Chrome may in practice have tolerated the old
value, in which case the *path* half of H‑2 was a type-only defect. The **control-flow half is real
regardless** — the nested `try` meant any `executeScript` rejection skipped the DOM-bridge fallback —
so the restructuring stands either way. Record which half was load-bearing.

**Steps**
1. Open an Amazon search page. Start a collection, let it collect a few products, then **Pause**.
2. In `chrome://extensions`, click PPHunt's **reload** button. This orphans the content script in the
   already-open tab while leaving the tab alive — exactly the condition the recovery path exists for.
3. Return to the side panel and press **Start** (or Resume).
4. Watch the service-worker console.

**Pass:** recovery succeeds, products resume, and no `SCRIPT_DISCONNECTED` error modal appears.
**Also verify the fallback path:** temporarily point `files` at a nonexistent path in a scratch build
and confirm the `func`-based DOM bridge now runs and recovery still succeeds. Before Phase 2 it did
not — the outer `catch` swallowed the injection failure. That is the behavioural change to confirm.

---

## Item 2 — M‑5 / Step 7.2: table virtualisation geometry

**Why it matters.** jsdom performs no layout, so `offsetHeight`, `getBoundingClientRect` and
`border-collapse` row-height resolution are unavailable. `ProductTable.tsx` virtualises inside a real
`<table>` using `ROW_HEIGHT = 52` as a constant `estimateSize()` and `<tr><td style={{height:N}}/></tr>`
spacers. In a collapsed-border table a specified height is a **minimum**, so any cell taller than 52 px
makes the real row height diverge from the estimate and the spacer arithmetic drift.

**Steps**
1. Collect ~1,000 products, deliberately including listings with very long keyword-stuffed titles,
   stacked price/discount cells and multi-line availability strings.
2. Open the Preview overlay and scroll the full range, slowly, then fast, then back up.

**Pass:** no blank gaps, no content jumping as rows enter the viewport, no cumulative offset drift by
the end of the list, spacers never visibly misaligned, and the horizontal scrollbar behaves.
**Fail → apply Step 7.2 remedy 1:** single-line clamp (`truncate` / `line-clamp-1` + `overflow-hidden`)
on the title, brand, availability and seller cells. Re-check. Only escalate to `measureElement` if
multi-line cells are a genuine product requirement.

**Also verify while here (Phase 7's manual gate):** column resize by drag, sorting on each sortable
header, select-all and per-row select, row numbers staying correct after sort/filter/delete, and
thumbnail rendering.

---

## Item 3 — H‑9: real-DOM parser timings

**Why it matters.** Phase 5's measurements were taken in JSDOM, which is typically 5–20× slower than a
native DOM. The per-card cost (~5–7 ms) and the linear scaling are the reliable parts; the absolute
milliseconds (2.34 s for 480 cards complete, 3.31 s incomplete) are an upper bound.

**Steps**
1. Open an Amazon search page with several hundred results.
2. Chrome DevTools → **Performance** → record.
3. Start a collection in **Automatic** mode; let it run to completion.
4. Stop the recording and inspect the main-thread flame chart for the content script.

**Record:** total scripting time attributable to `parseCurrentPage` / `parseSearchResults` /
`extractCardByHeuristics`; the longest single task; and whether any task exceeds 200 ms (the point at
which scrolling visibly stutters). Compare against a pre-Phase-5 recording if one was captured — if
not, capture one on the pre-change build first, which is the only way to prove the improvement.

**Pass:** no single task over ~200 ms during steady-state scrolling, and the second parse of an
unchanged document does near-zero work (confirm by watching the flame chart while the page is idle but
mutations continue from carousels).

---

## Item 4 — H‑8: MV3 service-worker termination

**Why it matters.** Phase 4 Step 4.2 added rehydration via `chrome.storage.session`. The unit test
simulates termination by re-invoking `defineBackground()`; only a real browser shows whether Chrome's
actual termination timing and the storage API behave as assumed.

**Steps**
1. Start a collection in Automatic mode on a page with several hundred results.
2. While it is running, go to `chrome://extensions` → PPHunt → click the service worker's **Stop**
   button (or "Inspect views: service worker" → close the DevTools window and wait ~30 s idle).
3. Return to the side panel and watch the counter.

**Pass:** the counter keeps advancing, products continue to be stored under the **original** sessionKey,
and the eventual History row shows the original `startedAt`, `url`, `mode` and `targetCount` — not the
`50 / manual / https://www.amazon.com/` fallbacks.

**Verify the sessionKey directly:** side panel console →
```js
(await indexedDB.databases(), null);  // or use the Application tab → IndexedDB → pphunt → products
```
Group the `products` rows by `sessionKey` in the Application tab and confirm a single run produced a
single key. Before Phase 4 it produced two, in two different formats.

**Also test:** close the collection tab mid-run and confirm the History entry is marked `interrupted`
rather than vanishing.

---

## Item 5 — M‑2: automatic mode terminates on an exhausted page

**Why it matters.** Phase 5 Step 5.3 narrowed the `countProducts` selector. The risk of that change is
**under**-counting, which would end collection early — the opposite failure mode, and one no fixture
covers.

**Steps**
1. Find a search page with roughly 120 real results.
2. Set the target to 500 (above what the page can supply) and start in **Automatic** mode.
3. Time it.

**Pass:** collection completes on its own within roughly
`maxWaitForNew / scrollInterval` = 10 ticks after the last real card, reports ~120 products, and does
not scroll indefinitely.
**Also check the under-count risk:** on a page where you know the true result count, confirm the
collected total matches it. Repeat on a **category** page, a **deals** page and a **bestsellers** page —
the narrow selector must cover all four page types, and this is the specific regression Step 5.3 could
introduce.

---

## Item 6 — M‑4 / M‑3: overlay isolation and web-accessible resources

**Steps for M‑4 (postMessage origin)**
1. Open the Page Overlay on a **non-Amazon** HTTPS page (any site — `isOverlayAllowed` permits it).
2. In that page's console:
   ```js
   addEventListener('message', e => console.log('MSG', e.origin, e.data));
   ```
3. Toggle full-width preview, then close the overlay.

**Pass:** no `PPHUNT_*` message is logged. Before Phase 6, both
`PPHUNT_SET_OVERLAY_FULLWIDTH` and `PPHUNT_CLOSE_OVERLAY` arrived with the host page's own origin
context visible.

**Steps for M‑3 (WAR narrowing)**
1. From any ordinary web page's console, attempt to fetch a **non-overlay** chunk:
   ```js
   fetch(chrome.runtime.id ? '' : '').catch(()=>{});   // get the id from chrome://extensions first
   fetch('chrome-extension://<EXTENSION_ID>/chunks/global-<hash>.js').then(r => console.log(r.status));
   ```
2. Then confirm the overlay itself still works.

**Pass:** the non-overlay chunk fetch is blocked; the overlay renders fully styled and interactive on
both an Amazon page and a non-Amazon HTTPS page. If narrowing the WAR broke the overlay, that is the
signal that Option B (a dedicated `overlay/` output directory) is required rather than Option A.

---

## Item 7 — H‑7 / Phase 8: does the generated `.xlsx` actually open?

**Why it matters.** The old code round-tripped a ZIP through `XLSX.CFB.read`/`write` and hand-wrote
DrawingML XML. The tests read the buffer back with `XLSX.read` and pass, but SheetJS is considerably
more permissive than Excel. After the `exceljs` rewrite this must be re-proven against real
applications.

**Steps**
1. Export ~200 products to XLSX with `exportImages: 'always'`.
2. Open in **Microsoft Excel** (if available) and **LibreOffice Calc**.

**Pass, all of:**
- No "we found a problem with some content" / repair prompt in Excel
- Thumbnails visible, correctly positioned inside their cells, not overlapping adjacent rows
- Header row genuinely **bold** (it was not before Phase 8 — SheetJS community does not write cell
  styles, so `ws[cellRef].s = {font:{bold:true}}` was a no-op)
- `Price`, `List Price`, `Rating`, `Reviews` are right-aligned **numbers** that sum correctly, not text
- Column widths and row heights are sane; the Image column stays compact
- A cell containing `=1+1` in a product title displays as literal text `'=1+1`, not as `2`
- Opening a 1,000-product export with `exportImages: 'auto'` completes in bounded time and shows URL
  text rather than images past the threshold

---

## Item 8 — Live Amazon selector validity (pre-existing gap, not caused by this work)

**Why it matters.** `src/lib/scraper/selectors.ts:2` claims *"Last verified: 2026-10-16"*, but the
investigation had no network access to Amazon and no recorded DOM fixtures beyond the hand-written
ones in `tests/`. Selector staleness against today's Amazon markup is therefore **entirely
unassessed**, and no amount of unit testing will reveal it.

**Steps.** For each of the ten host permissions in `wxt.config.ts:20-33`, open a search page, a
category/bestsellers page and one product-detail page, collect ~20 products, and check the Preview
table for:

| Field | What a broken selector looks like |
|---|---|
| `title`, `asin`, `url`, `price` | missing or null on most rows |
| `currency` | anything other than a 3-letter code — **this is the Phase 1 regression check** |
| `rating`, `reviewCount` | null on rows that visibly have stars |
| `imageUrl` | null on rows that visibly have a thumbnail |
| `brand`, `seller`, `availability`, `delivery` | null, or picking up unrelated page text |
| `bestSellersRank`, `pastMonthSales` | null on detail pages that display them |

**Deliverable from this item:** save the HTML of one page per type per storefront into
`tests/fixtures/` (a new directory). Every future selector change can then be verified offline against
real markup, which permanently closes the gap that made this check necessary. This is the single
highest-value durable output of Phase 11.

---

## Release checklist

Before shipping:

- [ ] `npm run verify` green locally **and** in CI, with both previously-non-blocking steps now blocking
- [ ] All eight items above run, with results recorded
- [ ] `tests/fixtures/` populated from item 8
- [ ] `dist/chrome-mv3/manifest.json` reviewed by hand: permissions, host permissions, WAR entries,
      version, name, description
- [ ] Bundle size recorded and compared against the 1.27 MB / 919.70 kB baseline
- [ ] CHANGELOG entry written, including the currency re-collection note (decision D7) and the
      notifications scope reduction (Phase 3)
- [ ] Fresh-install path tested: clear the extension's IndexedDB, load, confirm defaults are applied and
      nothing throws (this exercises Phase 3's M‑10 fallback and the first-launch `getSettings()` write)
- [ ] Upgrade path tested: install the **old** build, collect some products, change some settings, then
      load the **new** build over it and confirm products and settings survive — specifically that a
      stored `exportFormat: 'xlsx'` upgrades to `'excel'` without throwing
- [ ] Firefox: `npx wxt build -b firefox` was never exercised during the investigation, and the manifest
      uses Chrome-specific APIs (`sidePanel`, `action.onClicked`, `chrome.storage.session`). Either
      verify it loads, or state in the README that only Chrome is supported.


## Execution record — 2026-10-17 (SAD-200)

**Release not signed off. Manual execution subsequently skipped at user request (see decision below).** This record follows the ten-item Linear checklist;
the older narrative above groups those checks differently. No manual result is inferred
from a passing unit test or successful build.

| Linear checklist item | Result / evidence |
|---|---|
| 1. Live injection / recovery tolerance | NOT RUN — needs Chrome and live Amazon |
| 2. Table geometry / virtualization | NOT RUN — needs real browser layout |
| 3. Real-page performance profile | NOT RUN — needs Chrome trace on live results |
| 4. Excel Windows/macOS + LibreOffice fidelity | NOT RUN — desktop applications unavailable |
| 5. Automatic termination on short result page | NOT RUN — live run required |
| 6. Overlay isolation on host page | NOT RUN — real browser smoke required |
| 7. Keyboard + NVDA/VoiceOver | NOT RUN — assistive-technology environment required |
| 8. MV3 worker termination / restart | NOT RUN — Chrome runtime required |
| 9. Live Amazon selectors / fixture capture | NOT RUN — current storefront evidence required |
| 10. Firefox build | BUILD PASS: `npm run build:firefox`, Firefox MV2 output, 1.43 MB. Runtime loading/API compatibility NOT RUN. |

Automated baseline at `19728e6`: 341/341 tests; TypeScript zero errors;
Chrome build 1.43 MB; production audit zero vulnerabilities. Step 10.2 removed
1,655 bytes relative to its preceding Chrome build. CI was still running when
this record was prepared. The existing PPHunt PNG icons are preserved.

Also pending: Step 10.2 load-unpacked collection/export/icon smoke, independent
Step 10.1 documentation review, fresh-install/upgrade tests, and explicit decision
sign-off. Do not check these off on the strength of automated results alone.

**Export-plan correction:** the exceljs spike was rejected. The implementation
retains patched SheetJS 0.20.3 and the CFB image injector. References above to
"after the exceljs rewrite" are superseded; bold-header support and desktop-file
fidelity remain acceptance checks, not confirmed features.


## User decision — 2026-10-17

When asked how to perform the remaining real-browser and desktop checks, the
user answered **"Skip it"**. Remaining manual execution is therefore **SKIPPED
AT USER REQUEST**, not passed. The NOT RUN entries above preserve the actual
evidence history; the Firefox build-only pass remains valid.

SAD-200 is canceled as skipped, rather than marked Done. This decision does not
establish runtime compatibility, Excel fidelity, accessibility, live-selector
validity, or absence of regressions. It is not a release approval or approval
of unrelated product decisions. Independent documentation review remains open.
No application source or dependencies were changed to record this decision.
