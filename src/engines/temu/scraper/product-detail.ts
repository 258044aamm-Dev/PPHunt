import type { TemuScrapedProduct } from '../types';
import { parseTemuPrice } from '../utils/price-parser';
import {
  extractGoodsId,
  normalizeGoodsId,
  resolveTemuProductUrl,
} from '../utils/temu-url';
import {
  applyValidationResults,
  type FieldDiagnosticsCollector,
  type FieldExtractionSource,
  type TemuDiagnosticField,
} from './extraction-diagnostics';
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
  /**
   * SAD-360: at least one `application/ld+json` block failed to parse, so a
   * field with no value cannot be attributed to "absent from the page".
   */
  malformedJsonLd: boolean;
  /**
   * SAD-360: JSON-LD carried a property whose value could not be used, with
   * the static reason. Consumed at the merge point, never written directly
   * (a later DOM write would otherwise clobber it).
   */
  rejections: Map<TemuDiagnosticField, string>;
}

/** Fields that a JSON-LD `Product` block can legitimately supply. */
const JSON_LD_FIELDS = new Set<TemuDiagnosticField>([
  'title',
  'description',
  'imageUrl',
  'price',
  'currency',
  'rating',
  'reviewCount',
  'brand',
  'seller',
  'availability',
]);

/**
 * SAD-360: a later source in the merge chain produced the final value.
 * A rejected DOM candidate downgrades the outcome to PARTIAL; a clean
 * fallback (the earlier source simply had nothing) stays EXTRACTED.
 */
function recordFallback(
  diag: FieldDiagnosticsCollector | undefined,
  field: TemuDiagnosticField,
  options: { source: FieldExtractionSource; selector?: string },
  rescueReason: string
): void {
  if (!diag) return;
  try {
    if (diag.entries().get(field)?.status === 'PARSE_FAILED') {
      diag.rescued(field, rescueReason, options);
    } else {
      diag.extracted(field, options);
    }
  } catch {
    // Diagnostics only; never let bookkeeping escape into extraction.
  }
}

/**
 * SAD-360: no value from any source. Helper evidence wins; a malformed
 * JSON-LD block turns absence into UNKNOWN because attribution is impossible.
 */
function recordAbsence(
  diag: FieldDiagnosticsCollector | undefined,
  field: TemuDiagnosticField,
  reason: string,
  options: { source: FieldExtractionSource; selector?: string },
  jsonLd: { malformedJsonLd: boolean; rejections: Map<TemuDiagnosticField, string> }
): void {
  if (!diag) return;
  try {
    const prior = diag.entries().get(field);
    // A rejected source is stronger evidence than "no source", so it wins.
    if (prior?.status === 'PARSE_FAILED') return;
    const rejection = jsonLd.rejections.get(field);
    if (rejection) {
      diag.parseFailed(field, rejection, { source: 'json-ld' });
      return;
    }
    if (jsonLd.malformedJsonLd && JSON_LD_FIELDS.has(field)) {
      diag.unknown(field, 'malformed JSON-LD block; attribution unknown');
      return;
    }
    if (prior) return;
    diag.missing(field, reason, options);
  } catch {
    // Diagnostics only.
  }
}

/** The evidence object `recordAbsence` needs, built from the JSON-LD result. */
function jsonLdEvidence(ldMeta: TemuJsonLdMetadata): {
  malformedJsonLd: boolean;
  rejections: Map<TemuDiagnosticField, string>;
} {
  return {
    malformedJsonLd: ldMeta.malformedJsonLd,
    rejections: ldMeta.rejections,
  };
}

/**
 * Parses a single product from a Temu Product Detail Page (`/*-g-<goodsId>.html` or `/goods.html?goods_id=<goodsId>`).
 *
 * Uses a 4-layer extraction pipeline:
 * 1. Structured `application/ld+json` (`@type: "Product"`, `"BreadcrumbList"`)
 * 2. Scoped PDP DOM landmarks (`#rightContent`, `#leftContent`, `#goods_price`, `#reviewContent`, `#goodsDetail`, `h1[aria-label]`)
 * 3. Structural fallback heuristics
 * 4. Strict Zod validation & non-fabrication (`null` when absent)
 *
 * SAD-360: the optional `diagnostics` collector receives the outcome of every
 * supported field. It never changes what is extracted — the returned product is
 * identical with and without it (parity-tested).
 */
export function parseTemuProductDetail(
  document: Document,
  url?: string,
  diagnostics?: FieldDiagnosticsCollector
): TemuScrapedProduct | null {
  const diag = diagnostics;
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

    // D7: recorded before the guard, so a goodsId-less PDP still reports.
    diag?.setGoodsId(goodsId);

    if (!goodsId) return null;

    const pdpScope =
      document.querySelector('#rightContent') ??
      document.querySelector('#goodsDetail') ??
      document.body ??
      document.documentElement;

    // 1. Title (`h1[aria-label]` -> `h1` -> JSON-LD `name` -> `meta[property="og:title"]`)
    const titleEl = document.querySelector(TEMU_SELECTORS.productDetail.title);
    const domTitle =
      cleanTemuText(titleEl?.getAttribute('aria-label')) ??
      extractTemuElementText(titleEl);
    const ogTitle =
      domTitle === null && ldMeta.title === null
        ? cleanTemuText(
            document
              .querySelector('meta[property="og:title"]')
              ?.getAttribute('content')
          )
        : null;
    const title = domTitle ?? ldMeta.title ?? ogTitle;

    if (domTitle !== null) {
      diag?.extracted('title', {
        source: 'dom',
        selector: TEMU_SELECTORS.productDetail.title,
      });
    } else if (titleEl) {
      diag?.parseFailed(
        'title',
        'title element present but produced no text',
        { source: 'dom', selector: TEMU_SELECTORS.productDetail.title }
      );
    }
    if (domTitle === null && ldMeta.title !== null) {
      recordFallback(
        diag,
        'title',
        { source: 'json-ld' },
        'DOM title element rejected; JSON-LD name used'
      );
    }
    if (domTitle === null && ldMeta.title === null && ogTitle !== null) {
      recordFallback(
        diag,
        'title',
        { source: 'dom', selector: 'meta[property="og:title"]' },
        'DOM title element rejected; og:title used'
      );
    }
    if (title === null) {
      recordAbsence(
        diag,
        'title',
        'no h1 title element, JSON-LD name, or og:title',
        { source: 'dom', selector: TEMU_SELECTORS.productDetail.title },
        jsonLdEvidence(ldMeta)
      );
    }

    // 2. Price, List Price, Discount Percentage (scoped to `#goods_price` or `#rightContent` first, then JSON-LD)
    const priceScope =
      document.querySelector(TEMU_SELECTORS.productDetail.priceContainer) ??
      pdpScope;

    const domPricing = priceScope
      ? extractTemuPricing(priceScope, ldMeta.currency ?? 'USD', diag)
      : {
          price: null,
          currency: null,
          listPrice: null,
          discountPercentage: null,
        };

    const price = domPricing.price ?? ldMeta.price;
    // SAD-380 F1: the struck reference price can live outside `#goods_price`
    // (the long-dead `productDetail.listPrice` selector anticipated
    // `#rightContent del/s`). If the price container yielded none, run ONE
    // diagnostics-free pricing pass over the wider PDP scope and take only
    // its `listPrice` — price/discount from the scoped pass are untouched,
    // and the validator still enforces `listPrice > price` on the merge.
    let listPrice = domPricing.listPrice;
    if (listPrice === null && pdpScope && priceScope !== pdpScope) {
      const widerPricing = extractTemuPricing(
        pdpScope,
        ldMeta.currency ?? 'USD'
      );
      if (widerPricing.listPrice !== null) {
        listPrice = widerPricing.listPrice;
        recordFallback(
          diag,
          'listPrice',
          {
            source: 'dom',
            selector: TEMU_SELECTORS.productDetail.listPrice,
          },
          'price container had no list price; wider PDP scope used'
        );
      }
    }
    const currency =
      domPricing.currency ??
      ldMeta.currency ??
      (price !== null || listPrice !== null ? 'USD' : null);
    const discountPercentage = domPricing.discountPercentage;

    if (domPricing.price === null && ldMeta.price !== null) {
      recordFallback(
        diag,
        'price',
        { source: 'json-ld' },
        'DOM price candidate rejected; JSON-LD price used'
      );
    }
    if (price === null) {
      recordAbsence(
        diag,
        'price',
        'no price node in the price scope',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    if (currency !== null) {
      if (domPricing.currency === null) {
        if (ldMeta.currency !== null) {
          diag?.extracted('currency', { source: 'json-ld' });
        } else {
          diag?.extracted('currency', {
            source: 'derived',
            reason: 'defaulted to USD because a price was parsed',
          });
        }
      }
    } else {
      recordAbsence(
        diag,
        'currency',
        'no currency token and no price to derive from',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    // 3. Rating & Review Count (check `#reviewContent` + `#rightContent` + JSON-LD `aggregateRating`)
    const reviewScope =
      document.querySelector('#reviewContent') ?? pdpScope ?? document.body;
    const domReviews = reviewScope
      ? extractTemuRatingAndReviews(reviewScope, diag)
      : { rating: null, reviewCount: null };

    const rating = domReviews.rating ?? ldMeta.rating;
    const reviewCount = domReviews.reviewCount ?? ldMeta.reviewCount;

    if (domReviews.rating === null && ldMeta.rating !== null) {
      recordFallback(
        diag,
        'rating',
        { source: 'json-ld' },
        'DOM rating candidate rejected; JSON-LD rating used'
      );
    }
    if (rating === null) {
      recordAbsence(
        diag,
        'rating',
        'no rating element or JSON-LD aggregateRating',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    if (domReviews.reviewCount === null && ldMeta.reviewCount !== null) {
      recordFallback(
        diag,
        'reviewCount',
        { source: 'json-ld' },
        'DOM review-count candidate rejected; JSON-LD reviewCount used'
      );
    }
    if (reviewCount === null) {
      recordAbsence(
        diag,
        'reviewCount',
        'no review-count node or JSON-LD reviewCount',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    // 4. Sales Volume (`10K+ sold`)
    const pastMonthSales = pdpScope
      ? extractTemuSalesVolume(pdpScope, diag)
      : null;
    if (pastMonthSales === null) {
      recordAbsence(
        diag,
        'pastMonthSales',
        'no sales-tip node',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    // 5. Primary Hero Image (`#leftContent img[data-js-main-img="true"]` -> JSON-LD `image[0]` -> `og:image`)
    const heroImgEl = document.querySelector<HTMLImageElement>(
      TEMU_SELECTORS.productDetail.heroImage
    );
    const domImageUrl = extractTemuBestImageUrl(heroImgEl, baseUrl);
    const jsonLdImageUrl = domImageUrl === null ? ldMeta.imageUrl : null;
    const ogImageUrl =
      domImageUrl === null && jsonLdImageUrl === null
        ? cleanTemuText(
            document
              .querySelector('meta[property="og:image"]')
              ?.getAttribute('content')
          )
        : null;
    const imageUrl = domImageUrl ?? jsonLdImageUrl ?? ogImageUrl;

    if (domImageUrl !== null) {
      diag?.extracted('imageUrl', {
        source: 'dom',
        selector: TEMU_SELECTORS.productDetail.heroImage,
      });
    } else if (heroImgEl) {
      diag?.parseFailed(
        'imageUrl',
        'hero image element present but no valid http(s) URL',
        { source: 'dom', selector: TEMU_SELECTORS.productDetail.heroImage }
      );
    }
    if (domImageUrl === null && jsonLdImageUrl !== null) {
      recordFallback(
        diag,
        'imageUrl',
        { source: 'json-ld' },
        'DOM hero image rejected; JSON-LD image used'
      );
    }
    if (domImageUrl === null && jsonLdImageUrl === null && ogImageUrl !== null) {
      recordFallback(
        diag,
        'imageUrl',
        { source: 'dom', selector: 'meta[property="og:image"]' },
        'DOM hero image rejected; og:image used'
      );
    }
    if (imageUrl === null) {
      recordAbsence(
        diag,
        'imageUrl',
        'no hero image, JSON-LD image, or og:image',
        { source: 'dom', selector: TEMU_SELECTORS.productDetail.heroImage },
        jsonLdEvidence(ldMeta)
      );
    }

    // 6. Metadata (Seller/Mall, Brand, Availability, Deal Badge, Badge, Coupon, Delivery)
    const meta = pdpScope
      ? extractTemuCardMetadata(pdpScope, diag)
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

    if (meta.seller === null && ldMeta.seller !== null) {
      recordFallback(
        diag,
        'seller',
        { source: 'json-ld' },
        'DOM seller label rejected; JSON-LD seller used'
      );
    }
    if (seller === null) {
      recordAbsence(
        diag,
        'seller',
        'no Sold by / Provided by / Shop / Store label or JSON-LD seller',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    if (meta.brand === null && ldMeta.brand !== null) {
      recordFallback(
        diag,
        'brand',
        { source: 'json-ld' },
        'DOM Brand label rejected; JSON-LD brand used'
      );
    }
    if (brand === null) {
      recordAbsence(
        diag,
        'brand',
        'no Brand label or JSON-LD brand',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    if (meta.availability === null && ldMeta.availability !== null) {
      recordFallback(
        diag,
        'availability',
        { source: 'json-ld' },
        'DOM stock phrase rejected; JSON-LD availability used'
      );
    }
    if (availability === null) {
      recordAbsence(
        diag,
        'availability',
        'no stock phrase or JSON-LD availability',
        { source: 'dom' },
        jsonLdEvidence(ldMeta)
      );
    }

    // 7. Features / Specifications & Description
    const features = extractTemuPdpFeatures(document, diag);
    const domDescription =
      ldMeta.description === null
        ? cleanTemuText(
            document
              .querySelector('meta[name="description"]')
              ?.getAttribute('content')
          )
        : null;
    const description = ldMeta.description ?? domDescription;

    if (ldMeta.description !== null) {
      diag?.extracted('description', { source: 'json-ld' });
    } else if (domDescription !== null) {
      recordFallback(
        diag,
        'description',
        { source: 'dom', selector: 'meta[name="description"]' },
        'JSON-LD description rejected; meta description used'
      );
    } else {
      recordAbsence(
        diag,
        'description',
        'no JSON-LD description or meta description',
        { source: 'dom', selector: 'meta[name="description"]' },
        jsonLdEvidence(ldMeta)
      );
    }

    const productUrl = resolveTemuProductUrl(
      canonicalHref ?? baseUrl,
      goodsId,
      baseUrl
    );
    diag?.extracted(
      'url',
      canonicalHref
        ? {
            source: 'url',
            selector: 'link[rel="canonical"]',
            reason: 'resolved from the canonical link',
          }
        : {
            source: 'derived',
            reason: 'built from goodsId and page origin',
          }
    );

    const candidate: TemuScrapedProduct = {
      goodsId,
      asin: goodsId,
      url: productUrl,
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
    };

    const normalized = validateAndNormalizeTemuScrapedProduct(
      candidate,
      baseUrl,
      'detail'
    );
    if (diag && normalized) {
      applyValidationResults(diag, candidate, normalized);
    }
    return normalized;
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

function extractTemuPdpFeatures(
  document: Document,
  diagnostics?: FieldDiagnosticsCollector
): string[] {
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

  // SAD-360: absence vs. "candidates were rejected by the existing filters".
  if (diagnostics) {
    if (features.length > 0) {
      diagnostics.extracted('features', { source: 'dom' });
    } else if (items.length > 0) {
      diagnostics.parseFailed(
        'features',
        'feature candidates rejected by length or dedup filters',
        { source: 'dom' }
      );
    } else {
      diagnostics.missing('features', 'no feature/spec list nodes', {
        source: 'dom',
      });
    }
  }

  return features;
}

/**
 * Extracts structured metadata from embedded `<script type="application/ld+json">` blocks
 * on Temu Product Detail Pages (`@type: "Product"` and `@type: "BreadcrumbList"`).
 *
 * SAD-360: only *rejections* are recorded here (a property was present but its
 * value could not be used); successful values are attributed by the caller.
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
    malformedJsonLd: false,
    rejections: new Map(),
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
            if (!result.title) {
              result.rejections.set('title', 'JSON-LD name present but empty');
            }
          }

          if (!result.description && typeof item.description === 'string') {
            result.description = cleanTemuText(item.description);
            if (!result.description) {
              result.rejections.set(
                'description',
                'JSON-LD description present but empty'
              );
            }
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
            if (!result.imageUrl) {
              result.rejections.set(
                'imageUrl',
                'JSON-LD image present but not a usable URL'
              );
            }
          }

          if (!result.brand && item.brand) {
            const rawBrand =
              typeof item.brand === 'string' ? item.brand : item.brand?.name;
            result.brand = cleanTemuText(rawBrand);
            if (!result.brand) {
              result.rejections.set(
                'brand',
                'JSON-LD brand present but empty'
              );
            }
          }

          if (item.aggregateRating && typeof item.aggregateRating === 'object') {
            if (
              result.rating === null &&
              item.aggregateRating.ratingValue != null
            ) {
              result.rating = parseTemuRating(
                String(item.aggregateRating.ratingValue)
              );
              if (result.rating === null) {
                result.rejections.set(
                  'rating',
                  'JSON-LD ratingValue present but not a 0-5 value'
                );
              }
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
              if (result.reviewCount === null) {
                result.rejections.set(
                  'reviewCount',
                  'JSON-LD reviewCount present but not a count'
                );
              }
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
              if (p.value === null) {
                result.rejections.set(
                  'price',
                  'JSON-LD offer price present but unparseable'
                );
              }
            }
            if (!result.seller && offer.seller?.name) {
              result.seller = cleanTemuText(String(offer.seller.name));
              if (!result.seller) {
                result.rejections.set(
                  'seller',
                  'JSON-LD seller present but empty'
                );
              }
            }
            if (!result.availability && typeof offer.availability === 'string') {
              if (/InStock/i.test(offer.availability)) {
                result.availability = 'In Stock';
              } else if (/OutOfStock/i.test(offer.availability)) {
                result.availability = 'Out of Stock';
              } else {
                result.rejections.set(
                  'availability',
                  'JSON-LD availability present but not mapped'
                );
              }
            }
          }
        }
      } catch {
        // Ignore malformed JSON-LD block, but remember that attribution is now
        // impossible for fields it might have carried.
        result.malformedJsonLd = true;
      }
    }
  } catch {
    // Fault isolation
  }

  return result;
}
