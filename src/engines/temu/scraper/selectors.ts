/**
 * Temu Non-Hashed Semantic Selectors — Verified against live Temu US DOM & Modern.js bundles (2026-10-17).
 *
 * FUTURE-PROOFING RULE:
 * Never place Webpack/Modern.js hashed CSS module classes (e.g. `_6SrDUqV_`, `_1_ozo7oW`) in this file.
 * Use only stable `data-tooltip`, `data-type`, `data-js-*`, `data-sales`, `aria-*`, `role`, semantic IDs,
 * and `js-*` functional hooks emitted by Temu's shared React components (`bui-web-goods-list` & `goods`).
 */

export const TEMU_SELECTORS = {
  listing: {
    /**
     * Scoped root container for the MutationObserver on search & category grids.
     * Falls back to `[role="main"]` or `document.body` when absent.
     */
    resultsContainer:
      '.js-search-goodsList, .js-category-goodsList, .js-category-RecGoodsList, .auto-fit-list, #main_scale, [role="main"]',

    /**
     * Primary semantic product card wrappers (`bui-web-goods-list`).
     * `[data-tooltip^="goodContainer-"]` carries `goodContainer-${goodsId}` and `data-tooltip-title="${fullTitle}"`.
     */
    productCard:
      '[data-tooltip^="goodContainer-"], [data-goods-id], [data-testid*="goods-item" i], [data-testid*="product-card" i]',

    /** Title wrapper carrying `goodName-${goodsId}` and `data-tooltip-title="${fullTitle}"` */
    titleWrapper:
      '[data-tooltip^="goodName-"][data-tooltip-title], [data-tooltip^="goodName-"], h2, h3, [role="link"][aria-label]',

    /** Product anchor href patterns linking to a Temu product detail page */
    productLink:
      'a[href*="-g-"], a[href*="goods.html"], a[href*="goods_id="]',

    /** Current selling price block (`[data-type="price"]` contains `.srOnly` or `[aria-label]`) */
    sellingPrice:
      '[data-type="price"] [class*="srOnly"], [data-type="price"][aria-label], [data-type="price"]',

    /**
     * Reference / original struck-through price block.
     * SAD-380: aria vocabulary unified with the parsers (Original/Regular/
     * List/Was). Note the step-1 live capture also showed `priceText`
     * carrying promo text on feed cards — candidates from this selector are
     * always validated (currency token + strictly above the selling price)
     * in `extractTemuPricing`, which also has aria-scan and struck-leaf
     * fallbacks; this selector alone never assigns a value.
     */
    listPrice:
      '[data-type="priceText"], [aria-label*="Original price" i], [aria-label*="Regular price" i], [aria-label*="List price" i], [aria-label*="Was price" i], del, s',

    /** Discount percentage badge (`[data-type="discount"]` e.g. `-68%`) */
    discountPercentage:
      '[data-type="discount"], [aria-label*="off" i][data-type="discount"]',

    /** Unit price (`[data-type="unitPrice"]`) */
    unitPrice: '[data-type="unitPrice"]',

    /** Sales count / velocity (`[data-type="saleTips"]`, e.g. `10K+ sold`) */
    salesTips: '[data-type="saleTips"], [data-sales="true"] [data-type="saleTips"]',

    /** Star rating element (`div[role="img"][aria-label*="out of five stars" i]`) */
    rating:
      '[role="img"][aria-label*="out of five stars" i], [role="img"][aria-label*="out of 5" i], [role="img"][aria-label*="star" i], [aria-label*="out of five stars" i], [aria-label*="out of 5 stars" i]',

    /** Review count container inside or adjacent to rating region */
    reviewRegion: '[role="region"], [aria-label*="review" i], [aria-label*="rating" i]',

    /** Primary product image (`img[data-js-main-img="true"]` or `.goods-img-external`) */
    image:
      'img[data-js-main-img="true"], img.goods-img-external, .goods-image-container-external img, img[src*="kwcdn.com"], img[data-src*="kwcdn.com"]',

    /** Add to cart button (`[data-type="goodsCart"]`) */
    addToCartButton: '[data-type="goodsCart"]',

    /** "See more items" pagination button on Temu search & category listings */
    seeMoreButton:
      '[role="button"][aria-label*="See more" i], button[aria-label*="See more" i]',
  },

  productDetail: {
    /** Main PDP layout landmarks */
    rootContainer: '#rightContent, #leftContent, #goodsDetail, [role="main"]',

    /** Product title heading on PDP (`h1[aria-label]` inside `#rightContent` or `#leftContent`) */
    title:
      '#rightContent h1[aria-label], #leftContent h1[aria-label], #rightContent h1, #leftContent h1, h1[aria-label], h1',

    /** Scoped PDP price container (`#goods_price`) */
    priceContainer: '#goods_price',

    /** Selling price inside `#goods_price` */
    sellingPrice:
      '#goods_price [data-type="price"], #goods_price [aria-label*="$"], #goods_price [aria-label*="price" i]',

    /** Struck-through / original reference price inside `#goods_price` or `#rightContent` */
    listPrice:
      '#goods_price [data-type="priceText"], #goods_price [aria-label*="Original price" i], #goods_price del, #goods_price s, #rightContent del, #rightContent s',

    /** Discount percentage inside `#goods_price` or `#rightContent` */
    discountPercentage:
      '#goods_price [data-type="discount"], #rightContent [data-type="discount"]',

    /** Review & rating section on PDP */
    reviewContainer: '#reviewContent, #rightContent, #leftContent',

    /** Hero / gallery product images on PDP */
    heroImage:
      '#leftContent img[data-js-main-img="true"], #leftContent img[src*="kwcdn.com"], #big_picture_img_item img, img[data-js-main-img="true"], img[src*="kwcdn.com"]',

    /** Breadcrumb navigation links */
    breadcrumb: 'nav[aria-label*="breadcrumb" i] a, ol li a[href*="-o"]',

    /**
     * SAD-381: product-details section. `GoodsDetailV2` emits this id
     * unconditionally on a PDP (verified in Temu's own goods bundle).
     */
    detailsSection: '#goodsDetail',

    /**
     * SAD-381: Temu's stable module wrapper. Both the `Highlight` module and
     * `DescriptionV2` render `data-id="module"`; the hashed class names beside
     * it rotate per deploy and are never used.
     */
    moduleBlock: '[data-id="module"]',

    /** SAD-381: `GoodsPropertyTable` rows (`<tr><th>key</th><td>value</td></tr>`). */
    propertyTable: 'table tr',

    /** SAD-381: the right column that carries the `Description` module. */
    descriptionRegion: '#rightContent',
  },
} as const;
