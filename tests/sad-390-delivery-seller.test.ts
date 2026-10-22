import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  cleanSeller,
  extractCardDeliveryAndAvailability,
  extractCardSeller,
  extractCleanElementText,
   parseAmazonCategoryPage,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function readFixture(name: string): string {
  return readFileSync(
    join(process.cwd(), 'docs', 'plans', 'SAD-390-fixtures', name),
    'utf8',
  );
}

describe('SAD-390 Step 2: clean element text, seller normalization, and card delivery/seller extraction', () => {
  describe('extractCleanElementText', () => {
    it('strips script, style, noscript, template, and hidden/preload nodes without mutating the live DOM', () => {
      const doc = createDoc(`
        <div id="target">
          <div class="udm-primary-delivery-message">
            <a class="udm-sfx-prime-signup-trigger">
              <style>.prime-brand-color {color: #0064f9; }</style>
              <span class="prime-brand-color">Join Prime</span>
            </a>
            <script type="text/javascript">(function(){ window.P._namespace("udm"); })();</script>
            <noscript>Enable JS</noscript>
            <template><span>Template noise</span></template>
            <span class="aok-hidden">Hidden duplicate</span>
            <span class="a-popover-preload">Popover preload noise</span>
            to get FREE delivery <span class="a-text-bold">Fri, Oct 23</span>
          </div><div class="udm-secondary-delivery-message">Or Non-members get FREE delivery <span class="a-text-bold">Mon, Oct 26</span></div>
        </div>
      `);
      const target = doc.getElementById('target')!;
      const scriptCountBefore = target.querySelectorAll('script, style').length;

      const text = extractCleanElementText(target);

      expect(text).toBe(
        'Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26',
      );
      expect(target.querySelectorAll('script, style').length).toBe(
        scriptCountBefore,
      );
    });
  });

  describe('cleanSeller', () => {
    it('normalizes legacy, colon-separated, abbreviated ODF, and localized seller strings', () => {
      expect(cleanSeller('Ships from and sold by Amazon.com.')).toBe(
        'Amazon.com',
      );
      expect(
        cleanSeller('Sold by AnkerDirect and Fulfilled by Amazon.'),
      ).toBe('AnkerDirect');
      expect(cleanSeller('Sold by: Amazon.com')).toBe('Amazon.com');
      expect(
        cleanSeller('Ships from: Amazon.com Sold by: Amazon.com'),
      ).toBe('Amazon.com');
      expect(
        cleanSeller(
          'Ships from: Amazon Sold by: EVERJOY TECH TRADING LIMITED',
        ),
      ).toBe('EVERJOY TECH TRADING LIMITED');
      expect(cleanSeller('Shipper / Seller Amazon.com')).toBe('Amazon.com');
      expect(cleanSeller('Verkauf durch: AnkerDirect')).toBe('AnkerDirect');
      expect(cleanSeller('Vendu par : Amazon.fr')).toBe('Amazon.fr');
      expect(cleanSeller('Vendido por: Amazon.es')).toBe('Amazon.es');
    });

    it('rejects standalone fulfillment labels and empty/header-only tokens', () => {
      expect(cleanSeller('Fulfilled by Amazon')).toBeNull();
      expect(cleanSeller('Shipper / Seller')).toBeNull();
      expect(cleanSeller('Sold by')).toBeNull();
      expect(cleanSeller('Ships from')).toBeNull();
      expect(cleanSeller('   ')).toBeNull();
      expect(cleanSeller(null)).toBeNull();
    });
  });

  describe('Search & Category Card delivery and seller extraction', () => {
    it('extracts clean delivery without <style>/<script> leakage or row concatenation on verbatim Moli card B01GJOMWVA', () => {
      const html = `<div class="s-main-slot">${readFixture('search-card-prime-upsell-script.real.html')}</div>`;
      const doc = createDoc(html);

      const results = parseAmazonSearchResults(
        doc,
        'https://www.amazon.com/s?k=coffee+maker',
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.asin).toBe('B01GJOMWVA');
      expect(results[0]?.delivery).toBe(
        'Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26 on $35 of items shipped by Amazon',
      );
      expect(results[0]?.delivery).not.toContain('prime-brand-color');
      expect(results[0]?.delivery).not.toContain('window.P._namespace');
      expect(results[0]?.isPrime).toBe(true);
    });

    it('extracts BOTH delivery and low-stock availability on verbatim Moli card B0FTZZYP24', () => {
      const html = `<div class="s-main-slot">${readFixture('search-card-delivery-and-low-stock.real.html')}</div>`;
      const doc = createDoc(html);

      const results = parseAmazonSearchResults(
        doc,
        'https://www.amazon.com/s?k=coffee+maker',
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.asin).toBe('B0FTZZYP24');
      expect(results[0]?.delivery).toBe('FREE delivery Oct 28 - 30');
      expect(results[0]?.availability).toBe(
        'Only 14 left in stock - order soon.',
      );
    });

    it('keeps delivery undefined when [data-cy="delivery-recipe"] contains only a stock notice', () => {
      const doc = createDoc(`
        <div data-component-type="s-search-result" data-asin="B08N5WRWNW">
          <div data-cy="delivery-recipe">
            <span aria-label="Only 4 left in stock - order soon.">
              <span class="a-color-price">Only 4 left in stock - order soon.</span>
            </span>
          </div>
        </div>
      `);
      const card = doc.querySelector('[data-asin="B08N5WRWNW"]')!;
      const extracted = extractCardDeliveryAndAvailability(card);

      expect(extracted.availability).toBe('Only 4 left in stock - order soon.');
      expect(extracted.delivery).toBeUndefined();
    });

    it('finds a later delivery [aria-label] when an earlier [aria-label] inside delivery-recipe is not a delivery message', () => {
      const doc = createDoc(`
        <div data-component-type="s-search-result" data-asin="B0ARIA0002">
          <div data-cy="delivery-recipe">
            <span aria-label="Amazon Prime"></span>
            <span aria-label="FREE delivery Tomorrow, Oct 23">FREE delivery Tomorrow, Oct 23</span>
          </div>
        </div>
      `);
      const card = doc.querySelector('[data-asin="B0ARIA0002"]')!;
      const extracted = extractCardDeliveryAndAvailability(card);

      expect(extracted.delivery).toBe('FREE delivery Tomorrow, Oct 23');
    });

    it('falls back to [data-csa-c-content-id*="delivery"] when [data-cy="delivery-recipe"] is absent (category/deals card)', () => {
      const doc = createDoc(`
        <div id="gridItemRoot" class="zg-grid-general-faceout" data-asin="B0CATDEL01">
          <a href="/dp/B0CATDEL01"><h2><span>Category Product</span></h2></a>
          <span class="a-price"><span class="a-offscreen">$29.99</span></span>
          <div data-csa-c-content-id="delivery-promise">FREE delivery Tue, Oct 27</div>
          <img src="https://m.media-amazon.com/images/I/cat._AC_UL320_.jpg" />
        </div>
      `);
      const results = parseAmazonCategoryPage(
        doc,
        'https://www.amazon.com/Best-Sellers/zgbs',
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.delivery).toBe('FREE delivery Tue, Oct 27');
    });

    it('extracts card seller from secondary-offer-recipe with colon or ships-from prefix and ignores More Buying Choices noise', () => {
      const cardWithSeller = createDoc(`
        <div data-component-type="s-search-result" data-asin="B0SELL0001">
          <div data-cy="secondary-offer-recipe">
            <style>.offer-style{}</style>
            <span>Ships from: Amazon Sold by: AnkerDirect</span>
          </div>
        </div>
      `).querySelector('[data-asin="B0SELL0001"]')!;
      expect(extractCardSeller(cardWithSeller)).toBe('AnkerDirect');

      const cardWithMoreBuyingChoices = createDoc(`
        <div data-component-type="s-search-result" data-asin="B0SELL0002">
          <div data-cy="secondary-offer-recipe">
            <span>More Buying Choices $24.99 (12 used &amp; new offers)</span>
          </div>
        </div>
      `).querySelector('[data-asin="B0SELL0002"]')!;
      expect(extractCardSeller(cardWithMoreBuyingChoices)).toBeNull();
    });
  });
});
