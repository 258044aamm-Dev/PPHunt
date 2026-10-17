import type { Product } from '@/types/product';
import { neutralizeSpreadsheetFormula } from './sanitize';
import { EXPORT_COLUMNS } from './types';

/**
 * Copies products to clipboard as TSV (tab-separated values).
 *
 * - Tab characters between columns
 * - Newlines between rows
 * - Headers included as first row
 * - Array fields joined with "; "
 * - Null values are empty strings
 * - Standard format for pasting into Google Sheets, Excel, etc.
 */
export async function exportClipboard(
  products: Product[],
  visibleColumns: string[]
): Promise<void> {
  const columns = visibleColumns.filter((col) => col in EXPORT_COLUMNS);

  // Header row
  const header = columns.join('\t');

  // Data rows
  const rows = products.map((product) => {
    return columns
      .map((col) => {
        const accessor = EXPORT_COLUMNS[col];
        let value: string;
        // R6 (SAD-191): numbers paste as bare numeric literals — neutralise
        // only the string path (matches csv.ts and excel.ts behaviour).
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

        if (isNumeric) return value;
        // Strip structural characters first (H-6), then neutralise formula
        // triggers so a value that only started with a tab is not needlessly
        // prefixed.
        return neutralizeSpreadsheetFormula(value.replace(/[\t\n]/g, ' '));
      })
      .join('\t');
  });

  const tsvContent = [header, ...rows].join('\n');

  await navigator.clipboard.writeText(tsvContent);
}