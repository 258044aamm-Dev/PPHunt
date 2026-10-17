import type { ScrapedProduct } from '@/types/common';

/**
 * Step 5.1 (SAD-177) — H-9a: per-card parse memoisation.
 *
 * `parseCurrentPage()` re-parses every card on every MutationObserver tick and
 * every scroll tick; on a 480-card page that is seconds of repeated work. The
 * cache keys on the card Element (WeakMap → entries vanish with their DOM
 * nodes, so Amazon recycling cards needs no manual eviction).
 *
 * RISK R3 GUARD: Amazon hydrates images / ratings / review counts / BSR
 * lazily, and `DeduplicationEngine.mergeAndFilterNew` relies on cards being
 * re-parsed so late-arriving fields get enriched. A cache hit is therefore
 * only served for COMPLETE products; an incomplete card is re-parsed next
 * tick, exactly as today.
 */

/** Fields Amazon hydrates lazily; a card missing any of these is re-parsed. */
const HYDRATING_FIELDS = [
  'imageUrl',
  'rating',
  'reviewCount',
  'bestSellersRank',
] as const;

export class ParseCache {
  private entries = new WeakMap<
    Element,
    { product: ScrapedProduct; complete: boolean }
  >();

  /** Returns the cached product only when it was complete; else undefined. */
  get(card: Element): ScrapedProduct | undefined {
    const hit = this.entries.get(card);
    return hit?.complete ? hit.product : undefined;
  }

  set(card: Element, product: ScrapedProduct): void {
    const complete = HYDRATING_FIELDS.every((f) => {
      const value = product[f];
      return value != null && value !== '';
    });
    this.entries.set(card, { product, complete });
  }

  /** A WeakMap cannot be emptied in place — swap the instance. */
  clear(): void {
    this.entries = new WeakMap();
  }
}
