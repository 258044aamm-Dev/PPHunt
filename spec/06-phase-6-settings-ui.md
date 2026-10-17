# Phase 6: Settings UI

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Build a settings overlay that slides in from the right within the side panel when the user clicks the gear icon in the header. The settings UI lets users configure default collection mode, target count, auto-scroll behavior, which data fields to collect, duplicate detection, notifications, and export defaults. All settings are persisted in IndexedDB and validated with Zod. A "Restore Default Settings" option resets everything.

---

## Settings Access Pattern

The settings UI is an overlay panel that slides in from the right within the side panel. It covers the main content area (Collect/Preview/History tabs). The animation is a 200ms ease-out slide from the right edge.

The overlay has:
- A back arrow ("← Settings") at the top left in serif 16px, ink — clicking it slides the overlay back out
- A scrollable content area for all settings sections
- A `surface-card` (#efe9de) background to visually differentiate from the main canvas
- All inputs use the standard PPHunt style: hairline border, 8px radius, no shadow, ink text

No "Save" button — settings auto-save on change (debounced at 500ms). A subtle "Saved" toast appears briefly when settings are persisted.

---

## Settings Panel Layout

```
┌──────────────────────────────────────────┐
│                                          │
│  ← Settings                              │  ← serif 16px, ink, back arrow
│  ─────────────────────────────────────── │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  UI MODE                           │  │  ← sans 12px 600, uppercase, hairline
│  │                                    │  │
│  │  Default opening behavior          │  │
│  │  ┌────────────┐ ┌────────────┐    │  │  ← pill toggle
│  │  │  Side      │ │  Page      │    │  │
│  │  │  Panel     │ │  Overlay   │    │  │
│  │  └────────────┘ └────────────┘    │  │
│  │                                    │  │
│  │  Clicking the extension icon       │  │  ← serif 12px, hairline
│  │  opens this mode directly.         │  │
│  │  Hold Shift + click for chooser.   │  │
│  │                                    │  │
│  │  Overlay default width             │  │
│  │  [400 px]  ████████░░░░           │  │  ← range slider, 300–800
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  GENERAL                           │  │  ← sans 12px 600, uppercase, hairline
│  │                                    │  │
│  │  Default Mode                      │  │
│  │  ┌──────────┐ ┌──────────────┐    │  │  ← pill toggle
│  │  │  Manual   │ │  Automatic   │    │  │
│  │  └──────────┘ └──────────────┘    │  │
│  │                                    │  │
│  │  Default Target                    │  │
│  │  [________________]               │  │  ← hairline input, 8px radius
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  AUTOMATIC SCROLLING               │  │
│  │                                    │  │
│  │  Scroll Speed       [800 px]      │  │
│  │  ████████░░░░                      │  │  ← clay slider track
│  │                                    │  │
│  │  Wait After Scroll  [1500 ms]     │  │
│  │  ██████████░░                      │  │
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  DATA FIELDS                       │  │
│  │                                    │  │
│  │  ☑ Title        ☑ ASIN            │  │  ← clay checkmarks
│  │  ☑ URL           ☑ Price          │  │
│  │  ☑ Rating        ☑ Review Count   │  │
│  │  ☑ Image URL     ☑ Sponsored      │  │
│  │  ☑ Prime         ☑ Brand          │  │
│  │  ☑ Availability  ☐ Seller         │  │
│  │  ☐ Description   ☐ Features       │  │
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  BEHAVIOR                          │  │
│  │                                    │  │
│  │  ☑ Duplicate detection             │  │
│  │  ☑ Notifications                   │  │
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  EXPORT DEFAULTS                   │  │
│  │                                    │  │
│  │  Format:     [CSV ▾]              │  │  ← select dropdown
│  │  Filename:   [pphunt-export    ]  │  │
│  │  ☑ Include UTF-8 BOM              │  │
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  Restore Default Settings          │  │  ← outlined, clay text
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

---

## Settings Sections

### UI Mode

**Default opening behavior** — Pill toggle between Side Panel and Page Overlay. When set, clicking the extension icon opens that mode directly without showing the chooser popup. The user can always override by holding Shift + click, which forces the popup to appear. Changing this setting writes `pphuntDefaultMode` to `chrome.storage.local` and updates the popup's `default_popup` manifest behavior via `chrome.action.setPopup`.

**Overlay default width** — Range slider (300–800px). Controls the initial width of the overlay drawer when it first opens. After the user resizes by dragging, the dragged width is saved and overrides this setting for future opens.

When switching between modes (e.g., from overlay to side panel), the setting updates immediately. A subtle hint below the toggle: "Hold Shift + click the icon for the chooser popup."

### General

**Default Mode** — Pill toggle between Manual and Automatic. Same component as the collection panel's mode selector. This sets the mode that's pre-selected when the side panel opens.

**Default Target Count** — Number input, same as the collection panel's custom target. Min 1, max 1000. This value pre-fills the target selector on the collection panel.

### Automatic Scrolling

These settings only apply when mode is Automatic.

**Scroll Speed** — Range slider (100–3000 px). Controls how far the page scrolls in each step. Default: 800px. The slider uses clay for the filled track and canvas for the unfilled track. The current value is displayed in a sans 12px label to the right: "800 px".

**Scroll Interval** — Range slider (200–5000 ms). Controls the time between scroll steps. Default: 500ms. Lower = faster collection but higher risk of triggering Amazon's anti-scraping.

**Wait After Scroll** — Range slider (500–10000 ms). Controls how long to wait after each scroll for new content to load. Default: 1500ms. Higher = more reliable but slower.

All three sliders update the settings in real time (debounced at 500ms for persistence).

### Data Fields

A two-column grid of checkboxes, one for each product field. When a field is unchecked:
- It will not be collected during future scrapes
- In the preview table, the column for that field is hidden by default
- Existing data for that field is preserved in IndexedDB (not deleted)

**15 fields:**
Title, ASIN, URL, Price, Currency, Rating, Review Count, Image URL, Sponsored, Prime, Brand, Availability, Seller, Description, Features

Default enabled: Title, ASIN, URL, Price, Rating, Review Count, Image URL, Sponsored, Prime, Brand, Availability
Default disabled: Seller, Description, Features (these are more expensive to extract and less commonly needed)

### Behavior

**Duplicate Detection** — Toggle. When enabled, the scraper skips products whose ASIN or URL has already been collected in the current session. When disabled, all products are collected (useful if the user wants to see price/availability changes across page loads).

**Notifications** — Toggle. When enabled, in-panel toasts are shown for events like "target reached", "CAPTCHA detected", "tab closed". When disabled, only in-panel status updates (no toasts).

> **Scope note (remediation SAD-167, 2026-10):** this toggle deliberately governs **in-panel toasts only**. Chrome-level notifications (`chrome.notifications`) are not implemented and the `notifications` permission is intentionally not requested — adding it would trigger a new permission prompt on update, a store-review and user-trust cost disproportionate to the benefit. This is a documented, deliberate scope reduction of the original "Chrome notifications and in-panel toasts" requirement.

### Export Defaults

**Export Format** — Select dropdown: CSV, Excel, Clipboard. Default: CSV. This pre-selects the format in the export dropdown on the preview table.

**Export Filename** — Text input. Default: "pphunt-export". The date is appended automatically on export (e.g., "pphunt-export-2026-10-14.csv").

**Include UTF-8 BOM** — Toggle. Default: enabled. When enabled, CSV files are prepended with the UTF-8 BOM character for Excel compatibility with international characters.

### Danger Zone

**Restore Default Settings** — An outlined button with clay text. Clicking it shows a confirmation popover: "Restore all settings to defaults? This cannot be undone." Confirming resets all settings to the Zod schema's default values.

---

## Settings Persistence

Settings are stored in IndexedDB (via Dexie) in the `settings` table with `id: 'default'`. On first launch, the Zod schema's `.parse({})` call produces an object with all default values, which is written to IndexedDB.

The `useSettings` hook:

1. Uses `useLiveQuery` to subscribe to the settings record
2. Returns: `settings` (the full settings object), `isLoading`
3. Provides: `updateSettings(partial)` — merges a partial update into the existing settings, validates with Zod, writes to IndexedDB
4. Provides: `restoreDefaults()` — resets to schema defaults
5. Auto-save: every `updateSettings` call is debounced at 500ms and writes to IndexedDB

---

## First-Launch Experience

On the very first launch (no settings record in IndexedDB):
1. The Zod schema generates default values via `.parse({})`
2. These are written to IndexedDB
3. The side panel opens with default settings already active
4. No setup wizard or onboarding flow — the defaults are sensible enough to use immediately

---

## Deliverables

At the end of Phase 6:
- Settings overlay that slides in from the right over the side panel content
- UI Mode settings: default opening behavior (Side Panel / Overlay), overlay default width
- General settings: default mode and target count
- Automatic scrolling settings: scroll speed, interval, and wait time with range sliders
- Data field toggles: 15 fields in a two-column checkbox grid
- Behavior settings: duplicate detection and notifications toggles
- Export defaults: format, filename, UTF-8 BOM toggle
- Danger zone: restore defaults with confirmation
- Auto-save on change with Zod validation
- useSettings hook with live query subscription and partial updates
- First-launch experience with schema defaults written to IndexedDB