# PPHunt — Amazon Product Scraper Chrome Extension

> **Historical implementation plan — superseded for current behavior (2026-10-17).**
> This is the original design, not a shipped-feature or verification checklist.
> See [README](README.md), [ARCHITECTURE](ARCHITECTURE.md), and
> [remediation outcomes](docs/remediation-plan/README.md) for current status.


## Complete Implementation Plan

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Phase 1: Project Scaffolding & Core Infrastructure](#3-phase-1-project-scaffolding--core-infrastructure)
4. [Phase 2: Content Script & Scraping Engine](#4-phase-2-content-script--scraping-engine)
5. [Phase 3: Side Panel UI — Collection & Controls](#5-phase-3-side-panel-ui--collection--controls)
6. [Phase 4: Preview Table & Data Management](#6-phase-4-preview-table--data-management)
7. [Phase 5: Export & Download System](#7-phase-5-export--download-system)
8. [Phase 6: Settings UI](#8-phase-6-settings-ui)
9. [Phase 7: Session Persistence & Recovery](#9-phase-7-session-persistence--recovery)
10. [Phase 8: Error Handling, Edge Cases & Polish](#10-phase-8-error-handling-edge-cases--polish)
11. [Data Schemas & Type Definitions](#11-data-schemas--type-definitions)
12. [Amazon CSS Selectors Reference](#12-amazon-css-selectors-reference)
13. [Messaging Protocol](#13-messaging-protocol)
14. [Dependencies](#14-dependencies)
15. [Build & Development Commands](#15-build--development-commands)

---

## 1. Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Browser                           │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐ │
│  │  Side Panel   │   │  Background   │   │  Content Script  │ │
│  │  (React UI)   │◄─►│  Service      │◄─►│  (Amazon Page)   │ │
│  │              │   │  Worker       │   │                  │ │
│  │  - Collection│   │              │   │  - DOM Scraper   │ │
│  │  - Preview   │   │  - Routing   │   │  - Auto-Scroll   │ │
│  │  - Settings  │   │  - Tab mgmt  │   │  - MutationObs   │ │
│  │  - Export    │   │  - Panel open│   │  - Dedup         │ │
│  └──────┬───────┘   └──────────────┘   └──────────────────┘ │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              IndexedDB (via Dexie.js)                 │   │
│  │  - products table  (all scraped products)             │   │
│  │  - sessions table  (collection session state)         │   │
│  │  - settings table  (user preferences)                 │   │
│  │  - history table   (past collection sessions)         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Communication Flow

```
Side Panel  ──(runtime.sendMessage)──►  Background SW
                                            │
                                            ├──(tabs.sendMessage)──►  Content Script
                                            │                              │
                                            │◄──(runtime.sendMessage)──────┘
                                            │
Side Panel  ◄──(runtime.sendMessage)──── Background SW
```

**Key design decisions:**

- **Side Panel** is the main UI — persistent across tab switches (Chrome Side Panel API guarantees this).
- **Content Script** is injected only into Amazon pages (`*://*.amazon.*/*`). It handles DOM scraping and auto-scrolling.
- **Background Service Worker** acts as a message router between the side panel and content scripts. It manages tab tracking and opens the panel on icon click.
- **IndexedDB via Dexie** is the single source of truth for product data. Both the side panel and background can read/write. The side panel uses `useLiveQuery` for reactive UI updates.
- **Zod** validates all messages at the boundary — every message sent/received is parsed through a Zod schema before processing.

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | WXT | Extension scaffolding, manifest generation, HMR |
| Language | TypeScript (strict) | Type safety across all contexts |
| UI | React 18+ | Side panel, settings, preview table |
| Styling | Tailwind CSS | Utility-first CSS with PPHunt design tokens |
| State | Zustand | Lightweight global state in side panel |
| Storage | IndexedDB + Dexie.js | Persistent product/session/settings storage |
| Validation | Zod | Message schemas, settings validation, data parsing |
| Table | @tanstack/react-table | Preview table (sorting, filtering, selection) |
| Virtualization | @tanstack/react-virtual | Smooth scrolling for large datasets (300+ rows) |
| Export | SheetJS (xlsx) | Excel export |
| Build | Vite (via WXT) | Bundling, HMR |

### Design System: PPHunt Design System

PPHunt follows PPHunt Design System — warm, editorial, paper-like. The system reads like a curated research publication on warm parchment paper, not a generic tech tool.

**Core Principles:**
- Ivory/oat/clay earth tones only — no cool grays, no saturated blues
- Flat surfaces — no box-shadow; depth via surface tone and 1px borders
- Serif body voice — Lora at 14px for body copy carries the editorial personality
- Sans UI chrome — Poppins at 12-14px for buttons, labels, navigation
- Bottom-only 8px radius on filled buttons (signature PPHunt treatment)
- 12px radius on inputs, 16px on cards/containers
- Pure white (#ffffff) never used as a surface — always warm ivory
- Accent color (Clay #d97757) reserved exclusively for primary CTA — never decoration
- Underlined links — editorial print convention, persistent (not reveal-on-hover)
- 1px hairline borders (#b0aea5 or #e8e6dc) for separation — no shadows

**Color Palette:**

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

**Typography:**

| Role | Font | Fallback | Weight | Size |
|------|------|----------|--------|------|
| Body / Display serif | Lora | Georgia, Source Serif Pro | 400, 600 | 14–18px |
| UI Chrome | Poppins | Inter, system-ui, Arial | 400, 500, 600 | 12–16px |
| Code / Mono | JetBrains Mono | ui-monospace, Menlo | 400 | 13px |

**Spacing Scale (4px base):** 4, 8, 12, 16, 20, 24, 32, 48, 64

**Border Radius:** 8px (buttons, inputs), 12px (small cards), 16px (containers), 24px (large cards)

---

## 2. Project Structure

```
pphunt/
├── wxt.config.ts                          # WXT configuration + manifest
├── tsconfig.json                          # TypeScript config (extends WXT generated)
├── tailwind.config.ts                     # Tailwind CSS config
├── postcss.config.js                      # PostCSS config
├── package.json
├── .env                                   # Environment variables (if any)
│
├── src/
│   ├── entrypoints/                       # WXT file-based entrypoints
│   │   ├── background.ts                  # Service worker entrypoint
│   │   │
│   │   ├── sidepanel/                     # Side panel (HTML entrypoint)
│   │   │   ├── index.html                 # HTML shell
│   │   │   ├── main.tsx                   # React root mount
│   │   │   ├── App.tsx                    # Root app component + router
│   │   │   ├── global.css                 # Tailwind imports + global styles
│   │   │   │
│   │   │   ├── components/               # Side panel UI components
│   │   │   │   ├── layout/
│   │   │   │   │   ├── Header.tsx         # PPHunt logo, settings icon, tab nav
│   │   │   │   │   ├── TabBar.tsx         # Collection | Preview | History tabs
│   │   │   │   │   └── StatusBar.tsx      # Error/info banners
│   │   │   │   │
│   │   │   │   ├── collection/
│   │   │   │   │   ├── CollectionPanel.tsx        # Main collection view
│   │   │   │   │   ├── ModeSelector.tsx           # Manual / Automatic toggle
│   │   │   │   │   ├── TargetSelector.tsx         # 50/100/200/300 + custom input
│   │   │   │   │   ├── ControlButtons.tsx         # Start / Pause / Resume / Stop
│   │   │   │   │   ├── ProgressDisplay.tsx        # Progress bar + count + status
│   │   │   │   │   ├── CollectionStatus.tsx       # Status badge (Ready/Collecting/etc.)
│   │   │   │   │   └── NotificationToast.tsx      # Completion/error notifications
│   │   │   │   │
│   │   │   │   ├── preview/
│   │   │   │   │   ├── PreviewPanel.tsx           # Preview tab container
│   │   │   │   │   ├── ProductTable.tsx           # @tanstack/react-table wrapper
│   │   │   │   │   ├── TableToolbar.tsx           # Search, column toggle, export buttons
│   │   │   │   │   ├── TableRow.tsx               # Individual product row
│   │   │   │   │   ├── MissingFieldsBadge.tsx     # Shows which fields are empty
│   │   │   │   │   ├── DuplicateBadge.tsx         # Highlights duplicates
│   │   │   │   │   └── ColumnSelector.tsx         # Checkbox list of columns to show
│   │   │   │   │
│   │   │   │   ├── settings/
│   │   │   │   │   ├── SettingsPanel.tsx          # Settings overlay/page
│   │   │   │   │   ├── GeneralSettings.tsx        # Default mode, target count
│   │   │   │   │   ├── ScrollSettings.tsx         # Auto-scroll speed, wait interval
│   │   │   │   │   ├── FieldToggles.tsx           # Enable/disable individual fields
│   │   │   │   │   ├── NotificationSettings.tsx   # Duplicate detection, notifications
│   │   │   │   │   └── DangerZone.tsx             # Restore defaults, clear data
│   │   │   │   │
│   │   │   │   └── shared/
│   │   │   │       ├── Button.tsx
│   │   │   │       ├── Badge.tsx
│   │   │   │       ├── ProgressBar.tsx
│   │   │   │       ├── Toggle.tsx
│   │   │   │       ├── Select.tsx
│   │   │   │       ├── Input.tsx
│   │   │   │       ├── Modal.tsx
│   │   │   │       ├── Tooltip.tsx
│   │   │   │       └── EmptyState.tsx
│   │   │   │
│   │   │   ├── hooks/                     # Side panel React hooks
│   │   │   │   ├── useCollection.ts       # Collection state machine + controls
│   │   │   │   ├── useProducts.ts         # Product data access (via Dexie liveQuery)
│   │   │   │   ├── useSettings.ts         # Settings read/write
│   │   │   │   ├── useActiveTab.ts        # Track current active tab
│   │   │   │   ├── useExport.ts           # Export logic
│   │   │   │   └── useNotifications.ts    # Toast/notification management
│   │   │   │
│   │   │   └── store/                     # Zustand stores
│   │   │       ├── collectionStore.ts     # Collection state (mode, status, progress)
│   │   │       └── uiStore.ts             # UI state (active tab, settings open)
│   │   │
│   │   └── amazon.content.ts              # Content script for Amazon pages
│   │
│   ├── lib/                               # Shared library code (all contexts)
│   │   ├── db/
│   │   │   ├── database.ts                # Dexie database definition + schema
│   │   │   ├── products.ts                # Product CRUD operations
│   │   │   ├── sessions.ts                # Session state persistence
│   │   │   ├── settings.ts                # Settings CRUD + defaults
│   │   │   └── history.ts                 # Collection history
│   │   │
│   │   ├── schemas/
│   │   │   ├── product.ts                 # Zod schema for Product
│   │   │   ├── settings.ts                # Zod schema for Settings
│   │   │   ├── session.ts                 # Zod schema for SessionState
│   │   │   └── messages.ts                # Zod schemas for all messages
│   │   │
│   │   ├── messaging/
│   │   │   ├── types.ts                   # Protocol map type definitions
│   │   │   ├── sender.ts                  # Typed message sender (side panel → bg → content)
│   │   │   └── handler.ts                 # Typed message handler registration
│   │   │
│   │   ├── scraper/
│   │   │   ├── types.ts                   # ScrapedProduct, PageType types
│   │   │   ├── selectors.ts               # All Amazon CSS selectors (centralized)
│   │   │   ├── search-results.ts          # Parser for search results pages
│   │   │   ├── product-detail.ts          # Parser for product detail pages
│   │   │   ├── category-page.ts           # Parser for category/browse pages
│   │   │   ├── page-detector.ts           # Detect which Amazon page type we're on
│   │   │   ├── dedup.ts                   # Deduplication logic (by ASIN + URL)
│   │   │   └── scroll-controller.ts       # Auto-scroll engine
│   │   │
│   │   └── utils/
│   │       ├── export-csv.ts              # CSV generation (UTF-8 with BOM)
│   │       ├── export-xlsx.ts             # Excel generation (SheetJS)
│   │       ├── export-clipboard.ts        # Copy to clipboard (TSV format)
│   │       ├── file-saver.ts              # Download file helper
│   │       ├── price-parser.ts            # Parse price strings to number + currency
│   │       ├── amazon-url.ts              # ASIN extraction from URLs
│   │       └── notifications.ts           # Chrome notification helpers
│   │
│   ├── types/                             # Shared TypeScript type definitions
│   │   ├── product.ts                     # Product interface
│   │   ├── settings.ts                    # Settings interface
│   │   ├── session.ts                     # Session/Collection state types
│   │   └── common.ts                      # Shared utility types
│   │
│   ├── constants/                         # Application constants
│   │   ├── amazon-patterns.ts             # Amazon URL patterns, selectors versioned
│   │   ├── defaults.ts                    # Default settings values
│   │   └── limits.ts                      # Min/max values, rate limits
│   │
│   └── assets/                            # Static assets (PPHunt palette)
│       ├── icon-16.png                    # Clay (#d97757) icon on transparent bg
│       ├── icon-32.png
│       ├── icon-48.png
│       ├── icon-128.png
│       └── logo.svg                       # Wordmark: "PPHunt" in Poppins 600, clay
│
├── public/                                # WXT public directory (copied as-is)
│   └── _locales/                          # i18n (future-proofing)
│       └── en/
│           └── messages.json
│
└── tests/                                 # Test files
    ├── unit/
    │   ├── scraper/
    │   │   ├── selectors.test.ts
    │   │   ├── search-results.test.ts
    │   │   ├── product-detail.test.ts
    │   │   └── dedup.test.ts
    │   ├── utils/
    │   │   ├── price-parser.test.ts
    │   │   ├── amazon-url.test.ts
    │   │   └── export-csv.test.ts
    │   └── schemas/
    │       └── messages.test.ts
    └── fixtures/                          # Amazon HTML fixtures for testing
        ├── search-results.html
        ├── product-detail.html
        └── category-page.html
```

---

## 3. Phase 1: Project Scaffolding & Core Infrastructure

**Goal:** Get the WXT project running with React, Tailwind, TypeScript, Dexie, and Zod. All entrypoints bootstrapped. Dev environment with HMR working.

### Step 1.1: Initialize WXT Project

```bash
npx wxt@latest init pphunt
# Select: React template, pnpm package manager
cd pphunt
```

### Step 1.2: Install Dependencies

```bash
# Core
pnpm add dexie dexie-react-hooks zustand zod

# UI
pnpm add @tanstack/react-table

# Export
pnpm add xlsx file-saver
pnpm add -D @types/file-saver

# Tailwind (if not already included by WXT template)
pnpm add -D tailwindcss postcss autoprefixer
npx tailwindcss init -p

# Dev
pnpm add -D @types/chrome
```

### Step 1.3: Configure `wxt.config.ts`

```typescript
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'PPHunt',
    description: 'Collect, preview, and export Amazon product data with care.',
    version: '1.0.0',
    permissions: [
      'sidePanel',
      'activeTab',
      'tabs',
      'storage',
      'scripting',
    ],
    host_permissions: [
      '*://*.amazon.com/*',
      '*://*.amazon.co.uk/*',
      '*://*.amazon.de/*',
      '*://*.amazon.fr/*',
      '*://*.amazon.ca/*',
      '*://*.amazon.co.jp/*',
      '*://*.amazon.in/*',
      '*://*.amazon.com.au/*',
      '*://*.amazon.es/*',
      '*://*.amazon.it/*',
    ],
    action: {},
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
  },
});
```

**Important:** WXT automatically adds the `sidePanel` permission when it detects a `sidepanel/` entrypoint directory. It also auto-generates the `side_panel.default_path` manifest field.

### Step 1.4: Configure Tailwind with PPHunt Design Tokens

```typescript
// tailwind.config.ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // PPHunt earth-tone palette — no cool grays, no saturated blues
        ink:        '#141413',   // Primary text, dark surfaces
        canvas:     '#f0eee6',   // Page background (the floor)
        surface:    '#faf9f5',   // Cards, elevated surfaces
        'surface-card': '#efe9de',  // Feature cards
        'surface-soft': '#f5f0e8',  // Section dividers
        hairline:   '#b0aea5',   // Borders, muted text, placeholders
        'hairline-soft': '#e8e6dc', // Subtle borders
        clay:       '#d97757',   // Primary accent — CTAs only
        'clay-active': '#b85a3e',   // Clay hover/press
        sky:        '#6a9bcc',   // Secondary accent — info, links
        moss:       '#788c5d',   // Tertiary accent — success
      },
      fontFamily: {
        // Lora for body/display serif (editorial voice)
        serif: ['Lora', 'Georgia', 'Source Serif Pro', 'Charter', 'serif'],
        // Poppins for UI chrome (buttons, labels, nav)
        sans: ['Poppins', 'Inter', 'system-ui', 'Arial', 'sans-serif'],
        // JetBrains Mono for code/metadata
        mono: ['JetBrains Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
      // 4px base spacing scale — PPHunt standard
      spacing: {
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '8': '32px',
        '12': '48px',
        '16': '64px',
      },
      // PPHunt border radius scale
      borderRadius: {
        'sm': '8px',    // buttons, inputs
        'md': '12px',   // small cards
        'lg': '16px',   // containers
        'xl': '24px',   // large cards
      },
      // Use px — prevents host page rem interference in side panel
      fontSize: {
        'xs':    ['12px', { lineHeight: '16px', letterSpacing: '-0.02em' }],
        'sm':    ['13px', { lineHeight: '18px' }],
        'base':  ['14px', { lineHeight: '20px' }],
        'lg':    ['16px', { lineHeight: '24px' }],
        'xl':    ['18px', { lineHeight: '26px' }],
        '2xl':   ['20px', { lineHeight: '28px' }],
      },
      // No box-shadow tokens — elevation via surface tones only
      boxShadow: {
        'none': 'none',
      },
    },
  },
  plugins: [],
} satisfies Config;
```

**PPHunt Design Rules enforced in Tailwind:**
- `px` units for all font sizes (prevents host-page `rem` interference in the side panel)
- No box-shadow tokens — depth is communicated through surface tone (`canvas` → `surface` → `surface-card`) and 1px hairline borders
- Warm earth-tone palette only — no cool grays (`gray-*`), no bright blues (`blue-*`), no pure white backgrounds
- Clay (`#d97757`) is the only chromatic accent and reserved for primary CTAs

### Step 1.5: Bootstrap Entrypoints

**`src/entrypoints/background.ts`** — Service worker:

```typescript
export default defineBackground(() => {
  // Open side panel when extension icon is clicked
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Message routing hub
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Route messages between side panel and content scripts
    // All messages validated with Zod before processing
    // Implementation in Phase 2
    return true; // Keep channel open for async
  });

  // Track which Amazon tab is active for collection
  browser.tabs.onActivated.addListener((activeInfo) => {
    // Notify side panel of tab switch
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Detect navigation away from Amazon, notify side panel
  });
});
```

**`src/entrypoints/sidepanel/index.html`** — Side panel HTML shell:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PPHunt</title>
    <!-- PPHunt typography: Lora (body serif), Poppins (UI sans), JetBrains Mono (code) -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Lora:wght@400;600&family=JetBrains+Mono&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

**`src/entrypoints/sidepanel/main.tsx`** — React mount:

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**`src/entrypoints/sidepanel/global.css`** — Tailwind base + PPHunt globals:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html {
    /* Prevent host page font-size from affecting the side panel */
    font-size: 16px;
  }

  body {
    font-family: 'Lora', Georgia, 'Source Serif Pro', Charter, serif;
    color: #141413;           /* ink */
    background-color: #f0eee6; /* canvas — the PPHunt page floor */
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    margin: 0;
    padding: 0;
  }

  /* PPHunt link style — persistent underline, sky accent */
  a {
    color: #6a9bcc;           /* sky */
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  a:hover {
    color: #141413;           /* ink on hover */
  }

  /* Scrollbar — minimal, warm-toned */
  ::-webkit-scrollbar {
    width: 6px;
  }
  ::-webkit-scrollbar-track {
    background: #f0eee6;      /* canvas */
  }
  ::-webkit-scrollbar-thumb {
    background: #b0aea5;      /* hairline */
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #141413;      /* ink */
  }
}
```

**`src/entrypoints/amazon.content.ts`** — Content script:

```typescript
export default defineContentScript({
  matches: [
    '*://*.amazon.com/*',
    '*://*.amazon.co.uk/*',
    '*://*.amazon.de/*',
    '*://*.amazon.fr/*',
    '*://*.amazon.ca/*',
    '*://*.amazon.co.jp/*',
    '*://*.amazon.in/*',
    '*://*.amazon.com.au/*',
    '*://*.amazon.es/*',
    '*://*.amazon.it/*',
  ],
  runAt: 'document_idle',

  main(ctx) {
    // Content script logic — Phase 2
    console.log('[PPHunt] Content script loaded on:', window.location.href);

    // Listen for messages from background/side panel
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Handle collection commands
      return true;
    });
  },
});
```

### Step 1.6: Set Up Dexie Database

**`src/lib/db/database.ts`**:

```typescript
import Dexie, { type EntityTable } from 'dexie';
import type { Product } from '@/types/product';
import type { SessionState } from '@/types/session';
import type { AppSettings } from '@/types/settings';

export const db = new Dexie('PPHuntDB') as Dexie & {
  products: EntityTable<Product, 'id'>;
  sessions: EntityTable<SessionState, 'id'>;
  settings: EntityTable<AppSettings, 'id'>;
  history: EntityTable<CollectionHistory, 'id'>;
};

db.version(1).stores({
  products: '++id, asin, url, sessionKey, collectedAt, [sessionKey+asin]',
  sessions: 'id, tabId, status, startedAt',
  settings: 'id',
  history: '++id, sessionKey, startedAt, completedAt',
});
```

**`src/lib/schemas/product.ts`** — Zod schema:

```typescript
import { z } from 'zod';

export const ProductSchema = z.object({
  id: z.number().optional(),
  asin: z.string().min(1),
  url: z.string().url(),
  title: z.string().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
  reviewCount: z.number().int().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  isSponsored: z.boolean().optional(),
  isPrime: z.boolean().optional(),
  brand: z.string().nullable().optional(),
  availability: z.string().nullable().optional(),
  seller: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  features: z.array(z.string()).optional(),
  collectedAt: z.string().datetime(),
  sessionKey: z.string(),
  source: z.enum(['search', 'detail', 'category']),
});

export type Product = z.infer<typeof ProductSchema>;
```

### Step 1.7: Set Up Zustand Stores

**`src/entrypoints/sidepanel/store/collectionStore.ts`**:

```typescript
import { create } from 'zustand';

export type CollectionMode = 'manual' | 'automatic';
export type CollectionStatus = 'idle' | 'collecting' | 'paused' | 'completed' | 'error';

interface CollectionState {
  mode: CollectionMode;
  status: CollectionStatus;
  targetCount: number;
  collectedCount: number;
  errorMessage: string | null;
  activeTabId: number | null;
  activeTabUrl: string | null;
  isAmazonPage: boolean;

  // Actions
  setMode: (mode: CollectionMode) => void;
  setStatus: (status: CollectionStatus) => void;
  setTarget: (count: number) => void;
  setCollectedCount: (count: number) => void;
  setError: (message: string | null) => void;
  setActiveTab: (tabId: number | null, url: string | null, isAmazon: boolean) => void;
  reset: () => void;
}
```

### Step 1.8: Verify Dev Environment

```bash
pnpm dev
# WXT opens Chrome with the extension loaded
# Verify: side panel opens on icon click
# Verify: content script logs on Amazon pages
# Verify: HMR works for side panel React components
```

---

## 4. Phase 2: Content Script & Scraping Engine

**Goal:** Build the DOM scraping logic for Amazon search results, product detail, and category pages. Implement the MutationObserver + auto-scroll engine. Wire up messaging between content script and side panel.

### Step 2.1: Amazon Page Type Detection

**`src/lib/scraper/page-detector.ts`**:

Detect which type of Amazon page the user is viewing:

```typescript
export type AmazonPageType = 'search' | 'product-detail' | 'category' | 'bestsellers' | 'unknown';

export function detectPageType(url: string, document: Document): AmazonPageType {
  const pathname = new URL(url).pathname;

  // Search results: /s?k=... or /s?i=...
  if (pathname.startsWith('/s') && (url.includes('?k=') || url.includes('?i='))) {
    return 'search';
  }

  // Product detail: /dp/<ASIN> or /gp/product/<ASIN>
  if (/\/dp\/[A-Z0-9]{10}/.test(pathname) || /\/gp\/product\/[A-Z0-9]{10}/.test(pathname)) {
    return 'product-detail';
  }

  // Category/browse pages
  if (pathname.startsWith('/b/') || pathname.startsWith('/Best-Sellers/') || document.querySelector('#departments')) {
    return 'category';
  }

  // Bestsellers
  if (pathname.startsWith('/Best-Sellers/') || pathname.includes('bestsellers')) {
    return 'bestsellers';
  }

  // Fallback: check for search results grid
  if (document.querySelector('[data-component-type="s-search-result"]')) {
    return 'search';
  }

  return 'unknown';
}
```

### Step 2.2: Centralized CSS Selectors

**`src/lib/scraper/selectors.ts`**:

All Amazon CSS selectors in one file, versioned for easy maintenance. When Amazon changes their DOM, update this one file.

```typescript
/**
 * Amazon CSS Selectors — Last verified: 2026-10-14
 *
 * When selectors break, update this file. All scraper modules
 * import selectors from here rather than hardcoding them.
 */

export const SELECTORS = {
  search: {
    // Container for each product card in search results
    productCard: '[data-component-type="s-search-result"]',
    // ASIN is the data-asin attribute on the card
    asin: '[data-asin]',
    // Product title
    title: 'h2 a span',
    titleLink: 'h2 a[href]',
    // Price (current)
    price: '.a-price[data-a-color="base"] .a-offscreen',
    priceFallback: 'span.a-price > span.a-offscreen',
    // List price (strikethrough)
    listPrice: '.a-price[data-a-color="secondary"] .a-offscreen',
    // Rating
    rating: 'span.a-icon-alt',
    // Review count
    reviewCount: '[aria-label$="ratings"], [aria-label$="rating"]',
    reviewCountFallback: 'span.s-underline-text',
    // Image
    image: 'img.s-image',
    // Sponsored label
    sponsored: '.puis-sponsored-label-text',
    // Prime badge
    prime: '[aria-label*="Prime"]',
    // Brand
    brand: '.a-size-base-plus.a-color-base',
    // Next page button (for pagination detection)
    nextPage: '.s-pagination-next',
    // Result info bar ("1-48 of over X results")
    resultInfo: '[data-component-type="s-result-info-bar"]',
  },

  productDetail: {
    // Title
    title: '#productTitle',
    // ASIN — from URL or product details table
    asinTable: '#productDetails_techSpec_section_1 tr:has(th:contains("ASIN")) td',
    // Price (Buy Box)
    price: 'span.a-price span.a-offscreen',
    priceWhole: 'span.a-price-whole',
    priceFraction: 'span.a-price-fraction',
    priceSymbol: 'span.a-price-symbol',
    // List price
    listPrice: '.a-text-price .a-offscreen',
    // Rating
    rating: '#acrPopover',
    ratingText: 'span[data-hook="rating-out-of-text"]',
    // Review count
    reviewCount: '#acrCustomerReviewText',
    // Availability
    availability: '#availability',
    // Brand
    brand: '#bylineInfo',
    brandMeta: 'meta[name="author"]',
    // Features (bullet points)
    features: '#feature-bullets .a-list-item',
    // Description
    description: '#productDescription p',
    descriptionAlt: '#aplus .a-section',
    // Hero image
    heroImage: '#landingImage',
    // Image gallery
    imageGallery: '#altImages .a-button-thumbnail img',
    // Seller
    seller: '#sellerProfileTriggerId',
    sellerFallback: '#tabular-buybox .tabular-buybox-text a',
    // Category breadcrumb
    breadcrumb: '#wayfinding-breadcrumbs_feature_div a',
    // Product details table
    detailsTable: '#productDetails_techSpec_section_1 tr',
    detailsTableAlt: '#detailBullets_feature_div .a-list-item',
  },

  category: {
    productCard: '.zg-grid-general-faceout, [data-asin]',
    title: '._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, .a-size-base-plus',
    price: '.a-price .a-offscreen',
    rating: '.a-icon-alt',
    reviewCount: '.a-size-small',
    image: 'img',
    link: 'a[href*="/dp/"]',
  },
} as const;
```

### Step 2.3: Search Results Parser

**`src/lib/scraper/search-results.ts`**:

```typescript
import { SELECTORS } from './selectors';
import { extractASIN } from '@/lib/utils/amazon-url';
import { parsePrice } from '@/lib/utils/price-parser';
import type { ScrapedProduct } from './types';

export function parseSearchResults(document: Document): ScrapedProduct[] {
  const products: ScrapedProduct[] = [];
  const cards = document.querySelectorAll(SELECTORS.search.productCard);

  for (const card of cards) {
    const asinAttr = card.getAttribute('data-asin')?.trim();
    if (!asinAttr) continue;

    const titleEl = card.querySelector(SELECTORS.search.title);
    const titleLinkEl = card.querySelector(SELECTORS.search.titleLink);
    const priceEl = card.querySelector(SELECTORS.search.price)
      ?? card.querySelector(SELECTORS.search.priceFallback);
    const ratingEl = card.querySelector(SELECTORS.search.rating);
    const reviewEl = card.querySelector(SELECTORS.search.reviewCount)
      ?? card.querySelector(SELECTORS.search.reviewCountFallback);
    const imageEl = card.querySelector<HTMLImageElement>(SELECTORS.search.image);
    const sponsoredEl = card.querySelector(SELECTORS.search.sponsored);
    const primeEl = card.querySelector(SELECTORS.search.prime);

    const { value: price, currency } = parsePrice(priceEl?.textContent);

    products.push({
      asin: asinAttr,
      url: `https://www.amazon.com/dp/${asinAttr}`,
      title: titleEl?.textContent?.trim() || undefined,
      price,
      currency,
      rating: parseRating(ratingEl?.getAttribute('title') ?? ratingEl?.textContent),
      reviewCount: parseReviewCount(reviewEl),
      imageUrl: imageEl?.src || undefined,
      isSponsored: !!sponsoredEl,
      isPrime: !!primeEl,
      source: 'search',
    });
  }

  return products;
}
```

### Step 2.4: Product Detail Parser

**`src/lib/scraper/product-detail.ts`**:

Parses a single product from an Amazon product detail page (`/dp/<ASIN>`). This is used when the user navigates to a specific product page.

### Step 2.5: Deduplication Engine

**`src/lib/scraper/dedup.ts`**:

```typescript
export class DeduplicationEngine {
  private seenASINs = new Set<string>();
  private seenURLs = new Set<string>();

  constructor(existingProducts?: { asin: string; url: string }[]) {
    if (existingProducts) {
      for (const p of existingProducts) {
        this.seenASINs.add(p.asin);
        this.seenURLs.add(p.url);
      }
    }
  }

  /**
   * Returns true if this product is new (not a duplicate).
   */
  isNew(product: { asin: string; url?: string }): boolean {
    if (this.seenASINs.has(product.asin)) return false;
    if (product.url && this.seenURLs.has(product.url)) return false;
    return true;
  }

  /**
   * Mark a product as seen.
   */
  add(product: { asin: string; url?: string }): void {
    this.seenASINs.add(product.asin);
    if (product.url) this.seenURLs.add(product.url);
  }

  get size(): number {
    return this.seenASINs.size;
  }
}
```

### Step 2.6: Auto-Scroll Controller

**`src/lib/scraper/scroll-controller.ts`**:

```typescript
interface ScrollConfig {
  scrollAmount: number;      // pixels per scroll step
  scrollInterval: number;    // ms between scroll steps
  waitAfterScroll: number;   // ms to wait for new content to load
  maxWaitForNew: number;     // ms to wait before assuming end of page
}

const DEFAULT_CONFIG: ScrollConfig = {
  scrollAmount: 800,
  scrollInterval: 500,
  waitAfterScroll: 1500,
  maxWaitForNew: 5000,
};

export class ScrollController {
  private config: ScrollConfig;
  private observer: MutationObserver | null = null;
  private scrollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isPaused = false;
  private lastProductCount = 0;
  private staleCount = 0;

  constructor(config?: Partial<ScrollConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start auto-scrolling. Returns an async generator that yields
   * whenever new products are detected in the DOM.
   */
  async start(
    onNewProducts: (newCount: number) => void,
    onEndOfPage: () => void,
    shouldContinue: () => boolean,
  ): Promise<void> {
    // Implementation:
    // 1. Start MutationObserver on the product container
    // 2. Set interval to scroll by scrollAmount
    // 3. On each mutation batch, count new [data-asin] elements
    // 4. If no new products after maxWaitForNew, call onEndOfPage
    // 5. Check shouldContinue() before each scroll step
  }

  pause(): void { this.isPaused = true; }
  resume(): void { this.isPaused = false; }

  stop(): void {
    this.isRunning = false;
    this.observer?.disconnect();
    if (this.scrollTimer) clearInterval(this.scrollTimer);
  }

  updateConfig(config: Partial<ScrollConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
```

### Step 2.7: Messaging Protocol

**`src/lib/messaging/types.ts`**:

Define the typed message protocol between all extension contexts:

```typescript
import { z } from 'zod';
import { ProductSchema } from '@/lib/schemas/product';

// ─── Side Panel → Background ───

export const StartCollectionSchema = z.object({
  type: z.literal('START_COLLECTION'),
  payload: z.object({
    mode: z.enum(['manual', 'automatic']),
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX), // amended (remediation Phase 2): explicit 1–1000 bounds, not .positive()
    tabId: z.number(),
  }),
});

export const PauseCollectionSchema = z.object({
  type: z.literal('PAUSE_COLLECTION'),
  payload: z.object({ tabId: z.number() }),
});

export const ResumeCollectionSchema = z.object({
  type: z.literal('RESUME_COLLECTION'),
  payload: z.object({ tabId: z.number() }),
});

export const StopCollectionSchema = z.object({
  type: z.literal('STOP_COLLECTION'),
  payload: z.object({ tabId: z.number() }),
});

export const RequestProductCountSchema = z.object({
  type: z.literal('REQUEST_PRODUCT_COUNT'),
  payload: z.object({ tabId: z.number() }),
});

// ─── Background → Content Script ───

export const CollectProductsSchema = z.object({
  type: z.literal('COLLECT_PRODUCTS'),
  payload: z.object({
    mode: z.enum(['manual', 'automatic']),
    targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX), // amended (remediation Phase 2): explicit 1–1000 bounds, not .positive()
  }),
});

export const PauseScrollingSchema = z.object({
  type: z.literal('PAUSE_SCROLLING'),
});

export const ResumeScrollingSchema = z.object({
  type: z.literal('RESUME_SCROLLING'),
});

export const StopCollectionCmdSchema = z.object({
  type: z.literal('STOP_COLLECTION_CMD'),
});

// ─── Content Script → Background ───

export const ProductsCollectedSchema = z.object({
  type: z.literal('PRODUCTS_COLLECTED'),
  payload: z.object({
    products: z.array(ProductSchema),
    totalCount: z.number(),
    isNewBatch: z.boolean(),
  }),
});

export const CollectionProgressSchema = z.object({
  type: z.literal('COLLECTION_PROGRESS'),
  payload: z.object({
    collected: z.number(),
    target: z.number(),
    status: z.enum(['collecting', 'paused', 'completed', 'error']),
  }),
});

export const ContentErrorSchema = z.object({
  type: z.literal('CONTENT_ERROR'),
  payload: z.object({
    code: z.enum(['NOT_AMAZON', 'CAPTCHA', 'SIGN_IN', 'LOAD_FAILED', 'UNKNOWN']),
    message: z.string(),
  }),
});

// ─── Background → Side Panel ───

export const UpdateProgressSchema = z.object({
  type: z.literal('UPDATE_PROGRESS'),
  payload: z.object({
    collected: z.number(),
    target: z.number(),
    status: z.enum(['idle', 'collecting', 'paused', 'completed', 'error']),
    error: z.string().nullable(),
  }),
});

export const TabChangedSchema = z.object({
  type: z.literal('TAB_CHANGED'),
  payload: z.object({
    tabId: z.number(),
    url: z.string(),
    isAmazon: z.boolean(),
  }),
});

// Discriminated union of all messages
export const MessageSchema = z.discriminatedUnion('type', [
  StartCollectionSchema,
  PauseCollectionSchema,
  ResumeCollectionSchema,
  StopCollectionSchema,
  RequestProductCountSchema,
  CollectProductsSchema,
  PauseScrollingSchema,
  ResumeScrollingSchema,
  StopCollectionCmdSchema,
  ProductsCollectedSchema,
  CollectionProgressSchema,
  ContentErrorSchema,
  UpdateProgressSchema,
  TabChangedSchema,
]);

export type Message = z.infer<typeof MessageSchema>;
```

### Step 2.8: Content Script Main Logic

**`src/entrypoints/amazon.content.ts`** — Full implementation:

```typescript
export default defineContentScript({
  matches: [/* Amazon domains */],
  runAt: 'document_idle',

  main(ctx) {
    let dedup: DeduplicationEngine;
    let scrollController: ScrollController | null = null;
    let collectedProducts: ScrapedProduct[] = [];
    let targetCount = 0;
    let mode: 'manual' | 'automatic' = 'manual';

    // Initialize dedup with existing products from DB
    // (query via message to background)

    // Parse initial page products
    const pageType = detectPageType(window.location.href, document);
    if (pageType === 'search') {
      const initial = parseSearchResults(document);
      collectedProducts = dedup.filter(initial);
      sendProductsToBackground(collectedProducts, false);
    } else if (pageType === 'product-detail') {
      const product = parseProductDetail(document);
      if (product && dedup.isNew(product)) {
        collectedProducts = [product];
        sendProductsToBackground([product], false);
      }
    }

    // Manual mode: MutationObserver only
    const observer = new MutationObserver((mutations) => {
      if (mode !== 'manual') return;
      const newProducts = detectNewProductsFromMutations(mutations);
      const unique = dedup.filter(newProducts);
      if (unique.length > 0) {
        collectedProducts.push(...unique);
        sendProductsToBackground(unique, true);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Listen for commands from background/side panel
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const parsed = MessageSchema.safeParse(message);
      if (!parsed.success) return;

      switch (parsed.data.type) {
        case 'COLLECT_PRODUCTS':
          mode = parsed.data.payload.mode;
          targetCount = parsed.data.payload.targetCount;
          if (mode === 'automatic') {
            startAutoScroll();
          }
          break;
        case 'PAUSE_SCROLLING':
          scrollController?.pause();
          break;
        case 'RESUME_SCROLLING':
          scrollController?.resume();
          break;
        case 'STOP_COLLECTION_CMD':
          scrollController?.stop();
          break;
      }
    });

    function startAutoScroll() {
      scrollController = new ScrollController();
      scrollController.start(
        (newCount) => {
          // New products detected, parse and send
        },
        () => {
          // End of page reached
          sendProgressUpdate('completed');
        },
        () => collectedProducts.length < targetCount,
      );
    }

    // CAPTCHA / sign-in detection
    function detectPageIssues(): 'captcha' | 'signin' | 'blocked' | null {
      if (document.querySelector('#captchacharacters, form[action*="validateCaptcha"]')) {
        return 'captcha';
      }
      if (document.querySelector('#ap_email, #signInSubmit, [data-component-type="auth-page"]')) {
        return 'signin';
      }
      if (document.querySelector('#dogPage, #errorPage, .error-code')) {
        return 'blocked';
      }
      return null;
    }
  },
});
```

### Step 2.9: Background Service Worker Message Router

**`src/entrypoints/background.ts`** — Full implementation:

The background service worker:
1. Receives `START_COLLECTION` from side panel → routes to content script as `COLLECT_PRODUCTS`
2. Receives `PRODUCTS_COLLECTED` from content script → stores in IndexedDB → sends `UPDATE_PROGRESS` to side panel
3. Receives `CONTENT_ERROR` from content script → forwards to side panel with error info
4. Tracks active tab for collection
5. Detects when the collection tab is closed or navigated away

---

## 5. Phase 3: Side Panel UI — Collection & Controls

**Goal:** Build the main side panel interface with collection controls, progress display, and tab navigation.

### Step 3.1: Side Panel Layout

The side panel follows PPHunt's warm editorial aesthetic — ivory canvas, serif voice, flat surfaces, hairline borders. Three main tabs:
1. **Collect** — Main control panel for scraping
2. **Preview** — Spreadsheet view of collected products
3. **History** — Past collection sessions

```
┌──────────────────────────────────────────┐ ← canvas (#f0eee6)
│                                          │
│  PPHunt                    [⚙]          │  ← sans 16px 600, ink
│                                          │
│  ─────────────────────────────────────── │  ← hairline-soft border
│                                          │
│  Collect    Preview    History           │  ← sans 13px 500, tabs
│  ───────                                │  ← clay underline (active)
│                                          │
│  ┌────────────────────────────────────┐  │  ← surface-card bg, 12px radius
│  │                                    │  │
│  │  Collection Mode                   │  │  ← serif 14px, ink
│  │  ┌──────────┐ ┌──────────────┐    │  │
│  │  │  Manual   │ │  Automatic   │    │  │  ← pill toggle (no shadow)
│  │  └──────────┘ └──────────────┘    │  │
│  │                                    │  │
│  │  Target Products                   │  │
│  │  ┌────┐ ┌─────┐ ┌─────┐ ┌─────┐  │  │
│  │  │ 50 │ │ 100 │ │ 200 │ │ 300 │  │  │  ← outlined buttons, 8px bottom radius
│  │  └────┘ └─────┘ └─────┘ └─────┘  │  │
│  │  Custom: [________]               │  │  ← hairline input, 8px radius
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  ● Collecting                      │  │  ← moss dot + serif 13px
│  │                                    │  │
│  │  ████████████████░░░░░  67 / 100   │  │  ← clay progress bar on canvas bg
│  │                                    │  │
│  │  12 products found · 3 duplicates  │  │  ← hairline 12px muted text
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  ▶ Start  │  │  ⏸ Pause │  │ ⏹ Stop │ │  ← clay filled (primary),
│  └──────────┘  └──────────┘  └────────┘ │    outlined (secondary)
│                                          │
│  [Preview Collected Data →]              │  ← sky link, underlined
│                                          │
└──────────────────────────────────────────┘
```

### Shared Component Patterns (PPHunt Style)

Every shared component in `src/entrypoints/sidepanel/components/shared/` follows these PPHunt design rules:

**Button.tsx** — Two variants:
- `primary` (clay): `bg-clay text-surface font-sans text-sm font-medium rounded-sm rounded-b-[8px] px-4 py-2.5` — the filled clay button, used only for the single most important CTA in view. Hover: `bg-clay-active`.
- `secondary` (outlined): `bg-transparent text-ink border border-hairline font-sans text-sm rounded-sm rounded-b-[8px] px-4 py-2.5` — all other actions. Hover: `bg-surface-soft`.
- No box-shadow on either variant. No pill/rounded-full shapes.
- Active state: the button gets an 8px bottom-only border-radius (PPHunt signature). Top corners stay square or slightly rounded (the `rounded-sm` base class applies ~4px, then `rounded-b-[8px]` overrides the bottom to 8px specifically).

**Input.tsx**: `bg-surface border border-hairline rounded-sm text-ink font-sans placeholder:text-hairline focus:border-ink focus:outline-none px-3 py-2`. No shadow on focus — just a 1px border color change to ink.

**Toggle.tsx**: Pill toggle for Manual/Automatic mode. Two-segment control — active segment has `bg-surface text-ink` (elevated from canvas), inactive has `bg-transparent text-hairline`. Both in `font-sans text-sm`. No shadows, no color fills — the elevation difference between canvas and surface does the work.

**ProgressBar.tsx**: A thin (6px) clay-colored bar on a canvas track. `rounded-full` on the track (this is the one exception to the no-pill rule — progress bars are inherently rounded). No animation shimmer — just a smooth width transition.

**Tab.tsx**: `font-serif text-base`. Active tab: `text-ink border-b-2 border-clay`. Inactive: `text-hairline hover:text-ink`. The clay underline is the only active indicator — no background fills on tabs.

**StatusDot.tsx**: A 6px dot + serif label. `moss` for success/ready states, `clay` for active/attention states, `hairline` for inactive states. The label text is `font-serif text-xs text-hairline` (or `text-ink` when active).

**EmptyState.tsx**: A `surface-card` card with centered `font-serif text-base text-hairline` text. No illustrations, no icons — just a quiet, warm message.

### Step 3.2: Collection Panel Component

**`src/entrypoints/sidepanel/components/collection/CollectionPanel.tsx`**:

Main orchestrator component. Uses:
- `useCollection()` hook for state and controls
- `useActiveTab()` hook to track which tab is open
- `useProducts()` hook (Dexie liveQuery) for real-time product count

### Step 3.3: Mode Selector

Toggle between Manual and Automatic modes. Updates Zustand store + persists to settings.

### Step 3.4: Target Selector

Quick-select buttons (50, 100, 200, 300) plus a custom number input. Validates: min 1, max 1000 (configurable).

### Step 3.5: Control Buttons

State machine for controls:

```
idle → [Start] → collecting
collecting → [Pause] → paused
paused → [Resume] → collecting
collecting → [Stop] → idle
paused → [Stop] → idle
collecting → (target reached) → completed
```

### Step 3.6: Progress Display

Real-time progress bar + text showing `collectedCount / targetCount`. Updates arrive via messages from the content script (routed through background).

### Step 3.7: Status Indicator

Status is shown as a colored dot + label (no emoji, no badges — PPHunt style). Uses the muted serif for the label.

- `● Ready` — moss dot, muted text — idle, waiting to begin
- `● Collecting` — clay dot, ink text — actively scraping
- `● Paused` — hairline dot, muted text — collection paused
- `● Complete` — moss dot, ink text — target reached
- `● Needs attention` — clay dot, ink text — error requires user action

### Step 3.8: Non-Amazon Page Detection

When the active tab is not an Amazon page, show a friendly message:
```
⚠️ This is not an Amazon page.
Navigate to Amazon.com to start collecting products.
```

### Step 3.9: useCollection Hook

**`src/entrypoints/sidepanel/hooks/useCollection.ts`**:

```typescript
export function useCollection() {
  const store = useCollectionStore();
  const { activeTabId, isAmazonPage } = useActiveTab();
  const { settings } = useSettings();
  const { addToast } = useNotifications();

  const startCollection = useCallback(async () => {
    if (!activeTabId || !isAmazonPage) {
      store.setError('Please navigate to an Amazon page first.');
      return;
    }

    store.setStatus('collecting');
    store.setError(null);

    await browser.runtime.sendMessage({
      type: 'START_COLLECTION',
      payload: {
        mode: store.mode,
        targetCount: store.targetCount,
        tabId: activeTabId,
      },
    });
  }, [store.mode, store.targetCount, activeTabId, isAmazonPage]);

  const pauseCollection = useCallback(async () => { /* ... */ }, []);
  const resumeCollection = useCallback(async () => { /* ... */ }, []);
  const stopCollection = useCallback(async () => { /* ... */ }, []);

  // Listen for progress updates from background
  useEffect(() => {
    const listener = (message: any) => {
      if (message.type === 'UPDATE_PROGRESS') {
        store.setCollectedCount(message.payload.collected);
        store.setStatus(message.payload.status);
        if (message.payload.error) {
          store.setError(message.payload.error);
        }
        if (message.payload.status === 'completed') {
          addToast('Collection complete', `${message.payload.collected} products collected and ready to preview.`);
        }
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  return {
    ...store,
    startCollection,
    pauseCollection,
    resumeCollection,
    stopCollection,
    canStart: isAmazonPage && store.status === 'idle',
    canPause: store.status === 'collecting',
    canResume: store.status === 'paused',
    canStop: store.status === 'collecting' || store.status === 'paused',
  };
}
```

---

## 6. Phase 4: Preview Table & Data Management

**Goal:** Build a spreadsheet-style product preview table with search, sort, column selection, row selection, and duplicate/missing-field indicators.

### Step 4.1: Preview Panel Component

**`src/entrypoints/sidepanel/components/preview/PreviewPanel.tsx`**:

```
┌──────────────────────────────────────────────────────┐
│ [🔍 Search...] [Columns ▾] [Export ▾] [🗑️ Delete]   │
│ Showing 67 products · 12 selected · 3 duplicates     │
├──────────────────────────────────────────────────────┤
│ ☐ │ Title        │ ASIN   │ Price  │ Rating │ Prime  │
│───┼──────────────┼────────┼────────┼────────┼────────│
│ ☐ │ Echo Dot 5th │ B09B.. │ $49.99 │  4.7   │  ✓    │
│ ☐ │ Fire TV St.. │ B09X.. │ $24.99 │  4.5   │  ✓    │
│ ☐ │ Unknown Pro..│ B0XX.. │ —      │  —     │       │
│ ☐ │ Echo Show 8  │ B09N.. │ $129.  │  4.6   │  ✓    │
└──────────────────────────────────────────────────────┘
│ [Export All] [Export Selected] [Export Filtered]      │
```

### Step 4.2: Product Table with @tanstack/react-table + @tanstack/react-virtual

**`src/entrypoints/sidepanel/components/preview/ProductTable.tsx`**:

Uses `@tanstack/react-table` for column definitions, sorting, filtering, selection, and visibility. Uses `@tanstack/react-virtual` for windowed rendering — only visible rows are in the DOM, ensuring smooth scrolling even with 300+ products.

```
┌──────────────────────────────────────────────────────────┐
│ [🔍 Search products...]     [Columns ▾]  [Export ▾]     │  ← hairline input + outlined btns
│                                                          │
│  67 products · 12 selected · 3 with gaps                │  ← serif 12px muted text
│──────────────────────────────────────────────────────────│  ← hairline-soft divider
│ ☐ │  Title         │  ASIN     │  Price  │ Rating │ Prime │  ← sans 12px 600, uppercase tracking
│───┼────────────────┼───────────┼─────────┼────────┼───────│
│ ☐ │  Echo Dot 5th… │  B09B…    │  $49.99 │  4.7   │  ✓   │  ← serif 13px, ink
│ ☐ │  Fire TV Sti…  │  B09X…    │  $24.99 │  4.5   │  ✓   │
│ ☐ │  Unknown Prod… │  B0XX…    │  —      │  —     │      │  ← hairline (muted, gap indicator)
│ ☐ │  Echo Show 8   │  B09N…    │  $129.  │  4.6   │  ✓   │
│   │  ...virtualized rows below...                        │  ← only ~15-20 in DOM
│──────────────────────────────────────────────────────────│
│ [Export All]   [Export Selected]   [Export Filtered]     │  ← outlined + clay CTA
└──────────────────────────────────────────────────────────┘
```

**Virtualization strategy:**
- Fixed row height (e.g., 48px) for predictable scrolling
- `useVirtualizer` from `@tanstack/react-virtual` wraps the table body
- Container has a fixed height (fills available side panel space)
- Only ~15-20 rows rendered in DOM at any time, regardless of total count
- Smooth scroll behavior maintained even at 500+ products

Column definitions:

| Column | Key | Sortable | Default Visible |
|--------|-----|----------|-----------------|
| Checkbox | `select` | No | Yes |
| Title | `title` | Yes | Yes |
| ASIN | `asin` | Yes | Yes |
| Price | `price` | Yes | Yes |
| Currency | `currency` | No | No |
| Rating | `rating` | Yes | Yes |
| Reviews | `reviewCount` | Yes | Yes |
| Image | `imageUrl` | No | Yes (thumbnail) |
| Sponsored | `isSponsored` | Yes | Yes |
| Prime | `isPrime` | Yes | Yes |
| Brand | `brand` | Yes | No |
| Availability | `availability` | Yes | No |
| Seller | `seller` | Yes | No |
| Description | `description` | No | No |
| Features | `features` | No | No |
| URL | `url` | No | No |
| Collected At | `collectedAt` | Yes | No |

### Step 4.3: Missing Fields Detection

Each row checks which enabled fields are null/undefined/empty. Rows with missing fields get a warning indicator. A summary badge at the top shows "X products with missing fields."

### Step 4.4: Duplicate Detection

When duplicate detection is enabled:
- Products with the same ASIN or URL are highlighted
- A badge shows "X duplicates found"
- Users can select and remove duplicates

### Step 4.5: Row Actions

- **Select/Select All** via checkboxes
- **Remove selected** via toolbar button
- **Click row** to open product URL in new tab

### Step 4.6: Column Selector Component

**`src/entrypoints/sidepanel/components/preview/ColumnSelector.tsx`**:

Dropdown/modal with checkboxes for each column. Uses tanstack's `column.toggleVisibility()`.

### Step 4.7: useProducts Hook

**`src/entrypoints/sidepanel/hooks/useProducts.ts`**:

```typescript
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db/database';

export function useProducts(sessionKey?: string) {
  const products = useLiveQuery(
    () => sessionKey
      ? db.products.where('sessionKey').equals(sessionKey).toArray()
      : db.products.orderBy('collectedAt').reverse().toArray(),
    [sessionKey]
  );

  const totalCount = products?.length ?? 0;
  const duplicateCount = /* count products with duplicate ASINs */ 0;
  const missingFieldsCount = /* count products with null required fields */ 0;

  const removeProducts = useCallback(async (ids: number[]) => {
    await db.products.bulkDelete(ids);
  }, []);

  const clearAll = useCallback(async () => {
    await db.products.clear();
  }, []);

  return {
    products: products ?? [],
    totalCount,
    duplicateCount,
    missingFieldsCount,
    isLoading: products === undefined,
    removeProducts,
    clearAll,
  };
}
```

---

## 7. Phase 5: Export & Download System

**Goal:** Export collected data as CSV, Excel (.xlsx), or copy to clipboard. Support all/selected/filtered exports. Customizable columns and file names.

### Step 5.1: Export Options UI

**Export format selector:** CSV | Excel | Copy

**Export scope:** All Products | Selected Rows | Filtered Results

**Column selection:** Reuse ColumnSelector component

**File name input:** Default `pphunt-export-{date}` with editable text field

### Step 5.2: CSV Export

**`src/lib/utils/export-csv.ts`**:

```typescript
import { saveAs } from 'file-saver';

export function exportToCSV(
  products: Product[],
  columns: string[],
  options: { filename: string; includeBOM: boolean }
): void {
  const headers = columns.join(',');
  const rows = products.map(product =>
    columns.map(col => {
      const value = product[col as keyof Product];
      if (value === null || value === undefined) return '';
      if (Array.isArray(value)) return `"${value.join('; ')}"`;
      const str = String(value);
      // Escape quotes and wrap in quotes if contains comma/quote/newline
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',')
  );

  const csv = [headers, ...rows].join('\n');
  // UTF-8 BOM for Excel compatibility
  const bom = options.includeBOM ? '\uFEFF' : '';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  saveAs(blob, `${options.filename}.csv`);
}
```

### Step 5.3: Excel Export

**`src/lib/utils/export-xlsx.ts`**:

```typescript
import * as XLSX from 'xlsx';

export function exportToXLSX(
  products: Product[],
  columns: string[],
  options: { filename: string; sheetName: string }
): void {
  const data = products.map(product => {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      const value = product[col as keyof Product];
      row[col] = Array.isArray(value) ? value.join('; ') : value ?? '';
    }
    return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, options.sheetName);

  // Auto-size columns
  const colWidths = columns.map(col => ({
    wch: Math.max(
      col.length,
      ...data.map(row => String(row[col] ?? '').length)
    ),
  }));
  worksheet['!cols'] = colWidths;

  XLSX.writeFile(workbook, `${options.filename}.xlsx`);
}
```

### Step 5.4: Copy to Clipboard

**`src/lib/utils/export-clipboard.ts`**:

Exports as TSV (tab-separated values) for pasting into spreadsheets:

```typescript
export async function copyToClipboard(
  products: Product[],
  columns: string[],
): Promise<void> {
  const headers = columns.join('\t');
  const rows = products.map(product =>
    columns.map(col => {
      const value = product[col as keyof Product];
      if (Array.isArray(value)) return value.join('; ');
      return value?.toString() ?? '';
    }).join('\t')
  );

  const tsv = [headers, ...rows].join('\n');
  await navigator.clipboard.writeText(tsv);
}
```

### Step 5.5: useExport Hook

**`src/entrypoints/sidepanel/hooks/useExport.ts`**:

```typescript
export function useExport() {
  const [isExporting, setIsExporting] = useState(false);
  const [lastExportStatus, setLastExportStatus] = useState<'success' | 'error' | null>(null);

  const exportData = useCallback(async (
    format: 'csv' | 'xlsx' | 'clipboard',
    products: Product[],
    columns: string[],
    filename: string,
  ) => {
    setIsExporting(true);
    try {
      switch (format) {
        case 'csv':
          exportToCSV(products, columns, { filename, includeBOM: true });
          break;
        case 'xlsx':
          exportToXLSX(products, columns, { filename, sheetName: 'Products' });
          break;
        case 'clipboard':
          await copyToClipboard(products, columns);
          break;
      }
      setLastExportStatus('success');
    } catch (err) {
      setLastExportStatus('error');
    } finally {
      setIsExporting(false);
    }
  }, []);

  return { exportData, isExporting, lastExportStatus };
}
```

---

## 8. Phase 6: Settings UI

**Goal:** Build a settings overlay within the side panel (slides over the current view). The settings icon in the header triggers it. Animate in/out for polish.

### Step 6.0: Settings Access Pattern

The settings UI is an overlay panel that slides in from the right within the side panel. The settings gear icon in the header triggers it. Animate with a 200ms ease-out slide. The overlay has:
- A back/close button at the top left (labeled "← Back")
- Scrollable content area for all settings sections
- Uses surface-card (#efe9de) background to differentiate from the main canvas
- All inputs use the PPHunt input style: hairline border, 8px radius, no shadow, ink text

### Step 6.1: Settings Schema

**`src/lib/schemas/settings.ts`**:

```typescript
import { z } from 'zod';

export const SettingsSchema = z.object({
  id: z.literal('default').default('default'),
  version: z.number().int().default(1),

  // General
  defaultMode: z.enum(['manual', 'automatic']).default('manual'),
  defaultTargetCount: z.number().int().min(1).max(1000).default(50),

  // Automatic scrolling
  scrollSpeed: z.number().int().min(100).max(3000).default(800),        // px per scroll
  scrollInterval: z.number().int().min(200).max(5000).default(500),     // ms between scrolls
  waitAfterScroll: z.number().int().min(500).max(10000).default(1500),  // ms wait for content

  // Field toggles
  enabledFields: z.object({
    title: z.boolean().default(true),
    asin: z.boolean().default(true),
    url: z.boolean().default(true),
    price: z.boolean().default(true),
    currency: z.boolean().default(true),
    rating: z.boolean().default(true),
    reviewCount: z.boolean().default(true),
    imageUrl: z.boolean().default(true),
    isSponsored: z.boolean().default(true),
    isPrime: z.boolean().default(true),
    brand: z.boolean().default(true),
    availability: z.boolean().default(true),
    seller: z.boolean().default(false),
    description: z.boolean().default(false),
    features: z.boolean().default(false),
  }).default({}),

  // Behavior
  duplicateDetection: z.boolean().default(true),
  notifications: z.boolean().default(true),

  // Export defaults
  exportFormat: z.enum(['csv', 'xlsx', 'clipboard']).default('csv'),
  exportFilename: z.string().default('pphunt-export'),
  includeBOM: z.boolean().default(true),
});

export type AppSettings = z.infer<typeof SettingsSchema>;
```

### Step 6.2: Settings Panel Layout

```
┌──────────────────────────────────────────┐
│                                          │
│  ← Settings                              │  ← serif 16px, ink, back arrow
│  ─────────────────────────────────────── │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  General                           │  │  ← sans 12px 600, uppercase, hairline
│  │                                    │  │
│  │  Default Mode                      │  │
│  │  ┌──────────┐ ┌──────────────┐    │  │  ← pill toggle (same as collection)
│  │  │  Manual   │ │  Automatic   │    │  │
│  │  └──────────┘ └──────────────┘    │  │
│  │                                    │  │
│  │  Default Target                    │  │
│  │  [________________]               │  │  ← hairline input, 8px radius
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  Automatic Scrolling               │  │
│  │                                    │  │
│  │  Scroll Speed       [800 px]      │  │
│  │  ████████░░░░                      │  │  ← clay slider track
│  │                                    │  │
│  │  Wait After Scroll  [1500 ms]     │  │
│  │  ██████████░░                      │  │
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  Data Fields                       │  │
│  │                                    │  │
│  │  ☑ Title        ☑ ASIN            │  │  ← clay checkmarks (custom styled)
│  │  ☑ URL           ☑ Price          │  │
│  │  ☑ Rating        ☑ Review Count   │  │
│  │  ☑ Image URL     ☑ Sponsored      │  │
│  │  ☑ Prime         ☑ Brand          │  │
│  │  ☑ Availability  ☐ Seller         │  │
│  │  ☐ Description   ☐ Features       │  │
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  Restore Default Settings          │  │  ← outlined, clay text, 8px bottom
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

### Step 6.3: Settings Persistence

Settings are stored in IndexedDB (via Dexie) with `id: 'default'` as the key. The `useSettings` hook uses `useLiveQuery` to keep the UI reactive. On first launch, the Zod schema defaults are used.

---

## 9. Phase 7: Session Persistence & Recovery

**Goal:** Preserve collected data across side panel close/reopen, tab reload, and browser restart.

### Step 7.1: Session Management

Each collection session has a unique key: `{tabId}_{timestamp}`. Products are associated with a session key.

**`src/lib/db/sessions.ts`**:

```typescript
export async function createSession(tabId: number, url: string): Promise<string> {
  const sessionKey = `${tabId}_${Date.now()}`;
  await db.sessions.put({
    id: sessionKey,
    tabId,
    url,
    status: 'idle',
    startedAt: new Date().toISOString(),
    targetCount: 0,
    collectedCount: 0,
  });
  return sessionKey;
}

export async function updateSessionStatus(
  sessionKey: string,
  status: CollectionStatus,
  counts?: { collected: number; target: number }
): Promise<void> {
  await db.sessions.update(sessionKey, {
    status,
    ...counts,
    updatedAt: new Date().toISOString(),
  });
}

export async function getActiveSession(): Promise<SessionState | undefined> {
  return db.sessions
    .where('status')
    .anyOf(['collecting', 'paused'])
    .first();
}
```

### Step 7.2: Side Panel Lifecycle

The side panel persists across tab switches natively (Chrome Side Panel API). However, it can be closed and reopened. On mount:

1. Check for an active session in IndexedDB
2. If found, restore the collection state (status, counts, mode)
3. If the content script is still running on the target tab, re-establish message channel
4. If the tab was closed or navigated away, mark session as interrupted

### Step 7.3: Tab Reload / Browser Restart Recovery

When the side panel reopens after a tab reload:
1. Read the last active session from IndexedDB
2. Check if the target tab still exists and is still on Amazon
3. If yes, re-inject content script (WXT handles this for open tabs via `runAt`)
4. Restore state: collected count, target, mode
5. Offer user to "Resume" or "Start New" collection

When the browser restarts:
1. All sessions in IndexedDB survive
2. On side panel open, show the last session's data in the preview
3. Collection status is set to "interrupted" — user can start fresh

### Step 7.4: Collection History

**`src/lib/db/history.ts`**:

Store completed/interrupted sessions in a history table. The History tab shows:
- Date/time of each session
- Target vs collected count
- Source URL
- Option to view products or delete the session

### Step 7.5: Side Panel Persistent Across Tabs

The Chrome Side Panel API guarantees the panel stays open when switching tabs. The side panel uses `browser.tabs.onActivated` to track which tab is active:

```typescript
// In side panel
export function useActiveTab() {
  const [activeTab, setActiveTab] = useState<{ id: number; url: string; isAmazon: boolean } | null>(null);

  useEffect(() => {
    const updateTab = async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        setActiveTab({
          id: tab.id!,
          url: tab.url ?? '',
          isAmazon: isAmazonUrl(tab.url ?? ''),
        });
      }
    };

    updateTab();

    browser.tabs.onActivated.addListener(updateTab);
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.url) updateTab();
    });

    return () => {
      browser.tabs.onActivated.removeListener(updateTab);
    };
  }, []);

  return activeTab;
}
```

---

## 10. Phase 8: Error Handling, Edge Cases & Polish

**Goal:** Handle all error cases gracefully, add polish, and ensure production readiness.

### Step 8.1: Non-Amazon Page Detection

When the active tab is not an Amazon page, the collection panel shows warm editorial guidance (not cold error states):

```
┌──────────────────────────────────────────┐
│                                          │
│  ┌────────────────────────────────────┐  │  ← surface-card bg, 16px radius
│  │                                    │  │
│  │  Navigate to an Amazon page        │  │  ← serif 16px, ink
│  │                                    │  │
│  │  PPHunt collects products from     │  │  ← serif 13px, muted (hairline)
│  │  Amazon search results, product    │  │
│  │  details, and category pages.      │  │
│  │                                    │  │
│  │  Any Amazon regional site works —  │  │
│  │  .com, .co.uk, .de, and others.   │  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

### Step 8.2: CAPTCHA / Sign-In Detection

The content script checks for CAPTCHA and sign-in prompts on every mutation batch and before each auto-scroll step. When detected:

1. Send `CONTENT_ERROR` with code `CAPTCHA` or `SIGN_IN` to background
2. Background forwards to side panel
3. Side panel pauses collection and shows a warm, clear notice (not a harsh error):

```
┌────────────────────────────────────────────┐
│                                            │
│  Page requires attention                   │  ← serif 14px, ink
│                                            │
│  A CAPTCHA was detected on the active      │  ← serif 13px, muted
│  page. Solve it in the browser, then       │
│  resume collection here.                   │
│                                            │
│  [Resume Collection →]                     │  ← clay filled button, 8px bottom
│                                            │
└────────────────────────────────────────────┘
```

4. Auto-scroll is paused (not stopped) — user solves CAPTCHA, then clicks Resume

### Step 8.3: Loading Delay Handling

When auto-scrolling, the scroll controller waits for new content to appear:
- Uses MutationObserver to detect DOM changes
- Has a configurable `waitAfterScroll` (default 1500ms)
- If no new products after `maxWaitForNew` (default 5000ms), assumes end of page
- If a loading spinner is detected (`.s-result-list-placeholder, .aok-hidden`), waits longer

### Step 8.4: Missing Fields Handling

When a product has missing fields (null/undefined):
- The product is still collected and stored
- In the preview table, missing fields show as "—" with a subtle warning color
- The summary shows "X products with missing fields"
- Missing fields do NOT count as errors — they're expected (e.g., sponsored items may lack ratings)

### Step 8.5: Tab Closed During Collection

If the user closes the Amazon tab during collection:
1. Background detects `tabs.onRemoved` for the collection tab
2. Stops the collection session
3. Side panel shows a quiet inline notice (not an intrusive alert): "Tab closed — X products were saved."
4. Products remain in IndexedDB, accessible from the Preview tab

### Step 8.6: Content Script Injection Failure

If the content script fails to inject (CSP restrictions, about:blank, etc.):
1. Background catches the error from `browser.scripting.executeScript`
2. Notifies side panel with clear error message
3. Does not crash — user can try again

### Step 8.7: Rate Limiting & Polite Scraping

For automatic mode:
- Default scroll interval: 500ms (configurable: 200ms–5000ms)
- Default wait after scroll: 1500ms (configurable: 500ms–10000ms)
- No concurrent page fetches
- Random jitter (±20%) on scroll intervals to appear more human-like

### Step 8.8: Manifest V3 Compliance

- Service worker does NOT store state in memory (uses IndexedDB)
- All persistent state in IndexedDB or chrome.storage
- Minimum permissions: `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`
- `host_permissions` limited to Amazon domains only
- No remote code execution
- No `eval()` or `new Function()`

### Step 8.9: Accessibility

- All interactive elements are keyboard-navigable
- ARIA labels on buttons, progress bars, and status indicators
- Color is not the sole indicator (icons + text alongside colors)
- Focus management when switching tabs in the side panel

### Step 8.10: Toast / Notification Pattern (PPHunt Style)

Toasts are quiet inline notices that slide in from the bottom of the side panel, not floating overlays. They follow the PPHunt aesthetic:

```
┌──────────────────────────────────────────┐
│                                          │
│  ┌────────────────────────────────────┐  │  ← surface-card bg, 8px radius, 1px hairline
│  │                                    │  │
│  │  ● 67 products collected           │  │  ← serif 13px, moss dot, ink text
│  │    Ready to preview or export.     │  │  ← serif 12px, hairline text
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

- No colored background strips (no green/red/yellow banners)
- The dot color does the semantic work: moss = success, clay = needs attention
- Auto-dismiss after 5 seconds, or user clicks to dismiss
- Error notices use the same card treatment but with a clay dot and slightly more prominent text

### Step 8.11: Design System Compliance Checklist

Before shipping, verify every screen against these PPHunt rules:

- [ ] No `#ffffff` (pure white) as a background — always `#faf9f5` or `#f0eee6`
- [ ] No `box-shadow` on any element — depth via surface tones and 1px borders
- [ ] No cool grays (`gray-500`, `slate-*`) — use `hairline` (#b0aea5) and `hairline-soft` (#e8e6dc)
- [ ] No saturated blues/greens as backgrounds — `sky` and `moss` are for dots and text only
- [ ] Clay (#d97757) appears only on the primary CTA — never on decorative elements
- [ ] Body text is `font-serif` (Lora) — `font-sans` (Poppins) is for UI chrome only
- [ ] All links are underlined — persistent, not reveal-on-hover
- [ ] Buttons use 8px bottom-radius (the PPHunt signature) — never pill/rounded-full
- [ ] Inputs use 1px hairline border, 8px radius, no shadow — focus state changes border to ink
- [ ] Spacing uses the 4px scale: 4, 8, 12, 16, 20, 24, 32, 48, 64
- [ ] Status indicators are colored dots + serif labels — no emoji, no colored badges
- [ ] All surfaces are flat solid fills — no gradients, no glows, no color washes

---

## 11. Data Schemas & Type Definitions

### Product Type

```typescript
// src/types/product.ts

export interface Product {
  id?: number;                    // Auto-incremented by Dexie
  asin: string;                   // Amazon Standard Identification Number
  url: string;                    // Full product URL
  title?: string;                 // Product title
  price?: number | null;          // Numeric price (parsed)
  currency?: string;              // Currency symbol/code ($, €, £, etc.)
  rating?: number | null;         // Star rating (0-5)
  reviewCount?: number | null;    // Number of reviews
  imageUrl?: string | null;       // Product image URL
  isSponsored?: boolean;          // Sponsored listing flag
  isPrime?: boolean;              // Prime eligible flag
  brand?: string | null;          // Brand name
  availability?: string | null;   // "In Stock", "Only 3 left", etc.
  seller?: string | null;         // Seller name
  description?: string | null;    // Product description text
  features?: string[];            // Bullet-point features
  collectedAt: string;            // ISO datetime when collected
  sessionKey: string;             // Session this product belongs to
  source: 'search' | 'detail' | 'category'; // Where it was scraped from
}
```

### Session State

```typescript
// src/types/session.ts

export type CollectionStatus = 'idle' | 'collecting' | 'paused' | 'completed' | 'error' | 'interrupted';
export type CollectionMode = 'manual' | 'automatic';

export interface SessionState {
  id: string;                     // Unique session key
  tabId: number;                  // Chrome tab ID
  url: string;                    // URL of the Amazon page
  status: CollectionStatus;
  mode: CollectionMode;
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface CollectionHistory {
  id?: number;
  sessionKey: string;
  url: string;
  mode: CollectionMode;
  targetCount: number;
  collectedCount: number;
  startedAt: string;
  completedAt: string;
  status: CollectionStatus;
}
```

### Settings Type

```typescript
// src/types/settings.ts
// (Derived from Zod schema in src/lib/schemas/settings.ts)

export interface AppSettings {
  id: 'default';
  version: number;
  defaultMode: 'manual' | 'automatic';
  defaultTargetCount: number;
  scrollSpeed: number;
  scrollInterval: number;
  waitAfterScroll: number;
  enabledFields: Record<string, boolean>;
  duplicateDetection: boolean;
  notifications: boolean;
  exportFormat: 'csv' | 'xlsx' | 'clipboard';
  exportFilename: string;
  includeBOM: boolean;
}
```

---

## 12. Amazon CSS Selectors Reference

### Search Results Page (`/s?k=...`)

| Field | Selector | Notes |
|-------|----------|-------|
| Product card | `[data-component-type="s-search-result"]` | Most stable — use `data-asin` attr for ASIN |
| ASIN | `data-asin` attribute on card | Always present on search result cards |
| Title | `h2 a span` | Inside the link |
| Title link | `h2 a[href]` | For building full URL |
| Current price | `.a-price[data-a-color="base"] .a-offscreen` | Accessibility text, most stable |
| Price fallback | `span.a-price > span.a-offscreen` | When the above fails |
| List price | `.a-price[data-a-color="secondary"] .a-offscreen` | Strikethrough price |
| Rating | `span.a-icon-alt` | Returns "4.4 out of 5 stars" |
| Review count | `[aria-label$="ratings"]` or `[aria-label$="rating"]` | aria-label based |
| Image | `img.s-image` | `src` attribute |
| Sponsored | `.puis-sponsored-label-text` | Presence = sponsored |
| Prime | `[aria-label*="Prime"]` | Presence = Prime eligible |
| Next page | `.s-pagination-next` | For pagination detection |

### Product Detail Page (`/dp/<ASIN>`)

| Field | Selector | Notes |
|-------|----------|-------|
| ASIN | URL path `/dp/<ASIN>` | Regex: `/dp/([A-Z0-9]{10})` |
| Title | `#productTitle` | Strip whitespace |
| Price | `span.a-price span.a-offscreen` | Or whole/fraction split |
| Rating | `#acrPopover` `title` attribute | "4.7 out of 5 stars" |
| Review count | `#acrCustomerReviewText` | "12,450 ratings" |
| Availability | `#availability` | "In Stock", "Only 3 left" |
| Brand | `#bylineInfo` | "Visit the X Store" |
| Features | `#feature-bullets .a-list-item` | Bullet points array |
| Description | `#productDescription p` | Full description text |
| Hero image | `#landingImage` | `src` or `data-old-hires` attr |
| Seller | `#sellerProfileTriggerId` | Seller name link |
| Breadcrumb | `#wayfinding-breadcrumbs_feature_div a` | Category path |

---

## 13. Messaging Protocol

### Message Flow Diagrams

**Start Collection:**
```
Side Panel                    Background                   Content Script
    │                             │                             │
    │──START_COLLECTION──────────►│                             │
    │                             │──COLLECT_PRODUCTS──────────►│
    │                             │                             │──parse DOM
    │                             │                             │──start observer/scroll
    │                             │◄──PRODUCTS_COLLECTED────────│
    │                             │──store in IndexedDB         │
    │◄──UPDATE_PROGRESS───────────│                             │
    │                             │                             │
    │ (repeats as new products    │                             │
    │  are discovered)            │                             │
```

**Pause/Resume:**
```
Side Panel                    Background                   Content Script
    │                             │                             │
    │──PAUSE_COLLECTION──────────►│                             │
    │                             │──PAUSE_SCROLLING───────────►│
    │                             │                             │──pause observer
    │◄──UPDATE_PROGRESS───────────│                             │
    │  (status: 'paused')         │                             │
    │                             │                             │
    │──RESUME_COLLECTION─────────►│                             │
    │                             │──RESUME_SCROLLING──────────►│
    │                             │                             │──resume observer
    │◄──UPDATE_PROGRESS───────────│                             │
    │  (status: 'collecting')     │                             │
```

**CAPTCHA Detected:**
```
Side Panel                    Background                   Content Script
    │                             │                             │
    │                             │                             │──CAPTCHA found
    │                             │◄──CONTENT_ERROR─────────────│
    │                             │  (code: 'CAPTCHA')          │
    │◄──UPDATE_PROGRESS───────────│                             │
    │  (status: 'error',          │                             │
    │   error: 'CAPTCHA')         │                             │
    │                             │                             │
    │ [User solves CAPTCHA]       │                             │
    │                             │                             │
    │──RESUME_COLLECTION─────────►│──RESUME_SCROLLING──────────►│
```

**Tab Switch:**
```
Side Panel                    Background                   Content Script (Tab A)
    │                             │                             │
    │ [User switches to Tab B]    │                             │
    │                             │                             │
    │◄──TAB_CHANGED───────────────│                             │
    │  (tabId: B, isAmazon: true) │                             │
    │                             │                             │
    │ [Shows: "Different Amazon   │                             │
    │  page. Start new collection │                             │
    │  or switch back?"]          │                             │
```

---

## 14. Dependencies

### Production Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^18 | UI framework |
| `react-dom` | ^18 | React DOM renderer |
| `dexie` | ^4 | IndexedDB wrapper |
| `dexie-react-hooks` | ^1 | `useLiveQuery` for reactive DB queries |
| `zustand` | ^5 | Lightweight state management |
| `zod` | ^3 | Schema validation |
| `@tanstack/react-table` | ^8 | Headless table component |
| `@tanstack/react-virtual` | ^3 | Windowed rendering for large tables |
| `xlsx` | ^0.18 | Excel file generation |
| `file-saver` | ^2 | File download helper |

### Font Loading

PPHunt's type stack uses Poppins, Lora, and JetBrains Mono. Load via Google Fonts in the side panel HTML:

```html
<!-- src/entrypoints/sidepanel/index.html -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Lora:wght@400;600&family=JetBrains+Mono&display=swap" rel="stylesheet" />
```

**Note:** For the side panel (an extension page with full network access), Google Fonts load normally. The preview sandbox won't show them (expected), but the real side panel will render them correctly. If Google Fonts are unavailable, the fallback chain in `fontFamily` handles it: Lora → Georgia, Poppins → Inter → system-ui.

### Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `wxt` | ^0.20 | Extension framework |
| `@wxt-dev/module-react` | ^1 | WXT React module |
| `typescript` | ^5.5 | Language (strict mode) |
| `tailwindcss` | ^4 | Utility-first CSS |
| `postcss` | ^8 | CSS processing |
| `autoprefixer` | ^10 | CSS vendor prefixes |
| `@types/file-saver` | ^2 | Type definitions |
| `@types/chrome` | ^0.0 | Chrome API types |
| `vitest` | ^2 | Unit testing |
| `@testing-library/react` | ^14 | React testing utilities |

---

## 15. Build & Development Commands

```bash
# Install dependencies
pnpm install

# Development (with HMR)
pnpm dev
# WXT opens Chrome with the extension loaded automatically

# Prepare types (run after adding new entrypoints)
pnpm wxt prepare

# Build for production
pnpm build

# Build for specific browser
pnpm build --browser chrome
pnpm build --browser firefox

# Run tests
pnpm test

# Type checking
pnpm tsc --noEmit

# Lint
pnpm lint
```

---

## Implementation Order Summary

| Phase | Focus | Key Deliverables | Est. Effort |
|-------|-------|-----------------|-------------|
| 1 | Scaffolding | WXT project, Dexie DB, Zod schemas, Zustand stores, Tailwind (PPHunt tokens), Google Fonts, global.css, all entrypoints bootstrapped | Day 1-2 |
| 2 | Content Script | Page detection, CSS selectors, search/detail parsers, dedup engine, scroll controller, messaging | Day 3-5 |
| 3 | Side Panel UI | Collection panel, mode/target selectors, controls, progress bar, status badges, tab detection | Day 6-7 |
| 4 | Preview Table | @tanstack/react-table, column selection, search, sort, row selection, missing fields, duplicate badges | Day 8-9 |
| 5 | Export | CSV, Excel, clipboard export, column selection, filename customization | Day 10 |
| 6 | Settings | Settings UI, field toggles, scroll config, restore defaults, persistence | Day 11-12 |
| 7 | Persistence | Session recovery, tab reload handling, history, cross-tab awareness | Day 13-14 |
| 8 | Polish | Error handling, CAPTCHA detection, accessibility, edge cases, testing | Day 15-17 |

---

## Potential Challenges & Mitigations

| Challenge | Risk | Mitigation |
|-----------|------|------------|
| Amazon changes DOM selectors | High | Centralized `selectors.ts` file with versioned selectors; easy to update one file |
| Content script not injecting on SPA navigation | Medium | Use `document_idle` + MutationObserver to handle dynamic page loads |
| Service worker killed during long collection | Medium | All state in IndexedDB; collection driven by content script; SW is just a router |
| Auto-scroll hitting "infinite scroll" vs pagination | Medium | Detect page type: if pagination exists, navigate pages; if infinite scroll, keep scrolling |
| Side panel loses connection to content script after tab reload | Low | Background re-establishes connection; session state in IndexedDB provides continuity |
| Large product datasets (300+ products) in preview table | Low | Use virtualization (`@tanstack/react-virtual`) for the table if needed |
| Amazon rate-limiting or blocking | Medium | Configurable delays, jitter, human-like scroll patterns; no rapid-fire requests |
| `useLiveQuery` performance with many products | Low | Dexie handles this well; use `.offset()` and `.limit()` for pagination if needed |