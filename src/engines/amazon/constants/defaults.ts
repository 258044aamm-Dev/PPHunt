import type { AmazonSettings, EnabledFieldsConfig } from '../types';

export const TARGET_MIN = 1;
export const TARGET_MAX = 1000;
export const DEFAULT_TARGET_COUNT = 50;
export const TARGET_QUICK_SELECT = [50, 100, 200, 300] as const;
export const MAX_SEEDED_ASINS = 2000;

export function clampTargetCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TARGET_COUNT;
  }
  const rounded = Math.round(value);
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, rounded));
}

export const DEFAULT_ENABLED_FIELDS: EnabledFieldsConfig = {
  title: true,
  asin: true,
  url: true,
  price: true,
  listPrice: true,
  discountPercentage: true,
  dealBadge: true,
  currency: true,
  rating: true,
  reviewCount: true,
  bestSellersRank: true,
  pastMonthSales: true,
  coupon: true,
  badge: true,
  delivery: true,
  imageUrl: true,
  isSponsored: true,
  isPrime: true,
  brand: true,
  availability: true,
  seller: true,
  description: false,
  features: false,
};

export const AMAZON_DEFAULT_VISIBLE_COLUMNS = [
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
] as const;

export const DEFAULT_VISIBLE_COLUMNS = [...AMAZON_DEFAULT_VISIBLE_COLUMNS];

export const DEFAULT_AMAZON_SETTINGS: AmazonSettings = {
  id: 'default',
  defaultMode: 'manual',
  defaultTargetCount: 100,
  scrollSpeed: 800,
  scrollInterval: 500,
  waitAfterScroll: 1500,
  duplicateDetection: true,
  includeSponsored: true,
  defaultExportFormat: 'csv',
  excelIncludeImages: 'default',
  theme: 'light',
  openingMode: 'sidepanel',
  notifications: true,
  enabledFields: { ...DEFAULT_ENABLED_FIELDS },
};

export const DEFAULT_SETTINGS: AmazonSettings = DEFAULT_AMAZON_SETTINGS;

export const AMAZON_LIMITS = {
  MAX_DB_RECORDS: 50_000,
  DB_WARN_THRESHOLD: 25_000,
  BATCH_WRITE_SIZE: 50,
  SCROLL_STUCK_THRESHOLD: 3,
  CAPTCHA_PAUSE_MS: 30_000,
  MUTATION_DEBOUNCE_MS: 300,
} as const;

export const LIMITS = AMAZON_LIMITS;
