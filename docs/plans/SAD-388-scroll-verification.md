# SAD-388 — verification record

Branch `fix/sad-388-preview-scroll-jitter` · base `main` @ `2ec7eaf` · Chrome · dpr 1

No unit test can hold this fix: the suite is jsdom, where `getBoundingClientRect()` returns 0
for every element and `ResizeObserver` does not exist, so a test cannot observe a row's height
or prove the virtualizer's arithmetic. This document is therefore the durable record, following
the SAD-378 precedent.

---

## 1. Root cause — measured before the change

Console measurement on a real Amazon preview (`preview-table-scroll-container`), ~64 products,
**Separate category sections OFF**:

```
rowsRendered     : 20          (31 in an earlier sample, see below)
distinctHeights  : [64, 294]   heightCounts {64: 13, 294: 7}
distinctPitches  : [64, 294]
theadHeight      : 34.5
clientHeight     : 497
scrollHeight     : 4589        tbodyHeight 4554
```

Across a 40-step scroll of 400 px:

```
distinctScrollHeights : [4589, 4915, 4939, 4248, 4950, 3719, 3707, 3393, 3333]
count: 9        first: 4589        last: 3333
```

**The code assumed something the DOM does not do.** `AmazonProductTable.tsx:32` sets
`ROW_HEIGHT = 52`, line 247 passes `estimateSize: () => ROW_HEIGHT`, and nothing ever measured a
row (`grep -rn "measureElement|measureRef" src` → 0 hits). 52 px is only the tallest *fixed*
content — the image cell `h-10` (40 px) plus cell padding `py-1.5` ×2 (12 px) — not the row.

**The arithmetic closes exactly.** Both spacers are derived from `getTotalSize() = 52 × N`:

| Quantity | Value |
|---|---|
| `52 × 64` | **3328** |
| smallest measured `scrollHeight` | **3333** |
| largest measured `scrollHeight` | **4950** |
| per normal row (64 − 52) | **+12** |
| per tall row (294 − 52) | **+242** |

`scrollHeight = 52·N + Σ(actual − 52)` over the mounted window, so it rises by 242 for each
tall row inside the overscan window: 3328 → 4950 spans about 6.7 tall rows, which is what the
13 normal / 7 tall sample shows. Nothing else in the layout can move the content height by
1617 px.

**Mechanism of the two symptoms**

- **Flicker** — `scrollHeight` changes in 9 steps as tall rows enter and leave the window, so the
  scrollbar thumb resizes underneath the pointer.
- **Jitter** — the top spacer is `firstIndex × 52` while the rows above it really occupy
  `firstIndex × 64`, so the rendered block re-anchors 12 px per normal row and 242 px per tall
  row whenever the range shifts.
- **Why sections mode was immune** — it never consults the virtualizer; it renders
  `sectionRows.map(...)` with no spacers.

Predictions that were **wrong** and are corrected here: the plan expected a single pitch of
52-53 px (`52 + 1 px border`). The measurement showed two pitches, 64 and 294, and the
"reconcile the constant" fallback was dropped because no single constant can be right — the mix
depends on panel width.

---

## 2. The change

| File | Change |
|---|---|
| `AmazonProductTable.tsx` | `ref={virtualizer.measureElement}` on the **virtualized** `<tr>` (line 673). The sections row renderer (line 533) is untouched — it has no virtualizer. |
| `TemuProductTable.tsx` | Same one attribute; its block is identical (`ROW_HEIGHT` 52, `estimateSize`, `border-collapse`). |

Both rows already carry `data-index`, which is the only other thing `measureElement` needs
(`indexFromElement` reads it). Verified against the published `@tanstack/virtual-core` that
`@tanstack/react-virtual@^3.14.19` resolves to: the default measurer returns
`entry.borderBoxSize.blockSize` and falls back to `offsetHeight`, and
`shouldMeasureDuringScroll` returns `true` unless the scroll is smooth, so wheel scrolling is
measured live.

2 inserted lines. No new state, no new import, no new dependency, no change to `estimateSize`,
`overscan`, the spacers, sorting, filtering, selection, export, cell-expand, columns or the
sections path.

---

## 3. Secondary defect found while investigating (fixed in the same branch)

The `dealBadge`, `coupon` and `badge` cells asked for a one-line clamp and never got one. They
carried **both** `inline-block` and `line-clamp-1`, and both utilities declare `display`:

```css
/* compiled, dist/chrome-mv3/assets/global-*.css */
.line-clamp-1{-webkit-line-clamp:1;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}
.inline-block{display:inline-block}
```

`line-clamp-1` is emitted **first**, so at equal specificity the later `display:inline-block`
wins and the clamp is inert. Long values wrapped without limit.

Fix: the clamp moved to an inner element, which has no competing `display` utility, and the pill
kept its shape.

```tsx
<span className="inline-block max-w-full px-1.5 py-0.5 rounded-sm … bg-crimson/15 text-crimson"
      data-testid={`product-deal-${info.row.original.asin}`}>
  <span className="line-clamp-1">{deal}</span>
</span>
```

Applied to the same three pills in **both** engines (6 cells); Temu's markup is byte-identical.
`max-w-full` keeps the pill inside the cell. Short values render exactly as before — a one-line
clamp has no effect on text that already fits — and `data-testid` stays on the outer element, so
the existing suites still resolve it (verified: 1418 tests unchanged).

**This is not claimed as the cause of the 294 px rows.** To reach 294 px a pill would need
roughly 375 characters at 12 px/16 px in a 124-140 px column; that is implausible, and no
measurement confirms it.

---

## 4. The 294 px rows — parked, with evidence

Explanations checked and **ruled out** by reading the code:

| Hypothesis | Evidence | Verdict |
|---|---|---|
| A cell with no clamp | `warrantyDescription` is the only expandable column without one, but it is `whitespace-nowrap`, so it cannot wrap | ruled out |
| Inert clamp on the pills | real defect (§3) but needs ~375 chars to reach 294 px | implausible as the cause |
| Content taller than the row | every one of the 27 columns clamps to 1-2 lines (`clamp=True` on all); 2 lines at `leading-snug` = 32 px | ruled out |

The remaining question is *which cell* is 294 px tall. It needs one read-only query on a live
page (per-cell height + text length for rows over 100 px). Until that runs, this is recorded as
unknown rather than guessed — raised as its own ticket.

Note that §2 makes tall rows **harmless to scrolling** either way: measured, they are counted
and positioned correctly. §3 does not depend on the answer.

---

## 5. Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run check:dead-exports` | clean (42 files) |
| `npx wxt build` | 2.03 MB |
| `npx vitest run` | **127 passed + 1 skipped (128 files) / 1418 tests** — identical to `main` |
| Amazon diff vs `main` | only the two tables + the two `columns.tsx` files above |

---

## 6. Still to confirm on a real page (after install)

Run this before and after scrolling to the middle of a long list; the acceptance criteria are
in the last column.

```js
(() => {
  const s = document.querySelector('[data-testid="preview-table-scroll-container"]');
  const rows = [...s.querySelectorAll('tbody tr[data-index]')];
  const r = rows.map(el => +el.getBoundingClientRect().height.toFixed(2));
  return JSON.stringify({
    distinctHeights: [...new Set(r)],
    scrollHeight: s.scrollHeight,
    tbodyHeight: +s.querySelector('tbody').getBoundingClientRect().height.toFixed(2),
  });
})()
```

| Check | Before (measured) | Acceptance |
|---|---|---|
| `distinctHeights` | `[64, 294]` | unchanged — the rows are the same rows |
| `scrollHeight` vs `tbodyHeight` | 4589 vs 4554 (35 px apart) | **within 1 px** |
| `scrollHeight` over a 40-step scroll | 9 distinct values, swing 1617 px | **1 value** |
| Visual | snaps while scrolling, thumb breathes | no snap, thumb constant, both directions |
