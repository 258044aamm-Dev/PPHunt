/**
 * SAD-383 step 4 — the backfill queue.
 *
 * What is proven here, in the ticket's own terms:
 * - a product is queued **once per run**, even when a later `updatedExisting`
 *   batch re-sends the whole run;
 * - only products the card could not describe are queued at all;
 * - a `skipped` outcome (breaker open) drains the queue instead of hammering
 *   Amazon, and nothing is written;
 * - a payload with no reviews behind it is discarded (non-existent ASIN);
 * - a throwing fetch/parse/write is never a collection error;
 * - `reset()` isolates one run from the next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enqueueRatingBackfill,
  needsRatingBackfill,
  ratingBackfillQueuedCount,
  resetRatingBackfill,
  resetRatingBackfillForTests,
  whenRatingBackfillIdle,
} from '@/engines/amazon/background/rating-backfill';
import type { RatingFetchOutcome } from '@/engines/amazon/background/rating-fetch';

const SESSION = 'session-a';

function product(asin: string, rating: number | null = null, reviewCount: number | null = null) {
  return { asin, url: `https://www.amazon.com/dp/${asin}`, rating, reviewCount };
}

const POPOVER = '<html>4.6 out of 5 / 142,457 global ratings</html>';

function fetchSpy(outcome: RatingFetchOutcome | (() => Promise<RatingFetchOutcome>) = {
  status: 'ok',
  html: POPOVER,
}) {
  return vi.fn(async () => (typeof outcome === 'function' ? outcome() : outcome));
}

function parseSpy(values: { rating: number | null; reviewCount: number | null } = {
  rating: 4.6,
  reviewCount: 142457,
}) {
  return vi.fn(async () => ({ ok: true as const, ...values }));
}

function writeSpy() {
  return vi.fn(async (_sessionKey: string, _asin: string, _values: unknown) => [
    'rating',
    'reviewCount',
  ]);
}

beforeEach(() => {
  resetRatingBackfillForTests();
});

describe('SAD-383: backfill queue', () => {
  it('needsRatingBackfill is the single definition of the trigger', () => {
    expect(needsRatingBackfill({ rating: null, reviewCount: null })).toBe(true);
    expect(needsRatingBackfill({ rating: 4.6, reviewCount: null })).toBe(true);
    expect(needsRatingBackfill({ rating: null, reviewCount: 10 })).toBe(true);
    expect(needsRatingBackfill({ rating: 4.6, reviewCount: 10 })).toBe(false);
    expect(needsRatingBackfill({})).toBe(true);
  });

  it('queues only the products missing a field, and writes what it fetched', async () => {
    const fetchRating = fetchSpy();
    const parseRating = parseSpy();
    const write = writeSpy();

    enqueueRatingBackfill(
      [product('B0QUEUE001'), product('B0QUEUE002', 4.1, 12)],
      SESSION,
      { fetchRating, parseRating, write },
    );
    await whenRatingBackfillIdle();

    expect(fetchRating).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toEqual([
      SESSION,
      'B0QUEUE001',
      { rating: 4.6, reviewCount: 142457 },
    ]);
  });

  it('never queues the same ASIN twice in a run, even across re-sent batches', async () => {
    const fetchRating = fetchSpy();
    const write = writeSpy();

    enqueueRatingBackfill([product('B0QUEUE001')], SESSION, {
      fetchRating,
      parseRating: parseSpy(),
      write,
    });
    await whenRatingBackfillIdle();

    // `updatedExisting` re-sends the whole run — the same ASIN arrives again.
    enqueueRatingBackfill([product('B0QUEUE001'), product('B0QUEUE003')], SESSION, {
      fetchRating,
      parseRating: parseSpy(),
      write,
    });
    await whenRatingBackfillIdle();

    expect(fetchRating).toHaveBeenCalledTimes(2); // 001 once, 003 once
    expect(ratingBackfillQueuedCount()).toBe(2);
  });

  it('runs one request at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchRating = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { status: 'ok' as const, html: POPOVER };
    });

    enqueueRatingBackfill(
      [product('B0QUEUE001'), product('B0QUEUE002'), product('B0QUEUE003')],
      SESSION,
      { fetchRating, parseRating: parseSpy(), write: writeSpy() },
    );
    await whenRatingBackfillIdle();

    expect(fetchRating).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it('drains the queue when the host is out of service', async () => {
    const fetchRating = fetchSpy({ status: 'skipped', reason: 'circuit-open' });
    const write = writeSpy();

    enqueueRatingBackfill(
      [product('B0QUEUE001'), product('B0QUEUE002'), product('B0QUEUE003')],
      SESSION,
      { fetchRating, parseRating: parseSpy(), write },
    );
    await whenRatingBackfillIdle();

    // One attempt proves the host is blocked; the rest are not tried.
    expect(fetchRating).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('discards a payload with no reviews behind it', async () => {
    // The measured response for an ASIN that does not exist.
    const write = writeSpy();

    enqueueRatingBackfill([product('B0QUEUE001')], SESSION, {
      fetchRating: fetchSpy(),
      parseRating: parseSpy({ rating: 0, reviewCount: 0 }),
      write,
    });
    await whenRatingBackfillIdle();

    expect(write).not.toHaveBeenCalled();
  });

  it('does nothing when the parse produced no values', async () => {
    const write = writeSpy();
    enqueueRatingBackfill([product('B0QUEUE001')], SESSION, {
      fetchRating: fetchSpy(),
      parseRating: parseSpy({ rating: null, reviewCount: null }),
      write,
    });
    await whenRatingBackfillIdle();
    expect(write).not.toHaveBeenCalled();
  });

  it('a failed fetch, a failed parse and a throwing write are all contained', async () => {
    const write = vi.fn(async () => {
      throw new Error('db closed');
    });

    enqueueRatingBackfill(
      [product('B0QUEUE001'), product('B0QUEUE002')],
      SESSION,
      {
        fetchRating: vi
          .fn()
          .mockResolvedValueOnce({ status: 'failed', reason: 'http' })
          .mockResolvedValueOnce({ status: 'ok', html: POPOVER }),
        parseRating: parseSpy(),
        write,
      },
    );

    await expect(whenRatingBackfillIdle()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1); // only the one whose fetch succeeded
  });

  it('a parse error for one product does not stop the next', async () => {
    const write = writeSpy();
    const parseRating = vi
      .fn()
      .mockRejectedValueOnce(new Error('offscreen went away'))
      .mockResolvedValueOnce({ ok: true, rating: 4.2, reviewCount: 55 });

    enqueueRatingBackfill(
      [product('B0QUEUE001'), product('B0QUEUE002')],
      SESSION,
      { fetchRating: fetchSpy(), parseRating, write },
    );
    await whenRatingBackfillIdle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[1]).toBe('B0QUEUE002');
  });

  it('skips products with no ASIN or no URL instead of guessing', async () => {
    const fetchRating = fetchSpy();
    enqueueRatingBackfill(
      [
        { asin: null, url: 'https://www.amazon.com/dp/B0QUEUE001', rating: null },
        { asin: 'B0QUEUE002', url: null, rating: null },
      ],
      SESSION,
      { fetchRating, parseRating: parseSpy(), write: writeSpy() },
    );
    await whenRatingBackfillIdle();
    expect(fetchRating).not.toHaveBeenCalled();
  });

  it('reset() lets the same ASIN be queued by the next run', async () => {
    const fetchRating = fetchSpy();
    enqueueRatingBackfill([product('B0QUEUE001')], SESSION, {
      fetchRating,
      parseRating: parseSpy(),
      write: writeSpy(),
    });
    await whenRatingBackfillIdle();

    resetRatingBackfill(SESSION);
    enqueueRatingBackfill([product('B0QUEUE001')], SESSION, {
      fetchRating,
      parseRating: parseSpy(),
      write: writeSpy(),
    });
    await whenRatingBackfillIdle();

    expect(fetchRating).toHaveBeenCalledTimes(2);
  });
});
