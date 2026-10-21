import type { ScrapedAmazonProduct } from '../types';
import { resolveProductUrl } from '../utils/amazon-url';
import { mergeScrapedProductFields } from './dedup';
import {
  defaultAmazonDriftTelemetry,
  logDriftReport,
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
  extractCardListingCategoryAndSection,
  extractCardPastMonthSales,
  extractCardPricingAndDiscounts,
  extractCardRatingAndReviewsWithTier,
  extractCardSeller,
  extractCardTitleAndBrandWithTier,
  extractCardVariations,
  isWithinAnyCard,
  normalizeWhitespace,
  validateAndNormalizeScrapedProduct,
} from './field-parsers';
import {
  applyValidationResults,
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsSink,
} from './extraction-diagnostics';
import { recordCardDiagnostics } from './card-diagnostics';
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
  /** SAD-369: receives one finished report per parsed card. Absent → no diagnostics, no per-card cost. */
  diagnosticsSink?: ExtractionDiagnosticsSink;
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
    // SAD-369 step 2: opt-in per-card report. No sink → no collector, no cost,
    // and the extraction below is byte-identical.
    const diagnostics = options.diagnosticsSink
      ? createFieldDiagnosticsCollector()
      : undefined;

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
    const variations = extractCardVariations(card);
    const { listingCategory, sectionLabel } =
      extractCardListingCategoryAndSection(card, isSponsored);

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
    telemetry.recordCardExtraction(fieldTiers, {
      ratingNode: ratingResult.nodeSeen,
      reviewNode: reviewResult.nodeSeen,
    });

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
    if (variations !== undefined) {
      candidate.variations = variations;
    }
    if (listingCategory !== undefined) {
      candidate.listingCategory = listingCategory;
    }
    if (sectionLabel !== undefined) {
      candidate.sectionLabel = sectionLabel;
    }

    const normalized = validateAndNormalizeScrapedProduct(candidate, pageUrl);
    // SAD-369 step 2: record the per-card report AFTER validation so a
    // validator-dropped value honestly shows PARTIAL. No report when the
    // product was rejected — there is nothing for it to ride along with.
    // Recording only: the returned product is identical with or without a sink.
    if (diagnostics && normalized) {
      diagnostics.setAsin(asin);
      recordCardDiagnostics(diagnostics, {
        asin: { value: asin, tier: asinResult.tier },
        title: titleResult,
        brand,
        pricing,
        rating: ratingResult,
        reviewCount: reviewResult,
        image: imageResult,
        pastMonthSales,
        delivery,
        availability,
        seller,
        isPrime,
        bestSellersRank,
        variations,
        url,
      });
      applyValidationResults(diagnostics, candidate, normalized);
      options.diagnosticsSink!.accept(diagnostics.build());
    }
    return normalized;
  } catch (err) {
    console.warn('[PPHunt] Failed to parse search card:', err);
    return null;
  }
}

export const parseSearchCard = parseAmazonSearchCard;

const MAIN_SLOT_WIDGET_CARD_SELECTORS: readonly string[] = [
  '.s-result-item[data-asin]:not([data-asin=""])',
  '[data-type="productContainer"][data-asin]:not([data-asin=""])',
  '.a-carousel-card[data-asin]:not([data-asin=""])',
  '.a-carousel-card [data-asin]:not([data-asin=""])',
  '.s-widget [data-asin]:not([data-asin=""])',
  '[data-p13n-asin-metadata]',
  '[data-asinadattributesprops]',
  '[data-component-type="sbv-video-single-product"]',
];

function isExcludedWidgetNode(el: Element): boolean {
  if (el.classList.contains('atc-faceout-container')) {
    return true;
  }
  const tag = el.tagName.toUpperCase();
  if (tag === 'FORM' || tag === 'BUTTON' || tag === 'INPUT') {
    return true;
  }
  try {
    if (
      el.closest(
        '.atc-faceout-container, [cel_widget_id*="multi-brand-creative"], [data-card-metrics-id*="multi-brand-creative"], #rhf, #navFooter',
      )
    ) {
      return true;
    }
  } catch {
    // Ignore selector errors
  }
  return false;
}

/**
 * Discovers real product cards inside `.s-main-slot` search widgets (Sponsored Brand carousels,
 * Sponsored Brand Video collections, Single-Product Sponsored Video widgets, and Customer Review /
 * Shopping Adviser / Thematic carousels) while excluding nested `.atc-faceout-container` nodes,
 * non-product `multi-brand-creative` store banners, and peripheral `#rhf` noise.
 */
export function discoverMainSlotWidgetProductCards(
  doc: Document,
  primaryCards: readonly Element[] = [],
): Element[] {
  const mainSlot = safeQuerySelector(doc, '.s-main-slot');
  if (!mainSlot) return [];

  const primarySet = new Set<Element>(primaryCards);
  const rawCandidates: Element[] = [];
  const seenElements = new Set<Element>();

  const matches = safeQuerySelectorAll(
    mainSlot,
    MAIN_SLOT_WIDGET_CARD_SELECTORS.join(', '),
  );
  for (const el of matches) {
    if (seenElements.has(el)) continue;
    if (primarySet.has(el) || isWithinAnyCard(el, primarySet)) continue;
    if (isExcludedWidgetNode(el)) continue;
    seenElements.add(el);
    rawCandidates.push(el);
  }

  if (rawCandidates.length <= 1) {
    return rawCandidates;
  }

  // Keep only the outermost single-product widget card when candidates are nested inside each other
  const candidateSet = new Set<Element>(rawCandidates);
  return rawCandidates.filter((el) => {
    let cursor = el.parentElement;
    while (cursor && cursor !== mainSlot) {
      if (candidateSet.has(cursor)) {
        return false;
      }
      cursor = cursor.parentElement;
    }
    return true;
  });
}

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

  let primaryCards: Element[] = [];
  for (const selector of AMAZON_SELECTORS.search.cardContainers) {
    const matches = safeQuerySelectorAll(mainRoot, selector).filter(
      (el) => !el.closest('.a-carousel-card') && !isExcludedWidgetNode(el),
    );
    if (matches.length > 0) {
      primaryCards = matches;
      break;
    }
  }

  if (primaryCards.length === 0 && mainRoot !== doc) {
    for (const selector of AMAZON_SELECTORS.search.cardContainers) {
      const matches = safeQuerySelectorAll(doc, selector).filter(
        (el) => !el.closest('.a-carousel-card') && !isExcludedWidgetNode(el),
      );
      if (matches.length > 0) {
        primaryCards = matches;
        break;
      }
    }
  }

  const widgetCards = discoverMainSlotWidgetProductCards(doc, primaryCards);

  if (primaryCards.length === 0 && widgetCards.length === 0) {
    const structural = discoverStructuralProductCards(mainRoot);
    const asinCards = safeQuerySelectorAll(
      mainRoot,
      '[data-asin]:not([data-asin=""])',
    ).filter(
      (el) => !el.closest('.a-carousel-card') && !isExcludedWidgetNode(el),
    );
    primaryCards =
      structural.length >= asinCards.length && structural.length > 0
        ? structural
        : asinCards.length > 0
          ? asinCards
          : structural;
  }

  const primarySet = new Set<Element>(primaryCards);
  const allCards: Element[] = [...primaryCards, ...widgetCards];

  const results: ScrapedAmazonProduct[] = [];
  const entriesByAsin = new Map<
    string,
    { product: ScrapedAmazonProduct; isPrimary: boolean }
  >();

  for (const card of allCards) {
    try {
      const isPrimary = primarySet.has(card);
      const quickAsin = extractCardAsinWithTier(card).value;
      if (quickAsin) {
        const existingQuick = entriesByAsin.get(quickAsin);
        // If two primary `s-search-result` cards share an ASIN, first-card-wins without re-parsing
        if (existingQuick && existingQuick.isPrimary && isPrimary) {
          continue;
        }
      }

      const parsed = cache.getOrParse(card, (el) =>
        parseAmazonSearchCard(el, activeUrl, options),
      );
      if (!parsed) continue;

      const existing = entriesByAsin.get(parsed.asin);
      if (!existing) {
        // Clone before storing so in-place field merging never mutates a cached object reference unexpectedly
        const cloned: ScrapedAmazonProduct = { ...parsed };
        entriesByAsin.set(parsed.asin, { product: cloned, isPrimary });
        results.push(cloned);
      } else {
        // Merge non-null fields, preferring the primary `s-search-result` card over compact widget cards
        mergeScrapedProductFields(existing.product, parsed, {
          preferSource: isPrimary && !existing.isPrimary,
        });
        if (isPrimary && !existing.isPrimary) {
          existing.isPrimary = true;
        }
      }
    } catch (err) {
      console.warn('[PPHunt] Search card iteration error:', err);
    }
  }

  // SAD-359: surface the aggregate card telemetry once for this listing
  // parse. This adds logging only; `results` and the telemetry totals are
  // unchanged.
  logDriftReport(
    options.telemetry ?? defaultAmazonDriftTelemetry,
    'search-results',
  );

  return results;
}

export const parseSearchResults = parseAmazonSearchResults;
