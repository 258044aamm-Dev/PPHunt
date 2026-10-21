/**
 * SAD-386 step 1 — the discount normaliser.
 *
 * Every row below was measured against the shipped function before the change
 * (plan §5 F2, probe P01), so this file is the before/after contract:
 *
 *  - rows marked "unchanged" produced the same value before and after,
 *  - rows marked "fixed" produced `undefined` before and a value now,
 *  - rows marked "rejected" are deliberate rules that must not loosen.
 */
import { describe, expect, it } from 'vitest';
import { normalizeDiscountBadge } from '@/engines/amazon/scraper/field-parsers';

describe('SAD-386: discount normalisation', () => {
  it('keeps every form that already worked (byte-identical output)', () => {
    const unchanged: Array<[string, string]> = [
      ['-68%', '68% off'],
      ['( -68% )', '68% off'],
      ['-68 %', '68% off'],
      ['68% off', '68% off'],
      ['68 % off', '68% off'],
      ['-7%', '7% off'],
      ['19% off', '19% off'],
      ['-23%', '23% off'],
    ];
    for (const [input, expected] of unchanged) {
      expect(normalizeDiscountBadge(input), input).toBe(expected);
    }
  });

  it('reads the typographic minus that some layouts and locales print', () => {
    // U+2212 MINUS SIGN, U+2013 EN DASH, U+2014 EM DASH
    expect(normalizeDiscountBadge('\u221268%')).toBe('68% off');
    expect(normalizeDiscountBadge('(\u221268%)')).toBe('68% off');
    expect(normalizeDiscountBadge('(\u201368%)')).toBe('68% off');
    expect(normalizeDiscountBadge('\u201435%')).toBe('35% off');
    expect(normalizeDiscountBadge('\u221213%')).toBe('13% off');
  });

  it('reads the "Save NN%" form', () => {
    expect(normalizeDiscountBadge('Save 68%')).toBe('68% off');
    expect(normalizeDiscountBadge('save 40 %')).toBe('40% off');
  });

  it('reads a bare percentage only when the caller proved it is a savings node', () => {
    expect(normalizeDiscountBadge('68%')).toBeUndefined();
    expect(normalizeDiscountBadge('68%', { allowBare: true })).toBe('68% off');
    expect(normalizeDiscountBadge('(68%)', { allowBare: true })).toBe('68% off');
  });

  it('never reads a coupon as a product discount (regression: probe P02/G)', () => {
    // Before this change `Save 15% off with coupon` normalised to "15% off".
    expect(normalizeDiscountBadge('Save 15% off with coupon')).toBeUndefined();
    expect(normalizeDiscountBadge('Save 15% with coupon', { allowBare: true })).toBeUndefined();
    expect(normalizeDiscountBadge('15% off with coupon')).toBeUndefined();
    expect(normalizeDiscountBadge('Save $20.00 with coupon')).toBeUndefined();
    expect(normalizeDiscountBadge('Coupon: 10%')).toBeUndefined();
    expect(normalizeDiscountBadge('Jetzt 35% g\u00fcnstiger')).toBeUndefined();
  });

  it('rejects out-of-range, fractional and non-percentage text', () => {
    const rejected = [
      '-100%',
      '-0%',
      '-35.5%',
      '50%-off',
      'Deal Price: $199.99',
      '4.5 out of 5 stars',
      '',
      null,
      undefined,
    ];
    for (const input of rejected) {
      expect(normalizeDiscountBadge(input as string | null | undefined), String(input)).toBeUndefined();
    }
  });
});
