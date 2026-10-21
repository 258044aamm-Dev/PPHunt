import { z } from 'zod';
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_ENABLED_FIELDS,
  DEFAULT_ENRICH_COLLECTED_LIMIT,
  ENRICH_COLLECTED_LIMIT_OPTIONS,
  DEFAULT_QUICK_SAVE_AUTO_DOWNLOAD,
  DEFAULT_QUICK_SAVE_COLLECTION_BEHAVIOR,
  DEFAULT_TARGET_COUNT,
  SCROLL_INTERVAL_MAX,
  SCROLL_INTERVAL_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  TARGET_MAX,
  TARGET_MIN,
  WAIT_AFTER_SCROLL_MAX,
  WAIT_AFTER_SCROLL_MIN,
} from '../constants/defaults';

export { DEFAULT_ENABLED_FIELDS };

export const EnabledFieldsSchema = z.object({
  title: z.boolean().default(true),
  asin: z.boolean().default(true),
  url: z.boolean().default(true),
  price: z.boolean().default(true),
  listPrice: z.boolean().default(true),
  discountPercentage: z.boolean().default(true),
  dealBadge: z.boolean().default(true),
  currency: z.boolean().default(true),
  rating: z.boolean().default(true),
  reviewCount: z.boolean().default(true),
  bestSellersRank: z.boolean().default(true),
  pastMonthSales: z.boolean().default(true),
  coupon: z.boolean().default(true),
  badge: z.boolean().default(true),
  delivery: z.boolean().default(true),
  imageUrl: z.boolean().default(true),
  isSponsored: z.boolean().default(true),
  isPrime: z.boolean().default(true),
  brand: z.boolean().default(true),
  availability: z.boolean().default(true),
  seller: z.boolean().default(true),
  // SAD-333: default-on so a PDP-enriched save shows its two PDP-only fields.
  description: z.boolean().default(true),
  features: z.boolean().default(true),
  // SAD-357: default-on so enriched/PDP saves display Variations and Weight immediately.
  variations: z.boolean().default(true),
  weight: z.boolean().default(true),
  // SAD-349: default-on for the same reason as the two above — it is PDP-only,
  // so hiding it by default makes a right-click save look like data loss.
  // No settingsVersion bump is needed: parseStoredSettings merges
  // {...DEFAULT_ENABLED_FIELDS, ...stored}, so an existing install gains the key
  // on its next read and a deliberate later toggle-off still sticks.
  warrantyDescription: z.boolean().default(true),
});

const ExportFormatSchema = z.preprocess(
  (val) => (val === 'xlsx' ? 'excel' : val),
  z.enum(['csv', 'excel', 'clipboard']).default('csv'),
);

export const AmazonSettingsSchema = z.object({
  id: z.string().default('default'),
  // SAD-334: defaults to the current version so a row that is parsed without
  // the field (fresh install, reset, degraded fallback) is never migrated.
  // A genuinely pre-migration row is detected on the raw record, where the key
  // is absent, and is treated as version 0.
  settingsVersion: z
    .number()
    .int()
    .min(0)
    .default(CURRENT_SETTINGS_VERSION),
  defaultMode: z.enum(['manual', 'automatic']).default('manual'),
  defaultTargetCount: z
    .number()
    .int()
    .min(TARGET_MIN)
    .max(TARGET_MAX)
    .default(DEFAULT_TARGET_COUNT),
  scrollSpeed: z
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
  exportFormat: ExportFormatSchema,
  exportFilename: z.string().default(''),
  exportImages: z.enum(['auto', 'always', 'never']).default('auto'),
  includeBOM: z.boolean().default(true),
  notifications: z.boolean().default(true),
  separateCategorySections: z.boolean().default(false),
  enabledFields: EnabledFieldsSchema.default(() => ({
    ...DEFAULT_ENABLED_FIELDS,
  })),
  quickSaveCollectionBehavior: z
    .enum(['current', 'new', 'ask'])
    .default(DEFAULT_QUICK_SAVE_COLLECTION_BEHAVIOR),
  quickSaveAutoDownload: z.boolean().default(DEFAULT_QUICK_SAVE_AUTO_DOWNLOAD),
  // SAD-385: collection enrichment is no longer a switch — the product page is
  // the only source of `weight` and the full `variations`, so a collection always
  // runs that stage. A stored row that still carries `enrichCollectedProducts`
  // keeps the key untouched in IndexedDB (a non-strict `z.object` strips it) and
  // nothing reads it, so no settingsVersion bump is needed.
  enrichCollectedLimit: z
    .enum(ENRICH_COLLECTED_LIMIT_OPTIONS)
    .default(DEFAULT_ENRICH_COLLECTED_LIMIT),
});

export const PartialAmazonSettingsSchema = z.object({
  id: z.string().optional(),
  settingsVersion: z.number().int().min(0).optional(),
  defaultMode: z.enum(['manual', 'automatic']).optional(),
  defaultTargetCount: z
    .number()
    .int()
    .min(TARGET_MIN)
    .max(TARGET_MAX)
    .optional(),
  scrollSpeed: z
    .number()
    .int()
    .min(SCROLL_SPEED_MIN)
    .max(SCROLL_SPEED_MAX)
    .optional(),
  scrollInterval: z
    .number()
    .int()
    .min(SCROLL_INTERVAL_MIN)
    .max(SCROLL_INTERVAL_MAX)
    .optional(),
  waitAfterScroll: z
    .number()
    .int()
    .min(WAIT_AFTER_SCROLL_MIN)
    .max(WAIT_AFTER_SCROLL_MAX)
    .optional(),
  duplicateDetection: z.boolean().optional(),
  exportFormat: z
    .preprocess(
      (val) => (val === 'xlsx' ? 'excel' : val),
      z.enum(['csv', 'excel', 'clipboard']),
    )
    .optional(),
  exportFilename: z.string().optional(),
  exportImages: z.enum(['auto', 'always', 'never']).optional(),
  includeBOM: z.boolean().optional(),
  notifications: z.boolean().optional(),
  separateCategorySections: z.boolean().optional(),
  enabledFields: EnabledFieldsSchema.partial().optional(),
  quickSaveCollectionBehavior: z.enum(['current', 'new', 'ask']).optional(),
  quickSaveAutoDownload: z.boolean().optional(),
  // SAD-385: only the per-run budget is user-settable.
  enrichCollectedLimit: z.enum(ENRICH_COLLECTED_LIMIT_OPTIONS).optional(),
});

export const SettingsSchema = AmazonSettingsSchema;
export const PartialSettingsSchema = PartialAmazonSettingsSchema;

export type ValidatedAmazonSettings = z.infer<typeof AmazonSettingsSchema>;
export type ValidatedSettings = ValidatedAmazonSettings;
export type ValidatedPartialAmazonSettings = z.infer<
  typeof PartialAmazonSettingsSchema
>;
