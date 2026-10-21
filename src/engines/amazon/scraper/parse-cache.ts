import type { ScrapedAmazonProduct } from '../types';
import { DEAL_LABEL_PATTERN } from './deal-evidence';
import { AMAZON_SELECTORS, safeQuerySelectorAll } from './selectors';

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
 * SAD-393: the status badge (`badge` — Best Seller &c.) is the third
 * late-arriving family. It was invisible here, so a card cached before its
 * badge capsule existed kept answering `badge: undefined` for the rest of
 * the run: the price-family fast path settled it outright, and the
 * rating-complete path saw no `%`/deal evidence in a badge-only change.
 * Same rule, third time: an already-extracted `badge` settles the card
 * alongside the price family, and a changed subtree is re-read when it
 * shows badge evidence. (Live captures show rio badges are server-rendered
 * in the no-JS HTML, so this guards the measured lazy-card staleness of the
 * cache itself, not a proven hydration sequence.)
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

/** SAD-393: does the stored product already carry its status badge? */
function hasStatusBadgeField(product: ScrapedAmazonProduct): boolean {
  return Boolean(product.badge);
}

/**
 * SAD-393: does the card now show a status-badge-shaped node? Node presence
 * under the registry's `statusBadge` selectors, deal-badge subtrees
 * excluded (a deal arriving is price-family evidence, not badge evidence),
 * with readable text. Only consulted after the signature moved, so the
 * query cost lands once per actual DOM change, never on a warm pass.
 */
function showsStatusBadgeEvidence(element: Element): boolean {
  for (const selector of AMAZON_SELECTORS.cardFields.statusBadge) {
    for (const el of safeQuerySelectorAll(element, selector)) {
      if (el.closest('[data-a-badge-type="deal"]')) continue;
      if ((el.textContent ?? '').trim().length > 0) return true;
    }
  }
  return false;
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
      // SAD-386 + SAD-393: the price family AND the status badge are
      // present — nothing left to gain.
      if (
        hasBadgeFamilyFields(entry.product) &&
        hasStatusBadgeField(entry.product)
      ) {
        return entry.product;
      }
      // SAD-383: an unchanged card is never re-parsed.
      if (this.signatureOf(element) === entry.signature) {
        return entry.product;
      }
      // The subtree changed. A missing status badge can only have arrived
      // with that change if the card now shows badge evidence (SAD-393).
      const badgeCouldHaveArrived =
        !hasStatusBadgeField(entry.product) &&
        showsStatusBadgeEvidence(element);
      // SAD-386's fast path, preserved: price family present means the only
      // thing a re-read could still gain is the badge.
      if (hasBadgeFamilyFields(entry.product)) {
        if (!badgeCouldHaveArrived) {
          return entry.product;
        }
      } else if (
        // SAD-383's guarantee: a card that already carries both rating
        // values is only re-read when the change shows price-family
        // evidence — or, since SAD-393, status-badge evidence.
        hasRatingFields(entry.product) &&
        !showsPriceFamilyEvidence(element) &&
        !badgeCouldHaveArrived
      ) {
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
