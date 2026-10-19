# Changelog

All notable changes to PPHunt will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — One-click product saving (SAD-141)

Save a single Amazon product into History without leaving the page.

### Changed
- **The per-card save button now reads as PPHunt at rest** (SAD-329). It was a
  near-white chip with a 1.125 px grey stroke, a 1.51:1 hairline border and no
  brand colour until hover — on a listing page it read as a small dark smudge.
  It is now a solid clay control with a cream 18 px glyph at a 2 px stroke
  (1.5 CSS px), a fill per state (clay → moss → crimson), an inset focus ring
  that stays visible on the fill, and a haloed badge for partial enrichment.
  Every glyph/state pair passes WCAG AA (5.01:1 to 7.26:1). Behaviour is
  unchanged: same six states, click-safety, mounting, tooltips and labels.

### Added
- **Right-click → "Save Product Details"** on any Amazon listing or product page.
  The item is registered from one shared marketplace list, is re-registered on
  install/startup, and never removes the native menu items.
- **A per-card save button** (idle → queued → extracting → enriching →
  completed, or failed with retry), mounted through a single `IntersectionObserver`
  so a virtualised or re-rendered listing cannot produce duplicate buttons, and
  clicks never activate the card's link.
- **One shared pipeline** for both entries: identity → job → listing extract →
  background PDP enrichment (no tab is opened or switched to) → History →
  collection behaviour → CSV/XLSX → notification.
- **Right-Click Save Behavior** setting: *Add to Current* (default), *New
  Collection per product*, *Ask Every Time*. Cancelling the dialog keeps the
  product in the collection it was already saved to.
- **A `snapshots` store** (database v2) recording each observed price/availability
  with its source (`listing` / `detail`) and job id, so history is never rewritten.
- **Background PDP enrichment** with a bounded concurrency of 2, a per-marketplace
  circuit breaker and a typed outcome (`complete` / `partial` / `failed` / `skipped`).
- **MV3 worker recovery**: jobs are mirrored into `storage.session` and resumed at
  most once after a suspension; a job that dies twice is reported `interrupted`
  rather than leaving a card spinning.
- **CSV/XLSX export** of a one-click collection, built in the offscreen document
  through the same writers the panel uses, plus a **Download** action on the
  completion toast and an opt-in `quickSaveAutoDownload` setting (default off).

### Fixed
- `amazon.co.za` was missing from the content-script match patterns, so the
  extension did not load there at all.
- 12 supported marketplaces had no `host_permissions` entry (the manifest only
  covered 10), which broke background fetches on those domains. Both lists are
  now derived from `AMAZON_MARKETPLACE_DOMAINS`.

### Notes
- **Browser verification for SAD-141 is still pending** (tracked as SAD-293). The
  behaviour above is covered by unit/integration tests, not by a real Chrome run.
- Product fulfilment is not modelled (`delivery`, `seller` and `isPrime` are), so
  no `fulfillment` export column is produced.
- Clipboard export remains panel-only: an unfocused worker cannot write the
  clipboard, so the quick-save path refuses that format explicitly.
- The `downloads` permission adds Chrome's "Manage your downloads" install
  warning; the no-permission alternative is not verified yet (D10).

## [Unreleased] — Remediation 2026-10 (Phases 0–10)

Hardening & reliability pass over the whole extension (59 tracked issues, including phase parents).
User-visible changes:

### Fixed
- **Currency values were wrong on eurozone and Japanese storefronts (and any
  non-USD domain).** The stored `currency` field used to hold a URL instead of
  an ISO code, and prices rendered with hardcoded US formatting. **Action for
  existing users (decision D7):** rows collected before this update may carry a
  URL in `currency` — they are not auto-migrated. Re-collect the affected
  sessions (or re-export after re-collection) to get correct prices; the
  corrupted value shows up as a URL in the Currency column, so affected rows
  are easy to spot.
- **Settings now actually take effect** — every setting is consumed by the
  code paths it describes (scroll behavior, field toggles, export defaults).
- Prices render in their own locale: `1.299,00 €` on amazon.de, `￥3,980` on
  amazon.co.jp (no fake decimals), lakh grouping for INR.
- Worker termination can recover the active-session pointer from session storage.
  Browser-startup reconciliation marks leftover collecting sessions **Interrupted**;
  tab-close handling records interruption rather than leaving a stale collection.
- Row numbers (`#`) stay correct and gap-free under sort, filter and delete,
  and cost O(1) per cell instead of a full table scan.

### Changed
- Destructive actions (delete history, clear all, delete selected, restore
  defaults) now use a themed in-panel confirm dialog with proper focus
  handling instead of the blocking browser `confirm()`.
- All modals trap focus, close on Escape, and return focus to the element
  that opened them.
- XLSX auto image mode embeds only for exports of at most 200 products, with
  25 MiB fetched-image and 20-second image-fetch budgets. Always mode bypasses
  these auto limits. Missing/skipped images retain URL text; these limits do not
  bound total workbook-generation time or final file size.
- Excel engine moved to a patched SheetJS 0.20.3 (advisory-free; the npm
  registry's 0.18.5 carries unfixable advisories).
- Target count is clamped to 1–1000 everywhere (input, store, database,
  message schemas).
- Notifications are in-panel toasts only — the optional browser
  `notifications` permission was deliberately not added (notifications scope decision).

### Security
- Overlay iframe pinned to the extension origin with a strict message-origin
  allowlist (M-4); CSP tightened; remote fonts kept but fully disclosed
  (decision D2); production-dependency audit is a blocking CI gate.

## [1.0.0] — 2026-10-15

> Historical development record, not a verified release checklist. Original
> feature descriptions below may have been superseded by the remediation entry
> above and current README/ARCHITECTURE; manual release validation was skipped.

### Added

#### Phase 1: Project Scaffolding & Core Infrastructure
- WXT project with React 19 + TypeScript
- Tailwind CSS with full PPHunt design tokens (11 colors, 3 font families)
- Dexie.js database with 4 typed tables (products, sessions, settings, history)
- Zod schemas for Product (15+ fields), Settings (13 settings), Messages (14-type discriminated union)
- Zustand stores: collectionStore and uiStore
- TypeScript types for Product, Session, Settings, Common
- Background service worker with `setPanelBehavior`
- Content script matching 10 Amazon domains at `document_idle`
- Side panel with full PPHunt-styled UI shell

#### Phase 2: Content Script & Scraping Engine
- Page type detector (search, product detail, category, bestsellers)
- Centralized CSS selectors for 3 Amazon page types
- Search results parser (ASIN, title, price, rating, reviews, image, sponsored, prime)
- Product detail parser (15+ fields including features, seller, brand)
- Category page parser for browse/bestsellers layouts
- Deduplication engine with Set-based ASIN + URL lookup (O(1))
- Auto-scroll controller with ±20% jitter and end-of-page detection
- CAPTCHA/sign-in/blocked page detection
- Price parser handling $, €, £, ¥, thousands separators, whole+fraction
- ASIN extraction from all Amazon URL formats
- Full message protocol between content script and background

#### Phase 3: Side Panel UI — Collection Interface
- Header with logo and settings gear
- Navigation tabs (Collect | History) with clay active underline — a dedicated Preview tab was removed pre-release (SAD-136); the virtualized table lives on the Collect tab and History entries carry per-session Preview/Export
- Collection mode toggle (Manual / Automatic)
- Target selector with quick-select chips (50/100/200/300) and custom input (1–1000)
- Status bar with animated color dots (5 states)
- Live counter with percentage display
- Progress bar with clay gradient
- Collection controls (Start / Pause / Resume / Stop)
- Amazon page warning banner
- Error modal with Retry / Resume / Dismiss
- Settings overlay (slide-in from right)
- Empty states for Collections, Products, and History tabs
- Utility: formatNumber, formatCurrency, formatPercent, pluralize, truncate

#### Phase 4: Preview Table with Virtual Scrolling
- 24 default columns (checkbox, row number, image, title, ASIN, price, list price, discount, deal, currency, rating, reviews, BSR, monthly sales, coupon, badge, delivery, brand, seller, availability, sponsored, prime, source, collected-at) driven by the settings field toggles
- TanStack Table v9 integration with sorting, filtering, column resizing
- Row virtualization via @tanstack/react-virtual (52px rows, 10x overscan)
- Row selection with select all / deselect / delete selected
- Global search filter with icon and clear button
- Live updates via Dexie useLiveQuery

#### Phase 5: Export System
- CSV export with proper escaping and UTF-8 BOM for Excel compatibility
- Excel export via SheetJS with bold headers and auto-sized columns
- Clipboard copy as TSV (tab-separated values)
- Export scope: all products, selected rows, or filtered results
- Custom filename with date-based default
- Export modal with format selector, scope selector, filename input
- Toast notifications for success and error cases
- useExport hook with isExporting state and 5s auto-dismiss

#### Phase 6: Settings UI
- Full settings panel with 7 sections: UI Mode, General, Automatic Scrolling, Data Fields, Behavior, Export Defaults, Danger Zone
- UI Mode toggle: Side Panel / Page Overlay with chrome.storage.local persistence
- Overlay width slider (300–800px)
- General settings: default mode toggle, default target count input
- Automatic scrolling: 3 range sliders (speed, interval, wait)
- Data fields: 15-field checkbox grid with 2-column layout
- Behavior toggles: duplicate detection, notifications
- Export defaults: format dropdown, filename input, UTF-8 BOM toggle
- Restore defaults with confirmation dialog
- Auto-save on change (debounced 500ms)
- 200ms slide-in animation

#### Phase 7: Session Persistence & Recovery
- Session recovery on side panel mount: checks IndexedDB for active sessions
- Tab existence verification via `browser.tabs.get`
- Collection state restoration or interruption notice
- Session creation on collection start
- Session status updates on pause/resume
- History entry written on collection stop
- History tab with live data from IndexedDB
- History entry cards with status, count, mode, dates, View Products + Delete
- Clear all history with confirmation

#### Phase 8: Error Handling, Accessibility & Polish
- Toast notification system (Zustand store, max 2, 5s auto-dismiss)
- Context-aware error modal (detects CAPTCHA, sign-in, blocked)
- Targeted guidance messages for each error type
- Resume button for CAPTCHA and sign-in errors
- ARIA attributes: role=status, role=progressbar, role=tab, role=dialog
- Keyboard navigation: Arrow Left/Right for tabs, Escape to close
- Roving tabindex pattern for tab navigation
- Focus management utilities (trapFocus for modals)

#### Phase 9: Dual-Mode UI System
- Popup chooser: Side Panel / Page Overlay with "Remember my choice"
- Overlay drawer: floating panel over the page, slides from right, user-resizable
- Floating trigger button: 40×48px, ink background, clay hover, chevron rotation
- Mode preference system: chrome.storage.local sync, background behavior toggle
- Settings UI Mode toggle wired to storage
- Both modes render the same React app sharing IndexedDB

### Dependencies

**Runtime:**
- react, react-dom (19.x)
- @tanstack/react-table (9.x)
- @tanstack/react-virtual
- dexie, dexie-react-hooks
- zustand
- zod
- xlsx (SheetJS)
- file-saver

**Development:**
- wxt (0.21.x)
- tailwindcss (3.x)
- postcss, autoprefixer
- typescript

[1.0.0]: https://github.com/258044aamm-Dev/PPHunt/releases/tag/v1.0.0