import { z } from 'zod';

export const AmazonAsinSchema = z
  .string()
  .regex(/^[A-Z0-9]{10}$/, 'ASIN must be a 10-character uppercase alphanumeric string');

export const AmazonListingPageTypeSchema = z.enum(['search', 'category', 'detail']);

export const AmazonProductSchema = z.object({
  id: z.number().int().positive().optional(),
  asin: AmazonAsinSchema,
  title: z.string().min(1, 'Product title is required'),
  brand: z.string().optional(),
  price: z.number().nonnegative().nullable(),
  currency: z.string().min(1),
  listPrice: z.number().nonnegative().nullable().optional(),
  discountPercentage: z.number().min(0).max(100).nullable().optional(),
  dealBadge: z.string().optional(),
  statusBadge: z.string().optional(),
  couponText: z.string().optional(),
  boughtInPastMonth: z.string().optional(),
  bsr: z.string().optional(),
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  isPrime: z.boolean(),
  isSponsored: z.boolean(),
  deliveryInfo: z.string().optional(),
  availability: z.string().optional(),
  seller: z.string().optional(),
  imageUrl: z.string(),
  productUrl: z.string().url(),
  description: z.string().optional(),
  features: z.array(z.string()).optional(),
  collectedAt: z.iso.datetime({ offset: true }),
  sourceUrl: z.string().url(),
  pageType: AmazonListingPageTypeSchema,
  sessionId: z.string().min(1),
});

export const ProductSchema = AmazonProductSchema;

export type ValidatedAmazonProduct = z.infer<typeof AmazonProductSchema>;
