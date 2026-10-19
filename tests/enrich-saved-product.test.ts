/**
 * SAD-296 (P4.3) - the merge half of enrichment.
 *
 * The row is already saved when enrichment runs, so every test here is really
 * asking the same question in a different way: *can this path damage what the
 * user already has?* The answers it must give are: no (nulls never erase), no
 * (a $ row never gains a € price), no (listing context is not a PDP field), and
 * no (a deleted row is not resurrected).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import {
  enrichSavedProduct,
  mergeDetailIntoStored,
  resetEnrichmentConcurrencyForTests,
} from '@/engines/amazon/background/enrich-saved-product';
import { resetEnrichmentCircuitForTests } from '@/engines/amazon/background/enrichment-fetch';
import type { Product, ScrapedProduct } from '@/engines/amazon/types';

const ASIN = 'B08N5WRWNW';
const SESSION = 'oc_1760000000000';
const PRODUCT_URL = `https://www.amazon.com/dp/${ASIN}`;
const NOW = new Date('2026-10-19T12:00:00.000Z');

function storedRow(overrides: Partial<Product> = {}): Product {
  return {
    asin: ASIN,
    url: PRODUCT_URL,
    title: 'Anker 65W Charger — listing title',
    price: 19.99,
    currency: 'USD',
    rating: 4.4,
    reviewCount: 900,
    collectedAt: '2026-10-19T11:00:00.000Z',
    sessionKey: SESSION,
    source: 'search',
    listingCategory: 'organic',
    placements: ['search'],
    isSponsored: false,
    sectionLabel: 'Results',
    ...overrides,
  } as unknown as Product;
}

function detail(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: ASIN,
    url: PRODUCT_URL,
    title: 'Anker 65W Charger',
    price: 89.99,
    currency: 'USD',
    rating: 4.6,
    reviewCount: 1204,
    source: 'detail',
    ...overrides,
  } as ScrapedProduct;
}

function htmlResponse() {
  return {
    ok: true,
    status: 200,
    url: PRODUCT_URL,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html><body>pdp</body></html>',
  } as unknown as Response;
}

function parseReturning(product: ScrapedProduct | null) {
  return async () =>
    product
      ? ({ ok: true as const, product })
      : ({ ok: false as const, code: 'PARSE_FAILED' as const, message: 'no product' });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetEnrichmentCircuitForTests();
  resetEnrichmentConcurrencyForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mergeDetailIntoStored', () => {
  it('takes non-null detail values and reports what changed', () => {
    const stored = storedRow();
    const { patch, changedFields } = mergeDetailIntoStored(stored, detail());

    expect(patch.price).toBe(89.99);
    expect(patch.title).toBe('Anker 65W Charger');
    expect(changedFields).toEqual(
      expect.arrayContaining(['price', 'title', 'rating', 'reviewCount']),
    );
  });

  it('never lets a null erase a known value', () => {
    const stored = storedRow();
    const { patch } = mergeDetailIntoStored(
      stored,
      detail({ price: null, rating: null, reviewCount: null, title: null }),
    );

    expect(patch.price).toBeUndefined();
    expect(patch.rating).toBeUndefined();
    expect(patch.reviewCount).toBeUndefined();
    expect(patch.title).toBeUndefined();
  });

  it('freezes the price family when the currencies disagree', () => {
    const stored = storedRow({ currency: 'USD' });
    const { patch, changedFields } = mergeDetailIntoStored(
      stored,
      detail({ price: 89.99, currency: 'EUR', listPrice: 99.99 }),
    );

    expect(patch.price).toBeUndefined();
    expect(patch.listPrice).toBeUndefined();
    expect(patch.currency).toBeUndefined();
    expect(changedFields).not.toContain('price');
    // Non-price fields still flow.
    expect(patch.rating).toBe(4.6);
  });

  it('does not touch listing context that a PDP does not carry', () => {
    const stored = storedRow();
    const { patch } = mergeDetailIntoStored(stored, detail());

    expect(patch.listingCategory).toBeUndefined();
    expect(patch.placements).toBeUndefined();
    expect(patch.sectionLabel).toBeUndefined();
    expect(patch.isSponsored).toBeUndefined();
  });

  it('is a no-op for identical values', () => {
    const stored = storedRow();
    const { changedFields } = mergeDetailIntoStored(stored, {
      ...detail({ title: stored.title, price: 19.99, currency: 'USD', rating: 4.4, reviewCount: 900 }),
    } as ScrapedProduct);

    expect(changedFields).toEqual([]);
  });
});

describe('enrichSavedProduct', () => {
  async function seed() {
    await db.products.add(storedRow());
  }

  it('updates the row and appends a detail snapshot', async () => {
    await seed();

    const result = await enrichSavedProduct(
      { jobId: 'job-1', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(detail()),
      },
    );

    expect(result.status).toBe('complete');
    expect(result.fieldsChanged).toContain('price');
    expect(result.snapshotCreated).toBe(true);

    const row = await db.products.where('[sessionKey+asin]').equals([SESSION, ASIN]).first();
    expect(row?.price).toBe(89.99);
    expect(row?.listingCategory).toBe('organic');

    const snapshots = await db.snapshots.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ asin: ASIN, source: 'detail', price: 89.99 });
  });

  it('is partial, not failed, when the page has no price', async () => {
    await seed();

    const result = await enrichSavedProduct(
      { jobId: 'job-2', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(detail({ price: null })),
      },
    );

    expect(result.status).toBe('partial');

    const row = await db.products.where('[sessionKey+asin]').equals([SESSION, ASIN]).first();
    expect(row?.price).toBe(19.99);
    expect(row?.reviewCount).toBe(1204);
  });

  it('leaves the row untouched when the fetch fails', async () => {
    await seed();
    const parse = vi.fn();

    const result = await enrichSavedProduct(
      { jobId: 'job-3', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => ({ ...htmlResponse(), ok: false, status: 404 })) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parse as unknown as typeof import('@/engines/amazon/background/offscreen').parsePdpHtmlViaOffscreen,
      },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('not-found');
    expect(parse).not.toHaveBeenCalled();

    const row = await db.products.where('[sessionKey+asin]').equals([SESSION, ASIN]).first();
    expect(row?.price).toBe(19.99);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('leaves the row untouched when the parse is rejected', async () => {
    await seed();

    const result = await enrichSavedProduct(
      { jobId: 'job-4', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(null),
      },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('parse_failed');

    const row = await db.products.where('[sessionKey+asin]').equals([SESSION, ASIN]).first();
    expect(row?.price).toBe(19.99);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('does not resurrect a row deleted mid-flight', async () => {
    await seed();

    const result = await enrichSavedProduct(
      { jobId: 'job-5', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: async () => {
          await db.products.clear();
          return { ok: true as const, product: detail() };
        },
      },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('row-missing');
    expect(await db.products.count()).toBe(0);
    expect(await db.snapshots.count()).toBe(0);
  });

  it('keeps the stored price when the detail page reports another currency', async () => {
    await seed();

    const result = await enrichSavedProduct(
      { jobId: 'job-6', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(detail({ price: 89.99, currency: 'EUR' })),
      },
    );

    expect(result.currencyMismatch).toBe(true);

    const row = await db.products.where('[sessionKey+asin]').equals([SESSION, ASIN]).first();
    expect(row?.price).toBe(19.99);
    expect(row?.currency).toBe('USD');

    // The observation is still recorded with the currency it was seen in.
    const snapshot = (await db.snapshots.toArray())[0];
    expect(snapshot?.currency).toBe('EUR');
  });

  it('does not duplicate the detail snapshot for the same job', async () => {
    await seed();
    const deps = {
      fetchOptions: {
        fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
        hasHostPermission: async () => true,
      },
      parse: parseReturning(detail()),
    };

    const first = await enrichSavedProduct(
      { jobId: 'job-7', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      deps,
    );
    const second = await enrichSavedProduct(
      { jobId: 'job-7', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      deps,
    );

    expect(first.snapshotCreated).toBe(true);
    expect(second.snapshotCreated).toBe(false);
    expect(await db.snapshots.count()).toBe(1);
  });

  it('reports a skipped fetch as a failed enrichment with the reason', async () => {
    await seed();

    const result = await enrichSavedProduct(
      { jobId: 'job-8', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION },
      {
        fetchOptions: {
          fetchImpl: vi.fn() as unknown as typeof fetch,
          hasHostPermission: async () => false,
        },
        parse: parseReturning(detail()),
      },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('skipped:no-permission');
  });

  it('never runs more than two enrichments at once', async () => {
    await seed();
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return htmlResponse();
    });

    await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        enrichSavedProduct(
          {
            jobId: `job-burst-${index}`,
            asin: ASIN,
            productUrl: PRODUCT_URL,
            sessionKey: SESSION,
            now: NOW,
          },
          {
            fetchOptions: {
              fetchImpl: fetchImpl as unknown as typeof fetch,
              hasHostPermission: async () => true,
            },
            parse: parseReturning(detail()),
          },
        ),
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(2);
  });
});
