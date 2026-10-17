# Phase 4: Preview Table & Data Management

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Build a spreadsheet-style product preview table that displays all collected products with search, sort, column selection, row selection, horizontal scrolling, and windowed rendering for smooth performance at 300+ rows. Show missing-field warnings and duplicate indicators per row. Provide a toolbar for searching, toggling columns, and triggering exports. The table uses @tanstack/react-table for data operations and @tanstack/react-virtual for virtualized rendering.

---

## Preview Panel Layout

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  [🔍 Search products...]         [Columns ▾]  [Export ▾] │  ← hairline input + outlined btns
│                                                          │
│  67 products · 12 selected · 3 with gaps                │  ← serif 12px, hairline (muted)
│──────────────────────────────────────────────────────────│  ← hairline-soft divider
│                                                          │
│ ☐ │  Title         │  ASIN     │  Price  │ Rating │ Prime│  ← sans 12px 600, uppercase
│───┼────────────────┼───────────┼─────────┼────────┼──────│
│ ☐ │  Echo Dot 5th… │  B09B…    │  $49.99 │  4.7   │  ✓  │  ← serif 13px, ink
│ ☐ │  Fire TV Sti…  │  B09X…    │  $24.99 │  4.5   │  ✓  │
│ ☐ │  Unknown Prod… │  B0XX…    │  —      │  —     │     │  ← hairline (gap indicator)
│ ☐ │  Echo Show 8   │  B09N…    │  $129.  │  4.6   │  ✓  │
│   │  ...virtualized rows — only ~15-20 in DOM at once... │
│──────────────────────────────────────────────────────────│
│ [Export All]   [Export Selected]   [Export Filtered]     │  ← outlined + clay CTA
└──────────────────────────────────────────────────────────┘
```

---

## Table Column Definitions

The table has 17 columns. Users can show/hide any column. Default visibility is marked below.

| Column | Key | Sortable | Default Visible | Width | Notes |
|--------|-----|----------|-----------------|-------|-------|
| Checkbox | `select` | No | Yes | 32px | Row selection |
| Title | `title` | Yes | Yes | auto (flex) | Truncated with ellipsis if too long |
| ASIN | `asin` | Yes | Yes | 100px | Monospace font for readability |
| Price | `price` | Yes | Yes | 80px | Right-aligned, formatted with currency |
| Currency | `currency` | No | No | 50px | Shown when multi-currency data exists |
| Rating | `rating` | Yes | Yes | 60px | Numeric display (4.7) |
| Reviews | `reviewCount` | Yes | Yes | 70px | Formatted with thousands separator |
| Image | `imageUrl` | No | Yes | 48px | Thumbnail preview (48×48) |
| Sponsored | `isSponsored` | Yes | Yes | 70px | Yes/No text or dot indicator |
| Prime | `isPrime` | Yes | Yes | 50px | Checkmark or empty |
| Brand | `brand` | Yes | No | auto | |
| Availability | `availability` | Yes | No | auto | "In Stock", "Only 3 left" |
| Seller | `seller` | Yes | No | auto | |
| Description | `description` | No | No | auto | Truncated, full text on hover |
| Features | `features` | No | No | auto | Count shown, expand on click |
| URL | `url` | No | No | auto | Clickable link |
| Collected At | `collectedAt` | Yes | No | 120px | Formatted datetime |

---

## @tanstack/react-table Setup

The table uses TanStack Table in "manual" mode — all sorting, filtering, and pagination are handled by the table instance, not by external state.

### Sorting

- Click a column header to sort ascending
- Click again to sort descending
- Click a third time to clear the sort
- The active sort column gets a small arrow indicator (▲ or ▼) in hairline color
- Multi-column sort is supported (hold Shift + click to add secondary sort)

### Filtering / Search

- A global search input at the top of the table
- Filters across all visible columns
- Debounced at 300ms to avoid lag on large datasets
- The search input uses the standard PPHunt input style (hairline border, 8px radius)
- When a filter is active, show "Showing X of Y products" in the summary line

### Row Selection

- Each row has a checkbox in the first column
- "Select all" checkbox in the header selects/deselects all visible (filtered) rows
- Selected count shown in the summary line: "12 selected"
- Selected rows can be exported or deleted via the toolbar

---

## @tanstack/react-virtual (Windowed Rendering)

The table body uses @tanstack/react-virtual to render only the rows visible in the viewport. This ensures smooth scrolling even with 500+ products.

### Strategy

- The table container has a fixed height (fills available side panel space below the toolbar)
- Each row has a fixed height (48px) for predictable virtual scrolling
- `useVirtualizer` is configured with the total row count and the container's scroll element
- Only ~15–20 rows are rendered in the DOM at any time
- The virtualizer calculates which rows to render based on the scroll position
- A spacer element at the top and bottom of the table body maintains correct scroll height

### Performance Characteristics

- Initial render: O(1) — only visible rows
- Scroll: O(1) — same number of DOM elements regardless of total count
- Sort: O(n log n) — the full dataset is sorted in memory, but only visible rows are rendered
- Filter: O(n) — full dataset is filtered, visible rows rendered
- Memory: Products stored in IndexedDB, loaded into memory as a flat array. 500 products × ~1KB each = ~500KB — well within limits.

---

## Table Header Row

The header row is sticky — it stays visible when scrolling the body. Each header cell:

- Font: Poppins 500, 12px, uppercase with 0.05em letter-spacing
- Color: hairline (#b0aea5) when not sorted, ink (#141413) when sorted
- Bottom border: 1px hairline-soft
- Sort indicator: a small triangle (▲/▼) next to the column name
- Click target: the entire header cell

---

## Table Body Rows

Each body row:

- Font: Lora 400, 13px, ink color
- Height: 48px fixed
- Border: 1px hairline-soft on bottom only
- Hover: surface-soft background (subtle highlight, no shadow)
- Selected: surface-card background (slightly more prominent than hover)
- Alternating row backgrounds are NOT used (too noisy for the PPHunt aesthetic)

### Cell Rendering

- **Price cells**: right-aligned, formatted with currency symbol. Null prices show "—" in hairline color.
- **Rating cells**: numeric value (4.7). Null shows "—" in hairline.
- **Review count cells**: formatted with thousands separator (12,450). Null shows "—".
- **Image cells**: 48×48 thumbnail, lazy-loaded, rounded corners (4px). Broken images show a hairline placeholder.
- **Sponsored cells**: "Yes" in hairline text or a moss dot. Not sponsored: empty.
- **Prime cells**: a checkmark character (✓) in moss color, or empty.
- **Boolean cells**: checkmark (✓) for true, empty for false.
- **Array cells** (features): show count like "5 items", expandable on click.
- **Description cells**: truncated to one line, full text on hover (title attribute).
- **URL cells**: clickable link, opens in new tab. Styled as sky color, underlined.

---

## Missing Fields Detection

Each row is checked against the currently enabled fields (from settings). If any enabled field is null, undefined, or empty on that product:

- A subtle left border (3px, clay color) appears on the row
- The specific empty cells show "—" in hairline color instead of being blank

The summary line shows: "3 with gaps" in hairline text. This tells the user how many products have at least one missing field.

---

## Duplicate Detection

When duplicate detection is enabled in settings:

- Products with the same ASIN or URL within the current session are flagged
- Duplicate rows get a surface-soft background (slightly different from normal rows)
- A small "dup" label appears in hairline 10px at the right edge of the row
- The summary line shows: "2 duplicates" in hairline text

Users can:
- Sort by a "duplicates" column (shows count of duplicates)
- Select duplicate rows and remove them
- Use a "Remove duplicates" action in the toolbar (removes all but the first occurrence)

---

## Table Toolbar

Above the table, a toolbar row with:

### Left side
- **Search input**: hairline border, 8px radius, 12px serif placeholder "Search products..."
- **Summary text**: "67 products · 12 selected · 3 with gaps" in serif 12px, hairline color

### Right side
- **Columns button**: outlined, opens a dropdown/popover with checkboxes for each column. Uses the ColumnSelector component.
- **Export button**: outlined, opens a dropdown with export options (CSV, Excel, Clipboard). Triggers the export flow from Phase 5.
- **Delete button**: outlined, clay text. Deletes selected rows. Only visible when rows are selected. Shows a confirmation popover before deleting.

---

## Column Selector

A dropdown/popover that appears when the "Columns" button is clicked. Contains:

- A checkbox for each column (except the select checkbox column — always visible)
- Column names in serif 13px
- Checked = visible, unchecked = hidden
- The selector uses TanStack's `column.toggleVisibility()` method
- Changes are applied immediately (no "Apply" button needed)
- Column visibility preferences persist in chrome.storage.local (not IndexedDB — too granular for that)

---

## useProducts Hook

The hook that connects the preview table to IndexedDB:

1. Uses `useLiveQuery` from Dexie to subscribe to all products (or products for a specific session)
2. Returns: `products` (array), `totalCount`, `duplicateCount`, `missingFieldsCount`, `isLoading`
3. Provides: `removeProducts(ids)` to bulk-delete, `clearAll()` to wipe the table
4. When the background writes new products during an active collection, `useLiveQuery` automatically triggers a re-render — the table updates in real time without polling

### Duplicate Count Calculation

Group products by ASIN. Any ASIN appearing more than once has duplicates. Count the extra occurrences (not the first).

### Missing Fields Count Calculation

For each product, check if any enabled field (per settings) is null/undefined/empty string. Count products where at least one field is missing.

---

## Row Actions

- **Select**: click the checkbox to select/deselect a row
- **Select all**: click the header checkbox to select/deselect all visible (filtered) rows
- **Remove selected**: toolbar "Delete" button removes selected rows from IndexedDB
- **Open product**: click the ASIN or URL cell to open the product page in a new tab
- **Expand features**: click the features count to expand and show the full list inline

---

## Empty State

When no products have been collected yet, the preview tab shows an empty state card:

```
┌──────────────────────────────────────────┐
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  No products collected yet         │  │  ← serif 16px, ink
│  │                                    │  │
│  │  Start a collection from the       │  │  ← serif 13px, hairline
│  │  Collect tab to see products       │  │
│  │  here.                             │  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

---

## Deliverables

At the end of Phase 4:
- Preview panel with a full-featured product table
- @tanstack/react-table with sorting, filtering, column visibility, row selection
- @tanstack/react-virtual for windowed rendering (smooth at 300+ rows)
- 17 column definitions with appropriate renderers (price, rating, boolean, image, array)
- Search input with debounced global filtering
- Column selector dropdown for toggling column visibility
- Missing fields detection (clay left border, "—" placeholders, summary count)
- Duplicate detection (surface-soft background, "dup" label, summary count, remove action)
- Table toolbar with search, column toggle, export trigger, delete
- Empty state card when no products exist
- useProducts hook with live queries for real-time updates