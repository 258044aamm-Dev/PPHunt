import type { TemuUserSettings } from '../types';

/** Isolated IndexedDB name for the Temu engine */
export const TEMU_DB_NAME = 'PPHuntTemuDB';

/** Isolated chrome.storage.session key for the active Temu collection session */
export const TEMU_ACTIVE_SESSION_KEY = 'pphunt.temu.activeSession';

/** SAD-360: isolated chrome.storage.session key for logged-diagnostic suppression */
export const TEMU_DIAGNOSTICS_LEDGER_KEY = 'pphunt.temu.diagnosticsSeen';

/** Isolated chrome.storage.local key for Temu theme sync */
export const TEMU_THEME_STORAGE_KEY = 'pphunt.temu.theme';

/** Default settings applied on first install for the Temu engine */
export const DEFAULT_TEMU_SETTINGS: TemuUserSettings = {
  defaultMode: 'automatic',
  defaultTargetCount: 50,
  scrollSpeed: 'medium',
  scrollInterval: 1500,
  scrollAmount: 800,
  waitAfterScroll: 2000,
  maxRetries: 3,
  defaultExportFormat: 'csv',
  defaultExportColumns: [
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
    'url',
    'imageUrl',
    'brand',
    'seller',
    'availability',
    'isPrime',
    'isSponsored',
    'description',
    'features',
    'source',
    'collectedAt',
  ],
  exportIncludeHeaders: true,
  exportImageOption: 'url_only',
  exportImageBudget: 'default',
  theme: 'light',
  duplicateDetection: true,
  soundNotifications: false,
  autoSavePartial: true,
};

/** Quick-select target count presets */
export const TEMU_TARGET_PRESETS = [50, 100, 200, 300] as const;

/** Target count bounds */
export const TEMU_TARGET_MIN = 1;
export const TEMU_TARGET_MAX = 10000;

/** Maximum sessions stored in Temu history before oldest are pruned */
export const TEMU_MAX_HISTORY_SESSIONS = 50;

/** Scroll speed presets (ms) */
export const TEMU_SCROLL_SPEED_MAP = {
  slow: { scrollInterval: 2500, scrollAmount: 600, waitAfterScroll: 3000 },
  medium: { scrollInterval: 1500, scrollAmount: 800, waitAfterScroll: 2000 },
  fast: { scrollInterval: 800, scrollAmount: 1000, waitAfterScroll: 1000 },
} as const;

/** All available export column keys and labels for Temu */
export const TEMU_ALL_EXPORT_COLUMNS = [
  { key: 'asin', label: 'Goods ID' },
  { key: 'title', label: 'Title' },
  { key: 'price', label: 'Discounted Price' },
  { key: 'listPrice', label: 'Listing Price' },
  { key: 'discountPercentage', label: 'Discount %' },
  { key: 'dealBadge', label: 'Deal Label' },
  { key: 'currency', label: 'Currency' },
  { key: 'rating', label: 'Rating' },
  { key: 'reviewCount', label: 'Reviews' },
  { key: 'bestSellersRank', label: 'Category Rank' },
  { key: 'pastMonthSales', label: 'Sales Volume' },
  { key: 'coupon', label: 'Coupon' },
  { key: 'badge', label: 'Badge' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'brand', label: 'Brand' },
  { key: 'seller', label: 'Seller / Mall' },
  { key: 'availability', label: 'Availability' },
  { key: 'isPrime', label: 'Local / Fast' },
  { key: 'isSponsored', label: 'Sponsored' },
  { key: 'url', label: 'Product URL' },
  { key: 'imageUrl', label: 'Image URL' },
  { key: 'description', label: 'Description' },
  { key: 'features', label: 'Features' },
  { key: 'source', label: 'Source Page' },
  { key: 'collectedAt', label: 'Collected At' },
] as const;

/** Default filter state for the Temu product table */
export const DEFAULT_TEMU_FILTER_STATE = {
  search: '',
  priceMin: null as number | null,
  priceMax: null as number | null,
  minRating: null as number | null,
  source: 'all' as const,
  primeOnly: false,
  hideSponsored: false,
};
