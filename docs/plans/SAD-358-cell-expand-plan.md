# SAD-358 — Expanding Field: Detailed Implementation Plan
**PPHunt | Amazon Product Scraper — Expand Option for Truncated Cells**
> **Plan-only mode — no code has been modified. Every claim is traceable to a source file/commit.**
> Generated: 2026-10-20 (Asia/Dhaka) after cloning `MakeTheNewHistory/PPHunt` @ main and inspecting Linear SAD-358.

---

## 0. How this plan was produced (anti-guessing audit)

| Step | Evidence |
|------|----------|
| Cloned repo | `git clone https://github.com/MakeTheNewHistory/PPHunt.git` verified at `/home/user` — 9 top-level dirs, 80+ source files under `src/` |
| Read Linear SAD-358 | `linear.get_issue identifier=SAD-358` — 6 acceptance criteria (hover → icon, click → modal, full-content formatting, dismissal, responsive/touch, preserve existing functionality) |
| Verified no prior Expand implementation | `grep -rn "Expand\|Expandable\|TruncatedCell\|cell.*expand" src` → **0 hits**; `grep -rn "line-clamp" src` → 32 hits, all truncating (no expand exists) |
| Traced cell-rendering architecture | `src/engines/amazon/ui/table/columns.tsx` (796 LOC), `src/engines/temu/ui/table/columns.tsx` (681 LOC), barrel shims in `src/entrypoints/sidepanel/table/columns.tsx`, real tables in `src/engines/amazon/ui/table/AmazonProductTable.tsx` (710 LOC), `src/engines/temu/ui/table/TemuProductTable.tsx` (450 LOC), `src/entrypoints/preview/PreviewPageApp.tsx` (388 LOC) |
| Traced modal architecture | `src/entrypoints/sidepanel/components/ConfirmDialog.tsx` (129 LOC, focus-trap + `modalAriaProps`), `src/engines/amazon/ui/components/FullWidthPreviewModal.tsx` (201 LOC, `z-40`), `ExportModal.tsx` (329 LOC, `z-50`), `SettingsOverlay.tsx` (`z-40`), `ErrorModal.tsx` (`z-50`), `ExtractionCompleteModal.tsx` (331 LOC), plus `src/lib/utils/a11y.ts` (modalAriaProps) and `src/entrypoints/sidepanel/hooks/useFocusTrap.ts` (87 LOC) |
| Checked global constraints | `ARCHITECTURE.md` (363 LOC, DB v2, MV3 lifecycle, dual-mode overlay iframe in closed shadow root), `tailwind.config.js` (PPHunt tokens), `src/entrypoints/sidepanel/global.css` (142 LOC, `.preview-table-scroll` scrollbar, design tokens `#f0eee6` canvas, `#b04e30` clay, bottom-only 8px radius, no box-shadow), `tests/table-v9-contract.test.tsx` (ROW_HEIGHT=52 invariant), `src/lib/diagnostics/error-diagnosis.ts`, `wxt.config.ts` (WAR narrowing, host_permissions from `match-patterns.ts`) |
| Asked clarifying questions | `ask_user` with 4 questions — answered: **1) all truncated cells, 2) shared component `src/entrypoints/sidepanel/components`, 3) type-aware formatting, 4) tap-cell for touch** |

> `PLAN_ONLY_MODE` is explicit: no file has been created or edited in this pass (verified via `git status` clean). The plan is implementation-ready but zero-risk.

---

## 1. Issue restatement (Linear SAD-358 — “Expending field”)

**Title:** Expand option for cells containing extended information that cannot be fully previewed within the cell.

**Expected behavior (6 bullets):**
1. **Hover interaction:** hovering a cell with extended info displays an Expand icon/button inside the cell.
2. **Modal preview:** clicking Expand opens a modal dialog displaying full content in readable format.
3. **Content handling:** modal displays complete content without truncation, with appropriate formatting for the data type.
4. **Dismissal:** user can close easily and return to table without losing state (sorting, filters, selection, scroll, collapsed sections).
5. **Responsive:** works on desktop + mobile; on touch devices Expand is accessible without relying on hover.
6. **Preserve existing functionality:** follow existing UI design, component architecture, coding conventions; avoid unnecessary changes.

**User addendum:** new modification **must not influence other existing features**; prefer smallest necessary changes; reuse existing code if it fulfills requirement.

---

## 2. Codebase analysis — what actually renders cells today

### 2.1 Source of truth for tables
| Engine | Column defs | Table component | Barrel/shim | Live data source | Preview surfaces |
|--------|-------------|-----------------|-------------|------------------|------------------|
| Amazon | `src/engines/amazon/ui/table/columns.tsx` — `columnHelper` + 27 column defs, `amazonColumns` array and `getAmazonColumnsForSettings()` selector | `src/engines/amazon/ui/table/AmazonProductTable.tsx` — `useTable` + `useVirtualizer` (ROW_HEIGHT=52, overscan 10), `parentRef`, `handleKeyDown`/`handleWheel`, `TableToolbar`, `AmazonExportModal`, `ConfirmDialog` | `src/entrypoints/sidepanel/table/columns.tsx` re-exports; `ProductTable.tsx` re-exports | `useLiveQuery(() => db.products.where('sessionKey').equals(sessionKey)…)` via `src/engines/amazon/db/database.ts` (Dexie v2, stores: products, sessions, settings, history, snapshots) | Sidepanel Collect→Preview tab, `FullWidthPreviewModal` overlay (`z-40 bg-canvas p-4`), `src/entrypoints/preview/PreviewPageApp.tsx` (dedicated tab, engine toggle, history select, Export, Theme) |
| Temu | `src/engines/temu/ui/table/columns.tsx` — `temuColumns`, `getTemuColumnsForSettings()` (string[]-based) | `src/engines/temu/ui/table/TemuProductTable.tsx` — mirrored structure (no collapsible category sections) | `src/entrypoints/sidepanel/table/columns.tsx` does NOT shim Temu (Temu imported directly) | `temuDb` in `src/engines/temu/db/database.ts` | Same `PreviewPageApp.tsx` engine toggle |

**Key structural invariant:** `ROW_HEIGHT = 52` in both tables. `table-v9-contract.test.tsx:416-436` asserts every text cell is clamped to at most `line-clamp-2` (title) or `line-clamp-1` (all others) so the 52px estimate never drifts. This **prohibits inline expansion** inside the row; the modal is architecturally mandatory.

### 2.2 Which cells are truncated (and therefore in scope per your “all truncated” answer)

**Amazon (`src/engines/amazon/ui/table/columns.tsx`):**
| Column id | `line-clamp` | Current rendering | Why extended |
|-----------|--------------|-------------------|--------------|
| `title` | `line-clamp-2` | `<a href=url>` serif xs + category badge (`organic/sponsored/recommendation`) + `sectionLabel` subtitle + multi-placement `+` badge | Can exceed ~160 chars; longest free-text field |
| `bestSellersRank` | `line-clamp-1` | sans xs `title={bsr}` | BSR strings like “#12 in Electronics › Headphones › …” often > column width (160px) |
| `pastMonthSales` | `line-clamp-1` | moss font-medium | “10,000+ bought in past month” truncated |
| `coupon` | `line-clamp-1` | moss badge `title={coupon}` | “Save $15 with coupon” etc. |
| `badge` | `line-clamp-1` | golden badge `title={badge}` | “Amazon’s Choice”, “Best Seller” variations |
| `delivery` | `line-clamp-1` | `title={delivery}` | Date strings, “Tomorrow, Oct 22” + shipping notes |
| `brand` | `line-clamp-1` | `title={brand}` | Multi-word brand + sub-labels |
| `seller` | `line-clamp-1` | `title={seller}` | Marketplace seller names |
| `availability` | `line-clamp-1` | `title={availability}` | “Only 3 left in stock — order soon…” |
| `dealBadge` | `line-clamp-1` | crimson badge | “Limited time deal”, “Prime Early Access” |
| `url` | `line-clamp-1` | `/dp/{ASIN}` link with `title={url}` | Full URL hidden; user sees only short form |
| `description` | `line-clamp-2` | `title={desc}` serif | PDP-only, can be paragraphs |
| `features` | `line-clamp-2` | `joined = features.join(' • ')` + `title={joined}` | Array → bullet list; most extended field |
| `warrantyDescription` | `whitespace-nowrap` (not clamped but fixed width 110px) | `title={raw ?? warranty}` mono xs | Normalized token `1-year` with verbatim raw hidden in tooltip |
| `discountPercentage`, `dealBadge` etc. show `No` when absent — no expand needed |

**Temu** mirrors the same set minus `warrantyDescription` (Temu has no warranty column yet) but adds `seller` as “Seller / Mall”, `pastMonthSales` as “Sales Volume” etc. — same line-clamp pattern (`src/engines/temu/ui/table/columns.tsx:139,237,318…`).

**Not truncated (no expand needed):** `select` (checkbox), `rowNumber` (#), `imageUrl` (thumbnail 40px), `asin`/`goodsId` (8–12 chars fits), `price`/`listPrice` (formatted currency, ~10 chars), `currency`, `rating` (★ + 1 decimal), `reviewCount`, `isPrime`/`isSponsored` (badge No/Yes), `source` (pill).

**Total in scope:** ~13 columns per engine × 2 engines = 26 cells, plus cross-cutting title column enhancements.

### 2.3 Existing modal & a11y contracts (must be reused verbatim)

| Pattern | File | Contract |
|---------|------|----------|
| **Focus trap** | `src/entrypoints/sidepanel/hooks/useFocusTrap.ts` | `useFocusTrap<T>(active, onEscape?)` → `ref`; on `active` moves focus to first focusable or container (requires `tabIndex={-1}`), Tab/Shift+Tab wraps, Escape invokes callback, restores focus to `previouslyFocused` on cleanup. Queried on every Tab so async content works. Selector: `button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])` |
| **ARIA** | `src/lib/utils/a11y.ts` | `modalAriaProps(titleId)` → `{ role:'dialog', 'aria-modal':true, 'aria-labelledby': titleId }` |
| **Overlay shell** | `ExportModal.tsx`, `ErrorModal.tsx`, `ConfirmDialog.tsx`, `ExtractionCompleteModal.tsx` | Outer: `fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60 p-4` (settings uses `z-40`); inner: `bg-surface border border-hairline-soft rounded-md p-5 max-w-sm w-full` (or `max-w-md`), `shadow-lg` on destructive modals. Title id referenced by `modalAriaProps`, close button is SVG X `w-7 h-7`, Escape closes unless `exportModalOpen` blocks it (`FullWidthPreviewModal.tsx:108`) |
| **Design tokens** | `global.css` + `tailwind.config.js` | `surface/card/soft`, `ink/ink-muted/ink-subtle`, `hairline/hairline-soft`, `clay/clay-active/clay-ink`, `moss/golden/crimson/sky`, Lora serif for body/copy, Poppins sans for chrome, JetBrains Mono for metadata, 8px bottom-only radius on clay CTAs (floating card-action uses 8px all), flat surfaces, no box-shadow, 1px hairline borders |
| **Virtualization** | `AmazonProductTable.tsx:60-80` | `useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_HEIGHT, overscan: 10 })`; spacer rows via `firstVirtualItem.start`/`totalSize - last.end`; `totalTableWidth = table.getCenterTotalSize()` drives `<table width>` |
| **State isolation** | `ARCHITECTURE.md:57-64`, `session-state.ts` | Background SW mirrors `storage.session` pointer; panel/overlay share IndexedDB; Zustand `uiStore` holds `previewSorting`, `previewGlobalFilter`, `previewOverlayOpen`, `selectedSessionKey`; table state (`sorting`, `globalFilter`, `rowSelection`, `columnSizing`) is local `useState` + `useTable` with `manualSorting:true` + `sortProducts()` helper |

**Z-index contract today:** Settings `z-40`, all primary modals `z-50`, confirm `z-[60]`, page-overlay `z-40` (full-screen, `isolation` via `2147483647` closed shadow root for extension overlay). Any new cell modal must sit at `z-50` (or `z-[55]` if we want it above settings but below confirm) without breaking preview.

### 2.4 Constraints that shape the solution
- **No layout shift:** Cannot inline-expand rows; must be out-of-flow modal (ROW_HEIGHT invariant + virtualizer spacer math).
- **No breaking `getColumnsForSettings` contract:** `tests/table-v9-contract.test.tsx` pins ids, order, sizing, sortFn. Adding expand UI must not change column ids or order; sizing stays identical; sortFn untouched.
- **No `window.confirm` regression:** `tests/a11y-focus.test.tsx:170` scans `src/` for `confirm(` and fails if found. New code must use promise-based `ConfirmDialog` pattern, not blocking dialogs.
- **Docs consistency:** `tests/docs-consistency.test.ts` asserts every design token in `tailwind.config.js` appears in `global.css` — new colors/styles must reuse existing tokens.
- **Dual engines:** Temu and Amazon tables share toolbar, export, sorting but column defs diverge (`enabledFields` object vs `defaultExportColumns` string[]). Shared component must accept both `AmazonProduct` and `TemuProduct` shapes via generic.
- **Three preview surfaces reuse the same table:** sidepanel preview, `FullWidthPreviewModal` (overlay), `PreviewPageApp` dedicated tab. Cell expand must work in all three without duplicating logic.

---

## 3. Design decisions (with rationale & alternatives rejected)

| Decision | Chosen | Why | Rejected alternative |
|----------|--------|-----|----------------------|
| **Component location** | Shared `src/entrypoints/sidepanel/components/CellExpandModal.tsx` + `src/entrypoints/sidepanel/components/ExpandableCell.tsx` (or `src/lib/ui/cell-expand/`) | Per your “shared sidepanel” answer; DRY across Amazon/Temu; importable as `@/entrypoints/sidepanel/components/CellExpandModal` from both engines. Follows existing pattern where `ConfirmDialog`, `TableToolbar`, `ExportToast` are shared sidepanel components reused by engine UIs. | Per-engine duplicates would diverge and double maintenance; placing under `src/engines/amazon/...` would break Temu reuse. |
| **Modal multiplicity** | **Single table-level singleton modal** + column `meta.onExpand` callback via TanStack `table.options.meta` | Prevents N modals in virtualized rows (virtualizer recycles DOM; per-cell `useState` would create mount/unmount churn and focus-restore bugs). Table holds `expandedCell: { rowId, columnId, label, value, raw, product } \| null` and renders one modal at root sibling to scroll container. Columns call `meta.onExpand(payload)`. Aligns with `ExportModal`/`ConfirmDialog` singleton pattern. | Per-cell local `useState + <CellExpandModal>` inside each `cell:` function works functionally but bloats VDOM, complicates focus restore (which row’s button?), and risks z-index stacking inside table. |
| **Trigger visibility** | **CSS-only hover reveal + focus-visible + touch fallback + tap-cell as supplementary** (per your “tap cell” answer) | Desktop: button hidden `opacity-0` until `group-hover:opacity-100` or `group-focus-within:opacity-100`; keyboard: button is `tabIndex=0` reachable via Tab inside expanded cell container; touch: `@media (hover: none)` or `@supports` fallback forces `opacity:100` + larger hit area; supplementary: truncated text span itself is tappable on `max-width:768px` via `onClick` that delegates to `onExpand` (preserving link clicks via `e.stopPropagation`/`e.preventDefault` guard). Satisfies SAD-358 bullet 5. | JS `onMouseEnter` state per cell causes re-renders and conflicts with virtualizer; purely hover without touch fallback fails WCAG 2.5.5 and mobile. Pure JS tap-cell without button reduces discoverability on desktop. |
| **Content handling** | **Type-aware formatted rendering** (per your answer) | Each column declares its `format:` rendering function: title → serif heading + category badge + placements; description → serif paragraph with preserved line breaks; features → `<ul>` bullets; brand/seller/availability/delivery → sans text; BSR/sales/coupon/badge/deal → pill + copy button; url → full URL code block + copy + open link; price/listPrice → mono currency (when expanded, show the already-visible value but also cross-ref); warranty → token + raw verbatim. Reuses `formatCurrency`, `formatNumber`, `resolveListingCategory` utilities. | Plain-text fallback would strip semantic value (features list becomes unreadable run-on); inventing markdown would be unnecessary. “Just show raw string” was rejected per your explicit “formatted_by_type”. |
| **Hover target** | Expand button **inside** the `<td>`’s cell wrapper, not as column header | SAD-358 says “within the cell”; putting it in `<td>` `group` with `relative` + button `absolute top-1 right-1` (or inline `ml-auto` for flex cells) keeps hit area inside the cell border and avoids overlapping column resize handle (right 1.5px). | As separate column would shift all column widths and break contract; as header control would not be per-cell. |
| **Z-index** | `z-50` (same as Export/Error) — or `z-[55]` if Settings coexistence needed | Export/Error/Extraction all `z-50`; Settings is `z-40`. Using `z-50` ensures modal appears above table and toolbar; `ConfirmDialog` remains `z-[60]` above everything (so destructive confirms still overlay the expand modal, matching contract). | `z-40` would hide behind settings; `z-[60]` would hide confirm. |
| **State preservation** | Modal is **controlled local to table** — does not touch `uiStore`, routing, or Dexie | Closing modal calls `setExpandedCell(null)` and `buttonRef.current?.focus()`; no `setPreviewSorting`/`setPreviewGlobalFilter` side effect; virtualizer `rows` and `sortedAndFilteredProducts` remain untouched. | Storing expanded state in Zustand or URL would pollute session persistence and preview tab sync (`previewStateSync.ts`). |
| **Accessibility baseline** | Inherit `useFocusTrap(isOpen, onClose)` + `modalAriaProps`, Escape, backdrop-click, Tab wrap, focus restore, `aria-label`/`aria-labelledby`, `aria-expanded` on trigger | Matches SAD-194/L-6 verified by `a11y-focus.test.tsx`; zero new a11y utilities. | Custom focus logic would risk failing existing focus-trap tests. |

---

## 4. Architecture overview

```
AmazonProductTable / TemuProductTable (tables)
│
├── TableToolbar (existing)
├── Scroll container (existing: preview-table-scroll, parentRef)
│   └── <table> virtualized rows (existing, ROW_HEIGHT=52)
│       └── <td group> (NEW: each truncated cell wraps content + Expand button)
│           └── Expand button (opacity-0 → group-hover/front, @media hover:none visible)
│               └── onClick → meta.onExpand({ columnId, label, value, raw, product })
│
└── CellExpandModal — singleton at table root (NEW, z-50, portal-less, fixed inset-0)
    ├── Backdrop (ink/40) click → onClose
    ├── Dialog (bg-surface, focus trap, max-w-lg, max-h-[80vh], responsive)
    │   ├── Header: field label + ASIN/goodsId pill + copy-all button + close X
    │   ├── Divider (hairline)
    │   ├── Body: type-aware formatter (title/features/description/etc.)
    │   └── Footer: Close (clay) + optional Open Product Link (surface-card)
    └── ConfirmDialog (existing, z-[60], never overlapped)

Shared components (new):
  src/entrypoints/sidepanel/components/
    ├── CellExpandModal.tsx      ← generic <T extends AmazonProduct | TemuProduct>
    └── ExpandableCell.tsx       ← generic wrapper + ExpandIconButton
  plus optional:
    src/lib/ui/cell-expand/types.ts   ← ExpandedCellPayload, CellExpandFormatter

Modified files (minimal):
  src/engines/amazon/ui/table/columns.tsx
  src/engines/temu/ui/table/columns.tsx
  src/engines/amazon/ui/table/AmazonProductTable.tsx
  src/engines/temu/ui/table/TemuProductTable.tsx

Untouched (critical to not influence):
  background.ts, amazon.content.ts, all scraper/parsers, db/*, export/*,
  HistoryTab, SettingsOverlay, FullWidthPreviewModal shell (except table import),
  PreviewPageApp header/theme/engine toggle, docs/ARCHITECTURE.md/PLAN.md
```

---

## 5. Detailed implementation plan — 7 phases (smallest necessary changes)

### Phase 1 — Add shared types + modal shell (no behavior change to tables)

**New file 1: `src/entrypoints/sidepanel/components/CellExpandModal.tsx`**
- Props (generic over product):
```tsx
interface CellExpandModalProps<T = AmazonProduct | TemuProduct> {
  open: boolean;
  onClose: () => void;
  payload: ExpandedCellPayload<T> | null;
  // payload shape:
  // { columnId: string; label: string; value: string | string[] | null;
  //   raw?: string | null; product: T; fieldType: 'text'|'list'|'url'|'badge'|'currency'|'image'|... }
}
```
- Structure (copy-paste from `ExportModal.tsx` as template, verified contracts):
  - `const trapRef = useFocusTrap<HTMLDivElement>(open, onClose)`
  - Return `null` if `!open || !payload`
  - Outer overlay: `fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60 p-4` with `onClick={onClose}` on overlay and `e.stopPropagation()` on dialog (so backdrop click closes but dialog click does not).
  - Dialog: `ref={trapRef} tabIndex={-1} {...modalAriaProps('cell-expand-title')} class="bg-surface border border-hairline-soft rounded-md p-5 max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden shadow-lg"` (max-w-lg slightly larger than Export’s max-w-sm to accommodate long text; use `md:max-w-xl` for desktop).
  - Header: flex between title (`font-serif text-base font-semibold text-ink` at `id="cell-expand-title"` showing `label`) + ASIN/goodsId pill (`font-mono text-[10px] bg-surface-card border hairline`). Row: copy-all button (`Copy` → `Copied!` 2s via `navigator.clipboard.writeText`) + close X SVG (reuse exact SVG from ExportModal).
  - Divider: `border-b border-hairline-soft`
  - Body: `flex-1 overflow-y-auto mt-3` with type-aware renderer (see 5.2).
  - Footer: `mt-4 flex justify-end gap-2` with Close (clay) + optionally `Open on Amazon`/Temu link (surface-card) if payload has url.
  - Responsive: dialog `w-full mx-4` on mobile (p-4 already), body `text-[13px] leading-relaxed`; on `sm:` keep same; modal centered vertically/horizontally even on narrow sidepanel (320px min). Verify with sidepanel width 360px (SAD-138 narrow sidebar) — dialog still centered via `fixed inset-0` full viewport, not constrained by sidepanel iframe (both sidepanel and overlay iframe share same Tailwind build, so `fixed` is relative to iframe viewport, which is sufficient; if overlay iframe is 300–800px resizable, dialog will center within it).

- A11y: Escape closes via `useFocusTrap`’s `onEscape`; Tab wraps; focus restores to the expand button that opened payload (store `triggerRef` in table and restore on close).

- Performance: no extra deps; `navigator.clipboard` guarded (`try/catch`); copy feedback via local `useState`.

**New file 2: `src/entrypoints/sidepanel/components/ExpandableCell.tsx` (or `ExpandableCellWrapper.tsx`)**
- Generic wrapper for any truncated cell content:
```tsx
interface ExpandableCellProps {
  label: string;                 // column header, for modal title
  columnId: string;
  value: string | string[] | null | undefined;
  raw?: string | null;           // e.g. warrantyDescriptionRaw
  onExpand: (payload: ExpandedCellPayload) => void;
  children: React.ReactNode;     // the clamped content span/div
  showExpand?: boolean;          // false when value is falsy/'No'/'—'
  className?: string;            // wrapper layout
}
export function ExpandableCell({ label, columnId, value, raw, onExpand, children, showExpand = true, ... }: ExpandableCellProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!showExpand || !value) return <>{children}</>;
  // Determine if truncated: we always show for non-empty values in scope columns.
  // Alternative later: measure scrollWidth vs clientWidth, but not needed for MVP.
  const handleExpand = () => onExpand({ columnId, label, value, raw, triggerRef });
  return (
    <div className="group flex items-start gap-1 min-w-0 relative">
      <span
        className="min-w-0 flex-1 cursor-pointer md:cursor-default"
        onClick={(e) => {
          // On touch/coarse-pointer, tapping the text itself expands.
          // On desktop, allow text selection; only expand if explicitly coarse.
          if (window.matchMedia('(pointer: coarse)').matches) {
            e.preventDefault();
            handleExpand();
          }
        }}
        data-testid={`cell-expand-tap-${columnId}`}
      >
        {children}
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Expand ${label}`}
        aria-expanded={false}
        onClick={(e) => { e.stopPropagation(); handleExpand(); }}
        className="
          shrink-0 w-6 h-6 flex items-center justify-center
          rounded-sm bg-surface-card border border-hairline-soft
          text-ink-muted hover:text-ink hover:border-hairline
          opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
          focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-clay
          transition-opacity duration-150 cursor-pointer
          max-[768px]:opacity-100                    // touch fallback via media (alternative to hover:none)
          [@media(hover:none)]:opacity-100           // standards-compliant coarse pointer
        "
        data-testid={`cell-expand-button-${columnId}`}
      >
        {/* Expand icon: 12x12 arrow-out or maximize SVG */}
      </button>
    </div>
  );
}
export function ExpandIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 2H2v8h8V8M2 2l5 5M8 2h2v4" />
    </svg>
  );
}
```
- Hover CSS rationale: `group-hover:opacity-100` implements SAD-358 bullet 1 with zero JS; `group-focus-within` ensures keyboard users tabbing into cell see button; `[@media(hover:none)]:opacity-100` implements bullet 5 for touch without JS detection. Alternative `max-[768px]:opacity-100` is pragmatic for sidepanel narrow view.

- Tap-cell rationale (your answer): the `span` tap handler only fires when `(pointer: coarse)` matches, so desktop drag-select remains functional; `e.stopPropagation()` on button prevents double-fire.

**Optional new file 3: `src/lib/ui/cell-expand/types.ts`** — shared `ExpandedCellPayload` and `CellFieldFormatter` types if we want to keep modal generic.

### Phase 2 — Wire `onExpand` through TanStack Table meta (zero column order change)

**In `src/engines/amazon/ui/table/AmazonProductTable.tsx`:**
1. Add state near existing `exportOpen`:
```tsx
const [expandedCell, setExpandedCell] = useState<ExpandedCellPayload | null>(null);
const expandTriggerRef = useRef<HTMLElement | null>(null);
// Helper to open and remember trigger for focus restore:
const handleExpand = useCallback((payload: ExpandedCellPayload) => {
  expandTriggerRef.current = payload.triggerRef?.current ?? null;
  setExpandedCell(payload);
}, []);
const handleCloseExpand = useCallback(() => {
  setExpandedCell(null);
  // Focus restore is handled by useFocusTrap’s cleanup capturing previouslyFocused.
  // As fallback, manually restore to trigger if focus-trap’s capture missed due to portal:
  requestAnimationFrame(() => expandTriggerRef.current?.focus());
}, []);
```
2. Provide `meta` to `useTable`:
```tsx
const table = useTable({
  data: sortedAndFilteredProducts,
  columns: activeColumns, // unchanged call
  // ...
  meta: { onExpand: handleExpand }, // NEW — type via declare module '@tanstack/react-table'
});
```
   - Add TanStack meta augmentation at top of file (or shared types):
```tsx
declare module '@tanstack/react-table' {
  interface TableMeta<TData extends RowData> {
    onExpand?: (payload: ExpandedCellPayload) => void;
  }
}
```
3. Render modal as sibling to scroll container (outside virtualizer, so it does not scroll):
```tsx
return (
  <div className="flex flex-col h-full flex-1 min-h-0 min-w-0 w-full">
    <TableToolbar ... />
    <div ref={parentRef} ...> {/* existing scroll container + table */} </div>
    <CellExpandModal open={!!expandedCell} payload={expandedCell} onClose={handleCloseExpand} />
    <AmazonExportModal ... />
    {confirmDialog}
  </div>
);
```
   - Same insertion point for both the collapsed-category-sections branch and the default virtualized branch — modal is at root so it overlays both.

4. For the collapsible category branch (sectionRows), existing `rows.filter` + `sectionRows.map` must also propagate the same `expandedCell` modal — since modal is now table-level, no per-section modal needed.

**Duplicate minimal wiring in `src/engines/temu/ui/table/TemuProductTable.tsx`** (same `useState`, `meta.onExpand`, singleton modal). Keep Amazon and Temu wiring symmetrical for testability.

### Phase 3 — Wrap truncated columns in `ExpandableCell`

**In `src/engines/amazon/ui/table/columns.tsx`:**
- Add imports at top:
```tsx
import { ExpandableCell } from '@/entrypoints/sidepanel/components/ExpandableCell';
```
- For each in-scope column, wrap its `cell:` return with `ExpandableCell`. Example for `titleColumn`:
```tsx
const titleColumn = columnHelper.accessor('title', {
  header: 'Title',
  cell: (info) => {
    const product = info.row.original;
    const title = info.getValue();
    // ... existing badge/placements logic (unchanged)
    const meta = info.table.options.meta as { onExpand?: (p: any) => void };
    const shouldExpand = !!title && title.length > 0; // or always true when title truthy
    return (
      <ExpandableCell
        label="Title"
        columnId="title"
        value={title}
        onExpand={(p) => meta.onExpand?.({ ...p, product })}
        showExpand={shouldExpand}
      >
        {/* existing JSX: badges + <a href...>title</a> — keep line-clamp-2 */}
        <div className="flex flex-col gap-0.5 min-w-0">
          {/* badges unchanged */}
          <a href={url} ... className="... line-clamp-2 ...">{title ?? '—'}</a>
        </div>
      </ExpandableCell>
    );
  },
  // sizing/sortFn untouched
});
```
- Apply same pattern to:
  - `bestSellersRankColumn` → `label="Best Sellers Rank"`, `value={bsr}`, `showExpand={!!bsr}`
  - `pastMonthSalesColumn` → `label="Monthly Sales"`, check `!!sales`
  - `couponColumn` → only when `coupon !== No` (currently renders `No` span for falsy — showExpand false for that)
  - `badgeColumn`, `deliveryColumn`, `brandColumn`, `sellerColumn`, `availabilityColumn`, `dealBadgeColumn`, `descriptionColumn`, `featuresColumn` (value is `features` array, pass `joined` as value but keep array for modal list), `warrantyDescriptionColumn` (pass `raw` as extra), `urlColumn` (value is full `url`, display shows `/dp/ASIN` but modal shows full)
  - `titleColumn` already covered.
  - Keep `showExpand={false}` for columns whose current cell is not truncated in a meaningful way: we intentionally leave `imageUrl`, `asin`, `price`, `listPrice`, `currency`, `rating`, `reviewCount`, `isPrime`, `isSponsored`, `source`, `select`, `rowNumber` untouched.

**In `src/engines/temu/ui/table/columns.tsx`:**
- Same wrapping for Temu’s equivalent columns (title, bestSellersRank/categoryRank, pastMonthSales/salesVolume, coupon, badge, delivery, brand, seller, availability, dealBadge, description, features, url).

**Sizing & sort preservation proof:**
- Each column’s `size/minSize/maxSize/enableSorting/enableResizing/sortFn` stays exactly as before; only `cell:` function body is wrapped, which `table-v9-contract.test.tsx` does not assert against (it asserts `size/minSize/maxSize/sortFn` and `id` order). Verified by reading test at lines 96-142: it reads `col.size/minSize/maxSize/sortFn` only, never `cell`.

### Phase 4 — Modal body formatters (type-aware readable format)

Inside `CellExpandModal.tsx`, define a formatter map keyed by `columnId`:

```tsx
function renderModalBody(payload: ExpandedCellPayload) {
  const { columnId, value, raw, product } = payload;
  switch (columnId) {
    case 'title':
      return (
        <>
          <div className="flex flex-wrap gap-1 mb-3">{/* re-render badges as in cell but full */}</div>
          <h3 className="font-serif text-sm font-semibold text-ink leading-snug break-words">{value as string}</h3>
          <a href={product.url} target="_blank" rel="noopener noreferrer"
             className="mt-2 inline-flex font-mono text-xs text-clay underline">{product.url}</a>
        </>
      );
    case 'features':
      // value is string[] or joined string — prefer array for list
      const list = Array.isArray(value) ? value as string[] : (value as string).split(' • ');
      return (
        <ul className="list-disc list-inside space-y-1.5 font-serif text-xs text-ink leading-relaxed">
          {list.map((f,i) => <li key={i} className="break-words">{f}</li>)}
        </ul>
      );
    case 'description':
      return <p className="font-serif text-sm text-ink leading-relaxed whitespace-pre-wrap break-words">{value as string}</p>;
    case 'bestSellersRank':
    case 'pastMonthSales':
    case 'coupon':
    case 'badge':
    case 'delivery':
    case 'brand':
    case 'seller':
    case 'availability':
    case 'dealBadge':
      return <p className="font-sans text-sm text-ink break-words">{value as string}</p>;
    case 'warrantyDescription':
      return (
        <div className="space-y-2">
          <p className="font-mono text-sm text-ink font-medium">{value as string}</p>
          {raw && <p className="font-serif text-xs text-ink-muted italic">Original: “{raw}”</p>}
        </div>
      );
    case 'url':
      return (
        <div className="space-y-2">
          <p className="font-mono text-xs text-ink break-all bg-canvas p-2.5 rounded-sm border border-hairline-soft">{value as string}</p>
          <div className="flex gap-2">
            <a href={value as string} target="_blank" rel="noopener noreferrer"
               className="px-3 py-1.5 rounded-sm bg-clay text-clay-ink font-sans text-xs font-medium hover:bg-clay-active">Open link →</a>
            <button onClick={() => navigator.clipboard.writeText(value as string)}
                    className="px-3 py-1.5 rounded-sm bg-surface-card border border-hairline font-sans text-xs text-ink">Copy</button>
          </div>
        </div>
      );
    default:
      return <p className="font-sans text-sm text-ink break-words whitespace-pre-wrap">{String(value ?? '')}</p>;
  }
}
```

- Each formatter reuses design tokens only (no new colors); `break-words`/`break-all` prevent overflow without horizontal scroll; `whitespace-pre-wrap` preserves any newlines in description.
- For `dealBadge`/`coupon`/`badge` which previously rendered pill, modal upgrades to plain readable text plus optional pill replica for context.
- Copy-all button in header copies `value` or `joined` string.

### Phase 5 — Responsive & touch verification specifics

| Surface | Width | Expectation |
|---------|-------|-------------|
| Sidepanel (sidepanel.html) | 360px (SAD-138 narrow) to Chrome-resizable | Modal `fixed inset-0` centers in iframe viewport; body scrolls vertically (`max-h-[80vh]`); expand button `opacity-100` via `@media (hover:none)` so touch users always see it; tap fallback ensures text-tap also expands. |
| Overlay (overlay.html iframe in closed shadow root, 300–800px via `overlayHost.ts` clamp) | overlay width 300–800px | Modal still `fixed` to iframe viewport; no host-page CSS leakage (shadow root isolation). |
| Dedicated preview tab (`preview.html` full-screen) | 95vw / full tab | Same behavior; modal max-w-lg → md:max-w-xl for readability. |
| Keyboard | Any | Button is focusable (`tabIndex=0`), `group-focus-within:opacity-100` reveals it; `useFocusTrap` wraps Tab; Escape closes; `aria-label="Expand Title"` etc. |
| Touch (pointer: coarse) | Phone/tablet | Button always visible; cell text tap also expands (coarse-pointer guard prevents desktop interference). |

### Phase 6 — Preserve existing functionality (explicit non-goals & guardrails)

**Must NOT change:**
- `src/engines/amazon/db/*`, `src/lib/db/*`, `src/engines/temu/db/*` — schema, indexes (notably `[sessionKey+asin]` compound index), CRUD.
- `src/entrypoints/background.ts`, `src/entrypoints/amazon.content.ts`, `src/entrypoints/temu.content.ts`, `src/engines/amazon/scraper/*`, `src/lib/scraper/*` — scraping pipeline.
- `src/engines/amazon/export/*`, `src/lib/export/*` — CSV/Excel/clipboard (including image budgets).
- `src/entrypoints/sidepanel/store/*`, `src/engines/amazon/ui/store/*` — Zustand stores; no new store keys.
- `src/entrypoints/sidepanel/components/SettingsOverlay.tsx`, `HistoryTab.tsx`, `HistoryEntry.tsx`, `ExtractionCompleteModal.tsx`, `FullWidthPreviewModal.tsx` shell (only table inside it changes).
- `wxt.config.ts` host_permissions/manifest WAR.

**Automated guardrails to run after implementation:**
1. `npx tsc --noEmit` — type check (no implicit any; generic modal typed).
2. `npx vitest run` — all 60+ test suites; specifically watch `table-v9-contract.test.tsx`, `preview-horizontal-scroll.test.tsx`, `a11y-focus.test.tsx`, `pricing-deals-bsr.test.tsx`, `warranty-description.test.tsx`.
3. `npm run check:dead-exports` — ensure no orphaned exports.
4. `npx wxt build` — verify manifest WAR still narrows (overlay chunks) and sidepanel builds.
5. Manual smoke: hover desktop → icon appears, click → modal opens centered, shows full text, Copy works, Escape closes, focus returns, table sorting/selection preserved; mobile emulation (DevTools 375px, touch) → button always visible, tap cell expands.

### Phase 7 — Testing plan for this feature (to be added with implementation)

**Unit (vitest, jsdom + mocked virtualizer):**
- `cell-expand-modal.test.tsx` (new):
  - Renders modal when `open=true` with payload; role=dialog, aria-modal, aria-labelledby; focus moves inside; Tab wraps; Escape calls onClose; backdrop click closes; dialog click does not; Close button and copy button.
  - Each `columnId` formatter snapshots (title, description, features list, BSR, url, warranty raw/token).
  - Responsive: asserts `[@media(hover:none)]:opacity-100` class present on button.
- `expandable-cell.test.tsx` (new):
  - With truthy value → button rendered, initially `opacity-0`, `group-hover:opacity-100` class present; `aria-label="Expand ${label}"`.
  - With falsy/`No` → no button.
  - Table meta wiring: clicking button calls `meta.onExpand` with correct payload; coarse-pointer tap path.

**Integration (table-level):**
- `product-table-expand.test.tsx` (new):
  - Render `AmazonProductTable` with seeded products containing long title/B SR/description/features; hover simulation (fireEvent.mouseEnter + check `group-hover` class is no-op in jsdom, so test via rendered button existence instead); click expand → modal visible; close via Escape → modal gone, focus restored; verify `sortedAndFilteredProducts` unchanged after open/close.
  - Same for `TemuProductTable`.

**Contract tests (must still pass):**
- Existing `table-v9-contract.test.tsx` — all 6 tests green (column order, sizing, sortFn, PDP-only defaults).
- `preview-horizontal-scroll.test.tsx` — scroll container `overflow-x-auto` intact, scrollbar tests still pass (modal does not interfere with scrollLeft).
- `a11y-focus.test.tsx` — no `window.confirm` regressed; modal focus contract holds.

**Manual verification (per SAD-358 bullets):**
1. Hover each truncated cell → icon appears (desktop Chrome); tap cell → modal (mobile emulation).
2. Modal shows full unclipped content with correct formatting (pills vs lists vs pre-wrap).
3. Close via X, Escape, backdrop → table unchanged (selection, filters, collapsed organic/sponsored/recommendation sections).
4. Overlay mode + dedicated tab mode both show same behavior.
5. No console errors, no z-index clipping under Settings (`z-40`) or over Confirm (`z-60`).

---

## 6. File change matrix

| File | Action | Lines changed (est.) | Risk |
|------|--------|----------------------|------|
| **NEW** `src/entrypoints/sidepanel/components/CellExpandModal.tsx` | Create | ~180 LOC | Low — isolated, no table coupling except props |
| **NEW** `src/entrypoints/sidepanel/components/ExpandableCell.tsx` | Create | ~90 LOC | Low — pure wrapper, no state |
| **NEW** `src/lib/ui/cell-expand/types.ts` (optional) | Create | ~30 LOC | Low — type-only |
| `src/engines/amazon/ui/table/columns.tsx` | Modify | ~80 LOC delta (wrap 13 cell functions) | Medium — ensure no id/size/sortFn touched, add only `ExpandableCell` wrapper + `meta.onExpand` access |
| `src/engines/temu/ui/table/columns.tsx` | Modify | ~70 LOC delta | Medium — mirror Amazon |
| `src/engines/amazon/ui/table/AmazonProductTable.tsx` | Modify | ~40 LOC delta (state + meta + modal render) | Medium — virtualizer sibling insertion must not affect `totalTableWidth` calc |
| `src/engines/temu/ui/table/TemuProductTable.tsx` | Modify | ~40 LOC delta | Medium — same |
| `tests/cell-expand-modal.test.tsx` | NEW test | ~150 LOC | Low |
| `tests/expandable-cell.test.tsx` | NEW test | ~80 LOC | Low |
| `tests/product-table-expand.test.tsx` | NEW test | ~120 LOC | Low |
| **Everything else** | **Untouched** | 0 | — |

**Total new LOC:** ~300 (src) + ~350 (tests) = ~650. No deletions. All existing contracts preserved.

---

## 7. Visual spec (PPHunt design system compliance)

| Element | Token & value (from `global.css`/`tailwind.config.js`) |
|---------|--------------------------------------------------------|
| Expand button bg | `bg-surface-card` (`#efe9de` light / `#252421` dark) |
| Button border | `border-hairline-soft` (`#d2cdc1` / `#3e3c37`), hover `border-hairline` |
| Button icon | `text-ink-muted` → `hover:text-ink`, `w-6 h-6` (12×12 icon centered) |
| Button radius | `rounded-sm` = 8px (config) — matches toolbar, not 8px-bottom-only because floating cell control is explicitly allowed `8px on all corners` per README Design System rules. |
| Button shadow | `shadow: none` (rule: no box-shadow anywhere) |
| Modal bg/backdrop | `bg-surface` / `bg-ink/40 dark:bg-black/60` (copy from ExportModal) |
| Modal border | `border border-hairline-soft`, `rounded-md` (12px) |
| Header title | `font-serif text-base font-semibold text-ink` |
| Body text | `font-serif text-sm leading-relaxed` for description/features/title; `font-sans text-sm` for short fields; `font-mono text-xs` for url/warranty/copy; all `text-ink` |
| Divider | `border-hairline-soft` |
| Copy button | `bg-surface-card border border-hairline` `font-sans text-xs` — secondary; `Copy` → `Copied!` + `text-moss` feedback |
| Close button | `w-7 h-7` SVG X (identical to ExportModal/ErrorModal) |
| CTA footer | `bg-clay text-clay-ink hover:bg-clay-active` Close; secondary Open link `bg-surface-card` |
| Typography | Lora serif for body (description/features/title), Poppins sans for chrome (toolbar/modals/buttons), JetBrains Mono for metadata (ASIN/URL/warranty). Fallback chains already declared in `tailwind.config.js`. |

---

## 8. Edge cases & failure modes

| Case | Handling |
|------|----------|
| Cell value is `null`/`undefined`/`''` or renders `No`/ `—` | `showExpand=false`; no button at all. Matches existing `couponColumn` etc. which return `<span>No</span>` for falsy — we do not add expand for “no data” placeholders. |
| Features array empty | No expand. |
| Title is also a link `<a href>` | Clicking title link navigates (preserved). Clicking expand button `stopPropagation` so link not triggered. Tapping title text on coarse-pointer expands only if tap target is the clamped span, not the nested `<a>` — implement tap delegation on outer span but guard: if `e.target.closest('a')` then navigate, do not expand. |
| Long unbroken strings (URL, BSR hash) | Use `break-all` in modal; never horizontal overflow. |
| Virtualizer re-uses DOM nodes | Table-level modal sidesteps recycling; no per-row state to stale. |
| Rapid open/close | `requestAnimationFrame` focus restore fallback prevents race. |
| Clipboard denied | Copy button gracefully falls back to ` Copied Summary` never shown; no error toast (preserve export-toast pattern but out of scope — keep silent). |
| Dark theme | All tokens have dark variants in `global.css` — modal inherits via `class="dark"` on `html`. Test via `tests/theme-and-contrast.test.tsx`. |
| Overlay iframe 300px narrow | Modal `max-w-lg` still fits because `fixed inset-0 p-4` pads; body scroll handles overflow; verify not clipped by iframe border. |
| Keyboard-only user | Button focusable; `group-focus-within:opacity-100` reveals even without hover; focus-trap allows Tab cycling; Escape returns. |
| Screen reader | Button has `aria-label="Expand ${label}"`; modal has `role=dialog aria-modal` + `aria-labelledby`; list rendered as `<ul>` for features. |

---

## 9. Verification checklist (to be executed after implementation)

- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` all suites green, specifically:
  - [ ] `table-v9-contract` (ids/order/sizing/sortFn)
  - [ ] `preview-horizontal-scroll` (scrollLeft, Shift+Wheel, Arrow keys)
  - [ ] `a11y-focus` (focus trap, no window.confirm)
  - [ ] `warranty-description` (SAD-349 token+raw still shown)
  - [ ] `pricing-deals-bsr` (BSR parsing unaffected)
  - [ ] new `cell-expand-*` suites
- [ ] `npx wxt build` produces `dist/chrome-mv3/manifest.json` with WAR narrowed via `computeOverlayWarResources`
- [ ] Manual: desktop hover → icon, click → modal formatted correctly per type, Copy works, Escape/close/backdrop → table state preserved
- [ ] Manual: DevTools mobile 375px → button always visible, tap cell expands, modal centered, vertical scroll works
- [ ] Manual: overlay mode + dedicated tab mode both functional
- [ ] `git diff --stat` shows only 4 modified + 3 new files (no collateral changes)

---

## 10. Example code skeletons (copy-ready snippets, minimal)

### 10.1 CellExpandModal shell (uses existing contracts)
```tsx
// src/entrypoints/sidepanel/components/CellExpandModal.tsx
import { useState } from 'react';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import { modalAriaProps } from '@/lib/utils/a11y';

export interface ExpandedCellPayload<T = unknown> {
  columnId: string;
  label: string;
  value: string | string[] | null;
  raw?: string | null;
  product: T;
  triggerRef?: React.RefObject<HTMLElement>;
}
export function CellExpandModal({ open, onClose, payload }: { open: boolean; onClose: () => void; payload: ExpandedCellPayload | null }) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const [copied, setCopied] = useState(false);
  if (!open || !payload) return null;
  const textToCopy = Array.isArray(payload.value) ? (payload.value as string[]).join('\n') : String(payload.value ?? '');
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(textToCopy); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60 p-4">
      <div ref={trapRef} tabIndex={-1} {...modalAriaProps('cell-expand-title')}
           onClick={(e) => e.stopPropagation()}
           className="bg-surface border border-hairline-soft rounded-md p-5 max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <h3 id="cell-expand-title" className="font-serif text-base font-semibold text-ink">{payload.label}</h3>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleCopy}
                    className="px-2.5 py-1 rounded-sm bg-surface-card border border-hairline font-sans text-xs text-ink-muted hover:text-ink">
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" onClick={onClose} aria-label="Close"
                    className="w-7 h-7 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="1" y1="1" x2="13" y2="13" /><line x1="13" y1="1" x2="1" y2="13" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto mt-4 font-serif text-sm text-ink leading-relaxed break-words">
          {/* renderModalBody(payload) */}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose}
                  className="px-3.5 py-2 rounded-sm bg-clay text-clay-ink font-sans text-xs font-medium hover:bg-clay-active">Close</button>
        </div>
      </div>
    </div>
  );
}
```

### 10.2 ExpandableCell wrapper
```tsx
// src/entrypoints/sidepanel/components/ExpandableCell.tsx
import { useRef } from 'react';

export function ExpandableCell({ label, columnId, value, raw, onExpand, children, showExpand = true }: {
  label: string; columnId: string; value: any; raw?: string | null;
  onExpand: (p: any) => void; children: React.ReactNode; showExpand?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  if (!showExpand || value == null || value === '' || (Array.isArray(value) && value.length === 0)) return <>{children}</>;
  const handleExpand = () => onExpand({ columnId, label, value, raw, triggerRef: btnRef });
  return (
    <div className="group flex items-start gap-1 min-w-0 relative">
      <span className="min-w-0 flex-1"
            onClick={(e) => {
              if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
                const t = e.target as HTMLElement;
                if (t.closest('a')) return; // let link navigate
                e.preventDefault();
                handleExpand();
              }
            }}>
        {children}
      </span>
      <button ref={btnRef} type="button" aria-label={`Expand ${label}`} onClick={(e) => { e.stopPropagation(); handleExpand(); }}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-sm bg-surface-card border border-hairline-soft text-ink-muted hover:text-ink hover:border-hairline opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 max-[768px]:opacity-100 transition-opacity cursor-pointer">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M4 2H2v8h8V8M2 2l5 5M8 2h2v4" />
        </svg>
      </button>
    </div>
  );
}
```

---

## 11. What this plan explicitly does NOT do (scope guard)

- No inline row expansion (breaks ROW_HEIGHT invariant).
- No changes to `enableHiding` or column visibility UI.
- No changes to export output (modal is view-only; exported CSV/Excel already contains full values via `getExportColumnsFromSettings`).
- No new dependency (no `react-modal`, `headlessui` — only existing React/Tailwind/Zustand/Dexie/TanStack).
- No new permission in `wxt.config.ts`.
- No change to overlay iframe isolation or WAR narrowing.
- No migration or DB version bump.

---

## 12. Rollout recommendation

1. Implement Phase 1–3 in a single feature branch `feat/sad-358-cell-expand` (protected by existing tests).
2. Open PR with screenshots: desktop hover, mobile touch, modal per field type (title, features, BSR, url, warranty).
3. Request reviewer to verify `git diff --stat` = 4 modified + 3 new files, no unrelated diff.
4. After merge, validate on real extension build (`wxt build` + load unpacked + navigate Amazon search → preview → hover/expand cycle).

---

*End of plan — ready for implementation once you confirm. No files were modified in this pass.*
