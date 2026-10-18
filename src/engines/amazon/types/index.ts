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
}
export type Settings = AmazonSettings;
export type AppSettings = AmazonSettings;

export interface AmazonHistoryEntry {
  id?: number;
  sessionKey: string;
  url: string;
  mode: CollectionMode;
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  completedAt: string;
  status: AmazonCollectionStatus;
}
export type HistoryEntry = AmazonHistoryEntry;
export type CollectionHistory = AmazonHistoryEntry;

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
    };

export type ExtensionMessage = AmazonExtensionMessage;
