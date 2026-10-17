import { z } from 'zod';
import { ScrapedProductSchema } from './product';
// L-1 (SAD-162): the message schema reads the SAME bounds the UI components
// (TargetSelector, SettingsOverlay) and SettingsSchema use, so they cannot
// drift apart again. H-1b (SAD-170): the scroll bounds likewise mirror the
// SettingsOverlay slider ranges.
import {
  TARGET_MIN,
  TARGET_MAX,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_INTERVAL_MIN,
  SCROLL_INTERVAL_MAX,
  WAIT_AFTER_SCROLL_MIN,
  WAIT_AFTER_SCROLL_MAX,
} from '@/constants/defaults';

export const CollectionModeSchema = z.enum(['manual', 'automatic']);

export const CollectionStatusSchema = z.enum([
  'idle',
  'collecting',
  'paused',
  'completed',
  'error',
  // L-5 (SAD-162): written by background.ts and useSessionRecovery.ts —
  // matches types/session.ts. Phase 4 maps it to 'paused' at the UI boundary.
  'interrupted',
]);

export const ErrorCodeSchema = z.enum([
  'NOT_AMAZON',
  'CAPTCHA',
  'SIGN_IN',
  'LOAD_FAILED',
  'BLOCKED',
  'RATE_LIMITED',
  'SCRIPT_DISCONNECTED',
  'INJECTION_BLOCKED',
  'TAB_CLOSED',
  'EXPORT_FAILED',
  'STORAGE_ERROR',
  'UNKNOWN',
]);

// --- Side Panel → Background ---

export const StartCollectionMessageSchema = z.object({
  type: z.literal('START_COLLECTION'),
  payload: z.object({
    mode: CollectionModeSchema,
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
    tabId: z.number().int(),
    sessionKey: z.string().optional(),
  }),
});

export const ReloadAndRetryCollectionMessageSchema = z.object({
  type: z.literal('RELOAD_AND_RETRY_COLLECTION'),
  payload: z.object({
    mode: CollectionModeSchema,
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
    tabId: z.number().int(),
    sessionKey: z.string().optional(),
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

// --- Background → Content Script ---

/**
 * H-1b (SAD-170): scroll tuning carried by COLLECT_PRODUCTS so the persisted
 * settings reach the content script. Bounds mirror the SettingsOverlay slider
 * ranges exactly; defaults match the values hardcoded before this change, so
 * a message from an older background behaves identically.
 */
export const ScrollConfigSchema = z.object({
  scrollAmount: z
    .number()
    .int()
    .min(SCROLL_SPEED_MIN)
    .max(SCROLL_SPEED_MAX)
    .default(800),
  scrollInterval: z
    .number()
    .int()
    .min(SCROLL_INTERVAL_MIN)
    .max(SCROLL_INTERVAL_MAX)
    .default(500),
  waitAfterScroll: z
    .number()
    .int()
    .min(WAIT_AFTER_SCROLL_MIN)
    .max(WAIT_AFTER_SCROLL_MAX)
    .default(1500),
  duplicateDetection: z.boolean().default(true),
});

export type ScrollConfig = z.infer<typeof ScrollConfigSchema>;

export const CollectProductsMessageSchema = z.object({
  type: z.literal('COLLECT_PRODUCTS'),
  payload: z.object({
    mode: CollectionModeSchema,
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
    // Optional so a message from an older background build still validates
    // (dev reloads can briefly mix builds); defaults live in ScrollConfigSchema.
    scroll: ScrollConfigSchema.optional(),
    // Declared here so Phase 4 (Step 4.4) needs no second protocol bump.
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

// --- Content Script → Background ---

export const ProductsCollectedMessageSchema = z.object({
  type: z.literal('PRODUCTS_COLLECTED'),
  payload: z.object({
    products: z.array(ScrapedProductSchema),
    totalCount: z.number().int().min(0),
    isNewBatch: z.boolean(),
  }),
});

export const CollectionProgressMessageSchema = z.object({
  type: z.literal('COLLECTION_PROGRESS'),
  payload: z.object({
    collected: z.number().int().min(0),
    target: z.number().int().min(0),
    status: CollectionStatusSchema,
  }),
});

export const ContentErrorMessageSchema = z.object({
  type: z.literal('CONTENT_ERROR'),
  payload: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    diagnostic: z.any().optional(),
  }),
});

// --- Background → Side Panel ---

export const UpdateProgressMessageSchema = z.object({
  type: z.literal('UPDATE_PROGRESS'),
  payload: z.object({
    collected: z.number().int().min(0),
    target: z.number().int().min(0),
    status: CollectionStatusSchema,
    error: z.string().nullable(),
    sessionKey: z.string().nullable().optional(),
    diagnostic: z.any().optional(),
  }),
});

export const TabStatusChangedMessageSchema = z.object({
  type: z.literal('TAB_STATUS_CHANGED'),
  payload: z.object({
    tabId: z.number().int(),
    url: z.string(),
    isAmazon: z.boolean(),
    pageType: z
      .enum(['search', 'product-detail', 'category', 'bestsellers', 'unknown'])
      .nullable(),
  }),
});

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
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
