# Messaging Protocol

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Overview

All communication between the side panel, background service worker, and content scripts uses Chrome's `runtime.sendMessage` and `tabs.sendMessage` APIs. Every message is validated with a Zod schema before processing. Known malformed types receive an INVALID_MESSAGE reply in the background/content routers; unknown types are ignored.

The protocol uses a discriminated union on the `type` field — each message type has a specific payload shape.

---

## Message Flow Architecture

```
Side Panel                          Background SW                       Content Script
    │                                    │                                    │
    │──── START_COLLECTION ─────────────►│                                    │
    │     { mode, targetCount, tabId }   │                                    │
    │                                    │──── COLLECT_PRODUCTS ─────────────►│
    │                                    │     { mode, targetCount }          │
    │                                    │                                    │── parse DOM
    │                                    │                                    │── start observer
    │                                    │                                    │── (auto-scroll if automatic)
    │                                    │                                    │
    │                                    │◄──── PRODUCTS_COLLECTED ───────────│
    │                                    │      { products[], totalCount }     │
    │                                    │── store in IndexedDB                │
    │◄──── UPDATE_PROGRESS ──────────────│                                    │
    │      { collected, target, status }  │                                    │
    │                                    │                                    │
    │    (repeats as products arrive)     │                                    │
```

---

## Message Types: Side Panel → Background

### START_COLLECTION

- **When sent**: User clicks the Start button
- **Payload**:
  - `mode`: `'manual'` or `'automatic'`
  - `targetCount`: integer, 1–1000 (`TARGET_MIN`–`TARGET_MAX`; Phase 2 replaced the originally planned `.positive()` with explicit bounds — the UI and the schema enforce the same range)
  - `tabId`: Chrome tab ID of the Amazon page
- **Background action**: Stores the active collection tab ID, sends `COLLECT_PRODUCTS` to the content script in that tab

### PAUSE_COLLECTION

- **When sent**: User clicks the Pause button
- **Payload**:
  - `tabId`: Chrome tab ID
- **Background action**: Sends `PAUSE_SCROLLING` to the content script

### RESUME_COLLECTION

- **When sent**: User clicks the Resume button
- **Payload**:
  - `tabId`: Chrome tab ID
- **Background action**: Sends `RESUME_SCROLLING` to the content script

### STOP_COLLECTION

- **When sent**: User clicks the Stop button
- **Payload**:
  - `tabId`: Chrome tab ID
- **Background action**: Sends `STOP_COLLECTION_CMD` to the content script, clears the active collection tab

### REQUEST_PRODUCT_COUNT

- **When sent**: Side panel needs the current count (e.g., after reopening)
- **Payload**:
  - `tabId`: Chrome tab ID
- **Background action**: Queries IndexedDB for the session's product count, sends `UPDATE_PROGRESS` back

---

## Message Types: Background → Content Script

### COLLECT_PRODUCTS

- **When sent**: After receiving `START_COLLECTION` from the side panel
- **Payload**:
  - `mode`: `'manual'` or `'automatic'`
  - `targetCount`: integer, 1–1000 (`TARGET_MIN`–`TARGET_MAX`; Phase 2 replaced the originally planned `.positive()` with explicit bounds — the UI and the schema enforce the same range)
- **Content script action**: Begins or resumes collection. In automatic mode, starts the scroll controller. In manual mode, activates the MutationObserver.

### PAUSE_SCROLLING

- **When sent**: After receiving `PAUSE_COLLECTION` from the side panel
- **Payload**: none
- **Content script action**: Pauses the scroll controller. MutationObserver continues running (so manually-scrolled products are still detected).

### RESUME_SCROLLING

- **When sent**: After receiving `RESUME_COLLECTION` from the side panel
- **Payload**: none
- **Content script action**: Resumes the scroll controller.

### STOP_COLLECTION_CMD

- **When sent**: After receiving `STOP_COLLECTION` from the side panel
- **Payload**: none
- **Content script action**: Stops the scroll controller and disconnects the MutationObserver. Cannot be resumed.

---

## Message Types: Content Script → Background

### PRODUCTS_COLLECTED

- **When sent**: After parsing a batch of new products (initial page load or new products detected)
- **Payload**:
  - `products`: array of scraped product objects
  - `totalCount`: total unique products collected so far in this session
  - `isNewBatch`: boolean — true if these are newly discovered products, false if it's a recount
- **Background action**: Validates each product with the Product Zod schema. Writes valid products to IndexedDB. Sends `UPDATE_PROGRESS` to the side panel.

### COLLECTION_PROGRESS

- **When sent**: Periodically during collection, or when status changes
- **Payload**:
  - `collected`: current product count
  - `target`: target count
  - `status`: `'collecting'`, `'paused'`, `'completed'`, or `'error'`
- **Background action**: Forwards as `UPDATE_PROGRESS` to the side panel.

### CONTENT_ERROR

- **When sent**: When the content script detects an issue on the page
- **Payload**:
  - `code`: one of `'NOT_AMAZON'`, `'CAPTCHA'`, `'SIGN_IN'`, `'LOAD_FAILED'`, `'BLOCKED'`, `'UNKNOWN'`
  - `message`: human-readable error description
- **Background action**: Forwards to the side panel as `UPDATE_PROGRESS` with `status: 'error'` and the error message.

---

## Message Types: Background → Side Panel

### UPDATE_PROGRESS

- **When sent**: After processing `PRODUCTS_COLLECTED`, `COLLECTION_PROGRESS`, or `CONTENT_ERROR` from the content script
- **Payload**:
  - `collected`: current product count
  - `target`: target count
  - `status`: one of `'idle'`, `'collecting'`, `'paused'`, `'completed'`, `'error'`
  - `error`: string or null — error description when status is `'error'`
- **Side panel action**: Updates the Zustand collection store. Triggers re-render of progress bar, status indicator, and count. Shows toast notification if status changed to `completed` or `error`.

### TAB_CHANGED

- **When sent**: When the user switches to a different tab or the active tab's URL changes
- **Payload**:
  - `tabId`: new active tab's ID
  - `url`: new tab's URL
  - `isAmazon`: boolean — whether the URL is an Amazon page
- **Side panel action**: Updates `useActiveTab` state. Shows/hides the "Navigate to Amazon" guidance. Offers to switch context if collection is running on another tab.

---

## Message Validation

> **Amended (remediation Phase 2, 2026-10):** the description below matched the
> original design; the shipped implementation differs in two ways. (1) The
> validation entry point is `validateExtensionMessage()` in
> `src/lib/schemas/`, wrapping the Zod discriminated union
> (`*MessageSchema` types in `src/lib/schemas/messages.ts`). (2) Invalid
> messages with known types are **not silently discarded** — the background router replies with
> an `INVALID_MESSAGE` error message and returns `false`, so a sender waiting
> on the ack learns the message was rejected (finding H-3). It still never
> processes the payload and never throws.

Every message is validated with a Zod discriminated union on the `type` field:

- `type: 'START_COLLECTION'` → validates payload with `StartCollectionMessageSchema`
- `type: 'PAUSE_COLLECTION'` → validates payload with `PauseCollectionMessageSchema`
- (etc. for all 14 message types)

If validation fails:
- For a known malformed type, reply `{ ok: false, error: 'INVALID_MESSAGE' }`; unknown/missing types are ignored
- Do NOT process the message
- Do NOT crash or throw

This protects against:
- Corrupted messages (bit flips, partial sends)
- Version mismatches (old content script sending outdated message format)
- External interference (other extensions sending messages)

---

## Error Codes

| Code | Meaning | User-Facing Message |
|------|---------|-------------------|
| `NOT_AMAZON` | Content script injected on a non-Amazon page | Not shown to user (side panel detects this independently) |
| `CAPTCHA` | CAPTCHA challenge detected on the page | "Page requires attention — A CAPTCHA was detected." |
| `SIGN_IN` | Sign-in requirement detected | "Page requires attention — Sign-in is required." |
| `LOAD_FAILED` | Page content failed to load | "Page failed to load — Try refreshing the page." |
| `BLOCKED` | Page access restricted or blocked | "Page access restricted — This page may be blocked." |
| `UNKNOWN` | An unexpected error occurred | "Something went wrong — Try refreshing the page." |

---

## Tab Tracking in Background

The background service worker maintains a lightweight record of the active collection tab:

- When `START_COLLECTION` arrives, store the `tabId`
- Listen for `tabs.onRemoved` — if the collection tab closes, mark the session as `interrupted` and notify the side panel
- Listen for `tabs.onUpdated` — if the collection tab navigates away from Amazon, pause collection and notify
- When `STOP_COLLECTION` arrives, clear the stored tab ID
- When the service worker wakes up (MV3 workers sleep after ~30s of inactivity), it re-reads the active session from IndexedDB to restore its context

The worker does NOT keep product data, progress counts, or any mutable state in memory. Everything persists in IndexedDB. The worker's in-memory state is limited to: the current collection tab ID (for routing messages).