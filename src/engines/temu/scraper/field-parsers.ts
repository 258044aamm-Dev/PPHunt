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
  imageEl: HTMLImageElement | null
): string | null {
  // 1. Direct or nested data-tooltip-title (emitted by Temu's bui-web-goods-list)
  const directTooltipTitle = cleanTemuText(
    card.getAttribute('data-tooltip-title')
  );
  if (directTooltipTitle) return directTooltipTitle;

  const tooltipTitleEl = card.querySelector(
    '[data-tooltip^="goodName-"][data-tooltip-title], [data-tooltip^="goodContainer-"][data-tooltip-title], [data-tooltip-title]'
  );
  const nestedTooltipTitle = cleanTemuText(
    tooltipTitleEl?.getAttribute('data-tooltip-title')
  );
  if (nestedTooltipTitle) return nestedTooltipTitle;

  // 2. goodName element text or heading
  const goodNameEl = card.querySelector('[data-tooltip^="goodName-"]');
  const goodNameText =
    cleanTemuText(goodNameEl?.getAttribute('aria-label')) ??
    extractTemuElementText(goodNameEl);
  if (goodNameText) return goodNameText;

  const headings = Array.from(card.querySelectorAll('h1, h2, h3, h4'));
  for (const h of headings) {
    const t =
      cleanTemuText(h.getAttribute('aria-label')) ?? extractTemuElementText(h);
    if (t && t.length >= 3) return t;
  }

  // 3. Product anchor aria-label / title / text
  const links = Array.from(
    card.querySelectorAll<HTMLAnchorElement>(TEMU_SELECTORS.listing.productLink)
  );
  for (const a of links) {
    const aria = cleanTemuText(a.getAttribute('aria-label'));
    if (aria && aria.length >= 4 && !/^\$?\d/.test(aria)) {
      return aria.replace(/^item\s+picture\s+/i, '').trim();
    }
    const text = extractTemuElementText(a);
    if (text && text.length >= 4 && !/^[\d,.\s$€£¥%-]+$/.test(text)) {
      return text;
    }
  }

  // 4. Primary image alt attribute (Temu sets alt="item picture <Title>")
  const rawAlt = cleanTemuText(imageEl?.getAttribute('alt'));
  if (rawAlt) {
    const stripped = rawAlt.replace(/^item\s+picture\s+/i, '').trim();
    if (stripped.length >= 2) return stripped;
  }

  return null;
}

function isTemuReferenceOrStrikePriceNode(el: Element | null): boolean {
  if (!el) return false;
  if (
    el.closest(
      '[data-type="priceText"], [data-type="unitPrice"], [data-type="discount"], del, s, strike, [aria-label*="Original price" i], [aria-label*="Regular price" i]'
    )
  ) {
    return true;
  }
  const aria = el.getAttribute('aria-label') ?? '';
  if (/\b(?:original|regular|was|list)\s+price\b/i.test(aria)) {
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
  fallbackCurrency = 'USD'
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

  // 1. Current selling price via semantic `[data-type="price"]`
  const priceNodes = Array.from(
    container.querySelectorAll('[data-type="price"]')
  );
  for (const priceNode of priceNodes) {
    if (isTemuReferenceOrStrikePriceNode(priceNode)) continue;

    // Prefer accessible `.srOnly` or `aria-label` inside `[data-type="price"]`
    const srOnly = priceNode.querySelector('[class*="srOnly"], .sr-only');
    const candidateText =
      cleanTemuText(srOnly?.textContent) ??
      cleanTemuText(priceNode.getAttribute('aria-label')) ??
      extractTemuElementText(priceNode);

    const parsed = parseTemuPrice(candidateText, fallbackCurrency);
    if (parsed.value !== null) {
      price = parsed.value;
      currency = parsed.currency;
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
        !/\b(?:original|regular|was|save|coupon|unit)\b/i.test(text)
      ) {
        const parsed = parseTemuPrice(text, fallbackCurrency);
        if (parsed.value !== null) {
          price = parsed.value;
          currency = parsed.currency;
          break;
        }
      }
    }
  }

  // 2. Original / Reference List Price (`[data-type="priceText"]`, `aria-label*="Original price"`, `del`, `s`)
  const listPriceCandidates = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.listPrice)
  );
  for (const el of listPriceCandidates) {
    if (el.closest('[data-type="unitPrice"], [data-type="discount"]')) continue;
    const raw =
      cleanTemuText(el.getAttribute('aria-label')) ??
      extractTemuElementText(el);
    if (!raw) continue;
    const parsed = parseTemuPrice(raw, currency ?? fallbackCurrency);
    if (parsed.value !== null && (price === null || parsed.value !== price)) {
      listPrice = parsed.value;
      if (!currency && parsed.currency) {
        currency = parsed.currency;
      }
      break;
    }
  }

  // 3. Displayed Discount Percentage (`[data-type="discount"]` or explicit `-68%` / `68% off` badge)
  const discountCandidates = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.discountPercentage)
  );
  for (const el of discountCandidates) {
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
      const normalized = normalizeTemuDiscountPercentage(text);
      if (normalized) {
        discountPercentage = normalized;
        break;
      }
    }
  }

  return { price, currency, listPrice, discountPercentage };
}

/**
 * Extracts sales velocity (`10K+ sold`) from `[data-type="saleTips"]` or leaf spans.
 */
export function extractTemuSalesVolume(container: Element): string | null {
  const saleTipNodes = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.salesTips)
  );
  for (const node of saleTipNodes) {
    const text =
      cleanTemuText(node.getAttribute('aria-label')) ??
      extractTemuElementText(node);
    const normalized = normalizeTemuSalesText(text);
    if (normalized) return normalized;
  }

  const allSpans = Array.from(container.querySelectorAll('span, div'));
  for (const el of allSpans) {
    if (el.children.length > 2) continue;
    const text =
      cleanTemuText(el.getAttribute('aria-label')) ??
      cleanTemuText(el.textContent);
    if (!text || text.length > 48) continue;
    const normalized = normalizeTemuSalesText(text);
    if (normalized) return normalized;
  }

  return null;
}

/**
 * Extracts star rating (0–5) and review count from a Temu card or PDP review block.
 */
export function extractTemuRatingAndReviews(container: Element): {
  rating: number | null;
  reviewCount: number | null;
} {
  let rating: number | null = null;
  let reviewCount: number | null = null;

  // 1. Check semantic rating nodes (`[role="img"][aria-label*="out of five stars" i]`)
  const ratingNodes = Array.from(
    container.querySelectorAll(TEMU_SELECTORS.listing.rating)
  );
  for (const el of ratingNodes) {
    const r =
      parseTemuRating(el.getAttribute('aria-label')) ??
      parseTemuRating(el.getAttribute('title')) ??
      parseTemuRating(el.textContent);
    if (r !== null) {
      rating = r;
      // Check sibling or parent region for review count (e.g. `(1,234)` or `1,234 reviews`)
      const region = el.closest('[role="region"]') ?? el.parentElement;
      if (region) {
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
        const rc = parseTemuReviewCount(text);
        if (rc !== null) {
          reviewCount = rc;
          break;
        }
      }
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
  baseUrl = 'https://www.temu.com'
): { imageUrl: string | null; imageEl: HTMLImageElement | null } {
  const searchIn = (
    container: Element
  ): { imageUrl: string | null; imageEl: HTMLImageElement | null } => {
    const primaryImgs = Array.from(
      container.querySelectorAll<HTMLImageElement>(TEMU_SELECTORS.listing.image)
    );
    const allImgs = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
    const candidates = Array.from(new Set([...primaryImgs, ...allImgs]));

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
        return { imageUrl: url, imageEl: img };
      }
      if (!fallbackUrl) {
        fallbackUrl = url;
        fallbackEl = img;
      }
    }

    return { imageUrl: fallbackUrl, imageEl: fallbackEl };
  };

  const direct = searchIn(card);
  if (direct.imageUrl) return direct;

  if (goodsId) {
    const expanded = resolveSingleGoodsCardContainer(card, goodsId);
    if (expanded !== card) {
      return searchIn(expanded);
    }
  }

  return direct;
}

/**
 * Extracts secondary promotional badges, seller/mall info, stock notices, and shipping tags from a Temu card or PDP.
 */
export function extractTemuCardMetadata(container: Element): {
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
      }
    }

    // Brand
    if (!brand) {
      const brandMatch = text.match(/^Brand\s*[:：]\s*(.+)$/i);
      if (brandMatch?.[1]) {
        brand = cleanTemuText(brandMatch[1]);
      }
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
      (price === null || raw.listPrice !== price)
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
