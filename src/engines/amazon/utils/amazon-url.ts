/**
 * Multi-marketplace Amazon URL, hostname, ASIN, and image URL utilities.
 * Supports 20+ global Amazon domains and handles tracking-parameter cleanup,
 * sponsored redirect unwrap (/sspa/click), and high-resolution image upgrading.
 */

export const AMAZON_MARKETPLACE_DOMAINS = [
  'amazon.com.au',
  'amazon.com.be',
  'amazon.com.br',
  'amazon.com.mx',
  'amazon.com.tr',
  'amazon.co.jp',
  'amazon.co.uk',
  'amazon.co.za',
  'amazon.com',
  'amazon.ca',
  'amazon.cn',
  'amazon.de',
  'amazon.eg',
  'amazon.es',
  'amazon.fr',
  'amazon.in',
  'amazon.it',
  'amazon.nl',
  'amazon.pl',
  'amazon.sa',
  'amazon.se',
  'amazon.sg',
  'amazon.ae',
] as const;

export type AmazonMarketplaceDomain = (typeof AMAZON_MARKETPLACE_DOMAINS)[number];

const ASIN_EXACT_REGEX = /^[A-Z0-9]{10}$/;

const ASIN_URL_PATTERNS: readonly RegExp[] = [
  /\/dp\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/gp\/product\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/gp\/offer-listing\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/product-reviews\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/o\/ASIN\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
  /\/d\/[^/]+\/([A-Z0-9]{10})(?:[/?#&]|$)/i,
];

/**
 * Matches an Amazon domain in a hostname (`www.amazon.co.uk`, `smile.amazon.de`, `amazon.com`).
 */
export function matchAmazonMarketplaceDomain(
  hostnameOrUrl: string | null | undefined,
): AmazonMarketplaceDomain | null {
  if (!hostnameOrUrl || typeof hostnameOrUrl !== 'string') {
    return null;
  }
  const raw = hostnameOrUrl.trim().toLowerCase();
  if (!raw) return null;

  let host = raw;
  if (raw.includes('://')) {
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    host = raw.split('/')[0]?.split(':')[0] ?? '';
  }

  for (const domain of AMAZON_MARKETPLACE_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return domain;
    }
  }

  return null;
}

export function isAmazonHostname(hostname: string | null | undefined): boolean {
  return matchAmazonMarketplaceDomain(hostname) !== null;
}

export function isAmazonUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return isAmazonHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Normalizes a raw 10-character ASIN candidate or extracts one from an Amazon URL/path.
 */
export function normalizeAsin(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (ASIN_EXACT_REGEX.test(upper)) {
    return upper;
  }

  return extractAsinFromUrl(trimmed);
}

/**
 * Extracts a 10-character uppercase ASIN from direct product URLs, mobile URLs,
 * or sponsored `/sspa/click?...&url=%2Fdp%2FB08N5WRWNW` redirect links.
 */
export function extractAsinFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const candidate = rawUrl.trim();
  if (!candidate) return null;

  for (const pattern of ASIN_URL_PATTERNS) {
    const match = pattern.exec(candidate);
    if (match?.[1]) {
      const asin = match[1].toUpperCase();
      if (ASIN_EXACT_REGEX.test(asin)) {
        return asin;
      }
    }
  }

  // Check query parameters (e.g. /sspa/click?url=%2Fdp%2FB08N5WRWNW or ?asin=B08N5WRWNW)
  try {
    const parsed = new URL(candidate, 'https://www.amazon.com');
    const directAsinParam =
      parsed.searchParams.get('asin') ??
      parsed.searchParams.get('ASIN') ??
      parsed.searchParams.get('pd_rd_i');
    if (directAsinParam) {
      const upper = directAsinParam.trim().toUpperCase();
      if (ASIN_EXACT_REGEX.test(upper)) {
        return upper;
      }
    }

    const nestedUrlParam =
      parsed.searchParams.get('url') ??
      parsed.searchParams.get('lp') ??
      parsed.searchParams.get('redirectUrl');
    if (nestedUrlParam) {
      let decoded = nestedUrlParam;
      try {
        decoded = decodeURIComponent(nestedUrlParam);
      } catch {
        // Keep raw nested parameter if already decoded
      }
      for (const pattern of ASIN_URL_PATTERNS) {
        const match = pattern.exec(decoded);
        if (match?.[1]) {
          const asin = match[1].toUpperCase();
          if (ASIN_EXACT_REGEX.test(asin)) {
            return asin;
          }
        }
      }
    }
  } catch {
    // Ignore malformed URLs and try URL-decoding once
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded !== candidate) {
        for (const pattern of ASIN_URL_PATTERNS) {
          const match = pattern.exec(decoded);
          if (match?.[1]) {
            const asin = match[1].toUpperCase();
            if (ASIN_EXACT_REGEX.test(asin)) {
              return asin;
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Resolves the canonical origin (`https://www.amazon.<tld>`) from a base URL or hostname.
 */
export function resolveAmazonOrigin(baseUrl?: string | null): string {
  if (baseUrl && typeof baseUrl === 'string') {
    try {
      const parsed = new URL(baseUrl);
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        isAmazonHostname(parsed.hostname)
      ) {
        return `https://${parsed.hostname.toLowerCase()}`;
      }
    } catch {
      const domain = matchAmazonMarketplaceDomain(baseUrl);
      if (domain) {
        return `https://www.${domain}`;
      }
    }
  }
  return 'https://www.amazon.com';
}

/**
 * Builds a canonical `https://<amazon-host>/dp/<ASIN>` URL.
 */
export function buildCanonicalAmazonProductUrl(
  asin: string,
  baseUrl?: string | null,
): string {
  const normalized = normalizeAsin(asin);
  const origin = resolveAmazonOrigin(baseUrl);
  if (!normalized) {
    return origin;
  }
  return `${origin}/dp/${normalized}`;
}

/**
 * Normalizes any product href or ASIN into a clean canonical `/dp/<ASIN>` URL
 * on the active Amazon marketplace domain.
 */
export function normalizeProductUrl(
  rawHref: string | null | undefined,
  asin?: string | null,
  baseUrl?: string | null,
): string {
  const origin = resolveAmazonOrigin(baseUrl || rawHref);
  const resolvedAsin = normalizeAsin(asin) ?? extractAsinFromUrl(rawHref);

  if (resolvedAsin) {
    // If rawHref itself has a valid Amazon host, preserve that marketplace host
    if (rawHref) {
      try {
        const parsedHref = new URL(rawHref, origin);
        if (isAmazonHostname(parsedHref.hostname)) {
          return `https://${parsedHref.hostname.toLowerCase()}/dp/${resolvedAsin}`;
        }
      } catch {
        // Fall through to origin
      }
    }
    return `${origin}/dp/${resolvedAsin}`;
  }

  if (!rawHref || typeof rawHref !== 'string' || !rawHref.trim()) {
    return '';
  }

  try {
    const parsed = new URL(rawHref.trim(), origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    // Strip tracking query parameters when no ASIN could be extracted
    const cleanPath = parsed.pathname.replace(/\/ref=[^/]*$/i, '');
    return `https://${parsed.hostname.toLowerCase()}${cleanPath}`;
  } catch {
    return '';
  }
}

/**
 * Upgrades Amazon dynamic thumbnail modifiers (`._AC_UL320_.jpg`, `._SX300_SY300_.jpg`, etc.)
 * to clean high-resolution product image URLs.
 */
export function upgradeAmazonImageUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:')) return '';

  let normalized = trimmed;
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    // Strip Amazon dynamic sizing directives between the image ID and file extension:
    // e.g. /images/I/71abc123._AC_UL320_.jpg -> /images/I/71abc123.jpg
    parsed.pathname = parsed.pathname.replace(
      /\._[A-Za-z0-9,._-]+_\.(jpg|jpeg|png|webp|gif)$/i,
      '.$1',
    );
    return parsed.toString();
  } catch {
    return '';
  }
}
