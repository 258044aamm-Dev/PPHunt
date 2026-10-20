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
  variations: boolean;
  weight: boolean;
  /** SAD-349: gates both the warranty token and its verbatim source column. */
  warrantyDescription: boolean;
}

export type OpeningMode = 'sidepanel' | 'overlay' | 'window' | 'tab' | 'ask';
export type ThemeMode = 'light' | 'dark' | 'system';
export type ExportFormat = 'csv' | 'excel' | 'clipboard';
export type ExcelImageBudgetMode = 'auto' | 'always' | 'never';

export interface AmazonSettings {
  id?: string;
  /**
   * SAD-334: schema version of the stored row. Rows written before this field
   * existed parse as 0 and are upgraded once by `db/settings.ts`.
   */
  settingsVersion: number;
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
        /**
         * SAD-369 step 3 (D11): per-product diagnostics reports for THIS
         * message only — a subset of `products`, self-identified by `asin`,
         * NOT a parallel array. Each message carries only the reports not
         * yet sent this run; products past the 50-item cap have no report.
         */
        extractionDiagnostics?: import('../scraper/extraction-diagnostics').ExtractionDiagnosticsReport[];
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
        /**
         * SAD-359 (optional): per-field extraction diagnostics when the
         * product was parsed on a PDP. Logged by the worker; never stored.
         */
        extractionDiagnostics?: import('../scraper/extraction-diagnostics').ExtractionDiagnosticsReport;
      };
    }
  | {
      type: 'SAVE_CONTEXT_PRODUCT';
      payload: {
        requestedAt: string;
        /**
         * SAD-344: true when the menu click happened inside a sub-frame. The
         * content script only ever runs in the top frame, so it can resolve
         * nothing there and should say why instead of "No product found here".
         */
        fromSubframe?: boolean;
      };
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
        productTitle?: string;
        downloadReady?: boolean;
        /**
         * SAD-343: the tab that asked for the save. Lets the side panel stay
         * quiet when that tab is the active one — the page is already showing
         * its own toast, so a second one would be a duplicate.
         */
        tabId?: number;
        updatedAt: string;
      };
    }
  | {
      type: 'ASSIGN_SAVED_PRODUCT';
      payload: { jobId: string; choice: 'current' | 'new' };
    }
  | {
      type: 'EXPORT_SAVED_PRODUCT';
      payload: { jobId?: string; collectionKey?: string };
    }
  | {
      /**
       * SAD-369 D10: the drift telemetry line, routed to the service worker
       * so it lands in the extension console instead of the page's. Counts
       * only — never product values (C2 holds across the boundary).
       */
      type: 'DRIFT_REPORT';
      payload: {
        stage: 'search-results' | 'category-page';
        report: AmazonDriftReport;
      };
    };

export type ExtensionMessage = AmazonExtensionMessage;
