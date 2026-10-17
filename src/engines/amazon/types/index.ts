import type {
  AmazonListingPageType,
  AmazonProduct,
  Product,
  ScrapedAmazonProduct,
  ScrapedProduct,
} from './product';

export type {
  AmazonListingPageType,
  AmazonProduct,
  Product,
  ScrapedAmazonProduct,
  ScrapedProduct,
};

export type AmazonPageType = 'search' | 'category' | 'detail' | 'unsupported';
export type PageType = AmazonPageType;

export type AmazonCollectionStatus =
  | 'idle'
  | 'collecting'
  | 'paused'
  | 'completed'
  | 'error';
export type CollectionStatus = AmazonCollectionStatus;

export type AmazonErrorCode =
  | 'CAPTCHA_DETECTED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'DOM_CHANGED'
  | 'STORAGE_FULL'
  | 'TAB_CLOSED'
  | 'UNKNOWN';
export type ErrorCode = AmazonErrorCode;

export type AmazonExtractionTier =
  | 'tier1_json'
  | 'tier2_semantic'
  | 'tier3_structural'
  | 'tier4_selector'
  | 'missing';

export interface AmazonDriftReport {
  cardsInspected: number;
  cardsExtracted: number;
  fieldCoverage: {
    asin: number;
    title: number;
    price: number;
    rating: number;
    reviewCount: number;
    imageUrl: number;
  };
  tierBreakdown: Record<AmazonExtractionTier, number>;
  isDriftDetected: boolean;
  driftReasons: string[];
}

export interface AmazonCollectionSession {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: AmazonCollectionStatus;
  sourceUrl: string;
  pageType: AmazonPageType;
  searchQuery?: string;
  totalCollected: number;
  totalDuplicatesSkipped: number;
  scrollCount: number;
  errorMessage?: string;
}
export type CollectionSession = AmazonCollectionSession;

export interface AmazonSettings {
  scrolling: {
    scrollAmount: number;
    scrollInterval: number;
    waitAfterScroll: number;
    autoScroll: boolean;
  };
  collection: {
    includeSponsored: boolean;
    duplicateDetection: boolean;
    maxProducts: number;
    autoRetryCount: number;
  };
  export: {
    defaultFormat: 'csv' | 'xlsx' | 'clipboard';
    filenameTemplate: string;
    includeHeaders: boolean;
    includeBom: boolean;
    selectedFields: string[];
    excelIncludeImages: 'default' | 'always' | 'never';
  };
  storage: {
    maxHistorySessions: number;
    autoCleanDays: number;
  };
  ui: {
    theme: 'light' | 'dark' | 'system';
    compactView: boolean;
    showThumbnails: boolean;
    visibleColumns: string[];
    openingMode: 'sidepanel' | 'overlay' | 'window' | 'tab';
  };
}
export type Settings = AmazonSettings;

export interface AmazonHistoryEntry {
  id?: number;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  sourceUrl: string;
  pageType: AmazonPageType;
  searchQuery?: string;
  productCount: number;
  status: AmazonCollectionStatus;
}
export type HistoryEntry = AmazonHistoryEntry;

export interface AmazonScrollRuntimeOptions {
  scrollAmount?: number;
  scrollInterval?: number;
  waitAfterScroll?: number;
  duplicateDetection?: boolean;
}

export type AmazonExtensionMessage =
  | {
      type: 'COLLECT_PRODUCTS';
      sessionId: string;
      existingAsins?: string[];
      settings?: AmazonScrollRuntimeOptions;
    }
  | { type: 'PAUSE_COLLECTION' }
  | { type: 'RESUME_COLLECTION' }
  | { type: 'STOP_COLLECTION' }
  | {
      type: 'COLLECT_SINGLE_PAGE';
      sessionId: string;
      existingAsins?: string[];
      duplicateDetection?: boolean;
    }
  | {
      type: 'PRODUCTS_COLLECTED';
      products: ScrapedAmazonProduct[];
      sessionId: string;
    }
  | {
      type: 'COLLECTION_PROGRESS';
      totalCollected: number;
      scrollCount: number;
      duplicatesSkipped: number;
      status: AmazonCollectionStatus;
    }
  | {
      type: 'COLLECTION_COMPLETE';
      sessionId: string;
      totalCollected: number;
    }
  | {
      type: 'COLLECTION_ERROR';
      sessionId: string;
      error: string;
      code: AmazonErrorCode;
    }
  | { type: 'START_COLLECTION'; tabId: number }
  | { type: 'COLLECT_MANUAL'; tabId: number }
  | {
      type: 'EXPORT_DATA';
      format: 'csv' | 'xlsx' | 'clipboard';
      sessionId?: string;
      fields: string[];
    }
  | { type: 'CLEAR_SESSION'; sessionId: string }
  | {
      type: 'UPDATE_PROGRESS';
      session: AmazonCollectionSession;
      newProducts: AmazonProduct[];
    }
  | { type: 'GET_PAGE_STATUS' }
  | {
      type: 'PAGE_STATUS';
      pageType: AmazonPageType;
      url: string;
      estimatedProducts?: number;
      isCaptcha?: boolean;
    }
  | { type: 'GET_ACTIVE_SESSION' }
  | { type: 'RESUME_INTERRUPTED_SESSION'; sessionId: string }
  | { type: 'DISCARD_INTERRUPTED_SESSION'; sessionId: string };

export type ExtensionMessage = AmazonExtensionMessage;
