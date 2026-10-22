import type {
  AmazonExtractionTier,
  AmazonListingCategory,
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
import {
  DEAL_LABEL_PATTERN,
  deriveDealFromPrices,
  detectDealEvidence,
} from './deal-evidence';
import type { AmazonTrackedField } from './drift-telemetry';
import {
  AMAZON_SELECTORS,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

export interface TieredValue<T> {
  value: T;
  tier: AmazonExtractionTier;
  /**
   * SAD-383: whether a candidate node was found at all, independent of whether
   * its text parsed. A card layout that prints no rating produces no node; a
   * layout that prints one the parser refuses produces a node and no value.
   * Only diagnostics read this — extraction output is unchanged.
   */
  nodeSeen?: boolean;
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
  /**
   * SAD-369 D9 (diagnostics-only): the first cascade tier that FOUND a price
   * node whose text would not parse, when no tier produced a price. Lets the
   * card report say PARSE_FAILED instead of claiming the price was absent.
   * Ignored by every existing consumer; the extracted price, currency and
   * priceTier are byte-identical with and without it.
   */
  unparseablePriceTier?: AmazonExtractionTier;
  /**
   * SAD-386 (diagnostics-only): a discount-looking node was present but its
   * text did not normalise to a percentage (e.g. a coupon-style "Save 15% with
   * coupon", a bare out-of-range "100%", or a currency amount). Lets the card
   * report say PARSE_FAILED instead of claiming the discount was absent.
   */
  unparseableDiscountNode?: boolean;
  /** SAD-386 (diagnostics-only): the deal value came from evidence, not a printed badge. */
  dealBadgeDerived?: boolean;
  /** SAD-389: an eligible coupon node existed but its offer text was rejected. */
  unparseableCouponNode?: boolean;
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

const NON_CONTENT_TAG_NAMES = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
]);

const BLOCK_BOUNDARY_TAG_NAMES = new Set([
  'DIV',
  'P',
  'LI',
  'TR',
  'BR',
]);

function isExcludedCleanTextElement(
  el: Element,
  extraExcludeClass?: string,
): boolean {
  if (NON_CONTENT_TAG_NAMES.has(el.tagName)) return true;
  if (el.hasAttribute('hidden')) return true;
  const cls = el.classList;
  if (
    cls &&
    (cls.contains('aok-hidden') ||
      cls.contains('a-hidden') ||
      cls.contains('a-popover-preload') ||
      (extraExcludeClass !== undefined && cls.contains(extraExcludeClass)))
  ) {
    return true;
  }
  return false;
}

/**
 * SAD-390: Extracts human-visible text from an element without cloning or
 * mutating the DOM, skipping `<script>`, `<style>`, `<noscript>`, `<template>`,
 * and hidden/preload subtrees while preserving whitespace across block rows.
 */
export function extractCleanElementText(
  root: Element | null | undefined,
  extraExcludeClass?: string,
): string {
  if (!root || isExcludedCleanTextElement(root, extraExcludeClass)) return '';
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      if (node.nodeValue) parts.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (isExcludedCleanTextElement(el, extraExcludeClass)) return;

    const isBlock = BLOCK_BOUNDARY_TAG_NAMES.has(el.tagName);
    if (isBlock) parts.push(' ');
    for (let child = el.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
    if (isBlock) parts.push(' ');
  };

  for (let child = root.firstChild; child; child = child.nextSibling) {
    walk(child);
  }

  return normalizeWhitespace(parts.join(''));
}

export function cleanSeller(raw: string | null | undefined): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  let cleaned = text;

  // Handle combined abbreviated rows: "Ships from: Amazon.com Sold by: Amazon.com"
  const soldByAfterShipsFrom =
    /\b(?:Sold by|Verkauf durch|Vendu par|Vendido por)\s*(?::\s*|\s+)(.+)$/i.exec(
      cleaned,
    );
  if (soldByAfterShipsFrom?.[1] && /\bShips from\b/i.test(cleaned)) {
    cleaned = soldByAfterShipsFrom[1];
  }

  cleaned = cleaned
    .replace(/^Ships from and sold by\s*:?\s*/i, '')
    .replace(/^Shipper\s*\/\s*Seller\s*:?\s*/i, '')
    .replace(/^(?:Sold by|Verkauf durch|Vendu par|Vendido por)\s*:?\s*/i, '')
    .replace(/\s+and\s+Fulfilled by Amazon\.?$/i, '')
    .replace(/\s*\(\d+\s+used\s*&\s*new\s+offers?\)$/i, '')
    .replace(/\.$/, '')
    .trim();

  if (
    !cleaned ||
    /^(?:Fulfilled by Amazon|Ships from(?:\s+and\s+sold\s+by)?|Sold by|Shipper\s*\/\s*Seller)$/i.test(
      cleaned,
    )
  ) {
    return null;
  }

  return cleaned;
}

/** SAD-349: spelled-out quantities Amazon writes into warranty cells. */
const WARRANTY_WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
  sixty: 60,
  ninety: 90,
  'twenty-one': 21,
  'twenty-two': 22,
  'twenty-three': 23,
  'twenty-four': 24,
  'twenty-five': 25,
  'thirty-six': 36,
  'sixty-four': 64,
};

/**
 * SAD-349: `<quantity><unit>` inside a warranty cell. Compound spelled numbers
 * are listed first so "twenty-four year" cannot be mis-read as "four year", and
 * the unit alternation accepts every plural/abbrev spelling Amazon uses.
 *
 * SAD-393: three narrow extensions, each pinned by the P-W2 probe table:
 * - the consumed prefix `(?:^|[^\w.,])` (the weight matcher's shape) stops a
 *   quantity from starting *mid-number* — "1.5 years" used to match the "5"
 *   and store `5-year`, wrong data rather than missing data;
 * - `\d{1,3}(?:\.\d+)?` accepts the fraction the seller printed, emitting the
 *   exact token (`1.5-year`);
 * - `(5)` accepts the parenthesized digit of "Five (5) Year" / "One (1) Year",
 *   the form device/tool manufacturers print (the bare word alone fails
 *   there: the parenthesis blocks the unit).
 */
const WARRANTY_DURATION_RE =
  /(?:^|[^\w.,])(\(\s*\d{1,3}\s*\)|(?:twenty|thirty|sixty|ninety)[\s-](?:one|two|three|four|five|six|seven|eight|nine)|\d{1,3}(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|thirty|sixty|ninety)[\s-]*(years?|yrs?|months?|mos?|days?|weeks?)\b/i;

/** Maps each unit spelling onto the one canonical singular form. */
const WARRANTY_UNIT_CANONICAL: Readonly<Record<string, string>> = {
  year: 'year',
  years: 'year',
  yr: 'year',
  yrs: 'year',
  month: 'month',
  months: 'month',
  mo: 'month',
  mos: 'month',
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
};

/**
 * SAD-349: reduces an Amazon warranty cell to a compact, sortable token
 * (`1-year`, `2-year`, `90-day`, `lifetime`; SAD-393 adds the seller's exact
 * fraction when printed, e.g. `1.5-year`).
 *
 * Returning `null` when the cell states no coverage period is deliberate and
 * load-bearing. The "Warranty & Support" block on essentially every amazon.com
 * page reads *"Product Warranty: For warranty information about this product,
 * please click here"* — a link, not data. Requiring a duration token rejects
 * that boilerplate **structurally**, so there is no denylist to maintain and a
 * new boilerplate variant cannot slip through.
 *
 * Two documented consequences:
 * - the **first** duration wins, so a cell quoting a secondary period
 *   ("...or 90 days from shipment, whichever is longer") keeps the leading,
 *   primary one;
 * - the qualifier is dropped — the caller keeps the verbatim cell in
 *   `warrantyDescriptionRaw` so nothing is lost.
 */
export function normalizeWarrantyDescription(
  raw: string | null | undefined,
): string | null {
  // SAD-393: fold typographic dashes (U+2010–U+2015, U+2212 — the SAD-386
  // discount set) to '-' inside THIS function only. Sellers print them
  // ("2–year", "2 year"); the shared `normalizeWhitespace` stays untouched
  // so no other field's parsing changes. `warrantyDescriptionRaw` is the
  // caller's verbatim cell and is not affected.
  const text = normalizeWhitespace(raw).replace(/[\u2010-\u2015\u2212]/g, '-');
  if (!text) return null;

  // "Limited lifetime warranty" states coverage that is not a duration.
  if (/\blifetime\b/i.test(text)) return 'lifetime';

  const match = WARRANTY_DURATION_RE.exec(text);
  if (!match) return null;

  // Parentheses belong to the "(5)" form only; stripping them leaves the
  // plain digit (or word-number) the quantity lookup below already knows.
  const quantityText = match[1]!
    .toLowerCase()
    .replace(/[()]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  const quantity = /^\d+(?:\.\d+)?$/.test(quantityText)
    ? Number.parseFloat(quantityText)
    : WARRANTY_WORD_NUMBERS[quantityText];
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  const unit = WARRANTY_UNIT_CANONICAL[match[2]!.toLowerCase()];
  if (!unit) return null;

  return `${quantity}-${unit}`;
}

const WEIGHT_UNIT_CANONICAL: Record<
  string,
  { singular: string; plural: string }
> = {
  mg: { singular: 'mg', plural: 'mg' },
  milligram: { singular: 'mg', plural: 'mg' },
  milligrams: { singular: 'mg', plural: 'mg' },
  g: { singular: 'g', plural: 'g' },
  gm: { singular: 'g', plural: 'g' },
  gms: { singular: 'g', plural: 'g' },
  gram: { singular: 'g', plural: 'g' },
  grams: { singular: 'g', plural: 'g' },
  gramm: { singular: 'g', plural: 'g' },
  grammes: { singular: 'g', plural: 'g' },
  kg: { singular: 'kg', plural: 'kg' },
  kgs: { singular: 'kg', plural: 'kg' },
  kilogram: { singular: 'kg', plural: 'kg' },
  kilograms: { singular: 'kg', plural: 'kg' },
  kilogramm: { singular: 'kg', plural: 'kg' },
  kilogrammes: { singular: 'kg', plural: 'kg' },
  oz: { singular: 'oz', plural: 'oz' },
  ounce: { singular: 'oz', plural: 'oz' },
  ounces: { singular: 'oz', plural: 'oz' },
  lb: { singular: 'lb', plural: 'lbs' },
  lbs: { singular: 'lb', plural: 'lbs' },
  pound: { singular: 'lb', plural: 'lbs' },
  pounds: { singular: 'lb', plural: 'lbs' },
};

const COMPOUND_IMPERIAL_WEIGHT_RE =
  /(?:^|[^\d.])(\d+(?:[.,]\d+)?)\s*(lbs?|pounds?)\.?\s+(\d+(?:[.,]\d+)?)\s*(oz|ounces?)\.?(?![a-zA-Z])/i;

const SINGLE_WEIGHT_RE =
  /(?:^|[^\d.])(\d+(?:[.,]\d+)?)\s*(mg|milligrams?|g|gms?|grams?|gramm|grammes|kgs?|kilograms?|kilogramm|kilogrammes|oz|ounces?|lbs?|pounds?)\.?(?![a-zA-Z])/i;

function parsePositiveWeightNumber(rawNum: string): {
  numeric: number;
  display: string;
} | null {
  let cleaned = rawNum.trim();
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned =
      cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')
        ? cleaned.replace(/,/g, '')
        : cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    cleaned = /^[1-9]\d{0,2}(?:,\d{3})+$/.test(cleaned)
      ? cleaned.replace(/,/g, '')
      : /,\d{1,3}$/.test(cleaned)
        ? cleaned.replace(',', '.')
        : cleaned.replace(/,/g, '');
  }
  const numeric = Number.parseFloat(cleaned);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return { numeric, display: String(Number(cleaned)) };
}

/**
 * SAD-357: cleans an Amazon weight cell into a canonical value + unit string
 * (e.g. `"0.19 kg"`, `"9.12 oz"`, `"1.73 lbs"`, `"1 lb 4 oz"`).
 * Returns `null` when no positive physical mass unit is present.
 */
export function normalizeWeightValue(
  raw: string | null | undefined,
): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  const compound = COMPOUND_IMPERIAL_WEIGHT_RE.exec(text);
  if (compound) {
    const lbParsed = parsePositiveWeightNumber(compound[1]!);
    const ozParsed = parsePositiveWeightNumber(compound[3]!);
    if (lbParsed && ozParsed) {
      const lbUnit = lbParsed.numeric === 1 ? 'lb' : 'lbs';
      return `${lbParsed.display} ${lbUnit} ${ozParsed.display} oz`;
    }
  }

  const single = SINGLE_WEIGHT_RE.exec(text);
  if (!single) return null;

  const parsed = parsePositiveWeightNumber(single[1]!);
  if (!parsed) return null;

  const unitSpec = WEIGHT_UNIT_CANONICAL[single[2]!.toLowerCase()];
  if (!unitSpec) return null;

  const unitLabel =
    parsed.numeric === 1 ? unitSpec.singular : unitSpec.plural;
  return `${parsed.display} ${unitLabel}`;
}

export interface VariationDimensionSummaryInput {
  label: string;
  values: readonly string[];
}

/**
 * SAD-357: formats structured variation dimensions and total count into a
 * lossless human-readable string (full values preserved for exports and
 * SAD-358's CellExpandModal; clamped via `line-clamp-1` inside the table cell).
 * Returns `null` for singletons (`totalVariations <= 1` and `<= 1` option per dim).
 */
export function formatVariationDimensionsSummary(
  dimensions: readonly VariationDimensionSummaryInput[],
  totalVariations?: number | null,
): string | null {
  const cleanedDims: Array<{ label: string; values: string[] }> = [];

  for (const dim of dimensions) {
    const label = normalizeWhitespace(dim.label).replace(/:+$/, '').trim();
    if (!label) continue;
    const uniqueValues: string[] = [];
    for (const rawVal of dim.values) {
      const val = normalizeWhitespace(rawVal);
      if (val && !uniqueValues.includes(val)) {
        uniqueValues.push(val);
      }
    }
    if (uniqueValues.length > 0) {
      cleanedDims.push({ label, values: uniqueValues });
    }
  }

  const hasMultiOptionDim = cleanedDims.some((d) => d.values.length > 1);
  const validTotal =
    typeof totalVariations === 'number' && Number.isFinite(totalVariations)
      ? Math.trunc(totalVariations)
      : null;

  if ((validTotal === null || validTotal <= 1) && !hasMultiOptionDim) {
    return null;
  }

  const dimSummary = cleanedDims
    .map(({ label, values }) => `${label}: ${values.join(', ')}`)
    .join('; ');

  if (validTotal !== null && validTotal > 1 && dimSummary) {
    return `${validTotal} (${dimSummary})`;
  }
  if (dimSummary) {
    const inferredCount =
      cleanedDims.length === 1
        ? cleanedDims[0]!.values.length
        : Math.max(...cleanedDims.map((d) => d.values.length));
    return `${inferredCount} (${dimSummary})`;
  }
  if (validTotal !== null && validTotal > 1) {
    return `${validTotal} variations`;
  }
  return null;
}

const SWATCH_REMAINING_RE =
  /^\+\s*(\d+)\s+(?:other\s+)?(colors?(?:\/patterns?)?|patterns?|sizes?|styles?|flavors?|scents?|options?|designs?)\b/i;

/**
 * SAD-357: extracts variation hints from search/category result cards using
 * Amazon's `.s-color-swatch-container` region (immune to sustainability badges).
 */
export function extractCardVariations(card: Element): string | undefined {
  const container = safeQuerySelector(
    card,
    AMAZON_SELECTORS.cardFields.variationSwatches.containers,
  );
  if (!container) return undefined;

  const swatchNames: string[] = [];
  const swatchLinks = safeQuerySelectorAll(
    container,
    AMAZON_SELECTORS.cardFields.variationSwatches.swatchLinks,
  );
  for (const link of swatchLinks) {
    const rawLabel = normalizeWhitespace(
      link.getAttribute('aria-label') ||
        link.querySelector('img')?.getAttribute('alt'),
    );
    if (
      !rawLabel ||
      /^colors?\s+available$/i.test(rawLabel) ||
      SWATCH_REMAINING_RE.test(rawLabel)
    ) {
      continue;
    }
    if (!swatchNames.includes(rawLabel)) {
      swatchNames.push(rawLabel);
    }
  }

  let extraCount = 0;
  let overflowText: string | null = null;
  const moreNodes = safeQuerySelectorAll(
    container,
    AMAZON_SELECTORS.cardFields.variationSwatches.moreLinks,
  );
  for (const node of moreNodes) {
    const candidate = normalizeWhitespace(
      node.getAttribute('data-csa-c-swatch-remaining-count') ||
        node.getAttribute('aria-label') ||
        node.textContent,
    );
    const match = SWATCH_REMAINING_RE.exec(candidate);
    if (match) {
      extraCount = Number.parseInt(match[1]!, 10);
      overflowText = candidate;
      break;
    }
  }

  if (swatchNames.length > 0 && extraCount > 0) {
    const total = swatchNames.length + extraCount;
    return `${total} (Color: ${swatchNames.join(', ')}, +${extraCount} more)`;
  }

  if (swatchNames.length >= 2) {
    return (
      formatVariationDimensionsSummary(
        [{ label: 'Color', values: swatchNames }],
        swatchNames.length,
      ) ?? undefined
    );
  }

  if (extraCount > 0 && overflowText) {
    const total = (swatchNames.length || 1) + extraCount;
    return `${total} (${overflowText})`;
  }

  return undefined;
}

/**
 * SAD-351: a URL that plainly names an image file.
 *
 * Used only to *rank* `srcset` candidates against each other (and against
 * `currentSrc`), never to reject one. A hard rule would have caught the
 * deal-page bug, but it would also start dropping URLs that work today on page
 * types this fix must not touch (PDP hero images, offscreen enrichment,
 * one-click saves), so the guard stays a preference.
 */
const IMAGE_FILE_URL_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;

/**
 * SAD-351: a comma separates `srcset` candidates only when the next token
 * starts a URL.
 *
 * Amazon embeds commas *inside* the file name of its size token on the
 * `/deals` `ProductCard` grid (`…_AC_SF226,226_QL85_.jpg`), so the usual
 * `split(',')` shortcut truncates the file name and yields a URL the media CDN
 * answers with HTTP 400 (`…_AC_SF452`). Splitting on "comma followed by a URL"
 * keeps those names intact and is a no-op for the comma-free srcsets used by
 * search and best-seller cards.
 */
const SRCSET_SEPARATOR_RE = /,\s*(?=(?:https?:)?\/\/)/i;

/** `1x`, `1.5x`, `226w` — the optional candidate descriptor. */
const SRCSET_DESCRIPTOR_RE = /^(\d+(?:\.\d+)?)(w|x)$/i;

interface ImageCandidate {
  url: string;
  /** Higher wins within the same `renderable` class. `452w` → 452, `2x` → 2000. */
  score: number;
  /** The URL names an image file (`IMAGE_FILE_URL_RE`). */
  renderable: boolean;
}

/**
 * Parses one `srcset` attribute into candidates, keeping the commas that
 * belong to a file name (SAD-351). Fragments that do not start with a URL are
 * dropped, exactly as the previous `split(',')` implementation dropped them.
 */
function parseSrcsetCandidates(
  raw: string | null | undefined,
): ImageCandidate[] {
  if (!raw) return [];
  const candidates: ImageCandidate[] = [];
  for (const part of raw.split(SRCSET_SEPARATOR_RE)) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url || !/^(?:https?:)?\/\//i.test(url)) continue;
    const match = descriptor ? SRCSET_DESCRIPTOR_RE.exec(descriptor) : null;
    const score = match
      ? Number(match[1]) * (match[2]!.toLowerCase() === 'x' ? 1000 : 1)
      : 1;
    candidates.push({ url, score, renderable: IMAGE_FILE_URL_RE.test(url) });
  }
  return candidates;
}

/**
 * Picks the candidate the browser would have shown: the highest descriptor,
 * with "names a real image file" breaking every tie (SAD-351). Equal
 * candidates keep the later one, which preserves the previous
 * "last candidate wins" selection. When no candidate is renderable the best
 * one is still returned, so permissive inputs keep their previous result.
 */
function pickBestImageCandidate(
  candidates: readonly ImageCandidate[],
): string | null {
  let best: ImageCandidate | null = null;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.renderable !== best.renderable) {
      if (candidate.renderable) best = candidate;
      continue;
    }
    if (candidate.score >= best.score) {
      best = candidate;
    }
  }
  return best?.url ?? null;
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

  // SAD-351: `currentSrc` is the URL the browser actually fetched, so it cannot
  // contain a `srcset` split artefact. It is empty while an image is unladen
  // (and always empty in jsdom), and it ranks below every parsed candidate so
  // the existing `2x` selection on search / best-seller / PDP pages is kept.
  const currentSrcValue =
    typeof (img as Partial<HTMLImageElement>).currentSrc === 'string'
      ? ((img as Partial<HTMLImageElement>).currentSrc as string).trim()
      : '';

  const bestImageUrl = pickBestImageCandidate([
    ...parseSrcsetCandidates(srcset),
    ...(/^https?:\/\//i.test(currentSrcValue)
      ? [
          {
            url: currentSrcValue,
            score: 0,
            renderable: IMAGE_FILE_URL_RE.test(currentSrcValue),
          },
        ]
      : []),
  ]);
  if (bestImageUrl) {
    return upgradeAmazonImageUrl(bestImageUrl) || null;
  }

  const src =
    img.getAttribute('src')?.trim() ||
    img.getAttribute('data-src')?.trim() ||
    img.getAttribute('data-lazy-src')?.trim();
  if (
    src &&
    /^https?:\/\//i.test(src) &&
    !/badges\/|prime-badge|1x1|sprite|transparent-pixel|grey-pixel|nav-sprite|\/impb\?|sponsored-ads\.amazon\.[^/]+\/px|aax-[^/]+\/e\/is\//i.test(
      src,
    )
  ) {
    return upgradeAmazonImageUrl(src) || null;
  }

  return null;
}

interface ParsedAsinAdAttributesProps {
  asin?: string;
  imageUrl?: string;
  dealString?: string;
  title?: string;
  rating?: number | null;
  reviewCount?: number | null;
}

function parseAsinAdAttributesProps(
  card: Element,
): ParsedAsinAdAttributesProps | null {
  const attrNode = card.hasAttribute('data-asinadattributesprops')
    ? card
    : safeQuerySelector(card, '[data-asinadattributesprops]');
  const raw = attrNode?.getAttribute('data-asinadattributesprops');
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      asin?: string;
      imageUrl?: string;
      dealString?: string;
      productComponents?: {
        title?: string;
        imageUrl?: string;
        customerReviews?: string | { ratingValue?: string | number; rating?: string; count?: string | number };
      };
    };
    const out: ParsedAsinAdAttributesProps = {};
    if (typeof parsed.asin === 'string') out.asin = parsed.asin;
    const imgUrl = parsed.productComponents?.imageUrl ?? parsed.imageUrl;
    if (typeof imgUrl === 'string' && /^https?:\/\//i.test(imgUrl)) {
      out.imageUrl = upgradeAmazonImageUrl(imgUrl) || imgUrl;
    }
    if (typeof parsed.dealString === 'string' && parsed.dealString.trim()) {
      out.dealString = parsed.dealString.trim();
    }
    if (
      typeof parsed.productComponents?.title === 'string' &&
      parsed.productComponents.title.trim()
    ) {
      out.title = normalizeWhitespace(parsed.productComponents.title);
    }
    const rawReviews = parsed.productComponents?.customerReviews;
    if (rawReviews) {
      const revObj =
        typeof rawReviews === 'string'
          ? (JSON.parse(rawReviews) as {
              ratingValue?: string | number;
              rating?: string;
              count?: string | number;
            })
          : rawReviews;
      const rVal =
        typeof revObj.ratingValue === 'number'
          ? revObj.ratingValue
          : parseRating(String(revObj.ratingValue ?? revObj.rating ?? ''));
      if (rVal !== null && Number.isFinite(rVal)) {
        out.rating = rVal;
      }
      const cVal =
        typeof revObj.count === 'number'
          ? revObj.count
          : parseReviewCount(String(revObj.count ?? ''));
      if (cVal !== null && Number.isFinite(cVal)) {
        out.reviewCount = cVal;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * SAD-386: text that proves the node is *not* a product discount.
 *
 * Measured before this change (probe P02/G): a card whose only percentage sat
 * inside `Save 15% off with coupon` stored `15% off` as the product's discount.
 * That is a wrong value, not a missing one, so it is rejected here for every
 * caller.
 */
const NON_DISCOUNT_TEXT =
  /coupon|voucher|rabatt|remise|with\s+coupon|save\s*[$\u20ac\u00a3\u20b9\u00a5]/i;

/**
 * SAD-386: the discount forms Amazon prints, in one place.
 *
 * ASCII hyphen kept first (the form that already worked and is pinned by
 * existing fixtures); then the typographic minus/en-dash/em-dash that other
 * layouts and locales emit, optionally wrapped in parens; then `NN% off`;
 * then `Save NN%`; then a bare `NN%` which is only accepted when the caller
 * proved the node is a savings node (`allowBare`).
 */
const DISCOUNT_PATTERN =
  /(?:[-\u2212\u2013\u2014]\s*(\d{1,2})\s*%)|(?:\(?\s*(\d{1,2})\s*%\s*off\s*\)?)|(?:save\s*(\d{1,2})\s*%)|(?:^\s*\(?\s*(\d{1,2})\s*%\s*\)?\s*$)/i;

/**
 * Normalizes a discount string ("-68%", "19% off", "\u221268%", "Save 68%") into
 * `"68% off"`.
 *
 * SAD-386 added the typographic-minus, paren, `Save NN%` and (opt-in) bare
 * forms. The output format is unchanged, and every string that normalised
 * before still normalises to the same value.
 */
export function normalizeDiscountBadge(
  raw: string | null | undefined,
  options: { allowBare?: boolean } = {},
): string | undefined {
  const text = normalizeWhitespace(raw);
  if (!text) return undefined;
  if (NON_DISCOUNT_TEXT.test(text)) return undefined;
  const match = DISCOUNT_PATTERN.exec(text);
  if (!match) return undefined;
  const pct = match[1] ?? match[2] ?? match[3] ?? (options.allowBare ? match[4] : undefined);
  if (!pct) return undefined;
  const num = Number.parseInt(pct, 10);
  if (!Number.isFinite(num) || num <= 0 || num >= 100) return undefined;
  return `${num}% off`;
}

/**
 * SAD-386: the ONE bounded scan for a printed savings percentage inside `root`.
 *
 * Rules (identical for listing cards and product pages):
 * - short text only (a badge, not a paragraph),
 * - the text must contain a `%`,
 * - a bare `NN%` is only accepted on a node whose class/id/aria-label says it is
 *   a savings node; `-NN%`, `NN% off`, `Save NN%` and the typographic variants
 *   are accepted anywhere the other guards allow.
 *
 * Returns the normalised value and whether a percentage-looking node was present
 * but refused (used by the diagnostics lane).
 */
export function scanDiscountNodes(
  root: Element,
  options: { skip?: (el: Element) => boolean } = {},
): {
  value?: string;
  nodeSeen: boolean;
} {
  const skip = options.skip ?? (() => false);
  let nodeSeen = false;
  for (const el of safeQuerySelectorAll(root, 'span, div, b, strong')) {
    if (el.children.length > 2) continue;
    if (skip(el)) continue;
    const rawText = normalizeWhitespace(el.textContent);
    if (!rawText || rawText.length > 24 || !rawText.includes('%')) continue;
    const label = `${el.className} ${el.id} ${el.getAttribute('aria-label') ?? ''}`;
    const looksLikeSavings = /saving|discount|percent|\boff\b/i.test(label);
    const normalized = isAmazonCouponRegion(el) ? undefined : normalizeDiscountBadge(rawText, {
      allowBare: looksLikeSavings,
    });
    if (normalized) return { value: normalized, nodeSeen };
    nodeSeen = true;
  }
  return { nodeSeen };
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
  // SAD-369 D9: first tier that found a price node whose text would not
  // parse — observed at each tier below, first observation wins, and only
  // returned when no tier produced a price. Diagnostics-only.
  let unparseablePriceTier: AmazonExtractionTier | undefined;

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
        } else if (unparseablePriceTier === undefined) {
          unparseablePriceTier = 'tier1_json';
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
      if (
        el.closest(
          '[data-a-strike="true"], [data-strikethroughprice="true"], .a-text-strike, .basisPrice, s, del',
        )
      ) {
        continue;
      }
      const parsed = parsePrice(el.textContent, pageCurrency);
      if (parsed.value !== null) {
        price = parsed.value;
        currency = parsed.currency ?? pageCurrency ?? 'USD';
        priceTier = 'tier2_semantic';
        break;
      } else if (unparseablePriceTier === undefined) {
        // SAD-369 D9: a price node was present but its text would not parse.
        unparseablePriceTier = 'tier2_semantic';
      }
    }
  }

  // Tier 2b: Split `.a-price-whole` + `.a-price-fraction` + `.a-price-symbol`
  if (price === null) {
    const priceBlock = safeQuerySelector(
      card,
      '.a-price:not([data-a-strike="true"])',
    );
    if (
      priceBlock &&
      !priceBlock.closest(
        '[data-a-strike="true"], [data-strikethroughprice="true"], .a-text-strike, .basisPrice',
      )
    ) {
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
      } else if (unparseablePriceTier === undefined) {
        // SAD-369 D9: the price block was present but its parts would not parse.
        unparseablePriceTier = 'tier2_semantic';
      }
    }
  }

  // Tier 4: Declarative fallback selectors (`._cDEzb_p13n-sc-price_3mJ9Z`, `.p13n-sc-price`, etc.)
  if (price === null) {
    for (const selector of AMAZON_SELECTORS.cardFields.sellingPrice) {
      const els = safeQuerySelectorAll(card, selector);
      for (const el of els) {
        if (
          el.closest(
            '[data-a-strike="true"], [data-strikethroughprice="true"], .a-text-strike, .basisPrice, s, del',
          )
        ) {
          continue;
        }
        // Guard against matching rank `#1` or review counts on `.a-size-small`
        const rawText = normalizeWhitespace(el.textContent);
        if (!rawText || /^#\d+/.test(rawText)) continue;
        const parsed = parsePrice(rawText, pageCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency ?? pageCurrency ?? 'USD';
          priceTier = 'tier4_selector';
          break;
        } else if (unparseablePriceTier === undefined) {
          // SAD-369 D9: a fallback price node was present but unparseable.
          unparseablePriceTier = 'tier4_selector';
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
      if (
        node.closest(
          '[data-a-strike="true"], [data-strikethroughprice="true"], .a-text-strike, .basisPrice, s, del',
        )
      ) {
        continue;
      }
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
        } else if (unparseablePriceTier === undefined) {
          // SAD-369 D9: a currency-token node was present but unparseable.
          unparseablePriceTier = 'tier3_structural';
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
  // SAD-386 (diagnostics-only): a percentage-looking node existed but did not
  // normalise. Reported in step 5 so "absent" and "unreadable" stop looking alike.
  let discountNodeSeen = false;
  for (const selector of AMAZON_SELECTORS.cardFields.discount) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      // SAD-386: the old `children.length > 1` guard dropped a percentage wrapped
      // in markup (`<span><b>-68%</b><i></i></span>` — probe P02/H). The honest
      // guard is on the TEXT: a discount badge is short, and the normaliser
      // already refuses coupon/currency text.
      const rawText = normalizeWhitespace(el?.textContent);
      if (!rawText || rawText.length > 32) continue;
      const normalized = isAmazonCouponRegion(el) ? undefined : normalizeDiscountBadge(rawText);
      if (normalized) {
        discountPercentage = normalized;
        break;
      }
      if (/%/.test(rawText)) discountNodeSeen = true;
    }
    if (discountPercentage !== undefined) break;
  }

  // SAD-386: one bounded fallback pass inside the price area, never ahead of the
  // declarative list above. Same rules as the product-page path.
  if (discountPercentage === undefined) {
    const priceNode = safeQuerySelector(
      card,
      '[data-cy="price-recipe"] .a-price, .a-price, .priceToPay, .apexPriceToPay',
    );
    const priceArea =
      safeQuerySelector(card, '[data-cy="price-recipe"]') ??
      priceNode?.parentElement ??
      card;
    const scanned = scanDiscountNodes(priceArea);
    if (scanned.value !== undefined) discountPercentage = scanned.value;
    if (scanned.nodeSeen) discountNodeSeen = true;
  }

  // Deal Badge (`Limited-time deal`, etc.)
  let dealBadge: string | undefined;
  // SAD-386 (diagnostics-only): the value came from evidence, not a printed badge.
  let dealBadgeDerived = false;
  for (const selector of AMAZON_SELECTORS.cardFields.dealBadge) {
    const els = safeQuerySelectorAll(card, selector);
    for (const el of els) {
      const text = normalizeWhitespace(el?.textContent);
      // SAD-386: one shared vocabulary (was duplicated with the PDP path).
      if (text && DEAL_LABEL_PATTERN.test(text)) {
        dealBadge = text;
        break;
      }
    }
    if (dealBadge !== undefined) break;
  }

  if (dealBadge === undefined) {
    const adProps = parseAsinAdAttributesProps(card);
    if (adProps?.dealString) {
      dealBadge = adProps.dealString;
    }
  }

  // SAD-386: badge containers the declarative list does not name, then the
  // operator-approved strike-price rule (D5). Both are additive: the loops above
  // keep first refusal, so no selector that wins today can lose to these.
  if (dealBadge === undefined) {
    const evidence =
      detectDealEvidence(card) ?? deriveDealFromPrices(price, listPrice);
    if (evidence) {
      dealBadge = evidence.value;
      dealBadgeDerived = evidence.derived;
    }
  }

  const couponResult = readAmazonCoupon(card);
  const coupon = couponResult.value;

  const result: CardPricingAndDiscounts = {
    price,
    currency: currency ?? pageCurrency ?? 'USD',
    priceTier,
  };
  if (listPrice !== undefined) result.listPrice = listPrice;
  if (discountPercentage !== undefined) {
    result.discountPercentage = discountPercentage;
  }
  if (dealBadge !== undefined) {
    result.dealBadge = dealBadge;
    if (dealBadgeDerived) result.dealBadgeDerived = true;
  }
  // SAD-386 (diagnostics-only): only meaningful when no node produced a value.
  if (discountPercentage === undefined && discountNodeSeen) {
    result.unparseableDiscountNode = true;
  }
  if (coupon !== undefined) result.coupon = coupon;
  else if (couponResult.nodeSeen) result.unparseableCouponNode = true;
  // SAD-369 D9: only meaningful when no tier produced a price — otherwise the
  // observation is noise next to a successfully extracted value.
  if (price === null && unparseablePriceTier !== undefined) {
    result.unparseablePriceTier = unparseablePriceTier;
  }

  return result;
}

/**
 * 4-Tier ASIN extraction from a product card element.
 */
export function extractCardAsinWithTier(
  card: Element,
): TieredValue<string | null> {
  // Tier 1: `data-p13n-asin-metadata` or `data-asinadattributesprops` JSON
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

  const adProps = parseAsinAdAttributesProps(card);
  if (adProps?.asin) {
    const asin = normalizeASIN(adProps.asin);
    if (asin) {
      return { value: asin, tier: 'tier1_json' };
    }
  }

  // Tier 2: `data-asin`, `data-csa-c-asin`, or `data-csa-c-item-id` attribute on card or child
  const directAsin =
    normalizeASIN(card.getAttribute('data-asin')) ??
    normalizeASIN(card.getAttribute('data-csa-c-asin')) ??
    normalizeASIN(card.getAttribute('data-csa-c-item-id'));
  if (directAsin) {
    return { value: directAsin, tier: 'tier2_semantic' };
  }
  const nestedAsinEl = safeQuerySelector(
    card,
    '[data-asin]:not([data-asin=""]), [data-csa-c-asin]:not([data-csa-c-asin=""]), [data-csa-c-item-id*="amzn1.asin."]',
  );
  if (nestedAsinEl) {
    const nestedAsin =
      normalizeASIN(nestedAsinEl.getAttribute('data-asin')) ??
      normalizeASIN(nestedAsinEl.getAttribute('data-csa-c-asin')) ??
      normalizeASIN(nestedAsinEl.getAttribute('data-csa-c-item-id'));
    if (nestedAsin) {
      return { value: nestedAsin, tier: 'tier2_semantic' };
    }
  }

  // Tier 3: Structural `/dp/<ASIN>`, `/gp/product/<ASIN>`, or sponsored redirect anchor/popover discovery
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"], a[href*="/sspa/click"], a[href*="sponsored-ads.amazon."], a[href*="aax-"]',
  );
  for (const anchor of anchors) {
    const asin = extractASIN(anchor.getAttribute('href'));
    if (asin) {
      return { value: asin, tier: 'tier3_structural' };
    }
  }

  const popoverEl = safeQuerySelector(card, '[data-a-popover*="asin="]');
  if (popoverEl) {
    const asin = extractASIN(popoverEl.getAttribute('data-a-popover'));
    if (asin) {
      return { value: asin, tier: 'tier3_structural' };
    }
  }

  return { value: null, tier: 'missing' };
}

function stripSponsoredTitlePrefix(raw: string): string {
  return raw.replace(/^Sponsored\s+Ad\s*[-–—:]\s*/i, '').trim();
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

  // Tier 1: `data-asinadattributesprops` JSON title if present
  const adProps = parseAsinAdAttributesProps(card);
  if (adProps?.title && adProps.title.length >= 2) {
    return {
      title: {
        value: stripSponsoredTitlePrefix(adProps.title),
        tier: 'tier1_json',
      },
      brand,
    };
  }

  // Tier 2: Semantic link heading inside `[data-cy="title-recipe"]`, `h2 a`, or `a[data-type="productTitle"]`
  const semanticSelectors = [
    '[data-cy="title-recipe"] a h2 span',
    '[data-cy="title-recipe"] h2 a span',
    'h2 a.a-link-normal span',
    'h2 a span',
    'a[data-type="productTitle"]',
    '.a-truncate .a-truncate-full',
    '[data-testid="product-card-title"]',
    '[data-testid="deal-title"]',
  ];
  for (const selector of semanticSelectors) {
    const el = safeQuerySelector(card, selector);
    const text = stripSponsoredTitlePrefix(
      normalizeWhitespace(el?.textContent),
    );
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
      const text = stripSponsoredTitlePrefix(
        normalizeWhitespace(el.textContent),
      );
      if (text && text !== brand && text.length >= 2) {
        return {
          title: { value: text, tier: 'tier4_selector' },
          brand,
        };
      }
    }
  }

  // Tier 3: Structural `/dp/<ASIN>` or sponsored redirect anchor text fallback
  const anchors = safeQuerySelectorAll<HTMLAnchorElement>(
    card,
    'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"], a[href*="/sspa/click"], a[href*="sponsored-ads.amazon."], a[href*="aax-"]',
  );
  let bestText = '';
  for (const anchor of anchors) {
    if (asin) {
      const linkAsin = extractASIN(anchor.getAttribute('href'));
      if (linkAsin && linkAsin !== asin) continue;
    }
    const rawCandidate =
      normalizeWhitespace(anchor.getAttribute('title')) ||
      normalizeWhitespace(anchor.getAttribute('aria-label')) ||
      normalizeWhitespace(anchor.textContent);
    const candidate = stripSponsoredTitlePrefix(rawCandidate);
    if (
      candidate.length > bestText.length &&
      candidate !== brand &&
      !/^Rated\s+\d/i.test(candidate) &&
      !/^\d+(?:[.,]\d+)?\s*out of\s*5/i.test(candidate) &&
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
  // SAD-383: a node that exists but does not parse is a different failure from a
  // layout that never prints the field, and the two need different fixes.
  let ratingNodeSeen = false;
  let reviewNodeSeen = false;

  for (const selector of AMAZON_SELECTORS.cardFields.rating) {
    const el = safeQuerySelector(card, selector);
    if (!el) continue;
    ratingNodeSeen = true;
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
      reviewNodeSeen = true;
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

  if (rating === null || reviewCount === null) {
    const adProps = parseAsinAdAttributesProps(card);
    if (rating === null && typeof adProps?.rating === 'number') {
      rating = adProps.rating;
      ratingTier = 'tier1_json';
    }
    if (reviewCount === null && typeof adProps?.reviewCount === 'number') {
      reviewCount = adProps.reviewCount;
      reviewTier = 'tier1_json';
    }
  }

  return {
    rating: { value: rating, tier: ratingTier, nodeSeen: ratingNodeSeen },
    reviewCount: {
      value: reviewCount,
      tier: reviewTier,
      nodeSeen: reviewNodeSeen,
    },
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
  const adProps = parseAsinAdAttributesProps(card);
  if (adProps?.imageUrl) {
    return {
      value: adProps.imageUrl,
      tier: 'tier1_json',
    };
  }
  return { value: null, tier: 'missing' };
}

/** Transient parser evidence only; never persisted on the product. */
interface AmazonSignalResult {
  value?: string;
  nodeSeen: boolean;
  selector?: string;
}

const SIGNAL_EXCLUDED = [
  ...AMAZON_SELECTORS.detail.excludedSubtrees,
  // A title, description or review quoting an offer is not a product signal.
  'h1', 'h2', '#productTitle', '[data-cy="title-recipe"]',
  '[id^="title-"]', '[class*="p13n-sc-css-line-clamp"]',
  '#productDescription', '#feature-bullets', '#customerReviews',
  '#reviewsMedley', '[data-hook="review"]', '.a-popover-preload',
].join(',');
const SIGNAL_HIDDEN = 'script, style, template, noscript, [hidden], .aok-hidden, .a-hidden';
const COUPON_STRONG = '.s-coupon-unclipped, .couponLabelText, [id^="couponText"], [data-component-type="s-coupon-component"], #couponBadgeRegularVpc, #vpcButton';

/** Semantic coupon text must not become a product discount when it omits "coupon". */
export function isAmazonCouponRegion(el: Element): boolean {
  return Boolean(el.closest(COUPON_STRONG) || el.querySelector(COUPON_STRONG));
}

/**
 * A card is its own ownership boundary, including when it lives in a carousel.
 * A Document is a PDP: every ancestor and every different-ASIN subtree matters.
 * No layout reads: this also works in an offscreen DOMParser document. In
 * particular aria-hidden alone is NOT proof of invisibility (Amazon uses it
 * for visible text with a separate accessible equivalent).
 */
function signalScope(root: Element | Document, asin?: string) {
  const owner = asin ?? (root.nodeType === 1 ? normalizeASIN((root as Element).getAttribute('data-asin')) : null);
  const excluded = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.matches(SIGNAL_HIDDEN)) return true;
      const style = (node as HTMLElement).style;
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return true;
      if (node !== root) {
        if (node.matches(SIGNAL_EXCLUDED)) return true;
        const nestedAsin = normalizeASIN(node.getAttribute('data-asin'));
        if (nestedAsin && nestedAsin !== owner) return true;
      }
      if (node === root) break;
    }
    return false;
  };
  return excluded;
}

/** Bounded, non-mutating text walk. Exclusions apply to descendants too. */
function cleanSignalText(el: Element, excluded: (el: Element) => boolean, coupon = false): string {
  const parts: string[] = [];
  let length = 0;
  let visited = 0;
  const visit = (node: Node): void => {
    if (++visited > 128 || length > 512) return;
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      parts.push(text);
      length += text.length;
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (excluded(child)) return;
      if (coupon && child.matches('a') && /^(?:shop items|terms(?: and conditions)?|details)$/i.test(normalizeWhitespace(child.textContent))) return;
      for (const next of child.childNodes) {
        visit(next);
        if (visited > 128 || length > 512) break;
      }
    }
  };
  visit(el);
  // Never return a truncated offer as though it were complete.
  return visited > 128 || length > 512 ? '' : normalizeWhitespace(parts.join(' '));
}

function signalCandidates(root: Element | Document, selector: string): Element[] {
  const found = safeQuerySelectorAll(root, selector);
  return root.nodeType === 1 && (root as Element).matches(selector)
    ? [root as Element, ...found]
    : found;
}

/** Shared listing/PDP coupon reader; no coupon-to-price/discount conversion. */
export function readAmazonCoupon(root: Element | Document, asin?: string): AmazonSignalResult {
  const excluded = signalScope(root, asin);
  const seen = new Set<Element>();
  let rejectedSelector: string | undefined;
  // One DOM query, retaining the established selector-priority order below.
  const candidates = signalCandidates(root, AMAZON_SELECTORS.cardFields.coupon.join(','));
  for (const selector of AMAZON_SELECTORS.cardFields.coupon) {
    for (const el of candidates) {
      if (seen.has(el) || !el.matches(selector)) continue;
      seen.add(el);
      if (excluded(el)) continue;
      rejectedSelector ??= selector;
      const text = cleanSignalText(el, excluded, true)
        .replace(/\s*(?:shop items\s*(?:[|·]\s*)?)?terms(?: and conditions)?\s*$/i, '')
        .replace(/\s*(?:shop items|[|·])\s*$/i, '')
        .trim();
      if (!text || /\b(?:no coupons?|expired|unavailable)\b/i.test(text)) continue;
      const hasKeyword = /coupon|voucher|rabatt|remise/i.test(text);
      const hasOffer = /\d|\bapply\b|\bclip\b/i.test(text);
      const provenOffer = el.matches(COUPON_STRONG) && /(?:save|apply|get|you pay)\s+(?:[$£€]\s*\d|\d+(?:[.,]\d+)?\s*%)/i.test(text);
      if ((hasKeyword && hasOffer) || provenOffer) {
        return { value: text, nodeSeen: true, selector };
      }
    }
  }
  return { nodeSeen: rejectedSelector !== undefined, selector: rejectedSelector };
}

/**
 * Semantic markers first, then short owned elements of a card/main PDP scope.
 * Never scan the entire PDP body or concatenate an excluded recommendation.
 */
export function readAmazonPastMonthSales(root: Element | Document, asin?: string): AmazonSignalResult {
  // Most cards print no sales signal. Avoid five selector scans on that hot
  // path, but retain PARSE_FAILED for an explicit empty/loading social-proof
  // marker. This is only a prefilter, never evidence used as the field value.
  const textRoot = root.nodeType === 1 ? root : (root as Document).documentElement;
  if (!/bought/i.test(textRoot?.textContent ?? '') &&
      !(root.nodeType === 1 && (root as Element).id === 'social-proofing-faceout-title-tk_bought') &&
      !safeQuerySelector(root, '#social-proofing-faceout-title-tk_bought')) {
    return { nodeSeen: false };
  }
  const excluded = signalScope(root, asin);
  const seen = new Set<Element>();
  let rejectedSelector: string | undefined;
  const read = (el: Element, selector: string, explicit = false): AmazonSignalResult | undefined => {
    if (seen.has(el)) return;
    seen.add(el);
    // Cheap rejection before the bounded text walk, important on large lists.
    const raw = el.textContent ?? '';
    if (!explicit && (!/bought/i.test(raw) || raw.length > 512)) return;
    if (excluded(el)) return;
    const text = cleanSignalText(el, excluded);
    if (!explicit && !/bought\s+in\s+past\s+month/i.test(text)) return;
    rejectedSelector ??= selector;
    const value = PAST_MONTH_SALES_REGEX.exec(text)?.[1]?.trim();
    if (value) return { value, nodeSeen: true, selector };
  };
  for (const selector of AMAZON_SELECTORS.cardFields.boughtInPastMonth) {
    for (const el of signalCandidates(root, selector)) {
      const result = read(el, selector, el.id === 'social-proofing-faceout-title-tk_bought');
      if (result) return result;
    }
  }
  const scopes = root.nodeType === 1
    ? [root as Element]
    : safeQuerySelectorAll(root, AMAZON_SELECTORS.detail.rootContainers.join(','));
  for (const scope of scopes) {
    if (excluded(scope)) continue;
    for (const el of signalCandidates(scope, 'span, div, p, b, strong')) {
      const result = read(el, '(owned short monthly-sales text)');
      if (result) return result;
    }
  }
  return { nodeSeen: rejectedSelector !== undefined, selector: rejectedSelector };
}

/** Compatibility string API for existing callers. */
export function extractCardPastMonthSales(card: Element): string | undefined {
  return readAmazonPastMonthSales(card).value;
}

/**
 * SAD-393: the wording this module accepts as a status/recognition badge.
 * The stored value is always the page's own (whitespace-normalized) text —
 * this pattern only decides whether a candidate node *is* that badge.
 */
const STATUS_BADGE_PATTERN =
  /best seller|amazon's choice|overall pick|popular|new release|most wished/i;

export interface CardBadgeResult {
  badge?: string;
  /**
   * SAD-393: a non-deal badge candidate with readable text existed but was
   * refused by the status-badge pattern. Diagnostics only — it is what turns
   * "Amazon renamed the badge" into a visible PARSE_FAILED instead of a
   * silent, permanent MISSING (the SAD-383 `nodeSeen` precedent).
   */
  nodeSeen: boolean;
}

export function extractCardBadgeResult(card: Element): CardBadgeResult {
  let nodeSeen = false;
  for (const selector of AMAZON_SELECTORS.cardFields.statusBadge) {
    // SAD-393: every match, not just the first. `.a-badge-label-inner` is
    // shared with the deal badge, so a first-match read let a deal node end
    // the search before the status node was ever considered (live cards
    // carry both — `docs/plans/SAD-393-fixtures/`).
    for (const el of safeQuerySelectorAll(card, selector)) {
      // The deal badge's own subtree is never a status badge, whatever its
      // text says — the same separation `deal-evidence.ts` enforces in the
      // other direction.
      if (el.closest('[data-a-badge-type="deal"]')) continue;
      const text = normalizeWhitespace(el?.textContent);
      if (!text) continue;
      // Amazon prints both apostrophes (U+0027 and U+2019); folding is for
      // the comparison only, the page's original text is what is stored.
      if (STATUS_BADGE_PATTERN.test(text.replace(/\u2019/g, "'"))) {
        return { badge: text, nodeSeen: true };
      }
      nodeSeen = true;
    }
  }
  return { nodeSeen };
}

export function extractCardBadge(card: Element): string | undefined {
  return extractCardBadgeResult(card).badge;
}

const DELIVERY_KEYWORD_RE =
  /delivery|lieferung|livraison|entrega|consegna|bezorging|dostawa|leverans/i;

export function extractCardDeliveryAndAvailability(card: Element): {
  delivery?: string;
  availability: string | null;
} {
  let delivery: string | undefined;
  let availability: string | null = null;

  const deliveryBlock = safeQuerySelector(card, '[data-cy="delivery-recipe"]');
  if (deliveryBlock) {
    const stockSpan = safeQuerySelector(deliveryBlock, '.a-color-price');
    // SAD-392: same stripped read as the PDP loop — a delivery-recipe block
    // can host <script>/<style> nodes (the Prime-signup ingress seen live in
    // 49/64 captured cards), and `textContent` would serialize them into the
    // stock phrase check and the stored value. Unified (merge plan D-M4) onto
    // SAD-390's `extractCleanElementText` — already whitespace-normalized.
    const stockText = extractCleanElementText(stockSpan);
    if (stockText && /left in stock|out of stock|unavailable/i.test(stockText)) {
      availability = stockText;
    }

    for (const ariaEl of safeQuerySelectorAll(deliveryBlock, '[aria-label]')) {
      if (ariaEl.closest('.a-color-price')) continue;
      const ariaText = normalizeWhitespace(
        ariaEl.getAttribute('aria-label') || extractCleanElementText(ariaEl),
      );
      if (ariaText && DELIVERY_KEYWORD_RE.test(ariaText)) {
        delivery = ariaText;
        break;
      }
    }

    if (!delivery) {
      const udmBlock =
        safeQuerySelector(deliveryBlock, '[data-cy="delivery-block"]') ??
        deliveryBlock;
      const fallbackText = extractCleanElementText(udmBlock, 'a-color-price');
      if (fallbackText && DELIVERY_KEYWORD_RE.test(fallbackText)) {
        delivery = fallbackText;
      }
    }
  } else if (
    DELIVERY_KEYWORD_RE.test(card.textContent ?? '') ||
    /delivery/i.test(card.innerHTML)
  ) {
    for (const selector of AMAZON_SELECTORS.cardFields.delivery) {
      if (selector.startsWith('[data-cy="delivery-recipe"]')) continue;
      const el = safeQuerySelector(card, selector);
      if (!el) continue;
      const candidateText = normalizeWhitespace(
        el.getAttribute('aria-label') ||
          extractCleanElementText(el, 'a-color-price'),
      );
      if (candidateText && DELIVERY_KEYWORD_RE.test(candidateText)) {
        delivery = candidateText;
        break;
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
    const text = extractCleanElementText(offerBlock);
    if (
      /sold by|ships from and sold by|verkauf durch|vendu par|vendido por/i.test(
        text,
      )
    ) {
      return cleanSeller(text);
    }
  }

  const leafNodes = safeQuerySelectorAll(card, 'div, span');
  for (const node of leafNodes) {
    if (node.children.length > 0) continue;
    const text = normalizeWhitespace(node.textContent);
    if (
      /^(?:Ships from and sold by|Sold by|Verkauf durch|Vendu par|Vendido por)\s*:?\s+.+/i.test(
        text,
      )
    ) {
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
    card.getAttribute('data-component-type') === 'sbv-video-single-product' ||
    card.classList.contains('AdHolder')
  ) {
    return true;
  }

  // Check if the card resides inside an enclosing sponsored search widget container
  // (e.g. Sponsored Brand themed collection, Sponsored Brand Video collection, or Single-Product Sponsored Video)
  try {
    const sponsoredParent = card.closest(
      '.AdHolder, [data-component-type="sp-sponsored-result"], [data-component-type="sbv-video-single-product"], .sb-video-creative, .sb-desktop, [cel_widget_id*="sb-themed-collection"], [cel_widget_id*="sb-video-product-collection"], [cel_widget_id^="MAIN-VIDEO_SINGLE_PRODUCT"], [data-card-metrics-id*="sb-themed-collection"], [data-card-metrics-id*="sb-video-product-collection"]',
    );
    if (sponsoredParent) {
      return true;
    }
  } catch {
    // Ignore selector error in older DOM implementations
  }

  // Check for sponsored redirect links inside the card
  if (
    safeQuerySelector(
      card,
      'a[href*="sponsored-ads.amazon."], a[href*="/sspa/click"], [data-component-props*="SponsoredProducts"]',
    )
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

  // Check if an enclosing `.s-main-slot > .s-result-item[data-asin=""]` widget wrapper carries a widget-level Sponsored disclosure
  try {
    const enclosingWidget = card.closest(
      '.s-main-slot > .s-result-item[data-asin=""], .s-main-slot > .s-widget',
    );
    if (
      enclosingWidget &&
      !enclosingWidget.matches(
        '[data-component-type="s-shopping-adviser"], [cel_widget_id^="MAIN-SHOPPING_ADVISER"]',
      ) &&
      !safeQuerySelector(
        enclosingWidget,
        '[data-component-type="s-shopping-adviser"]',
      )
    ) {
      if (
        safeQuerySelector(
          enclosingWidget,
          '.puis-sponsored-label-text, [data-component-props*="SponsoredProducts"], .sb-desktop-sponsored-Creator, [id^="sponsored-brands-"]',
        )
      ) {
        return true;
      }
    }
  } catch {
    // Ignore selector errors
  }

  return false;
}

function cleanWidgetSectionHeading(raw: string | null | undefined): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;
  const cleaned = text
    .replace(/\bPage\s+\d+\s+of\s+\d+\b.*$/i, '')
    .replace(/\b(?:See more|Shop now|Learn more|Sponsored)\s*$/i, '')
    .replace(/\s*[|·•-]\s*$/, '')
    .trim();
  if (!cleaned || cleaned.length < 3 || cleaned.length > 90) {
    return null;
  }
  if (/^(?:results|price and other details|check each product page|sponsored)$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function findEnclosingWidgetHeading(card: Element, widgetRoot: Element): string | null {
  const headingCandidates = safeQuerySelectorAll(
    widgetRoot,
    'h1, h2, h3, [role="heading"], .a-carousel-heading, .puis-card-title, .a-size-large.a-text-bold, .a-size-medium-plus.a-text-bold',
  );
  for (const el of headingCandidates) {
    // Skip any heading inside a product card item or carousel slide
    if (card.contains(el)) continue;
    try {
      if (
        el.closest(
          '.a-carousel-card, [data-component-type="s-search-result"], .s-result-item[data-asin]:not([data-asin=""])',
        )
      ) {
        continue;
      }
    } catch {
      // Ignore selector error
    }
    const cleaned = cleanWidgetSectionHeading(el.textContent);
    if (cleaned) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Classifies a product card into `'organic' | 'sponsored' | 'recommendation'` and extracts
 * the enclosing widget's human-readable section heading (e.g. `"People Also View"`,
 * `"People Also Like"`, `"Recently bought and rated"`, `"Highly rated by customers"`,
 * `"Sponsored Brand"`, `"Sponsored Video"`).
 *
 * Returns `{}` for standard primary `[data-component-type="s-search-result"]` cards so
 * baseline snapshot shapes remain untouched (their category resolves deterministically
 * from `isSponsored`).
 */
export function extractCardListingCategoryAndSection(
  card: Element,
  isSponsored: boolean,
): {
  listingCategory?: AmazonListingCategory;
  sectionLabel?: string;
} {
  try {
    // 1. Sponsored Brand themed collection carousel
    const sbThemed = card.closest(
      '[cel_widget_id*="sb-themed-collection"], [data-card-metrics-id*="sb-themed-collection"], [id^="sponsored-brands-"]',
    );
    if (sbThemed) {
      return {
        listingCategory: 'sponsored',
        sectionLabel: 'Sponsored Brand',
      };
    }

    // 2. Sponsored Brand Video multi-product or single-product video creative
    const sbVideo = card.closest(
      '.sb-video-creative, [cel_widget_id*="sb-video-product-collection"], [data-card-metrics-id*="sb-video-product-collection"], [data-component-type="sbv-video-single-product"], [cel_widget_id^="MAIN-VIDEO_SINGLE_PRODUCT"]',
    );
    if (sbVideo || card.getAttribute('data-component-type') === 'sbv-video-single-product') {
      return {
        listingCategory: 'sponsored',
        sectionLabel: 'Sponsored Video',
      };
    }

    // 3. Recommendation / Shopping Adviser / Featured ASINs / Discovery carousels & widgets
    const recommendationWidget = card.closest(
      '[data-component-type="s-shopping-adviser"], [data-component-type="s-searchgrid-carousel"], [cel_widget_id^="MAIN-SHOPPING_ADVISER"], [cel_widget_id^="MAIN-FEATURED_ASINS_LIST"], .s-main-slot > .s-result-item[data-asin=""], .s-main-slot > .s-widget, .a-carousel-container',
    );
    const inCarouselCard = Boolean(card.closest('.a-carousel-card'));
    const isBestsellerGrid =
      card.classList.contains('zg-grid-general-faceout') ||
      Boolean(card.closest('#gridItemRoot, .zg-grid-general-faceout'));
    const hasP13nMeta =
      !isBestsellerGrid &&
      (card.hasAttribute('data-p13n-asin-metadata') ||
        Boolean(safeQuerySelector(card, '[data-p13n-asin-metadata]')));

    if (recommendationWidget || inCarouselCard || hasP13nMeta) {
      const headingRoot =
        card.closest(
          '.s-main-slot > .s-result-item[data-asin=""], .s-main-slot > .s-widget, [data-component-type="s-shopping-adviser"], [data-component-type="s-searchgrid-carousel"], [cel_widget_id^="MAIN-SHOPPING_ADVISER"], [cel_widget_id^="MAIN-FEATURED_ASINS_LIST"]',
        ) ??
        card.closest('.a-carousel-container') ??
        recommendationWidget;
      const heading = headingRoot
        ? findEnclosingWidgetHeading(card, headingRoot)
        : null;

      if (isSponsored) {
        return {
          listingCategory: 'sponsored',
          sectionLabel: heading ?? 'Sponsored Carousel',
        };
      }

      return {
        listingCategory: 'recommendation',
        sectionLabel: heading ?? 'Recommendation',
      };
    }
  } catch {
    // Ignore selector errors in older DOM implementations
  }

  return {};
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
    if (typeof raw.variations === 'string' && raw.variations.trim()) {
      normalized.variations = raw.variations.trim();
    }
    if (typeof raw.weight === 'string' && raw.weight.trim()) {
      normalized.weight = raw.weight.trim();
    }
    // SAD-349: the token and its source text travel together — a token without
    // the cell it came from would be the only surviving copy of the value.
    if (raw.warrantyDescription) {
      normalized.warrantyDescription = raw.warrantyDescription;
      if (raw.warrantyDescriptionRaw) {
        normalized.warrantyDescriptionRaw = raw.warrantyDescriptionRaw;
      }
    }
    if (
      raw.listingCategory === 'organic' ||
      raw.listingCategory === 'sponsored' ||
      raw.listingCategory === 'recommendation'
    ) {
      normalized.listingCategory = raw.listingCategory;
    }
    if (typeof raw.sectionLabel === 'string' && raw.sectionLabel.trim()) {
      normalized.sectionLabel = raw.sectionLabel.trim();
    }
    if (Array.isArray(raw.placements) && raw.placements.length > 0) {
      normalized.placements = raw.placements.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
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
