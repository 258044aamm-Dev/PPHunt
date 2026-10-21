/**
 * SAD-387 — the Deal field must hold the page's own text, never Amazon's
 * countdown i18n template.
 *
 * Step 1 of this file pins the rule itself (`utils/deal-text.ts`). Later steps
 * add the parser wiring and the read-time cleaning.
 *
 * Evidence note: the `NO_OF_*` shape is the one reported in the ticket, fed
 * through the real parsers verbatim. It was **not** reproduced on six live Amazon
 * pages captured while writing this fix (search, /deals, goldbox, a PDP,
 * amazon.nl, amazon.de — all HTTP 200, zero occurrences), so the cases below test
 * the *token pattern* rather than one page shape.
 */
import { describe, expect, it } from 'vitest';
import {
  dealBadgeForDisplay,
  sanitizeDealBadge,
} from '@/engines/amazon/utils/deal-text';

/** Verbatim from SAD-387: 217 characters, 5 labels, 6 tokens. */
const TICKET_TEXT =
  'Limited time deal NO_OF_HOURS hours NO_OF_MINUTES minutes Limited time deal ' +
  'NO_OF_MINUTES minutes Limited time deal NO_OF_MINUTES minutes NO_OF_SECONDS ' +
  'seconds Limited time deal NO_OF_SECONDS seconds Limited time deal';

/** Real badge text captured live from amazon.com (see the .real.html fixtures). */
const LIVE_LIMITED = 'Limited time deal';
const LIVE_ENDS_IN = 'Ends in 15:00:26';

describe('SAD-387: countdown templates never reach the Deal field', () => {
  it('folds the ticket blob down to the label the page printed', () => {
    expect(TICKET_TEXT.length).toBe(217);
    expect(sanitizeDealBadge(TICKET_TEXT)).toBe('Limited time deal');
  });

  it('drops a clock-style template without leaving dangling separators', () => {
    expect(
      sanitizeDealBadge('Ends in NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS'),
    ).toBe('Ends in');
  });

  it('drops a template that trails a label', () => {
    expect(sanitizeDealBadge('Limited time deal NO_OF_MINUTES minutes')).toBe(
      'Limited time deal',
    );
  });

  it('invents nothing when the text is only a template', () => {
    expect(sanitizeDealBadge('NO_OF_HOURS hours NO_OF_MINUTES minutes')).toBe(
      undefined,
    );
    expect(sanitizeDealBadge('   ')).toBe(undefined);
    expect(sanitizeDealBadge(null)).toBe(undefined);
  });

  it('keeps numbers the page really printed (D1b)', () => {
    expect(sanitizeDealBadge(LIVE_ENDS_IN)).toBe('Ends in 15:00:26');
    expect(sanitizeDealBadge('Limited time deal 2 hours 15 minutes')).toBe(
      'Limited time deal 2 hours 15 minutes',
    );
    // Repeats that came from the template collapse to the one copy the page
    // actually renders for a human.
    expect(
      sanitizeDealBadge(
        'Limited time deal NO_OF_MINUTES minutes Limited time deal NO_OF_MINUTES minutes',
      ),
    ).toBe('Limited time deal');
  });

  it('leaves template-free repetition alone — the page really said it twice', () => {
    // Deliberate boundary: the rule only intervenes when a template is present.
    // Every non-template value keeps today's bytes (this is what protects the
    // existing deal assertions and rows already in the database).
    const twice =
      'Limited time deal 2 hours 15 minutes Limited time deal 2 hours 15 minutes';
    expect(sanitizeDealBadge(twice)).toBe(twice);
  });

  it('keeps genuinely different variants verbatim (D1c)', () => {
    const mixed =
      'Limited time deal 2 hours 15 minutes Limited time deal 15 minutes 30 seconds';
    expect(sanitizeDealBadge(mixed)).toBe(mixed);
  });

  it('leaves every ordinary badge byte-identical', () => {
    for (const value of [
      LIVE_LIMITED,
      'Limited-time deal',
      'Prime Big Deal',
      "Amazon's Choice",
      'Save 15% with coupon',
      'Deal Dash Board Game Deluxe Edition',
      'Lightning deal',
    ]) {
      expect(sanitizeDealBadge(value)).toBe(value);
    }
  });

  it('is idempotent, so the read-time path cannot change a clean value', () => {
    for (const value of [TICKET_TEXT, LIVE_ENDS_IN, LIVE_LIMITED, 'Prime Big Deal']) {
      const once = sanitizeDealBadge(value);
      expect(sanitizeDealBadge(once)).toBe(once);
    }
  });

  it('exposes the same rule for stored rows (D2)', () => {
    expect(dealBadgeForDisplay(TICKET_TEXT)).toBe('Limited time deal');
    expect(dealBadgeForDisplay(LIVE_LIMITED)).toBe('Limited time deal');
    expect(dealBadgeForDisplay(null)).toBe(null);
    expect(dealBadgeForDisplay(undefined)).toBe(null);
  });
});
