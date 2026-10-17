/**
 * Step 1.1 (SAD-158) — C-1: currency inference and the EUR/JPY separator coupling.
 * These are the tests that fail without the fix: a page URL must never escape
 * as a `currency`, and EUR/JPY locale separators must parse once the fallback
 * is a real ISO code.
 */
import { describe, expect, it } from 'vitest';
import {
  parsePrice,
  parsePriceFromElements,
} from '@/lib/utils/price-parser';
import { isIsoCurrency, resolvePageCurrency } from '@/lib/utils/currency';

function el(text: string | null): Element | null {
  if (text === null) return null;
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

describe('resolvePageCurrency / isIsoCurrency', () => {
  it('resolves the documented ISO code for all 10 supported storefronts', () => {
    expect(resolvePageCurrency('https://www.amazon.com/s?k=x')).toBe('USD');
    expect(resolvePageCurrency('https://www.amazon.de/s?k=x')).toBe('EUR');
    expect(resolvePageCurrency('https://www.amazon.co.uk/s?k=x')).toBe('GBP');
    expect(resolvePageCurrency('https://www.amazon.fr/s?k=x')).toBe('EUR');
    expect(resolvePageCurrency('https://www.amazon.it/s?k=x')).toBe('EUR');
    expect(resolvePageCurrency('https://www.amazon.es/s?k=x')).toBe('EUR');
    expect(resolvePageCurrency('https://www.amazon.ca/s?k=x')).toBe('CAD');
    expect(resolvePageCurrency('https://www.amazon.com.au/s?k=x')).toBe('AUD');
    expect(resolvePageCurrency('https://www.amazon.co.jp/s?k=x')).toBe('JPY');
    expect(resolvePageCurrency('https://www.amazon.in/s?k=x')).toBe('INR');
  });

  it('returns null — never a guess — for unrecognised hosts and empty input', () => {
    expect(resolvePageCurrency('https://example.com/product')).toBeNull();
    expect(resolvePageCurrency(null)).toBeNull();
    expect(resolvePageCurrency(undefined)).toBeNull();
    expect(resolvePageCurrency('not a url')).toBeNull();
  });

  it('accepts only bare three-letter uppercase codes', () => {
    expect(isIsoCurrency('EUR')).toBe(true);
    expect(isIsoCurrency('usd')).toBe(false);
    expect(isIsoCurrency('EURO')).toBe(false);
    expect(isIsoCurrency('https://www.amazon.de/s?k=x')).toBe(false);
    expect(isIsoCurrency(null)).toBe(false);
    expect(isIsoCurrency(42)).toBe(false);
  });
});

describe('parsePrice — symbol-less prices resolve via the page currency (C-1)', () => {
  it('parses a German decimal-comma price with the page-derived fallback', () => {
    expect(
      parsePrice('49,99', resolvePageCurrency('https://www.amazon.de/s?k=x'))
    ).toEqual({ value: 49.99, currency: 'EUR' });
  });

  it('parses EUR thousands separators correctly (the 1000× defect)', () => {
    expect(parsePrice('1.299', 'EUR')).toEqual({ value: 1299, currency: 'EUR' });
    expect(parsePrice('1.299,99', 'EUR')).toEqual({
      value: 1299.99,
      currency: 'EUR',
    });
  });

  it('parses JPY thousands separators without inventing decimals', () => {
    expect(parsePrice('3,980', 'JPY')).toEqual({ value: 3980, currency: 'JPY' });
  });

  it('parses JPY split elements with the fullwidth yen symbol', () => {
    expect(
      parsePriceFromElements(el('3,980'), null, el('￥'), 'JPY')
    ).toEqual({ value: 3980, currency: 'JPY' });
  });

  it('parses a symbol-less JP price with the page-derived fallback', () => {
    expect(
      parsePrice('3,980', resolvePageCurrency('https://www.amazon.co.jp/s?k=x'))
    ).toEqual({ value: 3980, currency: 'JPY' });
  });
});

describe('parsePrice — guard: a non-ISO fallback can never escape as a currency', () => {
  it('returns null instead of the URL when a URL is passed as fallback', () => {
    const parsed = parsePrice('49.99', 'https://www.amazon.de/s?k=x');
    expect(parsed.value).toBe(49.99);
    expect(parsed.currency).toBeNull();
  });

  it('returns null for a lowercase (non-ISO) fallback', () => {
    expect(parsePrice('49.99', 'usd').currency).toBeNull();
  });

  it('still prefers an explicit symbol over any fallback', () => {
    expect(parsePrice('€49,99', 'USD')).toEqual({ value: 49.99, currency: 'EUR' });
    expect(parsePrice('$19.99', 'EUR')).toEqual({ value: 19.99, currency: 'USD' });
  });

  it('keeps the regional-dollar behaviour for generic $ on CA/AU pages', () => {
    expect(parsePrice('$19.99', 'CAD')).toEqual({ value: 19.99, currency: 'CAD' });
    expect(parsePrice('$19.99', 'AUD')).toEqual({ value: 19.99, currency: 'AUD' });
  });

  it('parsePriceFromElements: URL fallback yields the USD safety net only for nullish input, never the URL', () => {
    // nullish fallback keeps the historical USD default of parsePriceFromElements
    expect(
      parsePriceFromElements(el('39'), el('99'), el('$'), undefined)
    ).toEqual({ value: 39.99, currency: 'USD' });
    // a URL fallback can never become the currency
    const parsed = parsePriceFromElements(
      el('39'),
      el('99'),
      el('\u00A0'), // non-matching symbol content
      'https://www.amazon.de/s?k=x'
    );
    expect(parsed.currency).not.toBe('https://www.amazon.de/s?k=x');
    expect(parsed.currency === null || isIsoCurrency(parsed.currency)).toBe(true);
  });
});
