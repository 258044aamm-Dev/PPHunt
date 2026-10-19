/**
 * SAD-280 (P1.3) - right-click target capture and element -> card resolution.
 *
 * The resolver must return the *card the user aimed at*, never a neighbouring
 * card and never site chrome. These fixtures mirror the markup the collectors
 * already parse, so a passing test here means the resolver and the scraper agree
 * about what a product card is.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { parseAmazonSearchCard } from '@/engines/amazon/scraper/search-results';
import {
  captureSaveTarget,
  CONTEXT_CAPTURE_TTL_MS,
  isCaptureFresh,
  resolveCapturedCard,
  resolveSavableCard,
} from '@/engines/amazon/content/save-target';

const SEARCH_PAGE = `
  <div class="s-main-slot">
    <div data-component-type="s-search-result" data-asin="B0AAAAAAAA" id="card-a">
      <img class="s-image" id="img-a" src="https://m.media-amazon.com/images/I/a.jpg">
      <h2><a id="title-a" href="/Test-A/dp/B0AAAAAAAA"><span id="title-span-a">Product A</span></a></h2>
      <span class="a-price"><span class="a-price-whole" id="price-a">19</span></span>
      <span id="blank-a"> </span>
    </div>
    <div data-component-type="s-search-result" data-asin="B0BBBBBBBB" id="card-b">
      <img class="s-image" id="img-b" src="https://m.media-amazon.com/images/I/b.jpg">
      <h2><a id="title-b" href="/Test-B/dp/B0BBBBBBBB"><span id="title-span-b">Product B</span></a></h2>
      <span class="a-price"><span class="a-price-whole" id="price-b">29</span></span>
    </div>
    <div data-component-type="s-search-result" data-asin="" id="card-no-asin">
      <a href="/not-a-product">Nothing here</a>
    </div>
  </div>
  <div id="navFooter"><a id="footer-link" href="/Some-Thing/dp/B0FOOTERXX">Footer</a></div>
  <div id="rhf"><div data-asin="B0RECOMMEND" id="rhf-card"><a id="rhf-link" href="/Rec/dp/B0RECOMMEND">Recommended</a></div></div>
  <div class="a-carousel-card"><div data-asin="B0CAROUSEL" id="carousel-card"><a id="carousel-link" href="/Car/dp/B0CAROUSEL">Carousel</a></div></div>
`;

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`fixture element #${id} is missing`);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = SEARCH_PAGE;
});

describe('resolveSavableCard', () => {
  it('resolves the card that contains the clicked price, not its neighbour', () => {
    expect(resolveSavableCard(byId('price-b'))?.id).toBe('card-b');
    expect(resolveSavableCard(byId('price-a'))?.id).toBe('card-a');
  });

  it('resolves from the image, the title and the title text node wrapper', () => {
    expect(resolveSavableCard(byId('img-a'))?.id).toBe('card-a');
    expect(resolveSavableCard(byId('title-b'))?.id).toBe('card-b');
    expect(resolveSavableCard(byId('title-span-a'))?.id).toBe('card-a');
  });

  it('resolves from whitespace inside the card', () => {
    expect(resolveSavableCard(byId('blank-a'))?.id).toBe('card-a');
  });

  it('ignores site chrome, recommendation rails and carousels', () => {
    expect(resolveSavableCard(byId('footer-link'))).toBeNull();
    expect(resolveSavableCard(byId('rhf-link'))).toBeNull();
    expect(resolveSavableCard(byId('carousel-link'))).toBeNull();
  });

  it('ignores a card-shaped element with no ASIN', () => {
    expect(resolveSavableCard(byId('card-no-asin'))).toBeNull();
  });

  it('returns null for an element outside any card', () => {
    const loose = document.createElement('div');
    document.body.appendChild(loose);
    expect(resolveSavableCard(loose)).toBeNull();
    expect(resolveSavableCard(null)).toBeNull();
  });

  it('falls back to structural /dp/ discovery for unknown markup', () => {
    document.body.innerHTML = `
      <div id="unknown-layout">
        <div id="mystery-card">
          <a href="/Mystery/dp/B0MYSTERY1">Mystery product</a>
          <span>39.99</span>
        </div>
      </div>
      <div id="unrelated">Just text</div>
    `;

    const resolved = resolveSavableCard(byId('mystery-card'));
    expect(resolved).not.toBeNull();
    expect(resolved?.textContent).toContain('Mystery product');
    // Whatever container discovery picks, it must describe exactly one product.
    expect(resolved?.querySelectorAll('a[href*="/dp/"]')).toHaveLength(1);
  });

  it('never returns a container that spans two products', () => {
    document.body.innerHTML = `
      <div id="shared-wrapper">
        <div id="first-product">
          <a href="/First/dp/B0FIRSTAAA">First product</a>
        </div>
        <div id="second-product">
          <a href="/Second/dp/B0SECONDAA">Second product</a>
        </div>
      </div>
    `;

    const resolved = resolveSavableCard(byId('second-product'));

    expect(resolved).not.toBeNull();
    expect(resolved?.textContent).toContain('Second product');
    expect(resolved?.textContent).not.toContain('First product');
    expect(resolved?.querySelectorAll('a[href*="/dp/"]')).toHaveLength(1);
  });
});

describe('captureSaveTarget', () => {
  it('remembers the element under the pointer and the page it was captured on', () => {
    const capture = captureSaveTarget(
      { target: byId('price-a') } as unknown as Event,
      1_000,
    );

    expect(capture.element?.id).toBe('price-a');
    expect(capture.capturedAt).toBe(1_000);
    expect(capture.pageUrl).toBe(location.href);
  });

  it('accepts a text node by falling back to its parent element', () => {
    const textNode = byId('title-span-a').firstChild;
    const capture = captureSaveTarget({ target: textNode } as unknown as Event);

    expect(capture.element?.id).toBe('title-span-a');
  });

  it('returns a null element when the event has no target', () => {
    expect(captureSaveTarget({ target: null } as unknown as Event).element).toBeNull();
  });

  it('treats a capture older than the TTL as stale', () => {
    const capture = captureSaveTarget({ target: byId('price-a') } as unknown as Event, 1_000);

    expect(isCaptureFresh(capture, 1_000 + CONTEXT_CAPTURE_TTL_MS)).toBe(true);
    expect(isCaptureFresh(capture, 1_000 + CONTEXT_CAPTURE_TTL_MS + 1)).toBe(false);
    expect(isCaptureFresh(null)).toBe(false);
  });

  it('gives a capture long enough to survive a human reading the menu (SAD-341)', () => {
    // The old budget was 5 s, which a normal right-click-then-click can exceed.
    expect(CONTEXT_CAPTURE_TTL_MS).toBeGreaterThanOrEqual(10 * 60 * 1_000);

    const capture = captureSaveTarget({ target: byId('price-a') } as unknown as Event, 1_000);
    expect(isCaptureFresh(capture, 1_000 + 30_000)).toBe(true);
    expect(isCaptureFresh(capture, 1_000 + 60_000)).toBe(true);
  });

  it('rejects a malformed capture instead of treating it as brand new', () => {
    const malformed = {
      element: byId('price-a'),
      capturedAt: Number.NaN,
      pageUrl: location.href,
    };

    expect(isCaptureFresh(malformed)).toBe(false);
  });
});

describe('resolveCapturedCard', () => {
  it('resolves the captured element while the capture is fresh', () => {
    const capture = captureSaveTarget({ target: byId('img-b') } as unknown as Event, 5_000);

    expect(resolveCapturedCard(capture, 5_000)?.id).toBe('card-b');
  });

  it('refuses a stale capture', () => {
    const capture = captureSaveTarget({ target: byId('img-b') } as unknown as Event, 5_000);

    expect(resolveCapturedCard(capture, 5_000 + CONTEXT_CAPTURE_TTL_MS + 1)).toBeNull();
  });

  it('still resolves a capture that is a minute old on the same page (SAD-341)', () => {
    const capture = captureSaveTarget({ target: byId('img-b') } as unknown as Event, 5_000);

    // Open the menu, read it, wait, then click Save.
    expect(resolveCapturedCard(capture, 5_000 + 30_000)?.id).toBe('card-b');
    expect(resolveCapturedCard(capture, 5_000 + 60_000)?.id).toBe('card-b');
  });

  it('refuses a capture taken on another page', () => {
    const capture = {
      element: byId('img-b'),
      capturedAt: Date.now(),
      pageUrl: 'https://www.amazon.com/s?k=somewhere-else',
    };

    expect(resolveCapturedCard(capture)).toBeNull();
  });

  it('refuses a cross-page capture however young it is', () => {
    // The page check must not be a side effect of the age check: a capture is
    // only meaningful for the document it was taken in.
    const capturedAt = 10_000;
    const capture = {
      element: byId('img-b'),
      capturedAt,
      pageUrl: 'https://www.amazon.com/dp/B0AAAAAAAA',
    };

    expect(isCaptureFresh(capture, capturedAt)).toBe(true);
    expect(resolveCapturedCard(capture, capturedAt)).toBeNull();
  });

  it('never resolves a cleared capture', () => {
    expect(resolveCapturedCard(null)).toBeNull();
    expect(resolveCapturedCard(undefined)).toBeNull();
  });
});

describe('resolver and parser agree', () => {
  it('the resolved element parses into the product the user right-clicked', () => {
    const cardB = resolveSavableCard(byId('price-b'));
    const cardA = resolveSavableCard(byId('price-a'));

    expect(parseAmazonSearchCard(cardB as Element, location.href)?.asin).toBe(
      'B0BBBBBBBB',
    );
    expect(parseAmazonSearchCard(cardA as Element, location.href)?.asin).toBe(
      'B0AAAAAAAA',
    );
  });
});
