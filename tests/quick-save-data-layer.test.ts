/**
 * SAD-277 (P0.4) - the write path a one-click save uses.
 *
 * `addProducts()` stays fill-only for full-page runs; quick-save has its own
 * upsert so a fresh save refreshes volatile fields without ever writing a null
 * over a known value, and without touching the full-page rows around it.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db/database';
import {
  addProducts,
  getProductCountBySession,
} from '@/engines/amazon/db/products';
import { getHistoryEntries } from '@/engines/amazon/db/history';
import { getActiveSession } from '@/engines/amazon/db/sessions';
import {
  appendSnapshot,
  moveProductToCollection,
  QuickSaveValidationError,
  saveQuickProduct,
  snapshotFromProduct,
  upsertProductFromQuickSave,
} from '@/engines/amazon/db/quick-save';
import {
  allocateOneClickSessionKey,
  createOneClickCollection,
  deriveCollectionLabel,
  pickUniqueCollectionLabel,
  refreshCollectionCounts,
} from '@/engines/amazon/db/collections';
import type { ScrapedProduct } from '@/engines/amazon/types';

const COLLECTION = 'oc_1700000000000';

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.com/dp/B08N5WRWNW',
    title: 'Anker 65W Charger',
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 1200,
    source: 'search',
    ...overrides,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('upsertProductFromQuickSave', () => {
  it('creates the row on the first save', async () => {
    const result = await upsertProductFromQuickSave(product(), COLLECTION, {
      collectedAt: '2026-10-19T10:00:00.000Z',
    });

    expect(result.created).toBe(true);
    expect(result.currencyMismatch).toBe(false);

    const row = await db.products.get(result.productId);
    expect(row?.asin).toBe('B08N5WRWNW');
    expect(row?.sessionKey).toBe(COLLECTION);
    expect(row?.collectedAt).toBe('2026-10-19T10:00:00.000Z');
    expect(row?.title).toBe('Anker 65W Charger');
  });

  it('refreshes volatile fields on a re-save instead of adding a row', async () => {
    const first = await upsertProductFromQuickSave(product(), COLLECTION);
    const second = await upsertProductFromQuickSave(
      product({ price: 24.99, rating: 4.4, reviewCount: 1300 }),
      COLLECTION,
    );

    expect(second.created).toBe(false);
    expect(second.productId).toBe(first.productId);
    expect(await db.products.count()).toBe(1);

    const row = await db.products.get(first.productId);
    expect(row?.price).toBe(24.99);
    expect(row?.rating).toBe(4.4);
    expect(row?.reviewCount).toBe(1300);
    expect(second.updatedFields).toEqual(
      expect.arrayContaining(['price', 'rating', 'reviewCount']),
    );
  });

  it('never overwrites a known value with null or undefined', async () => {
    const first = await upsertProductFromQuickSave(product(), COLLECTION);
    await upsertProductFromQuickSave(
      product({
        price: null,
        rating: null,
        reviewCount: null,
        title: null,
        brand: null,
        availability: null,
        seller: null,
        imageUrl: null,
      }),
      COLLECTION,
    );

    const row = await db.products.get(first.productId);
    expect(row?.price).toBe(19.99);
    expect(row?.rating).toBe(4.5);
    expect(row?.reviewCount).toBe(1200);
    expect(row?.title).toBe('Anker 65W Charger');
  });

  it('keeps the longer title and fills an empty one', async () => {
    const first = await upsertProductFromQuickSave(
      product({ title: 'Anker 65W Charger with Cable' }),
      COLLECTION,
    );
    await upsertProductFromQuickSave(product({ title: 'Anker 65W' }), COLLECTION);

    expect((await db.products.get(first.productId))?.title).toBe(
      'Anker 65W Charger with Cable',
    );

    const empty = await upsertProductFromQuickSave(
      product({ asin: 'B0EMPTY000', title: null }),
      COLLECTION,
    );
    await upsertProductFromQuickSave(
      product({ asin: 'B0EMPTY000', title: 'Filled Later' }),
      COLLECTION,
    );

    expect((await db.products.get(empty.productId))?.title).toBe('Filled Later');
  });

  it('ORs isPrime and fills features only when empty', async () => {
    const first = await upsertProductFromQuickSave(
      product({ isPrime: false, features: [] }),
      COLLECTION,
    );
    await upsertProductFromQuickSave(
      product({ isPrime: true, features: ['65W', 'GaN'] }),
      COLLECTION,
    );
    await upsertProductFromQuickSave(
      product({ isPrime: true, features: ['ignored'] }),
      COLLECTION,
    );

    const row = await db.products.get(first.productId);
    expect(row?.isPrime).toBe(true);
    expect(row?.features).toEqual(['65W', 'GaN']);
  });

  it('freezes the price when the currency changed', async () => {
    const first = await upsertProductFromQuickSave(
      product({ price: 19.99, currency: 'USD' }),
      COLLECTION,
    );
    const second = await upsertProductFromQuickSave(
      product({ price: 24.99, currency: 'EUR' }),
      COLLECTION,
    );

    const row = await db.products.get(first.productId);
    expect(second.currencyMismatch).toBe(true);
    expect(row?.price).toBe(19.99);
    expect(row?.currency).toBe('USD');
  });

  it('scopes rows by sessionKey, so the same ASIN can live in two collections', async () => {
    const a = await upsertProductFromQuickSave(product(), 'oc_a');
    const b = await upsertProductFromQuickSave(product(), 'oc_b');

    expect(a.productId).not.toBe(b.productId);
    expect(await db.products.count()).toBe(2);
  });

  it('rejects an invalid product with a typed error', async () => {
    await expect(
      upsertProductFromQuickSave(product({ asin: 'bad' }), COLLECTION),
    ).rejects.toBeInstanceOf(QuickSaveValidationError);

    await expect(
      upsertProductFromQuickSave(product({ asin: 'bad' }), COLLECTION),
    ).rejects.toMatchObject({ code: 'INVALID_PRODUCT' });

    await expect(
      upsertProductFromQuickSave(product(), ''),
    ).rejects.toMatchObject({ code: 'MISSING_SESSION_KEY' });
  });

  it('leaves full-page rows written by addProducts untouched', async () => {
    await addProducts([product({ price: 19.99 })], 'session_full');
    const before = await db.products.where('sessionKey').equals('session_full').first();

    await upsertProductFromQuickSave(product({ price: 29.99 }), COLLECTION);

    const after = await db.products.where('sessionKey').equals('session_full').first();
    expect(after).toEqual(before);
    expect(await db.products.count()).toBe(2);
  });
});

describe('appendSnapshot', () => {
  it('records one row per observation', async () => {
    const base = snapshotFromProduct(product(), {
      sessionKey: COLLECTION,
      jobId: 'job-1',
      source: 'listing',
      capturedAt: '2026-10-19T10:00:00.000Z',
    });

    const first = await appendSnapshot(base);
    const second = await appendSnapshot({
      ...base,
      jobId: 'job-2',
      capturedAt: '2026-10-20T10:00:00.000Z',
      price: 24.99,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(await db.snapshots.count()).toBe(2);
  });

  it('is idempotent for a replayed jobId and source', async () => {
    const base = snapshotFromProduct(product(), {
      sessionKey: COLLECTION,
      jobId: 'job-1',
      source: 'listing',
      capturedAt: '2026-10-19T10:00:00.000Z',
    });

    const first = await appendSnapshot(base);
    const replay = await appendSnapshot(base);

    expect(replay.created).toBe(false);
    expect(replay.id).toBe(first.id);
    expect(await db.snapshots.count()).toBe(1);
  });

  it('stores unavailable values as null rather than omitting them', async () => {
    const base = snapshotFromProduct(
      product({ price: null, rating: null, reviewCount: null, currency: null }),
      { sessionKey: COLLECTION, jobId: 'job-3', source: 'detail' },
    );

    expect(base.price).toBeNull();
    expect(base.rating).toBeNull();
    expect(base.currency).toBeNull();
    expect(base.capturedAt).toEqual(expect.any(String));
    await appendSnapshot(base);
  });
});

describe('saveQuickProduct', () => {
  it('writes the product and its snapshot together', async () => {
    const first = await saveQuickProduct({
      product: product(),
      sessionKey: COLLECTION,
      jobId: 'job-1',
      collectedAt: '2026-10-19T10:00:00.000Z',
    });

    expect(first.upsert.created).toBe(true);
    expect(first.snapshot.created).toBe(true);
    expect(await db.products.count()).toBe(1);
    expect(await db.snapshots.count()).toBe(1);

    const second = await saveQuickProduct({
      product: product({ price: 24.99 }),
      sessionKey: COLLECTION,
      jobId: 'job-2',
      collectedAt: '2026-10-20T10:00:00.000Z',
    });

    expect(second.upsert.created).toBe(false);
    expect(await db.products.count()).toBe(1);
    expect(await db.snapshots.count()).toBe(2);

    const prices = (await db.snapshots.toArray()).map((row) => row.price).sort();
    expect(prices).toEqual([19.99, 24.99]);
    expect((await db.products.toArray())[0]?.price).toBe(24.99);
  });
});

describe('moveProductToCollection', () => {
  it('moves the product and its snapshots to the target collection', async () => {
    await saveQuickProduct({ product: product(), sessionKey: 'oc_a', jobId: 'job-1' });

    const result = await moveProductToCollection('B08N5WRWNW', 'oc_a', 'oc_b');

    expect(result).toMatchObject({ moved: true, merged: false });
    const rows = await db.products.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionKey).toBe('oc_b');
    expect(await db.snapshots.where('sessionKey').equals('oc_b').count()).toBe(1);
    expect(await db.snapshots.where('sessionKey').equals('oc_a').count()).toBe(0);
  });

  it('merges into an existing row at the destination instead of duplicating it', async () => {
    await saveQuickProduct({
      product: product({ title: null, brand: null }),
      sessionKey: 'oc_a',
      jobId: 'job-1',
    });
    await saveQuickProduct({
      product: product({ title: 'Anker 65W Charger', brand: 'Anker' }),
      sessionKey: 'oc_b',
      jobId: 'job-2',
    });

    const result = await moveProductToCollection('B08N5WRWNW', 'oc_a', 'oc_b');

    expect(result).toMatchObject({ moved: true, merged: true });
    const rows = await db.products.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionKey).toBe('oc_b');
    expect(rows[0]?.title).toBe('Anker 65W Charger');
    expect(await db.snapshots.where('sessionKey').equals('oc_b').count()).toBe(2);
  });

  it('reports a missing source and a no-op move', async () => {
    expect(await moveProductToCollection('B08N5WRWNW', 'oc_a', 'oc_b')).toEqual({
      moved: false,
      merged: false,
      reason: 'NOT_FOUND',
    });

    await saveQuickProduct({ product: product(), sessionKey: 'oc_a', jobId: 'job-1' });
    expect(await moveProductToCollection('B08N5WRWNW', 'oc_a', 'oc_a')).toEqual({
      moved: false,
      merged: false,
      reason: 'SAME_COLLECTION',
    });
  });
});

describe('history-only collections', () => {
  it('creates a history row and never a sessions row', async () => {
    const created = await createOneClickCollection({
      pageUrl: 'https://www.amazon.com/s?k=chargers',
      product: { title: 'Anker 65W Charger', asin: 'B08N5WRWNW' },
      now: new Date('2026-10-19T10:00:00.000Z'),
    });

    expect(created.sessionKey).toBe(`${'oc_'}${Date.parse('2026-10-19T10:00:00.000Z')}`);
    expect(created.label).toBe('Anker 65W Charger');

    const rows = await db.history.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionKey: created.sessionKey,
      name: 'Anker 65W Charger',
      origin: 'one-click',
      targetCount: 0,
      collectedCount: 0,
      status: 'completed',
    });

    // The full-page recovery mechanism must not see this collection.
    expect(await db.sessions.count()).toBe(0);
    expect(await getActiveSession()).toBeUndefined();
  });

  it('disambiguates duplicate labels without touching the sessionKey', async () => {
    const a = await createOneClickCollection({
      pageUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
      product: { title: 'Anker 65W Charger' },
      now: new Date('2026-10-19T10:00:00.000Z'),
    });
    const b = await createOneClickCollection({
      pageUrl: 'https://www.amazon.com/dp/B0OTHERAAA',
      product: { title: 'Anker 65W Charger' },
    });

    expect(a.label).toBe('Anker 65W Charger');
    expect(b.label).toBe('Anker 65W Charger (2)');
    expect(b.sessionKey).not.toBe(a.sessionKey);
    expect(await pickUniqueCollectionLabel('Anker 65W Charger')).toBe(
      'Anker 65W Charger (3)',
    );
  });

  it('allocates a fresh key inside the same millisecond', async () => {
    const now = Date.parse('2026-10-19T10:00:00.000Z');
    const first = await allocateOneClickSessionKey(now);
    await db.history.add({
      sessionKey: first,
      url: 'https://www.amazon.com',
      mode: 'manual',
      targetCount: 0,
      collectedCount: 0,
      startedAt: '2026-10-19T10:00:00.000Z',
      completedAt: '2026-10-19T10:00:00.000Z',
      status: 'completed',
    });

    expect(await allocateOneClickSessionKey(now)).toBe(`oc_${now}_2`);
  });

  it('derives a bounded label from a long or missing title', () => {
    expect(deriveCollectionLabel({ title: '  Anker   65W\tCharger ' })).toBe(
      'Anker 65W Charger',
    );

    const long = deriveCollectionLabel({ title: 'x'.repeat(200) });
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);

    expect(deriveCollectionLabel({ title: null, asin: 'B08N5WRWNW' })).toBe(
      'Saved B08N5WRWNW',
    );
    expect(
      deriveCollectionLabel({}, new Date('2026-10-19T10:00:00.000Z')),
    ).toBe('Saved 2026-10-19');
  });

  it('refreshCollectionCounts reads the true count back from products', async () => {
    const created = await createOneClickCollection({
      pageUrl: 'https://www.amazon.com/s?k=x',
      product: { title: 'Tools' },
    });

    await saveQuickProduct({
      product: product(),
      sessionKey: created.sessionKey,
      jobId: 'job-1',
    });
    await saveQuickProduct({
      product: product({ asin: 'B0SECONDAA' }),
      sessionKey: created.sessionKey,
      jobId: 'job-2',
    });

    const count = await refreshCollectionCounts(created.sessionKey);

    expect(count).toBe(2);
    expect(await getProductCountBySession(created.sessionKey)).toBe(2);

    const history = await getHistoryEntries();
    expect(history[0]?.collectedCount).toBe(2);
    expect(history[0]?.updatedAt).toEqual(expect.any(String));
  });
});
