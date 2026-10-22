import type { ScrapedAmazonProduct } from '../types';
import { normalizeASIN } from '../utils/amazon-url';
import {
  resolveListingCategory,
  resolveProductPlacements,
} from '../utils/listing-category';

export interface MergeAndFilterResult {
  newProducts: ScrapedAmazonProduct[];
  updatedExisting: boolean;
}

const MERGEABLE_NULLABLE_FIELDS = [
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
  // SAD-357: variations (upgraded when source === 'detail') and PDP weight.
  'variations',
  'weight',
  // SAD-349: a collection run started ON a product page parses the detail
  // parser, so warranty can reach the dedup merge today, not hypothetically.
  'warrantyDescription',
  'warrantyDescriptionRaw',
] as const;

/**
 * SAD-391 (D8): records one more placement on an already-kept row without
 * re-parsing anything — used when a second primary `s-search-result` card
 * (typically the Sponsored Products ad of an ASIN that is also listed
 * organically) is skipped as a duplicate. `isSponsored` / `listingCategory`
 * of the kept row are untouched; the extra placement is what the Sponsored
 * filter and badge read (`matchesListingCategoryFilter`). Returns whether the
 * row changed.
 */
export function appendProductPlacement(
  target: ScrapedAmazonProduct,
  placement: string,
): boolean {
  const current = resolveProductPlacements(target);
  if (current.includes(placement)) {
    return false;
  }
  target.placements = [...current, placement];
  return true;
}

/**
 * Merges fields from `source` into `target` in place.
 * When `preferSource` is true (e.g. `source` is a primary `s-search-result` card and `target`
 * came from a compact widget card), non-null/defined fields on `source` overwrite `target`
 * while preserving any fields that are only present on `target`.
 */
export function mergeScrapedProductFields(
  target: ScrapedAmazonProduct,
  source: ScrapedAmazonProduct,
  options: { preferSource?: boolean } = {},
): boolean {
  let changed = false;
  const preferSource = Boolean(options.preferSource);

  if (
    source.title &&
    (!target.title ||
      (preferSource && source.title !== target.title) ||
      (source.title.length > target.title.length &&
        source.title.startsWith(target.title.replace(/\.{2,}|…$/, '').trim())))
  ) {
    target.title = source.title;
    changed = true;
  }

  for (const key of MERGEABLE_NULLABLE_FIELDS) {
    const targetVal = target[key];
    const sourceVal = source[key];
    if (sourceVal === null || sourceVal === undefined) continue;

    if (
      targetVal === null ||
      targetVal === undefined ||
      (preferSource && targetVal !== sourceVal)
    ) {
      (target as unknown as Record<string, unknown>)[key] = sourceVal;
      changed = true;
    }
  }

  // SAD-357: an authoritative PDP (`detail`) variations breakdown upgrades
  // partial search/category card swatch hints even when `preferSource` is false.
  if (
    source.source === 'detail' &&
    target.source !== 'detail' &&
    source.variations &&
    target.variations !== source.variations
  ) {
    target.variations = source.variations;
    changed = true;
  }

  // SAD-392 (D1): a PDP observation is authoritative for provenance,
  // mirroring the SAD-357 variations upgrade above — and it must stay AFTER
  // it: that condition reads the pre-promotion `target.source !== 'detail'`,
  // so promoting first would silently kill the variations upgrade (pinned by
  // test). Upgrade-only: a listing re-observation never downgrades a row
  // already proven on its PDP.
  if (source.source === 'detail' && target.source !== 'detail') {
    target.source = 'detail';
    changed = true;
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

  // SAD-391 (F7): a source that carries no listing information at all — the
  // quick-save volatile refresh object, an enrichment patch — must not be
  // read as "an organic, unsponsored observation". Without this guard the
  // placement union invented 'Organic Search', `listingCategory` was
  // recomputed to 'organic' and `isSponsored` was overwritten with
  // `undefined` on every re-save of a sponsored product.
  const sourceHasListingContext =
    (Array.isArray(source.placements) && source.placements.length > 0) ||
    Boolean(source.sectionLabel) ||
    source.listingCategory !== undefined ||
    typeof source.isSponsored === 'boolean';

  // Record multi-placement context before overwriting `isSponsored` / `listingCategory`
  if (sourceHasListingContext) {
    const targetPlacements = resolveProductPlacements(target);
    const sourcePlacements = resolveProductPlacements(source);
    const orderedPlacements = preferSource
      ? [...sourcePlacements, ...targetPlacements]
      : [...targetPlacements, ...sourcePlacements];
    const distinctPlacements: string[] = [];
    for (const p of orderedPlacements) {
      if (p && !distinctPlacements.includes(p)) {
        distinctPlacements.push(p);
      }
    }
    if (distinctPlacements.length > 1) {
      const prevKey = (target.placements ?? []).join('|');
      const nextKey = distinctPlacements.join('|');
      if (prevKey !== nextKey) {
        target.placements = distinctPlacements;
        changed = true;
      }
    }
  }

  if (preferSource && sourceHasListingContext) {
    const nextCategory = source.listingCategory ?? resolveListingCategory(source);
    if (target.listingCategory && target.listingCategory !== nextCategory) {
      target.listingCategory = nextCategory;
      changed = true;
    }
  } else if (!target.listingCategory && source.listingCategory) {
    // Keep primary card category if target was already a primary search result,
    // while recording the widget's sectionLabel for context
    if (!target.sectionLabel && source.sectionLabel) {
      target.sectionLabel = source.sectionLabel;
      changed = true;
    }
  }

  if (!target.sectionLabel && source.sectionLabel) {
    target.sectionLabel = source.sectionLabel;
    changed = true;
  }

  if (
    preferSource &&
    typeof source.isSponsored === 'boolean' &&
    target.isSponsored !== source.isSponsored
  ) {
    target.isSponsored = source.isSponsored;
    changed = true;
  }

  return changed;
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
    return mergeScrapedProductFields(target, source);
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
