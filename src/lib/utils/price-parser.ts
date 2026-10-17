/**
 * Parses Amazon price strings into a numeric value and ISO currency code.
 *
 * Handles:
 *   - "$49.99", "US$49.99", "CA$29.99", "C$29.99", "AU$19.99", "A$19.99"
 *   - "€39,99", "39,99 €", "1.299,99 €" (trailing & leading Euro formats)
 *   - "£24.99", "£1,299.99"
 *   - "¥3,980", "￥3,980"
 *   - "₹1,49,999.00", "₹499"
 *   - Price ranges ("$19.99 - $29.99" → first price 19.99)
 *   - "See price at checkout" / "Currently unavailable" → null
 *   - Whole + fraction split (e.g. "$49" + "99", or "3,980" + null for JPY)
 */

import { isIsoCurrency } from './currency';

export interface ParsedPrice {
  value: number | null;
  currency: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  USD: 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  '£': 'GBP',
  GBP: 'GBP',
  '¥': 'JPY',
  '￥': 'JPY',
  JPY: 'JPY',
  '₹': 'INR',
  INR: 'INR',
  'A$': 'AUD',
  AU$: 'AUD',
  AUD: 'AUD',
  'C$': 'CAD',
  CA$: 'CAD',
  CDN$: 'CAD',
  CAD: 'CAD',
};

const HOST_CURRENCY_MAP: Array<[RegExp, string]> = [
  [/amazon\.co\.uk$/i, 'GBP'],
  [/amazon\.(de|fr|es|it)$/i, 'EUR'],
  [/amazon\.co\.jp$/i, 'JPY'],
  [/amazon\.ca$/i, 'CAD'],
  [/amazon\.com\.au$/i, 'AUD'],
  [/amazon\.in$/i, 'INR'],
  [/amazon\.com$/i, 'USD'],
];

/**
 * Infers the default ISO currency code from an Amazon page URL.
 */
export function inferCurrencyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { hostname } = new URL(url);
    for (const [pattern, code] of HOST_CURRENCY_MAP) {
      if (pattern.test(hostname)) return code;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveCurrencyToken(
  rawSymbol: string | null | undefined,
  fallbackCurrency?: string | null
): string | null {
  // Defence in depth (C-1): only a valid ISO-4217 code may ever be used as the
  // fallback — a URL or any other junk passed by a call site resolves to null.
  if (!rawSymbol) return isIsoCurrency(fallbackCurrency) ? fallbackCurrency : null;
  const cleaned = rawSymbol.replace(/\s+/g, '').toUpperCase();
  const mapped = CURRENCY_SYMBOLS[cleaned] ?? CURRENCY_SYMBOLS[rawSymbol.trim()];
  if (mapped) {
    // If generic '$' appears on amazon.ca or amazon.com.au, prefer the regional dollar code
    if (rawSymbol.trim() === '$' && (fallbackCurrency === 'CAD' || fallbackCurrency === 'AUD')) {
      return fallbackCurrency;
    }
    return mapped;
  }
  return isIsoCurrency(fallbackCurrency) ? fallbackCurrency : null;
}

function extractCurrencyFromText(
  text: string,
  fallbackCurrency?: string | null
): string | null {
  // Check explicit multi-char tokens first, then single-char symbols
  const tokenMatch = text.match(
    /(?:^|[\s(])(CDN\$|CA\$|AU\$|US\$|C\$|A\$|USD|EUR|GBP|JPY|CAD|AUD|INR)(?=[\s\d.,)]|$)|([€£¥￥₹$])/i
  );
  const symbol = tokenMatch?.[1] ?? tokenMatch?.[2] ?? null;
  return resolveCurrencyToken(symbol, fallbackCurrency);
}

function parseNumericPriceString(numStr: string, currency: string | null): number | null {
  const cleaned = numStr.replace(/\s+/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastPeriod = cleaned.lastIndexOf('.');

  let normalized = cleaned;

  if (lastComma > -1 && lastPeriod > -1) {
    if (lastComma > lastPeriod) {
      // European format: 1.299,99 → 1299.99
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US/UK/IN format: 1,299.99 or 1,49,999.00 → 1299.99 / 149999.00
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // Only commas present: e.g. "39,99" (EUR decimal) vs "3,980" (USD/JPY thousands) or "1,49,999"
    const parts = cleaned.split(',');
    const afterLastComma = parts[parts.length - 1] ?? '';
    if (parts.length === 2 && afterLastComma.length === 2 && currency !== 'JPY') {
      // Decimal comma: "39,99" → "39.99"
      normalized = `${parts[0]}.${afterLastComma}`;
    } else if (parts.length === 2 && afterLastComma.length === 1 && currency === 'EUR') {
      normalized = `${parts[0]}.${afterLastComma}`;
    } else {
      // Thousands separator: "3,980" or "1,299,000"
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastPeriod > -1) {
    // Only periods present: e.g. "49.99" vs "1.299" (EUR thousands without decimals)
    const parts = cleaned.split('.');
    const afterLastPeriod = parts[parts.length - 1] ?? '';
    if (
      (parts.length > 2) ||
      (parts.length === 2 && afterLastPeriod.length === 3 && currency === 'EUR')
    ) {
      normalized = cleaned.replace(/\./g, '');
    }
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

export function parsePrice(
  text: string | null | undefined,
  fallbackCurrency?: string | null
): ParsedPrice {
  if (!text) return { value: null, currency: null };

  const trimmed = text.replace(/\u00A0/g, ' ').trim();

  if (
    !trimmed ||
    /see price/i.test(trimmed) ||
    /check.*price/i.test(trimmed) ||
    /currently unavailable/i.test(trimmed)
  ) {
    return { value: null, currency: null };
  }

  // If a price range is present (e.g. "$19.99 - $29.99"), parse the primary (first) segment
  const primarySegment = trimmed.split(/\s+[-–—]\s+/)[0] ?? trimmed;
  const currency = extractCurrencyFromText(primarySegment, fallbackCurrency) ??
    extractCurrencyFromText(trimmed, fallbackCurrency);

  const numberMatch = primarySegment.match(/(\d[\d,.\s]*\d|\d)/);
  if (!numberMatch) return { value: null, currency: null };

  const value = parseNumericPriceString(numberMatch[1]!, currency);
  if (value === null) {
    return { value: null, currency: null };
  }

  return {
    value,
    // Defence in depth (C-1): a non-ISO fallback (e.g. a page URL) can never
    // escape as a currency.
    currency: currency ?? (isIsoCurrency(fallbackCurrency) ? fallbackCurrency : null),
  };
}

export function parsePriceFromElements(
  wholeEl: Element | null,
  fractionEl: Element | null,
  symbolEl: Element | null,
  fallbackCurrency?: string | null
): ParsedPrice {
  if (!wholeEl?.textContent) return { value: null, currency: null };

  const wholeDigits = wholeEl.textContent.replace(/[^\d]/g, '');
  if (!wholeDigits) return { value: null, currency: null };

  const fractionDigits = fractionEl?.textContent?.replace(/[^\d]/g, '') ?? '';
  const currency = resolveCurrencyToken(symbolEl?.textContent, fallbackCurrency ?? 'USD');

  const rawNumber =
    fractionDigits.length > 0 && currency !== 'JPY'
      ? `${wholeDigits}.${fractionDigits}`
      : wholeDigits;

  const value = Number.parseFloat(rawNumber);
  if (!Number.isFinite(value) || value < 0) {
    return { value: null, currency: null };
  }

  return {
    value: Math.round(value * 100) / 100,
    currency,
  };
}
