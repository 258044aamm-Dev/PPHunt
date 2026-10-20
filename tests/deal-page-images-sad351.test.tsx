import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { db } from '@/lib/db/database';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import {
  extractBestImageUrl,
  validateAndNormalizeScrapedProduct,
} from '@/lib/scraper/field-parsers';
import { addProducts } from '@/engines/amazon/db/products';
import { ScrapedProductSchema } from '@/engines/amazon/schemas/scraped-product';
import type { ScrapedProduct } from '@/engines/amazon/types';

/**
 * SAD-351: images collected from the `/deals` grid never rendered.
 *
 * Root cause: `extractBestImageUrl` split `srcset` on every comma, but Amazon's
 * `ProductCard` grid embeds a comma inside the file name of its size token
 * (`…_AC_SF226,226_QL85_.jpg`). Every candidate was truncated to `…_AC_SF452`,
 * which the media CDN answers with HTTP 400, so `ProductImageCell` fell back to
 * the placeholder icon.
 *
 * The fixture below is two real cards captured from a hydrated
 * `https://www.amazon.com/deals` page (headless Chromium, 2026-10-20), trimmed
 * of Amazon's telemetry attributes and truncation widgets. Every attribute the
 * parser reads is verbatim.
 */

const CARD = (
  asin: string,
  base: string,
  title: string,
  price: string
) => `
<div class="ProductCard-module__card_uyr_Jh7WpSkPx4iEpn4w" data-asin="${asin}" data-testid="product-card" role="group">
  <div class="a-section a-spacing-mini ProductCard-module__imageWrapper_ytp7KTuzmF4mDTFCQLzr">
    <a class="a-link-normal ProductCard-module__cardContainingLink_OkTYz2ZO_0za69shksJ7" data-testid="product-card-link"
       href="https://www.amazon.com/dp/${asin}?ref=dlx_deals_dg_dcl">
      <div class="a-image-container a-dynamic-image-container">
        <picture>
          <source type="image/avif" srcset="https://m.media-amazon.com/images/I/${base}._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte 1x, https://m.media-amazon.com/images/I/${base}._AC_FMavif_SF452,452_QL58_.jpg?aicid=discounts-widgets-horizonte 2x">
          <source type="image/jpg" srcset="https://m.media-amazon.com/images/I/${base}._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte 1x, https://m.media-amazon.com/images/I/${base}._AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte 2x">
          <img class="a-amazon-image ProductCardImage-module__image_SU6C7KYJpko3vQ2fK7Kf"
               height="226" width="226" loading="lazy"
               src="https://m.media-amazon.com/images/I/${base}._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte"
               srcset="https://m.media-amazon.com/images/I/${base}._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte 1x, https://m.media-amazon.com/images/I/${base}._AC_SF339,339_QL80_.jpg?aicid=discounts-widgets-horizonte 1.5x, https://m.media-amazon.com/images/I/${base}._AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte 2x"
               alt="${title}">
        </picture>
      </div>
    </a>
  </div>
  <a class="a-link-normal" href="https://www.amazon.com/dp/${asin}?ref=dlx_deals_dg_dcl">
    <div class="a-section a-spacing-mini ProductCard-module__priceContainer_m0ycNRDHrTYDub6rnxSJ">
      <span class="a-price"><span class="a-offscreen">Deal Price: ${price}</span></span>
      <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">List: $999.99</span></span>
    </div>
    <p class="a-spacing-none ProductCard-module__title_awabIOxk6xfKvxKcdKDH" id="title-${asin}">
      <span><span class="a-truncate">${title}</span></span>
    </p>
  </a>
</div>`;

const SHARK_BASE = '71BSpB-pRaL';
const OLANLY_BASE = '91TX4I0i8DL';
const SHARK_URL = `https://m.media-amazon.com/images/I/${SHARK_BASE}._AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte`;

const DEALS_HTML = `<div class="grid">${CARD(
  'B0FB59FN5M',
  SHARK_BASE,
  'Shark PowerPro Reveal Plus Cordless Vacuum Cleaner',
  '$199.99'
)}${CARD(
  'B0CFGYFCYL',
  OLANLY_BASE,
  'OLANLY Bathroom Rugs 30x20, Extra Soft',
  '$8.99'
)}</div>`;

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** jsdom has the `currentSrc` getter but never loads an image, so it is always ''. */
function withCurrentSrc(html: string, value: string): HTMLImageElement {
  const img = createDoc(html).querySelector('img')!;
  Object.defineProperty(img, 'currentSrc', { value, configurable: true });
  return img as HTMLImageElement;
}

const COMMA_SRCSET =
  'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=w 1x, ' +
  'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF339,339_QL80_.jpg?aicid=w 1.5x, ' +
  'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=w 2x';

describe('SAD-351: deal-page image extraction', () => {
  describe('extractBestImageUrl — the regression', () => {
    it('keeps the comma inside Amazon size tokens instead of truncating the file name', () => {
      const img = createDoc(`<img srcset="${COMMA_SRCSET}">`).querySelector('img');
      const url = extractBestImageUrl(img);

      expect(url).toBe(
        'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=w'
      );
      // The old bug produced exactly this prefix, which the CDN answers with 400.
      expect(url).not.toBe(
        'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452'
      );
      expect(url).toMatch(/\.(?:jpe?g|png|webp)(?:\?|$)/i);
    });

    it('keeps the comma when the only candidates live on <picture><source>', () => {
      const img = createDoc(
        `<picture><source srcset="${COMMA_SRCSET}"><img></picture>`
      ).querySelector('img');
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=w'
      );
    });
  });

  describe('extractBestImageUrl — existing behaviour must not move', () => {
    it('still picks the 2x candidate from a comma-free search-card srcset', () => {
      const img = createDoc(
        '<img srcset="https://m.media-amazon.com/images/I/71gH._AC_UY218_.jpg 1x, https://m.media-amazon.com/images/I/71gH._AC_UY327_FMwebp_QL65_.jpg 1.5x, https://m.media-amazon.com/images/I/71gH._AC_UY436_FMwebp_QL65_.jpg 2x">'
      ).querySelector('img');
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/71gH._AC_UY436_FMwebp_QL65_.jpg'
      );
    });

    it('still prefers data-old-hires over any srcset', () => {
      const img = createDoc(
        `<img data-old-hires="https://m.media-amazon.com/images/I/sony-hires.jpg" srcset="${COMMA_SRCSET}">`
      ).querySelector('img');
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/sony-hires.jpg'
      );
    });

    it('still prefers the largest data-a-dynamic-image entry', () => {
      const img = createDoc(
        `<img data-a-dynamic-image='{"https://m.media-amazon.com/images/I/low._AC_UL320_.jpg":[320,320],"https://m.media-amazon.com/images/I/high._AC_SL1500_.jpg":[1500,1500]}' srcset="${COMMA_SRCSET}">`
      ).querySelector('img');
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/high._AC_SL1500_.jpg'
      );
    });

    it('still rejects 1x1 tracking pixels and deal-badge sprites', () => {
      expect(
        extractBestImageUrl(
          createDoc(`<img width="1" height="1" srcset="${COMMA_SRCSET}">`).querySelector('img')
        )
      ).toBeNull();
      expect(
        extractBestImageUrl(
          createDoc(
            '<img class="deal-badge" srcset="https://m.media-amazon.com/images/G/01/badges/prime.gif">'
          ).querySelector('img')
        )
      ).toBeNull();
    });

    it('still reads data-a-hires and data-lazy-src when srcset is absent', () => {
      expect(
        extractBestImageUrl(
          createDoc(
            '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-a-hires="https://m.media-amazon.com/images/I/81dealImg2._AC_SL1500_.jpg">'
          ).querySelector('img')
        )
      ).toBe('https://m.media-amazon.com/images/I/81dealImg2._AC_SL1500_.jpg');
      expect(
        extractBestImageUrl(
          createDoc(
            '<img data-lazy-src="https://m.media-amazon.com/images/I/71dealImg1._AC_SL500_.jpg">'
          ).querySelector('img')
        )
      ).toBe('https://m.media-amazon.com/images/I/71dealImg1._AC_SL500_.jpg');
    });

    it('still refuses relative URLs (the offscreen parser documents this)', () => {
      expect(
        extractBestImageUrl(createDoc('<img src="/images/I/relative.jpg">').querySelector('img'))
      ).toBeNull();
    });

    it('still returns an extensionless candidate when that is all the srcset offers (preference, not rejection)', () => {
      expect(
        extractBestImageUrl(
          createDoc('<img srcset="https://cdn.example.com/a 1x, https://cdn.example.com/b 2x">').querySelector('img')
        )
      ).toBe('https://cdn.example.com/b');
    });
  });

  describe('extractBestImageUrl — img.currentSrc is a trusted input', () => {
    it('falls back to currentSrc when the srcset winner is not a renderable image URL', () => {
      const img = withCurrentSrc(
        '<img srcset="https://m.media-amazon.com/images/I/x._AC_SF452">',
        'https://m.media-amazon.com/images/I/x._AC_SF452,452_QL80_.jpg'
      );
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/x._AC_SF452,452_QL80_.jpg'
      );
    });

    it('never lets currentSrc outrank a parsed srcset candidate', () => {
      const img = withCurrentSrc(
        `<img srcset="${COMMA_SRCSET}">`,
        'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=w'
      );
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=w'
      );
    });

    it('uses currentSrc when the element carries nothing else', () => {
      const img = withCurrentSrc(
        '<img>',
        'https://m.media-amazon.com/images/I/only._AC_SF226,226_QL85_.jpg'
      );
      expect(extractBestImageUrl(img)).toBe(
        'https://m.media-amazon.com/images/I/only._AC_SF226,226_QL85_.jpg'
      );
    });
  });

  describe('parse pipeline', () => {
    it('parses a deals grid into products whose image URLs survive to the end of the pipeline', () => {
      const products = parseCategoryPage(
        createDoc(DEALS_HTML),
        'https://www.amazon.com/deals'
      );

      expect(products).toHaveLength(2);
      for (const product of products) {
        expect(product.source).toBe('category');
        expect(product.imageUrl).toContain('_AC_SF452,452_QL80_.jpg');
        expect(product.imageUrl).toMatch(/\.jpg\?aicid=/);
      }

      const shark = products.find((p) => p.asin === 'B0FB59FN5M');
      expect(shark?.imageUrl).toBe(SHARK_URL);
      expect(products.find((p) => p.asin === 'B0CFGYFCYL')?.imageUrl).toBe(
        `https://m.media-amazon.com/images/I/${OLANLY_BASE}._AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte`
      );
    });

    it('normalizes and validates the comma URL without mangling it', () => {
      const normalized = validateAndNormalizeScrapedProduct(
        {
          asin: 'B0FB59FN5M',
          url: 'https://www.amazon.com/dp/B0FB59FN5M',
          title: 'Shark PowerPro Reveal Plus Cordless Vacuum Cleaner',
          price: 199.99,
          currency: 'USD',
          rating: 4.5,
          reviewCount: 1200,
          imageUrl: SHARK_URL,
          source: 'category',
        },
        'https://www.amazon.com/deals'
      );

      expect(normalized?.imageUrl).toBe(SHARK_URL);
      expect(ScrapedProductSchema.safeParse(normalized).success).toBe(true);
    });
  });

  describe('storage', () => {
    beforeEach(async () => {
      await db.open();
      await db.products.clear();
      await db.history.clear();
      await db.settings.clear();
    });

    afterEach(() => {
      cleanup();
    });

    it('persists the comma URL unchanged through addProducts', async () => {
      const scraped = parseCategoryPage(createDoc(DEALS_HTML), 'https://www.amazon.com/deals');
      await addProducts(scraped as ScrapedProduct[], 'session-sad351');

      const rows = await db.products.where('sessionKey').equals('session-sad351').toArray();
      expect(rows).toHaveLength(2);
      const shark = rows.find((r) => r.asin === 'B0FB59FN5M');
      expect(shark?.imageUrl).toBe(SHARK_URL);
    });

    it('renders the thumbnail in the preview table instead of the placeholder', async () => {
      await db.products.add({
        asin: 'B0FB59FN5M',
        title: 'Shark PowerPro Reveal Plus Cordless Vacuum Cleaner',
        price: 199.99,
        currency: 'USD',
        rating: 4.5,
        reviewCount: 1200,
        brand: 'Shark',
        seller: 'Amazon.com',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        imageUrl: SHARK_URL,
        url: 'https://www.amazon.com/dp/B0FB59FN5M',
        description: null,
        features: [],
        source: 'category',
        collectedAt: '2026-10-20T06:00:00.000Z',
        pageUrl: 'https://www.amazon.com/deals',
        sessionKey: 'session-sad351',
      });

      render(<ProductTable fullHeight sessionKey="session-sad351" />);

      const img = (await screen.findByTestId(
        'product-image-B0FB59FN5M'
      )) as HTMLImageElement;
      expect(img.getAttribute('src')).toBe(SHARK_URL);
      expect(img.getAttribute('src')).toMatch(/,452_QL80_/);
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
      await waitFor(() => {
        expect(
          screen.queryByTestId('product-image-placeholder-B0FB59FN5M')
        ).toBeNull();
      });
    });
  });
});

// jsdom reports every scroll container as 0px tall, so the virtualized table
// would render no rows at all without this mock (same trick as SAD-139's suite).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        end: (index + 1) * 52,
        size: 52,
      })),
  }),
}));
