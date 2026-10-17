import { z } from 'zod';

export const AmazonScrollingSettingsSchema = z.object({
  scrollAmount: z.number().int().min(100).max(5000),
  scrollInterval: z.number().int().min(500).max(10000),
  waitAfterScroll: z.number().int().min(500).max(10000),
  autoScroll: z.boolean(),
});

export const AmazonCollectionSettingsSchema = z.object({
  includeSponsored: z.boolean(),
  duplicateDetection: z.boolean(),
  maxProducts: z.number().int().min(0).max(50000),
  autoRetryCount: z.number().int().min(0).max(10),
});

export const AmazonExportSettingsSchema = z.object({
  defaultFormat: z.enum(['csv', 'xlsx', 'clipboard']),
  filenameTemplate: z.string().min(1),
  includeHeaders: z.boolean(),
  includeBom: z.boolean(),
  selectedFields: z.array(z.string()),
  excelIncludeImages: z.enum(['default', 'always', 'never']),
});

export const AmazonStorageSettingsSchema = z.object({
  maxHistorySessions: z.number().int().min(1).max(1000),
  autoCleanDays: z.number().int().min(1).max(365),
});

export const AmazonUISettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  compactView: z.boolean(),
  showThumbnails: z.boolean(),
  visibleColumns: z.array(z.string()),
  openingMode: z.enum(['sidepanel', 'overlay', 'window', 'tab']),
});

export const AmazonSettingsSchema = z.object({
  scrolling: AmazonScrollingSettingsSchema,
  collection: AmazonCollectionSettingsSchema,
  export: AmazonExportSettingsSchema,
  storage: AmazonStorageSettingsSchema,
  ui: AmazonUISettingsSchema,
});

export const PartialAmazonSettingsSchema = z.object({
  scrolling: AmazonScrollingSettingsSchema.partial().optional(),
  collection: AmazonCollectionSettingsSchema.partial().optional(),
  export: AmazonExportSettingsSchema.partial().optional(),
  storage: AmazonStorageSettingsSchema.partial().optional(),
  ui: AmazonUISettingsSchema.partial().optional(),
});

export const SettingsSchema = AmazonSettingsSchema;
export const PartialSettingsSchema = PartialAmazonSettingsSchema;

export type ValidatedAmazonSettings = z.infer<typeof AmazonSettingsSchema>;
export type ValidatedPartialAmazonSettings = z.infer<typeof PartialAmazonSettingsSchema>;
