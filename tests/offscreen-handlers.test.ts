/**
 * SAD-295 (P4.1) - the offscreen document's own side of the protocol.
 *
 * The service worker cannot parse HTML or mint a blob URL, so this document is
 * the only place those happen. The tests cover what crosses the boundary: a
 * parse that succeeds, a parse that returns a typed error instead of throwing,
 * an ASIN mismatch that must never be attributed to the product we asked for,
 * and the blob URL lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBlobUrl,
  createOffscreenMessageHandler,
  exceedsByteBudget,
  handleOffscreenRequest,
  liveBlobUrlCount,
  revokeAllBlobUrls,
  revokeBlobUrl,
} from '@/engines/amazon/offscreen/handlers';
import { parsePdpHtml, withBaseHref } from '@/engines/amazon/offscreen/parse';
import {
  MAX_OFFSCREEN_HTML_LENGTH,
  OFFSCREEN_TARGET,
  isOffscreenRequest,
  type OffscreenParseProductRequest,
} from '@/engines/amazon/offscreen/protocol';

const PRODUCT_URL = 'https://www.amazon.com/dp/B0DELTA123';

const PDP_HTML = `<!doctype html>
<html>
  <head><title>Delta Widget</title></head>
  <body>
    <span id="productTitle">Delta Widget, 2 Pack</span>
    <div id="corePriceDisplay_desktop_feature_div">
      <span class="a-price">
        <span class="a-price-whole">89</span><span class="a-price-fraction">99</span>
      </span>
    </div>
    <span id="acrCustomerReviewText">1,204 ratings</span>
    <i id="acrPopover" title="4.5 out of 5 stars"></i>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/delta._AC_SL1500_.jpg">
    <div id="feature-bullets"><ul><li>Solid brass</li><li>Two pack</li></ul></div>
    <span id="bylineInfo">Visit the Delta Store</span>
    <div id="availability"><span>In Stock</span></div>
  </body>
</html>`;

const NO_PRODUCT_HTML = '<!doctype html><html><body><p>Nothing to see</p></body></html>';

/** The buybox node is present but its text carries no price. */
const GARBAGE_PRICE_HTML = PDP_HTML.replace(
  /<span class="a-price">[\s\S]*?<\/span>\s*<\/div>/,
  '<span class="a-price">See price in cart</span></div>',
);

function parseRequest(overrides: Partial<OffscreenParseProductRequest> = {}) {
  return {
    target: OFFSCREEN_TARGET,
    type: 'OFFSCREEN_PARSE_PRODUCT' as const,
    html: PDP_HTML,
    productUrl: PRODUCT_URL,
    ...overrides,
  };
}

let urlCounter = 0;

beforeEach(() => {
  urlCounter = 0;
  // jsdom (this version) does not implement the blob URL API. Install a
  // deterministic stand-in so the lifecycle logic is what is under test.
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => `blob:pphunt-${++urlCounter}`,
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
});

afterEach(() => {
  revokeAllBlobUrls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parsePdpHtml', () => {
  it('parses a fetched product page into a normalized product', () => {
    const result = parsePdpHtml(PDP_HTML, PRODUCT_URL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.product.asin).toBe('B0DELTA123');
    expect(result.product.title).toContain('Delta Widget');
    expect(result.product.price).toBe(89.99);
    expect(result.product.url).toBe(PRODUCT_URL);
  });

  it('SAD-359: carries per-field extraction diagnostics on success', () => {
    const result = parsePdpHtml(PDP_HTML, PRODUCT_URL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fieldDiagnostics?.asin).toBe('B0DELTA123');

    const fields = new Map(
      (result.fieldDiagnostics?.fields ?? []).map((e) => [e.field, e]),
    );
    expect(fields.size).toBe(25);
    expect(fields.get('price')).toMatchObject({ status: 'EXTRACTED' });
    // The fixture has no seller node: absent from the HTML, with a reason.
    expect(fields.get('seller')).toMatchObject({ status: 'MISSING' });
    expect(fields.get('seller')?.reason).toContain('no seller/merchant node');
  });

  it('SAD-359: carries a PARSE_FAILED outcome across the offscreen boundary', () => {
    const result = parsePdpHtml(GARBAGE_PRICE_HTML, PRODUCT_URL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = new Map(
      (result.fieldDiagnostics?.fields ?? []).map((e) => [e.field, e]),
    );
    // The buybox node was present but carried no price: the source was there
    // and the parser failed on it. That is not the same as "no buybox".
    expect(fields.get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'buybox/price node present but no parseable price',
    });
  });

  it('SAD-359: carries diagnostics on parser-ran errors too', () => {
    const noProduct = parsePdpHtml(NO_PRODUCT_HTML, PRODUCT_URL);
    expect(noProduct.ok).toBe(false);
    if (!noProduct.ok) {
      const fields = new Map(
        (noProduct.fieldDiagnostics?.fields ?? []).map((e) => [e.field, e]),
      );
      expect(fields.get('title')?.status).toBe('MISSING');
    }

    const mismatch = parsePdpHtml(PDP_HTML, PRODUCT_URL, 'B0OTHER999');
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.fieldDiagnostics?.asin).toBe('B0DELTA123');
    }
  });

  it('accepts a page whose ASIN matches the one that was requested', () => {
    const result = parsePdpHtml(PDP_HTML, PRODUCT_URL, 'B0DELTA123');
    expect(result.ok).toBe(true);
  });

  it('refuses a page that resolved to a different product', () => {
    const result = parsePdpHtml(PDP_HTML, PRODUCT_URL, 'B0OTHER999');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PARSER_REJECTED');
    expect(result.message).toContain('B0OTHER999');
  });

  it('returns a typed failure, never a throw, when there is no product', () => {
    const result = parsePdpHtml(NO_PRODUCT_HTML, PRODUCT_URL);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PARSE_FAILED');
  });

  it('rejects a body that is too large to be a page', () => {
    const huge = 'x'.repeat(MAX_OFFSCREEN_HTML_LENGTH + 1);
    const result = parsePdpHtml(huge, PRODUCT_URL);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('HTML_TOO_LARGE');
  });

  it('reports PARSE_UNAVAILABLE instead of throwing where DOMParser is missing', () => {
    vi.stubGlobal('DOMParser', undefined);

    const result = parsePdpHtml(PDP_HTML, PRODUCT_URL);
    expect(result).toMatchObject({ ok: false, code: 'PARSE_UNAVAILABLE' });
  });
});

describe('the <base> tag', () => {
  it('is inserted as the first child of <head>', () => {
    const html = withBaseHref('<html><head><title>x</title></head><body></body></html>', PRODUCT_URL);

    expect(html).toContain(`<head><base href="${PRODUCT_URL}"><title>x</title>`);
  });

  it('is prepended when the document has no head', () => {
    const html = withBaseHref('<p>fragment</p>', PRODUCT_URL);
    expect(html.startsWith(`<base href="${PRODUCT_URL}">`)).toBe(true);
  });

  it('escapes the URL so it cannot break out of the attribute', () => {
    const html = withBaseHref('<head></head>', 'https://x.test/?a="b"&c=<d>');

    expect(html).toContain('&quot;b&quot;');
    expect(html).toContain('&amp;c=&lt;d&gt;');
  });

  it('changes no parsed field (it is insurance, not a behaviour change)', () => {
    const plain = parsePdpHtml(PDP_HTML.replace('<head>', '<head><!-- no base -->'), PRODUCT_URL);
    const withBase = parsePdpHtml(PDP_HTML, PRODUCT_URL);

    expect(plain.ok && withBase.ok).toBe(true);
    if (!plain.ok || !withBase.ok) return;
    expect(withBase.product).toEqual(plain.product);
  });
});

describe('blob URLs', () => {
  it('creates a URL and reports the byte length', () => {
    const result = createBlobUrl('text/csv', btoa('a,b\n1,2'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url.startsWith('blob:')).toBe(true);
    expect(result.size).toBe(7);
    expect(liveBlobUrlCount()).toBe(1);
  });

  it('revokes only URLs it minted, idempotently', () => {
    const created = createBlobUrl('text/csv', btoa('x'));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(revokeBlobUrl(created.url)).toEqual({ ok: true });
    expect(liveBlobUrlCount()).toBe(0);
    expect(revokeBlobUrl(created.url)).toEqual({ ok: true });
    expect(revokeBlobUrl('blob:someone-else')).toEqual({ ok: true });
  });

  it('rejects a payload that is not base64', () => {
    const result = createBlobUrl('text/csv', '***not base64***');

    expect(result).toMatchObject({ ok: false, code: 'BLOB_FAILED' });
  });

  it('has an explicit budget boundary', () => {
    expect(exceedsByteBudget(32, 32)).toBe(false);
    expect(exceedsByteBudget(33, 32)).toBe(true);
  });

  it('routes CREATE_BLOB_URL through the same handler', async () => {
    const result = await handleOffscreenRequest({
      target: OFFSCREEN_TARGET,
      type: 'OFFSCREEN_CREATE_BLOB_URL',
      mimeType: 'text/csv',
      base64: btoa('a,b'),
    });

    expect(result).toMatchObject({ ok: true, size: 3 });
  });
});

describe('request validation', () => {
  it('accepts well formed requests to this document', () => {
    expect(isOffscreenRequest(parseRequest())).toBe(true);
    expect(
      isOffscreenRequest({
        target: OFFSCREEN_TARGET,
        type: 'OFFSCREEN_CREATE_BLOB_URL',
        mimeType: 'text/csv',
        base64: 'Zm9v',
      }),
    ).toBe(true);
    expect(
      isOffscreenRequest({
        target: OFFSCREEN_TARGET,
        type: 'OFFSCREEN_REVOKE_URL',
        url: 'blob:pphunt-1',
      }),
    ).toBe(true);
  });

  it('declines anything addressed elsewhere or malformed', () => {
    expect(isOffscreenRequest({ type: 'OFFSCREEN_PARSE_PRODUCT' })).toBe(false);
    expect(isOffscreenRequest({ ...parseRequest(), target: 'pphunt-panel' })).toBe(false);
    expect(isOffscreenRequest(parseRequest({ html: '' }))).toBe(false);
    expect(isOffscreenRequest(parseRequest({ productUrl: '' }))).toBe(false);
    expect(isOffscreenRequest({ target: OFFSCREEN_TARGET, type: 'OFFSCREEN_NOPE' })).toBe(false);
    expect(
      isOffscreenRequest({
        target: OFFSCREEN_TARGET,
        type: 'OFFSCREEN_REVOKE_URL',
        url: 'https://example.com/x',
      }),
    ).toBe(false);
  });
});

describe('createOffscreenMessageHandler', () => {
  it('ignores messages that are not addressed to the offscreen document', () => {
    const handler = createOffscreenMessageHandler();
    const sendResponse = vi.fn();

    expect(handler({ type: 'SAVE_PRODUCT', payload: {} }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('answers a parse request asynchronously', async () => {
    const handler = createOffscreenMessageHandler();
    const response = await new Promise((resolve) => {
      const keepOpen = handler(parseRequest(), {}, resolve);
      expect(keepOpen).toBe(true);
    });

    expect(response).toMatchObject({ ok: true });
  });
});
