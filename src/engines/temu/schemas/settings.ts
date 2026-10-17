import { z } from 'zod';

/**
 * Zod schema for Temu UserSettings stored in PPHuntTemuDB.
 */
export const TemuSettingsSchema = z.object({
  id: z.number().int().positive().optional(),

  defaultMode: z.enum(['automatic', 'manual']).default('automatic'),

  defaultTargetCount: z.number().int().min(1).max(10000).default(50),

  scrollSpeed: z.enum(['slow', 'medium', 'fast']).default('medium'),

  scrollInterval: z.number().int().min(500).max(5000).default(1500),

  scrollAmount: z.number().int().min(200).max(2000).default(800),

  waitAfterScroll: z.number().int().min(500).max(5000).default(2000),

  maxRetries: z.number().int().min(1).max(10).default(3),

  defaultExportFormat: z.enum(['csv', 'xlsx', 'clipboard']).default('csv'),

  defaultExportColumns: z
    .array(z.string())
    .default([
      'asin',
      'title',
      'price',
      'listPrice',
      'discountPercentage',
      'dealBadge',
      'currency',
      'rating',
      'reviewCount',
      'bestSellersRank',
      'pastMonthSales',
      'coupon',
      'badge',
      'delivery',
      'url',
      'imageUrl',
      'brand',
      'seller',
      'availability',
      'isPrime',
      'isSponsored',
      'description',
      'features',
      'source',
      'collectedAt',
    ]),

  exportIncludeHeaders: z.boolean().default(true),

  exportImageOption: z
    .enum(['url_only', 'embed_image', 'none'])
    .default('url_only'),

  exportImageBudget: z.enum(['default', 'always', 'never']).default('default'),

  theme: z.enum(['light', 'dark', 'system']).default('light'),

  duplicateDetection: z.boolean().default(true),

  soundNotifications: z.boolean().default(false),

  autoSavePartial: z.boolean().default(true),
});

export type ValidatedTemuSettings = z.infer<typeof TemuSettingsSchema>;
