import { z } from 'zod';

/**
 * Wire format sent by the content script inside PRODUCTS_COLLECTED.
 * Deliberately looser than ProductSchema: `collectedAt` and `sessionKey` are
 * stamped by the background script during persistence, not by the scraper.
 *
 * Three deliberate loosenings (see remediation plan §2.1):
 * 1. `url` is a plain string, not `.url()` — the scraper emits relative or
 *    protocol-less URLs in some paths; `resolveProductUrl` canonicalises them
 *    after the message is accepted.
 * 2. `imageUrl` / `rating` / `reviewCount` are type-checked only —
 *    normalisation is the parser's job; the message layer's job is to reject
 *    structurally wrong messages.
 * 3. `source` matches `ProductSource` exactly; the page-detector's
 *    'bestsellers' page type never becomes a `source` value.
 */
export const ScrapedProductSchema = z.object({
  asin: z.string().min(1),
  url: z.string(),
  title: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  listPrice: z.number().nullable().optional(),
  discountPercentage: z.string().nullable().optional(),
  dealBadge: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  reviewCount: z.number().nullable().optional(),
  bestSellersRank: z.string().nullable().optional(),
  pastMonthSales: z.string().nullable().optional(),
  coupon: z.string().nullable().optional(),
  badge: z.string().nullable().optional(),
  delivery: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  isSponsored: z.boolean().optional(),
  isPrime: z.boolean().optional(),
  brand: z.string().nullable().optional(),
  availability: z.string().nullable().optional(),
  seller: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  features: z.array(z.string()).optional(),
  source: z.enum(['search', 'detail', 'category']),
});
