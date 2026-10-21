import { z } from 'zod';
import {
  TEMU_TARGET_MAX,
  TEMU_TARGET_MIN,
} from '../constants/defaults';
import { TemuProductSchema } from './product';
import { TemuScrapedProductSchema } from './scraped-product';

/**
 * Zod schemas for all chrome.runtime.sendMessage payloads in the Temu engine.
 * Strictly namespaced with `TEMU_` prefix so Amazon and Temu messages never collide.
 */

// ─── Side Panel / Overlay → Background ────────────────────────────────────────

export const TemuStartCollectionMessageSchema = z.object({
  type: z.literal('TEMU_START_COLLECTION'),
  payload: z.object({
    mode: z.enum(['automatic', 'manual']),
    targetCount: z.number().int().min(TEMU_TARGET_MIN).max(TEMU_TARGET_MAX),
    tabId: z.number().int(),
    sessionId: z.string().uuid().optional(),
  }),
});

export const TemuStopCollectionMessageSchema = z.object({
  type: z.literal('TEMU_STOP_COLLECTION'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const TemuPauseCollectionMessageSchema = z.object({
  type: z.literal('TEMU_PAUSE_COLLECTION'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const TemuResumeCollectionMessageSchema = z.object({
  type: z.literal('TEMU_RESUME_COLLECTION'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const TemuCollectManualMessageSchema = z.object({
  type: z.literal('TEMU_COLLECT_MANUAL'),
  payload: z.object({
    tabId: z.number().int(),
    sessionId: z.string().uuid().optional(),
    targetCount: z
      .number()
      .int()
      .min(TEMU_TARGET_MIN)
      .max(TEMU_TARGET_MAX)
      .optional(),
  }),
});

export const TemuGetPageStatusMessageSchema = z.object({
  type: z.literal('TEMU_GET_PAGE_STATUS'),
  payload: z.object({
    tabId: z.number().int(),
  }),
});

export const TemuClearSessionProductsMessageSchema = z.object({
  type: z.literal('TEMU_CLEAR_SESSION_PRODUCTS'),
  payload: z.object({
    sessionId: z.string().uuid().optional(),
  }),
});

// ─── Background → Content Script ──────────────────────────────────────────────

export const TemuScrollSettingsPayloadSchema = z.object({
  scrollAmount: z.number().int().min(200).max(2000),
  scrollInterval: z.number().int().min(500).max(5000),
  waitAfterScroll: z.number().int().min(500).max(5000),
});

export const TemuCollectProductsMessageSchema = z.object({
  type: z.literal('TEMU_COLLECT_PRODUCTS'),
  payload: z.object({
    mode: z.enum(['automatic', 'manual']),
    targetCount: z.number().int().min(TEMU_TARGET_MIN).max(TEMU_TARGET_MAX),
    sessionId: z.string().uuid(),
    scroll: TemuScrollSettingsPayloadSchema.optional(),
    duplicateDetection: z.boolean().optional(),
    /** SAD-381: expand collapsed detail rows before parsing (optional, default false). */
    expandDetails: z.boolean().optional(),
    existingGoodsIds: z
      .array(z.string().regex(/^\d{6,22}$/))
      .max(2000)
      .optional(),
  }),
});

export const TemuPauseScrollingMessageSchema = z.object({
  type: z.literal('TEMU_PAUSE_SCROLLING'),
  payload: z.object({}).optional(),
});

export const TemuResumeScrollingMessageSchema = z.object({
  type: z.literal('TEMU_RESUME_SCROLLING'),
  payload: z.object({}).optional(),
});

export const TemuStopCollectionCmdMessageSchema = z.object({
  type: z.literal('TEMU_STOP_COLLECTION_CMD'),
  payload: z.object({}).optional(),
});

// ─── Content Script → Background ──────────────────────────────────────────────

/**
 * SAD-360: per-field extraction diagnostics for one product at one stage.
 * Diagnostics only — nothing branches on them, so `source`/`selector`/`reason`
 * stay loose strings instead of enums that would couple the wire schema to the
 * scraper internals.
 */
export const TemuFieldDiagnosticSchema = z.object({
  field: z.string().min(1),
  status: z.enum(['EXTRACTED', 'MISSING', 'PARSE_FAILED', 'PARTIAL', 'UNKNOWN']),
  source: z.string().optional(),
  selector: z.string().optional(),
  reason: z.string().optional(),
  validated: z.boolean().optional(),
});

export const TemuDiagnosticsReportSchema = z.object({
  /** null only for a PDP whose goodsId could not be resolved (decision D7). */
  goodsId: z.string().nullable(),
  stage: z.enum(['search', 'product_detail', 'category']),
  fields: z.array(TemuFieldDiagnosticSchema).max(64),
});

export const TemuProductsCollectedMessageSchema = z.object({
  type: z.literal('TEMU_PRODUCTS_COLLECTED'),
  payload: z.object({
    products: z.array(z.unknown()),
    pageType: z.enum(['search', 'product_detail', 'category', 'unknown']),
    pageUrl: z.string().url(),
    totalOnPage: z.number().int().nonnegative(),
    // SAD-360: optional, so a message from an older content script still
    // validates and persists exactly as before. Bounded to keep the runtime
    // message small even on a large card batch.
    productDiagnostics: z.array(TemuDiagnosticsReportSchema).max(200).optional(),
  }),
});

export const TemuCollectionProgressMessageSchema = z.object({
  type: z.literal('TEMU_COLLECTION_PROGRESS'),
  payload: z.object({
    collectedCount: z.number().int().nonnegative(),
    targetCount: z.number().int().min(TEMU_TARGET_MIN).max(TEMU_TARGET_MAX),
    status: z.enum([
      'idle',
      'collecting',
      'paused',
      'completed',
      'stopped',
      'error',
    ]),
    scrollCount: z.number().int().nonnegative(),
  }),
});

export const TemuCollectionCompleteMessageSchema = z.object({
  type: z.literal('TEMU_COLLECTION_COMPLETE'),
  payload: z.object({
    totalCollected: z.number().int().nonnegative(),
    reason: z.enum([
      'target_reached',
      'no_more_results',
      'user_stopped',
      'error',
    ]),
  }),
});

export const TemuCollectionErrorMessageSchema = z.object({
  type: z.literal('TEMU_COLLECTION_ERROR'),
  payload: z.object({
    code: z.string(),
    category: z.enum([
      'page_compatibility',
      'network',
      'captcha',
      'dom_change',
      'storage',
      'unknown',
    ]),
    title: z.string(),
    message: z.string(),
    remedy: z.string(),
    details: z.string().optional(),
  }),
});

export const TemuPageStatusResponseSchema = z.object({
  type: z.literal('TEMU_PAGE_STATUS'),
  payload: z.object({
    isTemuPage: z.boolean(),
    pageType: z.enum(['search', 'product_detail', 'category', 'unknown']),
    url: z.string(),
    productCountOnPage: z.number().int().nonnegative(),
    searchQuery: z.string().nullable(),
  }),
});

// ─── Background → Side Panel / Overlay ────────────────────────────────────────

export const TemuProductsScrapedMessageSchema = z.object({
  type: z.literal('TEMU_PRODUCTS_SCRAPED'),
  payload: z.object({
    products: z.array(TemuProductSchema),
    totalCollected: z.number().int().nonnegative(),
    targetCount: z.number().int().min(TEMU_TARGET_MIN).max(TEMU_TARGET_MAX),
    sessionId: z.string().uuid(),
    rejectedCount: z.number().int().nonnegative().optional(),
  }),
});

export const TemuCollectionStatusBroadcastSchema = z.object({
  type: z.literal('TEMU_COLLECTION_STATUS'),
  payload: z.object({
    status: z.enum([
      'idle',
      'collecting',
      'paused',
      'completed',
      'stopped',
      'error',
    ]),
    collectedCount: z.number().int().nonnegative(),
    targetCount: z.number().int().min(TEMU_TARGET_MIN).max(TEMU_TARGET_MAX),
    sessionId: z.string().uuid().nullable(),
    reason: z.string().optional(),
  }),
});

// ─── Discriminated Unions per Receiver ────────────────────────────────────────

export const TemuBackgroundIncomingMessageSchema = z.discriminatedUnion(
  'type',
  [
    TemuStartCollectionMessageSchema,
    TemuStopCollectionMessageSchema,
    TemuPauseCollectionMessageSchema,
    TemuResumeCollectionMessageSchema,
    TemuCollectManualMessageSchema,
    TemuGetPageStatusMessageSchema,
    TemuClearSessionProductsMessageSchema,
    TemuProductsCollectedMessageSchema,
    TemuCollectionProgressMessageSchema,
    TemuCollectionCompleteMessageSchema,
    TemuCollectionErrorMessageSchema,
  ]
);

export const TemuContentIncomingMessageSchema = z.discriminatedUnion('type', [
  TemuCollectProductsMessageSchema,
  TemuPauseScrollingMessageSchema,
  TemuResumeScrollingMessageSchema,
  TemuStopCollectionCmdMessageSchema,
  TemuGetPageStatusMessageSchema,
]);

export const TemuSidepanelIncomingMessageSchema = z.discriminatedUnion('type', [
  TemuProductsScrapedMessageSchema,
  TemuCollectionStatusBroadcastSchema,
  TemuCollectionProgressMessageSchema,
  TemuCollectionErrorMessageSchema,
  TemuPageStatusResponseSchema,
]);

export const TemuExtensionMessageSchema = z.discriminatedUnion('type', [
  TemuStartCollectionMessageSchema,
  TemuStopCollectionMessageSchema,
  TemuPauseCollectionMessageSchema,
  TemuResumeCollectionMessageSchema,
  TemuCollectManualMessageSchema,
  TemuGetPageStatusMessageSchema,
  TemuClearSessionProductsMessageSchema,
  TemuCollectProductsMessageSchema,
  TemuPauseScrollingMessageSchema,
  TemuResumeScrollingMessageSchema,
  TemuStopCollectionCmdMessageSchema,
  TemuProductsCollectedMessageSchema,
  TemuCollectionProgressMessageSchema,
  TemuCollectionCompleteMessageSchema,
  TemuCollectionErrorMessageSchema,
  TemuPageStatusResponseSchema,
  TemuProductsScrapedMessageSchema,
  TemuCollectionStatusBroadcastSchema,
]);

export type TemuBackgroundIncomingMessage = z.infer<
  typeof TemuBackgroundIncomingMessageSchema
>;
export type TemuContentIncomingMessage = z.infer<
  typeof TemuContentIncomingMessageSchema
>;
export type TemuSidepanelIncomingMessage = z.infer<
  typeof TemuSidepanelIncomingMessageSchema
>;
export type TemuExtensionMessage = z.infer<typeof TemuExtensionMessageSchema>;
export type TemuFieldDiagnostic = z.infer<typeof TemuFieldDiagnosticSchema>;
export type TemuDiagnosticsReport = z.infer<typeof TemuDiagnosticsReportSchema>;

// Keep TemuScrapedProductSchema referenced for re-export convenience
export { TemuScrapedProductSchema };
