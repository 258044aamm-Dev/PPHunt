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

function resolveCategorySourceUrl(
  doc?: Document | null,
  explicitUrl?: string,
): string {
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
  return explicitUrl || 'https://www.amazon.com/gp/bestsellers';
}

/**
 * Filters out ancestor containers that wrap other candidate cards in O(N * depth) time
 * using a Set lookup on parent chains rather than O(N^2) `element.contains()`.
 */
export function filterLeafCandidateCards(candidates: readonly Element[]): Element[] {
  if (candidates.length <= 1) return [...candidates];

  const candidateSet = new Set<Element>(candidates);
  const ancestorsOfCandidates = new Set<Element>();

  for (const el of candidates) {
    let parent = el.parentElement;
    while (parent) {
      if (candidateSet.has(parent)) {
        ancestorsOfCandidates.add(parent);
      }
      parent = parent.parentElement;
    }
  }

  return candidates.filter((el) => !ancestorsOfCandidates.has(el));
}

/**
 * Parses a single Amazon Category / Best Sellers / Deals / New Releases card element.
 */
export function parseAmazonCategoryCard(
  card: Element,
  sourceUrl = 'https://www.amazon.com/gp/bestsellers',
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
    pageType: 'category',
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

export const parseCategoryCard = parseAmazonCategoryCard;

/**
 * Extracts all valid product cards from an Amazon Category, Best Sellers, Deals,
 * or New Releases page. Supports `(doc, sourceUrl, cache, telemetry)` and `(doc, cache)`.
 */
export function parseAmazonCategoryPage(
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
  const sourceUrl = resolveCategorySourceUrl(activeDoc, explicitUrl);

  // Collect candidate cards across Best Sellers, Deals, and Category grids
  const combinedSelector = [
    ...AMAZON_SELECTORS.category.bestSellerCards,
    ...AMAZON_SELECTORS.category.dealCards,
    ...AMAZON_SELECTORS.category.browseCards,
  ].join(', ');

  let candidateCards = filterLeafCandidateCards(
    safeQuerySelectorAll(activeDoc, combinedSelector),
  );

  if (candidateCards.length === 0) {
    candidateCards = discoverStructuralProductCards(activeDoc);
  }

  const results: ScrapedAmazonProduct[] = [];
  const seenInPass = new Set<string>();

  for (const card of candidateCards) {
    try {
      const product = cache
        ? cache.getOrParse(card, (el) =>
            parseAmazonCategoryCard(el, sourceUrl, telemetry),
          )
        : parseAmazonCategoryCard(card, sourceUrl, telemetry);

      if (product && !seenInPass.has(product.asin)) {
        seenInPass.add(product.asin);
        results.push(product);
      }
    } catch {
      // Isolate per-card DOM exceptions
    }
  }

  // If semantic containers matched wrapper elements that lacked titles, try Tier 3 structural fallback
  if (results.length === 0) {
    const structuralCards = discoverStructuralProductCards(activeDoc);
    for (const card of structuralCards) {
      try {
        const product = parseAmazonCategoryCard(card, sourceUrl, telemetry);
        if (product && !seenInPass.has(product.asin)) {
          seenInPass.add(product.asin);
          results.push(product);
        }
      } catch {
        // Ignore
      }
    }
  }

  return results;
}

export const parseCategoryPage = parseAmazonCategoryPage;
