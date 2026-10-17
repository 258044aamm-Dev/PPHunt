import { isIsoCurrency } from './currency';

const CURRENCY_LOCALE_MAP: Readonly<Record<string, string>> = {
  USD: 'en-US',
  GBP: 'en-GB',
  EUR: 'de-DE',
  JPY: 'ja-JP',
  CAD: 'en-CA',
  AUD: 'en-AU',
  INR: 'en-IN',
  MXN: 'es-MX',
  BRL: 'pt-BR',
  PLN: 'pl-PL',
  SEK: 'sv-SE',
  SGD: 'en-SG',
  AED: 'ar-AE',
  SAR: 'ar-SA',
  TRY: 'tr-TR',
};

/**
 * Maps an ISO 4217 currency code to its primary marketplace locale.
 * Returns `undefined` for unmapped codes so `Intl.NumberFormat` uses the runtime default locale.
 */
export function localeForCurrency(
  currency: string | null | undefined,
): string | undefined {
  if (!currency || typeof currency !== 'string') return undefined;
  const code = currency.trim().toUpperCase();
  return CURRENCY_LOCALE_MAP[code];
}

/**
 * Formats a numeric price in its marketplace-appropriate locale and currency symbol.
 * Defaults to USD (`en-US`) when `currency` is null/undefined, and degrades gracefully
 * to `CODE 0.00` if an invalid currency string is supplied.
 */
export function formatCurrency(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  const normalizedCode =
    currency && typeof currency === 'string' && currency.trim()
      ? currency.trim().toUpperCase()
      : 'USD';

  if (!isIsoCurrency(normalizedCode)) {
    return `${normalizedCode} ${value.toFixed(2)}`;
  }

  const locale = localeForCurrency(normalizedCode) ?? 'en-US';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizedCode,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    return `${normalizedCode} ${value.toFixed(2)}`;
  }
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatRating(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(1);
}
