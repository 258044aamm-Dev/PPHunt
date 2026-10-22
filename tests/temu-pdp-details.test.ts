/**
 * SAD-381 — Temu PDP `features` / `description` extraction.
 *
 * The DOM shapes asserted here come from Temu's own PDP bundle
 * (`goods_3ec530fb9c64b2d4fc2a.js`): `GoodsDetailV2` emits `#goodsDetail` with
 * `data-id="module"` Highlights rows, a `Key: value` property list of `div`s and
 * a `<table>`; `DescriptionV2` emits a `data-id="module"` block in
 * `#rightContent` whose rows are `div[role="button"][aria-label="$…"]`.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMU_PDP_FALLBACK_LABELS,
  expandTemuDetailSections,
  extractTemuPdpDescription,
  extractTemuPdpFeatures,
  readTemuPdpLabels,
} from '@/engines/temu/scraper/pdp-details';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function i18nScript(values: Record<string, unknown>): string {
  return `<script>window.__InitialI18nStore__=${JSON.stringify({
    en: { goods: values },
  })};</script>`;
}

const EN_I18N = i18nScript({
  main_detail: {
    highlight: 'Highlights',
    descriptionTitle: 'Description',
    descriptionMore: 'See more',
  },
  goodsDetail: {
    goodsDetailTitle: 'Product details',
    descriptionSeeAll: 'See all details',
    descriptionMoreWithDimension: 'See all details and dimensions',
  },
  accessSeeMoreProductDetails: 'See more product details',
  accessSeeMoreGoodsProperties: 'See more properties',
});

function page(body: string, head = ''): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

/** Details section: Highlights module, chrome, property list, chips, table. */
const DETAILS = `
  <div id="goodsDetail">
    <h2>Product details</h2>
    <div data-id="module">
      <span>Highlights</span>
      <div aria-label="Breathable lining for all-day wear"><span>Breathable lining</span></div>
      <div aria-label="Regular fit two-piece suit">Regular fit</div>
    </div>
    <div>Report this item</div>
    <div>This product contains small parts, keep away from children under 3.</div>
    <div class="_prop">
      <div>
        <div>Season: Spring, Autumn</div>
        <div>Pattern Type: Solid</div>
        <div>Style: Business Casual</div>
      </div>
      <div role="button" aria-label="See all details">See all details</div>
    </div>
    <ul><li>Polyester</li><li>Spandex</li></ul>
    <table><tbody>
      <tr><th>Waist Type</th><td>Mid</td></tr>
      <tr><th>Occasion</th><td>Party</td></tr>
    </tbody></table>
  </div>`;

const DESCRIPTION_MODULE = `
  <div data-id="module">
    <div>Description</div>
    <div>
      <div role="button" aria-label="$Material: 95% Polyester, 5% Spandex">Material: 95% Polyester, 5% Spandex</div>
      <div role="button" aria-label="$Fit: Regular">Fit: Regular</div>
      <div role="button" aria-label="See more">See more</div>
    </div>
  </div>`;

const RIGHT = `
  <div id="rightContent">
    <h1 aria-label="Two Piece Suit">Two Piece Suit</h1>
    <div id="goods_price"><span data-type="price"><span class="srOnly">US$34.99</span></span></div>
    ${DESCRIPTION_MODULE}
  </div>`;

const FULL_PDP = page(`${RIGHT}${DETAILS}`, EN_I18N);

describe('SAD-381 — label resolution (D4)', () => {
  it('reads the labels from the page i18n store', () => {
    const labels = readTemuPdpLabels(createDoc(FULL_PDP));
    expect(labels).toEqual({
      highlight: 'Highlights',
      description: 'Description',
      details: 'Product details',
      seeAll: 'See all details',
      seeAllDimensions: 'See all details and dimensions',
      seeMore: 'See more',
      seeMoreProductDetails: 'See more product details',
      seeMoreProperties: 'See more properties',
    });
  });

  it('falls back to English when the store is absent', () => {
    const labels = readTemuPdpLabels(createDoc(page(RIGHT + DETAILS)));
    expect(labels).toEqual(TEMU_PDP_FALLBACK_LABELS);
  });

  it('resolves a non-English storefront (and still filters an English control)', () => {
    const es = i18nScript({
      main_detail: {
        highlight: 'Aspectos destacados',
        descriptionTitle: 'Descripción',
        descriptionMore: 'Ver más',
      },
      goodsDetail: {
        goodsDetailTitle: 'Detalles del producto',
        descriptionSeeAll: 'Ver todos los detalles',
        descriptionMoreWithDimension: 'Ver todo y dimensiones',
      },
    });
    const html = page(
      RIGHT.replace('<div>Description</div>', '<div>Descripción</div>') +
        DETAILS.replace('<span>Highlights</span>', '<span>Aspectos destacados</span>'),
      es
    );
    const doc = createDoc(html);
    const labels = readTemuPdpLabels(doc);
    expect(labels.highlight).toBe('Aspectos destacados');
    expect(labels.description).toBe('Descripción');
    expect(extractTemuPdpDescription(doc, labels).description).toBe(
      'Material: 95% Polyester, 5% Spandex · Fit: Regular'
    );
  });

  it('never throws on a truncated store and keeps the English labels', () => {
    const broken = page(
      RIGHT,
      `<script>window.__InitialI18nStore__={"en":{"goods":{"main_detail":</script>`
    );
    expect(() => readTemuPdpLabels(createDoc(broken))).not.toThrow();
    expect(readTemuPdpLabels(createDoc(broken))).toEqual(TEMU_PDP_FALLBACK_LABELS);
  });

  it('tolerates a store whose values are not strings', () => {
    const odd = page(
      RIGHT,
      i18nScript({ main_detail: { highlight: 42 }, goodsDetail: [] })
    );
    const labels = readTemuPdpLabels(createDoc(odd));
    expect(labels.highlight).toBe('Highlights');
    expect(labels.details).toBe('Product details');
  });
});

describe('SAD-381 — features', () => {
  it('collects Highlights, property rows and table rows in source order', () => {
    const evidence = extractTemuPdpFeatures(createDoc(FULL_PDP));
    expect(evidence.features).toEqual([
      'Breathable lining for all-day wear',
      'Regular fit two-piece suit',
      'Season: Spring, Autumn',
      'Pattern Type: Solid',
      'Style: Business Casual',
      'Waist Type: Mid',
      'Occasion: Party',
    ]);
    expect(evidence.source).toBe('details-section');
  });

  it('reports the details section as the source', () => {
    const evidence = extractTemuPdpFeatures(createDoc(FULL_PDP));
    expect(evidence.source).toBe('details-section');
    expect(evidence.candidates).toBeGreaterThan(0);
  });

  it('never lets page chrome into features', () => {
    const joined = extractTemuPdpFeatures(createDoc(FULL_PDP)).features.join(' | ');
    for (const noise of [
      'Report this item',
      'small parts',
      'See all details',
      'See more',
      'Product details',
      // attribute chips are names only, not key/value data
      'Polyester',
    ]) {
      expect(joined).not.toContain(noise);
    }
  });

  it('deduplicates case-insensitively, keeping the first form', () => {
    const html = page(`
      <div id="goodsDetail">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="Soft cotton">Soft cotton</div>
          <div aria-label="soft COTTON">soft COTTON</div>
        </div>
      </div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual(['Soft cotton']);
  });

  it('caps the list at 15 entries', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `<div aria-label="Row number ${i}">${i}</div>`).join('');
    const html = page(`<div id="goodsDetail"><div data-id="module"><span>Highlights</span>${rows}</div></div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toHaveLength(15);
  });

  it('drops rows shorter than 4 or longer than 200 characters', () => {
    const long = 'x'.repeat(201);
    const html = page(`
      <div id="goodsDetail">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="abc">abc</div>
          <div aria-label="${long}">${long}</div>
          <div aria-label="Keeps this one">Keeps this one</div>
        </div>
      </div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual(['Keeps this one']);
  });

  it('drops keys that already have dedicated fields', () => {
    const html = page(`
      <div id="goodsDetail">
        <div>
          <div>
            <div>Seller: Some Store</div>
            <div>Delivery: 3 days</div>
            <div>Pattern Type: Solid</div>
          </div>
        </div>
      </div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual([
      'Pattern Type: Solid',
    ]);
  });

  it('rejects a container whose children are not all Key: value rows', () => {
    const html = page(`
      <div id="goodsDetail">
        <div>
          <div>
            <div>Season: Spring, Autumn</div>
            <div>Pattern Type: Solid</div>
            <div>Report this item</div>
          </div>
        </div>
      </div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual([]);
  });

  it('does not treat a two-child container as a property list', () => {
    const html = page(`
      <div id="goodsDetail">
        <div>
          <div><div>Season: Spring</div><div>Style: Casual</div></div>
        </div>
      </div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual([]);
  });

  it('returns an empty list when the details section is absent', () => {
    const html = page(`<div id="rightContent"><h1 aria-label="X">X</h1></div>`);
    const evidence = extractTemuPdpFeatures(createDoc(html));
    expect(evidence.features).toEqual([]);
    expect(evidence.source).toBe('none');
  });

  it('uses the right-column Highlights only when the details section yields nothing', () => {
    const html = page(`
      <div id="rightContent">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="Only from the right column">Only from the right column</div>
        </div>
      </div>
      <div id="goodsDetail"><h2>Product details</h2></div>`, EN_I18N);
    const evidence = extractTemuPdpFeatures(createDoc(html));
    expect(evidence.features).toEqual(['Only from the right column']);
    expect(evidence.source).toBe('right-column-highlights');
  });

  it('does not duplicate Highlights when both columns render them', () => {
    const html = page(`
      <div id="rightContent">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="Breathable lining for all-day wear">Breathable lining</div>
        </div>
      </div>
      <div id="goodsDetail">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="Breathable lining for all-day wear">Breathable lining</div>
        </div>
      </div>`, EN_I18N);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual([
      'Breathable lining for all-day wear',
    ]);
  });

  it('flags a collapsed section so the caller can report PARTIAL', () => {
    expect(extractTemuPdpFeatures(createDoc(FULL_PDP)).collapsed).toBe(true);
  });

  it('does not flag collapse when no control is rendered', () => {
    const html = page(`
      <div id="goodsDetail">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="Breathable lining for all-day wear">Breathable lining</div>
        </div>
      </div>`, EN_I18N);
    expect(extractTemuPdpFeatures(createDoc(html)).collapsed).toBe(false);
  });

  it('strips Temu’s "Open in new tab." suffix from linked rows', () => {
    const html = page(`
      <div id="goodsDetail">
        <div data-id="module">
          <span>Highlights</span>
          <div aria-label="Learn about materials. Open in new tab.">x</div>
        </div>
      </div>`);
    expect(extractTemuPdpFeatures(createDoc(html)).features).toEqual([
      'Learn about materials',
    ]);
  });
});

describe('SAD-381 — description', () => {
  it('reads the Description module rows', () => {
    const evidence = extractTemuPdpDescription(createDoc(FULL_PDP));
    expect(evidence.description).toBe(
      'Material: 95% Polyester, 5% Spandex · Fit: Regular'
    );
    expect(evidence.source).toBe('description-module');
  });

  it('finds the module by its "$" signature when the store is missing', () => {
    const doc = createDoc(page(RIGHT + DETAILS));
    expect(extractTemuPdpDescription(doc).description).toBe(
      'Material: 95% Polyester, 5% Spandex · Fit: Regular'
    );
  });

  it('returns null when no Description module exists', () => {
    const html = page(`
      <div id="rightContent">
        <h1 aria-label="Plain Shirt">Plain Shirt</h1>
        <div data-id="module"><span>Highlights</span><div aria-label="Soft cotton">Soft cotton</div></div>
      </div>`, EN_I18N);
    const evidence = extractTemuPdpDescription(createDoc(html));
    expect(evidence.description).toBeNull();
    expect(evidence.source).toBe('none');
  });

  it('returns null when the right column is absent', () => {
    const evidence = extractTemuPdpDescription(createDoc(DETAILS));
    expect(evidence.description).toBeNull();
  });

  it('never returns the collapse-control text as a row', () => {
    expect(extractTemuPdpDescription(createDoc(FULL_PDP)).description).not.toContain(
      'See more'
    );
  });

  it('flags a collapsed Description module', () => {
    expect(extractTemuPdpDescription(createDoc(FULL_PDP)).collapsed).toBe(true);
  });

  it('keeps the row, not the nested copy button, as the datum', () => {
    const html = page(`
      <div id="rightContent">
        <div data-id="module">
          <div>Description</div>
          <div>
            <div role="button" aria-label="$Material: Cotton">
              <span>Material: Cotton</span>
              <button aria-label="Copy"></button>
            </div>
          </div>
        </div>
      </div>`, EN_I18N);
    expect(extractTemuPdpDescription(createDoc(html)).description).toBe(
      'Material: Cotton'
    );
  });

  it('ignores meta[name="description"] entirely', () => {
    const html = page(
      RIGHT + DETAILS,
      `${EN_I18N}<meta name="description" content="deals on 2pcs mens suit set on Temu. Shop on Temu to start saving.">`
    );
    const evidence = extractTemuPdpDescription(createDoc(html));
    expect(evidence.description).not.toContain('deals on');
    expect(evidence.description).not.toContain('Shop on Temu');
  });

  it('does not mistake the Highlights module for the description', () => {
    const html = page(`
      <div id="rightContent">
        <div data-id="module"><span>Highlights</span><div aria-label="Soft cotton">Soft cotton</div></div>
      </div>`, EN_I18N);
    expect(extractTemuPdpDescription(createDoc(html)).description).toBeNull();
  });

  it('collapses whitespace inside a row', () => {
    const html = page(`
      <div id="rightContent">
        <div data-id="module">
          <div>Description</div>
          <div><div role="button" aria-label="$  Material:   Cotton  ">x</div></div>
        </div>
      </div>`, EN_I18N);
    expect(extractTemuPdpDescription(createDoc(html)).description).toBe(
      'Material: Cotton'
    );
  });
});

describe('SAD-381 — expand helper (opt-in)', () => {
  it('clicks every collapse control inside the PDP containers', () => {
    const doc = createDoc(FULL_PDP);
    expect(expandTemuDetailSections(doc)).toBe(2);
  });

  it('returns 0 when there is nothing to expand', () => {
    const html = page(`
      <div id="rightContent"><h1 aria-label="X">X</h1></div>
      <div id="goodsDetail"><h2>Product details</h2></div>`, EN_I18N);
    expect(expandTemuDetailSections(createDoc(html))).toBe(0);
  });

  it('ignores controls outside the two PDP containers', () => {
    const html = page(`
      <div id="rightContent"><h1 aria-label="X">X</h1></div>
      <div id="goodsDetail"><h2>Product details</h2></div>
      <nav><div role="button" aria-label="See all details">See all details</div></nav>`, EN_I18N);
    expect(expandTemuDetailSections(createDoc(html))).toBe(0);
  });

  it('never throws when a control is detached before the click', () => {
    const doc = createDoc(FULL_PDP);
    const control = doc.querySelector('#goodsDetail [role="button"]');
    control?.remove();
    expect(() => expandTemuDetailSections(doc)).not.toThrow();
  });
});
