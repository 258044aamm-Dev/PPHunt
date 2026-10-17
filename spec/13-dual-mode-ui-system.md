# PPHunt — Dual-Mode UI System

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Side Panel + Overlay with Mode Chooser

---

## What This Spec Covers

A new UI system where PPHunt offers two rendering modes:

1. **Side Panel** — the native Chrome Side Panel API panel, docked to the right edge of the browser chrome. Persistent across tab switches. Does not overlay page content.
2. **Overlay** — a content-script-injected drawer that slides out from the right edge of the page, on top of the content. Collapsible to a small floating trigger button.

When the user clicks the extension icon, a small popup menu appears asking which mode to use. The user's choice is remembered for future clicks. A collapsible floating trigger button is always visible on the right edge of the page when the overlay mode is available.

---

## Architecture Overview

```
User clicks extension icon
         │
         ▼
┌─────────────────────────────┐
│   Popup (mode chooser)      │  ← tiny popup, 200×80px
│   ┌─────────┐ ┌───────────┐ │
│   │ Side    │ │ Overlay   │ │
│   │ Panel   │ │           │ │
│   └─────────┘ └───────────┘ │
│   [✓ Remember my choice]    │
└─────────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌──────────────────────┐
│  Chrome Side    │  │  Content Script      │
│  Panel API      │  │  Overlay (Shadow DOM) │
│                 │  │                      │
│  - Docked right │  │  - Slides from right │
│  - Persistent   │  │  - Collapsible       │
│  - Browser UI   │  │  - Floating trigger  │
│  - Full API     │  │  - Page-level        │
│  access         │  │  - Shadow isolated   │
└─────────────────┘  └──────────────────────┘
```

### Key Architectural Decisions

**Chrome forces a choice on icon click**: either the icon opens a popup, or it opens the side panel — never both. To offer a choice, we use the popup as the chooser. The popup is a tiny menu, not the main UI.

**The overlay uses WXT's `createShadowRootUi`** with `position: 'inline'` and a fixed-position host element. This gives full CSS isolation from the host page via Shadow DOM.

**Both modes render the same React app**. The shared component library (`CollectionPanel`, `PreviewPanel`, `SettingsPanel`, etc.) works in both contexts. A thin adapter layer handles the few differences (scroll container, width constraints, collapse behavior).

**The floating trigger button is always present** on Amazon pages when overlay mode is available, regardless of which mode is currently active. This gives the user a persistent way to open the overlay without going through the extension icon.

---

## Mode 1: Chrome Side Panel

### How It Works

The standard Chrome Side Panel API. The panel is a full extension page rendered in Chrome's built-in side panel. It persists across tab switches and has access to all Chrome extension APIs.

### Behavior

- Opens via `chrome.sidePanel.open({ tabId })` called from the popup or background
- Docks to the right edge of the browser (user can move it to the left in Chrome settings)
- Resizable by the user (drag the left border)
- Stays open when switching tabs (Chrome Side Panel API guarantees this)
- Has full access to `chrome.tabs`, `chrome.storage`, `browser.runtime`, etc.
- Renders the React app in a standard HTML page (not Shadow DOM)
- Loads Google Fonts normally (it's a full extension page)
- Width: determined by the user's resize (typically 300–400px)

### When to Use

- The user wants PPHunt to stay open while they browse multiple tabs
- The user is collecting products across several Amazon searches
- The user prefers a panel that doesn't overlap page content
- The user wants to resize the panel

### Limitations

- Not available in full-screen mode (Chrome hides the side panel)
- Takes space from the page content (page shrinks)
- Chrome-only feature (Firefox has a different sidebar API)

---

## Mode 2: Content Script Overlay

### How It Works

A content script injects a React app into the Amazon page via WXT's `createShadowRootUi`. The UI is a fixed-position drawer on the right edge of the page, rendered inside a Shadow DOM for full CSS isolation.

### Visual States

**Collapsed state** — a small floating trigger button:

```
                                              ┌──────┐
                                              │      │
                                              │  ◀   │  ← 40×48px, ink bg, surface text
                                              │      │
                                              └──────┘
                                              ← fixed right edge, vertically centered
```

**Expanded state** — a full drawer sliding out from the right:

```
┌──────────────────────────────────────┬──────────┐
│                                      │          │
│  PPHunt                    [✕] [⬇]  │    ◀     │  ← the trigger button moves
│                                      │          │
│  ─────────────────────────────────── │          │
│                                      │          │
│  Collect    Preview    History       │          │
│  ───────                            │          │
│                                      │          │
│  [Collection panel content]          │          │
│                                      │          │
│                                      │          │
└──────────────────────────────────────┴──────────┘
← 400px wide, full viewport height, slides from right ←
← semi-transparent backdrop behind (optional)         ←
```

**Transition**: 300ms ease-out slide from right. The drawer starts at `translateX(100%)` and animates to `translateX(0)`.

### Trigger Button

- Size: 40px wide × 48px tall
- Position: fixed to the right edge, vertically centered
- Style: ink (#141413) background, surface (#faf9f5) chevron icon (◀)
- Border-radius: 8px on the left side only (flat on the right, flush with viewport edge)
- Click: toggles the drawer open/closed
- Always visible on Amazon pages when overlay mode is available
- Draggable vertically (optional enhancement — user can reposition the button)

### Drawer Panel

- Width: 400px default, **user-resizable** (see Resizing section below)
- Height: 100vh
- Position: fixed, right: 0, top: 0
- Background: canvas (#f0eee6)
- Shadow: a subtle left border (1px hairline) to separate from page content
- No box-shadow (PPHunt design rules)
- Overflow: auto (scrollable content)
- z-index: 2147483647 (maximum, above all page content)

### Close / Collapse Controls

Two buttons in the header:
- **[✕] Close** — collapses the drawer back to the trigger button
- **[⬇] Switch to Side Panel** — closes the overlay and opens the Chrome side panel instead (mode switch)

The user can also:
- Press Escape to collapse
- Click the trigger button to toggle
- Click outside the drawer on the backdrop (if backdrop is enabled)

### Shadow DOM Isolation

The overlay renders inside a Shadow DOM via WXT's `createShadowRootUi`. This means:
- The host page's CSS cannot affect PPHunt's styles
- PPHunt's CSS cannot leak into the host page
- Tailwind classes work normally inside the shadow root
- Google Fonts are loaded inside the shadow root's stylesheet
- Event isolation: keyboard events inside the shadow root don't trigger page shortcuts (use `isolateEvents` in WXT config)

### When to Use

- The user wants to see PPHunt alongside the page without shrinking the content
- The user is on a single Amazon page and wants quick access
- The user is in full-screen mode (the side panel doesn't work in full-screen)
- The user prefers a floating, dismissible interface

### Limitations

- Only visible on the current tab (not persistent across tab switches)
- The drawer overlays page content (may obscure product listings on the right side)
- Content script may not inject on all Amazon subpages (e.g., iframes, certain SPA routes)
- Google Fonts may need to be inlined if the shadow root blocks external stylesheet loading

---

## Popup: Mode Chooser

### Trigger

The extension icon in the Chrome toolbar. Clicking it opens a small popup (not the side panel, not the overlay — just a chooser).

### Manifest Configuration

```json
{
  "action": {
    "default_popup": "popup.html",
    "default_title": "PPHunt"
  },
  "side_panel": {
    "default_path": "sidepanel/index.html"
  }
}
```

`openPanelOnActionClick` is NOT set (defaults to false). The popup handles the icon click. The side panel is opened programmatically from the popup.

### Popup Layout

```
┌──────────────────────────────┐
│                              │
│  Open PPHunt                 │  ← Poppins 500, 14px, ink
│                              │
│  ┌────────────┐ ┌──────────┐│
│  │  Side      │ │  Page    ││
│  │  Panel     │ │  Overlay ││
│  └────────────┘ └──────────┘│
│                              │
│  ☑ Remember my choice        │  ← Lora 12px, hairline
│  (sets as default in         │
│   Settings → UI Mode)        │
│                              │
└──────────────────────────────┘
```

- Width: 260px, Height: ~120px
- Two buttons, equal width, outlined style (PPHunt secondary)
- "Side Panel" button: opens the Chrome side panel
- "Page Overlay" button: sends a `TOGGLE_OVERLAY` message to the content script
- Checkbox: "Remember my choice" — when checked, writes `pphuntDefaultMode` to `chrome.storage.local`. This becomes the setting shown in Settings → UI Mode.
- Below the checkbox: a subtle hint in serif 11px hairline: "(sets as default in Settings → UI Mode)"

### When the Popup Shows vs. Is Skipped

| `pphuntDefaultMode` | Shift held? | What happens |
|---------------------|-------------|-------------|
| `null` (no pref) | No | Popup shows — user picks a mode |
| `null` (no pref) | Yes | Popup shows (same as above) |
| `'sidepanel'` | No | Popup skipped — side panel opens directly |
| `'sidepanel'` | Yes | Popup shows — Shift overrides the default |
| `'overlay'` | No | Popup skipped — overlay toggles directly |
| `'overlay'` | Yes | Popup shows — Shift overrides the default |

### Popup-to-Mode Handoff

**Side Panel chosen:**
1. Popup calls `chrome.sidePanel.open({ tabId })`
2. Popup closes automatically (Chrome behavior when opening side panel)

**Page Overlay chosen:**
1. Popup sends a `TOGGLE_OVERLAY` message to the content script in the active tab
2. If the content script overlay is not yet injected, the background injects it via `browser.scripting.executeScript`
3. The overlay drawer opens
4. Popup closes

---

## Floating Trigger Button

### Purpose

A persistent, always-visible button on the right edge of Amazon pages. It provides quick access to the overlay without going through the extension icon and popup.

### Appearance

- Width: 40px, Height: 48px
- Background: ink (#141413)
- Icon: a left-pointing chevron (◀) in surface (#faf9f5), 16px
- Border-radius: 8px left, 0 right (flush with viewport edge)
- Position: fixed, right: 0, vertically centered (calc(50vh - 24px))
- z-index: 2147483647
- Cursor: pointer
- Transition: background 150ms ease (ink → clay on hover)

### Behavior

- **Click**: toggles the overlay drawer open/closed
- **When drawer is open**: the chevron rotates 180° (▶) to indicate "click to close"
- **When drawer is closed**: the chevron points left (◀) to indicate "click to open"
- **Drag** (optional): user can drag the button up or down to reposition it. Position is saved to `chrome.storage.local`.

### Visibility Rules

- Visible on all Amazon pages (matched by the content script's `matches` patterns)
- Hidden on non-Amazon pages
- Always visible regardless of which mode is currently active (side panel or overlay)
- If the side panel is the active mode, clicking the trigger button opens the overlay anyway (gives quick access without closing the side panel)

---

## Mode Switching

### From Overlay to Side Panel

The overlay header has a "Switch to Side Panel" button (or icon). Clicking it:
1. Collapses the overlay drawer
2. Opens the Chrome side panel via `chrome.sidePanel.open({ tabId })`
3. Saves the preference if "Remember" was checked
4. The floating trigger button remains visible (for quick overlay access)

### From Side Panel to Overlay

The side panel header has a "Switch to Overlay" button. Clicking it:
1. Closes the Chrome side panel
2. Sends a message to the content script to open the overlay
3. Saves the preference if "Remember" was checked

### Both Open Simultaneously

It's possible to have both the side panel AND the overlay open at the same time. They share the same IndexedDB data, so products collected in one are visible in the other. This is useful if the user wants a persistent reference (side panel) plus a quick-access tool (overlay).

When both are open, a subtle indicator in each header shows "Also open in [other mode]" with a link to switch focus.

---

## Shared React App

Both modes render the same React component tree. The difference is the mounting context:

| Aspect | Side Panel | Overlay |
|--------|-----------|---------|
| Mount target | `document.getElementById('root')` in HTML page | Shadow DOM container via `createShadowRootUi` |
| CSS loading | Global CSS import + Google Fonts link in HTML | CSS injected into shadow root (`cssInjectionMode: 'ui'`) |
| Font loading | Google Fonts via `<link>` in HTML | Google Fonts via `@import` in shadow root CSS, or inlined |
| Width | User-resizable (300–500px typical) | Fixed 400px |
| Scroll container | `body` or `#root` | Shadow DOM container |
| Close behavior | Chrome closes it (user clicks X) | Collapse to trigger button |
| Persistence | Tab-persistent | Tab-scoped (re-injects on navigation) |

### Adapter Layer

A thin adapter provides context about the current rendering mode and dimensions:

```
UIProvider
├── mode: 'sidepanel' | 'overlay'
├── width: number              ← live container width from ResizeObserver
├── breakpoint: 'narrow' | 'default' | 'wide'
├── onClose: () => void
├── onSwitchMode: () => void
└── children: <App />
```

Components read this context to adjust behavior:
- The header shows different close/switch buttons depending on mode
- The overlay mode hides the "Switch to Overlay" button (already in overlay)
- The side panel mode hides the "Switch to Side Panel" button (already in side panel)
- Components use `width` and `breakpoint` to decide layout (single-column vs two-column, which table columns to show, spacing scale)

---

## Settings Integration

### UI Mode Setting

In the Settings panel, a dedicated section:

```
┌────────────────────────────────────┐
│                                    │
│  UI MODE                           │  ← sans 12px 600, uppercase, hairline
│                                    │
│  Default opening behavior          │
│  ┌────────────┐ ┌────────────┐    │
│  │  Side      │ │  Page      │    │  ← pill toggle
│  │  Panel     │ │  Overlay   │    │
│  └────────────┘ └────────────┘    │
│                                    │
│  When set, clicking the extension  │  ← serif 12px, hairline
│  icon opens this mode directly.    │
│  Hold Shift + click to see the     │
│  chooser popup instead.            │
│                                    │
│  ──────────────────────────────── │
│                                    │
│  Overlay width                     │
│  [400 px]  ████████░░░░           │  ← range slider, 300–800
│                                    │
│  Or drag the panel edge to resize. │  ← serif 12px, hairline
│                                    │
│  ──────────────────────────────── │
│                                    │
│  Trigger button position           │
│  ☑ Lock to center of viewport      │  ← toggle
│  ☐ Remember custom position        │
│                                    │
└────────────────────────────────────┘
```

### How the Setting Works

**"Default opening behavior"** is a pill toggle with two options:

**Side Panel** (default):
- Clicking the extension icon opens the Chrome side panel directly (no popup)
- The side panel is persistent across tab switches
- The overlay is still accessible via the floating trigger button on Amazon pages
- To switch to overlay: click "Switch to Overlay" in the side panel header, or click the floating trigger button

**Page Overlay**:
- Clicking the extension icon sends a `TOGGLE_OVERLAY` message to the content script
- If the overlay is closed, it opens. If open, it closes (toggle behavior)
- If the content script isn't injected yet, the background injects it first
- The side panel is still accessible via "Switch to Side Panel" in the overlay header

### Override: Shift + Click

When the user holds Shift and clicks the extension icon, the popup chooser always appears regardless of the saved preference. This lets the user:
- Try the other mode without changing their default
- Access the chooser to change their preference
- Recover if they accidentally set a mode they don't want

The background detects Shift via the `action.onClicked` listener — it checks `chrome.storage.local` for the preference. If Shift is held (detected by a one-time keydown listener or by the popup always being set when Shift is held), it falls through to the popup.

**Implementation detail**: To detect Shift+click, keep `default_popup` set to the popup HTML in the manifest. In the background, on `runtime.onInstalled` or `runtime.onStartup`, check the saved preference:
- If preference is set AND it's not a Shift+click → call `chrome.action.setPopup({ popup: '' })` to disable the popup, then use `action.onClicked` to open the preferred mode directly
- If preference is not set OR it's a Shift+click → leave `default_popup` enabled so the popup shows

This requires toggling `setPopup` dynamically. Chrome allows this — `chrome.action.setPopup({ popup: '' })` disables the popup (making `action.onClicked` fire), and `chrome.action.setPopup({ popup: 'popup.html' })` re-enables it.

### Preference Storage

The preference is stored in `chrome.storage.local`:

```
Key: pphuntDefaultMode
Value: 'sidepanel' | 'overlay' | null
```

- `null`: no preference set → popup always shows (first-launch behavior)
- `'sidepanel'`: icon click opens side panel directly
- `'overlay'`: icon click toggles overlay directly

The popup's "Remember my choice" checkbox writes this value. The Settings UI's pill toggle also writes this value. They stay in sync.

### First-Launch Behavior

On the very first launch (no `pphuntDefaultMode` in storage):
1. The popup always shows when the icon is clicked
2. The user picks a mode and optionally checks "Remember"
3. If "Remember" is checked, `pphuntDefaultMode` is set and future clicks skip the popup
4. If "Remember" is not checked, `pphuntDefaultMode` stays null and the popup shows every time

The user can always change this in Settings → UI Mode, or use Shift+click to access the chooser.

---

## Overlay Width Setting

A range slider in Settings → UI Mode controls the overlay's default width:
- Range: 300–800px
- Default: 400px
- This value is used when the overlay first opens (before the user resizes it manually)
- After the user resizes by dragging, the dragged width is saved and overrides this setting
- The "Or drag the panel edge to resize" hint tells the user they can also resize interactively

---

## Trigger Button Position Setting

Two options for the floating trigger button's vertical position:

**Lock to center of viewport** (default): the button is always at `calc(50vh - 24px)`. It stays centered even if the user scrolls.

**Remember custom position**: if the user drags the trigger button up or down, the position is saved to `chrome.storage.local` as `pphuntTriggerTop` (as a CSS value like `340px`). The button restores to this position on next page load.

---

## Per-Tab Mode Override

Advanced: the side panel can show different content per tab via `chrome.sidePanel.setOptions({ tabId, path })`. The overlay is always per-tab (injected into the current page). This means:

- Side panel: one instance, shared across tabs, shows context for the active tab
- Overlay: one instance per tab, independent, shows context for that specific page

---

## Content Script: Overlay Injection

### Entrypoint

A dedicated content script entrypoint for the overlay: `pphunt-overlay.content.ts`. This is separate from the main `amazon.content.ts` (which handles scraping logic).

The overlay content script:
- Matches Amazon domains only
- Runs at `document_idle`
- Creates the floating trigger button immediately (always visible on Amazon pages)
- Does NOT auto-mount the full drawer — waits for a user action (trigger click or message from background)
- Uses `createShadowRootUi` with `position: 'inline'` and custom fixed positioning CSS

#### Resizing

The overlay drawer has a resize handle on its left edge. The user can drag it to make the panel wider or narrower.

**Resize handle:**
- Position: left edge of the drawer, 6px wide hit area (the visual handle is 1px — the hairline border itself)
- Cursor: `col-resize` when hovering over the handle zone
- On hover: the handle zone shows a surface-soft (#f5f0e8) background, 6px wide strip on the left edge
- On drag: the cursor stays `col-resize` globally (set on `document.body` during resize to prevent cursor flicker)

**Constraints:**
- Minimum width: 300px (below this, the UI components would be too cramped)
- Maximum width: 80% of the viewport width (never covers the entire page)
- Default width: 400px (first launch)
- Width persists across sessions: saved to `chrome.storage.local` as `pphuntOverlayWidth`

**Resize behavior:**
- The drawer's right edge stays fixed (anchored to the viewport right). Dragging the left edge changes the width.
- All internal content reflows responsively as the width changes. The preview table, collection panel, and settings all use responsive Tailwind classes.
- During resize, a `resizing` CSS class is applied to the drawer that disables transitions (prevents animation lag during drag).
- On mouse up, the `resizing` class is removed and the final width is saved.

**Resize handle rendering:**

```
┌──────────────────────────────────────┬──────────┐
│ │                                  │          │
│ │  PPHunt                  [✕] [⬇]│    ◀     │
│ │                                  │          │
│ │  ────────────────────────────────│          │
│ │                                  │          │
│ │  [Collection panel content]      │          │
│ │                                  │          │
│6px│                                │          │
│ ← this strip is the drag zone →   │          │
└──────────────────────────────────────┴──────────┘
```

The 6px strip on the left is invisible normally. On hover, it gets a `surface-soft` background and `col-resize` cursor. During drag, it stays highlighted.

---

## Side Panel Resizing

The Chrome Side Panel is natively resizable — the user drags the left edge of the panel to resize it. Chrome handles this; PPHunt doesn't need custom code for it.

However, PPHunt should respect the side panel's current width for responsive layout:
- The side panel React app reads its container width via `ResizeObserver`
- Components adapt their layout at breakpoints: narrow (< 320px), default (320–420px), wide (> 420px)
- The preview table hides less important columns at narrower widths
- The collection panel stacks mode and target selectors vertically at narrow widths

---

## Popup Resizing

The popup is a small fixed-size menu (240×110px). It does not need to be resizable — it's a transient chooser, not a workspace. Chrome popups have a maximum width constraint (~800px) and auto-size to content.

---

## Responsive Layout Strategy

Both the side panel and overlay share the same responsive breakpoints:

| Breakpoint | Width | Layout Behavior |
|-----------|-------|----------------|
| Narrow | < 320px | Single column. Stack all controls vertically. Hide table columns to essential 4 (title, ASIN, price, prime). Compact spacing (8px gaps). |
| Default | 320–420px | Two-column for mode/target selectors. Show 6–8 table columns. Standard spacing (16px gaps). |
| Wide | > 420px | All controls comfortable. Show all visible columns. Generous spacing (24px gaps). |

All components use Tailwind responsive classes (`sm:`, `md:`) mapped to these breakpoints. The adapter layer provides the current width via `ResizeObserver`, so components can also use JavaScript for more complex responsive decisions (e.g., collapsing the table to a card list at very narrow widths).

---

## Width Persistence

| Context | Where Width Is Saved | Default | Min | Max |
|---------|---------------------|---------|-----|-----|
| Overlay drawer | `chrome.storage.local` key `pphuntOverlayWidth` | 400px | 300px | 80vw |
| Side panel | Chrome remembers natively (per-user, not per-extension) | ~340px | ~200px | ~50% viewport |
| Floating trigger | `chrome.storage.local` key `pphuntTriggerTop` | 50vh (centered) | 48px from top | 48px from bottom |
| Popup | Not saved (fixed size) | 240px | — | — |

---

## Shadow DOM CSS

The overlay's CSS is injected into the shadow root. Key styles:

- The host element: `position: fixed !important; right: 0; top: 0; height: 100vh; z-index: 2147483647; pointer-events: auto;` — width is set dynamically from `chrome.storage.local` (default 400px), updated on resize
- The trigger button: `position: fixed; right: 0; top: 50%; transform: translateY(-50%); width: 40px; height: 48px; z-index: 2147483647;`
- Resize handle: `position: absolute; left: 0; top: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 1;` — transparent by default, surface-soft on hover, highlighted during drag
- Animation: `@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }` — disabled when `.resizing` class is present (add `* { transition: none !important; }` to host during resize to prevent animation lag)
- Backdrop (optional): `position: fixed; inset: 0; background: rgba(20, 20, 19, 0.15); z-index: 2147483646;`

### Event Isolation

Use WXT's `isolateEvents` option to prevent keyboard events inside the shadow root from bubbling to the page:

```
isolateEvents: ['keydown', 'keyup', 'keypress', 'input', 'wheel']
```

This prevents Amazon's keyboard shortcuts from firing when the user types in PPHunt's search inputs.

---

## Popup Entry Point

### File

`src/entrypoints/popup/index.html` + `src/entrypoints/popup/main.tsx`

### UI

A tiny React app — just the mode chooser. Two buttons, a checkbox, and the PPHunt name. Uses the same Tailwind config and PPHunt design tokens.

### Logic

1. On mount, check `chrome.storage.local` for `pphuntPreferredMode`
2. If found AND the preference is set, skip the chooser — directly open that mode and close the popup
3. If not found, show the chooser UI
4. On "Side Panel" click: call `chrome.sidePanel.open({ tabId })`, close popup
5. On "Page Overlay" click: send `TOGGLE_OVERLAY` message to content script, close popup
6. On "Remember" checkbox change: save/clear the preference in `chrome.storage.local`

---

## Message Types (New)

Added to the existing messaging protocol:

### TOGGLE_OVERLAY

- **Direction**: Background → Content Script
- **Payload**: none
- **Action**: Toggle the overlay drawer open/closed. If the overlay is not yet mounted, mount it first.

### OVERLAY_READY

- **Direction**: Content Script → Background
- **Payload**: `{ tabId: number }`
- **Action**: Notify the background that the overlay content script has loaded and the trigger button is visible.

### SWITCH_MODE

- **Direction**: Either UI → Background
- **Payload**: `{ from: 'sidepanel' | 'overlay', to: 'sidepanel' | 'overlay', tabId: number }`
- **Action**: Close the source UI and open the target UI.

### DEFAULT_MODE_CHANGED

- **Direction**: Settings UI → Background
- **Payload**: `{ mode: 'sidepanel' | 'overlay' }`
- **Action**: Background updates `chrome.storage.local` with `pphuntDefaultMode`, and toggles `chrome.action.setPopup` accordingly:
  - If mode is set → `setPopup({ popup: '' })` to disable popup, enabling direct `action.onClicked` handling
  - If mode is cleared (null) → `setPopup({ popup: 'popup.html' })` to re-enable the chooser popup

---

## Updated Project Structure

New and modified files:

```
src/entrypoints/
├── popup/                          ← NEW: mode chooser popup
│   ├── index.html
│   └── main.tsx
│
├── sidepanel/                      ← existing, add mode-switch button to header
│   └── components/layout/Header.tsx
│
├── pphunt-overlay.content.ts       ← NEW: overlay content script
│
├── amazon.content.ts               ← existing, scraping logic (unchanged)
└── background.ts                   ← existing, add popup preference handling


src/entrypoints/sidepanel/components/
├── shared/
│   ├── TriggerButton.tsx           ← NEW: floating trigger button component
│   ├── DrawerPanel.tsx             ← NEW: the overlay drawer container
│   ├── ResizeHandle.tsx            ← NEW: left-edge drag handle for drawer resize
│   ├── ModeSwitchButton.tsx        ← NEW: "Switch to [other mode]" button
│   └── useResizeObserver.ts        ← NEW: hook for responsive layout based on container width
│
└── ... (all existing components unchanged)


src/lib/
├── storage/
│   └── preferences.ts              ← NEW: chrome.storage.local for mode preference
│
└── context/
    └── UIModeContext.tsx            ← NEW: React context providing mode + adapter
```

---

## User Flows

### First Launch

1. User installs PPHunt
2. User navigates to Amazon
3. The floating trigger button appears on the right edge of the page (overlay content script runs)
4. User clicks the extension icon
5. Popup appears: "Open PPHunt — Side Panel | Page Overlay"
6. User clicks "Page Overlay" (or "Side Panel")
7. If "Page Overlay": the drawer slides open from the right
8. If "Side Panel": Chrome's side panel opens
9. User checks "Remember my choice"
10. Future icon clicks go directly to the chosen mode

### Switching Modes Mid-Session

1. User is using the overlay on an Amazon search page
2. User clicks "Switch to Side Panel" in the overlay header
3. Overlay collapses, side panel opens
4. All collected data is already in IndexedDB — the side panel shows it immediately
5. The floating trigger button remains visible on the page

### Full-Screen Scenario

1. User is in full-screen mode watching a product video
2. Side panel is not available (Chrome hides it in full-screen)
3. User clicks the floating trigger button on the right edge
4. The overlay drawer opens on top of the video
5. User collects products, then collapses the drawer

### Both Open

1. User opens the side panel for persistent reference
2. User also clicks the floating trigger to open the overlay on the current page
3. Both show the same products from IndexedDB
4. Products collected in the overlay appear in the side panel's live query
5. A subtle note in each: "Also open in [other mode]"

---

## PPHunt Design Tokens (Unchanged)

The overlay and popup use the same PPHunt design system as the side panel:

- Canvas (#f0eee6) background
- Ink (#141413) text
- Lora serif for body, Poppins sans for UI chrome
- Clay (#d97757) for primary CTAs
- Hairline borders, no box-shadow
- 8px bottom radius on buttons
- Flat surfaces, warm earth tones

The trigger button is the one element that uses ink as a background (not canvas) — it needs to be visible against any Amazon page background. On hover, it transitions to clay.

---

## Implementation Order

This UI system is built AFTER the existing 8 phases (which focus on the side panel). It's an additive layer:

| Step | What | Depends On |
|------|------|-----------|
| A | Create popup entrypoint (mode chooser) | Phase 1 (scaffolding) |
| B | Create overlay content script with trigger button | Phase 1 |
| C | Implement `createShadowRootUi` drawer with React mount | Phase 1 |
| D | Add `UIModeContext` adapter layer | Phase 3 (side panel UI exists) |
| E | Wire mode switching (overlay ↔ side panel) | Phase 3 |
| F | Add "Remember my choice" to `chrome.storage.local` | Phase 1 |
| G | Add mode-switch buttons to both headers | Phase 3 |
| H | Handle both-open scenario (shared IndexedDB) | Phase 4 (preview table) |
| I | Update settings with UI Mode section | Phase 6 |
| J | Test: full-screen, tab switching, both-open, event isolation | Phase 8 |

---

## Deliverables

- Popup entrypoint with mode chooser (Side Panel / Overlay / Remember)
- Overlay content script with `createShadowRootUi` Shadow DOM injection
- Floating trigger button (40×48px, fixed right edge, always visible on Amazon)
- Drawer panel (400px default, full height, slide animation, canvas background)
- **Resizable drawer**: drag handle on left edge, 300px–80vw range, width persisted in storage
- Responsive layout: all components adapt at narrow/default/wide breakpoints via ResizeObserver
- Collapse/expand toggle via trigger button and Escape key
- Mode switching: overlay → side panel and side panel → overlay
- "Remember my choice" persistence in `chrome.storage.local`
- `UIModeContext` adapter for shared React components (provides mode + current width)
- Event isolation for keyboard input in the overlay
- Settings integration (UI Mode section)
- Both-open scenario: shared IndexedDB, live query updates across modes
- Full PPHunt design compliance in both modes