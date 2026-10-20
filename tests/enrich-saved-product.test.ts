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
  collectMissingDetailFields,
  collectPresentDetailFields,
  enrichSavedProduct,
  mergeDetailIntoStored,
  resetEnrichmentConcurrencyForTests,
} from '@/engines/amazon/background/enrich-saved-product';
import { resetEnrichmentCircuitForTests } from '@/engines/amazon/background/enrichment-fetch';
import type { Product, ScrapedProduct } from '@/engines/amazon/types';
import type { ExtractionDiagnosticsReport } from '@/engines/amazon/scraper/extraction-diagnostics';

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
  it('takes non-null detail values for descriptive fields', () => {
    const stored = storedRow();
    const { patch, changedFields } = mergeDetailIntoStored(stored, detail());

    expect(patch.title).toBe('Anker 65W Charger');
    expect(patch.rating).toBe(4.6);
    expect(changedFields).toEqual(
      expect.arrayContaining(['title', 'rating', 'reviewCount']),
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

  it('keeps the listing price even when the detail price differs', () => {
    const stored = storedRow({ price: 19.99 });
    const { patch, changedFields } = mergeDetailIntoStored(stored, detail({ price: 89.99 }));

    expect(patch.price).toBeUndefined();
    expect(changedFields).not.toContain('price');
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

  it('fills the row and appends a detail snapshot', async () => {
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
    expect(result.fieldsChanged).toContain('rating');
    expect(result.snapshotCreated).toBe(true);

    const row = await db.products.where('[sessionKey+asin]').equals([SESSION, ASIN]).first();
    // The listing price the user saved with wins; the PDP observation lives in
    // the snapshot.
    expect(row?.price).toBe(19.99);
    expect(row?.rating).toBe(4.6);
    expect(row?.reviewCount).toBe(1204);
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
    expect(result.errorCode).toBe('ENRICH_FETCH_FAILED');
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
    expect(result.errorCode).toBe('ENRICH_PARSE_FAILED');

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
    expect(result.errorCode).toBe('DB_WRITE_FAILED');
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

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('skipped:no-permission');
  });

  it('isolates one failing job from its siblings', async () => {
    await seed();
    const products = [
      detail({ asin: ASIN }),
      null,
      detail({ asin: ASIN }),
    ];

    const results = await Promise.all(
      products.map((product, index) =>
        enrichSavedProduct(
          {
            jobId: `job-iso-${index}`,
            asin: ASIN,
            productUrl: PRODUCT_URL,
            sessionKey: SESSION,
            now: NOW,
          },
          {
            fetchOptions: {
              fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
              hasHostPermission: async () => true,
            },
            parse: parseReturning(product),
          },
        ),
      ),
    );

    expect(results.map((result) => result.status)).toEqual([
      'complete',
      'failed',
      'complete',
    ]);
    // Two successes, one failure -> two snapshots (attempts and observations are
    // not the same thing).
    expect(await db.snapshots.count()).toBe(2);
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

describe('collectMissingDetailFields (SAD-352)', () => {
  it('is empty when every PDP-authoritative field is populated', () => {
    const full = storedRow({
      listPrice: 29.99,
      discountPercentage: '-33%',
      bestSellersRank: '#12 in Widgets',
      availability: 'In Stock',
      seller: 'Anker',
      brand: 'Anker',
      description: 'A charger.',
      imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
      coupon: 'Save 5%',
      delivery: 'FREE delivery',
      dealBadge: 'Limited time deal',
      pastMonthSales: '1K+ bought in past month',
      badge: "Amazon's Choice",
      variations: '2 (Size: S, M)',
      weight: '0.19 kg',
      warrantyDescription: '1-year',
      warrantyDescriptionRaw: '1 year manufacturer',
      features: ['Fast charging'],
    });

    expect(collectMissingDetailFields(full)).toEqual([]);
  });

  it('lists the detail fields a bare listing row is missing', () => {
    const missing = collectMissingDetailFields(storedRow());

    expect(missing).toEqual(
      expect.arrayContaining([
        'brand',
        'seller',
        'availability',
        'description',
        'bestSellersRank',
        'variations',
        'weight',
        'warrantyDescription',
        'features',
      ]),
    );
    // Fields the card already supplied are not reported as missing.
    expect(missing).not.toContain('title');
    expect(missing).not.toContain('price');
  });

  it('treats blank strings and an empty features list as missing', () => {
    const missing = collectMissingDetailFields(
      storedRow({ brand: '   ', features: [] }),
    );

    expect(missing).toContain('brand');
    expect(missing).toContain('features');
  });

  it('collectPresentDetailFields is the complement view on a parsed detail', () => {
    const present = collectPresentDetailFields(
      detail({ brand: 'Anker', features: ['Fast'] }),
    );

    expect(present).toEqual(
      expect.arrayContaining(['title', 'price', 'brand', 'features']),
    );
    expect(present).not.toContain('seller');
    expect(present).not.toContain('description');
  });
});

describe('SAD-352 enrichment outcome logging', () => {
  function outcomeLines(
    spy: { mock: { calls: unknown[][] } },
  ): Array<Record<string, unknown>> {
    const tag = '[PPHunt] enrichment outcome ';
    return spy.mock.calls
      .map((call) => call[0])
      .filter(
        (first): first is string =>
          typeof first === 'string' && first.startsWith(tag),
      )
      .map((line) => JSON.parse(line.slice(tag.length)) as Record<string, unknown>);
  }

  it('logs exactly one outcome for a completed enrichment', async () => {
    await db.products.add(storedRow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await enrichSavedProduct(
      { jobId: 'job-diag-1', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(detail()),
      },
    );

    expect(result.status).toBe('complete');
    const lines = outcomeLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      jobId: 'job-diag-1',
      asin: ASIN,
      status: 'complete',
      httpStatus: 200,
      htmlBytes: '<html><body>pdp</body></html>'.length,
      snapshotCreated: true,
      currencyMismatch: false,
    });
    expect(lines[0]?.fieldsChanged).toEqual(expect.arrayContaining(['title']));
    // The default detail carries no brand: the row is `complete` by the
    // title+price rule yet still missing it — exactly what this log exists
    // to make visible (SAD-352 H4).
    expect(lines[0]?.missingDetailFields).toEqual(
      expect.arrayContaining(['brand']),
    );
    // The parsed detail itself carried title/price/rating but no brand —
    // parser-side absence, not a merge refusal (SAD-352 step 1a.2).
    expect(lines[0]?.detailPresentFields).toEqual(
      expect.arrayContaining(['title', 'price', 'rating']),
    );
    expect(lines[0]?.detailPresentFields).not.toContain('brand');
    expect(typeof lines[0]?.ms).toBe('number');
  });

  it('logs the fetch classification when the PDP cannot be fetched', async () => {
    await db.products.add(storedRow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await enrichSavedProduct(
      { jobId: 'job-diag-2', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => ({ ...htmlResponse(), ok: false, status: 404 })) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(detail()),
      },
    );

    expect(result.status).toBe('failed');
    const lines = outcomeLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'failed',
      reason: 'not-found',
      errorCode: 'ENRICH_FETCH_FAILED',
      httpStatus: 404,
      message: 'The product page no longer exists',
      snapshotCreated: false,
    });
  });

  it('logs a guard skip without attempting a fetch report', async () => {
    await db.products.add(storedRow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await enrichSavedProduct(
      { jobId: 'job-diag-3', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn() as unknown as typeof fetch,
          hasHostPermission: async () => false,
        },
        parse: parseReturning(detail()),
      },
    );

    expect(result.status).toBe('skipped');
    const lines = outcomeLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'skipped',
      reason: 'skipped:no-permission',
      message: 'No host permission for amazon.com',
    });
    expect(lines[0]).not.toHaveProperty('httpStatus');
  });

  it('a throwing console never changes the enrichment result', async () => {
    await db.products.add(storedRow());
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('console is gone');
    });

    const result = await enrichSavedProduct(
      { jobId: 'job-diag-4', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: {
          fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
          hasHostPermission: async () => true,
        },
        parse: parseReturning(detail()),
      },
    );

    expect(result.status).toBe('complete');
  });
});

describe('SAD-359 extraction diagnostics logging', () => {
  const REPORT: ExtractionDiagnosticsReport = {
    asin: ASIN,
    fields: [
      { field: 'asin', status: 'EXTRACTED', source: 'url' },
      {
        field: 'price',
        status: 'PARTIAL',
        source: 'json-ld',
        reason: 'buybox present but no parseable DOM price; JSON-LD fallback used',
      },
      {
        field: 'seller',
        status: 'MISSING',
        reason: 'no seller/merchant node in the fetched HTML',
      },
    ],
  };

  function diagnosticLines(
    spy: { mock: { calls: unknown[][] } },
  ): Array<Record<string, unknown>> {
    const tag = '[PPHunt] extraction diagnostics ';
    return spy.mock.calls
      .map((call) => call[0])
      .filter(
        (first): first is string =>
          typeof first === 'string' && first.startsWith(tag),
      )
      .map((line) => JSON.parse(line.slice(tag.length)) as Record<string, unknown>);
  }

  const okFetch = () => ({
    fetchImpl: vi.fn(async () => htmlResponse()) as unknown as typeof fetch,
    hasHostPermission: async () => true,
  });

  it('logs the parse diagnostics once, grouped with the enrichment job', async () => {
    await db.products.add(storedRow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await enrichSavedProduct(
      { jobId: 'job-diag-359-1', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: okFetch(),
        parse: async () => ({ ok: true as const, product: detail(), fieldDiagnostics: REPORT }),
      },
    );

    expect(result.status).toBe('complete');
    const lines = diagnosticLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      jobId: 'job-diag-359-1',
      asin: ASIN,
      stage: 'enrichment-parse',
      counts: { extracted: 1, missing: 1, partial: 1 },
    });
    expect(lines[0]?.fields).toEqual(REPORT.fields);
  });

  it('logs diagnostics for a rejected parse as well', async () => {
    await db.products.add(storedRow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await enrichSavedProduct(
      { jobId: 'job-diag-359-2', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      {
        fetchOptions: okFetch(),
        parse: async () => ({
          ok: false as const,
          code: 'PARSE_FAILED' as const,
          message: 'no product',
          fieldDiagnostics: REPORT,
        }),
      },
    );

    expect(result.status).toBe('failed');
    expect(diagnosticLines(info)).toHaveLength(1);
  });

  it('stays silent when the parser provides no diagnostics', async () => {
    await db.products.add(storedRow());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await enrichSavedProduct(
      { jobId: 'job-diag-359-3', asin: ASIN, productUrl: PRODUCT_URL, sessionKey: SESSION, now: NOW },
      { fetchOptions: okFetch(), parse: parseReturning(detail()) },
    );

    expect(diagnosticLines(info)).toHaveLength(0);
  });
});
