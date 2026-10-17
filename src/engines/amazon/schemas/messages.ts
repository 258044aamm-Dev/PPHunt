import { z } from 'zod';
import { TARGET_MAX, TARGET_MIN } from '../constants/defaults';
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
]);

export const ExtensionMessageSchema = AmazonExtensionMessageSchema;
