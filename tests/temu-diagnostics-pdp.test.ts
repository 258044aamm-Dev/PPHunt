/**
 * SAD-360 step 2 — PDP parser instrumentation.
 *
 * Two guarantees are tested together:
 *  1. every supported PDP field is classified from evidence the parser already
 *     had (EXTRACTED / MISSING / PARSE_FAILED / PARTIAL / UNKNOWN), and
 *  2. the parsed product is identical with and without the collector.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_DIAGNOSTIC_FIELDS,
  DETAIL_DIAGNOSTIC_FIELDS,
  createFieldDiagnosticsCollector,
  formatTemuExtractionDiagnosticsLog,
  summarizeFieldDiagnostics,
  type FieldDiagnostic,
  type ExtractionDiagnosticsReport,
} from '@/engines/temu/scraper/extraction-diagnostics';
import { parseTemuProductDetail } from '@/engines/temu/scraper/product-detail';
import {
  FEATURES_ABSENT_PDP,
  FEATURES_REJECTED_PDP,
  FULL_PDP,
  INVALID_HERO_IMAGE_PDP,
  JSON_LD_ONLY_PDP,
  JSON_LD_RATING_REJECTED_PDP,
  LIST_PRICE_EQUAL_PDP,
  MALFORMED_JSON_LD_PDP,
  MINIMAL_PDP,
  NO_GOODS_ID_PDP,
  PDP_FIXTURES,
  PDP_URL,
  PRICE_RESCUED_PDP,
  PRICE_UNPARSEABLE_PDP,
  TITLE_RESCUED_PDP,
  ZERO_RATING_PDP,
} from './fixtures/temu-pdp-fixtures';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

interface Parsed {
  product: ReturnType<typeof parseTemuProductDetail>;
  report: ExtractionDiagnosticsReport;
  byField: Map<string, FieldDiagnostic>;
}

function parseWithDiagnostics(
  html: string,
  url: string = PDP_URL
): Parsed {
  const collector = createFieldDiagnosticsCollector('product_detail');
  const product = parseTemuProductDetail(createDoc(html), url, collector);
  const report = collector.build();
  return {
    product,
    report,
    byField: new Map(report.fields.map((entry) => [entry.field, entry])),
  };
}

function parseWithoutDiagnostics(html: string, url: string = PDP_URL) {
  return parseTemuProductDetail(createDoc(html), url);
}

describe('SAD-360 step 2 — field-set contract', () => {
  it('reports exactly the 22 modelled PDP fields and never an identifier or unsupported field', () => {
    const { report } = parseWithDiagnostics(FULL_PDP);
    expect(report.fields).toHaveLength(22);
    expect(report.fields.map((entry) => entry.field)).toEqual([
      ...DETAIL_DIAGNOSTIC_FIELDS,
    ]);
    for (const excluded of [
      'goodsId',
      'asin',
      'source',
      'categoryBreadcrumb',
      'variations',
      'weight',
    ]) {
      expect(report.fields.some((entry) => entry.field === excluded)).toBe(
        false
      );
    }
    expect(report.stage).toBe('product_detail');
    expect(report.goodsId).toBe('601099769178067');
  });

  it('the five counts partition the reported fields for every fixture', () => {
    for (const fixture of PDP_FIXTURES) {
      const { report } = parseWithDiagnostics(fixture.html, fixture.url);
      const counts = summarizeFieldDiagnostics(report.fields);
      const total =
        counts.extracted +
        counts.missing +
        counts.parseFailed +
        counts.partial +
        counts.unknown;
      expect(total, fixture.name).toBe(report.fields.length);
      expect(total, fixture.name).toBe(22);
    }
  });
});

describe('SAD-360 step 2 — full and minimal pages', () => {
  it('classifies every field of a complete PDP as EXTRACTED', () => {
    const { product, report } = parseWithDiagnostics(FULL_PDP);
    expect(product).not.toBeNull();
    expect(summarizeFieldDiagnostics(report.fields)).toEqual({
      extracted: 22,
      missing: 0,
      parseFailed: 0,
      partial: 0,
      unknown: 0,
    });
    expect(report.fields.every((entry) => entry.source)).toBe(true);
  });

  it('records the winning source and selector for DOM-backed fields', () => {
    const { byField } = parseWithDiagnostics(FULL_PDP);
    expect(byField.get('title')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '#rightContent h1[aria-label], #leftContent h1[aria-label], #rightContent h1, #leftContent h1, h1[aria-label], h1',
    });
    expect(byField.get('price')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '[data-type="price"]',
    });
    expect(byField.get('url')).toMatchObject({
      status: 'EXTRACTED',
      source: 'derived',
    });
    expect(byField.get('isSponsored')).toMatchObject({
      status: 'EXTRACTED',
      source: 'derived',
    });
    expect(byField.get('isPrime')).toMatchObject({ status: 'EXTRACTED' });
  });

  it('reports absent fields as MISSING with a field-specific reason, never UNKNOWN', () => {
    const { report, byField } = parseWithDiagnostics(MINIMAL_PDP);
    expect(report.fields.some((entry) => entry.status === 'UNKNOWN')).toBe(
      false
    );
    expect(byField.get('brand')).toMatchObject({
      status: 'MISSING',
      reason: 'no Brand label in the page metadata',
    });
    expect(byField.get('seller')).toMatchObject({
      status: 'MISSING',
      reason: 'no seller label in the page metadata',
    });
    expect(byField.get('coupon')).toMatchObject({
      status: 'MISSING',
      reason: 'no coupon marker found',
    });
    expect(byField.get('features')).toMatchObject({
      status: 'MISSING',
      reason: 'no feature/spec list nodes',
    });
    expect(byField.get('listPrice')).toMatchObject({ status: 'MISSING' });
    expect(byField.get('discountPercentage')).toMatchObject({
      status: 'MISSING',
    });
  });
});

describe('SAD-360 step 2 — failure causes are distinguishable', () => {
  it('a price node that cannot be parsed is PARSE_FAILED, not MISSING', () => {
    const { byField } = parseWithDiagnostics(PRICE_UNPARSEABLE_PDP);
    expect(byField.get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      source: 'dom',
      reason: 'price node present but no parseable price',
    });
  });

  it('structured-data-only pages report the JSON-LD source', () => {
    const { report, byField } = parseWithDiagnostics(JSON_LD_ONLY_PDP);
    for (const field of [
      'title',
      'price',
      'currency',
      'rating',
      'reviewCount',
      'imageUrl',
      'brand',
      'seller',
      'availability',
      'description',
    ]) {
      expect(byField.get(field), field).toMatchObject({
        status: 'EXTRACTED',
        source: 'json-ld',
      });
    }
    expect(summarizeFieldDiagnostics(report.fields).unknown).toBe(0);
  });

  it('a JSON-LD rescue of a rejected DOM candidate is PARTIAL, not EXTRACTED', () => {
    const { product, byField } = parseWithDiagnostics(PRICE_RESCUED_PDP);
    expect(product?.price).toBe(19.99);
    expect(byField.get('price')).toMatchObject({
      status: 'PARTIAL',
      source: 'json-ld',
      reason: 'DOM price candidate rejected; JSON-LD price used',
      validated: true,
    });
  });

  it('a malformed JSON-LD block downgrades unattributable absence to UNKNOWN', () => {
    const { byField } = parseWithDiagnostics(MALFORMED_JSON_LD_PDP);
    expect(byField.get('price')).toMatchObject({
      status: 'UNKNOWN',
      reason: 'malformed JSON-LD block; attribution unknown',
    });
    expect(byField.get('rating')).toMatchObject({ status: 'UNKNOWN' });
    // Fields with no JSON-LD source keep their evidence-based status.
    expect(byField.get('coupon')).toMatchObject({ status: 'MISSING' });
    expect(byField.get('isPrime')).toMatchObject({ status: 'MISSING' });
  });

  it('a value the validator drops is PARTIAL with validated:false', () => {
    const { product, byField } = parseWithDiagnostics(LIST_PRICE_EQUAL_PDP);
    expect(product?.listPrice ?? null).toBeNull();
    expect(byField.get('listPrice')).toMatchObject({
      status: 'PARTIAL',
      validated: false,
      reason: 'parsed but failed validation',
    });
  });

  it('an element that exists but yields nothing is PARSE_FAILED, and its rescue is PARTIAL', () => {
    const { product, byField } = parseWithDiagnostics(TITLE_RESCUED_PDP);
    expect(product?.title).toBe('Title From Structured Data');
    expect(byField.get('title')).toMatchObject({
      status: 'PARTIAL',
      source: 'json-ld',
    });
  });

  it('distinguishes absent feature nodes from feature candidates that were rejected', () => {
    expect(
      parseWithDiagnostics(FEATURES_ABSENT_PDP).byField.get('features')
    ).toMatchObject({ status: 'MISSING', reason: 'no feature/spec list nodes' });
    expect(
      parseWithDiagnostics(FEATURES_REJECTED_PDP).byField.get('features')
    ).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'feature candidates rejected by length or dedup filters',
    });
  });

  it('reports an unusable hero image as PARSE_FAILED and the JSON-LD rescue as PARTIAL', () => {
    const { product, byField } = parseWithDiagnostics(INVALID_HERO_IMAGE_PDP);
    expect(product?.imageUrl).toBe(
      'https://img.kwcdn.com/product/fancy/hero-real.jpg'
    );
    expect(byField.get('imageUrl')).toMatchObject({
      status: 'PARTIAL',
      source: 'json-ld',
    });
  });
});

describe('SAD-360 step 2 — booleans, zero values and structured rejections', () => {
  it('keeps a legitimate false boolean as MISSING with a marker reason (never validated:false)', () => {
    const { byField } = parseWithDiagnostics(MINIMAL_PDP);
    expect(byField.get('isSponsored')).toEqual({
      field: 'isSponsored',
      status: 'MISSING',
      source: 'derived',
      reason: 'no Ad/Sponsored marker found',
    });
    expect(byField.get('isPrime')).toEqual({
      field: 'isPrime',
      status: 'MISSING',
      source: 'derived',
      reason: 'no Local warehouse marker found',
    });
  });

  it('treats a zero-star rating as an extracted value', () => {
    const { product, byField } = parseWithDiagnostics(ZERO_RATING_PDP);
    expect(product?.rating).toBe(0);
    expect(byField.get('rating')).toMatchObject({
      status: 'EXTRACTED',
      validated: true,
    });
    expect(byField.get('reviewCount')).toMatchObject({
      status: 'EXTRACTED',
      validated: true,
    });
  });

  it('records a rejected JSON-LD value as PARSE_FAILED on the json-ld source', () => {
    const { byField } = parseWithDiagnostics(JSON_LD_RATING_REJECTED_PDP);
    expect(byField.get('rating')).toMatchObject({
      status: 'PARSE_FAILED',
      source: 'json-ld',
      reason: 'JSON-LD ratingValue present but not a 0-5 value',
    });
  });

  it('emits a null-id report for a PDP with no resolvable goodsId (D7)', () => {
    const collector = createFieldDiagnosticsCollector('product_detail');
    const product = parseTemuProductDetail(
      createDoc(NO_GOODS_ID_PDP),
      'https://www.temu.com/some-landing-page.html',
      collector
    );
    expect(product).toBeNull();
    const report = collector.build();
    expect(report.goodsId).toBeNull();
    expect(report.fields).toHaveLength(22);
    expect(report.fields.every((entry) => entry.status === 'UNKNOWN')).toBe(
      true
    );
    expect(report.fields.every((entry) => entry.reason === 'not attempted')).toBe(
      true
    );
    const line = formatTemuExtractionDiagnosticsLog(report, {
      sessionId: 'session-1',
    });
    expect(line).toContain('[PPHunt][Temu][Diagnostics] ');
    expect(line).toContain('"goodsId":null');
  });

  it('reports the canonical link as the url source when one exists', () => {
    const html = `<html><head><link rel="canonical" href="${PDP_URL}" /></head><body>${MINIMAL_PDP.replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '')}</body></html>`;
    const { byField } = parseWithDiagnostics(html);
    expect(byField.get('url')).toMatchObject({
      status: 'EXTRACTED',
      source: 'url',
      selector: 'link[rel="canonical"]',
    });
  });
});

describe('SAD-360 step 2 — parity and log hygiene', () => {
  it('returns the identical product with and without a collector for every fixture', () => {
    for (const fixture of PDP_FIXTURES) {
      const without = parseWithoutDiagnostics(fixture.html, fixture.url);
      const withDiag = parseWithDiagnostics(fixture.html, fixture.url).product;
      expect(withDiag, fixture.name).toStrictEqual(without);
    }
    const withoutNoId = parseWithoutDiagnostics(
      NO_GOODS_ID_PDP,
      'https://www.temu.com/some-landing-page.html'
    );
    const withNoId = parseWithDiagnostics(
      NO_GOODS_ID_PDP,
      'https://www.temu.com/some-landing-page.html'
    ).product;
    expect(withNoId).toBeNull();
    expect(withoutNoId).toBeNull();
  });

  it('never writes an extracted value, HTML fragment or unsupported field into the report', () => {
    const { report } = parseWithDiagnostics(FULL_PDP);
    const serialized = JSON.stringify(report);
    for (const leaked of [
      'Wireless Bluetooth Earbuds',
      'AnkerDirect',
      'Anker',
      '10K+ sold',
      '29.99',
      '12.49',
      'Free shipping',
      '#1 Best Seller',
      '<div',
      '<span',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    for (const entry of report.fields) {
      expect(CARD_DIAGNOSTIC_FIELDS.length).toBeLessThan(
        DETAIL_DIAGNOSTIC_FIELDS.length
      );
      expect(entry.field).not.toBe('goodsId');
    }
  });

  it('formats one paste-safe line per product with the exact prefix', () => {
    const { report } = parseWithDiagnostics(FULL_PDP);
    const line = formatTemuExtractionDiagnosticsLog(report, {
      sessionId: 'session-abc',
      pageType: 'product_detail',
    });
    expect(line).not.toBeNull();
    expect(line!.startsWith('[PPHunt][Temu][Diagnostics] ')).toBe(true);
    expect(line!.includes('\n')).toBe(false);
    const payload = JSON.parse(line!.slice('[PPHunt][Temu][Diagnostics] '.length));
    expect(payload).toMatchObject({
      goodsId: '601099769178067',
      sessionId: 'session-abc',
      stage: 'product_detail',
      pageType: 'product_detail',
      counts: { extracted: 22, missing: 0, parseFailed: 0, partial: 0, unknown: 0 },
    });
    expect(payload.fields).toHaveLength(22);
  });

  it('keeps the collector optional at the parser boundary', () => {
    expect(parseWithoutDiagnostics(FULL_PDP)).toStrictEqual(
      parseWithDiagnostics(FULL_PDP).product
    );
  });
});
