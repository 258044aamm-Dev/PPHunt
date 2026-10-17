import type { AmazonPageType } from '../types';
import { extractASIN, isAmazonUrl } from '../utils/amazon-url';
import { countProductCards } from './count-products';
import { safeQuerySelector } from './selectors';

const DETAIL_PATH_PATTERNS: readonly RegExp[] = [
  /\/dp\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/gp\/product\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/gp\/aw\/d\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/exec\/obidos\/ASIN\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/o\/ASIN\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
  /\/d\/[^/]+\/[A-Z0-9]{10}(?:[/?#&]|$)/i,
];

const SEARCH_PATH_REGEX = /^\/s(?:\/|$|\?)/i;

const BESTSELLERS_PATH_PATTERNS: readonly RegExp[] = [
  /\/gp\/bestsellers/i,
  /\/Best-Sellers/i,
  /\/zgbs(?:\/|$|\?)/i,
  /\/gp\/new-releases/i,
  /\/gp\/movers-and-shakers/i,
  /\/gp\/most-wished-for/i,
];

const CATEGORY_PATH_PATTERNS: readonly RegExp[] = [
  /^\/b(?:\/|$|\?)/i,
  /\/gp\/goldbox/i,
  /^\/deals(?:\/|$|\?)/i,
  /\/Todays-Deals/i,
  /\/e\/[A-Z0-9]+/i,
  /\/stores\//i,
];

/**
 * Classifies an Amazon URL and optional Document into `'search'`, `'category'`,
 * `'bestsellers'`, `'product-detail'`, or `'other'`.
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
      return 'other';
    }

    try {
      const parsed = new URL(activeUrl);
      const pathAndSearch = `${parsed.pathname}${parsed.search}`;

      for (const pattern of DETAIL_PATH_PATTERNS) {
        if (pattern.test(pathAndSearch) || extractASIN(activeUrl)) {
          return 'product-detail';
        }
      }

      for (const pattern of BESTSELLERS_PATH_PATTERNS) {
        if (pattern.test(pathAndSearch)) {
          return 'bestsellers';
        }
      }

      if (
        SEARCH_PATH_REGEX.test(parsed.pathname) ||
        parsed.searchParams.has('k') ||
        parsed.searchParams.has('field-keywords')
      ) {
        return 'search';
      }

      for (const pattern of CATEGORY_PATH_PATTERNS) {
        if (pattern.test(pathAndSearch)) {
          return 'category';
        }
      }

      if (parsed.searchParams.has('node') || parsed.searchParams.has('rh')) {
        return 'category';
      }
    } catch {
      return 'other';
    }
  }

  if (activeDoc) {
    if (
      safeQuerySelector(activeDoc, '#productTitle') ||
      safeQuerySelector(activeDoc, '#dp-container')
    ) {
      return 'product-detail';
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
      safeQuerySelector(activeDoc, '[data-p13n-asin-metadata]')
    ) {
      return 'bestsellers';
    }

    if (
      safeQuerySelector(activeDoc, '[data-testid*="deal-card"]') ||
      safeQuerySelector(activeDoc, '.octopus-pc-item')
    ) {
      return 'category';
    }
  }

  return 'other';
}

export const detectPageType = detectAmazonPageType;

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
  }

  return undefined;
}

export const extractSearchQuery = extractAmazonSearchQuery;
export const countScopedProductCards = countProductCards;
export const estimateProductCount = countProductCards;
