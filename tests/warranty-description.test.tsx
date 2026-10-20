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
import { describe, expect, it } from 'vitest';
import { normalizeWarrantyDescription } from '@/engines/amazon/scraper/field-parsers';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';

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
import { beforeEach } from 'vitest';
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

import { afterEach, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { getSettings, updateSettings } from '@/engines/amazon/db/settings';
import { CURRENT_SETTINGS_VERSION } from '@/engines/amazon/constants/defaults';
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

    fireEvent.click(box);

    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row?.enabledFields.warrantyDescription).toBe(false);
    });
  });
});
