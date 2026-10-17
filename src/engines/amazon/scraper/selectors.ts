/**
 * Centralized, versioned declarative selector registry for the rebuilt Amazon engine.
 * Used as part of the 4-tier self-healing extraction cascade:
 *   Tier 1: Structured JSON & metadata attributes (data-p13n-asin-metadata, ld+json, data-a-state, data-a-dynamic-image)
 *   Tier 2: Semantic data-* & ARIA attributes (data-asin, data-component-type, data-cy, aria-label)
 *   Tier 3: Structural /dp/<ASIN> & /gp/product/<ASIN> anchor-tree container heuristics
 *   Tier 4: Declarative selector fallback lists defined below
 */

export const AMAZON_SELECTOR_REGISTRY_VERSION = '2.0.0';

export const AMAZON_SELECTORS = {
  search: {
    productCard:
      '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
    mainContainers: [
      '[data-component-type="s-search-results"]',
      '.s-main-slot.s-result-list',
      '.s-main-slot',
      '#search .s-search-results',
    ],
    cardContainers: [
      '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
      '.s-result-item[data-asin]:not([data-asin=""])',
      '[data-cel-widget^="search_result_"][data-asin]:not([data-asin=""])',
    ],
    paginationNext: [
      'a.s-pagination-next:not(.s-pagination-disabled)',
      '.s-pagination-item.s-pagination-next:not(.s-pagination-disabled)',
      '.a-pagination li.a-last:not(.a-disabled) a',
      'a[aria-label*="Go to next page" i]',
      'a[aria-label*="Next page" i]',
    ],
  },

  category: {
    productCard:
      '#gridItemRoot, .zg-grid-general-faceout, [id^="p13n-asin-index-"], [data-p13n-asin-metadata], [data-testid="product-card"], [data-testid*="deal-card"], .octopus-pc-item',
    bestSellerCards: [
      '#gridItemRoot',
      '.zg-grid-general-faceout',
      '[id^="p13n-asin-index-"]',
      '[data-p13n-asin-metadata]',
      '.zg-item-immersion',
    ],
    dealCards: [
      '[data-testid="product-card"]',
      '[data-testid="grid-deals-container"] [data-testid*="deal-card"]',
      '[data-testid*="deal-card"]',
      '[data-csa-c-item-id*="amzn1.deal"]',
      '.DealGridItem-module__dealItemContent',
    ],
    browseCards: [
      '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
      '.s-result-item[data-asin]:not([data-asin=""])',
      '.octopus-pc-item',
      '.apb-browse-searchresults-product',
      '[data-asin]:not([data-asin=""])',
    ],
    loadMoreControls: [
      '[data-testid="load-more-view-more-button"]',
      'button[aria-label*="View more deals" i]',
      'button[aria-label*="See more" i]',
      'button[aria-label*="Load more" i]',
      '[data-action*="show-more" i] button',
      '[data-action*="show-more" i] a',
      'a.s-pagination-next:not(.s-pagination-disabled)',
      '.a-pagination li.a-last:not(.a-disabled) a',
    ],
  },

  detail: {
    rootContainers: ['#dp-container', '#dp', '#ppd', '#centerCol'],
    buyboxScopes: [
      '#corePriceDisplay_desktop_feature_div',
      '#corePrice_feature_div',
      '#apex_desktop',
      '#buybox',
      '#desktop_buybox',
      '#newBuyBoxPrice',
      '#price_inside_buybox',
      '#priceblock_ourprice_row',
      '#priceblock_dealprice_row',
      '#tp_price_block_total_price_ww',
    ],
    excludedSubtrees: [
      '[id*="sp_detail"]',
      '[id*="sims-consolidated"]',
      '[class*="sp_detail"]',
      '#similarities_feature_div',
      '#HLCXComparisonWidget_feature_div',
      '.a-carousel-container',
      '[data-component-type="sp-sponsored-result"]',
    ],
    title: [
      '#productTitle',
      '#title span#productTitle',
      'h1#title span',
      'h1#title',
      '[data-feature-name="title"] h1',
    ],
    brand: [
      '#bylineInfo',
      'a#bylineInfo',
      '[data-feature-name="bylineInfo"] a',
      '#brand',
      'tr.po-brand td.a-span9 span',
      '#productOverview_feature_div tr.po-brand span.po-break-word',
    ],
    bsr: [
      '#SalesRank',
      '#detailBulletsWrapper_feature_div',
      '#prodDetails',
      '#productDetails_detailBullets_sections1',
      '#productDetails_db_sections',
    ],
    description: [
      '#productDescription p',
      '#productDescription span',
      '#productDescription',
      '#bookDescription_feature_div',
    ],
    features: [
      '#feature-bullets ul li span.a-list-item',
      '#featurebullets_feature_div ul li span.a-list-item',
      '#productFactsDesktopExpander ul li span.a-list-item',
    ],
    availability: [
      '#availability span',
      '#availability',
      '#outOfStock .a-color-price',
    ],
    delivery: [
      '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE span[data-csa-c-delivery-price]',
      '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
      '#mir-layout-DELIVERY_BLOCK',
      '#deliveryBlockMessage',
    ],
    seller: [
      '#sellerProfileTriggerId',
      '#tabular-buybox .tabular-buybox-text a',
      '#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Sold by"] span',
      '#tabular-buybox .tabular-buybox-text',
      '#merchant-info a',
      '#merchant-info',
    ],
    images: [
      '#landingImage',
      '#imgBlkFront',
      '#main-image',
      '#imgTagWrapperId img',
      '#imageBlock img',
    ],
  },

  cardFields: {
    title: [
      '[data-cy="title-recipe"] a h2 span',
      '[data-cy="title-recipe"] h2 a span',
      'h2 a.a-link-normal span',
      'h2 a span',
      '[data-cy="title-recipe"] h2 span',
      'h2.a-size-mini span',
      'h2 span.a-text-normal',
      'h2',
      '[data-testid="product-card-title"]',
      '[data-testid="deal-title"]',
      '.p13n-sc-truncate-desktop-type2',
      '.p13n-sc-truncated',
      '[class*="_cDEzb_p13n-sc-css-line-clamp"]',
      '.octopus-pc-asin-title',
    ],
    brand: [
      '[data-cy="title-recipe"] > h2 > span',
      '[data-cy="title-recipe"] .a-row.a-size-base.a-color-secondary span.a-size-base-plus',
      'h5.s-line-clamp-1 span',
      '.s-line-clamp-1 span.a-size-base-plus',
    ],
    sellingPrice: [
      '[data-cy="price-recipe"] .a-price:not([data-a-strike="true"]) .a-offscreen',
      '.a-price:not([data-a-strike="true"]) .a-offscreen',
      '.priceToPay .a-offscreen',
      '.apexPriceToPay .a-offscreen',
      '#priceblock_dealprice',
      '#priceblock_ourprice',
      '#price_inside_buybox',
      '[data-testid="price-badge"] [class*="Price"]',
      '._cDEzb_p13n-sc-price_3mJ9Z',
      '.p13n-sc-price',
      '.octopus-pc-asin-price .a-offscreen',
      '.a-color-price',
    ],
    wholePrice: '.a-price:not([data-a-strike="true"]) .a-price-whole',
    fractionPrice: '.a-price:not([data-a-strike="true"]) .a-price-fraction',
    priceSymbol: '.a-price:not([data-a-strike="true"]) .a-price-symbol',
    listPrice: [
      '[data-cy="price-recipe"] .a-price[data-a-strike="true"] .a-offscreen',
      '.a-price[data-a-strike="true"] .a-offscreen',
      '.a-text-price[data-a-strike="true"] .a-offscreen',
      '.basisPrice .a-offscreen',
      'span[data-a-strike="true"] .a-offscreen',
      '#listPrice',
      '#priceblock_saleprice_lbl + span',
    ],
    discount: [
      '.savingsPercentage',
      '[data-cy="price-recipe"] span.a-letter-space + span',
      '[data-testid="price-badge"] [class*="Badge"]',
      'span[class*="savingsPercentage"]',
    ],
    dealBadge: [
      '[data-a-badge-type="deal"] .a-badge-text',
      '#dealBadge_feature_div .dealBadgeText',
      '#dealBadge_feature_div .a-badge-text',
      '[data-cy="price-recipe"] .a-badge-text',
      '[data-testid="badge-label"]',
      '.dealBadge .a-badge-text',
    ],
    statusBadge: [
      '[data-component-type="s-status-badge-component"] .a-badge-text',
      '.a-badge-label-inner',
    ],
    coupon: [
      '[data-component-type="s-coupon-component"]',
      '.s-coupon-unclipped',
      '#couponBadgeRegularVpc',
      '#vpcButton',
      'span[class*="coupon" i]',
    ],
    boughtInPastMonth: [
      '[data-cy="reviews-block"] .a-row.a-size-base span.a-color-secondary',
      '#social-proofing-faceout-title-tk_bought span',
      'span.a-size-base.a-color-secondary',
      'div > span',
    ],
    rating: [
      '[data-cy="reviews-block"] span.a-icon-alt',
      '[data-cy="reviews-block"] i[class*="a-star"] span.a-icon-alt',
      'i[class*="a-star"] span.a-icon-alt',
      '.a-icon-row span.a-icon-alt',
      'span.a-icon-alt',
      '#acrPopover span.a-icon-alt',
      '#acrPopover',
      '[aria-label*="out of 5 stars" i]',
      '[aria-label*="von 5 Sternen" i]',
      '[aria-label*="sur 5 étoiles" i]',
      '[aria-label*="de 5 estrellas" i]',
      '[aria-label*="su 5 stelle" i]',
      '[aria-label*="5つ星のうち"]',
    ],
    reviewCount: [
      '[data-cy="reviews-block"] a[href*="#customerReviews"] span.s-underline-text',
      '[data-cy="reviews-block"] a[href*="#customerReviews"] span',
      '[data-cy="reviews-block"] span.s-underline-text',
      '#acrCustomerReviewText',
      'a[href*="product-reviews"] span',
      'a[href*="#customerReviews"] span',
      'span[aria-label$="ratings" i]',
      'span[aria-label$="reviews" i]',
    ],
    prime: [
      'i.a-icon-prime',
      '[aria-label="Amazon Prime" i]',
      '[data-testid*="prime-badge"]',
      '#bbop-sbbop-container',
    ],
    sponsored: [
      '.puis-sponsored-label-text',
      '[data-component-type="sp-sponsored-result"]',
      'span[aria-label*="Sponsored" i]',
      '.s-label-popover-default',
    ],
    delivery: [
      '[data-cy="delivery-recipe"] [aria-label]',
      '[data-cy="delivery-recipe"]',
      '[data-csa-c-content-id*="delivery"]',
      '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
      '#mir-layout-DELIVERY_BLOCK',
    ],
    image: [
      'img.s-image',
      '[data-component-type="s-product-image"] img',
      '#gridItemRoot img',
      'img[data-a-dynamic-image]',
      'img[src*="media-amazon.com/images/"]',
      'img[src*="images-amazon.com/images/"]',
      'img[src*="ssl-images-amazon.com/images/"]',
    ],
  },
} as const;

export const SELECTORS = AMAZON_SELECTORS;

export function safeQuerySelector<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T | null {
  try {
    return root.querySelector<T>(selector);
  } catch {
    return null;
  }
}

export function safeQuerySelectorAll<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T[] {
  try {
    return Array.from(root.querySelectorAll<T>(selector));
  } catch {
    return [];
  }
}

export function queryFirstMatching<T extends Element = Element>(
  root: ParentNode,
  selectors: readonly string[],
): { element: T | null; selector: string | null } {
  for (const selector of selectors) {
    const found = safeQuerySelector<T>(root, selector);
    if (found) {
      return { element: found, selector };
    }
  }
  return { element: null, selector: null };
}
