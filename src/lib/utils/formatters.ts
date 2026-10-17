/**
 * Formatting utilities for display values.
 */

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/**
 * L-2 (SAD-195), decision (c) recommended option: the locale follows the
 * currency. Deterministic, matches what the shopper saw on the storefront the
 * price was scraped from, and independent of the operator's machine (the same
 * export looks identical everywhere). Covers exactly the marketplaces in
 * HOST_CURRENCY_MAP (src/lib/utils/price-parser.ts).
 */
const LOCALE_FOR_CURRENCY: Readonly<Record<string, string>> = {
  USD: 'en-US',
  GBP: 'en-GB',
  EUR: 'de-DE',
  JPY: 'ja-JP',
  CAD: 'en-CA',
  AUD: 'en-AU',
  INR: 'en-IN',
};

/** Locale to format a currency code with, or undefined for unmapped codes. */
export function localeForCurrency(currency: string): string | undefined {
  return LOCALE_FOR_CURRENCY[currency.toUpperCase()];
}

export function formatCurrency(value: number, currency?: string | null): string {
  const code = (currency ?? 'USD').toUpperCase();
  try {
    // No forced fraction digits: Intl derives the minor unit per currency
    // (JPY -> none, most others -> 2), so JPY 1299 renders as ￥1,299.
    return new Intl.NumberFormat(localeForCurrency(code), {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    // Invalid/unknown code: never throw, keep the value readable.
    return `${code} ${value.toFixed(2)}`;
  }
}

