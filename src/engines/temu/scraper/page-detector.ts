import type { TemuPageType } from '../types';
import {
  detectTemuPageTypeFromUrl,
  extractGoodsId,
  extractTemuSearchQueryFromUrl,
  isTemuUrl,
} from '../utils/temu-url';
import { TEMU_SELECTORS } from './selectors';

/**
 * Classifies the current Temu document into `product_detail`, `search`, `category`, or `unknown`.
 * Combines:
 * 1. URL pattern classification (`/*-g-<goodsId>.html`, `/goods.html?goods_id=`, `/search_result.html`, `/*-s.html`, `/*-o3-*.html`)
 * 2. SSR page context (`window.__PageContext__.pagePath` when accessible in content script context)
 * 3. Semantic DOM landmarks (`#goods_price`, `#rightContent`, `.js-search-goodsList`, `.js-category-goodsList`, `application/ld+json`)
 */
export function detectTemuPageType(
  url: string,
  document: Document
): TemuPageType {
  if (!isTemuUrl(url)) {
    return 'unknown';
  }

  // 1. Check URL patterns first
  const urlPageType = detectTemuPageTypeFromUrl(url);
  if (urlPageType !== 'unknown') {
    return urlPageType;
  }

  // 2. Check inline SSR script or JSON-LD for PDP vs Search vs Category
  const pageContextPath = extractPageContextPathFromScripts(document);
  if (pageContextPath) {
    if (pageContextPath === 'w/goods' || pageContextPath.endsWith('/goods')) {
      return 'product_detail';
    }
    if (
      pageContextPath === 'w/search_result' ||
      pageContextPath === 'w/seo_search_result' ||
      pageContextPath.includes('search_result')
    ) {
      return 'search';
    }
    if (
      pageContextPath === 'w/category' ||
      pageContextPath.includes('category') ||
      pageContextPath.includes('channel')
    ) {
      return 'category';
    }
  }

  // 3. Check semantic DOM landmarks
  if (
    document.querySelector('#goods_price') ||
    (document.querySelector('#leftContent') &&
      document.querySelector('#rightContent')) ||
    hasProductJsonLd(document)
  ) {
    return 'product_detail';
  }

  if (document.querySelector('.js-search-goodsList')) {
    return 'search';
  }

  if (
    document.querySelector(
      '.js-category-goodsList, .js-category-RecGoodsList'
    )
  ) {
    return 'category';
  }

  // If generic product cards exist on a Temu subpage (e.g. deals/channel/bestsellers), classify as category
  const cardCount = countTemuProductCardsOnPage(document);
  if (cardCount > 1) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname && parsed.pathname !== '/') {
        return 'category';
      }
    } catch {
      // Ignore
    }
  }

  return 'unknown';
}

/**
 * Extracts `pagePath` from inline `<script>` tags containing `window.__PageContext__ = {...}`.
 */
function extractPageContextPathFromScripts(document: Document): string | null {
  try {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
    for (const script of scripts) {
      const text = script.textContent ?? '';
      if (!text.includes('__PageContext__')) continue;
      const match = text.match(/"pagePath"\s*:\s*"([^"]+)"/);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // Ignore script scan errors
  }
  return null;
}

/**
 * Checks whether the document contains a `<script type="application/ld+json">` with `@type: "Product"`.
 */
function hasProductJsonLd(document: Document): boolean {
  try {
    const ldScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    for (const script of ldScripts) {
      const raw = script.textContent?.trim();
      if (!raw || !raw.includes('Product')) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      if (
        items.some(
          (item) =>
            item &&
            typeof item === 'object' &&
            String(item['@type'] ?? '').toLowerCase() === 'product'
        )
      ) {
        return true;
      }
    }
  } catch {
    // Ignore malformed JSON-LD
  }
  return false;
}

/**
 * Counts unique Temu products currently visible in the page DOM.
 * Scoped to the main listing container when present so peripheral recommendation carousels
 * do not reset scroll staleness detection.
 */
export function countTemuProductCardsOnPage(document: Document): number {
  const scope =
    document.querySelector(
      '.js-search-goodsList, .js-category-goodsList, .auto-fit-list'
    ) ?? document;

  const seenGoodsIds = new Set<string>();

  const tooltipCards = Array.from(
    scope.querySelectorAll(TEMU_SELECTORS.listing.productCard)
  );
  for (const el of tooltipCards) {
    const id =
      extractGoodsId(el.getAttribute('data-tooltip')) ??
      extractGoodsId(el.getAttribute('data-goods-id'));
    if (id) seenGoodsIds.add(id);
  }

  const links = Array.from(
    scope.querySelectorAll<HTMLAnchorElement>(TEMU_SELECTORS.listing.productLink)
  );
  for (const link of links) {
    const id = extractGoodsId(link.getAttribute('href'));
    if (id) seenGoodsIds.add(id);
  }

  return seenGoodsIds.size;
}

/**
 * Extracts the active search query or category heading from the URL or DOM.
 */
export function extractTemuSearchQuery(
  url: string,
  document?: Document
): string | null {
  const fromUrl = extractTemuSearchQueryFromUrl(url);
  if (fromUrl) return fromUrl;
  if (!document) return null;

  const searchInput = document.querySelector<HTMLInputElement>(
    'input[type="search"], input#searchInput, input[placeholder*="Search" i]'
  );
  if (searchInput?.value?.trim()) {
    return searchInput.value.trim();
  }

  const h1 = document.querySelector('h1');
  const h1Text = h1?.getAttribute('aria-label')?.trim() || h1?.textContent?.trim();
  if (h1Text && h1Text.length <= 100) {
    return h1Text;
  }

  return null;
}
