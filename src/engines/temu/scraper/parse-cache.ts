import type { TemuScrapedProduct } from '../types';

/**
 * WeakMap-backed per-card parse cache for Temu listing cards.
 *
 * Only caches cards whose lazy-hydrated fields (`imageUrl`, `price`, `title`)
 * are populated, so cards still hydrating in the viewport will be re-parsed on
 * the next MutationObserver or scroll pass and enriched by `TemuDeduplicationEngine`.
 */
const REQUIRED_HYDRATED_FIELDS = ['title', 'price', 'imageUrl'] as const;

export class TemuParseCache {
  private entries = new WeakMap<
    Element,
    { product: TemuScrapedProduct; complete: boolean }
  >();

  get(card: Element): TemuScrapedProduct | undefined {
    const hit = this.entries.get(card);
    return hit?.complete ? hit.product : undefined;
  }

  set(card: Element, product: TemuScrapedProduct): void {
    const complete = REQUIRED_HYDRATED_FIELDS.every((field) => {
      const value = product[field];
      return value !== null && value !== undefined && value !== '';
    });
    this.entries.set(card, { product, complete });
  }

  clear(): void {
    this.entries = new WeakMap();
  }
}
