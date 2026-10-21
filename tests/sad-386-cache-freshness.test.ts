/**
 * SAD-386 (merged) — a card that hydrated its badge late must still be re-read.
 *
 * Probe P04-P06 measured the bug: the same DOM answered `null` when the cache
 * had memoised the card before hydration and `"68% off"` when it had not.
 *
 * The first implementation gave the cache a 2 s TTL. Measured against `main`
 * (which by then carried SAD-383's DOM-signature rule for the reviews row) the
 * TTL broke the repo's own performance contract — `tests/scraper-performance.test.ts`
 * expects a warm pass to do no work, and on a slow 480-card page the TTL had
 * expired, so every card was re-parsed. The merged implementation therefore
 * extends SAD-383's rule to the price family: a card is settled only once it
 * carries a discount, a deal badge or a list price, and an unsettled card is
 * re-read exactly once per actual DOM change.
 */
import { describe, expect, it } from 'vitest';
import { AmazonParseCache, parseAmazonSearchResults } from '@/engines/amazon/scraper';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';

const URL_SEARCH = 'https://www.amazon.com/s?k=deal';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The product shape the counting-parser cases return. */
const SAMPLE: ScrapedAmazonProduct = {
  asin: 'B0CACHE001',
  url: 'https://www.amazon.com/dp/B0CACHE001',
  title: 'Cached Deal Laptop',
  price: 259.99,
  currency: 'USD',
  rating: null,
  reviewCount: null,
  imageUrl: 'https://m.media-amazon.com/images/I/71cache._AC_UY218_.jpg',
  isSponsored: false,
  isPrime: false,
  brand: null,
  availability: null,
  seller: null,
  description: null,
  features: [],
  source: 'search',
};

/** Hydrated card: price + image only, no badge family, reviews absent. */
const CARD = `
  <div class="s-main-slot">
    <div data-component-type="s-search-result" data-asin="B0CACHE001">
      <div data-cy="title-recipe">
        <a class="a-link-normal" href="/dp/B0CACHE001"><h2><span>Cached Deal Laptop</span></h2></a>
      </div>
      <div data-cy="price-recipe">
        <span class="a-price"><span class="a-offscreen">$259.99</span></span>
      </div>
      <img class="s-image" src="https://m.media-amazon.com/images/I/71cache._AC_UY218_.jpg" />
    </div>
  </div>`;

/** Amazon injects the badge, the percentage and the reviews row a moment later. */
function hydrate(d: Document): void {
  const card = d.querySelector('[data-asin="B0CACHE001"]')!;
  const price = card.querySelector('[data-cy="price-recipe"]')!;
  const badge = d.createElement('span');
  badge.className = 'a-badge-text';
  badge.setAttribute('data-a-badge-type', 'deal');
  badge.textContent = 'Limited time deal';
  price.appendChild(badge);
  const pct = d.createElement('span');
  pct.className = 'savingsPercentage';
  pct.textContent = '-68%';
  price.appendChild(pct);
  const reviews = d.createElement('div');
  reviews.setAttribute('data-cy', 'reviews-block');
  reviews.innerHTML =
    '<span class="a-icon-alt">4.5 out of 5 stars</span>' +
    '<a href="#customerReviews"><span class="s-underline-text">(1,234)</span></a>';
  card.appendChild(reviews);
}

function span(html: string): Element {
  return doc(html).body.firstElementChild!;
}

describe('SAD-386: a late badge is not frozen out by the parse cache', () => {
  it('re-parses a card whose badge family was missing when the DOM changes', () => {
    const cache = new AmazonParseCache();
    const d = doc(CARD);

    const first = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(first[0]?.discountPercentage).toBeUndefined();
    expect(first[0]?.dealBadge).toBeUndefined();

    hydrate(d);

    const second = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(second[0]?.discountPercentage).toBe('68% off');
    expect(second[0]?.dealBadge).toBe('Limited time deal');
  });

  it('does zero extra work when an unsettled card did not change', () => {
    const card = doc(CARD).querySelector('[data-asin="B0CACHE001"]')!;
    const cache = new AmazonParseCache();
    let calls = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      cache.getOrParse(card, () => {
        calls += 1;
        return SAMPLE;
      });
    }
    expect(calls).toBe(1); // one parse, then signature matches
  });

  it('never re-parses a settled card, even when the DOM changes', () => {
    // SAD-383's guarantee, kept: once the price family is present, a later DOM
    // change must not rewrite the numbers the user was already shown.
    const card = doc(CARD).querySelector('[data-asin="B0CACHE001"]')!;
    card.appendChild(span('<span class="savingsPercentage">-68%</span>'));
    const cache = new AmazonParseCache();
    let calls = 0;
    cache.getOrParse(card, () => {
      calls += 1;
      return { ...SAMPLE, discountPercentage: '68% off' };
    });
    card.appendChild(span('<span>late noise without price-family evidence</span>'));
    cache.getOrParse(card, () => {
      calls += 1;
      return { ...SAMPLE, discountPercentage: '90% off' };
    });
    expect(calls).toBe(1);
  });

  it('still refuses to memoise an incomplete card, so hydration is picked up at once', () => {
    const cache = new AmazonParseCache();
    const withoutImage = doc(CARD.replace(/<img[^>]*>/, ''));
    const first = parseAmazonSearchResults(withoutImage, URL_SEARCH, { cache });
    expect(first[0]?.imageUrl).toBeFalsy();

    const img = withoutImage.createElement('img');
    img.className = 's-image';
    img.src = 'https://m.media-amazon.com/images/I/71late._AC_UY218_.jpg';
    withoutImage.querySelector('[data-asin="B0CACHE001"]')!.appendChild(img);

    const second = parseAmazonSearchResults(withoutImage, URL_SEARCH, { cache });
    expect(second[0]?.imageUrl).toContain('71late');
  });
});
