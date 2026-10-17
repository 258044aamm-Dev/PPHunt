/** Page types the Temu content script can detect */
export type TemuPageType =
  | 'search'
  | 'product_detail'
  | 'category'
  | 'unknown';

/** Collection session status */
export type TemuCollectionStatus =
  | 'idle'
  | 'collecting'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'error';

/** Collection mode: automatic scrolling vs user-driven manual */
export type TemuCollectionMode = 'automatic' | 'manual';

/** Source page where a Temu product was scraped from */
export type TemuProductSource = 'search' | 'detail' | 'category';

/** Export file formats */
export type TemuExportFormat = 'csv' | 'xlsx' | 'clipboard';

/** Export scope options */
export type TemuExportScope = 'all' | 'filtered' | 'selected';

/** Export image options */
export type TemuExportImageOption = 'url_only' | 'embed_image' | 'none';

/** Export image budget overrides */
export type TemuExportImageBudget = 'default' | 'always' | 'never';

/** Theme options */
export type TemuTheme = 'light' | 'dark' | 'system';

/** Navigation tabs in the side panel */
export type TemuActiveTab = 'collect' | 'history';

/** Error categories for error display */
export type TemuErrorCategory =
  | 'page_compatibility'
  | 'network'
  | 'captcha'
  | 'dom_change'
  | 'storage'
  | 'unknown';

/** Structured error info for ErrorModal */
export interface TemuErrorInfo {
  code: string;
  category: TemuErrorCategory;
  title: string;
  message: string;
  remedy: string;
  details?: string;
}

/** Collection session stored in IndexedDB */
export interface TemuCollectionSession {
  id?: number;
  sessionId: string;
  url: string;
  pageType: TemuPageType;
  searchQuery: string | null;
  mode: TemuCollectionMode;
  targetCount: number;
  collectedCount: number;
  status: TemuCollectionStatus;
  startedAt: string;
  completedAt: string | null;
}

/** Raw scraped product from Temu content script (before DB fields added) */
export interface TemuScrapedProduct {
  /** Primary numeric Temu goods identifier (e.g. "601099769178067") */
  goodsId: string;
  /** Alias for goodsId to maintain 100% table/filter/export contract parity */
  asin: string;
  title: string | null;
  price: number | null;
  listPrice?: number | null;
  discountPercentage?: string | null;
  dealBadge?: string | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  bestSellersRank?: string | null;
  pastMonthSales?: string | null;
  coupon?: string | null;
  badge?: string | null;
  delivery?: string | null;
  imageUrl: string | null;
  url: string;
  isSponsored: boolean;
  isPrime: boolean;
  brand: string | null;
  availability: string | null;
  seller: string | null;
  description: string | null;
  features: string[];
  source: TemuProductSource;
}

/** User settings stored in PPHuntTemuDB */
export interface TemuUserSettings {
  id?: number;
  defaultMode: TemuCollectionMode;
  defaultTargetCount: number;
  scrollSpeed: 'slow' | 'medium' | 'fast';
  scrollInterval: number;
  scrollAmount: number;
  waitAfterScroll: number;
  maxRetries: number;
  defaultExportFormat: TemuExportFormat;
  defaultExportColumns: string[];
  exportIncludeHeaders: boolean;
  exportImageOption: TemuExportImageOption;
  exportImageBudget: TemuExportImageBudget;
  theme: TemuTheme;
  duplicateDetection: boolean;
  soundNotifications: boolean;
  autoSavePartial: boolean;
}
