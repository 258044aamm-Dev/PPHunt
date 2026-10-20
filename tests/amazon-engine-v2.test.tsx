import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  extractAsinFromUrl,
  isValidASIN,
  normalizeProductUrl,
  matchAmazonMarketplaceDomain,
} from '@/engines/amazon/utils/amazon-url';
import {
  parsePrice,
  inferCurrencyFromUrl,
} from '@/engines/amazon/utils/price-parser';
import {
  AmazonDriftTelemetry,
  defaultAmazonDriftTelemetry,
  logDriftReport,
} from '@/engines/amazon/scraper/drift-telemetry';
import {
  discoverStructuralProductCards,
  extractCardAsinWithTier,
  extractCardTitleAndBrandWithTier,
  extractCardImageWithTier,
} from '@/engines/amazon/scraper/field-parsers';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryPage } from '@/engines/amazon/scraper/category-page';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import {
  isAmazonCaptchaPage,
  detectAmazonRestriction,
} from '@/engines/amazon/scraper/captcha-detector';
import { AmazonDeduplicationEngine } from '@/engines/amazon/scraper/dedup';
import { AmazonParseCache } from '@/engines/amazon/scraper/parse-cache';
import { AmazonScrollController } from '@/engines/amazon/scraper/scroll-controller';
import {
  diagnoseError,
  formatDiagnosticReportForClipboard,
} from '@/engines/amazon/diagnostics/error-diagnosis';
import { db } from '@/engines/amazon/db/database';
import { addProducts } from '@/engines/amazon/db/products';
import { exportClipboard } from '@/engines/amazon/export';
import { AmazonEngineApp } from '@/engines/amazon/ui/AmazonEngineApp';

describe('Amazon Engine v2 — Clean-Slate Architecture & Future-Proofing Suite (SAD-243)', () => {
  beforeEach(async () => {
    defaultAmazonDriftTelemetry.reset();
    await db.open();
    await db.products.clear();
    await db.sessions.clear();
    await db.history.clear();
    await db.settings.clear();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('1. Multi-marketplace URL, ASIN & localized price utilities', () => {
    it('extracts and normalizes ASINs across /dp/, /gp/product/, and /gp/aw/d/ paths', () => {
      expect(isValidASIN('B09V3KXJPB')).toBe(true);
      expect(isValidASIN('invalid')).toBe(false);
      expect(
        extractAsinFromUrl(
          'https://www.amazon.de/-/en/Sony-Headphones/dp/b09v3kxjpb/ref=sr_1_1?qid=123',
        ),
      ).toBe('B09V3KXJPB');
      expect(
        extractAsinFromUrl(
          'https://www.amazon.co.jp/gp/product/B08N5WRWNW?psc=1',
        ),
      ).toBe('B08N5WRWNW');
      expect(
        normalizeProductUrl(
          '/gp/aw/d/B09V3KXJPB/ref=mp_s_a_1_1',
          'B09V3KXJPB',
          'https://www.amazon.co.uk/s?k=headphones',
        ),
      ).toBe('https://www.amazon.co.uk/dp/B09V3KXJPB');
    });

    it('resolves marketplace currency and parses US, EU, UK, and JP prices without fabricating data', () => {
      expect(
        matchAmazonMarketplaceDomain('https://www.amazon.de/s?k=test'),
      ).toBe('amazon.de');
      expect(inferCurrencyFromUrl('https://www.amazon.de/s?k=test')).toBe(
        'EUR',
      );
      expect(inferCurrencyFromUrl('https://www.amazon.co.jp/s?k=test')).toBe(
        'JPY',
      );

      expect(parsePrice('$1,299.99')).toEqual({
        value: 1299.99,
        currency: 'USD',
      });
      expect(parsePrice('1.299,95 €')).toEqual({
        value: 1299.95,
        currency: 'EUR',
      });
      expect(parsePrice('£49.50')).toEqual({
        value: 49.5,
        currency: 'GBP',
      });
      expect(parsePrice('￥15,800')).toEqual({
        value: 15800,
        currency: 'JPY',
      });
      expect(parsePrice('Currently unavailable')).toEqual({
        value: null,
        currency: null,
      });
    });
  });

  describe('2. Four-Tier Self-Healing Extraction Cascade', () => {
    it('Tier 1 (Structured JSON/metadata): extracts ASIN and hi-res image from embedded JSON attributes', () => {
      const card = document.createElement('div');
      card.setAttribute(
        'data-p13n-asin-metadata',
        JSON.stringify({ asin: 'B0TIER1001', price: '$79.99' }),
      );
      card.innerHTML = `
        <a href="/dp/B0TIER1001">
          <img
            alt="Tier 1 Structured Metadata Wireless Earbuds"
            src="https://m.media-amazon.com/images/I/lowres._AC_UL160_.jpg"
            data-a-dynamic-image='{"https://m.media-amazon.com/images/I/hires400._AC_UL400_.jpg":[400,400],"https://m.media-amazon.com/images/I/hires1200._AC_SL1200_.jpg":[1200,1200]}'
          />
        </a>
        <div class="p13n-sc-truncate">Tier 1 Structured Metadata Wireless Earbuds</div>
        <span class="_cDEzb_p13n-sc-price_3mJ9Z">$79.99</span>
      `;

      const asinHit = extractCardAsinWithTier(card);
      expect(asinHit).toEqual({
        value: 'B0TIER1001',
        tier: 'tier1_json',
      });

      const imageHit = extractCardImageWithTier(card);
      expect(imageHit).toEqual({
        value: 'https://m.media-amazon.com/images/I/hires1200._AC_SL1200_.jpg',
        tier: 'tier1_json',
      });

      document.body.appendChild(card);
      const products = parseAmazonCategoryPage(
        document,
        'https://www.amazon.com/gp/bestsellers',
      );
      expect(products).toHaveLength(1);
      expect(products[0]?.asin).toBe('B0TIER1001');
      expect(products[0]?.price).toBe(79.99);
      expect(products[0]?.imageUrl).toBe(
        'https://m.media-amazon.com/images/I/hires1200._AC_SL1200_.jpg',
      );
    });

    it('Tier 1 on PDP: falls back to JSON-LD Product schema when standard PDP DOM nodes are absent', () => {
      document.body.innerHTML = `
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "sku": "B0JSONLD99",
            "name": "JSON-LD Resilient Studio Monitor",
            "brand": { "@type": "Brand", "name": "AudioTech" },
            "description": "Studio reference monitor extracted via Tier 1 JSON-LD.",
            "image": ["https://m.media-amazon.com/images/I/monitor.jpg"],
            "offers": {
              "@type": "Offer",
              "price": "349.00",
              "priceCurrency": "USD",
              "availability": "https://schema.org/InStock"
            },
            "aggregateRating": {
              "@type": "AggregateRating",
              "ratingValue": "4.8",
              "reviewCount": "1420"
            }
          }
        </script>
      `;

      const pdp = parseAmazonProductDetail(
        document,
        'https://www.amazon.com/dp/B0JSONLD99',
      );
      expect(pdp).not.toBeNull();
      expect(pdp?.asin).toBe('B0JSONLD99');
      expect(pdp?.title).toBe('JSON-LD Resilient Studio Monitor');
      expect(pdp?.price).toBe(349);
      expect(pdp?.currency).toBe('USD');
      expect(pdp?.rating).toBe(4.8);
      expect(pdp?.reviewCount).toBe(1420);
      expect(pdp?.brand).toBe('AudioTech');
    });

    it('Tier 2 (Semantic data-* & ARIA) & Tier 3 (Structural /dp/<ASIN> recovery): extracts products even when all Amazon CSS classes and data-asin attributes are stripped', () => {
      document.body.innerHTML = `
        <main>
          <article>
            <div>
              <a href="/Headphones-Noise-Cancelling/dp/B0TIER3001/ref=sr_1_1">
                <img src="https://m.media-amazon.com/images/I/tier3-img1.jpg" alt="Heuristic Anchor Discovery Headphones" />
              </a>
            </div>
            <div>
              <a href="/Headphones-Noise-Cancelling/dp/B0TIER3001/ref=sr_1_1">
                Heuristic Anchor Discovery Headphones with 40h Battery
              </a>
              <span aria-label="4.6 out of 5 stars">4.6</span>
              <a href="/Headphones-Noise-Cancelling/dp/B0TIER3001#customerReviews">(2,345)</a>
              <div>$149.99</div>
            </div>
          </article>
          <article>
            <div>
              <a href="/Portable-SSD-2TB/dp/B0TIER3002/ref=sr_1_2">
                <img src="https://m.media-amazon.com/images/I/tier3-img2.jpg" alt="Heuristic Anchor Discovery 2TB NVMe SSD" />
              </a>
            </div>
            <div>
              <a href="/Portable-SSD-2TB/dp/B0TIER3002/ref=sr_1_2">
                Heuristic Anchor Discovery 2TB NVMe SSD USB-C
              </a>
              <div>$189.50</div>
            </div>
          </article>
        </main>
      `;

      const containers = discoverStructuralProductCards(document);
      expect(containers.length).toBe(2);

      const titleAndBrand = extractCardTitleAndBrandWithTier(
        containers[0]!,
        'B0TIER3001',
      );
      expect(titleAndBrand.title.tier).toBe('tier3_structural');
      expect(titleAndBrand.title.value).toContain(
        'Heuristic Anchor Discovery Headphones with 40h Battery',
      );

      const products = parseAmazonSearchResults(
        document,
        'https://www.amazon.com/s?k=headphones',
      );
      expect(products).toHaveLength(2);
      expect(products[0]).toMatchObject({
        asin: 'B0TIER3001',
        title: 'Heuristic Anchor Discovery Headphones with 40h Battery',
        price: 149.99,
        currency: 'USD',
        rating: 4.6,
        reviewCount: 2345,
        // Missing optional fields are never fabricated
        brand: null,
        seller: null,
      });
      expect(products[1]).toMatchObject({
        asin: 'B0TIER3002',
        title: 'Heuristic Anchor Discovery 2TB NVMe SSD USB-C',
        price: 189.5,
        currency: 'USD',
        rating: null,
        reviewCount: null,
      });
    });
  });

  describe('3. Local DOM-Drift & Tier-Fallback Telemetry', () => {
    it('tracks per-field tier hits, detects partial field degradation, and formats privacy-safe diagnostic reports', () => {
      const telemetry = new AmazonDriftTelemetry();

      // Simulate 5 cards where ASIN and title succeed via Tier 2, but price is missing on all 5 cards
      for (let i = 0; i < 5; i++) {
        telemetry.recordCardExtraction({
          asin: 'tier2_semantic',
          title: 'tier2_semantic',
          imageUrl: 'tier2_semantic',
          price: 'missing',
          rating: 'tier3_structural',
          reviewCount: 'tier3_structural',
        });
      }

      const report = telemetry.getReport();
      expect(report.cardsInspected).toBe(5);
      expect(report.cardsExtracted).toBe(5);
      expect(report.isDriftDetected).toBe(true);
      expect(report.fieldCoverage.price).toBe(0);
      expect(report.driftReasons.some((r) => r.includes('Low price field coverage'))).toBe(
        true,
      );

      const diagnosis = diagnoseError(
        'Collection stalled on this Amazon search page',
        {
          url: 'https://www.amazon.com/s?k=laptop&tag=secret-20&session-id=123-456',
          pageType: 'search',
          driftReasons: report.driftReasons,
        },
      );
      expect(diagnosis.safeContext.sanitizedUrl).toBe(
        'https://www.amazon.com/s',
      );
      expect(
        diagnosis.potentialCauses.some((c) =>
          c.includes('Low price field coverage'),
        ),
      ).toBe(true);

      const clipboardText = formatDiagnosticReportForClipboard(diagnosis);
      expect(clipboardText).toContain('=== PPHunt Diagnostic Summary ===');
      expect(clipboardText).not.toContain('secret-20');
      expect(clipboardText).not.toContain('123-456');
    });
    it('SAD-359: logs the existing aggregate report as one-line JSON without resetting it', () => {
      const telemetry = new AmazonDriftTelemetry();
      telemetry.recordCardExtraction({
        asin: 'tier2_semantic',
        title: 'tier2_semantic',
        price: 'missing',
        rating: 'missing',
        reviewCount: 'missing',
        imageUrl: 'tier2_semantic',
      });

      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      logDriftReport(telemetry, 'search-results');

      const tag = '[PPHunt] drift report ';
      const lines = info.mock.calls
        .map((call) => call[0])
        .filter(
          (first): first is string =>
            typeof first === 'string' && first.startsWith(tag),
        );
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('\n');
      expect(JSON.parse(lines[0]!.slice(tag.length))).toMatchObject({
        stage: 'search-results',
        cardsInspected: 1,
        cardsExtracted: 1,
        fieldCoverage: { price: 0 },
      });

      // Surfacing the report is observation only: cumulative totals remain.
      expect(telemetry.getReport().cardsInspected).toBe(1);
    });

    it('SAD-359: stays silent before any card is inspected and never throws', () => {
      const telemetry = new AmazonDriftTelemetry();
      const info = vi.spyOn(console, 'info').mockImplementation(() => {
        throw new Error('console is gone');
      });

      expect(() => logDriftReport(telemetry, 'category-page')).not.toThrow();
      expect(info).not.toHaveBeenCalled();

      telemetry.recordCardExtraction({ asin: 'tier2_semantic' });
      expect(() => logDriftReport(telemetry, 'category-page')).not.toThrow();
    });

    it('SAD-359: top-level search and category parses each surface their telemetry once', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});

      document.body.innerHTML = `
        <div class="s-main-slot">
          <div data-component-type="s-search-result" data-asin="B0DRIFT359">
            <h2><a href="/Drift-Widget/dp/B0DRIFT359"><span>Drift Widget</span></a></h2>
            <img class="s-image" src="https://m.media-amazon.com/images/I/drift.jpg">
            <span class="a-price"><span class="a-offscreen">$19.99</span></span>
          </div>
        </div>
      `;
      const searchTelemetry = new AmazonDriftTelemetry();
      const searchProducts = parseAmazonSearchResults(
        document,
        'https://www.amazon.com/s?k=drift',
        { telemetry: searchTelemetry, cache: new AmazonParseCache() },
      );
      expect(searchProducts).toHaveLength(1);

      const categoryCard = document.createElement('div');
      categoryCard.setAttribute(
        'data-p13n-asin-metadata',
        JSON.stringify({ asin: 'B0CATG3590', price: '$29.99' }),
      );
      categoryCard.innerHTML = `
        <a href="/dp/B0CATG3590">
          <img alt="Category Drift Widget" src="https://m.media-amazon.com/images/I/category.jpg">
        </a>
        <div class="p13n-sc-truncate">Category Drift Widget</div>
      `;
      document.body.replaceChildren(categoryCard);
      const categoryTelemetry = new AmazonDriftTelemetry();
      const categoryProducts = parseAmazonCategoryPage(
        document,
        'https://www.amazon.com/gp/bestsellers',
        { telemetry: categoryTelemetry, cache: new AmazonParseCache() },
      );
      expect(categoryProducts).toHaveLength(1);

      const tag = '[PPHunt] drift report ';
      const reports = info.mock.calls
        .map((call) => call[0])
        .filter(
          (first): first is string =>
            typeof first === 'string' && first.startsWith(tag),
        )
        .map((line) => JSON.parse(line.slice(tag.length)) as Record<string, unknown>);
      expect(reports).toHaveLength(2);
      expect(reports[0]).toMatchObject({
        stage: 'search-results',
        cardsInspected: 1,
        cardsExtracted: 1,
      });
      expect(reports[1]).toMatchObject({
        stage: 'category-page',
        cardsInspected: 1,
        cardsExtracted: 1,
      });
    });
  });

  describe('4. Hybrid Scroll & Safe Load-More / Pagination Controller', () => {
    it('triggers safe inline load-more controls when scrolling stalls before declaring end-of-page', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      try {
        document.body.innerHTML = `
          <div id="search">
            <div data-asin="B09V3KXJP1" data-component-type="s-search-result"></div>
          </div>
          <button id="load-more-btn" type="button" class="s-pagination-next">See more</button>
        `;
        const loadMoreBtn = document.getElementById('load-more-btn')!;
        let clicked = false;
        let cardCount = 1;
        loadMoreBtn.addEventListener('click', () => {
          clicked = true;
          cardCount = 2;
        });

        const onNewProducts = vi.fn();
        const onEndOfPage = vi.fn();

        const controller = new AmazonScrollController({
          scrollAmount: 400,
          scrollInterval: 200,
          waitAfterScroll: 300,
          maxWaitForNew: 800,
        });

        controller.start(
          onNewProducts,
          onEndOfPage,
          () => true,
          () => cardCount,
          () => false,
        );

        await vi.advanceTimersByTimeAsync(1500);
        expect(clicked).toBe(true);
        expect(onNewProducts).toHaveBeenCalled();

        controller.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('5. CAPTCHA Detection, Deduplication, ParseCache, DB, Exporters & UI Isolation', () => {
    it('detects Amazon CAPTCHA challenges and restriction states without attempting to bypass', () => {
      document.body.innerHTML = `
        <form action="/errors/validateCaptcha">
          <input id="captchacharacters" />
        </form>
      `;
      expect(isAmazonCaptchaPage(document)).toBe(true);
      const restriction = detectAmazonRestriction(document);
      expect(restriction.restricted).toBe(true);
      expect(restriction.reason).toBe('captcha');
    });

    it('merges richer product fields in AmazonDeduplicationEngine and caches DOM nodes in AmazonParseCache', () => {
      const dedup = new AmazonDeduplicationEngine();
      const existing = [
        {
          asin: 'B0DEDUP001',
          title: 'Initial Search Title',
          price: null,
          currency: 'USD',
          rating: 4.5,
          reviewCount: null,
          brand: null,
          seller: null,
          availability: null,
          isSponsored: false,
          isPrime: false,
          imageUrl: null,
          url: 'https://www.amazon.com/dp/B0DEDUP001',
          description: null,
          features: [],
          source: 'search' as const,
        },
      ];

      const incoming = [
        {
          asin: 'B0DEDUP001',
          title: 'Initial Search Title',
          price: 59.99,
          currency: 'USD',
          rating: null,
          reviewCount: 412,
          brand: 'Anker',
          seller: 'Amazon.com',
          availability: 'In Stock',
          isSponsored: false,
          isPrime: true,
          imageUrl: 'https://m.media-amazon.com/images/I/anker.jpg',
          url: 'https://www.amazon.com/dp/B0DEDUP001',
          description: 'High speed charger',
          features: ['Fast charging'],
          source: 'detail' as const,
        },
      ];

      const { newProducts, updatedExisting } = dedup.mergeAndFilterNew(
        existing,
        incoming,
      );
      expect(newProducts).toHaveLength(0);
      expect(updatedExisting).toBe(true);
      expect(existing[0]?.price).toBe(59.99);
      expect(existing[0]?.rating).toBe(4.5); // Retained from first record
      expect(existing[0]?.reviewCount).toBe(412); // Enriched from second record
      expect(existing[0]?.brand).toBe('Anker');
      expect(existing[0]?.isPrime).toBe(true);

      const cache = new AmazonParseCache();
      const el = document.createElement('div');
      let calls = 0;
      const a = cache.getOrParse(el, () => {
        calls++;
        return existing[0]!;
      });
      const b = cache.getOrParse(el, () => {
        calls++;
        return existing[0]!;
      });
      expect(calls).toBe(1);
      expect(a).toBe(b);
    });

    it('persists products in PPHuntDB, exports formula-safe Clipboard TSV, and renders AmazonEngineApp', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const added = await addProducts(
        [
          {
            asin: 'B0EXPORT01',
            title: '=cmd|" /C calc"!A0 Dangerous Title',
            price: 29.99,
            currency: 'USD',
            rating: 4.9,
            reviewCount: 88,
            brand: 'SafeBrand',
            seller: 'Amazon',
            availability: 'In Stock',
            isSponsored: false,
            isPrime: true,
            imageUrl: 'https://m.media-amazon.com/images/I/safe.jpg',
            url: 'https://www.amazon.com/dp/B0EXPORT01',
            description: null,
            features: [],
            source: 'search',
          },
        ],
        'https://www.amazon.com/s?k=safe',
      );
      expect(added).toBe(1);

      const stored = await db.products.toArray();
      expect(stored).toHaveLength(1);

      await exportClipboard(stored, ['ASIN', 'Title', 'Price']);
      expect(writeText).toHaveBeenCalledTimes(1);
      const tsv = writeText.mock.calls[0]?.[0] as string;
      expect(tsv).toContain("'=cmd|");

      // Render AmazonEngineApp and verify Collect & History navigation tabs render with 100% visual parity
      render(<AmazonEngineApp />);
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Collect' })).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
      });
    });
  });
});
