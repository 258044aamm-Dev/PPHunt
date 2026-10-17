import {
  buildAmazonCSVContent,
  exportAmazonCSV,
} from '@/engines/amazon/export/csv';
import { DEFAULT_VISIBLE_COLUMNS } from '@/engines/amazon/export/types';
import type { AmazonProduct } from '@/engines/amazon/types/product';

export function buildCSVContent(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  includeBOM: boolean = false,
): string {
  return buildAmazonCSVContent(products, visibleColumns, includeBOM);
}

export function exportCSV(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  filename?: string,
  includeBOM: boolean = true,
): void {
  return exportAmazonCSV(products, visibleColumns, filename, includeBOM);
}
