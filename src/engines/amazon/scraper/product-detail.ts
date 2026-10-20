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
  formatVariationDimensionsSummary,
  normalizeDiscountBadge,
  normalizeWarrantyDescription,
  normalizeWeightValue,
  normalizeWhitespace,
  parseRating,
  parseReviewCount,
  validateAndNormalizeScrapedProduct,
  type VariationDimensionSummaryInput,
} from './field-parsers';
import {
  AMAZON_DIMENSIONS_LABEL_PATTERN,
  AMAZON_SELECTORS,
  AMAZON_WARRANTY_LABEL_PATTERN,
  AMAZON_WEIGHT_ITEM_LABEL_PATTERN,
  AMAZON_WEIGHT_PACKAGE_LABEL_PATTERN,
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

        const aggRating = rec.aggregateRating as
          | Record<string, unknown>
          | undefined;
        if (aggRating && typeof aggRating === 'object') {
          const parsedRating = parseRating(
            String(aggRating.ratingValue ?? ''),
          );
          if (parsedRating !== null && result.rating === undefined) {
            result.rating = parsedRating;
          }
          const parsedReviews = parseReviewCount(
            String(aggRating.reviewCount ?? aggRating.ratingCount ?? ''),
          );
          if (parsedReviews !== null && result.reviewCount === undefined) {
            result.reviewCount = parsedReviews;
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

/** SAD-349: the normalized token plus the verbatim cell it came from. */
interface DetailWarranty {
  warrantyDescription: string;
  warrantyDescriptionRaw: string;
}

/**
 * SAD-349: yields `{ label, value }` for each labelled row of a detail
 * container, handling every shape Amazon ships:
 *
 * - `<tr><th>Label</th><td>Value</td></tr>` — `productDetails_techSpec_*`,
 *   `productDetails_detailBullets_sections1`, `productDetails_db_sections`
 * - `<tr class="po-x"><td><span class="a-text-bold">Label</span></td><td>…</td></tr>`
 *   — `productOverview_feature_div`, where the label lives in the *first* `td`
 * - `<li><span class="a-text-bold">Label:</span> Value</li>` —
 *   `detailBulletsWrapper_feature_div`
 *
 * The value cell is the first `td` that is not the label's own cell; when there
 * is no `td` at all (the list shape) the row text minus the label is used.
 */
function* iterDetailSpecRows(
  container: Element,
): Generator<{ label: string; value: string }> {
  for (const row of safeQuerySelectorAll(container, 'tr, li')) {
    const header = row.querySelector(
      'th, .a-text-bold, td:first-child strong, td:first-child b',
    );
    if (!header) continue;

    const label = normalizeWhitespace(header.textContent).replace(/:+$/, '').trim();
    if (!label) continue;

    const cells = safeQuerySelectorAll(row, 'td');
    const valueCell = cells.find((cell) => cell !== header && !cell.contains(header));

    let value = normalizeWhitespace(
      valueCell ? valueCell.textContent : row.textContent,
    );
    if (!valueCell && value.startsWith(label)) {
      value = value.slice(label.length);
    }
    value = value.replace(/^[\s:]+/, '').trim();

    if (value) yield { label, value };
  }
}

/**
 * SAD-349: reads the warranty period from the PDP's structured detail tables.
 *
 * Deliberately mirrors `extractDetailBsr` — same container walk, same exclusion
 * of sponsored/similar-item subtrees — because the warranty row sits in the very
 * tables the BSR row does.
 *
 * A labelled row whose cell yields no duration is skipped rather than returned:
 * that is the "Product Warranty: For warranty information about this product,
 * please click here" boilerplate, and a real row can follow it in the same table.
 */
function extractDetailWarranty(doc: Document): DetailWarranty | undefined {
  for (const selector of AMAZON_SELECTORS.detail.warrantyContainers) {
    const container = safeQuerySelector(doc, selector);
    if (!container || isInsideExcludedDetailSubtree(container)) continue;

    for (const { label, value } of iterDetailSpecRows(container)) {
      if (!AMAZON_WARRANTY_LABEL_PATTERN.test(label)) continue;

      const warrantyDescription = normalizeWarrantyDescription(value);
      if (!warrantyDescription) continue;

      return { warrantyDescription, warrantyDescriptionRaw: value };
    }
  }
  return undefined;
}

/**
 * SAD-357: extracts product weight from structured PDP detail containers
 * using a 4-tier specificity waterfall:
 *   1. Direct item mass rows (`Item Weight`, `Product Weight`, `Weight`, ...)
 *   2. Packaged/shipping mass rows when no item-weight row exists
 *   3. Combined `Product Dimensions: L x W x H; Weight` rows
 *   4. A+ manufacturer spec tables (`#aplus`), direct mass labels only
 */
function extractDetailWeight(doc: Document): string | undefined {
  let packageWeightFallback: string | undefined;
  let dimensionsWeightFallback: string | undefined;

  for (const selector of AMAZON_SELECTORS.detail.warrantyContainers) {
    const container = safeQuerySelector(doc, selector);
    if (!container || isInsideExcludedDetailSubtree(container)) continue;

    for (const { label, value } of iterDetailSpecRows(container)) {
      if (AMAZON_WEIGHT_ITEM_LABEL_PATTERN.test(label)) {
        const normalized = normalizeWeightValue(value);
        if (normalized) return normalized;
        continue;
      }

      if (
        packageWeightFallback === undefined &&
        AMAZON_WEIGHT_PACKAGE_LABEL_PATTERN.test(label)
      ) {
        const normalized = normalizeWeightValue(value);
        if (normalized) packageWeightFallback = normalized;
        continue;
      }

      if (
        dimensionsWeightFallback === undefined &&
        AMAZON_DIMENSIONS_LABEL_PATTERN.test(label) &&
        value.includes(';')
      ) {
        const weightSegment = value.split(';').slice(1).join(';');
        const normalized = normalizeWeightValue(weightSegment);
        if (normalized) dimensionsWeightFallback = normalized;
      }
    }
  }

  if (packageWeightFallback !== undefined) return packageWeightFallback;
  if (dimensionsWeightFallback !== undefined) return dimensionsWeightFallback;

  const aplusContainer = safeQuerySelector(doc, '#aplus');
  if (aplusContainer && !isInsideExcludedDetailSubtree(aplusContainer)) {
    for (const { label, value } of iterDetailSpecRows(aplusContainer)) {
      if (!AMAZON_WEIGHT_ITEM_LABEL_PATTERN.test(label)) continue;
      const normalized = normalizeWeightValue(value);
      if (normalized) return normalized;
    }
  }

  return undefined;
}

function extractBalancedJsonAfterKey(
  source: string,
  key: string,
): unknown | undefined {
  const keyPattern = new RegExp(
    `["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:\\s*`,
  );
  const match = keyPattern.exec(source);
  if (!match) return undefined;

  const startIdx = match.index + match[0].length;
  const openChar = source[startIdx];
  if (openChar !== '[' && openChar !== '{') return undefined;
  const closeChar = openChar === '[' ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(startIdx, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function humanizeDimensionKey(rawKey: string): string {
  const cleaned = rawKey
    .replace(/^inline-twister-row-|^variation_/, '')
    .replace(/_name$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractTwisterScriptVariations(doc: Document): string | null {
  for (const script of safeQuerySelectorAll<HTMLScriptElement>(doc, 'script')) {
    const text = script.textContent;
    if (!text || !text.includes('twister-js-init-dpx-data')) continue;
    if (isInsideExcludedDetailSubtree(script)) continue;

    const rawDims = extractBalancedJsonAfterKey(text, 'dimensions');
    const rawLabels = extractBalancedJsonAfterKey(
      text,
      'variationDisplayLabels',
    );
    const rawValues = extractBalancedJsonAfterKey(text, 'variationValues');
    const rawDisplayData = extractBalancedJsonAfterKey(
      text,
      'dimensionValuesDisplayData',
    );
    const totalMatch = /["']num_total_variations["']\s*:\s*(\d+)/.exec(text);
    const explicitTotal = totalMatch
      ? Number.parseInt(totalMatch[1]!, 10)
      : null;

    const dimKeys = Array.isArray(rawDims)
      ? rawDims.filter((k): k is string => typeof k === 'string')
      : [];
    const labelsMap =
      rawLabels && typeof rawLabels === 'object' && !Array.isArray(rawLabels)
        ? (rawLabels as Record<string, unknown>)
        : {};
    const valuesMap =
      rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)
        ? (rawValues as Record<string, unknown>)
        : {};
    const displayMatrix =
      rawDisplayData &&
      typeof rawDisplayData === 'object' &&
      !Array.isArray(rawDisplayData)
        ? (rawDisplayData as Record<string, unknown>)
        : null;

    const matrixEntries = displayMatrix ? Object.values(displayMatrix) : [];
    const inferredTotal =
      explicitTotal ??
      (matrixEntries.length > 0 ? matrixEntries.length : null);

    const effectiveKeys =
      dimKeys.length > 0 ? dimKeys : Object.keys(valuesMap);
    const dimensions: VariationDimensionSummaryInput[] = [];

    effectiveKeys.forEach((key, dimIdx) => {
      const displayLabel =
        typeof labelsMap[key] === 'string' && labelsMap[key].trim()
          ? labelsMap[key]
          : humanizeDimensionKey(key);
      if (!displayLabel) return;

      const directArr = Array.isArray(valuesMap[key])
        ? (valuesMap[key] as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          )
        : [];

      let optionValues = directArr;
      if (optionValues.length === 0 && matrixEntries.length > 0) {
        const collected: string[] = [];
        for (const tuple of matrixEntries) {
          if (Array.isArray(tuple) && typeof tuple[dimIdx] === 'string') {
            collected.push(tuple[dimIdx]);
          }
        }
        optionValues = collected;
      }

      if (optionValues.length > 0) {
        dimensions.push({ label: displayLabel, values: optionValues });
      }
    });

    const formatted = formatVariationDimensionsSummary(
      dimensions,
      inferredTotal,
    );
    if (formatted) return formatted;
    // If `twister-js-init-dpx-data` explicitly declared a singleton (`<= 1`), stop cleanly.
    if (inferredTotal !== null && inferredTotal <= 1) return null;
  }
  return null;
}

function extractTwisterOptionLabel(optionEl: Element): string {
  const aria = normalizeWhitespace(optionEl.getAttribute('aria-label'));
  if (aria && !/^select\b/i.test(aria)) {
    return aria.replace(/^click to select\s+/i, '').trim();
  }

  const titleAttr = normalizeWhitespace(optionEl.getAttribute('title'));
  if (titleAttr) {
    const cleaned = titleAttr.replace(/^click to select\s+/i, '').trim();
    if (cleaned) return cleaned;
  }

  const imgAlt = normalizeWhitespace(
    optionEl.querySelector('img[alt]')?.getAttribute('alt'),
  );
  if (imgAlt) return imgAlt;

  const textTarget = optionEl.querySelector(
    '.swatch-title-text-display, .twisterTextDiv p, .twisterTextDiv',
  );
  if (textTarget) {
    return normalizeWhitespace(textTarget.textContent);
  }

  if (optionEl.tagName === 'OPTION') {
    const valAttr = optionEl.getAttribute('value');
    if (valAttr === '-1' || valAttr === '') return '';
    return normalizeWhitespace(optionEl.textContent);
  }

  const buttonText = optionEl.querySelector('.a-button-text');
  const sourceNode = buttonText ?? optionEl;
  const clone = sourceNode.cloneNode(true) as Element;
  for (const noise of safeQuerySelectorAll(
    clone,
    '.twisterSwatchPrice, .a-price, .a-color-price, script, style',
  )) {
    noise.remove();
  }
  return normalizeWhitespace(clone.textContent);
}

/**
 * SAD-357: extracts product variations using a 3-tier waterfall:
 *   Tier 1: Embedded `twister-js-init-dpx-data` JSON payload (exact counts + all dimensions)
 *   Tier 2: Inline twister (`#inline-twister-row-*`) and classic `#twister` DOM rows
 *   Tier 3: Media/Book format swatches (`#tmmSwatches .swatchElement`)
 */
function extractDetailVariations(doc: Document): string | undefined {
  const scriptSummary = extractTwisterScriptVariations(doc);
  if (scriptSummary) return scriptSummary;

  const domRows = [
    ...safeQuerySelectorAll(doc, AMAZON_SELECTORS.detail.twister.inlineRows),
    ...safeQuerySelectorAll(doc, AMAZON_SELECTORS.detail.twister.classicRows),
  ].filter((row) => !isInsideExcludedDetailSubtree(row));

  if (domRows.length > 0) {
    const dims: VariationDimensionSummaryInput[] = [];
    for (const row of domRows) {
      const labelNode = row.querySelector(
        '.a-form-label, [id^="inline-twister-dim-title-"] .a-color-secondary',
      );
      let label = normalizeWhitespace(labelNode?.textContent)
        .replace(/:+$/, '')
        .trim();
      if (!label) {
        const headerFallback = normalizeWhitespace(
          row.querySelector(AMAZON_SELECTORS.detail.twister.inlineDimTitle)
            ?.textContent,
        );
        if (headerFallback) {
          label = headerFallback.split(':')[0]!.trim();
        }
      }
      if (!label && row.id) {
        label = humanizeDimensionKey(row.id);
      }
      if (!label) continue;

      const optionEls = safeQuerySelectorAll(
        row,
        'li[data-asin], li[data-defaultasin], li[id], select option',
      );
      const values = optionEls
        .map(extractTwisterOptionLabel)
        .filter((v) => Boolean(v) && !/^select\b/i.test(v));

      if (values.length > 0) {
        dims.push({ label, values });
      }
    }

    const total =
      dims.length > 1
        ? dims.reduce((acc, d) => acc * d.values.length, 1)
        : dims[0]?.values.length ?? null;
    const domSummary = formatVariationDimensionsSummary(dims, total);
    if (domSummary) return domSummary;
  }

  const mediaSwatches = safeQuerySelectorAll(
    doc,
    AMAZON_SELECTORS.detail.twister.mediaSwatches,
  ).filter((el) => !isInsideExcludedDetailSubtree(el));
  if (mediaSwatches.length >= 2) {
    const formats: string[] = [];
    for (const swatch of mediaSwatches) {
      const slotTitle = swatch.querySelector(
        '.slot-title span, .slot-title, a.a-button-text > span:first-child',
      );
      const text = normalizeWhitespace(slotTitle?.textContent)
        .replace(/\s+format$/i, '')
        .trim();
      if (text && !formats.includes(text)) {
        formats.push(text);
      }
    }
    const mediaSummary = formatVariationDimensionsSummary(
      [{ label: 'Format', values: formats }],
      formats.length,
    );
    if (mediaSummary) return mediaSummary;
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

    // Warranty (SAD-349) — structured detail tables only, PDP-exclusive.
    const warranty = extractDetailWarranty(doc);

    // Variations & Weight (SAD-357)
    const variations = extractDetailVariations(doc);
    const weight = extractDetailWeight(doc);

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
    if (variations !== undefined) candidate.variations = variations;
    if (weight !== undefined) candidate.weight = weight;
    // SAD-349: both halves or neither — a token with no source text would make
    // the normalized form the only surviving copy of what the page said.
    if (warranty) {
      candidate.warrantyDescription = warranty.warrantyDescription;
      candidate.warrantyDescriptionRaw = warranty.warrantyDescriptionRaw;
    }

    return validateAndNormalizeScrapedProduct(candidate, activeUrl);
  } catch (err) {
    console.warn('[PPHunt] Failed to parse product detail page:', err);
    return null;
  }
}

export const parseProductDetail = parseAmazonProductDetail;
