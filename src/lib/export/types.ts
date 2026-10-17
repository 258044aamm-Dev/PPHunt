import type { Product } from '@/types/product';
import type { ValidatedSettings } from '@/lib/schemas/settings';

export type ExportFormat = 'csv' | 'excel' | 'clipboard';

export type ExportScope = 'all' | 'selected' | 'filtered';

export interface ExportResult {
  success: boolean;
  message: string;
  count: number;
}

/**
 * Validates and normalizes an exported product image URL so missing, null,
 * placeholder, or malformed strings never corrupt CSV or XLSX exports (SAD-139).
 */
export function sanitizeExportImageUrl(
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
 * Column definitions for export.
 * Maps internal field names to human-readable headers.
 */
export const EXPORT_COLUMNS: Record<
  string,
  keyof Product | ((p: Product) => string)
> = {
  ASIN: 'asin',
  Title: 'title',
  Price: 'price',
  'List Price': 'listPrice',
  Discount: 'discountPercentage',
  Deal: 'dealBadge',
  Currency: 'currency',
  Rating: 'rating',
  Reviews: 'reviewCount',
  'Best Sellers Rank': 'bestSellersRank',
  'Monthly Sales': 'pastMonthSales',
  Coupon: 'coupon',
  Badge: 'badge',
  Delivery: 'delivery',
  Brand: 'brand',
  Seller: 'seller',
  Availability: 'availability',
  Sponsored: (p) => (p.isSponsored ? 'Yes' : 'No'),
  Prime: (p) => (p.isPrime ? 'Yes' : 'No'),
  Image: (p) => sanitizeExportImageUrl(p.imageUrl),
  URL: 'url',
  Description: 'description',
  Features: (p) => (p.features ?? []).join('; '),
  Source: 'source',
  'Collected At': 'collectedAt',
};

/**
 * Default export columns include all 21 core/pricing/deal/BSR/market intelligence fields + Source + Collected At,
 * while excluding Description and Features by default.
 */
export const DEFAULT_VISIBLE_COLUMNS = [
  'ASIN',
  'Title',
  'Price',
  'List Price',
  'Discount',
  'Deal',
  'Currency',
  'Rating',
  'Reviews',
  'Best Sellers Rank',
  'Monthly Sales',
  'Coupon',
  'Badge',
  'Delivery',
  'Brand',
  'Seller',
  'Availability',
  'Sponsored',
  'Prime',
  'Image',
  'URL',
  'Source',
  'Collected At',
];

const FIELD_TO_EXPORT_COLUMN: Record<
  keyof ValidatedSettings['enabledFields'],
  string
> = {
  asin: 'ASIN',
  title: 'Title',
  price: 'Price',
  listPrice: 'List Price',
  discountPercentage: 'Discount',
  dealBadge: 'Deal',
  currency: 'Currency',
  rating: 'Rating',
  reviewCount: 'Reviews',
  bestSellersRank: 'Best Sellers Rank',
  pastMonthSales: 'Monthly Sales',
  coupon: 'Coupon',
  badge: 'Badge',
  delivery: 'Delivery',
  brand: 'Brand',
  seller: 'Seller',
  availability: 'Availability',
  isSponsored: 'Sponsored',
  isPrime: 'Prime',
  imageUrl: 'Image',
  url: 'URL',
  description: 'Description',
  features: 'Features',
};

/**
 * Resolves export columns from the user's enabledFields setting,
 * falling back to DEFAULT_VISIBLE_COLUMNS.
 */
export function getExportColumnsFromSettings(
  enabledFields?: ValidatedSettings['enabledFields']
): string[] {
  if (!enabledFields) return DEFAULT_VISIBLE_COLUMNS;

  const cols: string[] = [];
  const coreFields: (keyof ValidatedSettings['enabledFields'])[] = [
    'asin',
    'title',
    'price',
    'listPrice',
    'discountPercentage',
    'dealBadge',
    'currency',
    'rating',
    'reviewCount',
    'bestSellersRank',
    'pastMonthSales',
    'coupon',
    'badge',
    'delivery',
    'brand',
    'seller',
    'availability',
    'isSponsored',
    'isPrime',
    'imageUrl',
    'url',
  ];

  for (const field of coreFields) {
    if (enabledFields[field] !== false) {
      cols.push(FIELD_TO_EXPORT_COLUMN[field]);
    }
  }

  if (enabledFields.description) {
    cols.push(FIELD_TO_EXPORT_COLUMN.description);
  }
  if (enabledFields.features) {
    cols.push(FIELD_TO_EXPORT_COLUMN.features);
  }

  cols.push('Source', 'Collected At');
  return cols;
}
