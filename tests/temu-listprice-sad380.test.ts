/**
 * SAD-380 step 2 — failing-first fixtures for Temu `listPrice` extraction.
 *
 * Basis (step 1, measured): on the one live render captured from Temu, per-card
 * `[data-type="priceText"]` carried promo text ("Last day"), not a price, and
 * `del`/`s` were absent — so the assumed candidate pool can be empty or
 * unparseable. These fixtures lock the target behavior for the step-3 fix:
 * candidate-pool (not first-match) selection, `listPrice > price`, srOnly
 * labelled segments in either order, unified original/list/was aria wording,
 * currency-token requirement, scoped line-through ("strikethrough price")
 * fallback, PDP second-scope search, and precise diagnostics reasons.
 * Nothing here may change `price` or `discountPercentage` on existing shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsReport,
} from '@/engines/temu/scraper/extraction-diagnostics';
import { validateAndNormalizeTemuScrapedProduct } from '@/engines/temu/scraper/field-parsers';
import { parseTemuProductDetail } from '@/engines/temu/scraper/product-detail';
import { parseTemuSearchResults } from '@/engines/temu/scraper/search-results';
import { CARD_URL, PDP_URL, cardGrid } from './fixtures/temu-pdp-fixtures';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const ID = '601099769178067';

function card(inner: string): string {
  return `<div data-tooltip="goodContainer-${ID}" data-goods-id="${ID}">
    <a href="/item-g-${ID}.html">
      <img data-js-main-img="true" src="https://img.kwcdn.com/product/fancy/x.jpg" alt="item picture Widget" />
      <h2 data-tooltip="goodName-${ID}" data-tooltip-title="Widget">Widget</h2>
      ${inner}
    </a>
  </div>`;
}

function parseCards(html: string) {
  const diagnosticsByGoodsId = new Map<string, ExtractionDiagnosticsReport>();
  const products = parseTemuSearchResults(
    createDoc(html),
    CARD_URL,
    undefined,
    'search',
    diagnosticsByGoodsId
  );
  const report = diagnosticsByGoodsId.get(ID);
  const byField = report
    ? new Map(report.fields.map((entry) => [entry.field, entry]))
    : new Map();
  return { products, product: products[0], byField };
}

function pdp(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

const PRICE_1249 = `<span data-type="price"><span class="srOnly">US$12.49</span><span>$12</span><span>.49</span></span>`;

describe('SAD-380 — card listPrice candidate behavior', () => {
  it('C1: finds a styled line-through struck price when no priceText/del exists', () => {
    const { product, byField } = parseCards(
      cardGrid([
        card(
          `${PRICE_1249}
           <span style="text-decoration: line-through">US$29.99</span>
           <span data-type="discount">-58%</span>`
        ),
      ])
    );
    expect(product?.price).toBe(12.49);
    expect(product?.listPrice).toBe(29.99);
    expect(product?.discountPercentage).toBe('58% off');
    expect(byField.get('listPrice')).toMatchObject({
      status: 'EXTRACTED',
      selector: 'struck (line-through) price leaf',
    });
  });

  it('C2: skips a lower candidate and takes a later valid one (no first-match lock-in)', () => {
    const { product } = parseCards(
      cardGrid([
        card(
          `${PRICE_1249}
           <span data-type="priceText">US$9.99</span>
           <del>US$29.99</del>`
        ),
      ])
    );
    expect(product?.price).toBe(12.49);
    expect(product?.listPrice).toBe(29.99);
  });

  it('C3: a sole candidate at/below the selling price is rejected, with a precise reason', () => {
    const { product, byField } = parseCards(
      cardGrid([card(`${PRICE_1249}<span data-type="priceText">US$9.99</span>`)])
    );
    expect(product?.price).toBe(12.49);
    expect(product?.listPrice ?? null).toBeNull();
    expect(byField.get('listPrice')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'list-price candidates rejected: none above selling price',
    });
  });

  it('C4: srOnly with original-first ordering still assigns price and listPrice correctly', () => {
    const { product } = parseCards(
      cardGrid([
        card(
          `<span data-type="price"><span class="srOnly">original price is: $32.99, current price is: $11.49</span></span>`
        ),
      ])
    );
    expect(product?.price).toBe(11.49);
    expect(product?.listPrice).toBe(32.99);
  });

  it('C5: srOnly current-first ordering (existing shape) keeps working and reports srOnly provenance', () => {
    const { product, byField } = parseCards(
      cardGrid([
        card(
          `<span data-type="price"><span class="srOnly">current price is: $11.49, original price is: $32.99</span></span>`
        ),
      ])
    );
    expect(product?.price).toBe(11.49);
    expect(product?.listPrice).toBe(32.99);
    expect(byField.get('listPrice')).toMatchObject({
      status: 'EXTRACTED',
      selector: 'srOnly labelled segment',
    });
  });

  it('C7: a struck price inside a unit-price node is never taken as listPrice', () => {
    const { product } = parseCards(
      cardGrid([
        card(
          `${PRICE_1249}
           <span data-type="unitPrice"><span style="text-decoration: line-through">US$49.99</span> /count</span>`
        ),
      ])
    );
    expect(product?.price).toBe(12.49);
    expect(product?.listPrice ?? null).toBeNull();
  });

  it('C8b: aria wording "List price" is a candidate (unified vocabulary)', () => {
    const { product } = parseCards(
      cardGrid([card(`${PRICE_1249}<span aria-label="List price: US$29.99"></span>`)])
    );
    expect(product?.listPrice).toBe(29.99);
  });

  it('C9: a bare currency-less number in <del> is not a price', () => {
    const { product } = parseCards(
      cardGrid([card(`${PRICE_1249}<del>2024</del>`)])
    );
    expect(product?.price).toBe(12.49);
    expect(product?.listPrice ?? null).toBeNull();
  });

  it('C10: no struck price shown stays null + MISSING (non-fabrication control)', () => {
    const { product, byField } = parseCards(cardGrid([card(PRICE_1249)]));
    expect(product?.price).toBe(12.49);
    expect(product?.listPrice ?? null).toBeNull();
    expect(byField.get('listPrice')).toMatchObject({ status: 'MISSING' });
  });
});

describe('SAD-380 — PDP listPrice scope behavior', () => {
  function parsePdp(body: string) {
    const collector = createFieldDiagnosticsCollector('product_detail');
    const product = parseTemuProductDetail(createDoc(pdp(body)), PDP_URL, collector);
    const byField = collector.entries();
    return { product, byField };
  }

  it('P1: searches #rightContent when #goods_price has no list price', () => {
    const { product, byField } = parsePdp(`
      <div id="rightContent">
        <h1 aria-label="Widget">Widget</h1>
        <div id="goods_price">
          <span data-type="price"><span class="srOnly">US$34.99</span></span>
        </div>
        <del>US$69.98</del>
      </div>`);
    expect(product?.price).toBe(34.99);
    expect(product?.listPrice).toBe(69.98);
    expect(byField.get('listPrice')).toMatchObject({ status: 'EXTRACTED' });
  });

  it('P2: #goods_price list price still wins over a later #rightContent value', () => {
    const { product } = parsePdp(`
      <div id="rightContent">
        <h1 aria-label="Widget">Widget</h1>
        <div id="goods_price">
          <span data-type="price"><span class="srOnly">US$34.99</span></span>
          <span data-type="priceText">US$69.98</span>
        </div>
        <del>US$99.99</del>
      </div>`);
    expect(product?.listPrice).toBe(69.98);
  });

  it('P3: styled line-through struck price inside #goods_price is found', () => {
    const { product } = parsePdp(`
      <div id="rightContent">
        <h1 aria-label="Widget">Widget</h1>
        <div id="goods_price">
          <span data-type="price"><span class="srOnly">US$34.99</span></span>
          <span style="text-decoration-line: line-through">US$69.98</span>
        </div>
      </div>`);
    expect(product?.price).toBe(34.99);
    expect(product?.listPrice).toBe(69.98);
  });
});

describe('SAD-380 — validator rule (D4)', () => {
  it('V1: listPrice below the selling price is dropped', () => {
    const out = validateAndNormalizeTemuScrapedProduct(
      { goodsId: ID, url: PDP_URL, price: 12.49, listPrice: 9.99 },
      PDP_URL
    );
    expect(out?.listPrice ?? null).toBeNull();
    expect(out?.price).toBe(12.49);
  });

  it('V2: listPrice above price is kept; listPrice without price is kept', () => {
    expect(
      validateAndNormalizeTemuScrapedProduct(
        { goodsId: ID, url: PDP_URL, price: 12.49, listPrice: 29.99 },
        PDP_URL
      )?.listPrice
    ).toBe(29.99);
    expect(
      validateAndNormalizeTemuScrapedProduct(
        { goodsId: ID, url: PDP_URL, price: null, listPrice: 29.99 },
        PDP_URL
      )?.listPrice
    ).toBe(29.99);
  });
});
