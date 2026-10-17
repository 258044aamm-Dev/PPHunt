# Phase 2: Content Script & Scraping Engine

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Build the DOM scraping logic that extracts product data from Amazon pages. Implement page type detection (search results, product detail, category/browse), the centralized CSS selectors file, parsers for each page type, the deduplication engine, the auto-scroll controller, and the typed messaging protocol that connects the content script to the background service worker. At the end of this phase, navigating to an Amazon search results page and starting a collection sends parsed products to IndexedDB via the background.

---

## Amazon Page Type Detection

The content script must first determine what kind of Amazon page it's running on. Three supported page types:

**Search results** (`/s?k=...` or `/s?i=...`):
- URL starts with `/s` and contains `?k=` or `?i=` query parameter
- Fallback detection: check for `[data-component-type="s-search-result"]` in the DOM

**Product detail** (`/dp/<ASIN>` or `/gp/product/<ASIN>`):
- URL path matches `/dp/[A-Z0-9]{10}` or `/gp/product/[A-Z0-9]{10}`
- This is the regex most reliable for ASIN extraction from URLs

**Category / Browse pages** (`/b/`, `/Best-Sellers/`):
- URL starts with `/b/` or `/Best-Sellers/` or contains `bestsellers`
- Fallback: check for `#departments` element in the DOM

If none match, the page type is `unknown` and the content script reports this to the side panel so it can show the "not a supported page" guidance.

---

## Centralized CSS Selectors

All Amazon CSS selectors live in a single file. When Amazon changes their DOM, this is the only file that needs updating. Each selector is verified against the current Amazon DOM (last verified: October 2026). The file is organized by page type.

### Search Results Page Selectors

| Field | Selector | Notes |
|-------|----------|-------|
| Product card container | `[data-component-type="s-search-result"]` | Most stable selector — each card is a result |
| ASIN | `data-asin` attribute on the card | Always present on search result cards |
| Product title | `h2 a span` | Inside the title link |
| Title link | `h2 a[href]` | For building the full product URL |
| Current price (primary) | `.a-price[data-a-color="base"] .a-offscreen` | Accessibility text — most stable price selector |
| Current price (fallback) | `span.a-price > span.a-offscreen` | When primary fails |
| List price (strikethrough) | `.a-price[data-a-color="secondary"] .a-offscreen` | Original price before discount |
| Star rating | `span.a-icon-alt` | Returns text like "4.4 out of 5 stars" |
| Review count (primary) | `[aria-label$="ratings"]` or `[aria-label$="rating"]` | aria-label based, stable |
| Review count (fallback) | `span.s-underline-text` | Less stable fallback |
| Product image | `img.s-image` | `src` attribute |
| Sponsored label | `.puis-sponsored-label-text` | Presence means the card is sponsored |
| Prime badge | `[aria-label*="Prime"]` | Presence means Prime eligible |
| Next page button | `.s-pagination-next` | For detecting if more pages exist |
| Result info bar | `[data-component-type="s-result-info-bar"]` | "1-48 of over X results" text |

### Product Detail Page Selectors

| Field | Selector | Notes |
|-------|----------|-------|
| ASIN | URL path `/dp/<ASIN>` | Regex: `/dp/([A-Z0-9]{10})` |
| Title | `#productTitle` | Strip leading/trailing whitespace |
| Price (accessibility text) | `span.a-price span.a-offscreen` | Most stable |
| Price (whole + fraction) | `span.a-price-whole` + `span.a-price-fraction` | Less stable, breaks every 4–8 weeks |
| List price | `.a-text-price .a-offscreen` | Strikethrough price |
| Rating | `#acrPopover` title attribute | "4.7 out of 5 stars" |
| Rating (alt) | `span[data-hook="rating-out-of-text"]` | Alternative selector |
| Review count | `#acrCustomerReviewText` | "12,450 ratings" |
| Availability | `#availability` | "In Stock", "Only 3 left in stock - order soon" |
| Brand | `#bylineInfo` | "Visit the X Store" link under the title |
| Brand (meta) | `meta[name="author"]` | Fallback for brand |
| Features (bullets) | `#feature-bullets .a-list-item` | Array of bullet-point strings |
| Description | `#productDescription p` | Full description text |
| Description (alt) | `#aplus .a-section` | A+ content description |
| Hero image | `#landingImage` | `src` or `data-old-hires` attribute for highest resolution |
| Image gallery | `#altImages .a-button-thumbnail img` | Array of thumbnail URLs |
| Seller (primary) | `#sellerProfileTriggerId` | Seller name link |
| Seller (fallback) | `#tabular-buybox .tabular-buybox-text a` | Alternative seller selector |
| Breadcrumb | `#wayfinding-breadcrumbs_feature_div a` | Category path |
| Product details table | `#productDetails_techSpec_section_1 tr` | Technical specs as key-value pairs |

### Category / Browse Page Selectors

| Field | Selector | Notes |
|-------|----------|-------|
| Product card | `.zg-grid-general-faceout, [data-asin]` | Grid items |
| Title | `._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, .a-size-base-plus` | May vary by page layout |
| Price | `.a-price .a-offscreen` | |
| Rating | `.a-icon-alt` | |
| Review count | `.a-size-small` | |
| Image | `img` | |
| Link | `a[href*="/dp/"]` | For extracting ASIN |

---

## Search Results Parser

The parser iterates over all `[data-component-type="s-search-result"]` elements on the page. For each card:

1. Read the `data-asin` attribute — skip if empty
2. Extract title from `h2 a span`
3. Build product URL from the ASIN: `https://www.amazon.com/dp/{ASIN}`
4. Parse the current price from `.a-price .a-offscreen` — the price parser extracts both the numeric value and the currency symbol
5. Parse rating from `span.a-icon-alt` — extract the leading number before "out of 5"
6. Parse review count from `[aria-label$="ratings"]` — extract the numeric value
7. Read image URL from `img.s-image` src
8. Check for sponsored label and Prime badge presence
9. Return an array of scraped product objects

The parser handles missing fields gracefully — if a field's selector doesn't match, that field is null/undefined rather than throwing.

## Product Detail Parser

For single product pages, the parser extracts all available fields from the product detail page. ASIN is extracted from the URL path. Features are collected as an array of bullet-point strings. The price parser handles both the accessibility text format and the whole+fraction split format with fallback logic.

## Category Page Parser

Category pages use a simpler parser since the DOM structure is less consistent. It focuses on extracting ASIN (from `data-asin` or link href), title, price, rating, and image. Fewer fields are available on category pages compared to search results.

---

## Price Parser

The price parser handles multiple Amazon price formats:

- Accessibility text: "$49.99", "€39,99", "£24.99", "¥3,980"
- Whole + fraction split: "$49" + ".99"
- With thousands separators: "$1,299.99"
- Stripped text from `.a-offscreen` elements

The parser extracts both the numeric value (as a float) and the currency symbol/code (as a string). It uses a regex to find the first number pattern in the text, handling comma and period as thousands/decimal separators based on the currency context.

---

## Deduplication Engine

The dedup engine prevents the same product from being collected twice. It uses two lookup sets:

1. **ASIN set** — primary key. Every Amazon product has a unique ASIN.
2. **URL set** — secondary key. Catches cases where the same product appears with different URL formats.

**Algorithm:**
- On initialization, load all existing products for the current session from IndexedDB into both sets
- Before accepting a new product, check if its ASIN or URL is already in the sets
- If new, add to both sets and accept the product
- If duplicate, skip and increment a duplicate counter
- The engine exposes a `size` property for the total unique count

**Performance:** Set lookups are O(1). For 1000 products, initialization is a single IndexedDB query, and each dedup check is two Set.has() calls.

---

## Auto-Scroll Controller

The scroll controller handles automatic page scrolling in "Automatic" collection mode.

### Behavior

1. Start a MutationObserver on the product container element
2. Set an interval to scroll the page by a configurable amount (default: 800px)
3. After each scroll, wait a configurable period (default: 1500ms) for new content to load
4. Count new `[data-asin]` elements in the DOM
5. If no new products appear after a configurable max wait (default: 5000ms), assume end of page
6. Check a `shouldContinue()` callback before each scroll step — returns false when target is reached
7. Add ±20% random jitter to scroll intervals to appear more human-like

### End-of-Page Detection

The controller detects the end of results through several signals:
- No new `[data-asin]` elements after `maxWaitForNew` milliseconds
- The scroll position hasn't changed after a scroll attempt (already at bottom)
- The "Next" pagination button (`.s-pagination-next`) is absent or disabled
- A "No results" or "End of results" message appears in the DOM

### Pause / Resume / Stop

- **Pause**: stops the scroll interval but keeps the MutationObserver running (so manually-scrolled products are still detected)
- **Resume**: restarts the scroll interval
- **Stop**: disconnects the MutationObserver and clears the scroll interval. Cannot be resumed — must start a new collection.

### Loading Delay Handling

When a loading spinner is detected (`.s-result-list-placeholder` or similar), the controller extends its wait time. It polls the DOM every 200ms during the wait, checking for the spinner to disappear and new products to appear, up to a maximum of 15 seconds before giving up.

---

## Content Script Main Logic

The content script orchestrates all the above components:

1. On load, detect the page type
2. Initialize the dedup engine with existing products from IndexedDB (via a message to background)
3. Parse the initial page products (the ones visible without scrolling)
4. Send the initial batch to the background via `PRODUCTS_COLLECTED` message
5. Start a MutationObserver for manual mode detection
6. Listen for commands from the background:
   - `COLLECT_PRODUCTS`: begin collection with specified mode and target
   - `PAUSE_SCROLLING`: pause the scroll controller
   - `RESUME_SCROLLING`: resume the scroll controller
   - `STOP_COLLECTION_CMD`: stop everything
7. Periodically send `COLLECTION_PROGRESS` messages with current count and status

### MutationObserver Strategy

The observer watches `document.body` with `{ childList: true, subtree: true }`. On each mutation batch:
1. Look for new elements matching the product card selector
2. For each new card, extract its `data-asin`
3. Run through the dedup engine
4. Parse and accumulate unique new products
5. After a 300ms debounce (to batch rapid mutations), send the new batch to the background

The debounce prevents flooding the message channel when Amazon loads many products at once (e.g., infinite scroll injecting 20 cards in a single DOM update).

---

## CAPTCHA / Sign-In Detection

Before each collection action and during auto-scroll, the content script checks for:

**CAPTCHA**: Elements matching `#captchacharacters` or `form[action*="validateCaptcha"]`

**Sign-in requirement**: Elements matching `#ap_email`, `#signInSubmit`, or `[data-component-type="auth-page"]`

**Access restriction**: Elements matching `#dogPage`, `#errorPage`, or `.error-code`

When any of these are detected:
- Send a `CONTENT_ERROR` message to the background with the appropriate error code
- The error code is one of: `CAPTCHA`, `SIGN_IN`, `BLOCKED`, `UNKNOWN`
- Auto-scroll pauses (not stops) — the user can resolve the issue and resume
- The side panel shows a warm, clear notice (not a harsh error banner)

---

## Messaging Protocol

All messages between extension contexts are validated with Zod schemas. Every message has a `type` field (discriminated union) and an optional `payload`.

### Messages: Side Panel → Background

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `START_COLLECTION` | `{ mode, targetCount, tabId }` | Begin collecting products |
| `PAUSE_COLLECTION` | `{ tabId }` | Pause active collection |
| `RESUME_COLLECTION` | `{ tabId }` | Resume paused collection |
| `STOP_COLLECTION` | `{ tabId }` | Stop collection entirely |
| `REQUEST_PRODUCT_COUNT` | `{ tabId }` | Get current product count |

### Messages: Background → Content Script

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `COLLECT_PRODUCTS` | `{ mode, targetCount }` | Start/continue collection |
| `PAUSE_SCROLLING` | (none) | Pause auto-scroll |
| `RESUME_SCROLLING` | (none) | Resume auto-scroll |
| `STOP_COLLECTION_CMD` | (none) | Stop everything |

### Messages: Content Script → Background

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `PRODUCTS_COLLECTED` | `{ products[], totalCount, isNewBatch }` | New products found |
| `COLLECTION_PROGRESS` | `{ collected, target, status }` | Progress update |
| `CONTENT_ERROR` | `{ code, message }` | Error detected |

### Messages: Background → Side Panel

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `UPDATE_PROGRESS` | `{ collected, target, status, error }` | Forwarded progress/status |
| `TAB_CHANGED` | `{ tabId, url, isAmazon }` | Active tab changed |

All messages are parsed through `MessageSchema.safeParse()` before processing. Invalid messages are logged and discarded.

---

## Background Service Worker: Message Router

The background service worker acts as a message hub:

1. Receives `START_COLLECTION` from side panel → stores the target tab ID → forwards `COLLECT_PRODUCTS` to the content script in that tab
2. Receives `PRODUCTS_COLLECTED` from content script → writes products to IndexedDB → sends `UPDATE_PROGRESS` to the side panel
3. Receives `CONTENT_ERROR` from content script → forwards to side panel with error info
4. Receives `PAUSE/RESUME/STOP` from side panel → forwards the corresponding command to the content script
5. Tracks which tab is the "collection tab" — if that tab closes or navigates away, notifies the side panel

The service worker does NOT store product data in memory. All state lives in IndexedDB. The worker's job is purely routing and tab management.

---

## Deliverables

At the end of Phase 2:
- Page type detector that correctly identifies search, detail, and category pages
- Centralized CSS selectors file covering all three page types
- Search results parser that extracts all available fields from product cards
- Product detail parser for single-product pages
- Category page parser for browse pages
- Price parser handling multiple Amazon formats (symbol, locale, thousands separators)
- Dedup engine that prevents duplicate products by ASIN and URL
- Auto-scroll controller with pause/resume/stop, end-of-page detection, jitter, and loading delay handling
- CAPTCHA and sign-in detection with graceful pause behavior
- Full messaging protocol with 14 message types, all Zod-validated
- Background service worker message router
- Content script that parses initial products on page load and sends them to IndexedDB