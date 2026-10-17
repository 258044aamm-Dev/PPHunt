import { z } from 'zod';

export const ProductSchema = z.object({
  id: z.number().optional(),
  asin: z.string().min(1),
  url: z.string().url(),
  title: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  listPrice: z.number().nullable().optional(),
  discountPercentage: z.string().nullable().optional(),
  dealBadge: z.string().nullable().optional(),
  // C-1: a currency must be a bare ISO-4217 code (or absent) — a URL or any
  // other junk fails validation instead of reaching IndexedDB and the exporters.
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code')
    .nullable()
    .optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
  reviewCount: z.number().int().nullable().optional(),
  bestSellersRank: z.string().nullable().optional(),
  pastMonthSales: z.string().nullable().optional(),
  coupon: z.string().nullable().optional(),
  badge: z.string().nullable().optional(),
  delivery: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  isSponsored: z.boolean().optional().default(false),
  isPrime: z.boolean().optional().default(false),
  brand: z.string().nullable().optional(),
  availability: z.string().nullable().optional(),
  seller: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  features: z.array(z.string()).optional().default([]),
  // M-7 (SAD-180): `{ offset: true }` accepts `+HH:MM` offsets — without it,
  // Zod silently rejected every product collected by users east of Greenwich
  // whose timestamps carry a local offset instead of `Z`.
  collectedAt: z.string().datetime({ offset: true }),
  sessionKey: z.string().min(1),
  pageUrl: z.string().optional(),
  source: z.enum(['search', 'detail', 'category']),
});

// Step 2.1 (SAD-161): messages.ts imports ScrapedProductSchema from './product' —
// re-export it so that path resolves. The canonical definition lives in
// './scraped-product' (the wire shape differs from ProductSchema: no
// collectedAt/sessionKey, looser url).
export { ScrapedProductSchema } from './scraped-product';
