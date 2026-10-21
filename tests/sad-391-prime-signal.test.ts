/**
 * SAD-391 step 2 — `isPrime` = Prime badge ∨ explicit Prime-eligibility
 * ingress (decision D1). "FREE delivery" alone is a shipping fact, not Prime.
 *
 * Markup provenance:
 * - UDM badge: real amazon.com cart markup (rigwild/mcp-server-amazon
 *   `mocks/getCartContent.html`, 2025) — `.udm-badge-block > i.a-icon-prime-with-text
 *   > i.a-icon-prime[aria-label="Prime"]`.
 * - Legacy badge: the pre-UDM `i.a-icon-prime.a-icon-small[aria-label="Prime"]`.
 * - Ingress / plain-free-delivery cards: `docs/plans/SAD-391-fixtures/*.real.html`
 *   captured 2026-10-21 from a logged-out `/s?k=laptop`.
 * - Sponsored card with "FREE delivery … to Malaysia": crawl4ai example
 *   (`sponsored-card-2025.external.html`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  extractCardDeliveryAndAvailability,
  extractCardIsPrime,
  extractCardPrimeSignal,
} from '@/engines/amazon/scraper/field-parsers';
import { parseSearchResults } from '@/engines/amazon/scraper/search-results';
import { parseProductDetail } from '@/engines/amazon/scraper/product-detail';
import {
  AMAZON_PRIME_BADGE_LABEL_PATTERN,
  AMAZON_PRIME_INGRESS_TEXT_PATTERN,
  AMAZON_SELECTOR_REGISTRY_VERSION,
} from '@/engines/amazon/scraper/selectors';

const fixture = (name: string): string =>
  readFileSync(
    join(__dirname, '..', 'docs', 'plans', 'SAD-391-fixtures', name),
    'utf8',
  );

const createDoc = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html');

function cardFrom(html: string): Element {
  const card = createDoc(`<html><body>${html}</body></html>`).querySelector(
    '[data-component-type="s-search-result"]',
  );
  if (!card) throw new Error('no s-search-result card in markup');
  return card;
}

/** The exact call chain `search-results.ts` / `category-page.ts` use. */
function primeOf(card: Element) {
  const { delivery } = extractCardDeliveryAndAvailability(card);
  return {
    delivery,
    signal: extractCardPrimeSignal(card, delivery),
    isPrime: extractCardIsPrime(card, delivery),
  };
}

const UDM_BADGE_CARD = `
  <div data-component-type="s-search-result" data-asin="B0UDMBADG1">
    <h2 aria-label="Wireless Earbuds"><span>Wireless Earbuds</span></h2>
    <div data-cy="delivery-recipe">
      <div class="a-row"><div data-cy="delivery-block" class="udm-delivery-block">
        <div class="a-row a-color-base udm-badge-block"><i class="a-icon-wrapper a-icon-prime-with-text a-icon-prime-with-text-small"><i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i><span class="a-icon-text">One-Day</span></i></div>
        <div class="udm-primary-delivery-message"><div class="a-column">FREE delivery <span class="a-text-bold">Tomorrow, Oct 22</span></div></div>
      </div></div>
    </div>
  </div>`;

const LEGACY_BADGE_CARD = `
  <div data-component-type="s-search-result" data-asin="B0LEGBADG1">
    <h2 aria-label="Wireless Earbuds"><span>Wireless Earbuds</span></h2>
    <div data-cy="delivery-recipe">
      <span aria-label="FREE delivery Tomorrow, Oct 17">FREE delivery Tomorrow, Oct 17</span>
    </div>
    <i class="a-icon a-icon-prime a-icon-small" aria-label="Prime"><span class="a-icon-alt">Prime</span></i>
  </div>`;

describe('AMAZON_PRIME_INGRESS_TEXT_PATTERN', () => {
  it('matches the verified non-member wording and nothing generic', () => {
    expect(
      AMAZON_PRIME_INGRESS_TEXT_PATTERN.test(
        'Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26',
      ),
    ).toBe(true);
    expect(
      AMAZON_PRIME_INGRESS_TEXT_PATTERN.test('Or Non-members get FREE delivery Mon, Oct 26'),
    ).toBe(true);
    expect(AMAZON_PRIME_INGRESS_TEXT_PATTERN.test('Prime members get FREE delivery')).toBe(true);
    expect(AMAZON_PRIME_INGRESS_TEXT_PATTERN.test('FREE delivery Tomorrow, Oct 22')).toBe(false);
    expect(AMAZON_PRIME_INGRESS_TEXT_PATTERN.test('FREE delivery Thu, Jun 19 to Malaysia on $49 of eligible items')).toBe(false);
    expect(AMAZON_PRIME_INGRESS_TEXT_PATTERN.test('Primer Spray for face, 4 oz')).toBe(false);
    expect(AMAZON_PRIME_INGRESS_TEXT_PATTERN.test('$4.99 delivery Oct 28 - 30')).toBe(false);
  });

  it('AMAZON_PRIME_BADGE_LABEL_PATTERN is anchored: badge labels yes, titles no', () => {
    for (const label of ['Prime', 'prime', 'Amazon Prime', 'Prime Eligible', 'Prime.']) {
      expect(AMAZON_PRIME_BADGE_LABEL_PATTERN.test(label)).toBe(true);
    }
    for (const label of [
      'Primer Spray for face, hydrating makeup Prime base 4 oz',
      'Prime Hydration Drink, 12 pack',
      'Join Prime to get FREE delivery Fri, Oct 23',
      'View Sponsored information or leave ad feedback',
      'Optimus Prime Transformers figure',
    ]) {
      expect(AMAZON_PRIME_BADGE_LABEL_PATTERN.test(label)).toBe(false);
    }
  });

  it('bumps the selector registry version with the semantic change', () => {
    expect(AMAZON_SELECTOR_REGISTRY_VERSION).toBe('2.1.0');
  });
});

describe('card isPrime — badge', () => {
  it('UDM badge (signed-in Prime member markup) → badge', () => {
    const card = cardFrom(UDM_BADGE_CARD);
    expect(primeOf(card)).toEqual({
      delivery: 'FREE delivery Tomorrow, Oct 22',
      signal: 'badge',
      isPrime: true,
    });
  });

  it('legacy a-icon-prime badge → badge (every pre-existing fixture shape stays Prime)', () => {
    const card = cardFrom(LEGACY_BADGE_CARD);
    expect(primeOf(card).signal).toBe('badge');
    expect(primeOf(card).isPrime).toBe(true);
  });

  it('class-less Tier-3 shape <span aria-label="Prime Eligible"> stays Prime (error-recovery suite)', () => {
    const card = cardFrom(
      '<div data-component-type="s-search-result" data-asin="B0ARIAPRM1"><h3>Apple AirPods Pro</h3><span aria-label="Prime Eligible">Prime</span><div>In Stock</div></div>',
    );
    expect(primeOf(card).signal).toBe('badge');
  });

  it('a badge with no delivery text at all is still Prime', () => {
    const card = cardFrom(
      '<div data-component-type="s-search-result" data-asin="B0NODELIV1"><i class="a-icon a-icon-prime" aria-label="Prime"></i></div>',
    );
    expect(extractCardIsPrime(card)).toBe(true);
    expect(extractCardIsPrime(card, undefined)).toBe(true);
  });
});

describe('card isPrime — ingress (live 2026-10-21 markup)', () => {
  it('"Join Prime to get FREE delivery" card → ingress, through the cleaned delivery text', () => {
    const card = cardFrom(fixture('search-card-join-prime-stock-warning.real.html'));
    const result = primeOf(card);
    expect(result.signal).toBe('ingress');
    expect(result.isPrime).toBe(true);
    expect(result.delivery).toBe(
      'Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26',
    );
  });

  it('ingress is also recognised when only the text survives (no selectors)', () => {
    const card = cardFrom(
      '<div data-component-type="s-search-result" data-asin="B0TEXTONL1"><div data-cy="delivery-recipe"><span aria-label="Join Prime to get FREE delivery Fri, Oct 23">Join Prime to get FREE delivery Fri, Oct 23</span></div></div>',
    );
    expect(primeOf(card).signal).toBe('ingress');
  });
});

describe('card isPrime — NOT Prime (the false positives this step removes)', () => {
  it('plain "FREE delivery Tomorrow, Oct 22" with an empty badge block → false', () => {
    const card = cardFrom(fixture('search-card-free-delivery-no-prime.real.html'));
    expect(primeOf(card)).toEqual({
      delivery: 'FREE delivery Tomorrow, Oct 22',
      signal: null,
      isPrime: false,
    });
  });

  it('"FREE delivery Oct 28 - 29 / Or fastest delivery" window → false', () => {
    const card = cardFrom(fixture('search-card-free-delivery-window-stock.real.html'));
    expect(primeOf(card).isPrime).toBe(false);
  });

  it('"Join Prime" ingress only on the "Get it faster" secondary offer → false (live B0GPW3BJ6V)', () => {
    // The row's price ($695.00) and delivery ("FREE delivery Oct 26 - 28") describe the
    // featured offer; the Prime ingress belongs to the pricier $709.99 secondary offer in
    // [data-cy="multi-offer-display"]. It must not make the featured offer Prime.
    const card = cardFrom(fixture('search-card-secondary-offer-prime-ingress.real.html'));
    expect(card.querySelector('[data-cy="multi-offer-display"] .udm-sfx-prime-signup-trigger')).not.toBeNull();
    expect(primeOf(card)).toEqual({
      delivery: 'FREE delivery Oct 26 - 28',
      signal: null,
      isPrime: false,
    });
  });

  it('sponsored card with "FREE delivery … to Malaysia on $49 of eligible items" → false', () => {
    const card = cardFrom(
      `<div data-component-type="s-search-result" data-asin="B081XSYZMS" class="s-result-item s-asin AdHolder">${fixture('sponsored-card-2025.external.html')}</div>`,
    );
    const result = primeOf(card);
    expect(result.delivery).toContain('FREE delivery');
    expect(result.isPrime).toBe(false);
  });

  it('a product title containing "Prime" (aria-label wildcard) → false', () => {
    const card = cardFrom(`
      <div data-component-type="s-search-result" data-asin="B0PRIMER01">
        <h2 aria-label="Primer Spray for face, hydrating makeup Prime base 4 oz"><span>Primer Spray for face, hydrating makeup Prime base 4 oz</span></h2>
        <div data-cy="delivery-recipe"><span aria-label="$5.99 delivery Oct 28 - 30">$5.99 delivery Oct 28 - 30</span></div>
      </div>`);
    expect(primeOf(card)).toEqual({
      delivery: '$5.99 delivery Oct 28 - 30',
      signal: null,
      isPrime: false,
    });
  });

  it('end-to-end through parseSearchResults: badge card true, ingress card true, plain card false', () => {
    const html = `<div class="s-main-slot">${UDM_BADGE_CARD}${fixture('search-card-join-prime-stock-warning.real.html')}${fixture('search-card-free-delivery-no-prime.real.html')}</div>`;
    const products = parseSearchResults(createDoc(html), 'https://www.amazon.com/s?k=laptop');
    const byAsin = new Map(products.map((p) => [p.asin, p]));
    expect(byAsin.get('B0UDMBADG1')?.isPrime).toBe(true);
    expect(byAsin.get('B0GQB2F5NF')?.isPrime).toBe(true);
    expect(byAsin.get('B0GQB2F5NF')?.availability).toBe('Only 7 left in stock - order soon.');
    expect(byAsin.get('B0HK7LXM3G')?.isPrime).toBe(false);
    expect(byAsin.get('B0HK7LXM3G')?.delivery).toBe('FREE delivery Tomorrow, Oct 22');
  });
});

describe('PDP isPrime', () => {
  const pdp = (buyboxExtra: string, pageExtra = '') => `
    <html><head><link rel="canonical" href="https://www.amazon.com/dp/B0PDPPRIM1" /></head><body>
      <h1 id="title"><span id="productTitle">Laptop Stand</span></h1>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$29.99</span></span></div>
      <div id="desktop_buybox"><div id="buybox">
        <div id="availability"><span>In Stock</span></div>
        ${buyboxExtra}
      </div></div>
      ${pageExtra}
    </body></html>`;
  const parse = (html: string) => parseProductDetail(createDoc(html), 'https://www.amazon.com/dp/B0PDPPRIM1');

  it('badge inside the buy box → true (unchanged behaviour)', () => {
    expect(parse(pdp('<i class="a-icon a-icon-prime" aria-label="Prime"></i>'))?.isPrime).toBe(true);
  });

  it('UDM badge inside the delivery block → true', () => {
    expect(
      parse(
        pdp(
          '',
          '<div id="mir-layout-DELIVERY_BLOCK"><div class="udm-badge-block"><i class="a-icon-wrapper a-icon-prime-with-text"><i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i></i></div><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">FREE delivery Tomorrow, Oct 22</div></div>',
        ),
      )?.isPrime,
    ).toBe(true);
  });

  it('"Join Prime" ingress in the delivery block (inline style/script stripped) → true', () => {
    const product = parse(
      pdp(
        '',
        '<div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><a class="udm-sfx-prime-signup-trigger"><style>.prime-brand-color{color:#0064f9;}</style><span class="prime-brand-color">Join Prime</span></a><script>(function(f){})();</script> to get FREE delivery <span class="a-text-bold">Fri, Oct 23</span></div></div>',
      ),
    );
    expect(product?.isPrime).toBe(true);
    expect(product?.delivery).toBe('Join Prime to get FREE delivery Fri, Oct 23');
  });

  it('"FREE delivery" wording alone → false', () => {
    const product = parse(
      pdp(
        '',
        '<div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">FREE delivery <span class="a-text-bold">Tomorrow, Oct 22</span></div></div>',
      ),
    );
    expect(product?.delivery).toBe('FREE delivery Tomorrow, Oct 22');
    expect(product?.isPrime).toBe(false);
  });

  it('data-csa-c-delivery-price="FREE" alone → false (shipping price, not Prime)', () => {
    expect(
      parse(
        pdp(
          '',
          '<div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span data-csa-c-delivery-price="FREE" data-csa-c-delivery-time="Tomorrow, Oct 22">FREE delivery Tomorrow, Oct 22</span></div></div>',
        ),
      )?.isPrime,
    ).toBe(false);
  });

  it('a badge only inside a sponsored/similar-items carousel → false', () => {
    expect(
      parse(
        pdp(
          '',
          '<div id="sp_detail_carousel"><div class="a-carousel-container"><i class="a-icon a-icon-prime" aria-label="Prime"></i></div></div>',
        ),
      )?.isPrime,
    ).toBe(false);
    expect(
      parse(pdp('', '<div class="a-carousel-container"><i class="a-icon a-icon-prime" aria-label="Prime"></i></div>'))
        ?.isPrime,
    ).toBe(false);
  });

  it('#bbop-sbbop-container keeps counting (unchanged behaviour)', () => {
    expect(parse(pdp('', '<div id="bbop-sbbop-container"></div>'))?.isPrime).toBe(true);
  });
});
