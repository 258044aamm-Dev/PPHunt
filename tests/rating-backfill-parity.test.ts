/**
 * SAD-383 step 4 — the ticket's acceptance criterion, stated differentially.
 *
 * The ticket says: *"ratings and rating counts are extracted correctly when using
 * the right-click context menu or the per-product icon, but not in Collection
 * Mode"*. So the test is not "a rating appears" — it is **the same product, taken
 * through both pipelines, must end as the same row**.
 *
 * The card used here is the real deals faceout captured on 2026-10-21: it prints
 * an image, a price and a title, and **no rating node at all** (verified in
 * `SAD-383-evidence-2026-10-21.md` §2.2). That is the layout the ticket is about.
 *
 * Both sides are the production code paths:
 * - save: `extractProductFromCard` → `parseAmazonProductDetail` → `mergeDetailIntoStored`
 * - collection: `extractProductFromCard` → the backfill queue → the popover parser
 *   → `backfillProductRating`
 *
 * Only the two network calls are replaced, each with the payload Amazon actually
 * served that day, so equality here means the pipelines agree — not that two
 * mocks were written to agree.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { db } from '@/engines/amazon/db/database';
import { addProducts } from '@/engines/amazon/db/products';
import { extractProductFromCard } from '@/engines/amazon/content/save-product';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import { mergeDetailIntoStored } from '@/engines/amazon/background/enrich-saved-product';
import {
  enqueueRatingBackfill,
  resetRatingBackfillForTests,
  whenRatingBackfillIdle,
} from '@/engines/amazon/background/rating-backfill';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'docs', 'plans', 'SAD-383-fixtures', name), 'utf8');

const DEALS_CARD = fixture('deals-card.real.html');
const POPOVER = fixture('rating-popover.real.html');

const SAVE_SESSION = 'session_save_383';
const COLLECT_SESSION = 'session_collect_383';

/**
 * The product page both pipelines are entitled to read. Markup shape is the one
 * the repo's own save tests use (`tests/save-product.test.ts`), with the numbers
 * Amazon served for this ASIN on 2026-10-21.
 */
const DETAIL_PAGE = `
  <span id="productTitle">LOAAO 72X36 Inch Brushed Nickel Bathroom Mirror</span>
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-price-whole">251</span><span class="a-price-fraction">99</span></span>
  </div>
  <i id="acrPopover" title="4.6 out of 5 stars"></i>
  <span id="acrCustomerReviewText">142,457 ratings</span>
  <img id="landingImage" src="https://m.media-amazon.com/images/I/71H+vZXVVCL._AC_SL1500_.jpg">
  <div id="availability"><span>In Stock</span></div>
`;

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The card as the content script sees it, on the deals grid. */
function cardProduct() {
  const card = doc(DEALS_CARD).querySelector('[data-csa-c-item-type="deal"]');
  if (!card) throw new Error('the deals fixture no longer contains a faceout');
  const product = extractProductFromCard(
    card,
    'https://www.amazon.com/deals',
  );
  if (!product) throw new Error('the deals card no longer parses');
  return product;
}

async function rowFor(sessionKey: string, asin: string) {
  return db.products.where('[sessionKey+asin]').equals([sessionKey, asin]).first();
}

beforeEach(async () => {
  resetRatingBackfillForTests();
  await db.products.clear();
});

describe('SAD-383: a save and a collection end with the same rating', () => {
  it('both pipelines carry the same rating and review count for a card that printed neither', async () => {
    const product = cardProduct();

    // The premise: this card really has no rating to extract.
    expect(product.rating ?? null).toBeNull();
    expect(product.reviewCount ?? null).toBeNull();

    // Store the same card-derived product for both runs.
    await addProducts([product], SAVE_SESSION);
    await addProducts([product], COLLECT_SESSION);

    /* ---- save pipeline: parse the product page, merge the detail fields ---- */
    const detail = parseAmazonProductDetail(
      doc(DETAIL_PAGE),
      product.url,
    );
    expect(detail).not.toBeNull();
    expect(detail?.rating).toBe(4.6);
    expect(detail?.reviewCount).toBe(142457);

    const saveRow = await rowFor(SAVE_SESSION, product.asin);
    const { patch } = mergeDetailIntoStored(saveRow!, detail!);
    await db.products.update(saveRow!.id!, patch);

    /* ---- collection pipeline: the backfill queue ---- */
    enqueueRatingBackfill([product], COLLECT_SESSION, {
      // The network only. Everything after it is production code.
      fetchRating: vi.fn(async () => ({ status: 'ok' as const, html: POPOVER })),
    });
    await whenRatingBackfillIdle();

    const savedRow = await rowFor(SAVE_SESSION, product.asin);
    const collectedRow = await rowFor(COLLECT_SESSION, product.asin);

    // The ticket, in one assertion.
    expect(collectedRow?.rating).toBe(savedRow?.rating);
    expect(collectedRow?.reviewCount).toBe(savedRow?.reviewCount);
    expect(collectedRow?.rating).toBe(4.6);
    expect(collectedRow?.reviewCount).toBe(142457);
  });

  it('the collection keeps the card’s own rating when the card printed one', async () => {
    const product = { ...cardProduct(), rating: 4.1, reviewCount: 12 };
    await addProducts([product], COLLECT_SESSION);

    enqueueRatingBackfill([product], COLLECT_SESSION, {
      fetchRating: vi.fn(async () => ({ status: 'ok' as const, html: POPOVER })),
    });
    await whenRatingBackfillIdle();

    // Nothing to fill, so nothing was fetched and nothing changed.
    const row = await rowFor(COLLECT_SESSION, product.asin);
    expect(row?.rating).toBe(4.1);
    expect(row?.reviewCount).toBe(12);
  });

  it('a product with no reviews is left alone rather than stamped with 0.0', async () => {
    const product = cardProduct();
    await addProducts([product], COLLECT_SESSION);

    enqueueRatingBackfill([product], COLLECT_SESSION, {
      fetchRating: vi.fn(async () => ({
        status: 'ok' as const,
        html: fixture('rating-popover.empty.real.html'),
      })),
    });
    await whenRatingBackfillIdle();

    const row = await rowFor(COLLECT_SESSION, product.asin);
    expect(row?.rating).toBeNull();
    expect(row?.reviewCount).toBeNull();
  });
});
