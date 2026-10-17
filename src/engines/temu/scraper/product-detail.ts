import type { TemuScrapedProduct } from '../types';
import { parseTemuPrice } from '../utils/price-parser';
import {
  extractGoodsId,
  normalizeGoodsId,
  resolveTemuProductUrl,
} from '../utils/temu-url';
import {
  cleanTemuText,
  extractTemuBestImageUrl,
  extractTemuCardMetadata,
  extractTemuElementText,
  extractTemuPricing,
  extractTemuRatingAndReviews,
  extractTemuSalesVolume,
  parseTemuRating,
  parseTemuReviewCount,
  validateAndNormalizeTemuScrapedProduct,
} from './field-parsers';
import { TEMU_SELECTORS } from './selectors';

interface TemuJsonLdMetadata {
  goodsId: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  brand: string | null;
  seller: string | null;
  availability: string | null;
  categoryBreadcrumb: string | null;
}

/**
 * Parses a single product from a Temu Product Detail Page (`/*-g-<goodsId>.html` or `/goods.html?goods_id=<goodsId>`).
 *
 * Uses a 4-layer extraction pipeline:
 * 1. Structured `application/ld+json` (`@type: "Product"`, `"BreadcrumbList"`)
 * 2. Scoped PDP DOM landmarks (`#rightContent`, `#leftContent`, `#goods_price`, `#reviewContent`, `#goodsDetail`, `h1[aria-label]`)
 * 3. Structural fallback heuristics
 * 4. Strict Zod validation & non-fabrication (`null` when absent)
 */
export function parseTemuProductDetail(
  document: Document,
  url?: string
): TemuScrapedProduct | null {
  try {
    const baseUrl =
      url ??
      document.location?.href ??
      (typeof window !== 'undefined' ? window.location?.href : undefined) ??
      'https://www.temu.com';

    const ldMeta = extractTemuJsonLdMetadata(document);
    const canonicalHref =
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ??
      null;

    // Resolve authoritative goodsId
    const goodsId =
      extractGoodsId(baseUrl) ??
      extractGoodsId(canonicalHref) ??
      ldMeta.goodsId ??
      extractGoodsIdFromPdpDom(document);

    if (!goodsId) return null;

    const pdpScope =
      document.querySelector('#rightContent') ??
      document.querySelector('#goodsDetail') ??
      document.body ??
      document.documentElement;

    // 1. Title (`h1[aria-label]` -> `h1` -> JSON-LD `name` -> `meta[property="og:title"]`)
    const titleEl = document.querySelector(TEMU_SELECTORS.productDetail.title);
    const title =
      cleanTemuText(titleEl?.getAttribute('aria-label')) ??
      extractTemuElementText(titleEl) ??
      ldMeta.title ??
      cleanTemuText(
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute('content')
      );

    // 2. Price, List Price, Discount Percentage (scoped to `#goods_price` or `#rightContent` first, then JSON-LD)
    const priceScope =
      document.querySelector(TEMU_SELECTORS.productDetail.priceContainer) ??
      pdpScope;

    const domPricing = priceScope
      ? extractTemuPricing(priceScope, ldMeta.currency ?? 'USD')
      : {
          price: null,
          currency: null,
          listPrice: null,
          discountPercentage: null,
        };

    const price = domPricing.price ?? ldMeta.price;
    const currency =
      domPricing.currency ??
      ldMeta.currency ??
      (price !== null || domPricing.listPrice !== null ? 'USD' : null);
    const listPrice = domPricing.listPrice;
    const discountPercentage = domPricing.discountPercentage;

    // 3. Rating & Review Count (check `#reviewContent` + `#rightContent` + JSON-LD `aggregateRating`)
    const reviewScope =
      document.querySelector('#reviewContent') ?? pdpScope ?? document.body;
    const domReviews = reviewScope
      ? extractTemuRatingAndReviews(reviewScope)
      : { rating: null, reviewCount: null };

    const rating = domReviews.rating ?? ldMeta.rating;
    const reviewCount = domReviews.reviewCount ?? ldMeta.reviewCount;

    // 4. Sales Volume (`10K+ sold`)
    const pastMonthSales = pdpScope ? extractTemuSalesVolume(pdpScope) : null;

    // 5. Primary Hero Image (`#leftContent img[data-js-main-img="true"]` -> JSON-LD `image[0]` -> `og:image`)
    const heroImgEl = document.querySelector<HTMLImageElement>(
      TEMU_SELECTORS.productDetail.heroImage
    );
    const imageUrl =
      extractTemuBestImageUrl(heroImgEl, baseUrl) ??
      ldMeta.imageUrl ??
      cleanTemuText(
        document
          .querySelector('meta[property="og:image"]')
          ?.getAttribute('content')
      );

    // 6. Metadata (Seller/Mall, Brand, Availability, Deal Badge, Badge, Coupon, Delivery)
    const meta = pdpScope
      ? extractTemuCardMetadata(pdpScope)
      : {
          brand: null,
          seller: null,
          availability: null,
          dealBadge: null,
          badge: null,
          coupon: null,
          delivery: null,
          bestSellersRank: null,
          isSponsored: false,
          isPrime: false,
        };

    const seller = meta.seller ?? ldMeta.seller;
    const brand = meta.brand ?? ldMeta.brand;
    const availability = meta.availability ?? ldMeta.availability;

    // 7. Features / Specifications & Description
    const features = extractTemuPdpFeatures(document);
    const description =
      ldMeta.description ??
      cleanTemuText(
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content')
      );

    return validateAndNormalizeTemuScrapedProduct(
      {
        goodsId,
        asin: goodsId,
        url: resolveTemuProductUrl(canonicalHref ?? baseUrl, goodsId, baseUrl),
        title,
        price,
        listPrice,
        discountPercentage,
        dealBadge: meta.dealBadge,
        currency,
        rating,
        reviewCount,
        bestSellersRank: meta.bestSellersRank,
        pastMonthSales,
        coupon: meta.coupon,
        badge: meta.badge,
        delivery: meta.delivery,
        imageUrl,
        isSponsored: meta.isSponsored,
        isPrime: meta.isPrime,
        brand,
        availability,
        seller,
        description,
        features,
        source: 'detail',
      },
      baseUrl,
      'detail'
    );
  } catch (err) {
    console.warn('[PPHunt:Temu] Isolated product detail parse error:', err);
    return null;
  }
}

function extractGoodsIdFromPdpDom(document: Document): string | null {
  const scripts = Array.from(document.querySelectorAll('script:not([src])'));
  for (const script of scripts) {
    const text = script.textContent ?? '';
    const match =
      text.match(/"goods_id"\s*:\s*"?(\d{6,22})"?/) ??
      text.match(/"goodsId"\s*:\s*"?(\d{6,22})"?/);
    if (match?.[1]) {
      return normalizeGoodsId(match[1]);
    }
  }
  return null;
}

function extractTemuPdpFeatures(document: Document): string[] {
  const features: string[] = [];
  const seen = new Set<string>();
  const scope =
    document.querySelector('#goodsDetail, #leftContent, #rightContent') ??
    document;

  const items = Array.from(scope.querySelectorAll('li, tr'));
  for (const item of items) {
    // Skip breadcrumb items
    if (item.closest('nav, ol')) continue;
    const text = extractTemuElementText(item);
    if (!text || text.length < 4 || text.length > 200) continue;
    if (!seen.has(text)) {
      seen.add(text);
      features.push(text);
      if (features.length >= 15) break;
    }
  }

  return features;
}

/**
 * Extracts structured metadata from embedded `<script type="application/ld+json">` blocks
 * on Temu Product Detail Pages (`@type: "Product"` and `@type: "BreadcrumbList"`).
 */
function extractTemuJsonLdMetadata(document: Document): TemuJsonLdMetadata {
  const result: TemuJsonLdMetadata = {
    goodsId: null,
    title: null,
    description: null,
    imageUrl: null,
    price: null,
    currency: null,
    rating: null,
    reviewCount: null,
    brand: null,
    seller: null,
    availability: null,
    categoryBreadcrumb: null,
  };

  try {
    const ldScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
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

          if (type === 'breadcrumblist' && Array.isArray(item.itemListElement)) {
            const crumbs = item.itemListElement
              .map((el: { name?: string; item?: { name?: string } }) =>
                cleanTemuText(el?.name ?? el?.item?.name)
              )
              .filter((c: string | null): c is string => Boolean(c));
            if (crumbs.length > 0 && !result.categoryBreadcrumb) {
              result.categoryBreadcrumb = crumbs.join(' > ');
            }
          }

          if (!type.includes('product')) continue;

          if (!result.goodsId) {
            result.goodsId =
              normalizeGoodsId(item.sku) ??
              normalizeGoodsId(item.productID) ??
              extractGoodsId(item.url);
          }

          if (!result.title && typeof item.name === 'string') {
            result.title = cleanTemuText(item.name);
          }

          if (!result.description && typeof item.description === 'string') {
            result.description = cleanTemuText(item.description);
          }

          if (!result.imageUrl && item.image) {
            const firstImg = Array.isArray(item.image)
              ? item.image[0]
              : item.image;
            if (typeof firstImg === 'string') {
              result.imageUrl = firstImg;
            } else if (
              firstImg &&
              typeof firstImg === 'object' &&
              typeof firstImg.contentUrl === 'string'
            ) {
              result.imageUrl = firstImg.contentUrl;
            }
          }

          if (!result.brand && item.brand) {
            const rawBrand =
              typeof item.brand === 'string' ? item.brand : item.brand?.name;
            result.brand = cleanTemuText(rawBrand);
          }

          if (item.aggregateRating && typeof item.aggregateRating === 'object') {
            if (
              result.rating === null &&
              item.aggregateRating.ratingValue != null
            ) {
              result.rating = parseTemuRating(
                String(item.aggregateRating.ratingValue)
              );
            }
            if (
              result.reviewCount === null &&
              (item.aggregateRating.reviewCount != null ||
                item.aggregateRating.ratingCount != null)
            ) {
              result.reviewCount = parseTemuReviewCount(
                String(
                  item.aggregateRating.reviewCount ??
                    item.aggregateRating.ratingCount
                )
              );
            }
          }

          const offer = Array.isArray(item.offers)
            ? item.offers[0]
            : item.offers;
          if (offer && typeof offer === 'object') {
            if (result.price === null && offer.price != null) {
              const p = parseTemuPrice(
                `${offer.priceCurrency ?? 'USD'} ${offer.price}`,
                'USD'
              );
              result.price = p.value;
              result.currency =
                typeof offer.priceCurrency === 'string'
                  ? offer.priceCurrency.toUpperCase()
                  : p.currency;
            }
            if (!result.seller && offer.seller?.name) {
              result.seller = cleanTemuText(String(offer.seller.name));
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
        // Ignore malformed JSON-LD block
      }
    }
  } catch {
    // Fault isolation
  }

  return result;
}
