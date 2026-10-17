# Phase 7: Session Persistence & Recovery

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Goal

Preserve collected product data when the side panel closes and reopens. Restore collection state after a tab reload or browser restart where technically possible. Provide a History tab showing past collection sessions with options to view products or delete records. Ensure the side panel remains aware of the active tab and can reconnect to an in-progress collection.

---

## Session Model

Every collection run is wrapped in a "session." A session tracks:

- **id**: unique string key, format `{tabId}_{timestamp}` (e.g., `1234_1697234567890`)
- **tabId**: Chrome tab ID where collection is running
- **url**: URL of the Amazon page at session start
- **status**: one of `idle`, `collecting`, `paused`, `completed`, `error`, `interrupted`
- **mode**: `manual` or `automatic`
- **targetCount**: user-specified target
- **collectedCount**: actual products collected
- **startedAt**: ISO datetime
- **updatedAt**: ISO datetime (updated on every status change)
- **completedAt**: ISO datetime (set when status becomes completed or interrupted)
- **errorMessage**: string (set when status becomes error)

---

## Side Panel Close & Reopen

The Chrome Side Panel API keeps the panel alive across tab switches, but the user can close it (click the X or click the extension icon again). When the side panel reopens:

1. On mount, query IndexedDB for any session with status `collecting` or `paused`
2. If found, check if the tab still exists via `browser.tabs.get(session.tabId)`
3. If the tab exists and is still on an Amazon page:
   - Restore the collection UI: show the mode, target, collected count, and status
   - Re-establish the message channel (send a ping to the content script)
   - If the content script responds, collection continues seamlessly
   - If the content script doesn't respond (it was unloaded during panel close), re-inject it via `browser.scripting.executeScript` and resume
4. If the tab was closed or navigated away:
   - Set session status to `interrupted`
   - Show a notice: "Collection was interrupted — 42 products were saved."
   - The collected products remain in IndexedDB, accessible from the Preview tab

### Background Persistence

The background service worker persists across side panel open/close. It continues to:
- Listen for messages from content scripts (products keep flowing to IndexedDB even if the side panel is closed)
- Track tab events (if the collection tab closes, the background marks the session as interrupted)

This means: if the user closes the side panel while collection is running, products continue to be collected and stored. When the panel reopens, the count has advanced.

---

## Tab Reload Recovery

When the user reloads the Amazon page where collection was running:

1. The content script is destroyed and re-injected on the new page load
2. The new content script instance has no memory of the previous session
3. The background detects the tab reload via `tabs.onUpdated` with `changeInfo.status === 'loading'`
4. The background sends a `TAB_CHANGED` message to the side panel with the new URL
5. If the URL is still Amazon, the side panel offers: "Page reloaded — Resume collection or start fresh?"
6. If "Resume" is chosen:
   - Load the session state from IndexedDB
   - Send `COLLECT_PRODUCTS` to the (newly loaded) content script with the remaining target count
   - The dedup engine in the content script loads existing ASINs from IndexedDB, so already-collected products are not re-scraped
7. If "Start fresh" is chosen:
   - Create a new session
   - Optionally clear the old session's products

---

## Browser Restart Recovery

When Chrome restarts (crash, update, or manual restart):

1. IndexedDB data survives — all products, sessions, and settings are intact
2. The background service worker is restarted by Chrome
3. The side panel is NOT automatically opened — the user must click the extension icon
4. On side panel open:
   - Query IndexedDB for the most recent session
   - If it was `collecting` or `paused`, set it to `interrupted`
   - Show the products from that session in the Preview tab
   - Show a notice: "Previous session was interrupted — 67 products are available."
   - The user can start a new collection from the Collect tab

Content scripts on open tabs are re-injected by WXT on browser restart (Chrome re-runs content scripts for matching URLs). However, the content script has no session context — it starts fresh. The side panel must explicitly tell it to begin a new collection.

---

## History Tab

The History tab shows a chronological list of past collection sessions.

### Layout

```
┌──────────────────────────────────────────┐
│                                          │
│  Collection History                      │  ← serif 16px, ink
│                                          │
│  ┌────────────────────────────────────┐  │
│  │                                    │  │
│  │  Oct 14, 2026 · 3:42 PM           │  │  ← serif 13px, ink
│  │  amazon.com/s?k=wireless+earbuds   │  │  ← sans 12px, sky, underlined
│  │  67 / 100 products · Completed    │  │  ← serif 12px, hairline
│  │  [View Products]  [Delete]         │  │  ← outlined + hairline text buttons
│  │                                    │  │
│  │  ──────────────────────────────── │  │
│  │                                    │  │
│  │  Oct 13, 2026 · 11:15 AM          │  │
│  │  amazon.com/dp/B09B8V1LZ3         │  │
│  │  12 / 50 products · Interrupted   │  │
│  │  [View Products]  [Delete]         │  │
│  │                                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [Clear All History]                     │  ← outlined, clay text
│                                          │
└──────────────────────────────────────────┘
```

### Session Card

Each session card shows:
- Date and time of the session start (formatted locale-aware)
- The source URL (truncated if long, clickable to open in new tab)
- Collection progress: "X / Y products" with the final status
- Status label: "Completed" (moss), "Interrupted" (hairline), "Error" (clay)
- Two action buttons: "View Products" and "Delete"

### View Products

Clicking "View Products" switches to the Preview tab and filters the table to show only products from that session (using the `sessionKey` field). The filter is shown as a tag that can be dismissed: "Filtered: Session from Oct 14, 2026".

### Delete Session

Clicking "Delete" shows a confirmation popover: "Delete this session and its products? This cannot be undone." Confirming:
1. Deletes all products with this session's key from IndexedDB
2. Deletes the session record
3. Deletes the history record
4. The history list updates immediately via useLiveQuery

### Clear All History

A "Clear All History" button at the bottom. Confirmation: "Delete all sessions and collected products? This cannot be undone." Confirming wipes the products, sessions, and history tables.

---

## Tab Close During Collection

If the user closes the Amazon tab while collection is running:

1. Background detects `tabs.onRemoved` for the collection tab's ID
2. Background marks the session as `interrupted` in IndexedDB
3. Background sends `UPDATE_PROGRESS` to the side panel with status `interrupted`
4. Side panel shows a toast: "● Tab closed — 42 products were saved."
5. All products collected up to that point remain in IndexedDB
6. The Preview tab shows those products

---

## Cross-Tab Awareness

The side panel is aware of which tab the user is currently viewing. When the user switches between tabs:

- If the new tab is an Amazon page with an active collection session, the side panel shows that session's state
- If the new tab is an Amazon page with no active session, the side panel shows "Ready to collect"
- If the new tab is not Amazon, the side panel shows "Navigate to Amazon"
- If collection is running on Tab A and the user switches to Tab B, collection continues on Tab A. The side panel shows: "Collecting from another tab" with a "Switch to tab" link

---

## History Data Access

The `useProducts` hook accepts an optional `sessionKey` parameter:
- Without sessionKey: returns all products across all sessions
- With sessionKey: returns only products from that session

The History tab uses a separate `useHistory` hook that queries the `history` table via useLiveQuery, sorted by `startedAt` descending.

---

## Deliverables

At the end of Phase 7:
- Session model persisted in IndexedDB with full lifecycle tracking
- Side panel close/reopen recovery: reconnects to in-progress collection or shows saved products
- Tab reload recovery: offers resume or fresh start, dedup prevents re-scraping existing products
- Browser restart recovery: marks interrupted sessions, shows saved products
- History tab with session cards (date, URL, progress, status)
- "View Products" action that filters the preview table by session
- "Delete" action with confirmation for individual sessions
- "Clear All History" with confirmation
- Tab close detection: session marked as interrupted, products preserved
- Cross-tab awareness: side panel tracks active tab, shows appropriate state