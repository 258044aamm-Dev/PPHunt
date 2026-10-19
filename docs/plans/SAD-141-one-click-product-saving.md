# SAD-141 — One-Click Product Saving (Right-Click Menu + Card Button)

**Status:** revision 2 approved; **implementation under way** — P0.1–P0.4 and P1.1–P1.4 are merged on `main`
(`0226e7f`…`1fcc22d`, eleven issues In Review, suite 385/48 → 584/62). A right-click, or the per-card
button, now parses one product and writes it to a one-click collection in History — no enrichment yet. Live tracker: `docs/plans/SAD-141-issues.md`.
**Revision 2 (2026-10-19):** compared line by line against the independently revised plan in the same Linear thread (`8fdc9555…` / `62daab08…`). Eight items adopted, three rejected, nine retained; full rationale and evidence in the companion document `docs/plans/SAD-141-comparison.md`. The changes are listed in §17.
**Issue:** [SAD-141](https://linear.app/sad-mod/issue/SAD-141/feature-request-one-click-product-saving-via-right-click-context-menu) (project PPHunt, team Sad_mod)
**Repository:** `MakeTheNewHistory/PPHunt`, branch `main`, commit `0441fdc`
**Analysis date:** 2026-10-19
**Baseline verified locally before writing this plan:**

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | clean (exit 0) |
| Tests | `npx vitest run` | **385 passed / 48 files**, 66.4 s |
| Build | `npx wxt build` | success, **1.76 MB** total, 2.3 s; content script 163 kB |
| Dead-export guard | `npm run check:dead-exports` | clean (42 files scanned) |
| Production audit | `npm audit --omit=dev` | **0 vulnerabilities** |

> **Source note.** The Linear API returned SAD-141 with the middle of the description elided (the payload jumps from §8.2 Option C to the final acceptance criteria). Everything visible (§1–§8.2, final acceptance criteria, deliverables) is covered below. If §9–§13 contain additional hard requirements (notifications, error taxonomy, permissions), they should be reconciled against §6 "Implementation phases" before coding starts.

---

## Table of contents

1. [TL;DR](#1-tldr)
2. [What the codebase already gives us](#2-what-the-codebase-already-gives-us)
3. [What is actually missing](#3-what-is-actually-missing)
4. [Platform research and hard constraints](#4-platform-research-and-hard-constraints)
5. [Proposed architecture](#5-proposed-architecture)
6. [Data model changes](#6-data-model-changes)
7. [Collection semantics (the three settings)](#7-collection-semantics-the-three-settings)
8. [Product identification and button injection](#8-product-identification-and-button-injection)
9. [Shared save pipeline](#9-shared-save-pipeline)
10. [Background enrichment](#10-background-enrichment)
11. [Export and download](#11-export-and-download)
12. [Field coverage map (issue §5 → existing model)](#12-field-coverage-map-issue-5--existing-model)
13. [Implementation phases](#13-implementation-phases)
14. [Test plan](#14-test-plan)
15. [Risks, limitations, and non-goals](#15-risks-limitations-and-non-goals)
16. [Open decisions (recommended defaults)](#16-open-decisions-recommended-defaults)
17. [Comparative review and adoption log](#17-comparative-review-and-adoption-log)
18. [Appendix A — message contract](#appendix-a--message-contract)
19. [Appendix B — settings UI copy](#appendix-b--settings-ui-copy)
20. [Appendix C — acceptance-criteria traceability](#appendix-c--acceptance-criteria-traceability)

---

## 1. TL;DR

The feature is buildable **without rewriting the collectors, the preview table, the export engines, or the History model**, because the pieces already exist:

- Single-card parsers already exist: `parseAmazonSearchCard(card, url)`, `parseAmazonCategoryCard(card, url)`, `parseAmazonProductDetail(doc, url)`.
- Persistence already dedupes per `(sessionKey, asin)` and History is already an upsert keyed by `sessionKey` (`addHistoryEntry`).
- CSV/XLSX workbook **byte builders** already exist (`buildAmazonCSVContent`, `buildExcelWorkbookBuffer`) and are decoupled from `file-saver`.

The plan therefore is:

1. **Content script** owns all DOM work: resolve the right-clicked element to one product card, inject/update one small shadow-DOM button per card, capture the right-click target, and drive per-card job states.
2. **Background (service worker)** owns all state: a small `SaveJobManager`, collection resolution, validation, persistence, enrichment orchestration, export orchestration.
3. **A new offscreen document** performs the two DOM-only operations the MV3 worker cannot do: `DOMParser` for fetched product-detail HTML, and Blob/object-URL creation for exports.
4. **One new table** (`snapshots`, Dexie v2) plus four optional fields give historical tracking without duplicating existing fields. One new settings enum (`quickSaveCollectionBehavior`) implements the three collection behaviours; default `current`.
5. **One-click collections are `history` + `products` rows only — never a `sessions` row.** A collection *is* a `sessionKey`, and `sessions` is the full-page recovery mechanism: `getActiveSession()` adopts any `collecting`/`paused` row globally, `reconcileInterruptedSessions()` flips stale rows to `interrupted`, and `pruneOldSessions()` deletes the products of every terminal session older than 30 days. Staying out of that table removes all three hazards. Trade-off: one-click collections are never auto-pruned (manual delete only).
6. **Two new permissions**: `contextMenus`, `offscreen` (both silent), plus `downloads` behind an explicit verification gate (§11.2, D10). Host permissions are aligned with the content-script patterns for all 23 marketplaces (§3 gap 9).

Deliberate scope cuts are listed in §12 and §15: variations, additional image galleries, rating distribution, price-per-unit, search rank storage and profit/ROI calculators are **not** supported by the current model or parser and would require new extraction + UI; they are proposed as follow-ups rather than silently faked.

---

## 2. What the codebase already gives us

### 2.1 Runtime shape

- WXT 0.21 / MV3. Source entrypoints: `background`, `amazon.content`, `temu.content`, `sidepanel`, `popup`, `overlay`, and a dedicated `preview` page.
- Two isolated engines (`engines/amazon`, `engines/temu`); `src/lib/*` files are mostly thin re-exports of the Amazon engine.
- Background is a **single** `runtime.onMessage` listener (`background.ts`), delegating to `createAmazonBackgroundController()` then Temu handlers.
- Content script has a single command handler that already accepts `PING_CONTENT_SCRIPT`, `HIDE_PAGE_OVERLAY`, `COLLECT_PRODUCTS`, pause/resume/stop, validated by Zod, plus a `pphunt:command` DOM-event bridge and a `__PPHUNT_CONTENT_CLEANUP__` hook.

### 2.2 Reusable pieces (verified in source)

| Need | Existing code | Reuse decision |
|---|---|---|
| Parse one search card | `parseAmazonSearchCard()` in `scraper/search-results.ts` (4-tier cascade) | **Reuse as-is** |
| Parse one category/bestseller/deals card | `parseAmazonCategoryCard()` in `scraper/category-page.ts` | **Reuse as-is** |
| Parse a product-detail page | `parseAmazonProductDetail()` in `scraper/product-detail.ts` — returns title, brand, price/list/discount/deal/coupon, rating, reviews, BSR, past-month sales, availability, delivery, seller, features, description, hi-res image, prime | **Reuse as-is** in offscreen |
| Normalization + validation | `validateAndNormalizeScrapedProduct()`, `ScrapedProductSchema`, `ProductSchema` | **Reuse** |
| Card discovery | `discoverStructuralProductCards`, `discoverMainSlotWidgetProductCards`, `dropNestedCards`, `countProductCards` scope rules | **Reuse** (export a small `discoverSavableCards`) |
| Card field tiers | `extractCardAsinWithTier`, `extractCardTitleAndBrandWithTier`, pricing etc. | **Reuse** |
| Merge semantics | `mergeScrapedProductFields(target, source, {preferSource})` | **Reuse for enrichment** |
| DB writes | `addProducts()` (dedupe `(sessionKey, asin)`, fill-only enrichment), `addHistoryEntry` (upsert by `sessionKey`), `getProductsBySession`, `getProductCountBySession` | **Reuse**; add `upsertProductFromQuickSave` for the volatile-field refresh (§6.4). `updateSessionStatus` stays a full-page-only API (§6.6) |
| Export bytes | `buildAmazonCSVContent()`, `buildExcelWorkbookBuffer()`, `EXPORT_COLUMNS`, `resolveExportColumns`, `getExportColumnsFromSettings()`, `buildExportFilename`, `sanitizeExportImageUrl` | **Reuse**; add a thin Blob/download adapter |
| Settings plumbing | `AmazonSettingsSchema`, `DEFAULT_AMAZON_SETTINGS`, `updateSettings` write queue, `useAmazonSettings` debounce | **Extend** with one enum |
| UI conventions | `SettingsSection`, tokens, `bg-clay`, 1px hairline, no shadow, 8 px bottom radius | **Follow** |
| Overlay host precedent | `mountOverlayHost()` — closed shadow root + inline styles | **Mirror** for the card button |
| Debounce | `createChurnResistantDebounce()` (300 ms / 2 s max wait) | **Reuse** for rescanning |
| Live UI | `dexie-react-hooks` `useLiveQuery` | **Reuse** |
| Tests | jsdom + `DOMParser` fixtures, `fake-indexeddb/auto`, background listener harness with a stubbed `browser` | **Follow** |

### 2.3 Data model today

```ts
Product      { id?, asin, url, title, price, listPrice?, discountPercentage?, dealBadge?,
               currency, rating, reviewCount, bestSellersRank?, pastMonthSales?, coupon?,
               badge?, delivery?, imageUrl?, isSponsored, isPrime, brand?, availability?,
               seller?, description?, features[], source, listingCategory?, sectionLabel?,
               placements?, collectedAt, sessionKey }
SessionState { id (sessionKey), tabId, url, status, mode, targetCount, collectedCount,
               startedAt, updatedAt?, completedAt?, errorMessage? }
HistoryEntry { id?, sessionKey, url, mode, targetCount, collectedCount,
               startedAt, completedAt, status }        // <-- "Collection"; there is no name
Settings     { ...23 field toggles, exportFormat, exportFilename, exportImages, notifications, ... }
Dexie        version(1) only: products, sessions, history, settings
```

Two consequences matter for this feature:

- **A "Collection" is a `sessionKey`**, surfaced through a `history` row. There is no separate collection entity, no name, and no "current collection" pointer.
- **`addProducts()` never overwrites a non-null price/rating/BSR.** It only fills empty fields. That is right for the full-page collector (late hydration), but wrong for a deliberate re-save where the price has changed. The quick-save path needs its own merge policy (§6.4).

### 2.4 History and preview flow

`HistoryTab` live-queries `db.history`, renders each entry with **Preview / Tab ↗ / Export / Delete**. Product counts prefer `max(entry.collectedCount, live count)`. `addHistoryEntry()` updates an existing row for the same `sessionKey` instead of inserting a duplicate — exactly what repeated quick-saves need.

### 2.5 Export flow

`useAmazonExport` → `exportAmazonCSV` / `exportExcel` → `file-saver`'s `saveAs()` in whichever UI document is open. `buildExcelWorkbookBuffer` already returns bytes (no save), and image embedding fetches images from the extension context with the existing 200-product / 25 MiB / 20 s budgets.

### 2.6 Build & guard rails

- `wxt.config.ts` narrows `web_accessible_resources` to exactly the hashed chunks `overlay.html` needs (M-3 / SAD-182). `tests/manifest-war.test.ts` runs a real build and asserts no wildcards.
- `scripts/check-dead-exports.mjs` fails CI for unused exports under `src/lib/**`.
- `tests/docs-consistency.test.ts` pins README strings (target range, quick-select chips, design-token hexes, version source).
- CI runs typecheck → dead exports → tests → build → `npm audit --omit=dev` (plus an informational full audit and a built-manifest sanity check).

---

## 3. What is actually missing

| # | Gap | Evidence |
|---|---|---|
| 1 | **No context menu at all** | `grep -r contextMenus src wxt.config.ts` → no matches; manifest permissions are `sidePanel, activeTab, tabs, storage, scripting` |
| 2 | **No in-page UI injection** | Only the overlay host (an iframe drawer) is injected; no per-card controls |
| 3 | **No single-product save path** | `PRODUCTS_COLLECTED` is tied to an active collection session; there is no "save one product" message or handler |
| 4 | **No collection entity/name/current pointer** | `HistoryEntry` has no `label`; nothing persists "current collection" |
| 5 | **No background enrichment** | The only `fetch` call sites in `src` are the XLSX image-embedding paths (`export/excel.ts`, Amazon + Temu); no `DOMParser` usage; no offscreen document |
| 6 | **No historical snapshots** | Products store only `collectedAt`; re-collection does not create a snapshot row |
| 7 | **No background export** | All export paths call `file-saver` from a UI document |
| 8 | **No job model / resilience for one-off saves** | Collection state is a single `activeCollection` pointer, not a per-product job |
| 9 | **Host-permission gap** | Content script's `AMAZON_MATCH_PATTERNS` covers 22 hard-coded Amazon domains (`amazon.content.ts:19`) while `host_permissions` covers 10 (`wxt.config.ts:31`). Two consequences: background PDP fetches fail on the other 12 (`.mx .br .nl .se .pl .sg .ae .sa .com.tr .com.be .eg .cn`), and `dispatchToAmazonTab()`'s `scripting.executeScript` re-injection fallback (`handler.ts:126`) is itself permission-gated, so after a service-worker restart a context-menu save silently fails on those 12. Separately, `amazon.co.za` is in `AMAZON_MARKETPLACE_DOMAINS` (`amazon-url.ts:15`) and `currency.ts:28` but in **neither** list, so `isAmazonUrl()` recognises a marketplace the extension never runs on. |
| 10 | **No re-save merge policy** | `addProducts()` fill-only; price changes are ignored |

---

## 4. Platform research and hard constraints

These findings drive the architecture; each is a hard platform rule, not a preference.

| # | Finding | Consequence for SAD-141 | Source |
|---|---|---|---|
| C1 | `contextMenus.onClicked` gives `menuItemId, pageUrl, frameId, linkUrl, srcUrl, selectionText, mediaType, editable…` — **no cursor coordinates and no element reference in Chrome**. Chromium engineers confirm the event does not supply mouse coordinates. Firefox adds `info.targetElementId` + `menus.getTargetElement()`, but that is Firefox-only (bug 1325814). | The "which product did I right-click?" decision **must happen in the content script**, which can listen to `contextmenu` and remember `event.target`. The background can only say "the user clicked Save in tab N". | [Chrome contextMenus docs](https://developer.chrome.com/docs/extensions/reference/api/contextMenus), [chromium-extensions thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/-kLm2x3TlDg), [MDN OnClickData](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/OnClickData), [bug 1325814](https://bugzilla.mozilla.org/show_bug.cgi?id=1325814) |
| C2 | `contextMenus.create({onclick})` is unavailable in MV3, and creating menus at the top level of a service worker causes duplicate-id errors after worker restarts. Create in `runtime.onInstalled`, handle clicks in `contextMenus.onClicked`. | Register the menu once on install/update; single listener; idempotent. | [Chrome docs](https://developer.chrome.com/docs/extensions/reference/api/contextMenus), [MV3 tutorial](https://manifestgo.app/blog/chrome-extension-context-menu-tutorial) |
| C3 | An MV3 service worker has **no `DOMParser`, no `document`, no `URL.createObjectURL`**. Chrome/Edge 109+ provide an offscreen document (`reasons: ['DOM_PARSER']`, `['BLOBS']`) with full DOM. Firefox MV3 runs an event page that already has a DOM. | Product-detail HTML must be parsed in an offscreen document (Chrome) or inline (Firefox). Exported files must be turned into Blobs/object URLs in the offscreen document. | [Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [MV3 known issues](https://developer.chrome.com/docs/extensions/develop/migrate/known-issues), [SO 68964543](https://stackoverflow.com/questions/68964543/chrome-extension-domparser-is-not-defined-with-manifest-v3) |
| C4 | Since Chrome 85, **content scripts are subject to the page's CORS**; host permissions apply to extension pages/workers, not content scripts. | The product-detail `fetch` must run in the background/offscreen context, never in the content script. | [Chromium security note](https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/), [Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) |
| C5 | Dynamic `import()` **inside a content script** requires the imported chunk to be listed in `web_accessible_resources` for the page's origin. | Do **not** lazy-load `xlsx` (or any export code) in the content script — it would regress the M-3 hardening that deliberately removed wildcard WAR entries. Export code lives in the offscreen entrypoint instead. | [MV3 code splitting](https://mv3-extension.com/manifest-v3-architecture-extension-lifecycle/build-tooling-and-bundlers/code-splitting-and-dynamic-imports-in-mv3/), [Extension.js lazy loading](https://extension.js.org/docs/implementation-guide/lazy-loading) |
| C6 | `chrome.downloads.download({url})` works from the worker, but large generated files need a Blob URL created in a DOM context. Data URLs work but cost +33 % base64 and are impractical past a couple of MB. | Build the file in the offscreen document, create an object URL there, then call `chrome.downloads.download` from the worker and revoke the URL on completion. | [MV3 downloads guide](https://mv3-extension.com/core-apis-cross-browser-data-management/browser-data-apis-bookmarks-history-downloads/managing-downloads-from-an-extension/), [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) |
| C7 | Context menus can be scoped with `documentUrlPatterns`; `contexts: ['all']` puts the item at the **top level** for page, link, image, selection, editable contexts. | Use `contexts: ['all']`, no `parentId`, title exactly **"Save Product Details"**, restricted to Amazon URL patterns. | [Chrome contextMenus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus) |
| C8 | **Content scripts are injected as classic scripts**; `import` statements are a syntax error, `import()` is allowed but WAR-gated (C5). WXT bundles content scripts as a single file. | Keep content-script additions dependency-free (no React, no SheetJS). | [MV3 dynamic imports](https://moderok.dev/blog/chrome-extension-cannot-use-import-statement-outside-a-module/) |

**Design decisions derived from C1–C8**

1. Context-menu click → background sends `SAVE_CONTEXT_PRODUCT` to the tab → content script resolves its recorded right-click target. No coordinate guessing.
2. Background fetches PDP HTML → offscreen parses with the existing `parseAmazonProductDetail`.
3. Export is built in offscreen → downloaded via `chrome.downloads`.
4. No dynamic imports in the content script; no new web-accessible resources.

---

## 5. Proposed architecture

### 5.1 Runtime flow

```
┌──────────────────────────── Amazon tab (content script) ────────────────────────────┐
│                                                                                      │
│  CardActionController                         SaveTargetResolver                     │
│  ├─ MutationObserver (childList+subtree)      ├─ contextmenu/mousedown capture      │
│  ├─ discoverSavableCards() + WeakSet          ├─ closest card → ASIN → parser       │
│  ├─ one <button> host per card (closed       └─ product-detail fallback              │
│  │   shadow root, 5 states)                                                          │
│  └─ click → SAVE_PRODUCT ───────────────┐                                             │
│                                          │                                             │
│  In-page toast / Ask-collection dialog ◄─┼── SAVE_JOB_UPDATE                           │
└──────────────────────────────────────────┼─────────────────────────────────────────────┘
                                           │ runtime messaging
┌──────────────────────────────────────────▼────────────────────────────────────────────┐
│ Background service worker (single router)                                             │
│                                                                                       │
│  contextMenu registration (onInstalled) ── SAVE_CONTEXT_PRODUCT ──► tab                │
│                                                                                       │
│  SaveJobManager                                                                       │
│   1 validate (ScrapedProductSchema)                                                   │
│   2 dedupe in-flight (collection+asin)                                                │
│   3 resolveCollection(setting, pointer, product)                                      │
│   4 upsert product + append snapshot + upsert history  ──► IndexedDB (PPHuntDB)       │
│   5 enqueue enrichment (max 2)                                                        │
│        fetch PDP HTML (extension origin, host permissions)                            │
│        ──► offscreen DOMParser → parseAmazonProductDetail → merge → snapshot          │
│   6 broadcast job state                                                               │
│   7 optional export → offscreen builds bytes → chrome.downloads                       │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                           │
┌──────────────────────────────────────────▼────────────────────────────────────────────┐
│ Offscreen document (extension origin, no UI)                                           │
│   • PARSE_PRODUCT_DETAIL(html, url) → ScrapedProduct                                   │
│   • BUILD_EXPORT(format, products, columns) → { objectUrl, filename, mime }            │
│   • REVOKE_OBJECT_URL(url)                                                             │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 New / changed modules

| Path | Type | Responsibility | Est. size |
|---|---|---|---|
| `src/engines/amazon/content/save-target.ts` | new | Record right-click target; resolve element → card → `ScrapedProduct`; page-type fallbacks; search position/page number | ~180 LOC |
| `src/engines/amazon/content/card-action-button.ts` | new | Shadow-DOM button, state machine, dedupe, mount points, cleanup | ~320 LOC |
| `src/engines/amazon/content/card-observer.ts` | new | Card discovery + debounced rescan + IntersectionObserver deferral + teardown | ~130 LOC |
| `src/engines/amazon/content/toast.ts` | new | Tiny shadow-DOM toast + "Ask where to save" dialog | ~220 LOC |
| `src/engines/amazon/background/context-menu.ts` | new | Idempotent menu registration + click routing | ~70 LOC |
| `src/engines/amazon/background/save-jobs.ts` | new | Job manager, queue, states, `storage.session` rehydration, stale-job sweep | ~380 LOC |
| `src/engines/amazon/background/collections.ts` | new | Current-collection pointer, `resolveCollection()`, label generation, move-on-assignment | ~200 LOC |
| `src/engines/amazon/background/enrichment.ts` | new | PDP fetch, validation, offscreen round-trip, bounded concurrency, merge | ~260 LOC |
| `src/engines/amazon/background/export-service.ts` | new | Load collection → offscreen build → downloads → revoke; filename rules | ~200 LOC |
| `src/engines/amazon/db/quick-save.ts` | new | `upsertProductFromQuickSave()`, `appendSnapshot()`, `moveProductToCollection()` | ~220 LOC |
| `src/engines/amazon/db/collections.ts` | new | History-only collection upsert (`name`/`origin`/running count), name de-duplication, move-in-transaction; no `sessions` writes (§6.6) | ~90 LOC |
| `src/engines/amazon/db/database.ts` | edit | Dexie v2: `snapshots` table | +10 |
| `src/engines/amazon/db/history.ts` | edit | Delete snapshots with history; expose `name`/`origin` fields in the upsert | +25 |
| `src/engines/amazon/db/products.ts` | edit | `getProductCountBySession` already exists; use it for accurate counts | reuse |
| `src/engines/amazon/db/sessions.ts` | edit | Prune/delete snapshot rows with sessions | +15 |
| `src/engines/amazon/schemas/messages.ts` | edit | 6 new message schemas + union | +90 |
| `src/engines/amazon/schemas/validate-message.ts` | edit | Register new type strings | +6 |
| `src/engines/amazon/schemas/product.ts` | edit | Optional `lastUpdatedAt`, `enrichmentStatus` | +12 |
| `src/engines/amazon/schemas/settings.ts` | edit | `quickSaveCollectionBehavior`, `quickSaveAutoDownload` | +20 |
| `src/engines/amazon/constants/defaults.ts` | edit | Defaults + quick-save limits | +15 |
| `src/engines/amazon/types/index.ts` | edit | New message types, `ProductSnapshot`, settings enum | +60 |
| `src/engines/amazon/background/handler.ts` | edit | Route new messages; **do not** repoint the one-click pointer on `START_COLLECTION`; accurate final counts via `getProductCountBySession` | +55 |
| `src/entrypoints/amazon.content.ts` | edit | Start controllers, context capture, new commands, cleanup | +90 |
| `src/entrypoints/background.ts` | edit | Register context menu, job sweep on startup | +15 |
| `src/entrypoints/offscreen/index.html` + `main.ts` | new | Offscreen message handler | ~70 |
| `src/engines/amazon/constants/match-patterns.ts` | new | Single source for the 22 Amazon match patterns (content script + context-menu `documentUrlPatterns`) | ~10 |
| `src/engines/amazon/ui/components/SettingsOverlay.tsx` | edit | Radio group + current collection display (the `entrypoints/sidepanel` file is only a re-export shim) | +55 |
| `src/engines/amazon/ui/components/HistoryEntry.tsx` | edit | Optional label, "Current" badge, "Make current" action, hide target for one-click rows | +30 |
| `src/engines/amazon/ui/components/HistoryTab.tsx` | edit | Pass the Make-current handler; live pointer state | +20 |
| `src/engines/amazon/ui/hooks/useCurrentCollection.ts` | new | Subscribe to the `pphunt.oneClickCollection` pointer in `storage.local` | ~40 |
| `wxt.config.ts` | edit | +3 permissions, +12 Amazon host patterns | +15 |
| `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | edit | Permissions table, data flow, feature entry | docs |

> **Dead-export guard:** new files live under `src/engines/**`, which the guard does not scan. If any helper is placed under `src/lib/**`, it must have a consumer or the CI gate fails.

### 5.3 Message contract summary

Full schemas in [Appendix A](#appendix-a--message-contract). Six new types:

| Type | Direction | Purpose |
|---|---|---|
| `SAVE_CONTEXT_PRODUCT` | background → content | "The user chose Save Product Details in this tab" |
| `SAVE_PRODUCT` | content → background | One normalized product + extraction context + `jobId` |
| `SAVE_JOB_UPDATE` | background → content / panel | State machine updates, collection assignment, export readiness |
| `RETRY_SAVE_PRODUCT` | content → background | Retry a failed job (re-parse + re-save) |
| `ASSIGN_SAVED_PRODUCT` | content → background | Result of the Ask-every-time dialog |
| `EXPORT_SAVED_PRODUCT` | content → background | Build/download the configured export for a job or collection |

These are additive; `AMAZON_MESSAGE_TYPES`, `AmazonExtensionMessageSchema` and `AmazonExtensionMessage` are extended. Existing message types keep their shapes, so the 385 existing tests and the Temu router are unaffected.

---

## 6. Data model changes

### 6.1 Dexie v2 — `snapshots`

```ts
export interface ProductSnapshot {
  id?: number;
  asin: string;
  sessionKey: string;          // collection
  jobId: string;               // links listing snapshot + detail snapshot
  source: 'listing' | 'detail';
  capturedAt: string;          // ISO
  price: number | null;
  listPrice?: number;
  discountPercentage?: string;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  bestSellersRank?: string;
  availability?: string;
  coupon?: string;
  dealBadge?: string;
  delivery?: string;
  context?: {                 // §5 of the issue: data-quality metadata
    pageType: string;
    pageUrl: string;
    triggeredBy: 'context-menu' | 'card-button';
    searchPosition?: number;  // 1-based among savable cards on the page
    pageNumber?: number;      // ?page= / ?pg=
    listingCategory?: string;
    sectionLabel?: string;
  };
}
```

```ts
// db/database.ts
this.version(1).stores({ /* unchanged */ });

// Dexie inherits v1 stores; only the new table must be declared.
this.version(2).stores({
  snapshots: '++id, asin, sessionKey, capturedAt, [asin+capturedAt]',
});
```

**Why a new table and not fields on `product`:**
- The issue requires one snapshot per collection event (price/rating/BSR/availability/coupon), while `products` must remain one row per `(sessionKey, asin)`.
- It keeps the existing `Product` shape and every consumer (table, export, dedupe) untouched.
- Historical deltas are computable with `snapshots.where('[asin+capturedAt]')` only when real rows exist — satisfying "do not imply historical data before collection began".

**Migration is additive.** Existing installs upgrade in place; no data rewrite. `clearAllHistory`/`deleteHistory`/`pruneOldSessions` must delete snapshot rows in the same transaction (otherwise orphan rows accumulate). No other schema change is needed.

### 6.2 Product additions (optional, backwards-compatible)

```ts
lastUpdatedAt?: string;                 // defaults to collectedAt on insert
enrichmentStatus?: 'none' | 'complete' | 'partial' | 'failed';
```

Both are `optional()` in Zod, so old rows and old exporters keep working.

### 6.3 History additions

```ts
label?: string;                          // human name, e.g. product title or search query
origin?: 'full-page' | 'one-click';      // distinguishes quick-save collections
```

`HistoryEntry` is not indexed on these fields, so no new index is needed. `HistoryTab` prefers `label ?? url`, and hides `x / target` for `origin === 'one-click'` (a one-click collection has no meaningful target).

> Small consistency fix worth including: `HistoryTab` sorts by `startedAt`, while the `useAmazonHistory` hook sorts by `completedAt`. Pick `startedAt` in both (no user-visible regression).

### 6.4 Merge policy for quick-save

The existing `addProducts()` only fills nulls. Quick-save needs "newer observation wins for volatile fields". Implement `upsertProductFromQuickSave()`:

| Field group | Fields | Rule |
|---|---|---|
| Volatile (price/availability signals) | `price, listPrice, discountPercentage, dealBadge, coupon, delivery, availability, rating, reviewCount, bestSellersRank, pastMonthSales, badge` | Overwrite when the incoming value is **non-null**; never overwrite with null/undefined |
| Stable identity | `title, imageUrl, brand, seller` | Fill only if empty; prefer a longer non-truncated title; detail page may replace image with hi-res |
| Collections | `features, description` | Fill when empty; detail enrichment may replace an empty array/string only |
| Flags | `isPrime` | OR |
| Context | `isSponsored, listingCategory, sectionLabel, placements` | Keep the latest listing context; append placements via `mergeScrapedProductFields` |
| Currency | `currency` | If it differs from the stored row, **do not silently re-price**; store the snapshot with its own `currency` and mark `enrichmentStatus: 'partial'` |

The existing `mergeScrapedProductFields(target, source, { preferSource: true })` already implements most of the right/left rules for enrichment and should be reused rather than re-implemented.

### 6.5 Settings

```ts
quickSaveCollectionBehavior: 'current' | 'new' | 'ask'   // default 'current'
quickSaveAutoDownload: boolean                            // default false (see §16.1)
```

Both go through `SettingsSchema` / `PartialAmazonSettingsSchema` / `DEFAULT_AMAZON_SETTINGS`, so `useAmazonSettings`'s debounce and `updateSettings`'s write queue work unchanged. Old settings rows parse with defaults; no migration.

### 6.6 Persistence of a one-click collection — history-only by design

A one-click collection writes:

| Table | Write | Why |
|---|---|---|
| `products` | one row per ASIN (`sessionKey = oc_<epochMs>`) | unchanged data path; Preview/Export read by `sessionKey` |
| `history` | one row per collection, upserted (`name`, `origin: 'one-click'`, running `collectedCount`) | collection identity + History UI |
| `snapshots` | one row per save (`source: 'listing'`, plus `'detail'` after enrichment) | price history |
| `sessions` | **never** | `sessions` is the full-page recovery mechanism, not a collection registry |

Why not `sessions` — three verified failure modes:

1. `getActiveSession()` (`db/sessions.ts`) returns the newest `collecting`/`paused` row **in the whole database**, and `hydrateActiveCollection()` falls back to it, so a lingering one-click session would be adopted by the next full-page run.
2. `reconcileInterruptedSessions()` flips every `collecting` row to `interrupted` on browser start — a healthy collection would look failed.
3. `pruneOldSessions()` (30-day, invoked on panel mount at `sidepanel/App.tsx:107` and History mount at `HistoryTab.tsx:63`) deletes `products` for every terminal session older than the cutoff — **silent loss of a curated collection**.

`deleteHistory(id)` already deletes the history row, its products and (if present) a session row (`db/history.ts:49`), so Preview / Export / Delete / Clear-All need no change. Retention is explicit: one-click collections are never auto-pruned; the user deletes them from History.

---

## 7. Collection semantics (the three settings)

### 7.1 What "current collection" means

A dedicated pointer in `chrome.storage.local`, separate from the full-page controller's `storage.session` pointer:

```ts
const ONE_CLICK_COLLECTION_KEY = 'pphunt.oneClickCollection';
interface OneClickCollectionPointer {
  sessionKey: string;      // oc_<epochMs>
  name: string;            // display label
  createdAt: string;
  updatedAt: string;
}
```

It is written when:

1. The first save into a **new** one-click collection.
2. The user chooses "Add to current" in the Ask dialog.
3. The user clicks **Make current** on a History entry (new, small UI affordance).

It is **not** written by `START_COLLECTION` or `COLLECTION_COMPLETE`, and a full-page `sessionKey` is never adopted implicitly. Missing pointer, or a pointer whose `sessionKey` no longer has a `history` row ⇒ **create a new `oc_<epochMs>` collection**; never fall back to "most recent history entry", because that would drop a single product into an unrelated collection with no visible signal.

The toast always names the target collection ("Saved to *Anker 65W Charger* · 3 products"), so the destination is never ambiguous.

### 7.2 Option A — Add to Current Collection (default)

```
Pointer exists & history row exists   ──► add product to pointer.sessionKey
Pointer missing / stale / wrong origin ──► create a new oc_ collection, write pointer
Either way                              ──► upsert history row, bump count, append snapshot
```

No new History row per product. `addHistoryEntry()` upserts the same `sessionKey`, updating `collectedCount` and `completedAt` while keeping the original `startedAt`.

**Running full-page collection case:** a one-click save **never joins** a session with `status === 'collecting' | 'paused'`, and never touches the background's `activeCollection`. Two reasons: `targetCount` is a promise about that run (a right-click product silently inflates it), and the completion dialog/count all describe that run. If the pointer somehow resolves to a live session, the save goes to a new one-click collection instead. Displayed counts stay honest anyway because `HistoryEntry` already renders `Math.max(entry.collectedCount, live count)` (`HistoryEntry.tsx:32–40`) and the completion handler will compute the final count from the DB via the existing `getProductCountBySession()` (`db/products.ts:147`) instead of `active.lastCollectedCount` (`handler.ts:387`).

### 7.3 Option B — Create New Collection

For each successful extraction:

1. `sessionKey = oc_<epochMs>` (no `createSession`, no `updateSessionStatus` — see §6.6).
2. `addHistoryEntry({ sessionKey, url: pageUrl, mode: 'manual', targetCount: 0, collectedCount: 0, status: 'completed', name: deriveLabel(product), origin: 'one-click', startedAt, completedAt })`.
3. `upsertProductFromQuickSave(product, sessionKey)` + `appendSnapshot(...)` in one transaction.
4. Update the history row's `collectedCount` to `getProductCountBySession(sessionKey)`.

`targetCount: 0` is the marker that a collection has no target; `HistoryEntry` renders "N products" instead of `N / target`.

Label rules: `title` trimmed to 80 chars, whitespace collapsed; if a history row already has the same label, append ` (2)`, ` (3)`… This is display-only; `sessionKey` remains the unique identity.

If extraction fails **before** a product is identified, no collection is created. If enrichment fails afterwards, the collection and product remain (partial).

### 7.4 Option C — Ask Every Time

To guarantee "cancelling does not delete the saved History record", the product is **persisted immediately into the current collection**, then the content script shows a lightweight dialog:

```
Where would you like to save this product?
[ Add to "<current label>" ]   [ Create new collection ]   [ Cancel ]
```

- "Add to current" → no-op (already there), dismiss.
- "Create new collection" → `ASSIGN_SAVED_PRODUCT { choice: 'new' }` → background moves the product + its snapshots to a newly created collection (single Dexie transaction).
- "Cancel"/Escape → product stays in the current collection. Nothing is lost.

Only one dialog can be open per tab; a second completed job replaces the dialog content with the newest product and a queue counter (`1 of 2`), never stacks.

### 7.5 Concurrent full-page collections

The controller supports **one** `activeCollection` at a time (single `storage.session` pointer). One-click collections are fully independent: they never read or write `activeCollection`, `storage.session['pphunt.activeSession']`, or `sessions`. A save that arrives while a full-page run is active goes to the one-click pointer (or a new collection), so the run's target, count, completion dialog and recovery state are untouched. Job updates use their own message type (`SAVE_JOB_UPDATE`), so `UPDATE_PROGRESS` — which the side panel treats as collection progress (`sidepanel/App.tsx:136`) — is never emitted for a save.

---

## 8. Product identification and button injection

### 8.1 Resolving a right-clicked element to one product

Content script, on every `contextmenu` (capture, passive) and `mousedown` with `button === 2`:

```ts
interface CapturedTarget {
  element: Element | null;
  capturedAt: number;
  pageUrl: string;
}

function resolveSavableCard(el: Element | null): Element | null {
  // 1. never accept excluded subtrees
  if (!el || el.closest('.atc-faceout-container, #rhf, #navFooter, [id*="sp_detail"], [id*="sims-consolidated"]')) return null;

  // 2. nearest known card, then climb out of nested inner cards
  for (const selector of SAVABLE_CARD_SELECTORS) {
    const card = el.closest(selector);
    if (card) return clampToOuterCard(card);   // e.g. .atc-faceout-container → ancestor s-search-result
  }

  // 3. structural fallback: reuse the collector's own discovery, cached per URL
  const cards = structuralCardsForPage();          // discoverStructuralProductCards(document.body)
  if (isWithinAnyCard(el, cards)) {                 // field-parsers.ts:63
    return nearestAncestorCard(el, cards);          // smallest discovered card containing el
  }

  return null;
}
```

Rules:

- Must resolve to a card **inside the same scope the collectors use** (exclude `.a-carousel-card` outside `.s-main-slot`, `#rhf`, footer, sponsored brand-store banners).
- Tier 3 reuses `discoverStructuralProductCards()` (`scraper/field-parsers.ts:1453`, already tested): it groups `/dp/` anchors by ASIN, skips carousel / sponsored / recommendation subtrees, and climbs at most 8 ancestors to the smallest plausible card, so the fallback is the collector's own notion of a card rather than a second, divergent one. The result is cached per `location.href` and invalidated by the same churn-resistant debounce used for card discovery.
- Must yield a valid 10-char ASIN via `extractCardAsinWithTier(card)`; otherwise treat as "no product".
- Right-clicking an image, title, price, rating, badge or blank card space all resolve to the same card because `closest()` walks up.
- Nested product containers (`.atc-faceout-container`) are clamped outward, so an "Add to cart" widget never resolves to an inner sub-card.
- Product-detail page: no card → if `detectAmazonPageType(...) === 'product-detail'` or `#productTitle` exists, use `parseAmazonProductDetail(document, location.href)`.
- Anything else → no extraction; content replies with a neutral toast "No product found here" (only after an explicit menu click).

**Keyboard-invoked menu fallback:** if `contextmenu` fires on `body`/`html` (keyboard), use `document.elementFromPoint(lastPointerX, lastPointerY)` where pointer coordinates are tracked by a throttled `pointermove` listener. This is best-effort; if it still resolves to nothing, do nothing.

### 8.2 Card button — appearance and states

One host element per card:

```html
<div class="pphunt-save-host" data-pphunt-save-host data-asin="B0…" style="position:absolute;top:8px;right:8px;z-index:10">
  #shadow-root (closed)
    <style>/* tokens + states + reduced motion */</style>
    <button type="button" aria-label="Save product details" data-state="idle">
      <svg …/>         <!-- idle icon: small "bookmark+" glyph -->
      <span class="ring"/>   <!-- extracting/enriching spinner -->
      <svg …/>         <!-- completed check / failed retry arrow -->
      <span class="sr-only" aria-live="polite">Saved</span>
    </button>
</div>
```

| State | Visual | Interaction |
|---|---|---|
| `idle` | Clay-on-surface bookmark icon, 28×28 px, 1 px hairline, 8 px bottom-only radius (repo rule) | Click → save |
| `queued` | Icon dimmed + thin progress ring at 15 % | Ignored (no duplicate jobs) |
| `extracting` | Ring spinning (CSS, `prefers-reduced-motion` → static) | Ignored |
| `enriching` | Ring with a small "+" dot; tooltip "Fetching product details…" | Ignored |
| `completed` | Moss check, tooltip "Saved to <collection>" | Click re-saves (new extraction event); auto-reverts to idle after 2.5 s |
| `failed` | Crimson retry arrow, tooltip with reason | Click retries |

`completed` covers both full and partial enrichment: when details were unavailable the same check icon carries a small warning dot, the tooltip reads "Saved — details unavailable", and the toast offers Retry. The job never reports `failed` after the product row was persisted.

Placement rules:

- Prefer the product image tile container (`[data-component-type="s-product-image"]`, `.s-product-image-container`, or the image's parent).
- If the computed `position` of the mount point is `static`, set `position: relative` inline and **remember the previous value** so cleanup can restore it.
- Never mount inside an `<a>` (would nest interactive content) — if the only candidate is an anchor, mount on the card itself.
- `pointerdown`, `mousedown`, `click` handlers call `stopPropagation()`; `click` also calls `preventDefault()`. This prevents navigation / add-to-cart on all card layouts.
- `draggable="false"`; `user-select: none`; `aria-label` includes the product title.
- Dark mode: `:host([data-theme="dark"])` variables + `@media (prefers-color-scheme: dark)` fallback. Read `pphuntTheme` from `storage.local` and subscribe to `storage.onChanged`.
- Button is **not** injected on `product-detail` pages (there is no card); right-click and the extension UI cover that page.

### 8.3 Dynamic content, dedupe, cleanup

```ts
class CardObserver {
  private seen = new WeakSet<Element>();
  private hosts = new Map<Element, HTMLElement>();      // card → host
  private observer: MutationObserver | null;
  private debounced = createChurnResistantDebounce(() => this.scan(), { debounceMs: 300, maxWaitMs: 2000 });
}
```

- Observe `document.body` with `{ childList: true, subtree: true }` only (no attributes — avoids self-triggering on state changes).
- On mutation: check whether any added node **is or contains** a known card selector before scheduling a scan; ignore unrelated churn.
- `scan()` queries only the card selectors, then `WeakSet` filters already-processed cards, so re-scans are O(new cards).
- Optional `IntersectionObserver` (`rootMargin: '200px'`) defers button creation until a card is near the viewport; the button is created on first intersection and then unobserved. This keeps infinite-scroll pages cheap.
- A `MutationObserver` on each card is **not** used; state comes from `SAVE_JOB_UPDATE` messages and an in-memory `Map<asin, state>`.
- Page navigation: on `popstate`/`hashchange` and when `location.href` changes between scans, disconnect, remove all hosts, clear `seen`, re-scan. Amazon mostly does full navigations; this also covers its partial AJAX swaps.
- Cleanup: `win.__PPHUNT_CONTENT_CLEANUP__` (existing), `pagehide`, and `beforeunload` disconnect observers, remove hosts/light-DOM attributes, restore modified inline `position` styles.
- The existing collection `MutationObserver` is untouched; a second observer is used precisely so `isCollecting` semantics never change.

### 8.4 Duplicate prevention

- **Content:** `Map<asin, JobState>`; a click while state is `queued|extracting|enriching` is ignored (and briefly pulses the ring). After `completed`/`failed`, a new click is allowed and creates a new extraction event (new snapshot).
- **Background:** `Map<`${collectionKey}:${asin}`, jobId>`; a duplicate `SAVE_PRODUCT` for the same pair returns the existing job id instead of creating a second job.
- **DB:** `(sessionKey, asin)` upsert, so repeated saves update one product row; snapshots capture each extraction.

---

## 9. Shared save pipeline

Both entry points call the **same** content-side function:

```ts
async function saveProductFromElement(card: Element, triggeredBy: 'context-menu' | 'card-button') {
  const parsed = parseCardForElement(card, location.href);   // search vs category parser
  if (!parsed) return notify('No product found here');
  const product = validateAndNormalizeScrapedProduct(parsed, location.href);
  if (!product) return notify('Could not read this product');
  const jobId = crypto.randomUUID();
  setCardState(product.asin, 'queued');
  sendMessage({
    type: 'SAVE_PRODUCT',
    payload: { jobId, product, context: buildContext(card, triggeredBy) },
  });
}
```

Background `SaveJobManager.run(job)`:

1. **Validate** `ScrapedProductSchema` (reject and emit `failed` on failure; log reason).
2. **Dedupe** in-flight `(collectionKey, asin)`.
3. **Resolve collection** per §7 — creates or reuses a **history** row, never a `sessions` row (§6.6), and refuses to target a live `collecting` session (§7.5).
4. **Persist listing snapshot first** (§6.4), so a later enrichment failure never loses data.
5. **Update product row** + `lastUpdatedAt`; append `snapshots` row `{ source: 'listing', context }`.
6. **Upsert history** (`addHistoryEntry`) with accurate live count, label, origin.
7. **Emit** `{ state: 'extracting' }` → persist → `{ state: 'enriching' }` → enrichment → `{ state: 'completed' | 'failed' }` (with `enrichmentStatus` and an optional `warning`; a saved product with failed enrichment is still `completed`, never `failed`).
8. **Export** (if enabled) after the terminal state; emit `downloadReady`.

Error taxonomy (kept small and actionable):

| Code | Meaning | User action |
|---|---|---|
| `NO_PRODUCT` | Right-clicked element is not in a supported card | Toast only |
| `PARSE_FAILED` | ASIN/title/url could not be normalized | Toast; retry |
| `DB_WRITE_FAILED` | IndexedDB error | Toast with retry; data not claimed saved |
| `ENRICH_FETCH_FAILED` | Network/HTTP/CAPTCHA/redirect | `completed` + `enrichmentStatus: 'partial'`; product already saved |
| `ENRICH_PARSE_FAILED` | HTML parsed but no product | `completed` + `enrichmentStatus: 'partial'` |
| `OFFSCREEN_UNAVAILABLE` | Chrome < 109 / offscreen error | `completed` + `enrichmentStatus: 'partial'`; retry later |
| `EXPORT_FAILED` | Workbook/download failure | Toast with retry; saved data intact |

**Never** mark a product saved if the DB transaction failed. **Never** roll back an already-saved product because enrichment/export failed.

---

## 10. Background enrichment

### 10.1 Fetch

```ts
const res = await fetch(product.url, {
  credentials: 'omit',            // public PDP data; avoids sending session cookies by default
  redirect: 'follow',
  signal: AbortSignal.timeout(15_000),
  headers: { Accept: 'text/html,application/xhtml+xml' },
});
```

- Runs in the **service worker** (extension origin) → CORS-exempt for hosts in `host_permissions` (C4).
- Guard: `res.ok`, content-type includes `text/html`, body length ≤ 3 MB, final URL still Amazon, final ASIN equals the requested ASIN (redirect check). If Amazon redirects to a different product, **reject** the enrichment (do not mix two products).
- CAPTCHA / sign-in detection: run the existing `detectPageIssues`-style checks on the parsed document; abort enrichment and keep listing data.
- Per-marketplace host permission gap: add the 12 missing Amazon domains to `host_permissions` so `amazon.nl`, `amazon.se`, `amazon.com.br`, etc. work (§15 R6).

### 10.2 Parse in offscreen

`entrypoints/offscreen/main.ts`:

```ts
import { browser } from 'wxt/browser';

browser.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'pphunt-offscreen') return false;
  if (msg.type === 'OFFSCREEN_PARSE_PRODUCT') {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    const product = parseAmazonProductDetail(doc, msg.url);
    respond({ ok: true, product });
    return true;
  }
  // OFFSCREEN_BUILD_EXPORT / OFFSCREEN_REVOKE_URL …
});
```

- Reuse `parseAmazonProductDetail` and its validation chain unchanged.
- If `typeof DOMParser !== 'undefined'` in the background (Firefox event page), parse inline and skip offscreen entirely.
- Before parsing, inject `<base href="{productUrl}">` into `<head>`. **Honest rationale:** no current parser reads `document.baseURI` — `parseAmazonProductDetail` works from `getAttribute('href'/'src')` and `extractASIN()` parses the raw attribute string, while `extractBestImageUrl` rejects non-absolute URLs by design. The `<base>` tag therefore changes nothing today; it is one line of insurance against a future helper using resolved `.href`/`.src`. A test pins field parity with and without it, so nobody "fixes" a non-bug later.
- Offscreen lifecycle, layered and race-safe: `runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` (Chrome 116+) → `offscreen.hasDocument()` (Chrome 116+) → `createDocument()`, catching the "only a single offscreen document may be created" race and re-checking once. Reasons `['DOM_PARSER']` for enrichment and `['BLOBS']` only when a file is actually built, so the justification stays truthful. Close after 30 s idle.
- **Price caveat (measured):** the PDP price parser is buybox-scoped (`#corePriceDisplay_desktop_feature_div`, `#corePrice_feature_div`, `#apex_desktop`, `#buybox`, …). A fetched PDP that lacks those containers — variant redirect, stripped/mobile markup, bot interstitial — parses cleanly but yields `price: null`. Because persistence is fill-only for prices during enrichment, the listing price survives; the job must therefore report `enrichmentStatus: 'partial'`, not `'complete'`.

### 10.3 Merge and snapshot

1. `mergeScrapedProductFields(stored, detail, { preferSource: true })` — detail wins for non-null fields, listing-only fields survive.
2. Apply the currency guard (§6.4).
3. Append a second snapshot `{ source: 'detail' }` so the UI can distinguish listing vs detail provenance.
4. `enrichmentStatus: 'complete'` if the detail product had the core fields (title + price present, page not a CAPTCHA); `'partial'` if only some (including the buybox-price case above); `'failed'` if no detail product at all. `'partial'` never downgrades the row and never turns the job into `failed` once the product is persisted (§9).

### 10.4 Concurrency and failure isolation

- Global queue with `MAX_CONCURRENT_ENRICHMENTS = 2`; per-job timeout 15 s; one automatic retry on network error (800 ms backoff); no retry for 404/CAPTCHA.
- Bounded queue length (e.g. 50). When full, saves still complete with listing data and `partial` enrichment.
- Each job is wrapped in `try/catch`; one failure never terminates the queue.
- Tab closes mid-job: the save is already owned by the background — fetch, merge, and persistence continue and the row appears in History. The terminal `SAVE_JOB_UPDATE` has no receiver and is dropped; an Option C dialog cannot be shown, so the product stays in the collection it was first persisted to (never lost).
- Service-worker suspension: job state is mirrored to `chrome.storage.session` on every transition. After a wake, any non-terminal job older than 90 s is marked `failed` — or `completed` with `enrichmentStatus: 'partial'` if a listing snapshot exists — and the tab is notified when it is still open. Completed rows are already durable in IndexedDB.

---

## 11. Export and download

### 11.1 What gets exported

Export the **collection**, not one product, so 20 sequential saves do not produce 20 files or 20 dialogs. `EXPORT_SAVED_PRODUCT` accepts an optional `collectionKey` (defaults to the job's collection).

Columns: reuse the same mapping as `ExportModal` — `getExportColumnsFromSettings(settings.enabledFields)` in `export/types.ts` — so the quick-save export matches the panel export exactly (including the Description/Features toggles that are off by default).

Filename:

- If `settings.exportFilename` is set, use it as the prefix.
- Else `buildExportFilename(count)` → `pphunt-amazon-YYYY-MM-DD-NNN`.
- For a one-click collection, append a short slug of the collection label: `-<slug>`.
- Sanitize path-hostile characters; cap at 120 chars.

### 11.2 Building and downloading

```ts
// background
const { objectUrl, filename, mime } = await offscreen.buildExport({ format, products, columns, includeBOM, embedImages });
const downloadId = await chrome.downloads.download({ url: objectUrl, filename: `${filename}.${ext}`, saveAs: false });
// on downloads.onChanged state === 'complete' | 'interrupted' → offscreen.revoke(objectUrl) and report
```

- CSV: `buildAmazonCSVContent()` → `Blob(text/csv;charset=utf-8)`.
- XLSX: `buildExcelWorkbookBuffer()` with existing image budgets; `Blob(application/vnd…sheet)`.
- Clipboard: cannot be produced reliably from an unfocused offscreen/worker. Keep clipboard export in the panel; for quick-save, show "Copied in panel" only when the panel is open, otherwise fall back to CSV download. (Documented limitation.)
- Download failure is reported as `EXPORT_FAILED`; retrying re-uses the saved rows and does **not** re-extract.
- Revoke object URLs after completion/failure; never leak them.

**Permission gate (D10).** Shipping with `downloads` costs one install-time warning ("Manage your downloads") and buys determinism: it works without a user gesture, survives offscreen teardown, and supports `conflictAction: 'uniquify'`. The alternative — an `<a download>` click inside the offscreen document, no permission — is plausible but unverified for the no-gesture case, and it needs the `BLOBS` reason to stay open. Phase 5 therefore includes an explicit check on Chrome and Edge: if the anchor path downloads correctly from an unfocused offscreen document, drop `downloads` from the manifest in a follow-up. Do not pre-commit to the unverified path, and do not discover it in production.

### 11.3 Automatic vs on-demand

Default: **on-demand**, with a completion toast action:

```
✓ Saved "Anker USB-C 65W Charger" to Writing Tools · [Download CSV] [Undo?]
```

A new setting `quickSaveAutoDownload` (default `false`) can auto-trigger the same export after each save if the user wants the literal "every save produces a file" behaviour. `Undo` is optional (deletes the just-added product from that collection and its snapshots); recommend deferring it.

---

## 12. Field coverage map (issue §5 → existing model)

Legend: **✅ exists** (parser + schema), **◐ partial**, **➕ add in this feature**, **⏭ deferred** (needs new extraction/UI; will be a follow-up issue).

| Issue field | Current model | Status | Plan |
|---|---|---|---|
| Title, ASIN, URL | `title, asin, url` | ✅ | — |
| Brand | `brand` | ✅ | — |
| Category / subcategory | `listingCategory` (organic/sponsored/recommendation), `sectionLabel` | ◐ | Store page context in `snapshot.context`; true taxonomy is ⏭ |
| Main image | `imageUrl` | ✅ | detail enrichment upgrades to hi-res |
| Additional images | — | ⏭ | needs gallery extraction + schema array |
| Variations (size/color/style) | — | ⏭ | needs dedicated PDP extraction + UI |
| Current price, list price, discount, currency | `price, listPrice, discountPercentage, currency` | ✅ | snapshot per save |
| Coupon availability/value/type | `coupon` (string) | ◐ | keep string; structured coupon type ⏭ |
| Deal/promotion label | `dealBadge` | ✅ | — |
| Price per unit | — | ⏭ | new field + parser |
| Price capture timestamp | `collectedAt` (+ `snapshots.capturedAt`) | ✅/➕ | snapshot adds per-event time |
| BSR + BSR category | `bestSellersRank` (string, includes category) | ◐ | keep string; structured category split ⏭ |
| Amazon's Choice / Best Seller badge | `badge` | ✅ | — |
| Rating, review count | `rating, reviewCount` | ✅ | snapshot per save |
| Search position / page number | — | ➕ (context only) | stored in `snapshot.context`, not product columns; exposing in UI ⏭ |
| Sponsored / organic | `isSponsored, listingCategory` | ✅ | — |
| Features / bullet points | `features[]` | ✅ (detail parser) | enriched in background |
| Important specifications | — | ⏭ | needs PDP table parser |
| Availability / stock | `availability` | ✅ | — |
| Estimated delivery | `delivery` | ✅ | — |
| Product video availability | — | ⏭ | new boolean |
| Review count / rating distribution | `reviewCount`; distribution — | ◐/⏭ | do not collect full reviews by default |
| Seller | `seller` | ✅ | — |
| Fulfilled by / Buy Box seller | — | ⏭ | new fields |
| Historical snapshots | — | ➕ | `snapshots` table |
| Data capture / last updated | `collectedAt` | ➕ `lastUpdatedAt` | — |
| Marketplace / currency / source URL | derivable from `url`, `currency`; `source` | ✅ | snapshot stores page URL |
| Extraction status / completeness / missing fields | — | ➕ `enrichmentStatus` | compute missing list in UI later |
| Discount %, price change, rating/review changes | `discountPercentage`; changes need snapshots | ✅/➕ | derived from snapshots; UI ⏭ |
| Profit, margin, break-even, ROI | — | ⏭ | requires user-entered costs; separate feature (and the issue's own "clearly label assumptions" bar) |

This mapping is the honest answer to the issue's "inspect the existing data model and reuse fields": most of the requested data is already supported; the missing items would require **new extraction sources**, and inventing them would violate "collect a field only when it is available through the existing, permitted extraction method".

---

## 13. Implementation phases

Each phase ends with `npx tsc --noEmit && npx vitest run && npx wxt build && npm run check:dead-exports` (or `npm run verify`, which adds the audit).

| Phase | Scope | Size | Effort |
|---|---|---|---|
| 0 | Contracts, Dexie v2, settings enum | S | 0.5 d |
| 1 | Context menu + resolver + minimal save | M | 1 d |
| 2 | Card button (six states, observers) | M | 1.5 d |
| 3 | Collections, pointer, Ask dialog, panel edits | M | 1.5 d |
| 4 | Background enrichment + offscreen | M/L | 2 d |
| 5 | Export + download gate | M | 1 d |
| 6 | Hardening, docs, manual QA | S/M | 1 d |
| | **Total to full parity** | | **~8.5 dev-days** + marketplace QA |

Phase 1 alone is a shippable slice: menu + single-product save + History, no enrichment, no export, ~1.5 d.

### Phase 0 — Contracts and data groundwork (S, 0.5 d)

- Extend `types/index.ts`: message types, `ProductSnapshot`, `QuickSaveCollectionBehavior`.
- Extend `schemas/messages.ts` + `validate-message.ts` with six message schemas.
- Extend `schemas/product.ts` (optional fields), `schemas/settings.ts`, `constants/defaults.ts`.
- Add Dexie v2 `snapshots` store; update `deleteHistory`, `clearAllHistory`, `deleteSession`, `pruneOldSessions` to clean snapshots.
- Add `db/quick-save.ts` with `upsertProductFromQuickSave`, `appendSnapshot`, `moveProductToCollection`, and `db/collections.ts` with the history-only collection upsert (§6.6).
- **Tests:** schema round-trips; v1→v2 upgrade preserves rows; cascade deletes remove snapshots; merge policy never nulls a field.
- **Exit:** all existing tests pass; no UI/behaviour change yet.

### Phase 1 — Context menu entry point (M, 1 d)

- `wxt.config.ts`: `contextMenus` permission. Extract `AMAZON_MATCH_PATTERNS` from `amazon.content.ts` into `src/engines/amazon/constants/match-patterns.ts` and import it from both the content script and the menu's `documentUrlPatterns` — one list, no drift.
- `background/context-menu.ts`: idempotent registration on install/update; single `onClicked`.
- `content/save-target.ts`: target capture + card resolution + detail fallback + context builder.
- Deliver `SAVE_CONTEXT_PRODUCT` through the existing `dispatchToAmazonTab()` (`handler.ts:104`) rather than a bare `tabs.sendMessage`: it already handles the transient "message channel closed" case, re-injects `content-scripts/amazon.js` with `scripting.executeScript` when the script is missing after an SW restart, and falls back to a DOM-event bridge. Reusing it removes a whole class of "menu click does nothing" bugs (and is why the host-permission gap in §3.9 matters).
- `amazon.content.ts`: `contextmenu`/`mousedown` listeners; handle `SAVE_CONTEXT_PRODUCT`; cleanup.
- Background: minimal `SAVE_PRODUCT` handler → validate → persist into the current one-click collection, or create one (§7.2) using a temporary simplified resolver. No settings, no enrichment, no export yet — those arrive in Phase 3+.
- Content toast: success/failure.
- **Tests:** menu registration; click routing; resolution matrix; save persists + history upsert; unrelated areas ignored.
- **Exit:** right-click → Save Product Details saves exactly one product into one collection, visible in History.

### Phase 2 — Card button entry point (M, 1.5 d)

- `content/card-observer.ts`, `content/card-action-button.ts`.
- Mount-point selection, shadow DOM styles, dark mode, six states, retry, dedupe.
- Content-side job map and state updates from `SAVE_JOB_UPDATE`.
- Cleanup on navigation/unload.
- **Tests:** one button per card; dynamic cards; no navigation on click; state transitions; duplicate click suppressed; cleanup restores DOM.
- **Exit:** click the icon on any supported card → same pipeline as the menu; no underlying link/cart activation.

### Phase 3 — Collections and settings (M, 1.5 d)

- `background/collections.ts`: pointer (`pphunt.oneClickCollection`), label generation, dedupe labels, `resolveCollection`, and the "never join a live session" guard (§7.5).
- **Do not** repoint on `START_COLLECTION`; "Make current" on History entries; "Current" badge (via the new `useCurrentCollection` hook wired through `HistoryTab`).
- Settings radio group "Right-Click Save Behavior" (3 options) + current collection line.
- Ask dialog (content) + `ASSIGN_SAVED_PRODUCT` + cross-collection move transaction.
- Accurate final counts via `getProductCountBySession` on completion.
- **Tests:** A/B/C behaviours; label dedupe; move preserves snapshots; settings persist across reopen; cancel leaves product in current.
- **Exit:** 10–20 sequential saves land in one collection by default; B creates one per product; C asks once per product without losing data.

### Phase 4 — Background enrichment (M/L, 2 d)

- `entrypoints/offscreen` + message handler; `background/enrichment.ts`.
- Host-permission alignment for all content-script Amazon domains.
- Fetch guards (timeout/size/redirect/ASIN/CAPTCHA), bounded concurrency, merge, detail snapshot, `enrichmentStatus`.
- Job resilience in `storage.session` + stale sweep.
- **Tests:** success merge; captcha; 404; timeout; ASIN redirect; concurrency limit; worker-restart recovery; no data loss on failure.
- **Exit:** saved products gain description/features/hi-res image/BSR from PDP without opening a tab; failures leave listing data intact.

### Phase 5 — Export (M, 1 d)

- `entrypoints/offscreen` export builder using existing byte builders.
- `background/export-service.ts`: collection load → build → `chrome.downloads` → revoke.
- Completion toast action; optional auto-download setting.
- Run the D10 permission gate (offscreen anchor vs `chrome.downloads`) on Chrome and Edge and record the result.
- Filename rules; XLSX image budgets respected.
- **Tests:** CSV/XLSX bytes; filename validity; download called with object URL; revoke; failure reporting; no re-extraction on retry.
- **Exit:** configured CSV/XLSX downloads open correctly and contain all saved fields + image URL.

### Phase 6 — Hardening, docs, verification (S/M, 1 d)

- README permissions table + features; ARCHITECTURE data flow and file index; CHANGELOG entry.
- Playwright-free manual checklist (§14.3).
- Performance pass: card observer on a 60-card page, 200 rapid mutations, memory of hosts.
- Accessibility pass: keyboard, focus ring, ARIA live, reduced motion.
- **Exit:** `npm run verify` green; manual checks recorded (real browser required).

---

## 14. Test plan

### 14.1 Automated (new files)

| Test file | Covers |
|---|---|
| `tests/amazon-save-target.test.ts` | `resolveSavableCard` matrix: search card, image, title, price, rating, blank space, nested `.atc-faceout-container`, widget card, `#gridItemRoot`, deal card, excluded carousel, header/footer, product-detail fallback, keyboard fallback, ASIN extraction failure |
| `tests/amazon-card-button.test.tsx` | Injection dedupe, dynamic cards, mount-point choice outside anchors, click `preventDefault`, state transitions from `SAVE_JOB_UPDATE`, retry on failed, cleanup + style restore, dark-mode attribute, reduced motion |
| `tests/amazon-context-menu.test.ts` | Menu created once with exact title/contexts/documentUrlPatterns; onClicked routes to the clicked tab; unknown ids ignored; re-install removes old id |
| `tests/amazon-save-pipeline.test.ts` | `SAVE_PRODUCT` validates, dedupes in-flight, writes product + snapshot + history; repeated save updates one row and appends a snapshot; merge never nulls; DB failure reported and not marked saved |
| `tests/amazon-quick-collections.test.ts` | Option A reuse/fallback/create; Option B per-product labels + dedupe; Option C dialog + move transaction; cancel keeps product; pointer lost → fallback |
| `tests/amazon-enrichment.test.ts` | Fetch success merge; captcha; 404; timeout; redirect to other ASIN; offscreen unavailable; concurrency ≤ 2; partial status |
| `tests/offscreen-export.test.ts` | CSV text + BOM; XLSX bytes non-empty; object URL creation; `downloads.download` args; revoke on complete; download failure |
| `tests/quick-save-resilience.test.ts` | `storage.session` rehydration; stale job sweep; completed rows intact; no duplicate on retry |
| `tests/amazon-quick-save-settings.test.tsx` | Settings radio persists; default is current; current collection label shown; existing settings preserved |
| `tests/message-registry-sync.test.ts` | The three registries agree: `AmazonExtensionMessage` union ↔ Zod discriminated union ↔ `AMAZON_MESSAGE_TYPES`; a fabricated `ONE_CLICK_NOPE` returns `'unknown'`; every new type appears exactly once in each |
| `tests/quick-save-collection-lifecycle.test.ts` | **No `sessions` row is written**; `pruneOldSessions()` leaves one-click products intact; a live `collecting` session is never joined; stale/deleted pointer ⇒ new `oc_` collection; `deleteHistory` removes history + products + snapshots and tolerates the absent session row |

Also update:

- `tests/background-router-robustness.test.ts` — add the new payload-bearing types to its matrix.
- `tests/docs-consistency.test.ts` — only if README wording pinned by the test changes (target chips/hexes do not).
- `tests/manifest-war.test.ts` — assert the new permissions/entrypoints did **not** add WAR entries.
- Existing background harnesses that stub `browser` (`background-router-robustness`, `mv3-state-survival`, `toolbar-routing`, `scroll-settings-wiring`, `progress-monotonicity`, …) gain `contextMenus` / `downloads` / `offscreen` mocks. `background.ts` must still use the repo's defensive `?.` style so a missing stub cannot throw at startup.

### 14.2 Commands

```bash
npm ci
npx tsc --noEmit
npm run check:dead-exports
npx vitest run                 # target: existing 385 + ~60 new, all green
npx wxt build
npm audit --omit=dev
```

### 14.3 Manual checks that unit tests cannot cover (real Chromium, must be recorded per issue §13)

1. Amazon search, Best Sellers, New Releases, Movers & Shakers, Today's Deals, and a PDP.
2. Right-click image / title / price / blank card area → "Save Product Details" is **top-level**; browser's Copy/Search items remain.
3. Right-click header/footer/nav → nothing is saved; toast explains.
4. Button appears on every card, does not move layout, does not trigger navigation or add-to-cart.
5. Scroll/paginate/infinite-load; new cards get exactly one button.
6. Save 10–20 products sequentially → default setting yields **one** collection with all rows.
7. Switch to "Create New Collection" → one collection per product, readable labels.
8. "Ask Every Time" → dialog, cancel, and both choices.
9. Dark mode + keyboard-only operation + screen reader labels.
10. Export CSV and XLSX; open files; check image URLs and UTF-8 (€/¥/£) rendering.
11. Terminate the service worker mid-enrichment (`chrome://extensions` → service worker → Terminate); verify the product remains and the job ends `completed` with a partial-enrichment warning (or `failed` only if nothing was persisted); no duplicate.
12. Close the Amazon tab mid-enrichment; reopen; history is intact.
13. Reload the extension; settings and current collection survive.
14. Firefox build loads and degrades gracefully if offscreen is unavailable (documented, unverified per README).

---

## 15. Risks, limitations, and non-goals

| # | Risk / limitation | Impact | Mitigation |
|---|---|---|---|
| R1 | **Amazon DOM drift** | Card selectors or mount points change; buttons missing or misplaced | Reuse the existing 4-tier ASIN/title extraction and card-scope helpers; buttons degrade silently (right-click still works); add a drift telemetry counter (`cardsSeen`, `buttonsMounted`) |
| R2 | **No coordinates in `contextMenus.onClicked`** | Wrong product if the content script's captured target is stale | Capture on `contextmenu`; validate target is still connected and inside the same card; if card removed, fall back to `pointer` coordinates/`elementFromPoint`; otherwise no-op |
| R3 | **Content-script performance on infinite lists** | Jank with thousands of cards | Debounced churn-resistant scans, `WeakSet`, optional IntersectionObserver deferral, no attribute observation |
| R4 | **MV3 worker suspension** | In-flight enrichment lost | `storage.session` mirror + stale sweep; listing snapshot persisted first; completed data in IndexedDB |
| R5 | **Permissions increase** | `downloads` shows "Manage your downloads"; `offscreen`/`contextMenus` normally silent | Declare only what is used; document in README; no `<all_urls>`; keep WAR untouched |
| R6 | **Host-permission gap** | Enrichment/fetch fails on 12 content-script domains (`.nl`, `.se`, `.com.br`, …) | Align `host_permissions` with `AMAZON_MATCH_PATTERNS`; test one non-default domain |
| R7 | **Cross-browser** | `chrome.offscreen` is Chrome/Edge-only; Firefox has DOM in the event page | Feature-detect `DOMParser` in the background; skip offscreen on Firefox; Firefox runtime remains "unverified" per README |
| R8 | **Automatic downloads noise** | 20 saves → 20 files | Default on-demand download; explicit opt-in setting; export the collection, not the product |
| R9 | **Duplicate collection labels** | Confusing History | Display-only dedupe `(2)`, `(3)`; keys remain unique |
| R10 | **Amazon ToS / rate limits** | Enrichment requests could be seen as scraping | One PDP request per explicit user save, no prefetching, bounded concurrency, respect CAPTCHA by aborting |
| R11 | **Right-click on iframes** | Deals widgets in iframes cannot be resolved | Content script is top-frame only today; documented limitation; `all_frames` + `frameId` routing can be added later |
| R12 | **Closed shadow DOM is not tamper-proof** | Page can still remove hosts | Cosmetic only; no secrets in the UI |
| R13 | **Issue text truncation** | Possible missed requirements (§9–§13) | Reconcile before Phase 1; this plan covers everything visible |
| R14 | **No auto-prune for one-click collections** | Deliberate: they are never expired, so the DB grows if the user never deletes them | `AMAZON_LIMITS.MAX_DB_RECORDS` (50 000) still applies globally; History shows counts and supports delete/clear; revisit a one-click-specific retention policy as a follow-up |
| R15 | **Implicit collection adoption** | Dropping a product into a big, unrelated collection is invisible and hard to undo | Pointer is separate from the full-page controller, never written on `START_COLLECTION`, and never falls back to "most recent history entry"; the toast always names the destination |
| R16 | **Buybox-scoped price parsing** | A fetched PDP without buybox containers yields `price: null` | Fill-only merge keeps the listing price; job reports `enrichmentStatus: 'partial'` (measured in the spike, §10.2) |

### Non-goals (explicit)

- No competitor analysis, manufacturing research, or sales estimates (`pastMonthSales` remains whatever Amazon displays and is labelled as Amazon's own signal).
- No full review-history collection, no AI summaries.
- No profit/ROI calculator in this feature (needs user-entered costs; separate feature).
- No refactor of the existing collection, preview, export, or History flows.
- No new dependency (everything uses existing Dexie, Zod, SheetJS, file-saver).

---

## 16. Open decisions (recommended defaults)

### 16.1 Auto-download

Recommendation: **on-demand by default**, with `quickSaveAutoDownload` off. The completion toast offers "Download CSV/XLSX". This preserves the issue's "generate a downloadable file" while avoiding 20 downloads for 20 saves. If the literal reading is required, flip the default to `true` — the export service is the same.

### 16.2 "Current collection" when a full-page collection is running

Recommendation (revised in v2): **never join it.** The one-click pointer is a separate key that `START_COLLECTION` does not touch, and a save that would land in a live `collecting`/`paused` session is redirected to a one-click collection (§7.5). Rationale: `targetCount` is a promise about that run, the completion dialog and counts describe that run, and a right-click product appearing inside a 500-item scrape is invisible until it finishes. The cost is that after a full-page run the next right-click save starts a new collection — mitigated by naming the destination in the toast and by **Make current** on any History row.

Rejected alternative: "fall back to the most recent history row", which silently targets an unrelated collection.

### 16.3 New permissions

Recommendation: accept `contextMenus` + `offscreen` + `downloads`, with `downloads` subject to the verification gate in §11.2 (D10). Without `offscreen`, enrichment parsing must round-trip through the content script (works, but fails if the tab closes) and export must be content-script-only (blocked by the WAR/C5 constraint). If a strict permission budget is a hard requirement, the fallback is:
- enrichment: background fetch → content script `DOMParser` → return product (no offscreen);
- export: CSV via `data:` URL + `chrome.downloads` (< 2 MB), XLSX deferred.

### 16.4 Schema additions

Recommendation: accept the `snapshots` table + optional `label`/`origin`/`lastUpdatedAt`/`enrichmentStatus`. Without snapshots, §7 "Historical Tracking" cannot be satisfied truthfully.

### 16.5 Deferred field extraction

Recommendation: ship §12's ✅/◐/➕ set now; open follow-up issues for variations, additional images, rating distribution, price-per-unit, buy-box/fulfilled-by, spec table, video availability, and profit calculators. They need new parsers and UI, and the issue itself forbids inventing data.

### 16.6 "Ask Every Time" semantics

Recommendation: persist first into the current collection, then offer move/new/cancel (as described in §7.4). This is the only design that guarantees "cancelling does not delete the saved History record" without a staging collection.

### 16.7 Decision register

| # | Decision | Status | Section |
|---|---|---|---|
| D1 | Export the collection, not the product | accepted | §11.1 |
| D2 | Persist first, then route (Ask) | accepted | §7.4 |
| D3 | `enrichmentStatus: 'partial'` instead of `failed` after a persisted row | accepted | §9, §10.3 |
| D4 | No new side-panel surface — edits to `SettingsOverlay`, `HistoryEntry`, `HistoryTab` only | accepted (user-confirmed) | §5.2 |
| D5 | Snapshot table in this PR (Dexie v2, additive) | accepted | §6.1 |
| D6 | Six-state job machine, `failed` only before persistence | accepted | §9 |
| D7 | `targetCount: 0` marks a target-less collection | accepted | §7.3 |
| D8 | Re-save refreshes volatile fields (never with nulls) **and** appends a snapshot | accepted | §6.4 |
| D9 | Derive menu patterns, content matches and host permissions from one marketplace list (incl. `amazon.co.za`) | accepted | §3.9, §13 |
| D10 | `downloads` permission behind a Chrome+Edge verification gate | **open** | §11.2 |
| D11 | One-click collections are never auto-pruned | accepted (trade-off noted) | §6.6, R14 |
| D12 | One-click pointer is separate; no implicit adoption of a full-page/old collection | accepted | §7.1, §7.2 |
| D13 | Auto-download off by default | accepted | §11.3 |

---

## 17. Comparative review and adoption log

A second, independently revised plan was posted in the same Linear thread. Both plans were compared line by line; the full table, evidence and the unreadable-section boundary are in the companion document `docs/plans/SAD-141-comparison.md`. Summary:

**Converged (no action, high confidence):** single shared pipeline; content script owns DOM and the background owns state; offscreen `DOM_PARSER` for fetched HTML; fill-only merge; `addProducts` dedupe; persist-first Ask semantics; no auto-download; never reuse `UPDATE_PROGRESS`; no new panel surface; `sessionKey` as collection identity.

**Adopted from the other plan (8):**

| # | Item | Why it is better | Where it landed |
|---|---|---|---|
| 1 | One-click collections never write a `sessions` row | Avoids adoption by `getActiveSession()`, `reconcileInterruptedSessions()`, and **30-day deletion of curated products** by `pruneOldSessions()` | §6.6, §7.3 |
| 2 | Dedicated `pphunt.oneClickCollection` pointer, no implicit fallback | Stops a save landing in an unrelated full-page/older collection | §7.1, §7.2 |
| 3 | Never join a live `collecting` session | Protects `targetCount`, completion counts and recovery state | §7.5, §16.2 |
| 4 | Reuse `discoverStructuralProductCards()` / `isWithinAnyCard()` for the fallback | Less new code, already tested, one notion of "card" | §8.1 |
| 5 | Layered offscreen creation (`getContexts` → `hasDocument` → create) | Race-safe on Chrome 116+ | §10.2 |
| 6 | `message-registry-sync` test | Three registries silently drop unknown types | §14.1 |
| 7 | Effort estimates per phase | Needed to schedule; ~8.5 dev-days to parity | §13 |
| 8 | Host-permission framing + `amazon.co.za` | The gap breaks `executeScript` re-injection after an SW restart, not just `fetch`; `co.za` is missing from both lists | §3.9, R6, D9 |

**Rejected (3):**

| Item | Why not |
|---|---|
| Offscreen `<a download>` as the primary export path | Unverified for the no-gesture case, and it loses `conflictAction`; kept as post-Phase-5 gate instead (D10) |
| `<base href>` as a correctness requirement | Measured: no parser reads `document.baseURI`; kept as one line of insurance with a parity test (§10.2) |
| Optional "current collection" card on the Collect tab | Not needed for parity; deferred follow-up (D4) |

**Corrections to v1 this review forced:** the `sessions` row (R14/§6.6), the "most recent history" fallback (§7.1), joining live runs (§7.5), the hand-rolled structural fallback (§8.1), and the missing `dispatchToAmazonTab` reuse in Phase 1.

**Verification added in v2:** an independent jsdom spike (8/8, deleted after running) that reproduces the other plan's 7/7 and adds the buybox-price finding; `amazon.co.za` confirmed absent from both the content-script patterns and `host_permissions` while present in the marketplace list.

---

## Appendix A — message contract

```ts
// content -> background
export interface SaveProductMessage {
  type: 'SAVE_PRODUCT';
  payload: {
    jobId: string;                       // uuid from content
    product: ScrapedAmazonProduct;       // already normalized
    context: {
      pageType: 'search' | 'category' | 'bestsellers' | 'product-detail' | 'other';
      pageUrl: string;
      triggeredBy: 'context-menu' | 'card-button';
      searchPosition?: number;
      pageNumber?: number;
      listingCategory?: 'organic' | 'sponsored' | 'recommendation';
      sectionLabel?: string;
    };
  };
}

// background -> content
export interface SaveContextProductMessage {
  type: 'SAVE_CONTEXT_PRODUCT';
  payload: { requestedAt: string };
}

// background -> content/panel
export interface SaveJobUpdateMessage {
  type: 'SAVE_JOB_UPDATE';
  payload: {
    jobId: string;
    asin: string;
    state: 'queued' | 'extracting' | 'enriching' | 'completed' | 'failed';
    enrichmentStatus?: 'complete' | 'partial' | 'failed';
    warning?: string;
    message?: string;
    errorCode?:
      | 'NO_PRODUCT' | 'PARSE_FAILED' | 'DB_WRITE_FAILED'
      | 'ENRICH_FETCH_FAILED' | 'ENRICH_PARSE_FAILED'
      | 'OFFSCREEN_UNAVAILABLE' | 'EXPORT_FAILED';
    collectionKey?: string;
    collectionLabel?: string;
    requiresCollectionChoice?: boolean;
    defaultCollectionKey?: string;
    downloadReady?: boolean;
    updatedAt: string;
  };
}

// content -> background
export interface RetrySaveProductMessage {
  type: 'RETRY_SAVE_PRODUCT';
  payload: { jobId: string };
}

export interface AssignSavedProductMessage {
  type: 'ASSIGN_SAVED_PRODUCT';
  payload: { jobId: string; choice: 'current' | 'new' };
}

export interface ExportSavedProductMessage {
  type: 'EXPORT_SAVED_PRODUCT';
  payload: { jobId?: string; collectionKey?: string };
}
```

`SAVE_PRODUCT` is **one product per message**; `products` arrays are deliberately avoided so a malformed batch can never drop siblings.

---

## Appendix B — settings UI copy

Section: **BEHAVIOR** (inside `SettingsOverlay`)

```
Right-Click Save Behavior
Controls the context-menu action and the card save button.

( ) Add to Current Collection          [default]
    Keep adding saved products to "<current collection label>".
( ) Create New Collection
    Create a separate collection for every saved product.
( ) Ask Every Time
    Save the product first, then ask where it should go.

[ ] Auto-download after each save
    Build the configured CSV/XLSX file as soon as a product is saved.
```

History entry:

```
[status dot] completed · 12 products · Oct 19, 4:12 PM   [Current]
https://www.amazon.com/s?k=writing+tools
[Preview] [Tab ↗] [Export] [Delete] [Make current]
```

---

## Appendix C — acceptance-criteria traceability

| Issue section | Requirement | Where addressed |
|---|---|---|
| §2.1 | Menu label exactly "Save Product Details", top-level | §4 C7, §13 Phase 1 |
| §2.2 | Right-click any product element; correct card; ignore unrelated; dynamic pages; no duplicate listeners | §8.1, §14.1 |
| §3.1–3.2 | One small icon per card; no side panel; discoverable, no obstruction; light/dark; dynamic; no duplicate buttons; no link activation | §8.2–8.4 |
| §3.3 | Idle / queued / extracting / enriching / completed / failed + retry; no duplicate jobs | §8.2, §8.4 |
| §3.4 | Efficient DOM observation; cleanup; no interference with Preview/History/collection | §8.3 |
| §4 | One shared pipeline; both entry points; save to History; collection behavior; export; notifications | §9 |
| §4 | No tab switching / visible tabs / waiting on PDP | §10 (fetch in background), §11 (offscreen) |
| §5 | Field coverage without fabrication | §12 |
| §5 | Preserve existing data model, no duplicate fields | §6 |
| §6 | Background enrichment via existing mechanism; bounded concurrency; graceful failure; partial save | §10 |
| §7.1 | Persistent History; survives tab close/restart | §6 (IndexedDB), §9 |
| §7.3 | ASIN identity; no unintended duplicates; don't overwrite valid data with empty values | §6.4, §8.4 |
| §8.2 | Setting "Right-Click Save Behavior" with A/B/C; A default | §6.5, §7, Appendix B |
| §8.2 C | Ask dialog, cancel keeps History | §7.4 |
| §13 (visible tail) | 10–20 sequential extractions; no mixing; worker suspension; interrupted jobs; existing features intact | §9, §10.4, §13, §15 |
| §14 | Deliverables: architecture assessment, change summary, smallest change, tests, modified files, limitations | This document; §13 file list; §14 |

---

### Immediate next step

If this plan is approved (and the decisions in §16 are confirmed), implementation starts with **Phase 0** — protocol + Dexie v2 + settings schema, which is additive and keeps `npm run verify` green before any UI work begins.
