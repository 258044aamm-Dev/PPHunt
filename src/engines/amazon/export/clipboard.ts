import type { AmazonProduct } from '../types/product';
import { neutralizeSpreadsheetFormula } from './sanitize';
import {
  DEFAULT_VISIBLE_COLUMNS,
  EXPORT_COLUMNS,
  resolveExportColumns,
} from './types';

/**
 * Builds the TSV (tab-separated values) string for pasting Amazon products into spreadsheets.
 */
export function buildClipboardTSV(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
): string {
  const columns = resolveExportColumns(visibleColumns);
  const header = columns.join('\t');

  const rows = products.map((product) => {
    return columns
      .map((col) => {
        const accessor = EXPORT_COLUMNS[col];
        let value: string;
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
        return neutralizeSpreadsheetFormula(value.replace(/[\t\n]/g, ' '));
      })
      .join('\t');
  });

  return [header, ...rows].join('\n');
}

/**
 * Copies Amazon products to the system clipboard as TSV.
 */
export async function exportClipboard(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
): Promise<void> {
  const tsvContent = buildClipboardTSV(products, visibleColumns);
  await navigator.clipboard.writeText(tsvContent);
}
