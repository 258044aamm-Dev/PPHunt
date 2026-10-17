import {
  extractCurrencyFromSymbol,
  isIsoCurrency,
  resolvePageCurrency,
} from './currency';

export interface ParsedPriceResult {
  value: number | null;
  currency: string | null;
}

export interface ParsedAmazonPrice {
  price: number | null;
  currency: string;
}

/**
 * Parses a localized numeric price amount from raw text, taking into account
 * currency-specific thousands/decimal conventions (e.g. EUR `1.299` = 1299, JPY `3,980` = 3980).
 */
export function parsePriceAmount(
  raw: string | null | undefined,
  currencyHint?: string | null,
): number | null {
  if (!raw || typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .trim();
  if (!cleaned) return null;

  const tokenMatch = cleaned.match(
    /(?:^|[^\d/])(\d{1,3}(?:[.,'\s]\d{2,3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\s*%)/,
  );
  if (!tokenMatch?.[1]) {
    return null;
  }

  let numericToken = tokenMatch[1].trim().replace(/['\s]/g, '');
  if (!numericToken) return null;

  const lastDot = numericToken.lastIndexOf('.');
  const lastComma = numericToken.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) {
      // European format: "1.299,99" -> "1299.99"
      numericToken = numericToken.replace(/\./g, '').replace(',', '.');
    } else {
      // US/UK/IN format: "1,299.99" or "1,49,999.00" -> "1299.99" / "149999.00"
      numericToken = numericToken.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const commaCount = (numericToken.match(/,/g) ?? []).length;
    const digitsAfterComma = numericToken.length - lastComma - 1;

    if (currencyHint === 'JPY') {
      numericToken = numericToken.replace(/,/g, '');
    } else if (
      commaCount === 1 &&
      (digitsAfterComma === 1 || digitsAfterComma === 2)
    ) {
      // Decimal comma: "49,99"
      numericToken = numericToken.replace(',', '.');
    } else if (commaCount > 1 && digitsAfterComma === 2) {
      numericToken =
        numericToken.slice(0, lastComma).replace(/,/g, '') +
        '.' +
        numericToken.slice(lastComma + 1);
    } else {
      // Thousands comma: "3,980"
      numericToken = numericToken.replace(/,/g, '');
    }
  } else if (lastDot !== -1) {
    const dotCount = (numericToken.match(/\./g) ?? []).length;
    const digitsAfterDot = numericToken.length - lastDot - 1;

    if (dotCount > 1) {
      numericToken = numericToken.replace(/\./g, '');
    } else if (
      digitsAfterDot === 3 &&
      (currencyHint === 'EUR' ||
        currencyHint === 'PLN' ||
        currencyHint === 'SEK' ||
        currencyHint === 'TRY' ||
        cleaned.includes('€'))
    ) {
      // European thousands dot without decimals: "1.299" -> 1299
      numericToken = numericToken.replace(/\./g, '');
    }
  }

  const parsed = Number.parseFloat(numericToken);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

/**
 * Parses a price string into `{ value, currency }`.
 * - Rejects non-ISO fallback strings (such as URLs or lowercase codes) so they never escape as `currency`.
 * - Disambiguates `$` and `¥` using a valid ISO fallback when provided.
 */
export function parsePrice(
  raw: string | null | undefined,
  fallbackCurrency?: string | null,
): ParsedPriceResult {
  const validFallback = isIsoCurrency(fallbackCurrency)
    ? fallbackCurrency
    : null;
  const symbolCurrency = extractCurrencyFromSymbol(raw, validFallback);
  const resolvedCurrency = symbolCurrency ?? validFallback;
  const value = parsePriceAmount(raw, resolvedCurrency);

  if (value === null) {
    return { value: null, currency: null };
  }

  return {
    value,
    currency: resolvedCurrency,
  };
}

/**
 * Infers the ISO 4217 currency code from an Amazon marketplace URL, defaulting to `'USD'`.
 */
export function inferCurrencyFromUrl(url: string | null | undefined): string {
  return resolvePageCurrency(url) ?? 'USD';
}

/**
 * Parses split Amazon price elements (`.a-price-whole`, `.a-price-fraction`, `.a-price-symbol`).
 */
export function parsePriceFromElements(
  wholeEl: Element | null | undefined,
  fractionEl: Element | null | undefined,
  symbolEl?: Element | null | undefined,
  fallbackCurrencyOrUrl?: string | null,
): ParsedPriceResult {
  if (!wholeEl?.textContent) {
    return { value: null, currency: null };
  }

  const validFallback = isIsoCurrency(fallbackCurrencyOrUrl)
    ? fallbackCurrencyOrUrl
    : resolvePageCurrency(fallbackCurrencyOrUrl) ??
      (fallbackCurrencyOrUrl == null ? 'USD' : null);

  const symbolText = symbolEl?.textContent ?? '';
  const symbolCurrency = extractCurrencyFromSymbol(symbolText, validFallback);
  const currency = symbolCurrency ?? validFallback;

  const rawWhole = wholeEl.textContent
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F]/g, '')
    .trim();
  const wholeDigits = rawWhole.replace(/[^\d]/g, '');
  if (!wholeDigits) {
    return { value: null, currency: null };
  }

  const rawFraction =
    fractionEl?.textContent?.replace(/[^\d]/g, '').slice(0, 2) ?? '';

  if (currency === 'JPY' || !rawFraction) {
    const intVal = Number.parseInt(wholeDigits, 10);
    if (!Number.isFinite(intVal) || intVal < 0) {
      return { value: null, currency: null };
    }
    return { value: intVal, currency };
  }

  const combined = Number.parseFloat(`${wholeDigits}.${rawFraction}`);
  if (!Number.isFinite(combined) || combined < 0) {
    return { value: null, currency: null };
  }

  return {
    value: Math.round(combined * 100) / 100,
    currency,
  };
}

/**
 * Convenience wrapper returning `{ price, currency }` with a non-null currency default.
 */
export function parsePriceText(
  raw: string | null | undefined,
  pageUrl?: string | null,
): ParsedAmazonPrice {
  const pageCurrency = isIsoCurrency(pageUrl)
    ? pageUrl
    : resolvePageCurrency(pageUrl);
  const { value, currency } = parsePrice(raw, pageCurrency);
  return {
    price: value,
    currency: currency ?? pageCurrency ?? 'USD',
  };
}
