export type ProductSource = 'search' | 'category' | 'detail';

export type AmazonListingCategory = 'organic' | 'sponsored' | 'recommendation';

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
  /**
   * SAD-349: warranty period normalized to a compact token (`1-year`,
   * `90-day`, `lifetime`), read from the PDP's structured detail tables.
   * Omitted when the page states no duration, so snapshot shapes stay clean.
   */
  warrantyDescription?: string | null;
  /**
   * SAD-349: the verbatim warranty cell the token was derived from
   * (e.g. `2 year manufacturer`). Kept so the normalized form is never the
   * only surviving copy of what the page said.
   */
  warrantyDescriptionRaw?: string | null;
  source: ProductSource;
  listingCategory?: AmazonListingCategory;
  sectionLabel?: string | null;
  placements?: string[];
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
