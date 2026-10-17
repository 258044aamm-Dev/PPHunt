export type AmazonListingPageType = 'search' | 'category' | 'detail';

export interface AmazonProduct {
  id?: number;
  asin: string;
  title: string;
  brand?: string;
  price: number | null;
  currency: string;
  listPrice?: number | null;
  discountPercentage?: number | null;
  dealBadge?: string;
  statusBadge?: string;
  couponText?: string;
  boughtInPastMonth?: string;
  bsr?: string;
  rating: number | null;
  reviewCount: number | null;
  isPrime: boolean;
  isSponsored: boolean;
  deliveryInfo?: string;
  availability?: string;
  seller?: string;
  imageUrl: string;
  productUrl: string;
  description?: string;
  features?: string[];
  collectedAt: string;
  sourceUrl: string;
  pageType: AmazonListingPageType;
  sessionId: string;
}

export type ScrapedAmazonProduct = Omit<AmazonProduct, 'id' | 'collectedAt' | 'sessionId'>;

export type Product = AmazonProduct;
export type ScrapedProduct = ScrapedAmazonProduct;
