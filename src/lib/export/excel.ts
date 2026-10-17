import {
  AUTO_MAX_PRODUCTS,
  buildExcelWorkbookBuffer as buildAmazonExcelWorkbookBuffer,
  detectImageExtension,
  exportExcel as exportAmazonExcel,
  resolveEmbedImages,
  type EmbedImagesMode,
  type ExcelExportBuildOptions,
} from '@/engines/amazon/export/excel';
import { DEFAULT_VISIBLE_COLUMNS } from '@/engines/amazon/export/types';
import type { AmazonProduct } from '@/engines/amazon/types/product';

export {
  AUTO_MAX_PRODUCTS,
  detectImageExtension,
  resolveEmbedImages,
  type EmbedImagesMode,
  type ExcelExportBuildOptions,
};

export function buildExcelWorkbookBuffer(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  options: ExcelExportBuildOptions = {},
): Promise<Uint8Array> {
  return buildAmazonExcelWorkbookBuffer(products, visibleColumns, options);
}

export function exportExcel(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
  filename?: string,
  options?: ExcelExportBuildOptions,
): Promise<void> {
  return exportAmazonExcel(products, visibleColumns, filename, options);
}
