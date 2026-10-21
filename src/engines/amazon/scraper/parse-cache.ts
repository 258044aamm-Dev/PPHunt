import type { ScrapedAmazonProduct } from '../types';
import { DEAL_LABEL_PATTERN } from './deal-evidence';

/**
 * WeakMap-backed DOM Element parse cache (`AmazonParseCache`).
 * Memoizes complete product cards in O(1) time without re-querying the DOM on subsequent passes,
 * while leaving incomplete cards (e.g. missing `imageUrl` or `price` during lazy hydration)
 * uncached so they automatically re-parse once hydrated.
 *
 * SAD-383: completeness alone was not enough. A card becomes "complete" once
 * `asin`, `title`, `price` and `imageUrl` exist — which routinely happens
 * *before* Amazon injects the reviews row. Such a card was then answered from
 * this cache for the rest of the run, so its `rating`/`reviewCount` stayed null
 * even though the values appeared a moment later (measured: second pass `null`,
 * a fresh cache `4.5`). The entry now carries a cheap DOM signature, and a card
 * whose rating is still missing is re-parsed **only when its subtree changed**.
 *
 * SAD-386: the same argument applies to the price family — a deal badge, a
 * savings percentage and a struck list price are also injected after
 * `asin`/`title`/`price`/`imageUrl`. Rather than a second mechanism (a TTL was
 * measured to break the 480-card budget: a warm pass re-parsed every card), the
 * rule below adds one condition: a card that is already settled for the reviews
 * row is re-read only when its text now carries a `%` or a deal label that it
 * did not carry before.
 *
 * Cost is unchanged on the hot paths:
 * - a card that carries both rating values is settled and never re-parsed
 *   unless price-family evidence appears;
 * - an unchanged rating-less card is re-parsed zero times after the first pass;
 * - the signature is two DOM reads (descendant count + text length), taken only
 *   for cards that are not settled.
 */
interface AmazonParseCacheEntry {
  product: ScrapedAmazonProduct;
  /** Descendant count + text length — changes when Amazon injects/removes a subtree. */
  signature: number;
}

function hasRatingFields(product: ScrapedAmazonProduct): boolean {
  return (
    product.rating !== null &&
    product.rating !== undefined &&
    product.reviewCount !== null &&
    product.reviewCount !== undefined
  );
}

/** SAD-386: does the stored product already carry any price-family value? */
function hasBadgeFamilyFields(product: ScrapedAmazonProduct): boolean {
  return Boolean(
    product.discountPercentage ||
      product.dealBadge ||
      (product.listPrice !== null && product.listPrice !== undefined),
  );
}

/**
 * SAD-386: does the card's text show price-family evidence at all? A card whose
 * text carries neither a `%` nor a deal label cannot have gained a badge, so
 * SAD-383's guarantee ("a DOM change must not rewrite values the user was
 * already shown") stands.
 */
function showsPriceFamilyEvidence(element: Element): boolean {
  const text = element.textContent ?? '';
  return text.includes('%') || DEAL_LABEL_PATTERN.test(text);
}

export class AmazonParseCache {
  private cache = new WeakMap<Element, AmazonParseCacheEntry>();

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

  private signatureOf(element: Element): number {
    const nodeCount = element.getElementsByTagName('*').length;
    const textLength = element.textContent?.length ?? 0;
    return nodeCount * 31 + textLength;
  }

  public get(element: Element): ScrapedAmazonProduct | undefined {
    return this.cache.get(element)?.product;
  }

  public set(element: Element, product: ScrapedAmazonProduct | null): void {
    if (this.isComplete(product)) {
      this.cache.set(element, {
        product,
        signature: this.signatureOf(element),
      });
    }
  }

  public getOrParse(
    element: Element,
    parser: (el: Element) => ScrapedAmazonProduct | null,
  ): ScrapedAmazonProduct | null {
    const entry = this.cache.get(element);
    if (entry) {
      // SAD-386: the price family is present — nothing left to gain.
      if (hasBadgeFamilyFields(entry.product)) {
        return entry.product;
      }
      // SAD-383: an unchanged card is never re-parsed.
      if (this.signatureOf(element) === entry.signature) {
        return entry.product;
      }
      // SAD-383's guarantee: a card that already carries both rating values is
      // only re-read when the text now shows a badge or a percentage.
      if (hasRatingFields(entry.product) && !showsPriceFamilyEvidence(element)) {
        return entry.product;
      }
    }

    const parsed = parser(element);
    if (this.isComplete(parsed)) {
      this.cache.set(element, {
        product: parsed,
        signature: this.signatureOf(element),
      });
    }
    return parsed;
  }

  public clear(): void {
    this.cache = new WeakMap<Element, AmazonParseCacheEntry>();
  }
}

export const ParseCache = AmazonParseCache;
export const defaultAmazonParseCache = new AmazonParseCache();
export const defaultParseCache = defaultAmazonParseCache;
