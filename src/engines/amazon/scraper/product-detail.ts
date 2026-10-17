import type { ScrapedAmazonProduct } from '../types';
import {
  extractASIN,
  normalizeASIN,
  resolveProductUrl,
} from '../utils/amazon-url';
import { isIsoCurrency, resolvePageCurrency } from '../utils/currency';
import { parsePrice } from '../utils/price-parser';
import {
  cleanAvailability,
  cleanBrand,
  cleanSeller,
  extractBestImageUrl,
  extractCardPastMonthSales,
  extractCardPricingAndDiscounts,
  normalizeDiscountBadge,
  normalizeWhitespace,
  parseRating,
  parseReviewCount,
  validateAndNormalizeScrapedProduct,
} from './field-parsers';
import {
  AMAZON_SELECTORS,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

function isInsideExcludedDetailSubtree(el: Element): boolean {
  for (const selector of AMAZON_SELECTORS.detail.excludedSubtrees) {
    try {
      if (el.closest(selector)) {
        return true;
      }
    } catch {
      // Ignore selector error
    }
  }
  return false;
}

interface JsonLdProductMetadata {
  asin?: string;
  title?: string;
  brand?: string;
  imageUrl?: string;
  description?: string;
  price?: number;
  currency?: string;
  rating?: number;
  reviewCount?: number;
}

function extractProductJsonLd(doc: Document): JsonLdProductMetadata {
  const result: JsonLdProductMetadata = {};
  const scripts = safeQuerySelectorAll<HTMLScriptElement>(
    doc,
    'script[type="application/ld+json"]',
  );

  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        if (rec['@type'] !== 'Product') continue;

        const asinCandidate = normalizeASIN(
          (rec.sku as string | undefined) ??
            (rec.productID as string | undefined) ??
            (rec.mpn as string | undefined),
        );
        if (asinCandidate && !result.asin) result.asin = asinCandidate;

        if (typeof rec.name === 'string' && rec.name.trim() && !result.title) {
          result.title = normalizeWhitespace(rec.name);
        }

        if (rec.brand && typeof rec.brand === 'object' && !result.brand) {
          const brandName = (rec.brand as Record<string, unknown>).name;
          if (typeof brandName === 'string') {
            result.brand = cleanBrand(brandName) ?? undefined;
          }
        }

        if (typeof rec.image === 'string' && !result.imageUrl) {
          result.imageUrl = rec.image;
        } else if (
          Array.isArray(rec.image) &&
          typeof rec.image[0] === 'string' &&
          !result.imageUrl
        ) {
          result.imageUrl = rec.image[0];
        }

        if (typeof rec.description === 'string' && !result.description) {
          result.description = normalizeWhitespace(rec.description);
        }

        const offers = rec.offers as Record<string, unknown> | undefined;
        if (offers && typeof offers === 'object') {
          const rawPrice = offers.price ?? offers.lowPrice;
          if (
            (typeof rawPrice === 'number' || typeof rawPrice === 'string') &&
            result.price === undefined
          ) {
            const num =
              typeof rawPrice === 'number'
                ? rawPrice
                : Number.parseFloat(rawPrice);
            if (Number.isFinite(num) && num >= 0) {
              result.price = Math.round(num * 100) / 100;
            }
          }
          if (
            typeof offers.priceCurrency === 'string' &&
            isIsoCurrency(offers.priceCurrency)
          ) {
            result.currency = offers.priceCurrency.toUpperCase();
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  return result;
}

function extractDetailAsin(
  doc: Document,
  pageUrl?: string,
  jsonLd?: JsonLdProductMetadata,
): string | null {
  const fromUrl = extractASIN(pageUrl);
  if (fromUrl) return fromUrl;

  const hiddenInputs = safeQuerySelectorAll<HTMLInputElement>(
    doc,
    'input#ASIN, input[name="ASIN"], input[name="ASIN.0"], input[name="idx.asin"]',
  );
  for (const input of hiddenInputs) {
    const asin = normalizeASIN(input.value || input.getAttribute('value'));
    if (asin) return asin;
  }

  const canonical = safeQuerySelector<HTMLLinkElement>(
    doc,
    'link[rel="canonical"]',
  );
  const fromCanonical = extractASIN(canonical?.getAttribute('href'));
  if (fromCanonical) return fromCanonical;

  const detailRoot = safeQuerySelector(
    doc,
    '#dp-container[data-asin], #dp[data-asin], [data-asin]',
  );
  const fromDataAttr = normalizeASIN(detailRoot?.getAttribute('data-asin'));
  if (fromDataAttr) return fromDataAttr;

  if (jsonLd?.asin) return jsonLd.asin;

  return null;
}

function extractDetailBsr(doc: Document): string | undefined {
  for (const selector of AMAZON_SELECTORS.detail.bsr) {
    const container = safeQuerySelector(doc, selector);
    if (!container) continue;
    const rawText = normalizeWhitespace(container.textContent);
    if (!/Best Sellers Rank/i.test(rawText)) continue;

    // Strip parenthetical "(See Top 100 in ...)" before extracting rank clauses
    const cleaned = rawText.replace(/\(\s*See Top\s+\d+[^)]*\)/gi, ' ');
    const rankMatches = Array.from(
      cleaned.matchAll(/#\d[\d,]*\s+in\s+[A-Za-z0-9 &,'/-]+/g),
      (m) => normalizeWhitespace(m[0]),
    ).filter(Boolean);

    if (rankMatches.length >= 2) {
      return `${rankMatches[0]} (${rankMatches[1]})`;
    }
    if (rankMatches.length === 1) {
      return rankMatches[0];
    }
  }
  return undefined;
}

/**
 * Parses an Amazon Product Detail (`/dp/<ASIN>`) page.
 * Prioritizes `#corePriceDisplay_desktop_feature_div` / `#buybox` over ad carousels.
 */
export function parseAmazonProductDetail(
  doc: Document = document,
  pageUrl?: string,
): ScrapedAmazonProduct | null {
  try {
    const activeUrl =
      pageUrl ??
      (typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'https://www.amazon.com');

    const jsonLd = extractProductJsonLd(doc);
    const asin = extractDetailAsin(doc, activeUrl, jsonLd);
    if (!asin) {
      return null;
    }

    // Title
    let title: string | null = null;
    for (const selector of AMAZON_SELECTORS.detail.title) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        const text = normalizeWhitespace(el.textContent);
        if (text) {
          title = text;
          break;
        }
      }
    }
    if (!title && jsonLd.title) {
      title = jsonLd.title;
    }
    if (!title) {
      return null;
    }

    // Brand
    let brand: string | null = null;
    for (const selector of AMAZON_SELECTORS.detail.brand) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        brand = cleanBrand(el.textContent);
        if (brand) break;
      }
    }
    if (!brand && jsonLd.brand) {
      brand = jsonLd.brand;
    }

    // Scoped Buybox Pricing & Discounts
    const pageCurrency = resolvePageCurrency(activeUrl);
    let price: number | null = null;
    let currency: string | null = pageCurrency;
    let listPrice: number | undefined;
    let discountPercentage: string | undefined;
    let dealBadge: string | undefined;
    let coupon: string | undefined;

    for (const scopeSelector of AMAZON_SELECTORS.detail.buyboxScopes) {
      const scopeEl = safeQuerySelector(doc, scopeSelector);
      if (!scopeEl || isInsideExcludedDetailSubtree(scopeEl)) continue;

      const scopedPricing = extractCardPricingAndDiscounts(scopeEl, activeUrl);
      if (price === null && scopedPricing.price !== null) {
        price = scopedPricing.price;
        currency = scopedPricing.currency ?? pageCurrency;
      }
      if (listPrice === undefined && scopedPricing.listPrice !== undefined) {
        listPrice = scopedPricing.listPrice;
      }
      if (
        discountPercentage === undefined &&
        scopedPricing.discountPercentage !== undefined
      ) {
        discountPercentage = scopedPricing.discountPercentage;
      }
      if (dealBadge === undefined && scopedPricing.dealBadge !== undefined) {
        dealBadge = scopedPricing.dealBadge;
      }
      if (coupon === undefined && scopedPricing.coupon !== undefined) {
        coupon = scopedPricing.coupon;
      }
      if (price !== null) break;
    }

    // Check legacy `#priceblock_ourprice` / `#priceblock_dealprice` if still null
    if (price === null) {
      const legacyEl = safeQuerySelector(
        doc,
        '#priceblock_dealprice, #priceblock_ourprice, #price_inside_buybox',
      );
      if (legacyEl && !isInsideExcludedDetailSubtree(legacyEl)) {
        const parsed = parsePrice(legacyEl.textContent, pageCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency ?? pageCurrency;
        }
      }
    }

    if (price === null && jsonLd.price !== undefined) {
      price = jsonLd.price;
      currency = jsonLd.currency ?? pageCurrency;
    }

    if (listPrice === undefined) {
      const strikeEls = safeQuerySelectorAll(
        doc,
        '#corePriceDisplay_desktop_feature_div [data-a-strike="true"] .a-offscreen, #corePrice_feature_div [data-a-strike="true"] .a-offscreen, #apex_desktop .basisPrice .a-offscreen, #listPrice',
      );
      for (const el of strikeEls) {
        if (isInsideExcludedDetailSubtree(el)) continue;
        const parsed = parsePrice(el.textContent, currency ?? pageCurrency);
        if (
          parsed.value !== null &&
          (price === null || parsed.value > price)
        ) {
          listPrice = parsed.value;
          break;
        }
      }
    }

    if (discountPercentage === undefined) {
      const savEl = safeQuerySelector(
        doc,
        '#corePriceDisplay_desktop_feature_div .savingsPercentage, #corePrice_feature_div .savingsPercentage, #apex_desktop .savingsPercentage',
      );
      if (savEl && !isInsideExcludedDetailSubtree(savEl)) {
        discountPercentage = normalizeDiscountBadge(savEl.textContent);
      }
    }

    if (dealBadge === undefined) {
      for (const selector of AMAZON_SELECTORS.cardFields.dealBadge) {
        const el = safeQuerySelector(doc, selector);
        if (!el || isInsideExcludedDetailSubtree(el)) continue;
        const text = normalizeWhitespace(el.textContent);
        if (text && /deal|limited|lightning|prime day|black friday/i.test(text)) {
          dealBadge = text;
          break;
        }
      }
    }

    if (coupon === undefined) {
      for (const selector of AMAZON_SELECTORS.cardFields.coupon) {
        const el = safeQuerySelector(doc, selector);
        if (!el || isInsideExcludedDetailSubtree(el)) continue;
        const text = normalizeWhitespace(el.textContent);
        if (text && /coupon|voucher|rabatt/i.test(text)) {
          coupon = text.replace(/\s*Terms\s*$/i, '').trim();
          break;
        }
      }
    }

    // Past Month Sales
    let pastMonthSales: string | undefined;
    const boughtEl = safeQuerySelector(
      doc,
      '#social-proofing-faceout-title-tk_bought span, #social-proofing-faceout-title-tk_bought',
    );
    if (boughtEl && !isInsideExcludedDetailSubtree(boughtEl)) {
      const text = normalizeWhitespace(boughtEl.textContent);
      const match =
        /(\d+(?:[.,]\d+)?\s*[KkMm+]?\+?\s*bought in past month)/i.exec(text);
      if (match?.[1]) {
        pastMonthSales = match[1].trim();
      }
    }
    if (!pastMonthSales && (doc.body || doc.documentElement)) {
      pastMonthSales = extractCardPastMonthSales(
        (doc.body ?? doc.documentElement)!,
      );
    }

    // Rating & Review count
    let rating: number | null = null;
    const acrPopover = safeQuerySelector(
      doc,
      '#acrPopover, #averageCustomerReviews [data-action="acrStarsLink-click-metrics"]',
    );
    if (acrPopover && !isInsideExcludedDetailSubtree(acrPopover)) {
      rating = parseRating(
        acrPopover.getAttribute('title') ||
          acrPopover.getAttribute('aria-label') ||
          acrPopover.textContent,
      );
    }
    if (rating === null && jsonLd.rating !== undefined) {
      rating = jsonLd.rating;
    }

    let reviewCount: number | null = null;
    const reviewEl = safeQuerySelector(doc, '#acrCustomerReviewText');
    if (reviewEl && !isInsideExcludedDetailSubtree(reviewEl)) {
      reviewCount = parseReviewCount(reviewEl.textContent);
    }
    if (reviewCount === null && jsonLd.reviewCount !== undefined) {
      reviewCount = jsonLd.reviewCount;
    }

    // Availability
    let availability: string | null = null;
    for (const selector of AMAZON_SELECTORS.detail.availability) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        availability = cleanAvailability(el.textContent);
        if (availability) break;
      }
    }

    // Delivery
    let delivery: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.delivery) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        const text = normalizeWhitespace(el.textContent);
        if (text) {
          delivery = text;
          break;
        }
      }
    }

    // Seller
    let seller: string | null = null;
    for (const selector of AMAZON_SELECTORS.detail.seller) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        seller = cleanSeller(el.textContent);
        if (seller) break;
      }
    }

    // Features
    const features: string[] = [];
    for (const selector of AMAZON_SELECTORS.detail.features) {
      const items = safeQuerySelectorAll(doc, selector);
      for (const item of items) {
        if (isInsideExcludedDetailSubtree(item)) continue;
        const text = normalizeWhitespace(item.textContent);
        if (text && !features.includes(text)) {
          features.push(text);
        }
      }
      if (features.length > 0) break;
    }

    // Description
    let description: string | null = null;
    for (const selector of AMAZON_SELECTORS.detail.description) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        const text = normalizeWhitespace(el.textContent);
        if (text) {
          description = text;
          break;
        }
      }
    }
    if (!description && jsonLd.description) {
      description = jsonLd.description;
    }

    // High-res Image
    let imageUrl: string | null = null;
    for (const selector of AMAZON_SELECTORS.detail.images) {
      const img = safeQuerySelector(doc, selector);
      if (img && !isInsideExcludedDetailSubtree(img)) {
        imageUrl = extractBestImageUrl(img);
        if (imageUrl) break;
      }
    }
    if (!imageUrl && jsonLd.imageUrl) {
      imageUrl = jsonLd.imageUrl;
    }

    // BSR
    const bestSellersRank = extractDetailBsr(doc);

    // Prime
    const isPrime = Boolean(
      safeQuerySelector(
        doc,
        '#bbop-sbbop-container, #buybox i.a-icon-prime, #desktop_buybox i.a-icon-prime, #apex_desktop i.a-icon-prime, i.a-icon-prime, #mir-layout-DELIVERY_BLOCK [data-csa-c-delivery-price="FREE"]',
      ) ||
        (delivery && /\bFREE delivery\b/i.test(delivery)),
    );

    const url = resolveProductUrl(null, asin, activeUrl);

    const candidate: Partial<ScrapedAmazonProduct> = {
      asin,
      url,
      title,
      price,
      currency: currency ?? pageCurrency ?? 'USD',
      rating,
      reviewCount,
      imageUrl,
      isSponsored: false,
      isPrime,
      brand,
      availability,
      seller,
      description,
      features,
      source: 'detail',
    };

    if (listPrice !== undefined) candidate.listPrice = listPrice;
    if (discountPercentage !== undefined) {
      candidate.discountPercentage = discountPercentage;
    }
    if (dealBadge !== undefined) candidate.dealBadge = dealBadge;
    if (bestSellersRank !== undefined) {
      candidate.bestSellersRank = bestSellersRank;
    }
    if (pastMonthSales !== undefined) {
      candidate.pastMonthSales = pastMonthSales;
    }
    if (coupon !== undefined) candidate.coupon = coupon;
    if (delivery !== undefined) candidate.delivery = delivery;

    return validateAndNormalizeScrapedProduct(candidate, activeUrl);
  } catch (err) {
    console.warn('[PPHunt] Failed to parse product detail page:', err);
    return null;
  }
}

export const parseProductDetail = parseAmazonProductDetail;
