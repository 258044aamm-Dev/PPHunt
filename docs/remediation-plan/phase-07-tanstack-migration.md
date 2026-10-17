# Phase 7 — TanStack Table v9 Migration

**Issues addressed:** M‑5 (71 of the 111 type errors; no type safety in the table module)
**Estimated effort:** Large · **Prerequisites:** Phase 0 · **Blocks:** the CI typecheck gate becoming blocking

This is the phase that takes `tsc --noEmit` from **~27 errors to 0** and lets the CI gate built in
Phase 0 become a real gate. It is also the phase with the least test coverage behind it — jsdom cannot
verify table geometry — so it carries a mandatory manual verification step.

---

## Step 7.0 — Establish the current runtime contract

### Objective
Record exactly what the table does today, so "types are now correct" is not confused with "behaviour
changed".

### Root Cause
Not a defect — a safety measure. The code currently **works at runtime** despite being un-type-checked,
because TanStack v9's runtime still honours v8-shaped column objects and
`features: {...stockFeatures}` supplies the row-selection methods. That means the type errors are not
pointing at broken behaviour; they are pointing at an API shape the compiler cannot verify. A migration
that "fixes the types" by changing runtime behaviour would be a regression.

### Files Involved
None modified. Record in the PR description:
- the column list and order produced by `getColumnsForSettings(DEFAULT_ENABLED_FIELDS)`
- which columns are `display` vs `accessor`
- the `size` / `minSize` / `maxSize` values on each
- the select-all, row-selection, sorting, filtering and column-sizing state shapes
- the virtualisation parameters (`ROW_HEIGHT = 52`, `KEYBOARD_SCROLL_STEP = 120`)

---

## Step 7.1 — Migrate `columns.tsx` to the v9 column-helper signature

### Objective
Zero type errors in `src/entrypoints/sidepanel/table/columns.tsx` (71 today).

### Root Cause
`package.json` pins `"@tanstack/react-table": "^9.3.1"`; the installed version is **9.3.1**. In v9 the
helper takes **two** type parameters. Confirmed directly against the installed declaration file
`node_modules/@tanstack/table-core/dist/helpers/columnHelper.d.ts:67`:
```ts
export declare function createColumnHelper<
  TFeatures extends TableFeatures,
  TData extends RowData
>(): ColumnHelper<TFeatures, TData>;
```
with the documented usage at line 59:
```ts
const helper = createColumnHelper<typeof features, Person>()
// features is the result of the `tableFeatures({})` helper
```

`columns.tsx:7` uses the v8 single-generic form:
```ts
const columnHelper = createColumnHelper<Product>();     // ← TS2558: Expected 2 type arguments, but got 1
```
Because the first parameter is unresolved, `columnHelper.display({...})` falls back to
`DisplayColumnDef<Product, RowData>`, which does not accept sizing — producing the 26 × TS2353
(`'size' does not exist in type 'DisplayColumnDef<...>'`), 24 × TS2345 and 20 × TS2339 errors.

Meanwhile `ProductTable.tsx` has **already** adopted the v9 API — it imports `useTable` and
`stockFeatures` (lines 3, 5) and calls `useTable({ ..., features: {...stockFeatures},
rowSelectionFeature: stockFeatures.rowSelectionFeature })` at lines 129-134. So the codebase straddles
two incompatible major versions of the same library, and `columns.tsx` is the half that was never
migrated.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/table/columns.tsx` | modify | Helper instantiation, sizing placement, `RowData` references |
| `src/entrypoints/sidepanel/table/ProductTable.tsx` | modify | Share the `features` object with `columns.tsx`; fix the 4 remaining errors |

### Implementation Details

**1. Instantiate the helper with both generics.** `ProductTable.tsx` already uses `stockFeatures`, so
use the same object to keep the two files in agreement:
```ts
// columns.tsx
- import { createColumnHelper } from '@tanstack/react-table';
+ import { createColumnHelper, stockFeatures } from '@tanstack/react-table';

- const columnHelper = createColumnHelper<Product>();
+ const columnHelper = createColumnHelper<typeof stockFeatures, Product>();
```
If `stockFeatures` is not a `TableFeatures` value but a factory result, use
`createColumnHelper<ReturnType<typeof tableFeatures>, Product>()` or define one shared
`const FEATURES = tableFeatures({})` in a new `table/features.ts` imported by both files. **Verify
which shape v9.3.1 exports before choosing** — this is the single decision the whole step hinges on,
and it is a 5-minute check against `node_modules/@tanstack/table-core/dist/index.d.ts`.

**2. Move sizing to where v9 accepts it.** The 26 × TS2353 errors are all `size` / `minSize` /
`maxSize` on `display(...)` definitions. In v9, sizing comes from the `columnSizingFeature` slot, so
once the helper is correctly generic these properties should type-check. If they still do not, the
v9-correct location is `columnDef.meta` or the table-level `defaultColumn`. Do **not** silence this
with `as any` or `@ts-expect-error` — the whole point of the phase is that the compiler can see the
table.

**3. Fix the `RowData` references.** `columns.tsx:70, 78` and similar use
`table.getIsAllPageRowsSelected()` and `row.original.asin` where the compiler reports
`Property 'asin' does not exist on type 'RowData'` — a direct consequence of the unresolved first
generic. These should disappear once step 1 lands. Verify rather than assume: re-run `tsc` after step 1
alone and see how many of the 71 remain.

**4. `ProductTable.tsx`'s four errors:**
- `:131` and `:226` — `Record<string, boolean>` is not assignable to `SetStateAction<RowSelectionState>`.
  v9's `RowSelectionState` shape differs from v8's; convert at the boundary rather than casting.
- `:356` and `:360` — virtualiser/row-model references; check against v9's `getRowModel()` return type.

**5. Do not change `features: {...stockFeatures}` at `ProductTable.tsx:133-134` unless the compiler
requires it.** It is what makes row selection work at runtime today.

### Dependencies and Order
- Independent of Phases 1–6. Can be done in parallel by a second contributor.
- **Must complete before the CI typecheck gate flips to blocking** (Step 7.3).
- Interacts with **Phase 9 Step 9.2** (the O(rows)-per-cell row-number column and the hand-rolled
  sorting): do them together, since both edit `columns.tsx` and `ProductTable.tsx`. Recommended:
  Phase 7 first to get types green, then Step 9.2 as a clean follow-up commit.

### Testing and Verification
1. `npx tsc --noEmit` → **0 errors** in `src/entrypoints/sidepanel/table/`. This is the primary gate.
2. `npx vitest run` — the table-related suites must pass unchanged:
   `preview-horizontal-scroll.test.tsx`, `preview-images-rownumbers-export.test.tsx`,
   `history-preview-export.test.tsx`. These assert DOM structure (row numbers, thumbnails, horizontal
   scroll, export column sets) and are the only automated coverage the table has.
3. **New tests worth adding** (jsdom *can* verify these):
   - `getColumnsForSettings(DEFAULT_ENABLED_FIELDS)` returns the same column ids in the same order as
     recorded in Step 7.0.
   - Toggling each `enabledFields` key adds/removes exactly the expected column.
   - Row-selection state round-trips: select all → assert the state shape; select none → assert empty.
4. **Mandatory manual verification (risk R4 — jsdom cannot do this).** Load `dist/chrome-mv3` unpacked,
   collect ~1,000 products, open the Preview overlay and check: column resizing by drag, sorting by
   each sortable header, select-all and per-row select, row numbers staying correct after sort/filter/
   delete, thumbnail rendering, and smooth virtualised scrolling with no blank gaps or jumps. Record
   the result in Phase 11's checklist.

---

## Step 7.2 — Verify the virtualisation row-height assumption

### Objective
Confirm or fix a suspected row-height drift that no existing test can detect.

### Root Cause
`ProductTable.tsx` implements virtualisation inside a real `<table>` with `border-collapse` and
`table-fixed`, using `<tr><td style={{height: N}}/></tr>` as spacers and a constant
`ROW_HEIGHT = 52` (line 21) as `estimateSize()`. In a collapsed-border table, a specified row height is
a **minimum**, not an exact value: if any cell's content exceeds 52 px — a wrapped two-line title, a
long availability string, a stacked price/discount cell — the real row height diverges from the
estimate and the spacer arithmetic drifts, producing visual jumps while scrolling.

**jsdom performs no layout**, so `offsetHeight`, `getBoundingClientRect` and row-height resolution are
all unavailable. Every existing test asserts DOM structure only, never geometry. This risk was flagged
in the investigation report as unverifiable in the sandbox and it remains so.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/table/ProductTable.tsx` | modify **only if** the manual check shows drift | Clamp cell content to one line, or switch to a measured `estimateSize` |

### Implementation Details
Two remedies, in order of preference:
1. **Prevent overflow (cheap, deterministic).** Ensure every cell in a 52 px row is single-line:
   `truncate` / `line-clamp-1` on the title, brand, availability and seller cells, plus
   `overflow-hidden` on the `<td>`. This makes the constant estimate correct by construction.
2. **Measure instead of estimate (correct but costlier).** Use
   `measureElement` from `@tanstack/react-virtual` with `estimateSize` as the initial guess. This
   handles arbitrary content but adds a layout read per row and can itself cause jitter if done
   naively.

Choose (1) unless the product genuinely needs multi-line cells.

### Testing and Verification
Manual only — this is Phase 11 item 2. Deliberately load products with very long titles (Amazon
keywords-stuffed listings are ideal) and scroll the full range.

---

## Step 7.3 — Flip the CI typecheck gate to blocking

### Objective
Make `tsc --noEmit` a hard gate.

### Root Cause
Phase 0 added the step with `continue-on-error: true` because the repository starts at 111 errors.
Once this phase lands, that tolerance is what would let the next 111 errors accumulate.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `.github/workflows/ci.yml` | modify | Remove `continue-on-error` from the Typecheck step |
| `package.json` | modify | `verify` script: `tsc --noEmit;` → `tsc --noEmit &&` |

### Implementation Details
```yaml
- name: Typecheck
  run: npx tsc --noEmit
- # continue-on-error removed
```
Also remove the `tests/` type errors (15 of the 111) in the same phase — they are mostly fixtures
typed loosely against the old column shapes, and leaving them would keep the gate red.

### Testing and Verification
1. `npx tsc --noEmit` exits **0**.
2. Introduce a deliberate type error on a branch → confirm CI fails. Then revert.
3. `npm run verify` fails fast on a type error rather than continuing to the tests.

---

## Phase 7 exit criteria

- [ ] `npx tsc --noEmit` exits 0 across `src/` **and** `tests/`
- [ ] No `as any`, `@ts-expect-error` or `@ts-ignore` was added to `table/columns.tsx` or `table/ProductTable.tsx`
- [ ] Column ids, order and sizing match the Step 7.0 record
- [ ] All table-related test suites pass unchanged
- [ ] CI's Typecheck step is blocking; `npm run verify` uses `&&`
- [ ] Manual browser pass completed for resize / sort / select-all / row numbers / virtualise at ~1,000 rows
- [ ] Row-height drift confirmed absent, or fixed via Step 7.2
- [ ] `vitest run` at **≥ 161** passing · `wxt build` OK
