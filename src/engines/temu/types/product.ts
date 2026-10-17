import type { TemuProductSource } from './index';

/**
 * Full Temu Product record as stored in PPHuntTemuDB and displayed in the UI.
 * Created by enriching a TemuScrapedProduct with sessionId and collectedAt in the background worker.
 */
export interface TemuProduct {
  /** Auto-incremented primary key in Dexie */
  id?: number;

  /** Primary Temu numeric Goods ID (6–22 digits, e.g. "601099769178067") */
  goodsId: string;

  /** Mirror of goodsId for 100% UI/table/export contract parity */
  asin: string;

  /** Product title as displayed on the listing */
  title: string | null;

  /** Current selling / discounted price as a float (e.g. 12.49), null if unavailable */
  price: number | null;

  /** Original / reference list price before discount (e.g. 39.99), null if not displayed */
  listPrice?: number | null;

  /** Displayed discount percentage (e.g. "68% off"), null if not displayed */
  discountPercentage?: string | null;

  /** Promotional deal label (e.g. "Lightning deal", "Limited time offer"), null if none */
  dealBadge?: string | null;

  /** ISO 4217 currency code (e.g. "USD", "EUR", "GBP", "CAD") */
  currency: string | null;

  /** Star rating on a 0–5 scale (e.g. 4.8), null if unrated */
  rating: number | null;

  /** Total number of customer reviews (integer), null if none */
  reviewCount: number | null;

  /** Category rank badge when displayed (e.g. "#1 Best Seller in Women's Shoes"), null if not displayed */
  bestSellersRank?: string | null;

  /** Sales velocity / total sold text (e.g. "10K+ sold"), null if not displayed */
  pastMonthSales?: string | null;

  /** Coupon or promo offer text, null if none */
  coupon?: string | null;

  /** Recognition badge (e.g. "Star store", "Top pick", "Local warehouse"), null if none */
  badge?: string | null;

  /** Primary delivery or shipping message (e.g. "Free shipping", "Local warehouse"), null if none */
  delivery?: string | null;

  /** Primary product image URL (HTTPS), null if missing */
  imageUrl: string | null;

  /** Canonical product detail URL */
  url: string;

  /** Whether the listing is marked as Ad / Sponsored */
  isSponsored: boolean;

  /** Whether the listing has Local Warehouse / Fast Shipping badge (mapped to Prime badge slot for parity) */
  isPrime: boolean;

  /** Brand or store name, null if not extracted */
  brand: string | null;

  /** Stock availability text (e.g. "In Stock", "Almost sold out", "Sold out") */
  availability: string | null;

  /** Seller / Mall name (e.g. "Sold by XYZ Official Store"), null if not on page */
  seller: string | null;

  /** Product description text (detail pages), null on search cards */
  description: string | null;

  /** Bullet-point feature / specification strings, empty array on search cards */
  features: string[];

  /** Which page type this product was scraped from */
  source: TemuProductSource;

  /** ISO 8601 timestamp when the product was collected */
  collectedAt: string;

  /** UUID of the collection session this product belongs to */
  sessionId: string;
}

/**
 * Filter state for the Temu data table toolbar.
 */
export interface TemuFilterState {
  search: string;
  priceMin: number | null;
  priceMax: number | null;
  minRating: number | null;
  source: TemuProductSource | 'all';
  primeOnly: boolean;
  hideSponsored: boolean;
}
