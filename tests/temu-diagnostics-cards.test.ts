/**
 * SAD-360 step 3 — card (search/category) parser instrumentation.
 *
 * The card path has no JSON-LD, so every status comes from DOM evidence the
 * existing helpers already had. Parity is asserted for every fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_DIAGNOSTIC_FIELDS,
  createFieldDiagnosticsCollector,
  summarizeFieldDiagnostics,
  type ExtractionDiagnosticsReport,
} from '@/engines/temu/scraper/extraction-diagnostics';
import { parseTemuCategoryPage } from '@/engines/temu/scraper/category-page';
import { TemuParseCache } from '@/engines/temu/scraper/parse-cache';
import { parseTemuSearchResults } from '@/engines/temu/scraper/search-results';
import {
  CARD_URL,
  DUPLICATE_CARD_GRID,
  FULL_CARD,
  MINIMAL_CARD,
  NO_GOODS_ID_CARD,
  UNPARSEABLE_PRICE_CARD,
  cardGrid,
} from './fixtures/temu-pdp-fixtures';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function parseCards(
  html: string,
  options: { cache?: TemuParseCache; source?: 'search' | 'category' } = {}
) {
  const diagnosticsByGoodsId = new Map<string, ExtractionDiagnosticsReport>();
  const products = parseTemuSearchResults(
    createDoc(html),
    CARD_URL,
    options.cache,
    options.source ?? 'search',
    diagnosticsByGoodsId
  );
  return { products, diagnosticsByGoodsId };
}

function fieldsOf(report: ExtractionDiagnosticsReport) {
  return new Map(report.fields.map((entry) => [entry.field, entry]));
}

describe('SAD-360 step 3 — card field-set contract', () => {
  it('reports exactly the 20 modelled card fields, never description/features', () => {
    const { diagnosticsByGoodsId } = parseCards(cardGrid([FULL_CARD]));
    const report = diagnosticsByGoodsId.get('601099769178067');
    expect(report).toBeDefined();
    expect(report!.fields).toHaveLength(20);
    expect(report!.fields.map((entry) => entry.field)).toEqual([
      ...CARD_DIAGNOSTIC_FIELDS,
    ]);
    for (const excluded of ['description', 'features', 'goodsId', 'asin', 'source']) {
      expect(report!.fields.some((entry) => entry.field === excluded)).toBe(
        false
      );
    }
    expect(report!.stage).toBe('search');
    expect(report!.goodsId).toBe('601099769178067');
  });

  it('the five counts partition the reported fields', () => {
    const { diagnosticsByGoodsId } = parseCards(cardGrid([FULL_CARD]));
    const report = diagnosticsByGoodsId.get('601099769178067')!;
    const counts = summarizeFieldDiagnostics(report.fields);
    expect(
      counts.extracted +
        counts.missing +
        counts.parseFailed +
        counts.partial +
        counts.unknown
    ).toBe(20);
  });
});

describe('SAD-360 step 3 — card outcomes', () => {
  it('classifies every field of a complete card as EXTRACTED', () => {
    const { diagnosticsByGoodsId } = parseCards(cardGrid([FULL_CARD]));
    const report = diagnosticsByGoodsId.get('601099769178067')!;
    expect(summarizeFieldDiagnostics(report.fields)).toEqual({
      extracted: 20,
      missing: 0,
      parseFailed: 0,
      partial: 0,
      unknown: 0,
    });
    const fields = fieldsOf(report);
    expect(fields.get('title')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '[data-tooltip-title]',
    });
    expect(fields.get('imageUrl')).toMatchObject({
      source: 'dom',
      selector: 'img[data-js-main-img="true"]',
    });
    expect(fields.get('url')).toMatchObject({ source: 'url' });
    expect(fields.get('isSponsored')).toMatchObject({ status: 'EXTRACTED' });
  });

  it('reports genuinely absent card fields as MISSING with reasons', () => {
    const { diagnosticsByGoodsId } = parseCards(cardGrid([MINIMAL_CARD]));
    const fields = fieldsOf(diagnosticsByGoodsId.get('601099769178068')!);
    expect(fields.get('rating')).toMatchObject({
      status: 'MISSING',
      reason: 'no rating element',
    });
    expect(fields.get('pastMonthSales')).toMatchObject({
      status: 'MISSING',
      reason: 'no sales-tip node',
    });
    expect(fields.get('discountPercentage')).toMatchObject({
      status: 'MISSING',
      reason: 'no discount badge',
    });
    expect(fields.get('currency')).toMatchObject({
      status: 'MISSING',
      reason: 'no currency token and no price to derive from',
    });
    expect(fields.get('imageUrl')).toMatchObject({
      status: 'MISSING',
      reason: 'no image element in the card',
    });
    expect(fields.get('isPrime')).toMatchObject({
      status: 'MISSING',
      reason: 'no Local warehouse marker found',
    });
  });

  it('distinguishes a rejected price node from an absent one', () => {
    const { diagnosticsByGoodsId } = parseCards(
      cardGrid([UNPARSEABLE_PRICE_CARD])
    );
    expect(fieldsOf(diagnosticsByGoodsId.get('601099769178069')!).get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'price node present but no parseable price',
    });
  });
});

describe('SAD-360 step 3 — silence where silence is correct', () => {
  it('produces no report for a cached card', () => {
    const cache = new TemuParseCache();
    const html = cardGrid([FULL_CARD]);
    const first = parseCards(html, { cache });
    expect(first.diagnosticsByGoodsId.size).toBe(1);

    // A second parse of the same DOM node hits the cache and skips extraction.
    const cache2 = new TemuParseCache();
    const doc = createDoc(html);
    const collector = new Map<string, ExtractionDiagnosticsReport>();
    const productsA = parseTemuSearchResults(doc, CARD_URL, cache2, 'search', collector);
    expect(productsA).toHaveLength(1);
    collector.clear();
    const productsB = parseTemuSearchResults(doc, CARD_URL, cache2, 'search', collector);
    expect(productsB).toHaveLength(1);
    expect(collector.size).toBe(0);
    expect(productsB).toStrictEqual(productsA);
  });

  it('produces no report for a node with no resolvable goodsId', () => {
    const { products, diagnosticsByGoodsId } = parseCards(
      cardGrid([NO_GOODS_ID_CARD])
    );
    expect(products).toHaveLength(0);
    expect(diagnosticsByGoodsId.size).toBe(0);
  });

  it('produces exactly one report when the same card appears twice', () => {
    const { products, diagnosticsByGoodsId } = parseCards(DUPLICATE_CARD_GRID);
    expect(products).toHaveLength(1);
    expect(diagnosticsByGoodsId.size).toBe(1);
  });
});

describe('SAD-360 step 3 — category delegation', () => {
  it('forwards the collector map and labels the stage as category', () => {
    const diagnosticsByGoodsId = new Map<string, ExtractionDiagnosticsReport>();
    const html = cardGrid([FULL_CARD]);
    const products = parseTemuCategoryPage(
      createDoc(html),
      CARD_URL,
      'category',
      undefined,
      diagnosticsByGoodsId
    );
    expect(products).toHaveLength(1);
    const report = diagnosticsByGoodsId.get('601099769178067');
    expect(report?.stage).toBe('category');
    expect(report?.fields).toHaveLength(20);
  });
});

describe('SAD-360 step 3 — parity', () => {
  it('returns identical products with and without a collector for every fixture', () => {
    const fixtures = [
      cardGrid([FULL_CARD]),
      cardGrid([MINIMAL_CARD]),
      cardGrid([UNPARSEABLE_PRICE_CARD]),
      DUPLICATE_CARD_GRID,
      cardGrid([FULL_CARD, MINIMAL_CARD, UNPARSEABLE_PRICE_CARD]),
    ];
    for (const [index, html] of fixtures.entries()) {
      const without = parseTemuSearchResults(createDoc(html), CARD_URL);
      const withDiag = parseCards(html).products;
      expect(withDiag, `fixture ${index}`).toStrictEqual(without);
    }
  });

  it('keeps the collector optional at the card parser boundary', () => {
    expect(parseTemuSearchResults(createDoc(cardGrid([FULL_CARD])), CARD_URL)).toStrictEqual(
      parseCards(cardGrid([FULL_CARD])).products
    );
  });

  it('never writes extracted values or HTML into a card report', () => {
    const { diagnosticsByGoodsId } = parseCards(cardGrid([FULL_CARD]));
    const serialized = JSON.stringify([...diagnosticsByGoodsId.values()]);
    for (const leaked of [
      'Wireless Bluetooth Earbuds',
      'AnkerDirect',
      'Anker',
      '10K+ sold',
      '12.49',
      '29.99',
      'Free shipping',
      '<div',
      '<span',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
