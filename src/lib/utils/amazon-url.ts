const AMAZON_DOMAINS = [
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.ca',
  'amazon.co.jp',
  'amazon.in',
  'amazon.com.au',
  'amazon.es',
  'amazon.it',
];

const ASIN_PATH_PATTERNS = [
  /\/dp\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/gp\/product\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/o\/ASIN\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/product\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/product-reviews\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /amzn1\.asin\.(?:\d+\.)?([A-Z0-9]{10})(?:[^A-Z0-9]|$)/i,
];

/**
 * Validates that a string is a canonical 10-character Amazon ASIN or ISBN-10.
 */
export function isValidASIN(value: string | null | undefined): boolean {
  if (!value) return false;
  const cleaned = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(cleaned)) return false;
  // Standard Amazon ASINs start with B (e.g. B08N5WRWNW) or are 10-digit ISBNs (optionally ending in X)
  return /^B[A-Z0-9]{9}$/.test(cleaned) || /^\d{9}[\dX]$/.test(cleaned);
}

/**
 * Normalizes a raw ASIN string to uppercase 10-char format, or null if invalid.
 */
export function normalizeASIN(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase();
  return isValidASIN(cleaned) ? cleaned : null;
}

/**
 * Checks whether a URL belongs to a supported Amazon domain.
 */
export function isAmazonUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return AMAZON_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Extracts a 10-character ASIN from an Amazon URL (including /sspa/click sponsored redirects)
 * or returns null if not found.
 */
export function extractASIN(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (isValidASIN(trimmed)) return trimmed.toUpperCase();

  for (const pattern of ASIN_PATH_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1] && isValidASIN(match[1])) {
      return match[1].toUpperCase();
    }
  }

  try {
    const parsed = new URL(trimmed, 'https://www.amazon.com');
    for (const pattern of ASIN_PATH_PATTERNS) {
      const match = parsed.pathname.match(pattern);
      if (match?.[1] && isValidASIN(match[1])) {
        return match[1].toUpperCase();
      }
    }

    // Check embedded redirect URL query params (e.g. /sspa/click?url=%2Fdp%2FB08N5WRWNW...)
    for (const param of ['url', 'lp', 'u', 'asin', 'pd_rd_i']) {
      const val = parsed.searchParams.get(param);
      if (!val) continue;
      if (isValidASIN(val)) return val.trim().toUpperCase();
      const decoded = decodeURIComponent(val);
      for (const pattern of ASIN_PATH_PATTERNS) {
        const match = decoded.match(pattern);
        if (match?.[1] && isValidASIN(match[1])) {
          return match[1].toUpperCase();
        }
      }
    }
  } catch {
    // Ignore malformed URLs
  }

  return null;
}

/**
 * Builds a clean, canonical product URL preserving the regional Amazon domain when available.
 * Accepts either (rawHref, asin, pageUrl) or (asin, rawHref, pageUrl).
 */
export function resolveProductUrl(
  first: string | null | undefined,
  second?: string | null,
  pageUrl?: string | null
): string {
  let cleanAsin: string | null = null;
  let rawHref: string | null | undefined = null;

  if (isValidASIN(first)) {
    cleanAsin = normalizeASIN(first);
    rawHref = second;
  } else if (isValidASIN(second)) {
    cleanAsin = normalizeASIN(second);
    rawHref = first;
  } else {
    cleanAsin =
      (first ? extractASIN(first) : null) ??
      (second ? extractASIN(second) : null) ??
      (first ?? second ?? '').trim().toUpperCase();
    rawHref = first;
  }

  for (const candidate of [pageUrl, rawHref]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (isAmazonUrl(parsed.href)) {
        const host = parsed.hostname.startsWith('www.')
          ? parsed.hostname
          : `www.${parsed.hostname}`;
        return `https://${host}/dp/${cleanAsin}`;
      }
    } catch {
      // Ignore relative or invalid URLs
    }
  }

  return `https://www.amazon.com/dp/${cleanAsin}`;
}
