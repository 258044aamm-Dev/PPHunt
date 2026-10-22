import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  cleanSeller,
  createFieldDiagnosticsCollector,
  extractCardDeliveryAndAvailability,
  extractCardSeller,
  extractCleanElementText,
  parseAmazonCategoryPage,
  parseAmazonProductDetail,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';
import { mergeDetailIntoStored } from '@/engines/amazon/background/enrich-saved-product';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import type { Product } from '@/engines/amazon/types';

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

  describe('SAD-390 Step 3: PDP seller and delivery extraction (ODF, accordion scoping, scripts, JSON-LD, enrichment)', () => {
    it('extracts 1P seller "Amazon.com" from ODF desktop-merchant-info on verbatim Moli fixture B0G66ZJG3Y', () => {
      const html = readFixture('pdp-1p-odf-merchant-info.real.html');
      const doc = createDoc(html);
      const collector = createFieldDiagnosticsCollector();

      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B0G66ZJG3Y',
        collector,
      );
      const fields = new Map(
        collector.build().fields.map((entry) => [entry.field, entry]),
      );

      expect(product).not.toBeNull();
      expect(product?.asin).toBe('B0G66ZJG3Y');
      expect(product?.seller).toBe('Amazon.com');
      expect(product?.delivery).toBe('FREE delivery Monday, October 26');
      expect(fields.get('seller')).toMatchObject({
        status: 'EXTRACTED',
        source: 'dom',
        selector:
          '[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message',
      });
      expect(fields.get('delivery')).toMatchObject({
        status: 'EXTRACTED',
        source: 'dom',
      });
    });

    it('extracts active 1P seller "Amazon.com" and active delivery instead of collapsed #usedAccordionRow "Amazon Resale" on verbatim Moli fixture B00AHAWWO0', () => {
      const html = readFixture('pdp-1p-accordion-with-used-row.real.html');
      const doc = createDoc(html);

      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B00AHAWWO0',
      );

      expect(product).not.toBeNull();
      expect(product?.asin).toBe('B00AHAWWO0');
      expect(product?.seller).toBe('Amazon.com');
      expect(product?.delivery).toBe(
        'FREE delivery Monday, October 26 on orders shipped by Amazon over $35',
      );
    });

    it('prefers active 1P accordion row over an inactive accordion row that contains #sellerProfileTriggerId', () => {
      const doc = createDoc(`
        <!doctype html>
        <html>
          <body>
            <span id="productTitle">Multi-Accordion Product</span>
            <div id="corePriceDisplay_desktop_feature_div">
              <span class="a-price"><span class="a-offscreen">$49.99</span></span>
            </div>
            <div id="buyBoxAccordion">
              <div id="newAccordionRow_0" data-csa-c-is-in-initial-active-row="true">
                <div id="merchantInfoFeature_feature_div">
                  <div class="offer-display-feature-text" offer-display-feature-name="desktop-merchant-info">
                    <span class="offer-display-feature-text-message">Amazon.com</span>
                  </div>
                </div>
              </div>
              <div id="newAccordionRow_1" data-csa-c-is-in-initial-active-row="false">
                <a id="sellerProfileTriggerId">RightBox</a>
              </div>
            </div>
            <img id="landingImage" src="https://m.media-amazon.com/images/I/multi._AC_SL1500_.jpg" />
          </body>
        </html>
      `);

      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B07ZPKN6YR',
      );

      expect(product?.seller).toBe('Amazon.com');
    });

    it('extracts seller from #shipFromSoldByAbbreviatedODF_feature_div when #merchantInfoFeature_feature_div is absent', () => {
      const doc = createDoc(`
        <!doctype html>
        <html>
          <body>
            <span id="productTitle">Abbreviated ODF Product</span>
            <div id="corePriceDisplay_desktop_feature_div">
              <span class="a-price"><span class="a-offscreen">$24.99</span></span>
            </div>
            <div id="shipFromSoldByAbbreviatedODF_feature_div">
              <div class="a-row"><span>Ships from:</span><span>Amazon.com</span></div>
              <div class="a-row"><span>Sold by:</span><span>Amazon.com</span></div>
            </div>
            <img id="landingImage" src="https://m.media-amazon.com/images/I/abbr._AC_SL1500_.jpg" />
          </body>
        </html>
      `);

      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B00MNV8E0C',
      );

      expect(product?.seller).toBe('Amazon.com');
    });

    it('falls back to secondary/Used offer container on Used-only PDPs (#usedOnlyBuybox)', () => {
      const doc = createDoc(`
        <!doctype html>
        <html>
          <body>
            <span id="productTitle">AMD Ryzen 9 5900X</span>
            <div id="usedOnlyBuybox">
              <div id="usedbuyBox">
                <a id="sellerProfileTriggerId">Amazon Resale</a>
                <div id="deliveryBlockMessage">
                  <div id="mir-layout-DELIVERY_BLOCK">
                    FREE delivery Tuesday, October 27
                    <style>.prime-brand-color{color:#0064f9;}</style>
                    <script type="text/javascript">(function(){ window.P._namespace("udm"); })();</script>
                  </div>
                </div>
              </div>
            </div>
            <img id="landingImage" src="https://m.media-amazon.com/images/I/ryzen._AC_SL1500_.jpg" />
          </body>
        </html>
      `);

      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B09V3KXJPB',
      );

      expect(product?.seller).toBe('Amazon Resale');
      expect(product?.delivery).toBe('FREE delivery Tuesday, October 27');
      expect(product?.delivery).not.toContain('window.P._namespace');
    });

    it('ignores "Fulfilled by Amazon" anchor inside #merchant-info and extracts the actual seller from #merchant-info text', () => {
      const doc = createDoc(`
        <!doctype html>
        <html>
          <body>
            <span id="productTitle">Legacy Merchant Info Product</span>
            <div id="merchant-info">
              Sold by Acme Electronics and <a href="/gp/help/customer/display.html">Fulfilled by Amazon</a>.
            </div>
            <img id="landingImage" src="https://m.media-amazon.com/images/I/acme._AC_SL1500_.jpg" />
          </body>
        </html>
      `);

      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B0ACME0001',
      );

      expect(product?.seller).toBe('Acme Electronics');
    });

    it('falls back to JSON-LD offers.seller.name when DOM seller node is absent', () => {
      const doc = createDoc(`
        <!doctype html>
        <html>
          <body>
            <span id="productTitle">JSON-LD Seller Product</span>
            <img id="landingImage" src="https://m.media-amazon.com/images/I/jsonld._AC_SL1500_.jpg" />
            <script type="application/ld+json">
              {
                "@type": "Product",
                "name": "JSON-LD Seller Product",
                "sku": "B0JSONLD01",
                "offers": {
                  "price": 34.99,
                  "priceCurrency": "USD",
                  "seller": { "name": "DirectBrand Official" }
                }
              }
            </script>
          </body>
        </html>
      `);

      const collector = createFieldDiagnosticsCollector();
      const product = parseAmazonProductDetail(
        doc,
        'https://www.amazon.com/dp/B0JSONLD01',
        collector,
      );
      const fields = new Map(
        collector.build().fields.map((entry) => [entry.field, entry]),
      );

      expect(product?.seller).toBe('DirectBrand Official');
      expect(fields.get('seller')).toMatchObject({
        status: 'EXTRACTED',
        source: 'json-ld',
      });
    });

    it('enriches a stored card row with PDP seller and delivery via parsePdpHtml and mergeDetailIntoStored', () => {
      const html = readFixture('pdp-1p-odf-merchant-info.real.html');
      const parsed = parsePdpHtml(
        html,
        'https://www.amazon.com/dp/B0G66ZJG3Y',
        'B0G66ZJG3Y',
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const stored: Product = {
        id: 1,
        asin: 'B0G66ZJG3Y',
        url: 'https://www.amazon.com/dp/B0G66ZJG3Y',
        title: 'Philips Sonicare 7300',
        price: 149.96,
        currency: 'USD',
        rating: 4.6,
        reviewCount: 512,
        imageUrl: 'https://m.media-amazon.com/images/I/71sonicare._AC_UL320_.jpg',
        isSponsored: false,
        isPrime: true,
        brand: null,
        availability: null,
        seller: null,
        description: null,
        features: [],
        source: 'search',
        collectedAt: '2026-10-22T00:00:00.000Z',
        sessionKey: 'session_test',
      };

      const { patch, changedFields } = mergeDetailIntoStored(
        stored,
        parsed.product,
      );

      expect(patch.seller).toBe('Amazon.com');
      expect(patch.delivery).toBe('FREE delivery Monday, October 26');
      expect(changedFields).toContain('seller');
      expect(changedFields).toContain('delivery');
    });
  });
});
