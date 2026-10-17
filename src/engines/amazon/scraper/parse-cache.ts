import type { ScrapedAmazonProduct } from '../types';

/**
 * WeakMap-backed DOM Element parse cache (`AmazonParseCache`).
 * Memoizes complete product cards in O(1) time without re-querying the DOM on subsequent passes,
 * while leaving incomplete cards (e.g. missing `imageUrl` or `price` during lazy hydration)
 * uncached so they automatically re-parse once hydrated.
 */
export class AmazonParseCache {
  private cache = new WeakMap<Element, ScrapedAmazonProduct>();

  /**
   * A card is considered complete (safe to memoize permanently for the life of the Element)
   * once its core hydrating fields (`asin`, `title`, `price`, and `imageUrl`) are populated.
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
    return this.cache.get(element);
  }

  public set(element: Element, product: ScrapedAmazonProduct | null): void {
    if (this.isComplete(product)) {
      this.cache.set(element, product);
    }
  }

  public getOrParse(
    element: Element,
    parser: (el: Element) => ScrapedAmazonProduct | null,
  ): ScrapedAmazonProduct | null {
    const cached = this.cache.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parser(element);
    if (this.isComplete(parsed)) {
      this.cache.set(element, parsed);
    }
    return parsed;
  }

  public clear(): void {
    this.cache = new WeakMap<Element, ScrapedAmazonProduct>();
  }
}

export const ParseCache = AmazonParseCache;
export const defaultAmazonParseCache = new AmazonParseCache();
export const defaultParseCache = defaultAmazonParseCache;
