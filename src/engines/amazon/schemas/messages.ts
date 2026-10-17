import { z } from 'zod';
import { AmazonProductSchema } from './product';
import { AmazonScrapedProductSchema } from './scraped-product';

export const AmazonPageTypeSchema = z.enum([
  'search',
  'category',
  'detail',
  'unsupported',
]);

export const AmazonCollectionStatusSchema = z.enum([
  'idle',
  'collecting',
  'paused',
  'completed',
  'error',
]);

export const AmazonErrorCodeSchema = z.enum([
  'CAPTCHA_DETECTED',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'DOM_CHANGED',
  'STORAGE_FULL',
  'TAB_CLOSED',
  'UNKNOWN',
]);

export const AmazonCollectionSessionSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  status: AmazonCollectionStatusSchema,
  sourceUrl: z.string().min(1),
  pageType: AmazonPageTypeSchema,
  searchQuery: z.string().optional(),
  totalCollected: z.number().int().nonnegative(),
  totalDuplicatesSkipped: z.number().int().nonnegative(),
  scrollCount: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
});

export const AmazonScrollRuntimeOptionsSchema = z
  .object({
    scrollAmount: z.number().int().min(100).max(5000).optional(),
    scrollInterval: z.number().int().min(500).max(10000).optional(),
    waitAfterScroll: z.number().int().min(500).max(10000).optional(),
    duplicateDetection: z.boolean().optional(),
  })
  .optional();

export const CollectProductsMessageSchema = z.object({
  type: z.literal('COLLECT_PRODUCTS'),
  sessionId: z.string().min(1),
  existingAsins: z.array(z.string()).optional(),
  settings: AmazonScrollRuntimeOptionsSchema,
});

export const PauseCollectionMessageSchema = z.object({
  type: z.literal('PAUSE_COLLECTION'),
});

export const ResumeCollectionMessageSchema = z.object({
  type: z.literal('RESUME_COLLECTION'),
});

export const StopCollectionMessageSchema = z.object({
  type: z.literal('STOP_COLLECTION'),
});

export const CollectSinglePageMessageSchema = z.object({
  type: z.literal('COLLECT_SINGLE_PAGE'),
  sessionId: z.string().min(1),
  existingAsins: z.array(z.string()).optional(),
  duplicateDetection: z.boolean().optional(),
});

export const ProductsCollectedMessageSchema = z.object({
  type: z.literal('PRODUCTS_COLLECTED'),
  products: z.array(AmazonScrapedProductSchema),
  sessionId: z.string().min(1),
});

export const CollectionProgressMessageSchema = z.object({
  type: z.literal('COLLECTION_PROGRESS'),
  totalCollected: z.number().int().nonnegative(),
  scrollCount: z.number().int().nonnegative(),
  duplicatesSkipped: z.number().int().nonnegative(),
  status: AmazonCollectionStatusSchema,
});

export const CollectionCompleteMessageSchema = z.object({
  type: z.literal('COLLECTION_COMPLETE'),
  sessionId: z.string().min(1),
  totalCollected: z.number().int().nonnegative(),
});

export const CollectionErrorMessageSchema = z.object({
  type: z.literal('COLLECTION_ERROR'),
  sessionId: z.string().min(1),
  error: z.string(),
  code: AmazonErrorCodeSchema,
});

export const StartCollectionMessageSchema = z.object({
  type: z.literal('START_COLLECTION'),
  tabId: z.number().int(),
});

export const CollectManualMessageSchema = z.object({
  type: z.literal('COLLECT_MANUAL'),
  tabId: z.number().int(),
});

export const ExportDataMessageSchema = z.object({
  type: z.literal('EXPORT_DATA'),
  format: z.enum(['csv', 'xlsx', 'clipboard']),
  sessionId: z.string().optional(),
  fields: z.array(z.string()),
});

export const ClearSessionMessageSchema = z.object({
  type: z.literal('CLEAR_SESSION'),
  sessionId: z.string().min(1),
});

export const UpdateProgressMessageSchema = z.object({
  type: z.literal('UPDATE_PROGRESS'),
  session: AmazonCollectionSessionSchema,
  newProducts: z.array(AmazonProductSchema),
});

export const GetPageStatusMessageSchema = z.object({
  type: z.literal('GET_PAGE_STATUS'),
});

export const PageStatusMessageSchema = z.object({
  type: z.literal('PAGE_STATUS'),
  pageType: AmazonPageTypeSchema,
  url: z.string(),
  estimatedProducts: z.number().int().nonnegative().optional(),
  isCaptcha: z.boolean().optional(),
});

export const GetActiveSessionMessageSchema = z.object({
  type: z.literal('GET_ACTIVE_SESSION'),
});

export const ResumeInterruptedSessionMessageSchema = z.object({
  type: z.literal('RESUME_INTERRUPTED_SESSION'),
  sessionId: z.string().min(1),
});

export const DiscardInterruptedSessionMessageSchema = z.object({
  type: z.literal('DISCARD_INTERRUPTED_SESSION'),
  sessionId: z.string().min(1),
});

export const AmazonExtensionMessageSchema = z.discriminatedUnion('type', [
  CollectProductsMessageSchema,
  PauseCollectionMessageSchema,
  ResumeCollectionMessageSchema,
  StopCollectionMessageSchema,
  CollectSinglePageMessageSchema,
  ProductsCollectedMessageSchema,
  CollectionProgressMessageSchema,
  CollectionCompleteMessageSchema,
  CollectionErrorMessageSchema,
  StartCollectionMessageSchema,
  CollectManualMessageSchema,
  ExportDataMessageSchema,
  ClearSessionMessageSchema,
  UpdateProgressMessageSchema,
  GetPageStatusMessageSchema,
  PageStatusMessageSchema,
  GetActiveSessionMessageSchema,
  ResumeInterruptedSessionMessageSchema,
  DiscardInterruptedSessionMessageSchema,
]);

export const ExtensionMessageSchema = AmazonExtensionMessageSchema;
