# Amazon CSS Selectors Reference

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Purpose

All Amazon DOM selectors are centralized in a single file. When Amazon changes their HTML structure, only this file needs updating. Each selector is verified against the live Amazon DOM. The date of last verification is tracked at the top of the source file.

---

## Search Results Page (`/s?k=...`)

URL pattern: `amazon.{tld}/s?k={query}` or `amazon.{tld}/s?i={category}`

| Field | Selector | Selector Type | Stability | Notes |
|-------|----------|--------------|-----------|-------|
| Product card | `[data-component-type="s-search-result"]` | Attribute | Very high | Each card is one search result. This is the container for all other selectors. |
| ASIN | `data-asin` attribute on the card | Attribute | Very high | Always present on organic and sponsored result cards. Empty for non-product rows (banners). |
| Title | `h2 a span` | Element chain | High | Inside the title link element. Strip whitespace. |
| Title link | `h2 a[href]` | Element chain | High | For building the full product URL if the ASIN is missing. |
| Current price (primary) | `.a-price[data-a-color="base"] .a-offscreen` | Class + attribute | High | The accessibility text span. Most stable price selector. |
| Current price (fallback) | `span.a-price > span.a-offscreen` | Class + element | Medium | Broader match, may catch list price too. |
| List price (strikethrough) | `.a-price[data-a-color="secondary"] .a-offscreen` | Class + attribute | High | The "was" price before discount. |
| Star rating | `span.a-icon-alt` | Class | High | Returns "4.4 out of 5 stars" — parse the leading number. |
| Review count (primary) | `[aria-label$="ratings"]` or `[aria-label$="rating"]` | Attribute ends-with | High | Returns "12,450 ratings" — parse the number. |
| Review count (fallback) | `span.s-underline-text` | Class | Medium | May match other text spans. |
| Product image | `img.s-image` | Class | High | Read via `extractBestImageUrl`, not raw `src`: `data-old-hires` → `data-a-dynamic-image` → comma-aware `srcset` → `currentSrc` → `src`. |
| Sponsored label | `.puis-sponsored-label-text` | Class | High | Presence = this card is sponsored. Absent for organic results. |
| Prime badge | `[aria-label*="Prime"]` | Attribute contains | High | Presence = Prime eligible. |
| Next page button | `.s-pagination-next` | Class | Medium | Used for pagination detection. May be absent on the last page. |
| Result info bar | `[data-component-type="s-result-info-bar"]` | Attribute | Medium | Contains "1-48 of over X results" text. |

### Parsing Notes for Search Results

- **Empty data-asin**: Some cards (banners, editorial placements) have `data-asin=""`. Skip these.
- **Multiple prices**: The first `.a-price .a-offscreen` is the current price. The second (with `data-a-color="secondary"`) is the list price.
- **Rating text**: Always in the format "X.X out of 5 stars" — extract with regex `/([0-9.]+) out of/`.
- **Review count text**: Format varies — "12,450 ratings" or "1 rating" — extract the number.
- **Sponsored detection**: Check for `.puis-sponsored-label-text` or `[data-component-type="s-sponsored-result"]`.
- **Image loading**: Images may be lazy-loaded. The `src` attribute is usually populated by the time the content script runs at `document_idle`.
- **Image URLs may contain commas (SAD-351)**: Amazon's size token can embed one (`…_AC_SF226,226_QL85_.jpg` on the `/deals` `ProductCard` grid). Never split a `srcset` on `,` alone — a comma separates candidates only when the next token starts a URL. Truncating at the comma yields a URL the CDN answers with HTTP 400.
- **Image precedence** (implemented once in `extractBestImageUrl`, shared by every parser): `data-old-hires` / `data-a-hires` → `data-a-dynamic-image` (largest area) → `srcset` / first `<picture><source srcset>` (highest descriptor, image-file URLs preferred) → `img.currentSrc` → `src` / `data-src` / `data-lazy-src`.

---

## Product Detail Page (`/dp/<ASIN>`)

URL pattern: `amazon.{tld}/dp/{ASIN}` or `amazon.{tld}/gp/product/{ASIN}`

| Field | Selector | Selector Type | Stability | Notes |
|-------|----------|--------------|-----------|-------|
| ASIN | URL path | Regex | Very high | Regex: `/dp/([A-Z0-9]{10})` on the URL pathname. |
| Title | `#productTitle` | ID | Very high | Strip leading/trailing whitespace. |
| Price (accessibility) | `span.a-price span.a-offscreen` | Class chain | High | First match is the current price. |
| Price (whole) | `span.a-price-whole` | Class | Medium | The integer part of the price. May include thousands separator. |
| Price (fraction) | `span.a-price-fraction` | Class | Medium | The decimal part. Combine with whole. |
| Price (symbol) | `span.a-price-symbol` | Class | Medium | Currency symbol ($, €, etc.). |
| List price | `.a-text-price .a-offscreen` | Class chain | High | The strikethrough "was" price. |
| Rating | `#acrPopover` title attr | ID + attribute | Very high | Returns "4.7 out of 5 stars". |
| Rating (alt) | `span[data-hook="rating-out-of-text"]` | Attribute | Medium | Alternative selector for rating text. |
| Review count | `#acrCustomerReviewText` | ID | Very high | Returns "12,450 ratings". |
| Availability | `#availability` | ID | Very high | Text content: "In Stock", "Only 3 left", "Currently unavailable". |
| Brand (primary) | `#bylineInfo` | ID | High | "Visit the X Store" or "by Brand". |
| Brand (meta) | `meta[name="author"]` | Element + attribute | Medium | Fallback for brand extraction. |
| Features | `#feature-bullets .a-list-item` | ID + class | High | Each `.a-list-item` inside `#feature-bullets` is one bullet point. |
| Description | `#productDescription p` | ID + element | Medium | Full description text. Not all products have this. |
| Description (alt) | `#aplus .a-section` | ID + class | Medium | A+ content description. Richer than basic description. |
| Hero image | `#landingImage` | ID | Very high | Use `data-old-hires` for the highest resolution, then the same cascade as cards (`extractBestImageUrl`). |
| Image gallery | `#altImages .a-button-thumbnail img` | Class chain | Medium | Each img is a gallery thumbnail. |
| Seller (primary) | `#sellerProfileTriggerId` | ID | High | Seller name link in the Buy Box. |
| Seller (fallback) | `#tabular-buybox .tabular-buybox-text a` | Class chain | Medium | Alternative seller selector for newer layouts. |
| Breadcrumb | `#wayfinding-breadcrumbs_feature_div a` | ID + element | Medium | Each `<a>` is one level of the category path. |
| Details table | `#productDetails_techSpec_section_1 tr` | ID + element | Medium | Each `<tr>` is a key-value pair (th/td). |
| Details (alt) | `#detailBullets_feature_div .a-list-item` | ID + class | Medium | Alternative format for product details. |

### Parsing Notes for Product Detail

- **ASIN from URL**: The most reliable source. Regex `/dp\/([A-Z0-9]{10})/` on the pathname. Fallback: check the product details table for an "ASIN" row.
- **Price handling**: Amazon sometimes shows "See price at checkout" instead of a number. Handle this as null.
- **Brand extraction**: `#bylineInfo` may contain "Visit the [Brand] Store" or "by [Brand]" — strip the prefix.
- **Features cleanup**: Each feature may start with whitespace or special characters. Trim and clean.
- **Multiple images**: The hero image (`#landingImage`) is the primary. The gallery (`#altImages`) has thumbnails — parse the `src` or `data-src` attribute.
- **Seller vs Brand**: The brand is the manufacturer; the seller is who's fulfilling the order. They may differ.

---

## Category / Browse Pages (`/b/`, `/Best-Sellers/`)

URL pattern: `amazon.{tld}/b/{nodeId}`, `amazon.{tld}/Best-Sellers/{category}`

| Field | Selector | Selector Type | Stability | Notes |
|-------|----------|--------------|-----------|-------|
| Product card | `.zg-grid-general-faceout, [data-asin]` | Class + attribute | Medium | Grid items in category pages. |
| Title | `._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, .a-size-base-plus` | Class | Low | Amazon obfuscates class names; these change frequently. |
| Price | `.a-price .a-offscreen` | Class chain | High | Same selector as search results. |
| Rating | `.a-icon-alt` | Class | High | Same as search results. |
| Review count | `.a-size-small` | Class | Low | May match non-review text. |
| Image | `img` | Element | Medium | Context-specific — within the card container. |
| Link | `a[href*="/dp/"]` | Attribute contains | High | Extract ASIN from the href. |

### Parsing Notes for Category Pages

- **Class name instability**: Amazon obfuscates class names on category pages. Prefer `[data-asin]` over class-based selectors.
- **Grid vs list layout**: Category pages may use grid or list layout. The selectors should handle both.
- **Bestseller badges**: Bestseller pages have additional badge elements (e.g., "#1 Best Seller"). These can be detected but are not a standard product field.
- **Limited fields**: Category pages typically have fewer fields available than search results. Focus on ASIN, title, price, rating, image.

---

## Selector Versioning Strategy

Each time selectors are updated:
1. Add a date comment at the top of the selectors file: `// Last verified: 2026-10-14`
2. Keep the old selector as a fallback comment: `// Previous: .old-selector (broken 2026-10-14)`
3. Update the corresponding parser tests with new fixture HTML
4. If a selector breaks, add the fallback chain in the parser (try primary, then fallback)

### Common Breakage Patterns

| Frequency | What Breaks | Example |
|-----------|-------------|---------|
| Every 4–8 weeks | Price whole/fraction selectors | `.a-price-whole` renamed or restructured |
| Every 2–3 months | Category page class names | Obfuscated class names rotate |
| Every 6–12 months | Sponsored label class | `.puis-sponsored-label-text` changes prefix |
| Rarely | ID-based selectors (`#productTitle`, `#availability`) | Amazon rarely changes IDs |
| Very rarely | `data-asin` attribute | Extremely stable — used by Amazon's own JS |

**Priority**: When updating, fix ID-based selectors first (they affect the most users), then attribute-based, then class-based.

---

## Anti-Bot Considerations

Since PPHunt runs as a content script in the user's browser (not as a bot), it has natural advantages:
- The user's real browser session, cookies, and User-Agent are used
- No proxy or fingerprinting concerns — the request comes from the actual browser
- The content script reads the already-loaded DOM — no additional HTTP requests
- Rate limiting is handled by the scroll controller's configurable intervals and jitter

However, Amazon may still detect automated behavior if:
- Scrolling is too fast or too regular (mitigated by jitter)
- Too many products are collected in rapid succession (mitigated by wait intervals)
- The same tab is being scraped for an extended time (user-dependent)

The extension should err on the side of caution — default scroll speeds and intervals are conservative. Users who want faster collection can adjust settings, with a note about reliability tradeoffs.