import type { TemuScrapedProduct } from '../types';

/**
 * Deduplication engine for Temu products.
 * Tracks seen `goodsId`s and canonical URLs with O(1) Set lookup, and supports
 * late-hydration field enrichment when a card's image/rating/sales load on scroll.
 */
export class TemuDeduplicationEngine {
  private seenGoodsIds = new Set<string>();
  private seenUrls = new Set<string>();

  constructor(
    existingProducts?: Array<{ goodsId?: string; asin?: string; url?: string }>
  ) {
    if (existingProducts) {
      for (const p of existingProducts) {
        this.add(p);
      }
    }
  }

  private normalizeKey(item: { goodsId?: string; asin?: string }): string {
    return (item.goodsId ?? item.asin ?? '').trim();
  }

  isNew(product: { goodsId?: string; asin?: string; url?: string }): boolean {
    const key = this.normalizeKey(product);
    if (!key) return false;
    if (this.seenGoodsIds.has(key)) return false;
    if (product.url && this.seenUrls.has(product.url)) return false;
    return true;
  }

  add(product: { goodsId?: string; asin?: string; url?: string }): void {
    const key = this.normalizeKey(product);
    if (key) this.seenGoodsIds.add(key);
    if (product.url) this.seenUrls.add(product.url);
  }

  filterNew<T extends { goodsId?: string; asin?: string; url?: string }>(
    products: T[]
  ): T[] {
    const unique: T[] = [];
    for (const product of products) {
      if (this.isNew(product)) {
        this.add(product);
        unique.push(product);
      }
    }
    return unique;
  }

  mergeAndFilterNew(
    existing: TemuScrapedProduct[],
    incoming: TemuScrapedProduct[]
  ): { newProducts: TemuScrapedProduct[]; updatedExisting: boolean } {
    const byGoodsId = new Map<string, TemuScrapedProduct>();
    for (const item of existing) {
      byGoodsId.set(this.normalizeKey(item), item);
    }

    const newProducts: TemuScrapedProduct[] = [];
    let updatedExisting = false;

    for (const product of incoming) {
      const key = this.normalizeKey(product);
      if (!key) continue;

      const prev = byGoodsId.get(key);
      if (prev) {
        const nullableFields: Array<keyof TemuScrapedProduct> = [
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
            (prev as unknown as Record<string, unknown>)[field] =
              product[field];
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
        byGoodsId.set(key, product);
        newProducts.push(product);
      }
    }

    return { newProducts, updatedExisting };
  }

  get size(): number {
    return this.seenGoodsIds.size;
  }

  clear(): void {
    this.seenGoodsIds.clear();
    this.seenUrls.clear();
  }
}
