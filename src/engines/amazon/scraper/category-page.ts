import type { ScrapedAmazonProduct } from '../types';
import { resolveProductUrl } from '../utils/amazon-url';
import {
  defaultAmazonDriftTelemetry,
  logDriftReport,
  type AmazonDriftTelemetry,
  type AmazonTrackedField,
} from './drift-telemetry';
import {
  discoverStructuralProductCards,
  dropNestedCards,
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
  extractCardVariations,
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

export interface CategoryPageParseOptions {
  cache?: AmazonParseCache;
  telemetry?: AmazonDriftTelemetry;
  extractPricing?: typeof extractCardPricingAndDiscounts;
  categoryName?: string | null;
}

export const filterLeafCandidateCards = (cards: readonly Element[]): Element[] =>
  dropNestedCards(cards, { dropDuplicates: false });

function extractPageCategoryHeading(doc: Document): string | null {
  const headings = safeQuerySelectorAll(
    doc,
    'h1, .zg-banner-text, #zg_listTitle',
  );
  for (const h of headings) {
    const text = normalizeWhitespace(h.textContent);
    const match =
      /(?:Best Sellers|New Releases|Movers & Shakers|Most Wished For)\s+in\s+(.+)/i.exec(
        text,
      );
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function extractCategoryCardBsr(
  card: Element,
  categoryName?: string | null,
): string | undefined {
  // Check explicit `#N in <Category>` inside card first
  const allSpans = safeQuerySelectorAll(card, 'span, div');
  for (const el of allSpans) {
    if (el.children.length > 2) continue;
    const text = normalizeWhitespace(el.textContent);
    const fullMatch = /(#\d[\d,]*\s+in\s+[A-Za-z0-9 &,'/-]+)/.exec(text);
    if (fullMatch?.[1]) {
      return fullMatch[1].trim();
    }
  }

  // Check Best Sellers badge (`span.zg-bdg-text`, `[class*="zg-bdg"]`, or standalone `#1` span)
  const rankBadge = safeQuerySelector(
    card,
    '.zg-bdg-text, [class*="zg-bdg-text"]',
  );
  let rankToken: string | null = null;
  if (rankBadge?.textContent) {
    const match = /(#\d{1,5})\b/.exec(normalizeWhitespace(rankBadge.textContent));
    if (match?.[1]) {
      rankToken = match[1];
    }
  }

  if (!rankToken) {
    for (const el of allSpans) {
      if (el.children.length > 0) continue;
      const text = normalizeWhitespace(el.textContent);
      if (/^#\d{1,5}$/.test(text)) {
        rankToken = text;
        break;
      }
    }
  }

  if (rankToken) {
    return categoryName ? `${rankToken} in ${categoryName}` : rankToken;
  }

  return undefined;
}

/**
 * Parses a single Category / Best Sellers / Deals card using the 4-tier self-healing cascade.
 */
export function parseAmazonCategoryCard(
  card: Element,
  pageUrl?: string,
  options: CategoryPageParseOptions = {},
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
    const bestSellersRank = extractCategoryCardBsr(card, options.categoryName);
    const pastMonthSales = extractCardPastMonthSales(card);
    const badge = extractCardBadge(card);
    const { delivery, availability } = extractCardDeliveryAndAvailability(card);
    const seller = extractCardSeller(card);
    const isPrime = extractCardIsPrime(card, delivery);
    const isSponsored = extractCardIsSponsored(card);
    const variations = extractCardVariations(card);

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
      source: 'category',
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
    if (variations !== undefined) {
      candidate.variations = variations;
    }

    return validateAndNormalizeScrapedProduct(candidate, pageUrl);
  } catch (err) {
    console.warn('[PPHunt] Failed to parse category card:', err);
    return null;
  }
}

export const parseCategoryCard = parseAmazonCategoryCard;

/**
 * Parses all Amazon Category / Best Sellers / Deals cards in a `Document`.
 * Uses O(N * depth) `dropNestedCards` so outer wrapper nodes never shadow inner cards.
 */
export function parseAmazonCategoryPage(
  doc: Document = document,
  pageUrl?: string,
  pageTypeOrCacheOrOptions?:
    | string
    | AmazonParseCache
    | CategoryPageParseOptions,
  explicitCache?: AmazonParseCache,
): ScrapedAmazonProduct[] {
  const activeUrl =
    pageUrl ??
    (typeof window !== 'undefined' && window.location ? window.location.href : undefined);

  const options: CategoryPageParseOptions =
    pageTypeOrCacheOrOptions instanceof AmazonParseCache
      ? { cache: pageTypeOrCacheOrOptions }
      : typeof pageTypeOrCacheOrOptions === 'string'
        ? { cache: explicitCache }
        : { ...(pageTypeOrCacheOrOptions ?? {}) };

  if (explicitCache && !options.cache) {
    options.cache = explicitCache;
  }

  const cache = options.cache ?? defaultAmazonParseCache;
  if (options.categoryName === undefined) {
    options.categoryName = extractPageCategoryHeading(doc);
  }

  const candidateSelectors = [
    ...AMAZON_SELECTORS.category.bestSellerCards,
    ...AMAZON_SELECTORS.category.dealCards,
    '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
    '.s-result-item[data-asin]:not([data-asin=""])',
    '.octopus-pc-item',
    '.apb-browse-searchresults-product',
  ];

  const seenElements = new Set<Element>();
  const rawCandidates: Element[] = [];

  for (const selector of candidateSelectors) {
    const matches = safeQuerySelectorAll(doc, selector);
    for (const el of matches) {
      if (el.closest('.a-carousel-card')) continue;
      if (!seenElements.has(el)) {
        seenElements.add(el);
        rawCandidates.push(el);
      }
    }
  }

  if (rawCandidates.length === 0) {
    const structural = discoverStructuralProductCards(doc);
    const asinFallbacks = safeQuerySelectorAll(
      doc,
      '[data-asin]:not([data-asin=""])',
    ).filter((el) => !el.closest('.a-carousel-card'));
    const fallbackList =
      structural.length >= asinFallbacks.length && structural.length > 0
        ? structural
        : asinFallbacks.length > 0
          ? asinFallbacks
          : structural;
    for (const el of fallbackList) {
      if (!seenElements.has(el)) {
        seenElements.add(el);
        rawCandidates.push(el);
      }
    }
  }

  const leafCards = dropNestedCards(rawCandidates, { dropDuplicates: true });

  const results: ScrapedAmazonProduct[] = [];
  const seenAsinsInPass = new Set<string>();

  for (const card of leafCards) {
    try {
      const parsed = cache.getOrParse(card, (el) =>
        parseAmazonCategoryCard(el, activeUrl, options),
      );
      if (parsed && !seenAsinsInPass.has(parsed.asin)) {
        seenAsinsInPass.add(parsed.asin);
        results.push(parsed);
      }
    } catch (err) {
      console.warn('[PPHunt] Category card iteration error:', err);
    }
  }

  // SAD-359: surface the aggregate card telemetry once for this listing
  // parse. This adds logging only; `results` and the telemetry totals are
  // unchanged.
  logDriftReport(
    options.telemetry ?? defaultAmazonDriftTelemetry,
    'category-page',
  );

  return results;
}

export const parseCategoryPage = parseAmazonCategoryPage;
