/**
 * SAD-391 step 4 — persistence stops erasing what was extracted (F7).
 *
 * Before: the quick-save volatile pass fed `mergeScrapedProductFields` an
 * object with no listing fields under `preferSource`, which (1) invented an
 * 'Organic Search' placement, (2) recomputed `listingCategory` to 'organic'
 * and (3) wrote `isSponsored = undefined` — a second one-click save of a
 * sponsored product relabelled it organic (probe P04 in the plan).
 *
 * Decided semantics (D6): `isSponsored` is sticky across saves like `isPrime`;
 * a later organic save still records its 'Organic Search' placement.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db/database';
import { upsertProductFromQuickSave } from '@/engines/amazon/db/quick-save';
import { mergeScrapedProductFields } from '@/engines/amazon/scraper/dedup';
import type { ScrapedAmazonProduct, ScrapedProduct } from '@/engines/amazon/types';

const COLLECTION = 'oc_1700000000391';

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B081XSYZMS',
    url: 'https://www.amazon.com/dp/B081XSYZMS',
    title: 'Wireless Earbuds',
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 1200,
    source: 'search',
    isPrime: false,
    isSponsored: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('upsertProductFromQuickSave — isSponsored survives a re-save (P04)', () => {
  it('a second save of the same sponsored card changes only collectedAt', async () => {
    const first = await upsertProductFromQuickSave(
      product({ isSponsored: true }),
      COLLECTION,
      { collectedAt: '2026-10-21T10:00:00.000Z' },
    );
    const second = await upsertProductFromQuickSave(
      product({ isSponsored: true }),
      COLLECTION,
      { collectedAt: '2026-10-21T10:05:00.000Z' },
    );

    expect(second.created).toBe(false);
    expect(second.updatedFields).toEqual(['collectedAt']);
    const row = await db.products.get(first.productId);
    expect(row?.isSponsored).toBe(true);
    expect(row?.listingCategory).toBeUndefined();
    expect(row?.placements).toBeUndefined();
  });

  it('a widget-sourced sponsored row keeps its category and section on re-save', async () => {
    const first = await upsertProductFromQuickSave(
      product({
        isSponsored: true,
        listingCategory: 'sponsored',
        sectionLabel: 'Sponsored Brand',
      }),
      COLLECTION,
    );
    const second = await upsertProductFromQuickSave(
      product({
        isSponsored: true,
        listingCategory: 'sponsored',
        sectionLabel: 'Sponsored Brand',
        price: 17.99,
      }),
      COLLECTION,
    );

    expect(second.updatedFields).toEqual(['collectedAt', 'price']);
    const row = await db.products.get(first.productId);
    expect(row?.isSponsored).toBe(true);
    expect(row?.listingCategory).toBe('sponsored');
    expect(row?.sectionLabel).toBe('Sponsored Brand');
    expect(row?.placements).toBeUndefined();
  });

  it('D6: an organic save after a sponsored save keeps isSponsored and records the organic placement', async () => {
    const first = await upsertProductFromQuickSave(
      product({ isSponsored: true }),
      COLLECTION,
    );
    await upsertProductFromQuickSave(product({ isSponsored: false }), COLLECTION);

    const row = await db.products.get(first.productId);
    expect(row?.isSponsored).toBe(true);
    expect(row?.placements).toEqual(['Sponsored Search', 'Organic Search']);
    expect(row?.listingCategory).toBeUndefined();
  });

  it('D6: a sponsored save after an organic save sets isSponsored and records both placements', async () => {
    const first = await upsertProductFromQuickSave(
      product({ isSponsored: false }),
      COLLECTION,
    );
    const second = await upsertProductFromQuickSave(
      product({ isSponsored: true }),
      COLLECTION,
    );

    expect(second.updatedFields).toEqual(['collectedAt', 'isSponsored', 'placements']);
    const row = await db.products.get(first.productId);
    expect(row?.isSponsored).toBe(true);
    expect(row?.placements).toEqual(['Organic Search', 'Sponsored Search']);
  });

  it('D6: a stored "organic" category follows the flag when the product is later saved as an ad', async () => {
    const first = await upsertProductFromQuickSave(
      product({ isSponsored: false, listingCategory: 'organic' }),
      COLLECTION,
    );
    await upsertProductFromQuickSave(product({ isSponsored: true }), COLLECTION);

    const row = await db.products.get(first.productId);
    expect(row?.isSponsored).toBe(true);
    expect(row?.listingCategory).toBe('sponsored');
  });

  it('organic re-saves of an organic row invent nothing', async () => {
    const first = await upsertProductFromQuickSave(product(), COLLECTION);
    const second = await upsertProductFromQuickSave(
      product({ price: 21.99 }),
      COLLECTION,
    );

    expect(second.updatedFields).toEqual(['collectedAt', 'price']);
    const row = await db.products.get(first.productId);
    expect(row?.isSponsored).toBe(false);
    expect(row?.placements).toBeUndefined();
    expect(row?.listingCategory).toBeUndefined();
  });
});

describe('mergeScrapedProductFields — a source without listing context is not an observation', () => {
  const sponsoredRow = (): ScrapedAmazonProduct =>
    ({
      asin: 'B081XSYZMS',
      url: 'https://www.amazon.com/dp/B081XSYZMS',
      title: 'Wireless Earbuds',
      price: 19.99,
      currency: 'USD',
      rating: 4.5,
      reviewCount: 1200,
      imageUrl: null,
      isSponsored: true,
      isPrime: false,
      brand: null,
      availability: null,
      seller: null,
      description: null,
      features: [],
      source: 'search',
      listingCategory: 'sponsored',
    }) as ScrapedAmazonProduct;

  it('volatile-shaped source under preferSource refreshes the price and nothing else', () => {
    const target = sponsoredRow();
    const changed = mergeScrapedProductFields(
      target,
      {
        asin: 'B081XSYZMS',
        url: 'https://www.amazon.com/dp/B081XSYZMS',
        source: 'search',
        price: 17.49,
      } as unknown as ScrapedAmazonProduct,
      { preferSource: true },
    );

    expect(changed).toBe(true);
    expect(target.price).toBe(17.49);
    expect(target.isSponsored).toBe(true);
    expect(target.listingCategory).toBe('sponsored');
    expect(target.placements).toBeUndefined();
  });

  it('page-level semantics are unchanged: a primary organic card still wins over a sponsored widget card', () => {
    const target = {
      ...sponsoredRow(),
      sectionLabel: 'Sponsored Brand',
    } as ScrapedAmazonProduct;
    const primary = {
      ...sponsoredRow(),
      isSponsored: false,
      listingCategory: undefined,
      price: 18.99,
    } as ScrapedAmazonProduct;

    mergeScrapedProductFields(target, primary, { preferSource: true });

    expect(target.isSponsored).toBe(false);
    expect(target.listingCategory).toBe('organic');
    expect(target.placements).toEqual(['Organic Search', 'Sponsored Brand']);
  });

  it('a boolean false from a real card still applies under preferSource', () => {
    const target = sponsoredRow();
    mergeScrapedProductFields(
      target,
      { ...sponsoredRow(), isSponsored: false, listingCategory: undefined },
      { preferSource: true },
    );
    expect(target.isSponsored).toBe(false);
  });
});
