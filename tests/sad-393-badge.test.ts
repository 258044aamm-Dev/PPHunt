/**
 * SAD-393 step 1 — the `badge` field (Badge column) reads the badge Amazon
 * actually renders.
 *
 * Root cause (step-0 evidence, `docs/plans/SAD-393-step0-evidence-2026-10-21.md`):
 * Amazon moved Best Seller badges into the `amazonBadges` capsule
 * (`rio-badge-*` markup). Neither pre-SAD-393 `statusBadge` selector matches
 * it, so 14/14 live Best Seller cards lost the field while old-markup
 * Overall Pick cards (5/5) kept working — the reported intermittency.
 * Hand-authored fixtures could not see this (they model the old markup), so
 * the pins below replay verbatim captures from
 * `docs/plans/SAD-393-fixtures/` first; synthetic cards only isolate the
 * first-match and apostrophe regressions.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCardBadge } from '@/engines/amazon/scraper/field-parsers';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryCard } from '@/engines/amazon/scraper/category-page';
import { extractProductFromCard } from '@/engines/amazon/content/save-product';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'docs', 'plans', 'SAD-393-fixtures', name), 'utf8');

const SEARCH_URL = 'https://www.amazon.com/s?k=fixture';
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');

function searchDocWith(fixtureName: string): Document {
  return doc(`<div class="s-main-slot">${fixture(fixtureName)}</div>`);
}

function cardOf(d: Document, asin: string): Element {
  const card = d.querySelector(`[data-asin="${asin}"]`);
  if (!card) throw new Error(`fixture no longer contains card ${asin}`);
  return card;
}

describe('captured real cards (step-0 fixtures)', () => {
  it('rio-capsule Best Seller card: badge extracted, supplementary category not stored, deal stays a deal', () => {
    const products = parseAmazonSearchResults(
      searchDocWith('search-card-rio-bestseller-deal.real.html'),
      SEARCH_URL,
    );
    const product = products.find((p) => p.asin === 'B0725WFLMB')!;
    expect(product).toBeTruthy();
    // The capsule prints "Best Seller" + supplementary "in Bed Pillow
    // Pillowcases" — G1 stores the label only.
    expect(product.badge).toBe('Best Seller');
    // The printed deal on the same card is not a status badge, and the
    // status badge is not a deal (SAD-386 separation holds).
    expect(product.dealBadge).toBe('Limited time deal');
  });

  it('old-markup Overall Pick card: unchanged behaviour', () => {
    const products = parseAmazonSearchResults(
      searchDocWith('search-card-overall-pick.real.html'),
      SEARCH_URL,
    );
    const product = products.find((p) => p.asin === 'B0HDB173YV')!;
    expect(product).toBeTruthy();
    expect(product.badge).toBe('Overall Pick');
    expect(product.dealBadge).not.toBe('Overall Pick');
  });

  it('one-click save path (extractProductFromCard) gets the same badge as collection', () => {
    const card = cardOf(searchDocWith('search-card-rio-bestseller-deal.real.html'), 'B0725WFLMB');
    const saved = extractProductFromCard(card, SEARCH_URL);
    expect(saved?.badge).toBe('Best Seller');
  });

  it('category parser gets the same badge from the same card', () => {
    const card = cardOf(searchDocWith('search-card-rio-bestseller-deal.real.html'), 'B0725WFLMB');
    const product = parseAmazonCategoryCard(card, SEARCH_URL);
    expect(product?.badge).toBe('Best Seller');
  });
});

describe('extractCardBadge regressions (synthetic isolation)', () => {
  const cardWith = (inner: string) => {
    const d = doc(
      `<div data-component-type="s-search-result" data-asin="B0PROBE001">${inner}</div>`,
    );
    return d.querySelector('[data-asin]')!;
  };

  it('a deal node sharing .a-badge-label-inner does not end the search', () => {
    const card = cardWith(`
      <span class="a-badge" data-a-badge-type="deal"><span class="a-badge-label"><span class="a-badge-label-inner">Limited time deal</span></span></span>
      <span class="a-badge-label-inner">Best Seller</span>`);
    expect(extractCardBadge(card)).toBe('Best Seller');
  });

  it('a deal-only card yields no badge', () => {
    const card = cardWith(`
      <span class="a-badge" data-a-badge-type="deal"><span class="a-badge-label"><span class="a-badge-label-inner">Limited time deal</span></span></span>`);
    expect(extractCardBadge(card)).toBeUndefined();
  });

  it("Amazon's Choice with a curly apostrophe (U+2019) matches, page text stored verbatim", () => {
    const card = cardWith(`
      <span data-component-type="s-status-badge-component"><span class="a-badge-text">Amazon’s Choice</span></span>`);
    expect(extractCardBadge(card)).toBe('Amazon’s Choice');
  });

  it('rio capsule: stores the label only, never the supplementary category text', () => {
    const card = cardWith(`
      <div class="puis-status-badge-container">
        <div data-csa-c-slot-id="amazonBadges-search-badge" data-csa-c-content-id="BEST_SELLER">
          <div class="rio-badge-component"><div class="rio-badge-supplementary-group">
            <span class="rio-badge-label"><span>Best Seller</span></span>
            <span class="rio-badge-supplementary-text">in Yoga Mats</span>
          </div></div>
        </div>
      </div>`);
    expect(extractCardBadge(card)).toBe('Best Seller');
  });

  it('a rio node whose text is not a known status badge yields nothing (no fabrication)', () => {
    const card = cardWith(`
      <span class="rio-badge-label"><span>Climate Pledge Friendly</span></span>`);
    expect(extractCardBadge(card)).toBeUndefined();
  });
});
