import type {
  AmazonExtractionTier,
  ProductSource,
  ScrapedAmazonProduct,
} from '../types';
import {
  extractASIN,
  isValidASIN,
  normalizeASIN,
  resolveProductUrl,
  upgradeAmazonImageUrl,
} from '../utils/amazon-url';
import { isIsoCurrency, resolvePageCurrency } from '../utils/currency';
import { parsePrice, parsePriceFromElements } from '../utils/price-parser';
import type { AmazonTrackedField } from './drift-telemetry';
import {
  AMAZON_SELECTORS,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

export interface TieredValue<T> {
  value: T;
  tier: AmazonExtractionTier;
}

export type CardFieldTierMap = Partial<
  Record<AmazonTrackedField, AmazonExtractionTier>
>;

export interface CardPricingAndDiscounts {
  price: number | null;
  currency: string | null;
  listPrice?: number;
  discountPercentage?: string;
  dealBadge?: string;
  coupon?: string;
  priceTier: AmazonExtractionTier;
}

const RATING_PATTERNS: readonly RegExp[] = [
  /(\d+(?:[.,]\d+)?)\s*(?:out of|von|sur|de|su|van|z|av)\s*5/i,
  /5\s*つ星のうち\s*(\d+(?:[.,]\d+)?)/i,
  /(\d+(?:[.,]\d+)?)\s*stars?/i,
  /^(\d(?:[.,]\d)?)$/,
];

const PAST_MONTH_SALES_REGEX =
  /(\d+(?:[.,]\d+)?\s*[KkMm+]?\+?\s*bought in past month)/i;

export function normalizeWhitespace(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether `el` is equal to or a descendant of any element in `cardSet` in O(depth) time.
 */
export function isWithinAnyCard(
  el: Element,
  cardSet: ReadonlySet<Element>,
): boolean {
  let cursor: Element | null = el;
  while (cursor) {
    if (cardSet.has(cursor)) {
      return true;
    }
    cursor = cursor.parentElement;
  }
  return false;
}

/**
 * Checks whether `root` contains any element in `cardSet` in O(|cardSet| * depth) time.
 */
export function containsAnyCard(
  root: Element,
  cardSet: ReadonlySet<Element>,
): boolean {
  if (cardSet.has(root)) return true;
  for (const card of cardSet) {
    let cursor: Element | null = card.parentElement;
    while (cursor) {
      if (cursor === root) return true;
      cursor = cursor.parentElement;
    }
  }
  return false;
}

/**
 * Linear O(N * depth) nested-card filter matching the exact semantics of:
 * - default: `cards.filter((card) => !cards.some((other) => other !== card && other.contains(card)))`
 * - `dropDuplicates: true`: `cards.filter((card, idx) => !cards.some((other, otherIdx) => otherIdx !== idx && other.contains(card)))`
 */
export function dropNestedCards(
  cards: readonly Element[],
  options: { dropDuplicates?: boolean } = {},
): Element[] {
  if (cards.length <= 1) return [...cards];

  const cardCounts = new Map<Element, number>();
  for (const card of cards) {
    cardCounts.set(card, (cardCounts.get(card) ?? 0) + 1);
  }

  return cards.filter((card) => {
    if (options.dropDuplicates && (cardCounts.get(card) ?? 0) > 1) {
      return false;
    }
    let ancestor = card.parentElement;
    while (ancestor) {
      if (cardCounts.has(ancestor)) {
        return false;
      }
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

/**
 * Parses a localized star rating (`4.6 out of 5 stars`, `4,7 von 5 Sternen`, `5つ星のうち4.3`) into `0..5`.
 */
export function parseRating(raw: string | null | undefined): number | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  for (const regex of RATING_PATTERNS) {
    const match = regex.exec(text);
    if (match?.[1]) {
      const val = Number.parseFloat(match[1].replace(',', '.'));
      if (Number.isFinite(val) && val >= 0 && val <= 5) {
        return Math.round(val * 10) / 10;
      }
    }
  }
  return null;
}

export const parseRatingValue = parseRating;

/**
 * Parses a localized review count (`1,284 ratings`, `4.5 out of 5 stars 1,284 ratings`, `(4.321)`, `1.5K ratings`)
 * while never mistaking star rating numbers (`4.5 out of 5 stars`) for review counts.
 */
export function parseReviewCount(raw: string | null | undefined): number | null {
  let text = normalizeWhitespace(raw);
  if (!text) return null;

  // Reject past-month sales strings or bare rank badges
  if (/bought in past month/i.test(text) || /^#\d+$/.test(text)) {
    return null;
  }

  // Strip any leading/inline star rating phrases ("4.5 out of 5 stars", "4,8 von 5 Sternen", "5つ星のうち4.4")
  text = text
    .replace(
      /\d+(?:[.,]\d+)?\s*(?:out of|von|sur|de|su|van|z|av)\s*5\s*(?:stars?|sternen|étoiles|estrellas|stelle)?/gi,
      ' ',
    )
    .replace(/5\s*つ星のうち\s*\d+(?:[.,]\d+)?/g, ' ')
    .trim();

  if (!text) return null;

  // Compact K/M suffix ("1.5K ratings")
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

export const parseReviewCountValue = parseReviewCount;

export function cleanBrand(raw: string | null | undefined): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  const cleaned = text
    .replace(/^Visit the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .replace(/^Brand:\s*/i, '')
    .replace(/^Marke:\s*/i, '')
    .replace(/^Marque\s*:\s*/i, '')
    .replace(/^Marca:\s*/i, '')
    .replace(/^ブランド:\s*/i, '')
    .trim();

  if (!cleaned || cleaned.length > 80) return null;
  if (/^(sponsored|best seller|amazon's choice|overall pick)$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export const cleanAmazonBrandText = cleanBrand;

export function cleanAvailability(raw: string | null | undefined): string | null {
  const text = normalizeWhitespace(raw);
  return text || null;
}

export function cleanSeller(raw: string | null | undefined): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  const cleaned = text
    .replace(/^Ships from and sold by\s+/i, '')
    .replace(/^Sold by\s+/i, '')
    .replace(/\s+and\s+Fulfilled by Amazon\.?$/i, '')
    .replace(/\.$/, '')
    .trim();

  return cleaned || null;
}

/**
 * Picks the highest-resolution image URL from an `<img>` element (`data-old-hires`, `data-a-hires`,
 * `data-a-dynamic-image`, `srcset`, `<picture><source srcset>`, `src`, `data-src`, or `data-lazy-src`).
 */
export function extractBestImageUrl(
  img: Element | null | undefined,
): string | null {
  if (!img) return null;

  if (
    img.getAttribute('width') === '1' ||
    img.getAttribute('height') === '1' ||
    img.classList.contains('deal-badge')
  ) {
    return null;
  }

  const hires =
    img.getAttribute('data-old-hires')?.trim() ||
    img.getAttribute('data-a-hires')?.trim();
  if (hires && /^https?:\/\//i.test(hires)) {
    return upgradeAmazonImageUrl(hires) || null;
  }

  const dynamicJson = img.getAttribute('data-a-dynamic-image');
  if (dynamicJson) {
    try {
      const parsed = JSON.parse(dynamicJson) as Record<
        string,
        [number, number] | unknown
      >;
      let bestUrl = '';
      let bestArea = -1;
      for (const [url, dims] of Object.entries(parsed)) {
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
        return upgradeAmazonImageUrl(bestUrl) || null;
      }
    } catch {
      // Fall through
    }
  }

  let srcset = img.getAttribute('srcset')?.trim();
  if (!srcset) {
    const picture = img.closest('picture');
    if (picture) {
      const sourceEl = safeQuerySelector(picture, 'source[srcset]');
      srcset = sourceEl?.getAttribute('srcset')?.trim();
    }
  }
  if (srcset) {
    const urls = srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));
    const last = urls[urls.length - 1];
    if (last) {
      return upgradeAmazonImageUrl(last) || null;
    }
  }

  const src =
    img.getAttribute('src')?.trim() ||
    img.getAttribute('data-src')?.trim() ||
    img.getAttribute('data-lazy-src')?.trim();
  if (
    src &&
    /^https?:\/\//i.test(src) &&
    !/badges\/|prime-badge|1x1|sprite|transparent-pixel|grey-pixel|nav-sprite/i.test(
      src,
    )
  ) {
    return upgradeAmazonImageUrl(src) || null;
  }

  return null;
}

/**
 * Normalizes a discount string ("-68%", "19% off") into `"68% off"`.
 */
export function normalizeDiscountBadge(
  raw: string | null | undefined,
): string | undefined {
  const text = normalizeWhitespace(raw);
  if (!text) return undefined;
  const match = /-\s*(\d{1,2})\s*%|(\d{1,2})\s*%\s*off/i.exec(text);
  const pct = match?.[1] ?? match?.[2];
  if (!pct) return undefined;
  const num = Number.parseInt(pct, 10);
  if (!Number.isFinite(num) || num <= 0 || num >= 100) return undefined;
  return `${num}% off`;
}

/**
 * Extracts selling price, currency, struck-through list price, discount percentage,
 * deal badge, and coupon from a product card or buybox container.
 * Never confuses struck-through list prices (`data-a-strike="true"`) with selling prices,
 * and never invents a discount or listPrice when none is in the DOM.
 */
export function extractCardPricingAndDiscounts(
  card: Element,
  pageUrl?: string,
): CardPricingAndDiscounts {
  const pageCurrency = resolvePageCurrency(pageUrl);
  let price: number | null = null;
  let currency: string | null = pageCurrency;
  let priceTier: AmazonExtractionTier = 'missing';

  // Tier 1: `data-p13n-asin-metadata` JSON price if present
  const metaRaw =
    card.getAttribute('data-p13n-asin-metadata') ??
    safeQuerySelector(card, '[data-p13n-asin-metadata]')?.getAttribute(
      'data-p13n-asin-metadata',
    );
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as {
        price?: number | string;
        currency?: string;
      };
      if (typeof meta.price === 'number' && Number.isFinite(meta.price)) {
        price = Math.round(meta.price * 100) / 100;
        currency = isIsoCurrency(meta.currency)
          ? meta.currency
          : pageCurrency ?? 'USD';
        priceTier = 'tier1_json';
      } else if (typeof meta.price === 'string') {
        const parsed = parsePrice(meta.price, pageCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency ?? pageCurrency ?? 'USD';
          priceTier = 'tier1_json';
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  // Tier 2a: `.a-price:not([data-a-strike="true"]) .a-offscreen`
  if (price === null) {
    const offscreenCandidates = safeQuerySelectorAll(
      card,
      '.a-price:not([data-a-strike="true"]) .a-offscreen, .priceToPay .a-offscreen, .apexPriceToPay .a-offscreen',
    );
    for (const el of offscreenCandidates) {
      if (el.closest('[data-a-strike="true"], .basisPrice, s, del')) continue;
      const parsed = parsePrice(el.textContent, pageCurrency);
      if (parsed.value !== null) {
        price = parsed.value;
        currency = parsed.currency ?? pageCurrency ?? 'USD';
        priceTier = 'tier2_semantic';
        break;
      }
    }
  }

  // Tier 2b: Split `.a-price-whole` + `.a-price-fraction` + `.a-price-symbol`
  if (price === null) {
    const priceBlock = safeQuerySelector(
      card,
      '.a-price:not([data-a-strike="true"])',
    );
    if (priceBlock && !priceBlock.closest('[data-a-strike="true"], .basisPrice')) {
      const wholeEl = safeQuerySelector(priceBlock, '.a-price-whole');
      const fractionEl = safeQuerySelector(priceBlock, '.a-price-fraction');
      const symbolEl = safeQuerySelector(priceBlock, '.a-price-symbol');
      const splitParsed = parsePriceFromElements(
        wholeEl,
        fractionEl,
        symbolEl,
        pageCurrency,
      );
      if (splitParsed.value !== null) {
        price = splitParsed.value;
        currency = splitParsed.currency ?? pageCurrency ?? 'USD';
        priceTier = 'tier2_semantic';
      }
    }
  }

  // Tier 4: Declarative fallback selectors (`._cDEzb_p13n-sc-price_3mJ9Z`, `.p13n-sc-price`, etc.)
  if (price === null) {
    for (const selector of AMAZON_SELECTORS.cardFields.sellingPrice) {
      const els = safeQuerySelectorAll(card, selector);
      for (const el of els) {
        if (el.closest('[data-a-strike="true"], .basisPrice, s, del')) continue;
        // Guard against matching rank `#1` or review counts on `.a-size-small`
        const rawText = normalizeWhitespace(el.textContent);
        if (!rawText || /^#\d+/.test(rawText)) continue;
        const parsed = parsePrice(rawText, pageCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency ?? pageCurrency ?? 'USD';
          priceTier = 'tier4_selector';
          break;
        }
      }
      if (price !== null) break;
    }
  }

  // Tier 3: Structural currency-symbol text scan inside card
  if (price === null) {
    const currencyTokenRegex =
      /(?:US\$|CA\$|AU\$|MX\$|S\$|R\$|[\$£€¥￥₹₺]|CHF|PLN|zł|SEK|kr|AED|SAR)\s*\d[\d.,'\s]*|\d[\d.,'\s]*\s*(?:€|zł|kr|TL|₺)/i;
    const nodes = safeQuerySelectorAll(card, 'span, div');
    for (const node of nodes) {
      if (node.children.length > 1) continue;
      if (node.closest('[data-a-strike="true"], .basisPrice, s, del')) continue;
      const rawText = normalizeWhitespace(node.textContent);
      if (!rawText || rawText.length > 32) continue;
      if (/coupon|save|off|voucher|rabatt/i.test(rawText)) continue;
      const match = currencyTokenRegex.exec(rawText);
      if (match?.[0]) {
        const parsed = parsePrice(match[0], pageCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency ?? pageCurrency ?? 'USD';
          priceTier = 'tier3_structural';
          break;
        }
      }
    }
  }

  // Struck-through List Price (`data-a-strike="true"` or `.basisPrice`)
  let listPrice: number | undefined;
  for (const selector of AMAZON_SELECTORS.cardFields.listPrice) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      if (!el?.textContent) continue;
      const parsed = parsePrice(el.textContent, currency ?? pageCurrency);
      if (
        parsed.value !== null &&
        (price === null || parsed.value > price)
      ) {
        listPrice = parsed.value;
        break;
      }
    }
    if (listPrice !== undefined) break;
  }

  // Explicit Discount Percentage (`-68%` -> `68% off`, `19% off` -> `19% off`)
  let discountPercentage: string | undefined;
  for (const selector of AMAZON_SELECTORS.cardFields.discount) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      if (el.children.length > 1) continue;
      const normalized = normalizeDiscountBadge(el?.textContent);
      if (normalized) {
        discountPercentage = normalized;
        break;
      }
    }
    if (discountPercentage !== undefined) break;
  }

  // Deal Badge (`Limited-time deal`, etc.)
  let dealBadge: string | undefined;
  for (const selector of AMAZON_SELECTORS.cardFields.dealBadge) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      const text = normalizeWhitespace(el?.textContent);
      if (
        text &&
        /deal|limited time|limited-time|lightning|black friday|prime day|cyber monday|angebot|offre|oferta/i.test(
          text,
        )
      ) {
        dealBadge = text;
        break;
      }
    }
    if (dealBadge !== undefined) break;
  }

  // Coupon (`Save 15% with coupon`, `Save $20.00 with coupon`)
  let coupon: string | undefined;
  for (const selector of AMAZON_SELECTORS.cardFields.coupon) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      const text = normalizeWhitespace(el?.textContent);
      if (text && /coupon|voucher|rabatt|remise/i.test(text)) {
        coupon = text.replace(/\s*Terms\s*$/i, '').trim();
        break;
      }
    }
    if (coupon !== undefined) break;
  }

  const result: CardPricingAndDiscounts = {
    price,
    currency: currency ?? pageCurrency ?? 'USD',
    priceTier,
  };
  if (listPrice !== undefined) result.listPrice = listPrice;
  if (discountPercentage !== undefined) {
    result.discountPercentage = discountPercentage;
  }
  if (dealBadge !== undefined) result.dealBadge = dealBadge;
  if (coupon !== undefined) result.coupon = coupon;

  return result;
}

/**
 * 4-Tier ASIN extraction from a product card element.
 */
export function extractCardAsinWithTier(
  card: Element,
): TieredValue<string | null> {
  // Tier 1: `data-p13n-asin-metadata` JSON
  const metaNode = card.hasAttribute('data-p13n-asin-metadata')
    ? card
    : safeQuerySelector(card, '[data-p13n-asin-metadata]');
  const rawMeta = metaNode?.getAttribute('data-p13n-asin-metadata');
  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta) as { asin?: string };
      const asin = normalizeASIN(parsed.asin);
      if (asin) {
        return { value: asin, tier: 'tier1_json' };
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  // Tier 2: `data-asin` attribute on card or child
  const directAsin = normalizeASIN(card.getAttribute('data-asin'));
  if (directAsin) {
    return { value: directAsin, tier: 'tier2_semantic' };
  }
  const nestedAsinEl = safeQuerySelector(card, '[data-asin]:not([data-asin=""])');
  const nestedAsin = normalizeASIN(nestedAsinEl?.getAttribute('data-asin'));
  if (nestedAsin) {
    return { value: nestedAsin, tier: 'tier2_semantic' };
  }

  // Tier 3: Structural `/dp/<ASIN>` or `/gp/product/<ASIN>` anchor discovery
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"], a[href*="/sspa/click"]',
  );
  for (const anchor of anchors) {
    const asin = extractASIN(anchor.getAttribute('href'));
    if (asin) {
      return { value: asin, tier: 'tier3_structural' };
    }
  }

  return { value: null, tier: 'missing' };
}

/**
 * 4-Tier Title & Brand extraction from a product card element.
 * Handles modern `data-cy="title-recipe"` cards where a standalone `<h2><span>Brand</span></h2>`
 * precedes `<a class="a-link-normal"><h2><span>Product Title</span></h2></a>`.
 */
export function extractCardTitleAndBrandWithTier(
  card: Element,
  asin?: string | null,
): { title: TieredValue<string>; brand: string | null } {
  let brand: string | null = null;

  // Check if `[data-cy="title-recipe"]` has a brand heading outside the main product link
  const titleRecipe = safeQuerySelector(card, '[data-cy="title-recipe"]');
  if (titleRecipe) {
    const allH2 = safeQuerySelectorAll(titleRecipe, 'h2');
    if (allH2.length >= 2) {
      const firstH2 = allH2[0]!;
      if (!firstH2.closest('a') && !safeQuerySelector(firstH2, 'a')) {
        brand = cleanBrand(firstH2.textContent);
      }
    }
  }

  if (!brand) {
    for (const selector of AMAZON_SELECTORS.cardFields.brand) {
      if (selector === '[data-cy="title-recipe"] > h2 > span') continue;
      const el = safeQuerySelector(card, selector);
      const cleaned = cleanBrand(el?.textContent);
      if (cleaned) {
        brand = cleaned;
        break;
      }
    }
  }

  // Tier 3: Adaptive structural scan for "Visit the <Brand> Store" or "Brand: <Brand>"
  if (!brand) {
    const leafNodes = safeQuerySelectorAll(card, 'div, span, a');
    for (const node of leafNodes) {
      if (node.children.length > 0) continue;
      const text = normalizeWhitespace(node.textContent);
      if (/^(?:Visit the\s+.+\s+Store|Brand:\s*.+)$/i.test(text)) {
        brand = cleanBrand(text);
        if (brand) break;
      }
    }
  }

  // Tier 2: Semantic link heading inside `[data-cy="title-recipe"]` or `h2 a`
  const semanticSelectors = [
    '[data-cy="title-recipe"] a h2 span',
    '[data-cy="title-recipe"] h2 a span',
    'h2 a.a-link-normal span',
    'h2 a span',
    '[data-testid="product-card-title"]',
    '[data-testid="deal-title"]',
  ];
  for (const selector of semanticSelectors) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (text && text.length >= 2) {
      return {
        title: { value: text, tier: 'tier2_semantic' },
        brand,
      };
    }
  }

  // Tier 4: Declarative selector registry
  for (const selector of AMAZON_SELECTORS.cardFields.title) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      const text = normalizeWhitespace(el.textContent);
      if (text && text !== brand && text.length >= 2) {
        return {
          title: { value: text, tier: 'tier4_selector' },
          brand,
        };
      }
    }
  }

  // Tier 3: Structural `/dp/<ASIN>` anchor text fallback
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/sspa/click"]',
  );
  let bestText = '';
  for (const anchor of anchors) {
    if (asin) {
      const linkAsin = extractASIN(anchor.getAttribute('href'));
      if (linkAsin && linkAsin !== asin) continue;
    }
    const candidate =
      normalizeWhitespace(anchor.getAttribute('title')) ||
      normalizeWhitespace(anchor.textContent);
    if (
      candidate.length > bestText.length &&
      candidate !== brand &&
      !/^\$?\d+[.,]\d{2}$/.test(candidate) &&
      !/^\d[\d,.]*$/.test(candidate)
    ) {
      bestText = candidate;
    }
  }
  if (bestText.length >= 2) {
    return {
      title: { value: bestText, tier: 'tier3_structural' },
      brand,
    };
  }

  return {
    title: { value: '', tier: 'missing' },
    brand,
  };
}

export function extractCardRatingAndReviewsWithTier(card: Element): {
  rating: TieredValue<number | null>;
  reviewCount: TieredValue<number | null>;
} {
  let rating: number | null = null;
  let ratingTier: AmazonExtractionTier = 'missing';
  let reviewCount: number | null = null;
  let reviewTier: AmazonExtractionTier = 'missing';

  for (const selector of AMAZON_SELECTORS.cardFields.rating) {
    const el = safeQuerySelector(card, selector);
    if (!el) continue;
    const raw =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent;
    const parsed = parseRating(raw);
    if (parsed !== null) {
      rating = parsed;
      ratingTier =
        selector.includes('data-cy') || selector.includes('aria-label')
          ? 'tier2_semantic'
          : 'tier4_selector';
      break;
    }
  }

  for (const selector of [
    ...AMAZON_SELECTORS.cardFields.reviewCount,
    'a[href*="#customerReviews"]',
    'a[href*="product-reviews"]',
  ]) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      const raw = el.getAttribute('aria-label') || el.textContent;
      const parsed = parseReviewCount(raw);
      if (parsed !== null) {
        reviewCount = parsed;
        reviewTier =
          selector.includes('data-cy') || selector.includes('aria-label')
            ? 'tier2_semantic'
            : 'tier3_structural';
        break;
      }
    }
    if (reviewCount !== null) break;
  }

  return {
    rating: { value: rating, tier: ratingTier },
    reviewCount: { value: reviewCount, tier: reviewTier },
  };
}

export function extractCardImageWithTier(
  card: Element,
): TieredValue<string | null> {
  const images = safeQuerySelectorAll<HTMLImageElement>(
    card,
    [...AMAZON_SELECTORS.cardFields.image, 'img'].join(', '),
  );
  for (const img of images) {
    const best = extractBestImageUrl(img);
    if (best) {
      const hasDynamic =
        img.hasAttribute('data-old-hires') ||
        img.hasAttribute('data-a-hires') ||
        img.hasAttribute('data-a-dynamic-image');
      return {
        value: best,
        tier: hasDynamic
          ? 'tier1_json'
          : img.classList.contains('s-image')
            ? 'tier2_semantic'
            : 'tier3_structural',
      };
    }
  }
  return { value: null, tier: 'missing' };
}

export function extractCardPastMonthSales(card: Element): string | undefined {
  const candidates = safeQuerySelectorAll(card, 'span, div');
  for (const el of candidates) {
    if (el.children.length > 1) continue;
    const text = normalizeWhitespace(el.textContent);
    const match = PAST_MONTH_SALES_REGEX.exec(text);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function extractCardBadge(card: Element): string | undefined {
  for (const selector of AMAZON_SELECTORS.cardFields.statusBadge) {
    const el = safeQuerySelector(card, selector);
    const text = normalizeWhitespace(el?.textContent);
    if (
      text &&
      /best seller|amazon's choice|overall pick|popular|new release|most wished/i.test(
        text,
      )
    ) {
      return text;
    }
  }
  return undefined;
}

export function extractCardDeliveryAndAvailability(card: Element): {
  delivery?: string;
  availability: string | null;
} {
  let delivery: string | undefined;
  let availability: string | null = null;

  const deliveryBlock = safeQuerySelector(card, '[data-cy="delivery-recipe"]');
  if (deliveryBlock) {
    const stockSpan = safeQuerySelector(deliveryBlock, '.a-color-price');
    const stockText = normalizeWhitespace(stockSpan?.textContent);
    if (stockText && /left in stock|out of stock|unavailable/i.test(stockText)) {
      availability = stockText;
    }

    const ariaEl = safeQuerySelector(deliveryBlock, '[aria-label]');
    const ariaText = normalizeWhitespace(
      ariaEl?.getAttribute('aria-label') || ariaEl?.textContent,
    );
    if (ariaText && /delivery|lieferung|livraison|entrega/i.test(ariaText)) {
      delivery = ariaText;
    } else if (!availability) {
      const fallbackText = normalizeWhitespace(deliveryBlock.textContent);
      if (
        fallbackText &&
        /delivery|lieferung|livraison|entrega/i.test(fallbackText)
      ) {
        delivery = fallbackText;
      }
    }
  }

  if (!availability) {
    const leafNodes = safeQuerySelectorAll(card, 'div, span');
    for (const node of leafNodes) {
      if (node.children.length > 0) continue;
      const text = normalizeWhitespace(node.textContent);
      if (
        /^(?:In Stock\.?|Only \d+ left in stock[^.]*\.?|Temporarily out of stock\.?|Currently unavailable\.?)$/i.test(
          text,
        )
      ) {
        availability = text;
        break;
      }
    }
  }

  return { delivery, availability };
}

export function extractCardSeller(card: Element): string | null {
  const offerBlock = safeQuerySelector(
    card,
    '[data-cy="secondary-offer-recipe"]',
  );
  if (offerBlock) {
    const text = normalizeWhitespace(offerBlock.textContent);
    if (/sold by/i.test(text)) {
      return cleanSeller(text);
    }
  }

  const leafNodes = safeQuerySelectorAll(card, 'div, span');
  for (const node of leafNodes) {
    if (node.children.length > 0) continue;
    const text = normalizeWhitespace(node.textContent);
    if (/^(?:Ships from and sold by|Sold by)\s+.+/i.test(text)) {
      const cleaned = cleanSeller(text);
      if (cleaned) return cleaned;
    }
  }

  return null;
}

export function extractCardIsPrime(
  card: Element,
  deliveryText?: string,
): boolean {
  for (const selector of [
    ...AMAZON_SELECTORS.cardFields.prime,
    '[aria-label*="Prime" i]',
  ]) {
    if (safeQuerySelector(card, selector)) {
      return true;
    }
  }
  if (deliveryText && /\bFREE delivery\b/i.test(deliveryText)) {
    return true;
  }
  return false;
}

export function extractCardIsSponsored(card: Element): boolean {
  if (
    card.getAttribute('data-component-type') === 'sp-sponsored-result' ||
    card.classList.contains('AdHolder')
  ) {
    return true;
  }
  for (const selector of AMAZON_SELECTORS.cardFields.sponsored) {
    const el = safeQuerySelector(card, selector);
    if (el) {
      const text = normalizeWhitespace(
        el.getAttribute('aria-label') || el.textContent,
      );
      if (
        !text ||
        /sponsored|gesponsert|sponsorisé|patrocinado|スポンサー/i.test(text)
      ) {
        return true;
      }
    }
  }
  const leafNodes = safeQuerySelectorAll(card, 'span, div');
  for (const node of leafNodes) {
    if (node.children.length > 0) continue;
    const text = normalizeWhitespace(node.textContent);
    if (/^(?:Sponsored|Gesponsert|Sponsorisé|Patrocinado|スポンサー)$/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates and normalizes a raw scraped product candidate into a clean `ScrapedAmazonProduct`.
 * Logs a warning and returns `null` when invalid or if a property getter throws.
 */
export function validateAndNormalizeScrapedProduct(
  raw: Partial<ScrapedAmazonProduct> | null | undefined,
  pageUrl?: string,
): ScrapedAmazonProduct | null {
  if (!raw || typeof raw !== 'object') return null;

  try {
    const asin = normalizeASIN(raw.asin);
    if (!asin || !isValidASIN(asin)) {
      return null;
    }

    const source: ProductSource =
      raw.source === 'search' ||
      raw.source === 'category' ||
      raw.source === 'detail'
        ? raw.source
        : 'search';

    const url = resolveProductUrl(raw.url, asin, pageUrl);
    if (!url || !/^https?:\/\//i.test(url)) {
      return null;
    }

    const title = raw.title ? normalizeWhitespace(raw.title) : null;
    if (!title) {
      return null;
    }

    const pageCurrency = resolvePageCurrency(pageUrl || url);
    const currency = isIsoCurrency(raw.currency)
      ? raw.currency
      : pageCurrency ?? 'USD';

    const price =
      typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price >= 0
        ? Math.round(raw.price * 100) / 100
        : null;

    const rating =
      typeof raw.rating === 'number' &&
      Number.isFinite(raw.rating) &&
      raw.rating >= 0 &&
      raw.rating <= 5
        ? Math.round(raw.rating * 10) / 10
        : null;

    const reviewCount =
      typeof raw.reviewCount === 'number' &&
      Number.isFinite(raw.reviewCount) &&
      raw.reviewCount >= 0
        ? Math.trunc(raw.reviewCount)
        : null;

    const imageUrl =
      typeof raw.imageUrl === 'string' && /^https?:\/\//i.test(raw.imageUrl)
        ? raw.imageUrl
        : null;

    const normalized: ScrapedAmazonProduct = {
      asin,
      url,
      title,
      price,
      currency,
      rating,
      reviewCount,
      imageUrl,
      isSponsored: Boolean(raw.isSponsored),
      isPrime: Boolean(raw.isPrime),
      brand: raw.brand ?? null,
      availability: raw.availability ?? null,
      seller: raw.seller ?? null,
      description: raw.description ?? null,
      features: Array.isArray(raw.features) ? raw.features : [],
      source,
    };

    if (
      typeof raw.listPrice === 'number' &&
      Number.isFinite(raw.listPrice) &&
      raw.listPrice > 0
    ) {
      normalized.listPrice = Math.round(raw.listPrice * 100) / 100;
    }
    if (raw.discountPercentage) {
      normalized.discountPercentage = raw.discountPercentage;
    }
    if (raw.dealBadge) {
      normalized.dealBadge = raw.dealBadge;
    }
    if (raw.bestSellersRank) {
      normalized.bestSellersRank = raw.bestSellersRank;
    }
    if (raw.pastMonthSales) {
      normalized.pastMonthSales = raw.pastMonthSales;
    }
    if (raw.coupon) {
      normalized.coupon = raw.coupon;
    }
    if (raw.badge) {
      normalized.badge = raw.badge;
    }
    if (raw.delivery) {
      normalized.delivery = raw.delivery;
    }

    return normalized;
  } catch (err) {
    console.warn('[PPHunt] validateAndNormalizeScrapedProduct failed:', err);
    return null;
  }
}

/**
 * Tier 3 Structural Card Discovery:
 * Discovers product card containers via `/dp/<ASIN>` links when semantic card attributes are absent.
 */
export function discoverStructuralProductCards(root: ParentNode): Element[] {
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    root,
    'a[href*="/dp/"], a[href*="/gp/product/"]',
  );
  const anchorsByAsin = new Map<string, HTMLAnchorElement[]>();
  const anchorAsinMap = new WeakMap<HTMLAnchorElement, string>();

  for (const anchor of anchors) {
    if (
      anchor.closest(
        '.a-carousel-card, [id*="sp_detail"], [id*="sims-consolidated"]',
      )
    ) {
      continue;
    }
    const asin = extractASIN(anchor.getAttribute('href'));
    if (!asin) continue;
    anchorAsinMap.set(anchor, asin);
    const list = anchorsByAsin.get(asin) ?? [];
    list.push(anchor);
    anchorsByAsin.set(asin, list);
  }

  const discovered: Element[] = [];
  for (const [asin, asinAnchors] of anchorsByAsin.entries()) {
    const primary = asinAnchors[0];
    if (!primary) continue;

    let current: Element | null = primary.parentElement;
    let best: Element | null = null;
    let depth = 0;

    while (
      current &&
      current !== (root as unknown as Element) &&
      current.tagName !== 'BODY' &&
      current.tagName !== 'MAIN' &&
      depth < 8
    ) {
      const childAnchors = safeQuerySelectorAll<HTMLAnchorElement>(
        current,
        'a[href*="/dp/"], a[href*="/gp/product/"]',
      );
      let hasForeignAsin = false;
      for (const child of childAnchors) {
        const childAsin =
          anchorAsinMap.get(child) ?? extractASIN(child.getAttribute('href'));
        if (childAsin && childAsin !== asin) {
          hasForeignAsin = true;
          break;
        }
      }
      if (hasForeignAsin) break;

      best = current;
      current = current.parentElement;
      depth += 1;
    }

    if (best) {
      discovered.push(best);
    }
  }

  return dropNestedCards(discovered, { dropDuplicates: true });
}
