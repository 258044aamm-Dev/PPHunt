import { SELECTORS } from './selectors';
import { extractASIN, normalizeASIN, resolveProductUrl } from '@/lib/utils/amazon-url';
import {
  cleanAvailability,
  cleanBrand,
  cleanSeller,
  cleanText,
  containsAnyCard,
  discoverFallbackProductCards,
  dropNestedCards,
  isWithinAnyCard,
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
import type { ProductSource, ScrapedProduct } from '@/types/common';
import type { ParseCache } from './parse-cache';

/**
 * Parses products from Amazon category/browse/bestsellers/deals pages.
 * Uses 3-tier extraction (1: CSS selectors -> 2: ARIA/data-* -> 3: structural heuristics)
 * with per-card fault isolation so a malformed card never aborts the batch.
 */
export function parseCategoryPage(
  document: Document,
  pageUrl?: string,
  source: ProductSource = 'category',
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
  const rawCards = Array.from(
    document.querySelectorAll(SELECTORS.category.productCard)
  );

  // Prefer outermost product card containers when nested [data-asin] elements
  // match. H-9b: single-pass ancestor filter (O(N × depth)) — behaviourally
  // identical to the previous O(N²) `rawCards.some(contains)` filter.
  const cards = dropNestedCards(rawCards);
  // H-9b: kept in sync with `cards` so the dp-link overlap checks below are
  // Set-based ancestor walks instead of O(N²) `Node.contains()` pairs.
  const cardSet = new Set<Element>(cards);
  const dpLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/dp/"], a[href*="/gp/product/"]'
    )
  );
  for (const link of dpLinks) {
    if (isWithinAnyCard(link, cardSet)) continue;
    try {
      const asin = extractASIN(link.getAttribute('href') ?? '');
      if (!asin) continue;
      const container = resolveSingleProductCardContainer(link, asin);
      if (
        container &&
        !cardSet.has(container) &&
        !isWithinAnyCard(container, cardSet) &&
        !containsAnyCard(container, cardSet)
      ) {
        cards.push(container);
        cardSet.add(container);
      }
    } catch {
      // Isolate per-card DOM errors
    }
  }
  if (cards.length === 0) {
    cards.push(...discoverFallbackProductCards(document));
  }

  for (const rawCard of cards) {
    try {
      const initialLinkEl = rawCard.querySelector<HTMLAnchorElement>(
        SELECTORS.category.link
      );
      const initialHref =
        initialLinkEl?.getAttribute('href') ?? initialLinkEl?.href ?? null;
      const asin = extractCategoryCardAsin(rawCard, initialHref);

      if (!asin || seenAsins.has(asin)) continue;

      // H-9a (SAD-177): memoised per-card parse (see search-results.ts).
      const cached = cache?.get(rawCard);
      if (cached) {
        if (seenAsins.has(cached.asin)) continue;
        seenAsins.add(cached.asin);
        products.push(cached);
        continue;
      }

      // Expand to full single-product card container if rawCard was an inner [data-asin] or link node
      const card =
        rawCard.querySelector('img') != null
          ? rawCard
          : resolveSingleProductCardContainer(rawCard, asin);

      const linkEl =
        card.querySelector<HTMLAnchorElement>(SELECTORS.category.link) ??
        initialLinkEl;
      const linkHref = linkEl?.getAttribute('href') ?? linkEl?.href ?? null;

      const { imageUrl: initialImageUrl, imageEl } = findBestCardImageUrl(
        card,
        asin,
        baseUrl,
        SELECTORS.category.image
      );
      let title = extractCategoryCardTitle(card, linkEl, imageEl);

      // Pricing, List Price, and Discount Percentage (strictly separating current price from reference price)
      const pricing = extractCardPricingAndDiscounts(
        card,
        baseUrl,
        SELECTORS.category.price
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

      // Rating
      const ratingEl = card.querySelector(SELECTORS.category.rating);
      let rating =
        parseRating(ratingEl?.getAttribute('title')) ??
        parseRating(ratingEl?.getAttribute('aria-label')) ??
        parseRating(ratingEl?.textContent) ??
        parseRating(ratingEl?.parentElement?.getAttribute('aria-label'));

      // Review Count
      let reviewCount = extractCategoryCardReviewCount(card);

      // Image URL
      let imageUrl = initialImageUrl;

      // Prime & Sponsored
      let isPrime = !!card.querySelector(SELECTORS.category.prime);
      let isSponsored =
        !!card.querySelector(SELECTORS.category.sponsored) ||
        !!(
          linkHref &&
          (linkHref.includes('/sspa/click') || linkHref.includes('sp_atk='))
        );

      // Brand, Availability, Seller
      let brand = extractCategoryCardBrand(card, title);
      let availability = extractCategoryCardAvailability(card);
      let seller = extractCategoryCardSeller(card);

      // Tier 3: Structural heuristics fallback if any core field was missed
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
          source,
        },
        baseUrl
      );

      if (validated) {
        cache?.set(rawCard, validated);
        seenAsins.add(validated.asin);
        products.push(validated);
      }
    } catch (err) {
      console.warn('[PPHunt] Isolated category card parse error:', err);
    }
  }

  return products;
}

function extractCategoryCardAsin(
  card: Element,
  linkHref: string | null
): string | null {
  // 1. Direct data-asin on card or nested element
  const directAsin = normalizeASIN(card.getAttribute('data-asin'));
  if (directAsin) return directAsin;

  const nestedAsinEl = card.querySelector('[data-asin]:not([data-asin=""])');
  const nestedAsin = normalizeASIN(nestedAsinEl?.getAttribute('data-asin'));
  if (nestedAsin) return nestedAsin;

  // 2. Amazon Bestsellers p13n metadata attribute: data-p13n-asin-metadata='{"asin":"B0..."}'
  const metaAttr =
    card.getAttribute('data-p13n-asin-metadata') ??
    card
      .querySelector('[data-p13n-asin-metadata]')
      ?.getAttribute('data-p13n-asin-metadata');
  if (metaAttr) {
    try {
      const parsed = JSON.parse(metaAttr) as { asin?: string };
      const metaAsin = normalizeASIN(parsed?.asin);
      if (metaAsin) return metaAsin;
    } catch {
      // Ignore invalid JSON
    }
  }

  // 3. CSA item-id / ASIN attributes used on Amazon /deals cards (e.g. data-csa-c-item-id="amzn1.asin.B0...")
  const csaAsinAttr =
    card.getAttribute('data-csa-c-asin') ??
    card.querySelector('[data-csa-c-asin]')?.getAttribute('data-csa-c-asin') ??
    card.getAttribute('data-csa-c-item-id') ??
    card
      .querySelector('[data-csa-c-item-id]')
      ?.getAttribute('data-csa-c-item-id');
  if (csaAsinAttr) {
    const csaAsin = normalizeASIN(csaAsinAttr) ?? extractASIN(csaAsinAttr);
    if (csaAsin) return csaAsin;
  }

  // 4. Product link href
  if (linkHref) {
    const linkAsin = extractASIN(linkHref);
    if (linkAsin) return linkAsin;
  }

  // 5. Any nested anchor href containing an ASIN
  const allLinks = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'));
  for (const a of allLinks) {
    const found = extractASIN(a.getAttribute('href') ?? a.href ?? '');
    if (found) return found;
  }

  return null;
}

function extractCategoryCardTitle(
  card: Element,
  linkEl: HTMLAnchorElement | null,
  imageEl: HTMLImageElement | null
): string | null {
  const titleEl = card.querySelector(SELECTORS.category.title);
  const directTitle = extractElementText(titleEl);
  if (directTitle) return directTitle;

  // Fallback to h2/h3 heading or link text (excluding links that only wrap price or review counts)
  const headingEl = card.querySelector('h2, h3, [data-testid*="title"]');
  const headingTitle = extractElementText(headingEl);
  if (headingTitle && !/^[\d,.\s$€£¥₹()]+$/.test(headingTitle)) {
    return headingTitle;
  }

  if (linkEl) {
    const linkTitle =
      cleanText(linkEl.getAttribute('title')) ?? extractElementText(linkEl);
    if (linkTitle && !/^[\d,.\s$€£¥₹()]+$/.test(linkTitle)) {
      return linkTitle;
    }
  }

  return cleanText(imageEl?.getAttribute('alt'));
}

function extractCategoryCardReviewCount(card: Element): number | null {
  // 1. Check dedicated review count selectors first (icon row or review link)
  const dedicatedSelectors =
    '.a-icon-row a span.a-size-small, a[href*="product-reviews"] span, a[href*="#customerReviews"] span, [aria-label$="ratings"], [aria-label$="rating"]';
  const dedicatedEls = card.querySelectorAll(dedicatedSelectors);
  for (const el of dedicatedEls) {
    const text = el.getAttribute('aria-label') ?? el.textContent;
    if (!text || /[$€£¥￥₹]/.test(text)) continue;
    const count = parseReviewCount(text);
    if (count !== null) return count;
  }

  // 2. Fallback to .a-size-small only when its text looks like a review count (not a price, rank "#1", or title)
  const smallEls = card.querySelectorAll('.a-size-small');
  for (const el of smallEls) {
    if (el.closest('.a-price')) continue;
    const text = (el.getAttribute('aria-label') ?? el.textContent)?.trim();
    if (!text) continue;
    // Skip prices, bestseller rank badges (#1), or multi-word prose titles
    if (/[$€£¥￥₹]|^#\d+/.test(text)) continue;
    if (
      /^[(]?[\d,.]+\s*[kKmM]?[)]?(\s+(?:ratings?|reviews?|sterne|évaluation|valoraciones))?$/i.test(
        text
      )
    ) {
      const count = parseReviewCount(text);
      if (count !== null) return count;
    }
  }

  return null;
}

function extractCategoryCardBrand(
  card: Element,
  title: string | null
): string | null {
  const brandCandidates = card.querySelectorAll(
    '.a-row.a-size-small .a-size-small.a-color-base, .s-line-clamp-1 span, [data-brand]'
  );
  for (const el of brandCandidates) {
    const candidate = cleanBrand(
      el.getAttribute('data-brand') ?? extractElementText(el)
    );
    if (
      candidate &&
      candidate !== title &&
      !/^[\d,.\s$€£¥₹()]+$/.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function extractCategoryCardAvailability(card: Element): string | null {
  const els = card.querySelectorAll(
    '.a-color-success, .a-color-price, [aria-label*="in stock"]'
  );
  for (const el of els) {
    if (el.closest('.a-price')) continue;
    const text = extractElementText(el);
    if (
      text &&
      /\b(in stock|left in stock|currently unavailable|out of stock)\b/i.test(
        text
      )
    ) {
      return cleanAvailability(text);
    }
  }
  return null;
}

function extractCategoryCardSeller(card: Element): string | null {
  const els = card.querySelectorAll('.a-color-secondary, .a-size-small');
  for (const el of els) {
    const text = extractElementText(el);
    if (text && /\b(?:sold by|ships from and sold by)\s+/i.test(text)) {
      return cleanSeller(text);
    }
  }
  return null;
}
