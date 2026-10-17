import type { AmazonSettings } from '../types';

export const AMAZON_ALL_EXPORT_FIELDS = [
  'asin',
  'title',
  'brand',
  'price',
  'currency',
  'listPrice',
  'discountPercentage',
  'dealBadge',
  'statusBadge',
  'couponText',
  'boughtInPastMonth',
  'bsr',
  'rating',
  'reviewCount',
  'isPrime',
  'isSponsored',
  'deliveryInfo',
  'availability',
  'seller',
  'imageUrl',
  'productUrl',
  'description',
  'features',
  'collectedAt',
  'sourceUrl',
  'pageType',
] as const;

export const ALL_EXPORT_FIELDS = AMAZON_ALL_EXPORT_FIELDS;

export const AMAZON_DEFAULT_VISIBLE_COLUMNS = [
  'imageUrl',
  'title',
  'brand',
  'price',
  'discountPercentage',
  'rating',
  'reviewCount',
  'boughtInPastMonth',
  'dealBadge',
  'isPrime',
  'asin',
] as const;

export const DEFAULT_VISIBLE_COLUMNS = AMAZON_DEFAULT_VISIBLE_COLUMNS;

export const DEFAULT_AMAZON_SETTINGS: AmazonSettings = {
  scrolling: {
    scrollAmount: 800,
    scrollInterval: 1500,
    waitAfterScroll: 2000,
    autoScroll: true,
  },
  collection: {
    includeSponsored: true,
    duplicateDetection: true,
    maxProducts: 0,
    autoRetryCount: 3,
  },
  export: {
    defaultFormat: 'csv',
    filenameTemplate: 'pphunt_{date}_{count}',
    includeHeaders: true,
    includeBom: true,
    selectedFields: [...AMAZON_ALL_EXPORT_FIELDS],
    excelIncludeImages: 'default',
  },
  storage: {
    maxHistorySessions: 50,
    autoCleanDays: 30,
  },
  ui: {
    theme: 'light',
    compactView: false,
    showThumbnails: true,
    visibleColumns: [...AMAZON_DEFAULT_VISIBLE_COLUMNS],
    openingMode: 'sidepanel',
  },
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
