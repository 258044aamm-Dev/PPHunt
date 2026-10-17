import type { AmazonExtractionTier } from '../types';
import {
  extractAsinFromUrl,
  normalizeAsin,
  normalizeProductUrl,
  upgradeAmazonImageUrl,
} from '../utils/amazon-url';
import { resolveAmazonCurrency } from '../utils/currency';
import { parsePriceAmount, parsePriceText } from '../utils/price-parser';
import type { AmazonTrackedField } from './drift-telemetry';
import {
  AMAZON_SELECTORS,
  queryFirstMatching,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

export interface AmazonP13nMetadata {
  asin?: string;
  price?: number | string;
  currency?: string;
  rating?: number | string;
  reviewCount?: number | string;
}

export interface AmazonLdJsonProductData {
  asin?: string;
  title?: string;
  brand?: string;
  price?: number | null;
  currency?: string;
  rating?: number | null;
  reviewCount?: number | null;
  imageUrl?: string;
  description?: string;
  availability?: string;
}

export interface TieredValue<T> {
  value: T;
  tier: AmazonExtractionTier;
}

export type CardFieldTierMap = Partial<Record<AmazonTrackedField, AmazonExtractionTier>>;

const RATING_REGEXES: readonly RegExp[] = [
  /(\d+(?:[.,]\d+)?)\s*(?:out of|von|sur|de|su|van|z|av)\s*5/i,
  /5\s*つ星のうち\s*(\d+(?:[.,]\d+)?)/i,
  /(\d+(?:[.,]\d+)?)\s*stars?/i,
  /^(\d(?:[.,]\d)?)$/,
];

const BOUGHT_PAST_MONTH_REGEX =
  /(\d+(?:[.,]\d+)?\s*[KkMm+]?\+?\s*(?:bought in past month|gekauft Mal im letzten Monat|achetés le mois dernier|comprados el mes pasado|acquistati nell'ultimo mese|過去1か月で\d+点以上購入されました))/i;

const BSR_REGEX =
  /(#\s?[\d,.]+\s+in\s+[^\n(]+|Nr\.\s?[\d,.]+\s+in\s+[^\n(]+|nº\s?[\d,.]+\s+en\s+[^\n(]+)/i;

function normalizeWhitespace(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tier 1: Extracts structured metadata from `data-p13n-asin-metadata` or `data-csa-c-*`.
 */
export function extractTier1CardMetadata(card: Element): AmazonP13nMetadata | null {
  const metaNode = card.hasAttribute('data-p13n-asin-metadata')
    ? card
    : safeQuerySelector(card, '[data-p13n-asin-metadata]');
  const rawMeta = metaNode?.getAttribute('data-p13n-asin-metadata');
  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta) as Record<string, unknown>;
      const asin =
        typeof parsed.asin === 'string'
          ? normalizeAsin(parsed.asin) ?? undefined
          : undefined;
      return {
        asin,
        price:
          typeof parsed.price === 'number' || typeof parsed.price === 'string'
            ? parsed.price
            : undefined,
        currency:
          typeof parsed.currency === 'string' ? parsed.currency : undefined,
        rating:
          typeof parsed.rating === 'number' || typeof parsed.rating === 'string'
            ? parsed.rating
            : undefined,
        reviewCount:
          typeof parsed.reviewCount === 'number' ||
          typeof parsed.reviewCount === 'string'
            ? parsed.reviewCount
            : undefined,
      };
    } catch {
      // Ignore malformed metadata JSON
    }
  }

  const csaNode =
    card.getAttribute('data-csa-c-asin') || card.getAttribute('data-csa-c-item-id')
      ? card
      : safeQuerySelector(card, '[data-csa-c-asin], [data-csa-c-item-id]');
  if (csaNode) {
    const rawCsa =
      csaNode.getAttribute('data-csa-c-asin') ??
      csaNode.getAttribute('data-csa-c-item-id') ??
      '';
    const asinMatch =
      normalizeAsin(rawCsa) ??
      (/asin\.([A-Z0-9]{10})/i.exec(rawCsa)?.[1]?.toUpperCase() ?? null);
    if (asinMatch) {
      return { asin: asinMatch };
    }
  }

  return null;
}

/**
 * Tier 1: Extracts structured `application/ld+json` Product metadata from a Document.
 */
export function extractTier1LdJsonProduct(
  doc: Document,
  pageUrl?: string,
): AmazonLdJsonProductData | null {
  const scripts = safeQuerySelectorAll<HTMLScriptElement>(
    doc,
    'script[type="application/ld+json"]',
  );
  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { '@graph'?: unknown[] })['@graph'])
          ? ((parsed as { '@graph': unknown[] })['@graph'])
          : [parsed];

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const typeVal = record['@type'];
        const isProduct =
          typeVal === 'Product' ||
          (Array.isArray(typeVal) && typeVal.includes('Product'));
        if (!isProduct) continue;

        const asin =
          normalizeAsin(
            typeof record.sku === 'string'
              ? record.sku
              : typeof record.productID === 'string'
                ? record.productID
                : typeof record.mpn === 'string'
                  ? record.mpn
                  : undefined,
          ) ?? undefined;
        const title =
          typeof record.name === 'string'
            ? normalizeWhitespace(record.name)
            : undefined;
        let brand: string | undefined;
        if (typeof record.brand === 'string') {
          brand = normalizeWhitespace(record.brand);
        } else if (record.brand && typeof record.brand === 'object') {
          const brandName = (record.brand as { name?: unknown }).name;
          if (typeof brandName === 'string') {
            brand = normalizeWhitespace(brandName);
          }
        }

        let price: number | null | undefined;
        let currency: string | undefined;
        let availability: string | undefined;
        const offers = record.offers;
        const offerObj = Array.isArray(offers)
          ? (offers[0] as Record<string, unknown> | undefined)
          : (offers as Record<string, unknown> | undefined);
        if (offerObj && typeof offerObj === 'object') {
          const rawPrice = offerObj.price ?? offerObj.lowPrice;
          if (typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice >= 0) {
            price = Math.round(rawPrice * 100) / 100;
          } else if (typeof rawPrice === 'string') {
            price = parsePriceAmount(rawPrice);
          }
          if (typeof offerObj.priceCurrency === 'string') {
            currency = offerObj.priceCurrency.trim().toUpperCase();
          }
          if (typeof offerObj.availability === 'string') {
            availability = offerObj.availability.replace(/^https?:\/\/schema\.org\//i, '');
          }
        }

        let rating: number | null | undefined;
        let reviewCount: number | null | undefined;
        const agg = record.aggregateRating as Record<string, unknown> | undefined;
        if (agg && typeof agg === 'object') {
          const rawRating = agg.ratingValue;
          if (typeof rawRating === 'number' && rawRating >= 0 && rawRating <= 5) {
            rating = Math.round(rawRating * 10) / 10;
          } else if (typeof rawRating === 'string') {
            rating = parseRatingValue(rawRating);
          }
          const rawCount = agg.reviewCount ?? agg.ratingCount;
          if (typeof rawCount === 'number' && rawCount >= 0) {
            reviewCount = Math.trunc(rawCount);
          } else if (typeof rawCount === 'string') {
            reviewCount = parseReviewCountValue(rawCount);
          }
        }

        let imageUrl: string | undefined;
        if (typeof record.image === 'string') {
          imageUrl = upgradeAmazonImageUrl(record.image);
        } else if (Array.isArray(record.image) && typeof record.image[0] === 'string') {
          imageUrl = upgradeAmazonImageUrl(record.image[0]);
        }

        const description =
          typeof record.description === 'string'
            ? normalizeWhitespace(record.description)
            : undefined;

        return {
          asin,
          title,
          brand,
          price,
          currency: currency ?? resolveAmazonCurrency(undefined, pageUrl),
          rating,
          reviewCount,
          imageUrl,
          description,
          availability,
        };
      }
    } catch {
      // Ignore malformed JSON-LD block
    }
  }
  return null;
}

/**
 * 4-Tier ASIN extraction from a product card element.
 */
export function extractCardAsinWithTier(card: Element): TieredValue<string | null> {
  // Tier 1: Structured JSON metadata (`data-p13n-asin-metadata`, `data-csa-c-asin`)
  const tier1 = extractTier1CardMetadata(card);
  if (tier1?.asin) {
    return { value: tier1.asin, tier: 'tier1_json' };
  }

  // Tier 2: Semantic `data-asin` attribute on card or direct child
  const directAsin = normalizeAsin(card.getAttribute('data-asin'));
  if (directAsin) {
    return { value: directAsin, tier: 'tier2_semantic' };
  }
  const nestedAsinEl = safeQuerySelector(card, '[data-asin]:not([data-asin=""])');
  const nestedAsin = normalizeAsin(nestedAsinEl?.getAttribute('data-asin'));
  if (nestedAsin) {
    return { value: nestedAsin, tier: 'tier2_semantic' };
  }

  // Tier 3: Structural `/dp/<ASIN>` or `/gp/product/<ASIN>` anchor discovery
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"], a[href*="/sspa/click"]',
  );
  for (const anchor of anchors) {
    const asin = extractAsinFromUrl(anchor.getAttribute('href'));
    if (asin) {
      return { value: asin, tier: 'tier3_structural' };
    }
  }

  return { value: null, tier: 'missing' };
}

export function extractCardAsin(card: Element): string | null {
  return extractCardAsinWithTier(card).value;
}

/**
 * 4-Tier Title extraction from a product card element.
 */
export function extractCardTitleWithTier(
  card: Element,
  asin?: string | null,
): TieredValue<string> {
  // Tier 2: Semantic `[data-cy="title-recipe"]` or `[data-testid="product-card-title"]`
  const semanticSelectors = [
    '[data-cy="title-recipe"] h2 span',
    '[data-cy="title-recipe"] h2 a span',
    '[data-cy="title-recipe"] h2',
    '[data-testid="product-card-title"]',
  ];
  for (const selector of semanticSelectors) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text && text.length >= 2) {
      return { value: text, tier: 'tier2_semantic' };
    }
  }

  // Tier 4: Declarative selector registry
  for (const selector of AMAZON_SELECTORS.cardFields.title) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text && text.length >= 2) {
      return { value: text, tier: 'tier4_selector' };
    }
  }

  // Tier 3: Layout-agnostic `/dp/<ASIN>` anchor text heuristic
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click"]',
  );
  let bestText = '';
  for (const anchor of anchors) {
    if (asin) {
      const linkAsin = extractAsinFromUrl(anchor.getAttribute('href'));
      if (linkAsin && linkAsin !== asin) continue;
    }
    const candidate =
      normalizeWhitespace(anchor.getAttribute('title')) ||
      normalizeWhitespace(anchor.textContent);
    if (
      candidate.length > bestText.length &&
      !/^\$?\d+[.,]\d{2}$/.test(candidate) &&
      !/^\d+\s*(?:ratings|reviews|stars)/i.test(candidate)
    ) {
      bestText = candidate;
    }
  }
  if (bestText.length >= 2) {
    return { value: bestText, tier: 'tier3_structural' };
  }

  // Fallback to image alt text if present and descriptive
  const imgWithAlt = safeQuerySelector<HTMLImageElement>(card, 'img[alt]');
  const altText = normalizeWhitespace(imgWithAlt?.getAttribute('alt'));
  if (altText.length >= 4 && !/^sponsored/i.test(altText)) {
    return { value: altText, tier: 'tier3_structural' };
  }

  return { value: '', tier: 'missing' };
}

export function extractCardTitle(card: Element, asin?: string | null): string {
  return extractCardTitleWithTier(card, asin).value;
}

/**
 * Cleans Amazon brand byline strings ("Visit the Sony Store" -> "Sony", "Brand: Anker" -> "Anker").
 */
export function cleanAmazonBrandText(raw: string | null | undefined): string | undefined {
  const text = normalizeWhitespace(raw);
  if (!text) return undefined;

  const cleaned = text
    .replace(/^Visit the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .replace(/^Brand:\s*/i, '')
    .replace(/^Marke:\s*/i, '')
    .replace(/^Marque\s*:\s*/i, '')
    .replace(/^Marca:\s*/i, '')
    .replace(/^ブランド:\s*/i, '')
    .trim();

  if (!cleaned || cleaned.length > 80) return undefined;
  if (/^(sponsored|best seller|amazon's choice|overall pick)$/i.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

export function extractCardBrand(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.brand) {
    const el = safeQuerySelector(card, selector);
    const cleaned = cleanAmazonBrandText(el?.textContent);
    if (cleaned) return cleaned;
  }
  return undefined;
}

/**
 * 4-Tier Selling Price + Currency extraction from a product card or buybox container.
 */
export function extractCardPriceWithTier(
  card: Element,
  pageUrl?: string,
): TieredValue<{ price: number | null; currency: string }> {
  const defaultCurrency = resolveAmazonCurrency(undefined, pageUrl);

  // Tier 1: Structured JSON metadata (`data-p13n-asin-metadata`)
  const tier1 = extractTier1CardMetadata(card);
  if (tier1?.price !== undefined) {
    if (typeof tier1.price === 'number' && Number.isFinite(tier1.price) && tier1.price >= 0) {
      return {
        value: {
          price: Math.round(tier1.price * 100) / 100,
          currency: tier1.currency ?? defaultCurrency,
        },
        tier: 'tier1_json',
      };
    }
    if (typeof tier1.price === 'string') {
      const parsed = parsePriceText(tier1.price, pageUrl);
      if (parsed.price !== null) {
        return { value: parsed, tier: 'tier1_json' };
      }
    }
  }

  // Tier 2: Semantic `[data-cy="price-recipe"]` or `.a-price:not([data-a-strike="true"]) .a-offscreen`
  const semanticOffscreen = safeQuerySelector(
    card,
    '[data-cy="price-recipe"] .a-price:not([data-a-strike="true"]) .a-offscreen, .a-price:not([data-a-strike="true"]) .a-offscreen',
  );
  if (semanticOffscreen?.textContent) {
    const parsed = parsePriceText(semanticOffscreen.textContent, pageUrl);
    if (parsed.price !== null) {
      return { value: parsed, tier: 'tier2_semantic' };
    }
  }

  // Tier 2b: Whole + Fraction composite price (`a-price-whole` + `a-price-fraction`)
  const wholeEl = safeQuerySelector(card, AMAZON_SELECTORS.cardFields.wholePrice);
  if (wholeEl?.textContent) {
    const wholeDigits = wholeEl.textContent.replace(/[^\d]/g, '');
    const fractionEl = safeQuerySelector(
      card,
      AMAZON_SELECTORS.cardFields.fractionPrice,
    );
    const symbolEl = safeQuerySelector(card, AMAZON_SELECTORS.cardFields.priceSymbol);
    const fractionDigits = fractionEl?.textContent?.replace(/[^\d]/g, '') ?? '';
    if (wholeDigits) {
      const combinedNumeric = fractionDigits
        ? `${wholeDigits}.${fractionDigits.slice(0, 2)}`
        : wholeDigits;
      const numericVal = Number.parseFloat(combinedNumeric);
      if (Number.isFinite(numericVal) && numericVal >= 0) {
        const currency = resolveAmazonCurrency(symbolEl?.textContent, pageUrl);
        return {
          value: { price: Math.round(numericVal * 100) / 100, currency },
          tier: 'tier2_semantic',
        };
      }
    }
  }

  // Tier 4: Declarative selector registry
  for (const selector of AMAZON_SELECTORS.cardFields.sellingPrice) {
    const elements = safeQuerySelectorAll(card, selector);
    for (const el of elements) {
      if (el.closest('[data-a-strike="true"], s, del')) continue;
      const parsed = parsePriceText(el.textContent, pageUrl);
      if (parsed.price !== null) {
        return { value: parsed, tier: 'tier4_selector' };
      }
    }
  }

  // Tier 3: Structural currency-annotated text scan inside card (excluding strikethroughs)
  const currencyTokenRegex =
    /(?:US\$|CA\$|AU\$|MX\$|S\$|R\$|[\$£€¥￥₹₺]|CHF|PLN|zł|SEK|kr|AED|SAR)\s*\d[\d.,'\s]*|\d[\d.,'\s]*\s*(?:€|zł|kr|TL|₺)/i;
  const candidateSpans = safeQuerySelectorAll(card, 'span, div, a');
  for (const node of candidateSpans) {
    if (node.children.length > 2) continue;
    if (node.closest('[data-a-strike="true"], s, del')) continue;
    const rawText = normalizeWhitespace(node.textContent);
    if (!rawText || rawText.length > 36) continue;
    if (/coupon|save|off|voucher|rabatt/i.test(rawText)) continue;
    const match = currencyTokenRegex.exec(rawText);
    if (match?.[0]) {
      const parsed = parsePriceText(match[0], pageUrl);
      if (parsed.price !== null) {
        return { value: parsed, tier: 'tier3_structural' };
      }
    }
  }

  return {
    value: { price: null, currency: defaultCurrency },
    tier: 'missing',
  };
}

export function extractCardListPrice(
  card: Element,
  sellingPrice: number | null,
  pageUrl?: string,
): number | null {
  for (const selector of AMAZON_SELECTORS.cardFields.listPrice) {
    const el = safeQuerySelector(card, selector);
    if (!el?.textContent) continue;
    const parsed = parsePriceText(el.textContent, pageUrl).price;
    if (
      parsed !== null &&
      (sellingPrice === null || parsed > sellingPrice)
    ) {
      return parsed;
    }
  }
  return null;
}

export function extractCardDiscountPercentage(
  card: Element,
  sellingPrice: number | null,
  listPrice: number | null,
): number | null {
  for (const selector of AMAZON_SELECTORS.cardFields.discount) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (!text) continue;
    const pctMatch = /-\s*(\d{1,2})\s*%|(\d{1,2})\s*%\s*off/i.exec(text);
    const rawPct = pctMatch?.[1] ?? pctMatch?.[2];
    if (rawPct) {
      const pct = Number.parseInt(rawPct, 10);
      if (Number.isFinite(pct) && pct > 0 && pct <= 99) {
        return pct;
      }
    }
  }

  if (
    sellingPrice !== null &&
    listPrice !== null &&
    listPrice > sellingPrice &&
    listPrice > 0
  ) {
    const computed = Math.round(((listPrice - sellingPrice) / listPrice) * 100);
    if (computed > 0 && computed <= 99) {
      return computed;
    }
  }

  return null;
}

/**
 * Parses a localized star rating (`4.6 out of 5 stars`, `4,6 von 5 Sternen`, `5つ星のうち4.6`) into `0..5`.
 */
export function parseRatingValue(raw: string | null | undefined): number | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  for (const regex of RATING_REGEXES) {
    const match = regex.exec(text);
    if (match?.[1]) {
      const normalized = match[1].replace(',', '.');
      const value = Number.parseFloat(normalized);
      if (Number.isFinite(value) && value >= 0 && value <= 5) {
        return Math.round(value * 10) / 10;
      }
    }
  }
  return null;
}

/**
 * Parses a localized review count (`1,234`, `(45.678)`, `12.4K`, `1,234 global ratings`) into a non-negative integer.
 */
export function parseReviewCountValue(raw: string | null | undefined): number | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  // Reject strings that look like star ratings ("4.5 out of 5") or bought-in-past-month badges
  if (/out of 5|von 5|sur 5|de 5|su 5|5つ星|bought in past month/i.test(text)) {
    return null;
  }

  const compactMatch = /(\d+(?:[.,]\d+)?)\s*([KkMm])\b/.exec(text);
  if (compactMatch?.[1] && compactMatch[2]) {
    const base = Number.parseFloat(compactMatch[1].replace(',', '.'));
    const mult = compactMatch[2].toUpperCase() === 'M' ? 1_000_000 : 1_000;
    if (Number.isFinite(base) && base >= 0) {
      return Math.round(base * mult);
    }
  }

  const digitsMatch = /\(?(\d{1,3}(?:[.,\s]\d{3})+|\d+)\)?/.exec(text);
  if (!digitsMatch?.[1]) return null;

  const digitsOnly = digitsMatch[1].replace(/[^\d]/g, '');
  if (!digitsOnly) return null;
  const count = Number.parseInt(digitsOnly, 10);
  if (!Number.isFinite(count) || count < 0) return null;
  return count;
}

export function extractCardRatingWithTier(card: Element): TieredValue<number | null> {
  const tier1 = extractTier1CardMetadata(card);
  if (tier1?.rating !== undefined) {
    const val =
      typeof tier1.rating === 'number'
        ? tier1.rating
        : parseRatingValue(String(tier1.rating));
    if (val !== null && val >= 0 && val <= 5) {
      return { value: Math.round(val * 10) / 10, tier: 'tier1_json' };
    }
  }

  for (const selector of AMAZON_SELECTORS.cardFields.rating) {
    const el = safeQuerySelector(card, selector);
    if (!el) continue;
    const raw =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent;
    const rating = parseRatingValue(raw);
    if (rating !== null) {
      const tier: AmazonExtractionTier = selector.includes('data-cy') || selector.includes('aria-label')
        ? 'tier2_semantic'
        : 'tier4_selector';
      return { value: rating, tier };
    }
  }

  return { value: null, tier: 'missing' };
}

export function extractCardReviewCountWithTier(
  card: Element,
): TieredValue<number | null> {
  const tier1 = extractTier1CardMetadata(card);
  if (tier1?.reviewCount !== undefined) {
    const val =
      typeof tier1.reviewCount === 'number'
        ? Math.trunc(tier1.reviewCount)
        : parseReviewCountValue(String(tier1.reviewCount));
    if (val !== null && val >= 0) {
      return { value: val, tier: 'tier1_json' };
    }
  }

  for (const selector of AMAZON_SELECTORS.cardFields.reviewCount) {
    const elements = safeQuerySelectorAll(card, selector);
    for (const el of elements) {
      const raw = el.getAttribute('aria-label') || el.textContent;
      const count = parseReviewCountValue(raw);
      if (count !== null) {
        const tier: AmazonExtractionTier = selector.includes('data-cy') || selector.includes('aria-label')
          ? 'tier2_semantic'
          : 'tier4_selector';
        return { value: count, tier };
      }
    }
  }

  return { value: null, tier: 'missing' };
}

/**
 * 4-Tier Image URL extraction from a product card or detail container.
 * Supports `data-old-hires`, `data-a-dynamic-image` JSON map, `srcset`, `src`, and `data-src`.
 */
export function extractImageWithTier(card: Element): TieredValue<string> {
  const images = safeQuerySelectorAll<HTMLImageElement>(
    card,
    [...AMAZON_SELECTORS.cardFields.image, 'img'].join(', '),
  );

  for (const img of images) {
    // Skip tiny tracking pixels or prime/badge icons
    const srcCandidate =
      img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
    if (/sprite|transparent-pixel|grey-pixel|nav-sprite/i.test(srcCandidate)) {
      continue;
    }

    // Tier 1: `data-old-hires` or `data-a-dynamic-image` JSON resolution map
    const oldHires = img.getAttribute('data-old-hires');
    if (oldHires && /^https?:\/\//i.test(oldHires.trim())) {
      return {
        value: upgradeAmazonImageUrl(oldHires),
        tier: 'tier1_json',
      };
    }

    const dynamicImageJson = img.getAttribute('data-a-dynamic-image');
    if (dynamicImageJson) {
      try {
        const parsedMap = JSON.parse(dynamicImageJson) as Record<
          string,
          [number, number] | unknown
        >;
        let bestUrl = '';
        let bestArea = -1;
        for (const [url, dims] of Object.entries(parsedMap)) {
          if (!/^https?:\/\//i.test(url)) continue;
          const area =
            Array.isArray(dims) &&
            typeof dims[0] === 'number' &&
            typeof dims[1] === 'number'
              ? dims[0] * dims[1]
              : 0;
          if (area >= bestArea) {
            bestArea = area;
            bestUrl = url;
          }
        }
        if (bestUrl) {
          return {
            value: upgradeAmazonImageUrl(bestUrl),
            tier: 'tier1_json',
          };
        }
      } catch {
        // Ignore malformed dynamic-image JSON
      }
    }

    // Tier 2: Semantic `s-image` / `s-product-image` with `srcset` or `src`
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const candidates = srcset
        .split(',')
        .map((entry) => entry.trim().split(/\s+/)[0])
        .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));
      const highestRes = candidates[candidates.length - 1];
      if (highestRes) {
        return {
          value: upgradeAmazonImageUrl(highestRes),
          tier: img.classList.contains('s-image') ? 'tier2_semantic' : 'tier3_structural',
        };
      }
    }

    if (srcCandidate && /^https?:\/\//i.test(srcCandidate)) {
      return {
        value: upgradeAmazonImageUrl(srcCandidate),
        tier: img.classList.contains('s-image') ? 'tier2_semantic' : 'tier3_structural',
      };
    }
  }

  return { value: '', tier: 'missing' };
}

export function extractCardDealBadge(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.dealBadge) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (
      text &&
      /deal|limited time|lightning|black friday|prime day|cyber monday|angebot|offre|oferta/i.test(
        text,
      )
    ) {
      return text;
    }
  }
  return undefined;
}

export function extractCardStatusBadge(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.statusBadge) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (
      text &&
      /best seller|amazon's choice|overall pick|popular|new release|most wished|bestseller|#\d+/i.test(
        text,
      )
    ) {
      return text;
    }
  }
  return undefined;
}

export function extractCardCouponText(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.coupon) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text && /coupon|save|voucher|rabatt|remise/i.test(text)) {
      return text.replace(/\s*Terms\s*$/i, '').trim();
    }
  }
  return undefined;
}

export function extractCardBoughtInPastMonth(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.boughtInPastMonth) {
    const elements = safeQuerySelectorAll(card, selector);
    for (const el of elements) {
      const text = normalizeWhitespace(el.textContent);
      const match = BOUGHT_PAST_MONTH_REGEX.exec(text);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  }
  return undefined;
}

export function extractCardBsr(card: Element): string | undefined {
  const badge = safeQuerySelector(card, '.zg-bdg-text');
  const badgeText = normalizeWhitespace(badge?.textContent);
  if (badgeText && /^#\d+/.test(badgeText)) {
    return badgeText;
  }

  for (const selector of AMAZON_SELECTORS.detail.bsr) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    const match = BSR_REGEX.exec(text);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function extractCardIsPrime(card: Element): boolean {
  const { element } = queryFirstMatching(card, AMAZON_SELECTORS.cardFields.prime);
  return element !== null;
}

export function extractCardIsSponsored(card: Element): boolean {
  if (
    card.getAttribute('data-component-type') === 'sp-sponsored-result' ||
    card.classList.contains('AdHolder')
  ) {
    return true;
  }
  const { element } = queryFirstMatching(
    card,
    AMAZON_SELECTORS.cardFields.sponsored,
  );
  if (element) {
    const text = normalizeWhitespace(
      element.getAttribute('aria-label') || element.textContent,
    );
    if (!text || /sponsored|gesponsert|sponsorisé|patrocinado|スポンサー/i.test(text)) {
      return true;
    }
  }
  return false;
}

export function extractCardDeliveryInfo(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.delivery) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text && text.length <= 160) {
      return text;
    }
  }
  return undefined;
}

export function extractCardProductUrl(
  card: Element,
  asin: string,
  pageUrl?: string,
): string {
  const anchor = safeQuerySelector<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], h2 a[href]',
  );
  return normalizeProductUrl(anchor?.getAttribute('href'), asin, pageUrl);
}

/**
 * Tier 3 Structural Card Discovery:
 * When Amazon A/B tests strip `[data-component-type="s-search-result"]` or `#gridItemRoot`,
 * discovers distinct product card containers by grouping `/dp/<ASIN>` links and walking up
 * to each ASIN's lowest self-contained card ancestor.
 */
export function discoverStructuralProductCards(root: ParentNode): Element[] {
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    root,
    'a[href*="/dp/"], a[href*="/gp/product/"]',
  );
  const anchorsByAsin = new Map<string, HTMLAnchorElement[]>();
  const anchorAsinMap = new WeakMap<HTMLAnchorElement, string>();

  for (const anchor of anchors) {
    // Ignore peripheral ad carousels if inside a detail page
    if (anchor.closest('[id*="sp_detail"], [id*="sims-consolidated"]')) {
      continue;
    }
    const asin = extractAsinFromUrl(anchor.getAttribute('href'));
    if (!asin) continue;
    anchorAsinMap.set(anchor, asin);
    const list = anchorsByAsin.get(asin) ?? [];
    list.push(anchor);
    anchorsByAsin.set(asin, list);
  }

  const discoveredCards: Element[] = [];
  const usedContainers = new Set<Element>();

  for (const [asin, asinAnchors] of anchorsByAsin.entries()) {
    const primaryAnchor = asinAnchors[0];
    if (!primaryAnchor) continue;

    let current: Element | null = primaryAnchor.parentElement;
    let bestContainer: Element | null = null;
    let depth = 0;

    while (
      current &&
      current !== (root as unknown as Element) &&
      current.tagName !== 'BODY' &&
      current.tagName !== 'MAIN' &&
      depth < 8
    ) {
      // Check if `current` contains any anchor for a DIFFERENT ASIN
      const childAnchors = safeQuerySelectorAll<HTMLAnchorElement>(
        current,
        'a[href*="/dp/"], a[href*="/gp/product/"]',
      );
      let hasForeignAsin = false;
      for (const childAnchor of childAnchors) {
        const childAsin =
          anchorAsinMap.get(childAnchor) ??
          extractAsinFromUrl(childAnchor.getAttribute('href'));
        if (childAsin && childAsin !== asin) {
          hasForeignAsin = true;
          break;
        }
      }
      if (hasForeignAsin) {
        break;
      }

      bestContainer = current;
      current = current.parentElement;
      depth += 1;
    }

    if (bestContainer && !usedContainers.has(bestContainer)) {
      usedContainers.add(bestContainer);
      discoveredCards.push(bestContainer);
    }
  }

  return discoveredCards;
}
