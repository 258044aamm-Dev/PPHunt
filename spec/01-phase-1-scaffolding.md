# Phase 1: Project Scaffolding & Core Infrastructure

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Get a working WXT + React + TypeScript project with all dependencies installed, all entrypoints bootstrapped, the Dexie database defined, Zod schemas for products and messages, Zustand stores initialized, Tailwind configured with PPHunt design tokens, Google Fonts loaded, and the dev environment with HMR confirmed working. At the end of this phase, clicking the extension icon opens an empty side panel, and the content script logs to the console on Amazon pages.

---

## Steps

### Step 1.1: Initialize the WXT Project

Run the WXT scaffolder. Select the React template and pnpm as the package manager. WXT creates the project skeleton with entrypoints, a basic manifest, and React wiring.

After scaffolding, set `srcDir: 'src'` in `wxt.config.ts` and move the generated `entrypoints/`, `assets/`, and `public/` directories under `src/`.

### Step 1.2: Install All Dependencies

**Production dependencies:**
- `dexie` and `dexie-react-hooks` — IndexedDB wrapper and React live query hook
- `zustand` — lightweight state management for the side panel
- `zod` — schema validation for messages, settings, and products
- `@tanstack/react-table` — headless table component for the preview
- `@tanstack/react-virtual` — windowed rendering for large product lists
- `xlsx` — Excel file generation
- `file-saver` — browser file download helper

**Development dependencies:**
- `@types/file-saver` — type definitions for file-saver
- `@types/chrome` — Chrome API type definitions
- `tailwindcss`, `postcss`, `autoprefixer` — CSS processing (if not already included by WXT template)

### Step 1.3: Configure wxt.config.ts

Set the manifest fields:
- Name: "PPHunt"
- Description: "Collect, preview, and export Amazon product data with care."
- Version: "1.0.0"
- Permissions: `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`
- Host permissions: all `*://*.amazon.{com,co.uk,de,fr,ca,co.jp,in,com.au,es,it}/*`
- Action: empty (WXT handles icon click → side panel via `setPanelBehavior`)
- Icons: 16, 32, 48, 128px

WXT automatically adds the `sidePanel` permission and `side_panel.default_path` when it detects a `sidepanel/` entrypoint directory. No need to declare these manually.

### Step 1.4: Configure Tailwind with PPHunt Design Tokens

The Tailwind config replaces all generic color tokens with PPHunt's earth-tone palette:

**Colors (11 tokens):**
- `ink` (#141413) — primary text, dark surfaces
- `canvas` (#f0eee6) — page background
- `surface` (#faf9f5) — cards, elevated surfaces
- `surface-card` (#efe9de) — feature cards
- `surface-soft` (#f5f0e8) — section dividers
- `hairline` (#b0aea5) — borders, muted text, placeholders
- `hairline-soft` (#e8e6dc) — subtle borders
- `clay` (#d97757) — primary accent, CTAs only
- `clay-active` (#b85a3e) — clay hover/press state
- `sky` (#6a9bcc) — secondary accent, info, links
- `moss` (#788c5d) — tertiary accent, success

**Font families:**
- `serif`: Lora → Georgia → Source Serif Pro → Charter
- `sans`: Poppins → Inter → system-ui → Arial
- `mono`: JetBrains Mono → ui-monospace → Menlo

**Spacing:** 4px base unit — 4, 8, 12, 16, 20, 24, 32, 48, 64

**Border radius:** 8px (sm — buttons/inputs), 12px (md — small cards), 16px (lg — containers), 24px (xl — large cards)

**Font sizes:** All in `px` (not `rem`) to prevent host-page font-size interference in the side panel. xs=12px, sm=13px, base=14px, lg=16px, xl=18px, 2xl=20px.

**Box shadow:** No shadow tokens. The only allowed value is `none`. Depth is communicated through surface tone and 1px borders.

**Important Tailwind rules:**
- No `gray-*`, `slate-*`, or `zinc-*` colors — use hairline tokens
- No `blue-*`, `green-*`, `red-*` as backgrounds — sky and moss are for text/dots only
- `clay` appears only on primary CTAs, never on decorative elements

### Step 1.5: Load Google Fonts

In the side panel HTML shell (`index.html`), add preconnect links and a stylesheet link for all three font families:
- Poppins (weights 400, 500, 600)
- Lora (weights 400, 600)
- JetBrains Mono (weight 400)

The link uses `display=swap` so the UI renders immediately with fallback fonts, then swaps when the web fonts load.

### Step 1.6: Create global.css

The global CSS file sets up the PPHunt base layer:

- Tailwind directives (`@tailwind base/components/utilities`)
- Body: Lora as font-family, ink as color, canvas as background, antialiased rendering
- Links: sky color, persistent underline, 2px offset, ink on hover
- Scrollbar: 6px wide, canvas track, hairline thumb, ink thumb on hover
- Font size locked to 16px on html to prevent host-page interference

### Step 1.7: Bootstrap All Entrypoints

**Background service worker** (`background.ts`):
- Call `browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so the extension icon opens the side panel
- Register a `runtime.onMessage` listener as the message routing hub (implementation in Phase 2)
- Register `tabs.onActivated` and `tabs.onUpdated` listeners for tab tracking (implementation in Phase 3)

**Side panel** (`sidepanel/index.html`, `sidepanel/main.tsx`):
- HTML shell with Google Fonts links and a `<div id="root">` mount point
- React entry that mounts `<App />` inside `<React.StrictMode>`
- Imports `global.css`

**Content script** (`amazon.content.ts`):
- `matches` array covering all 10 Amazon regional domains
- `runAt: 'document_idle'`
- `main` function logs `[PPHunt] Content script loaded on: {url}` to console
- Registers a `runtime.onMessage` listener (implementation in Phase 2)

### Step 1.8: Set Up the Dexie Database

Define the database with four tables and typed entity access:

**Products table:**
- Auto-increment `id` primary key
- Indexes on: `asin`, `url`, `sessionKey`, `collectedAt`, compound `[sessionKey+asin]`
- The compound index enables fast "is this ASIN already in this session?" lookups

**Sessions table:**
- String `id` primary key (format: `{tabId}_{timestamp}`)
- Indexes on: `tabId`, `status`, `startedAt`

**Settings table:**
- String `id` primary key (always `'default'`)

**History table:**
- Auto-increment `id` primary key
- Indexes on: `sessionKey`, `startedAt`

### Step 1.9: Define Zod Schemas

**Product schema** — validates all product fields:
- Required: `asin` (non-empty string), `url` (valid URL), `collectedAt` (ISO datetime), `sessionKey` (string), `source` (enum: 'search' | 'detail' | 'category')
- Optional: `title`, `price` (number | null), `currency`, `rating` (0–5 | null), `reviewCount` (int | null), `imageUrl` (URL | null), `isSponsored` (boolean), `isPrime` (boolean), `brand`, `availability`, `seller`, `description`, `features` (string array)

**Settings schema** — validates all user preferences with defaults:
- General: `defaultMode` ('manual'|'automatic'), `defaultTargetCount` (1–1000, default 50)
- Scrolling: `scrollSpeed` (100–3000, default 800), `scrollInterval` (200–5000, default 500), `waitAfterScroll` (500–10000, default 1500)
- Fields: `enabledFields` object with boolean for each of 15 fields
- Behavior: `duplicateDetection` (default true), `notifications` (default true)
- Export: `exportFormat` ('csv'|'xlsx'|'clipboard'), `exportFilename`, `includeBOM`

**Message schemas** — see Phase 2 / Messaging Protocol spec for full details. Each message type gets its own Zod schema with a discriminated union on `type`.

### Step 1.10: Initialize Zustand Stores

**Collection store** — holds collection mode, status, target count, collected count, error message, active tab info. Provides actions: `setMode`, `setStatus`, `setTarget`, `setCollectedCount`, `setError`, `setActiveTab`, `reset`.

**UI store** — holds active tab (Collect/Preview/History), settings overlay open/closed. Provides actions: `setActiveTab`, `toggleSettings`.

### Step 1.11: Create Extension Icons

Four PNG icons (16, 32, 48, 128px) using the Clay color (#d97757) on transparent background. A simple, recognizable shape — a magnifying glass or target reticle works well for a "hunt" metaphor. An SVG logo wordmark "PPHunt" in Poppins 600, clay color.

### Step 1.12: Verify Dev Environment

Run `pnpm dev`. WXT opens Chrome with the extension loaded. Verify:
- Clicking the extension icon opens the side panel (even if empty)
- The content script logs to the console when navigating to any Amazon page
- HMR works for side panel React components (edit a file, see the change without reloading)
- `pnpm wxt prepare` generates types without errors

---

## Deliverables

At the end of Phase 1:
- Working WXT project with React, TypeScript, Tailwind (PPHunt tokens), and HMR
- Dexie database with 4 tables and typed access
- Zod schemas for Product, Settings, and message types
- Zustand stores for collection and UI state
- All three entrypoints bootstrapped and communicating
- Google Fonts loaded in the side panel
- Extension icons in Clay
- Dev environment confirmed working