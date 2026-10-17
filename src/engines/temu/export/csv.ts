import { saveAs } from 'file-saver';
import type { TemuProduct } from '../types/product';
import { neutralizeTemuSpreadsheetFormula } from './sanitize';
import {
  DEFAULT_TEMU_VISIBLE_COLUMNS,
  TEMU_EXPORT_COLUMNS,
  buildTemuExportFilename,
  resolveTemuExportColumns,
} from './types';

function escapeTemuCSV(value: string, skipNeutralize = false): string {
  const safe = skipNeutralize
    ? value
    : neutralizeTemuSpreadsheetFormula(value);
  if (
    safe.includes(',') ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r')
  ) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Builds the serialized CSV string for Temu products.
 * Includes UTF-8 BOM (`\uFEFF`) by default so Excel opens non-ASCII titles cleanly.
 */
export function buildTemuCSVContent(
  products: TemuProduct[],
  visibleColumns: string[] = DEFAULT_TEMU_VISIBLE_COLUMNS,
  includeBOM: boolean = true
): string {
  const columns = resolveTemuExportColumns(visibleColumns);
  const header = columns.map((col) => escapeTemuCSV(col)).join(',');

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

        return escapeTemuCSV(value, isNumeric);
      })
      .join(',');
  });

  const csvContent = [header, ...rows].join('\n');
  return includeBOM ? `\uFEFF${csvContent}` : csvContent;
}

/**
 * Downloads Temu products as a `.csv` file (`pphunt-temu-YYYY-MM-DD-NNN.csv`).
 */
export function exportTemuCSV(
  products: TemuProduct[],
  visibleColumns: string[] = DEFAULT_TEMU_VISIBLE_COLUMNS,
  filename: string = buildTemuExportFilename(products.length),
  includeBOM: boolean = true
): void {
  const fullContent = buildTemuCSVContent(products, visibleColumns, includeBOM);
  const blob = new Blob([fullContent], {
    type: 'text/csv;charset=utf-8',
  });
  const cleanName = filename.replace(/\.csv$/i, '');
  saveAs(blob, `${cleanName}.csv`);
}
