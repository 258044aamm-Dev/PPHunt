import type { TemuProduct } from '../types/product';
import { neutralizeTemuSpreadsheetFormula } from './sanitize';
import {
  DEFAULT_TEMU_VISIBLE_COLUMNS,
  TEMU_EXPORT_COLUMNS,
  resolveTemuExportColumns,
} from './types';

/**
 * Builds the TSV (tab-separated values) string for pasting Temu products into spreadsheets.
 */
export function buildTemuClipboardTSV(
  products: TemuProduct[],
  visibleColumns: string[] = DEFAULT_TEMU_VISIBLE_COLUMNS
): string {
  const columns = resolveTemuExportColumns(visibleColumns);
  const header = columns.join('\t');

  const rows = products.map((product) => {
    return columns
      .map((col) => {
        const accessor = TEMU_EXPORT_COLUMNS[col];
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
        return neutralizeTemuSpreadsheetFormula(value.replace(/[\t\n\r]/g, ' '));
      })
      .join('\t');
  });

  return [header, ...rows].join('\n');
}

/**
 * Copies Temu products to the system clipboard as TSV.
 */
export async function exportTemuClipboard(
  products: TemuProduct[],
  visibleColumns: string[] = DEFAULT_TEMU_VISIBLE_COLUMNS
): Promise<void> {
  const tsvContent = buildTemuClipboardTSV(products, visibleColumns);
  await navigator.clipboard.writeText(tsvContent);
}
