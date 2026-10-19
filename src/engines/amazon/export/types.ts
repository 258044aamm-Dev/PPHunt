import type { EnabledFieldsConfig } from '../types';
import type { AmazonProduct } from '../types/product';
import {
  formatListingCategoryLabel,
  resolveListingCategory,
  resolveProductPlacements,
} from '../utils/listing-category';

export type ExportFormat = 'csv' | 'excel' | 'clipboard';

export type ExportScope = 'all' | 'selected' | 'filtered';

export interface ExportResult {
  success: boolean;
  message: string;
  count: number;
}

/**
 * Validates and normalizes an exported Amazon product image URL so missing, null,
 * placeholder, or malformed strings never corrupt CSV or XLSX exports.
 */
export function sanitizeExportImageUrl(
  rawUrl: string | null | undefined,
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
  if (
    /transparent-pixel|grey-pixel|1x1\.gif|sprite/i.test(trimmed) ||
    /\/images\/G\/01\/x-locale\/common\/transparent-pixel/i.test(trimmed)
  ) {
    return '';
  }
  if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

/**
 * Column definitions for Amazon export.
 * Supports both human-readable headers (`ASIN`, `Title`, `Price`, ...) and
 * property-key aliases (`asin`, `title`, `price`, ...) for full flexibility.
 */
export const EXPORT_COLUMNS: Record<
  string,
  keyof AmazonProduct | ((p: AmazonProduct) => string)
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
  'Past Month Sales': 'pastMonthSales',
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
  Category: (p) => formatListingCategoryLabel(resolveListingCategory(p)),
  Section: (p) => resolveProductPlacements(p).join(' + '),
  Source: (p) => {
    const baseSource = p.source ?? 'search';
    if (Array.isArray(p.placements) && p.placements.length > 1) {
      return `${baseSource} (${p.placements.join(' + ')})`;
    }
    if (p.sectionLabel) {
      const catLabel = formatListingCategoryLabel(resolveListingCategory(p));
      return p.sectionLabel.toLowerCase() === catLabel.toLowerCase()
        ? `${baseSource} (${catLabel})`
        : `${baseSource} (${catLabel}: ${p.sectionLabel})`;
    }
    if (p.listingCategory === 'recommendation') {
      return `${baseSource} (Recommendation)`;
    }
    return baseSource;
  },
  'Collected At': 'collectedAt',
  // SAD-290: derived from the snapshots table at export time, so the row shape
  // carries them even though they are not product columns.
  'Snapshot Count': (p) => {
    const value = (p as { snapshotCount?: number | null }).snapshotCount;
    return value == null ? '' : String(value);
  },
  'Last Snapshot': (p) => {
    const value = (p as { lastSnapshotAt?: string | null }).lastSnapshotAt;
    return value ?? '';
  },
};

const FIELD_KEY_TO_HEADER: Record<string, string> = {
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
  'Past Month Sales': 'Monthly Sales',
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
  listingCategory: 'Category',
  sectionLabel: 'Section',
  source: 'Source',
  collectedAt: 'Collected At',
  snapshotCount: 'Snapshot Count',
  lastSnapshotAt: 'Last Snapshot',
};

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
  'Description',
  'Features',
  'Source',
  'Collected At',
];

/**
 * Derives the visible export columns from `EnabledFieldsConfig` while always keeping
 * core identity and timestamp columns (`ASIN`, `Currency`, `URL`, `Source`, `Collected At`).
 */
export function getExportColumnsFromSettings(
  enabledFields?: Partial<EnabledFieldsConfig>,
): string[] {
  if (!enabledFields) {
    return [...DEFAULT_VISIBLE_COLUMNS];
  }

  const columns: string[] = ['ASIN'];

  if (enabledFields.title !== false) columns.push('Title');
  if (enabledFields.price !== false) columns.push('Price');
  if (enabledFields.listPrice !== false) {
    columns.push('List Price', 'Discount', 'Deal');
  }
  columns.push('Currency');
  if (enabledFields.rating !== false) columns.push('Rating');
  if (enabledFields.reviewCount !== false) columns.push('Reviews');
  columns.push('Best Sellers Rank', 'Monthly Sales');
  if (enabledFields.coupon !== false) columns.push('Coupon');
  if (enabledFields.badge !== false) columns.push('Badge');
  if (enabledFields.delivery !== false) columns.push('Delivery');
  if (enabledFields.brand !== false) columns.push('Brand');
  if (enabledFields.seller !== false) columns.push('Seller');
  if (enabledFields.availability !== false) columns.push('Availability');
  if (enabledFields.isSponsored !== false) columns.push('Sponsored');
  if (enabledFields.isPrime !== false) columns.push('Prime');
  if (enabledFields.imageUrl !== false) columns.push('Image');
  columns.push('URL');
  if (enabledFields.description) columns.push('Description');
  if (enabledFields.features) columns.push('Features');
  columns.push('Source', 'Collected At');

  return columns;
}

/**
 * Normalizes a caller-supplied list of column names (which may be either human headers
 * like `'ASIN'` or property keys like `'asin'`) into canonical keys in `EXPORT_COLUMNS`.
 */
export function resolveExportColumns(visibleColumns?: string[]): string[] {
  if (!visibleColumns || visibleColumns.length === 0) {
    return DEFAULT_VISIBLE_COLUMNS;
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of visibleColumns) {
    const header = raw in EXPORT_COLUMNS ? raw : FIELD_KEY_TO_HEADER[raw];
    if (header && header in EXPORT_COLUMNS && !seen.has(header)) {
      seen.add(header);
      resolved.push(header);
    }
  }
  return resolved.length > 0 ? resolved : DEFAULT_VISIBLE_COLUMNS;
}

/**
 * Builds the canonical Amazon export base filename (`pphunt-amazon-YYYY-MM-DD-NNN`).
 */
export function buildExportFilename(
  count: number,
  date: Date = new Date(),
): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const paddedCount = String(Math.max(0, count)).padStart(3, '0');
  return `pphunt-amazon-${yyyy}-${mm}-${dd}-${paddedCount}`;
}
