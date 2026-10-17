import { saveAs } from 'file-saver';
import type { AmazonProduct } from '../types/product';
import { neutralizeSpreadsheetFormula } from './sanitize';
import {
  DEFAULT_VISIBLE_COLUMNS,
  EXPORT_COLUMNS,
  buildExportFilename,
  resolveExportColumns,
} from './types';

function escapeCSVCell(value: string, skipNeutralize = false): string {
  const safe = skipNeutralize ? value : neutralizeSpreadsheetFormula(value);
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
 * Builds the serialized CSV string for Amazon products.
 * Defaults `includeBOM` to `false` for pure string callers unless explicitly passed `true`,
 * while `exportAmazonCSV` defaults `includeBOM` to `true` for file downloads.
 */
export function buildAmazonCSVContent(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  includeBOM: boolean = false,
): string {
  const columns = resolveExportColumns(visibleColumns);
  const header = columns.map((col) => escapeCSVCell(col)).join(',');

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

        return escapeCSVCell(value, isNumeric);
      })
      .join(',');
  });

  const csvContent = [header, ...rows].join('\n');
  return includeBOM ? `\uFEFF${csvContent}` : csvContent;
}

/**
 * Downloads Amazon products as a `.csv` file (`pphunt-amazon-YYYY-MM-DD-NNN.csv`).
 */
export function exportAmazonCSV(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  filename: string = buildExportFilename(products.length),
  includeBOM: boolean = true,
): void {
  const fullContent = buildAmazonCSVContent(
    products,
    visibleColumns,
    includeBOM,
  );
  const blob = new Blob([fullContent], {
    type: 'text/csv;charset=utf-8',
  });
  const cleanName = filename.replace(/\.csv$/i, '');
  saveAs(blob, `${cleanName}.csv`);
}

export {
  buildAmazonCSVContent as buildCSVContent,
  exportAmazonCSV as exportCSV,
};
