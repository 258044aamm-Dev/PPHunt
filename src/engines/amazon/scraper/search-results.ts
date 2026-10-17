import type { ScrapedAmazonProduct } from '../types';
import { resolveProductUrl } from '../utils/amazon-url';
import {
  defaultAmazonDriftTelemetry,
  type AmazonDriftTelemetry,
  type AmazonTrackedField,
} from './drift-telemetry';
import {
  discoverStructuralProductCards,
  extractCardAsinWithTier,
  extractCardBadge,
  extractCardDeliveryAndAvailability,
  extractCardImageWithTier,
  extractCardIsPrime,
  extractCardIsSponsored,
  extractCardPastMonthSales,
  extractCardPricingAndDiscounts,
  extractCardRatingAndReviewsWithTier,
  extractCardSeller,
  extractCardTitleAndBrandWithTier,
  normalizeWhitespace,
  validateAndNormalizeScrapedProduct,
} from './field-parsers';
import {
  AmazonParseCache,
  defaultAmazonParseCache,
} from './parse-cache';
import {
  AMAZON_SELECTORS,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

export interface SearchResultsParseOptions {
  cache?: AmazonParseCache;
  telemetry?: AmazonDriftTelemetry;
  extractPricing?: typeof extractCardPricingAndDiscounts;
}

function extractInlineCardBsr(card: Element): string | undefined {
  const nodes = safeQuerySelectorAll(card, 'span, div');
  for (const node of nodes) {
    if (node.children.length > 2) continue;
    const text = normalizeWhitespace(node.textContent);
    const match = /(#\d[\d,]*\s+in\s+[A-Za-z0-9 &,'/-]+)/.exec(text);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Parses a single Amazon search result card using the 4-tier self-healing extraction cascade.
 */
export function parseAmazonSearchCard(
  card: Element,
  pageUrl?: string,
  options: SearchResultsParseOptions = {},
): ScrapedAmazonProduct | null {
  try {
    const telemetry = options.telemetry ?? defaultAmazonDriftTelemetry;
    const pricingFn = options.extractPricing ?? extractCardPricingAndDiscounts;

    const asinResult = extractCardAsinWithTier(card);
    if (!asinResult.value) {
      return null;
    }

    const asin = asinResult.value;
    const { title: titleResult, brand } = extractCardTitleAndBrandWithTier(
      card,
      asin,
    );
    if (!titleResult.value) {
      return null;
    }

    const pricing = pricingFn(card, pageUrl);
    const { rating: ratingResult, reviewCount: reviewResult } =
      extractCardRatingAndReviewsWithTier(card);
    const imageResult = extractCardImageWithTier(card);
    const pastMonthSales = extractCardPastMonthSales(card);
    const badge = extractCardBadge(card);
    const { delivery, availability } = extractCardDeliveryAndAvailability(card);
    const seller = extractCardSeller(card);
    const isPrime = extractCardIsPrime(card, delivery);
    const isSponsored = extractCardIsSponsored(card);
    const bestSellersRank = extractInlineCardBsr(card);

    const fieldTiers: Partial<
      Record<AmazonTrackedField, typeof asinResult.tier>
    > = {
      asin: asinResult.tier,
      title: titleResult.tier,
      price: pricing.priceTier,
      rating: ratingResult.tier,
      reviewCount: reviewResult.tier,
      imageUrl: imageResult.tier,
    };
    telemetry.recordCardExtraction(fieldTiers);

    const url = resolveProductUrl(null, asin, pageUrl);

    const candidate: Partial<ScrapedAmazonProduct> = {
      asin,
      url,
      title: titleResult.value,
      price: pricing.price,
      currency: pricing.currency,
      rating: ratingResult.value,
      reviewCount: reviewResult.value,
      imageUrl: imageResult.value,
      isSponsored,
      isPrime,
      brand,
      availability,
      seller,
      description: null,
      features: [],
      source: 'search',
    };

    if (pricing.listPrice !== undefined) {
      candidate.listPrice = pricing.listPrice;
    }
    if (pricing.discountPercentage !== undefined) {
      candidate.discountPercentage = pricing.discountPercentage;
    }
    if (pricing.dealBadge !== undefined) {
      candidate.dealBadge = pricing.dealBadge;
    }
    if (bestSellersRank !== undefined) {
      candidate.bestSellersRank = bestSellersRank;
    }
    if (pastMonthSales !== undefined) {
      candidate.pastMonthSales = pastMonthSales;
    }
    if (pricing.coupon !== undefined) {
      candidate.coupon = pricing.coupon;
    }
    if (badge !== undefined) {
      candidate.badge = badge;
    }
    if (delivery !== undefined) {
      candidate.delivery = delivery;
    }

    return validateAndNormalizeScrapedProduct(candidate, pageUrl);
  } catch (err) {
    console.warn('[PPHunt] Failed to parse search card:', err);
    return null;
  }
}

export const parseSearchCard = parseAmazonSearchCard;

/**
 * Parses all Amazon search result cards in a `Document`, isolating per-card exceptions
 * and memoizing complete cards in `AmazonParseCache`.
 */
export function parseAmazonSearchResults(
  doc: Document = document,
  pageUrl?: string,
  pageTypeOrCacheOrOptions?:
    | string
    | AmazonParseCache
    | SearchResultsParseOptions,
  explicitCache?: AmazonParseCache,
): ScrapedAmazonProduct[] {
  const activeUrl =
    pageUrl ??
    (typeof window !== 'undefined' && window.location ? window.location.href : undefined);

  const options: SearchResultsParseOptions =
    pageTypeOrCacheOrOptions instanceof AmazonParseCache
      ? { cache: pageTypeOrCacheOrOptions }
      : typeof pageTypeOrCacheOrOptions === 'string'
        ? { cache: explicitCache }
        : { ...(pageTypeOrCacheOrOptions ?? {}) };

  if (explicitCache && !options.cache) {
    options.cache = explicitCache;
  }

  const cache = options.cache ?? defaultAmazonParseCache;

  let mainRoot: ParentNode = doc;
  for (const selector of AMAZON_SELECTORS.search.mainContainers) {
    const found = safeQuerySelector(doc, selector);
    if (found) {
      mainRoot = found;
      break;
    }
  }

  let cards: Element[] = [];
  for (const selector of AMAZON_SELECTORS.search.cardContainers) {
    const matches = safeQuerySelectorAll(mainRoot, selector).filter(
      (el) => !el.closest('.a-carousel-card'),
    );
    if (matches.length > 0) {
      cards = matches;
      break;
    }
  }

  if (cards.length === 0 && mainRoot !== doc) {
    for (const selector of AMAZON_SELECTORS.search.cardContainers) {
      const matches = safeQuerySelectorAll(doc, selector).filter(
        (el) => !el.closest('.a-carousel-card'),
      );
      if (matches.length > 0) {
        cards = matches;
        break;
      }
    }
  }

  if (cards.length === 0) {
    const structural = discoverStructuralProductCards(mainRoot);
    const asinCards = safeQuerySelectorAll(
      mainRoot,
      '[data-asin]:not([data-asin=""])',
    ).filter((el) => !el.closest('.a-carousel-card'));
    cards =
      structural.length >= asinCards.length && structural.length > 0
        ? structural
        : asinCards.length > 0
          ? asinCards
          : structural;
  }

  const results: ScrapedAmazonProduct[] = [];
  const seenAsinsInPass = new Set<string>();

  for (const card of cards) {
    try {
      const quickAsin = extractCardAsinWithTier(card).value;
      if (quickAsin && seenAsinsInPass.has(quickAsin)) {
        continue;
      }
      const parsed = cache.getOrParse(card, (el) =>
        parseAmazonSearchCard(el, activeUrl, options),
      );
      if (parsed && !seenAsinsInPass.has(parsed.asin)) {
        seenAsinsInPass.add(parsed.asin);
        results.push(parsed);
      }
    } catch (err) {
      console.warn('[PPHunt] Search card iteration error:', err);
    }
  }

  return results;
}

export const parseSearchResults = parseAmazonSearchResults;
