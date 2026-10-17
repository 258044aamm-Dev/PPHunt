import {
  type AmazonMarketplaceDomain,
  matchAmazonMarketplaceDomain,
} from './amazon-url';

export const MARKETPLACE_CURRENCY_MAP: Readonly<Record<AmazonMarketplaceDomain, string>> = {
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

const EXPLICIT_PREFIX_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
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
 * Infers the ISO 4217 currency code from an Amazon URL or hostname.
 * Defaults to 'USD' when no regional Amazon domain matches.
 */
export function inferCurrencyFromHost(urlOrHost?: string | null): string {
  const domain = matchAmazonMarketplaceDomain(urlOrHost);
  if (domain && MARKETPLACE_CURRENCY_MAP[domain]) {
    return MARKETPLACE_CURRENCY_MAP[domain];
  }
  return 'USD';
}

/**
 * Resolves the ISO 4217 currency code from a raw price string and/or page URL.
 * Disambiguates shared symbols (`$`, `¥`) using the marketplace hostname when available.
 */
export function resolveAmazonCurrency(
  priceText?: string | null,
  pageUrl?: string | null,
): string {
  const hostCurrency = inferCurrencyFromHost(pageUrl);
  if (!priceText || typeof priceText !== 'string') {
    return hostCurrency;
  }

  const trimmed = priceText.trim();
  if (!trimmed) {
    return hostCurrency;
  }

  for (const [pattern, code] of EXPLICIT_PREFIX_TOKENS) {
    if (pattern.test(trimmed)) {
      return code;
    }
  }

  if (/[¥￥]/.test(trimmed)) {
    return hostCurrency === 'CNY' ? 'CNY' : 'JPY';
  }

  if (trimmed.includes('$')) {
    if (
      hostCurrency === 'CAD' ||
      hostCurrency === 'AUD' ||
      hostCurrency === 'MXN' ||
      hostCurrency === 'SGD' ||
      hostCurrency === 'BRL'
    ) {
      return hostCurrency;
    }
    return 'USD';
  }

  return hostCurrency;
}

export const inferCurrency = resolveAmazonCurrency;
