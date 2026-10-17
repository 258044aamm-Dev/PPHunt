import { describe, expect, it } from 'vitest';
import {
  detectTemuPageType,
  extractTemuSearchQuery,
} from '@/engines/temu/scraper/page-detector';
import {
  detectTemuCaptcha,
  isEndOfTemuResultsReached,
  findTemuSeeMoreButton,
} from '@/engines/temu/scraper/captcha-detector';
import { validateAndNormalizeTemuProduct } from '@/engines/temu/scraper/field-parsers';
import { parseTemuSearchResults } from '@/engines/temu/scraper/search-results';
import { parseTemuCategoryPage } from '@/engines/temu/scraper/category-page';
import { parseTemuProductDetail } from '@/engines/temu/scraper/product-detail';
import { TemuDeduplicationEngine } from '@/engines/temu/scraper/dedup';
import { TemuParseCache } from '@/engines/temu/scraper/parse-cache';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('Temu page detection & query extraction (SAD-211 / SAD-222)', () => {
  it('detects search, SEO search, category, product detail, and unsupported Temu pages', () => {
    const searchDoc = createDoc('<div class="js-search-goodsList"></div>');
    expect(
      detectTemuPageType(
        'https://www.temu.com/search_result.html?search_key=wireless+earbuds',
        searchDoc
      )
    ).toBe('search');
    expect(
      extractTemuSearchQuery(
        'https://www.temu.com/search_result.html?search_key=wireless+earbuds',
        searchDoc
      )
    ).toBe('wireless earbuds');

    // SEO search landing page (*-s.html)
    const seoSearchDoc = createDoc('<h1>Flat Wireless Earbuds</h1>');
    expect(
      detectTemuPageType(
        'https://www.temu.com/flat-wireless-earbuds-5030186936120-s.html',
        seoSearchDoc
      )
    ).toBe('search');

    // Category page (*-o3-*.html)
    const categoryDoc = createDoc('<div class="js-category-goodsList"></div>');
    expect(
      detectTemuPageType(
        'https://www.temu.com/womens-shoes-o3-95.html',
        categoryDoc
      )
    ).toBe('category');

    // Product detail page (*-g-*.html and /goods.html?goods_id=*)
    const detailDoc = createDoc('<div id="goodsDetail"></div>');
    expect(
      detectTemuPageType(
        'https://www.temu.com/wireless-earbuds-g-601099769178067.html',
        detailDoc
      )
    ).toBe('detail');
    expect(
      detectTemuPageType(
        'https://www.temu.com/goods.html?goods_id=601099769178067',
        detailDoc
      )
    ).toBe('detail');

    // Unsupported pages (cart, checkout, non-Temu)
    expect(
      detectTemuPageType(
        'https://www.temu.com/cart.html',
        createDoc('<div>Shopping Cart</div>')
      )
    ).toBe('unsupported');
    expect(
      detectTemuPageType(
        'https://www.amazon.com/s?k=earbuds',
        createDoc('<div></div>')
      )
    ).toBe('unsupported');
  });
});

describe('Temu CAPTCHA / verification challenge & pagination detection (SAD-211 / SAD-222)', () => {
  it('detects verificationdialogs, #captcha, and text-based security challenges', () => {
    const cleanDoc = createDoc(
      '<div class="js-search-goodsList"><a href="/item-g-601099769178067.html">Item</a></div>'
    );
    expect(detectTemuCaptcha(cleanDoc)).toBe(false);

    const dialogDoc = createDoc(
      '<div class="verificationDialog_wrapper"><div>Drag the slider to fit the puzzle</div></div>'
    );
    expect(detectTemuCaptcha(dialogDoc)).toBe(true);

    const captchaIdDoc = createDoc('<div id="captcha"><iframe src="about:blank"></iframe></div>');
    expect(detectTemuCaptcha(captchaIdDoc)).toBe(true);

    const textChallengeDoc = createDoc(
      '<main><h1>Security Verification</h1><p>Please complete the puzzle to continue shopping.</p></main>'
    );
    expect(detectTemuCaptcha(textChallengeDoc)).toBe(true);
  });

  it('detects end-of-results markers and "See more items" pagination buttons', () => {
    const endDoc = createDoc('<div><span>No more results</span></div>');
    expect(isEndOfTemuResultsReached(endDoc)).toBe(true);

    const moreDoc = createDoc(
      '<div><div role="button"><span>See more items</span></div></div>'
    );
    expect(isEndOfTemuResultsReached(moreDoc)).toBe(false);
    const btn = findTemuSeeMoreButton(moreDoc);
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('See more items');
  });
});

describe('Temu Search, Category, PDP & Structural Fallback Extraction (SAD-212 / SAD-213 / SAD-222)', () => {
  it('extracts search result cards using semantic data-* attributes and srOnly price strings', () => {
    const html = `
      <div class="js-search-goodsList">
        <div class="auto-fit-list">
          <div data-tooltip="goodContainer-601099769178067">
            <a href="/wireless-noise-cancelling-earbuds-g-601099769178067.html?_oak_mp_inf=abc">
              <img class="goods-img-external" src="https://img.kwcdn.com/product/fancy/earbuds-main.jpg" alt="Wireless Noise Cancelling Earbuds" />
              <div data-tooltip="goodName-601099769178067" data-tooltip-title="Wireless Noise Cancelling Earbuds Bluetooth 5.3">
                <span>Wireless Noise Cancelling Earbuds Bluetooth 5.3</span>
              </div>
            </a>
            <div data-type="price">
              <span class="srOnly">current price is: $11.49, original price is: $32.99</span>
              <span data-type="priceText">$11.49</span>
              <span>$32.99</span>
            </div>
            <span data-type="discount">-65%</span>
            <span data-type="saleTips">10K+ sold</span>
            <div role="img" aria-label="4.8 out of 5 stars"></div>
            <span>(3,412)</span>
            <span>Lightning deal</span>
            <span>Free shipping</span>
          </div>

          <div data-tooltip="goodContainer-601099123456789">
            <a href="/braided-usb-c-fast-charging-cable-g-601099123456789.html">
              <img class="goods-img-external" data-src="https://img.kwcdn.com/product/fancy/cable.jpg" alt="Braided USB-C Cable" />
              <h3 data-tooltip="goodName-601099123456789">Braided USB-C Fast Charging Cable 6ft</h3>
            </a>
            <div data-type="price">
              <span data-type="priceText">$3.29</span>
            </div>
            <span data-sales="true">850 sold</span>
          </div>
        </div>
      </div>
    `;

    const pageUrl = 'https://www.temu.com/search_result.html?search_key=earbuds';
    const doc = createDoc(html);
    const raws = parseTemuSearchResults(doc, pageUrl);
    expect(raws).toHaveLength(2);

    const first = validateAndNormalizeTemuProduct(raws[0]!, pageUrl);
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      goodsId: '601099769178067',
      asin: '601099769178067',
      title: 'Wireless Noise Cancelling Earbuds Bluetooth 5.3',
      price: 11.49,
      listPrice: 32.99,
      discountPercentage: '-65%',
      currency: 'USD',
      rating: 4.8,
      reviewCount: 3412,
      pastMonthSales: '10K+ sold',
      dealBadge: 'Lightning deal',
      delivery: 'Free shipping',
      isPrime: true,
      imageUrl: 'https://img.kwcdn.com/product/fancy/earbuds-main.jpg',
      url: 'https://www.temu.com/wireless-noise-cancelling-earbuds-g-601099769178067.html',
      source: 'search',
    });

    const second = validateAndNormalizeTemuProduct(raws[1]!, pageUrl);
    expect(second).not.toBeNull();
    expect(second).toMatchObject({
      goodsId: '601099123456789',
      title: 'Braided USB-C Fast Charging Cable 6ft',
      price: 3.29,
      listPrice: null,
      discountPercentage: null,
      rating: null,
      reviewCount: null,
      pastMonthSales: '850 sold',
      imageUrl: 'https://img.kwcdn.com/product/fancy/cable.jpg',
      source: 'search',
    });
  });

  it('Layer 3 structural fallback: extracts cards when data-tooltip and grid classes are absent', () => {
    // Simulates a Temu frontend update where CSS classes and data-tooltip attributes changed,
    // leaving only standard <a href="...-g-<goodsId>.html"> product links inside card wrappers.
    const html = `
      <section>
        <div>
          <article>
            <a href="/portable-espresso-maker-g-601099555444333.html" aria-label="Portable Espresso Maker for Camping">
              <img src="https://img.kwcdn.com/product/fancy/espresso.jpg" alt="Portable Espresso Maker for Camping" />
              <h2>Portable Espresso Maker for Camping</h2>
            </a>
            <div>
              <span>$24.50</span>
              <span>$49.00</span>
              <span>-50%</span>
              <span>2.1K+ sold</span>
            </div>
          </article>
          <article>
            <a href="/stainless-steel-milk-frother-g-601099222111000.html" aria-label="Stainless Steel Milk Frother">
              <img src="https://img.kwcdn.com/product/fancy/frother.jpg" alt="Stainless Steel Milk Frother" />
              <h2>Stainless Steel Milk Frother</h2>
            </a>
            <div>
              <span>$6.99</span>
            </div>
          </article>
        </div>
      </section>
    `;

    const pageUrl = 'https://www.temu.com/search_result.html?search_key=coffee';
    const raws = parseTemuSearchResults(createDoc(html), pageUrl);
    expect(raws).toHaveLength(2);
    expect(raws[0]?.goodsId).toBe('601099555444333');
    expect(raws[0]?.title).toBe('Portable Espresso Maker for Camping');
    expect(raws[0]?.price).toBe(24.5);
    expect(raws[0]?.listPrice).toBe(49);
    expect(raws[0]?.discountPercentage).toBe('-50%');
    expect(raws[0]?.pastMonthSales).toBe('2.1K+ sold');

    expect(raws[1]?.goodsId).toBe('601099222111000');
    expect(raws[1]?.title).toBe('Stainless Steel Milk Frother');
    expect(raws[1]?.price).toBe(6.99);
    expect(raws[1]?.listPrice).toBeNull();
  });

  it('extracts category pages including Best Seller rank badges', () => {
    const html = `
      <div class="js-category-goodsList">
        <div data-tooltip="goodContainer-601099999888777">
          <a href="/womens-running-sneakers-g-601099999888777.html">
            <img class="goods-img-external" src="https://img.kwcdn.com/product/fancy/sneakers.jpg" />
            <div data-tooltip="goodName-601099999888777">Women's Breathable Mesh Running Sneakers</div>
          </a>
          <div data-type="price"><span data-type="priceText">$16.80</span></div>
          <span>#1 Best Seller in Women's Running Shoes</span>
          <span data-type="saleTips">50K+ sold</span>
        </div>
      </div>
    `;

    const pageUrl = 'https://www.temu.com/womens-shoes-o3-95.html';
    const raws = parseTemuCategoryPage(createDoc(html), pageUrl);
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({
      goodsId: '601099999888777',
      title: "Women's Breathable Mesh Running Sneakers",
      price: 16.8,
      bestSellersRank: "#1 Best Seller in Women's Running Shoes",
      badge: 'Best Seller',
      pastMonthSales: '50K+ sold',
      source: 'category',
    });
  });

  it('extracts Product Detail Pages (PDP) combining JSON-LD Product schema and semantic DOM landmarks', () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "Product",
              "name": " Ergonomic Mechanical Gaming Keyboard RGB 75% ",
              "sku": "601099444555666",
              "description": "Hot-swappable 75% mechanical keyboard with gasket mount and PBT keycaps.",
              "image": ["https://img.kwcdn.com/product/fancy/keyboard-hd.jpg"],
              "brand": { "@type": "Brand", "name": "KeyCraft" },
              "offers": {
                "@type": "Offer",
                "price": "34.99",
                "priceCurrency": "USD",
                "availability": "https://schema.org/InStock",
                "url": "https://www.temu.com/ergonomic-mechanical-keyboard-g-601099444555666.html"
              },
              "aggregateRating": {
                "@type": "AggregateRating",
                "ratingValue": "4.9",
                "reviewCount": "1280"
              }
            }
          </script>
        </head>
        <body>
          <div id="goodsDetail">
            <div id="rightContent">
              <h1 aria-label="Ergonomic Mechanical Gaming Keyboard RGB 75%">Ergonomic Mechanical Gaming Keyboard RGB 75%</h1>
              <div id="goods_price" data-type="price">
                <span class="srOnly">current price is: $34.99, original price is: $69.98</span>
                <span data-type="priceText">$34.99</span>
                <span data-type="discount">-50%</span>
              </div>
              <span data-type="saleTips">5.2K+ sold</span>
              <div>Sold by KeyCraft Direct Store</div>
              <div>Free shipping on all orders</div>
              <ul>
                <li>Material: ABS & PBT Double-Shot Keycaps</li>
                <li>Connectivity: Tri-Mode Wireless 2.4G / Bluetooth 5.1 / USB-C</li>
              </ul>
            </div>
          </div>
        </body>
      </html>
    `;

    const pageUrl =
      'https://www.temu.com/ergonomic-mechanical-keyboard-g-601099444555666.html';
    const raw = parseTemuProductDetail(createDoc(html), pageUrl);
    expect(raw).not.toBeNull();
    const normalized = validateAndNormalizeTemuProduct(raw!, pageUrl);
    expect(normalized).not.toBeNull();
    expect(normalized).toMatchObject({
      goodsId: '601099444555666',
      asin: '601099444555666',
      title: 'Ergonomic Mechanical Gaming Keyboard RGB 75%',
      price: 34.99,
      listPrice: 69.98,
      discountPercentage: '-50%',
      currency: 'USD',
      rating: 4.9,
      reviewCount: 1280,
      pastMonthSales: '5.2K+ sold',
      brand: 'KeyCraft',
      seller: 'KeyCraft Direct Store',
      availability: 'In Stock',
      delivery: 'Free shipping',
      isPrime: true,
      imageUrl: 'https://img.kwcdn.com/product/fancy/keyboard-hd.jpg',
      description:
        'Hot-swappable 75% mechanical keyboard with gasket mount and PBT keycaps.',
      source: 'detail',
    });
    expect(normalized?.features.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces the non-fabrication rule: missing fields remain null and are never invented', () => {
    const html = `
      <div class="js-search-goodsList">
        <div data-tooltip="goodContainer-601099000111222">
          <a href="/mystery-desk-organizer-g-601099000111222.html">
            <div data-tooltip="goodName-601099000111222">Minimalist Wooden Desk Organizer</div>
          </a>
        </div>
      </div>
    `;
    const pageUrl = 'https://www.temu.com/search_result.html?search_key=desk';
    const raws = parseTemuSearchResults(createDoc(html), pageUrl);
    expect(raws).toHaveLength(1);
    const normalized = validateAndNormalizeTemuProduct(raws[0]!, pageUrl);
    expect(normalized).toEqual({
      goodsId: '601099000111222',
      asin: '601099000111222',
      title: 'Minimalist Wooden Desk Organizer',
      price: null,
      listPrice: null,
      discountPercentage: null,
      currency: 'USD',
      rating: null,
      reviewCount: null,
      pastMonthSales: null,
      badge: null,
      dealBadge: null,
      bestSellersRank: null,
      coupon: null,
      delivery: null,
      imageUrl: null,
      url: 'https://www.temu.com/mystery-desk-organizer-g-601099000111222.html',
      isSponsored: false,
      isPrime: false,
      brand: null,
      availability: null,
      seller: null,
      description: null,
      features: [],
      source: 'search',
    });
  });

  it('deduplicates by goodsId and caches unchanged card subtrees', () => {
    const dedup = new TemuDeduplicationEngine();
    const cache = new TemuParseCache();

    const html = `
      <div class="js-search-goodsList">
        <div data-tooltip="goodContainer-601099769178067">
          <a href="/item-1-g-601099769178067.html">
            <div data-tooltip="goodName-601099769178067">First Item Title</div>
          </a>
          <div data-type="price"><span data-type="priceText">$9.99</span></div>
        </div>
      </div>
    `;
    const doc = createDoc(html);
    const pageUrl = 'https://www.temu.com/search_result.html?search_key=item';

    const firstPass = parseTemuSearchResults(doc, pageUrl, cache);
    expect(firstPass).toHaveLength(1);

    // Second pass with same DOM and populated cache skips re-parsing unchanged card
    const secondPass = parseTemuSearchResults(doc, pageUrl, cache);
    expect(secondPass).toHaveLength(0);

    // Deduplication filters repeated goodsId when enabled, and allows when disabled
    const unique1 = dedup.filterNew(firstPass);
    expect(unique1).toHaveLength(1);
    const unique2 = dedup.filterNew(firstPass);
    expect(unique2).toHaveLength(0);

    dedup.setEnabled(false);
    expect(dedup.filterNew(firstPass)).toHaveLength(1);
  });
});
