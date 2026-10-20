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
 */
const WARRANTY_DURATION_RE =
  /\b((?:twenty|thirty|sixty|ninety)[\s-](?:one|two|three|four|five|six|seven|eight|nine)|\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty|thirty|sixty|ninety)[\s-]*(years?|yrs?|months?|mos?|days?|weeks?)\b/i;

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
 * (`1-year`, `2-year`, `90-day`, `lifetime`).
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
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  // "Limited lifetime warranty" states coverage that is not a duration.
  if (/\blifetime\b/i.test(text)) return 'lifetime';

  const match = WARRANTY_DURATION_RE.exec(text);
  if (!match) return null;

  const quantityText = match[1]!.toLowerCase().replace(/\s+/g, '-');
  const quantity = /^\d+$/.test(quantityText)
    ? Number.parseInt(quantityText, 10)
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

  if (dealBadge === undefined) {
    const adProps = parseAsinAdAttributesProps(card);
    if (adProps?.dealString) {
      dealBadge = adProps.dealString;
    }
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
  const adProps = parseAsinAdAttributesProps(card);
  if (adProps?.imageUrl) {
    return {
      value: adProps.imageUrl,
      tier: 'tier1_json',
    };
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
