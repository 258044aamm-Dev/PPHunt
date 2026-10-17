/**
 * Amazon CSS Selectors — Last verified: 2026-10-16
 *
 * When Amazon changes their DOM, update this one file.
 * All parsers import selectors from here rather than hardcoding them.
 */

export const SELECTORS = {
  search: {
    /**
     * Root container of the result grid. H-9b (Phase 5): the MutationObserver
     * watches this instead of the whole <body> so unrelated DOM churn (lazy
     * images, carousels, ad beacons, hover popovers) no longer re-triggers a
     * full parse. Falls back to <body> when nothing matches.
     */
    resultsContainer:
      '[data-component-type="s-search-results"], .s-main-slot, #search, [role="main"]',
    /** Container for each product card */
    productCard:
      '[data-component-type="s-search-result"], div.s-result-item[data-asin]:not([data-asin=""])',
    /** ASIN is the data-asin attribute on the card */
    asin: 'data-asin',
    /** Product title text */
    title:
      'h2 a span, a h2 span, [data-cy="title-recipe"] a h2 span, [data-cy="title-recipe"] h2 a span, h2 span',
    /** Title link element */
    titleLink:
      'h2 a[href], a:has(h2)[href], [data-cy="title-recipe"] a[href], a.a-link-normal.s-underline-text[href], a.a-link-normal[href*="/dp/"], a.a-link-normal[href*="/gp/"]',
    /** Current selling price — accessibility text, strictly excluding struck-through list prices */
    price:
      '.a-price.priceToPay .a-offscreen, .a-price[data-a-color="base"]:not([data-a-strike="true"]) .a-offscreen, .a-price[data-a-color="price"]:not([data-a-strike="true"]) .a-offscreen',
    /** Current price fallback (still strictly excluding strike-through/secondary reference prices) */
    priceFallback:
      'span.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not([data-a-color="tertiary"]):not(.a-text-price) > span.a-offscreen, [data-cy="price-recipe"] .a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-offscreen',
    /** Price whole part */
    priceWhole:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-price-whole',
    /** Price fraction part */
    priceFraction:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-price-fraction',
    /** Price currency symbol */
    priceSymbol:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-price-symbol',
    /** List / original reference price (strikethrough) */
    listPrice:
      '.a-price[data-a-strike="true"] .a-offscreen, .a-text-price[data-a-strike="true"] .a-offscreen, .a-price[data-a-color="secondary"] .a-offscreen, .basisPrice .a-offscreen, .a-text-price .a-offscreen, [data-testid*="list-price"], [data-testid*="was-price"]',
    /** Discount percentage badge / text */
    discountPercentage:
      '.savingsPercentage, .reinventPriceSavingsPercentageMargin, [class*="savingsPercentage"], [data-testid*="percent-off"], [data-testid*="savings-badge"], .dealPriceSavings',
    /** Deal badge */
    dealBadge:
      '[data-a-badge-type="deal"] .a-badge-text, [data-a-badge-type="deal"], .s-uk-deal-badge, [data-testid*="deal-badge"], .dealBadgeText, .dealBadge, [class*="dealBadge"]',
    /** Star rating — "4.4 out of 5 stars" */
    rating:
      'span.a-icon-alt, i[class*="a-star"] span.a-icon-alt, [aria-label*="out of 5"], [aria-label*="Sternen"], [aria-label*="sur 5"], [aria-label*="de 5"]',
    /** Review count — aria-label ends with "ratings" or "rating" */
    reviewCount:
      '[aria-label$="ratings"], [aria-label$="rating"], a[href*="#customerReviews"] span.s-underline-text, a[href*="customerReviews"] span.s-underline-text',
    /** Review count fallback */
    reviewCountFallback:
      'span.s-underline-text, [data-cy="reviews-block"] span.a-size-base',
    /** Product image */
    image:
      'img.s-image, .s-product-image-container img, .a-dynamic-image, [data-testid*="image"] img, picture img, img[src*="/images/I/"], img[data-src*="/images/I/"]',
    /** Sponsored label */
    sponsored:
      '.puis-sponsored-label-text, [data-component-type="s-sponsored-result"], .s-sponsored-label-text, .puis-sponsored-label-info-icon, [aria-label="Sponsored"]',
    /** Prime badge */
    prime:
      '[aria-label*="Prime"], i.a-icon-prime, .s-prime i, span[data-component-type="s-status-badge-component"]',
    /** Brand label on search card */
    brand:
      'h5.s-line-clamp-1 span, .s-line-clamp-1 span.a-size-base-plus, [data-cy="title-recipe"] .a-color-secondary',
    /** Availability / stock notice on search card */
    availability:
      '[data-cy="delivery-recipe"] .a-color-price, .a-row.a-size-base.a-color-secondary .a-color-price, .a-color-success, [aria-label*="left in stock"], [aria-label*="unavailable"]',
    /** Seller info on search card */
    seller: '[data-cy="secondary-offer-recipe"] .a-color-base',
    /** Coupon component on search card */
    coupon:
      '[data-component-type="s-coupon-component"], .s-coupon-unclipped, .couponLabelText, [data-csa-c-type="coupon"]',
    /** Editorial / Best Seller badge on search card */
    badge:
      '[data-component-type="s-status-badge-component"] .a-badge-text, .a-badge-label, .zg-bdg-text',
    /** Delivery block on search card */
    delivery:
      '[data-cy="delivery-recipe"], .s-align-children-center [aria-label*="delivery"], [aria-label*="FREE delivery"]',
    /** Next page button */
    nextPage: '.s-pagination-next',
    /** Result info bar */
    resultInfo: '[data-component-type="s-result-info-bar"]',
  },

  productDetail: {
    /** Product title */
    title: '#productTitle, #title span, h1#title',
    /** Scoped primary price containers (checked before whole-document fallback, excluding strike-through) */
    scopedPrice:
      '#corePriceDisplay_desktop_feature_div .priceToPay span.a-offscreen, #corePriceDisplay_desktop_feature_div .apexPriceToPay span.a-offscreen, #corePriceDisplay_desktop_feature_div span.a-price:not([data-a-strike="true"]):not(.a-text-price) span.a-offscreen, #corePrice_feature_div span.a-price:not([data-a-strike="true"]):not(.a-text-price) span.a-offscreen, #apex_desktop span.a-price:not([data-a-strike="true"]):not(.a-text-price) span.a-offscreen, #buybox span.a-price:not([data-a-strike="true"]):not(.a-text-price) span.a-offscreen, #tp_price_block_total_price_ww span.a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #priceblock_saleprice, #price_inside_buybox, #newBuyBoxPrice, .a-price.priceToPay span.a-offscreen',
    /** Price — accessibility text (strictly non-strikethrough) */
    price:
      'span.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) span.a-offscreen',
    /** Price whole part */
    priceWhole:
      '#corePriceDisplay_desktop_feature_div .a-price:not([data-a-strike="true"]) .a-price-whole, #corePrice_feature_div .a-price:not([data-a-strike="true"]) .a-price-whole, .a-price:not([data-a-strike="true"]) .a-price-whole',
    /** Price fraction part */
    priceFraction:
      '#corePriceDisplay_desktop_feature_div .a-price:not([data-a-strike="true"]) .a-price-fraction, #corePrice_feature_div .a-price:not([data-a-strike="true"]) .a-price-fraction, .a-price:not([data-a-strike="true"]) .a-price-fraction',
    /** Price currency symbol */
    priceSymbol:
      '#corePriceDisplay_desktop_feature_div .a-price:not([data-a-strike="true"]) .a-price-symbol, #corePrice_feature_div .a-price:not([data-a-strike="true"]) .a-price-symbol, .a-price:not([data-a-strike="true"]) .a-price-symbol',
    /** List price (strikethrough / basisPrice) */
    listPrice:
      '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price[data-a-strike="true"] .a-offscreen, #corePrice_feature_div .a-text-price .a-offscreen, #apex_desktop .basisPrice .a-offscreen, .basisPrice .a-offscreen, .a-price[data-a-strike="true"] .a-offscreen, .a-text-price[data-a-strike="true"] .a-offscreen, .a-text-price .a-offscreen, #priceblock_listprice, .priceBlockStrikePriceString',
    /** Discount percentage on detail page */
    discountPercentage:
      '#corePriceDisplay_desktop_feature_div .savingsPercentage, #corePriceDisplay_desktop_feature_div .reinventPriceSavingsPercentageMargin, #apex_desktop .savingsPercentage, .savingsPercentage, #regularprice_savings .a-color-price, .dealPriceSavings',
    /** Deal badge on detail page */
    dealBadge:
      '#dealBadge_feature_div .dealBadgeText, #dealBadge_feature_div, [data-a-badge-type="deal"] .a-badge-text, .dealBadge, [data-testid*="deal-badge"]',
    /** Best Sellers Rank container on detail page */
    bestSellersRank:
      '#SalesRank, #detailBulletsWrapper_feature_div, #productDetails_detailBullets_sections1, #productDetails_db_sections',
    /** Rating — title attribute on popover */
    rating: '#acrPopover, #averageCustomerReviews #acrPopover',
    /** Rating alt */
    ratingText:
      'span[data-hook="rating-out-of-text"], #acrPopover .a-icon-alt, #averageCustomerReviews .a-icon-alt',
    /** Review count */
    reviewCount: '#acrCustomerReviewText, [data-hook="total-review-count"]',
    /** Availability */
    availability: '#availability span, #availability, #outOfStock .a-color-price',
    /** Brand */
    brand: '#bylineInfo, #brand, tr.po-brand .po-break-word',
    /** Brand meta fallback */
    brandMeta: 'meta[name="brand"], meta[name="author"]',
    /** Feature bullets */
    features:
      '#feature-bullets .a-list-item, #productFactsDesktopExpander .a-list-item',
    /** Description */
    description: '#productDescription p, #productDescription',
    /** Description alt (A+ content) */
    descriptionAlt: '#aplus .a-section, #aplus_feature_div .aplus-v2',
    /** Hero image */
    heroImage:
      '#landingImage, #imgBlkFront, #main-image, #ebooksImgBlkFront, #imgTagWrapperId img',
    /** Image gallery thumbnails */
    imageGallery: '#altImages .a-button-thumbnail img, #imageBlock img',
    /** Seller name */
    seller: '#sellerProfileTriggerId, #merchant-info a',
    /** Seller fallback */
    sellerFallback:
      '#tabular-buybox .tabular-buybox-text a, #tabular-buybox .tabular-buybox-text, #tabular-buybox a, #merchant-info, #fulfillerInfoFeature_feature_div .offer-display-feature-text-message, #merchantInfoFeature_feature_div .offer-display-feature-text-message',
    /** Prime indicator on detail page */
    prime:
      '#bbop-check-box, #primeSavingsUpsell, #apex_desktop i.a-icon-prime, #buybox i.a-icon-prime, #priceBadging_feature_div i.a-icon-prime',
    /** Category breadcrumb */
    breadcrumb: '#wayfinding-breadcrumbs_feature_div a',
    /** Product details table rows */
    detailsTable:
      '#productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, #productDetails_detailBullets_sections1 tr, #productOverview_feature_div tr',
    /** Details bullets fallback */
    detailsTableAlt:
      '#detailBullets_feature_div .a-list-item, #detailBulletsWrapper_feature_div li',
  },

  category: {
    /** Root container of the grid (H-9b observer target; falls back to <body>). */
    resultsContainer: '.zg-grid, #gridIndexRoot, #grid-container, [role="main"]',
    /** Product cards in grid/list */
    productCard:
      '.zg-grid-general-faceout, #gridItemRoot, .p13n-sc-uncoverable-faceout, .octopus-pc-item, [data-testid="product-card"], [data-testid="deal-card"], [data-asin]',
    /** Title */
    title:
      '._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, ._cDEzb_p13n-sc-css-line-clamp-2_EWgCb, ._cDEzb_p13n-sc-css-line-clamp-1_1Fn1y, .p13n-sc-truncate-desktop-type2, .p13n-sc-truncate, .octopus-pc-asin-title, [data-testid="product-card-title"], .a-size-base-plus, h2 span',
    /** Current selling price (strictly excluding struck-through list prices) */
    price:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-offscreen, ._cDEzb_p13n-sc-price_3mJ9Z, .p13n-sc-price',
    /** Price whole part */
    priceWhole:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-price-whole',
    /** Price fraction part */
    priceFraction:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-price-fraction',
    /** Price currency symbol */
    priceSymbol:
      '.a-price:not([data-a-strike="true"]):not([data-a-color="secondary"]):not(.a-text-price) .a-price-symbol',
    /** List / reference price on category or deal cards */
    listPrice:
      '.a-price[data-a-strike="true"] .a-offscreen, .a-text-price[data-a-strike="true"] .a-offscreen, .a-price[data-a-color="secondary"] .a-offscreen, .basisPrice .a-offscreen, .a-text-price .a-offscreen, [data-testid*="list-price"], [data-testid*="was-price"]',
    /** Discount percentage on category or deal cards */
    discountPercentage:
      '.savingsPercentage, [class*="savingsPercentage"], [data-testid*="percent-off"], [data-testid*="savings-badge"], .dealPriceSavings',
    /** Deal badge on category or deal cards */
    dealBadge:
      '[data-a-badge-type="deal"] .a-badge-text, [data-a-badge-type="deal"], [data-testid*="deal-badge"], .dealBadgeText, .dealBadge, [class*="dealBadge"]',
    /** Best Sellers Rank badge on bestsellers/category cards */
    bestSellersRank: '.zg-bdg-text, .zg-badge-text, [data-testid*="bestseller-rank"]',
    /** Rating */
    rating: '.a-icon-alt, i[class*="a-star"] span',
    /** Review count */
    reviewCount:
      '.a-icon-row a span.a-size-small, a[href*="product-reviews"] span, a[href*="#customerReviews"] span, [aria-label$="ratings"], [aria-label$="rating"], .a-size-small',
    /** Image */
    image:
      'img.s-image, .a-dynamic-image, [data-testid*="image"] img, picture img, img[src*="/images/I/"], img[data-src*="/images/I/"], img',
    /** Link to product */
    link: 'a[href*="/dp/"], a[href*="/gp/product/"]',
    /** Prime badge */
    prime: 'i.a-icon-prime, [aria-label*="Prime"]',
    /** Sponsored badge */
    sponsored:
      '.puis-sponsored-label-text, [data-component-type="s-sponsored-result"], .s-sponsored-label-text',
  },
} as const;
