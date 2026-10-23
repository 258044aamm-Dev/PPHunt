# SAD-390 — Root-Cause Analysis & Implementation Plan: `delivery` and `seller` Extraction

- **Issue**: [SAD-390 — The delivery and seller fields](https://linear.app/sad-mod/issue/SAD-390/the-delivery-and-seller-fields)
- **Branch**: `fix/sad-390-delivery-seller` (based on `main@2ec7eaf`)
- **Scope**: Amazon engine (`src/engines/amazon/scraper/*`); Temu engine, DB schemas, and UI/export schemas remain untouched.

---

## 1. Live Reproduction via Moli (`lexmount/moli`)

Using `moli fetch --wait-until done` (Moli 1.1.18) across 6 live `amazon.com` search queries (`wireless+earbuds`, `coffee+maker`, `usb+c+cable`, `anker+charger`, `gaming+mouse`, `mechanical+keyboard` — 120+ search cards) and 16 live `amazon.com` PDPs (`B00MNV8E0C`, `B0G66ZJG3Y`, `B00AHAWWO0`, `B07MJL8NXR`, `B0DKVDZXSN`, `B0D7NXSQ44`, `B0CNVCQZG1`, `B0HDB173YV`, `B0HCZ5ZF7J`, `B09V3KXJPB`, `B07ZPKN6YR`, `B0946MVWGD`, `B0D1XD1ZV3`, `B09BD8GZ8L`, `B0D54JZTHY`, `B07PXGQC1Q`), we reproduced the exact extraction failures in `delivery` and `seller`.

### 1.1 Listing Card `delivery` Reproduction (`extractCardDeliveryAndAvailability` in `src/engines/amazon/scraper/field-parsers.ts`)

1. **Inline `<style>` and `<script>` contamination**:
   On live search cards (`B01GJOMWVA`, `B0D8LXRHQ8`, `B0H9LC953P`, `B07S98411N`, etc.), `[data-cy="delivery-recipe"]` contains `[data-cy="delivery-block"].udm-delivery-block` with **no** `aria-label` on the delivery elements, and embeds `<style>.prime-brand-color {color: #0064f9; }</style>` plus a 1,258-char `<script type="text/javascript">(function(f) {var _np=(window.P._namespace("udm-kata-sfx-prime-signup-ingress-script"))...` inside `.udm-primary-delivery-message`.
   Falling back to `normalizeWhitespace(deliveryBlock.textContent)` leaked the raw CSS and JavaScript source into `product.delivery`.
2. **Adjacent block rows concatenated without whitespace**:
   `.udm-primary-delivery-message` (`... FREE delivery Fri, Oct 23`) and `.udm-secondary-delivery-message` (`Or Non-members get FREE delivery Mon, Oct 26`) are sibling `<div>` blocks with no text whitespace node between them. Raw `.textContent` concatenated them as `"FREE delivery Fri, Oct 23Or Non-members get FREE delivery Mon, Oct 26"`.
3. **`delivery` dropped when a low-stock `.a-color-price` notice is also present**:
   On live cards with low-stock warnings (`B0FTZZYP24`, `B077KD11T1`, `B0HFJ75YSY`, `B0HFHZCLD7`, `B0BVMZRNZL`), `[data-cy="delivery-recipe"]` renders both `[data-cy="delivery-block"]` (`FREE delivery Oct 28 - 30`) and a sibling row `<span aria-label="Only 14 left in stock - order soon."><span class="a-size-base a-color-price">Only 14 left in stock - order soon.</span></span>`.
   Because `safeQuerySelector(deliveryBlock, '[aria-label]')` matched the stock notice's `aria-label` (failing `/delivery|.../i`) and `else if (!availability)` skipped the fallback whenever `availability` was truthy, `delivery` became `undefined`.
4. **Unused fallback selectors**:
   `AMAZON_SELECTORS.cardFields.delivery` defines fallback selectors (`[data-csa-c-content-id*="delivery"]`, `#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE`, `#mir-layout-DELIVERY_BLOCK`) that `extractCardDeliveryAndAvailability` never consulted when `[data-cy="delivery-recipe"]` was absent.

### 1.2 PDP `seller` Reproduction (`AMAZON_SELECTORS.detail.seller` & `parseAmazonProductDetail`)

1. **Missing modern Offer Display Features (ODF) selectors on 1st-party (`Amazon.com`) PDPs**:
   Modern Amazon desktop buyboxes render seller information inside `#merchantInfoFeature_feature_div` (`[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message`) and, on accordion buyboxes, `#shipFromSoldByAbbreviatedODF_feature_div`.
   - For 3rd-party sellers, Amazon places `<a id="sellerProfileTriggerId" class="... offer-display-feature-text-message">` inside `[offer-display-feature-name="desktop-merchant-info"]`.
   - For 1st-party products sold by `Amazon.com`, there is **no `#sellerProfileTriggerId` anchor**, **no `#tabular-buybox`**, and **no `#merchant-info`** in the active buybox — only `<span class="a-size-small offer-display-feature-text-message">Amazon.com</span>`.
   - On non-accordion 1P PDPs (`B0G66ZJG3Y`, `B0CNVCQZG1`), `#shipFromSoldByAbbreviatedODF_feature_div` is also absent; `#merchantInfoFeature_feature_div` (`[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message`) is the sole seller node in the DOM.
   - Consequently, 1P PDPs without a Used accordion (`B00MNV8E0C`, `B0G66ZJG3Y`, `B07MJL8NXR`, `B0CNVCQZG1`) returned `seller: null` (`MISSING`).
2. **Inactive / Used buybox accordion contamination**:
   On 1P PDPs with a collapsed "Save with Used" accordion row (`#usedAccordionRow`, `data-csa-c-is-in-initial-active-row="false"`) — such as `B00AHAWWO0`, `B0DKVDZXSN`, and `B0D7NXSQ44` — the active New row is sold by `Amazon.com` (via ODF), while the collapsed `#usedAccordionRow` contains legacy `<div id="merchant-info">Sold by <a>Amazon Resale</a> and <a>Fulfilled by Amazon</a>.</div>`. Without ODF selectors and active-offer prioritization, `parseAmazonProductDetail` extracted `"Amazon Resale"` instead of `"Amazon.com"`.
   Similarly, on multi-row 3P accordion PDPs (`B0HDB173YV`, `B07ZPKN6YR`), inactive rows (`#buyBoxAccordion [data-csa-c-is-in-initial-active-row="false"]`) carry different sellers (`EVERJOY TECH TRADING LIMITED`, `RightBox`).
3. **Abbreviated ODF and colon-formatted seller strings in `cleanSeller`**:
   `#shipFromSoldByAbbreviatedODF_feature_div` renders `Ships from: Amazon.com Sold by: Amazon.com`, and `#merchantInfoFeature_feature_div` includes `Shipper / Seller`. `cleanSeller` previously only stripped `/^Ships from and sold by\s+/i` and `/^Sold by\s+/i` (without optional colons or `Ships from: ... Sold by: ...` prefix handling) and did not reject standalone `"Fulfilled by Amazon"`.

### 1.3 PDP `delivery` Reproduction (`parseAmazonProductDetail` in `src/engines/amazon/scraper/product-detail.ts`)

1. **Inline `<script>` and `<style>` inside `#mir-layout-DELIVERY_BLOCK` and `#deliveryBlockMessage`**:
   PDPs with a Prime signup upsell (`B00MNV8E0C`, `B09V3KXJPB`, `B0HDB173YV`, `B0HCZ5ZF7J`, `B0G66ZJG3Y`, `B00AHAWWO0`) embed an inline `<script>` (`window.P._namespace("udm-sfx-prime-signup-ingress-script")`) inside `#mir-layout-DELIVERY_BLOCK` / `#deliveryBlockMessage`. Using raw `el.textContent` leaks script content whenever extraction falls back to those containers.
2. **Active vs inactive accordion delivery blocks**:
   Multi-accordion PDPs (`B0HDB173YV`, `B00AHAWWO0`, `B07ZPKN6YR`) include separate delivery blocks inside `#usedAccordionRow` and inactive accordion rows (`#buyBoxAccordion [data-csa-c-is-in-initial-active-row="false"]`) with slower delivery dates.

---

## 2. Implementation Steps

1. **Step 1 (Docs & Verbatim Fixtures)**:
   - Record root-cause analysis and plan in `docs/plans/SAD-390-delivery-seller-plan.md`.
   - Commit verbatim Moli-captured HTML fragments in `docs/plans/SAD-390-fixtures/`.
2. **Step 2 (`field-parsers.ts` — Clean Element Text, `cleanSeller`, Card `delivery` & `seller`)**:
   - Add `extractCleanElementText(root, extraExcludeSelector)` to strip `script, style, noscript, template, [hidden], .aok-hidden, .a-hidden, .a-popover-preload` and preserve spaces across block boundaries (`div, p, li, tr, br`).
   - Harden `cleanSeller` to handle colons (`Sold by: ...`), combined `Ships from: ... Sold by: ...`, `Shipper / Seller`, and reject standalone `"Fulfilled by Amazon"`.
   - Update `extractCardDeliveryAndAvailability` and `extractCardSeller` to use `extractCleanElementText`, check all `[aria-label]` nodes, extract both `delivery` and `availability` when a card has both `[data-cy="delivery-block"]` and a `.a-color-price` stock notice, and consult fallback selectors in `AMAZON_SELECTORS.cardFields.delivery`.
3. **Step 3 (`selectors.ts` & `product-detail.ts` — ODF Selectors, Active-Offer Scoping, JSON-LD Fallback)**:
   - Add `[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message`, `#merchantInfoFeature_feature_div .offer-display-feature-text-message`, `#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Sold by"] a`, `#shipFromSoldByAbbreviatedODF_feature_div`, `#shipFromSoldByAbbreviated_feature_div` to `AMAZON_SELECTORS.detail.seller`, and `_MEDIUM` delivery slots to `AMAZON_SELECTORS.detail.delivery`.
   - In `parseAmazonProductDetail`, use a two-pass lookup for `delivery` and `seller` (Pass 1 skips secondary/Used/inactive accordion subtrees `#usedBuySection, #usedAccordionRow, #usedOnlyBuybox, #used_buybox_desktop, #usedbuyBox, #olpLinkWidget_feature_div, #moreBuyingChoices_feature_div, #snsAccordionRowMiddle, #snsDetailPage, #buyBoxAccordion [data-csa-c-is-in-initial-active-row="false"]`; Pass 2 allows fallback for Used-only PDPs), strip non-content nodes via `extractCleanElementText`, and add JSON-LD `offers.seller` fallback.
4. **Step 4 (Full Verification, PR & Linear In Review)**:
   - Run full verification gate (`tsc --noEmit`, `check:dead-exports`, `vitest run`, `wxt build`, `npm audit --omit=dev`, manifest sanity, and live Moli verification), commit `docs/plans/SAD-390-verification-report.md`, open PR against `main`, and move `SAD-390` to **In Review**.
