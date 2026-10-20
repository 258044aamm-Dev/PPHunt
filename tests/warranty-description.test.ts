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
