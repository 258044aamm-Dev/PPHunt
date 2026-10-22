/**
 * SAD-392 — Availability must hold the page's message, not Amazon's embedded
 * script text; Source must follow the PDP observation.
 *
 * Step 1 pins (plan §4 cases 1–4 and 11): the buybox `#availability` div
 * carries an a-state JSON <script> on every live-captured PDP, and the
 * ticket's variant swaps the span for an AOD asset-loader <script> with the
 * delivery message as a bare text sibling. `el.textContent` serialized those
 * bytes into the stored value (1011 chars, reproduced end-to-end in plan
 * §1.1). `extractAmazonElementText` reads text the way the page renders it.
 *
 * Fixtures in docs/plans/SAD-392-fixtures/ are verbatim extracts of the live
 * captures (`real`) or clearly-labelled reproductions of the ticket paste
 * (`reported`) — see the plan §1.2/§1.1 for provenance.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';
import { parseAmazonProductDetail, parseAmazonSearchResults } from '@/engines/amazon/scraper';
import {
  createFieldDiagnosticsCollector,
  type ExtractionDiagnosticsReport,
} from '@/engines/amazon/scraper/extraction-diagnostics';
import {
  extractAmazonElementText,
  extractCardDeliveryAndAvailability,
} from '@/engines/amazon/scraper/field-parsers';

// Same fixture-loading convention as tests/drift-rating-coverage.test.ts (SAD-383).
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', 'docs', 'plans', 'SAD-392-fixtures', name), 'utf8');

const REAL_AVAILABILITY = 'pdp-availability-in-stock.real.html';
const REAL_DUPLICATE_ID = 'pdp-availability-duplicate-id.real.html';
const REPORTED_AOD = 'pdp-availability-aod-script.reported.html';

/** The exact message from the ticket — what availability must hold. */
const TICKET_MESSAGE =
  'This item cannot be shipped to your selected delivery location. ' +
  'Please choose a different delivery location.';

const URL_A = 'https://www.amazon.com/dp/B087GMJXMC';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Minimal PDP skeleton in the shape the parser requires (canonical link,
 * #centerCol, title node, price scope) — same convention as the SAD-386
 * tests, with the availability block under test injected verbatim.
 */
function page(inner: string, canonical = URL_A): string {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}" /></head><body>
    <div id="centerCol">
      <h1 id="title"><span id="productTitle">Availability Test Product</span></h1>
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price"><span class="a-offscreen">$329.00</span></span>
      </div>
      ${inner}
    </div></body></html>`;
}

function fieldMap(report: ExtractionDiagnosticsReport): Map<string, (typeof report.fields)[number]> {
  return new Map(report.fields.map((entry) => [entry.field, entry]));
}

describe('SAD-392 step 1: extractAmazonElementText (DOM helper)', () => {
  it('is byte-identical to textContent when no script/style/noscript exists', () => {
    const el = doc('<div id="availability"><span> In Stock </span><br></div>').querySelector('div');
    expect(extractAmazonElementText(el)).toBe(el?.textContent ?? null);
    expect(extractAmazonElementText(el)).toBe(' In Stock ');
  });

  it('strips script, style and noscript descendants, keeping rendered text', () => {
    const el = doc(
      `<div>Only 5 left in stock<script>P.when("A");</script><style>.x{color:#fff}</style>` +
        `<noscript>Enable JavaScript</noscript> — order now</div>`,
    ).querySelector('div');
    expect(extractAmazonElementText(el)).toBe('Only 5 left in stock — order now');
  });

  it('is null-safe', () => {
    expect(extractAmazonElementText(null)).toBeNull();
    expect(extractAmazonElementText(undefined)).toBeNull();
  });
});

describe('SAD-392 step 1: availability through the real PDP parser', () => {
  it('case 1 (real capture): the live buybox shape with BOTH duplicate-ID divs stays "In Stock"', () => {
    // The live page carries two elements with id="availability" (buybox +
    // SNS accordion duplicate), each with the a-state script inside.
    const inner = fixture(REAL_AVAILABILITY) + fixture(REAL_DUPLICATE_ID);
    const product = parseAmazonProductDetail(doc(page(inner)), URL_A);
    expect(product?.availability).toBe('In Stock');
    expect(product?.source).toBe('detail');
  });

  it('case 2 (reported): the AOD-loader variant stores the message, not the script', () => {
    const product = parseAmazonProductDetail(
      doc(page(fixture(REPORTED_AOD))),
      URL_A,
    );
    expect(product).not.toBeNull();
    expect(product?.availability).toBe(TICKET_MESSAGE);
    expect(product?.availability).not.toContain('P.when');
    expect((product?.availability ?? '').length).toBeLessThan(200);
    expect(product?.source).toBe('detail');
  });

  it('case 3: parsePdpHtml (offscreen/enrichment parity) returns the same clean value', () => {
    const response = parsePdpHtml(page(fixture(REPORTED_AOD)), URL_A, 'B087GMJXMC');
    expect(response.ok).toBe(true);
    if (response.ok !== true) return; // unreachable; narrows the union for TS
    expect(response.product.availability).toBe(TICKET_MESSAGE);
    expect(response.product.source).toBe('detail');
  });

  it('case 4: the live a-state shape with the span unwrapped ("In Stock {json}") yields "In Stock"', () => {
    // Derived from the real fixture by unwrapping the span, so the div's
    // textContent is exactly what the live capture measured in probe C:
    // `In Stock {"isInternal":false,…}` — bare message text + script JSON.
    const realDiv = fixture(REAL_AVAILABILITY);
    const unwrapped = realDiv.replace(
      /<span[^>]*>(\s*In Stock\s*)<\/span>/,
      '$1',
    );
    expect(unwrapped).not.toBe(realDiv); // the unwrap actually fired

    const product = parseAmazonProductDetail(doc(page(unwrapped)), URL_A);
    expect(product?.availability).toBe('In Stock');
  });
});

describe('SAD-392 step 1: diagnostics contract (case 11)', () => {
  it('records availability EXTRACTED via the "#availability" fallback for the reported shape', () => {
    const collector = createFieldDiagnosticsCollector();
    const product = parseAmazonProductDetail(
      doc(page(fixture(REPORTED_AOD))),
      URL_A,
      collector,
    );
    expect(product?.availability).toBe(TICKET_MESSAGE);
    const fields = fieldMap(collector.build());
    // The stripped value is non-empty, so the outcome is EXTRACTED with the
    // same selector the parser reached — the contract is unchanged.
    expect(fields.get('availability')).toMatchObject({
      status: 'EXTRACTED',
      source: 'dom',
      selector: '#availability',
    });
  });

  it('a value that is empty after stripping still takes the existing PARSE_FAILED branch', () => {
    // Span present but blank + script-only div: every selector yields null
    // after cleaning, exactly like a blank node did before this change.
    const inner =
      `<div id="availability"><span>   </span>` +
      `<script type="a-state" data-a-state='{"key":"social-proofing-page-state"}'>` +
      `{"isInternal":false,"asin":"B087GMJXMC"}</script></div>`;
    const collector = createFieldDiagnosticsCollector();
    const product = parseAmazonProductDetail(doc(page(inner)), URL_A, collector);
    expect(product?.availability ?? null).toBeNull();
    const fields = fieldMap(collector.build());
    expect(fields.get('availability')).toMatchObject({
      status: 'PARSE_FAILED',
      reason: 'availability node present but rejected by the field parser',
      selector: '#availability span',
    });
  });
});

describe('SAD-392 step 2: the card stock read (W3) and the leaf fallback (W4)', () => {
  const SEARCH_URL = 'https://www.amazon.com/s?k=aa+batteries';

  it('case 5 (real capture): the full search card parses with availability null and no field changed', () => {
    const card = fixture('search-card-B09RTVD1GF.real.html');
    const listingDoc = doc(`<!doctype html><html><head></head><body>${card}</body></html>`);
    const products = parseAmazonSearchResults(listingDoc, SEARCH_URL);
    expect(products).toHaveLength(1);

    // Whole-object pin recorded from the real capture. The pre-fix and
    // post-fix runs of this fixture were diffed byte-for-byte during step 2
    // development and are identical: this card's delivery-recipe hosts no
    // `.a-color-price`, so the stripped read is a proven no-op here.
    const { delivery, ...rest } = products[0]!;
    expect(rest).toEqual({
      asin: 'B09RTVD1GF',
      url: 'https://www.amazon.com/dp/B09RTVD1GF',
      title:
        'Energizer AA Batteries Alkaline Power, 32 Count Alkaline Double A Battery Pack',
      price: 15.99,
      currency: 'USD',
      rating: 4.8,
      reviewCount: 80700,
      imageUrl:
        'https://m.media-amazon.com/images/I/81AX1sbArxL._AC_UL960_FMwebp_QL65_.jpg',
      isSponsored: false,
      isPrime: true,
      brand: null,
      availability: null, // the card prints no stock phrase — stays null
      seller: null,
      description: null,
      features: [],
      source: 'search',
      listPrice: 21.78,
      dealBadge: 'Ends in 13:00:10',
      pastMonthSales: '100K+ bought in past month',
      badge: 'Overall Pick',
    });
    // Delivery still carries the Prime-signup CSS+JS blob — that pollution is
    // SAD-390's field and must NOT change here (D5). Pinned by the measured
    // edges so any accidental delivery-path edit in this ticket fails.
    expect(delivery).toHaveLength(1416);
    expect(delivery?.startsWith('.prime-brand-color {color: #0064f9; }Join Prime(function(f){')).toBe(true);
    expect(delivery?.endsWith(' FREE delivery Mon, Oct 26 on $35 of items shipped by Amazon')).toBe(true);
  });

  it('case 6: a stock span hosting a <script> yields the clean phrase', () => {
    // W3 hardening: before the fix, textContent concatenated the script
    // bytes onto the phrase and the unanchored /left in stock/i regex still
    // passed — storing the blob. The stripped read keeps the phrase only.
    const card = doc(
      `<div class="s-result-item"><div data-cy="delivery-recipe">` +
        `<span class="a-color-price">Only 5 left in stock` +
        `<script>P.when("A","ready").execute("ingress",function(){});</script>` +
        `</span></div></div>`,
    ).querySelector('div');
    const result = extractCardDeliveryAndAvailability(card!);
    expect(result.availability).toBe('Only 5 left in stock');
    expect(result.availability).not.toContain('P.when');
  });

  it('case 7 (W4 pin): the leaf fallback still skips a script-hosting node', () => {
    // Structurally safe and untouched (plan §3.1): the leaf loop reads only
    // childless nodes, so a <script> host can never leak through it.
    const card = doc(
      `<div class="s-result-item"><span>Only 3 left in stock<script>ueLogError();</script></span></div>`,
    ).querySelector('div');
    const result = extractCardDeliveryAndAvailability(card!);
    expect(result.availability).toBeNull();
  });
});
