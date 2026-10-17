# Phase 3: Side Panel UI — Collection & Controls

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Build the main side panel interface where users control product collection. This includes the shell layout (header, tab bar), the collection panel with mode and target selection, control buttons (Start/Pause/Resume/Stop), a real-time progress bar, status indicators, non-Amazon page detection, and the `useCollection` hook that orchestrates everything. The UI follows PPHunt Design System — warm ivory surfaces, serif body text, flat components, hairline borders, clay CTAs.

---

## Side Panel Shell Layout

The side panel has a fixed structure that persists across all tabs:

```
┌──────────────────────────────────────────┐  ← canvas (#f0eee6)
│                                          │
│  PPHunt                    [⚙]          │  ← header: sans 16px 600, ink
│                                          │
│  ─────────────────────────────────────── │  ← hairline-soft border
│                                          │
│  Collect    Preview    History           │  ← tab bar: sans 13px 500
│  ───────                                │  ← clay underline on active tab
│                                          │
│  [Tab content area — scrollable]         │
│                                          │
└──────────────────────────────────────────┘
```

### Header

Left side: "PPHunt" in Poppins 600, 16px, ink color. Right side: a settings gear icon in hairline color, which opens the settings overlay when clicked. The header is fixed at the top and does not scroll.

### Tab Bar

Three tabs: Collect, Preview, History. Each tab label is Poppins 500, 13px. The active tab has ink text and a 2px clay underline. Inactive tabs have hairline text that transitions to ink on hover. The tab bar scrolls horizontally if needed on very narrow side panels.

### Tab Content Area

Fills the remaining vertical space below the header and tab bar. Scrollable. The content changes based on the active tab.

---

## Collection Panel Layout

The collection tab contains these sections, top to bottom:

```
┌──────────────────────────────────────────┐
│                                          │
│  ┌────────────────────────────────────┐  │  ← surface-card, 12px radius
│  │                                    │  │
│  │  Collection Mode                   │  │  ← serif 14px, ink
│  │  ┌──────────┐ ┌──────────────┐    │  │
│  │  │  Manual   │ │  Automatic   │    │  │  ← pill toggle
│  │  └──────────┘ └──────────────┘    │  │
│  │                                    │  │
│  │  Target Products                   │  │
│  │  ┌────┐ ┌─────┐ ┌─────┐ ┌─────┐  │  │
│  │  │ 50 │ │ 100 │ │ 200 │ │ 300 │  │  │  ← outlined buttons, 8px bottom
│  │  └────┘ └─────┘ └─────┘ └─────┘  │  │
│  │  Custom: [________]               │  │  ← hairline input, 8px radius
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  ● Collecting                      │  │  ← StatusDot (clay dot + serif label)
│  │                                    │  │
│  │  ████████████████░░░░░  67 / 100   │  │  ← clay progress bar on canvas
│  │                                    │  │
│  │  12 products found · 3 duplicates  │  │  ← serif 12px, hairline (muted)
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

---

## Mode Selector

A pill toggle with two segments: Manual and Automatic. The active segment has a `surface` background (elevated from the canvas behind it) with ink text. The inactive segment has transparent background with hairline text. No shadows, no color fills — the elevation difference between canvas and surface does the visual work.

When the user toggles the mode:
- Update the Zustand collection store
- Persist to settings (so it becomes the default for next session)
- If a collection is in progress, warn that changing mode will stop the current collection

---

## Target Selector

Four quick-select buttons for common counts: 50, 100, 200, 300. Each is an outlined button (secondary style). The currently selected target has a surface-card background to show selection.

Below the buttons, a "Custom:" label with a number input field. The input accepts:
- Minimum: 1
- Maximum: 1000 (configurable in constants)
- Type: integer only
- The input field uses the standard PPHunt input style (hairline border, 8px radius, no shadow)

When the user types a custom value, it overrides the quick-select buttons. If the custom input is cleared, the last quick-select value is restored.

---

## Control Buttons

A row of up to three buttons, arranged horizontally with equal spacing. Only the relevant buttons for the current state are shown:

### State Machine

```
idle ──[Start]──► collecting
collecting ──[Pause]──► paused
paused ──[Resume]──► collecting
collecting ──[Stop]──► idle
paused ──[Stop]──► idle
collecting ──(target reached)──► completed
completed ──[Start]──► collecting (new session)
```

### Button Styles

- **Start** (primary, clay filled): shown when status is `idle` or `completed`. This is the single most important CTA, so it uses the clay color.
- **Pause** (secondary, outlined): shown when status is `collecting`
- **Resume** (primary, clay filled): shown when status is `paused`. Resuming is the primary action when paused.
- **Stop** (secondary, outlined): shown when status is `collecting` or `paused`

When `Start` is clicked:
1. Validate that the active tab is an Amazon page
2. Validate that a target count is set
3. Set status to `collecting`
4. Send `START_COLLECTION` message to background
5. Background routes `COLLECT_PRODUCTS` to the content script

When `Stop` is clicked:
1. Send `STOP_COLLECTION` message to background
2. Background routes `STOP_COLLECTION_CMD` to content script
3. Content script stops scrolling and MutationObserver
4. Set status to `idle`
5. Products collected so far remain in IndexedDB

---

## Progress Display

### Status Indicator

A colored dot followed by a serif label. No emoji, no colored badges — just the dot and text.

| Status | Dot Color | Label Text | Text Color |
|--------|-----------|------------|------------|
| Ready | moss (#788c5d) | "Ready" | hairline |
| Collecting | clay (#d97757) | "Collecting" | ink |
| Paused | hairline (#b0aea5) | "Paused" | hairline |
| Complete | moss (#788c5d) | "Complete" | ink |
| Needs attention | clay (#d97757) | "Needs attention" | ink |

### Progress Bar

A thin (6px height) bar with:
- Track: canvas (#f0eee6) background
- Fill: clay (#d97757) color
- Rounded ends (this is the one exception to the no-pill rule — progress bars are inherently rounded)
- No animation shimmer, no glow — just a smooth width transition (200ms ease-out)
- Text below: "67 / 100" in sans 12px, ink

### Count Summary

Below the progress bar, a muted line showing: "12 products found · 3 duplicates" in serif 12px, hairline color. This gives at-a-glance context without being noisy.

---

## Non-Amazon Page Detection

When the active tab is not an Amazon page, the collection panel shows a warm editorial card instead of the controls:

```
┌──────────────────────────────────────────┐
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  Navigate to an Amazon page        │  │  ← serif 16px, ink
│  │                                    │  │
│  │  PPHunt collects products from     │  │  ← serif 13px, hairline
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

The Start button is disabled (hairline-soft background, hairline text) when not on an Amazon page.

---

## Tab Switch Awareness

The side panel persists across tab switches (Chrome Side Panel API). The `useActiveTab` hook:

1. On mount, query the current active tab via `browser.tabs.query({ active: true, currentWindow: true })`
2. Determine if it's an Amazon page by checking the URL against Amazon domain patterns
3. Listen for `tabs.onActivated` to detect tab switches
4. Listen for `tabs.onUpdated` to detect URL changes within a tab
5. Expose: `tabId`, `url`, `isAmazon` (boolean)

When the user switches to a different tab:
- If it's another Amazon page, the side panel can start a new collection or continue an existing one
- If it's not Amazon, show the "Navigate to Amazon" guidance
- If a collection was in progress on the previous tab, it continues running in the background (the content script keeps working). The side panel just shows a notice: "Collecting from another tab"

---

## useCollection Hook

This is the main orchestration hook that ties everything together. It:

1. Reads collection state from the Zustand store
2. Reads the active tab info from `useActiveTab`
3. Provides action functions: `startCollection`, `pauseCollection`, `resumeCollection`, `stopCollection`
4. Listens for `UPDATE_PROGRESS` messages from the background
5. Updates the store when progress messages arrive
6. Triggers toast notifications when milestones are reached (target hit, errors)
7. Returns derived state: `canStart`, `canPause`, `canResume`, `canStop`

### Start Collection Flow

1. Validate: active tab must be Amazon, target must be set, status must be idle or completed
2. Set status to `collecting` in the store
3. Create a new session in IndexedDB
4. Send `START_COLLECTION` to background with mode, target, and tabId
5. Background looks up the content script in that tab and sends `COLLECT_PRODUCTS`

### Progress Update Flow

When the background receives `PRODUCTS_COLLECTED` from the content script:
1. Writes products to IndexedDB
2. Counts total products for this session
3. Sends `UPDATE_PROGRESS` to the side panel

The side panel's `useCollection` hook receives this message and:
1. Updates `collectedCount` in the store (which triggers a re-render of the progress bar)
2. If `collectedCount >= targetCount`, sets status to `completed` and shows a completion toast

---

## Notification Toast

Toasts are quiet inline notices at the bottom of the side panel. They follow PPHunt style:

- A surface-card card with 8px radius and 1px hairline border
- A colored dot (moss for success, clay for attention) + serif 13px text
- A secondary serif 12px hairline line for the detail message
- Auto-dismiss after 5 seconds
- Click to dismiss immediately
- Maximum 2 toasts visible at once (newest at bottom)

Examples:
- Success: "● 67 products collected — Ready to preview or export."
- Attention: "● Page requires attention — A CAPTCHA was detected."
- Tab closed: "● Tab closed — 42 products were saved."

---

## Deliverables

At the end of Phase 3:
- Side panel shell with header, tab bar, and scrollable content area
- Collection panel with mode selector, target selector, control buttons
- State machine for collection status (idle → collecting → paused → completed)
- Progress bar with real-time count updates
- Status indicator (colored dots + serif labels)
- Non-Amazon page detection with warm editorial guidance
- Tab switch awareness — side panel knows which tab is active
- useCollection hook orchestrating all controls and messages
- Toast notification system (PPHunt style)
- All UI components styled with PPHunt design tokens