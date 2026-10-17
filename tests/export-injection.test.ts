/**
 * Step 1.2 (SAD-159) — H-6: spreadsheet formula injection.
 * Seller-authored listing content must never reach Excel / Google Sheets /
 * LibreOffice Calc as a live formula through any of the three exporters.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import type { Product } from '@/types/product';
import { buildCSVContent } from '@/lib/export/csv';
import { exportClipboard } from '@/lib/export/clipboard';
import { buildExcelWorkbookBuffer } from '@/lib/export/excel';
import { neutralizeSpreadsheetFormula } from '@/lib/export/sanitize';

const TRIGGER = /^[=+\-@\t\r]/;

const PAYLOADS = [
  '=1+1',
  '+1+1',
  '-1+1',
  '@SUM(A1:A2)',
  "=cmd|'/C calc'!A0",
  '=HYPERLINK("http://evil.example";"Click")',
  '\t=1+1', // tab-prefixed bypass
  '\r=1+1', // CR-prefixed bypass (SAD-191: explicit \r coverage)
  '=DDE("cmd";"/C calc";"A1")',
];

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    asin: 'B0INJECT01',
    url: 'https://www.amazon.com/dp/B0INJECT01',
    title: 'Benign Title',
    price: 19.99,
    currency: 'USD',
    collectedAt: '2026-10-17T00:00:00.000Z',
    sessionKey: 'session_test',
    source: 'search',
    ...overrides,
  };
}

describe('neutralizeSpreadsheetFormula', () => {
  it('prefixes every trigger character and leaves benign values untouched', () => {
    for (const payload of PAYLOADS) {
      const neutralized = neutralizeSpreadsheetFormula(payload);
      expect(neutralized.startsWith("'")).toBe(true);
      expect(TRIGGER.test(neutralized)).toBe(false);
    }
    expect(neutralizeSpreadsheetFormula('Wireless Charger, 20W')).toBe(
      'Wireless Charger, 20W'
    );
    expect(neutralizeSpreadsheetFormula('')).toBe('');
  });
});

describe('CSV export — formula injection (H-6)', () => {
  it('no emitted cell begins with a trigger character', () => {
    for (const payload of PAYLOADS) {
      const csv = buildCSVContent([makeProduct({ title: payload })], ['Title']);
      const dataRow = csv.split('\n')[1]!;
      // A quoted cell (RFC 4180) legitimately starts with '"' — a non-trigger.
      expect(TRIGGER.test(dataRow)).toBe(false);
      // The actual cell content (after unquoting) must start with the
      // neutralising apostrophe.
      const content = dataRow.startsWith('"')
        ? dataRow.slice(1, -1).replace(/""/g, '"')
        : dataRow;
      expect(content.startsWith("'")).toBe(true);
      expect(TRIGGER.test(content)).toBe(false);
    }
  });

  it('a payload containing a comma is neutralised AND correctly quoted', () => {
    const csv = buildCSVContent(
      [makeProduct({ title: "=cmd|'/C calc'!A0,A1" })],
      ['Title']
    );
    const dataRow = csv.split('\n')[1]!;
    expect(dataRow).toBe(`"'=cmd|'/C calc'!A0,A1"`);
  });

  it('R6: benign comma value stays quoted with no apostrophe; BOM stays at position 0', () => {
    const csv = buildCSVContent(
      [makeProduct({ title: 'Wireless Charger, 20W' })],
      ['Title']
    );
    expect(csv.split('\n')[1]).toBe('"Wireless Charger, 20W"');

    const withBom = buildCSVContent(
      [makeProduct({ title: '=1+1' })],
      ['Title'],
      true
    );
    expect(withBom.charCodeAt(0)).toBe(0xfeff);
    expect(withBom.slice(1).split('\n')[1]!.startsWith("'")).toBe(true);
  });
});

describe('Clipboard (TSV) export — formula injection (H-6)', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  it('no pasted cell begins with a trigger character', async () => {
    for (const payload of PAYLOADS) {
      writeText.mockClear();
      await exportClipboard([makeProduct({ title: payload })], ['Title']);
      const tsv = writeText.mock.calls[0]![0] as string;
      const dataRow = tsv.split('\n')[1]!;
      expect(TRIGGER.test(dataRow)).toBe(false);
      if (payload.startsWith('\t')) {
        // Deliberate ordering (per plan): structural characters are stripped
        // FIRST, so a tab-prefixed payload becomes " =1+1" — a leading space
        // is not a formula trigger, and no apostrophe is needed.
        expect(dataRow.startsWith(' ')).toBe(true);
      } else {
        expect(dataRow.startsWith("'")).toBe(true);
      }
    }
  });
});

describe('XLSX export — formula injection (H-6)', () => {
  it('string cells are neutralised; numeric cells stay real numbers (R6)', async () => {
    for (const payload of PAYLOADS) {
      const bytes = await buildExcelWorkbookBuffer(
        [makeProduct({ title: payload })],
        ['Title'],
        { fetchImage: async () => null }
      );
      const wb = XLSX.read(bytes, { type: 'array' });
      const cell = wb.Sheets['Products']!['A2']!;
      expect(typeof cell.v).toBe('string');
      // SAD-191: no cell may be of formula type ('f') in the written file.
      expect(cell.t).toBe('s');
      expect(TRIGGER.test(String(cell.v))).toBe(false);
      expect(String(cell.v).startsWith("'")).toBe(true);
    }

    // R6: price -5 stays the NUMBER -5 (sortable/summable), not the string '-5'
    const bytes = await buildExcelWorkbookBuffer(
      [makeProduct({ price: -5 })],
      ['Price'],
      { fetchImage: async () => null }
    );
    const wb = XLSX.read(bytes, { type: 'array' });
    const priceCell = wb.Sheets['Products']!['A2']!;
    expect(typeof priceCell.v).toBe('number');
    expect(priceCell.v).toBe(-5);

    // R6: a negative discount STRING is prefixed (string field → correct mitigation)
    const discountBytes = await buildExcelWorkbookBuffer(
      [makeProduct({ discountPercentage: '-68%' })],
      ['Discount'],
      { fetchImage: async () => null }
    );
    const discountWb = XLSX.read(discountBytes, { type: 'array' });
    const discountCell = discountWb.Sheets['Products']!['A2']!;
    expect(discountCell.v).toBe("'-68%");
  });
});

describe('SAD-191 gap coverage — R6 parity in CSV/clipboard, unicode, multiline', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  it('R6: CSV writes a genuine negative number as the bare literal, but escapes the string "-5"', () => {
    const numericCsv = buildCSVContent([makeProduct({ price: -5 })], ['Price']);
    expect(numericCsv.split('\n')[1]).toBe('-5');

    const stringCsv = buildCSVContent(
      [makeProduct({ discountPercentage: '-5' })],
      ['Discount']
    );
    expect(stringCsv.split('\n')[1]).toBe("'-5");
  });

  it('R6: clipboard writes a genuine negative number bare, but escapes the string "-5"', async () => {
    await exportClipboard([makeProduct({ price: -5 })], ['Price']);
    expect((writeText.mock.calls[0]![0] as string).split('\n')[1]).toBe('-5');

    writeText.mockClear();
    await exportClipboard(
      [makeProduct({ discountPercentage: '-5' })],
      ['Discount']
    );
    expect((writeText.mock.calls[0]![0] as string).split('\n')[1]).toBe("'-5");
  });

  it('unicode and multiline titles are unaffected (no apostrophe) in all three formats', async () => {
    const title = 'Café ☕ 20W Fast Charger\nSecond Line — Ünicode';

    const csv = buildCSVContent([makeProduct({ title })], ['Title']);
    // Quoted because of the newline; content itself unchanged.
    expect(csv.split('\n').slice(1).join('\n')).toBe(`"${title}"`);

    const bytes = await buildExcelWorkbookBuffer(
      [makeProduct({ title })],
      ['Title'],
      { fetchImage: async () => null }
    );
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.Sheets['Products']!['A2']!.v).toBe(title);

    await exportClipboard([makeProduct({ title })], ['Title']);
    // TSV strips the structural newline by design (Phase 1); the unicode
    // content itself must survive untouched and un-prefixed.
    expect((writeText.mock.calls[0]![0] as string).split('\n')[1]).toBe(
      title.replace(/\n/g, ' ')
    );
  });

  it('round-trip: benign values are byte-identical to the raw input', () => {
    const csv = buildCSVContent(
      [makeProduct({ title: 'Anker 737 Power Bank', brand: 'Anker' })],
      ['Title', 'Brand']
    );
    expect(csv).toBe('Title,Brand\nAnker 737 Power Bank,Anker');
  });
});
