export type ProductSource = 'search' | 'category' | 'detail';

export interface AmazonProduct {
  id?: number;
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
  collectedAt: string;
  sessionKey: string;
}

export type ScrapedAmazonProduct = Omit<
  AmazonProduct,
  'id' | 'collectedAt' | 'sessionKey'
>;

export type Product = AmazonProduct;
export type ScrapedProduct = ScrapedAmazonProduct;
