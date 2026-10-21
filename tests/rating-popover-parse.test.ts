/**
 * SAD-383 step 3 — parsing the review popover.
 *
 * Inputs are the two payloads captured verbatim from Amazon on 2026-10-21
 * (`docs/plans/SAD-383-fixtures/`): a real product with 4.6 / 142,457 ratings, and
 * the response for an ASIN that does not exist (0.0 / 0 global ratings — the
 * reason the caller needs a guard).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRatingPopoverHtml } from '@/engines/amazon/offscreen/parse';
import { isUsableRatingPayload } from '@/engines/amazon/background/rating-fetch';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'docs', 'plans', 'SAD-383-fixtures', name), 'utf8');

describe('SAD-383 popover parse', () => {
  it('reads the same pair the product page prints', () => {
    const result = parseRatingPopoverHtml(fixture('rating-popover.real.html'));
    expect(result).toEqual({ ok: true, rating: 4.6, reviewCount: 142457 });
    // …and the guard agrees this is usable.
    expect(
      isUsableRatingPayload({ rating: 4.6, reviewCount: 142457 }),
    ).toBe(true);
  });

  it('parses a non-existent ASIN, and the guard rejects it', () => {
    const result = parseRatingPopoverHtml(fixture('rating-popover.empty.real.html'));
    expect(result).toEqual({ ok: true, rating: 0, reviewCount: 0 });
    expect(isUsableRatingPayload({ rating: 0, reviewCount: 0 })).toBe(false);
  });

  it('falls back to the star icon’s aria-label when the text node is gone', () => {
    const html =
      '<div data-hook="average-stars-rating-anywhere" aria-label="4.2 out of 5 stars"></div>' +
      '<span data-hook="total-review-count">88 global ratings</span>';
    expect(parseRatingPopoverHtml(html)).toEqual({
      ok: true,
      rating: 4.2,
      reviewCount: 88,
    });
  });

  it('handles a localized (German) popover through the shared parsers', () => {
    const html =
      '<h2 data-hook="acr-average-stars-rating-text"><span aria-hidden="true">4,7 von 5 Sternen</span></h2>' +
      '<span data-hook="total-review-count">142.457 Sternebewertungen</span>';
    expect(parseRatingPopoverHtml(html)).toEqual({
      ok: true,
      rating: 4.7,
      reviewCount: 142457,
    });
  });

  it('returns nulls — not zeros — when the markup is absent', () => {
    expect(parseRatingPopoverHtml('<html><body>nothing here</body></html>')).toEqual({
      ok: true,
      rating: null,
      reviewCount: null,
    });
  });

  it('refuses an oversized body instead of parsing it', () => {
    const result = parseRatingPopoverHtml('x'.repeat(5_000_001));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HTML_TOO_LARGE');
  });

  it('refuses an empty body', () => {
    const result = parseRatingPopoverHtml('');
    expect(result.ok).toBe(false);
  });
});
