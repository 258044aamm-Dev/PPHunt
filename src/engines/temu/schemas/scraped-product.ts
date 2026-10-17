import { z } from 'zod';

/**
 * Zod schema for a raw scraped Temu product sent from content script to background.
 * Identical to TemuProductSchema minus id, collectedAt, and sessionId (added by background).
 */
export const TemuScrapedProductSchema = z.object({
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
    .regex(/^[A-Z]{3}$/)
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
});

export type ValidatedTemuScrapedProduct = z.infer<
  typeof TemuScrapedProductSchema
>;
