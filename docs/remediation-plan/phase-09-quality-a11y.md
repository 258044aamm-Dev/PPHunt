# Phase 9 — Quality, Accessibility & Dead Code

**Issues addressed:** L‑2 (`formatCurrency` locale) · L‑4 (O(rows) row numbers, hand-rolled sorting) · L‑6 (no focus trap, native `confirm()`) · L‑3 (remaining dead code)
**Estimated effort:** Medium · **Prerequisites:** Phase 7 (table types green) · **Blocks:** nothing

Everything here is contained and independently shippable. Step 9.2 depends on Phase 7 because both edit
`columns.tsx` and `ProductTable.tsx`.

---

## Step 9.1 — L‑2: locale-aware currency formatting

### Objective
Prices display with the correct minor-unit convention and grouping for their currency.

### Root Cause
`src/lib/utils/formatters.ts:11-23`:
```ts
export function formatCurrency(value: number, currency?: string | null): string {
  const code = currency ?? 'USD';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(value);
  } catch { return `$${value.toFixed(2)}`; }
}
```
Two problems:
- **Locale is hardcoded to `en-US`**, so a German user sees `€1299.99` instead of `1.299,99 €`, and a
  Japanese user sees `¥3,980.00`.
- **Fraction digits are forced to 2**, which is wrong for zero-decimal currencies. JPY renders as
  `¥3,980.00`; KRW, VND, CLP and ISK would be equally wrong.

This only became fully visible after Phase 1: before that fix, `currency` was usually a URL, so
`Intl.NumberFormat` threw and the `catch` returned `$<value>` for most products.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/utils/formatters.ts` | modify | Derive the locale; let `Intl` choose the digits |
| `src/lib/utils/currency.ts` | modify | Add `localeForCurrency(code)` (created in Phase 1) |
| `src/entrypoints/sidepanel/table/columns.tsx` | no change | Already calls `formatCurrency(value, row.original.currency)` |

### Implementation Details
```ts
export function formatCurrency(value: number, currency?: string | null): string {
  const code = isIsoCurrency(currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat(localeForCurrency(code), {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      // no minimum/maximumFractionDigits — Intl uses the currency's default
    }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;      // no hardcoded '$'
  }
}
```
`localeForCurrency` maps a code to a canonical locale (`EUR → 'de-DE'`, `JPY → 'ja-JP'`,
`GBP → 'en-GB'`, `USD → 'en-US'`, `INR → 'en-IN'`, `CAD → 'en-CA'`, `AUD → 'en-AU'`). The map belongs
next to `HOST_CURRENCY_MAP` in the currency module so the storefront → currency → locale chain lives in
one place.

**`currencyDisplay: 'narrowSymbol'`** avoids `CA$`/`A$`/`US$` prefixes cluttering a narrow table cell.
Verify it is supported in the target Chrome version; fall back to `'symbol'` if not.

**Decision required:** should the locale follow the *currency* or the *browser*
(`navigator.language`)? Following the currency gives consistent output for a mixed-currency dataset,
which is what a product-research table usually is. Following the browser matches user expectation for
grouping. **Recommendation: follow the currency** — it is deterministic and testable, and a user
comparing a JP and a DE product wants each rendered natively. Flag for approval.

### Testing and Verification
| Input | Expected |
|---|---|
| `formatCurrency(3980, 'JPY')` | `￥3,980` — no `.00` |
| `formatCurrency(1299.99, 'EUR')` | `1.299,99 €` |
| `formatCurrency(19.99, 'USD')` | `$19.99` |
| `formatCurrency(19.99, 'GBP')` | `£19.99` |
| `formatCurrency(19.99, 'https://x')` | `$19.99` (guard falls back to USD, never a URL) |
| `formatCurrency(19.99, null)` | `$19.99` |
| `formatCurrency(19.99, 'XYZ')` | falls into the `catch` → `XYZ 19.99`, no throw |

**Regression:** `tests/pricing-deals-bsr.test.tsx` and `columns.tsx`-driven preview tests may assert
exact formatted strings — grep for `€`/`$`/`£`/`¥` literals in `tests/` before changing, and update
deliberately.

---

## Step 9.2 — L‑4: O(1) row numbers and TanStack-native sorting

### Objective
Remove a per-cell O(rows) scan, and stop hand-sorting data behind TanStack's back.

### Root Cause
**Row numbers.** `columns.tsx:95-101`:
```ts
cell: ({ row, table }) => {
  const displayedRows = table.getRowModel().rows;
  const positionIndex = displayedRows.findIndex((r) => r.id === row.id);
  const rowNumber = positionIndex >= 0 ? positionIndex + 1 : row.index + 1;
```
`findIndex` runs for **every rendered cell on every render** — O(rows) per cell, O(rows × visible) per
frame. With 10,000 rows loaded and 30 virtualised rows visible, that is 300,000 comparisons per render,
which defeats much of the virtualisation benefit.

**Sorting.** `ProductTable.tsx:101-127` sorts the data array by hand and casts
`activeSort.id as keyof Product`, so sorting a `display` column (`select`, `rowNumber`) would read
`undefined`. It is harmless today because both set `enableSorting: false`, but it means TanStack's own
sorting state is decorative and the table's data order is computed outside the library that renders it.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/table/columns.tsx` | modify | Row number from the virtualiser index |
| `src/entrypoints/sidepanel/table/ProductTable.tsx` | modify | Pass the index down; consider adopting TanStack sorting |

### Implementation Details
**Row numbers.** `ProductTable.tsx` already knows each row's position — it renders
`virtualRow.index` for the spacer arithmetic. Thread it into the cell via TanStack's `meta`:
```ts
// ProductTable.tsx — when constructing the row model / rendering
table.options.meta = { ...table.options.meta, rowIndex: virtualRow.index };
// columns.tsx
cell: ({ row, table }) => {
  const n = (table.options.meta as { rowIndex?: number })?.rowIndex;
  return <span ...>{(n ?? row.index) + 1}</span>;
}
```
If `meta` is awkward with virtualisation, the simpler equivalent is to keep a
`useMemo(() => new Map(rows.map((r,i) => [r.id, i])), [rows])` in `ProductTable` and look up by id —
O(1) per cell, O(rows) once per render instead of O(rows) per cell.

**Sorting.** Two options:
1. **Minimal (recommended for this phase):** keep the hand-sort but type it properly and add a guard so
   a `display` column can never be sorted:
   ```ts
   if (!isSortableColumn(activeSort.id)) return data;
   ```
2. **Fuller:** delete the hand-sort, enable `getSortedRowModel()` and let TanStack own ordering. This
   is cleaner but changes the data-identity contract that the row-number and selection logic depend on,
   so it should only be attempted once Phase 7 is complete and manually verified.

Choose (1) unless (2) is trivially clean after Phase 7. Record which was taken.

### Testing and Verification
1. `tests/preview-images-rownumbers-export.test.tsx` already asserts row numbers stay correct when rows
   are added, removed, filtered and reordered (SAD‑139) — it must pass unchanged. **That is the
   primary gate for this step.**
2. New: 10,000-row fixture, render, assert the row-number cell function is called once per *visible*
   row and performs no `findIndex` over the full model (spy or counter).
3. New: sorting by a `display` column is a no-op rather than producing `undefined` comparisons.
4. Manual (Phase 11): scroll a large table and confirm row numbers remain correct and scrolling stays
   smooth.

---

## Step 9.3 — L‑6: focus management and non-blocking confirmations

### Objective
Make the modal claim in the README true, and stop using native blocking dialogs inside a side panel.

### Root Cause
`trapFocus` exists at `src/lib/utils/a11y.ts:67-93` and has **zero call sites**. Grep confirms no
`useRef` / `focus()` / `autoFocus` / `tabIndex` in `ErrorModal`, `ExtractionCompleteModal`,
`ExportModal`, `SettingsOverlay` or `FullWidthPreviewModal` — none of the five modals traps focus or
moves focus on open. Only `FullWidthPreviewModal` handles Escape, via a `window` listener;
`ExportModal` relies on a React `onKeyDown` attached to a non-focusable `div`.

Separately, `confirm()` is used for four destructive actions:
- `SettingsOverlay.tsx:109` — restore defaults
- `HistoryTab.tsx:39` — delete one history entry
- `HistoryTab.tsx:44` — clear all history
- `ProductTable.tsx:215` — delete selected products

A native `confirm()` inside a Chrome side panel is a blocking OS dialog that cannot be styled, cannot
be themed for dark mode, and is inconsistent with the custom modal system used everywhere else.
`modalAriaProps` (`a11y.ts:55`) is used, so the modals are correctly *labelled* — they are just not
correctly *behaved*.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/components/ConfirmDialog.tsx` | **create** | Accessible confirmation modal (decision D6) |
| `src/entrypoints/sidepanel/hooks/useFocusTrap.ts` | **create** | Thin React wrapper around the existing `trapFocus` |
| `src/entrypoints/sidepanel/components/ErrorModal.tsx` | modify | Focus trap, initial focus, Escape |
| `src/entrypoints/sidepanel/components/ExtractionCompleteModal.tsx` | modify | Same |
| `src/entrypoints/sidepanel/components/ExportModal.tsx` | modify | Same; move `onKeyDown` to a focusable root |
| `src/entrypoints/sidepanel/components/SettingsOverlay.tsx` | modify | Same; replace `confirm()` |
| `src/entrypoints/sidepanel/components/FullWidthPreviewModal.tsx` | modify | Add trap; keep the existing Escape handler |
| `src/entrypoints/sidepanel/components/HistoryTab.tsx` | modify | Replace two `confirm()` calls |
| `src/entrypoints/sidepanel/table/ProductTable.tsx` | modify | Replace one `confirm()` call |
| `src/lib/utils/a11y.ts` | modify | Wire up or delete the four unused helpers |

### Implementation Details
**`useFocusTrap`** wraps the existing, already-correct `trapFocus` rather than reimplementing it:
```ts
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current.focus?.();
    const release = trapFocus(ref.current);
    return () => { release(); previouslyFocused?.focus?.(); };
  }, [active]);
  return ref;
}
```
Restoring focus to the previously-focused element on close is the half most implementations forget, and
it is what makes the modal non-disorienting for keyboard users.

Each modal gets: `ref={trapRef}`, `tabIndex={-1}` on its root, `onKeyDown` for Escape on that root (now
focusable, so the handler actually fires), and `aria-modal="true"` via the existing `modalAriaProps`.

**`ConfirmDialog`** is a small promise-based component:
```ts
const confirm = useConfirm();
if (!(await confirm({ title: 'Clear all history?', body: '…', destructive: true }))) return;
```
Its copy must incorporate the Phase 4 M‑9 correction — the clear-all dialog has to state that
collected products are also deleted.

**The four unused `a11y.ts` helpers** (`statusAriaProps`, `progressBarAriaProps`, `tabAriaProps`,
`tabPanelAriaProps`): two of them describe components that *do* exist and currently hand-roll their
ARIA — `StatusBar.tsx:24` has `role="status" aria-label={...}` and `ProgressBar.tsx` has its own. Wire
those two up (it is a genuine small improvement, not busywork) and **delete** `tabAriaProps` /
`tabPanelAriaProps` only if `Navigation.tsx` already handles tab ARIA correctly — verify first, since
`Navigation.tsx:41-56` maps `TABS` and may already be compliant.

### Testing and Verification
1. Per modal: open → `document.activeElement` is inside the dialog; Tab cycles without escaping;
   Escape closes; on close, focus returns to the trigger.
2. `ConfirmDialog`: renders, resolves `true` on confirm and `false` on cancel/Escape, and the caller's
   destructive action only runs on `true`.
3. Replace the four `confirm()` call sites one at a time and confirm each existing test that stubbed
   `window.confirm` is updated — grep `tests/` for `confirm` first; `settings-overlay.test.tsx` and
   `history-preview-export.test.tsx` are the likely candidates.
4. Extend `tests/theme-and-contrast.test.tsx` to assert the confirm dialog is legible in dark mode.

---

## Step 9.4 — L‑3: remove the remaining dead exports

### Objective
Delete code that has no callers, so the remaining surface is the real surface.

### Root Cause
Verified by grep — zero references outside each symbol's own definition:

| Symbol | Location | Note |
|---|---|---|
| `statusAriaProps` | `a11y.ts:9` | Step 9.3 wires this up instead of deleting |
| `progressBarAriaProps` | `a11y.ts:19` | Step 9.3 wires this up instead of deleting |
| `tabAriaProps` / `tabPanelAriaProps` | `a11y.ts:32, 44` | Delete **or** wire into `Navigation.tsx` |
| `formatPercent`, `pluralize` | `formatters.ts:25, 30` | `CounterDisplay` and `ProgressBar` format inline instead |
| `CollectionResult`, `ScraperConfig` | `scraper/types.ts` | Never referenced |
| Compound index `[sessionKey+asin]` | `db/database.ts` | Unused; verify no query depends on it before removing |
| `addProducts`, `getAllProducts`, `getProductCount`, `deleteProductsBySession`, `clearAllProducts` | `db/products.ts` | Check whether Phase 4 gave any of these a caller first |

**Several of these became live during earlier phases** and must be re-checked, not blindly deleted:
- `getExistingASINs` → wired in Phase 4 Step 4.4
- `getActiveSession` → wired in Phase 4 Steps 4.2 and 4.3
- `getSession` → wired in Phase 4 Step 4.1
- `deleteSession` / `clearAllSessions` → wired in Phase 4 Steps 4.3 and 4.5
- `trapFocus` → wired in Phase 9 Step 9.3

So the deletion list must be **re-derived after Phase 8**, not copied from the investigation report.

### Files Involved
`src/lib/utils/a11y.ts`, `src/lib/utils/formatters.ts`, `src/lib/scraper/types.ts`,
`src/lib/db/products.ts`, `src/lib/db/database.ts` — all modify.

### Implementation Details
For each candidate: `grep -rn "<symbol>" src tests` → if the only hits are the definition and its
export, delete. Remove the compound index only after confirming no `db.products.where([...])` query
uses it — an unused index costs write throughput and storage, but removing a *used* one breaks queries
at runtime with no type error.

Also address two related items found during the investigation:
- `collectionStore.ts`'s unused `timerRef` in `useSettings.ts:20` (declared, never cleared) — Phase 3
  Step 3.2 already handles it.
- `StatusBar.tsx:21` destructures `STATUS_CONFIG[status]` with no guard. Phase 2 Step 2.2 added
  `'interrupted'` to the **schema** but deliberately not to the store's type; if Phase 4 forwards
  `'interrupted'` to the UI, add both the `STATUS_CONFIG` entry and a guard. Verify whether it does.

### Testing and Verification
1. `npx tsc --noEmit` still exits 0 — deleting an export that is actually used produces an error, so the
   compiler is the check.
2. `npx vitest run` count unchanged.
3. `npx wxt build` succeeds and the bundle shrinks; record the delta.
4. Add a dead-export guard to CI: a script that lists every exported symbol in `src/lib/` and fails if
   any has zero importers outside its own module. Cheap to write, and it is the only thing that stops
   this recurring.

---

## Phase 9 exit criteria

- [ ] `formatCurrency(3980, 'JPY')` renders without `.00`; EUR renders with European grouping
- [ ] The row-number cell performs no scan over the full row model
- [ ] All five modals trap focus, focus their root on open, close on Escape and restore focus on close
- [ ] No `confirm(` / `alert(` / `prompt(` remains in `src/`
- [ ] The dead-export list is re-derived post-Phase 8 and every deletion is compiler-verified
- [ ] A dead-export guard runs in CI
- [ ] `tsc --noEmit` exits 0 · `vitest run` at **≥ 177** passing · `wxt build` OK
