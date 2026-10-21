import { readFileSync } from 'node:fs';

export const ASIN = 'B0SAD38901';
export const SEARCH_URL = 'https://www.amazon.com/s?k=earbuds';
export const PDP_URL = `https://www.amazon.com/dp/${ASIN}`;

export function documentOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function fixture(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

/** Controlled shell; not a capture of a real product. */
export function cardHtml(extra = '', withDeal = false): string {
  return `<div class="s-main-slot"><div data-component-type="s-search-result" data-asin="${ASIN}">
    <h2><a href="/dp/${ASIN}"><span>Controlled earbuds</span></a></h2>
    <span class="a-price"><span class="a-offscreen">$59.99</span></span>
    <img class="s-image" src="https://m.media-amazon.com/images/I/sad389.jpg">
    <span class="a-icon-alt">4.5 out of 5 stars</span><span aria-label="17 ratings">17 ratings</span>
    ${withDeal ? '<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$79.99</span></span>' : ''}
    ${extra}
  </div></div>`;
}

/** `before` lets an excluded candidate precede the primary product in DOM order. */
export function pdpHtml(inner = '', before = '', after = ''): string {
  return `<html><head><link rel="canonical" href="${PDP_URL}"></head><body>${before}
    <div id="centerCol"><h1 id="productTitle">Controlled earbuds</h1>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$59.99</span></span></div>
      ${inner}
    </div>${after}</body></html>`;
}
