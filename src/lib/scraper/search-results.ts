import { SELECTORS } from './selectors';
import { extractASIN, normalizeASIN, resolveProductUrl } from '@/lib/utils/amazon-url';
import {
  cleanAvailability,
  cleanBrand,
  cleanSeller,
  cleanText,
  discoverFallbackProductCards,
  extractBestSellersRank,
  extractCardByHeuristics,
  extractCardPricingAndDiscounts,
  extractCouponText,
  extractDealBadge,
  extractDeliveryInfo,
  extractElementText,
  extractPageCategoryName,
  extractPastMonthSales,
  extractProductBadge,
  findBestCardImageUrl,
  parseRating,
  parseReviewCount,
  resolveSingleProductCardContainer,
  validateAndNormalizeScrapedProduct,
} from './field-parsers';
import type { ScrapedProduct } from '@/types/common';
import type { ParseCache } from './parse-cache';

/**
 * Parses all product cards from an Amazon search results page.
 * Uses 3-tier extraction (1: CSS selectors -> 2: ARIA/data-* -> 3: structural heuristics)
 * with per-card fault isolation so a malformed card never aborts the batch.
 */
export function parseSearchResults(
  document: Document,
  pageUrl?: string,
  cache?: ParseCache
): ScrapedProduct[] {
  const products: ScrapedProduct[] = [];
  const seenAsins = new Set<string>();
  const baseUrl =
    pageUrl ??
    document.location?.href ??
    (typeof window !== 'undefined' ? window.location?.href : undefined) ??
    'https://www.amazon.com';

  const pageCategoryHint = extractPageCategoryName(document);
  const primaryCards = Array.from(
    document.querySelectorAll(SELECTORS.search.productCard)
  );
  const cards =
    primaryCards.length > 0
      ? primaryCards
      : discoverFallbackProductCards(document);

  for (const rawCard of cards) {
    try {
      const rawAsin = rawCard.getAttribute(SELECTORS.search.asin)?.trim();
      const linkEl = rawCard.querySelector<HTMLAnchorElement>(
        SELECTORS.search.titleLink
      );
      const linkHref = linkEl?.getAttribute('href') ?? linkEl?.href ?? null;

      let asin =
        normalizeASIN(rawAsin) ?? (linkHref ? extractASIN(linkHref) : null);

      if (!asin) {
        const anyDpLink = rawCard.querySelector<HTMLAnchorElement>(
          'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click"]'
        );
        if (anyDpLink) {
          asin = extractASIN(anyDpLink.getAttribute('href') ?? '');
        }
      }

      if (!asin || seenAsins.has(asin)) continue;

      // H-9a (SAD-177): memoised per-card parse. Only COMPLETE cards hit the
      // cache (risk R3: late-hydrating fields must keep re-parsing). ASIN
      // extraction and dedup stay live so first-card-wins ordering is
      // unchanged.
      const cached = cache?.get(rawCard);
      if (cached) {
        if (seenAsins.has(cached.asin)) continue;
        seenAsins.add(cached.asin);
        products.push(cached);
        continue;
      }

      const card =
        primaryCards.length > 0
          ? rawCard
          : resolveSingleProductCardContainer(rawCard, asin);

      const { imageUrl: initialImageUrl, imageEl } = findBestCardImageUrl(
        card,
        asin,
        baseUrl,
        SELECTORS.search.image
      );

      // Tier 1 & 2 extraction
      let title = extractSearchCardTitle(card, imageEl);

      // Pricing, List Price, and Discount Percentage (strictly separating current price from reference price)
      const pricing = extractCardPricingAndDiscounts(
        card,
        baseUrl,
        SELECTORS.search.price,
        SELECTORS.search.priceFallback
      );
      let price = pricing.price;
      let currency = pricing.currency;
      let listPrice = pricing.listPrice;
      let discountPercentage = pricing.discountPercentage;

      let dealBadge = extractDealBadge(card);
      let bestSellersRank = extractBestSellersRank(card, pageCategoryHint);
      let pastMonthSales = extractPastMonthSales(card);
      let coupon = extractCouponText(card);
      let badge = extractProductBadge(card);
      let delivery = extractDeliveryInfo(card);

      let rating = extractSearchCardRating(card);
      let reviewCount = extractSearchCardReviewCount(card);
      let imageUrl = initialImageUrl;
      let isSponsored = detectSearchCardSponsored(card, linkHref);
      let isPrime = detectSearchCardPrime(card);
      let brand = extractSearchCardBrand(card, title);
      let availability = extractSearchCardAvailability(card);
      let seller = extractSearchCardSeller(card);

      // Tier 3: Structural heuristics fallback if any core field was missed due to DOM/class changes
      if (
        !title ||
        price === null ||
        rating === null ||
        reviewCount === null ||
        !imageUrl
      ) {
        const heuristic = extractCardByHeuristics(card, asin, baseUrl);
        title = title ?? heuristic.title ?? null;
        if (price === null && heuristic.price != null) {
          price = heuristic.price;
          currency = heuristic.currency ?? currency;
        }
        listPrice = listPrice ?? heuristic.listPrice ?? null;
        discountPercentage =
          discountPercentage ?? heuristic.discountPercentage ?? null;
        dealBadge = dealBadge ?? heuristic.dealBadge ?? null;
        bestSellersRank = bestSellersRank ?? heuristic.bestSellersRank ?? null;
        pastMonthSales = pastMonthSales ?? heuristic.pastMonthSales ?? null;
        coupon = coupon ?? heuristic.coupon ?? null;
        badge = badge ?? heuristic.badge ?? null;
        delivery = delivery ?? heuristic.delivery ?? null;
        rating = rating ?? heuristic.rating ?? null;
        reviewCount = reviewCount ?? heuristic.reviewCount ?? null;
        imageUrl = imageUrl ?? heuristic.imageUrl ?? null;
        brand = brand ?? heuristic.brand ?? null;
        availability = availability ?? heuristic.availability ?? null;
        seller = seller ?? heuristic.seller ?? null;
        isSponsored = isSponsored || Boolean(heuristic.isSponsored);
        isPrime = isPrime || Boolean(heuristic.isPrime);
      }

      const validated = validateAndNormalizeScrapedProduct(
        {
          asin,
          url: resolveProductUrl(linkHref, asin, baseUrl),
          title,
          price,
          listPrice,
          discountPercentage,
          dealBadge,
          currency,
          rating,
          reviewCount,
          bestSellersRank,
          pastMonthSales,
          coupon,
          badge,
          delivery,
          imageUrl,
          isSponsored,
          isPrime,
          brand,
          availability,
          seller,
          description: null,
          features: [],
          source: 'search',
        },
        baseUrl
      );

      if (validated) {
        cache?.set(rawCard, validated);
        seenAsins.add(validated.asin);
        products.push(validated);
      }
    } catch (err) {
      console.warn('[PPHunt] Isolated search card parse error:', err);
    }
  }

  return products;
}

function extractSearchCardTitle(
  card: Element,
  imageEl: HTMLImageElement | null
): string | null {
  // 1. Prefer h2 inside a link or a link inside h2
  const linkedTitleEl = card.querySelector(
    'h2 a span, a h2 span, [data-cy="title-recipe"] a h2 span, [data-cy="title-recipe"] h2 a span'
  );
  const linkedTitle = extractElementText(linkedTitleEl);
  if (linkedTitle) return linkedTitle;

  // 2. Check all h2 elements; if multiple exist (e.g. mini brand h2 + main title h2), pick the longest one
  const h2Els = Array.from(card.querySelectorAll('h2'));
  if (h2Els.length > 0) {
    let bestH2Text: string | null = null;
    for (const h2 of h2Els) {
      const aria = cleanText(h2.getAttribute('aria-label'));
      const text = aria ?? extractElementText(h2);
      if (text && (!bestH2Text || text.length > bestH2Text.length)) {
        bestH2Text = text;
      }
    }
    if (bestH2Text) return bestH2Text;
  }

  // 3. Fallback to primary selector or h3 heading inside a product link
  const fallbackEl =
    card.querySelector(SELECTORS.search.title) ??
    card.querySelector('a[href*="/dp/"] h3, h3 a[href*="/dp/"], h3');
  const fallbackText = extractElementText(fallbackEl);
  if (fallbackText) return fallbackText;

  const altText = cleanText(
    imageEl?.getAttribute('alt')?.replace(/^Sponsored Ad\s*-\s*/i, '')
  );
  return altText;
}

function extractSearchCardRating(card: Element): number | null {
  const candidates = card.querySelectorAll(SELECTORS.search.rating);
  for (const el of candidates) {
    const rating =
      parseRating(el.getAttribute('title')) ??
      parseRating(el.getAttribute('aria-label')) ??
      parseRating(el.textContent) ??
      parseRating(el.parentElement?.getAttribute('aria-label'));
    if (rating !== null) return rating;
  }
  return null;
}

function extractSearchCardReviewCount(card: Element): number | null {
  const primaryEls = card.querySelectorAll(SELECTORS.search.reviewCount);
  for (const el of primaryEls) {
    const count =
      parseReviewCount(el.getAttribute('aria-label')) ??
      parseReviewCount(el.textContent);
    if (count !== null) return count;
  }

  const fallbackEls = card.querySelectorAll(
    SELECTORS.search.reviewCountFallback
  );
  for (const el of fallbackEls) {
    const text = el.getAttribute('aria-label') ?? el.textContent;
    if (!text) continue;
    // Skip elements that are clearly prices or non-numeric labels
    if (/[$€£¥￥₹]/.test(text)) continue;
    const count = parseReviewCount(text);
    if (count !== null) return count;
  }

  return null;
}

function detectSearchCardSponsored(
  card: Element,
  linkHref: string | null
): boolean {
  if (card.getAttribute('data-component-type') === 's-sponsored-result') {
    return true;
  }
  if (card.classList.contains('AdHolder')) {
    return true;
  }
  if (card.querySelector(SELECTORS.search.sponsored)) {
    return true;
  }
  if (
    linkHref &&
    (linkHref.includes('/sspa/click') || linkHref.includes('sp_atk='))
  ) {
    return true;
  }
  const secondarySpans = card.querySelectorAll(
    '.a-color-secondary, .puis-label-popover-default'
  );
  for (const span of secondarySpans) {
    const text = span.textContent?.trim();
    if (
      text &&
      /^(Sponsored|Gesponsert|Sponsorisé|Patrocinado|Sponsorizzato|スポンサー)$/i.test(
        text
      )
    ) {
      return true;
    }
  }
  return false;
}

function detectSearchCardPrime(card: Element): boolean {
  return !!card.querySelector(SELECTORS.search.prime);
}

function extractSearchCardBrand(
  card: Element,
  title: string | null
): string | null {
  // 1. Check explicit brand selectors (h5.s-line-clamp-1, .a-size-base-plus)
  const brandEl = card.querySelector(
    'h5.s-line-clamp-1 span, .s-line-clamp-1 span.a-size-base-plus, [data-brand]'
  );
  const directBrand = cleanBrand(
    brandEl?.getAttribute('data-brand') ?? extractElementText(brandEl)
  );
  if (directBrand && directBrand !== title) {
    return directBrand;
  }

  // 2. If [data-cy="title-recipe"] has an unlinked mini h2 above the linked title h2
  const h2Els = Array.from(card.querySelectorAll('h2'));
  if (h2Els.length >= 2) {
    const firstH2 = h2Els[0];
    if (firstH2 && !firstH2.querySelector('a') && !firstH2.closest('a')) {
      const candidate = cleanBrand(extractElementText(firstH2));
      if (candidate && candidate !== title && candidate.length <= 60) {
        return candidate;
      }
    }
  }

  // 3. Check "by <Brand>" in secondary rows
  const secondaryRows = card.querySelectorAll(
    '.a-row.a-size-base.a-color-secondary, [data-cy="title-recipe"] .a-color-secondary'
  );
  for (const row of secondaryRows) {
    const rowText = extractElementText(row);
    if (!rowText) continue;
    const byMatch = rowText.match(
      /(?:^|\b)by\s+([A-Za-z0-9][A-Za-z0-9\s.&'-]{1,50})/i
    );
    if (byMatch?.[1]) {
      const parsed = cleanBrand(byMatch[1]);
      if (parsed && parsed !== title) return parsed;
    }
  }

  return null;
}

function extractSearchCardAvailability(card: Element): string | null {
  const candidates = card.querySelectorAll(SELECTORS.search.availability);
  for (const el of candidates) {
    const text =
      cleanText(el.getAttribute('aria-label')) ?? extractElementText(el);
    if (
      text &&
      /\b(in stock|left in stock|currently unavailable|temporarily out of stock|out of stock|available instantly)\b/i.test(
        text
      )
    ) {
      return cleanAvailability(text);
    }
  }
  return null;
}

function extractSearchCardSeller(card: Element): string | null {
  const sellerEl = card.querySelector(SELECTORS.search.seller);
  if (sellerEl) {
    const cleaned = cleanSeller(extractElementText(sellerEl));
    if (cleaned) return cleaned;
  }

  const secondaryEls = card.querySelectorAll(
    '.a-row.a-size-base.a-color-secondary span'
  );
  for (const el of secondaryEls) {
    const text = extractElementText(el);
    if (text && /\b(?:sold by|ships from and sold by)\s+/i.test(text)) {
      const cleaned = cleanSeller(text);
      if (cleaned) return cleaned;
    }
  }

  return null;
}
