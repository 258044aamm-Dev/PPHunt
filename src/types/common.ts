export type AmazonPageType =
  | 'search'
  | 'product-detail'
  | 'category'
  | 'bestsellers'
  | 'unknown';

export type ProductSource = 'search' | 'detail' | 'category';

export type ErrorCode =
  | 'NOT_AMAZON'
  | 'CAPTCHA'
  | 'SIGN_IN'
  | 'LOAD_FAILED'
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'SCRIPT_DISCONNECTED'
  | 'INJECTION_BLOCKED'
  | 'TAB_CLOSED'
  | 'EXPORT_FAILED'
  | 'STORAGE_ERROR'
  | 'UNKNOWN';

export type DiagnosticConfidence = 'confirmed' | 'likely' | 'uncertain';

export type DiagnosticRecoveryAction =
  | 'resume'
  | 'reload-and-retry'
  | 'retry'
  | 'dismiss';

export interface SafeDiagnosticContext {
  errorCode: ErrorCode;
  confidence: DiagnosticConfidence;
  sanitizedUrl: string | null;
  pageType: string | null;
  tabStatus: string | null;
  preservedProductsCount: number;
  occurredAt: string;
}

export interface ErrorDiagnostic {
  code: ErrorCode;
  category: string;
  title: string;
  confidence: DiagnosticConfidence;
  summary: string;
  rootCause: string;
  whatIsKnown: string;
  whatIsUncertain: string | null;
  potentialCauses: string[];
  troubleshootingSteps: string[];
  recoveryAction: DiagnosticRecoveryAction;
  safeContext: SafeDiagnosticContext;
}

export interface ScrapedProduct {
  asin: string;
  url: string;
  title?: string | null;
  price?: number | null;
  listPrice?: number | null;
  discountPercentage?: string | null;
  dealBadge?: string | null;
  currency?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  bestSellersRank?: string | null;
  pastMonthSales?: string | null;
  coupon?: string | null;
  badge?: string | null;
  delivery?: string | null;
  imageUrl?: string | null;
  isSponsored?: boolean;
  isPrime?: boolean;
  brand?: string | null;
  availability?: string | null;
  seller?: string | null;
  description?: string | null;
  features?: string[];
  source: ProductSource;
}
