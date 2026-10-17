import type { ScrapedAmazonProduct } from '../types';

interface CachedAmazonCardEntry {
  signature: string;
  product: ScrapedAmazonProduct | null;
}

/**
 * WeakMap-backed DOM Element parse cache (`AmazonParseCache`).
 * Skips unchanged hydrated product cards in O(1) time across MutationObserver and scroll ticks
 * on large 480+ card Amazon pages, while automatically invalidating if lazy hydration
 * populates missing price, image, or review subtrees.
 */
export class AmazonParseCache {
  private cache = new WeakMap<Element, CachedAmazonCardEntry>();

  /**
   * Computes a lightweight structural signature for a DOM card element.
   */
  private computeSignature(element: Element): string {
    const asin = element.getAttribute('data-asin') ?? '';
    const childCount = element.childElementCount;
    const textLen = element.textContent?.length ?? 0;
    const imgEl = element.querySelector('img');
    const imgSrc =
      imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? '';
    return `${asin}|${childCount}|${textLen}|${imgSrc}`;
  }

  get(element: Element): ScrapedAmazonProduct | null | undefined {
    const entry = this.cache.get(element);
    if (!entry) return undefined;
    const currentSignature = this.computeSignature(element);
    if (entry.signature !== currentSignature) {
      this.cache.delete(element);
      return undefined;
    }
    return entry.product;
  }

  set(element: Element, product: ScrapedAmazonProduct | null): void {
    this.cache.set(element, {
      signature: this.computeSignature(element),
      product,
    });
  }

  getOrParse(
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

  clear(): void {
    this.cache = new WeakMap<Element, CachedAmazonCardEntry>();
  }
}

export const ParseCache = AmazonParseCache;
export const defaultAmazonParseCache = new AmazonParseCache();
export const defaultParseCache = defaultAmazonParseCache;
