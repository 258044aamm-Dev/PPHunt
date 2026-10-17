import type { ScrapedAmazonProduct } from '../types';
import { normalizeAsin } from '../utils/amazon-url';

export interface AmazonBatchDedupResult {
  unique: ScrapedAmazonProduct[];
  duplicatesSkipped: number;
  enriched: ScrapedAmazonProduct[];
}

/**
 * ASIN-based deduplication & late-hydration enrichment engine for Amazon products.
 * Supports toggling `duplicateDetection` on/off via `setEnabled(boolean)` and seeding
 * previously persisted session ASINs across service worker restarts.
 */
export class AmazonDeduplicationEngine {
  private seenAsins = new Set<string>();
  private productByAsin = new Map<string, ScrapedAmazonProduct>();
  private duplicatesSkippedCount = 0;
  private enabled: boolean;

  constructor(initialAsins?: Iterable<string>, enabled = true) {
    this.enabled = enabled;
    if (initialAsins) {
      this.seed(initialAsins);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  seed(asins: Iterable<string>): void {
    for (const raw of asins) {
      const normalized = normalizeAsin(raw);
      if (normalized) {
        this.seenAsins.add(normalized);
      }
    }
  }

  has(asin: string): boolean {
    if (!this.enabled) return false;
    const normalized = normalizeAsin(asin);
    if (!normalized) return false;
    return this.seenAsins.has(normalized);
  }

  add(asinOrProduct: string | ScrapedAmazonProduct): boolean {
    const rawAsin =
      typeof asinOrProduct === 'string' ? asinOrProduct : asinOrProduct.asin;
    const normalized = normalizeAsin(rawAsin);
    if (!normalized) return false;

    if (this.enabled && this.seenAsins.has(normalized)) {
      this.duplicatesSkippedCount += 1;
      if (typeof asinOrProduct !== 'string') {
        this.mergeHydratedFields(normalized, asinOrProduct);
      }
      return false;
    }

    this.seenAsins.add(normalized);
    if (typeof asinOrProduct !== 'string') {
      this.productByAsin.set(normalized, {
        ...asinOrProduct,
        asin: normalized,
      });
    }
    return true;
  }

  /**
   * Filters a batch of scraped products, returning only newly discovered products
   * (or all valid products when `duplicateDetection` is disabled).
   */
  filterNew(products: readonly ScrapedAmazonProduct[]): ScrapedAmazonProduct[] {
    return this.processBatch(products).unique;
  }

  /**
   * Processes a batch of scraped products, tracking unique items, skipped duplicates,
   * and any previously seen items that gained newly hydrated fields (e.g. price or rating).
   */
  processBatch(
    products: readonly ScrapedAmazonProduct[],
  ): AmazonBatchDedupResult {
    const unique: ScrapedAmazonProduct[] = [];
    const enriched: ScrapedAmazonProduct[] = [];
    let batchDuplicates = 0;

    for (const item of products) {
      const normalized = normalizeAsin(item.asin);
      if (!normalized) continue;

      const normalizedItem: ScrapedAmazonProduct = {
        ...item,
        asin: normalized,
      };

      if (!this.enabled) {
        this.seenAsins.add(normalized);
        this.productByAsin.set(normalized, normalizedItem);
        unique.push(normalizedItem);
        continue;
      }

      if (this.seenAsins.has(normalized)) {
        batchDuplicates += 1;
        this.duplicatesSkippedCount += 1;
        const merged = this.mergeHydratedFields(normalized, normalizedItem);
        if (merged) {
          enriched.push(merged);
        }
        continue;
      }

      this.seenAsins.add(normalized);
      this.productByAsin.set(normalized, normalizedItem);
      unique.push(normalizedItem);
    }

    return {
      unique,
      duplicatesSkipped: batchDuplicates,
      enriched,
    };
  }

  private mergeHydratedFields(
    asin: string,
    incoming: ScrapedAmazonProduct,
  ): ScrapedAmazonProduct | null {
    const existing = this.productByAsin.get(asin);
    if (!existing) return null;

    let changed = false;
    const updated: ScrapedAmazonProduct = { ...existing };

    if (updated.price === null && incoming.price !== null) {
      updated.price = incoming.price;
      updated.currency = incoming.currency || updated.currency;
      changed = true;
    }
    if (updated.rating === null && incoming.rating !== null) {
      updated.rating = incoming.rating;
      changed = true;
    }
    if (updated.reviewCount === null && incoming.reviewCount !== null) {
      updated.reviewCount = incoming.reviewCount;
      changed = true;
    }
    if (!updated.imageUrl && incoming.imageUrl) {
      updated.imageUrl = incoming.imageUrl;
      changed = true;
    }
    if (!updated.brand && incoming.brand) {
      updated.brand = incoming.brand;
      changed = true;
    }
    if (!updated.dealBadge && incoming.dealBadge) {
      updated.dealBadge = incoming.dealBadge;
      changed = true;
    }
    if (!updated.boughtInPastMonth && incoming.boughtInPastMonth) {
      updated.boughtInPastMonth = incoming.boughtInPastMonth;
      changed = true;
    }

    if (changed) {
      this.productByAsin.set(asin, updated);
      return updated;
    }
    return null;
  }

  get size(): number {
    return this.seenAsins.size;
  }

  get duplicatesSkipped(): number {
    return this.duplicatesSkippedCount;
  }

  getSeenAsins(): string[] {
    return Array.from(this.seenAsins);
  }

  reset(): void {
    this.seenAsins.clear();
    this.productByAsin.clear();
    this.duplicatesSkippedCount = 0;
  }
}

export const DeduplicationEngine = AmazonDeduplicationEngine;
