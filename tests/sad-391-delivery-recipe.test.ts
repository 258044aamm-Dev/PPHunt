/**
 * SAD-391 step 1 — the delivery recipe that `isPrime` is derived from.
 *
 * Real markup: `docs/plans/SAD-391-fixtures/*.real.html` (captured 2026-10-21
 * from a logged-out `/s?k=laptop`). Before this step the recipe took the first
 * `[aria-label]` of the block — the stock warning — and then skipped the text
 * fallback because `availability` was already set, so the card lost its
 * delivery message; and `textContent` of the "Join Prime" ingress carried the
 * inline `<style>`/`<script>` source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  extractCardDeliveryAndAvailability,
} from '@/engines/amazon/scraper/field-parsers';

const fixture = (name: string): string =>
  readFileSync(
    join(__dirname, '..', 'docs', 'plans', 'SAD-391-fixtures', name),
    'utf8',
  );

function cardFrom(html: string): Element {
  const doc = new DOMParser().parseFromString(
    `<html><body>${html}</body></html>`,
    'text/html',
  );
  const card = doc.querySelector('[data-component-type="s-search-result"]');
  if (!card) throw new Error('fixture has no s-search-result card');
  return card;
}

describe('extractCardDeliveryAndAvailability — unified delivery message (live 2025 markup)', () => {
  it('keeps the delivery message when a stock warning follows the UDM block, and strips the inline code of the Prime ingress', () => {
    const { delivery, availability } = extractCardDeliveryAndAvailability(
      cardFrom(fixture('search-card-join-prime-stock-warning.real.html')),
    );
    expect(availability).toBe('Only 7 left in stock - order soon.');
    expect(delivery).toBe(
      'Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26',
    );
    expect(delivery).not.toMatch(/\{color:|\(function|prime-brand-color/);
  });

  it('reads a plain primary message exactly as before', () => {
    const { delivery, availability } = extractCardDeliveryAndAvailability(
      cardFrom(fixture('search-card-free-delivery-no-prime.real.html')),
    );
    expect(delivery).toBe('FREE delivery Tomorrow, Oct 22');
    expect(availability).toBeNull();
  });

  it('joins primary and secondary messages and still returns the stock warning', () => {
    const { delivery, availability } = extractCardDeliveryAndAvailability(
      cardFrom(fixture('search-card-free-delivery-window-stock.real.html')),
    );
    expect(delivery).toBe(
      'FREE delivery Oct 28 - 29 Or fastest delivery Tue, Oct 27',
    );
    expect(availability).toBe('Only 11 left in stock - order soon.');
  });
});

describe('extractCardDeliveryAndAvailability — legacy markup is unchanged', () => {
  it('aria-label delivery message (the shape every existing fixture uses)', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0LEGACY01">
        <div data-cy="delivery-recipe">
          <span aria-label="FREE delivery Tomorrow, Oct 17">FREE delivery Tomorrow, Oct 17</span>
        </div>
      </div>`);
    expect(extractCardDeliveryAndAvailability(card)).toEqual({
      delivery: 'FREE delivery Tomorrow, Oct 17',
      availability: null,
    });
  });

  it('stock-only recipe (scraper-accuracy shape): availability set, no delivery invented', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0LEGACY02">
        <div data-cy="delivery-recipe">
          <span class="a-color-price">Only 4 left in stock - order soon.</span>
        </div>
      </div>`);
    expect(extractCardDeliveryAndAvailability(card)).toEqual({
      delivery: undefined,
      availability: 'Only 4 left in stock - order soon.',
    });
  });

  it('a stock-warning aria-label no longer hides a later delivery aria-label', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0LEGACY03">
        <div data-cy="delivery-recipe">
          <span aria-label="Only 2 left in stock - order soon."><span class="a-color-price">Only 2 left in stock - order soon.</span></span>
          <span aria-label="FREE delivery Mon, Oct 19">FREE delivery Mon, Oct 19</span>
        </div>
      </div>`);
    expect(extractCardDeliveryAndAvailability(card)).toEqual({
      delivery: 'FREE delivery Mon, Oct 19',
      availability: 'Only 2 left in stock - order soon.',
    });
  });

  it('plain-text recipe with a stock span: delivery keeps the message, not the warning', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0LEGACY04">
        <div data-cy="delivery-recipe">
          <span>FREE delivery Mon, Oct 19</span>
          <span class="a-color-price">Only 3 left in stock - order soon.</span>
        </div>
      </div>`);
    expect(extractCardDeliveryAndAvailability(card)).toEqual({
      delivery: 'FREE delivery Mon, Oct 19',
      availability: 'Only 3 left in stock - order soon.',
    });
  });

  it('no delivery recipe at all: nothing changes', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0LEGACY05">
        <span>In Stock</span>
      </div>`);
    expect(extractCardDeliveryAndAvailability(card)).toEqual({
      delivery: undefined,
      availability: 'In Stock',
    });
  });
});
