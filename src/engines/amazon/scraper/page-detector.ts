import type { AmazonPageType } from '../types';
import { extractAsinFromUrl, isAmazonUrl } from '../utils/amazon-url';
import {
  AMAZON_SELECTORS,
  safeQuerySelector,
  safeQuerySelectorAll,
} from './selectors';

const DETAIL_PATH_PATTERNS: readonly RegExp[] = [
  /\/dp\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/gp\/product\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/gp\/aw\/d\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/exec\/obidos\/ASIN\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/o\/ASIN\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/d\/[^/]+\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
];

const SEARCH_PATH_REGEX = /^\/s(?:\/|$|\?)/i;

const CATEGORY_PATH_PATTERNS: readonly RegExp[] = [
  /^\/b(?:\/|$|\?)/i,
  /\/gp\/bestsellers/i,
  /\/Best-Sellers/i,
  /\/zgbs(?:\/|$|\?)/i,
  /\/gp\/new-releases/i,
  /\/gp\/movers-and-shakers/i,
  /\/gp\/most-wished-for/i,
  /\/gp\/goldbox/i,
  /^\/deals(?:\/|$|\?)/i,
  /\/Todays-Deals/i,
  /\/e\/[A-Z0-9]+/i,
  /\/stores\//i,
];

const UNSUPPORTED_PATH_PATTERNS: readonly RegExp[] = [
  /^\/?$/,
  /^\/ref=[^/]*\/?$/i,
  /^\/gp\/cart/i,
  /^\/gp\/buy/i,
  /^\/gp\/css/i,
  /^\/gp\/your-account/i,
  /^\/ap\/signin/i,
  /^\/ap\/register/i,
  /^\/hz\/wishlist/i,
  /^\/ customer-preferences/i,
];

/**
 * Classifies an Amazon URL and optional Document into `'search'`, `'category'`,
 * `'detail'`, or `'unsupported'`.
 */
export function detectAmazonPageType(
  url?: string | null,
  doc?: Document | null,
): AmazonPageType {
  const activeUrl =
    url ??
    (typeof window !== 'undefined' && window.location ? window.location.href : '');
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);

  if (activeUrl) {
    if (!isAmazonUrl(activeUrl)) {
      return 'unsupported';
    }

    try {
      const parsed = new URL(activeUrl);
      const pathAndSearch = `${parsed.pathname}${parsed.search}`;

      // 1. Product Detail Page (PDP) URL patterns
      for (const pattern of DETAIL_PATH_PATTERNS) {
        if (pattern.test(pathAndSearch)) {
          return 'detail';
        }
      }

      // 2. Explicit unsupported utility routes (cart, login, root homepage without query)
      for (const pattern of UNSUPPORTED_PATH_PATTERNS) {
        if (pattern.test(parsed.pathname) && !parsed.searchParams.has('k') && !parsed.searchParams.has('field-keywords') && !parsed.searchParams.has('node') && !parsed.searchParams.has('rh')) {
          return 'unsupported';
        }
      }

      // 3. Search results URL patterns
      if (
        SEARCH_PATH_REGEX.test(parsed.pathname) ||
        parsed.searchParams.has('k') ||
        parsed.searchParams.has('field-keywords')
      ) {
        // Note: /s?rh=n:... without a keyword (`k` / `field-keywords`) is still rendered using the search/browse grid
        if (
          parsed.searchParams.has('k') ||
          parsed.searchParams.has('field-keywords') ||
          SEARCH_PATH_REGEX.test(parsed.pathname)
        ) {
          return 'search';
        }
      }

      // 4. Category, Best Sellers, Deals, New Releases, Storefronts
      for (const pattern of CATEGORY_PATH_PATTERNS) {
        if (pattern.test(pathAndSearch)) {
          return 'category';
        }
      }

      if (parsed.searchParams.has('node') || parsed.searchParams.has('rh')) {
        return 'category';
      }
    } catch {
      return 'unsupported';
    }
  }

  // Fallback to DOM inspection when URL path is ambiguous
  if (activeDoc) {
    if (
      safeQuerySelector(activeDoc, '#productTitle') ||
      safeQuerySelector(activeDoc, '#dp-container') ||
      safeQuerySelector(activeDoc, 'input#ASIN')
    ) {
      return 'detail';
    }

    if (
      safeQuerySelector(
        activeDoc,
        '[data-component-type="s-search-result"][data-asin]',
      )
    ) {
      return 'search';
    }

    if (
      safeQuerySelector(activeDoc, '#gridItemRoot') ||
      safeQuerySelector(activeDoc, '[data-p13n-asin-metadata]') ||
      safeQuerySelector(activeDoc, '[data-testid*="deal-card"]') ||
      safeQuerySelector(activeDoc, '.octopus-pc-item')
    ) {
      return 'category';
    }
  }

  return 'unsupported';
}

export const detectPageType = detectAmazonPageType;

/**
 * Extracts the active search query or category label from an Amazon URL and optional Document.
 */
export function extractAmazonSearchQuery(
  url?: string | null,
  doc?: Document | null,
): string | undefined {
  const activeUrl =
    url ??
    (typeof window !== 'undefined' && window.location ? window.location.href : '');
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);

  if (activeUrl) {
    try {
      const parsed = new URL(activeUrl);
      const queryParam =
        parsed.searchParams.get('k') ??
        parsed.searchParams.get('field-keywords') ??
        parsed.searchParams.get('keywords');
      if (queryParam && queryParam.trim()) {
        return queryParam.trim();
      }
    } catch {
      // Ignore malformed URL
    }
  }

  if (activeDoc) {
    const searchInput = safeQuerySelector<HTMLInputElement>(
      activeDoc,
      '#twotabsearchtextbox, input[name="field-keywords"]',
    );
    if (searchInput?.value?.trim()) {
      return searchInput.value.trim();
    }

    const breadcrumbHeading = safeQuerySelector(
      activeDoc,
      '#zg_banner_text, #zg-right-col h1, .s-desktop-toolbar .a-color-state',
    );
    const headingText = breadcrumbHeading?.textContent?.trim()?.replace(/^["']|["']$/g, '');
    if (headingText) {
      return headingText;
    }
  }

  return undefined;
}

export const extractSearchQuery = extractAmazonSearchQuery;

/**
 * Counts the number of distinct scoped product cards currently present in the DOM.
 * Excludes peripheral recommendation carousels on search pages so scroll progress is accurate.
 */
export function countScopedProductCards(
  doc?: Document | null,
  pageType?: AmazonPageType,
): number {
  const activeDoc =
    doc ?? (typeof document !== 'undefined' ? document : null);
  if (!activeDoc) return 0;

  const resolvedType = pageType ?? detectAmazonPageType(undefined, activeDoc);
  if (resolvedType === 'unsupported') return 0;
  if (resolvedType === 'detail') {
    const hasTitle = Boolean(
      safeQuerySelector(activeDoc, '#productTitle, h1#title, #dp-container'),
    );
    return hasTitle ? 1 : 0;
  }

  if (resolvedType === 'search') {
    const searchCards = safeQuerySelectorAll(
      activeDoc,
      AMAZON_SELECTORS.search.cardContainers.join(', '),
    );
    const uniqueAsins = new Set<string>();
    for (const card of searchCards) {
      const asin = card.getAttribute('data-asin')?.trim().toUpperCase();
      if (asin && /^[A-Z0-9]{10}$/.test(asin)) {
        uniqueAsins.add(asin);
      }
    }
    if (uniqueAsins.size > 0) {
      return uniqueAsins.size;
    }
  }

  // Category / Best Sellers / Deals or Tier 3 fallback
  const categorySelectors = [
    ...AMAZON_SELECTORS.category.bestSellerCards,
    ...AMAZON_SELECTORS.category.dealCards,
    ...AMAZON_SELECTORS.category.browseCards,
  ].join(', ');
  const cards = safeQuerySelectorAll(activeDoc, categorySelectors);
  const uniqueIds = new Set<string>();

  for (const card of cards) {
    const directAsin = card.getAttribute('data-asin')?.trim().toUpperCase();
    if (directAsin && /^[A-Z0-9]{10}$/.test(directAsin)) {
      uniqueIds.add(directAsin);
      continue;
    }
    const metaRaw = card.getAttribute('data-p13n-asin-metadata');
    if (metaRaw) {
      try {
        const parsed = JSON.parse(metaRaw) as { asin?: string };
        if (parsed.asin && /^[A-Z0-9]{10}$/i.test(parsed.asin)) {
          uniqueIds.add(parsed.asin.toUpperCase());
          continue;
        }
      } catch {
        // Ignore malformed JSON
      }
    }
    const dpLink = safeQuerySelector<HTMLAnchorElement>(
      card,
      'a[href*="/dp/"], a[href*="/gp/product/"]',
    );
    const linkAsin = extractAsinFromUrl(dpLink?.getAttribute('href'));
    if (linkAsin) {
      uniqueIds.add(linkAsin);
    }
  }

  if (uniqueIds.size > 0) {
    return uniqueIds.size;
  }

  // Tier 3 structural anchor fallback
  const dpAnchors = safeQuerySelectorAll<HTMLAnchorElement>(
    activeDoc,
    'a[href*="/dp/"], a[href*="/gp/product/"]',
  );
  for (const anchor of dpAnchors) {
    const asin = extractAsinFromUrl(anchor.getAttribute('href'));
    if (asin) {
      uniqueIds.add(asin);
    }
  }

  return uniqueIds.size;
}

export const estimateProductCount = countScopedProductCards;
