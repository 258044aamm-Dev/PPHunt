/**
 * SAD-386 step 5 — diagnostics lane.
 *
 * Two promises, both asserted here:
 * 1. the report can now tell "the page had nothing" from "we could not read
 *    what it had" for `discountPercentage`, and labels a derived `dealBadge`
 *    as `derived` rather than pretending a badge was printed;
 * 2. the PRODUCT is byte-identical with and without a diagnostics sink — this
 *    step must not change stored data.
 */
import { describe, expect, it } from 'vitest';
import { parseAmazonSearchResults } from '@/engines/amazon/scraper';
import type { ExtractionDiagnosticsReport } from '@/engines/amazon/scraper';
import {
  CARD_INAPPLICABLE_FIELDS,
} from '@/engines/amazon/scraper/card-diagnostics';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper';
import { createFieldDiagnosticsCollector } from '@/engines/amazon/scraper/extraction-diagnostics';

const URL_SEARCH = 'https://www.amazon.com/s?k=deal';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function reportFor(html: string): ExtractionDiagnosticsReport {
  const reports: ExtractionDiagnosticsReport[] = [];
  parseAmazonSearchResults(doc(html), URL_SEARCH, {
    diagnosticsSink: { accept: (report) => reports.push(report) },
  });
  expect(reports).toHaveLength(1);
  return reports[0]!;
}

function fieldOf(report: ExtractionDiagnosticsReport, name: string) {
  return report.fields.find((field) => field.field === name);
}

const CARD = (inner: string) => `
  <div class="s-main-slot">
    <div data-component-type="s-search-result" data-asin="B0DIAG0001">
      <div data-cy="title-recipe">
        <a class="a-link-normal" href="/dp/B0DIAG0001"><h2><span>Diagnostics Product</span></h2></a>
      </div>
      <div data-cy="price-recipe">
        <span class="a-price"><span class="a-offscreen">$31.99</span></span>
        ${inner}
      </div>
      <img class="s-image" src="https://m.media-amazon.com/images/I/71diag._AC_UY218_.jpg" />
    </div>
  </div>`;

describe('SAD-386: diagnostics honesty for discount and deal', () => {
  it('still reports exactly 26 fields (card universe: 25 detail fields since SAD-391 + badge since SAD-393)', () => {
    const report = reportFor(CARD(''));
    const expected = 26;
    expect(report.fields).toHaveLength(expected);
    expect(CARD_INAPPLICABLE_FIELDS).toHaveLength(4);
  });

  it('reports a refused percentage node as PARSE_FAILED, not MISSING', () => {
    const report = reportFor(
      CARD('<span class="s-coupon-unclipped">Save 15% off with coupon</span>'),
    );
    const discount = fieldOf(report, 'discountPercentage');
    expect(discount?.status).toBe('PARSE_FAILED');
    expect(discount?.reason).toContain('not a product discount');
  });

  it('reports genuinely absent values as MISSING', () => {
    const report = reportFor(CARD(''));
    expect(fieldOf(report, 'discountPercentage')?.status).toBe('MISSING');
    expect(fieldOf(report, 'dealBadge')?.status).toBe('MISSING');
  });

  it('reports a printed badge as EXTRACTED from the dom', () => {
    const report = reportFor(
      CARD('<span data-a-badge-type="deal"><span class="a-badge-text">Limited time deal</span></span>'),
    );
    const deal = fieldOf(report, 'dealBadge');
    expect(deal?.status).toBe('EXTRACTED');
    expect(deal?.source).toBe('dom');
  });

  it('reports a derived deal as EXTRACTED with source derived', () => {
    const report = reportFor(
      CARD('<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$99.99</span></span>'),
    );
    const deal = fieldOf(report, 'dealBadge');
    expect(deal?.status).toBe('EXTRACTED');
    expect(deal?.source).toBe('derived');
  });

  it('the product is byte-identical with and without a diagnostics sink', () => {
    const html = CARD(
      '<span class="savingsPercentage">-68%</span><span data-a-badge-type="deal"><span class="a-badge-text">Limited time deal</span></span>',
    );
    const withSink = parseAmazonSearchResults(doc(html), URL_SEARCH, {
      diagnosticsSink: { accept: () => {} },
    });
    const withoutSink = parseAmazonSearchResults(doc(html), URL_SEARCH);
    expect(withSink).toEqual(withoutSink);
  });
});

describe('SAD-386: product-page provenance', () => {
  const page = (inner: string) => `<!doctype html><html><head>
      <link rel="canonical" href="https://www.amazon.com/dp/B0DIAG0002" /></head><body>
      <div id="centerCol">
        <h1 id="title"><span id="productTitle">Diagnostics PDP</span></h1>
        ${inner}
      </div></body></html>`;

  it('labels a struck-price deal as derived in the product-page report', () => {
    const collector = createFieldDiagnosticsCollector();
    const result = parseAmazonProductDetail(
      doc(page(`
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price"><span class="a-offscreen">$329.00</span></span>
        <span class="basisPrice"><span class="a-price" data-a-strike="true"><span class="a-offscreen">$429.00</span></span></span>
      </div>`)),
      'https://www.amazon.com/dp/B0DIAG0002',
      collector,
    );
    expect(result?.dealBadge).toBe('Deal');
    const report = collector.build();
    const deal = report.fields.find((field) => field.field === 'dealBadge');
    expect(deal?.status).toBe('EXTRACTED');
    expect(deal?.source).toBe('derived');
  });

  it('reports a refused PDP percentage node as PARSE_FAILED', () => {
    const collector = createFieldDiagnosticsCollector();
    parseAmazonProductDetail(
      doc(page(`
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price"><span class="a-offscreen">$329.00</span></span>
        <span class="savingsPercentage">100%</span>
      </div>`)),
      'https://www.amazon.com/dp/B0DIAG0003',
      collector,
    );
    const discount = collector.build().fields.find((f) => f.field === 'discountPercentage');
    expect(discount?.status).toBe('PARSE_FAILED');
  });
});
