import { saveAs } from 'file-saver';
import type { Product } from '@/types/product';
import { neutralizeSpreadsheetFormula } from './sanitize';
import { DEFAULT_VISIBLE_COLUMNS, EXPORT_COLUMNS } from './types';

/**
 * Builds the serialized CSV string for the given products and columns.
 * Includes the `Image` column (containing the validated image URL or empty string)
 * whenever `Image` is in `visibleColumns` (or by default when `visibleColumns` is omitted).
 */
export function buildCSVContent(
  products: Product[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  includeBOM: boolean = false
): string {
  const requested =
    visibleColumns && visibleColumns.length > 0
      ? visibleColumns
      : DEFAULT_VISIBLE_COLUMNS;
  const columns = requested.filter((col) => col in EXPORT_COLUMNS);

  // Build header row
  const header = columns.map((col) => escapeCSV(col)).join(',');

  // Build data rows
  const rows = products.map((product) => {
    return columns
      .map((col) => {
        const accessor = EXPORT_COLUMNS[col];
        let value: string;
        // R6 (SAD-191): a genuine number (e.g. a negative price delta) must
        // reach the file as the bare numeric literal — never apostrophe-
        // prefixed into text. Neutralisation applies to the string path only.
        let isNumeric = false;

        if (typeof accessor === 'function') {
          value = accessor(product);
        } else if (accessor) {
          const raw = product[accessor];
          isNumeric = typeof raw === 'number';
          value = raw == null ? '' : String(raw);
        } else {
          value = '';
        }

        return escapeCSV(value, isNumeric);
      })
      .join(',');
  });

  const csvContent = [header, ...rows].join('\n');
  return includeBOM ? `\uFEFF${csvContent}` : csvContent;
}

/**
 * Exports products as a CSV file.
 *
 * - Includes the `Image` column with the product image URL (since CSV does not support binary image embedding)
 * - Handles missing or invalid image URLs gracefully without breaking the export
 * - Proper escaping for commas, quotes, newlines
 * - UTF-8 BOM option for Excel compatibility with non-ASCII
 * - Array fields joined with "; "
 * - Null/undefined values are empty strings
 */
export function exportCSV(
  products: Product[],
  visibleColumns: string[],
  filename: string,
  includeBOM: boolean
): void {
  const fullContent = buildCSVContent(products, visibleColumns, includeBOM);
  const blob = new Blob([fullContent], {
    type: 'text/csv;charset=utf-8',
  });

  saveAs(blob, `${filename}.csv`);
}

/**
 * Escapes a CSV value:
 * - Neutralises leading spreadsheet-formula triggers (H-6) BEFORE the quoting
 *   decision, so the added apostrophe is itself quoted correctly when the
 *   value also contains a comma
 * - Wraps in double quotes if it contains commas, quotes, or newlines
 * - Escapes internal double quotes as ""
 */
function escapeCSV(value: string, skipNeutralize = false): string {
  const safe = skipNeutralize ? value : neutralizeSpreadsheetFormula(value);
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
