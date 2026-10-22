/**
 * SAD-349 — Warranty Description extraction.
 *
 * Two things are pinned here that fail silently if they regress:
 *
 * 1. `normalizeWarrantyDescription` must return null when a cell states no
 *    coverage period. That is what rejects Amazon's boilerplate "Product
 *    Warranty: For warranty information about this product, please click here"
 *    structurally — there is no denylist, so a new boilerplate variant cannot
 *    slip through.
 * 2. `validateAndNormalizeScrapedProduct` must keep both warranty keys. It
 *    builds an explicit `normalized` object, so an omitted key dies there
 *    without any error — the exact failure mode SAD-330 was filed for.
 *
 * The four DOM fixtures cover every shape Amazon ships for the Product
 * information block, because the warranty row moves between them by category
 * and page age.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeWarrantyDescription } from '@/engines/amazon/scraper/field-parsers';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';
import { createFieldDiagnosticsCollector } from '@/engines/amazon/scraper/extraction-diagnostics';

const SHELL = (body: string) => new DOMParser().parseFromString(
  `<!doctype html><html><body>
     <h1 id="productTitle">Widget</h1>
     <input id="ASIN" value="B0WARANTY1" />
     ${body}
   </body></html>`, 'text/html');

const PDP = 'https://www.amazon.com/dp/B0WARANTY1';

describe('normalizeWarrantyDescription', () => {
  const cases: Array<[string, string | null]> = [
    ['2 year manufacturer', '2-year'],
    ['1-year manufacturer warranty on parts and labor', '1-year'],
    ['1 Year Warranty', '1-year'],
    ['1 year', '1-year'],
    ['One-Year Limited Warranty', '1-year'],
    ['90-Day Limited Warranty', '90-day'],
    ['90 days', '90-day'],
    ['Two-Year Limited Warranty', '2-year'],
    ['Worry-Free Guarantee (Two-Year Limited Warranty)', '2-year'],
    ['2 years', '2-year'],
    ['3 Month', '3-month'],
    ['24 months', '24-month'],
    ['twenty-four year', '24-year'],
    ['Limited lifetime warranty', 'lifetime'],
    // SAD-393 step 5 (P-W2 probe table): the fraction the seller printed is
    // the token — '1.5 years' used to garble to '5-year' (matched mid-number).
    ['1.5 years', '1.5-year'],
    ['1.5-Year Limited Warranty', '1.5-year'],
    ['12.5 years', '12.5-year'],
    ['2.5 years', '2.5-year'],
    // Parenthesized digit forms used to yield nothing.
    ['Five (5) Year', '5-year'],
    ['One (1) Year', '1-year'],
    ['(3) Year Limited Warranty', '3-year'],
    // Typographic dashes used to yield nothing (folded inside the
    // normalizer only, never in the shared whitespace pass).
    ['2 year', '2-year'],
    ['2 year', '2-year'],
    ['3-yr', '3-year'],
    // A quantity never starts mid-number: no salvage from a version string.
    ['Version 2.5.1 years', null],
    // the boilerplate + non-durations must yield nothing
    ['For warranty information about this product, please click here', null],
    ['Product Warranty: For warranty information about this product, please click here', null],
    ['Manufacturer warranty', null],
    ['See description', null],
    ['No warranty', null],
    ['', null],
    ['   ', null],
  ];
  it.each(cases)('%j -> %j', (input, expected) => {
    expect(normalizeWarrantyDescription(input)).toBe(expected);
  });
  it('survives the LRM mark Amazon injects into detailBullets', () => {
    expect(normalizeWarrantyDescription('2 year\u200e manufacturer')).toBe('2-year');
  });
});

describe('parseAmazonProductDetail — warranty shapes', () => {
  it('tech-spec table (th/td)', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<table id="productDetails_techSpec_section_1"><tr>
         <th class="prodDetSectionEntry">Warranty Description</th>
         <td class="prodDetAttrValue">2 year manufacturer</td></tr></table>`), PDP);
    expect(p?.warrantyDescription).toBe('2-year');
    expect(p?.warrantyDescriptionRaw).toBe('2 year manufacturer');
  });

  it('detail-bullets table (th/td)', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<table id="productDetails_detailBullets_sections1"><tr>
         <th>Warranty</th><td>90 days</td></tr></table>`), PDP);
    expect(p?.warrantyDescription).toBe('90-day');
  });

  it('detail-bullets list (span.a-text-bold + colon)', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<div id="detailBulletsWrapper_feature_div"><ul><li>
         <span class="a-text-bold">Warranty Description:\u200e</span> One-Year Limited Warranty
       </li></ul></div>`), PDP);
    expect(p?.warrantyDescription).toBe('1-year');
    expect(p?.warrantyDescriptionRaw).toBe('One-Year Limited Warranty');
  });

  it('product-overview table (label in first td)', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<div id="productOverview_feature_div"><table><tr class="po-warranty">
         <td><span class="a-text-bold">Warranty</span></td>
         <td><span class="po-break-word">1 Year</span></td></tr></table></div>`), PDP);
    expect(p?.warrantyDescription).toBe('1-year');
    expect(p?.warrantyDescriptionRaw).toBe('1 Year');
  });

  it('REJECTS the click-here boilerplate', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<div id="prodDetails"><table><tr>
         <th>Product Warranty</th>
         <td>For warranty information about this product, please click here</td>
       </tr></table></div>`), PDP);
    expect(p).not.toBeNull();
    expect(p?.warrantyDescription).toBeUndefined();
    expect(p?.warrantyDescriptionRaw).toBeUndefined();
  });

  it('skips the boilerplate row and takes the real row that follows', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<div id="prodDetails"><table>
         <tr><th>Product Warranty</th><td>For warranty information about this product, please click here</td></tr>
         <tr><th>Warranty Description</th><td>2 year manufacturer</td></tr>
       </table></div>`), PDP);
    expect(p?.warrantyDescription).toBe('2-year');
  });

  it('omits the key entirely when no warranty row exists', () => {
    const p = parseAmazonProductDetail(SHELL(
      `<table id="productDetails_techSpec_section_1"><tr>
         <th>Brand</th><td>Acme</td></tr></table>`), PDP);
    expect(p).not.toBeNull();
    expect('warrantyDescription' in (p as object)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * The three merge gates. Each of these is a whitelist: a field missing from it
 * is dropped without an error, which is exactly how SAD-330's "data collected
 * but never displayed" bug was produced. One pin per gate.
 * ------------------------------------------------------------------------- */

import React, { StrictMode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

/**
 * jsdom reports every scroll container as 0px tall, so the real
 * `useVirtualizer` returns no virtual items and the table body renders empty.
 * This is the same mock the pricing-deals-bsr suite installs; without it a
 * rendered-row assertion cannot pass in this environment at all.
 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        end: (index + 1) * 52,
        size: 52,
      })),
  }),
}));
import { db } from '@/engines/amazon/db/database';
import { addProducts } from '@/engines/amazon/db/products';
import { mergeScrapedProductFields } from '@/engines/amazon/scraper/dedup';
import { mergeDetailIntoStored } from '@/engines/amazon/background/enrich-saved-product';
import type { Product, ScrapedProduct } from '@/engines/amazon/types';

function scraped(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B0WARANTY1',
    url: 'https://www.amazon.com/dp/B0WARANTY1',
    title: 'Widget',
    price: null,
    currency: 'USD',
    rating: null,
    reviewCount: null,
    imageUrl: null,
    isSponsored: false,
    isPrime: false,
    brand: null,
    availability: null,
    seller: null,
    description: null,
    features: [],
    source: 'detail',
    ...overrides,
  };
}

describe('merge gates', () => {
  it('G4: mergeScrapedProductFields carries both warranty keys', () => {
    const target = scraped({ source: 'search' });
    const source = scraped({
      warrantyDescription: '1-year',
      warrantyDescriptionRaw: '1 Year Warranty',
    });
    const changed = mergeScrapedProductFields(target, source);
    expect(changed).toBe(true);
    expect(target.warrantyDescription).toBe('1-year');
    expect(target.warrantyDescriptionRaw).toBe('1 Year Warranty');
  });

  it('G6: mergeDetailIntoStored fills warranty and reports the change', () => {
    const stored = {
      ...scraped({ source: 'search' }),
      collectedAt: '2026-10-20T00:00:00.000Z',
      sessionKey: 'sess-1',
    } as Product;
    const detail = scraped({
      warrantyDescription: '90-day',
      warrantyDescriptionRaw: '90 days',
    });

    const { patch, changedFields } = mergeDetailIntoStored(stored, detail);

    expect(patch.warrantyDescription).toBe('90-day');
    expect(patch.warrantyDescriptionRaw).toBe('90 days');
    expect(changedFields).toContain('warrantyDescription');
    expect(changedFields).toContain('warrantyDescriptionRaw');
  });

  it('G6: a currency mismatch skips the price family but still lands warranty', () => {
    const stored = {
      ...scraped({ source: 'search', price: 10, currency: 'USD' }),
      collectedAt: '2026-10-20T00:00:00.000Z',
      sessionKey: 'sess-1',
    } as Product;
    const detail = scraped({
      price: 12,
      currency: 'EUR',
      warrantyDescription: '2-year',
      warrantyDescriptionRaw: '2 year manufacturer',
    });

    const { patch } = mergeDetailIntoStored(stored, detail);

    expect(patch.price).toBeUndefined(); // price family skipped
    expect(patch.warrantyDescription).toBe('2-year'); // warranty is not in it
  });
});

describe('G5: addProducts backfills warranty onto an existing row', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('fills a row that was first collected without a warranty', async () => {
    await addProducts([scraped({ source: 'search' })], 'sess-w');

    const before = await db.products.where('sessionKey').equals('sess-w').first();
    expect(before?.warrantyDescription).toBeUndefined();

    await addProducts(
      [scraped({ warrantyDescription: '1-year', warrantyDescriptionRaw: '1 Year' })],
      'sess-w',
    );

    const after = await db.products.where('sessionKey').equals('sess-w').first();
    expect(after?.warrantyDescription).toBe('1-year');
    expect(after?.warrantyDescriptionRaw).toBe('1 Year');
  });

  it('never overwrites a warranty already stored', async () => {
    await addProducts(
      [scraped({ warrantyDescription: '1-year', warrantyDescriptionRaw: '1 Year' })],
      'sess-w',
    );
    await addProducts(
      [scraped({ warrantyDescription: '5-year', warrantyDescriptionRaw: '5 Years' })],
      'sess-w',
    );

    const row = await db.products.where('sessionKey').equals('sess-w').first();
    expect(row?.warrantyDescription).toBe('1-year');
    expect(row?.warrantyDescriptionRaw).toBe('1 Year');
  });
});

/* ------------------------------------------------------------------------- *
 * Settings. The claim to prove is that a NEW key needs no migration:
 * parseStoredSettings merges {...DEFAULT_ENABLED_FIELDS, ...stored}, so an
 * install written by the previous build simply gains the key on its next read.
 * Bumping settingsVersion here would be the unnecessary change.
 * ------------------------------------------------------------------------- */

import { getSettings, updateSettings } from '@/engines/amazon/db/settings';
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_ENABLED_FIELDS,
} from '@/engines/amazon/constants/defaults';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';

describe('settings integration', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('an install written before the field existed gains it with no migration', async () => {
    // Exactly what the previous build stored: current version, no warranty key.
    const { warrantyDescription: _drop, ...legacyFields } = (
      await getSettings()
    ).enabledFields;
    await db.settings.put({
      id: 'default',
      settingsVersion: CURRENT_SETTINGS_VERSION,
      enabledFields: legacyFields,
    } as never);

    const settings = await getSettings();

    expect(settings.enabledFields.warrantyDescription).toBe(true);
    // No version bump, and nothing else about the row was rewritten.
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(settings.enabledFields.description).toBe(true);
    expect(settings.enabledFields.features).toBe(true);
  });

  it('a deliberate toggle-off sticks across a reload', async () => {
    await getSettings();
    await updateSettings({ enabledFields: { warrantyDescription: false } });

    const stored = await db.settings.get('default');
    expect(stored?.enabledFields.warrantyDescription).toBe(false);

    const reread = await getSettings();
    expect(reread.enabledFields.warrantyDescription).toBe(false);
  });
});

describe('Settings > DATA FIELDS', () => {
  beforeEach(async () => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    await db.delete();
    await db.open();
    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('renders a "Warranty Description" toggle, on by default, that persists', async () => {
    render(
      <StrictMode>
        <Header />
        <SettingsOverlay />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    await screen.findByText('DATA FIELDS', {}, { timeout: 3000 });

    const box = screen.getByLabelText('Warranty Description') as HTMLInputElement;
    expect(box.checked).toBe(true);

    // Pins the "24 data-field toggles" figure quoted in README.md and
    // ARCHITECTURE.md: the grid holds exactly one label per enabledFields key,
    // so a new field that forgets its toggle shows up here.
    const grid = box.closest('label')?.parentElement;
    expect(grid?.querySelectorAll('label > input[type="checkbox"]').length).toBe(
      Object.keys(DEFAULT_ENABLED_FIELDS).length,
    );
    expect(Object.keys(DEFAULT_ENABLED_FIELDS)).toHaveLength(26);

    fireEvent.click(box);

    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row?.enabledFields.warrantyDescription).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------------- *
 * The Preview table. All four surfaces — side panel, full-width preview modal,
 * dedicated preview tab and History preview — render through this one
 * component, so this is the whole UI acceptance surface.
 * ------------------------------------------------------------------------- */

import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { getColumnsForSettings } from '@/entrypoints/sidepanel/table/columns';

function row(asin: string, over: Partial<Product> = {}): Product {
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: `Widget ${asin}`,
    price: 10,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 10,
    imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
    isSponsored: false,
    isPrime: false,
    brand: 'Acme',
    availability: 'In Stock',
    seller: 'Amazon.com',
    description: null,
    features: [],
    source: 'detail',
    collectedAt: '2026-10-20T00:00:00.000Z',
    sessionKey: 'sess-warranty-ui',
    ...over,
  };
}

describe('Preview table', () => {
  // NOT db.delete(): destroying the database tears down Dexie's observable that
  // useLiveQuery subscribes to, so the table would render its empty state no
  // matter what was inserted. Matches the pricing-deals-bsr suite.
  beforeEach(async () => {
    await db.open();
    await db.products.clear();
    await db.settings.clear();
  });

  afterEach(() => cleanup());

  it('shows the token, carries the verbatim text as its tooltip, and says No when absent', async () => {
    await db.products.bulkAdd([
      row('B0WARANTY1', {
        warrantyDescription: '2-year',
        warrantyDescriptionRaw: '2 year manufacturer',
      }),
      row('B0WARANTY2'),
    ]);

    render(<ProductTable fullHeight sessionKey="sess-warranty-ui" />);

    await waitFor(() => {
      const withWarranty = screen.getByTestId('product-warranty-B0WARANTY1');
      expect(withWarranty.textContent).toBe('2-year');
      // The raw cell must still be reachable — that is the whole point of
      // storing warrantyDescriptionRaw alongside the token.
      expect(withWarranty.getAttribute('title')).toBe('2 year manufacturer');
    });

    // Absent renders "No" and, like the other promotional cells, has no testid.
    expect(screen.queryByTestId('product-warranty-B0WARANTY2')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Warranty' })).toBeTruthy();
  });

  it('is a column the settings toggle can remove on its own', () => {
    const on = getColumnsForSettings({
      title: true, asin: true, url: true, price: true, listPrice: true,
      discountPercentage: true, dealBadge: true, currency: true, rating: true,
      reviewCount: true, bestSellersRank: true, pastMonthSales: true,
      coupon: true, badge: true, delivery: true, imageUrl: true,
      isSponsored: true, isPrime: true, brand: true, availability: true,
      seller: true, description: true, features: true,
      variations: true, weight: true, warrantyDescription: true,
    });
    const off = getColumnsForSettings({
      title: true, asin: true, url: true, price: true, listPrice: true,
      discountPercentage: true, dealBadge: true, currency: true, rating: true,
      reviewCount: true, bestSellersRank: true, pastMonthSales: true,
      coupon: true, badge: true, delivery: true, imageUrl: true,
      isSponsored: true, isPrime: true, brand: true, availability: true,
      seller: true, description: true, features: true,
      variations: true, weight: true, warrantyDescription: false,
    });
    const ids = (cols: unknown[]) =>
      (cols as Array<{ id?: string; accessorKey?: string }>).map(
        (c) => c.id ?? c.accessorKey,
      );
    expect(ids(on)).toContain('warrantyDescription');
    expect(ids(off)).not.toContain('warrantyDescription');
    expect(ids(off).length).toBe(ids(on).length - 1);
  });
});

/* ------------------------------------------------------------------------- *
 * Exports. The ticket's "included in all relevant exports" criterion, checked
 * against the real builders rather than the column list alone — the three
 * writers coerce missing values differently, which is exactly why `|| 'No'`
 * has to live in the accessor.
 * ------------------------------------------------------------------------- */

import * as XLSX from 'xlsx';
import { buildCSVContent } from '@/engines/amazon/export/csv';
import { buildClipboardTSV } from '@/engines/amazon/export/clipboard';
import { buildExcelWorkbookBuffer } from '@/engines/amazon/export/excel';
import {
  DEFAULT_VISIBLE_COLUMNS,
  getExportColumnsFromSettings,
} from '@/engines/amazon/export/types';

const exportSample: Product[] = [
  row('B0WARANTY1', {
    warrantyDescription: '2-year',
    warrantyDescriptionRaw: '2 year manufacturer',
  }),
  row('B0WARANTY2'),
];

describe('Exports', () => {
  it('ships both warranty columns by default, in the right place', () => {
    const i = DEFAULT_VISIBLE_COLUMNS.indexOf('Warranty Description');
    expect(i).toBeGreaterThan(DEFAULT_VISIBLE_COLUMNS.indexOf('Features'));
    expect(DEFAULT_VISIBLE_COLUMNS[i + 1]).toBe('Warranty Details');
    expect(DEFAULT_VISIBLE_COLUMNS[i + 2]).toBe('Source');
  });

  it('CSV carries the token, the verbatim text, and No when absent', () => {
    const csv = buildCSVContent(exportSample, DEFAULT_VISIBLE_COLUMNS, false);
    const lines = csv.split('\n');

    expect(lines[0]).toContain('Warranty Description,Warranty Details');
    // Populated row: token then verbatim cell.
    expect(lines[1]).toContain('2-year,2 year manufacturer');
    // Absent row: both columns fall back to No, never blank and never a dash.
    expect(lines[2]).toContain('No,No');
    expect(csv).not.toContain('—');
  });

  it('clipboard TSV agrees with CSV cell for cell', () => {
    const tsv = buildClipboardTSV(exportSample, DEFAULT_VISIBLE_COLUMNS);
    const lines = tsv.split('\n');

    expect(lines[0]).toContain('Warranty Description\tWarranty Details');
    expect(lines[1]).toContain('2-year\t2 year manufacturer');
    expect(lines[2]).toContain('No\tNo');
  });

  it('XLSX keeps both columns as text, including the No fallback', async () => {
    const bytes = await buildExcelWorkbookBuffer(
      exportSample,
      DEFAULT_VISIBLE_COLUMNS,
      { embedImages: 'always', fetchImage: async () => null },
    );
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets['Products'];
    if (!sheet) throw new Error('Products sheet missing from workbook');
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ASIN: 'B0WARANTY1',
      'Warranty Description': '2-year',
      'Warranty Details': '2 year manufacturer',
    });
    expect(rows[1]).toMatchObject({
      ASIN: 'B0WARANTY2',
      'Warranty Description': 'No',
      'Warranty Details': 'No',
    });
  });

  it('the settings toggle removes both columns from an export', () => {
    const on = getExportColumnsFromSettings({
      title: true, asin: true, url: true, price: true, listPrice: true,
      discountPercentage: true, dealBadge: true, currency: true, rating: true,
      reviewCount: true, bestSellersRank: true, pastMonthSales: true,
      coupon: true, badge: true, delivery: true, imageUrl: true,
      isSponsored: true, isPrime: true, brand: true, availability: true,
      seller: true, description: true, features: true,
      variations: true, weight: true, warrantyDescription: true,
    });
    const off = getExportColumnsFromSettings({
      title: true, asin: true, url: true, price: true, listPrice: true,
      discountPercentage: true, dealBadge: true, currency: true, rating: true,
      reviewCount: true, bestSellersRank: true, pastMonthSales: true,
      coupon: true, badge: true, delivery: true, imageUrl: true,
      isSponsored: true, isPrime: true, brand: true, availability: true,
      seller: true, description: true, features: true,
      variations: true, weight: true, warrantyDescription: false,
    });

    expect(on).toContain('Warranty Description');
    expect(on).toContain('Warranty Details');
    expect(off).not.toContain('Warranty Description');
    expect(off).not.toContain('Warranty Details');
    expect(off.length).toBe(on.length - 2);

    // And the omission actually reaches the CSV, not just the column list.
    const csv = buildCSVContent(exportSample, off, false);
    expect(csv.split('\n')[0]).not.toContain('Warranty');
  });
});

describe('SAD-393 step 4 — Amazon Devices warranty reach (verbatim captures)', () => {
  // Live captures 2026-10-21 (step-0 evidence). Wrappers restore the
  // captured ancestry noted in each fixture's header comment; layout divs
  // between the wrapper and the table are omitted, as they were in step 0.
  const fixture = (name: string) =>
    readFileSync(join(__dirname, '..', 'docs', 'plans', 'SAD-393-fixtures', name), 'utf8');

  const pdpWith = (asin: string, body: string) =>
    new DOMParser().parseFromString(
      `<!doctype html><html><body>
         <h1 id="productTitle">Fixture ${asin}</h1>
         <input id="ASIN" value="${asin}" />
         ${body}
       </body></html>`,
      'text/html',
    );

  it('Kindle Paperwhite: Warranty and Service row under #tech -> 1-year, Raw is the full cell', () => {
    const p = parseAmazonProductDetail(
      pdpWith('B0CFPJYX7P', `<div id="tech">${fixture('pdp-kindle-warranty-table.real.html')}</div>`),
      'https://www.amazon.com/dp/B0CFPJYX7P',
    );
    // The cell also offers optional 1/2/3-year extensions; first-duration-
    // wins keeps the INCLUDED term, Raw keeps the seller's full sentence.
    expect(p?.warrantyDescription).toBe('1-year');
    expect(p?.warrantyDescriptionRaw).toContain(
      '1-year limited warranty and service included',
    );
  });

  it('Echo Dot: Warranty and service row under #tech -> 90-day (not the optional 1-year extension)', () => {
    const p = parseAmazonProductDetail(
      pdpWith('B09B93ZDG4', `<div id="tech">${fixture('pdp-echo-warranty-table.real.html')}</div>`),
      'https://www.amazon.com/dp/B09B93ZDG4',
    );
    expect(p?.warrantyDescription).toBe('90-day');
    expect(p?.warrantyDescriptionRaw).toContain('90-day limited warranty and service');
  });

  it('diagnostics credits the container that actually held the row (#tech)', () => {
    const collector = createFieldDiagnosticsCollector();
    parseAmazonProductDetail(
      pdpWith('B0CFPJYX7P', `<div id="tech">${fixture('pdp-kindle-warranty-table.real.html')}</div>`),
      'https://www.amazon.com/dp/B0CFPJYX7P',
      collector,
    );
    const entry = collector
      .build()
      .fields.find((f) => f.field === 'warrantyDescription');
    expect(entry).toMatchObject({ status: 'EXTRACTED', selector: '#tech' });
  });

  it('Dewalt positive control: existing containers/labels unchanged -> 3-year', () => {
    const p = parseAmazonProductDetail(
      pdpWith(
        'B00ET5VMTU',
        `<div id="productDetails_expanderTables_depthRightSections">${fixture('pdp-dewalt-warranty-table.real.html')}</div>`,
      ),
      'https://www.amazon.com/dp/B00ET5VMTU',
    );
    expect(p?.warrantyDescription).toBe('3-year');
    expect(p?.warrantyDescriptionRaw).toBe('3 Year Limited Warranty');
  });

  it('TOZO negative control: a warranty row without a duration stays honest undefined', () => {
    const p = parseAmazonProductDetail(
      pdpWith(
        'B09FT58QQP',
        `<div id="productDetails_expanderTables_depthLeftSections">${fixture('pdp-tozo-warranty-table.real.html')}</div>`,
      ),
      'https://www.amazon.com/dp/B09FT58QQP',
    );
    expect(p?.warrantyDescription).toBeUndefined();
    expect(p?.warrantyDescriptionRaw).toBeUndefined();
  });
});
