# Phase 8: Error Handling, Edge Cases & Polish

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Handle every error case gracefully, ensure the extension works reliably across Amazon's regional sites, enforce PPHunt design compliance, add accessibility features, and test edge cases. At the end of this phase, the extension is production-ready.

---

## Non-Amazon Page Handling

When the active tab is not an Amazon page, the collection panel shows a warm editorial card (not a harsh error state). The card explains what PPHunt does and which pages it works on. The Start button is disabled with hairline-soft styling.

The detection checks the URL against the 10 supported Amazon domain patterns. If the URL doesn't match any, the page is considered non-Amazon.

---

## CAPTCHA Detection

The content script checks for CAPTCHA elements on every mutation batch and before each auto-scroll step. When detected:
- Send a `CONTENT_ERROR` message with code `CAPTCHA` to the background
- The background forwards it to the side panel
- Auto-scroll pauses (not stops)
- The side panel shows: "Page requires attention — A CAPTCHA was detected. Solve it in the browser, then resume collection here."
- A "Resume Collection →" clay button lets the user continue after solving the CAPTCHA

---

## Sign-In Detection

Same flow as CAPTCHA but with code `SIGN_IN`. Elements checked: `#ap_email`, `#signInSubmit`, `[data-component-type="auth-page"]`.

---

## Access Restriction Detection

Elements checked: `#dogPage`, `#errorPage`, `.error-code`. These indicate the page is blocked or unavailable. Code: `BLOCKED`.

---

## Loading Delay Handling

When auto-scrolling, the scroll controller extends its wait time when loading indicators are present. Polls the DOM every 200ms during the wait, checking for spinners to disappear and new products to appear, up to a maximum of 15 seconds before giving up and moving on.

---

## Missing Fields Handling

Products with missing fields are still collected and stored. In the preview table, missing fields show "—" in hairline color. Missing fields are NOT counted as errors — they're expected (e.g., sponsored items may lack ratings, some products don't have brand info).

---

## Tab Closed During Collection

If the user closes the Amazon tab during collection:
1. Background detects `tabs.onRemoved` for the collection tab
2. Marks the session as `interrupted`
3. Notifies side panel with a quiet inline notice: "Tab closed — X products were saved."
4. Products remain in IndexedDB, accessible from the Preview tab

---

## Content Script Injection Failure

If the content script fails to inject (CSP restrictions, about:blank, etc.):
1. Background catches the error from `browser.scripting.executeScript`
2. Notifies side panel: "Could not access the page — The browser blocked PPHunt from running on this page."
3. Does not crash — the user can try navigating to a different Amazon page

---

## Rate Limiting & Polite Scraping

For automatic mode, the defaults are deliberately conservative:
- Scroll interval: 500ms (configurable 200ms–5000ms)
- Wait after scroll: 1500ms (configurable 500ms–10000ms)
- No concurrent page fetches
- Random jitter (±20%) on scroll intervals to appear more human-like
- No rapid-fire DOM queries — the MutationObserver approach is passive

---

## Manifest V3 Compliance

- Service worker does NOT store state in memory (uses IndexedDB exclusively)
- All persistent state in IndexedDB or chrome.storage
- Minimum permissions: `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`
- `host_permissions` limited to Amazon domains only
- No remote code execution
- No `eval()` or `new Function()`
- No web-accessible resources beyond what's necessary

---

## Accessibility

- All interactive elements are keyboard-navigable (Tab, Enter, Escape, Arrow keys)
- ARIA labels on buttons, progress bars, status indicators, and form inputs
- Focus management: when switching tabs in the side panel, focus moves to the tab content
- Color is never the sole indicator — icons, text, or patterns always accompany color
- Keyboard shortcuts: Escape closes the settings overlay
- Screen reader support: table rows announce their content, progress bar announces percentage

---

## Toast / Notification Pattern (PPHunt Style)

Toasts are quiet inline notices at the bottom of the side panel:

- A `surface-card` card with 8px radius and 1px hairline border
- A colored dot (moss for success, clay for attention) + serif 13px text
- A secondary serif 12px hairline line for the detail message
- Auto-dismiss after 5 seconds, or click to dismiss
- Maximum 2 toasts visible at once (newest at bottom)
- No colored background strips, no green/red/yellow banners
- The dot color does the semantic work

Examples:
- "● 67 products collected — Ready to preview or export."
- "● Page requires attention — A CAPTCHA was detected."
- "● Tab closed — 42 products were saved."
- "● Exported — 67 products saved as pphunt-export-2026-10-14.csv"
- "● Clipboard access denied — Check browser permissions."
- "● Nothing to export — No products match the current selection."

---

## Design System Compliance Checklist

Before shipping, every screen must pass this checklist:

### Colors
- [ ] No `#ffffff` (pure white) as a background — always `#faf9f5` or `#f0eee6`
- [ ] No cool grays (`gray-500`, `slate-*`) — use `hairline` (#b0aea5) and `hairline-soft` (#e8e6dc)
- [ ] No saturated blues/greens as backgrounds — `sky` and `moss` are for dots and text only
- [ ] Clay (#d97757) appears only on the primary CTA — never on decorative elements

### Typography
- [ ] Body text is `font-serif` (Lora) — `font-sans` (Poppins) is for UI chrome only
- [ ] Headings use Poppins 600 for section titles, Lora 400 for body descriptions
- [ ] Code/metadata uses JetBrains Mono

### Surfaces
- [ ] No `box-shadow` on any element — depth via surface tones and 1px borders
- [ ] All surfaces are flat solid fills — no gradients, no glows, no color washes
- [ ] Borders are 1px hairline, never 2px+

### Components
- [ ] All links are underlined — persistent, not reveal-on-hover
- [ ] Buttons use 8px bottom-radius (the PPHunt signature) — never pill/rounded-full
- [ ] Inputs use 1px hairline border, 8px radius, no shadow — focus changes border to ink
- [ ] Status indicators are colored dots + serif labels — no emoji, no colored badges

### Spacing
- [ ] All padding and margins use the 4px scale: 4, 8, 12, 16, 20, 24, 32, 48, 64
- [ ] Cards use 16px or 24px padding depending on size
- [ ] List items use 8px or 12px gaps

---

## Testing Strategy

### Unit Tests

- **Selectors**: verify each CSS selector matches expected elements in fixture HTML
- **Parsers**: verify search results, product detail, and category parsers extract correct data from fixtures
- **Dedup**: verify new/duplicate detection with various ASIN and URL combinations
- **Price parser**: verify handling of $, €, £, ¥, comma/period separators
- **Amazon URL**: verify ASIN extraction from all URL formats (/dp/, /gp/product/, with query params)
- **Export CSV**: verify correct escaping, BOM, encoding
- **Message schemas**: verify Zod validation of all 14 message types (valid and invalid inputs)

### Fixtures

Saved Amazon HTML pages for deterministic testing:
- `search-results.html` — a search results page with 20+ products, including sponsored and Prime items
- `product-detail.html` — a product detail page with all fields present
- `category-page.html` — a category/browse page with grid layout

### Integration Testing

- Side panel opens on icon click
- Content script injects on Amazon pages and not on non-Amazon pages
- Start collection → products appear in IndexedDB → progress updates in side panel
- Pause/resume/stop controls work correctly
- Settings changes persist across side panel close/reopen
- Export generates valid CSV/Excel files

---

## Deliverables

At the end of Phase 8:
- Non-Amazon page detection with warm editorial guidance
- CAPTCHA, sign-in, and access restriction detection with pause behavior
- Loading delay handling with configurable timeouts
- Tab close and content script failure graceful handling
- Rate limiting with jitter for polite scraping
- Manifest V3 compliance verified
- Accessibility: keyboard navigation, ARIA labels, focus management, screen reader support
- PPHunt design compliance checklist passed
- Toast notification system (PPHunt style)
- Unit tests for selectors, parsers, dedup, price parser, URL extraction, CSV export, message schemas
- HTML fixtures for deterministic parser testing
- Integration test scenarios