import type { ScrapedProduct } from '@/types/common';

/**
 * Deduplication engine that prevents the same product from being collected twice.
 * Uses Set-based lookup for O(1) per-check performance.
 */
export class DeduplicationEngine {
  private seenASINs = new Set<string>();
  private seenURLs = new Set<string>();

  constructor(existingProducts?: { asin: string; url?: string }[]) {
    if (existingProducts) {
      for (const p of existingProducts) {
        this.add(p);
      }
    }
  }

  private normalizeKey(asin: string): string {
    return asin.trim().toUpperCase();
  }

  /** Returns true if this product has NOT been seen before. */
  isNew(product: { asin: string; url?: string }): boolean {
    const key = this.normalizeKey(product.asin);
    if (!key) return false;
    if (this.seenASINs.has(key)) return false;
    if (product.url && this.seenURLs.has(product.url)) return false;
    return true;
  }

  /** Mark a product as seen so future duplicates are caught. */
  add(product: { asin: string; url?: string }): void {
    const key = this.normalizeKey(product.asin);
    if (key) this.seenASINs.add(key);
    if (product.url) this.seenURLs.add(product.url);
  }

  /** Filter an array to only include new (non-duplicate) products. Adds them to the seen set. */
  filterNew<T extends { asin: string; url?: string }>(products: T[]): T[] {
    const unique: T[] = [];
    for (const product of products) {
      if (this.isNew(product)) {
        this.add(product);
        unique.push(product);
      }
    }
    return unique;
  }

  /**
   * Enriches existing collected products if a later DOM pass populates previously null fields,
   * and returns only the newly discovered products.
   */
  mergeAndFilterNew(
    existing: ScrapedProduct[],
    incoming: ScrapedProduct[]
  ): { newProducts: ScrapedProduct[]; updatedExisting: boolean } {
    const byAsin = new Map<string, ScrapedProduct>();
    for (const item of existing) {
      byAsin.set(this.normalizeKey(item.asin), item);
    }

    const newProducts: ScrapedProduct[] = [];
    let updatedExisting = false;

    for (const product of incoming) {
      const key = this.normalizeKey(product.asin);
      if (!key) continue;

      const prev = byAsin.get(key);
      if (prev) {
        // Fill in any null/missing fields from the newly hydrated DOM node
        const nullableFields: (keyof ScrapedProduct)[] = [
          'title',
          'price',
          'listPrice',
          'discountPercentage',
          'dealBadge',
          'currency',
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
        ];
        for (const field of nullableFields) {
          if (prev[field] == null && product[field] != null) {
            (prev as any)[field] = product[field];
            updatedExisting = true;
          }
        }
        if (!prev.isPrime && product.isPrime) {
          prev.isPrime = true;
          updatedExisting = true;
        }
        if (!prev.isSponsored && product.isSponsored) {
          prev.isSponsored = true;
          updatedExisting = true;
        }
        if (
          (!prev.features || prev.features.length === 0) &&
          product.features &&
          product.features.length > 0
        ) {
          prev.features = product.features;
          updatedExisting = true;
        }
      } else if (this.isNew(product)) {
        this.add(product);
        byAsin.set(key, product);
        newProducts.push(product);
      }
    }

    return { newProducts, updatedExisting };
  }

  /** Total number of unique products tracked. */
  get size(): number {
    return this.seenASINs.size;
  }

  /** Clears all tracked ASINs and URLs for a fresh collection session. */
  clear(): void {
    this.seenASINs.clear();
    this.seenURLs.clear();
  }
}
