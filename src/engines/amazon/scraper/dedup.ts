import type { ScrapedAmazonProduct } from '../types';
import { normalizeASIN } from '../utils/amazon-url';

export interface MergeAndFilterResult {
  newProducts: ScrapedAmazonProduct[];
  updatedExisting: boolean;
}

/**
 * ASIN-based deduplication & late-hydration enrichment engine (`AmazonDeduplicationEngine`).
 * Supports seeding session ASINs, toggling duplicate detection, and enriching previously
 * collected items when lazy hydration populates missing fields.
 */
export class AmazonDeduplicationEngine {
  private seenAsins = new Set<string>();
  private duplicatesSkippedCount = 0;
  private enabled = true;

  constructor(initialAsins?: Iterable<string>, enabled = true) {
    this.enabled = enabled;
    if (initialAsins) {
      this.seed(initialAsins);
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public seed(asins: Iterable<string>): void {
    for (const raw of asins) {
      if (typeof raw !== 'string') continue;
      const normalized = normalizeASIN(raw) ?? raw.trim().toUpperCase();
      if (normalized) {
        this.seenAsins.add(normalized);
      }
    }
  }

  public has(asin: string): boolean {
    if (!this.enabled) return false;
    const normalized = normalizeASIN(asin);
    if (!normalized) return false;
    return this.seenAsins.has(normalized);
  }

  public add(asinOrProduct: string | ScrapedAmazonProduct): boolean {
    const rawAsin =
      typeof asinOrProduct === 'string' ? asinOrProduct : asinOrProduct.asin;
    const normalized = normalizeASIN(rawAsin);
    if (!normalized) return false;

    if (this.enabled && this.seenAsins.has(normalized)) {
      this.duplicatesSkippedCount += 1;
      return false;
    }

    this.seenAsins.add(normalized);
    return true;
  }

  public filterNew(
    products: readonly ScrapedAmazonProduct[],
  ): ScrapedAmazonProduct[] {
    const fresh: ScrapedAmazonProduct[] = [];
    for (const product of products) {
      const normalized = normalizeASIN(product.asin);
      if (!normalized) continue;
      if (this.enabled && this.seenAsins.has(normalized)) {
        this.duplicatesSkippedCount += 1;
        continue;
      }
      this.seenAsins.add(normalized);
      fresh.push(product);
    }
    return fresh;
  }

  /**
   * Enriches previously null/missing fields on `existingProducts` when a re-parse after
   * lazy DOM hydration yields newly populated fields, and returns any genuinely new products.
   */
  public mergeAndFilterNew(
    existingProducts: ScrapedAmazonProduct[],
    incomingProducts: readonly ScrapedAmazonProduct[],
  ): MergeAndFilterResult {
    const existingByAsin = new Map<string, ScrapedAmazonProduct>();
    for (const item of existingProducts) {
      const asin = normalizeASIN(item.asin);
      if (asin) {
        existingByAsin.set(asin, item);
        this.seenAsins.add(asin);
      }
    }

    const newProducts: ScrapedAmazonProduct[] = [];
    let updatedExisting = false;

    for (const incoming of incomingProducts) {
      const asin = normalizeASIN(incoming.asin);
      if (!asin) continue;

      if (!this.enabled) {
        newProducts.push(incoming);
        continue;
      }

      const existing = existingByAsin.get(asin);
      if (existing) {
        this.duplicatesSkippedCount += 1;
        if (this.enrichProductInPlace(existing, incoming)) {
          updatedExisting = true;
        }
        continue;
      }

      if (this.seenAsins.has(asin)) {
        this.duplicatesSkippedCount += 1;
        continue;
      }

      this.seenAsins.add(asin);
      existingByAsin.set(asin, incoming);
      newProducts.push(incoming);
    }

    return { newProducts, updatedExisting };
  }

  private enrichProductInPlace(
    target: ScrapedAmazonProduct,
    source: ScrapedAmazonProduct,
  ): boolean {
    let changed = false;

    const nullableFields = [
      'price',
      'listPrice',
      'discountPercentage',
      'dealBadge',
      'rating',
      'reviewCount',
      'bestSellersRank',
      'pastMonthSales',
      'coupon',
      'badge',
      'delivery',
      'imageUrl',
      'brand',
      'availability',
      'seller',
      'description',
    ] as const;

    for (const key of nullableFields) {
      if (
        (target[key] === null || target[key] === undefined) &&
        source[key] !== null &&
        source[key] !== undefined
      ) {
        (target as unknown as Record<string, unknown>)[key] = source[key];
        changed = true;
      }
    }

    if (
      source.price !== null &&
      source.price !== undefined &&
      source.currency &&
      target.currency !== source.currency
    ) {
      target.currency = source.currency;
      changed = true;
    }

    if (!target.isPrime && source.isPrime) {
      target.isPrime = true;
      changed = true;
    }

    return changed;
  }

  public get size(): number {
    return this.seenAsins.size;
  }

  public get duplicatesSkipped(): number {
    return this.duplicatesSkippedCount;
  }

  public clear(): void {
    this.seenAsins.clear();
    this.duplicatesSkippedCount = 0;
  }

  public reset(): void {
    this.clear();
  }
}

export const DeduplicationEngine = AmazonDeduplicationEngine;
