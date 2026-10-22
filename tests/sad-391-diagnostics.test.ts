/**
 * SAD-391 step 5 — diagnostics honesty (diagnostics lane; product rows are
 * byte-identical with and without a sink).
 *
 * - `isSponsored` is the 25th modelled field on card and product-page reports.
 * - `isPrime` EXTRACTED entries say which evidence it was (`prime badge` /
 *   `prime ingress`).
 * - A recorder input without the ad verdict leaves the field UNKNOWN rather
 *   than asserting an outcome nobody computed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createFieldDiagnosticsCollector,
  DETAIL_DIAGNOSTIC_FIELDS,
  summarizeFieldDiagnostics,
  type ExtractionDiagnosticsReport,
  type ExtractionDiagnosticsSink,
} from '@/engines/amazon/scraper/extraction-diagnostics';
import { recordCardDiagnostics } from '@/engines/amazon/scraper/card-diagnostics';
import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryCard } from '@/engines/amazon/scraper/category-page';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';

const fixture = (name: string): string =>
  readFileSync(
    join(__dirname, '..', 'docs', 'plans', 'SAD-391-fixtures', name),
    'utf8',
  );

const createDoc = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html');

function cardFrom(html: string): Element {
  const card = createDoc(`<html><body>${html}</body></html>`).querySelector(
    '[data-component-type="s-search-result"], [data-asin]',
  );
  if (!card) throw new Error('no card in markup');
  return card;
}

function collectingSink(): ExtractionDiagnosticsSink & {
  reports: ExtractionDiagnosticsReport[];
} {
  const reports: ExtractionDiagnosticsReport[] = [];
  return {
    reports,
    accept(report) {
      reports.push(report);
    },
  };
}

const byField = (report: ExtractionDiagnosticsReport) =>
  new Map(report.fields.map((entry) => [entry.field, entry]));

describe('the modelled field list', () => {
  it('has 25 fields, isSponsored last, next to isPrime', () => {
    expect(DETAIL_DIAGNOSTIC_FIELDS).toHaveLength(25);
    expect(new Set(DETAIL_DIAGNOSTIC_FIELDS).size).toBe(25);
    expect(DETAIL_DIAGNOSTIC_FIELDS.slice(-2)).toEqual(['isPrime', 'isSponsored']);
  });
});

describe('search-card report', () => {
  const PAGE = 'https://www.amazon.com/s?k=laptop';

  it('sponsored 2025 card: isSponsored EXTRACTED (derived), isPrime MISSING with the new reason', () => {
    const sink = collectingSink();
    const product = parseAmazonSearchCard(
      cardFrom(
        `<div data-component-type="s-search-result" data-asin="B081XSYZMS" class="s-result-item s-asin AdHolder">${fixture('sponsored-card-2025.external.html')}</div>`,
      ),
      PAGE,
      { diagnosticsSink: sink },
    );
    expect(product?.isSponsored).toBe(true);
    const fields = byField(sink.reports[0]!);
    expect(sink.reports[0]!.fields).toHaveLength(26);
    expect(fields.get('isSponsored')).toMatchObject({ status: 'EXTRACTED', source: 'derived' });
    expect(fields.get('isPrime')).toMatchObject({
      status: 'MISSING',
      source: 'derived',
      reason: 'no Prime badge or Prime ingress found',
    });
  });

  it('"Join Prime" ingress card: isPrime EXTRACTED with reason "prime ingress", isSponsored MISSING with a reason', () => {
    const sink = collectingSink();
    parseAmazonSearchCard(
      cardFrom(fixture('search-card-join-prime-stock-warning.real.html')),
      PAGE,
      { diagnosticsSink: sink },
    );
    const fields = byField(sink.reports[0]!);
    expect(fields.get('isPrime')).toMatchObject({
      status: 'EXTRACTED',
      source: 'derived',
      reason: 'prime ingress',
    });
    expect(fields.get('isSponsored')).toMatchObject({
      status: 'MISSING',
      source: 'derived',
      reason: 'no Sponsored marker found',
    });
    expect(fields.get('delivery')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('availability')).toMatchObject({ status: 'EXTRACTED' });
  });

  it('badge card: isPrime reason is "prime badge"; the five counts still partition the report', () => {
    const sink = collectingSink();
    parseAmazonSearchCard(
      cardFrom(`
        <div data-component-type="s-search-result" data-asin="B0UDMBADG1">
          <h2><a href="/x/dp/B0UDMBADG1"><span>Wireless Earbuds</span></a></h2>
          <span class="a-price"><span class="a-offscreen">$19.99</span></span>
          <div data-cy="delivery-recipe"><div class="udm-badge-block"><i class="a-icon-wrapper a-icon-prime-with-text"><i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i></i></div><div class="udm-primary-delivery-message">FREE delivery Tomorrow, Oct 22</div></div>
        </div>`),
      PAGE,
      { diagnosticsSink: sink },
    );
    const report = sink.reports[0]!;
    expect(byField(report).get('isPrime')).toMatchObject({ status: 'EXTRACTED', reason: 'prime badge' });
    const counts = summarizeFieldDiagnostics(report.fields);
    expect(counts.extracted + counts.missing + counts.parseFailed + counts.partial + counts.unknown).toBe(26);
    expect(counts.unknown).toBe(0);
  });

  it('parity: the product is identical with and without a sink', () => {
    const html = fixture('search-card-join-prime-stock-warning.real.html');
    const plain = parseAmazonSearchCard(cardFrom(html), PAGE);
    const withSink = parseAmazonSearchCard(cardFrom(html), PAGE, { diagnosticsSink: collectingSink() });
    expect(withSink).toEqual(plain);
  });
});

describe('category-card report', () => {
  it('carries the 26-field shape with the ad verdict recorded', () => {
    const sink = collectingSink();
    parseAmazonCategoryCard(
      cardFrom(`
        <div id="gridItemRoot" data-asin="B0CATEGRY1">
          <a href="/x/dp/B0CATEGRY1"><span>Category Item</span></a>
          <span class="a-price"><span class="a-offscreen">$9.99</span></span>
        </div>`),
      'https://www.amazon.com/gp/bestsellers/kitchen',
      { diagnosticsSink: sink },
    );
    const report = sink.reports[0]!;
    expect(report.fields).toHaveLength(26);
    expect(byField(report).get('isSponsored')).toMatchObject({ status: 'MISSING', source: 'derived' });
  });
});

describe('product-page report', () => {
  const PDP = `
    <html><head><link rel="canonical" href="https://www.amazon.com/dp/B0GQB2F5NF" /></head><body>
      <h1 id="title"><span id="productTitle">HP 15.6" Laptop</span></h1>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$329.00</span></span></div>
      <div id="buybox"><div id="availability"><span>In Stock</span></div></div>
    </body></html>`;

  it('ad click URL: isSponsored EXTRACTED from the url; canonical URL: MISSING with a reason', () => {
    const adCollector = createFieldDiagnosticsCollector();
    parseAmazonProductDetail(
      createDoc(PDP),
      'https://www.amazon.com/HP-Laptop/dp/B0GQB2F5NF/ref=sr_1_1_sspa?sp_csd=d2lkZ2V0TmFtZT1zcF9hdGY',
      adCollector,
    );
    const adReport = adCollector.build();
    expect(adReport.fields).toHaveLength(25);
    expect(byField(adReport).get('isSponsored')).toMatchObject({ status: 'EXTRACTED', source: 'url' });

    const plainCollector = createFieldDiagnosticsCollector();
    parseAmazonProductDetail(createDoc(PDP), 'https://www.amazon.com/dp/B0GQB2F5NF', plainCollector);
    expect(byField(plainCollector.build()).get('isSponsored')).toMatchObject({
      status: 'MISSING',
      source: 'url',
      reason: 'no Sponsored Products marker in the page URL',
    });
  });

  it('isPrime EXTRACTED entries name the signal and the winning selector', () => {
    const collector = createFieldDiagnosticsCollector();
    parseAmazonProductDetail(
      createDoc(PDP.replace('<div id="availability">', '<i class="a-icon a-icon-prime" aria-label="Prime"></i><div id="availability">')),
      'https://www.amazon.com/dp/B0GQB2F5NF',
      collector,
    );
    expect(byField(collector.build()).get('isPrime')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '#buybox i.a-icon-prime',
      reason: 'prime badge',
    });
  });
});

describe('recordCardDiagnostics without an ad verdict', () => {
  it('leaves isSponsored UNKNOWN instead of asserting MISSING', () => {
    const collector = createFieldDiagnosticsCollector();
    recordCardDiagnostics(collector, {
      asin: { value: 'B0NOVERDCT', tier: 'tier2_semantic' },
      title: { value: 'Fixture Card', tier: 'tier2_semantic' },
      brand: null,
      pricing: { price: 19.99, currency: 'USD', priceTier: 'tier2_semantic' },
      rating: { value: 4.5, tier: 'tier2_semantic' },
      reviewCount: { value: 10, tier: 'tier2_semantic' },
      image: { value: null, tier: 'tier4_selector' },
      availability: null,
      seller: null,
      isPrime: false,
      url: 'https://www.amazon.com/dp/B0NOVERDCT',
    });
    const fields = byField(collector.build());
    expect(fields.get('isSponsored')).toMatchObject({ status: 'UNKNOWN' });
    expect(fields.get('isPrime')).toMatchObject({ status: 'MISSING' });
  });
});
