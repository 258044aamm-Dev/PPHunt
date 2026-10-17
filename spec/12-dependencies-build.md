# Dependencies & Build Commands

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Production Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^18 | UI framework for the side panel |
| `react-dom` | ^18 | React DOM renderer |
| `dexie` | ^4 | IndexedDB wrapper with typed tables |
| `dexie-react-hooks` | ^1 | `useLiveQuery` hook for reactive DB queries in React |
| `zustand` | ^5 | Lightweight state management for side panel UI state |
| `zod` | ^3 | Schema validation for messages, settings, and products |
| `@tanstack/react-table` | ^8 | Headless table component (sorting, filtering, selection) |
| `@tanstack/react-virtual` | ^3 | Windowed rendering for large product tables |
| `xlsx` | ^0.18 | Excel (.xlsx) file generation |
| `file-saver` | ^2 | Browser file download helper |

## Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `wxt` | ^0.20 | Extension framework (scaffolding, manifest, HMR, build) |
| `@wxt-dev/module-react` | ^1 | WXT module for React integration |
| `typescript` | ^5.5 | Language (strict mode) |
| `tailwindcss` | ^4 | Utility-first CSS framework |
| `postcss` | ^8 | CSS processing pipeline |
| `autoprefixer` | ^10 | CSS vendor prefix insertion |
| `@types/file-saver` | ^2 | Type definitions for file-saver |
| `@types/chrome` | ^0.0 | Chrome API type definitions |
| `vitest` | ^2 | Unit testing framework |
| `@testing-library/react` | ^14 | React component testing utilities |

## Font Loading

Three font families are loaded via Google Fonts in the side panel HTML shell:

- **Poppins** (weights 400, 500, 600) — UI chrome: buttons, labels, navigation, headings
- **Lora** (weights 400, 600) — Body text, display text, descriptions, editorial voice
- **JetBrains Mono** (weight 400) — Code, ASIN values, metadata

Loaded with `display=swap` for instant render with fallback fonts. The fallback chains are:
- Lora → Georgia → Source Serif Pro → Charter → serif
- Poppins → Inter → system-ui → Arial → sans-serif
- JetBrains Mono → ui-monospace → Menlo → monospace

If Google Fonts are unavailable (offline, blocked), the fallback chain handles it gracefully.

---

## Build & Development Commands

### Install Dependencies

```
pnpm install
```

### Development Mode (with HMR)

```
pnpm dev
```

WXT opens Chrome with the extension loaded automatically. Changes to side panel React components are reflected instantly via HMR. Content script changes trigger an extension reload.

### Prepare Types

```
pnpm wxt prepare
```

Run after adding or renaming entrypoints. Generates TypeScript types for WXT's auto-imports (`defineBackground`, `defineContentScript`, `browser`, etc.) and updates the generated `tsconfig.json`.

### Build for Production

```
pnpm build
```

Outputs to `dist/`. Generates the `manifest.json` automatically from `wxt.config.ts`. The build is tree-shaken and minified.

### Build for Specific Browser

```
pnpm build --browser chrome
pnpm build --browser firefox
```

Chrome build uses Manifest V3. Firefox build uses Manifest V2 (WXT handles the conversion automatically).

### Run Tests

```
pnpm test
```

Runs all unit tests with Vitest. Tests cover selectors, parsers, dedup, price parser, URL extraction, CSV export, and message schema validation.

### Type Checking

```
pnpm tsc --noEmit
```

Runs the TypeScript compiler in check-only mode. Reports type errors without emitting files.

### Lint

```
pnpm lint
```

Runs the configured linter (ESLint or Biome, depending on the project setup).

---

## WXT Configuration

The `wxt.config.ts` file is the single source of truth for the extension manifest and build configuration.

### Key Settings

- `srcDir: 'src'` — all source code under the `src/` directory
- `outDir: 'dist'` — production build output
- `modules: ['@wxt-dev/module-react']` — enables React integration

### Manifest Fields

- `name`: "PPHunt"
- `description`: "Collect, preview, and export Amazon product data with care."
- `version`: "1.0.0"
- `permissions`: `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`
- `host_permissions`: 10 Amazon regional domain patterns
- `action`: empty object (WXT handles icon click → side panel)
- `icons`: 16, 32, 48, 128px PNG icons

### What WXT Auto-Generates

WXT automatically adds:
- `side_panel.default_path` (from the `sidepanel/` entrypoint directory)
- `sidePanel` permission (from the sidepanel entrypoint)
- `background.service_worker` (from the `background.ts` file)
- `content_scripts` entries (from the `amazon.content.ts` file with its `matches` array)

No manual manifest editing is needed for these fields.

---

## TypeScript Configuration

TypeScript runs in strict mode. The `tsconfig.json` extends the WXT-generated config:

- `allowImportingTsExtensions: true` — allows `.ts`/`.tsx` imports without extensions
- `jsx: 'react-jsx'` — React JSX transform
- `baseUrl: '.'` with path alias `@/*` → `./src/*`

Path aliases are configured in `wxt.config.ts` (not in `tsconfig.json`), because WXT overwrites `tsconfig.json` on `wxt prepare`.

---

## Tailwind Configuration

Configured with the PPHunt design token palette (11 colors), custom font families (3 stacks), 4px-base spacing scale, and radius scale (4 values). All font sizes in `px` to prevent host-page `rem` interference.

PostCSS pipeline: `tailwindcss` → `autoprefixer`.

---

## Production Build Output

The `dist/` directory contains:
- `manifest.json` — auto-generated by WXT
- `background.js` — service worker bundle
- `content-scripts/amazon.content.js` — content script bundle
- `sidepanel/` — side panel HTML, JS, and CSS bundles
- Icons and public assets

The extension can be loaded as an unpacked extension from `dist/` for testing, or zipped for Chrome Web Store submission.