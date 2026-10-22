/**
 * Centralized, versioned declarative selector registry for the rebuilt Amazon engine.
 * Used as part of the 4-tier self-healing extraction cascade:
 *   Tier 1: Structured JSON & metadata attributes (data-p13n-asin-metadata, ld+json, data-a-state, data-a-dynamic-image)
 *   Tier 2: Semantic data-* & ARIA attributes (data-asin, data-component-type, data-cy, aria-label)
 *   Tier 3: Structural /dp/<ASIN> & /gp/product/<ASIN> anchor-tree container heuristics
 *   Tier 4: Declarative selector fallback lists defined below
 */

export const AMAZON_SELECTOR_REGISTRY_VERSION = '2.1.0';

/**
 * SAD-349: the row labels under which Amazon publishes a warranty period.
 *
 * English only, on purpose. The extension matches 23 marketplaces
 * (`AMAZON_MARKETPLACE_DOMAINS`) but the only label with verified evidence is
 * the English one — an Amazon.in Seller Central thread quotes the PDP's Product
 * information block as literally `Warranty Description  2 year manufacturer`.
 * Adding a marketplace means adding a verified translation here and nowhere
 * else; nothing in the parser is language-aware.
 *
 * The pattern is anchored on the whole label so a neighbouring row cannot match
 * by containing the word, and a match alone is never enough to store a value:
 * `normalizeWarrantyDescription` must also find a duration in the cell.
 *
 * SAD-393: Amazon Devices PDPs (Kindle/Echo/Fire TV — three live captures,
 * `docs/plans/SAD-393-fixtures/`) label the row `Warranty and Service`. The
 * only change is `and|& + support` → `and|& + support|service`; the anchor
 * and every previously accepted label are untouched.
 */
export const AMAZON_WARRANTY_LABEL_PATTERN =
  /^(?:product\s+|manufacturer(?:['\u2019]s)?\s+)?warranty(?:\s+(?:description|details?|policy|type|period|coverage|information|service|support|(?:&|and)\s+(?:support|service)))*\s*:?$/i;

/**
 * SAD-357: Priority-1 spec-row labels stating the item's own physical mass.
 * Anchored on the full normalized label so non-mass spec rows (`Maximum Weight
 * Recommendation`, `Supported Weight`, `Paper Weight`, `Line Weight`) cannot match.
 */
export const AMAZON_WEIGHT_ITEM_LABEL_PATTERN =
  /^(?:item\s+weight|product\s+weight|weight|item\s+display\s+weight|net\s+weight|unit\s+weight|artikelgewicht|poids(?:\s+de\s+l['\u2019]article)?|peso(?:\s+del\s+producto|\s+articolo)?)\s*:?$/i;

/**
 * SAD-357: Priority-2 fallback labels used only when no item-weight row exists.
 */
export const AMAZON_WEIGHT_PACKAGE_LABEL_PATTERN =
  /^(?:(?:item\s+)?package\s+weight|shipping\s+weight|boxed-product\s+weight|paketgewicht|poids\s+du\s+colis)\s*:?$/i;

/**
 * SAD-357: Priority-3 combined `L x W x H unit; Weight unit` rows.
 */
export const AMAZON_DIMENSIONS_LABEL_PATTERN =
  /^(?:product\s+dimensions|item\s+dimensions(?:\s+lxwxh)?|package\s+dimensions|parcel\s+dimensions|dimensions)\s*:?$/i;

/**
 * SAD-391: the explicit Prime-eligibility wording Amazon prints for shoppers
 * who do not see the badge (non-members / signed-out). Verified live on
 * amazon.com search cards (2026-10-21): "Join Prime to get FREE delivery
 * Fri, Oct 23" / "Or Non-members get FREE delivery Mon, Oct 26". English only
 * — a locale variant is added here when a capture shows it, never as a bare
 * "Prime" word match, and plain "FREE delivery" is deliberately NOT Prime.
 */
export const AMAZON_PRIME_INGRESS_TEXT_PATTERN =
  /\b(?:Join Prime|Prime members? get|Non-members get FREE delivery)\b/i;

/**
 * SAD-391: ARIA labels that *are* the Prime badge, anchored on the whole label.
 * "Prime" is what the real UDM and legacy badges carry; "Amazon Prime" was the
 * registry's earlier exact entry; "Prime Eligible" is the class-less Tier-3
 * shape pinned by tests/error-recovery-and-resilience.test.tsx. Anchoring is
 * what stops a product title's `aria-label` ("Primer Spray …") from matching,
 * which the former `[aria-label*="Prime" i]` wildcard did.
 */
export const AMAZON_PRIME_BADGE_LABEL_PATTERN =
  /^(?:amazon\s+)?prime(?:\s+eligible)?\.?$/i;

/**
 * SAD-391: the word "Sponsored" in the marketplaces the extension matches
 * (`AMAZON_MARKETPLACE_DOMAINS`): en, de, fr, it, es/pt, nl, sv, pl, tr, ja.
 * `AMAZON_SPONSORED_WORD_PATTERN` is the containment form used on label
 * elements the registry already identified; `AMAZON_SPONSORED_LEAF_PATTERN`
 * is the whole-text form used on anonymous leaf nodes, where only the bare
 * word may count.
 */
export const AMAZON_SPONSORED_WORD_PATTERN =
  /sponsored|gesponsert|sponsoris|sponsorizzat|patrocinad|gesponsord|sponsrad|sponsorowan|sponsorlu|スポンサー/i;
export const AMAZON_SPONSORED_LEAF_PATTERN =
  /^(?:Sponsored|Gesponsert|Sponsorisé|Sponsorizzat[oa]|Patrocinad[oa]|Gesponsord|Sponsrad|Sponsorowan[ey]|Sponsorlu|スポンサー)$/i;

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
    /**
     * SAD-349: containers that hold labelled spec rows. Amazon ships the
     * warranty period in four different shapes depending on category and page
     * age — the two `productDetails_*` tables (`<th>/<td>`), the
     * `detailBulletsWrapper` list (`<span class="a-text-bold">Label:</span>
     * Value`) and the `productOverview` table (`tr.po-*`) — so all of them are
     * walked, narrowest first. Same list as `bsr` minus the BSR-only `#SalesRank`.
     */
    warrantyContainers: [
      '#productDetails_techSpec_section_1',
      '#productDetails_techSpec_section_2',
      '#productDetails_detailBullets_sections1',
      '#productDetails_db_sections',
      '#productDetails_expanderTables_depthLeftSections',
      '#productDetails_expanderTables_depthRightSections',
      '#productDetails_expanderSectionTables',
      '[data-feature-name="productDetailsHomeAndGarden_Updated"]',
      '#detailBulletsWrapper_feature_div',
      '#productOverview_feature_div',
      '#prodDetails',
      // SAD-393: Amazon Devices PDPs keep their spec tables (incl. the
      // `Warranty and Service` row) under `#tech` — live-proven on
      // Kindle/Echo/Fire TV. Appended last: narrowest-first order and
      // every existing priority are unchanged.
      '#tech',
    ],
    /**
     * SAD-357's container walk for the weight waterfall. Identical to
     * `warrantyContainers` until SAD-393, which appended `#tech` for the
     * warranty row only: `#tech` also carries `Weight` rows (measured on
     * the full Echo PDP — post-#tech it began yielding `10.7 oz`), and no
     * field outside badge/warranty may change behaviour on that account.
     * Weight therefore keeps walking exactly the pre-SAD-393 list; adding
     * `#tech` here is a separate, separately-evidenced decision.
     */
    weightContainers: [
      '#productDetails_techSpec_section_1',
      '#productDetails_techSpec_section_2',
      '#productDetails_detailBullets_sections1',
      '#productDetails_db_sections',
      '#productDetails_expanderTables_depthLeftSections',
      '#productDetails_expanderTables_depthRightSections',
      '#productDetails_expanderSectionTables',
      '[data-feature-name="productDetailsHomeAndGarden_Updated"]',
      '#detailBulletsWrapper_feature_div',
      '#productOverview_feature_div',
      '#prodDetails',
    ],
    twister: {
      inlineRows: 'div[id^="inline-twister-row-"]',
      inlineDimTitle: '[id^="inline-twister-dim-title-"]',
      classicRows: '#twister [id^="variation_"]',
      mediaSwatches: '#tmmSwatches .swatchElement',
    },
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
      '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM span[data-csa-c-delivery-price]',
      '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM',
      '#mir-layout-DELIVERY_BLOCK',
      '#deliveryBlockMessage',
    ],
    /**
     * SAD-391: the subtrees in which a PDP Prime badge or Prime ingress counts.
     * The page-wide `i.a-icon-prime` is deliberately not used — a "similar
     * items" or sponsored carousel tile can carry a badge the buy box does not.
     * `#bbop-sbbop-container` is kept as a presence signal of its own.
     */
    primeScopes: [
      '#buybox',
      '#desktop_buybox',
      '#apex_desktop',
      '#deliveryBlockMessage',
      '#mir-layout-DELIVERY_BLOCK',
    ],
    seller: [
      '#sellerProfileTriggerId',
      '[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message',
      '#merchantInfoFeature_feature_div .offer-display-feature-text-message',
      '#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Sold by"] a',
      '#tabular-buybox .tabular-buybox-text a',
      '#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Sold by"] span',
      '#tabular-buybox .tabular-buybox-text',
      '#shipFromSoldByAbbreviatedODF_feature_div',
      '#shipFromSoldByAbbreviated_feature_div',
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
      'a[data-type="productTitle"]',
      '.a-truncate .a-truncate-full',
      '[data-testid="product-card-title"]',
      '[data-testid="deal-title"]',
      '.p13n-sc-truncate-desktop-type2',
      '.p13n-sc-truncated',
      '.p13n-sc-truncate',
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
      '[data-strikethroughprice="true"] .a-text-strike',
      '.a-text-strike',
      '#listPrice',
      '#priceblock_saleprice_lbl + span',
    ],
    discount: [
      '.savingsPercentage',
      '[data-cy="price-recipe"] span.a-letter-space + span',
      '[data-cy="price-recipe"] span',
      '[class*="discountText"]',
      '[data-testid="price-badge"] [class*="Badge"]',
      'span[class*="savingsPercentage"]',
    ],
    dealBadge: [
      '[data-a-badge-type="deal"] .a-badge-text',
      '#dealBadge_feature_div .dealBadgeText',
      '#dealBadge_feature_div .a-badge-text',
      '[data-cy="price-recipe"] .a-badge-text',
      '[data-deal-badge-automated="true"]',
      '[data-testid="badge-label"]',
      '.dealBadge .a-badge-text',
    ],
    statusBadge: [
      '[data-component-type="s-status-badge-component"] .a-badge-text',
      '.a-badge-label-inner',
      // SAD-393: Amazon moved Best Seller badges to the `amazonBadges` capsule
      // (`data-csa-c-slot-id="amazonBadges-search-badge"`, live captures
      // 2026-10-21: 14/14 Best Seller cards, `docs/plans/SAD-393-fixtures/`).
      // The label span only — the sibling `.rio-badge-supplementary-text`
      // ("in <Category>") repeats the BSR category and is never stored.
      '.rio-badge-label',
    ],
    coupon: [
      '.s-coupon-unclipped',
      '.couponLabelText',
      '[id^="couponText"]',
      '[data-component-type="s-coupon-component"] .s-coupon-unclipped',
      '[data-component-type="s-coupon-component"]',
      '#couponBadgeRegularVpc',
      '#vpcButton',
      'span[class*="coupon" i]',
    ],
    boughtInPastMonth: [
      '#social-proofing-faceout-title-tk_bought',
      '[data-cy="reviews-block"] .a-row.a-size-base',
      '[data-cy="reviews-block"]',
      'span.a-size-base.a-color-secondary',
    ],
    rating: [
      '[data-cy="reviews-block"] span.a-icon-alt',
      '[data-cy="reviews-block"] i[class*="a-star"] span.a-icon-alt',
      'i[class*="a-star"] span.a-icon-alt',
      '.a-icon-row span.a-icon-alt',
      'span.a-icon-alt',
      'a[data-type="productReviews"]',
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
      'a[data-type="productReviews"] .a-color-tertiary',
      'a[data-type="productReviews"]',
      'span[data-rt]',
      '#acrCustomerReviewText',
      'a[href*="product-reviews"] span',
      'a[href*="#customerReviews"] span',
      'span[aria-label$="ratings" i]',
      'span[aria-label$="reviews" i]',
    ],
    /**
     * SAD-391: the Prime *badge*. Amazon renders it only for signed-in Prime
     * members: UDM cards (2025+) as `.udm-badge-block > i.a-icon-prime-with-text
     * > i.a-icon-prime[aria-label="Prime"]`, legacy/p13n cards as
     * `i.a-icon-prime.a-icon-small[aria-label="Prime"]`. The ARIA label is the
     * exact word "Prime", so the match is exact — a `*=` wildcard also hit
     * product titles ("Primer Spray").
     */
    prime: [
      '.udm-badge-block i.a-icon-prime',
      'i.a-icon-prime',
      '.a-icon-prime-with-text',
      '[aria-label="Prime" i]',
      '[aria-label="Amazon Prime" i]',
      '[data-testid*="prime-badge"]',
      '#bbop-sbbop-container',
    ],
    /**
     * SAD-391: the Prime-eligibility *ingress* a non-member sees instead of the
     * badge — the "Join Prime to get FREE delivery <date>" link inside the
     * unified delivery message. Scoped to the card's main delivery recipe on
     * purpose: the same link also appears in the "Get it faster" secondary
     * offer block (`[data-cy="multi-offer-display"]`, measured live on
     * B0GPW3BJ6V), where it describes a different, pricier offer than the one
     * whose price and delivery the row carries.
     */
    primeIngress: [
      '[data-cy="delivery-recipe"] .udm-sfx-prime-signup-trigger',
      '[data-cy="delivery-recipe"] .prime-brand-color',
    ],
    /**
     * SAD-391: every entry is read with the text guard in
     * `extractCardIsSponsored` (empty text or a localized "Sponsored" word),
     * which is what keeps Amazon's own "Featured from Amazon brands" tiles —
     * they reuse `.puis-sponsored-label-text` with a different label — organic.
     * The `aria-label` wildcard is scoped to the label element so a product
     * title can never match it. `[data-ad-feedback-label-id]` and the
     * `sp-info-popover-<ASIN>` popover are the ad-disclosure hooks of the 2025
     * Sponsored Products card.
     */
    sponsored: [
      '.puis-sponsored-label-text',
      '[data-component-type="sp-sponsored-result"]',
      '.puis-sponsored-label-text [aria-label*="Sponsored" i]',
      '.s-widget-sponsored-label-text',
      '.sponsored-brand-label-info-desktop',
      '.s-label-popover-default',
      '[data-ad-feedback-label-id]',
      '[data-a-popover*="sp-info-popover" i]',
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
    variationSwatches: {
      containers: '.s-color-swatch-container',
      swatchLinks:
        '[data-csa-c-content-id="color-swatch-link"] a[aria-label], .s-color-swatch-container a[aria-label]:not(.s-color-swatch-link)',
      moreLinks:
        '[data-csa-c-content-id="color-swatch-more-link"], .s-color-swatch-container a.s-color-swatch-link',
    },
  },
} as const;

export const SELECTORS = AMAZON_SELECTORS;

export function safeQuerySelector<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T | null {
  try {
    return root.querySelector<T>(selector);
  } catch (err) {
    if (err instanceof DOMException) {
      return null;
    }
    throw err;
  }
}

export function safeQuerySelectorAll<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T[] {
  try {
    return Array.from(root.querySelectorAll<T>(selector));
  } catch (err) {
    if (err instanceof DOMException) {
      return [];
    }
    throw err;
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
