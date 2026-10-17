# PPHunt — Architecture & System Overview

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## What PPHunt Is

PPHunt is a Chrome Extension that scrapes Amazon product data from search results, product detail, and category pages. It presents a side panel UI where users set collection targets, watch products accumulate in real time, preview them in a spreadsheet-style table, and export as CSV, Excel, or clipboard copy. All data stays local — IndexedDB via Dexie.js, nothing leaves the browser.

---

## High-Level Architecture

The extension has three execution contexts that communicate via Chrome's runtime messaging:

**Side Panel (React UI)**
The main interface. A persistent Chrome side panel that survives tab switches. Contains four screens: Collection controls, Preview table, History, and Settings overlay. Reads and writes product data to IndexedDB via Dexie.js with reactive live queries.

**Background Service Worker**
A lightweight message router. Receives commands from the side panel and forwards them to the correct content script tab. Receives scraped data from content scripts and persists it to IndexedDB. Manages tab tracking — knows which Amazon tab is active, detects when tabs close or navigate away. Opens the side panel on extension icon click.

**Content Script (Amazon pages only)**
Injected into Amazon pages. Parses the DOM for product cards, extracts fields, deduplicates by ASIN, and sends batches to the background. In manual mode, runs a MutationObserver to detect new products as the user scrolls. In automatic mode, also runs a scroll controller that scrolls the page, waits for new content, and stops when the target is reached or the page is exhausted.

### Data Flow

```
Side Panel  ──(START_COLLECTION)──►  Background  ──(COLLECT_PRODUCTS)──►  Content Script
                                                                              │
                                                                              │ parse DOM
                                                                              │ deduplicate
                                                                              │
Side Panel  ◄──(UPDATE_PROGRESS)──── Background  ◄──(PRODUCTS_COLLECTED)─────┘
```

The side panel never talks to content scripts directly. The background is always the intermediary. This keeps the architecture clean and makes tab management straightforward.

### Storage Architecture

IndexedDB via Dexie.js is the single source of truth. Four tables:

| Table | Purpose | Key |
|-------|---------|-----|
| `products` | All scraped products across all sessions | Auto-increment `id`, indexed on `asin`, `sessionKey`, `[sessionKey+asin]` |
| `sessions` | Active and historical collection sessions | `id` (string: `{tabId}_{timestamp}`) |
| `settings` | User preferences | `id` (always `'default'`) |
| `history` | Summary records of completed/interrupted sessions | Auto-increment `id` |

The side panel uses Dexie's `useLiveQuery` hook — when the background writes new products to IndexedDB, the side panel's product count and preview table update automatically without polling.

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Extension framework | WXT + Vite | File-based entrypoints, auto-manifest, HMR, React module |
| Language | TypeScript (strict mode) | Type safety across all three execution contexts |
| UI | React 18+ | Component model for side panel, hooks for state |
| Styling | Tailwind CSS with PPHunt design tokens | Utility-first, works in side panel without host-page conflicts |
| State management | Zustand | Minimal boilerplate, good for side panel UI state |
| Storage | IndexedDB via Dexie.js | Persistent, structured, reactive (useLiveQuery), large capacity |
| Validation | Zod | Runtime validation for all messages and settings |
| Table | @tanstack/react-table + @tanstack/react-virtual | Headless, fully controllable, virtualized for 300+ rows |
| Export | SheetJS (xlsx) + file-saver | Excel generation and file download |
| Build | Vite (via WXT) | Fast bundling, HMR during dev |

---

## Chrome Extension Permissions

| Permission | Why |
|-----------|-----|
| `sidePanel` | Display the side panel UI |
| `activeTab` | Access the current tab when user interacts |
| `tabs` | Track tab changes, detect Amazon pages, route messages |
| `storage` | Minimal usage alongside IndexedDB (extension prefs) |
| `scripting` | Inject content scripts programmatically when needed |

Host permissions are limited to Amazon domains only:
- `*://*.amazon.com/*`, `*://*.amazon.co.uk/*`, `*://*.amazon.de/*`
- `*://*.amazon.fr/*`, `*://*.amazon.ca/*`, `*://*.amazon.co.jp/*`
- `*://*.amazon.in/*`, `*://*.amazon.com.au/*`
- `*://*.amazon.es/*`, `*://*.amazon.it/*`

---

## Design System: PPHunt Design System

PPHunt follows PPHunt Design System — warm, editorial, paper-like. The system reads like a curated research publication on warm parchment paper, not a generic tech tool.

### Core Principles

- Ivory/oat/clay earth tones only — no cool grays, no saturated blues
- Flat surfaces — no box-shadow; depth via surface tone and 1px borders
- Serif body voice — Lora at 14px for body copy carries the editorial personality
- Sans UI chrome — Poppins at 12–14px for buttons, labels, navigation
- Bottom-only 8px radius on filled buttons (signature PPHunt treatment)
- 12px radius on inputs, 16px on cards/containers
- Pure white (#ffffff) never used as a surface — always warm ivory
- Accent color (Clay #d97757) reserved exclusively for primary CTA — never decoration
- Underlined links — editorial print convention, persistent (not reveal-on-hover)
- 1px hairline borders (#b0aea5 or #e8e6dc) for separation — no shadows

### Color Palette

| Token | Hex | Role |
|-------|-----|------|
| `ink` | `#141413` | Primary text, dark backgrounds |
| `canvas` | `#f0eee6` | Page background (the floor) |
| `surface` | `#faf9f5` | Cards, elevated surfaces |
| `surface-card` | `#efe9de` | Feature cards, content cards |
| `surface-soft` | `#f5f0e8` | Section dividers, soft bands |
| `hairline` | `#b0aea5` | Borders, secondary text, placeholders |
| `hairline-soft` | `#e8e6dc` | Subtle borders, inactive indicators |
| `clay` | `#d97757` | Primary accent — CTAs only |
| `clay-active` | `#b85a3e` | Clay hover/press state |
| `sky` | `#6a9bcc` | Secondary accent — info, links |
| `moss` | `#788c5d` | Tertiary accent — success states |

### Typography

| Role | Font | Fallback | Weight | Size |
|------|------|----------|--------|------|
| Body / Display serif | Lora | Georgia, Source Serif Pro | 400, 600 | 14–18px |
| UI Chrome | Poppins | Inter, system-ui, Arial | 400, 500, 600 | 12–16px |
| Code / Mono | JetBrains Mono | ui-monospace, Menlo | 400 | 13px |

Fonts loaded via Google Fonts in the side panel HTML. Fallback chain handles offline/missing fonts gracefully.

### Spacing & Radius

- **Spacing scale (4px base):** 4, 8, 12, 16, 20, 24, 32, 48, 64
- **Border radius:** 8px (buttons, inputs), 12px (small cards), 16px (containers), 24px (large cards)
- **No box-shadow tokens** — depth communicated through surface tone transitions and 1px borders

### Visual Rules

- No `#ffffff` (pure white) as a background — always `#faf9f5` or `#f0eee6`
- No cool grays (`gray-*`, `slate-*`) — use `hairline` and `hairline-soft`
- No saturated blues/greens as backgrounds — `sky` and `moss` are for dots and text only
- Clay appears only on the primary CTA — never on decorative elements
- Body text is serif (Lora) — sans (Poppins) is for UI chrome only
- All links are underlined — persistent, not reveal-on-hover
- All surfaces are flat solid fills — no gradients, no glows, no color washes

---

## Project Structure (src/ layout)

All source code lives under `src/` with `srcDir: 'src'` in WXT config.

### Entrypoints (`src/entrypoints/`)

| File / Directory | WXT Role | Purpose |
|-----------------|----------|---------|
| `background.ts` | Service worker | Message routing, tab tracking, panel open |
| `sidepanel/index.html` | Side panel HTML shell | Google Fonts links, React mount point |
| `sidepanel/main.tsx` | Side panel React entry | Mounts `<App />` with StrictMode |
| `sidepanel/App.tsx` | Root component | Tab routing (Collect / Preview / History) |
| `sidepanel/global.css` | Global styles | Tailwind base, PPHunt body styles, scrollbar |
| `amazon.content.ts` | Content script | DOM scraping, auto-scroll, MutationObserver |

### Side Panel Components (`src/entrypoints/sidepanel/components/`)

| Directory | Components | Purpose |
|-----------|-----------|---------|
| `layout/` | Header, TabBar, StatusBar | Shell chrome, tab navigation, info banners |
| `collection/` | CollectionPanel, ModeSelector, TargetSelector, ControlButtons, ProgressDisplay, CollectionStatus, NotificationToast | Main collection screen |
| `preview/` | PreviewPanel, ProductTable, TableToolbar, TableRow, MissingFieldsBadge, DuplicateBadge, ColumnSelector | Spreadsheet-style data preview |
| `settings/` | SettingsPanel, GeneralSettings, ScrollSettings, FieldToggles, NotificationSettings, DangerZone | Settings overlay |
| `shared/` | Button, Badge, ProgressBar, Toggle, Select, Input, Modal, Tooltip, StatusDot, Tab, EmptyState | Reusable PPHunt-styled primitives |

### Hooks (`src/entrypoints/sidepanel/hooks/`)

| Hook | Purpose |
|------|---------|
| `useCollection` | Collection state machine, start/pause/resume/stop controls |
| `useProducts` | Product data via Dexie useLiveQuery, real-time counts |
| `useSettings` | Settings read/write, Zod-validated |
| `useActiveTab` | Track which tab is open, detect Amazon pages |
| `useExport` | Export to CSV/Excel/clipboard with status |
| `useNotifications` | Toast notification management |

### Stores (`src/entrypoints/sidepanel/store/`)

| Store | Purpose |
|-------|---------|
| `collectionStore` | Collection mode, status, target, counts, error state |
| `uiStore` | Active tab (Collect/Preview/History), settings overlay open |

### Shared Library (`src/lib/`)

| Directory | Files | Purpose |
|-----------|-------|---------|
| `db/` | database, products, sessions, settings, history | Dexie database definition and CRUD |
| `schemas/` | product, settings, session, messages | Zod schemas for validation |
| `messaging/` | types, sender, handler | Typed Chrome message passing |
| `scraper/` | types, selectors, search-results, product-detail, category-page, page-detector, dedup, scroll-controller | Amazon DOM scraping |
| `utils/` | export-csv, export-xlsx, export-clipboard, file-saver, price-parser, amazon-url, notifications | Utility functions |

### Types (`src/types/`)

| File | Contents |
|------|----------|
| `product.ts` | Product interface (all fields) |
| `settings.ts` | AppSettings interface |
| `session.ts` | SessionState, CollectionStatus, CollectionMode |
| `common.ts` | Shared utility types |

### Constants (`src/constants/`)

| File | Contents |
|------|----------|
| `amazon-patterns.ts` | Amazon URL regex patterns, versioned selector keys |
| `defaults.ts` | Default settings values |
| `limits.ts` | Min/max values, rate limits, caps |

### Assets (`src/assets/`)

Extension icons in Clay (#d97757) on transparent background. Logo wordmark in Poppins 600, clay.

### Tests (`tests/`)

| Directory | Contents |
|-----------|----------|
| `unit/scraper/` | Selector tests, parser tests, dedup tests |
| `unit/utils/` | Price parser, URL extraction, CSV export tests |
| `unit/schemas/` | Message schema validation tests |
| `fixtures/` | Saved Amazon HTML pages for deterministic testing |

---

## Implementation Phases Overview

| Phase | Focus | Key Deliverables |
|-------|-------|-----------------|
| 1 | Scaffolding | WXT project, Dexie DB, Zod schemas, Zustand stores, Tailwind (PPHunt tokens), Google Fonts, global.css, all entrypoints bootstrapped |
| 2 | Content Script | Page detection, CSS selectors, search/detail parsers, dedup engine, scroll controller, messaging |
| 3 | Side Panel UI | Collection panel, mode/target selectors, controls, progress bar, status indicators, tab detection |
| 4 | Preview Table | @tanstack/react-table + react-virtual, column selection, search, sort, row selection, missing fields, duplicate badges |
| 5 | Export | CSV, Excel, clipboard export, column selection, filename customization |
| 6 | Settings | Settings overlay, field toggles, scroll config, restore defaults, persistence |
| 7 | Persistence | Session recovery, tab reload handling, history, cross-tab awareness |
| 8 | Polish | Error handling, CAPTCHA detection, accessibility, edge cases, design compliance checklist, testing |

Each phase is detailed in its own spec file in this directory.