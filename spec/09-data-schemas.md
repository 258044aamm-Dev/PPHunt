# Data Schemas & Type Definitions

> **Historical specification — superseded for current behavior (2026-10-17).**
> This document preserves the original design, not a claim that every feature
> shipped or was verified. Use [README](../README.md),
> [ARCHITECTURE](../ARCHITECTURE.md), and the linked source contracts for current
> behavior. The original spec phase numbers differ from the remediation phases.
> Dated amendments below are retained; unamended requirements remain historical.


## Product

The core data entity. Every scraped product is represented as a Product object stored in IndexedDB.

### Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | number | No (auto) | auto-incremented | Dexie primary key |
| `asin` | string | Yes | — | Amazon Standard Identification Number. Unique per product across all Amazon. 10 alphanumeric characters. |
| `url` | string (URL) | Yes | — | Full product page URL. Format: `https://www.amazon.{tld}/dp/{ASIN}` |
| `title` | string | No | null | Product title as shown on the page. May be truncated on search results. |
| `price` | number \| null | No | null | Numeric price value. Parsed from the displayed price string. Excludes currency symbol. |
| `currency` | string | No | null | Currency symbol or code ($, €, £, ¥, USD, etc.) |
| `rating` | number \| null | No | null | Star rating, 0–5 scale. One decimal place (e.g., 4.7). |
| `reviewCount` | integer \| null | No | null | Total number of reviews/ratings. |
| `imageUrl` | string (URL) \| null | No | null | URL of the product image. Usually from Amazon's CDN. |
| `isSponsored` | boolean | No | false | Whether this product is a sponsored/advertising listing on the search results page. |
| `isPrime` | boolean | No | false | Whether the product is eligible for Amazon Prime delivery. |
| `brand` | string \| null | No | null | Brand or manufacturer name. Extracted from the "by Brand" link or meta tag. |
| `availability` | string \| null | No | null | Stock status text. Examples: "In Stock", "Only 3 left in stock - order soon", "Currently unavailable". |
| `seller` | string \| null | No | null | Seller name from the Buy Box. May differ from brand. |
| `description` | string \| null | No | null | Full product description text. Usually available on detail pages only. |
| `features` | string[] | No | [] | Array of bullet-point feature strings from the "About this item" section. |
| `collectedAt` | string (ISO datetime) | Yes | — | Timestamp when the product was scraped. ISO 8601 format. |
| `sessionKey` | string | Yes | — | The session this product belongs to. Format: `{tabId}_{timestamp}`. |
| `source` | enum | Yes | — | Where the product was scraped. One of: `'search'`, `'detail'`, `'category'`. |

### Zod Validation Schema

The Zod schema validates every field with appropriate constraints:
- `asin`: non-empty string
- `url`: valid URL string
- `price`: nullable number
- `rating`: nullable number, min 0, max 5
- `reviewCount`: nullable integer
- `imageUrl`: nullable URL string
- `isSponsored`: optional boolean (default false)
- `isPrime`: optional boolean (default false)
- `features`: optional array of strings (default empty array)
- `collectedAt`: ISO datetime string
- `sessionKey`: non-empty string
- `source`: enum of three values

### IndexedDB Indexes

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key (auto) | Dexie internal ID |
| `asin` | Single | Fast lookup by ASIN |
| `url` | Single | Fast lookup by URL |
| `sessionKey` | Single | Filter products by session |
| `collectedAt` | Single | Sort by collection time |
| `[sessionKey+asin]` | Compound | Dedup check within a session |

---

## AppSettings

User preferences for the extension. Stored as a single record in IndexedDB with `id: 'default'`.

### Fields

| Field | Type | Default | Validation |
|-------|------|---------|------------|
| `id` | `'default'` | `'default'` | Literal |
| `version` | integer | `1` | For future migrations |
| `defaultMode` | `'manual' \| 'automatic'` | `'manual'` | Enum |
| `defaultTargetCount` | integer | `50` | Min 1, max 1000 |
| `scrollSpeed` | integer | `800` | Min 100, max 3000. Pixels per scroll step. |
| `scrollInterval` | integer | `500` | Min 200, max 5000. Milliseconds between scrolls. |
| `waitAfterScroll` | integer | `1500` | Min 500, max 10000. Milliseconds to wait for content. |
| `enabledFields` | object | See below | Object with boolean for each of 15 fields |
| `duplicateDetection` | boolean | `true` | |
| `notifications` | boolean | `true` | |
| `exportFormat` | `'csv' \| 'xlsx' \| 'clipboard'` | `'csv'` | Enum |
| `exportFilename` | string | `'pphunt-export'` | Non-empty |
| `includeBOM` | boolean | `true` | UTF-8 BOM for CSV |

### Default Enabled Fields

| Field | Default Enabled |
|-------|----------------|
| title | true |
| asin | true |
| url | true |
| price | true |
| currency | true |
| rating | true |
| reviewCount | true |
| imageUrl | true |
| isSponsored | true |
| isPrime | true |
| brand | true |
| availability | true |
| seller | false |
| description | false |
| features | false |

---

## SessionState

Represents a collection session's lifecycle.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique key: `{tabId}_{timestamp}` |
| `tabId` | number | Chrome tab ID |
| `url` | string | Amazon page URL at session start |
| `status` | CollectionStatus | Current lifecycle state |
| `mode` | CollectionMode | `'manual'` or `'automatic'` |
| `targetCount` | integer | User-specified target |
| `collectedCount` | integer | Products collected so far |
| `startedAt` | string (ISO) | Session start time |
| `updatedAt` | string (ISO) | Last status change time |
| `completedAt` | string (ISO) \| null | Set when completed or interrupted |
| `errorMessage` | string \| null | Set when status is error |

### CollectionStatus Values

| Value | Meaning |
|-------|---------|
| `idle` | No active collection |
| `collecting` | Actively scraping products |
| `paused` | Collection paused by user |
| `completed` | Target reached |
| `error` | An error occurred (CAPTCHA, sign-in, etc.) |
| `interrupted` | Tab closed, page navigated, or browser restarted |

### CollectionMode Values

| Value | Meaning |
|-------|---------|
| `manual` | Products collected as user scrolls; MutationObserver only |
| `automatic` | Auto-scroll controller drives collection |

---

## CollectionHistory

Summary record of a completed or interrupted session, stored in the history table.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | number (auto) | Dexie primary key |
| `sessionKey` | string | Links to the session |
| `url` | string | Source URL |
| `mode` | CollectionMode | Manual or automatic |
| `targetCount` | integer | Original target |
| `collectedCount` | integer | Final count |
| `startedAt` | string (ISO) | Session start |
| `completedAt` | string (ISO) | Session end |
| `status` | CollectionStatus | Final status |

---

## ScrapedProduct

The raw object returned by the DOM parsers before it's validated and stored as a Product. Same shape as Product but without `id`, `sessionKey`, or `collectedAt` — those are added by the storage layer.

---

## Future Schema Migrations

The `version` field in AppSettings exists for future migrations. When the schema changes:
1. Increment the version number
2. Add a Dexie version upgrade in `database.ts` with the appropriate `.stores()` change
3. Write a migration function that transforms old data to the new shape
4. Dexie handles the IndexedDB version upgrade automatically