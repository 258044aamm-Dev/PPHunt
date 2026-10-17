import {
  type AmazonMarketplaceDomain,
  matchAmazonMarketplaceDomain,
} from './amazon-url';

export const HOST_CURRENCY_MAP: Readonly<Record<AmazonMarketplaceDomain, string>> = {
  'amazon.com': 'USD',
  'amazon.co.uk': 'GBP',
  'amazon.de': 'EUR',
  'amazon.fr': 'EUR',
  'amazon.it': 'EUR',
  'amazon.es': 'EUR',
  'amazon.nl': 'EUR',
  'amazon.com.be': 'EUR',
  'amazon.co.jp': 'JPY',
  'amazon.ca': 'CAD',
  'amazon.com.au': 'AUD',
  'amazon.in': 'INR',
  'amazon.com.mx': 'MXN',
  'amazon.com.br': 'BRL',
  'amazon.pl': 'PLN',
  'amazon.se': 'SEK',
  'amazon.sg': 'SGD',
  'amazon.ae': 'AED',
  'amazon.sa': 'SAR',
  'amazon.com.tr': 'TRY',
  'amazon.eg': 'EGP',
  'amazon.co.za': 'ZAR',
  'amazon.cn': 'CNY',
};

export const MARKETPLACE_CURRENCY_MAP = HOST_CURRENCY_MAP;

const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;

/**
 * Checks whether a value is a bare 3-letter uppercase ISO 4217 currency code (e.g. 'USD', 'EUR').
 */
export function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && ISO_CURRENCY_REGEX.test(value);
}

/**
 * Resolves the ISO 4217 currency code from an Amazon page URL or hostname.
 * Returns `null` (never a guess or the raw URL) when the host is unrecognized or empty.
 */
export function resolvePageCurrency(
  pageUrlOrHost: string | null | undefined,
): string | null {
  if (!pageUrlOrHost || typeof pageUrlOrHost !== 'string') {
    return null;
  }
  const trimmed = pageUrlOrHost.trim();
  if (!trimmed) return null;

  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      const domain = matchAmazonMarketplaceDomain(parsed.hostname);
      return domain ? (HOST_CURRENCY_MAP[domain] ?? null) : null;
    } catch {
      return null;
    }
  }

  // Only treat bare hostname strings if they contain no whitespace
  if (/\s/.test(trimmed)) return null;
  const domain = matchAmazonMarketplaceDomain(trimmed);
  return domain ? (HOST_CURRENCY_MAP[domain] ?? null) : null;
}

/**
 * Infers the ISO 4217 currency code from an Amazon URL, defaulting to 'USD' when unknown.
 */
export function inferCurrencyFromUrl(url?: string | null): string {
  return resolvePageCurrency(url) ?? 'USD';
}

export const inferCurrencyFromHost = inferCurrencyFromUrl;

const EXPLICIT_SYMBOL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bUS\s*\$/i, 'USD'],
  [/\b(?:CA|CDN)\s*\$/i, 'CAD'],
  [/\b(?:AU|A)\s*\$/i, 'AUD'],
  [/\bMX\s*\$/i, 'MXN'],
  [/\bS\s*\$/i, 'SGD'],
  [/\bR\s*\$/i, 'BRL'],
  [/\bCHF\b/i, 'CHF'],
  [/\bAED\b|د\.إ/i, 'AED'],
  [/\bSAR\b|ر\.س/i, 'SAR'],
  [/\bEGP\b|ج\.م/i, 'EGP'],
  [/\bTRY\b|\bTL\b|₺/i, 'TRY'],
  [/\bPLN\b|zł/i, 'PLN'],
  [/\bSEK\b|\bkr\b/i, 'SEK'],
  [/\bZAR\b/i, 'ZAR'],
  [/\bINR\b|₹/i, 'INR'],
  [/\bGBP\b|£/i, 'GBP'],
  [/\bEUR\b|€/i, 'EUR'],
  [/\bJPY\b/i, 'JPY'],
  [/\bCNY\b|\bRMB\b/i, 'CNY'],
  [/\bUSD\b/i, 'USD'],
  [/\bCAD\b/i, 'CAD'],
  [/\bAUD\b/i, 'AUD'],
  [/\bMXN\b/i, 'MXN'],
  [/\bBRL\b/i, 'BRL'],
  [/\bSGD\b/i, 'SGD'],
];

/**
 * Extracts an explicit ISO 4217 currency code from a price string's symbol or prefix,
 * using `fallbackIso` only to disambiguate generic `$` or `¥` symbols.
 */
export function extractCurrencyFromSymbol(
  rawText: string | null | undefined,
  fallbackIso?: string | null,
): string | null {
  if (!rawText || typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  for (const [pattern, code] of EXPLICIT_SYMBOL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return code;
    }
  }

  const validFallback = isIsoCurrency(fallbackIso) ? fallbackIso : null;

  if (/[¥￥]/.test(trimmed)) {
    return validFallback === 'CNY' ? 'CNY' : 'JPY';
  }

  if (trimmed.includes('$')) {
    if (
      validFallback === 'CAD' ||
      validFallback === 'AUD' ||
      validFallback === 'MXN' ||
      validFallback === 'SGD' ||
      validFallback === 'BRL'
    ) {
      return validFallback;
    }
    return 'USD';
  }

  return null;
}

/**
 * Resolves the ISO 4217 currency code from a raw price string and/or page URL.
 */
export function resolveAmazonCurrency(
  priceText?: string | null,
  pageUrlOrFallback?: string | null,
): string {
  const validFallback = isIsoCurrency(pageUrlOrFallback)
    ? pageUrlOrFallback
    : resolvePageCurrency(pageUrlOrFallback);
  const symbolCurrency = extractCurrencyFromSymbol(priceText, validFallback);
  return symbolCurrency ?? validFallback ?? 'USD';
}

export const inferCurrency = resolveAmazonCurrency;
