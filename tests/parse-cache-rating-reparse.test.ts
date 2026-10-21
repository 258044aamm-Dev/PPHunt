/**
 * SAD-383 step 1 — a card must not be frozen before its reviews row exists.
 *
 * The defect: `AmazonParseCache.isComplete()` settles a card on
 * `asin+title+price+imageUrl`, which routinely happens before Amazon injects the
 * reviews row. From then on the collection's later passes were answered from the
 * cache and the card's `rating`/`reviewCount` stayed null for the rest of the run,
 * even though the values were on the page.
 *
 * The fix keeps the settle rule and adds a DOM signature, so a card that is still
 * missing a rating is re-parsed only when its subtree actually changed. These tests
 * pin both halves: the late hydration is picked up, and nothing else gets re-parsed.
 */
import { describe, expect, it } from 'vitest';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';

const ASIN = 'B0CACHE001'.slice(0, 10);

function product(overrides: Partial<ScrapedAmazonProduct> = {}): ScrapedAmazonProduct {
  return {
    asin: ASIN,
    url: `https://www.amazon.com/dp/${ASIN}`,
    title: 'A Card That Hydrates Late',
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
    source: 'search',
    ...overrides,
  };
}

function reviewsRow(asin: string): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-cy', 'reviews-block');
  row.innerHTML =
    '<i class="a-icon a-icon-star-small a-star-small-4-5">' +
    '<span class="a-icon-alt">4.5 out of 5 stars</span></i>' +
    `<a href="/dp/${asin}#customerReviews"><span class="s-underline-text">(1,234)</span></a>`;
  return row;
}

describe('SAD-383 parse cache: a late reviews row is no longer frozen out', () => {
  it('re-parses a card whose rating was missing when the DOM changes', () => {
    const card = document.createElement('div');
    card.innerHTML = '<h2>A Card That Hydrates Late</h2>';
    const cache = new AmazonParseCache();

    let calls = 0;
    const first = cache.getOrParse(card, () => {
      calls += 1;
      return product();
    });
    expect(first?.rating).toBeNull();
    expect(calls).toBe(1);

    // Amazon injects the reviews row after the first pass — same element.
    card.appendChild(reviewsRow(ASIN));

    const second = cache.getOrParse(card, () => {
      calls += 1;
      return product({ rating: 4.5, reviewCount: 1234 });
    });
    expect(calls).toBe(2);
    expect(second?.rating).toBe(4.5);
    expect(second?.reviewCount).toBe(1234);
  });

  it('does not re-parse a rating-less card whose DOM never changes', () => {
    const card = document.createElement('div');
    card.innerHTML = '<h2>A Card That Never Shows A Rating</h2>';
    const cache = new AmazonParseCache();

    let calls = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      cache.getOrParse(card, () => {
        calls += 1;
        return product();
      });
    }
    // One parse, then four signature matches. This is the /deals grid, where the
    // layout prints no rating at all — the cache must not become a re-parse loop.
    expect(calls).toBe(1);
  });

  it('never re-parses a card that already carries both values', () => {
    const card = document.createElement('div');
    card.innerHTML = '<h2>Already Rated</h2>';
    card.appendChild(reviewsRow(ASIN));
    const cache = new AmazonParseCache();

    let calls = 0;
    const run = (rating: number, reviewCount: number) =>
      cache.getOrParse(card, () => {
        calls += 1;
        return product({ rating, reviewCount });
      });

    run(4.5, 1234);
    // Even a DOM change must not rewrite values the user was already shown.
    card.appendChild(document.createElement('span'));
    run(1.0, 1);
    run(1.0, 1);

    expect(calls).toBe(1);
  });

  it('keeps a card with only one of the two values re-readable', () => {
    const card = document.createElement('div');
    card.innerHTML = '<h2>Rating But No Count</h2>';
    const cache = new AmazonParseCache();

    let calls = 0;
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ rating: 4.5, reviewCount: null });
    });
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ rating: 4.5, reviewCount: null });
    });
    expect(calls).toBe(1); // unchanged DOM → still one parse

    card.appendChild(reviewsRow(ASIN));
    const third = cache.getOrParse(card, () => {
      calls += 1;
      return product({ rating: 4.5, reviewCount: 1234 });
    });
    expect(calls).toBe(2);
    expect(third?.reviewCount).toBe(1234);
  });

  it('still caches nothing for an incomplete card', () => {
    const card = document.createElement('div');
    card.innerHTML = '<h2>No Price Yet</h2>';
    const cache = new AmazonParseCache();

    let calls = 0;
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ price: null });
    });
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ price: null });
    });
    // Unchanged behaviour: an incomplete card was never memoized.
    expect(calls).toBe(2);
  });

  it('clear() forgets everything', () => {
    const card = document.createElement('div');
    const cache = new AmazonParseCache();
    cache.set(card, product({ rating: 4.5, reviewCount: 10 }));
    expect(cache.get(card)).toBeDefined();
    cache.clear();
    expect(cache.get(card)).toBeUndefined();
  });

  it('reaches the collection the same way it does in a run: two passes over one document', () => {
    // The real collection shape — the same document parsed twice through one
    // cache, exactly as `runScrapeBatch()` does on manual re-scrape.
    document.body.innerHTML = `
      <div class="s-main-slot">
        <div data-component-type="s-search-result" data-asin="B0LATEHYD1">
          <h2><a href="/dp/B0LATEHYD1"><span>A Product Whose Reviews Row Arrives Late</span></a></h2>
          <span class="a-price"><span class="a-offscreen">$19.99</span></span>
          <img class="s-image" src="https://m.media-amazon.com/images/I/71aaaaaaaL._AC_UL320_.jpg">
        </div>
      </div>`;

    const cache = new AmazonParseCache();
    const pass1 = parseAmazonSearchResults(document, 'https://www.amazon.com/s?k=x', { cache });
    expect(pass1[0]?.rating).toBeNull();

    // Amazon hydrates the rating for that card.
    document
      .querySelector('[data-asin="B0LATEHYD1"]')!
      .appendChild(reviewsRow('B0LATEHYD1'));

    const pass2 = parseAmazonSearchResults(document, 'https://www.amazon.com/s?k=x', { cache });
    expect(pass2[0]?.rating).toBe(4.5);
    expect(pass2[0]?.reviewCount).toBe(1234);
  });
});
