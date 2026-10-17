export type ProductSource = 'search' | 'category' | 'detail';

/**
 * Clean-slate scraped Amazon product record produced by the 4-tier self-healing parser.
 * Optional deal/BSR keys are omitted when absent so snapshot shapes remain clean and deterministic.
 */
export interface ScrapedAmazonProduct {
  asin: string;
  url: string;
  title: string | null;
  price?: number | null;
  listPrice?: number | null;
  discountPercentage?: string | null;
  dealBadge?: string | null;
  currency?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  bestSellersRank?: string | null;
  pastMonthSales?: string | null;
  coupon?: string | null;
  badge?: string | null;
  delivery?: string | null;
  imageUrl?: string | null;
  isSponsored?: boolean;
  isPrime?: boolean;
  brand?: string | null;
  availability?: string | null;
  seller?: string | null;
  description?: string | null;
  features?: string[];
  source: ProductSource;
}

/**
 * Stored Amazon product record in IndexedDB (`PPHuntDB.products`).
 */
export interface AmazonProduct extends Omit<ScrapedAmazonProduct, 'title'> {
  id?: number;
  title?: string | null;
  pageUrl?: string;
  collectedAt: string;
  sessionKey: string;
}

export type ScrapedProduct = ScrapedAmazonProduct;
export type Product = AmazonProduct;
