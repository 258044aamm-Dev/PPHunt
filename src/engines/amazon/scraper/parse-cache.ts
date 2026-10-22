import type { ScrapedAmazonProduct } from '../types';
import { DEAL_LABEL_PATTERN } from './deal-evidence';
import { readAmazonCoupon, readAmazonPastMonthSales, extractCardBadge } from './field-parsers';
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
 * SAD-389: early cache returns have an independent missing-target lane. Only
 * coupon/monthly-sales readers may run there, gated by cheap textual evidence;
 * they cannot re-price a settled card or rewrite its ratings/deals. This lane
 * does not use the count/length signature: equal-length text changes and an
 * explicit hidden/class/style reveal must also be noticed. The existing full-
 * parser triggers for reviews/pricing below are deliberately unchanged.
 * Unchanged no-signal cards still perform zero extra full parses, with no TTL,
 * timers or observers owned by the cache.
 *
 * SAD-393: the status badge (`badge` — Best Seller &c.) joins this lane as a
 * fill-only target. A late-arriving badge capsule never triggers a full
 * card re-parse on a settled card; it is filled by `recoverMissingTargets`
 * alongside coupon and monthly sales. (Live captures show rio badges are
 * server-rendered in the no-JS HTML, so this guards the measured lazy-card
 * staleness of the cache itself, not a proven hydration sequence.)
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

  /** Fill only missing targets on a path that previously returned a frozen card. */
  private recoverMissingTargets(element: Element, entry: AmazonParseCacheEntry): ScrapedAmazonProduct {
    const product = entry.product;
    if (product.pastMonthSales && product.coupon && product.badge) return product;
    const text = element.textContent ?? '';
    const updates: Partial<ScrapedAmazonProduct> = {};
    let changed = false;

    const pastMonthSales = !product.pastMonthSales && /bought/i.test(text)
      ? readAmazonPastMonthSales(element, product.asin).value
      : undefined;
    if (pastMonthSales !== undefined) { updates.pastMonthSales = pastMonthSales; changed = true; }

    const coupon = !product.coupon && /coupon|voucher|rabatt|remise|\b(?:save|apply|clip|get|you\s+pay)\b/i.test(text)
      ? readAmazonCoupon(element, product.asin).value
      : undefined;
    if (coupon !== undefined) { updates.coupon = coupon; changed = true; }

    // SAD-393: fill a late-arriving status badge without re-parsing the card.
    if (!product.badge && showsStatusBadgeEvidence(element)) {
      const badge = extractCardBadge(element);
      if (badge) { updates.badge = badge; changed = true; }
    }

    if (!changed) return product;
    // Do not mutate the object a previous collection batch may still hold:
    // dedup must observe a real change and emit its existing updated batch.
    entry.product = { ...product, ...updates };
    return entry.product;
  }

  public getOrParse(
    element: Element,
    parser: (el: Element) => ScrapedAmazonProduct | null,
  ): ScrapedAmazonProduct | null {
    const entry = this.cache.get(element);
    if (entry) {
      // SAD-386 + SAD-393: price family AND status badge present — settled.
      if (
        hasBadgeFamilyFields(entry.product) &&
        hasStatusBadgeField(entry.product)
      ) {
        return entry.product;
      }
      // SAD-386: price family present — fill missing targets (badge included)
      // via cheap reads, never re-parse for badge alone (badge_in_lane).
      if (hasBadgeFamilyFields(entry.product)) {
        return this.recoverMissingTargets(element, entry);
      }
      // SAD-383: ratings complete — re-read only on price-family evidence.
      // Badge evidence alone fills the badge without re-parsing.
      if (hasRatingFields(entry.product) && !showsPriceFamilyEvidence(element)) {
        return this.recoverMissingTargets(element, entry);
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
