/**
 * SAD-383 step 3 — the fill-only write.
 *
 * The rule under test is the one that keeps this ticket from touching anything
 * else: a value the listing card printed is the value the user saw, and a
 * background request may only fill a hole, never replace a number.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/engines/amazon/db/database';
import { addProducts, backfillProductRating } from '@/engines/amazon/db/products';
import type { ScrapedProduct } from '@/engines/amazon/types';

const SESSION = 'session_sad383';

function scraped(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B0BACK0001',
    url: 'https://www.amazon.com/dp/B0BACK0001',
    title: 'A Collected Product',
    price: 19.99,
    currency: 'USD',
    rating: null,
    reviewCount: null,
    imageUrl: 'https://m.media-amazon.com/images/I/71aaaaaaaL._AC_UL320_.jpg',
    isSponsored: false,
    isPrime: false,
    brand: null,
    availability: null,
    seller: null,
    description: null,
    features: [],
    source: 'category',
    ...overrides,
  };
}

async function rowFor(sessionKey: string, asin: string) {
  return db.products.where('[sessionKey+asin]').equals([sessionKey, asin]).first();
}

beforeEach(async () => {
  await db.products.clear();
});

describe('SAD-383 backfillProductRating', () => {
  it('fills both fields when the card printed neither', async () => {
    await addProducts([scraped()], SESSION);

    const changed = await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.6,
      reviewCount: 142457,
    });

    expect(changed).toEqual(['rating', 'reviewCount']);
    const row = await rowFor(SESSION, 'B0BACK0001');
    expect(row?.rating).toBe(4.6);
    expect(row?.reviewCount).toBe(142457);
  });

  it('never replaces a value the card already printed', async () => {
    await addProducts([scraped({ rating: 4.1, reviewCount: 12 })], SESSION);

    const changed = await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.9,
      reviewCount: 999999,
    });

    expect(changed).toEqual([]);
    const row = await rowFor(SESSION, 'B0BACK0001');
    expect(row?.rating).toBe(4.1);
    expect(row?.reviewCount).toBe(12);
  });

  it('fills only the missing half of a pair', async () => {
    await addProducts([scraped({ rating: 4.1, reviewCount: null })], SESSION);

    const changed = await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.9,
      reviewCount: 512,
    });

    expect(changed).toEqual(['reviewCount']);
    const row = await rowFor(SESSION, 'B0BACK0001');
    expect(row?.rating).toBe(4.1); // card value kept
    expect(row?.reviewCount).toBe(512);
  });

  it('ignores nulls in the payload', async () => {
    await addProducts([scraped()], SESSION);
    const changed = await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: null,
      reviewCount: null,
    });
    expect(changed).toEqual([]);
  });

  it('is scoped to the run: another session’s row for the same ASIN is untouched', async () => {
    await addProducts([scraped()], 'other_session');

    const changed = await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.6,
      reviewCount: 10,
    });

    expect(changed).toEqual([]);
    const other = await rowFor('other_session', 'B0BACK0001');
    expect(other?.rating).toBeNull();
  });

  it('reports nothing for a row that no longer exists (deleted mid-run)', async () => {
    await addProducts([scraped()], SESSION);
    await db.products.clear();

    const changed = await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.6,
      reviewCount: 10,
    });
    expect(changed).toEqual([]);
  });

  it('writes no snapshot — a backfill is not a listing observation', async () => {
    await addProducts([scraped()], SESSION);
    const before = await db.snapshots.count();
    await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.6,
      reviewCount: 10,
    });
    expect(await db.snapshots.count()).toBe(before);
  });

  it('leaves every other field alone', async () => {
    await addProducts([scraped({ brand: 'Anker', availability: 'In Stock' })], SESSION);
    const before = await rowFor(SESSION, 'B0BACK0001');

    await backfillProductRating(SESSION, 'B0BACK0001', {
      rating: 4.6,
      reviewCount: 10,
    });

    const after = await rowFor(SESSION, 'B0BACK0001');
    expect({ ...after, rating: before?.rating, reviewCount: before?.reviewCount }).toEqual(
      before,
    );
  });
});
