/**
 * SAD-369 step 3 (T24–T27 + D11) — the per-run collection diagnostics state.
 *
 * The invariants under test:
 * - the first 50 unique products each get a report; the 51st does not (D7);
 * - duplicates and re-parses never burn cap slots;
 * - a second run resets everything (T26);
 * - every report is handed to a message exactly once per run, even when an
 *   `updatedExisting` batch re-sends the whole run (D11);
 * - sink keys and product lookups normalize ASINs identically.
 *
 * Plus: the PRODUCTS_COLLECTED schema accepts the reports with and without
 * the new optional field (older content scripts unaffected).
 */
import { describe, expect, it } from 'vitest';

import { createCollectionDiagnosticsRun } from '@/engines/amazon/content/collection-diagnostics';
import { COLLECTION_DIAGNOSTICS_LIMIT } from '@/engines/amazon/constants/defaults';
import { ProductsCollectedMessageSchema } from '@/engines/amazon/schemas/messages';
import type { ExtractionDiagnosticsReport } from '@/engines/amazon/scraper/extraction-diagnostics';

function report(asin: string): ExtractionDiagnosticsReport {
  return {
    asin,
    fields: [{ field: 'asin', status: 'EXTRACTED', source: 'dom' }],
  };
}

function asin(n: number): string {
  return `B0RUN${String(n).padStart(5, '0')}`;
}

describe('SAD-369 step 3: the collection run diagnostics state', () => {
  it('the cap is 50 and the first 50 unique products each get a report', () => {
    expect(COLLECTION_DIAGNOSTICS_LIMIT).toBe(50);
    const run = createCollectionDiagnosticsRun();

    for (let i = 1; i <= 60; i += 1) {
      run.sink.accept(report(asin(i)));
    }

    // T24/T25: exactly 50 accepted — the 51st onwards never enter the run.
    expect(run.loggedCount()).toBe(50);
    const taken = run.takeUnsentFor(
      Array.from({ length: 60 }, (_, i) => ({ asin: asin(i + 1) })),
    );
    expect(taken).toHaveLength(50);
    expect(taken[0]!.asin).toBe(asin(1));
    expect(taken[49]!.asin).toBe(asin(50));
    // The 51st product has no report at all.
    expect(taken.some((r) => r.asin === asin(51))).toBe(false);
  });

  it('duplicates and re-parses of the same card never burn cap slots', () => {
    const run = createCollectionDiagnosticsRun();

    // 40 unique products, each re-parsed three times (mutation churn).
    for (let pass = 0; pass < 3; pass += 1) {
      for (let i = 1; i <= 40; i += 1) {
        run.sink.accept(report(asin(i)));
      }
    }

    expect(run.loggedCount()).toBe(40);
    // There is still room for 10 more unique products after the churn.
    for (let i = 41; i <= 50; i += 1) {
      run.sink.accept(report(asin(i)));
    }
    expect(run.loggedCount()).toBe(50);
  });

  it('a report without an ASIN is refused, and lookup keys normalize like sink keys', () => {
    const run = createCollectionDiagnosticsRun();
    run.sink.accept({ asin: null, fields: [] });
    expect(run.loggedCount()).toBe(0);

    run.sink.accept(report('b0run00001')); // lowercase on the way in
    // The product lookup uses the canonical form — both sides must meet.
    const taken = run.takeUnsentFor([{ asin: 'B0RUN00001' }]);
    expect(taken).toHaveLength(1);
  });

  it('T27: an updatedExisting re-send does not re-log any product', () => {
    const run = createCollectionDiagnosticsRun();
    const products = [
      { asin: asin(1) },
      { asin: asin(2) },
      { asin: asin(3) },
    ];
    for (const p of products) run.sink.accept(report(p.asin!));

    // First batch: a new-products batch carrying all three.
    const first = run.takeUnsentFor(products);
    expect(first).toHaveLength(3);

    // The `updatedExisting` path re-sends the ENTIRE run's products — none of
    // the reports may ride along a second time (D11).
    const resend = run.takeUnsentFor(products);
    expect(resend).toHaveLength(0);

    // A product that appears later in the run still gets its one delivery.
    run.sink.accept(report(asin(4)));
    const later = run.takeUnsentFor([...products, { asin: asin(4) }]);
    expect(later).toHaveLength(1);
    expect(later[0]!.asin).toBe(asin(4));
  });

  it('T26: reset() starts a fresh run — counter, reports and sent-set', () => {
    const run = createCollectionDiagnosticsRun();
    for (let i = 1; i <= 60; i += 1) run.sink.accept(report(asin(i)));
    expect(run.takeUnsentFor([{ asin: asin(1) }])).toHaveLength(1);

    run.reset();
    expect(run.loggedCount()).toBe(0);

    // The same cards in the new run are new reports, delivered again.
    run.sink.accept(report(asin(1)));
    expect(run.loggedCount()).toBe(1);
    expect(run.takeUnsentFor([{ asin: asin(1) }])).toHaveLength(1);
  });

  it('PRODUCTS_COLLECTED validates with and without the reports field', () => {
    const product = {
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Anker Charger',
      price: 39.99,
      currency: 'EUR',
      source: 'search',
    };
    const base = {
      type: 'PRODUCTS_COLLECTED' as const,
      payload: { products: [product], totalCount: 1, isNewBatch: true },
    };

    // An older content script sends no reports at all.
    expect(ProductsCollectedMessageSchema.safeParse(base).success).toBe(true);

    const withReports = {
      ...base,
      payload: { ...base.payload, extractionDiagnostics: [report('B08N5WRWNW')] },
    };
    expect(ProductsCollectedMessageSchema.safeParse(withReports).success).toBe(
      true,
    );

    // A report is not a parallel array: one report for three products is
    // perfectly valid (the subset rule, D11).
    const subset = {
      ...base,
      payload: {
        products: [product, product, product],
        totalCount: 3,
        isNewBatch: true,
        extractionDiagnostics: [report('B08N5WRWNW')],
      },
    };
    expect(ProductsCollectedMessageSchema.safeParse(subset).success).toBe(true);
  });
});
