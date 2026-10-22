import { TemuScrapedProductSchema } from '../schemas/scraped-product';
import type { TemuProductSource, TemuScrapedProduct } from '../types';
import {
  normalizeTemuSalesText,
  parseTemuPrice,
  parseTemuSplitPrice,
} from '../utils/price-parser';
import {
  extractGoodsId,
  normalizeGoodsId,
  resolveTemuProductUrl,
} from '../utils/temu-url';
import type {
  FieldDiagnosticsCollector,
  TemuDiagnosticField,
} from './extraction-diagnostics';
import { TEMU_SELECTORS } from './selectors';

/**
 * 4-Layer Future-Proof Field Extraction & Validation Helpers for Temu.
 *
 * Layer 1: Structured JSON-LD (`application/ld+json`) & SSR metadata
 * Layer 2: Semantic `data-tooltip`, `data-type`, `data-js-*`, and ARIA contracts
 * Layer 3: Structural `goodsId` anchor-graph & single-product card boundary heuristics
 * Layer 4: Strict Zod boundary validation & non-fabrication (`null` when absent)
 */

const TEMU_RATING_PATTERNS: RegExp[] = [
  // "4.8 out of five stars", "4.8 out of 5 stars", "4.8/5"
  /([0-5](?:[.,]\d+)?)\s*(?:out\s+of\s+(?:five|5)\b|\/\s*5\b)/i,
  // "Rated 4.8 stars"
  /\b(?:rated|rating|score)\s*[:：]?\s*([0-5](?:[.,]\d+)?)\b/i,
];

/**
 * Cleans and normalizes text extracted from a DOM node or attribute.
 */
export function cleanTemuText(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = text
    .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Extracts text from an Element while ignoring `<script>`, `<style>`, and `<noscript>` descendants.
 */
export function extractTemuElementText(
  el: Element | null | undefined
): string | null {
  if (!el) return null;
  if (!el.querySelector('script, style, noscript')) {
    return cleanTemuText(el.textContent);
  }
  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll('script, style, noscript')
    .forEach((node) => node.remove());
  return cleanTemuText(clone.textContent);
}

/**
 * Parses a 0–5 star rating from Temu ARIA labels or rating text.
 */
export function parseTemuRating(
  text: string | null | undefined
): number | null {
  const cleaned = cleanTemuText(text);
  if (!cleaned) return null;

  for (const pattern of TEMU_RATING_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      const value = Number.parseFloat(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value >= 0 && value <= 5) {
        return Math.round(value * 10) / 10;
      }
    }
  }

  if (/^[0-5][.,]\d{1,2}$/.test(cleaned)) {
    const value = Number.parseFloat(cleaned.replace(',', '.'));
    if (Number.isFinite(value) && value >= 0 && value <= 5) {
      return Math.round(value * 10) / 10;
    }
  }

  return null;
}

/**
 * Parses a customer review count as a non-negative integer.
 * Strips rating phrases ("4.8 out of five stars") and sales tokens ("10K+ sold")
 * so neither is ever mistaken for a review count.
 */
export function parseTemuReviewCount(
  text: string | null | undefined
): number | null {
  if (!text) return null;

  const cleaned = text
    .replace(/[\u200B-\u200F\uFEFF\u00A0]/g, ' ')
    .replace(
      /[0-5](?:[.,]\d+)?\s*(?:out\s+of\s+(?:five|5)|\/\s*5)(?:\s*stars?)?/gi,
      ' '
    )
    .replace(/\b\d+(?:[.,]\d+)?\s*[KkMm]?\+?\s*sold\b/gi, ' ')
    .replace(/(?:^|\s)#\d+\b/g, ' ')
    .trim();

  if (!cleaned) return null;

  // Reject bare decimal star scores like "4.8" when not accompanied by "reviews"/"ratings" or parens
  if (/^[0-5]\.\d$/.test(cleaned)) {
    return null;
  }

  // Match compact notation like "(2.4K)", "1.2K reviews", "15k+"
  const compactMatch = cleaned.match(/(\d+(?:[.,]\d+)?)\s*([kKmM])\+?\b/);
  if (compactMatch?.[1] && compactMatch[2]) {
    const base = Number.parseFloat(compactMatch[1].replace(',', '.'));
    const multiplier =
      compactMatch[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
    if (Number.isFinite(base) && base >= 0) {
      return Math.round(base * multiplier);
    }
  }

  // Match parenthesized or labeled review count e.g. "(1,245)" or "1,245 reviews"
  const intMatch = cleaned.match(/(\d{1,3}(?:[.,\s]\d{3})+|\d+)/);
  if (!intMatch?.[1]) return null;

  const digitsOnly = intMatch[1].replace(/[.,\s]/g, '');
  const value = Number.parseInt(digitsOnly, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Normalizes a displayed discount badge (e.g. "-68%", "68% OFF", "Save 45%")
 * into a consistent "68% off" string, or returns null if absent.
 * Never calculates a discount from price and listPrice.
 */
export function normalizeTemuDiscountPercentage(
  raw: string | null | undefined
): string | null {
  const cleaned = cleanTemuText(raw);
  if (!cleaned) return null;

  if (/\bcoupon\b/i.test(cleaned)) return null;

  const minusMatch = cleaned.match(
    /(?:^|[\s(])[-−–]\s*(\d{1,2}(?:\.\d+)?)\s*%(?:[\s)]|$)/
  );
  if (minusMatch?.[1]) {
    const num = Number(minusMatch[1]);
    if (num > 0 && num < 100) return `${minusMatch[1]}% off`;
  }

  const offMatch = cleaned.match(
    /\b(\d{1,2}(?:\.\d+)?)\s*%\s*(?:off|savings|discount)\b/i
  );
  if (offMatch?.[1]) {
    const num = Number(offMatch[1]);
    if (num > 0 && num < 100) return `${offMatch[1]}% off`;
  }

  const saveMatch = cleaned.match(/\bsave\s+(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (saveMatch?.[1]) {
    const num = Number(saveMatch[1]);
    if (num > 0 && num < 100) return `${saveMatch[1]}% off`;
  }

  return null;
}

/**
 * Extracts `goodsId` from a product card element or its descendants using
 * semantic attributes (`data-tooltip="goodContainer-<id>"`, `data-goods-id`)
 * and product anchor hrefs (`/*-g-<id>.html`, `?goods_id=<id>`).
 */
export function extractGoodsIdFromCard(card: Element): {
  goodsId: string | null;
  linkHref: string | null;
} {
  const directTooltip = card.getAttribute('data-tooltip');
  const directId =
    extractGoodsId(directTooltip) ??
    normalizeGoodsId(card.getAttribute('data-goods-id'));

  const nestedTooltipEl = card.querySelector(
    '[data-tooltip^="goodContainer-"], [data-tooltip^="goodName-"], [data-tooltip^="GoodsSimilar-"], [data-goods-id]'
  );
  const nestedId =
    extractGoodsId(nestedTooltipEl?.getAttribute('data-tooltip')) ??
    normalizeGoodsId(nestedTooltipEl?.getAttribute('data-goods-id'));

  const links = Array.from(
    card.querySelectorAll<HTMLAnchorElement>(TEMU_SELECTORS.listing.productLink)
  );
  if (card.tagName === 'A' && card.hasAttribute('href')) {
    links.unshift(card as HTMLAnchorElement);
  }

  let linkHref: string | null = null;
  let linkGoodsId: string | null = null;
  for (const a of links) {
    const href = a.getAttribute('href') ?? a.href ?? '';
    const extracted = extractGoodsId(href);
    if (extracted) {
      linkGoodsId = extracted;
      linkHref = href;
      break;
    }
  }

  return {
    goodsId: directId ?? nestedId ?? linkGoodsId,
    linkHref,
  };
}

/**
 * Walks up the DOM from an inner anchor or tooltip element to find the outermost
 * container that still represents a SINGLE `goodsId` product card.
 */
export function resolveSingleGoodsCardContainer(
  el: Element,
  targetGoodsId: string | null | undefined
): Element {
  const normalizedTarget = normalizeGoodsId(targetGoodsId);
  if (!normalizedTarget) return el;

  const hasConflictingGoodsId = (candidate: Element): boolean => {
    const selfId =
      extractGoodsId(candidate.getAttribute('data-tooltip')) ??
      normalizeGoodsId(candidate.getAttribute('data-goods-id'));
    if (selfId && selfId !== normalizedTarget) return true;

    const tooltipNodes = candidate.querySelectorAll(
      '[data-tooltip^="goodContainer-"], [data-tooltip^="goodName-"], [data-goods-id]'
    );
    for (const node of tooltipNodes) {
      const nodeId =
        extractGoodsId(node.getAttribute('data-tooltip')) ??
        normalizeGoodsId(node.getAttribute('data-goods-id'));
      if (nodeId && nodeId !== normalizedTarget) return true;
    }

    const links = candidate.querySelectorAll<HTMLAnchorElement>(
      TEMU_SELECTORS.listing.productLink
    );
    for (const link of links) {
      const linkId = extractGoodsId(link.getAttribute('href'));
      if (linkId && linkId !== normalizedTarget) return true;
    }

    return false;
  };

  let current = el;
  let steps = 0;
  while (steps < 7 && current.parentElement) {
    const parent = current.parentElement;
    const tag = parent.tagName.toUpperCase();
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') break;
    if (
      parent.classList.contains('js-search-goodsList') ||
      parent.classList.contains('js-category-goodsList') ||
      parent.classList.contains('auto-fit-list')
    ) {
      break;
    }
    if (
      parent.children.length > 24 ||
      parent.querySelectorAll('img').length > 12
    ) {
      break;
    }
    if (hasConflictingGoodsId(parent)) break;

    current = parent;
    steps++;

    if (
      current.getAttribute('data-tooltip')?.startsWith('goodContainer-') &&
      current.querySelector('img')
    ) {
      break;
    }
  }

  return current;
}

/**
 * Drops nested elements so only the outermost container per card is kept (O(N * depth)).
 */
export function dropNestedTemuCards(cards: Element[]): Element[] {
  const cardSet = new Set<Element>(cards);
  const out: Element[] = [];
  for (const card of cards) {
    let hasAncestorInSet = false;
    for (let p = card.parentElement; p; p = p.parentElement) {
      if (cardSet.has(p)) {
        hasAncestorInSet = true;
        break;
      }
    }
    if (!hasAncestorInSet) {
      out.push(card);
    }
  }
  return out;
}

/**
 * Discovers all Temu product card containers in a listing document or scope container.
 * Uses Layer 2 semantic `[data-tooltip^="goodContainer-"]` cards first, then supplements
 * with Layer 3 structural `/*-g-<goodsId>.html` / `?goods_id=` anchor discovery.
 */
export function discoverTemuProductCards(
  root: Document | Element
): Element[] {
  const cards: Element[] = [];
  const seenGoodsIds = new Set<string>();

  // Layer 2: Semantic `goodContainer-<goodsId>` nodes
  const semanticNodes = Array.from(
    root.querySelectorAll(TEMU_SELECTORS.listing.productCard)
  );
  for (const node of semanticNodes) {
    const { goodsId } = extractGoodsIdFromCard(node);
    if (!goodsId || seenGoodsIds.has(goodsId)) continue;
    const expanded = resolveSingleGoodsCardContainer(node, goodsId);
    seenGoodsIds.add(goodsId);
    cards.push(expanded);
  }

  // Layer 3: Structural fallback via product links (`-g-<goodsId>.html` or `goods_id=<goodsId>`)
  const productLinks = Array.from(
    root.querySelectorAll<HTMLAnchorElement>(TEMU_SELECTORS.listing.productLink)
  );
  for (const link of productLinks) {
    const goodsId = extractGoodsId(link.getAttribute('href'));
    if (!goodsId || seenGoodsIds.has(goodsId)) continue;
    const container = resolveSingleGoodsCardContainer(link, goodsId);
    seenGoodsIds.add(goodsId);
    cards.push(container);
  }

  return dropNestedTemuCards(cards);
}

/**
 * Extracts the product title from a Temu card using:
 * 1. `data-tooltip-title` on `goodContainer-${goodsId}` or `goodName-${goodsId}` (full un-truncated title)
 * 2. Semantic headings (`h1`, `h2`, `h3`) or `[role="link"][aria-label]`
 * 3. Product link text
 * 4. Primary image `alt` attribute (stripping Temu's `"item picture "` prefix)
 */
export function extractTemuCardTitle(
  card: Element,
  imageEl: HTMLImageElement | null,
  diagnostics?: FieldDiagnosticsCollector
): string | null {
  // SAD-360: candidate bookkeeping on the nodes this function already reads.
  let sawTitleCandidate = false;

  const hit = (
    value: string | null,
    selector: string
  ): string | null => {
    if (value) diagnostics?.extracted('title', { source: 'dom', selector });
    return value;
  };

  // 1. Direct or nested data-tooltip-title (emitted by Temu's bui-web-goods-list)
  const directTooltipTitle = cleanTemuText(
    card.getAttribute('data-tooltip-title')
  );
  if (card.hasAttribute('data-tooltip-title')) sawTitleCandidate = true;
  if (directTooltipTitle) {
    return hit(directTooltipTitle, '[data-tooltip-title]');
  }

  const tooltipTitleEl = card.querySelector(
    '[data-tooltip^="goodName-"][data-tooltip-title], [data-tooltip^="goodContainer-"][data-tooltip-title], [data-tooltip-title]'
  );
  if (tooltipTitleEl) sawTitleCandidate = true;
  const nestedTooltipTitle = cleanTemuText(
    tooltipTitleEl?.getAttribute('data-tooltip-title')
  );
  if (nestedTooltipTitle) {
    return hit(nestedTooltipTitle, '[data-tooltip-title]');
  }

  // 2. goodName element text or heading
  const goodNameEl = card.querySelector('[data-tooltip^="goodName-"]');
  if (goodNameEl) sawTitleCandidate = true;
  const goodNameText =
    cleanTemuText(goodNameEl?.getAttribute('aria-label')) ??
    extractTemuElementText(goodNameEl);
  if (goodNameText) {
    return hit(goodNameText, '[data-tooltip^="goodName-"]');
  }

  const headings = Array.from(card.querySelectorAll('h1, h2, h3, h4'));
  if (headings.length > 0) sawTitleCandidate = true;
  for (const h of headings) {
    const t =
      cleanTemuText(h.getAttribute('aria-label')) ?? extractTemuElementText(h);
    if (t && t.length >= 3) return hit(t, 'h1, h2, h3, h4');
  }

  // 3. Product anchor aria-label / title / text
  const links = Array.from(
    card.querySelectorAll<HTMLAnchorElement>(TEMU_SELECTORS.listing.productLink)
  );
  if (links.length > 0) sawTitleCandidate = true;
  for (const a of links) {
    const aria = cleanTemuText(a.getAttribute('aria-label'));
    if (aria && aria.length >= 4 && !/^\$?\d/.test(aria)) {
      return hit(
        aria.replace(/^item\s+picture\s+/i, '').trim(),
        TEMU_SELECTORS.listing.productLink
      );
    }
    const text = extractTemuElementText(a);
    if (text && text.length >= 4 && !/^[\d,.\s$€£¥%-]+$/.test(text)) {
      return hit(text, TEMU_SELECTORS.listing.productLink);
    }
  }

  // 4. Primary image alt attribute (Temu sets alt="item picture <Title>")
  const rawAlt = cleanTemuText(imageEl?.getAttribute('alt'));
  if (rawAlt) {
    sawTitleCandidate = true;
    const stripped = rawAlt.replace(/^item\s+picture\s+/i, '').trim();
    if (stripped.length >= 2) return hit(stripped, 'img[alt]');
  }

  if (diagnostics) {
    if (sawTitleCandidate) {
      diagnostics.parseFailed(
        'title',
        'title candidates present but all rejected',
        { source: 'dom' }
      );
    } else {
      diagnostics.missing(
        'title',
        'no title tooltip, heading, link text, or image alt',
        { source: 'dom' }
      );
    }
  }

  return null;
}

/**
 * SAD-380: one shared reference-price vocabulary (was F5: four divergent lists).
 * En wording is measured from Temu's own i18n bundle ("Original price {0}",
 * "strikethrough price"); other locales keep degrading to the semantic
 * selectors. Always test with a fresh literal — never share a /g regex.
 */
const TEMU_REFERENCE_PRICE_LABEL_SOURCE =
  '\\b(?:original|regular|was|list|strikethrough)\\s+price\\b';
const TEMU_CURRENT_PRICE_LABEL_SOURCE = '\\b(?:current|selling|sale)\\s+price\\b';
const TEMU_CURRENCY_TOKEN_SOURCE =
  '(?:US\\$|CA\\$|AU\\$|C\\$|A\\$|[\\$€£¥￥]|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|CNY)\\b)';
const TEMU_LABELLED_AMOUNT_SOURCE = `(${TEMU_CURRENCY_TOKEN_SOURCE}\\s*\\d[\\d,.]*|\\d[\\d,.]*\\s*(?:€|£|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|CNY)\\b))`;

function hasTemuCurrencyToken(raw: string): boolean {
  return new RegExp(TEMU_CURRENCY_TOKEN_SOURCE, 'i').test(raw);
}

/**
 * Extracts the amount of a labelled price segment ("original price is: $32.99"
 * / "current price is: $11.49") so dual-price accessible strings never depend
 * on first-token order (SAD-380 F3).
 */
function parseTemuLabelledPriceSegment(
  text: string,
  labelSource: string,
  fallbackCurrency: string
): { value: number | null; currency: string | null } {
  const match = text.match(
    new RegExp(
      `${labelSource}\\s*(?:is)?\\s*[:：]?\\s*${TEMU_LABELLED_AMOUNT_SOURCE}`,
      'i'
    )
  );
  if (!match?.[1]) return { value: null, currency: null };
  return parseTemuPrice(match[1], fallbackCurrency);
}

/** Removes one labelled segment (label + amount) from a dual-price string. */
function stripTemuLabelledPriceSegment(text: string, labelSource: string): string {
  return text
    .replace(
      new RegExp(
        `${labelSource}\\s*(?:is)?\\s*[:：]?\\s*${TEMU_LABELLED_AMOUNT_SOURCE}`,
        'i'
      ),
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Presentation-semantic strike test (SAD-380): Temu's own term for the
 * reference price is "strikethrough price", and the live capture showed the
 * assumed `[data-type="priceText"]` hook carrying promo text instead. A node
 * counts as struck via its inline style or the computed style in a real
 * browser; `del`/`s`/`strike` tags are already selector candidates.
 */
function isTemuStruckPresentation(el: Element): boolean {
  const inline = el.getAttribute('style') ?? '';
  if (/text-decoration(?:-line)?\s*:[^;]*line-through/i.test(inline)) {
    return true;
  }
  try {
    const view = el.ownerDocument?.defaultView;
    const computed = view?.getComputedStyle?.(el as HTMLElement);
    const line = `${computed?.textDecorationLine ?? ''} ${computed?.textDecoration ?? ''}`;
    return line.includes('line-through');
  } catch {
    return false;
  }
}

function isTemuReferenceOrStrikePriceNode(el: Element | null): boolean {
  if (!el) return false;
  if (
    el.closest(
      '[data-type="priceText"], [data-type="unitPrice"], [data-type="discount"], del, s, strike, [aria-label*="Original price" i], [aria-label*="Regular price" i], [aria-label*="List price" i]'
    )
  ) {
    return true;
  }
  const aria = el.getAttribute('aria-label') ?? '';
  if (new RegExp(TEMU_REFERENCE_PRICE_LABEL_SOURCE, 'i').test(aria)) {
    return true;
  }
  return false;
}

/**
 * Extracts selling `price`, `currency`, original `listPrice`, and `discountPercentage`
 * from a Temu card or PDP price container.
 * Strictly separates `[data-type="price"]` from `[data-type="priceText"]` and never
 * calculates values that are not displayed on the page.
 */
export function extractTemuPricing(
  container: Element,
  fallbackCurrency = 'USD',
  diagnostics?: FieldDiagnosticsCollector
): {
  price: number | null;
  currency: string | null;
  listPrice: number | null;
  discountPercentage: string | null;
} {
  let price: number | null = null;
  let currency: string | null = null;
  let listPrice: number | null = null;
  let discountPercentage: string | null = null;

  // SAD-360: candidate bookkeeping only — no new queries, no reordering.
  let sawPriceNode = false;
  let priceSelector: string | null = null;
  let sawListPriceNode = false;
  let sawDiscountNode = false;

  // SAD-380: srOnly labelled segments join the list-price candidate pool in
  // section 2 (they no longer assign `listPrice` directly, so one ranking —
  // and one truthful provenance — decides every source).
  let srOnlyListPrice: number | null = null;
  let srOnlyListCurrency: string | null = null;
  let listPriceSelectorUsed: string | null = null;
  let sawRejectedAtOrBelowPrice = false;
  let sawExcludedListCandidate = false;

  // 1. Current selling price via semantic `[data-type="price"]`
  const priceNodes = Array.from(
    container.querySelectorAll('[data-type="price"]')
  );
  for (const priceNode of priceNodes) {
    if (isTemuReferenceOrStrikePriceNode(priceNode)) continue;
    sawPriceNode = true;

    // Prefer accessible `.srOnly` or `aria-label` inside `[data-type="price"]`
    const srOnly = priceNode.querySelector('[class*="srOnly"], .sr-only');
    const srOnlyText = cleanTemuText(srOnly?.textContent);
    if (srOnlyText && srOnlyListPrice === null) {
      // SAD-380 F3: capture the labelled reference segment for the pool;
      // the selling parse below reads the labelled current segment or the
      // string with the reference segment stripped — never first-token luck.
      const origParsed = parseTemuLabelledPriceSegment(
        srOnlyText,
        TEMU_REFERENCE_PRICE_LABEL_SOURCE,
        fallbackCurrency
      );
      if (origParsed.value !== null) {
        srOnlyListPrice = origParsed.value;
        srOnlyListCurrency = origParsed.currency;
        sawListPriceNode = true;
      }
    }
    let candidateText =
      srOnlyText ??
      cleanTemuText(priceNode.getAttribute('aria-label')) ??
      extractTemuElementText(priceNode);

    if (candidateText) {
      const currentSegment = parseTemuLabelledPriceSegment(
        candidateText,
        TEMU_CURRENT_PRICE_LABEL_SOURCE,
        fallbackCurrency
      );
      if (currentSegment.value !== null) {
        price = currentSegment.value;
        currency = currentSegment.currency;
        priceSelector = '[data-type="price"]';
        break;
      }
      if (srOnlyText && srOnlyListPrice !== null) {
        candidateText = stripTemuLabelledPriceSegment(
          candidateText,
          TEMU_REFERENCE_PRICE_LABEL_SOURCE
        );
      }
    }

    const parsed = parseTemuPrice(candidateText, fallbackCurrency);
    if (parsed.value !== null) {
      price = parsed.value;
      currency = parsed.currency;
      priceSelector = '[data-type="price"]';
      break;
    }

    // Split spans fallback inside `[data-type="price"]`
    const spans = Array.from(priceNode.querySelectorAll('span'));
    if (spans.length >= 2) {
      const texts = spans
        .map((s) => cleanTemuText(s.textContent))
        .filter((t): t is string => Boolean(t));
      const joined = texts.join('');
      const joinedParsed = parseTemuPrice(joined, fallbackCurrency);
      if (joinedParsed.value !== null) {
        price = joinedParsed.value;
        currency = joinedParsed.currency;
        priceSelector = '[data-type="price"]';
        break;
      }
      const splitParsed = parseTemuSplitPrice(
        texts[1],
        texts[2],
        texts[0],
        fallbackCurrency
      );
      if (splitParsed.value !== null) {
        price = splitParsed.value;
        currency = splitParsed.currency;
        priceSelector = '[data-type="price"]';
        break;
      }
    }
  }

  // Fallback for PDP `#goods_price` or heuristic leaf price node when `[data-type="price"]` is absent
  if (price === null) {
    const allNodes = Array.from(
      container.querySelectorAll('[aria-label], span, div, b, strong')
    );
    for (const el of allNodes) {
      if (isTemuReferenceOrStrikePriceNode(el)) continue;
      if (el.children.length > 3) continue;
      const text =
        cleanTemuText(el.getAttribute('aria-label')) ??
        cleanTemuText(el.textContent);
      if (!text || text.length > 36) continue;
      if (
        /(?:US\$|CA\$|AU\$|[\$€£¥])\s*\d/.test(text) &&
        !/\b(?:original|regular|was|list|strikethrough|save|coupon|unit)\b/i.test(text)
      ) {
        sawPriceNode = true;
        const parsed = parseTemuPrice(text, fallbackCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency;
          priceSelector = 'heuristic leaf price node';
          break;
        }
      }
    }
  }

  // 2. Original / Reference List Price — SAD-380 candidate pool (replaces
  // first-match-wins): collect from every proven source, filter, rank, then
  // assign at most one value. A candidate must carry a currency token (F7)
  // and, when the selling price is known, be strictly above it (D4/F2).
  interface ListPriceCandidate {
    value: number;
    currency: string | null;
    rank: number;
    selector: string;
  }
  const listCandidates: ListPriceCandidate[] = [];
  const considerListCandidate = (
    value: number | null,
    candidateCurrency: string | null,
    rank: number,
    selector: string
  ): void => {
    if (value === null) return;
    if (price !== null && value <= price) {
      sawRejectedAtOrBelowPrice = true;
      return;
    }
    listCandidates.push({ value, currency: candidateCurrency, rank, selector });
  };
  const inExcludedPriceScope = (el: Element): boolean =>
    el.closest('[data-type="unitPrice"], [data-type="discount"]') !== null;

  // 2a. Semantic selector candidates (priceText / original-price aria / del / s).
  const selectorCandidates = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.listPrice)
  );
  const seenCandidateEls = new Set<Element>();
  for (const el of selectorCandidates) {
    if (inExcludedPriceScope(el)) {
      sawExcludedListCandidate = true;
      continue;
    }
    sawListPriceNode = true;
    // F8: an ancestor that wraps another candidate (e.g. del > priceText) is
    // a wrapper — the innermost node's own text is the candidate.
    if (
      selectorCandidates.some((other) => other !== el && el.contains(other))
    ) {
      continue;
    }
    seenCandidateEls.add(el);
    const raw =
      cleanTemuText(el.getAttribute('aria-label')) ??
      extractTemuElementText(el);
    if (!raw || !hasTemuCurrencyToken(raw)) continue;
    // A labelled aria ("Original price $29.99, now $12.49") must contribute
    // its labelled amount, never the first token of a dual-price string.
    const labelled = parseTemuLabelledPriceSegment(
      raw,
      TEMU_REFERENCE_PRICE_LABEL_SOURCE,
      currency ?? fallbackCurrency
    );
    const parsed =
      labelled.value !== null
        ? labelled
        : parseTemuPrice(raw, currency ?? fallbackCurrency);
    considerListCandidate(
      parsed.value,
      parsed.currency,
      0,
      TEMU_SELECTORS.listing.listPrice
    );
  }

  // 2b. Reference-price aria labels anywhere in scope (unified vocabulary;
  // covers "List price"/"Was price" nodes the selector's aria list misses).
  const ariaCandidates = Array.from(container.querySelectorAll('[aria-label]'));
  for (const el of ariaCandidates) {
    if (seenCandidateEls.has(el)) continue;
    if (inExcludedPriceScope(el)) continue;
    const aria = cleanTemuText(el.getAttribute('aria-label'));
    if (!aria || aria.length > 120) continue;
    if (!new RegExp(TEMU_REFERENCE_PRICE_LABEL_SOURCE, 'i').test(aria)) {
      continue;
    }
    sawListPriceNode = true;
    seenCandidateEls.add(el);
    const labelled = parseTemuLabelledPriceSegment(
      aria,
      TEMU_REFERENCE_PRICE_LABEL_SOURCE,
      currency ?? fallbackCurrency
    );
    considerListCandidate(
      labelled.value,
      labelled.currency,
      0,
      TEMU_SELECTORS.listing.listPrice
    );
  }

  // 2c. srOnly labelled reference segment captured in section 1.
  if (srOnlyListPrice !== null) {
    considerListCandidate(
      srOnlyListPrice,
      srOnlyListCurrency,
      1,
      'srOnly labelled segment'
    );
  }

  // 2d. Presentation fallback: a struck (line-through), currency-bearing leaf
  // inside this price scope — Temu's "strikethrough price" rendering when no
  // semantic hook carries the value (step-1 capture). Scoped and filtered so
  // it can never reach outside the container already given to this helper.
  if (listCandidates.length === 0) {
    const struckLeaves = Array.from(
      container.querySelectorAll('span, div, b, strong, p')
    );
    for (const el of struckLeaves) {
      if (seenCandidateEls.has(el)) continue;
      if (inExcludedPriceScope(el)) continue;
      if (el.closest('[data-type="price"]')) continue;
      if (el.children.length > 4) continue;
      if (!isTemuStruckPresentation(el)) continue;
      const raw =
        cleanTemuText(el.getAttribute('aria-label')) ??
        extractTemuElementText(el);
      if (!raw || raw.length > 40 || !hasTemuCurrencyToken(raw)) continue;
      sawListPriceNode = true;
      seenCandidateEls.add(el);
      const parsed = parseTemuPrice(raw, currency ?? fallbackCurrency);
      considerListCandidate(
        parsed.value,
        parsed.currency,
        2,
        'struck (line-through) price leaf'
      );
    }
  }

  listCandidates.sort((a, b) => a.rank - b.rank);
  const winningListCandidate = listCandidates[0];
  if (winningListCandidate) {
    listPrice = winningListCandidate.value;
    listPriceSelectorUsed = winningListCandidate.selector;
    if (!currency && winningListCandidate.currency) {
      currency = winningListCandidate.currency;
    }
  }

  // 3. Displayed Discount Percentage (`[data-type="discount"]` or explicit `-68%` / `68% off` badge)
  const discountCandidates = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.discountPercentage)
  );
  for (const el of discountCandidates) {
    sawDiscountNode = true;
    const normalized =
      normalizeTemuDiscountPercentage(el.getAttribute('aria-label')) ??
      normalizeTemuDiscountPercentage(el.textContent);
    if (normalized) {
      discountPercentage = normalized;
      break;
    }
  }

  if (!discountPercentage) {
    const shortEls = Array.from(container.querySelectorAll('span, div'));
    for (const el of shortEls) {
      if (el.children.length > 1) continue;
      const text =
        cleanTemuText(el.getAttribute('aria-label')) ??
        cleanTemuText(el.textContent);
      if (!text || text.length > 24) continue;
      if (/%/.test(text)) sawDiscountNode = true;
      const normalized = normalizeTemuDiscountPercentage(text);
      if (normalized) {
        discountPercentage = normalized;
        break;
      }
    }
  }

  // SAD-360: record what this helper already decided. Candidate presence is the
  // only new information; no branch, order or return value changes.
  if (diagnostics) {
    if (price !== null) {
      diagnostics.extracted('price', {
        source: 'dom',
        selector: priceSelector ?? '[data-type="price"]',
      });
    } else if (sawPriceNode) {
      diagnostics.parseFailed(
        'price',
        'price node present but no parseable price',
        { source: 'dom', selector: '[data-type="price"]' }
      );
    } else {
      diagnostics.missing('price', 'no price node in the price scope', {
        source: 'dom',
      });
    }

    if (listPrice !== null) {
      diagnostics.extracted('listPrice', {
        source: 'dom',
        // SAD-380 F4: report the source that actually won the candidate pool.
        selector: listPriceSelectorUsed ?? TEMU_SELECTORS.listing.listPrice,
      });
    } else if (sawRejectedAtOrBelowPrice) {
      // SAD-380 F9: distinguish "rejected by the >price rule" from unparseable.
      diagnostics.parseFailed(
        'listPrice',
        'list-price candidates rejected: none above selling price',
        { source: 'dom', selector: TEMU_SELECTORS.listing.listPrice }
      );
    } else if (sawListPriceNode) {
      diagnostics.parseFailed(
        'listPrice',
        'list-price node present but no parseable value',
        { source: 'dom', selector: TEMU_SELECTORS.listing.listPrice }
      );
    } else if (sawExcludedListCandidate) {
      diagnostics.parseFailed(
        'listPrice',
        'list-price candidates only in excluded (unit/discount) nodes',
        { source: 'dom', selector: TEMU_SELECTORS.listing.listPrice }
      );
    } else {
      diagnostics.missing('listPrice', 'no original/list price node', {
        source: 'dom',
      });
    }

    if (discountPercentage !== null) {
      diagnostics.extracted('discountPercentage', {
        source: 'dom',
        selector: TEMU_SELECTORS.listing.discountPercentage,
      });
    } else if (sawDiscountNode) {
      diagnostics.parseFailed(
        'discountPercentage',
        'discount node present but not a valid percentage',
        { source: 'dom', selector: TEMU_SELECTORS.listing.discountPercentage }
      );
    } else {
      diagnostics.missing('discountPercentage', 'no discount badge', {
        source: 'dom',
      });
    }

    // Currency always rides along with a parsed price and may be the fallback,
    // so it is reported as a derived value (Amazon SAD-359 precedent).
    if (currency !== null) {
      diagnostics.extracted('currency', { source: 'derived' });
    }
  }

  return { price, currency, listPrice, discountPercentage };
}

/**
 * Extracts sales velocity (`10K+ sold`) from `[data-type="saleTips"]` or leaf spans.
 */
export function extractTemuSalesVolume(
  container: Element,
  diagnostics?: FieldDiagnosticsCollector
): string | null {
  let sawSalesTip = false;

  const saleTipNodes = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.salesTips)
  );
  for (const node of saleTipNodes) {
    sawSalesTip = true;
    const text =
      cleanTemuText(node.getAttribute('aria-label')) ??
      extractTemuElementText(node);
    const normalized = normalizeTemuSalesText(text);
    if (normalized) {
      diagnostics?.extracted('pastMonthSales', {
        source: 'dom',
        selector: TEMU_SELECTORS.listing.salesTips,
      });
      return normalized;
    }
  }

  const allSpans = Array.from(container.querySelectorAll('span, div'));
  for (const el of allSpans) {
    if (el.children.length > 2) continue;
    const text =
      cleanTemuText(el.getAttribute('aria-label')) ??
      cleanTemuText(el.textContent);
    if (!text || text.length > 48) continue;
    if (/[KkMm]\+?\s*sold\b/.test(text)) sawSalesTip = true;
    const normalized = normalizeTemuSalesText(text);
    if (normalized) {
      diagnostics?.extracted('pastMonthSales', {
        source: 'dom',
        selector: 'heuristic sales leaf',
      });
      return normalized;
    }
  }

  if (diagnostics) {
    if (sawSalesTip) {
      diagnostics.parseFailed(
        'pastMonthSales',
        'sales-tip node present but no sales token',
        { source: 'dom' }
      );
    } else {
      diagnostics.missing('pastMonthSales', 'no sales-tip node', {
        source: 'dom',
      });
    }
  }

  return null;
}

/**
 * Extracts star rating (0–5) and review count from a Temu card or PDP review block.
 */
export function extractTemuRatingAndReviews(
  container: Element,
  diagnostics?: FieldDiagnosticsCollector
): {
  rating: number | null;
  reviewCount: number | null;
} {
  let rating: number | null = null;
  let reviewCount: number | null = null;
  // SAD-360: candidate bookkeeping only — no new queries, no reordering.
  let sawRatingNode = false;
  let sawReviewCandidate = false;

  // 1. Check semantic rating nodes (`[role="img"][aria-label*="out of five stars" i]`)
  const ratingNodes = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.rating)
  );
  for (const el of ratingNodes) {
    sawRatingNode = true;
    const r =
      parseTemuRating(el.getAttribute('aria-label')) ??
      parseTemuRating(el.getAttribute('title')) ??
      parseTemuRating(el.textContent);
    if (r !== null) {
      rating = r;
      // Check sibling or parent region for review count (e.g. `(1,234)` or `1,234 reviews`)
      const region = el.closest('[role="region"]') ?? (el.parentElement !== container ? el.parentElement : null);
      if (region && region.children.length <= 5) {
        const regionText =
          cleanTemuText(region.getAttribute('aria-label')) ??
          extractTemuElementText(region);
        const rc = parseTemuReviewCount(regionText);
        if (rc !== null) {
          reviewCount = rc;
        }
      }
      break;
    }
  }

  // 2. Scan explicit review count nodes or parenthesized counts if still missing
  if (reviewCount === null) {
    const candidates = Array.from(
      container.querySelectorAll(
        '[aria-label*="review" i], [aria-label*="rating" i], span, div'
      )
    );
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const aria = cleanTemuText(el.getAttribute('aria-label'));
      if (aria && /\b(?:reviews?|ratings?)\b/i.test(aria)) {
        sawReviewCandidate = true;
        const rc = parseTemuReviewCount(aria);
        if (rc !== null) {
          reviewCount = rc;
          break;
        }
      }
      const text = cleanTemuText(el.textContent);
      if (!text || text.length > 32) continue;
      if (
        /^\(\s*\d[\d,.]*\s*[KkMm]?\+?\s*\)$/.test(text) ||
        /\b\d[\d,.]*\s*[KkMm]?\+?\s*reviews?\b/i.test(text)
      ) {
        sawReviewCandidate = true;
        const rc = parseTemuReviewCount(text);
        if (rc !== null) {
          reviewCount = rc;
          break;
        }
      }
    }
  }

  if (diagnostics) {
    if (rating !== null) {
      diagnostics.extracted('rating', {
        source: 'dom',
        selector: TEMU_SELECTORS.listing.rating,
      });
    } else if (sawRatingNode) {
      diagnostics.parseFailed(
        'rating',
        'rating element present but not a 0-5 value',
        { source: 'dom', selector: TEMU_SELECTORS.listing.rating }
      );
    } else {
      diagnostics.missing('rating', 'no rating element', { source: 'dom' });
    }

    if (reviewCount !== null) {
      diagnostics.extracted('reviewCount', {
        source: 'dom',
        selector: TEMU_SELECTORS.listing.reviewRegion,
      });
    } else if (sawReviewCandidate) {
      diagnostics.parseFailed(
        'reviewCount',
        'review-count node present but not a count',
        { source: 'dom' }
      );
    } else {
      diagnostics.missing('reviewCount', 'no review-count node', {
        source: 'dom',
      });
    }
  }

  return { rating, reviewCount };
}

function isPlaceholderImage(url: string): boolean {
  return /1x1|blank\.gif|spacer|transparent|avatar|icon|logo|sprite/i.test(url);
}

/**
 * Extracts a valid HTTP(S) product image URL from an `<img>` element.
 */
export function extractTemuBestImageUrl(
  imgEl: Element | null | undefined,
  baseUrl = 'https://www.temu.com'
): string | null {
  if (!imgEl) return null;

  const toValidUrl = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (
      !trimmed ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      isPlaceholderImage(trimmed)
    ) {
      return null;
    }
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.protocol === 'https:' || resolved.protocol === 'http:') {
        return resolved.href;
      }
      return null;
    } catch {
      return null;
    }
  };

  const fromSrcset = (srcset: string | null): string | null => {
    if (!srcset) return null;
    const parts = srcset
      .split(',')
      .map((s) => s.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const valid = toValidUrl(parts[i]);
      if (valid) return valid;
    }
    return null;
  };

  return (
    toValidUrl(imgEl.getAttribute('src')) ??
    toValidUrl(imgEl.getAttribute('data-src')) ??
    toValidUrl(imgEl.getAttribute('data-lazy-src')) ??
    fromSrcset(imgEl.getAttribute('srcset')) ??
    fromSrcset(imgEl.getAttribute('data-srcset')) ??
    toValidUrl((imgEl as HTMLImageElement).src) ??
    null
  );
}

/**
 * Finds the best product image URL inside a Temu product card container.
 * Prioritizes `img[data-js-main-img="true"]` and `.goods-img-external` hosted on `kwcdn.com`.
 */
export function findBestTemuCardImage(
  card: Element,
  goodsId?: string | null,
  baseUrl = 'https://www.temu.com',
  diagnostics?: FieldDiagnosticsCollector
): { imageUrl: string | null; imageEl: HTMLImageElement | null } {
  // SAD-360: candidate bookkeeping only.
  let sawImageElement = false;

  const selectorFor = (img: HTMLImageElement, url: string): string => {
    if (img.getAttribute('data-js-main-img') === 'true') {
      return 'img[data-js-main-img="true"]';
    }
    if (img.classList.contains('goods-img-external')) {
      return 'img.goods-img-external';
    }
    if (/kwcdn\.com/i.test(url)) return 'img[src*="kwcdn.com"]';
    return 'img';
  };

  const searchIn = (
    container: Element
  ): { imageUrl: string | null; imageEl: HTMLImageElement | null } => {
    const primaryImgs = Array.from(
      container.querySelectorAll<HTMLImageElement>(TEMU_SELECTORS.listing.image)
    );
    const allImgs = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
    const candidates = Array.from(new Set([...primaryImgs, ...allImgs]));
    if (candidates.length > 0) sawImageElement = true;

    let fallbackUrl: string | null = null;
    let fallbackEl: HTMLImageElement | null = null;

    for (const img of candidates) {
      const url = extractTemuBestImageUrl(img, baseUrl);
      if (!url) continue;
      if (
        img.getAttribute('data-js-main-img') === 'true' ||
        img.classList.contains('goods-img-external') ||
        /kwcdn\.com/i.test(url)
      ) {
        diagnostics?.extracted('imageUrl', {
          source: 'dom',
          selector: selectorFor(img, url),
        });
        return { imageUrl: url, imageEl: img };
      }
      if (!fallbackUrl) {
        fallbackUrl = url;
        fallbackEl = img;
      }
    }

    if (fallbackUrl) {
      diagnostics?.extracted('imageUrl', { source: 'dom', selector: 'img' });
    }
    return { imageUrl: fallbackUrl, imageEl: fallbackEl };
  };

  const direct = searchIn(card);
  if (direct.imageUrl) return direct;

  if (goodsId) {
    const expanded = resolveSingleGoodsCardContainer(card, goodsId);
    if (expanded !== card) {
      const expandedResult = searchIn(expanded);
      if (expandedResult.imageUrl) return expandedResult;
      recordCardImageAbsence(diagnostics, sawImageElement);
      return expandedResult;
    }
  }

  recordCardImageAbsence(diagnostics, sawImageElement);
  return direct;
}

function recordCardImageAbsence(
  diagnostics: FieldDiagnosticsCollector | undefined,
  sawImageElement: boolean
): void {
  if (!diagnostics) return;
  if (sawImageElement) {
    diagnostics.parseFailed(
      'imageUrl',
      'image element present but no valid http(s) URL',
      { source: 'dom' }
    );
  } else {
    diagnostics.missing('imageUrl', 'no image element in the card', {
      source: 'dom',
    });
  }
}

/**
 * Extracts secondary promotional badges, seller/mall info, stock notices, and shipping tags from a Temu card or PDP.
 */
export function extractTemuCardMetadata(
  container: Element,
  diagnostics?: FieldDiagnosticsCollector
): {
  brand: string | null;
  seller: string | null;
  availability: string | null;
  dealBadge: string | null;
  badge: string | null;
  coupon: string | null;
  delivery: string | null;
  bestSellersRank: string | null;
  isSponsored: boolean;
  isPrime: boolean;
} {
  let brand: string | null = null;
  let seller: string | null = null;
  let availability: string | null = null;
  let dealBadge: string | null = null;
  let badge: string | null = null;
  let coupon: string | null = null;
  let delivery: string | null = null;
  let bestSellersRank: string | null = null;
  let isSponsored = false;
  let isPrime = false;
  // SAD-360: label-prefix evidence only — the match rules are unchanged.
  let sawBrandLabel = false;
  let sawSellerLabel = false;

  const nodes = Array.from(container.querySelectorAll('span, div, a, p'));
  for (const el of nodes) {
    if (el.children.length > 2) continue;
    const text =
      cleanTemuText(el.getAttribute('aria-label')) ??
      cleanTemuText(el.textContent);
    if (!text || text.length > 90) continue;

    // Sponsored / Ad indicator
    if (/^(?:Ad|Sponsored)$/i.test(text)) {
      isSponsored = true;
    }

    // Local warehouse / Fast delivery (mapped to isPrime + delivery)
    if (/\bLocal\s+warehouse\b/i.test(text)) {
      isPrime = true;
      if (!delivery) delivery = 'Local warehouse';
      if (!badge) badge = 'Local warehouse';
    } else if (
      !delivery &&
      /\b(?:Free\s+shipping|Free\s+delivery|Fast\s+delivery|Ships\s+from\s+Temu)\b/i.test(
        text
      )
    ) {
      delivery = text;
    }

    // Deal badge
    if (
      !dealBadge &&
      /\b(?:Lightning\s+deal|Limited[- ]time\s+offer|Limited[- ]time\s+deal|Flash\s+sale|Clearance|Big\s+save)\b/i.test(
        text
      )
    ) {
      dealBadge = text;
    }

    // Best Sellers Rank
    if (
      !bestSellersRank &&
      /#\d+\s+(?:Best\s*Seller|Top\s*Rated|Most\s*Popular)(?:\s+in\s+[^.|]+)?/i.test(
        text
      )
    ) {
      bestSellersRank = text;
    }

    // Recognition badge
    if (
      !badge &&
      /\b(?:Star\s+store|Top\s+pick|Best\s+Seller|Popular\s+pick)\b/i.test(text)
    ) {
      badge = text;
    }

    // Coupon offer
    if (
      !coupon &&
      /\b(?:coupon|extra\s+\d+%\s+off|save\s+\$\d+(?:\.\d+)?\s+with)\b/i.test(
        text
      )
    ) {
      coupon = text;
    }

    // Availability / low stock
    if (
      !availability &&
      /\b(?:Only\s+\d+\s+left|Almost\s+sold\s+out|Sold\s+out|In\s+Stock|Out\s+of\s+Stock)\b/i.test(
        text
      )
    ) {
      availability = text;
    }

    // Seller / Mall
    if (!seller) {
      const soldByMatch = text.match(
        /^(?:Sold\s+by|Provided\s+by|Shop|Store)\s*[:：]?\s*(.+)$/i
      );
      if (soldByMatch?.[1]) {
        seller = cleanTemuText(soldByMatch[1]);
        if (!seller) sawSellerLabel = true;
      } else if (
        /^(?:Sold\s+by|Provided\s+by|Shop|Store)\s*[:：]?\s*$/i.test(text)
      ) {
        sawSellerLabel = true;
      }
    }

    // Brand
    if (!brand) {
      const brandMatch = text.match(/^Brand\s*[:：]\s*(.+)$/i);
      if (brandMatch?.[1]) {
        brand = cleanTemuText(brandMatch[1]);
        if (!brand) sawBrandLabel = true;
      } else if (/^Brand\s*[:：]?\s*$/i.test(text)) {
        sawBrandLabel = true;
      }
    }
  }

  // SAD-360: keyword/label outcomes, decided by the loop above.
  if (diagnostics) {
    const textField = (
      field: TemuDiagnosticField,
      value: string | null,
      reason: string
    ): void => {
      if (value !== null) diagnostics.extracted(field, { source: 'dom' });
      else diagnostics.missing(field, reason, { source: 'dom' });
    };

    if (brand !== null) {
      diagnostics.extracted('brand', { source: 'dom' });
    } else if (sawBrandLabel) {
      diagnostics.parseFailed('brand', 'Brand label present but empty', {
        source: 'dom',
      });
    } else {
      diagnostics.missing('brand', 'no Brand label in the page metadata', {
        source: 'dom',
      });
    }

    if (seller !== null) {
      diagnostics.extracted('seller', { source: 'dom' });
    } else if (sawSellerLabel) {
      diagnostics.parseFailed('seller', 'seller label present but empty', {
        source: 'dom',
      });
    } else {
      diagnostics.missing('seller', 'no seller label in the page metadata', {
        source: 'dom',
      });
    }

    textField('availability', availability, 'no stock phrase in the page metadata');
    textField('dealBadge', dealBadge, 'no deal marker found');
    textField('badge', badge, 'no recognition badge found');
    textField('coupon', coupon, 'no coupon marker found');
    textField('delivery', delivery, 'no shipping/delivery marker found');
    textField('bestSellersRank', bestSellersRank, 'no best-seller rank text found');

    // D6: a boolean is EXTRACTED on its marker and MISSING without it — a
    // legitimate `false` is never a validation failure.
    if (isSponsored) {
      diagnostics.extracted('isSponsored', { source: 'derived' });
    } else {
      diagnostics.missing('isSponsored', 'no Ad/Sponsored marker found', {
        source: 'derived',
      });
    }
    if (isPrime) {
      diagnostics.extracted('isPrime', { source: 'derived' });
    } else {
      diagnostics.missing('isPrime', 'no Local warehouse marker found', {
        source: 'derived',
      });
    }
  }

  return {
    brand,
    seller,
    availability,
    dealBadge,
    badge,
    coupon,
    delivery,
    bestSellersRank,
    isSponsored,
    isPrime,
  };
}

/**
 * Validates and normalizes a raw `TemuScrapedProduct` through `TemuScrapedProductSchema`.
 * Never fabricates missing fields; returns `null` if `goodsId` is invalid.
 */
export function validateAndNormalizeTemuScrapedProduct(
  raw: Partial<TemuScrapedProduct> & { goodsId?: string | null },
  pageUrl?: string,
  defaultSource: TemuProductSource = 'search'
): TemuScrapedProduct | null {
  try {
    const goodsId =
      normalizeGoodsId(raw.goodsId) ??
      normalizeGoodsId(raw.asin) ??
      extractGoodsId(raw.url);
    if (!goodsId) return null;

    const url = resolveTemuProductUrl(raw.url, goodsId, pageUrl);
    const price =
      typeof raw.price === 'number' &&
      Number.isFinite(raw.price) &&
      raw.price >= 0
        ? Math.round(raw.price * 100) / 100
        : null;

    const listPrice =
      typeof raw.listPrice === 'number' &&
      Number.isFinite(raw.listPrice) &&
      raw.listPrice >= 0 &&
      // SAD-380 D4: a reference/list price must sit strictly above the
      // selling price (Amazon precedent); at-or-below means a different
      // price was misassigned, and non-fabrication keeps it null.
      (price === null || raw.listPrice > price)
        ? Math.round(raw.listPrice * 100) / 100
        : null;

    const currency =
      price !== null || listPrice !== null
        ? cleanTemuText(raw.currency)?.toUpperCase() ?? 'USD'
        : cleanTemuText(raw.currency)?.toUpperCase() ?? null;

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
        ? Math.round(raw.reviewCount)
        : null;

    let imageUrl: string | null = null;
    if (raw.imageUrl) {
      try {
        const parsedImg = new URL(raw.imageUrl, url);
        if (
          parsedImg.protocol === 'https:' ||
          parsedImg.protocol === 'http:'
        ) {
          imageUrl = parsedImg.href;
        }
      } catch {
        imageUrl = null;
      }
    }

    const candidate: TemuScrapedProduct = {
      goodsId,
      asin: goodsId,
      title: cleanTemuText(raw.title),
      price,
      listPrice,
      discountPercentage:
        normalizeTemuDiscountPercentage(raw.discountPercentage) ??
        cleanTemuText(raw.discountPercentage),
      dealBadge: cleanTemuText(raw.dealBadge),
      currency,
      rating,
      reviewCount,
      bestSellersRank: cleanTemuText(raw.bestSellersRank),
      pastMonthSales:
        normalizeTemuSalesText(raw.pastMonthSales) ??
        cleanTemuText(raw.pastMonthSales),
      coupon: cleanTemuText(raw.coupon),
      badge: cleanTemuText(raw.badge),
      delivery: cleanTemuText(raw.delivery),
      imageUrl,
      url,
      isSponsored: Boolean(raw.isSponsored),
      isPrime: Boolean(raw.isPrime),
      brand: cleanTemuText(raw.brand),
      availability: cleanTemuText(raw.availability),
      seller: cleanTemuText(raw.seller),
      description: cleanTemuText(raw.description),
      features: Array.isArray(raw.features)
        ? raw.features
            .map((f) => cleanTemuText(f))
            .filter((f): f is string => Boolean(f))
        : [],
      source:
        raw.source === 'detail' ||
        raw.source === 'category' ||
        raw.source === 'search'
          ? raw.source
          : defaultSource,
    };

    const parsed = TemuScrapedProductSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn(
        '[PPHunt:Temu] validateAndNormalizeTemuScrapedProduct failed:',
        parsed.error.issues
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn(
      '[PPHunt:Temu] validateAndNormalizeTemuScrapedProduct exception:',
      err
    );
    return null;
  }
}
