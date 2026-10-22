/**
 * SAD-359: per-field extraction diagnostics for the PDP detail parser.
 *
 * The contract under test: for the same fetched page, the diagnostics report
 * says for every modelled field whether it was EXTRACTED (and from which
 * selector/source), MISSING (absent from the HTML) or PARTIAL (a candidate
 * existed but was rejected, had to be rescued by JSON-LD, or was dropped by
 * validation) — while the extracted product is byte-identical to a parse
 * without diagnostics.
 */
import { describe, expect, it } from 'vitest';

import {
  applyValidationResults,
  createFieldDiagnosticsCollector,
  formatExtractionDiagnosticsLog,
  summarizeFieldDiagnostics,
  type FieldDiagnostic,
} from '@/engines/amazon/scraper/extraction-diagnostics';
import { validateAndNormalizeScrapedProduct } from '@/engines/amazon/scraper/field-parsers';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper/product-detail';

const PRODUCT_URL = 'https://www.amazon.com/dp/B0DELTA123';

const FULL_HTML = `<!doctype html>
<html>
  <body>
    <span id="productTitle">Delta Widget, 2 Pack</span>
    <a id="bylineInfo">Visit the Delta Store</a>
    <div id="corePriceDisplay_desktop_feature_div">
      <span class="a-price">
        <span class="a-price-whole">89</span><span class="a-price-fraction">99</span>
      </span>
    </div>
    <i id="acrPopover" title="4.5 out of 5 stars"></i>
    <span id="acrCustomerReviewText">1,204 ratings</span>
    <div id="availability"><span>In Stock</span></div>
    <div id="mir-layout-DELIVERY_BLOCK">FREE delivery Friday, October 24</div>
    <a id="sellerProfileTriggerId">Delta Shop</a>
    <img id="landingImage" src="https://m.media-amazon.com/images/I/delta._AC_SL1500_.jpg">
    <div id="feature-bullets"><ul>
      <li><span class="a-list-item">Solid brass</span></li>
      <li><span class="a-list-item">Two pack</span></li>
    </ul></div>
    <div id="detailBulletsWrapper_feature_div">
      <ul>
        <li><span class="a-text-bold">Item Weight:</span> 1.25 pounds</li>
      </ul>
      Best Sellers Rank: #1,204 in Patio, Lawn &amp; Garden
    </div>
    <script type="text/javascript">
      P.register('twister-js-init-dpx-data', function () {
        return {
          "dimensions": ["color_name", "size_name"],
          "variationDisplayLabels": {"color_name": "Color", "size_name": "Size"},
          "variationValues": {"color_name": ["Black", "Silver"], "size_name": ["Small", "Large"]},
          "num_total_variations": 4
        };
      });
    </script>
  </body>
</html>`;

const NO_BUYBOX_HTML = `<!doctype html>
<html>
  <body>
    <span id="productTitle">Delta Widget, 2 Pack</span>
    <a id="bylineInfo">Visit the Delta Store</a>
    <div id="feature-bullets"><ul>
      <li><span class="a-list-item">Solid brass</span></li>
    </ul></div>
  </body>
</html>`;

const GARBAGE_PRICE_HTML = FULL_HTML.replace(
  /<span class="a-price">[\s\S]*?<\/span>\s*<\/div>/,
  '<span class="a-price">See price in cart</span></div>',
);

const JSONLD_SCRIPT = `<script type="application/ld+json">
{"@type":"Product","name":"Delta Widget, 2 Pack","sku":"B0DELTA123",
 "offers":{"price":42.5,"priceCurrency":"USD"},
 "aggregateRating":{"ratingValue":4.2,"reviewCount":77}}
</script>`;

const JSONLD_ONLY_HTML = NO_BUYBOX_HTML.replace(
  '</body>',
  `${JSONLD_SCRIPT}</body>`,
);

const JSONLD_RESCUE_HTML = GARBAGE_PRICE_HTML.replace(
  '</body>',
  `${JSONLD_SCRIPT}</body>`,
);

const JSONLD_BAD_IMAGE_HTML = `<!doctype html>
<html>
  <body>
    <span id="productTitle">Delta Widget, 2 Pack</span>
    <script type="application/ld+json">
    {"@type":"Product","name":"Delta Widget","image":"ftp://example.com/delta.jpg"}
    </script>
  </body>
</html>`;

const BSR_LABEL_ONLY_HTML = `<!doctype html>
<html>
  <body>
    <span id="productTitle">Delta Widget, 2 Pack</span>
    <div id="detailBulletsWrapper_feature_div">
      Best Sellers Rank: this item is not ranked yet
    </div>
  </body>
</html>`;

const WEIGHT_LABEL_ONLY_HTML = `<!doctype html>
<html>
  <body>
    <span id="productTitle">Delta Widget, 2 Pack</span>
    <div id="detailBulletsWrapper_feature_div">
      <ul>
        <li><span class="a-text-bold">Item Weight:</span> Not applicable</li>
      </ul>
    </div>
    <script type="text/javascript">
      P.register('twister-js-init-dpx-data', function () {
        return {
          "dimensions": ["size_name"],
          "variationDisplayLabels": {"size_name": "Size"},
          "variationValues": {"size_name": ["Standard"]},
          "num_total_variations": 1
        };
      });
    </script>
  </body>
</html>`;

const NO_TITLE_HTML = `<!doctype html>
<html><body><p>Sold by someone</p></body></html>`;

function parseWithReport(html: string) {
  const collector = createFieldDiagnosticsCollector();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const product = parseAmazonProductDetail(doc, PRODUCT_URL, collector);
  return { product, report: collector.build() };
}

function fieldMap(html: string): Map<string, FieldDiagnostic> {
  const { report } = parseWithReport(html);
  return new Map(report.fields.map((entry) => [entry.field, entry]));
}

describe('SAD-359 detail-parser field diagnostics', () => {
  it('classifies every modelled field on a complete PDP, with selectors', () => {
    const { product, report } = parseWithReport(FULL_HTML);
    const fields = new Map(report.fields.map((e) => [e.field, e]));

    expect(product).not.toBeNull();
    expect(report.asin).toBe('B0DELTA123');
    expect(report.fields).toHaveLength(25);

    expect(fields.get('asin')).toMatchObject({ status: 'EXTRACTED', source: 'url' });
    // The product URL is a modelled field of its own (SAD-359 requirement 1).
    expect(fields.get('url')).toMatchObject({
      status: 'EXTRACTED',
      source: 'url',
    });
    expect(fields.get('title')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '#productTitle',
      validated: true,
    });
    expect(fields.get('brand')).toMatchObject({
      status: 'EXTRACTED',
      selector: '#bylineInfo',
    });
    expect(fields.get('price')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '#corePriceDisplay_desktop_feature_div',
      validated: true,
    });
    expect(fields.get('price')?.tier).toBeDefined();
    expect(fields.get('seller')).toMatchObject({
      status: 'EXTRACTED',
      selector: '#sellerProfileTriggerId',
    });
    expect(fields.get('delivery')?.status).toBe('EXTRACTED');
    expect(fields.get('availability')?.status).toBe('EXTRACTED');
    expect(fields.get('rating')?.status).toBe('EXTRACTED');
    expect(fields.get('reviewCount')?.status).toBe('EXTRACTED');
    expect(fields.get('features')?.status).toBe('EXTRACTED');
    expect(fields.get('bestSellersRank')?.status).toBe('EXTRACTED');
    expect(fields.get('variations')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: 'script[twister-js-init-dpx-data]',
      validated: true,
    });
    expect(fields.get('weight')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '#detailBulletsWrapper_feature_div',
      validated: true,
    });
    expect(fields.get('imageUrl')?.status).toBe('EXTRACTED');
  });

  it('reports the SAD-352 buybox fingerprint as absent (MISSING), not unparseable', () => {
    const fields = fieldMap(NO_BUYBOX_HTML);

    expect(fields.get('price')).toMatchObject({
      status: 'MISSING',
      reason: 'no buybox or price node in the fetched HTML',
    });
    expect(fields.get('seller')?.status).toBe('MISSING');
    expect(fields.get('delivery')?.status).toBe('MISSING');
    expect(fields.get('discountPercentage')?.status).toBe('MISSING');
    // …while brand + features still extract, exactly as in live sessions.
    expect(fields.get('brand')?.status).toBe('EXTRACTED');
    expect(fields.get('features')?.status).toBe('EXTRACTED');
  });

  it('reports a present-but-unparseable price as PARSE_FAILED (candidate rejected)', () => {
    const { product } = parseWithReport(GARBAGE_PRICE_HTML);
    const fields = fieldMap(GARBAGE_PRICE_HTML);

    expect(product?.price).toBeNull();
    expect(fields.get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'buybox/price node present but no parseable price',
    });
  });

  it('separates "source present but unparseable" from "obtained but incomplete"', () => {
    // Same page shape, two different causes: a rejected DOM candidate with no
    // fallback is PARSE_FAILED; the same rejected candidate rescued by
    // JSON-LD yields a value that is merely incomplete, so it is PARTIAL.
    const rejected = fieldMap(GARBAGE_PRICE_HTML);
    const rescued = fieldMap(JSONLD_RESCUE_HTML);

    expect(rejected.get('price')?.status).toBe('PARSE_FAILED');
    expect(rescued.get('price')?.status).toBe('PARTIAL');
    // Both name the rejected candidate, so the reader can see what rotted.
    expect(rescued.get('price')?.reason).toContain('JSON-LD');
  });

  it('reports JSON-LD-only fields as EXTRACTED via the fallback source', () => {
    const fields = fieldMap(JSONLD_ONLY_HTML);

    expect(fields.get('price')).toMatchObject({
      status: 'EXTRACTED',
      source: 'json-ld',
    });
    expect(fields.get('rating')).toMatchObject({
      status: 'EXTRACTED',
      source: 'json-ld',
    });
    expect(fields.get('reviewCount')).toMatchObject({
      status: 'EXTRACTED',
      source: 'json-ld',
    });
  });

  it('counts a JSON-LD rescue over a rejected DOM candidate as PARTIAL (strict rule)', () => {
    const { product } = parseWithReport(JSONLD_RESCUE_HTML);
    const fields = fieldMap(JSONLD_RESCUE_HTML);

    // The value survived — but the DOM rot stays visible in the status.
    expect(product?.price).toBe(42.5);
    expect(fields.get('price')).toMatchObject({
      status: 'PARTIAL',
      source: 'json-ld',
      validated: true,
    });
    expect(fields.get('price')?.reason).toContain('JSON-LD fallback used');
  });

  it('reports a value dropped by validation as PARTIAL with validated:false', () => {
    const { product } = parseWithReport(JSONLD_BAD_IMAGE_HTML);
    const fields = fieldMap(JSONLD_BAD_IMAGE_HTML);

    // JSON-LD supplied an ftp:// image; validation requires http(s).
    expect(product?.imageUrl).toBeNull();
    expect(fields.get('imageUrl')).toMatchObject({
      status: 'PARTIAL',
      reason: 'parsed but failed validation',
      validated: false,
    });
  });

  it('reports a rank label without a parseable rank as PARSE_FAILED', () => {
    const fields = fieldMap(BSR_LABEL_ONLY_HTML);

    expect(fields.get('bestSellersRank')).toMatchObject({
      status: 'PARSE_FAILED',
    });
    expect(fields.get('bestSellersRank')?.reason).toContain('no rank could be parsed');
  });

  it('reports unparseable weight rows as PARSE_FAILED and singleton twister data as MISSING', () => {
    const fields = fieldMap(WEIGHT_LABEL_ONLY_HTML);

    expect(fields.get('weight')).toMatchObject({
      status: 'PARSE_FAILED',
      selector: '#detailBulletsWrapper_feature_div',
    });
    expect(fields.get('weight')?.reason).toContain('no positive mass could be parsed');
    expect(fields.get('variations')).toMatchObject({
      status: 'MISSING',
      reason: 'singleton product (no multi-option variations)',
    });
  });

  it('still builds a full report when the parser rejects the page (no title)', () => {
    const { product, report } = parseWithReport(NO_TITLE_HTML);
    const fields = new Map(report.fields.map((e) => [e.field, e]));

    expect(product).toBeNull();
    expect(fields.get('asin')?.status).toBe('EXTRACTED');
    expect(fields.get('title')?.status).toBe('MISSING');
    // Fields after the early return were never attempted. The report must not
    // claim they were absent from the page (SAD-359 requirement 3) — it knows
    // nothing about them.
    expect(fields.get('brand')).toMatchObject({
      status: 'UNKNOWN',
      reason: 'not attempted — the parser stopped before this field',
    });
  });

  it('never reports a field the parser did not reach as absent', () => {
    const { product, report } = parseWithReport(NO_TITLE_HTML);
    expect(product).toBeNull();

    const notAttempted = report.fields.filter((entry) =>
      entry.reason?.includes('not attempted'),
    );
    expect(notAttempted.length).toBeGreaterThan(0);
    for (const entry of notAttempted) {
      expect(entry.status).toBe('UNKNOWN');
    }
    // Nothing may claim absence on the strength of a field never looked at.
    expect(
      report.fields.some(
        (entry) => entry.status === 'MISSING' && entry.reason === 'not attempted',
      ),
    ).toBe(false);
  });

  it('never changes the extracted product (collector parity)', () => {
    for (const html of [
      FULL_HTML,
      NO_BUYBOX_HTML,
      GARBAGE_PRICE_HTML,
      JSONLD_ONLY_HTML,
      WEIGHT_LABEL_ONLY_HTML,
    ]) {
      const withDiag = parseWithReport(html).product;
      const withoutDiag = parseAmazonProductDetail(
        new DOMParser().parseFromString(html, 'text/html'),
        PRODUCT_URL,
      );
      expect(withDiag).toEqual(withoutDiag);
    }
  });
});

describe('SAD-359 diagnostics collector', () => {
  it('fills unrecorded fields and lets the final write win', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.setAsin('B0DELTA123');
    collector.extracted('title', { source: 'dom', selector: '#productTitle' });
    collector.partial('title', 'overridden by validation', {});

    const report = collector.build(['asin', 'title', 'brand']);
    const fields = new Map(report.fields.map((e) => [e.field, e]));

    expect(report.asin).toBe('B0DELTA123');
    expect(fields.get('title')?.status).toBe('PARTIAL');
    expect(fields.get('brand')).toEqual({
      field: 'brand',
      status: 'UNKNOWN',
      reason: 'not attempted — the parser stopped before this field',
    });
  });

  it('records a rejected candidate as PARSE_FAILED, not as an incomplete value', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.parseFailed(
      'price',
      'buybox/price node present but no parseable price',
    );
    collector.partial(
      'rating',
      'rating node present but unparseable; JSON-LD fallback used',
    );

    const fields = new Map(
      collector.build(['price', 'rating']).fields.map((e) => [e.field, e]),
    );
    expect(fields.get('price')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'buybox/price node present but no parseable price',
    });
    expect(fields.get('rating')).toMatchObject({ status: 'PARTIAL' });
  });

  it('flips a validation-dropped field and stamps survivors as validated', () => {
    const collector = createFieldDiagnosticsCollector();
    collector.extracted('imageUrl', { source: 'json-ld' });
    collector.extracted('title', { source: 'dom', selector: '#productTitle' });

    const candidate = {
      asin: 'B0DELTA123',
      url: PRODUCT_URL,
      title: 'Delta Widget',
      imageUrl: 'ftp://example.com/delta.jpg',
      source: 'detail' as const,
    };
    const normalized = validateAndNormalizeScrapedProduct(candidate, PRODUCT_URL);
    applyValidationResults(collector, candidate, normalized);

    const fields = new Map(collector.build().fields.map((e) => [e.field, e]));
    expect(fields.get('imageUrl')).toMatchObject({
      status: 'PARTIAL',
      validated: false,
    });
    expect(fields.get('title')).toMatchObject({
      status: 'EXTRACTED',
      validated: true,
    });
  });

  it('summarizes counts and formats one paste-safe JSON log line', () => {
    const { report } = parseWithReport(NO_BUYBOX_HTML);
    const counts = summarizeFieldDiagnostics(report.fields);
    // The five buckets partition the reported fields.
    expect(
      counts.extracted +
        counts.missing +
        counts.parseFailed +
        counts.partial +
        counts.unknown,
    ).toBe(25);

    const line = formatExtractionDiagnosticsLog(report, {
      jobId: 'job-1',
      asin: 'B0DELTA123',
      stage: 'enrichment-parse',
    });
    expect(line.startsWith('[PPHunt][Amazon][Diagnostics] {')).toBe(true);
    expect(line).not.toContain('\n');

    const payload = JSON.parse(line.slice(line.indexOf('{'))) as {
      jobId: string;
      stage: string;
      counts: typeof counts;
      fields: FieldDiagnostic[];
    };
    expect(payload.jobId).toBe('job-1');
    expect(payload.stage).toBe('enrichment-parse');
    expect(payload.counts).toEqual(counts);
    expect(payload.fields).toHaveLength(25);
  });

  it('carries the issue prefix and a bucket for every status', () => {
    const { report } = parseWithReport(NO_BUYBOX_HTML);
    const line = formatExtractionDiagnosticsLog(report, {
      jobId: 'job-1',
      asin: 'B0DELTA123',
      stage: 'detail-page',
    });

    // Requirement 4: an identifiable prefix, easy to filter in DevTools.
    expect(line.startsWith('[PPHunt][Amazon][Diagnostics] {')).toBe(true);
    // Requirement 4: no HTML, no values, one paste-safe line.
    expect(line).not.toContain('\n');
    expect(line).not.toContain('Delta Widget');

    const payload = JSON.parse(line.slice(line.indexOf('{'))) as {
      counts: Record<string, number>;
    };
    // Requirement 4: extracted / missing / partially extracted / failed —
    // plus the unknown bucket, so the five partition the report.
    expect(Object.keys(payload.counts).sort()).toEqual([
      'extracted',
      'missing',
      'parseFailed',
      'partial',
      'unknown',
    ]);
  });
});
