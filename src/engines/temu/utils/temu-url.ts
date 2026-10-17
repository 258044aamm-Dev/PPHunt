import type { TemuPageType } from '../types';

/**
 * Valid Temu numeric goodsId: 6 to 22 digits.
 * Live Temu US goodsIds are typically 12–18 digits (e.g. "601099769178067").
 */
const GOODS_ID_EXACT_REGEX = /^\d{6,22}$/;

/**
 * Ordered extraction patterns for Temu product URLs and semantic DOM hooks:
 * 1. data-tooltip hooks: `goodContainer-601099769178067`, `goodName-601099769178067`, `GoodsSimilar-601099769178067`
 * 2. SEO product URL slug: `/...-g-601099769178067.html`
 * 3. Query parameter: `?goods_id=601099769178067` or `&goods_id=601099769178067`
 */
const GOODS_ID_EXTRACTION_PATTERNS: RegExp[] = [
  /\b(?:goodContainer|goodName|GoodsSimilar)-(\d{6,22})\b/i,
  /-g-(\d{6,22})\.html(?:[/?#]|$)/i,
  /[?&]goods_id=(\d{6,22})(?:[&#]|$)/i,
  /\/goods\.html[^#]*?[?&]goods_id=(\d{6,22})/i,
];

/**
 * Validates and normalizes a raw candidate string into a numeric Temu goodsId.
 */
export function normalizeGoodsId(
  candidate: string | number | null | undefined
): string | null {
  if (candidate == null) return null;
  const trimmed = String(candidate).trim();
  if (!trimmed) return null;
  if (GOODS_ID_EXACT_REGEX.test(trimmed)) {
    return trimmed;
  }
  return extractGoodsId(trimmed);
}

/**
 * Extracts a numeric Temu `goodsId` from a URL, href, or `data-tooltip` attribute.
 */
export function extractGoodsId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (GOODS_ID_EXACT_REGEX.test(trimmed)) {
    return trimmed;
  }

  let candidate = trimmed;
  try {
    candidate = decodeURIComponent(trimmed);
  } catch {
    // Keep raw input if percent-decoding fails
  }

  for (const pattern of GOODS_ID_EXTRACTION_PATTERNS) {
    const match = candidate.match(pattern) ?? trimmed.match(pattern);
    if (match?.[1] && GOODS_ID_EXACT_REGEX.test(match[1])) {
      return match[1];
    }
  }

  return null;
}

/**
 * Checks whether a URL belongs to a supported Temu domain (`temu.com` or `*.temu.com`) over HTTP(S).
 */
export function isTemuUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'temu.com' || host.endsWith('.temu.com');
  } catch {
    return false;
  }
}

/**
 * Extracts the origin (`https://www.temu.com`) from a URL, falling back to `https://www.temu.com`.
 */
export function getTemuOrigin(url?: string | null): string {
  if (url) {
    try {
      const parsed = new URL(url);
      if (isTemuUrl(parsed.href)) {
        return parsed.origin;
      }
    } catch {
      // Fallback below
    }
  }
  return 'https://www.temu.com';
}

/**
 * Builds a clean canonical Temu product URL (`https://www.temu.com/goods.html?goods_id=<goodsId>`).
 */
export function buildCanonicalTemuUrl(
  goodsId: string,
  baseUrl?: string | null
): string {
  const origin = getTemuOrigin(baseUrl);
  return `${origin}/goods.html?goods_id=${encodeURIComponent(goodsId.trim())}`;
}

/**
 * Resolves a raw product link href into a clean, absolute Temu product URL.
 * Strips ephemeral tracking query parameters (`_bg_fs`, `_p_rfs`, `refer_page_*`, `_x_sessn_id`, etc.)
 * while preserving SEO `-g-<goodsId>.html` paths or normalizing `/goods.html?goods_id=<goodsId>`.
 */
export function resolveTemuProductUrl(
  rawHref: string | null | undefined,
  goodsId: string | null | undefined,
  baseUrl?: string | null
): string {
  const normalizedId = normalizeGoodsId(goodsId) ?? extractGoodsId(rawHref);
  const origin = getTemuOrigin(baseUrl);

  if (rawHref) {
    try {
      const resolved = new URL(rawHref.trim(), origin);
      if (
        (resolved.protocol === 'https:' || resolved.protocol === 'http:') &&
        isTemuUrl(resolved.href)
      ) {
        if (/-g-\d{6,22}\.html$/i.test(resolved.pathname)) {
          return `${resolved.origin}${resolved.pathname}`;
        }
        const idFromQuery = resolved.searchParams.get('goods_id');
        if (idFromQuery && GOODS_ID_EXACT_REGEX.test(idFromQuery)) {
          return `${resolved.origin}/goods.html?goods_id=${idFromQuery}`;
        }
      }
    } catch {
      // Fall through to canonical builder
    }
  }

  if (normalizedId) {
    return buildCanonicalTemuUrl(normalizedId, origin);
  }

  return origin;
}

/**
 * Classifies a Temu URL into `product_detail`, `search`, `category`, or `unknown`
 * based purely on URL pathname and query parameters.
 */
export function detectTemuPageTypeFromUrl(
  url: string | null | undefined
): TemuPageType {
  if (!url || !isTemuUrl(url)) return 'unknown';

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const searchParams = parsed.searchParams;

    // 1. Product Detail Page:
    // - /goods.html?goods_id=601099769178067
    // - /some-product-slug-g-601099769178067.html
    if (
      /-g-\d{6,22}\.html$/i.test(path) ||
      (path.endsWith('/goods.html') &&
        GOODS_ID_EXACT_REGEX.test(searchParams.get('goods_id') ?? '')) ||
      GOODS_ID_EXACT_REGEX.test(searchParams.get('goods_id') ?? '')
    ) {
      return 'product_detail';
    }

    // 2. Search Results Page:
    // - /search_result.html?search_key=...
    // - /flat-wireless-earbuds-5030186936120-s.html (SEO search landing page)
    if (
      path.includes('/search_result') ||
      searchParams.has('search_key') ||
      /-s\.html$/i.test(path)
    ) {
      return 'search';
    }

    // 3. Category / Channel / Best Sellers Page:
    // - /womens-shoes-o3-95.html, /*-o1-*.html, /*-o2-*.html, /*-o3-*.html
    // - /channel/*, /bestsellers*, /attendance/*
    if (
      /-o[1234]-\d+\.html$/i.test(path) ||
      path.startsWith('/channel/') ||
      path.includes('bestsellers') ||
      path.includes('best-sellers') ||
      path.startsWith('/c/') ||
      path.startsWith('/category/')
    ) {
      return 'category';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extracts a human-readable search query or category slug from a Temu URL when present.
 */
export function extractTemuSearchQueryFromUrl(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const searchKey = parsed.searchParams.get('search_key')?.trim();
    if (searchKey) return searchKey;

    // Static SEO search URL: /flat-wireless-earbuds-5030186936120-s.html
    const seoSearchMatch = parsed.pathname.match(
      /\/([a-z0-9-]+?)-\d+-s\.html$/i
    );
    if (seoSearchMatch?.[1]) {
      return seoSearchMatch[1].replace(/-/g, ' ').trim() || null;
    }

    // Category URL: /womens-shoes-o3-95.html
    const categoryMatch = parsed.pathname.match(
      /\/([a-z0-9-]+?)-o[1234]-\d+\.html$/i
    );
    if (categoryMatch?.[1]) {
      return categoryMatch[1].replace(/-/g, ' ').trim() || null;
    }

    return null;
  } catch {
    return null;
  }
}
