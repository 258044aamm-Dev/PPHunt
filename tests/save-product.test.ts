/**
 * SAD-281 (P1.4) - the single "resolve + parse" entry point both save triggers use.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSaveContext,
  extractProductFromCard,
  resolveSaveCandidate,
  SAVE_MISS_MESSAGE,
  saveMissMessage,
  SUBFRAME_SAVE_MISS_MESSAGE,
} from '@/engines/amazon/content/save-product';
import {
  SaveContextProductMessageSchema,
  SaveProductMessageSchema,
} from '@/engines/amazon/schemas/messages';
import { captureSaveTarget } from '@/engines/amazon/content/save-target';
import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import { CARD_INAPPLICABLE_REASON } from '@/engines/amazon/scraper/card-diagnostics';
import { setDiagnosticsEnabled } from '@/engines/amazon/utils/diagnostics-flag';

// SAD-369: the diagnostics switch is module state; keep every test starting
// from the production default (off) unless it turns the switch on itself.
afterEach(() => {
  void setDiagnosticsEnabled(false, {});
});

const SEARCH_PAGE = `
  <div class="s-main-slot">
    <div data-component-type="s-search-result" data-asin="B0AAAAAAAA">
      <img class="s-image" id="img-a" src="https://m.media-amazon.com/images/I/a.jpg">
      <h2><a href="/Test-A/dp/B0AAAAAAAA"><span id="title-a">Product A</span></a></h2>
      <span class="a-price"><span class="a-price-whole" id="price-a">19</span></span>
    </div>
    <div data-component-type="s-search-result" data-asin="B0BBBBBBBB">
      <span class="puis-sponsored-label-text">Sponsored</span>
      <img class="s-image" id="img-b" src="https://m.media-amazon.com/images/I/b.jpg">
      <h2><a href="/Test-B/dp/B0BBBBBBBB"><span id="title-b">Product B</span></a></h2>
      <span class="a-price"><span class="a-price-whole" id="price-b">29</span></span>
    </div>
  </div>
`;

const DETAIL_PAGE = `
  <span id="productTitle">Delta Widget, 2 Pack</span>
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-price-whole">89</span><span class="a-price-fraction">99</span></span>
  </div>
  <span id="acrCustomerReviewText">1,204 ratings</span>
  <i id="acrPopover" title="4.5 out of 5 stars"></i>
  <img id="landingImage" src="https://m.media-amazon.com/images/I/delta._AC_SL1500_.jpg">
  <div id="feature-bullets"><ul><li>Solid brass</li><li>Two pack</li></ul></div>
  <span id="bylineInfo">Visit the Delta Store</span>
  <div id="availability"><span>In Stock</span></div>
`;

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`fixture element #${id} is missing`);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = SEARCH_PAGE;
});

describe('extractProductFromCard', () => {
  it('parses a search card with the search parser', () => {
    const product = extractProductFromCard(
      byId('price-b').closest('[data-asin]') as Element,
      'https://www.amazon.com/s?k=widget',
    );

    expect(product?.asin).toBe('B0BBBBBBBB');
    expect(product?.title).toContain('Product B');
  });

  it('returns null for a card the parsers reject', () => {
    const empty = document.createElement('div');
    document.body.appendChild(empty);

    expect(
      extractProductFromCard(empty, 'https://www.amazon.com/s?k=widget'),
    ).toBeNull();
  });
});

describe('buildSaveContext', () => {
  it('records the page type, the 1-based search position and the placement', () => {
    const cardB = byId('price-b').closest('[data-asin]') as Element;
    const context = buildSaveContext(
      cardB,
      'https://www.amazon.com/s?k=widget',
      'context-menu',
    );

    expect(context.pageType).toBe('search');
    expect(context.triggeredBy).toBe('context-menu');
    expect(context.searchPosition).toBe(2);
    expect(context.listingCategory).toBe('sponsored');
  });

  it('marks an unpaid card as organic', () => {
    const cardA = byId('price-a').closest('[data-asin]') as Element;
    const context = buildSaveContext(
      cardA,
      'https://www.amazon.com/s?k=widget',
      'card-button',
    );

    expect(context.listingCategory).toBe('organic');
    expect(context.searchPosition).toBe(1);
  });

  it('omits position and placement outside search', () => {
    const cardA = byId('price-a').closest('[data-asin]') as Element;
    const context = buildSaveContext(
      cardA,
      'https://www.amazon.com/gp/bestsellers/kitchen',
      'card-button',
    );

    expect(context.searchPosition).toBeUndefined();
    expect(context.listingCategory).toBeUndefined();
  });
});

describe('resolveSaveCandidate', () => {
  it('resolves a right-click inside a card to that card product', () => {
    const capture = captureSaveTarget({ target: byId('price-b') } as unknown as Event);
    const result = resolveSaveCandidate({
      capture,
      pageUrl: 'https://www.amazon.com/s?k=widget',
      triggeredBy: 'context-menu',
    });

    expect(result?.product.asin).toBe('B0BBBBBBBB');
    expect(result?.context.triggeredBy).toBe('context-menu');
    expect(result?.context.searchPosition).toBe(2);
    // SAD-369 step 2: a card save carries its own per-card report — but only
    // with the switch on. The production default (off) sends nothing.
    expect(result?.extractionDiagnostics).toBeUndefined();
  });

  it('SAD-369 step 2: a card right-click carries the per-card report when the switch is on', () => {
    void setDiagnosticsEnabled(true, {});
    const capture = captureSaveTarget({ target: byId('price-b') } as unknown as Event);
    const result = resolveSaveCandidate({
      capture,
      pageUrl: 'https://www.amazon.com/s?k=widget',
      triggeredBy: 'context-menu',
    });

    expect(result?.product.asin).toBe('B0BBBBBBBB');
    expect(result?.extractionDiagnostics?.asin).toBe('B0BBBBBBBB');
    expect(result?.extractionDiagnostics?.fields).toHaveLength(26);

    const fields = new Map(
      (result?.extractionDiagnostics?.fields ?? []).map((entry) => [
        entry.field,
        entry,
      ]),
    );
    expect(fields.get('title')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('price')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('description')).toMatchObject({
      status: 'MISSING',
      reason: CARD_INAPPLICABLE_REASON,
    });
  });

  it('resolves nothing when the right-click missed every card', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="loose">Search bar</div>');
    const capture = captureSaveTarget({ target: byId('loose') } as unknown as Event);

    expect(
      resolveSaveCandidate({
        capture,
        pageUrl: 'https://www.amazon.com/s?k=widget',
        triggeredBy: 'context-menu',
      }),
    ).toBeNull();
  });

  it('treats a product-detail page as one product, with no card involved', () => {
    // SAD-369: the PDP report is opt-in; this test asserts the switch-on path.
    void setDiagnosticsEnabled(true, {});
    document.body.innerHTML = DETAIL_PAGE;
    const result = resolveSaveCandidate({
      capture: null,
      pageUrl: 'https://www.amazon.com/Delta-Widget/dp/B0DDDDDDDD',
      triggeredBy: 'context-menu',
    });

    expect(result?.product.asin).toBe('B0DDDDDDDD');
    expect(result?.product.price).toBe(89.99);
    expect(result?.product.title).toContain('Delta Widget');
    expect(result?.context.pageType).toBe('product-detail');
    expect(result?.context.searchPosition).toBeUndefined();

    // SAD-359: the live-DOM detail parse carries its full per-field report
    // back on the candidate, ready to ride along with SAVE_PRODUCT.
    expect(result?.extractionDiagnostics?.asin).toBe('B0DDDDDDDD');
    expect(result?.extractionDiagnostics?.fields).toHaveLength(25);
    const fields = new Map(
      (result?.extractionDiagnostics?.fields ?? []).map((entry) => [
        entry.field,
        entry,
      ]),
    );
    expect(fields.get('title')).toMatchObject({
      status: 'EXTRACTED',
      selector: '#productTitle',
    });
    expect(fields.get('price')).toMatchObject({ status: 'EXTRACTED' });
    expect(fields.get('seller')).toMatchObject({ status: 'MISSING' });
  });

  it('SAD-369: a PDP save carries no diagnostics while the switch is off', () => {
    // The default state — no collector is allocated and no report rides along,
    // so an off payload cannot log anything downstream (T5).
    void setDiagnosticsEnabled(false, {});
    document.body.innerHTML = DETAIL_PAGE;
    const result = resolveSaveCandidate({
      capture: null,
      pageUrl: 'https://www.amazon.com/Delta-Widget/dp/B0DDDDDDDD',
      triggeredBy: 'context-menu',
    });

    // The product itself is untouched by the switch (parity).
    expect(result?.product.asin).toBe('B0DDDDDDDD');
    expect(result?.extractionDiagnostics).toBeUndefined();
  });

  it('SAD-359: reports a present-but-unparseable buybox as PARSE_FAILED', () => {
    // SAD-369: the PDP report is opt-in; this test asserts the switch-on path.
    void setDiagnosticsEnabled(true, {});
    document.body.innerHTML = DETAIL_PAGE.replace(
      /<span class="a-price">[\s\S]*?<\/span>\s*<\/div>/,
      '<span class="a-price">See price in cart</span></div>',
    );
    const result = resolveSaveCandidate({
      capture: null,
      pageUrl: 'https://www.amazon.com/Delta-Widget/dp/B0DDDDDDDD',
      triggeredBy: 'context-menu',
    });

    const fields = new Map(
      (result?.extractionDiagnostics?.fields ?? []).map((entry) => [
        entry.field,
        entry,
      ]),
    );
    // The buybox node was found and its text carried no price: the source
    // was present and the extraction logic failed on it.
    expect(fields.get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'buybox/price node present but no parseable price',
    });
  });

  it('SAD-359: the SAVE_PRODUCT schema retains the optional PDP diagnostics', () => {
    // SAD-369: the PDP report is opt-in; this test asserts the switch-on path.
    void setDiagnosticsEnabled(true, {});
    document.body.innerHTML = DETAIL_PAGE;
    const result = resolveSaveCandidate({
      capture: null,
      pageUrl: 'https://www.amazon.com/Delta-Widget/dp/B0DDDDDDDD',
      triggeredBy: 'context-menu',
    });

    expect(result).not.toBeNull();
    if (!result) return;

    const payload = {
      jobId: 'job-sad359',
      product: result.product,
      context: result.context,
      extractionDiagnostics: result.extractionDiagnostics,
    };
    const parsed = SaveProductMessageSchema.safeParse({
      type: 'SAVE_PRODUCT',
      payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload.extractionDiagnostics?.fields).toHaveLength(25);
    }

    // The same message from an older content script remains valid.
    const legacy = SaveProductMessageSchema.safeParse({
      type: 'SAVE_PRODUCT',
      payload: {
        jobId: 'job-legacy',
        product: result.product,
        context: result.context,
      },
    });
    expect(legacy.success).toBe(true);
  });

  it('agrees with the parser when the same card is parsed twice', () => {
    const cardA = byId('price-a').closest('[data-asin]') as Element;
    const direct = parseAmazonSearchCard(
      cardA,
      'https://www.amazon.com/s?k=widget',
    );
    const capture = captureSaveTarget({ target: byId('title-a') } as unknown as Event);
    const result = resolveSaveCandidate({
      capture,
      pageUrl: 'https://www.amazon.com/s?k=widget',
      triggeredBy: 'card-button',
    });

    expect(result?.product.asin).toBe(direct?.asin);
  });
});

describe('SAD-344 — explaining a miss instead of implying one', () => {
  it('keeps the existing wording for a normal miss', () => {
    expect(saveMissMessage()).toBe(SAVE_MISS_MESSAGE);
    expect(saveMissMessage({})).toBe(SAVE_MISS_MESSAGE);
    expect(saveMissMessage({ fromSubframe: false })).toBe(SAVE_MISS_MESSAGE);
    expect(SAVE_MISS_MESSAGE).toBe('No product found here');
  });

  it('names the real cause when the click happened inside a sub-frame', () => {
    expect(saveMissMessage({ fromSubframe: true })).toBe(
      SUBFRAME_SAVE_MISS_MESSAGE,
    );
    // The explanation has to be different, or it is not an explanation.
    expect(SUBFRAME_SAVE_MISS_MESSAGE).not.toBe(SAVE_MISS_MESSAGE);
    expect(SUBFRAME_SAVE_MISS_MESSAGE).toMatch(/embedded frame/i);
  });

  it('still validates a payload from an older background without the flag', () => {
    const legacy = SaveContextProductMessageSchema.safeParse({
      type: 'SAVE_CONTEXT_PRODUCT',
      payload: { requestedAt: new Date().toISOString() },
    });
    expect(legacy.success).toBe(true);

    const subframe = SaveContextProductMessageSchema.safeParse({
      type: 'SAVE_CONTEXT_PRODUCT',
      payload: { requestedAt: new Date().toISOString(), fromSubframe: true },
    });
    expect(subframe.success).toBe(true);
  });
});
