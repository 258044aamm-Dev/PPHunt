import type {
  AmazonListingCategory,
  AmazonProduct,
  Product,
  ProductSource,
  ScrapedAmazonProduct,
  ScrapedProduct,
} from './product';

export type {
  AmazonListingCategory,
  AmazonProduct,
  Product,
  ProductSource,
  ScrapedAmazonProduct,
  ScrapedProduct,
};

export type AmazonPageType =
  | 'search'
  | 'category'
  | 'bestsellers'
  | 'product-detail'
  | 'other';
export type PageType = AmazonPageType;

export type CollectionMode = 'manual' | 'automatic';

export type AmazonCollectionStatus =
  | 'idle'
  | 'collecting'
  | 'paused'
  | 'completed'
  | 'error'
  | 'interrupted';
export type CollectionStatus = AmazonCollectionStatus;
export type SessionStatus = AmazonCollectionStatus;

export type AmazonErrorCode =
  | 'BLOCKED'
  | 'CAPTCHA'
  | 'INJECTION_BLOCKED'
  | 'NOT_AMAZON'
  | 'RATE_LIMITED'
  | 'SCRIPT_DISCONNECTED'
  | 'SIGN_IN'
  | 'TAB_CLOSED'
  | 'UNKNOWN';
export type ErrorCode = AmazonErrorCode;

export interface SafeDiagnosticContext {
  errorCode: AmazonErrorCode;
  confidence: 'confirmed' | 'likely' | 'uncertain';
  sanitizedUrl: string | null;
  pageType?: string | null;
  tabStatus: string | null;
  preservedProductsCount: number;
  preservedCount?: number;
  sanitizedMessage?: string;
  occurredAt: string;
  timestamp?: string;
}

export interface ErrorDiagnostic {
  code: AmazonErrorCode;
  category: string;
  title: string;
  confidence: 'confirmed' | 'likely' | 'uncertain';
  confidenceLabel?: string;
  summary: string;
  message?: string;
  recoveryAction:
    | 'resume'
    | 'reload-and-retry'
    | 'retry'
    | 'switch-tab'
    | 'dismiss';
  rootCause: string;
  whatIsKnown: string;
  whatIsUncertain: string | null;
  potentialCauses: string[];
  troubleshootingSteps: string[];
  safeContext: SafeDiagnosticContext;
}

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

export interface SessionState {
  id: string;
  tabId: number;
  url: string;
  status: AmazonCollectionStatus;
  mode: CollectionMode;
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}
export type AmazonCollectionSession = SessionState;
export type CollectionSession = SessionState;

export interface EnabledFieldsConfig {
  title: boolean;
  asin: boolean;
  url: boolean;
  price: boolean;
  listPrice: boolean;
  discountPercentage: boolean;
  dealBadge: boolean;
  currency: boolean;
  rating: boolean;
  reviewCount: boolean;
  bestSellersRank: boolean;
  pastMonthSales: boolean;
  coupon: boolean;
  badge: boolean;
  delivery: boolean;
  imageUrl: boolean;
  isSponsored: boolean;
  isPrime: boolean;
  brand: boolean;
  availability: boolean;
  seller: boolean;
  description: boolean;
  features: boolean;
}

export type OpeningMode = 'sidepanel' | 'overlay' | 'window' | 'tab' | 'ask';
export type ThemeMode = 'light' | 'dark' | 'system';
export type ExportFormat = 'csv' | 'excel' | 'clipboard';
export type ExcelImageBudgetMode = 'auto' | 'always' | 'never';

export interface AmazonSettings {
  id?: string;
  defaultMode: CollectionMode;
  defaultTargetCount: number;
  scrollSpeed: number;
  scrollInterval: number;
  waitAfterScroll: number;
  duplicateDetection: boolean;
  exportFormat: ExportFormat;
  exportFilename: string;
  exportImages: ExcelImageBudgetMode;
  includeBOM: boolean;
  notifications: boolean;
  separateCategorySections?: boolean;
  enabledFields: EnabledFieldsConfig;
  /** SAD-276: where a one-click save lands. */
  quickSaveCollectionBehavior: QuickSaveCollectionBehavior;
  /** SAD-276: build the configured export right after each save (default off). */
  quickSaveAutoDownload: boolean;
}
export type Settings = AmazonSettings;
export type AppSettings = AmazonSettings;

export interface AmazonHistoryEntry {
  id?: number;
  sessionKey: string;
  url: string;
  mode: CollectionMode;
  /**
   * `0` marks a target-less one-click collection (plan 7.3). Full-page runs always
   * carry the user's requested count.
   */
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  completedAt: string;
  status: AmazonCollectionStatus;
  /** Display label (SAD-277). Absent on rows written before one-click existed. */
  name?: string;
  /** Who created the collection. Absent means a pre-existing full-page run. */
  origin?: 'full-page' | 'one-click';
  /** Last write to the row (count bump, rename, move). */
  updatedAt?: string;
}
export type HistoryEntry = AmazonHistoryEntry;
export type CollectionHistory = AmazonHistoryEntry;

/** How a one-click save chooses its collection. */
export type QuickSaveCollectionBehavior = 'current' | 'new' | 'ask';

/** Lifecycle of a single one-click save job (card button / context menu). */
export type SaveJobState =
  | 'queued'
  | 'extracting'
  | 'enriching'
  | 'completed'
  | 'failed';

/** Outcome of the background PDP enrichment step. */
export type SaveEnrichmentStatus =
  | 'complete'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'interrupted';

/** Small, actionable error surface for one-click saves. */
export type SaveErrorCode =
  | 'NO_PRODUCT'
  | 'PARSE_FAILED'
  | 'DB_WRITE_FAILED'
  | 'ENRICH_FETCH_FAILED'
  | 'ENRICH_PARSE_FAILED'
  | 'OFFSCREEN_UNAVAILABLE'
  | 'EXPORT_FAILED';

/** One observation of a product at a point in time (listing or detail page). */
export interface ProductSnapshot {
  id?: number;
  asin: string;
  sessionKey: string;
  jobId: string;
  source: 'listing' | 'detail';
  capturedAt: string;
  price: number | null;
  listPrice?: number | null;
  discountPercentage?: string | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  bestSellersRank?: string | null;
  availability?: string | null;
  coupon?: string | null;
  dealBadge?: string | null;
  delivery?: string | null;
  context?: SaveExtractionContext;
}

/** Where a save came from and what the page looked like when it happened. */
export interface SaveExtractionContext {
  pageType: AmazonPageType;
  pageUrl: string;
  triggeredBy: 'context-menu' | 'card-button';
  searchPosition?: number;
  pageNumber?: number;
  listingCategory?: AmazonListingCategory;
  sectionLabel?: string;
}

export interface ScrollRuntimeSettingsPayload {
  scrollAmount: number;
  scrollInterval: number;
  waitAfterScroll: number;
  duplicateDetection: boolean;
}

export type AmazonExtensionMessage =
  | {
      type: 'START_COLLECTION';
      payload: {
        mode: CollectionMode;
        targetCount: number;
        tabId: number;
        sessionKey?: string;
      };
    }
  | {
      type: 'RELOAD_AND_RETRY_COLLECTION';
      payload: {
        mode: CollectionMode;
        targetCount: number;
        tabId: number;
        sessionKey?: string;
      };
    }
  | {
      type: 'PAUSE_COLLECTION';
      payload: { tabId: number };
    }
  | {
      type: 'RESUME_COLLECTION';
      payload: { tabId: number };
    }
  | {
      type: 'STOP_COLLECTION';
      payload: { tabId: number };
    }
  | {
      type: 'COLLECT_PRODUCTS';
      payload: {
        mode: CollectionMode;
        targetCount: number;
        scroll?: ScrollRuntimeSettingsPayload;
        existingAsins?: string[];
      };
    }
  | { type: 'PAUSE_SCROLLING' }
  | { type: 'RESUME_SCROLLING' }
  | { type: 'STOP_COLLECTION_CMD' }
  | {
      type: 'PRODUCTS_COLLECTED';
      payload: {
        products: ScrapedAmazonProduct[];
        totalCount: number;
        isNewBatch: boolean;
      };
    }
  | {
      type: 'COLLECTION_PROGRESS';
      payload: {
        collected: number;
        target: number;
        status: AmazonCollectionStatus;
      };
    }
  | {
      type: 'CONTENT_ERROR';
      payload: {
        code: AmazonErrorCode;
        message: string;
        diagnostic?: Record<string, unknown>;
      };
    }
  | {
      type: 'UPDATE_PROGRESS';
      payload: {
        collected: number;
        target: number;
        status: AmazonCollectionStatus;
        error: string | null;
        sessionKey?: string;
        rejected?: number;
        rejectedOf?: number;
      };
    }
  | {
      type: 'TAB_STATUS_CHANGED';
      payload: {
        tabId: number;
        url: string;
        isAmazon: boolean;
        pageType: AmazonPageType | null;
      };
    }
  | {
      type: 'SAVE_PRODUCT';
      payload: {
        jobId: string;
        product: ScrapedAmazonProduct;
        context: SaveExtractionContext;
      };
    }
  | {
      type: 'SAVE_CONTEXT_PRODUCT';
      payload: { requestedAt: string };
    }
  | {
      type: 'SAVE_JOB_UPDATE';
      payload: {
        jobId: string;
        asin: string;
        state: SaveJobState;
        enrichmentStatus?: SaveEnrichmentStatus;
        warning?: string;
        message?: string;
        errorCode?: SaveErrorCode;
        collectionKey?: string;
        collectionLabel?: string;
        requiresCollectionChoice?: boolean;
        defaultCollectionKey?: string;
        downloadReady?: boolean;
        updatedAt: string;
      };
    }
  | {
      type: 'RETRY_SAVE_PRODUCT';
      payload: { jobId: string };
    }
  | {
      type: 'ASSIGN_SAVED_PRODUCT';
      payload: { jobId: string; choice: 'current' | 'new' };
    }
  | {
      type: 'EXPORT_SAVED_PRODUCT';
      payload: { jobId?: string; collectionKey?: string };
    };

export type ExtensionMessage = AmazonExtensionMessage;
