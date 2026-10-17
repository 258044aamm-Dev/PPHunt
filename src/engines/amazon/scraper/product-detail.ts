import type { ScrapedAmazonProduct } from '../types';
import {
  buildCanonicalAmazonProductUrl,
  extractAsinFromUrl,
  isAmazonUrl,
  normalizeAsin,
} from '../utils/amazon-url';
import { resolveAmazonCurrency } from '../utils/currency';
import type { AmazonDriftTelemetry } from './drift-telemetry';
import {
  type CardFieldTierMap,
  cleanAmazonBrandText,
  extractCardBoughtInPastMonth,
  extractCardBsr,
  extractCardCouponText,
  extractCardDealBadge,
  extractCardDiscountPercentage,
  extractCardIsPrime,
  extractCardListPrice,
  extractCardPriceWithTier,
  extractCardRatingWithTier,
  extractCardReviewCountWithTier,
  extractCardStatusBadge,
  extractImageWithTier,
  extractTier1LdJsonProduct,
} from './field-parsers';
import {
  AMAZON_SELECTORS,
  queryFirstMatching,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

function normalizeWhitespace(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInsideExcludedAdSubtree(el: Element): boolean {
  const excludedSelector = AMAZON_SELECTORS.detail.excludedSubtrees.join(', ');
  try {
    return el.closest(excludedSelector) !== null;
  } catch {
    return false;
  }
}

function resolveDetailSourceUrl(
  doc?: Document | null,
  explicitUrl?: string,
): string {
  if (explicitUrl && isAmazonUrl(explicitUrl)) {
    return explicitUrl;
  }
  const canonicalLink = doc
    ? safeQuerySelector<HTMLLinkElement>(doc, 'link[rel="canonical"]')
    : null;
  const canonicalHref = canonicalLink?.getAttribute('href');
  if (canonicalHref && isAmazonUrl(canonicalHref)) {
    return canonicalHref;
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
  return explicitUrl || 'https://www.amazon.com';
}

function extractDetailAsin(
  doc: Document,
  sourceUrl: string,
  ldJsonAsin?: string,
): { asin: string | null; tier: 'tier1_json' | 'tier2_semantic' | 'tier3_structural' | 'missing' } {
  // 1. Canonical URL or active source URL `/dp/<ASIN>`
  const urlAsin = extractAsinFromUrl(sourceUrl);
  if (urlAsin) {
    return { asin: urlAsin, tier: 'tier2_semantic' };
  }

  const canonicalHref = safeQuerySelector<HTMLLinkElement>(
    doc,
    'link[rel="canonical"]',
  )?.getAttribute('href');
  const canonicalAsin = extractAsinFromUrl(canonicalHref);
  if (canonicalAsin) {
    return { asin: canonicalAsin, tier: 'tier2_semantic' };
  }

  // 2. Hidden input#ASIN or [data-asin] on #dp / #averageCustomerReviews
  const asinInput = safeQuerySelector<HTMLInputElement>(
    doc,
    'input#ASIN, input[name="ASIN"], input[name="ASIN.0"]',
  );
  const inputAsin = normalizeAsin(asinInput?.value ?? asinInput?.getAttribute('value'));
  if (inputAsin) {
    return { asin: inputAsin, tier: 'tier2_semantic' };
  }

  const dpAsinNode = safeQuerySelector(
    doc,
    '#dp[data-asin], #dp-container[data-asin], #averageCustomerReviews[data-asin], [data- detail-asin]',
  );
  const dpAsin = normalizeAsin(dpAsinNode?.getAttribute('data-asin'));
  if (dpAsin) {
    return { asin: dpAsin, tier: 'tier2_semantic' };
  }

  // 3. Tier 1 JSON-LD
  if (ldJsonAsin) {
    const normalized = normalizeAsin(ldJsonAsin);
    if (normalized) {
      return { asin: normalized, tier: 'tier1_json' };
    }
  }

  return { asin: null, tier: 'missing' };
}

/**
 * Extracts a single product from an Amazon Product Detail Page (PDP).
 * Prioritizes buybox/corePriceDisplay containers over peripheral ad carousels.
 */
export function parseAmazonProductDetail(
  doc?: Document | null,
  explicitSourceUrl?: string,
  telemetry?: AmazonDriftTelemetry,
): ScrapedAmazonProduct | null {
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);
  if (!activeDoc) return null;

  const sourceUrl = resolveDetailSourceUrl(activeDoc, explicitSourceUrl);
  const ldJson = extractTier1LdJsonProduct(activeDoc, sourceUrl);
  const fieldTiers: CardFieldTierMap = {};

  const asinResult = extractDetailAsin(activeDoc, sourceUrl, ldJson?.asin);
  fieldTiers.asin = asinResult.tier;
  const asin = asinResult.value;
  if (!asin) {
    telemetry?.recordCard(fieldTiers, false);
    return null;
  }

  // Title extraction (DOM `#productTitle` -> JSON-LD `name`)
  let title = '';
  for (const selector of AMAZON_SELECTORS.detail.title) {
    const el = safeQuerySelector(activeDoc, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text) {
      title = text;
      fieldTiers.title = 'tier2_semantic';
      break;
    }
  }
  if (!title && ldJson?.title) {
    title = ldJson.title;
    fieldTiers.title = 'tier1_json';
  }
  if (!title) {
    telemetry?.recordCard(fieldTiers, false);
    return null;
  }

  // Price extraction scoped to main buybox / corePriceDisplay first (avoiding ad carousels!)
  let price: number | null = null;
  let currency = resolveAmazonCurrency(undefined, sourceUrl);
  let listPrice: number | null = null;
  let discountPercentage: number | null = null;
  fieldTiers.price = 'missing';

  for (const scopeSelector of AMAZON_SELECTORS.detail.buyboxScopes) {
    const scopeEl = safeQuerySelector(activeDoc, scopeSelector);
    if (!scopeEl || isInsideExcludedAdSubtree(scopeEl)) continue;

    const scopedPrice = extractCardPriceWithTier(scopeEl, sourceUrl);
    if (scopedPrice.value.price !== null) {
      price = scopedPrice.value.price;
      currency = scopedPrice.value.currency;
      fieldTiers.price = scopedPrice.tier;
      listPrice = extractCardListPrice(scopeEl, price, sourceUrl);
      discountPercentage = extractCardDiscountPercentage(
        scopeEl,
        price,
        listPrice,
      );
      break;
    }
  }

  if (price === null && ldJson?.price !== undefined && ldJson.price !== null) {
    price = ldJson.price;
    currency = ldJson.currency || currency;
    fieldTiers.price = 'tier1_json';
  }

  // Fallback to main root container (`#centerCol` / `#ppd` / `#dp-container`) while skipping excluded ad carousels
  if (price === null) {
    const { element: rootContainer } = queryFirstMatching(
      activeDoc,
      AMAZON_SELECTORS.detail.rootContainers,
    );
    const searchRoot = rootContainer ?? activeDoc.body ?? activeDoc.documentElement;
    if (searchRoot) {
      for (const selector of AMAZON_SELECTORS.cardFields.sellingPrice) {
        const candidates = safeQuerySelectorAll(searchRoot, selector);
        for (const el of candidates) {
          if (isInsideExcludedAdSubtree(el)) continue;
          if (el.closest('[data-a-strike="true"], s, del')) continue;
          const scopedPrice = extractCardPriceWithTier(
            el.parentElement ?? el,
            sourceUrl,
          );
          if (scopedPrice.value.price !== null) {
            price = scopedPrice.value.price;
            currency = scopedPrice.value.currency;
            fieldTiers.price = scopedPrice.tier;
            break;
          }
        }
        if (price !== null) break;
      }
    }
  }

  // Rating & Review Count
  const reviewRoot =
    safeQuerySelector(
      activeDoc,
      '#averageCustomerReviews, #acrPopover, #reviewsMedley',
    ) ?? activeDoc.documentElement;
  const ratingResult = extractCardRatingWithTier(reviewRoot);
  const rating = ratingResult.value ?? ldJson?.rating ?? null;
  fieldTiers.rating =
    ratingResult.value !== null
      ? ratingResult.tier
      : ldJson?.rating !== undefined && ldJson.rating !== null
        ? 'tier1_json'
        : 'missing';

  const reviewCountResult = extractCardReviewCountWithTier(
    safeQuerySelector(activeDoc, '#averageCustomerReviews, #centerCol, #ppd') ??
      activeDoc.documentElement,
  );
  const reviewCount = reviewCountResult.value ?? ldJson?.reviewCount ?? null;
  fieldTiers.reviewCount =
    reviewCountResult.value !== null
      ? reviewCountResult.tier
      : ldJson?.reviewCount !== undefined && ldJson.reviewCount !== null
        ? 'tier1_json'
        : 'missing';

  // High-resolution Image URL
  const imageScope =
    safeQuerySelector(
      activeDoc,
      '#imageBlock, #imgTagWrapperId, #leftCol, #dp-container',
    ) ?? activeDoc.documentElement;
  const imageResult = extractImageWithTier(imageScope);
  const imageUrl = imageResult.value || ldJson?.imageUrl || '';
  fieldTiers.imageUrl = imageResult.value
    ? imageResult.tier
    : ldJson?.imageUrl
      ? 'tier1_json'
      : 'missing';

  // Brand
  let brand: string | undefined;
  for (const selector of AMAZON_SELECTORS.detail.brand) {
    const el = safeQuerySelector(activeDoc, selector);
    const cleaned = cleanAmazonBrandText(el?.textContent);
    if (cleaned) {
      brand = cleaned;
      break;
    }
  }
  if (!brand && ldJson?.brand) {
    brand = cleanAmazonBrandText(ldJson.brand);
  }

  // BSR, Badges, Coupon, Bought in past month
  const bsr = extractCardBsr(activeDoc.documentElement);
  const centerScope =
    safeQuerySelector(activeDoc, '#centerCol, #ppd, #dp-container') ??
    activeDoc.documentElement;
  const dealBadge = extractCardDealBadge(centerScope);
  const statusBadge = extractCardStatusBadge(centerScope);
  const couponText = extractCardCouponText(centerScope);
  const boughtInPastMonth = extractCardBoughtInPastMonth(centerScope);
  const isPrime = extractCardIsPrime(
    safeQuerySelector(activeDoc, '#buybox, #apex_desktop, #centerCol, #ppd') ??
      activeDoc.documentElement,
  );

  // Availability
  let availability: string | undefined;
  for (const selector of AMAZON_SELECTORS.detail.availability) {
    const el = safeQuerySelector(activeDoc, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text) {
      availability = text;
      break;
    }
  }
  if (!availability && ldJson?.availability) {
    availability = ldJson.availability;
  }

  // Delivery info
  let deliveryInfo: string | undefined;
  for (const selector of AMAZON_SELECTORS.detail.delivery) {
    const el = safeQuerySelector(activeDoc, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text) {
      deliveryInfo = text;
      break;
    }
  }

  // Seller
  let seller: string | undefined;
  for (const selector of AMAZON_SELECTORS.detail.seller) {
    const el = safeQuerySelector(activeDoc, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text) {
      seller = text
        .replace(/^Ships from and sold by\s+/i, '')
        .replace(/^Sold by\s+/i, '')
        .replace(/\s+and\s+Fulfilled by Amazon\.?$/i, '')
        .trim();
      if (seller) break;
    }
  }

  // Description
  let description: string | undefined;
  for (const selector of AMAZON_SELECTORS.detail.description) {
    const el = safeQuerySelector(activeDoc, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text && text.length >= 10) {
      description = text.slice(0, 2000);
      break;
    }
  }
  if (!description && ldJson?.description) {
    description = ldJson.description.slice(0, 2000);
  }

  // Bullet Features
  const features: string[] = [];
  for (const selector of AMAZON_SELECTORS.detail.features) {
    const items = safeQuerySelectorAll(activeDoc, selector);
    for (const item of items) {
      const bullet = normalizeWhitespace(item.textContent);
      if (
        bullet &&
        bullet.length >= 3 &&
        !/^make sure this fits/i.test(bullet) &&
        !features.includes(bullet)
      ) {
        features.push(bullet);
      }
    }
    if (features.length > 0) break;
  }

  telemetry?.recordCard(fieldTiers, true);

  const productUrl = buildCanonicalAmazonProductUrl(asin, sourceUrl);

  const scraped: ScrapedAmazonProduct = {
    asin,
    title,
    price,
    currency,
    rating,
    reviewCount,
    isPrime,
    isSponsored: false,
    imageUrl,
    productUrl,
    sourceUrl: isAmazonUrl(sourceUrl) ? sourceUrl : productUrl,
    pageType: 'detail',
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
  if (availability !== undefined) scraped.availability = availability;
  if (seller !== undefined) scraped.seller = seller;
  if (description !== undefined) scraped.description = description;
  if (features.length > 0) scraped.features = features;

  return scraped;
}

export const parseProductDetail = parseAmazonProductDetail;
