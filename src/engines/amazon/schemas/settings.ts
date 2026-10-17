import { z } from 'zod';
import {
  DEFAULT_ENABLED_FIELDS,
  TARGET_MAX,
  TARGET_MIN,
} from '../constants/defaults';

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
  description: z.boolean().default(false),
  features: z.boolean().default(false),
});

export const AmazonSettingsSchema = z.object({
  id: z.string().default('default'),
  defaultMode: z.enum(['manual', 'automatic']).default('manual'),
  defaultTargetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX).default(100),
  scrollSpeed: z.number().int().min(200).max(2000).default(800),
  scrollInterval: z.number().int().min(200).max(5000).default(500),
  waitAfterScroll: z.number().int().min(500).max(5000).default(1500),
  duplicateDetection: z.boolean().default(true),
  includeSponsored: z.boolean().default(true),
  defaultExportFormat: z.enum(['csv', 'xlsx', 'clipboard']).default('csv'),
  excelIncludeImages: z.enum(['default', 'always', 'never']).default('default'),
  theme: z.enum(['light', 'dark', 'system']).default('light'),
  openingMode: z
    .enum(['sidepanel', 'overlay', 'window', 'tab', 'ask'])
    .default('sidepanel'),
  notifications: z.boolean().default(true),
  enabledFields: EnabledFieldsSchema.default(() => ({
    ...DEFAULT_ENABLED_FIELDS,
  })),
});

export const PartialAmazonSettingsSchema = z.object({
  id: z.string().optional(),
  defaultMode: z.enum(['manual', 'automatic']).optional(),
  defaultTargetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX).optional(),
  scrollSpeed: z.number().int().min(200).max(2000).optional(),
  scrollInterval: z.number().int().min(200).max(5000).optional(),
  waitAfterScroll: z.number().int().min(500).max(5000).optional(),
  duplicateDetection: z.boolean().optional(),
  includeSponsored: z.boolean().optional(),
  defaultExportFormat: z.enum(['csv', 'xlsx', 'clipboard']).optional(),
  excelIncludeImages: z.enum(['default', 'always', 'never']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  openingMode: z
    .enum(['sidepanel', 'overlay', 'window', 'tab', 'ask'])
    .optional(),
  notifications: z.boolean().optional(),
  enabledFields: EnabledFieldsSchema.partial().optional(),
});

export const SettingsSchema = AmazonSettingsSchema;
export const PartialSettingsSchema = PartialAmazonSettingsSchema;

export type ValidatedAmazonSettings = z.infer<typeof AmazonSettingsSchema>;
export type ValidatedPartialAmazonSettings = z.infer<
  typeof PartialAmazonSettingsSchema
>;
