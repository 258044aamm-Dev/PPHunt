/**
 * SAD-360 — the live measurement harness's comparison logic.
 *
 * The harness itself needs a real browser and a real Temu page, so it cannot
 * run in CI. What *can* be tested is the part that decides whether a diagnostic
 * agrees with the row the extension stored — the part that would otherwise be
 * trusted blindly when it judges a live run.
 */
import { describe, expect, it } from 'vitest';
import {
  PREFIX,
  TEMU_DB_NAME,
  isEmpty,
  parseArgs,
  pdpUrl,
  verifyField,
  verifyReports,
  type HarnessField,
  type TemuDiagnosticStatus,
} from '../scripts/temu-diagnostics-measurement.mjs';

function field(
  name: string,
  status: TemuDiagnosticStatus,
  validated?: boolean
): HarnessField {
  return { field: name, status, validated };
}

describe('SAD-360 measurement harness — arguments', () => {
  it('defaults to no targets and requires one at call time', () => {
    const options = parseArgs([]);
    expect(options.pdps).toEqual([]);
    expect(options.listing).toBeNull();
    expect(options.targetCount).toBe(20);
  });

  it('parses comma-separated goodsIds and a listing URL', () => {
    const options = parseArgs([
      '--pdps',
      '601099769178067, 601099769178068',
      '--listing',
      'https://www.temu.com/search_result.html?search_key=x',
      '--target',
      '5',
    ]);
    expect(options.pdps).toEqual(['601099769178067', '601099769178068']);
    expect(options.listing).toContain('search_result');
    expect(options.targetCount).toBe(5);
  });

  it('accepts a bare goodsId or a full URL', () => {
    expect(pdpUrl('601099769178067')).toBe(
      'https://www.temu.com/goods.html?goods_id=601099769178067'
    );
    expect(pdpUrl('https://www.temu.com/x-g-601099769178067.html')).toBe(
      'https://www.temu.com/x-g-601099769178067.html'
    );
  });

  it('pins the prefix the operator filters on', () => {
    expect(PREFIX).toBe('[PPHunt][Temu][Diagnostics]');
    expect(TEMU_DB_NAME).toBe('PPHuntTemuDB');
  });
});

describe('SAD-360 measurement harness — emptiness rules', () => {
  it('treats null, empty strings and empty arrays as absent', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty('   ')).toBe(true);
    expect(isEmpty([])).toBe(true);
  });

  it('treats zero as a present value', () => {
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty('0')).toBe(false);
    expect(isEmpty(['x'])).toBe(false);
  });
});

describe('SAD-360 measurement harness — field agreement', () => {
  it('accepts EXTRACTED only when the stored row has the value', () => {
    expect(verifyField(field('title', 'EXTRACTED'), { title: 'Earbuds' })).toBeNull();
    expect(verifyField(field('title', 'EXTRACTED'), { title: null })).toContain(
      'no value'
    );
  });

  it('accepts a validation drop reported as PARTIAL validated:false', () => {
    expect(
      verifyField(field('listPrice', 'PARTIAL', false), { listPrice: null })
    ).toBeNull();
    expect(
      verifyField(field('listPrice', 'PARTIAL', false), { listPrice: 29.99 })
    ).toContain('still has a value');
  });

  it('accepts a rescue reported as PARTIAL without validated:false', () => {
    expect(verifyField(field('price', 'PARTIAL'), { price: 19.99 })).toBeNull();
    expect(verifyField(field('price', 'PARTIAL'), { price: null })).toContain(
      'no value'
    );
  });

  it('accepts MISSING / PARSE_FAILED / UNKNOWN only when the row is empty', () => {
    for (const status of [
      'MISSING',
      'PARSE_FAILED',
      'UNKNOWN',
    ] as TemuDiagnosticStatus[]) {
      expect(verifyField(field('brand', status), { brand: null })).toBeNull();
      expect(verifyField(field('brand', status), { brand: 'Anker' })).toContain(
        'still has a value'
      );
    }
  });

  it('treats a legitimate false boolean as absent for marker fields (D6)', () => {
    expect(
      verifyField(field('isPrime', 'MISSING'), { isPrime: false })
    ).toBeNull();
    expect(
      verifyField(field('isPrime', 'MISSING'), { isPrime: true })
    ).toContain('still has a value');
  });

  it('flags an unknown status', () => {
    expect(
      verifyField(
        { field: 'title', status: 'MADE_UP' as TemuDiagnosticStatus },
        { title: 'x' }
      )
    ).toContain('unknown status');
  });
});

describe('SAD-360 measurement harness — report verification', () => {
  it('matches each report to its stored row by goodsId', () => {
    const reports = [
      {
        goodsId: '601099769178067',
        stage: 'product_detail',
        counts: { extracted: 1 },
        fields: [field('title', 'EXTRACTED'), field('brand', 'MISSING')],
      },
    ];
    const stored = [
      { goodsId: '601099769178067', title: 'Earbuds', brand: null },
    ];
    const [result] = verifyReports(reports, stored);
    expect(result!.storedProductPresent).toBe(true);
    expect(result!.mismatches).toEqual([]);
  });

  it('reports a mismatch when a stored value contradicts the report', () => {
    const reports = [
      {
        goodsId: '601099769178067',
        stage: 'search',
        fields: [field('brand', 'MISSING')],
      },
    ];
    const stored = [{ goodsId: '601099769178067', brand: 'Anker' }];
    const [result] = verifyReports(reports, stored);
    expect(result!.mismatches).toHaveLength(1);
    expect(result!.mismatches[0]!.field).toBe('brand');
  });

  it('handles a null-id report without inventing a stored row', () => {
    const [result] = verifyReports(
      [
        {
          goodsId: null,
          stage: 'product_detail',
          fields: [field('price', 'UNKNOWN')],
        },
      ],
      [{ goodsId: '601099769178067', price: 1 }]
    );
    expect(result!.storedProductPresent).toBe(false);
    expect(result!.mismatches).toEqual([]);
  });
});
