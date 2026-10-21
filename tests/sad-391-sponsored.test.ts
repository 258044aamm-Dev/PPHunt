/**
 * SAD-391 step 3 — `isSponsored`: real 2025 Sponsored Products markup, the
 * localized labels, the ad-disclosure hooks, one detector for the save path,
 * the duplicate-primary placement (D8) and the PDP URL classification.
 *
 * Markup provenance:
 * - `docs/plans/SAD-391-fixtures/sponsored-card-2025.external.html`: real
 *   amazon.com SP card (crawl4ai example, June 2025).
 * - "Featured from Amazon brands" guard: those tiles reuse
 *   `.puis-sponsored-label-text` with a different label (Shpigford/knockoff
 *   styles.css comment) and must stay organic.
 * - URL shapes: live `/s?k=laptop` capture 2026-10-21 — ad links carry
 *   `sp_csd=` and `/ref=…_sspa`, organic links `/ref=sr_1_N`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractCardIsSponsored } from '@/engines/amazon/scraper/field-parsers';
import { parseSearchResults } from '@/engines/amazon/scraper/search-results';
import { parseProductDetail } from '@/engines/amazon/scraper/product-detail';
import { appendProductPlacement } from '@/engines/amazon/scraper/dedup';
import {
  AMAZON_SPONSORED_LEAF_PATTERN,
  AMAZON_SPONSORED_WORD_PATTERN,
} from '@/engines/amazon/scraper/selectors';
import { isSponsoredDetailUrl } from '@/engines/amazon/utils/amazon-url';
import { matchesListingCategoryFilter } from '@/engines/amazon/utils/listing-category';
import { buildSaveContext } from '@/engines/amazon/content/save-product';
import type { ScrapedAmazonProduct } from '@/engines/amazon/types';

const fixture = (name: string): string =>
  readFileSync(
    join(__dirname, '..', 'docs', 'plans', 'SAD-391-fixtures', name),
    'utf8',
  );

const createDoc = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html');

function cardFrom(html: string): Element {
  const card = createDoc(`<html><body>${html}</body></html>`).querySelector(
    '[data-component-type="s-search-result"]',
  );
  if (!card) throw new Error('no s-search-result card in markup');
  return card;
}

const SP_INNER = fixture('sponsored-card-2025.external.html');
const spCard = (extraClass = '') =>
  `<div data-component-type="s-search-result" data-asin="B081XSYZMS" class="s-result-item s-asin ${extraClass}">${SP_INNER}</div>`;

const organicCard = (asin: string, title = 'Wireless Earbuds') => `
  <div data-component-type="s-search-result" data-asin="${asin}" class="s-result-item s-asin">
    <h2 aria-label="${title}"><a href="/x/dp/${asin}/ref=sr_1_2"><span>${title}</span></a></h2>
    <span class="a-price"><span class="a-offscreen">$19.99</span></span>
    <div data-cy="delivery-recipe"><span aria-label="FREE delivery Tomorrow, Oct 22">FREE delivery Tomorrow, Oct 22</span></div>
  </div>`;

const sponsoredCard = (asin: string, title = 'Wireless Earbuds') => `
  <div data-component-type="s-search-result" data-asin="${asin}" class="s-result-item s-asin AdHolder">
    <div class="a-row a-spacing-micro"><a class="puis-label-popover puis-sponsored-label-text" href="javascript:void(0)"><span aria-label="View Sponsored information or leave ad feedback">Sponsored</span></a></div>
    <h2 aria-label="${title}"><a href="/sspa/click?ie=UTF8&amp;url=%2Fx%2Fdp%2F${asin}%2Fref%3Dsr_1_1_sspa"><span>${title}</span></a></h2>
    <span class="a-price"><span class="a-offscreen">$18.99</span></span>
  </div>`;

/** Amazon's own "Featured from Amazon brands" tile: same label class, different label. */
const FAB_CARD = `
  <div data-component-type="s-search-result" data-asin="B0FABTILE1" class="s-result-item s-asin">
    <div class="a-row"><a class="puis-label-popover puis-sponsored-label-text" href="javascript:void(0)"><span aria-label="Featured from Amazon brands information">Featured from Amazon brands</span></a></div>
    <h2 aria-label="Amazon Basics Cable"><a href="/x/dp/B0FABTILE1/ref=sr_1_4"><span>Amazon Basics Cable</span></a></h2>
    <span class="a-price"><span class="a-offscreen">$7.99</span></span>
  </div>`;

describe('isSponsored — real 2025 Sponsored Products card', () => {
  it('is sponsored with and without the AdHolder class', () => {
    expect(extractCardIsSponsored(cardFrom(spCard('AdHolder')))).toBe(true);
    expect(extractCardIsSponsored(cardFrom(spCard()))).toBe(true);
  });

  it('parses end-to-end as a sponsored search row', () => {
    const [row] = parseSearchResults(
      createDoc(`<div class="s-main-slot">${spCard()}</div>`),
      'https://www.amazon.com/s?k=laptop',
    );
    expect(row?.asin).toBe('B081XSYZMS');
    expect(row?.isSponsored).toBe(true);
    expect(row?.isPrime).toBe(false);
  });
});

describe('isSponsored — what must stay organic', () => {
  it('"Featured from Amazon brands" tile (label class reused, no Sponsored word) → false', () => {
    expect(extractCardIsSponsored(cardFrom(FAB_CARD))).toBe(false);
  });

  it('a title that merely contains the word "sponsored" → false', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0TITLEWD1" class="s-result-item s-asin">
        <h2 aria-label="Sponsored by Nobody — the independent creator's handbook"><a href="/x/dp/B0TITLEWD1/ref=sr_1_7"><span aria-label="Sponsored by Nobody — the independent creator's handbook">Sponsored by Nobody — the independent creator's handbook</span></a></h2>
        <span class="a-price"><span class="a-offscreen">$12.00</span></span>
      </div>`);
    expect(extractCardIsSponsored(card)).toBe(false);
  });

  it('plain organic card → false', () => {
    expect(extractCardIsSponsored(cardFrom(organicCard('B0ORGANIC1')))).toBe(false);
  });
});

describe('isSponsored — localized labels and ad-disclosure hooks', () => {
  const labels = [
    'Sponsored',
    'Gesponsert',
    'Sponsorisé',
    'Sponsorizzato',
    'Patrocinado',
    'Gesponsord',
    'Sponsrad',
    'Sponsorowane',
    'Sponsorlu',
    'スポンサー',
  ];

  it.each(labels)('leaf text "%s" → true', (label) => {
    expect(AMAZON_SPONSORED_LEAF_PATTERN.test(label)).toBe(true);
    const card = cardFrom(
      `<div data-component-type="s-search-result" data-asin="B0LOCALE01" class="s-result-item s-asin"><div class="a-row"><span>${label}</span></div><h2><span>Produkt</span></h2></div>`,
    );
    expect(extractCardIsSponsored(card)).toBe(true);
  });

  it.each(labels)('label element with aria-label containing "%s" → true', (label) => {
    expect(AMAZON_SPONSORED_WORD_PATTERN.test(`${label} info`)).toBe(true);
    const card = cardFrom(
      `<div data-component-type="s-search-result" data-asin="B0LOCALE02" class="s-result-item s-asin"><a class="puis-label-popover puis-sponsored-label-text"><span aria-label="${label} — Informationen">${label}</span></a><h2><span>Produkt</span></h2></div>`,
    );
    expect(extractCardIsSponsored(card)).toBe(true);
  });

  it('the leaf pattern is whole-word only', () => {
    expect(AMAZON_SPONSORED_LEAF_PATTERN.test('Sponsored by Nobody')).toBe(false);
    expect(AMAZON_SPONSORED_LEAF_PATTERN.test('Featured from Amazon brands')).toBe(false);
  });

  it('[data-ad-feedback-label-id] alone → true', () => {
    const card = cardFrom(
      '<div data-component-type="s-search-result" data-asin="B0ADFEEDB1" class="s-result-item s-asin"><div data-ad-feedback-label-id="B0ADFEEDB1"></div><h2><span>Item</span></h2></div>',
    );
    expect(extractCardIsSponsored(card)).toBe(true);
  });

  it('the sp-info-popover trigger alone → true', () => {
    const card = cardFrom(
      '<div data-component-type="s-search-result" data-asin="B0SPINFOP1" class="s-result-item s-asin"><a data-a-popover="{&quot;name&quot;:&quot;sp-info-popover-B0SPINFOP1&quot;,&quot;position&quot;:&quot;triggerVertical&quot;}"></a><h2><span>Item</span></h2></div>',
    );
    expect(extractCardIsSponsored(card)).toBe(true);
  });
});

describe('save path uses the same detector (buildSaveContext)', () => {
  it('FAB tile → organic, SP card → sponsored, both equal to extractCardIsSponsored', () => {
    const doc = createDoc(
      `<html><body><div class="s-main-slot">${FAB_CARD}${spCard()}${organicCard('B0ORGANIC2')}</div></body></html>`,
    );
    const cards = Array.from(doc.querySelectorAll('[data-component-type="s-search-result"]'));
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      const context = buildSaveContext(card, 'https://www.amazon.com/s?k=cable', 'card-button', doc);
      expect(context.pageType).toBe('search');
      expect(context.listingCategory).toBe(
        extractCardIsSponsored(card) ? 'sponsored' : 'organic',
      );
    }
    expect(buildSaveContext(cards[0]!, 'https://www.amazon.com/s?k=cable', 'card-button', doc).listingCategory).toBe('organic');
    expect(buildSaveContext(cards[1]!, 'https://www.amazon.com/s?k=cable', 'card-button', doc).listingCategory).toBe('sponsored');
  });
});

describe('duplicate primary cards of one ASIN (D8)', () => {
  const PAGE = 'https://www.amazon.com/s?k=earbuds';

  it('organic first, sponsored ad later: first row kept, Sponsored Search placement recorded', () => {
    const rows = parseSearchResults(
      createDoc(`<div class="s-main-slot">${organicCard('B0DUPASIN1')}${sponsoredCard('B0DUPASIN1')}</div>`),
      PAGE,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.isSponsored).toBe(false);
    expect(row.price).toBe(19.99);
    expect(row.placements).toEqual(['Organic Search', 'Sponsored Search']);
    expect(matchesListingCategoryFilter(row, 'sponsored')).toBe(true);
    expect(matchesListingCategoryFilter(row, 'organic')).toBe(true);
  });

  it('sponsored ad first, organic later: ad row kept, Organic Search placement recorded', () => {
    const rows = parseSearchResults(
      createDoc(`<div class="s-main-slot">${sponsoredCard('B0DUPASIN2')}${organicCard('B0DUPASIN2')}</div>`),
      PAGE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isSponsored).toBe(true);
    expect(rows[0]!.placements).toEqual(['Sponsored Search', 'Organic Search']);
  });

  it('two organic cards of one ASIN: nothing is invented', () => {
    const rows = parseSearchResults(
      createDoc(`<div class="s-main-slot">${organicCard('B0DUPASIN3')}${organicCard('B0DUPASIN3')}</div>`),
      PAGE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.placements).toBeUndefined();
  });

  it('appendProductPlacement is a pure union', () => {
    const row = { asin: 'B0UNIONTST', isSponsored: false } as unknown as ScrapedAmazonProduct;
    expect(appendProductPlacement(row, 'Organic Search')).toBe(false);
    expect(row.placements).toBeUndefined();
    expect(appendProductPlacement(row, 'Sponsored Search')).toBe(true);
    expect(row.placements).toEqual(['Organic Search', 'Sponsored Search']);
    expect(appendProductPlacement(row, 'Sponsored Search')).toBe(false);
  });
});

describe('PDP isSponsored from the visited URL', () => {
  it('isSponsoredDetailUrl recognises the ad URL shapes only', () => {
    expect(
      isSponsoredDetailUrl(
        'https://www.amazon.com/HP-Laptop/dp/B0GQB2F5NF/ref=sr_1_1_sspa?dib=abc&keywords=laptop&sp_csd=d2lkZ2V0TmFtZT1zcF9hdGY&psc=1',
      ),
    ).toBe(true);
    expect(isSponsoredDetailUrl('https://www.amazon.com/dp/B0GQB2F5NF/ref=sr_1_1_sspa')).toBe(true);
    expect(isSponsoredDetailUrl('https://www.amazon.com/sspa/click?ie=UTF8&url=%2Fdp%2FB0GQB2F5NF')).toBe(true);
    expect(isSponsoredDetailUrl('https://www.amazon.com/HP-Laptop/dp/B0GQB2F5NF/ref=sr_1_3?dib=abc&keywords=laptop')).toBe(false);
    expect(isSponsoredDetailUrl('https://www.amazon.com/dp/B0GQB2F5NF')).toBe(false);
    expect(isSponsoredDetailUrl('https://www.amazon.de/dp/B0GQB2F5NF?th=1&psc=1')).toBe(false);
    expect(isSponsoredDetailUrl('')).toBe(false);
    expect(isSponsoredDetailUrl(undefined)).toBe(false);
  });

  const PDP = `
    <html><head><link rel="canonical" href="https://www.amazon.com/dp/B0GQB2F5NF" /></head><body>
      <h1 id="title"><span id="productTitle">HP 15.6" Laptop</span></h1>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$329.00</span></span></div>
      <div id="buybox"><div id="availability"><span>In Stock</span></div></div>
    </body></html>`;

  it('reached through a Sponsored Products click → isSponsored true, URL still canonical', () => {
    const product = parseProductDetail(
      createDoc(PDP),
      'https://www.amazon.com/HP-Laptop/dp/B0GQB2F5NF/ref=sr_1_1_sspa?keywords=laptop&sp_csd=d2lkZ2V0TmFtZT1zcF9hdGY&psc=1',
    );
    expect(product?.isSponsored).toBe(true);
    expect(product?.url).toBe('https://www.amazon.com/dp/B0GQB2F5NF');
  });

  it('organic result click and canonical (enrichment) URL → false', () => {
    expect(
      parseProductDetail(createDoc(PDP), 'https://www.amazon.com/HP-Laptop/dp/B0GQB2F5NF/ref=sr_1_3?keywords=laptop')
        ?.isSponsored,
    ).toBe(false);
    expect(parseProductDetail(createDoc(PDP), 'https://www.amazon.com/dp/B0GQB2F5NF')?.isSponsored).toBe(false);
  });
});
