import { describe, expect, it } from 'vitest';
import {
  AmazonDeduplicationEngine,
  countProductCards,
  parseAmazonSearchResults,
} from '@/engines/amazon/scraper';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const LAPTOP_SEARCH_URL =
  'https://www.amazon.com/s?k=laptop&crid=2I5D8KO22QIN2&qid=1792256221&sprefix=lapto%2Caps%2C424&xpid=g7fsmeKaEMp_8&ref=sr_pg_1';

describe('Amazon Search Multi-Section Widget Extraction & Richer-Card Merging (SAD-259)', () => {
  it('extracts Sponsored Brand themed collection carousels, Sponsored Brand Video collections, Single-Product Sponsored Video cards, and Customer Review / Shopping Adviser carousels inside .s-main-slot while excluding Brand Store banners and #rhf noise', () => {
    const html = `
      <div class="s-main-slot s-result-list s-search-results sg-row">
        <!-- Widget 1: Sponsored Brand Themed Collection (sb-themed-collection) -->
        <div data-asin="" class="sg-col-20-of-24 s-result-item s-widget s-widget-spacing-large AdHolder s-flex-full-width">
          <div cel_widget_id="MAIN-TOP_BANNER_MESSAGE-0">
            <div data-card-metrics-id="sb-themed-collection-carousel-desktop_loom-desktop-top-slot_0">
              <div id="sponsored-brands-top-bar"><span>Sponsored</span></div>
              <ol class="a-carousel">
                <li class="a-carousel-card">
                  <div data-asin="B0HJG54TV2" class="_c2Itd_asinContainer_2167M">
                    <a href="https://sponsored-ads.amazon.com/clk/?aa=1&r=https%3A%2F%2Fwww.amazon.com%2Fgp%2Faw%2Fd%2FB0HJG54TV2">
                      <img src="https://m.media-amazon.com/images/I/718efD4DSiL._AC_SR270,180_QL70_.jpg" alt="15.6 Inch Laptop Student Business" />
                    </a>
                    <a aria-label="15.6 Inch Laptop, 16GB RAM 1TB SSD, FHD IPS Backlit Keyboard Laptop" href="https://sponsored-ads.amazon.com/clk/?aa=1&r=https%3A%2F%2Fwww.amazon.com%2Fgp%2Faw%2Fd%2FB0HJG54TV2">
                      <span class="a-truncate">
                        <span class="a-truncate-full a-offscreen">15.6 Inch Laptop, 16GB RAM 1TB SSD, FHD IPS Backlit Keyboard Laptop</span>
                        <span class="a-truncate-cut" aria-hidden="true">15.6 Inch Laptop, 16GB RAM...</span>
                      </span>
                    </a>
                    <a aria-label="Rated 4.5 out of 5 stars by 2 reviews. Go to review section." href="https://www.amazon.com/gp/aw/d/B0HJG54TV2#customerReviews">
                      <span class="a-size-small">4.5</span>
                      <i class="a-icon a-icon-star-mini a-star-mini-4-5"></i>
                      <span data-rt="2">(2)</span>
                    </a>
                    <div class="_c2Itd_dealBadge_KEp1h" data-deal-badge-automated="true">
                      <span>Limited time deal</span>
                    </div>
                    <div>
                      <span class="_c2Itd_discountText_2gdxP">-38%</span>
                      <span class="a-price" data-a-size="l">
                        <span class="a-offscreen">$499.99</span>
                        <span aria-hidden="true">
                          <span class="a-price-symbol">$</span>
                          <span class="a-price-whole">499</span>
                          <span class="a-price-fraction">99</span>
                        </span>
                      </span>
                    </div>
                    <div data-strikethroughprice="true">
                      <span>List: </span>
                      <span class="a-text-strike">$799.99</span>
                    </div>
                  </div>
                </li>
              </ol>
            </div>
          </div>
        </div>

        <!-- Main Search Card 1 (also has nested .atc-faceout-container with same ASIN) -->
        <div data-asin="B0GQ9R7MRZ" data-component-type="s-search-result" class="s-result-item s-asin AdHolder">
          <span class="puis-sponsored-label-text">Sponsored</span>
          <div data-cy="title-recipe">
            <h2><span>jumper</span></h2>
            <a class="a-link-normal" href="/dp/B0GQ9R7MRZ">
              <h2><span>jumper 15.6 Inch Laptop with 16GB RAM 512GB SSD, Intel N95 Processor</span></h2>
            </a>
          </div>
          <div data-cy="reviews-block">
            <span class="a-icon-alt">5.0 out of 5 stars</span>
            <a href="/dp/B0GQ9R7MRZ#customerReviews"><span class="s-underline-text">(17)</span></a>
            <div class="a-row a-size-base"><span class="a-color-secondary">50+ bought in past month</span></div>
          </div>
          <div data-cy="price-recipe">
            <span class="a-badge-text" data-a-badge-type="deal">Limited time deal</span>
            <span class="a-price"><span class="a-offscreen">$259.99</span></span>
            <span class="a-price" data-a-strike="true"><span class="a-offscreen">$799.99</span></span>
            <span>-68%</span>
            <span class="s-coupon-unclipped">Save $20.00 with coupon</span>
          </div>
          <div data-cy="delivery-recipe">
            <span aria-label="FREE delivery Wed, Oct 21">FREE delivery Wed, Oct 21</span>
          </div>
          <i class="a-icon-prime"></i>
          <img class="s-image" src="https://m.media-amazon.com/images/I/71jumper._AC_UY218_.jpg" />
          <div class="a-section atc-faceout-container" data-asin="B0GQ9R7MRZ">
            <button>Add to cart</button>
          </div>
        </div>

        <!-- Widget 2: Sponsored Brand Video Multi-Product Collection (sb-video-creative) with responsive duplicate containers -->
        <div data-asin="" class="sg-col-20-of-24 s-result-item s-widget s-widget-spacing-large s-flex-full-width">
          <div data-card-metrics-id="sb-video-product-collection-desktop_loom-desktop-inline-slot_0">
            <div class="sb-video-creative">
              <!-- Carousel responsive copy (inCarousel=true) -->
              <ol class="a-carousel">
                <li class="a-carousel-card">
                  <div data-asin="B0GWFMM48S" data-asinadattributesprops='{"asin":"B0GWFMM48S","imageUrl":"https://m.media-amazon.com/images/I/711y99ab6KL._AC_SR462,462_QL70_.jpg","dealString":"Prime Big Deal","inCarousel":true,"productComponents":{"title":"BiTECOOL 2026 Flagship 15.6 Inch Laptop, Core i5-1235U, 16GB RAM 512GB NVMe SSD","customerReviews":"{\\"count\\":\\"29\\",\\"ratingValue\\":\\"4.5\\"}"}}'>
                    <a data-type="productTitle" href="https://www.amazon.com/dp/B0GWFMM48S">BiTECOOL 2026 Flagship 15.6 Inch Laptop</a>
                  </div>
                </li>
              </ol>
              <!-- Desktop responsive copy (inCarousel=false) with price -->
              <div data-type="productContainer" data-asin="B0GWFMM48S" data-asinadattributesprops='{"asin":"B0GWFMM48S","imageUrl":"https://m.media-amazon.com/images/I/711y99ab6KL._AC_SR462,462_QL70_.jpg","dealString":"Prime Big Deal","inCarousel":false,"productComponents":{"title":"BiTECOOL 2026 Flagship 15.6 Inch Laptop, Core i5-1235U, 16GB RAM 512GB NVMe SSD","customerReviews":"{\\"count\\":\\"29\\",\\"ratingValue\\":\\"4.5\\"}"}}'>
                <a data-type="productTitle" href="https://www.amazon.com/dp/B0GWFMM48S">BiTECOOL 2026 Flagship 15.6 Inch Laptop, Core i5-1235U, 16GB RAM 512GB NVMe SSD</a>
                <a data-type="productReviews" aria-label="Rated 4.5 out of 5 stars from 29 reviews" href="https://www.amazon.com/dp/B0GWFMM48S#customerReviews">
                  <span>4.5</span>
                  <span class="a-color-tertiary">(29)</span>
                </a>
                <span class="a-price"><span class="a-offscreen">$389.99</span></span>
                <span class="a-price" data-a-strike="true"><span class="a-offscreen">$499.99</span></span>
              </div>
            </div>
          </div>
        </div>

        <!-- Widget 3: Customer Review / Shopping Adviser Carousel (s-shopping-adviser) with duplicate ASIN B0GQ9R7MRZ + unique organic ASIN B0GR1493ZV -->
        <div data-asin="" class="sg-col-20-of-24 s-result-item s-widget s-widget-spacing-large s-flex-full-width">
          <div cel_widget_id="MAIN-SHOPPING_ADVISER-16">
            <span data-component-type="s-shopping-adviser">
              <h2>Highly rated by customers for value</h2>
              <ol class="a-carousel">
                <li class="a-carousel-card">
                  <!-- Compact duplicate of B0GQ9R7MRZ (missing pastMonthSales, delivery, coupon) -->
                  <div data-asin="B0GQ9R7MRZ" class="s-result-item s-card-container">
                    <div data-cy="title-recipe">
                      <a class="a-link-normal" href="/dp/B0GQ9R7MRZ"><h2><span>jumper 15.6 Inch Laptop</span></h2></a>
                    </div>
                    <div data-cy="price-recipe">
                      <span class="a-price"><span class="a-offscreen">$259.99</span></span>
                    </div>
                    <img class="s-image" src="https://m.media-amazon.com/images/I/71jumper._AC_UY218_.jpg" />
                  </div>
                </li>
                <li class="a-carousel-card">
                  <!-- Unique organic Customer Review product B0GR1493ZV -->
                  <div data-asin="B0GR1493ZV" class="s-result-item s-card-container">
                    <div data-cy="title-recipe">
                      <a class="a-link-normal" href="/dp/B0GR1493ZV">
                        <h2><span>ASUS Vivobook Go 15.6” FHD Slim Laptop, AMD Ryzen 3 7320U, 8GB RAM, 128GB SSD</span></h2>
                      </a>
                    </div>
                    <div data-cy="reviews-block">
                      <span class="a-icon-alt">4.6 out of 5 stars</span>
                      <a href="/dp/B0GR1493ZV#customerReviews"><span class="s-underline-text">(1,420)</span></a>
                    </div>
                    <div data-cy="price-recipe">
                      <span class="a-price"><span class="a-offscreen">$279.99</span></span>
                      <span class="a-price" data-a-strike="true"><span class="a-offscreen">$329.99</span></span>
                      <span>-15%</span>
                    </div>
                    <img class="s-image" src="https://m.media-amazon.com/images/I/71asus._AC_UY218_.jpg" />
                    <div class="a-section atc-faceout-container" data-asin="B0GR1493ZV">
                      <button>Add to cart</button>
                    </div>
                  </div>
                </li>
              </ol>
            </span>
          </div>
        </div>

        <!-- Widget 4: Single-Product Sponsored Video Card (sbv-video-single-product, data-asin="" on outer wrapper) -->
        <div data-asin="" class="sg-col-20-of-24 s-result-item s-widget s-widget-spacing-large s-flex-full-width">
          <div cel_widget_id="MAIN-VIDEO_SINGLE_PRODUCT-22">
            <div data-component-type="sbv-video-single-product">
              <img src="https://aax-us-east-retail-direct.amazon.com/e/is/12345/impb?b=J6&w=0" alt="" />
              <div data-csa-c-asin="B0HFCVRC77" data-csa-c-item-id="amzn1.asin.B0HFCVRC77">
                <a href="https://aax-us-east-retail-direct.amazon.com/x/c/abc/https://www.amazon.com/acer- Aspire/dp/B0HFCVRC77/ref=sr_1_1?pd_rd_i=B0HFCVRC77">
                  <img class="s-image" src="https://m.media-amazon.com/images/I/71qfrQCzUOL._AC_UL640_QL65_.jpg" alt="Sponsored Ad - acer Aspire 15 Slim Laptop" />
                </a>
                <div data-cy="title-recipe">
                  <h2><span>acer</span></h2>
                  <a class="a-link-normal" href="https://aax-us-east-retail-direct.amazon.com/x/c/abc/https://www.amazon.com/acer-Aspire/dp/B0HFCVRC77/ref=sr_1_1?pd_rd_i=B0HFCVRC77">
                    <h2><span>acer Aspire 15 Slim Laptop, 15.6" FHD IPS, Snapdragon X, 16GB LPDDR5X, 512GB SSD</span></h2>
                  </a>
                </div>
                <div data-cy="reviews-block">
                  <span class="a-icon-alt">4.4 out of 5 stars</span>
                  <a href="/dp/B0HFCVRC77#customerReviews"><span class="s-underline-text">(86)</span></a>
                </div>
                <div data-cy="price-recipe">
                  <span class="a-badge-text" data-a-badge-type="deal">Limited time deal</span>
                  <span class="a-price"><span class="a-offscreen">$549.99</span></span>
                  <span class="a-price" data-a-strike="true"><span class="a-offscreen">$749.99</span></span>
                  <span>-27%</span>
                </div>
                <div data-cy="delivery-recipe">
                  <span aria-label="FREE delivery Thu, Oct 22">FREE delivery Thu, Oct 22</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Excluded Widget 5: Non-Product Brand Store Banner ("Brands related to your search") -->
        <div data-asin="" class="sg-col-20-of-24 s-result-item s-widget s-widget-spacing-large s-flex-full-width">
          <div data-card-metrics-id="multi-brand-creative-desktop_loom-desktop-brand-footer-slot_0">
            <h2>Brands related to your search</h2>
            <a href="https://www.amazon.com/stores/page/017F750C-2F32-4B79-B642-6BC4D004C603?lp_asins=B0FJ57ZSK4,B0FJ5FZ4JZ">
              <span>Explore HP Store</span>
            </a>
          </div>
        </div>
      </div>

      <!-- Out-of-slot Footer Recommendation Carousel (#rhf) — must be excluded -->
      <div id="rhf">
        <div class="a-carousel-card" data-asin="B0RHFNOISE">
          <a href="/dp/B0RHFNOISE"><span>Footer Noise Product</span></a>
          <span class="a-price"><span class="a-offscreen">$19.99</span></span>
        </div>
      </div>
    `;

    const doc = createDoc(html);
    const parsed = parseAmazonSearchResults(doc, LAPTOP_SEARCH_URL);
    const byAsin = new Map(parsed.map((p) => [p.asin, p]));

    // Should extract exactly the 5 unique real products in .s-main-slot and exclude Brand Store & #rhf
    expect(parsed.map((p) => p.asin)).toEqual([
      'B0GQ9R7MRZ',
      'B0HJG54TV2',
      'B0GWFMM48S',
      'B0GR1493ZV',
      'B0HFCVRC77',
    ]);
    expect(byAsin.has('B0RHFNOISE')).toBe(false);

    // 1. Sponsored Brand Themed Collection product (B0HJG54TV2)
    const sbThemed = byAsin.get('B0HJG54TV2')!;
    expect(sbThemed.title).toBe(
      '15.6 Inch Laptop, 16GB RAM 1TB SSD, FHD IPS Backlit Keyboard Laptop',
    );
    expect(sbThemed.price).toBe(499.99);
    expect(sbThemed.listPrice).toBe(799.99);
    expect(sbThemed.discountPercentage).toBe('38% off');
    expect(sbThemed.dealBadge).toBe('Limited time deal');
    expect(sbThemed.rating).toBe(4.5);
    expect(sbThemed.reviewCount).toBe(2);
    expect(sbThemed.isSponsored).toBe(true);

    // 2. Duplicate ASIN B0GQ9R7MRZ (merges richer primary s-search-result card fields over compact Customer Review carousel card)
    const mergedPrimary = byAsin.get('B0GQ9R7MRZ')!;
    expect(mergedPrimary.title).toBe(
      'jumper 15.6 Inch Laptop with 16GB RAM 512GB SSD, Intel N95 Processor',
    );
    expect(mergedPrimary.brand).toBe('jumper');
    expect(mergedPrimary.price).toBe(259.99);
    expect(mergedPrimary.listPrice).toBe(799.99);
    expect(mergedPrimary.discountPercentage).toBe('68% off');
    expect(mergedPrimary.dealBadge).toBe('Limited time deal');
    expect(mergedPrimary.coupon).toBe('Save $20.00 with coupon');
    expect(mergedPrimary.pastMonthSales).toBe('50+ bought in past month');
    expect(mergedPrimary.delivery).toBe('FREE delivery Wed, Oct 21');
    expect(mergedPrimary.isPrime).toBe(true);
    expect(mergedPrimary.isSponsored).toBe(true);

    // 3. Sponsored Brand Video multi-product item (B0GWFMM48S) merged across carousel & desktop containers
    const sbVideo = byAsin.get('B0GWFMM48S')!;
    expect(sbVideo.title).toBe(
      'BiTECOOL 2026 Flagship 15.6 Inch Laptop, Core i5-1235U, 16GB RAM 512GB NVMe SSD',
    );
    expect(sbVideo.price).toBe(389.99);
    expect(sbVideo.listPrice).toBe(499.99);
    expect(sbVideo.dealBadge).toBe('Prime Big Deal');
    expect(sbVideo.rating).toBe(4.5);
    expect(sbVideo.reviewCount).toBe(29);
    expect(sbVideo.isSponsored).toBe(true);

    // 4. Customer Review / Shopping Adviser organic item (B0GR1493ZV) -> isSponsored must be false
    const reviewItem = byAsin.get('B0GR1493ZV')!;
    expect(reviewItem.title).toContain('ASUS Vivobook Go 15.6” FHD Slim Laptop');
    expect(reviewItem.price).toBe(279.99);
    expect(reviewItem.listPrice).toBe(329.99);
    expect(reviewItem.discountPercentage).toBe('15% off');
    expect(reviewItem.rating).toBe(4.6);
    expect(reviewItem.reviewCount).toBe(1420);
    expect(reviewItem.isSponsored).toBe(false);

    // 5. Single-Product Sponsored Video card (B0HFCVRC77) -> ASIN from data-csa-c-asin, ignores AAX tracking pixel
    const singleVideo = byAsin.get('B0HFCVRC77')!;
    expect(singleVideo.title).toContain('acer Aspire 15 Slim Laptop');
    expect(singleVideo.brand).toBe('acer');
    expect(singleVideo.price).toBe(549.99);
    expect(singleVideo.listPrice).toBe(749.99);
    expect(singleVideo.discountPercentage).toBe('27% off');
    expect(singleVideo.dealBadge).toBe('Limited time deal');
    expect(singleVideo.rating).toBe(4.4);
    expect(singleVideo.reviewCount).toBe(86);
    expect(singleVideo.imageUrl).toContain('71qfrQCzUOL');
    expect(singleVideo.imageUrl).not.toContain('aax-');
    expect(singleVideo.isSponsored).toBe(true);

    // 6. countProductCards under-count guard holds while ignoring #rhf noise
    expect(countProductCards(doc)).toBeGreaterThanOrEqual(parsed.length);
  });

  it('merges richer fields across scroll passes via AmazonDeduplicationEngine when a compact widget card is seen before a main search card', () => {
    const dedup = new AmazonDeduplicationEngine();

    const compactWidgetDoc = createDoc(`
      <div class="s-main-slot">
        <div cel_widget_id="MAIN-FEATURED_ASINS_LIST-15">
          <ol class="a-carousel">
            <li class="a-carousel-card">
              <div data-asin="B0MERGE001" class="s-result-item">
                <div data-cy="title-recipe">
                  <a class="a-link-normal" href="/dp/B0MERGE001"><h2><span>Compact Title</span></h2></a>
                </div>
                <div data-cy="price-recipe">
                  <span class="a-price"><span class="a-offscreen">$399.99</span></span>
                </div>
                <img class="s-image" src="https://m.media-amazon.com/images/I/compact._AC_UY218_.jpg" />
              </div>
            </li>
          </ol>
        </div>
      </div>
    `);

    const richerMainCardDoc = createDoc(`
      <div class="s-main-slot">
        <div data-asin="B0MERGE001" data-component-type="s-search-result" class="s-result-item s-asin">
          <div data-cy="title-recipe">
            <h2><span>Lenovo</span></h2>
            <a class="a-link-normal" href="/dp/B0MERGE001"><h2><span>Lenovo IdeaPad Slim 3 15.6" FHD Laptop</span></h2></a>
          </div>
          <div data-cy="reviews-block">
            <span class="a-icon-alt">4.7 out of 5 stars</span>
            <a href="/dp/B0MERGE001#customerReviews"><span class="s-underline-text">(512)</span></a>
            <div class="a-row a-size-base"><span class="a-color-secondary">1K+ bought in past month</span></div>
          </div>
          <div data-cy="price-recipe">
            <span class="a-price"><span class="a-offscreen">$399.99</span></span>
            <span class="a-price" data-a-strike="true"><span class="a-offscreen">$599.99</span></span>
            <span>-33%</span>
          </div>
          <div data-cy="delivery-recipe">
            <span aria-label="FREE delivery Tomorrow">FREE delivery Tomorrow</span>
          </div>
          <img class="s-image" src="https://m.media-amazon.com/images/I/compact._AC_UY218_.jpg" />
        </div>
      </div>
    `);

    const collected = parseAmazonSearchResults(compactWidgetDoc, LAPTOP_SEARCH_URL);
    expect(collected).toHaveLength(1);
    dedup.mergeAndFilterNew([], collected);

    const pass2 = parseAmazonSearchResults(richerMainCardDoc, LAPTOP_SEARCH_URL);
    const { newProducts, updatedExisting } = dedup.mergeAndFilterNew(
      collected,
      pass2,
    );

    expect(newProducts).toHaveLength(0);
    expect(updatedExisting).toBe(true);
    expect(collected[0]!.brand).toBe('Lenovo');
    expect(collected[0]!.listPrice).toBe(599.99);
    expect(collected[0]!.discountPercentage).toBe('33% off');
    expect(collected[0]!.rating).toBe(4.7);
    expect(collected[0]!.reviewCount).toBe(512);
    expect(collected[0]!.pastMonthSales).toBe('1K+ bought in past month');
    expect(collected[0]!.delivery).toBe('FREE delivery Tomorrow');
  });
});
