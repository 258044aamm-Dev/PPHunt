# SAD-388 — Plan only: preview table flickers and jitters while scrolling

> **Status: PLAN ONLY. No source file has been changed, nothing committed, nothing pushed.**
> This document is the only new file in the tree.
>
> Everything below labelled **FACT** was read out of this repository or out of the published
> `@tanstack/virtual-core` source. Everything labelled **INFERENCE** is reasoning that Step 0
> converts into a measurement before any code is written.

Date: 2026-10-21 · base `main` @ `2ec7eaf`

---

## 0. The ticket, and what was ruled in/out by the operator

**SAD-388** (Bug, P1, project PPHunt, state Todo, no comments):
*"The preview UI is experiencing visual flickering and jittering when scrolling up or down.
Investigate the root cause… Ensure that scrolling remains smooth and stable in both
directions without introducing regressions or affecting unrelated functionality."*

Four answers given for this plan, which together name the culprit:

| Question | Answer | What it excludes |
|---|---|---|
| Where? | **All surfaces** (side panel, full-width modal, `preview.html`) | A surface-specific layout bug — all three mount the same component |
| Which mode? | **Amazon, "Separate category sections" OFF** | The sections path, which renders every row and never virtualizes |
| Browser? | **Chrome** | Gecko/WebKit scroll quirks |
| When? | **Only with a long list, scrolling far** | Paint/CSS flicker (would show on a short list too) |

---

## 1. What the code actually does

### FACT — the row height is declared as 52 px, and so is the estimate

`src/engines/amazon/ui/table/AmazonProductTable.tsx`

```
32:  const ROW_HEIGHT = 52;
244: const virtualizer = useVirtualizer({
245:   count: rows.length,
246:   getScrollElement: () => parentRef.current,
247:   estimateSize: () => ROW_HEIGHT,      // every row is assumed to be exactly 52
248:   overscan: 10,
249: });
673: data-index={virtualRow.index}
678: style={{ height: ROW_HEIGHT }}        // height: 52px on the <tr>
702: height: totalSize - (last.end)       // bottom spacer, derived from the estimate
```

`src/engines/temu/ui/table/TemuProductTable.tsx` is the same block: `27` `ROW_HEIGHT = 52`,
`194` `estimateSize`, `413` `data-index`, `418` `style={{ height: ROW_HEIGHT }}`, `442` bottom
spacer.

### FACT — nothing ever measures a real row

`grep -rn "measureElement|measureRef" src` → **0 hits**. `grep -rn "scrollMargin" src` → **0 hits**.
So `getTotalSize()`, both spacer heights and the rendered range are all computed from the
constant `52`, never from the DOM.

### FACT — the row's content is already exactly 52 px tall, and the row adds a border

| Piece | Source | Pixels |
|---|---|---|
| Image cell `h-10` | `columns.tsx:48` (`AmazonProductTable`), `temu/.../columns.tsx:37` | 40 |
| `<td className="px-2.5 py-1.5 text-sm">` → `py-1.5` × 2 | `AmazonProductTable.tsx:670` | 6 + 6 = 12 |
| **content total** | | **52** |
| `<tr className="… border-b border-hairline-soft">` | `AmazonProductTable.tsx:675` | + 1 (Tailwind default border width; `tailwind.config.js` does not override `borderWidth` or `spacing`) |
| `<table className="border-collapse table-fixed">` | `AmazonProductTable.tsx:465` | collapsed border model |

The tallest cell in the table (the image column) already consumes the whole 52 px, so the
`height: 52px` on the `<tr>` is not a ceiling — in CSS a row's `height` is a **minimum**, and
the 1 px bottom border is added on top of it.

### FACT — measured in Chrome on 2026-10-21 (dpr 1, ~64 products, sections OFF)

Console measurement (`getBoundingClientRect` on every `tbody tr[data-index]`):

```
rowsRendered : 20
distinctHeights : [64, 294]        heightCounts: {64: 13, 294: 7}
distinctPitches : [64, 294]        theadHeight : 34.5
clientHeight : 497                 scrollHeight: 4589     tbodyHeight: 4554
```

and over a 40-step scroll:

```
distinctScrollHeights : [4589, 4915, 4939, 4248, 4950, 3719, 3707, 3393, 3333]
count: 9        first: 4589        last: 3333
```

The prediction of 52-53 px was **wrong**: normal rows are **64 px** (the badge row plus a
two-line clamped title, not the 40 px image) and some rows are **294 px**. Every row breaks the
assumption, and 1 in 3 breaks it by 5.65×.

### The arithmetic closes exactly

| Quantity | Value |
|---|---|
| Virtualizer's total for N = 64 rows | `52 × 64` = **3328 px** |
| Smallest measured `scrollHeight` | **3333 px** |
| Largest measured `scrollHeight` | **4950 px** |
| Swing | **1617 px** |

`scrollHeight = 52·N + Σ(actual − 52)` over the rows currently mounted, because the two spacers
are computed from the 52-based total. With the 7 tall rows seen in the first sample
(`7 × 242 = 1694`), the model brackets the measurement from both sides: 3328 with no tall row in
range, 4950 ≈ 3328 + 6.7 × 242 with several. Nothing else in the layout explains a 1617 px
breathing range.

`rowsRendered` also fell from 31 to 20 between the two samples — the DOM really is laying out
294 px rows, so fewer fit the 497 px viewport. The virtualizer is computing the right *count*
from the wrong geometry.

### Why that produces exactly the reported symptom

- The top spacer is set to `firstVirtualItem.start` = `firstIndex × 52`, but the rows above it
  really occupy `firstIndex × 53`. The rendered block therefore sits ~1 px per row **above**
  where the virtualizer believes it is.
- Each time the range shifts, the block re-anchors — a **visible snap**, once per row scrolled.
  That is the "jitter", and it grows with the number of rows scrolled: **"only with a long
  list"**.
- `getTotalSize()` under-reports the content height, and the bottom spacer is recomputed from
  it on every render, so `scrollHeight` changes as rows mount and unmount — the scrollbar thumb
  **resizes under the mouse**. That is the "flicker", and it is why dragging or wheeling both
  feel unstable.
- Sections mode is immune because it never consults the virtualizer: it renders
  `sectionRows.map(...)` (`AmazonProductTable.tsx:533-539`) with no spacers — matching
  **"sections OFF"**.

### FACT — the library already supports the fix, and the rows are already wired for it

Read from the published `@tanstack/virtual-core` that `@tanstack/react-virtual@^3.14.19`
resolves to (verified by installing it and reading `dist/esm/index.js`):

- `indexFromElement` reads the `data-index` attribute — **already present** on both tables
  (`AmazonProductTable.tsx:673`, `TemuProductTable.tsx:413`).
- The default `measureElement` returns `entry.borderBoxSize.blockSize` (rounded) and falls back
  to `element.offsetHeight` — so no custom measurer is needed.
- `shouldMeasureDuringScroll` returns `true` unless the scroll is *smooth*, so wheel scrolling
  measures live.
- `scrollMargin` exists and defaults to `0`.

---

## 2. Deliberately ruled out (so we do not add code for a non-cause)

| Candidate | Why it is not the cause |
|---|---|
| Missing `scrollMargin` for the sticky `<thead>` | The thead is ~33 px (`py-2` 16 + `text-xs` line-height 16 + 1 px border). It shifts the virtualizer's coordinate space by a **constant** 33 px ≈ 0.64 rows, which `overscan: 10` absorbs. A constant offset cannot accumulate, so it cannot cause drift. No change proposed. |
| `container-type: inline-size` on `.preview-table-scroll` (SAD-378) | It is a *containment* hint and is applied identically whether or not the list is long. It also cannot explain cumulative behaviour. Untouched. |
| `useLiveQuery` churn | The answer to "when" was *long lists*, not *during collection*. Not the trigger. |
| Row `transition-colors` + `hover:bg-…` | Real but minor: rows sliding under the pointer animate for 150 ms. It can only produce a shimmer **under the cursor**, never a snap while the cursor is elsewhere. Kept as an optional micro-fix only if Step 0's numbers come back clean (see §3, branch B). |
| Sticky-thead repaint inside `border-collapse` | A genuine Chrome quirk, but it would show on a short list too. Branch C. |

---

## 3. Step 0 — measurement (EXECUTED — results in §1, kept here for re-verification)

Open a preview surface with **50+ rows**, sections **OFF**, scroll to the middle, and paste
this into the DevTools console:

```js
(() => {
  const s = document.querySelector('[data-testid="preview-table-scroll-container"]');
  const rows = [...s.querySelectorAll('tbody tr[data-index]')];
  const r = rows.map(el => el.getBoundingClientRect());
  const thead = s.querySelector('thead');
  return {
    rowsRendered: rows.length,
    rowHeights: [...new Set(r.map(x => +x.height.toFixed(2)))],
    pitch: r.length > 1 ? +(r[1].top - r[0].top).toFixed(2) : null,   // ← the decisive number
    theadHeight: thead ? +thead.getBoundingClientRect().height.toFixed(2) : null,
    clientHeight: s.clientHeight,
    scrollHeight: s.scrollHeight,
    tbodyHeight: +s.querySelector('tbody').getBoundingClientRect().height.toFixed(2),
  };
})()
```

Then confirm the "breathing" scrollbar — this scrolls the list in 40 steps and reports every
time `scrollHeight` changed:

```js
(async () => {
  const s = document.querySelector('[data-testid="preview-table-scroll-container"]');
  const seen = [];
  for (let i = 0; i <= 40; i++) {
    s.scrollTop = i * 400;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    seen.push(s.scrollHeight);
  }
  s.scrollTop = 0;
  return { distinctScrollHeights: [...new Set(seen)], samples: seen.length };
})()
```

**Outcome:** `pitch` is not one number at all — rows are 64 and 294 px, and `scrollHeight`
takes **9 distinct values** across 40 scroll steps. The estimate/actual mismatch row of the
decision table applies; Branches B and C are refuted (they predicted a stable `pitch` of 52 and
`distinctScrollHeights == 1`). **Proceed with Branch A.**

This section stays in the plan because it is the re-verification procedure for §5.

---

## 4. Branch A — the fix (2 lines, no new state, no new dependency)

Let the virtualizer use the real height instead of assuming it. Both rows already carry
`data-index`, which is the only other thing `measureElement` needs.

`src/engines/amazon/ui/table/AmazonProductTable.tsx` — the virtualized `<tr>` (~line 671):

```tsx
<tr
  key={row.id}
  ref={virtualizer.measureElement}
  data-index={virtualRow.index}
  className={`… border-b border-hairline-soft transition-colors …`}
  style={{ height: ROW_HEIGHT }}
>
```

`src/engines/temu/ui/table/TemuProductTable.tsx` — same one attribute on its `<tr>` (~line 412).

That is the entire change: **2 inserted lines.** `estimateSize` stays as the pre-measurement
default, `overscan` stays 10, the sections path is untouched (it has no virtualizer).

**Why this is the right shape of fix, and not just a magic number:** every row converges to its
measured height once, so `getTotalSize()` and both spacers become exact and stop depending on
`ROW_HEIGHT` matching the DOM. It also removes the latent trap that any future change to cell
padding, image size or border width silently re-introduces this exact bug.

**The constant-reconciliation fallback is dead.** It presumed a single correct pitch. The
measurement shows two (64 and 294), and the mix depends on panel width — a narrower panel wraps
more titles, so even a "corrected" 64 would be wrong at another width. There is no constant to
find; the height has to be measured.

**Pre-measurement spike risk:** `measureElement` on a `<tr>` is less common than on a div. If it
returns 0 for these rows, the fix becomes a custom measurer reading
`node.getBoundingClientRect().height` — same `ref`, one small function, no change in shape.
Verified in Step 2 by the `pitch` re-measurement below, before anything is committed.

### 4.1 The 294 px rows — a second, separate defect (not fixed by §4)

Seven of twenty rendered rows are **294 px** tall — 4.6× the normal 64 px. `measureElement`
makes scrolling *stable* with tall rows (they are measured and counted), but it does not make
them *right*: a 294 px row means something inside that row is rendering far taller than intended
while every other cell is capped (`line-clamp-1` / `line-clamp-2`).

Candidate causes, ranked by what the code shows — **none of these is confirmed**:

| Candidate | Where | Why it is plausible |
|---|---|---|
| Title clamp not applying | `columns.tsx:206` — `line-clamp-2` on an `<a>` that is a flex child of `flex flex-col gap-0.5` | 294 px ≈ 18 lines at the 16.5 px `leading-snug` line box, i.e. an unclamped long title |
| Badge row wrapping tall | `columns.tsx:172-201` — `flex flex-wrap` with `+ {extraPlacements.join(', ')}` | many placements in a narrow column wrap into a tall block |
| A cell with no clamp in the enabled-columns set | `getAmazonColumnsForSettings(settings?.enabledFields)` | only the columns you have enabled matter |

Identifying it is **one read-only query** — run it on the same page:

```js
(() => {
  const s = document.querySelector('[data-testid="preview-table-scroll-container"]');
  return JSON.stringify([...s.querySelectorAll('tbody tr[data-index]')]
    .filter(tr => tr.getBoundingClientRect().height > 100)
    .slice(0, 5)
    .map(tr => ({
      h: +tr.getBoundingClientRect().height.toFixed(2),
      asin: tr.querySelector('[data-testid^="product-category-badge-"]')?.getAttribute('data-testid')?.replace('product-category-badge-', '') ?? null,
      cells: [...tr.cells].map((td, i) => ({
        col: i,
        h: +td.getBoundingClientRect().height.toFixed(2),
        text: (td.textContent || '').trim().slice(0, 40),
        len: (td.textContent || '').trim().length,
      })),
    })));
})()
```

**This is deliberately a separate ticket.** It is a content/typography defect (SAD-265/SAD-357
area), not a virtualization one; folding it into SAD-388 would mix an unmeasured fix into a
measured one. SAD-388 ships with tall rows *handled correctly*, and the 294 px question becomes
its own issue with the output above as its evidence.

---

## 5. Step 2 — prove it

Re-run both snippets from §3. Acceptance:

| Check | Before (measured) | After (acceptance) |
|---|---|---|
| `pitch` vs the virtualizer's estimate | 64 and 294 vs 52 | **equal for every row** |
| `distinctScrollHeights` over a 40-step scroll | **9** values, swing 1617 px | **1** value |
| `scrollHeight` vs `tbodyHeight` | 4589 vs 4554 (they should agree) | within 1 px |
| Visual | snaps while scrolling; thumb breathes | no snap; thumb constant |
| Scroll **up** as well as down | — | stable both directions (the ticket's wording) |

All four surfaces: side panel, full-width modal, `preview.html`, and the Temu table if in scope.

---

## 6. Regression guards and gates

There is **no automated test available for this**: the suite is jsdom, where every
`getBoundingClientRect()` returns 0, so a unit test cannot observe a row's height or prove the
fix. `@tanstack/virtual-core` also depends on `ResizeObserver`, which jsdom does not implement.
Adding Playwright for one assertion would be a large, unrelated dependency — explicitly **not**
proposed.

Precedent in this repo is the SAD-378 approach: verify in a real browser, then record the
numbers in a document. So the guard is:

- `docs/plans/SAD-388-scroll-verification.md` with the before/after numbers from §3 and §5,
  the Chrome version, and the list size used.
- The existing suites must stay green, unchanged — in particular the ones that pin this exact
  rendering path: `preview-modes-and-sorting.test.tsx`, `preview-sections-scroll-sad378.test.tsx`,
  `preview-horizontal-scroll.test.tsx`, `preview-images-rownumbers-export.test.tsx`,
  `cell-expand-sad358.test.tsx`.

Gates (same as every other ticket in this repo):

```bash
npx tsc --noEmit && npm run check:dead-exports && npx wxt build && npx vitest run
```

Expected: clean, 2.03 MB, **128 files / 1418 tests** (the current `main` baseline).

---

## 7. Branch B / C — refuted by the measurement (kept as a record)

| Branch | Trigger | Minimal change |
|---|---|---|
| *(none)* | Both required a stable `pitch` of 52 and `distinctScrollHeights == 1`. Measured: `pitch ∈ {64, 294}`, 9 distinct scroll heights. **Neither is the cause.** | — |

<details><summary>original candidates, for the record</summary>

| Branch | Trigger | Minimal change |
|---|---|---|
| **B** — hover shimmer | `pitch == 52`, `distinctScrollHeights == 1`, and the flicker follows the cursor | drop `transition-colors` from the `<tr>` (keep the hover background) |
| **C** — sticky thead repaint | header band itself shimmers, short lists too | switch the table to `border-separate border-spacing-0` with the divider moved onto cells |

Both are 1-2 lines and neither is written before the measurement says so.

</details>

---

## 8. Scope and open questions

**Recommended scope:** fix both engines in one commit. The Temu table is byte-identical in this
respect (`ROW_HEIGHT = 52`, same `h-10` image, same `py-1.5`, same `border-collapse`), so
fixing only Amazon leaves the same bug reachable by switching engine.

**Branch:** `fix/sad-388-preview-scroll-jitter` off `main` @ `2ec7eaf`, or on a branch you name.

Not decided by this document — tell me if any should change:

1. **Temu too?** (recommended yes, 1 extra line — it has the identical 52/`h-10`/`border-collapse` block, and the same `data-index` already on its rows).
2. Which branch name / do you want it pushed straight to `main` or left on a branch for review?
3. Do you want the SAD-378-style verification doc committed with it (recommended, it is the only
   durable record of a fix that no unit test can hold)?
4. Step 0 is **done** — no longer a question. What remains is §4.1: do you want me to fold the
   294 px row defect into this ticket, or raise it separately (recommended: separate, it is a
   content/typography defect, and the snippet in §4.1 gives it its evidence)?

---

## 9. Out of scope

- No change to sorting, filtering, selection, export, cell-expand, columns or the sections path.
- No new dependency, no Playwright, no test-runner change.
- No change to `.preview-table-scroll` CSS, `container-type`, the sticky `<thead>`, or SAD-378's
  horizontal-scroll behaviour.
- No `scrollMargin` tuning (constant offset, absorbed by `overscan`, §2).
- No refactor of the two table components into a shared one — that is a much larger change and
  the ticket does not ask for it.
