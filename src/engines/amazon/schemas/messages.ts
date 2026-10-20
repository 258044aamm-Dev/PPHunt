import { z } from 'zod';
import { TARGET_MAX, TARGET_MIN } from '../constants/defaults';
import { AmazonAsinSchema, AmazonListingCategorySchema } from './product';
import { AmazonScrapedProductSchema } from './scraped-product';

export const CollectionModeSchema = z.enum(['manual', 'automatic']);

export const CollectionStatusSchema = z.enum([
  'idle',
  'collecting',
  'paused',
  'completed',
  'error',
  'interrupted',
]);

export const AmazonCollectionStatusSchema = CollectionStatusSchema;

export const AmazonPageTypeSchema = z.enum([
  'search',
  'category',
  'bestsellers',
  'product-detail',
  'other',
]);

export const PageTypeSchema = AmazonPageTypeSchema;

export const ErrorCodeSchema = z.enum([
  'BLOCKED',
  'CAPTCHA',
  'NOT_AMAZON',
  'RATE_LIMITED',
  'SCRIPT_DISCONNECTED',
  'SIGN_IN',
  'TAB_CLOSED',
  'UNKNOWN',
]);

export const AmazonErrorCodeSchema = ErrorCodeSchema;

export const ScrollSettingsPayloadSchema = z.object({
  scrollAmount: z.number().int().min(200).max(2000),
  scrollInterval: z.number().int().min(200).max(5000),
  waitAfterScroll: z.number().int().min(500).max(5000),
  duplicateDetection: z.boolean(),
});

export const StartCollectionMessageSchema = z.object({
  type: z.literal('START_COLLECTION'),
  payload: z.object({
    mode: CollectionModeSchema,
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
    tabId: z.number().int(),
    sessionKey: z.string().min(1).optional(),
  }),
});

export const ReloadAndRetryCollectionMessageSchema = z.object({
  type: z.literal('RELOAD_AND_RETRY_COLLECTION'),
  payload: z.object({
    mode: CollectionModeSchema,
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
    tabId: z.number().int(),
    sessionKey: z.string().min(1).optional(),
  }),
});

export const PauseCollectionMessageSchema = z.object({
  type: z.literal('PAUSE_COLLECTION'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const ResumeCollectionMessageSchema = z.object({
  type: z.literal('RESUME_COLLECTION'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const StopCollectionMessageSchema = z.object({
  type: z.literal('STOP_COLLECTION'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const CollectProductsMessageSchema = z.object({
  type: z.literal('COLLECT_PRODUCTS'),
  payload: z.object({
    mode: CollectionModeSchema,
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
    scroll: ScrollSettingsPayloadSchema.optional(),
    existingAsins: z.array(z.string()).optional(),
  }),
});

export const PauseScrollingMessageSchema = z.object({
  type: z.literal('PAUSE_SCROLLING'),
});

export const ResumeScrollingMessageSchema = z.object({
  type: z.literal('RESUME_SCROLLING'),
});

export const StopCollectionCmdMessageSchema = z.object({
  type: z.literal('STOP_COLLECTION_CMD'),
});

export const ProductsCollectedMessageSchema = z.object({
  type: z.literal('PRODUCTS_COLLECTED'),
  payload: z.object({
    products: z.array(AmazonScrapedProductSchema),
    totalCount: z.number().int().nonnegative(),
    isNewBatch: z.boolean(),
  }),
});

export const CollectionProgressMessageSchema = z.object({
  type: z.literal('COLLECTION_PROGRESS'),
  payload: z.object({
    collected: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    status: CollectionStatusSchema,
  }),
});

export const ContentErrorMessageSchema = z.object({
  type: z.literal('CONTENT_ERROR'),
  payload: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    diagnostic: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const UpdateProgressMessageSchema = z.object({
  type: z.literal('UPDATE_PROGRESS'),
  payload: z.object({
    collected: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    status: CollectionStatusSchema,
    error: z.string().nullable(),
    sessionKey: z.string().optional(),
    rejected: z.number().int().nonnegative().optional(),
    rejectedOf: z.number().int().nonnegative().optional(),
  }),
});

export const TabStatusChangedMessageSchema = z.object({
  type: z.literal('TAB_STATUS_CHANGED'),
  payload: z.object({
    tabId: z.number().int(),
    url: z.string(),
    isAmazon: z.boolean(),
    pageType: AmazonPageTypeSchema.nullable(),
  }),
});

export const QuickSaveCollectionBehaviorSchema = z.enum(['current', 'new', 'ask']);

export const SaveJobStateSchema = z.enum([
  'queued',
  'extracting',
  'enriching',
  'completed',
  'failed',
]);

export const SaveEnrichmentStatusSchema = z.enum([
  'complete',
  'partial',
  'failed',
  'skipped',
  'interrupted',
]);

export const SaveErrorCodeSchema = z.enum([
  'NO_PRODUCT',
  'PARSE_FAILED',
  'DB_WRITE_FAILED',
  'ENRICH_FETCH_FAILED',
  'ENRICH_PARSE_FAILED',
  'OFFSCREEN_UNAVAILABLE',
  'EXPORT_FAILED',
]);

export const SaveExtractionContextSchema = z.object({
  pageType: AmazonPageTypeSchema,
  pageUrl: z.string().url(),
  triggeredBy: z.enum(['context-menu', 'card-button']),
  searchPosition: z.number().int().positive().optional(),
  pageNumber: z.number().int().positive().optional(),
  listingCategory: AmazonListingCategorySchema.optional(),
  sectionLabel: z.string().optional(),
});

/**
 * SAD-359: per-field extraction diagnostics collected when the product was
 * parsed on a PDP in the content script. Diagnostics only (the worker logs
 * them; nothing branches on them), so `source`/`tier` stay loose strings
 * rather than enums that would couple this schema to the scraper.
 */
export const FieldDiagnosticSchema = z.object({
  field: z.string().min(1),
  status: z.enum(['EXTRACTED', 'MISSING', 'PARTIAL']),
  source: z.string().optional(),
  selector: z.string().optional(),
  tier: z.string().optional(),
  reason: z.string().optional(),
  validated: z.boolean().optional(),
});

export const ExtractionDiagnosticsReportSchema = z.object({
  asin: z.string().nullable(),
  fields: z.array(FieldDiagnosticSchema).max(64),
});

export const SaveProductMessageSchema = z.object({
  type: z.literal('SAVE_PRODUCT'),
  payload: z.object({
    jobId: z.string().min(1),
    product: AmazonScrapedProductSchema,
    context: SaveExtractionContextSchema,
    // SAD-359: optional, so a message from an older content script still validates.
    extractionDiagnostics: ExtractionDiagnosticsReportSchema.optional(),
  }),
});

export const SaveContextProductMessageSchema = z.object({
  type: z.literal('SAVE_CONTEXT_PRODUCT'),
  payload: z.object({
    requestedAt: z.string().min(1),
    // SAD-344: optional, so a message from an older background still validates.
    fromSubframe: z.boolean().optional(),
  }),
});

export const SaveJobUpdateMessageSchema = z.object({
  type: z.literal('SAVE_JOB_UPDATE'),
  payload: z.object({
    jobId: z.string().min(1),
    asin: AmazonAsinSchema,
    state: SaveJobStateSchema,
    enrichmentStatus: SaveEnrichmentStatusSchema.optional(),
    warning: z.string().optional(),
    message: z.string().optional(),
    errorCode: SaveErrorCodeSchema.optional(),
    collectionKey: z.string().min(1).optional(),
    collectionLabel: z.string().optional(),
    requiresCollectionChoice: z.boolean().optional(),
    defaultCollectionKey: z.string().min(1).optional(),
    productTitle: z.string().optional(),
    downloadReady: z.boolean().optional(),
    // SAD-343: optional so every message written before it still validates.
    tabId: z.number().int().nonnegative().optional(),
    updatedAt: z.string().min(1),
  }),
});

export const AssignSavedProductMessageSchema = z.object({
  type: z.literal('ASSIGN_SAVED_PRODUCT'),
  payload: z.object({
    jobId: z.string().min(1),
    choice: z.enum(['current', 'new']),
  }),
});

export const ExportSavedProductMessageSchema = z.object({
  type: z.literal('EXPORT_SAVED_PRODUCT'),
  payload: z.object({
    jobId: z.string().min(1).optional(),
    collectionKey: z.string().min(1).optional(),
  }),
});

export const AmazonExtensionMessageSchema = z.discriminatedUnion('type', [
  StartCollectionMessageSchema,
  ReloadAndRetryCollectionMessageSchema,
  PauseCollectionMessageSchema,
  ResumeCollectionMessageSchema,
  StopCollectionMessageSchema,
  CollectProductsMessageSchema,
  PauseScrollingMessageSchema,
  ResumeScrollingMessageSchema,
  StopCollectionCmdMessageSchema,
  ProductsCollectedMessageSchema,
  CollectionProgressMessageSchema,
  ContentErrorMessageSchema,
  UpdateProgressMessageSchema,
  TabStatusChangedMessageSchema,
  SaveProductMessageSchema,
  SaveContextProductMessageSchema,
  SaveJobUpdateMessageSchema,
  AssignSavedProductMessageSchema,
  ExportSavedProductMessageSchema,
]);

export const ExtensionMessageSchema = AmazonExtensionMessageSchema;
