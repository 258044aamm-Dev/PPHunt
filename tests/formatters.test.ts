/**
 * L-2 (SAD-195): locale-aware currency formatting.
 *
 * The exact case from the finding: a EUR price scraped from amazon.de must
 * render with European grouping/decimal separators, and JPY must not gain
 * fake minor units. Expected strings below were verified against this
 * project's Node/ICU build — including the NBSP before €.
 */
import { describe, expect, it } from 'vitest';
import { formatCurrency, localeForCurrency } from '@/lib/utils/formatters';

describe('formatCurrency (SAD-195 / L-2)', () => {
  it('renders the exact case from the finding: EUR 1299 -> 1.299,00 EUR (de-DE)', () => {
    // \u00A0 = NBSP that de-DE places before the euro sign.
    expect(formatCurrency(1299, 'EUR')).toBe('1.299,00\u00A0€');
  });

  it('gives JPY no minor units', () => {
    const jpy = formatCurrency(1299, 'JPY');
    expect(jpy).not.toContain('.');
    expect(jpy).not.toContain(',00');
    expect(jpy).toBe('￥1,299');
  });

  it('formats each supported marketplace currency in its own locale', () => {
    expect(formatCurrency(1299, 'USD')).toBe('$1,299.00');
    expect(formatCurrency(1299, 'GBP')).toBe('£1,299.00');
    expect(formatCurrency(1299, 'INR')).toBe('₹1,299.00');
    expect(formatCurrency(1299, 'CAD')).toBe('$1,299.00');
    expect(formatCurrency(1299, 'AUD')).toBe('$1,299.00');
  });

  it('keeps INR lakh-style digit grouping (locale follows currency)', () => {
    expect(formatCurrency(129900, 'INR')).toBe('₹1,29,900.00');
  });

  it('does not throw for a valid but unmapped code (XXX)', () => {
    expect(() => formatCurrency(1299, 'XXX')).not.toThrow();
    expect(formatCurrency(1299, 'XXX')).toBe('¤1,299.00');
  });

  it('does not throw for an invalid code and falls back to CODE value', () => {
    expect(() => formatCurrency(1299, 'ZZ1')).not.toThrow();
    expect(formatCurrency(1299, 'ZZ1')).toBe('ZZ1 1299.00');
  });

  it('defaults to USD when currency is null/undefined (existing behaviour)', () => {
    expect(formatCurrency(19.99)).toBe('$19.99');
    expect(formatCurrency(19.99, null)).toBe('$19.99');
    expect(formatCurrency(19.99, undefined)).toBe('$19.99');
  });

  it('accepts lowercase codes (defensive: scraped data varies)', () => {
    expect(formatCurrency(49.99, 'eur')).toBe('49,99\u00A0€');
  });

  it('leaves USD table rendering byte-identical to the pre-L-2 output', () => {
    // Regression guard for existing table tests ($31.99 / $99.99 fixtures).
    expect(formatCurrency(31.99, 'USD')).toBe('$31.99');
    expect(formatCurrency(99.99, 'USD')).toBe('$99.99');
  });
});

describe('localeForCurrency (SAD-195 / L-2)', () => {
  it('maps the HOST_CURRENCY_MAP marketplaces to deterministic locales', () => {
    expect(localeForCurrency('USD')).toBe('en-US');
    expect(localeForCurrency('GBP')).toBe('en-GB');
    expect(localeForCurrency('EUR')).toBe('de-DE');
    expect(localeForCurrency('JPY')).toBe('ja-JP');
    expect(localeForCurrency('CAD')).toBe('en-CA');
    expect(localeForCurrency('AUD')).toBe('en-AU');
    expect(localeForCurrency('INR')).toBe('en-IN');
  });

  it('returns undefined for unmapped codes (formatter then uses runtime locale)', () => {
    expect(localeForCurrency('XXX')).toBeUndefined();
  });
});
