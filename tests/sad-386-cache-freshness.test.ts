/**
 * SAD-386 step 4 — a card that hydrated its badge late must still be re-read.
 *
 * Probe P04-P06 measured the bug: the same DOM answered `null` when the cache
 * had memoised the card before hydration and `"68% off"` when it had not. These
 * tests pin the fix (a 2 s freshness window, injectable clock) and the two
 * performance invariants the cache exists for.
 */
import { describe, expect, it } from 'vitest';
import { AmazonParseCache, parseAmazonSearchResults } from '@/engines/amazon/scraper';
import { DEFAULT_PARSE_CACHE_TTL_MS } from '@/engines/amazon/scraper/parse-cache';

const URL_SEARCH = 'https://www.amazon.com/s?k=deal';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

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

/** Appends the badge and the percentage the page hydrates a moment later. */
function hydrate(d: Document): void {
  const price = d.querySelector('[data-cy="price-recipe"]')!;
  const badge = d.createElement('span');
  badge.className = 'a-badge-text';
  badge.setAttribute('data-a-badge-type', 'deal');
  badge.textContent = 'Limited time deal';
  price.appendChild(badge);
  const pct = d.createElement('span');
  pct.className = 'savingsPercentage';
  pct.textContent = '-68%';
  price.appendChild(pct);
}

describe('SAD-386: parse-cache freshness', () => {
  it('defaults to a short, documented window', () => {
    expect(new AmazonParseCache().ttlMs).toBe(DEFAULT_PARSE_CACHE_TTL_MS);
    expect(DEFAULT_PARSE_CACHE_TTL_MS).toBe(2000);
  });

  it('re-reads a card once its memoised entry is older than the window', () => {
    let clock = 1_000;
    const cache = new AmazonParseCache({ ttlMs: 2000, now: () => clock });
    const d = doc(CARD);

    const first = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(first[0]?.discountPercentage).toBeUndefined();
    expect(first[0]?.dealBadge).toBeUndefined();

    hydrate(d);

    // Within the window the memoised answer is served (the performance contract).
    clock += 100;
    const inside = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(inside[0]?.discountPercentage).toBeUndefined();
    expect(inside[0]?.dealBadge).toBeUndefined();

    // After the window the card is re-parsed and the late data appears.
    clock += 2_500;
    const after = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(after[0]?.discountPercentage).toBe('68% off');
    expect(after[0]?.dealBadge).toBe('Limited time deal');
  });

  it('keeps the zero-work promise for an immediate second pass', () => {
    const cache = new AmazonParseCache();
    const d = doc(CARD);
    const first = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(first).toHaveLength(1);
    const second = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(first[0]); // served from the cache, identical object
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

  it('ttlMs = Infinity restores the previous permanent behaviour', () => {
    let clock = 1_000;
    const cache = new AmazonParseCache({ ttlMs: Number.POSITIVE_INFINITY, now: () => clock });
    const d = doc(CARD);
    parseAmazonSearchResults(d, URL_SEARCH, { cache });
    hydrate(d);
    clock += 60_000;
    const after = parseAmazonSearchResults(d, URL_SEARCH, { cache });
    expect(after[0]?.dealBadge).toBeUndefined();
  });
});
