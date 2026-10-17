import { SELECTORS } from './selectors';
import { parsePrice, parsePriceFromElements } from '@/lib/utils/price-parser';
import { resolvePageCurrency } from '@/lib/utils/currency';
import { extractASIN, normalizeASIN, resolveProductUrl } from '@/lib/utils/amazon-url';
import {
  cleanAvailability,
  cleanBrand,
  cleanSeller,
  cleanText,
  extractBestImageUrl,
  extractBestSellersRank,
  extractCardByHeuristics,
  extractCardPricingAndDiscounts,
  extractCouponText,
  extractDealBadge,
  extractDeliveryInfo,
  extractElementText,
  extractPastMonthSales,
  extractProductBadge,
  isStrikeThroughOrReferencePriceElement,
  parseBestSellersRankText,
  parseRating,
  parseReviewCount,
  validateAndNormalizeScrapedProduct,
} from './field-parsers';
import type { ScrapedProduct } from '@/types/common';

interface DetailMetadataMap {
  asin: string | null;
  brand: string | null;
  seller: string | null;
  rating: number | null;
  reviewCount: number | null;
  price: number | null;
  currency: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  availability: string | null;
  bestSellersRank: string | null;
}

/**
 * Parses a single product from an Amazon product detail page (/dp/<ASIN>).
 * Uses 3-tier extraction (1: CSS selectors -> 2: tables/bullets/JSON-LD -> 3: structural heuristics)
 * with fault isolation so malformed sections never break extraction.
 */
export function parseProductDetail(
  document: Document,
  url?: string
): ScrapedProduct | null {
  try {
    const baseUrl =
      url ??
      document.location?.href ??
      (typeof window !== 'undefined' ? window.location?.href : undefined) ??
      'https://www.amazon.com';

    const metadata = extractDetailMetadata(document, baseUrl);
    const canonicalHref =
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ??
      null;

    const distinctAsinNodes = new Set(
      Array.from(document.querySelectorAll('[data-asin]:not([data-asin=""])'))
        .map((el) => normalizeASIN(el.getAttribute('data-asin')))
        .filter((a): a is string => Boolean(a))
    );
    const isMultiCardListingPage =
      !extractASIN(baseUrl) &&
      !(canonicalHref && extractASIN(canonicalHref)) &&
      !document.querySelector(
        '#productTitle, #dp, #ppd, #centerCol, #ASIN, input[name="ASIN"]'
      ) &&
      distinctAsinNodes.size > 1;

    if (isMultiCardListingPage) {
      return null;
    }

    const asin =
      extractASIN(baseUrl) ??
      (canonicalHref ? extractASIN(canonicalHref) : null) ??
      normalizeASIN(
        document.querySelector<HTMLInputElement>(
          '#ASIN, input[name="ASIN"], input[name="ASIN.0"]'
        )?.value
      ) ??
      normalizeASIN(
        document
          .querySelector(
            '#averageCustomerReviews[data-asin], [data-asin]:not([data-asin=""])'
          )
          ?.getAttribute('data-asin')
      ) ??
      metadata.asin;

    if (!asin) return null;

    // Title
    const titleEl = document.querySelector(SELECTORS.productDetail.title);
    let title =
      extractElementText(titleEl) ??
      metadata.title ??
      cleanText(
        document
          .querySelector('meta[name="title"]')
          ?.getAttribute('content')
          ?.replace(/^Amazon\.[a-z.]+:\s*/i, '')
      );

    // Price & Currency (check scoped Buy Box / Center Column first, strictly excluding strike-through list prices)
    let { value: price, currency } = extractDetailPrice(document, baseUrl);
    if (price === null && metadata.price !== null) {
      price = metadata.price;
      currency = metadata.currency ?? currency;
    }

    // Scoped detail pricing container for List Price, Discount %, Deal Badge, Coupon, Badge, Delivery, and Monthly Sales
    const detailScope =
      document.querySelector(
        '#centerCol, #dp-container, #ppd, #apex_desktop'
      ) ??
      document.body ??
      document.documentElement;

    const scopedPricing = detailScope
      ? extractCardPricingAndDiscounts(
          detailScope,
          baseUrl,
          SELECTORS.productDetail.scopedPrice,
          SELECTORS.productDetail.price
        )
      : {
          price: null,
          currency: null,
          listPrice: null,
          discountPercentage: null,
        };

    const listPrice = scopedPricing.listPrice;
    const discountPercentage = scopedPricing.discountPercentage;
    const dealBadge = detailScope ? extractDealBadge(detailScope) : null;
    const bestSellersRank =
      extractBestSellersRank(document) ?? metadata.bestSellersRank;
    const pastMonthSales = detailScope
      ? extractPastMonthSales(detailScope)
      : null;
    const coupon = detailScope ? extractCouponText(detailScope) : null;
    const badge = detailScope ? extractProductBadge(detailScope) : null;
    const delivery = detailScope ? extractDeliveryInfo(detailScope) : null;

    // Rating
    const ratingEl = document.querySelector(SELECTORS.productDetail.rating);
    const ratingTextEl = document.querySelector(
      SELECTORS.productDetail.ratingText
    );
    let rating =
      parseRating(ratingEl?.getAttribute('title')) ??
      parseRating(ratingEl?.getAttribute('aria-label')) ??
      parseRating(ratingTextEl?.textContent) ??
      parseRating(ratingEl?.textContent) ??
      metadata.rating;

    // Review Count
    const reviewCountEl = document.querySelector(
      SELECTORS.productDetail.reviewCount
    );
    let reviewCount =
      parseReviewCount(reviewCountEl?.getAttribute('aria-label')) ??
      parseReviewCount(reviewCountEl?.textContent) ??
      metadata.reviewCount;

    // Availability
    const availabilityEl = document.querySelector(
      SELECTORS.productDetail.availability
    );
    let availability =
      cleanAvailability(extractElementText(availabilityEl)) ??
      metadata.availability;

    // Brand
    const brandEl = document.querySelector(SELECTORS.productDetail.brand);
    const brandMetaEl = document.querySelector(
      SELECTORS.productDetail.brandMeta
    );
    let brand =
      cleanBrand(extractElementText(brandEl)) ??
      metadata.brand ??
      cleanBrand(brandMetaEl?.getAttribute('content'));

    // Seller
    let seller = extractDetailSeller(document) ?? metadata.seller;

    // Hero Image (with gallery fallback)
    const heroImageEl =
      document.querySelector<HTMLImageElement>(
        SELECTORS.productDetail.heroImage
      ) ??
      document.querySelector<HTMLImageElement>(
        SELECTORS.productDetail.imageGallery
      );
    let imageUrl =
      extractBestImageUrl(heroImageEl, baseUrl) ?? metadata.imageUrl;

    // Features
    const featureEls = document.querySelectorAll(
      SELECTORS.productDetail.features
    );
    const features = Array.from(featureEls)
      .map((el) => extractElementText(el))
      .filter(
        (t): t is string =>
          !!t &&
          t.length > 0 &&
          !/^›?\s*See more product details$/i.test(t)
      );

    // Description
    const descEl =
      document.querySelector(SELECTORS.productDetail.description) ??
      document.querySelector(SELECTORS.productDetail.descriptionAlt);
    const description =
      extractElementText(descEl) ?? metadata.description ?? null;

    // Prime & Sponsored
    let isPrime = !!document.querySelector(SELECTORS.productDetail.prime);
    const isSponsored =
      baseUrl.includes('/sspa/click') || baseUrl.includes('sp_atk=');

    // Tier 3: Structural heuristic fallback on detail container if core fields missed
    if (!title || price === null || rating === null || !imageUrl) {
      const root = document.body ?? document.documentElement;
      if (root) {
        const heuristic = extractCardByHeuristics(root, asin, baseUrl);
        title = title ?? heuristic.title ?? null;
        if (price === null && heuristic.price != null) {
          price = heuristic.price;
          currency = heuristic.currency ?? currency;
        }
        rating = rating ?? heuristic.rating ?? null;
        reviewCount = reviewCount ?? heuristic.reviewCount ?? null;
        imageUrl = imageUrl ?? heuristic.imageUrl ?? null;
        brand = brand ?? heuristic.brand ?? null;
        availability = availability ?? heuristic.availability ?? null;
        seller = seller ?? heuristic.seller ?? null;
        isPrime = isPrime || Boolean(heuristic.isPrime);
      }
    }

    return validateAndNormalizeScrapedProduct(
      {
        asin,
        url: resolveProductUrl(canonicalHref ?? baseUrl, asin, baseUrl),
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
        description,
        features,
        source: 'detail',
      },
      baseUrl
    );
  } catch (err) {
    console.warn('[PPHunt] Isolated product detail parse error:', err);
    return null;
  }
}

function extractDetailPrice(
  document: Document,
  baseUrl: string
): { value: number | null; currency: string | null } {
  // C-1: resolve the page's ISO currency once per invocation — parsePrice's
  // fallback parameter is an ISO code, never a URL.
  const pageCurrency = resolvePageCurrency(baseUrl);
  // 1. Check scoped primary price selectors first (avoids picking up carousel ads or struck-through list prices)
  const scopedCandidates = document.querySelectorAll(
    SELECTORS.productDetail.scopedPrice
  );
  for (const el of scopedCandidates) {
    if (isStrikeThroughOrReferencePriceElement(el)) continue;
    const parsed = parsePrice(el.textContent, pageCurrency);
    if (parsed.value !== null) return parsed;
  }

  // 2. Check general price selector (excluding carousels and struck-through list prices)
  const generalCandidates = document.querySelectorAll(
    SELECTORS.productDetail.price
  );
  for (const el of generalCandidates) {
    if (
      el.closest('#sp_detail_carousel, [id*="carousel"], [class*="carousel"]')
    ) {
      continue;
    }
    if (isStrikeThroughOrReferencePriceElement(el)) continue;
    const parsed = parsePrice(el.textContent, pageCurrency);
    if (parsed.value !== null) return parsed;
  }

  // 3. Fallback to split whole/fraction/symbol elements
  const wholeEl = document.querySelector(SELECTORS.productDetail.priceWhole);
  if (wholeEl && !isStrikeThroughOrReferencePriceElement(wholeEl)) {
    const splitParsed = parsePriceFromElements(
      wholeEl,
      document.querySelector(SELECTORS.productDetail.priceFraction),
      document.querySelector(SELECTORS.productDetail.priceSymbol),
      pageCurrency
    );
    if (splitParsed.value !== null) return splitParsed;
  }

  // 4. Hidden twister/attach price inputs on detail pages
  const hiddenPriceInput = document.querySelector<HTMLInputElement>(
    'input#attach-base-product-price, input#twister-plus-price-data-price'
  );
  if (hiddenPriceInput?.value) {
    const parsed = parsePrice(hiddenPriceInput.value, pageCurrency);
    if (parsed.value !== null) return parsed;
  }

  return { value: null, currency: null };
}

function extractDetailSeller(document: Document): string | null {
  // 1. Direct seller trigger link (#sellerProfileTriggerId)
  const primarySellerEl = document.querySelector(SELECTORS.productDetail.seller);
  const primarySeller = cleanSeller(extractElementText(primarySellerEl));
  if (primarySeller) return primarySeller;

  // 2. Tabular buybox rows (match "Sold by" / "Verkauf durch" / "Vendu par")
  const buyboxRows = document.querySelectorAll(
    '#tabular-buybox tr, #tabular-buybox .tabular-buybox-container'
  );
  for (const row of buyboxRows) {
    const rowText = extractElementText(row);
    if (
      rowText &&
      /\b(sold by|ships from and sold by|verkauf durch|vendu par|vendido por)\b/i.test(
        rowText
      )
    ) {
      const valueEl =
        row.querySelector('.tabular-buybox-text a') ??
        row.querySelector('.tabular-buybox-text');
      const cleaned = cleanSeller(extractElementText(valueEl ?? row));
      if (cleaned) return cleaned;
    }
  }

  // 3. Fallback seller selectors
  const fallbackEl = document.querySelector(
    SELECTORS.productDetail.sellerFallback
  );
  return cleanSeller(extractElementText(fallbackEl));
}

/**
 * Extracts structured fallback metadata from product details tables, bullet lists,
 * and embedded JSON-LD schema.org Product blocks.
 */
function extractDetailMetadata(
  document: Document,
  baseUrl: string
): DetailMetadataMap {
  // C-1: ISO currency fallback for JSON-LD prices — never the page URL.
  const pageCurrency = resolvePageCurrency(baseUrl);
  const result: DetailMetadataMap = {
    asin: null,
    brand: null,
    seller: null,
    rating: null,
    reviewCount: null,
    price: null,
    currency: null,
    title: null,
    description: null,
    imageUrl: null,
    availability: null,
    bestSellersRank: null,
  };

  try {
    // 1. Parse table rows (#productDetails_techSpec_section_1, #productOverview_feature_div, etc.)
    const rows = document.querySelectorAll(
      SELECTORS.productDetail.detailsTable
    );
    for (const row of rows) {
      const cells = row.querySelectorAll('th, td');
      if (cells.length < 2) continue;
      const key = extractElementText(cells[0])
        ?.toLowerCase()
        .replace(/[:\u200e\u200f]/g, '')
        .trim();
      const valText = extractElementText(cells[1]);
      if (!key || !valText) continue;

      if (key === 'asin' && !result.asin) {
        result.asin = normalizeASIN(valText);
      } else if (
        (key === 'brand' || key === 'brand name' || key === 'manufacturer') &&
        !result.brand
      ) {
        result.brand = cleanBrand(valText);
      } else if (key.includes('customer reviews')) {
        if (result.rating === null) {
          result.rating = parseRating(valText);
        }
        if (result.reviewCount === null) {
          result.reviewCount = parseReviewCount(valText);
        }
      } else if (
        (key.includes('best sellers rank') ||
          key.includes('bestseller-rang') ||
          key.includes('meilleures ventes') ||
          key.includes('más vendidos')) &&
        !result.bestSellersRank
      ) {
        result.bestSellersRank = parseBestSellersRankText(valText);
      }
    }

    // 2. Parse detail bullets (#detailBullets_feature_div .a-list-item)
    const bullets = document.querySelectorAll(
      SELECTORS.productDetail.detailsTableAlt
    );
    for (const item of bullets) {
      const text = extractElementText(item);
      if (!text) continue;
      const parts = text.split(/\s*[:\n]\s*/);
      if (parts.length < 2) continue;
      const rawKey = parts[0];
      if (!rawKey) continue;
      const key = rawKey
        .toLowerCase()
        .replace(/[\u200e\u200f]/g, '')
        .trim();
      const val = parts.slice(1).join(' ').trim();

      if (key === 'asin' && !result.asin) {
        result.asin = normalizeASIN(val);
      } else if (
        (key === 'brand' || key === 'manufacturer') &&
        !result.brand
      ) {
        result.brand = cleanBrand(val);
      } else if (
        (key.includes('best sellers rank') ||
          key.includes('bestseller-rang') ||
          key.includes('meilleures ventes') ||
          key.includes('más vendidos')) &&
        !result.bestSellersRank
      ) {
        result.bestSellersRank = parseBestSellersRankText(val);
      }
    }

    // 3. Parse JSON-LD schema.org Product if present
    const ldScripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of ldScripts) {
      const raw = script.textContent?.trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const type = String(item['@type'] ?? '').toLowerCase();
          if (!type.includes('product')) continue;

          if (!result.asin && typeof item.sku === 'string') {
            result.asin = normalizeASIN(item.sku);
          }
          if (!result.title && typeof item.name === 'string') {
            result.title = cleanText(item.name);
          }
          if (!result.description && typeof item.description === 'string') {
            result.description = cleanText(item.description);
          }
          if (!result.imageUrl) {
            const img = Array.isArray(item.image) ? item.image[0] : item.image;
            if (typeof img === 'string') {
              result.imageUrl = img;
            }
          }
          if (!result.brand && item.brand) {
            const brandRaw =
              typeof item.brand === 'string' ? item.brand : item.brand?.name;
            result.brand = cleanBrand(brandRaw);
          }
          if (item.aggregateRating) {
            if (
              result.rating === null &&
              item.aggregateRating.ratingValue != null
            ) {
              result.rating = parseRating(
                String(item.aggregateRating.ratingValue)
              );
            }
            if (
              result.reviewCount === null &&
              item.aggregateRating.reviewCount != null
            ) {
              result.reviewCount = parseReviewCount(
                String(item.aggregateRating.reviewCount)
              );
            }
          }
          const offer = Array.isArray(item.offers)
            ? item.offers[0]
            : item.offers;
          if (offer && typeof offer === 'object') {
            if (result.price === null && offer.price != null) {
              const p = parsePrice(
                `${offer.priceCurrency ?? ''} ${offer.price}`,
                pageCurrency
              );
              result.price = p.value;
              result.currency =
                typeof offer.priceCurrency === 'string'
                  ? offer.priceCurrency.toUpperCase()
                  : p.currency;
            }
            if (!result.seller && offer.seller?.name) {
              result.seller = cleanSeller(String(offer.seller.name));
            }
            if (!result.availability && typeof offer.availability === 'string') {
              if (/InStock/i.test(offer.availability)) {
                result.availability = 'In Stock';
              } else if (/OutOfStock/i.test(offer.availability)) {
                result.availability = 'Out of Stock';
              }
            }
          }
        }
      } catch {
        // Ignore malformed JSON-LD blocks
      }
    }
  } catch {
    // Fault isolation for metadata extraction
  }

  return result;
}
