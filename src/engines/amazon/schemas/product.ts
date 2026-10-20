import { z } from 'zod';

export const AmazonAsinSchema = z
  .string()
  .regex(/^[A-Z0-9]{10}$/, 'ASIN must be a 10-character uppercase alphanumeric string');

export const ProductSourceSchema = z.enum(['search', 'category', 'detail']);

export const AmazonListingCategorySchema = z.enum([
  'organic',
  'sponsored',
  'recommendation',
]);

export const AmazonProductSchema = z.object({
  id: z.number().int().positive().optional(),
  asin: AmazonAsinSchema,
  url: z.string().url(),
  title: z.string().nullable().optional().default(null),
  price: z.number().nullable().optional().default(null),
  listPrice: z.number().nullable().optional(),
  discountPercentage: z.string().nullable().optional(),
  dealBadge: z.string().nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter uppercase ISO 4217 code')
    .nullable()
    .optional()
    .default(null),
  rating: z.number().min(0).max(5).nullable().optional().default(null),
  reviewCount: z.number().int().min(0).nullable().optional().default(null),
  bestSellersRank: z.string().nullable().optional(),
  pastMonthSales: z.string().nullable().optional(),
  coupon: z.string().nullable().optional(),
  badge: z.string().nullable().optional(),
  delivery: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional().default(null),
  isSponsored: z.boolean().optional().default(false),
  isPrime: z.boolean().optional().default(false),
  brand: z.string().nullable().optional().default(null),
  availability: z.string().nullable().optional().default(null),
  seller: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  features: z.array(z.string()).optional().default([]),
  // SAD-349: optional with no default, matching listPrice/coupon/delivery, so an
  // unscraped row simply lacks the key instead of carrying an explicit null.
  warrantyDescription: z.string().nullable().optional(),
  warrantyDescriptionRaw: z.string().nullable().optional(),
  source: ProductSourceSchema,
  listingCategory: AmazonListingCategorySchema.optional(),
  sectionLabel: z.string().nullable().optional(),
  placements: z.array(z.string()).optional(),
  collectedAt: z.iso.datetime({ offset: true }),
  sessionKey: z.string().min(1),
});

export const ProductSchema = AmazonProductSchema;

export type ValidatedAmazonProduct = z.infer<typeof AmazonProductSchema>;
