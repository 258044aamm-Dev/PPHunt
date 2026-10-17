import {
  inferCurrencyFromUrl,
  parsePrice,
  parsePriceFromElements,
} from '@/lib/utils/price-parser';
import { resolvePageCurrency } from '@/lib/utils/currency';
import {
  extractASIN,
  normalizeASIN,
  resolveProductUrl,
} from '@/lib/utils/amazon-url';
import type { ScrapedProduct } from '@/types/common';

/**
 * Shared multi-locale field parsers, Tier-3 structural heuristics,
 * and source validation helpers for Amazon DOM scraping.
 */

const RATING_PATTERNS: RegExp[] = [
  // English / German / French / Spanish / Italian: "4.7 out of 5", "4,7 von 5", "4,7 sur 5", "4,7 de 5", "4,7 su 5"
  /([0-5](?:[.,]\d+)?)\s*(?:out\s*of|von|sur|de|su|\/)\s*5\b/i,
  // Japanese: "5つ星のうち4.7" or "5つ星のうち 4.7"
  /5つ星のうち\s*([0-5](?:[.,]\d+)?)/i,
];

const PRICE_HEURISTIC_REGEX =
  /(?:(?:US\$|CA\$|AU\$|C\$|A\$|[\$€£¥￥₹]|USD|EUR|GBP|JPY|CAD|AUD|INR)\s*\d[\d.,]*|\d[\d.,]*\s*(?:€|£|\$|¥|￥|₹|USD|EUR|GBP|JPY|CAD|AUD|INR)\b)/i;

/**
 * Parses a star rating on a 0–5 scale from English or international Amazon rating strings.
 */
export function parseRating(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/\u00A0/g, ' ').trim();
  if (!cleaned) return null;

  for (const pattern of RATING_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      const value = Number.parseFloat(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value >= 0 && value <= 5) {
        return Math.round(value * 10) / 10;
      }
    }
  }

  // Fallback for standalone rating badge text like "4.6" or "4,6"
  if (/^[0-5][.,]\d$/.test(cleaned)) {
    const value = Number.parseFloat(cleaned.replace(',', '.'));
    if (Number.isFinite(value) && value >= 0 && value <= 5) {
      return Math.round(value * 10) / 10;
    }
  }

  return null;
}

/**
 * Parses a review/rating count as a non-negative integer.
 * Strips embedded rating phrases ("4.6 out of 5 stars") so rating digits are never mistaken for review counts.
 */
export function parseReviewCount(text: string | null | undefined): number | null {
  if (!text) return null;

  const cleaned = text
    .replace(/\u00A0/g, ' ')
    // Strip rating phrases first
    .replace(
      /[0-5](?:[.,]\d+)?\s*(?:out\s*of|von|sur|de|su|\/)\s*5(?:\s*(?:stars?|Sternen|étoiles|estrellas|stelle))?/gi,
      ' '
    )
    .replace(/5つ星のうち\s*[0-5](?:[.,]\d+)?/gi, ' ')
    // Strip bestseller rank tokens like "#1" or "Nr. 1"
    .replace(/(?:^|\s)(?:#|Nr\.?\s*|No\.?\s*)\d+\b/gi, ' ')
    .trim();

  if (!cleaned) return null;

  // Ignore bare decimal star ratings like "4.5" or "(4.5)" when no K/M suffix exists
  if (/^\(?[0-5]\.\d\)?$/.test(cleaned)) {
    return null;
  }

  // Handle compact notation like "1.2K", "12,4K", "1.5M", "(2.3k)"
  const compactMatch = cleaned.match(/(\d+(?:[.,]\d+)?)\s*([kKmM])\b/);
  if (compactMatch?.[1] && compactMatch[2]) {
    const base = Number.parseFloat(compactMatch[1].replace(',', '.'));
    const multiplier =
      compactMatch[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
    if (Number.isFinite(base) && base >= 0) {
      return Math.round(base * multiplier);
    }
  }

  // Match integer with optional thousands separators (comma, period, or narrow space)
  // e.g. "12,450", "12.450", "1,49,999", "842"
  const intMatch = cleaned.match(/(\d{1,3}(?:[.,\s]\d{2,3})+|\d+)/);
  if (!intMatch?.[1]) return null;

  const digitsOnly = intMatch[1].replace(/[.,\s]/g, '');
  const value = Number.parseInt(digitsOnly, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Cleans and normalizes text extracted from a DOM element, stripping embedded scripts/styles.
 */
export function cleanText(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = text
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Extracts clean text from an Element while ignoring <script> and <style> descendants.
 */
export function extractElementText(
  el: Element | null | undefined
): string | null {
  if (!el) return null;
  if (!el.querySelector('script, style, noscript')) {
    return cleanText(el.textContent);
  }
  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll('script, style, noscript')
    .forEach((node) => node.remove());
  return cleanText(clone.textContent);
}

/**
 * Normalizes brand names by removing Amazon store/byline boilerplate in supported languages.
 */
export function cleanBrand(text: string | null | undefined): string | null {
  const raw = cleanText(text);
  if (!raw) return null;

  const cleaned = raw
    .replace(
      /^(?:Visit the|Besuchen Sie den|Besuche den|Visiter la boutique|Visita la tienda de|Visita lo Store di)\s+/i,
      ''
    )
    .replace(/\s+(?:Store|Shop|-Store)$/i, '')
    .replace(/^(?:Brand|Marke|Marque|Marca|ブランド)\s*[:：]\s*/i, '')
    .replace(/^(?:by|von|de|da)\s+/i, '')
    .trim();

  if (
    !cleaned ||
    /^(?:sponsored|gesponsert|sponsorisé|patrocinado|sponsorizzato)$/i.test(
      cleaned
    ) ||
    PRICE_HEURISTIC_REGEX.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

/**
 * Normalizes availability / stock text.
 */
export function cleanAvailability(
  text: string | null | undefined
): string | null {
  const raw = cleanText(text);
  if (!raw) return null;
  return raw;
}

/**
 * Normalizes seller / merchant text from Buy Box or search rows.
 */
export function cleanSeller(text: string | null | undefined): string | null {
  const raw = cleanText(text);
  if (!raw) return null;

  let cleaned = raw
    .replace(
      /^(?:Ships from and sold by|Dispatched from and sold by|Verkauf und Versand durch|Expédié et vendu par|Vendido y enviado por|Venduto e spedito da)\s+/i,
      ''
    )
    .replace(
      /^(?:Sold by|Verkauf durch|Vendu par|Vendido por|Venduto da)\s*:?\s*/i,
      ''
    )
    .replace(/\.$/, '')
    .trim();

  // If sentence continues with "and Fulfilled by Amazon" or similar, keep only the seller name
  cleaned = cleaned
    .replace(/\s+(?:and|&)\s+(?:Fulfilled|shipped)\s+by\s+Amazon.*$/i, '')
    .trim();

  return cleaned || null;
}

function isNonProductImageCandidate(url: string): boolean {
  return /grey-pixel|transparent-pixel|nav-sprite|sprite|prime[-_]?logo|icon-prime|1x1/i.test(
    url
  );
}

/**
 * Extracts the best valid HTTP(S) image URL from an Amazon <img> or <picture> element.
 * Priority: data-old-hires → data-a-hires → data-a-dynamic-image (largest dimension)
 * → srcset / data-srcset / <picture><source srcset> → src → data-src → data-lazy-src.
 */
export function extractBestImageUrl(
  imgEl: Element | null | undefined,
  baseUrl = 'https://www.amazon.com'
): string | null {
  if (!imgEl) return null;

  const toValidHttpUrl = (
    candidate: string | null | undefined
  ): string | null => {
    if (!candidate) return null;
    const trimmed = candidate.trim();
    if (
      !trimmed ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      isNonProductImageCandidate(trimmed)
    ) {
      return null;
    }
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.href;
      }
      return null;
    } catch {
      return null;
    }
  };

  // 1. High-resolution attributes on detail/deal pages
  const oldHires =
    toValidHttpUrl(imgEl.getAttribute('data-old-hires')) ??
    toValidHttpUrl(imgEl.getAttribute('data-a-hires'));
  if (oldHires) return oldHires;

  // 2. Dynamic image JSON map: {"https://...jpg":[500,500], ...}
  const dynamicAttr = imgEl.getAttribute('data-a-dynamic-image');
  if (dynamicAttr) {
    try {
      const map = JSON.parse(dynamicAttr) as Record<
        string,
        [number, number] | undefined
      >;
      let bestUrl: string | null = null;
      let bestArea = -1;
      for (const [urlKey, dims] of Object.entries(map)) {
        const valid = toValidHttpUrl(urlKey);
        if (!valid) continue;
        const area =
          Array.isArray(dims) && dims.length >= 2
            ? (dims[0] || 0) * (dims[1] || 0)
            : 0;
        if (area > bestArea) {
          bestArea = area;
          bestUrl = valid;
        }
      }
      if (bestUrl) return bestUrl;
    } catch {
      // Fall through to srcset/src
    }
  }

  // 3. srcset / data-srcset on img or enclosing <picture><source>
  const parseBestFromSrcset = (rawSrcset: string | null): string | null => {
    if (!rawSrcset) return null;
    const candidates = rawSrcset
      .split(',')
      .map((entry) => entry.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const valid = toValidHttpUrl(candidates[i]);
      if (valid) return valid;
    }
    return null;
  };

  const fromImgSrcset =
    parseBestFromSrcset(imgEl.getAttribute('srcset')) ??
    parseBestFromSrcset(imgEl.getAttribute('data-srcset'));
  if (fromImgSrcset) return fromImgSrcset;

  const pictureParent = imgEl.closest('picture');
  if (pictureParent) {
    const sources = Array.from(pictureParent.querySelectorAll('source'));
    for (const source of sources) {
      const fromSource =
        parseBestFromSrcset(source.getAttribute('srcset')) ??
        parseBestFromSrcset(source.getAttribute('data-srcset'));
      if (fromSource) return fromSource;
    }
  }

  // 4. Standard src or lazy data-src / data-lazy-src
  return (
    toValidHttpUrl(
      imgEl.getAttribute('src') ?? (imgEl as HTMLImageElement).src
    ) ??
    toValidHttpUrl(imgEl.getAttribute('data-src')) ??
    toValidHttpUrl(imgEl.getAttribute('data-lazy-src')) ??
    null
  );
}

/**
 * Checks whether an element contains any product link or data-asin belonging to
 * a DIFFERENT ASIN than `targetAsin`. Used when walking up the DOM from an inner
 * `[data-asin]` or `/dp/` link wrapper to find the full product card container
 * (which holds the sibling `<img>` on `/deals` and category grids).
 */
export function resolveSingleProductCardContainer(
  el: Element,
  targetAsin: string | null | undefined
): Element {
  const normalizedTarget = normalizeASIN(targetAsin);
  if (!normalizedTarget) return el;

  const hasConflictingAsin = (candidate: Element): boolean => {
    const selfAsin = normalizeASIN(candidate.getAttribute('data-asin'));
    if (selfAsin && selfAsin !== normalizedTarget) return true;

    const asinEls = candidate.querySelectorAll('[data-asin]:not([data-asin=""])');
    for (const node of asinEls) {
      const nodeAsin = normalizeASIN(node.getAttribute('data-asin'));
      if (nodeAsin && nodeAsin !== normalizedTarget) return true;
    }

    const dpLinks = candidate.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/dp/"], a[href*="/gp/product/"]'
    );
    for (const link of dpLinks) {
      const linkAsin = extractASIN(link.getAttribute('href') ?? '');
      if (linkAsin && linkAsin !== normalizedTarget) return true;
    }

    return false;
  };

  let current = el;
  let steps = 0;
  while (steps < 6 && current.parentElement) {
    const parent = current.parentElement;
    const tag = parent.tagName.toUpperCase();
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') break;
    if (
      parent.children.length > 24 ||
      parent.querySelectorAll('img').length > 10
    ) {
      break;
    }
    if (hasConflictingAsin(parent)) break;
    current = parent;
    steps++;
    // Once we have both an image and a link/heading inside the single-ASIN container, stop if we reached a card boundary
    if (
      current.querySelector('img') &&
      current.querySelector('a[href], h1, h2, h3, h4') &&
      (current.tagName === 'LI' ||
        current.tagName === 'ARTICLE' ||
        current.hasAttribute('data-testid') ||
        current.hasAttribute('data-asin'))
    ) {
      break;
    }
  }

  return current;
}

/**
 * Finds the best product image URL within a product card container (or its
 * enclosing single-product ancestor if `card` is an inner wrapper around the link/ASIN).
 * Prioritizes Amazon product media URLs (`/images/I/`, `s-image`, `a-dynamic-image`)
 * over badges and decorative icons.
 */
export function findBestCardImageUrl(
  card: Element,
  asin?: string | null,
  baseUrl = 'https://www.amazon.com',
  primarySelector?: string
): { imageUrl: string | null; imageEl: HTMLImageElement | null } {
  const searchInContainer = (
    container: Element
  ): { imageUrl: string | null; imageEl: HTMLImageElement | null } => {
    const candidateEls: HTMLImageElement[] = [];
    const seen = new Set<Element>();

    const addCandidates = (els: Iterable<HTMLImageElement>) => {
      for (const el of els) {
        if (!seen.has(el)) {
          seen.add(el);
          candidateEls.push(el);
        }
      }
    };

    if (primarySelector) {
      addCandidates(container.querySelectorAll<HTMLImageElement>(primarySelector));
    }
    addCandidates(
      container.querySelectorAll<HTMLImageElement>(
        'img.s-image, .s-product-image-container img, .a-dynamic-image, [data-testid*="image"] img, picture img'
      )
    );
    addCandidates(container.querySelectorAll<HTMLImageElement>('img'));

    let fallbackUrl: string | null = null;
    let fallbackEl: HTMLImageElement | null = null;

    for (const img of candidateEls) {
      const url = extractBestImageUrl(img, baseUrl);
      if (!url) continue;
      // Strongly prefer Amazon product catalog images (/images/I/ or /images/P/)
      if (/\/images\/[IP]\//i.test(url) || img.classList.contains('s-image')) {
        return { imageUrl: url, imageEl: img };
      }
      if (!fallbackUrl) {
        fallbackUrl = url;
        fallbackEl = img;
      }
    }

    return { imageUrl: fallbackUrl, imageEl: fallbackEl };
  };

  const direct = searchInContainer(card);
  if (direct.imageUrl) return direct;

  if (asin) {
    const expanded = resolveSingleProductCardContainer(card, asin);
    if (expanded !== card) {
      return searchInContainer(expanded);
    }
  }

  return direct;
}

/**
 * Tier-3 Structural Heuristic Extractor:
 * When Amazon changes CSS class names in the future, recovers product fields from semantic
 * HTML tags, ARIA attributes, link hrefs, and text patterns inside a product container.
 */
export function extractCardByHeuristics(
  container: Element,
  asin: string,
  baseUrl = 'https://www.amazon.com'
): Partial<ScrapedProduct> {
  const result: Partial<ScrapedProduct> = {};
  // C-1: resolve the page's ISO currency once per invocation — parsePrice's
  // fallback parameter is an ISO code, never a URL.
  const pageCurrency = resolvePageCurrency(baseUrl);
  const effectiveContainer = resolveSingleProductCardContainer(container, asin);

  try {
    // 1. Link & URL
    const links = Array.from(
      effectiveContainer.querySelectorAll<HTMLAnchorElement>('a[href]')
    );
    const productLink =
      links.find((a) => extractASIN(a.getAttribute('href') ?? '') === asin) ??
      links.find((a) =>
        /\/dp\/|\/gp\/product\/|\/sspa\/click/i.test(
          a.getAttribute('href') ?? ''
        )
      );
    const linkHref = productLink?.getAttribute('href') ?? null;
    result.url = resolveProductUrl(linkHref, asin, baseUrl);

    // 2. Image
    const { imageUrl, imageEl: bestImgEl } = findBestCardImageUrl(
      effectiveContainer,
      asin,
      baseUrl
    );
    result.imageUrl = imageUrl;

    // 3. Title (headings -> product link text -> image alt)
    const headings = Array.from(
      effectiveContainer.querySelectorAll('h1, h2, h3, h4')
    );
    let bestTitle: string | null = null;
    for (const h of headings) {
      const t = cleanText(h.getAttribute('aria-label')) ?? extractElementText(h);
      if (t && (!bestTitle || t.length > bestTitle.length)) {
        bestTitle = t;
      }
    }
    if (!bestTitle) {
      for (const a of links) {
        const href = a.getAttribute('href') ?? '';
        if (!/\/dp\/|\/gp\/product\/|\/sspa\/click/i.test(href)) continue;
        if (/#customerReviews|product-reviews/i.test(href)) continue;
        const text =
          cleanText(a.getAttribute('title')) ?? extractElementText(a);
        if (
          text &&
          text.length >= 6 &&
          !PRICE_HEURISTIC_REGEX.test(text) &&
          (!bestTitle || text.length > bestTitle.length)
        ) {
          bestTitle = text;
        }
      }
    }
    if (!bestTitle && bestImgEl) {
      bestTitle = cleanText(
        bestImgEl.getAttribute('alt')?.replace(/^Sponsored Ad\s*-\s*/i, '')
      );
    }
    result.title = bestTitle;

    // 4. Price & Currency (scan non-strikethrough leaf/short elements)
    const pricingInfo = extractCardPricingAndDiscounts(
      effectiveContainer,
      baseUrl
    );
    result.price = pricingInfo.price;
    result.currency = pricingInfo.currency;
    if (pricingInfo.listPrice !== null) {
      result.listPrice = pricingInfo.listPrice;
    }
    if (pricingInfo.discountPercentage) {
      result.discountPercentage = pricingInfo.discountPercentage;
    }

    const dealBadge = extractDealBadge(effectiveContainer);
    if (dealBadge) result.dealBadge = dealBadge;

    const bsr = extractBestSellersRank(effectiveContainer);
    if (bsr) result.bestSellersRank = bsr;

    const pastMonthSales = extractPastMonthSales(effectiveContainer);
    if (pastMonthSales) result.pastMonthSales = pastMonthSales;

    const coupon = extractCouponText(effectiveContainer);
    if (coupon) result.coupon = coupon;

    const badge = extractProductBadge(effectiveContainer);
    if (badge) result.badge = badge;

    const delivery = extractDeliveryInfo(effectiveContainer);
    if (delivery) result.delivery = delivery;

    const allEls = Array.from(effectiveContainer.querySelectorAll('*'));
    if (result.price == null) {
      for (const el of allEls) {
        if (
          el.tagName === 'S' ||
          el.tagName === 'DEL' ||
          el.tagName === 'SCRIPT' ||
          el.tagName === 'STYLE' ||
          isStrikeThroughOrReferencePriceElement(el)
        ) {
          continue;
        }
        if (el.children.length > 3) continue;
        const text =
          cleanText(el.getAttribute('aria-label')) ?? cleanText(el.textContent);
        if (!text || text.length > 32) continue;
        if (PRICE_HEURISTIC_REGEX.test(text)) {
          const parsed = parsePrice(text, pageCurrency);
          if (parsed.value !== null) {
            result.price = parsed.value;
            result.currency = parsed.currency;
            break;
          }
        }
      }
    }

    // 5. Rating & Review Count
    for (const el of allEls) {
      // H-9b early exit: both branches below are guarded by null checks, so
      // once both fields are found the remaining iterations are no-ops.
      if (result.rating != null && result.reviewCount != null) break;
      const candidates = [
        el.getAttribute('title'),
        el.getAttribute('aria-label'),
        el.children.length === 0 ? el.textContent : null,
      ];
      for (const c of candidates) {
        if (!c) continue;
        if (result.rating == null) {
          const r = parseRating(c);
          if (r !== null) result.rating = r;
        }
        if (
          result.reviewCount == null &&
          (/\b(?:ratings?|reviews?|sterne|évaluations?|valoraciones|件のカスタマーレビュー)\b/i.test(
            c
          ) ||
            (el.tagName === 'A' &&
              /#customerReviews|product-reviews/i.test(
                el.getAttribute('href') ?? ''
              )))
        ) {
          const rc = parseReviewCount(c);
          if (rc !== null) result.reviewCount = rc;
        }
      }
    }

    // 6. Sponsored & Prime
    const containerText = extractElementText(effectiveContainer) ?? '';
    result.isSponsored =
      Boolean(linkHref && /\/sspa\/click|sp_atk=/i.test(linkHref)) ||
      /\b(?:Sponsored|Gesponsert|Sponsorisé|Patrocinado|Sponsorizzato)\b/i.test(
        containerText
      );
    result.isPrime =
      Boolean(
        effectiveContainer.querySelector(
          '[aria-label*="Prime" i], [class*="prime" i], img[alt*="Prime" i]'
        )
      ) || /\bPrime\b/.test(containerText);

    // 7. Brand, Availability, Seller
    for (const el of allEls) {
      // H-9b early exit: every branch is guarded by `!result.x`, so once all
      // three fields are found the remaining iterations are no-ops.
      if (result.brand && result.availability && result.seller) break;
      if (el.children.length > 2) continue;
      const text = extractElementText(el);
      if (!text || text.length > 100) continue;

      if (
        !result.brand &&
        /^(?:Visit the\s+.+\s+Store|Brand\s*:\s*.+|by\s+[A-Z0-9][A-Za-z0-9\s.&'-]{1,40})$/i.test(
          text
        )
      ) {
        const b = cleanBrand(text);
        if (b && b !== result.title) result.brand = b;
      }

      if (
        !result.availability &&
        /\b(?:in stock|left in stock|currently unavailable|temporarily out of stock|out of stock)\b/i.test(
          text
        )
      ) {
        result.availability = cleanAvailability(text);
      }

      if (
        !result.seller &&
        /\b(?:sold by|ships from and sold by|verkauf durch|vendu par|vendido por)\s+/i.test(
          text
        )
      ) {
        result.seller = cleanSeller(text);
      }
    }
  } catch {
    // Fault isolation: never throw from heuristic fallback
  }

  return result;
}

/**
 * H-9b (Phase 5): linear replacement for the O(N²) `cards.some(contains)` filters.
 *
 * Keeps every card that has no OTHER card among the candidates in its ancestor
 * chain. Behaviourally identical to
 * `cards.filter((card) => !cards.some((o) => o !== card && o.contains(card)))`
 * but O(N × depth) instead of O(N²) `Node.contains()` calls (N can be 500+).
 *
 * `dropDuplicates: true` reproduces the index-based variant used by
 * `discoverFallbackProductCards` (there a duplicated element drops BOTH copies);
 * the default identity-based variant keeps duplicate references, matching
 * category-page's original filter.
 */
export function dropNestedCards(
  cards: Element[],
  options: { dropDuplicates?: boolean } = {}
): Element[] {
  const cardSet = new Set<Element>(cards);
  let duplicateCounts: Map<Element, number> | null = null;
  if (options.dropDuplicates) {
    duplicateCounts = new Map<Element, number>();
    for (const card of cards) {
      duplicateCounts.set(card, (duplicateCounts.get(card) ?? 0) + 1);
    }
  }

  const out: Element[] = [];
  for (const card of cards) {
    if (duplicateCounts && (duplicateCounts.get(card) ?? 0) > 1) continue;
    let hasCardAncestor = false;
    for (let a: Element | null = card.parentElement; a; a = a.parentElement) {
      if (cardSet.has(a)) {
        hasCardAncestor = true;
        break;
      }
    }
    if (!hasCardAncestor) out.push(card);
  }
  return out;
}

/**
 * True when `el` is itself in `set` or is contained by any element of `set`
 * (ancestor walk, O(depth)). Replaces `cards.some((c) => c.contains(el))`.
 */
export function isWithinAnyCard(el: Element, set: Set<Element>): boolean {
  if (set.has(el)) return true;
  for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
    if (set.has(a)) return true;
  }
  return false;
}

/**
 * True when any element of `set` sits inside `root`'s subtree. Replaces
 * `cards.some((c) => root.contains(c))` with an early-exit subtree scan
 * (bounded by one card's subtree, not the candidate list length).
 */
export function containsAnyCard(root: Element, set: Set<Element>): boolean {
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el && set.has(el)) return true;
  }
  return false;
}

/**
 * Discovers product card containers via structural attributes ([data-asin] or /dp/ links)
 * when primary CSS class selectors return no elements due to future Amazon DOM changes
 * or on Deals / Promotion grid pages.
 */
export function discoverFallbackProductCards(document: Document): Element[] {
  const asinNodes = Array.from(
    document.querySelectorAll('[data-asin]:not([data-asin=""])')
  );

  const cards: Element[] = [];
  // H-9b: kept in sync with `cards` so containment checks are Set-based
  // (O(depth) ancestor walks) instead of O(N²) `Node.contains()` pairs.
  const cardSet = new Set<Element>();
  const seenAsins = new Set<string>();

  for (const el of asinNodes) {
    try {
      const asin = normalizeASIN(el.getAttribute('data-asin'));
      if (!asin || seenAsins.has(asin)) continue;
      const expanded = resolveSingleProductCardContainer(el, asin);
      if (expanded.querySelector('a[href], img, h1, h2, h3, h4')) {
        seenAsins.add(asin);
        cards.push(expanded);
        cardSet.add(expanded);
      }
    } catch {
      // Fault isolation: ignore corrupted card nodes during fallback discovery
    }
  }

  // Also discover cards linked via /dp/<ASIN> that did not have a [data-asin] attribute
  const dpLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/dp/"], a[href*="/gp/product/"]'
    )
  );

  for (const link of dpLinks) {
    try {
      const asin = extractASIN(link.getAttribute('href') ?? '');
      if (!asin || seenAsins.has(asin)) continue;
      const container = resolveSingleProductCardContainer(link, asin);
      if (
        container &&
        !cardSet.has(container) &&
        !isWithinAnyCard(container, cardSet) &&
        !containsAnyCard(container, cardSet)
      ) {
        seenAsins.add(asin);
        cards.push(container);
        cardSet.add(container);
      }
    } catch {
      // Fault isolation
    }
  }

  return dropNestedCards(cards, { dropDuplicates: true });
}

/**
 * Checks whether a price node belongs to a struck-through, reference, original list price,
 * per-unit price, or coupon container so it is never confused with the current selling price (SAD-140).
 */
export function isStrikeThroughOrReferencePriceElement(
  el: Element | null | undefined
): boolean {
  if (!el) return false;

  if (
    el.closest(
      's, del, strike, [data-a-strike="true"], [data-a-color="secondary"], [data-a-color="tertiary"], .a-text-price, .basisPrice, #basisPriceLegalMessage, .priceBlockStrikePriceString, #priceblock_listprice, [data-testid*="list-price"], [data-testid*="was-price"], [data-testid*="strike"], [data-component-type="s-coupon-component"], .s-coupon-unclipped, #couponBadgeRegularVpc'
    )
  ) {
    return true;
  }

  // Check if parent or preceding sibling explicitly labels this price as List / Was / Typical / RRP / M.R.P.
  const parentText = cleanText(el.parentElement?.textContent) ?? '';
  const ownText = cleanText(el.textContent) ?? '';
  if (parentText && ownText) {
    const idx = parentText.indexOf(ownText);
    const prefix = idx > 0 ? parentText.slice(0, idx).trim() : parentText;
    if (
      /(?:List\s*Price|List|Was|Typical\s*price|Typical|M\.R\.P\.?|RRP|UVP|Prix\s*conseillé|Precio\s*recomendado)\s*:?\s*$/i.test(
        prefix
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Normalizes a displayed discount percentage string (e.g. "-68%", "(68% off)", "Save 68%")
 * into a consistent "68% off" display string, or returns null if no discount percentage is present.
 * Never calculates or invents a discount when not explicitly shown on the page.
 */
export function normalizeDiscountPercentage(
  raw: string | null | undefined
): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned) return null;

  // Exclude coupon strings like "Save 15% with coupon" (handled by extractCouponText)
  if (/\b(?:coupon|voucher|code|subscribe)\b/i.test(cleaned)) {
    return null;
  }

  // Match explicit "<N>% off" / "<N>% savings" / "<N>% Rabatt"
  const offMatch = cleaned.match(
    /\b(\d{1,2}(?:\.\d+)?)\s*%\s*(?:off|savings|rabatt|de\s+réduction|de\s+descuento|di\s+sconto)\b/i
  );
  if (offMatch?.[1]) {
    const num = Number(offMatch[1]);
    if (num > 0 && num < 100) {
      return `${offMatch[1]}% off`;
    }
  }

  // Match "-68%" or "−68%" badge format
  const minusMatch = cleaned.match(/(?:^|[\s(])[-−–]\s*(\d{1,2}(?:\.\d+)?)\s*%(?:[\s)]|$)/);
  if (minusMatch?.[1]) {
    const num = Number(minusMatch[1]);
    if (num > 0 && num < 100) {
      return `${minusMatch[1]}% off`;
    }
  }

  // Match "Save 68%" when not a coupon
  const saveMatch = cleaned.match(
    /\b(?:save|sparen\s+sie|économisez|ahorra)\s+(\d{1,2}(?:\.\d+)?)\s*%/i
  );
  if (saveMatch?.[1]) {
    const num = Number(saveMatch[1]);
    if (num > 0 && num < 100) {
      return `${saveMatch[1]}% off`;
    }
  }

  return null;
}

/**
 * Extracts and strictly separates:
 * - Current selling / discounted `price` & `currency`
 * - Original / reference `listPrice` (when displayed)
 * - Displayed `discountPercentage` (when displayed, e.g. "68% off")
 * Never invents or calculates values that are not present in the DOM (SAD-140).
 */
export function extractCardPricingAndDiscounts(
  container: Element,
  baseUrl: string,
  primaryPriceSelector?: string,
  fallbackPriceSelector?: string
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
  // C-1: resolve the page's ISO currency once per invocation — parsePrice's
  // fallback parameter is an ISO code, never a URL.
  const pageCurrency = resolvePageCurrency(baseUrl);

  // 1. Current selling / discounted price (strictly non-strikethrough)
  const sellingSelectors = [
    primaryPriceSelector,
    '.a-price.priceToPay .a-offscreen',
    '.apexPriceToPay .a-offscreen',
    '.a-price[data-a-color="base"]:not([data-a-strike="true"]) .a-offscreen',
    '.a-price[data-a-color="price"]:not([data-a-strike="true"]) .a-offscreen',
    fallbackPriceSelector,
    '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-offscreen',
    '._cDEzb_p13n-sc-price_3mJ9Z',
    '.p13n-sc-price',
    '[data-testid*="deal-price"]',
    '[data-testid*="price-to-pay"]',
  ]
    .filter((s): s is string => Boolean(s))
    .join(', ');

  const sellingCandidates = Array.from(
    container.querySelectorAll(sellingSelectors)
  );
  for (const el of sellingCandidates) {
    if (isStrikeThroughOrReferencePriceElement(el)) continue;
    const parsed = parsePrice(el.textContent, pageCurrency);
    if (parsed.value !== null) {
      price = parsed.value;
      currency = parsed.currency;
      break;
    }
  }

  // Fallback to split whole/fraction/symbol inside a non-strikethrough .a-price block
  if (price === null) {
    const priceBlocks = Array.from(
      container.querySelectorAll(
        '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price)'
      )
    );
    for (const block of priceBlocks) {
      if (isStrikeThroughOrReferencePriceElement(block)) continue;
      const splitParsed = parsePriceFromElements(
        block.querySelector('.a-price-whole'),
        block.querySelector('.a-price-fraction'),
        block.querySelector('.a-price-symbol'),
        pageCurrency
      );
      if (splitParsed.value !== null) {
        price = splitParsed.value;
        currency = splitParsed.currency;
        break;
      }
    }
  }

  // 2. Listing / Original reference price (struck-through or explicitly labeled List/Was/Typical price)
  const listPriceSelectors =
    '.basisPrice .a-offscreen, .a-price[data-a-strike="true"] .a-offscreen, .a-text-price[data-a-strike="true"] .a-offscreen, .a-price[data-a-color="secondary"] .a-offscreen, .a-text-price .a-offscreen, #priceblock_listprice, .priceBlockStrikePriceString, [data-testid*="list-price"], [data-testid*="was-price"], del, s';
  const listCandidates = Array.from(
    container.querySelectorAll(listPriceSelectors)
  );
  for (const el of listCandidates) {
    // Skip unit prices like "($0.45 / Fl Oz)"
    const parentText = cleanText(el.parentElement?.textContent) ?? '';
    if (/\/\s*(?:fl\s*oz|oz|count|ct|ea|item|kg|lb|g|ml|l)\b/i.test(parentText)) {
      continue;
    }
    const parsed = parsePrice(el.textContent, pageCurrency);
    if (parsed.value !== null) {
      if (price === null || parsed.value !== price) {
        listPrice = parsed.value;
        if (!currency && parsed.currency) {
          currency = parsed.currency;
        }
        break;
      }
    }
  }

  // Labeled text fallback for List Price / Was / Typical price when no .a-offscreen wrapper was used
  if (listPrice === null) {
    const rawCardText = container.textContent ?? '';
    const containerText =
      rawCardText.length <= 2500 ? cleanText(rawCardText) ?? '' : '';
    const labeledMatch = containerText.match(
      /(?:List\s*Price|Was|Typical\s*price|Typical|M\.R\.P\.?|RRP|UVP|Prix\s*conseillé)\s*:?\s*([$€£¥₹]\s*\d[\d,.]*|\d[\d,.]*\s*(?:[$€£¥₹]|USD|EUR|GBP|CAD|AUD|JPY|INR))/i
    );
    if (labeledMatch?.[1]) {
      const parsed = parsePrice(labeledMatch[1], pageCurrency);
      if (parsed.value !== null && (price === null || parsed.value !== price)) {
        listPrice = parsed.value;
        if (!currency && parsed.currency) {
          currency = parsed.currency;
        }
      }
    }
  }

  // 3. Displayed discount percentage (e.g., "68% off" or "-68%")
  const discountSelectors =
    '.savingsPercentage, .reinventPriceSavingsPercentageMargin, [class*="savingsPercentage"], [data-testid*="percent-off"], [data-testid*="savings-badge"], .dealPriceSavings, #regularprice_savings .a-color-price, .zp-deal-badge-savings';
  const discountEls = Array.from(container.querySelectorAll(discountSelectors));
  for (const el of discountEls) {
    const normalized =
      normalizeDiscountPercentage(el.getAttribute('aria-label')) ??
      normalizeDiscountPercentage(el.textContent);
    if (normalized) {
      discountPercentage = normalized;
      break;
    }
  }

  if (!discountPercentage) {
    const textEls = Array.from(
      container.querySelectorAll('span, div, b, strong')
    );
    for (const el of textEls) {
      if (el.children.length > 2) continue;
      if (
        el.closest(
          '[data-component-type="s-coupon-component"], .s-coupon-unclipped, #couponBadgeRegularVpc'
        )
      ) {
        continue;
      }
      const rawText =
        cleanText(el.getAttribute('aria-label')) ?? cleanText(el.textContent);
      if (!rawText || rawText.length > 48) continue;
      const normalized = normalizeDiscountPercentage(rawText);
      if (normalized) {
        discountPercentage = normalized;
        break;
      }
    }
  }

  return { price, currency, listPrice, discountPercentage };
}

const DEAL_BADGE_PATTERNS = [
  /\b(Limited[- ]time deal)\b/i,
  /\b(Lightning Deal)\b/i,
  /\b(Prime Big Deal|Prime Day Deal|Prime Exclusive Deal|Exclusive Prime price)\b/i,
  /\b(Early Black Friday Deal|Black Friday Deal)\b/i,
  /\b(Cyber Monday Deal)\b/i,
  /\b(Big Spring Deal|Spring Deal)\b/i,
  /\b(Deal of the Day|Spotlight Deal|Countdown Deal|Holiday Deal|Top Deal|Best Deal|With Deal)\b/i,
  /\b(Befristetes Angebot|Blitzangebot|Offre à durée limitée|Vente flash|Oferta por tiempo limitado|Oferta flash|Offerta a tempo)\b/i,
];

function matchDealLabel(raw: string | null | undefined): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned) return null;
  for (const pattern of DEAL_BADGE_PATTERNS) {
    const m = cleaned.match(pattern);
    if (m?.[1]) {
      // Standardize "Limited time deal" / "Limited-time deal" casing cleanly while preserving label
      if (/^limited[- ]time deal$/i.test(m[1])) {
        return m[1].includes('-') ? 'Limited-time deal' : 'Limited time deal';
      }
      return cleanText(m[1]);
    }
  }
  return null;
}

/**
 * Detects promotional deal labels such as "Limited-time deal", "Lightning Deal",
 * "Prime Big Deal", "Black Friday Deal", etc. (SAD-140).
 */
export function extractDealBadge(container: Element): string | null {
  const dealSelectors =
    '[data-a-badge-type="deal"] .a-badge-text, [data-a-badge-type="deal"], #dealBadge_feature_div .dealBadgeText, #dealBadge_feature_div, .s-uk-deal-badge, [data-testid*="deal-badge"], .dealBadgeText, .dealBadge, [class*="dealBadge"]';
  const explicitEls = Array.from(container.querySelectorAll(dealSelectors));

  for (const el of explicitEls) {
    const text =
      cleanText(el.getAttribute('aria-label')) ?? extractElementText(el);
    if (!text) continue;
    const matched = matchDealLabel(text);
    if (matched) return matched;
    // If inside an explicit deal-badge element and short non-numeric label, return cleaned text
    const stripped = cleanText(
      text.replace(/\b\d{1,2}(?:\.\d+)?\s*%\s*off\b/gi, '')
    );
    if (
      stripped &&
      stripped.length >= 4 &&
      stripped.length <= 40 &&
      /\b(?:deal|angebot|offre|oferta|offerta)\b/i.test(stripped)
    ) {
      return stripped;
    }
  }

  // Scan short badge/span elements for known deal labels
  const candidates = Array.from(
    container.querySelectorAll('.a-badge-text, .a-badge-label, span, div')
  );
  for (const el of candidates) {
    if (el.children.length > 2) continue;
    const text =
      cleanText(el.getAttribute('aria-label')) ?? cleanText(el.textContent);
    if (!text || text.length > 60) continue;
    const matched = matchDealLabel(text);
    if (matched) return matched;
  }

  return null;
}

/**
 * Extracts the category name from a Best Sellers or Category page heading
 * (e.g. "Best Sellers in Electronics" -> "Electronics") to enrich `#1` rank badges.
 */
export function extractPageCategoryName(document: Document): string | null {
  const headingSelectors =
    '#zg_banner_text, ._cDEzb_card-title_2sYgw, h1, .zg-banner-text, [data-testid*="category-title"]';
  const headings = Array.from(document.querySelectorAll(headingSelectors));
  for (const h of headings) {
    const text = extractElementText(h);
    if (!text) continue;
    const m = text.match(
      /(?:Best\s*Sellers|Hot\s*New\s*Releases|Movers\s*&\s*Shakers|Most\s*Wished\s*For)\s+in\s+(.+)$/i
    );
    if (m?.[1]) {
      return cleanText(m[1]);
    }
  }
  return null;
}

/**
 * Normalizes a raw Best Sellers Rank block (e.g. "#5 in Electronics (See Top 100 in Electronics) #1 in Headphones")
 * into a clean string such as "#5 in Electronics" or "#5 in Electronics (#1 in Headphones)".
 */
export function parseBestSellersRankText(
  raw: string | null | undefined
): string | null {
  const cleaned = cleanText(raw);
  if (!cleaned) return null;

  // Strip "(See Top 100 in ...)" parentheticals and leading label
  const withoutSeeTop = cleaned
    .replace(/\(\s*See\s+Top\s+\d+[^)]*\)/gi, ' ')
    .replace(
      /^(?:Amazon\s+)?(?:Best\s*Sellers\s*Rank|Bestseller-Rang|Classement\s+des\s+meilleures\s+ventes|Clasificación\s+en\s+los\s+más\s+vendidos)\s*:?\s*/i,
      ''
    )
    .trim();

  const matches = Array.from(
    withoutSeeTop.matchAll(
      /(?:^|[\s(,;])(?:Nr\.|N°|nº)?\s*#?\s*(\d[\d,.]*)\s+(?:in|en|dans)\s+([^#()\n]+?)(?=\s*(?:[(),;]|(?:#|Nr\.|N°|nº)?\s*\d[\d,.]*\s+(?:in|en|dans)\s+|$))/gi
    )
  );

  if (matches.length > 0) {
    const formatted = matches
      .map((m) => {
        const num = (m[1] ?? '').replace(/[^\d,]/g, '');
        const cat = cleanText(m[2]?.replace(/[,;:\-–—]+$/, ''));
        return num && cat ? `#${num} in ${cat}` : null;
      })
      .filter((s): s is string => Boolean(s));

    if (formatted.length === 1) return formatted[0] ?? null;
    if (formatted.length >= 2) {
      return `${formatted[0]} (${formatted.slice(1).join(', ')})`;
    }
  }

  // Fallback for single "#5 in Electronics" pattern
  const singleMatch = withoutSeeTop.match(
    /#\s*(\d[\d,]*)\s+(?:in|en|dans)\s+([A-Za-z0-9&,'’\s/-]{2,60})/i
  );
  if (singleMatch?.[1] && singleMatch?.[2]) {
    const cat = cleanText(singleMatch[2].replace(/[,;:\-–—]+$/, ''));
    if (cat) return `#${singleMatch[1]} in ${cat}`;
  }

  return null;
}

/**
 * Extracts Amazon Best Sellers Rank (e.g. "#5 in Electronics") from a product detail page
 * or a Best Sellers / Category / Search product card (SAD-140).
 */
export function extractBestSellersRank(
  rootOrDoc: Element | Document,
  pageCategoryHint?: string | null
): string | null {
  // 1. Check dedicated #SalesRank and product details tables/bullets
  const detailRows = Array.from(
    rootOrDoc.querySelectorAll(
      '#SalesRank, #productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, #productDetails_db_sections tr, #detailBulletsWrapper_feature_div li, #detailBullets_feature_div .a-list-item'
    )
  );
  for (const row of detailRows) {
    const text = extractElementText(row);
    if (!text) continue;
    if (
      row.id === 'SalesRank' ||
      /\b(?:Best\s*Sellers\s*Rank|Bestseller-Rang|Classement\s+des\s+meilleures\s+ventes|Clasificación\s+en\s+los\s+más\s+vendidos)\b/i.test(
        text
      )
    ) {
      const parsed = parseBestSellersRankText(text);
      if (parsed) return parsed;
    }
  }

  // 2. Check inline "#N in Category" text on cards or badges
  if ('tagName' in rootOrDoc) {
    const inlineCandidates = Array.from(
      rootOrDoc.querySelectorAll(
        '[data-testid*="bestseller-rank"], .a-badge-region, .zg-bdg-body, span, div'
      )
    );
    for (const el of inlineCandidates) {
      if (el.children.length > 3) continue;
      const text =
        cleanText(el.getAttribute('aria-label')) ?? cleanText(el.textContent);
      if (!text || text.length > 120) continue;
      if (/#\s*\d[\d,]*\s+in\s+/i.test(text)) {
        const parsed = parseBestSellersRankText(text);
        if (parsed) return parsed;
      }
    }

    // 3. Check Best Sellers rank badge (.zg-bdg-text or standalone "#1" badge on bestsellers cards)
    const rankBadgeEl =
      rootOrDoc.querySelector('.zg-bdg-text, .zg-badge-text') ??
      Array.from(rootOrDoc.querySelectorAll('span.a-size-small, .a-badge-text')).find(
        (el) => /^#\d{1,4}$/.test((el.textContent ?? '').trim())
      );
    if (rankBadgeEl) {
      const rankText = cleanText(rankBadgeEl.textContent);
      if (rankText && /^#\d[\d,]*$/.test(rankText)) {
        // Check if a sibling/parent specifies "in <Category>"
        const parentText = cleanText(rankBadgeEl.parentElement?.textContent);
        const withSiblingCat = parseBestSellersRankText(parentText);
        if (withSiblingCat) return withSiblingCat;

        if (pageCategoryHint) {
          return `${rankText} in ${pageCategoryHint}`;
        }
        return rankText;
      }
    }
  }

  return null;
}

/**
 * Extracts monthly sales velocity text (e.g. "10K+ bought in past month").
 */
export function extractPastMonthSales(container: Element): string | null {
  const els = Array.from(container.querySelectorAll('span, div'));
  for (const el of els) {
    if (el.children.length > 2) continue;
    const text =
      cleanText(el.getAttribute('aria-label')) ?? cleanText(el.textContent);
    if (!text || text.length > 80) continue;
    const match = text.match(
      /\b(\d+(?:[.,]\d+)?\s*[KkMm]?\+?\s+bought\s+in\s+past\s+(?:month|week))\b/i
    );
    if (match?.[1]) {
      return cleanText(match[1]);
    }
  }
  return null;
}

/**
 * Extracts coupon or promo offer text (e.g. "Save 15% with coupon", "Save $20.00 with coupon").
 */
export function extractCouponText(container: Element): string | null {
  const couponSelectors =
    '[data-component-type="s-coupon-component"], #couponBadgeRegularVpc, #vpcButton, .s-coupon-unclipped, .couponLabelText, [data-csa-c-type="coupon"]';
  const couponEls = Array.from(container.querySelectorAll(couponSelectors));
  for (const el of couponEls) {
    const text = extractElementText(el);
    if (!text) continue;
    const match = text.match(
      /\b((?:Save|Apply|Extra)\s+(?:[$€£¥₹]\s*\d+(?:[.,]\d+)?|\d{1,2}\s*%)\s+with\s+coupon|Coupon:\s*[^|•\n]+|\d{1,2}%\s+off\s+coupon)\b/i
    );
    if (match?.[1]) return cleanText(match[1]);
    if (text.length <= 60 && /\bcoupon\b/i.test(text)) {
      return text;
    }
  }

  const allSpans = Array.from(container.querySelectorAll('span, div'));
  for (const el of allSpans) {
    if (el.children.length > 2) continue;
    const text = cleanText(el.textContent);
    if (!text || text.length > 70) continue;
    const match = text.match(
      /\b((?:Save|Apply|Extra)\s+(?:[$€£¥₹]\s*\d+(?:[.,]\d+)?|\d{1,2}\s*%)\s+with\s+coupon)\b/i
    );
    if (match?.[1]) return cleanText(match[1]);
  }

  return null;
}

/**
 * Extracts editorial / recognition badges (e.g. "Amazon's Choice", "Overall Pick", "#1 Best Seller").
 */
export function extractProductBadge(container: Element): string | null {
  const badgeEls = Array.from(
    container.querySelectorAll(
      '#acBadge_feature_div, .ac-badge-wrapper, [data-component-type="s-status-badge-component"], .a-badge, .a-badge-label, .a-badge-text, span'
    )
  );
  for (const el of badgeEls) {
    if (el.children.length > 3) continue;
    const text =
      cleanText(el.getAttribute('aria-label')) ?? cleanText(el.textContent);
    if (!text || text.length > 60) continue;
    if (/\bAmazon's\s+Choice\b/i.test(text)) return "Amazon's Choice";
    if (/\bOverall\s+Pick\b/i.test(text)) return 'Overall Pick';
    if (/\b#?1\s+Best\s+Seller\b/i.test(text)) return '#1 Best Seller';
    if (/^Best\s+Seller$/i.test(text)) return 'Best Seller';
    if (/\b#?1\s+New\s+Release\b/i.test(text)) return '#1 New Release';
    if (/^New\s+Release$/i.test(text)) return 'New Release';
    if (/\bSmall\s+Business\b/i.test(text)) return 'Small Business';
  }
  return null;
}

/**
 * Extracts primary delivery / fulfilment details (e.g. "FREE delivery Tomorrow, Oct 17").
 */
export function extractDeliveryInfo(container: Element): string | null {
  const deliveryEls = Array.from(
    container.querySelectorAll(
      '[data-cy="delivery-recipe"] [aria-label*="delivery" i], [data-cy="delivery-recipe"], #mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE, #deliveryBlockMessage, [aria-label*="FREE delivery" i], [aria-label*="delivery" i]'
    )
  );
  for (const el of deliveryEls) {
    const raw =
      cleanText(el.getAttribute('aria-label')) ?? extractElementText(el);
    if (!raw) continue;
    const match = raw.match(
      /\b((?:FREE\s+delivery|Delivery)\s+[^.|;\n]{3,65})/i
    );
    if (match?.[1]) {
      return cleanText(match[1]);
    }
  }
  return null;
}

/**
 * Validates and normalizes a raw ScrapedProduct against source constraints.
 * Returns null if the product lacks a valid 10-character ASIN.
 */
export function validateAndNormalizeScrapedProduct(
  raw: ScrapedProduct,
  pageUrl?: string
): ScrapedProduct | null {
  try {
    if (!raw || typeof raw !== 'object') return null;

    const asin = normalizeASIN(raw.asin) ?? extractASIN(raw.url ?? '');
    if (!asin) return null;

    const url = resolveProductUrl(asin, raw.url, pageUrl);
    const fallbackCurrency = inferCurrencyFromUrl(pageUrl ?? url) ?? 'USD';

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

    const discountPercentage =
      normalizeDiscountPercentage(raw.discountPercentage) ??
      cleanText(raw.discountPercentage);

    const dealBadge = cleanText(raw.dealBadge);
    const bestSellersRank =
      parseBestSellersRankText(raw.bestSellersRank) ??
      cleanText(raw.bestSellersRank);
    const pastMonthSales = cleanText(raw.pastMonthSales);
    const coupon = cleanText(raw.coupon);
    const badge = cleanText(raw.badge);
    const delivery = cleanText(raw.delivery);

    const currency =
      price !== null || listPrice !== null
        ? (cleanText(raw.currency)?.toUpperCase() ?? fallbackCurrency)
        : cleanText(raw.currency)?.toUpperCase() ?? null;

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
          parsedImg.protocol === 'http:' ||
          parsedImg.protocol === 'https:'
        ) {
          imageUrl = parsedImg.href;
        }
      } catch {
        imageUrl = null;
      }
    }

    const title = cleanText(raw.title);
    const cleanedBrand = cleanBrand(raw.brand);
    const brand =
      cleanedBrand && cleanedBrand !== title ? cleanedBrand : null;

    const normalized: ScrapedProduct = {
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
      brand,
      availability: cleanAvailability(raw.availability),
      seller: cleanSeller(raw.seller),
      description: cleanText(raw.description) ?? null,
      features: Array.isArray(raw.features)
        ? raw.features
            .map((f) => cleanText(f))
            .filter((f): f is string => Boolean(f))
        : [],
      source:
        raw.source === 'detail' || raw.source === 'category'
          ? raw.source
          : 'search',
    };

    if (listPrice !== null) normalized.listPrice = listPrice;
    if (discountPercentage) normalized.discountPercentage = discountPercentage;
    if (dealBadge) normalized.dealBadge = dealBadge;
    if (bestSellersRank) normalized.bestSellersRank = bestSellersRank;
    if (pastMonthSales) normalized.pastMonthSales = pastMonthSales;
    if (coupon) normalized.coupon = coupon;
    if (badge) normalized.badge = badge;
    if (delivery) normalized.delivery = delivery;

    return normalized;
  } catch (err) {
    // M-7 (SAD-180): never drop a product without a trace — the bare
    // `catch { return null }` swallowed the exception too.
    console.warn('[PPHunt] validateAndNormalizeScrapedProduct failed:', err);
    return null;
  }
}
