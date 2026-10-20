/**
 * SAD-369 step 2 (T13–T18) — the per-card diagnostics report.
 *
 * A listing-card parse with a diagnostics sink produces one 24-field report
 * per product; the 4 fields a card can never carry are MISSING *with the
 * reason*; the extracted product is byte-identical with and without a sink;
 * and a validator-dropped value honestly shows PARTIAL.
 */
import { describe, expect, it } from 'vitest';

import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import { parseAmazonCategoryCard } from '@/engines/amazon/scraper/category-page';
import { extractCardPricingAndDiscounts } from '@/engines/amazon/scraper/field-parsers';
import {
  CARD_INAPPLICABLE_FIELDS,
  CARD_INAPPLICABLE_REASON,
  createSingleReportSink,
} from '@/engines/amazon/scraper/card-diagnostics';
import { summarizeFieldDiagnostics } from '@/engines/amazon/scraper/extraction-diagnostics';
import type {
  ExtractionDiagnosticsReport,
  ExtractionDiagnosticsSink,
} from '@/engines/amazon/scraper/extraction-diagnostics';

const PAGE_URL = 'https://www.amazon.com/s?k=diag';

const SEARCH_CARD = `
  <div data-component-type="s-search-result" data-asin="B0CARDDIAG">
    <h2 class="a-size-medium">
      <a href="/Diag-Widget/dp/B0CARDDIAG"><span>Diag Widget</span></a>
    </h2>
    <img class="s-image" src="https://m.media-amazon.com/images/I/diag.jpg" alt="Diag Widget">
    <span class="a-price"><span class="a-offscreen">$19.99</span></span>
    <span aria-label="4.5 out of 5 stars">
      <i class="a-icon a-icon-star-small"><span class="a-icon-alt">4.5 out of 5 stars</span></i>
    </span>
  </div>`;

const CATEGORY_CARD = `
  <div data-p13n-asin-metadata='{"asin":"B0CATGDIAG","price":"$29.99"}'>
    <a href="/dp/B0CATGDIAG">
      <img alt="Category Diag Widget" src="https://m.media-amazon.com/images/I/catdiag.jpg">
    </a>
    <div class="p13n-sc-truncate">Category Diag Widget</div>
  </div>`;

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

function renderCard(html: string): Element {
  document.body.innerHTML = html;
  const card = document.body.firstElementChild;
  if (!card) throw new Error('fixture rendered nothing');
  return card;
}

function byField(report: ExtractionDiagnosticsReport) {
  return new Map(report.fields.map((entry) => [entry.field, entry]));
}

describe('SAD-369 step 2: the card-level diagnostics report', () => {
  it('a search card produces a 24-field report; the 4 card-inapplicable fields are MISSING with the reason', () => {
    const card = renderCard(SEARCH_CARD);
    const sink = collectingSink();

    const product = parseAmazonSearchCard(card, PAGE_URL, {
      diagnosticsSink: sink,
    });

    expect(product).not.toBeNull();
    expect(sink.reports).toHaveLength(1);
    const report = sink.reports[0]!;
    expect(report.asin).toBe('B0CARDDIAG');
    // D3: the card report carries the same 24 modelled fields as a
    // product-page report — build()'s default list, no new field list.
    expect(report.fields).toHaveLength(24);

    const fields = byField(report);
    for (const field of CARD_INAPPLICABLE_FIELDS) {
      expect(fields.get(field)).toMatchObject({
        field,
        status: 'MISSING',
        reason: CARD_INAPPLICABLE_REASON,
      });
    }

    // The stable wins of this fixture are EXTRACTED, with the tier (not a
    // selector) as the honest "how did we get this" signal.
    expect(fields.get('asin')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('asin')!.tier).toBeTruthy();
    expect(fields.get('title')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('price')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('price')!.tier).toBeTruthy();
    expect(fields.get('price')!.selector).toBeUndefined();
    expect(fields.get('imageUrl')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('url')).toMatchObject({ status: 'EXTRACTED', source: 'url' });
  });

  it('the five counts sum to 24 and no field is left UNKNOWN for a fully-parsed card', () => {
    const card = renderCard(SEARCH_CARD);
    const sink = collectingSink();
    parseAmazonSearchCard(card, PAGE_URL, { diagnosticsSink: sink });

    const report = sink.reports[0]!;
    const counts = summarizeFieldDiagnostics(report.fields);
    expect(
      counts.extracted +
        counts.missing +
        counts.parseFailed +
        counts.partial +
        counts.unknown,
    ).toBe(24);
    // Every field was looked at (or declared inapplicable) — nothing UNKNOWN.
    expect(counts.unknown).toBe(0);
  });

  it('a card without an ASIN yields no product and no report', () => {
    document.body.innerHTML = `
      <div data-component-type="s-search-result">
        <h2><span>No Asin Widget</span></h2>
      </div>`;
    const card = document.body.firstElementChild!;
    const sink = collectingSink();

    const product = parseAmazonSearchCard(card, PAGE_URL, {
      diagnosticsSink: sink,
    });

    expect(product).toBeNull();
    // No product to ride along with → an unreconciled report would mislead.
    expect(sink.reports).toHaveLength(0);
  });

  it('a category card produces the same 24-field shape, including the 4 inapplicable rows', () => {
    const card = renderCard(CATEGORY_CARD);
    const sink = collectingSink();

    const product = parseAmazonCategoryCard(card, PAGE_URL, {
      diagnosticsSink: sink,
    });

    expect(product).not.toBeNull();
    expect(sink.reports).toHaveLength(1);
    const report = sink.reports[0]!;
    expect(report.asin).toBe('B0CATGDIAG');
    expect(report.fields).toHaveLength(24);

    const fields = byField(report);
    expect(fields.get('asin')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('price')).toMatchObject({
      status: 'EXTRACTED',
      tier: 'tier1_json',
    });
    for (const field of CARD_INAPPLICABLE_FIELDS) {
      expect(fields.get(field)).toMatchObject({
        status: 'MISSING',
        reason: CARD_INAPPLICABLE_REASON,
      });
    }
  });

  it('parity: the extracted product is identical with and without a sink', () => {
    const withSink = parseAmazonSearchCard(renderCard(SEARCH_CARD), PAGE_URL, {
      diagnosticsSink: collectingSink(),
    });
    const withoutSink = parseAmazonSearchCard(renderCard(SEARCH_CARD), PAGE_URL);

    expect(withSink).not.toBeNull();
    // The one invariant this step must never break.
    expect(withSink).toEqual(withoutSink);

    const categoryWith = parseAmazonCategoryCard(
      renderCard(CATEGORY_CARD),
      PAGE_URL,
      { diagnosticsSink: collectingSink() },
    );
    const categoryWithout = parseAmazonCategoryCard(
      renderCard(CATEGORY_CARD),
      PAGE_URL,
    );
    expect(categoryWith).toEqual(categoryWithout);
  });

  it('a validator-dropped value flips to PARTIAL "parsed but failed validation"', () => {
    // The parser obtains a price, then validation drops it (negative prices
    // never survive). The report must say obtained-then-invalidated — not
    // MISSING, and not PARSE_FAILED. The `extractPricing` injection is the
    // parser's own test seam; the recording path is the real one.
    const card = renderCard(SEARCH_CARD);
    const sink = collectingSink();

    const product = parseAmazonSearchCard(card, PAGE_URL, {
      diagnosticsSink: sink,
      extractPricing: () => ({
        price: -5,
        currency: 'USD',
        priceTier: 'tier2_semantic',
      }),
    });

    expect(product).not.toBeNull();
    expect(product!.price).toBeNull();
    const fields = byField(sink.reports[0]!);
    expect(fields.get('price')).toMatchObject({
      status: 'PARTIAL',
      reason: 'parsed but failed validation',
      validated: false,
    });
  });

  it('createSingleReportSink keeps exactly the first report', () => {
    const sink = createSingleReportSink();
    expect(sink.report).toBeUndefined();

    const first: ExtractionDiagnosticsReport = { asin: 'B0FIRST0001', fields: [] };
    const second: ExtractionDiagnosticsReport = { asin: 'B0SECOND001', fields: [] };
    sink.accept(first);
    sink.accept(second);

    expect(sink.report).toBe(first);
  });

  it('E9: an unparseable price keeps { price, currency, priceTier } identical and reports PARSE_FAILED', () => {
    // The offscreen node is present but its text carries no price ("See price
    // in cart"). Before SAD-369 the cascade fell through silently; the parity
    // pin proves the extracted triple is byte-identical to the pre-change
    // behaviour, and the report now says PARSE_FAILED instead of claiming the
    // price was absent.
    const card = renderCard(
      SEARCH_CARD.replace(
        '<span class="a-offscreen">$19.99</span>',
        '<span class="a-offscreen">See price in cart</span>',
      ),
    );
    const sink = collectingSink();

    const product = parseAmazonSearchCard(card, PAGE_URL, {
      diagnosticsSink: sink,
    });

    expect(product).not.toBeNull();
    // Parity pin: exactly what the cascade produced before the change.
    expect({
      price: product!.price,
      currency: product!.currency,
    }).toEqual({ price: null, currency: 'USD' });

    // The observation rides the diagnostics-only field...
    const pricing = extractCardPricingAndDiscounts(card, PAGE_URL);
    expect({
      price: pricing.price,
      currency: pricing.currency,
      priceTier: pricing.priceTier,
    }).toEqual({ price: null, currency: 'USD', priceTier: 'missing' });
    expect(pricing.unparseablePriceTier).toBe('tier2_semantic');

    // ...and the report entry is PARSE_FAILED with the observation tier.
    const fields = byField(sink.reports[0]!);
    expect(fields.get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'price node present but its text could not be parsed',
      tier: 'tier2_semantic',
    });
  });

  it('E9: a parseable price carries no unparseablePriceTier', () => {
    const card = renderCard(SEARCH_CARD);
    const pricing = extractCardPricingAndDiscounts(card, PAGE_URL);

    expect(pricing.price).toBe(19.99);
    expect(pricing.unparseablePriceTier).toBeUndefined();
  });
});
