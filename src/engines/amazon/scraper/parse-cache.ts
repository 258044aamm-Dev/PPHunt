import type { ScrapedAmazonProduct } from '../types';

/**
 * SAD-386: how long a memoised card stays trustworthy, in milliseconds.
 *
 * Why a TTL at all? The cache used to be permanent for the life of the Element
 * (`isComplete` = asin + title + price + imageUrl). A deal badge and a savings
 * percentage hydrate LATER than those four fields, so a card parsed a moment too
 * early kept answering "no deal, no discount" for the rest of the run — the
 * measured cause of "the discount field is extracted inconsistently"
 * (plan §5 F6, probe P04-P06: same DOM, `null` with the cache, `68% off`
 * without it).
 *
 * 2000 ms is deliberately short: it is longer than the hydration gap that
 * produced the bug (a frame or two) and short enough that a second scroll pass
 * over a long page re-reads cards rather than serving stale answers. The clock
 * is injectable so tests are deterministic.
 */
export const DEFAULT_PARSE_CACHE_TTL_MS = 2000;

export interface AmazonParseCacheOptions {
  /** Override the freshness window. `Infinity` restores the old permanent behaviour. */
  ttlMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  product: ScrapedAmazonProduct;
  at: number;
}

/**
 * WeakMap-backed DOM Element parse cache (`AmazonParseCache`).
 * Memoizes complete product cards in O(1) time without re-querying the DOM on
 * subsequent passes, while leaving incomplete cards (e.g. missing `imageUrl` or
 * `price` during lazy hydration) uncached so they automatically re-parse once
 * hydrated — and re-reading a complete card after `ttlMs` so a late-arriving
 * badge or percentage is picked up (SAD-386).
 */
export class AmazonParseCache {
  private cache = new WeakMap<Element, CacheEntry>();

  constructor(private readonly options: AmazonParseCacheOptions = {}) {}

  /** The effective freshness window in milliseconds. */
  public get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_PARSE_CACHE_TTL_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * A card is considered complete (worth memoising) once its core hydrating
   * fields (`asin`, `title`, `price`, and `imageUrl`) are populated.
   */
  public isComplete(product: ScrapedAmazonProduct | null | undefined): product is ScrapedAmazonProduct {
    if (!product) return false;
    return Boolean(
      product.asin &&
        product.title &&
        product.price !== null &&
        product.price !== undefined &&
        product.imageUrl,
    );
  }

  public get(element: Element): ScrapedAmazonProduct | undefined {
    const entry = this.cache.get(element);
    if (entry === undefined) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      // Stale: forget it so the caller re-parses and refreshes the entry.
      this.cache.delete(element);
      return undefined;
    }
    return entry.product;
  }

  public set(element: Element, product: ScrapedAmazonProduct | null): void {
    if (this.isComplete(product)) {
      this.cache.set(element, { product, at: this.now() });
    }
  }

  public getOrParse(
    element: Element,
    parser: (el: Element) => ScrapedAmazonProduct | null,
  ): ScrapedAmazonProduct | null {
    const cached = this.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parser(element);
    this.set(element, parsed);
    return parsed;
  }

  public clear(): void {
    this.cache = new WeakMap<Element, CacheEntry>();
  }
}

export const ParseCache = AmazonParseCache;
export const defaultAmazonParseCache = new AmazonParseCache();
export const defaultParseCache = defaultAmazonParseCache;
