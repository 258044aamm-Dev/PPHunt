# Phase 5: Export & Download System

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Allow users to export collected product data in three formats: CSV (.csv), Excel (.xlsx), and clipboard copy (TSV). Support exporting all products, only selected rows, or the currently filtered view. Let users choose which columns to include, set a custom file name, and see export success/failure feedback. All exports use UTF-8 encoding for international character support.

---

## Export Options UI

The export flow is triggered from the Preview table toolbar's "Export" dropdown. When clicked, it presents:

### Format Selector

Three options in a dropdown:
- **CSV** — downloads a .csv file
- **Excel** — downloads a .xlsx file
- **Copy** — copies TSV (tab-separated values) to the clipboard for pasting into spreadsheets

### Scope Selector

Three options:
- **All Products** — exports every product in the current dataset
- **Selected Rows** — exports only the rows the user has checked in the preview table. Disabled if no rows are selected.
- **Filtered Results** — exports only the rows matching the current search/filter. Disabled if no filter is active.

### Column Selection

Reuses the same column visibility state from the preview table. Only visible columns are included in the export. A note below the column options: "Columns match your current table view."

### File Name Input

Default: `pphunt-export-{YYYY-MM-DD}` (e.g., `pphunt-export-2026-10-14`). Editable text input. No file extension — the extension is added automatically based on format.

### Export Button

A clay-filled primary button labeled "Export" (or "Copy" for clipboard format). Clicking triggers the export and shows a status toast.

---

## CSV Export

### Implementation Details

- Headers are the column names (matching the visible column order)
- Each row is one product
- Values are comma-separated
- Fields containing commas, double quotes, or newlines are wrapped in double quotes
- Double quotes within values are escaped as `""`
- Array fields (features) are joined with "; " separator
- Null/undefined values are empty strings
- File is saved with UTF-8 BOM (`\uFEFF`) prepended for Excel compatibility with non-ASCII characters
- Content type: `text/csv;charset=utf-8`
- File downloaded via file-saver's `saveAs()` function

### UTF-8 BOM Option

In settings, there's a toggle for "Include UTF-8 BOM". When enabled (default), the BOM character is prepended. This ensures Excel correctly interprets international characters (e.g., Japanese product names from amazon.co.jp). When disabled, plain UTF-8 without BOM.

---

## Excel Export

### Implementation Details

- Uses SheetJS (xlsx) library to generate .xlsx files
- Column headers in the first row, bold
- Data rows match the column order
- Column widths are auto-sized based on content (with a minimum width of 10 and maximum of 50 characters)
- Null values are empty cells (not the string "null")
- Array fields are joined with "; " in the cell
- Date fields (collectedAt) are formatted as readable datetime strings
- Sheet name: "Products" (configurable in settings)
- File downloaded via SheetJS's `writeFile()` function

### Auto-Column Sizing

SheetJS doesn't auto-size columns natively. The export function calculates the maximum content width for each column by iterating through all rows and the header, then sets the `!cols` property on the worksheet.

---

## Clipboard Copy

### Implementation Details

- Generates TSV (tab-separated values) — tab characters between columns, newlines between rows
- TSV is the standard format for pasting into Google Sheets, Excel, and most spreadsheet apps
- Uses `navigator.clipboard.writeText()` API
- Headers included as the first row
- Array fields joined with "; "
- Null values are empty strings (two consecutive tabs)
- No BOM needed for clipboard

### Feedback

After a successful copy, show a toast: "● Copied — 67 products copied to clipboard." If clipboard access is denied (permissions), show an error toast: "● Clipboard access denied — Check browser permissions."

---

## Export Scope Details

### All Products

Query all products from IndexedDB for the current session (or all sessions if no session filter). No additional filtering applied.

### Selected Rows

Read the row selection state from @tanstack/react-table. Only products whose IDs are in the selected set are included. If the selection is empty, this option is disabled in the UI.

### Filtered Results

Apply the current global filter (search text) and any column-specific filters from @tanstack/react-table. Only rows that pass all active filters are included. If no filter is active, this option is disabled (use "All Products" instead).

---

## useExport Hook

The hook manages export state and execution:

1. `exportData(format, products, columns, filename)` — the main export function
2. `isExporting` — boolean flag (true while the export is in progress, useful for showing a loading state on the button)
3. `lastExportStatus` — `'success' | 'error' | null` — cleared after 5 seconds

### Error Handling

- If the product list is empty, show a toast: "● Nothing to export — No products match the current selection."
- If the file save fails (e.g., browser blocks the download), show a toast: "● Export failed — The browser blocked the download. Check your download settings."
- If clipboard write fails, show a toast: "● Copy failed — Clipboard access was denied."
- All errors are caught — the extension never crashes on export failure.

---

## Export Status Feedback

After a successful export:
- CSV/Excel: "● Exported — 67 products saved as pphunt-export-2026-10-14.csv"
- Clipboard: "● Copied — 67 products copied to clipboard."

Status toast uses the moss dot (success) + serif text style.

---

## Deliverables

At the end of Phase 5:
- CSV export with UTF-8 BOM, proper escaping, and file-saver download
- Excel export with SheetJS, auto-sized columns, bold headers
- Clipboard copy as TSV with proper tab/newline formatting
- Export scope: all, selected, or filtered products
- Column selection matching the table's current visibility
- Custom file name input with date-based default
- Status toasts for success and error cases
- useExport hook managing state and execution