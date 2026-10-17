import { z } from 'zod';

/**
 * Zod schema for validating a full persisted TemuProduct record.
 * Used at the IndexedDB write boundary and during import/export validation.
 */
export const TemuProductSchema = z.object({
  id: z.number().int().positive().optional(),

  goodsId: z
    .string()
    .regex(/^\d{6,22}$/, 'goodsId must be 6–22 numeric digits'),

  asin: z
    .string()
    .regex(/^\d{6,22}$/, 'asin alias must match goodsId (6–22 numeric digits)'),

  title: z.string().min(1).nullable(),

  price: z.number().nonnegative().nullable(),

  listPrice: z.number().nonnegative().nullable().optional(),

  discountPercentage: z.string().nullable().optional(),

  dealBadge: z.string().nullable().optional(),

  currency: z
    .string()
    .regex(
      /^[A-Z]{3}$/,
      'Currency must be a 3-letter ISO 4217 code (e.g. USD)'
    )
    .nullable(),

  rating: z.number().min(0).max(5).nullable(),

  reviewCount: z.number().int().nonnegative().nullable(),

  bestSellersRank: z.string().nullable().optional(),

  pastMonthSales: z.string().nullable().optional(),

  coupon: z.string().nullable().optional(),

  badge: z.string().nullable().optional(),

  delivery: z.string().nullable().optional(),

  imageUrl: z.string().url().nullable(),

  url: z.string().url(),

  isSponsored: z.boolean(),

  isPrime: z.boolean(),

  brand: z.string().nullable(),

  availability: z.string().nullable(),

  seller: z.string().nullable(),

  description: z.string().nullable(),

  features: z.array(z.string()),

  source: z.enum(['search', 'detail', 'category']),

  collectedAt: z.string().datetime({ offset: true }),

  sessionId: z.string().uuid(),
});

export type ValidatedTemuProduct = z.infer<typeof TemuProductSchema>;
