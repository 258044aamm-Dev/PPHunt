import type { ScrapedAmazonProduct } from '../types';
import { isAmazonUrl } from '../utils/amazon-url';
import type { AmazonDriftTelemetry } from './drift-telemetry';
import {
  type CardFieldTierMap,
  discoverStructuralProductCards,
  extractCardAsinWithTier,
  extractCardBoughtInPastMonth,
  extractCardBrand,
  extractCardBsr,
  extractCardCouponText,
  extractCardDealBadge,
  extractCardDeliveryInfo,
  extractCardDiscountPercentage,
  extractCardIsPrime,
  extractCardIsSponsored,
  extractCardListPrice,
  extractCardPriceWithTier,
  extractCardProductUrl,
  extractCardRatingWithTier,
  extractCardReviewCountWithTier,
  extractCardStatusBadge,
  extractCardTitleWithTier,
  extractImageWithTier,
} from './field-parsers';
import { AmazonParseCache } from './parse-cache';
import { AMAZON_SELECTORS, safeQuerySelectorAll } from './selectors';

function resolveSourceUrl(doc?: Document | null, explicitUrl?: string): string {
  if (explicitUrl && isAmazonUrl(explicitUrl)) {
    return explicitUrl;
  }
  const docUrl = doc?.location?.href;
  if (docUrl && isAmazonUrl(docUrl)) {
    return docUrl;
  }
  if (
    typeof window !== 'undefined' &&
    window.location?.href &&
    isAmazonUrl(window.location.href)
  ) {
    return window.location.href;
  }
  return explicitUrl || 'https://www.amazon.com/s';
}

/**
 * Parses a single Amazon search result card element into a `ScrapedAmazonProduct`
 * using the 4-tier self-healing extraction cascade.
 */
export function parseAmazonSearchCard(
  card: Element,
  sourceUrl = 'https://www.amazon.com/s',
  telemetry?: AmazonDriftTelemetry,
): ScrapedAmazonProduct | null {
  const fieldTiers: CardFieldTierMap = {};

  const asinResult = extractCardAsinWithTier(card);
  fieldTiers.asin = asinResult.tier;
  const asin = asinResult.value;
  if (!asin) {
    telemetry?.recordCard(fieldTiers, false);
    return null;
  }

  const titleResult = extractCardTitleWithTier(card, asin);
  fieldTiers.title = titleResult.tier;
  const title = titleResult.value;
  if (!title) {
    telemetry?.recordCard(fieldTiers, false);
    return null;
  }

  const priceResult = extractCardPriceWithTier(card, sourceUrl);
  fieldTiers.price = priceResult.tier;
  const { price, currency } = priceResult.value;

  const listPrice = extractCardListPrice(card, price, sourceUrl);
  const discountPercentage = extractCardDiscountPercentage(
    card,
    price,
    listPrice,
  );

  const ratingResult = extractCardRatingWithTier(card);
  fieldTiers.rating = ratingResult.tier;

  const reviewCountResult = extractCardReviewCountWithTier(card);
  fieldTiers.reviewCount = reviewCountResult.tier;

  const imageResult = extractImageWithTier(card);
  fieldTiers.imageUrl = imageResult.tier;

  const brand = extractCardBrand(card);
  const dealBadge = extractCardDealBadge(card);
  const statusBadge = extractCardStatusBadge(card);
  const couponText = extractCardCouponText(card);
  const boughtInPastMonth = extractCardBoughtInPastMonth(card);
  const bsr = extractCardBsr(card);
  const isPrime = extractCardIsPrime(card);
  const isSponsored = extractCardIsSponsored(card);
  const deliveryInfo = extractCardDeliveryInfo(card);
  const productUrl = extractCardProductUrl(card, asin, sourceUrl);

  telemetry?.recordCard(fieldTiers, true);

  const scraped: ScrapedAmazonProduct = {
    asin,
    title,
    price,
    currency,
    rating: ratingResult.value,
    reviewCount: reviewCountResult.value,
    isPrime,
    isSponsored,
    imageUrl: imageResult.value,
    productUrl,
    sourceUrl,
    pageType: 'search',
  };

  if (brand !== undefined) scraped.brand = brand;
  if (listPrice !== null) scraped.listPrice = listPrice;
  if (discountPercentage !== null) {
    scraped.discountPercentage = discountPercentage;
  }
  if (dealBadge !== undefined) scraped.dealBadge = dealBadge;
  if (statusBadge !== undefined) scraped.statusBadge = statusBadge;
  if (couponText !== undefined) scraped.couponText = couponText;
  if (boughtInPastMonth !== undefined) {
    scraped.boughtInPastMonth = boughtInPastMonth;
  }
  if (bsr !== undefined) scraped.bsr = bsr;
  if (deliveryInfo !== undefined) scraped.deliveryInfo = deliveryInfo;

  return scraped;
}

export const parseSearchCard = parseAmazonSearchCard;

/**
 * Extracts all valid product cards from an Amazon Search results document.
 * Supports both `(doc, sourceUrl, cache, telemetry)` and `(doc, cache)` call signatures.
 */
export function parseAmazonSearchResults(
  doc?: Document | null,
  sourceUrlOrCache?: string | AmazonParseCache,
  maybeCache?: AmazonParseCache,
  telemetry?: AmazonDriftTelemetry,
): ScrapedAmazonProduct[] {
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);
  if (!activeDoc) return [];

  const cache =
    sourceUrlOrCache instanceof AmazonParseCache
      ? sourceUrlOrCache
      : maybeCache;
  const explicitUrl =
    typeof sourceUrlOrCache === 'string' ? sourceUrlOrCache : undefined;
  const sourceUrl = resolveSourceUrl(activeDoc, explicitUrl);

  // Tier 2: Semantic search result cards (`[data-component-type="s-search-result"][data-asin]`, etc.)
  let candidateCards = safeQuerySelectorAll(
    activeDoc,
    AMAZON_SELECTORS.search.cardContainers.join(', '),
  );

  // Tier 3: Structural `/dp/<ASIN>` anchor-tree discovery when semantic attributes are absent
  if (candidateCards.length === 0) {
    candidateCards = discoverStructuralProductCards(activeDoc);
  }

  const results: ScrapedAmazonProduct[] = [];
  const seenInPass = new Set<string>();

  for (const card of candidateCards) {
    try {
      const product = cache
        ? cache.getOrParse(card, (el) =>
            parseAmazonSearchCard(el, sourceUrl, telemetry),
          )
        : parseAmazonSearchCard(card, sourceUrl, telemetry);

      if (product && !seenInPass.has(product.asin)) {
        seenInPass.add(product.asin);
        results.push(product);
      }
    } catch {
      // Isolate per-card DOM exceptions so sibling cards are never lost
    }
  }

  return results;
}

export const parseSearchResults = parseAmazonSearchResults;
