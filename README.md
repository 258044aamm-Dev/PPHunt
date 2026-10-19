# PPHunt

**Amazon Product Scraper Chrome Extension** — Collect, preview, and export Amazon product data with care.

Built with PPHunt Design System: warm earth tones, Lora/Poppins typography, flat surfaces, clay accent CTAs.

---

## What is PPHunt?

PPHunt is a Chrome extension that scrapes product data from Amazon search results, product detail, and category pages. It collects titles, prices, ratings, reviews, images, and more — then lets you preview, filter, sort, and export the data as CSV, Excel, or clipboard.

What makes PPHunt different:

- **Dual-mode UI** — Use it as a Chrome Side Panel (persistent across tabs) or as a floating overlay drawer on the page itself
- **PPHunt Design System** — No harsh error states, no garish colors. Warm canvas backgrounds, serif headings, clay CTAs, colored dots for status
- **Local-first** — All product data is scraped, stored and processed on your machine. Nothing is uploaded to any PPHunt server, and there is no analytics or telemetry. Two categories of network request do occur: (1) requests to Amazon and its image CDNs (`media-amazon.com`, `ssl-images-amazon.com`) to fetch the pages you are viewing and the product thumbnails used in exports; (2) requests to Google Fonts to load the Lora, Poppins and JetBrains Mono typefaces used by the panel, popup and overlay UI. To disable Google Fonts requests, block `fonts.googleapis.com` and `fonts.gstatic.com` — the interface falls back to Georgia, system-ui and ui-monospace
- **Smart scraping** — Deduplication, CAPTCHA detection, auto-scroll with human-like jitter, session persistence across tab reloads

## Features

- **Scrape** products from Amazon search, product detail, and category/browse pages (10 regional domains)
- **Two collection modes** — Manual (passive, collects as you scroll) and Automatic (auto-scroll with configurable speed)
- **Preview table** — Virtualized table with sorting, column resizing, row selection, and global search filter
- **Export** — CSV (with UTF-8 BOM), Excel (.xlsx with auto-sized columns and optional embedded product images; auto mode has image-fetch budgets, while always mode bypasses those auto limits), or copy to clipboard (TSV)
- **Export scope** — All products, selected rows, or filtered results
- **Settings** — Default mode, target count, scroll behavior, 23 data-field toggles, export defaults, duplicate detection
- **Session persistence** — Products survive side panel close/reopen, tab reload, and browser restart
- **History** — Past collection sessions with timestamps, product counts, and status
- **Error handling** — CAPTCHA/sign-in detection with guided recovery, toast notifications
- **Accessibility** — ARIA labels, keyboard navigation, modal focus traps (focus moves in on open, Tab wraps, Escape closes, focus returns to the trigger), promise-based confirm dialogs instead of blocking `window.confirm`

Chrome is the supported browser target. A Firefox build succeeds, but Firefox runtime compatibility is unverified.

## Quick Start

### Install from source

```bash
# Clone the repository
git clone https://github.com/258044aamm-Dev/PPHunt.git
cd PPHunt

# Use Node.js 22 or later, then install locked dependencies
npm ci

# Build the extension
npx wxt build

# Load in Chrome:
# 1. Open chrome://extensions
# 2. Enable "Developer mode" (top right)
# 3. Click "Load unpacked"
# 4. Select the dist/chrome-mv3 folder
```

### Development mode

```bash
# Start the dev server with hot reload
npx wxt dev
```

## Usage

1. **Navigate** to any Amazon page (search results, product page, or category)
2. **Click** the PPHunt extension icon in the toolbar
3. **Choose** Side Panel or Page Overlay (enable “Remember my choice” to save the selection)
4. **Set your target** — quick-select chips (50/100/200/300) or custom input (1–1000)
5. **Choose mode** — Manual (scroll yourself) or Automatic (auto-scroll)
6. **Click Start** — products are collected as they appear on the page
7. **Preview** — collected products appear in the virtualized table on the Collect tab (History keeps past sessions, each with its own Preview/Export)
8. **Export** — click Export to download as CSV, Excel, or copy to clipboard

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser Tab                       │
│  ┌───────────────────────────────────────────────┐  │
│  │  Content Script (amazon.content.ts)           │  │
│  │  ┌─────────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ Page        │ │ Parser   │ │ Dedup     │  │  │
│  │  │ Detector    │ │ Engine   │ │ Engine    │  │  │
│  │  └─────────────┘ └──────────┘ └───────────┘  │  │
│  │  ┌─────────────┐ ┌──────────┐                 │  │
│  │  │ Scroll      │ │ CAPTCHA  │                 │  │
│  │  │ Controller  │ │ Detector │                 │  │
│  │  └─────────────┘ └──────────┘                 │  │
│  └───────────────────────┬───────────────────────┘  │
│                          │ Messages                  │
│  ┌───────────────────────▼───────────────────────┐  │
│  │  Background Service Worker (background.ts)    │  │
│  │  ┌──────────────┐ ┌────────────────────────┐  │  │
│  │  │ Message      │ │ Tab Tracking           │  │  │
│  │  │ Router       │ │ Mode Preference        │  │  │
│  │  └──────────────┘ └────────────────────────┘  │  │
│  └───────────────────────┬───────────────────────┘  │
│                          │                           │
│  ┌───────────────────────▼───────────────────────┐  │
│  │  IndexedDB (Dexie)                            │  │
│  │  products │ sessions │ settings │ history     │  │
│  └───────────────────────┬───────────────────────┘  │
│                          │                           │
│  ┌───────────┐  ┌───────▼───────┐  ┌────────────┐  │
│  │  Popup    │  │  Side Panel   │  │  Overlay   │  │
│  │  Chooser  │  │  (React App)  │  │  (iframe   │  │
│  │           │  │               │  │ in closed  │  │
│  │           │  │               │  │ shadow rt) │  │
│  └───────────┘  └───────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Data Flow

```
Amazon DOM → Content Script Parser → Message (Zod-validated)
→ Background Service Worker → IndexedDB (Dexie)
→ Side Panel / Overlay (useLiveQuery) → React UI
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | [WXT](https://wxt.dev) | Chrome extension framework (MV3) |
| UI | React 19 + TypeScript | Component library |
| Styling | Tailwind CSS 3 | Utility-first CSS with PPHunt design tokens |
| Table | [TanStack Table v9](https://tanstack.com/table) + [react-virtual](https://tanstack.com/virtual) | Virtualized product table |
| Database | [Dexie.js](https://dexie.org) | IndexedDB wrapper with reactive queries |
| State | [Zustand](https://github.com/pmndrs/zustand) | Lightweight state management |
| Validation | [Zod](https://zod.dev) | Runtime schema validation |
| Export | [SheetJS](https://sheetjs.com) + [file-saver](https://github.com/nickersoft/FileSaver.js) | Excel + file download |

## Project Structure

```
src/
├── entrypoints/
│   ├── background.ts              # Service worker: message router, tab tracking
│   ├── amazon.content.ts          # Content script: scraping engine
│   ├── popup/
│   │   └── index.html             # Mode chooser popup
│   └── sidepanel/
│       ├── index.html             # Side panel HTML shell
│       ├── main.tsx               # React entrypoint
│       ├── App.tsx                # Main app shell
│       ├── global.css             # Tailwind imports + base styles
│       ├── components/            # 20+ UI components
│       ├── table/                 # Virtualized product table
│       ├── hooks/                 # useExport, useSettings, useSessionRecovery
│       └── store/                 # Zustand stores (collection + UI)
├── lib/
│   ├── db/                        # Dexie database + CRUD modules
│   ├── schemas/                   # Zod schemas (Product, Settings, Messages)
│   ├── scraper/                   # Page detection, parsers, dedup, scroll
│   ├── export/                    # CSV, Excel, clipboard engines
│   └── utils/                     # Price parser, URL parser, formatters, a11y
├── types/                         # TypeScript interfaces
└── constants/                     # Default values, limits
```

## Permissions

| Permission | Why |
|-----------|-----|
| `sidePanel` | Chrome Side Panel API for the main UI |
| `activeTab` | Access the current tab when the user clicks the icon |
| `tabs` | Track tab events, detect Amazon pages, send messages |
| `storage` | Persist user preferences (UI mode, overlay width) and the one-click collection pointer |
| `scripting` | Re-inject content script after tab reload for session recovery |
| `contextMenus` | The right-click **Save Product Details** item |
| `offscreen` | A hidden document that owns `DOMParser` and `URL.createObjectURL`, which an MV3 service worker does not have |
| `downloads` | Delivering an exported CSV/XLSX without a user gesture, with `conflictAction: 'uniquify'` (shows Chrome's "Manage your downloads" install warning) |

`downloads` is the deterministic path and is kept deliberately: the alternative
(an `<a download>` click inside the offscreen document) is not verified in a real
browser yet. `host_permissions` are derived from the same marketplace list the
content script and the context menu use, so a marketplace cannot be half-added.

## One-click saving

A product can be saved from two places without leaving the page:

- **Right-click → Save Product Details** anywhere on an Amazon listing or product page.
- **The per-card button** in the corner of each product card (idle → queued →
  extracting → enriching → completed, or failed with a retry).

Both entries run one pipeline: the content script extracts the card, the
background writes the product and a snapshot to IndexedDB, then fetches the
product page in the background (no tab is opened or switched to) and upgrades the
row with detail fields. **The price the user saw when saving is never replaced**
by the product-page price; the detail value is kept in the snapshot instead.
Fields the product page cannot provide stay empty — nothing is invented.

Where the saved product lands is the **Right-Click Save Behavior** setting:

| Behaviour | Result |
|---|---|
| **Add to Current** (default) | Every save joins the same one-click collection until you start a new one |
| **New Collection per product** | Each save creates its own collection, named after the product |
| **Ask Every Time** | A dialog offers the current collection, a new collection, or Cancel — cancelling keeps the product where it was already saved |

One-click collections are history-only: they never adopt or join a full-page
collection, and a full-page run never adopts them.

## Supported Sites

23 Amazon marketplaces, all derived from one list
(`src/engines/amazon/constants/match-patterns.ts`) that the content script,
the context menu and `host_permissions` share:

amazon.com, amazon.co.uk, amazon.de, amazon.fr, amazon.it, amazon.es,
amazon.nl, amazon.se, amazon.pl, amazon.com.be, amazon.ca, amazon.com.mx,
amazon.com.br, amazon.co.jp, amazon.in, amazon.com.au, amazon.sg, amazon.ae,
amazon.sa, amazon.eg, amazon.com.tr, amazon.co.za, amazon.cn

## Design System

PPHunt uses a custom design system:

Light theme (a dark theme ships too — both palettes live in `src/entrypoints/sidepanel/global.css`; `tests/docs-consistency.test.ts` asserts every value below appears there):

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| Canvas | `#f0eee6` | `#141413` | Page background |
| Surface | `#faf9f5` | `#1d1c1a` | Card/input backgrounds |
| Surface Card | `#efe9de` | `#252421` | Elevated surfaces |
| Ink | `#141413` | `#f5f2eb` | Primary text |
| Hairline | `#8a877d` | `#66635b` | Borders |
| Clay | `#b04e30` | `#d97757` | Primary CTA (buttons, links) |
| Moss | `#455e2d` | `#91b370` | Success indicators |
| Crimson | `#a3302d` | `#e87672` | Error indicators |
| Golden | `#856214` | `#e0ba5c` | Warning indicators |

**Typography:** Lora (serif) for headings and body, Poppins (sans) for UI chrome, JetBrains Mono for code/metadata.

**Rules:** No box-shadow. No pure white. 8px bottom-only button radius for in-panel buttons; floating page controls (the per-card save button) use 8px on all corners. 1px hairline borders. Flat surfaces only.

## Known limitations

Manual browser/desktop checks were skipped at your request on 2026-10-17, not passed. The following remain unverified (tracked in `docs/remediation-plan/phase-11-manual-verification.md`):

- Row numbers and table geometry in the real browser (jsdom has no layout engine)
- XLSX rendering in actual Excel/LibreOffice/Sheets, including embedded images
- Screen-reader passes (NVDA/VoiceOver) and a keyboard-only walkthrough of the panel
- Live end-to-end collection against Amazon (selectors drift as Amazon changes markup)

## License

MIT

---

*Built with care by the PPHunt team.*