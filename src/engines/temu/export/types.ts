import type { TemuProduct } from '../types/product';

export type TemuExportFormatType = 'csv' | 'excel' | 'xlsx' | 'clipboard';

export type TemuExportScopeType = 'all' | 'selected' | 'filtered';

export interface TemuExportResult {
  success: boolean;
  message: string;
  count: number;
}

/**
 * Validates and normalizes an exported Temu product image URL so missing, null,
 * placeholder, or malformed strings never corrupt CSV or XLSX exports.
 */
export function sanitizeTemuExportImageUrl(
  rawUrl: string | null | undefined
): string {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed || /^(null|undefined|about:blank|#)$/i.test(trimmed)) {
    return '';
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
    return trimmed;
  }
  if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

/**
 * Column definitions for Temu export.
 * Supports both human-readable headers (`Goods ID`, `Title`, `Price`, ...) and
 * property-key aliases (`asin`, `goodsId`, `title`, `price`, ...) for full flexibility.
 */
export const TEMU_EXPORT_COLUMNS: Record<
  string,
  keyof TemuProduct | ((p: TemuProduct) => string)
> = {
  'Goods ID': 'goodsId',
  ASIN: 'asin',
  Title: 'title',
  Price: 'price',
  'List Price': 'listPrice',
  Discount: 'discountPercentage',
  Deal: 'dealBadge',
  Currency: 'currency',
  Rating: 'rating',
  Reviews: 'reviewCount',
  'Category Rank': 'bestSellersRank',
  'Sales Volume': 'pastMonthSales',
  Coupon: 'coupon',
  Badge: 'badge',
  Delivery: 'delivery',
  Brand: 'brand',
  Seller: 'seller',
  Availability: 'availability',
  Sponsored: (p) => (p.isSponsored ? 'Yes' : 'No'),
  'Local / Fast': (p) => (p.isPrime ? 'Yes' : 'No'),
  Image: (p) => sanitizeTemuExportImageUrl(p.imageUrl),
  URL: 'url',
  Description: 'description',
  Features: (p) => (p.features ?? []).join('; '),
  Source: 'source',
  'Collected At': 'collectedAt',
};

const FIELD_KEY_TO_HEADER: Record<string, string> = {
  goodsId: 'Goods ID',
  asin: 'Goods ID',
  title: 'Title',
  price: 'Price',
  listPrice: 'List Price',
  discountPercentage: 'Discount',
  dealBadge: 'Deal',
  currency: 'Currency',
  rating: 'Rating',
  reviewCount: 'Reviews',
  bestSellersRank: 'Category Rank',
  pastMonthSales: 'Sales Volume',
  coupon: 'Coupon',
  badge: 'Badge',
  delivery: 'Delivery',
  brand: 'Brand',
  seller: 'Seller',
  availability: 'Availability',
  isSponsored: 'Sponsored',
  isPrime: 'Local / Fast',
  imageUrl: 'Image',
  url: 'URL',
  description: 'Description',
  features: 'Features',
  source: 'Source',
  collectedAt: 'Collected At',
};

export const DEFAULT_TEMU_VISIBLE_COLUMNS = [
  'Goods ID',
  'Title',
  'Price',
  'List Price',
  'Discount',
  'Deal',
  'Currency',
  'Rating',
  'Reviews',
  'Category Rank',
  'Sales Volume',
  'Coupon',
  'Badge',
  'Delivery',
  'Brand',
  'Seller',
  'Availability',
  'Sponsored',
  'Local / Fast',
  'Image',
  'URL',
  'Source',
  'Collected At',
];

/**
 * Normalizes a caller-supplied list of column names (which may be either human headers
 * like `'Goods ID'` or property keys like `'asin'` / `'goodsId'`) into canonical
 * keys in `TEMU_EXPORT_COLUMNS`.
 */
export function resolveTemuExportColumns(visibleColumns?: string[]): string[] {
  if (!visibleColumns || visibleColumns.length === 0) {
    return DEFAULT_TEMU_VISIBLE_COLUMNS;
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of visibleColumns) {
    const header =
      raw in TEMU_EXPORT_COLUMNS ? raw : FIELD_KEY_TO_HEADER[raw];
    if (header && header in TEMU_EXPORT_COLUMNS && !seen.has(header)) {
      seen.add(header);
      resolved.push(header);
    }
  }
  return resolved.length > 0 ? resolved : DEFAULT_TEMU_VISIBLE_COLUMNS;
}

/**
 * Builds the canonical Temu export base filename (`pphunt-temu-YYYY-MM-DD-NNN`).
 */
export function buildTemuExportFilename(
  count: number,
  date: Date = new Date()
): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const paddedCount = String(Math.max(0, count)).padStart(3, '0');
  return `pphunt-temu-${yyyy}-${mm}-${dd}-${paddedCount}`;
}
