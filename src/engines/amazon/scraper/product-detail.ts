import type { AmazonExtractionTier, ScrapedAmazonProduct } from '../types';
import {
  applyValidationResults,
  type FieldDiagnosticsCollector,
} from './extraction-diagnostics';
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
  extractAmazonElementText,
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
  scanDiscountNodes,
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
import {
  DEAL_LABEL_PATTERN,
  DEAL_CONTAINER_SELECTORS,
  deriveDealFromPrices,
  detectDealEvidence,
} from './deal-evidence';

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
  // SAD-359: optional; records which source resolved the ASIN. Behaviour is
  // identical with or without it.
  diagnostics?: FieldDiagnosticsCollector,
): string | null {
  const fromUrl = extractASIN(pageUrl);
  if (fromUrl) {
    diagnostics?.extracted('asin', { source: 'url' });
    return fromUrl;
  }

  const hiddenInputSelector =
    'input#ASIN, input[name="ASIN"], input[name="ASIN.0"], input[name="idx.asin"]';
  const hiddenInputs = safeQuerySelectorAll<HTMLInputElement>(
    doc,
    hiddenInputSelector,
  );
  for (const input of hiddenInputs) {
    const asin = normalizeASIN(input.value || input.getAttribute('value'));
    if (asin) {
      diagnostics?.extracted('asin', {
        source: 'dom',
        selector: hiddenInputSelector,
      });
      return asin;
    }
  }

  const canonical = safeQuerySelector<HTMLLinkElement>(
    doc,
    'link[rel="canonical"]',
  );
  const fromCanonical = extractASIN(canonical?.getAttribute('href'));
  if (fromCanonical) {
    diagnostics?.extracted('asin', {
      source: 'dom',
      selector: 'link[rel="canonical"]',
    });
    return fromCanonical;
  }

  const detailRootSelector = '#dp-container[data-asin], #dp[data-asin], [data-asin]';
  const detailRoot = safeQuerySelector(doc, detailRootSelector);
  const fromDataAttr = normalizeASIN(detailRoot?.getAttribute('data-asin'));
  if (fromDataAttr) {
    diagnostics?.extracted('asin', {
      source: 'dom',
      selector: detailRootSelector,
    });
    return fromDataAttr;
  }

  if (jsonLd?.asin) {
    diagnostics?.extracted('asin', { source: 'json-ld' });
    return jsonLd.asin;
  }

  diagnostics?.missing('asin', 'no ASIN in URL, page markup or JSON-LD', { source: 'url' });
  return null;
}

function extractDetailBsr(
  doc: Document,
  // SAD-359: optional diagnostics sink (see extractDetailAsin).
  diagnostics?: FieldDiagnosticsCollector,
): string | undefined {
  let labelSeenSelector: string | undefined;

  for (const selector of AMAZON_SELECTORS.detail.bsr) {
    const container = safeQuerySelector(doc, selector);
    if (!container) continue;
    const rawText = normalizeWhitespace(container.textContent);
    if (!/Best Sellers Rank/i.test(rawText)) continue;
    labelSeenSelector ??= selector;

    // Strip parenthetical "(See Top 100 in ...)" before extracting rank clauses
    const cleaned = rawText.replace(/\(\s*See Top\s+\d+[^)]*\)/gi, ' ');
    const rankMatches = Array.from(
      cleaned.matchAll(/#\d[\d,]*\s+in\s+[A-Za-z0-9 &,'/-]+/g),
      (m) => normalizeWhitespace(m[0]),
    ).filter(Boolean);

    if (rankMatches.length >= 2) {
      diagnostics?.extracted('bestSellersRank', { source: 'dom', selector });
      return `${rankMatches[0]} (${rankMatches[1]})`;
    }
    if (rankMatches.length === 1) {
      diagnostics?.extracted('bestSellersRank', { source: 'dom', selector });
      return rankMatches[0];
    }
  }

  if (labelSeenSelector) {
    diagnostics?.parseFailed(
      'bestSellersRank',
      'Best Sellers Rank label present but no rank could be parsed',
      { selector: labelSeenSelector },
    );
  } else {
    diagnostics?.missing(
      'bestSellersRank',
      'no Best Sellers Rank row in the detail tables',
      { source: 'dom' },
    );
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
function extractDetailWarranty(
  doc: Document,
  // SAD-359: optional diagnostics sink (see extractDetailAsin).
  diagnostics?: FieldDiagnosticsCollector,
): DetailWarranty | undefined {
  let labelSeen = false;

  for (const selector of AMAZON_SELECTORS.detail.warrantyContainers) {
    const container = safeQuerySelector(doc, selector);
    if (!container || isInsideExcludedDetailSubtree(container)) continue;

    for (const { label, value } of iterDetailSpecRows(container)) {
      if (!AMAZON_WARRANTY_LABEL_PATTERN.test(label)) continue;
      labelSeen = true;

      const warrantyDescription = normalizeWarrantyDescription(value);
      if (!warrantyDescription) continue;

      diagnostics?.extracted('warrantyDescription', {
        source: 'dom',
        selector,
      });
      return { warrantyDescription, warrantyDescriptionRaw: value };
    }
  }

  if (labelSeen) {
    diagnostics?.parseFailed(
      'warrantyDescription',
      'warranty row present but no duration could be parsed',
    );
  } else {
    diagnostics?.missing(
      'warrantyDescription',
      'no warranty row in the detail tables',
      { source: 'dom' },
    );
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
function extractDetailWeight(
  doc: Document,
  // SAD-359: optional diagnostics sink (see extractDetailAsin).
  diagnostics?: FieldDiagnosticsCollector,
): string | undefined {
  let labelSeenSelector: string | undefined;
  let packageWeightFallback: string | undefined;
  let packageWeightSelector: string | undefined;
  let dimensionsWeightFallback: string | undefined;
  let dimensionsWeightSelector: string | undefined;

  for (const selector of AMAZON_SELECTORS.detail.warrantyContainers) {
    const container = safeQuerySelector(doc, selector);
    if (!container || isInsideExcludedDetailSubtree(container)) continue;

    for (const { label, value } of iterDetailSpecRows(container)) {
      if (AMAZON_WEIGHT_ITEM_LABEL_PATTERN.test(label)) {
        labelSeenSelector ??= selector;
        const normalized = normalizeWeightValue(value);
        if (normalized) {
          diagnostics?.extracted('weight', { source: 'dom', selector });
          return normalized;
        }
        continue;
      }

      if (
        packageWeightFallback === undefined &&
        AMAZON_WEIGHT_PACKAGE_LABEL_PATTERN.test(label)
      ) {
        labelSeenSelector ??= selector;
        const normalized = normalizeWeightValue(value);
        if (normalized) {
          packageWeightFallback = normalized;
          packageWeightSelector = selector;
        }
        continue;
      }

      if (
        dimensionsWeightFallback === undefined &&
        AMAZON_DIMENSIONS_LABEL_PATTERN.test(label) &&
        value.includes(';')
      ) {
        const weightSegment = value.split(';').slice(1).join(';');
        const normalized = normalizeWeightValue(weightSegment);
        if (normalized) {
          dimensionsWeightFallback = normalized;
          dimensionsWeightSelector = selector;
        }
      }
    }
  }

  if (packageWeightFallback !== undefined) {
    diagnostics?.extracted('weight', {
      source: 'dom',
      selector: packageWeightSelector,
    });
    return packageWeightFallback;
  }
  if (dimensionsWeightFallback !== undefined) {
    diagnostics?.extracted('weight', {
      source: 'dom',
      selector: dimensionsWeightSelector,
    });
    return dimensionsWeightFallback;
  }

  const aplusContainer = safeQuerySelector(doc, '#aplus');
  if (aplusContainer && !isInsideExcludedDetailSubtree(aplusContainer)) {
    for (const { label, value } of iterDetailSpecRows(aplusContainer)) {
      if (!AMAZON_WEIGHT_ITEM_LABEL_PATTERN.test(label)) continue;
      labelSeenSelector ??= '#aplus';
      const normalized = normalizeWeightValue(value);
      if (normalized) {
        diagnostics?.extracted('weight', { source: 'dom', selector: '#aplus' });
        return normalized;
      }
    }
  }

  if (labelSeenSelector) {
    diagnostics?.parseFailed(
      'weight',
      'weight row present but no positive mass could be parsed',
      { selector: labelSeenSelector },
    );
  } else {
    diagnostics?.missing('weight', 'no weight row in the detail tables', { source: 'dom' });
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

function extractTwisterScriptVariations(doc: Document): {
  summary: string | null;
  singleton: boolean;
} {
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
    if (formatted) return { summary: formatted, singleton: false };
    // If `twister-js-init-dpx-data` explicitly declared a singleton (`<= 1`), stop cleanly.
    if (inferredTotal !== null && inferredTotal <= 1) {
      return { summary: null, singleton: true };
    }
  }
  return { summary: null, singleton: false };
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
function extractDetailVariations(
  doc: Document,
  // SAD-359: optional diagnostics sink (see extractDetailAsin).
  diagnostics?: FieldDiagnosticsCollector,
): string | undefined {
  const scriptResult = extractTwisterScriptVariations(doc);
  if (scriptResult.summary) {
    diagnostics?.extracted('variations', {
      source: 'dom',
      selector: 'script[twister-js-init-dpx-data]',
    });
    return scriptResult.summary;
  }

  const inlineRows = safeQuerySelectorAll(
    doc,
    AMAZON_SELECTORS.detail.twister.inlineRows,
  ).filter((row) => !isInsideExcludedDetailSubtree(row));
  const classicRows = safeQuerySelectorAll(
    doc,
    AMAZON_SELECTORS.detail.twister.classicRows,
  ).filter((row) => !isInsideExcludedDetailSubtree(row));
  const domRows = [...inlineRows, ...classicRows];

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
    if (domSummary) {
      diagnostics?.extracted('variations', {
        source: 'dom',
        selector:
          inlineRows.length > 0
            ? AMAZON_SELECTORS.detail.twister.inlineRows
            : AMAZON_SELECTORS.detail.twister.classicRows,
      });
      return domSummary;
    }
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
    if (mediaSummary) {
      diagnostics?.extracted('variations', {
        source: 'dom',
        selector: AMAZON_SELECTORS.detail.twister.mediaSwatches,
      });
      return mediaSummary;
    }
  }

  diagnostics?.missing(
    'variations',
    scriptResult.singleton
      ? 'singleton product (no multi-option variations)'
      : 'no variation twister or format swatches in the fetched HTML',
    { source: 'dom' },
  );
  return undefined;
}

/**
 * Parses an Amazon Product Detail (`/dp/<ASIN>`) page.
 * Prioritizes `#corePriceDisplay_desktop_feature_div` / `#buybox` over ad carousels.
 */
export function parseAmazonProductDetail(
  doc: Document = document,
  pageUrl?: string,
  // SAD-359: optional per-field diagnostics out-parameter. Every `diag?.`
  // call below only *records* an outcome the parser already reached; the
  // product returned is identical with or without a collector (parity is
  // pinned by tests/extraction-diagnostics.test.ts).
  diagnostics?: FieldDiagnosticsCollector,
): ScrapedAmazonProduct | null {
  const diag = diagnostics;
  try {
    const activeUrl =
      pageUrl ??
      (typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'https://www.amazon.com');

    const jsonLd = extractProductJsonLd(doc);
    const asin = extractDetailAsin(doc, activeUrl, jsonLd, diag);
    if (!asin) {
      return null;
    }
    diag?.setAsin(asin);

    // Title
    let title: string | null = null;
    let titleSelector: string | undefined;
    let titleRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.title) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        const text = normalizeWhitespace(el.textContent);
        if (text) {
          title = text;
          titleSelector = selector;
          break;
        }
        titleRejectedSelector ??= selector;
      }
    }
    if (title && titleSelector) {
      diag?.extracted('title', { source: 'dom', selector: titleSelector });
    }
    if (!title && jsonLd.title) {
      title = jsonLd.title;
      if (titleRejectedSelector) {
        diag?.rescued('title', 'title node present but empty; JSON-LD fallback used', {
          source: 'json-ld',
          selector: titleRejectedSelector,
        });
      } else {
        diag?.extracted('title', { source: 'json-ld' });
      }
    }
    if (!title) {
      if (titleRejectedSelector) {
        diag?.parseFailed('title', 'title node present but empty', {
          selector: titleRejectedSelector,
        });
      } else {
        diag?.missing('title', 'no title node or JSON-LD name in the fetched HTML', { source: 'dom' });
      }
      return null;
    }

    // Brand
    let brand: string | null = null;
    let brandSelector: string | undefined;
    let brandRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.brand) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        brand = cleanBrand(el.textContent);
        if (brand) {
          brandSelector = selector;
          break;
        }
        brandRejectedSelector ??= selector;
      }
    }
    if (brand && brandSelector) {
      diag?.extracted('brand', { source: 'dom', selector: brandSelector });
    }
    if (!brand && jsonLd.brand) {
      brand = jsonLd.brand;
      if (brandRejectedSelector) {
        diag?.rescued(
          'brand',
          'brand node present but rejected by the field parser; JSON-LD fallback used',
          { source: 'json-ld', selector: brandRejectedSelector },
        );
      } else {
        diag?.extracted('brand', { source: 'json-ld' });
      }
    }
    if (!brand) {
      if (brandRejectedSelector) {
        diag?.parseFailed('brand', 'brand node present but rejected by the field parser', {
          selector: brandRejectedSelector,
        });
      } else {
        diag?.missing('brand', 'no byline/brand node or JSON-LD brand in the fetched HTML', { source: 'dom' });
      }
    }

    // Scoped Buybox Pricing & Discounts
    const pageCurrency = resolvePageCurrency(activeUrl);
    let price: number | null = null;
    let currency: string | null = pageCurrency;
    let listPrice: number | undefined;
    let discountPercentage: string | undefined;
    let dealBadge: string | undefined;
    // SAD-386 (diagnostics-only): true when `dealBadge` came from evidence
    // (struck list price) rather than from text the page printed.
    let dealBadgeDerived = false;
    let coupon: string | undefined;

    // SAD-359: pricing provenance. The shared card pricing cascade is not
    // instrumented internally, so at this level "a buybox scope element was
    // present" is the candidate signal; the winning scope + priceTier say
    // where a value came from.
    let buyboxScopeSeen = false;
    let priceScopeSelector: string | undefined;
    let priceTier: AmazonExtractionTier | undefined;
    let listPriceSelector: string | undefined;
    let discountSelector: string | undefined;
    let dealBadgeSelector: string | undefined;
    let couponSelector: string | undefined;

    for (const scopeSelector of AMAZON_SELECTORS.detail.buyboxScopes) {
      const scopeEl = safeQuerySelector(doc, scopeSelector);
      if (!scopeEl || isInsideExcludedDetailSubtree(scopeEl)) continue;
      buyboxScopeSeen = true;

      const scopedPricing = extractCardPricingAndDiscounts(scopeEl, activeUrl);
      if (price === null && scopedPricing.price !== null) {
        price = scopedPricing.price;
        currency = scopedPricing.currency ?? pageCurrency;
        priceScopeSelector = scopeSelector;
        priceTier = scopedPricing.priceTier;
      }
      if (listPrice === undefined && scopedPricing.listPrice !== undefined) {
        listPrice = scopedPricing.listPrice;
        listPriceSelector = scopeSelector;
      }
      if (
        discountPercentage === undefined &&
        scopedPricing.discountPercentage !== undefined
      ) {
        discountPercentage = scopedPricing.discountPercentage;
        discountSelector = scopeSelector;
      }
      if (dealBadge === undefined && scopedPricing.dealBadge !== undefined) {
        dealBadge = scopedPricing.dealBadge;
        dealBadgeSelector = scopeSelector;
        dealBadgeDerived = scopedPricing.dealBadgeDerived === true;
      }
      if (coupon === undefined && scopedPricing.coupon !== undefined) {
        coupon = scopedPricing.coupon;
        couponSelector = scopeSelector;
      }
      // SAD-386: the loop used to stop as soon as ONE scope yielded a price, so
      // a later scope that carried the savings percentage, the deal badge or the
      // coupon was never read (`product-detail.ts:957` before this change).
      // Every field is still first-wins, so the price that wins today still wins;
      // the loop now stops only when all five fields are settled.
      if (
        price !== null &&
        listPrice !== undefined &&
        discountPercentage !== undefined &&
        dealBadge !== undefined &&
        coupon !== undefined
      ) {
        break;
      }
    }

    // Check legacy `#priceblock_ourprice` / `#priceblock_dealprice` if still null
    const legacyPriceSelector =
      '#priceblock_dealprice, #priceblock_ourprice, #price_inside_buybox';
    let priceFromLegacy = false;
    let legacyPriceRejected = false;
    if (price === null) {
      const legacyEl = safeQuerySelector(doc, legacyPriceSelector);
      if (legacyEl && !isInsideExcludedDetailSubtree(legacyEl)) {
        const parsed = parsePrice(legacyEl.textContent, pageCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency ?? pageCurrency;
          priceFromLegacy = true;
        } else {
          legacyPriceRejected = true;
        }
      }
    }

    let priceFromJsonLd = false;
    if (price === null && jsonLd.price !== undefined) {
      price = jsonLd.price;
      currency = jsonLd.currency ?? pageCurrency;
      priceFromJsonLd = true;
    }

    if (price !== null && priceScopeSelector) {
      diag?.extracted('price', {
        source: 'dom',
        selector: priceScopeSelector,
        ...(priceTier ? { tier: priceTier } : {}),
      });
    } else if (price !== null && priceFromLegacy) {
      diag?.extracted('price', { source: 'legacy', selector: legacyPriceSelector });
    } else if (price !== null && priceFromJsonLd) {
      if (buyboxScopeSeen || legacyPriceRejected) {
        diag?.rescued(
          'price',
          'buybox present but no parseable DOM price; JSON-LD fallback used',
          { source: 'json-ld' },
        );
      } else {
        diag?.extracted('price', { source: 'json-ld' });
      }
    } else if (buyboxScopeSeen || legacyPriceRejected) {
      diag?.parseFailed('price', 'buybox/price node present but no parseable price');
    } else {
      diag?.missing('price', 'no buybox or price node in the fetched HTML', { source: 'dom' });
    }
    // Currency always resolves (pricing → page → USD), so it is a derived value.
    diag?.extracted('currency', { source: 'derived' });

    const listPriceFallbackSelector =
      '#corePriceDisplay_desktop_feature_div [data-a-strike="true"] .a-offscreen, #corePrice_feature_div [data-a-strike="true"] .a-offscreen, #apex_desktop .basisPrice .a-offscreen, #listPrice';
    let listPriceRejected = false;
    if (listPrice === undefined) {
      const strikeEls = safeQuerySelectorAll(doc, listPriceFallbackSelector);
      for (const el of strikeEls) {
        if (isInsideExcludedDetailSubtree(el)) continue;
        const parsed = parsePrice(el.textContent, currency ?? pageCurrency);
        if (
          parsed.value !== null &&
          (price === null || parsed.value > price)
        ) {
          listPrice = parsed.value;
          listPriceSelector = listPriceFallbackSelector;
          break;
        }
        listPriceRejected = true;
      }
    }
    if (listPrice !== undefined) {
      diag?.extracted('listPrice', { source: 'dom', selector: listPriceSelector });
    } else if (listPriceRejected) {
      diag?.parseFailed(
        'listPrice',
        'struck-through price node present but rejected (unparseable or not above selling price)',
        { selector: listPriceFallbackSelector },
      );
    } else {
      diag?.missing('listPrice', 'no list price shown on the page', { source: 'dom' });
    }

    // SAD-386 (diagnostics-only): a percentage node existed but was refused.
    let discountNodeSeen = false;
    const savingsSelector =
      '#corePriceDisplay_desktop_feature_div .savingsPercentage, #corePrice_feature_div .savingsPercentage, #apex_desktop .savingsPercentage';
    let savingsRejected = false;
    if (discountPercentage === undefined) {
      const savEl = safeQuerySelector(doc, savingsSelector);
      if (savEl && !isInsideExcludedDetailSubtree(savEl)) {
        discountPercentage = normalizeDiscountBadge(savEl.textContent);
        if (discountPercentage !== undefined) {
          discountSelector = savingsSelector;
        } else {
          savingsRejected = true;
        }
      }
    }
    if (discountPercentage !== undefined) {
      diag?.extracted('discountPercentage', {
        source: discountSelector === 'detail-root:bounded-scan' ? 'derived' : 'dom',
        selector: discountSelector,
      });
    } else if (discountNodeSeen) {
      // SAD-386: honest status — a node was present and the parser refused it.
      diag?.parseFailed(
        'discountPercentage',
        'a percentage node is present but its text is not a product discount (coupon, out of range, or unreadable)',
        { selector: savingsSelector },
      );
    } else if (savingsRejected) {
      diag?.parseFailed(
        'discountPercentage',
        'savings percentage node present but unparseable',
        { selector: savingsSelector },
      );
    } else {
      diag?.missing('discountPercentage', 'no discount shown on the page', { source: 'dom' });
    }

    // SAD-386: still nothing? Scan the detail root container with the same
    // bounded rules the listing path uses. No new Amazon-specific selector: this
    // reads a label wherever the central column renders one.
    const detailRoot = safeQuerySelector(
      doc,
      AMAZON_SELECTORS.detail.rootContainers.join(', '),
    );
    if (discountPercentage === undefined && detailRoot) {
      const scanned = scanDiscountNodes(detailRoot, {
        skip: isInsideExcludedDetailSubtree,
      });
      if (scanned.value !== undefined) {
        discountPercentage = scanned.value;
        discountSelector = 'detail-root:bounded-scan';
      }
      if (scanned.nodeSeen) discountNodeSeen = true;
    }

    let dealBadgeRejectedSelector: string | undefined;
    // SAD-386: a derived value never outranks a badge the page actually printed,
    // so the badge search still runs when the current value is derived.
    if (dealBadge === undefined || dealBadgeDerived) {
      // SAD-386: the card list first (unchanged order), then the extra badge
      // containers the card list does not name — both against the SAME shared
      // vocabulary, which previously differed between this path and the card path.
      // The result is collected in a local so an *already derived* value cannot
      // terminate the search (it did on the first run: every PDP with a struck
      // list price reported "Deal" instead of its printed badge).
      let printedBadge: string | undefined;
      let printedBadgeSelector: string | undefined;
      for (const selector of [
        ...AMAZON_SELECTORS.cardFields.dealBadge,
        ...DEAL_CONTAINER_SELECTORS,
      ]) {
        const els = safeQuerySelectorAll(doc, selector);
        for (const el of els) {
          if (isInsideExcludedDetailSubtree(el)) continue;
          const text = normalizeWhitespace(el.textContent);
          if (text && DEAL_LABEL_PATTERN.test(text)) {
            printedBadge = text;
            printedBadgeSelector = selector;
            break;
          }
          dealBadgeRejectedSelector ??= selector;
        }
        if (printedBadge !== undefined) break;
      }
      if (printedBadge !== undefined) {
        dealBadge = printedBadge;
        dealBadgeSelector = printedBadgeSelector;
        dealBadgeDerived = false;
      }
    }
    // SAD-386: a deal label rendered anywhere in the central column (a promo
    // block, a badge slot the lists above do not name) — bounded by the same
    // non-badge regions and text length as the card path.
    if (dealBadge === undefined && detailRoot) {
      const evidence = detectDealEvidence(detailRoot, {
        skip: isInsideExcludedDetailSubtree,
      });
      if (evidence) {
        dealBadge = evidence.value;
        dealBadgeDerived = evidence.derived;
        dealBadgeSelector = 'detail-root:evidence';
      }
    }
    // SAD-386 (D5): a struck-through list price above the selling price proves a
    // deal even when the page prints no badge at all.
    if (dealBadge === undefined) {
      const derived = deriveDealFromPrices(price, listPrice);
      if (derived) {
        dealBadge = derived.value;
        dealBadgeDerived = derived.derived;
        dealBadgeSelector = 'derived:list-price';
      }
    }
    if (dealBadge !== undefined) {
      diag?.extracted('dealBadge', {
        source: dealBadgeDerived ? 'derived' : 'dom',
        selector: dealBadgeSelector,
      });
    } else if (dealBadgeRejectedSelector) {
      diag?.parseFailed('dealBadge', 'badge-like node present but its text is not a deal badge', {
        selector: dealBadgeRejectedSelector,
      });
    } else {
      diag?.missing('dealBadge', 'no deal badge shown on the page', { source: 'dom' });
    }

    let couponRejectedSelector: string | undefined;
    if (coupon === undefined) {
      for (const selector of AMAZON_SELECTORS.cardFields.coupon) {
        const el = safeQuerySelector(doc, selector);
        if (!el || isInsideExcludedDetailSubtree(el)) continue;
        const text = normalizeWhitespace(el.textContent);
        if (text && /coupon|voucher|rabatt/i.test(text)) {
          coupon = text.replace(/\s*Terms\s*$/i, '').trim();
          couponSelector = selector;
          break;
        }
        couponRejectedSelector ??= selector;
      }
    }
    if (coupon !== undefined) {
      diag?.extracted('coupon', { source: 'dom', selector: couponSelector });
    } else if (couponRejectedSelector) {
      diag?.parseFailed('coupon', 'coupon-like node present but its text is not a coupon', {
        selector: couponRejectedSelector,
      });
    } else {
      diag?.missing('coupon', 'no coupon shown on the page', { source: 'dom' });
    }

    // Past Month Sales
    const pastMonthSelector =
      '#social-proofing-faceout-title-tk_bought span, #social-proofing-faceout-title-tk_bought';
    let pastMonthSales: string | undefined;
    let pastMonthRejected = false;
    let pastMonthFromScan = false;
    const boughtEl = safeQuerySelector(doc, pastMonthSelector);
    if (boughtEl && !isInsideExcludedDetailSubtree(boughtEl)) {
      const text = normalizeWhitespace(boughtEl.textContent);
      const match =
        /(\d+(?:[.,]\d+)?\s*[KkMm+]?\+?\s*bought in past month)/i.exec(text);
      if (match?.[1]) {
        pastMonthSales = match[1].trim();
      } else {
        pastMonthRejected = true;
      }
    }
    if (!pastMonthSales && (doc.body || doc.documentElement)) {
      pastMonthSales = extractCardPastMonthSales(
        (doc.body ?? doc.documentElement)!,
      );
      pastMonthFromScan = pastMonthSales !== undefined;
    }
    if (pastMonthSales !== undefined) {
      diag?.extracted('pastMonthSales', {
        source: 'dom',
        selector: pastMonthFromScan ? '(document text scan)' : pastMonthSelector,
      });
    } else if (pastMonthRejected) {
      diag?.parseFailed(
        'pastMonthSales',
        'social-proof node present but the bought-in-past-month pattern did not match',
        { selector: pastMonthSelector },
      );
    } else {
      diag?.missing('pastMonthSales', 'no bought-in-past-month social proof on the page', { source: 'dom' });
    }

    // Rating & Review count
    const ratingSelector =
      '#acrPopover, #averageCustomerReviews [data-action="acrStarsLink-click-metrics"]';
    let rating: number | null = null;
    let ratingRejected = false;
    let ratingFromJsonLd = false;
    const acrPopover = safeQuerySelector(doc, ratingSelector);
    if (acrPopover && !isInsideExcludedDetailSubtree(acrPopover)) {
      rating = parseRating(
        acrPopover.getAttribute('title') ||
          acrPopover.getAttribute('aria-label') ||
          acrPopover.textContent,
      );
      ratingRejected = rating === null;
    }
    if (rating === null && jsonLd.rating !== undefined) {
      rating = jsonLd.rating;
      ratingFromJsonLd = true;
    }
    if (rating !== null && !ratingFromJsonLd) {
      diag?.extracted('rating', { source: 'dom', selector: ratingSelector });
    } else if (rating !== null && ratingFromJsonLd) {
      if (ratingRejected) {
        diag?.rescued('rating', 'rating node present but unparseable; JSON-LD fallback used', {
          source: 'json-ld',
          selector: ratingSelector,
        });
      } else {
        diag?.extracted('rating', { source: 'json-ld' });
      }
    } else if (ratingRejected) {
      diag?.parseFailed('rating', 'rating node present but unparseable', {
        selector: ratingSelector,
      });
    } else {
      diag?.missing('rating', 'no rating node or JSON-LD aggregateRating in the fetched HTML', { source: 'dom' });
    }

    let reviewCount: number | null = null;
    let reviewRejected = false;
    let reviewFromJsonLd = false;
    const reviewEl = safeQuerySelector(doc, '#acrCustomerReviewText');
    if (reviewEl && !isInsideExcludedDetailSubtree(reviewEl)) {
      reviewCount = parseReviewCount(reviewEl.textContent);
      reviewRejected = reviewCount === null;
    }
    if (reviewCount === null && jsonLd.reviewCount !== undefined) {
      reviewCount = jsonLd.reviewCount;
      reviewFromJsonLd = true;
    }
    if (reviewCount !== null && !reviewFromJsonLd) {
      diag?.extracted('reviewCount', { source: 'dom', selector: '#acrCustomerReviewText' });
    } else if (reviewCount !== null && reviewFromJsonLd) {
      if (reviewRejected) {
        diag?.rescued(
          'reviewCount',
          'review-count node present but unparseable; JSON-LD fallback used',
          { source: 'json-ld', selector: '#acrCustomerReviewText' },
        );
      } else {
        diag?.extracted('reviewCount', { source: 'json-ld' });
      }
    } else if (reviewRejected) {
      diag?.parseFailed('reviewCount', 'review-count node present but unparseable', {
        selector: '#acrCustomerReviewText',
      });
    } else {
      diag?.missing(
        'reviewCount',
        'no review-count node or JSON-LD aggregateRating in the fetched HTML',
        { source: 'dom' },
      );
    }

    // Availability
    let availability: string | null = null;
    let availabilitySelector: string | undefined;
    let availabilityRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.availability) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        // SAD-392: read text without Amazon's embedded scripts — the buybox
        // `#availability` div carries an a-state JSON <script> on every PDP,
        // and the reported variant an AOD loader script next to the message.
        availability = cleanAvailability(extractAmazonElementText(el));
        if (availability) {
          availabilitySelector = selector;
          break;
        }
        availabilityRejectedSelector ??= selector;
      }
    }
    if (availability) {
      diag?.extracted('availability', { source: 'dom', selector: availabilitySelector });
    } else if (availabilityRejectedSelector) {
      diag?.parseFailed(
        'availability',
        'availability node present but rejected by the field parser',
        { selector: availabilityRejectedSelector },
      );
    } else {
      diag?.missing('availability', 'no availability node in the fetched HTML', { source: 'dom' });
    }

    // Delivery
    let delivery: string | undefined;
    let deliverySelector: string | undefined;
    let deliveryRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.delivery) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        const text = normalizeWhitespace(el.textContent);
        if (text) {
          delivery = text;
          deliverySelector = selector;
          break;
        }
        deliveryRejectedSelector ??= selector;
      }
    }
    if (delivery !== undefined) {
      diag?.extracted('delivery', { source: 'dom', selector: deliverySelector });
    } else if (deliveryRejectedSelector) {
      diag?.parseFailed('delivery', 'delivery node present but empty', {
        selector: deliveryRejectedSelector,
      });
    } else {
      diag?.missing('delivery', 'no delivery block in the fetched HTML', { source: 'dom' });
    }

    // Seller
    let seller: string | null = null;
    let sellerSelector: string | undefined;
    let sellerRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.seller) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        seller = cleanSeller(el.textContent);
        if (seller) {
          sellerSelector = selector;
          break;
        }
        sellerRejectedSelector ??= selector;
      }
    }
    if (seller) {
      diag?.extracted('seller', { source: 'dom', selector: sellerSelector });
    } else if (sellerRejectedSelector) {
      diag?.parseFailed('seller', 'seller node present but rejected by the field parser', {
        selector: sellerRejectedSelector,
      });
    } else {
      diag?.missing('seller', 'no seller/merchant node in the fetched HTML', { source: 'dom' });
    }

    // Features
    const features: string[] = [];
    let featuresSelector: string | undefined;
    let featureNodesSeen = 0;
    for (const selector of AMAZON_SELECTORS.detail.features) {
      const items = safeQuerySelectorAll(doc, selector);
      const before = features.length;
      for (const item of items) {
        if (isInsideExcludedDetailSubtree(item)) continue;
        featureNodesSeen += 1;
        const text = normalizeWhitespace(item.textContent);
        if (text && !features.includes(text)) {
          features.push(text);
        }
      }
      if (features.length > before) featuresSelector = selector;
      if (features.length > 0) break;
    }
    if (features.length > 0) {
      diag?.extracted('features', { source: 'dom', selector: featuresSelector });
    } else if (featureNodesSeen > 0) {
      diag?.parseFailed('features', 'feature bullet nodes present but empty');
    } else {
      diag?.missing('features', 'no feature bullets in the fetched HTML', { source: 'dom' });
    }

    // Description
    let description: string | null = null;
    let descriptionSelector: string | undefined;
    let descriptionRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.description) {
      const el = safeQuerySelector(doc, selector);
      if (el && !isInsideExcludedDetailSubtree(el)) {
        const text = normalizeWhitespace(el.textContent);
        if (text) {
          description = text;
          descriptionSelector = selector;
          break;
        }
        descriptionRejectedSelector ??= selector;
      }
    }
    if (description && descriptionSelector) {
      diag?.extracted('description', { source: 'dom', selector: descriptionSelector });
    }
    if (!description && jsonLd.description) {
      description = jsonLd.description;
      if (descriptionRejectedSelector) {
        diag?.rescued(
          'description',
          'description node present but empty; JSON-LD fallback used',
          { source: 'json-ld', selector: descriptionRejectedSelector },
        );
      } else {
        diag?.extracted('description', { source: 'json-ld' });
      }
    }
    if (!description) {
      if (descriptionRejectedSelector) {
        diag?.parseFailed('description', 'description node present but empty', {
          selector: descriptionRejectedSelector,
        });
      } else {
        diag?.missing(
          'description',
          'no description node or JSON-LD description in the fetched HTML',
          { source: 'dom' },
        );
      }
    }

    // High-res Image
    let imageUrl: string | null = null;
    let imageSelector: string | undefined;
    let imageRejectedSelector: string | undefined;
    for (const selector of AMAZON_SELECTORS.detail.images) {
      const img = safeQuerySelector(doc, selector);
      if (img && !isInsideExcludedDetailSubtree(img)) {
        imageUrl = extractBestImageUrl(img);
        if (imageUrl) {
          imageSelector = selector;
          break;
        }
        imageRejectedSelector ??= selector;
      }
    }
    if (imageUrl && imageSelector) {
      diag?.extracted('imageUrl', { source: 'dom', selector: imageSelector });
    }
    if (!imageUrl && jsonLd.imageUrl) {
      imageUrl = jsonLd.imageUrl;
      if (imageRejectedSelector) {
        diag?.rescued(
          'imageUrl',
          'image node present but no usable URL; JSON-LD fallback used',
          { source: 'json-ld', selector: imageRejectedSelector },
        );
      } else {
        diag?.extracted('imageUrl', { source: 'json-ld' });
      }
    }
    if (!imageUrl) {
      if (imageRejectedSelector) {
        diag?.parseFailed('imageUrl', 'image node present but no usable URL', {
          selector: imageRejectedSelector,
        });
      } else {
        diag?.missing('imageUrl', 'no product image node or JSON-LD image in the fetched HTML', { source: 'dom' });
      }
    }

    // BSR
    const bestSellersRank = extractDetailBsr(doc, diag);

    // Warranty (SAD-349) — structured detail tables only, PDP-exclusive.
    const warranty = extractDetailWarranty(doc, diag);

    // Variations & Weight (SAD-357)
    const variations = extractDetailVariations(doc, diag);
    const weight = extractDetailWeight(doc, diag);

    // Prime
    const isPrime = Boolean(
      safeQuerySelector(
        doc,
        '#bbop-sbbop-container, #buybox i.a-icon-prime, #desktop_buybox i.a-icon-prime, #apex_desktop i.a-icon-prime, i.a-icon-prime, #mir-layout-DELIVERY_BLOCK [data-csa-c-delivery-price="FREE"]',
      ) ||
        (delivery && /\bFREE delivery\b/i.test(delivery)),
    );
    if (isPrime) {
      diag?.extracted('isPrime', { source: 'derived' });
    } else {
      diag?.missing('isPrime', 'no Prime marker found', { source: 'derived' });
    }

    const url = resolveProductUrl(null, asin, activeUrl);
    // SAD-359: the product URL is derived from the resolved ASIN and the
    // marketplace origin, so it is part of what this page yielded.
    if (url) {
      diag?.extracted('url', { source: 'url' });
    } else {
      diag?.missing(
        'url',
        'no product URL could be derived from the ASIN and page origin',
        { source: 'derived' },
      );
    }

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

    const normalized = validateAndNormalizeScrapedProduct(candidate, activeUrl);
    // SAD-359: reconcile the recorded outcomes with validation (a value the
    // parser produced but validation dropped becomes PARTIAL, validated:false).
    if (diag) applyValidationResults(diag, candidate, normalized);
    return normalized;
  } catch (err) {
    console.warn('[PPHunt] Failed to parse product detail page:', err);
    return null;
  }
}

export const parseProductDetail = parseAmazonProductDetail;
