/**
 * SAD-387 — the Deal field must hold the page's own text, never Amazon's
 * countdown i18n template.
 *
 * Step 1 of this file pins the rule itself (`utils/deal-text.ts`). Later steps
 * add the parser wiring and the read-time cleaning.
 *
 * Evidence note: the `NO_OF_*` shape is the one reported in the ticket, fed
 * through the real parsers verbatim. It was **not** reproduced on six live Amazon
 * pages captured while writing this fix (search, /deals, goldbox, a PDP,
 * amazon.nl, amazon.de — all HTTP 200, zero occurrences), so the cases below test
 * the *token pattern* rather than one page shape.
 */
import { describe, expect, it } from 'vitest';
import {
  dealBadgeForDisplay,
  sanitizeDealBadge,
} from '@/engines/amazon/utils/deal-text';

/** Verbatim from SAD-387: 217 characters, 5 labels, 6 tokens. */
const TICKET_TEXT =
  'Limited time deal NO_OF_HOURS hours NO_OF_MINUTES minutes Limited time deal ' +
  'NO_OF_MINUTES minutes Limited time deal NO_OF_MINUTES minutes NO_OF_SECONDS ' +
  'seconds Limited time deal NO_OF_SECONDS seconds Limited time deal';

/** Real badge text captured live from amazon.com (see the .real.html fixtures). */
const LIVE_LIMITED = 'Limited time deal';
const LIVE_ENDS_IN = 'Ends in 15:00:26';

describe('SAD-387: countdown templates never reach the Deal field', () => {
  it('folds the ticket blob down to the label the page printed', () => {
    expect(TICKET_TEXT.length).toBe(217);
    expect(sanitizeDealBadge(TICKET_TEXT)).toBe('Limited time deal');
  });

  it('drops a clock-style template without leaving dangling separators', () => {
    expect(
      sanitizeDealBadge('Ends in NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS'),
    ).toBe('Ends in');
  });

  it('drops a template that trails a label', () => {
    expect(sanitizeDealBadge('Limited time deal NO_OF_MINUTES minutes')).toBe(
      'Limited time deal',
    );
  });

  it('invents nothing when the text is only a template', () => {
    expect(sanitizeDealBadge('NO_OF_HOURS hours NO_OF_MINUTES minutes')).toBe(
      undefined,
    );
    expect(sanitizeDealBadge('   ')).toBe(undefined);
    expect(sanitizeDealBadge(null)).toBe(undefined);
  });

  it('keeps numbers the page really printed (D1b)', () => {
    expect(sanitizeDealBadge(LIVE_ENDS_IN)).toBe('Ends in 15:00:26');
    expect(sanitizeDealBadge('Limited time deal 2 hours 15 minutes')).toBe(
      'Limited time deal 2 hours 15 minutes',
    );
    // Repeats that came from the template collapse to the one copy the page
    // actually renders for a human.
    expect(
      sanitizeDealBadge(
        'Limited time deal NO_OF_MINUTES minutes Limited time deal NO_OF_MINUTES minutes',
      ),
    ).toBe('Limited time deal');
  });

  it('leaves template-free repetition alone — the page really said it twice', () => {
    // Deliberate boundary: the rule only intervenes when a template is present.
    // Every non-template value keeps today's bytes (this is what protects the
    // existing deal assertions and rows already in the database).
    const twice =
      'Limited time deal 2 hours 15 minutes Limited time deal 2 hours 15 minutes';
    expect(sanitizeDealBadge(twice)).toBe(twice);
  });

  it('keeps genuinely different variants verbatim (D1c)', () => {
    const mixed =
      'Limited time deal 2 hours 15 minutes Limited time deal 15 minutes 30 seconds';
    expect(sanitizeDealBadge(mixed)).toBe(mixed);
  });

  it('leaves every ordinary badge byte-identical', () => {
    for (const value of [
      LIVE_LIMITED,
      'Limited-time deal',
      'Prime Big Deal',
      "Amazon's Choice",
      'Save 15% with coupon',
      'Deal Dash Board Game Deluxe Edition',
      'Lightning deal',
    ]) {
      expect(sanitizeDealBadge(value)).toBe(value);
    }
  });

  it('is idempotent, so the read-time path cannot change a clean value', () => {
    for (const value of [TICKET_TEXT, LIVE_ENDS_IN, LIVE_LIMITED, 'Prime Big Deal']) {
      const once = sanitizeDealBadge(value);
      expect(sanitizeDealBadge(once)).toBe(once);
    }
  });

  it('exposes the same rule for stored rows (D2)', () => {
    expect(dealBadgeForDisplay(TICKET_TEXT)).toBe('Limited time deal');
    expect(dealBadgeForDisplay(LIVE_LIMITED)).toBe('Limited time deal');
    expect(dealBadgeForDisplay(null)).toBe(null);
    expect(dealBadgeForDisplay(undefined)).toBe(null);
  });
});

/**
 * Integration: the rule applied through every write path, on markup captured
 * live from amazon.com (the `.real.html` fixtures) plus the ticket's string
 * injected into that same real badge container.
 */
import { readFileSync } from 'node:fs';
import {
  parseAmazonProductDetail,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';
import { extractProductFromCard } from '@/engines/amazon/content/save-product';
import { parsePdpHtml } from '@/engines/amazon/offscreen/parse';

const URL_SEARCH = 'https://www.amazon.com/s?k=limited+time+deal';
const URL_PDP = 'https://www.amazon.com/dp/B087GMJXMC';

function fixture(name: string): string {
  return readFileSync(`docs/plans/SAD-387-fixtures/${name}`, 'utf8');
}

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Runs the real collection path over one captured card. */
function collect(card: string) {
  const doc = docOf(`<div class="s-main-slot">${card}</div>`);
  return parseAmazonSearchResults(doc, URL_SEARCH)[0];
}

const REAL_LIMITED = fixture('search-card-limited-time-deal.real.html');
const REAL_ENDS_IN = fixture('search-card-ends-in-countdown.real.html');

describe('SAD-387: real captured cards keep working', () => {
  it('reads the printed label from the real "Limited time deal" card', () => {
    expect(collect(REAL_LIMITED)?.dealBadge).toBe('Limited time deal');
  });

  it('reads the countdown from the real "Ends in" card (already correct — pinned)', () => {
    expect(collect(REAL_ENDS_IN)?.dealBadge).toBe('Ends in 15:00:26');
  });
});

describe('SAD-387: the ticket blob never reaches a product', () => {
  const brokenCard = REAL_LIMITED.replace(/>Limited time deal</, `>${TICKET_TEXT}<`);

  it('collection path stores the page label', () => {
    const product = collect(brokenCard);
    expect(product?.dealBadge).toBe('Limited time deal');
    expect(product?.dealBadge).not.toContain('NO_OF_');
  });

  it('one-click / right-click card save stores the same label', () => {
    const card = docOf(`<div class="s-main-slot">${brokenCard}</div>`).querySelector(
      '[data-component-type="s-search-result"]',
    )!;
    expect(extractProductFromCard(card, URL_SEARCH)?.dealBadge).toBe('Limited time deal');
  });

  it('product-page detail stores the page label', () => {
    const html = `
      <html><body>
        <span id="productTitle">Countdown Product</span>
        <div id="corePriceDisplay_desktop_feature_div">
          <div id="dealBadge_feature_div"><span class="dealBadgeText">${TICKET_TEXT}</span></div>
          <span class="a-price"><span class="a-offscreen">$199.99</span></span>
        </div>
      </body></html>`;
    expect(parseAmazonProductDetail(docOf(html), URL_PDP)?.dealBadge).toBe('Limited time deal');
  });

  it('offscreen PDP enrichment stores the page label', () => {
    const html = `
      <html><body>
        <span id="productTitle">Countdown Product</span>
        <div id="corePriceDisplay_desktop_feature_div">
          <div id="dealBadge_feature_div"><span class="dealBadgeText">${TICKET_TEXT}</span></div>
          <span class="a-price"><span class="a-offscreen">$199.99</span></span>
        </div>
      </body></html>`;
    const offscreen = parsePdpHtml(html, URL_PDP);
    expect(offscreen.ok).toBe(true);
    expect(offscreen.ok ? offscreen.product.dealBadge : undefined).toBe(
      'Limited time deal',
    );
  });

  it('a blob in a plain wrapper is reported as printed, not derived', () => {
    const card = REAL_LIMITED.replace(
      /<span class="a-badge-text"[^>]*>Limited time deal<\/span>/,
      `<span>${TICKET_TEXT}</span>`,
    );
    const product = collect(card);
    expect(product?.dealBadge).toBe('Limited time deal');
    // Provenance: a printed label, never the derived token.
    expect(product?.dealBadge).not.toBe('Deal');
  });
});
