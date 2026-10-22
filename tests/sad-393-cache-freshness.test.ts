/**
 * SAD-393 step 3 — a late status badge must not be frozen out by the parse
 * cache.
 *
 * Before this step the cache modelled only the rating row (SAD-383) and the
 * price family (SAD-386). A card memoised before its badge existed answered
 * `badge: undefined` for the rest of the run through two distinct paths:
 * (a) the price-family fast path settled the card unconditionally;
 * (b) the rating-complete path required `%`/deal evidence a badge-only
 * injection does not carry. Both are pinned below, alongside the guards
 * that keep SAD-383/386 guarantees: unchanged cards are never re-parsed,
 * evidence-free DOM noise rewrites nothing, and a card that already has its
 * badge is settled.
 */
import { describe, expect, it } from 'vitest';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';

const URL_SEARCH = 'https://www.amazon.com/s?k=badge';

function product(overrides: Partial<ScrapedAmazonProduct> = {}): ScrapedAmazonProduct {
  return {
    asin: 'B0CACHE393',
    url: 'https://www.amazon.com/dp/B0CACHE393',
    title: 'Late Badge Widget',
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 1234,
    imageUrl: 'https://m.media-amazon.com/images/I/71badge.jpg',
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

const RIO_BADGE =
  '<div data-csa-c-slot-id="amazonBadges-search-badge" data-csa-c-content-id="BEST_SELLER">' +
  '<span class="rio-badge-label"><span>Best Seller</span></span></div>';

function bareCard(): HTMLDivElement {
  const card = document.createElement('div');
  card.innerHTML = '<h2>Late Badge Widget</h2>';
  return card;
}

function appendHtml(card: Element, html: string): void {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  card.appendChild(holder.firstElementChild!);
}

describe('SAD-393 parse cache: the status badge joins the freshness rule', () => {
  it('(b) rating-complete card: a badge-only DOM change re-reads the card', () => {
    const card = bareCard();
    const cache = new AmazonParseCache();
    let calls = 0;

    const first = cache.getOrParse(card, () => {
      calls += 1;
      return product();
    });
    expect(first?.badge).toBeUndefined();
    expect(calls).toBe(1);

    appendHtml(card, RIO_BADGE);

    const second = cache.getOrParse(card, () => {
      calls += 1;
      return product({ badge: 'Best Seller' });
    });
    expect(calls).toBe(2);
    expect(second?.badge).toBe('Best Seller');
  });

  it('(a) price-family-settled card: badge evidence still re-reads, badge-free noise does not', () => {
    const card = bareCard();
    const cache = new AmazonParseCache();
    let calls = 0;
    const parse = (badge?: string) => () => {
      calls += 1;
      return product({ dealBadge: 'Limited time deal', badge });
    };

    cache.getOrParse(card, parse());
    expect(calls).toBe(1);

    // A DOM change with no badge evidence: SAD-386's fast path holds.
    appendHtml(card, '<span>late noise without badge evidence</span>');
    cache.getOrParse(card, parse('Best Seller'));
    expect(calls).toBe(1);

    // The badge capsule arrives: the card is re-read exactly once.
    appendHtml(card, RIO_BADGE);
    const after = cache.getOrParse(card, parse('Best Seller'));
    expect(calls).toBe(2);
    expect(after?.badge).toBe('Best Seller');
  });

  it('unchanged badgeless card parses exactly once across passes', () => {
    const card = bareCard();
    const cache = new AmazonParseCache();
    let calls = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      cache.getOrParse(card, () => {
        calls += 1;
        return product();
      });
    }
    expect(calls).toBe(1);
  });

  it('a card that already carries badge + price family is settled even when the DOM changes', () => {
    const card = bareCard();
    const cache = new AmazonParseCache();
    let calls = 0;
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ badge: 'Best Seller', discountPercentage: '40% off' });
    });
    appendHtml(card, RIO_BADGE);
    appendHtml(card, '<span>more noise</span>');
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ badge: 'Overall Pick', discountPercentage: '99% off' });
    });
    expect(calls).toBe(1);
  });

  it('a deal-badge node is not status-badge evidence', () => {
    const card = bareCard();
    const cache = new AmazonParseCache();
    let calls = 0;
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ dealBadge: 'Limited time deal' });
    });
    appendHtml(
      card,
      '<span class="a-badge" data-a-badge-type="deal"><span class="a-badge-label-inner">Limited time deal</span></span>',
    );
    cache.getOrParse(card, () => {
      calls += 1;
      return product({ dealBadge: 'Limited time deal', badge: 'Best Seller' });
    });
    expect(calls).toBe(1);
  });

  it('real parser: a settled deal card gains its badge when the capsule appears', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="s-main-slot">
        <div data-component-type="s-search-result" data-asin="B0CACHE393">
          <div data-cy="title-recipe"><a class="a-link-normal" href="/dp/B0CACHE393"><h2><span>Late Badge Widget</span></h2></a></div>
          <span aria-label="4.5 out of 5 stars"><i class="a-icon a-icon-star-small"><span class="a-icon-alt">4.5 out of 5 stars</span></i></span>
          <div data-cy="price-recipe">
            <span class="a-price"><span class="a-offscreen">$19.99</span></span>
            <span data-a-badge-type="deal"><span class="a-badge-text">Limited time deal</span></span>
          </div>
          <img class="s-image" src="https://m.media-amazon.com/images/I/71badge.jpg" />
        </div>
      </div>`,
      'text/html',
    );
    const cache = new AmazonParseCache();

    const first = parseAmazonSearchResults(doc, URL_SEARCH, { cache });
    expect(first[0]?.dealBadge).toBe('Limited time deal');
    expect(first[0]?.badge).toBeUndefined();

    appendHtml(doc.querySelector('[data-asin="B0CACHE393"]')!, RIO_BADGE);

    const second = parseAmazonSearchResults(doc, URL_SEARCH, { cache });
    expect(second[0]?.badge).toBe('Best Seller');
    expect(second[0]?.dealBadge).toBe('Limited time deal');
  });
});
