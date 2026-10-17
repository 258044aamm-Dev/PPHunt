import {
  exportClipboard as exportAmazonClipboard,
} from '@/engines/amazon/export/clipboard';
import { DEFAULT_VISIBLE_COLUMNS } from '@/engines/amazon/export/types';
import type { AmazonProduct } from '@/engines/amazon/types/product';

export function exportClipboard(
  products: AmazonProduct[],
  visibleColumns: string[] = DEFAULT_VISIBLE_COLUMNS,
): Promise<void> {
  return exportAmazonClipboard(products, visibleColumns);
}
