// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyValidationResults,
  CARD_DIAGNOSTIC_FIELDS,
  createFieldDiagnosticsCollector,
  DETAIL_DIAGNOSTIC_FIELDS,
  formatTemuExtractionDiagnosticsLog,
  summarizeFieldDiagnostics,
  type FieldDiagnostic,
  type FieldDiagnosticsCollector,
  type FieldExtractionSource,
  type TemuDiagnosticField,
} from '@/engines/temu/scraper/extraction-diagnostics';
import { validateAndNormalizeTemuScrapedProduct } from '@/engines/temu/scraper/field-parsers';
import type { TemuScrapedProduct } from '@/engines/temu/types';

const GOODS_ID = '601099769178067';
const PRODUCT_URL = `https://www.temu.com/goods.html?goods_id=${GOODS_ID}`;
const PREFIX = '[PPHunt][Temu][Diagnostics] ';

function fieldMap(collector: FieldDiagnosticsCollector) {
  return new Map(collector.build().fields.map((entry) => [entry.field, entry]));
}

function candidate(overrides: Partial<TemuScrapedProduct> = {}) {
  return { goodsId: GOODS_ID, asin: GOODS_ID, url: PRODUCT_URL, ...overrides };
}

function normalize(raw: Partial<TemuScrapedProduct>) {
  const product = validateAndNormalizeTemuScrapedProduct(raw, PRODUCT_URL);
  if (!product) throw new Error('Expected a valid Temu unit-test fixture');
  return product;
}

afterEach(() => vi.restoreAllMocks());

describe('SAD-360 Temu diagnostics collector (step 1, no parser wiring)', () => {
  it('runs without a DOM or browser extension globals', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(createFieldDiagnosticsCollector().build().stage).toBe('product_detail');
  });

  it('pins the exact modelled PDP/card field sets and excludes identifiers/unsupported fields', () => {
    expect(DETAIL_DIAGNOSTIC_FIELDS).toEqual([
      'url', 'title', 'price', 'listPrice', 'discountPercentage', 'currency',
      'rating', 'reviewCount', 'pastMonthSales', 'imageUrl', 'brand', 'seller',
      'availability', 'dealBadge', 'badge', 'coupon', 'delivery', 'bestSellersRank',
      'description', 'features', 'isSponsored', 'isPrime',
    ]);
    expect(new Set(DETAIL_DIAGNOSTIC_FIELDS).size).toBe(22);
    expect(CARD_DIAGNOSTIC_FIELDS).toEqual(
      DETAIL_DIAGNOSTIC_FIELDS.filter((field) => field !== 'description' && field !== 'features')
    );
    expect(new Set(CARD_DIAGNOSTIC_FIELDS).size).toBe(20);
    for (const field of ['goodsId', 'asin', 'source', 'variations', 'weight', 'categoryBreadcrumb']) {
      expect(DETAIL_DIAGNOSTIC_FIELDS).not.toContain(field);
      expect(CARD_DIAGNOSTIC_FIELDS).not.toContain(field);
    }
    expect(Object.isFrozen(DETAIL_DIAGNOSTIC_FIELDS)).toBe(true);
    expect(Object.isFrozen(CARD_DIAGNOSTIC_FIELDS)).toBe(true);
  });

  it('fills unattempted fields with UNKNOWN, never guessed absence or validation', () => {
    const report = createFieldDiagnosticsCollector().build();
    expect(report.goodsId).toBeNull();
    expect(report.fields).toHaveLength(22);
    for (const entry of report.fields) {
      expect(entry).toEqual({ field: entry.field, status: 'UNKNOWN', reason: 'not attempted' });
    }
    expect(summarizeFieldDiagnostics(report.fields)).toEqual({
      extracted: 0, missing: 0, parseFailed: 0, partial: 0, unknown: 22,
    });
  });

  it.each(['search', 'category'] as const)('reports only the 20 card fields for %s', (stage) => {
    const collector = createFieldDiagnosticsCollector(stage);
    collector.extracted('description');
    collector.missing('features', 'not on cards');
    const report = collector.build();
    expect(report.stage).toBe(stage);
    expect(report.fields.map((entry) => entry.field)).toEqual(CARD_DIAGNOSTIC_FIELDS);
    expect(report.fields).toHaveLength(20);
    expect(collector.entries().size).toBe(0);
  });

  it('records all five statuses with field-specific metadata and reasons', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.setGoodsId(GOODS_ID);
    collector.extracted('url', { source: 'url' });
    collector.missing('rating', 'no rating marker found', { source: 'dom', selector: '[role="img"]' });
    collector.parseFailed('price', 'price node present but unparseable', { source: 'dom', selector: '[data-type="price"]' });
    collector.partial('imageUrl', 'image rejected by validation', { source: 'json-ld' });
    collector.unknown('description', 'malformed JSON-LD; field presence undetermined');
    const fields = fieldMap(collector);
    expect(collector.build().goodsId).toBe(GOODS_ID);
    expect(fields.get('url')).toEqual({ field: 'url', status: 'EXTRACTED', source: 'url' });
    expect(fields.get('rating')).toMatchObject({ status: 'MISSING', source: 'dom', selector: '[role="img"]', reason: 'no rating marker found' });
    expect(fields.get('price')).toMatchObject({ status: 'PARSE_FAILED', selector: '[data-type="price"]' });
    expect(fields.get('imageUrl')?.status).toBe('PARTIAL');
    expect(fields.get('description')).toMatchObject({ status: 'UNKNOWN', reason: 'malformed JSON-LD; field presence undetermined' });
    expect(summarizeFieldDiagnostics(collector.build().fields)).toEqual({
      extracted: 1, missing: 1, parseFailed: 1, partial: 1, unknown: 18,
    });
  });

  it.each<FieldExtractionSource>(['dom', 'json-ld', 'url', 'derived'])('supports Temu provenance %s without inventing an API source', (source) => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('currency', { source });
    expect(fieldMap(collector).get('currency')?.source).toBe(source);
  });

  it('keeps JSON-LD-only success separate from an explicit rescue of a rejected DOM candidate', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('rating', { source: 'json-ld' });
    collector.parseFailed('price', 'DOM price rejected', { source: 'dom', selector: '[data-type="price"]' });
    collector.rescued('price', 'DOM price rejected; JSON-LD fallback used', { source: 'json-ld', selector: '[data-type="price"]' });
    expect(fieldMap(collector).get('rating')).toMatchObject({ status: 'EXTRACTED', source: 'json-ld' });
    expect(fieldMap(collector).get('price')).toMatchObject({ status: 'PARTIAL', source: 'json-ld', selector: '[data-type="price"]' });
  });

  it('uses the final write without retaining stale status metadata', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.missing('title', 'old missing reason', { source: 'dom', selector: 'h1' });
    collector.extracted('title', { source: 'json-ld' });
    expect(fieldMap(collector).get('title')).toEqual({ field: 'title', status: 'EXTRACTED', source: 'json-ld' });
    collector.setGoodsId(GOODS_ID);
    collector.setGoodsId(null);
    expect(collector.build().goodsId).toBeNull();
  });

  it('returns independent report snapshots', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('title', { source: 'dom', selector: 'h1' });
    const report = collector.build();
    report.fields.find((entry) => entry.field === 'title')!.status = 'MISSING';
    report.fields.pop();
    const next = collector.build();
    expect(next.fields).toHaveLength(22);
    expect(fieldMap(collector).get('title')).toMatchObject({ status: 'EXTRACTED', source: 'dom' });
  });

  it.each(['source', 'selector', 'reason'] as const)('isolates a failing diagnostic %s getter', (key) => {
    const collector = createFieldDiagnosticsCollector();
    const options = Object.defineProperty({}, key, { get() { throw new Error('diagnostic fault'); } });
    expect(() => collector.extracted('title', options)).not.toThrow();
    expect(fieldMap(collector).get('title')?.status).toBe('UNKNOWN');
    collector.extracted('price', { source: 'dom' });
    expect(fieldMap(collector).get('price')?.status).toBe('EXTRACTED');
  });
});

describe('SAD-360 validation reconciliation', () => {
  const droppedCases: Array<[TemuDiagnosticField, Partial<TemuScrapedProduct>]> = [
    ['imageUrl', { imageUrl: 'ftp://example.com/product.jpg' }],
    ['price', { price: -1 }],
    ['listPrice', { price: 9, listPrice: 9 }],
    ['rating', { rating: 9 }],
    ['reviewCount', { reviewCount: -1 }],
  ];

  it.each(droppedCases)('marks validation-dropped %s PARTIAL/validated:false using the existing validator', (field, values) => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted(field, { source: 'json-ld' });
    const raw = candidate(values);
    const normalized = normalize(raw);
    expect(normalized[field]).toBeNull();
    applyValidationResults(collector, raw, normalized);
    expect(fieldMap(collector).get(field)).toMatchObject({ status: 'PARTIAL', validated: false, reason: 'parsed but failed validation', source: 'json-ld' });
  });

  it('stamps survivors without changing a rescue back to EXTRACTED', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('title', { source: 'dom' });
    collector.rescued('price', 'DOM failed; JSON-LD fallback used', { source: 'json-ld' });
    const raw = candidate({ title: 'A valid title', price: 12.49 });
    applyValidationResults(collector, raw, normalize(raw));
    expect(fieldMap(collector).get('title')).toMatchObject({ status: 'EXTRACTED', validated: true });
    expect(fieldMap(collector).get('price')).toMatchObject({ status: 'PARTIAL', validated: true, reason: 'DOM failed; JSON-LD fallback used' });
  });

  it('retains legitimate numeric zero values', () => {
    const collector = createFieldDiagnosticsCollector();
    for (const field of ['price', 'rating', 'reviewCount'] as const) collector.extracted(field);
    const raw = candidate({ price: 0, rating: 0, reviewCount: 0 });
    applyValidationResults(collector, raw, normalize(raw));
    for (const field of ['price', 'rating', 'reviewCount'] as const) {
      expect(fieldMap(collector).get(field)).toMatchObject({ status: 'EXTRACTED', validated: true });
    }
  });

  it.each(['isSponsored', 'isPrime'] as const)('does not mark legitimate false %s as validation failure', (field) => {
    const collector = createFieldDiagnosticsCollector();
    collector.missing(field, `no ${field} marker found`, { source: 'dom' });
    const raw = candidate({ [field]: false });
    const normalized = normalize(raw);
    expect(normalized[field]).toBe(false);
    applyValidationResults(collector, raw, normalized);
    expect(fieldMap(collector).get(field)).toEqual({ field, status: 'MISSING', reason: `no ${field} marker found`, source: 'dom' });
    collector.extracted(field, { source: 'dom' });
    applyValidationResults(collector, raw, normalized);
    expect(fieldMap(collector).get(field)).toMatchObject({ status: 'EXTRACTED', validated: true });
  });

  it.each(['isSponsored', 'isPrime'] as const)('validates a found %s marker', (field) => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted(field, { source: 'dom' });
    const raw = candidate({ [field]: true });
    applyValidationResults(collector, raw, normalize(raw));
    expect(fieldMap(collector).get(field)).toMatchObject({ status: 'EXTRACTED', validated: true });
  });

  it('does not invent validation or provenance for missing, unparseable, unknown, or absent candidates', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.missing('title', 'no title found');
    collector.parseFailed('rating', 'rating rejected');
    collector.unknown('price', 'parser aborted');
    collector.extracted('brand');
    const before = collector.build();
    const raw = candidate({ title: 'Kept title', rating: 4, price: 1 });
    applyValidationResults(collector, raw, normalize(raw));
    expect(collector.build()).toEqual(before);
    expect(collector.entries().size).toBe(4);
  });

  it('leaves outcomes untouched when the whole product is rejected', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('title');
    const before = collector.build();
    applyValidationResults(collector, candidate({ title: 'Title' }), null);
    expect(collector.build()).toEqual(before);
  });

  it('does not mutate the candidate or normalized product', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('imageUrl');
    collector.extracted('features');
    const raw = Object.freeze(candidate({ imageUrl: 'ftp://example.com/image.jpg', features: ['Feature one'] }));
    const normalized = Object.freeze(normalize(raw));
    const before = JSON.stringify({ raw, normalized });
    applyValidationResults(collector, raw, normalized);
    expect(JSON.stringify({ raw, normalized })).toBe(before);
  });

  it('isolates reconciliation faults', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('title');
    const raw = candidate({ title: 'A title' });
    const normalized = normalize(raw);
    const faultyRaw = Object.defineProperty({ ...raw }, 'title', { get() { throw new Error('diagnostic fault'); } });
    expect(() => applyValidationResults(collector, faultyRaw, normalized)).not.toThrow();
    expect(() => applyValidationResults({ ...collector, entries() { throw new Error('collector fault'); } }, raw, normalized)).not.toThrow();
  });
});

describe('SAD-360 summary and value-free formatter', () => {
  it('counts each status exactly once and handles an empty field list', () => {
    const entries: FieldDiagnostic[] = [
      { field: 'url', status: 'EXTRACTED' },
      { field: 'title', status: 'MISSING' },
      { field: 'price', status: 'PARSE_FAILED' },
      { field: 'rating', status: 'PARTIAL' },
      { field: 'brand', status: 'UNKNOWN' },
    ];
    expect(summarizeFieldDiagnostics(entries)).toEqual({ extracted: 1, missing: 1, parseFailed: 1, partial: 1, unknown: 1 });
    expect(summarizeFieldDiagnostics([])).toEqual({ extracted: 0, missing: 0, parseFailed: 0, partial: 0, unknown: 0 });
  });

  it.each(['product_detail', 'search', 'category'] as const)('formats one JSON line with matching %s counts and explicit context', (stage) => {
    const collector = createFieldDiagnosticsCollector(stage);
    collector.setGoodsId(GOODS_ID);
    collector.extracted('url', { source: 'url' });
    collector.missing('title', 'no title\nmarker found');
    const report = collector.build();
    const line = formatTemuExtractionDiagnosticsLog(report, { sessionId: 'session-1', pageType: 'unknown' });
    expect(line).toMatch(/^\[PPHunt\]\[Temu\]\[Diagnostics\] \{/);
    expect(line).not.toContain('\n');
    const payload = JSON.parse(line!.slice(PREFIX.length));
    expect(payload).toMatchObject({ goodsId: GOODS_ID, sessionId: 'session-1', stage, pageType: 'unknown' });
    expect(payload.counts).toEqual(summarizeFieldDiagnostics(report.fields));
    expect(Object.values(payload.counts).reduce((sum: number, count) => sum + Number(count), 0)).toBe(stage === 'product_detail' ? 22 : 20);
    expect(payload.fields).toEqual(report.fields);
  });

  it('preserves null identifiers without inventing a session or a detected page type', () => {
    const report = createFieldDiagnosticsCollector().build();
    const line = formatTemuExtractionDiagnosticsLog(report);
    const payload = JSON.parse(line!.slice(PREFIX.length));
    expect(payload.goodsId).toBeNull();
    expect(payload.sessionId).toBeNull();
    expect(payload.stage).toBe('product_detail');
    expect(payload).not.toHaveProperty('pageType');
  });

  it('whitelists metadata and cannot leak raw values, HTML, or extra transport properties', () => {
    const collector = createFieldDiagnosticsCollector();
    const raw = candidate({ title: 'SECRET_TITLE', price: 129.87, imageUrl: 'https://example.com/SECRET_IMAGE.jpg' });
    const options = { source: 'dom' as const, selector: 'h1', value: raw.title, html: '<h1>SECRET_HTML</h1>' };
    collector.extracted('title', options);
    applyValidationResults(collector, raw, normalize(raw));
    expect(fieldMap(collector).get('title')).not.toHaveProperty('value');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const report = collector.build();
    const extraReport = { ...report, product: raw, response: circular, fields: report.fields.map((entry) => ({ ...entry, value: raw.title, html: options.html, raw: circular })) };
    const line = formatTemuExtractionDiagnosticsLog(extraReport, { sessionId: 'session-1' });
    expect(line).not.toBeNull();
    for (const value of ['SECRET_TITLE', '129.87', 'SECRET_IMAGE', 'SECRET_HTML', '<h1>', PRODUCT_URL, '"value"', '"product"', '"response"', '"raw"']) {
      expect(line).not.toContain(value);
    }
  });

  it('returns null on serialization failure and performs no console I/O', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = createFieldDiagnosticsCollector().build();
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('serialization fault'); });
    expect(formatTemuExtractionDiagnosticsLog(report)).toBeNull();
    expect(formatTemuExtractionDiagnosticsLog(report)).toMatch(/^\[PPHunt\]\[Temu\]\[Diagnostics\] /);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
