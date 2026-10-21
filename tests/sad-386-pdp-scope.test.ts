/**
 * SAD-386 step 3 — the product page must read the WHOLE price area.
 *
 * The buybox loop used to `break` as soon as one scope produced a price
 * (`product-detail.ts:957`), so any later scope carrying the savings
 * percentage, the deal badge or the coupon was never read (plan §5 F4, probe
 * P07/B). These tests pin the fix and the two things that must NOT move: the
 * winning price and the excluded-subtree rule.
 */
import { describe, expect, it } from 'vitest';
import { parseAmazonProductDetail } from '@/engines/amazon/scraper';
import { DERIVED_DEAL_LABEL } from '@/engines/amazon/scraper/deal-evidence';

const URL_A = 'https://www.amazon.com/dp/B0SCOPE001';

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function page(inner: string, canonical = URL_A): string {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}" /></head><body>
    <div id="centerCol">
      <h1 id="title"><span id="productTitle">Scope Test Product</span></h1>
      <a id="bylineInfo">Visit the Test Store</a>
      ${inner}
    </div></body></html>`;
}

describe('SAD-386: product-page price-area coverage', () => {
  it('reads a percent and a deal label that live in a later scope', () => {
    // Scope 1 (first in the buybox list) has the price and nothing else; the
    // promo block further down the column carries the badge and the percentage.
    const product = parseAmazonProductDetail(
      doc(
        page(`
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
        </div>
        <div id="promoPriceBlockMessage_feature_div">
          <span>Limited time deal</span>
          <span class="a-size-base a-color-secondary">(23% off)</span>
        </div>`),
      ),
      URL_A,
    );
    expect(product?.price).toBe(329);
    expect(product?.discountPercentage).toBe('23% off');
    expect(product?.dealBadge).toBe('Limited time deal');
  });

  it('still takes the price from the first scope that has one', () => {
    const product = parseAmazonProductDetail(
      doc(
        page(`
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
        </div>
        <div id="apex_desktop">
          <span class="a-price"><span class="a-offscreen">$999.00</span></span>
          <span class="savingsPercentage">-40%</span>
        </div>`),
      ),
      URL_A,
    );
    expect(product?.price).toBe(329); // first-wins is unchanged
    expect(product?.discountPercentage).toBe('40% off'); // but the later scope is read
  });

  it('never reads a percentage or badge from an excluded subtree', () => {
    const product = parseAmazonProductDetail(
      doc(
        page(`
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
        </div>
        <div id="sims-consolidated-2_feature_div">
          <span class="savingsPercentage">-90%</span>
          <span>Limited time deal</span>
        </div>`),
      ),
      URL_A,
    );
    expect(product?.price).toBe(329);
    expect(product?.discountPercentage).toBeUndefined();
    expect(product?.dealBadge).toBeUndefined();
  });

  it('a coupon in a later scope is still a coupon, not a discount', () => {
    const product = parseAmazonProductDetail(
      doc(
        page(`
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
        </div>
        <div id="couponBadgeRegularVpc"><span>Save 15% with coupon</span></div>`),
      ),
      URL_A,
    );
    expect(product?.discountPercentage).toBeUndefined();
    expect(product?.coupon).toBe('Save 15% with coupon');
  });

  it('a buy-box-less page still yields a derived deal from a struck list price', () => {
    const product = parseAmazonProductDetail(
      doc(
        page(`
        <div id="corePrice_feature_div">
          <span class="a-price"><span class="a-offscreen">$329.00</span></span>
          <span class="basisPrice"><span class="a-price" data-a-strike="true"><span class="a-offscreen">$429.00</span></span></span>
        </div>`),
      ),
      URL_A,
    );
    expect(product?.dealBadge).toBe(DERIVED_DEAL_LABEL);
  });
});
