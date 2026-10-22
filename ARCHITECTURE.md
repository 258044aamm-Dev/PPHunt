# PPHunt Architecture

Deep technical documentation for developers who want to understand, extend, or contribute to PPHunt.

---

## System Overview

PPHunt is a Chrome Extension (Manifest V3) with five entrypoints:

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser                                │
│                                                               │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────┐  │
│  │   Popup      │    │  Background SW   │    │  IndexedDB │  │
│  │   Chooser    │───▶│  (message router)│───▶│  (Dexie)   │  │
│  └──────────────┘    └───────┬──────────┘    └─────┬──────┘  │
│                              │                      │         │
│         ┌────────────────────┼──────────────────────┤         │
│         │                    │                      │         │
│  ┌──────▼──────┐    ┌───────▼──────────┐    ┌─────▼──────┐  │
│  │  Content    │    │  Side Panel      │    │  Overlay   │  │
│  │  Script     │◀──▶│  (React App)     │    │  (iframe   │  │
│  │  (scraper)  │    │                  │    │ in closed  │  │
│  │             │    │                  │    │ shadow rt) │  │
│  └─────────────┘    └──────────────────┘    └────────────┘  │
│                                                               │
│                      Amazon Page DOM                          │
└──────────────────────────────────────────────────────────────┘
```

### Entrypoints

| Entrypoint | File | Lifecycle | Purpose |
|-----------|------|-----------|---------|
| Background | `background.ts` | Service worker (sleeps/wakes) | Message routing, tab tracking, mode preference |
| Content Script | `amazon.content.ts` | Injected on Amazon pages | DOM scraping, auto-scroll, dedup |
| Side Panel | `sidepanel/index.html` | Persistent across tab switches | Main React UI |
| Popup | `popup/index.html` | Opens when no mode preference is saved | Mode chooser |
| Overlay | `overlay/index.html` | Extension-origin iframe mounted in a host page | Shared React UI |

---

## Data Flow

### Collection Pipeline

```
1. User clicks "Start" in Side Panel / Overlay
       │
2. Side Panel sends START_COLLECTION → Background
       │
3. Background forwards COLLECT_PRODUCTS → Content Script
       │
4. Content Script:
   a. Detects page type (search / detail / category)
   b. Parses DOM using centralized selectors
   c. Deduplicates against existing ASINs
   d. Sends PRODUCTS_COLLECTED → Background
       │
5. Background:
   a. Inserts/enriches products in IndexedDB (bulkAdd / bulkPut, with per-row fallback)
   b. Sends UPDATE_PROGRESS → Side Panel
   c. Queues the batch for the two post-write stages below; neither is awaited
      by the message path, so progress and Stop Collection never wait on a fetch
       │
6. Post-write stage — optional detail enrichment (SAD-379, off by default)
    a. enrichCollectedProducts, bounded by enrichCollectedLimit (25/50/all)
    b. same enrichSavedProduct a save uses: product page → offscreen parse →
       fill descriptive fields, fill-only price family, snapshot
       │
7. Post-write stage — rating backfill (SAD-383, on by default)
    a. For each product whose row has a null rating or reviewCount and whose card
       printed neither: fetch the ACR popover for that ASIN (~3 KB),
       credentials 'omit', one attempt, shared circuit breaker
    b. offscreen parses stars + count; a payload of 0.0/0 is treated as "no
       reviews" and discarded rather than written
    c. backfillProductRating writes those two columns only — fill-only, never
       overwrites a value the card printed, one fetch per ASIN per run
    d. a failed fetch/parse/write is contained to that product; a `skipped`
       outcome (breaker open) drains the rest of the run
       │
8. Side Panel:
   a. useLiveQuery detects new rows in IndexedDB
   b. Table re-renders with new products
   c. Counter and progress bar update
```

### One-click Save Pipeline (SAD-141)

One pipeline serves both entry points — the context menu and the per-card button:

```
1. Content script resolves the product for the gesture
   (contextmenu/mousedown capture, or the card the button lives in)
       │
2. SAVE_PRODUCT { jobId, product, context } → Background
       │
3. Background:
   a. job-store.begin() mirrors the job into storage.session
   b. resolves the collection (current / new / ask) and writes the product
      row + a listing snapshot in ONE Dexie transaction
   c. reports "completed" the moment the row exists — enrichment is an upgrade
       │
4. Background enrichment (no tab is opened):
   a. fetchPdpHtml() with credentials: 'omit', one retry, circuit breaker
   b. offscreen document parses the HTML (DOMParser lives there)
   c. merge into the existing row: descriptive fields fill, the price family
      is fill-only, nulls never erase, listing context is untouched
   d. a detail snapshot records the observation
       │
5. Background emits SAVE_JOB_UPDATE (state, enrichmentStatus, warning) to the
   originating tab and the panel; the card leaves its spinner
       │
6. If the worker was suspended mid-job, the next start rehydrates
   storage.session, drops jobs older than 15 minutes and resumes each job at
   most once; a second death reports enrichmentStatus: 'interrupted'
```

### Why a collection needs a second source for ratings (SAD-383)

The save and collection pipelines parse the same card, so a rating that is
missing from a collected row and present on a saved row cannot be a parser
difference. It is a markup difference: on some collection surfaces the card has
no rating node at all. Measured 2026-10-21 — `/gp/bestsellers/kitchen`: 30 cards,
30 ratings; `/deals`: 8 faceouts, **0** rating markers. There is nothing for the
card parser to read, so the pair is fetched after the write from Amazon's own
average-customer-review popover, which serves the same numbers as the product
page in ~3 KB instead of ~2.6 MB. Full evidence and the fixtures both stages are
verified against: `docs/plans/SAD-383-evidence-2026-10-21.md`.

Export is a separate, on-demand step: `EXPORT_SAVED_PRODUCT` (toast action or
`quickSaveAutoDownload`) → `buildCollectionExport()` → offscreen builds
CSV/XLSX bytes → `downloadBlob()` → `downloads.download({ conflictAction:
'uniquify' })` → the blob URL is revoked on `complete`/`interrupted` (60 s
backstop).

### Collection Enrichment (SAD-385)

A collection run stores what a listing card prints, then continues into the
**same** enrichment stage the save pipeline runs — `enrichSavedProduct()`
(fetch → offscreen parse → field-scoped merge → detail snapshot). It is not
optional, because two of the fields a card never prints exist only on the
product page: `weight` (`extractDetailWeight`) and the full twister
`variations` (`extractDetailVariations`). A collection that skipped this stage
could never carry them, whatever the mode — `mode` only selects the scroll
driver below, it never reaches a parser.

```
PRODUCTS_COLLECTED (per batch)
   │
   ├─ validateAndNormalize → addProducts()          (row is durable here)
   └─ enqueueCollectionEnrichment()                 (never awaited)
            │
            ▼
      enrichment-pump.ts — one queue, one serial runner, deduped per
      (sessionKey, asin), drained when a fetch returns `skipped`
            │
            ▼
      enrichSavedProduct({ jobId: 'collect:<session>:<asin>' })
            │
   run boundary (Stop / completion)
      └─ reconcile: rows of the session still missing `weight` or
         `variations` are queued once more, BEFORE the per-run bookkeeping
         (dedupe set + budget) is cleared
```

Four properties are load-bearing:

1. **Nothing on the collection path awaits enrichment**, so progress messages and
   Stop Collection never wait on a ~2.4 s fetch; a row can be visible at card
   quality and fill in afterwards.
2. **A failure is never a collection error.** The row keeps its card data and the
   run continues, exactly as a failed save does.
3. **The budget is per run** (`enrichCollectedLimit`: `25` / `50` / `all`,
   default `all`), resolved by the cached reader in
   `utils/enrich-collected-flag.ts` — mirrored into `storage.local` because the
   worker answers synchronously on every batch.
4. **The queue is in memory, the rows are not.** A worker suspension drops the
   remaining tail, which is why the run boundary reconciles from the rows. The
   reconciliation is idempotent per session and runs before the bookkeeping is
   cleared: the other order would re-fetch products the run already attempted,
   with no cap.

Deliberate trade-offs: one extra request per collected product (bounded by the
limit and by the host circuit breaker in `enrichment-fetch.ts`), ordering between
the row and its detail fields is not guaranteed, and a product page that prints
no weight is attempted once per run rather than retried.

### Automatic Mode (Additional Steps)

```
4a. Content Script starts ScrollController
    - Scrolls page by scrollAmount (±20% jitter)
    - Waits waitAfterScroll for new content
    - MutationObserver detects new DOM nodes
    - Re-parses and deduplicates
    - Stops when target reached or end-of-page
```

---

## Message Protocol

The background and content-script routers call `validateExtensionMessage`
before dispatch. A malformed message with a **known** type receives
`{ ok: false, error: 'INVALID_MESSAGE' }`; an unknown or missing type is ignored.
The validator checks the schema but returns the original object, so it does
not strip extra fields. This is not an authentication boundary or a claim that
every UI listener validates incoming messages. The union has 14 message types.

### Side Panel → Background

| Type | Payload | Description |
|------|---------|-------------|
| `START_COLLECTION` | `{ mode, targetCount, tabId, sessionKey? }` | Begin collecting |
| `RELOAD_AND_RETRY_COLLECTION` | `{ mode, targetCount, tabId, sessionKey? }` | Reload the tab and retry after CAPTCHA/recovery |
| `PAUSE_COLLECTION` | `{ tabId }` | Pause collection |
| `RESUME_COLLECTION` | `{ tabId }` | Resume collection |
| `STOP_COLLECTION` | `{ tabId }` | Stop collection |

### Background → Content Script

| Type | Payload | Description |
|------|---------|-------------|
| `COLLECT_PRODUCTS` | `{ mode, targetCount, scroll?, existingAsins? }` | Start/continue scraping |
| `PAUSE_SCROLLING` / `RESUME_SCROLLING` | No payload | Auto-scroll control |
| `STOP_COLLECTION_CMD` | No payload | Abort the in-page loop |

### Content Script → Background

| Type | Payload | Description |
|------|---------|-------------|
| `PRODUCTS_COLLECTED` | `{ products[], totalCount, isNewBatch }` | New products found |
| `COLLECTION_PROGRESS` | `{ collected, target, status }` | Progress tick |
| `CONTENT_ERROR` | `{ code, message, diagnostic? }` | CAPTCHA / sign-in / blocked |

### Background → Side Panel

| Type | Payload | Description |
|------|---------|-------------|
| `UPDATE_PROGRESS` | `{ collected, target, status, error: nullable string, sessionKey?: nullable string, diagnostic? }` | Forwarded progress |
| `TAB_STATUS_CHANGED` | `{ tabId, url, isAmazon, pageType }` | Active-tab context changed |

> The overlay is opened directly by the background via
> `lib/overlay/openOverlay.ts` (`openOverlayForTab`) — there is no
> TOGGLE_OVERLAY message; the earlier docs described a message that never
> existed.

---

## Database Schema

PPHunt uses [Dexie.js](https://dexie.org) (IndexedDB wrapper) with 5 tables.

The following files are authoritative; avoid copying partial interfaces into
this document as if they were complete schemas:

| Store | Indexes (database v3) | Data contract |
|---|---|---|
| products | `++id, asin, sessionKey, collectedAt, [sessionKey+asin]` | [`Product`](src/types/product.ts), [`ProductSchema`](src/lib/schemas/product.ts) |
| sessions | `id, tabId, status, startedAt, updatedAt` | [`SessionState`](src/types/session.ts) |
| settings | `id` | [`SettingsSchema`](src/lib/schemas/settings.ts) |
| history | `++id, sessionKey, startedAt, completedAt, status` | [`CollectionHistory`](src/types/session.ts) |
| snapshots | `++id, asin, sessionKey, capturedAt, [asin+capturedAt]` | [`ProductSnapshot`](src/engines/amazon/types/index.ts) |

[`database.ts`](src/engines/amazon/db/database.ts) keeps v1 for existing-install
upgrades; **v2 adds the `snapshots` store and nothing else** — the v1 stores are
inherited untouched and no row is rewritten on upgrade. **v3 (SAD-392) is
data-only**: `stores({})` inherits the v2 schema, and its upgrade pass cleans
`availability` values in `products` and `snapshots` that were polluted by
embedded-script text before the write-side fix, via the signature-gated
`sanitizeAvailabilityText`
([`availability-text.ts`](src/engines/amazon/utils/availability-text.ts)) —
clean values pass byte-identical, malformed non-strings pass untouched, and
only changed rows are written (Dexie 4's `Collection.modify` skips a write only
on `return false`). The pass is fault-contained end to end: a throwing Dexie
upgrade would block every DB open and take the extension down.

> **The `[sessionKey+asin]` compound index on `products` was not removed and must
> not be removed.** It is declared in v1 and is load-bearing:
> `quick-save.ts`, `assignment.ts`, `product-assignment.ts` and
> `enrich-saved-product.ts` all look a row up with
> `db.products.where('[sessionKey+asin]').equals([sessionKey, asin])`, and a
> missing compound index makes that query throw — i.e. every one-click save
> would fail.
A snapshot is one observation of a product — `source: 'listing' | 'detail'`,
the price/availability at that moment, and the job that produced it — so a
re-save or a delayed enrichment can never rewrite history. Product fields include optional
metadata such as list price, discounts, delivery and page URL. Session status
includes `interrupted`. Settings use 26 boolean field toggles, target bounds
1–1000, in-panel toast notifications, and `exportImages: auto / always / never`.
The legacy export-format value `xlsx` normalizes to `excel`.

---

## Scraping Pipeline

### 1. Page Detection

`page-detector.ts` classifies the current URL and DOM:

| Pattern | Type |
|---------|------|
| `/dp/<ASIN>` or `/gp/product/<ASIN>` | `product-detail` |
| `/s?k=` or `/s?i=` or `[data-component-type="s-search-result"]` | `search` |
| `/Best-Sellers/` or `bestsellers` in path | `bestsellers` |
| `/b/` or `#departments` in DOM | `category` |
| `#productTitle` in DOM | `product-detail` (fallback) |
| None match | `unknown` |

### 2. CSS Selectors

The shared selector tables live in `selectors.ts`, organized by page type:

See [`selectors.ts`](src/lib/scraper/selectors.ts) for the current selector
arrays. Parsers also use metadata extraction and structural fallbacks; a markup
change may require parser changes, not just edits to the shared tables.
Live selector validity was not verified in this remediation.

#### Availability text comes from the rendered page (SAD-392)

Amazon embeds non-rendered nodes inside buybox containers: an `a-state` JSON
`<script>` sits in the `#availability` div of every captured PDP, and the
delivery-restricted variant hosts an AOD asset-loader `<script>` next to the
message. A raw `textContent` read serializes those bytes into the field — the
reported row stored a 1011-character blob of `P.when(…)` code ahead of the real
message. Availability reads therefore go through `extractAmazonElementText` in
[`field-parsers.ts`](src/engines/amazon/scraper/field-parsers.ts): byte-identical
to `textContent` whenever the element hosts no `script`/`style`/`noscript`
descendant (every captured clean shape — that identity is why working extractions
did not move), and read from a detached clone with those nodes stripped when one
exists. Both the product-page availability loop (all three selectors, including
the `#outOfStock` fallback) and the listing card's stock read use it; the card's
leaf-node fallback reads only childless nodes and is structurally immune — left
untouched. Rows stored before this rule are cleaned **once** by database v3 (see
Database Schema): a migration, not display-time hooks.

#### Deal and discount evidence (SAD-386)

The two price-adjacent badge fields are read from **one** place:
[`deal-evidence.ts`](src/engines/amazon/scraper/deal-evidence.ts) owns the deal
vocabulary and the evidence rule; `scanDiscountNodes()` in `field-parsers.ts`
owns the printed-percentage rule. Both the listing path and the product-page
path call them, so the two cannot drift apart (they had: the product page's copy
was missing `cyber monday` and the locale words).

Three rules are load-bearing:

1. **Text the page printed outranks anything derived.** A derived value is only
   used when no badge text is readable.
2. **A derived value says so.** `dealBadge` from a struck list price is stored
   as the canonical `Deal` and reported with `source: 'derived'`; the switch is
   `TREAT_STRUCK_LIST_PRICE_AS_DEAL`.
3. **A percentage is only stored if the page printed one.** No percentage is
   computed from price and list price.

Shared slots are gated by vocabulary, never by position: the status-badge slot
also renders "Amazon's Choice", so a value from it must pass the deal lexicon.
The product-page bounded scans honour `detail.excludedSubtrees`, so a
similar-items carousel can never answer for the product.

The parse cache never freezes a card before its price family exists. SAD-383
already treated a card as settled only once `rating`/`reviewCount` were present;
SAD-386 extends the same rule to `discountPercentage`/`dealBadge`/`listPrice`.
A card that is not settled is re-read **once per actual DOM change** (its
subtree signature), and a settled card is re-read only when its text now carries
a `%` or a deal label — so a badge injected after the first pass is picked up,
and a settled card is never re-parsed otherwise.

### 3. Parsing

Each page type has a dedicated parser:

- `parseSearchResults(document, pageUrl?, cache?)` → `ScrapedProduct[]`
- `parseProductDetail(document, url?)` → `ScrapedProduct | null`
- `parseCategoryPage(document, pageUrl?, source = 'category', cache?)` → `ScrapedProduct[]`

#### Image extraction precedence (SAD-351)

All three parsers reach the DOM through `extractBestImageUrl(img)`, which tries
these sources in order and returns the first hit:

1. `data-old-hires` / `data-a-hires`
2. `data-a-dynamic-image` (largest `[w, h]` area)
3. `srcset`, then the first `<picture><source srcset>` — **split comma-aware**:
   a comma only separates candidates when the next token starts a URL
4. `img.currentSrc` — the URL the browser actually fetched
5. `src` / `data-src` / `data-lazy-src`

Steps 3 and 4 are ranked together rather than tried in sequence: the highest
descriptor wins (2x over 1x, 452w over 226w), and a candidate whose URL names an
image file (`.jpg/.jpeg/.png/.webp/.avif/.gif`) outranks one that does not.
`currentSrc` enters with a zero score, so it can never outrank a parsed
candidate — it only rescues a srcset that produced nothing renderable.

Why the comma handling exists: Amazon's `/deals` `ProductCard` grid embeds a
comma inside its size token (`…_AC_SF226,226_QL85_.jpg`). Naive `split(',')`
truncates the file name to `…_AC_SF452`, which the media CDN answers with
HTTP 400. Search and best-seller cards use comma-free tokens (`_AC_UY218_`,
`_AC_UL320_`), which is why the bug was invisible on those pages.

#### Variations & Weight extraction (SAD-357)

- **Variations (`variations`)**: Search and category cards read color/pattern
  swatches scoped strictly to `.s-color-swatch-container` (`aria-label` swatches
  plus `+N other colors/patterns` overflow counts). Product detail pages use a
  3-tier waterfall — embedded `twister-js-init-dpx-data` balanced JSON (with
  `dimensionValuesDisplayData` fallback), inline/classic Twister DOM rows, and
  `#tmmSwatches` format editions — preserving every dimension and option value
  verbatim while rejecting singleton (`<= 1`) definitions. Authoritative `detail`
  merges upgrade partial card swatch hints across `dedup.ts`, `db/products.ts`,
  and `enrich-saved-product.ts`, and `CellExpandModal` (`SAD-358`) renders a
  per-dimension breakdown on expansion.
- **Weight (`weight`)**: Extracted from structured PDP containers (`techSpec`,
  `detailBullets`, 2026 `#productDetails_expanderTables_*`, `productOverview`)
  using a 4-tier waterfall: direct item-weight labels (`Item Weight`,
  `Product Weight`, `Weight`) -> packaged/shipping weight -> semicolon
  `Product Dimensions` mass segment -> `#aplus` brand spec tables, ignoring
  excluded comparison/sponsored subtrees and sorting by gram mass in
  `product-sorter.ts`.

#### Per-field extraction diagnostics (SAD-359)

`src/engines/amazon/scraper/extraction-diagnostics.ts` is a pure, DOM-free
module that records **why** a product field is not a complete value. The PDP
detail parser already decides all of it — which selector won, whether a
candidate node existed but its text could not be parsed, whether JSON-LD had
to rescue a rejected DOM candidate, whether validation later dropped the
value — and used to throw the decision away. A collector is threaded through
the parser as an optional out-parameter so those decisions become one
structured report per product.

Each of the 24 modelled detail fields carries exactly one status:

| Status | Meaning |
|--------|---------|
| `EXTRACTED` | the final value is present and was kept |
| `MISSING` | the source was searched and the field was **not found** |
| `PARSE_FAILED` | the source **was found** and the extraction logic failed on it |
| `PARTIAL` | a value was obtained but is incomplete (JSON-LD rescue, or dropped by validation) |
| `UNKNOWN` | the parser never reached the field, so nothing is claimed about it |

The five counts partition the report, so every field is accounted for. The
report never changes what is extracted: the collector only records, and the
parsed product is byte-identical with and without it.

The report reaches the console as one line of JSON behind the prefix
`[PPHunt][Amazon][Diagnostics]` — in the **service worker** console for a
PDP save (`stage: "detail-page"`), an enrichment parse
(`stage: "enrichment-parse"`), a card save (`stage: "card"`) and each
collected product (`stage: "collection-card"`). The aggregate card-drift line
is also printed in the **service-worker** console (D10); the content script
sends a counts-only `DRIFT_REPORT` message rather than writing to the page
console. One-line JSON is deliberate: console objects collapse to `…` when
pasted out of DevTools, one-line JSON survives copy-paste and stays greppable.
Only statuses, sources, selectors, reasons and counts are logged — never
titles, prices, or page content.

### Diagnostics in every situation + setting (SAD-369)

Amazon diagnostics are controlled by the independent local-storage key
`pphuntDiagnosticsEnabled`, which defaults to **false** (off). The switch is
in Amazon Settings; a cached, fail-closed reader and `storage.onChanged`
subscription make it effective without reloading the Amazon page. The key is
not part of `AmazonSettingsSchema` or IndexedDB, so there is no settings
migration/version bump. "Restore defaults" resets the flag explicitly.

Diagnostics are a **side channel**. Card and product-detail parsers only
create collectors when a sink is supplied; the extracted object must remain
byte-identical with and without that observer. The shared card recorder
models all 24 fields: **20 card-extractable** fields and **4 card-inapplicable**
fields (`description`, `features`, `weight`, `warrantyDescription`), which
are `MISSING` with an explicit card-only reason (D4). Card cascade reports
carry `tier`, not `selector`. The price cascade's additive
`unparseablePriceTier` marks a present-but-unparseable card price as
`PARSE_FAILED` only when no price tier succeeds; price, currency and
`priceTier` remain unchanged (D9).

A per-run collection sink keys the first report by normalized ASIN, accepts
at most 50 **unique** products with reports (D7), resets at the collection
boundary, and sends each report only once even when an `updatedExisting`
batch re-sends products (D11). It does not participate in either save path,
so the cap never applies to saves (D8). A collection started on a product
page uses the same `collection-card` stage (G10). Collection reports are an
optional ASIN-identified subset on `PRODUCTS_COLLECTED`, never a parallel
array.

The four per-field stages are `detail-page`, `enrichment-parse`, `card`, and
`collection-card`; the aggregate stage is `drift`. All lines are gated by the
same switch and emitted to the **single service-worker console**. Drift keeps
its previous prefix and JSON shape, but the content script now routes it via
`DRIFT_REPORT` to the worker; the Amazon page console receives no diagnostics
lines (D10).

`scripts/sad-359-diagnostics-measurement.mjs` is the measurement harness
(spike tool, not bundled, not in CI): it drives the built extension against
real pages, checks product reports against the stored row, supports the
`--flag on|off` diagnostic gate check, captures worker lines separately from
page lines (including drift), can exercise a listing card save (`--l3`), the
card icon (`--l4`), a cap run (`--target`), and live switch flips (`--l8`).

#### Temu engine diagnostics (SAD-360)

The Temu engine mirrors the SAD-359 design with one important difference: it
never touches transport in the parsers. `src/engines/temu/scraper/extraction-diagnostics.ts`
is a DOM-free collector; both parsers accept an **optional trailing
collector** (`parseTemuProductDetail(..., diagnostics?)`,
`parseTemuSearchResults(..., diagnosticsByGoodsId?)`, forwarded by
`parseTemuCategoryPage`). Passing one cannot change the collected product —
every fixture is replayed with and without it and compared byte-for-byte.

Field sets are stage-specific: **22 PDP fields**, and **20 card fields**
(`description`/`features` are hardcoded on cards, so reporting them would be
permanent `MISSING` noise). `asin`, `source` and `categoryBreadcrumb` are never
reported: `goodsId` is the envelope identifier and `source` is the stage.

Evidence precedence at the DOM → JSON-LD merge, strongest first:

| Evidence | Status recorded |
|---|---|
| value kept from any source | `EXTRACTED` |
| DOM candidate found, parser rejected it, JSON-LD rescued the field | `PARTIAL` |
| DOM candidate found and rejected, nothing rescued it | `PARSE_FAILED` |
| JSON-LD carried the property but its value was unusable | `PARSE_FAILED` (`source: json-ld`) |
| JSON-LD block was malformed, so absence cannot be attributed | `UNKNOWN` |
| helper searched and found nothing | `MISSING` with a field-specific reason |
| parser never reached the field (aborted / goodsId-less PDP) | `UNKNOWN` |

`validated:false` is reserved for a value the existing
`validateAndNormalizeTemuScrapedProduct` dropped (e.g. a `listPrice` equal to
`price`, a non-HTTP image URL). A legitimate `false` boolean or a `0` rating is
an extracted value, never a validation failure.

Transport stays additive: `TEMU_PRODUCTS_COLLECTED` gains an **optional**
`productDiagnostics` array, so a message from an older content script still
validates. The content script attaches reports only for the bounded products in
the message it actually sends, and never on the `collectedSoFar` re-send branch.
A later-stage visit (for example the PDP of a product collected from search)
sends a diagnostics-only message with `products: []`; the background then
verifies that the product is already persisted in the session before logging and
never re-saves it.

The background logs one line per product behind `[PPHunt][Temu][Diagnostics]`
in the **service-worker** console, carrying `goodsId`, the resolved
`sessionId`, the `stage`, the five counts and the per-field entries. Products
rejected by the background get no line (the existing `rejectedCount` path is
unchanged), and at most one line is emitted per
`(sessionId, goodsId, stage)` — the ledger lives in memory and in
`browser.storage.session` so suppression survives a worker restart. If that
storage fails the logger **fails open** (it still logs): losing diagnostics is
worse than a rare duplicate, and persistence is never affected.

### 4. Deduplication

`DeduplicationEngine` maintains two Sets (ASINs and URLs):

```typescript
const dedup = new DeduplicationEngine(existingProducts);
const unique = dedup.filterNew(scrapedProducts); // O(1) per check
```

**Source follows the PDP, upgrade-only (SAD-392).** `source` says where a row
was authoritatively observed. `mergeScrapedProductFields` promotes a
`'search'`/`'category'` target to `'detail'` when a PDP observation merges onto
it, and never downgrades on a listing re-observation. The rule sits **after**
the SAD-357 variations upgrade, whose condition reads the pre-promotion
`target.source !== 'detail'` — promoting first would silently kill the
variations upgrade (pinned by test). `enrichStoredProductFields` (the
`addProducts` background write) applies the same rule to its patch; the
enrichment path (`mergeDetailIntoStored`) deliberately never carries `source`.

### 5. Price Parsing

`price-parser.ts` handles common Amazon price formats; representative outputs without a currency fallback:

| Input | Output |
|-------|--------|
| `$49.99` | `{ value: 49.99, currency: 'USD' }` |
| `€39,99` | `{ value: 39.99, currency: 'EUR' }` |
| `£1,299.99` | `{ value: 1299.99, currency: 'GBP' }` |
| `¥3,980` | `{ value: 3980, currency: 'JPY' }` |
| `See price at checkout` | `{ value: null, currency: null }` |

---

## Dual-Mode Architecture

Both Side Panel and Overlay render the **same React component tree**. The difference is the mounting context.

| Aspect | Side Panel | Overlay |
|--------|-----------|---------|
| Mount | `document.getElementById('root')` in HTML page | **Iframe at the extension origin inside a closed shadow root** (`lib/overlay/overlayHost.ts`) — the closed root isolates the iframe + resize handle from page CSS; the extension origin lets the overlay share IndexedDB with the side panel |
| CSS | Global Tailwind import | Own document inside the iframe (full Tailwind build) |
| Fonts | Google Fonts `<link>` in HTML | Google Fonts `<link>` in the iframe HTML |
| Width | User-resizable (Chrome native) | Drag handle, normally 300–800 px with viewport-dependent clamps; see `overlayHost.ts` |
| Lifecycle | Persists across tab switches | Lives on an allowed HTTP(S) host tab; collection is Amazon-specific |
| Z-index | Chrome-managed | `2147483647` (maximum) |

> **External dependency (M-8, SAD-184):** all three pages (side panel, popup,
> overlay) load their typefaces from Google Fonts via `<link>` tags in their
> HTML. Amazon page/image requests also occur. Blocking
> `fonts.googleapis.com` / `fonts.gstatic.com` degrades gracefully to the
> Georgia / system-ui / ui-monospace fallback stacks declared in
> `tailwind.config.js`. See the README's Local-first note for the full
> disclosure.

### Mode Switching

The background disables automatic side-panel-on-click behavior. With no saved
mode, it sets the action popup to `popup.html`. With a saved mode, it clears the
popup and handles `action.onClicked`: `sidePanel.open({ tabId })` for the side
panel or `openOverlayForTab(tab.id, tab.url)` for the overlay. Unsupported overlay
URLs fall back to the side panel. Storage changes update the action configuration.
The chooser remembers the selected mode only when its checkbox is enabled.
There is no implemented Shift-click shortcut to force the chooser.

Sources: [`background.ts`](src/entrypoints/background.ts),
[`popup/main.ts`](src/entrypoints/popup/main.ts),
[`openingMode.ts`](src/lib/ui/openingMode.ts).

### Preview table scrolling (SAD-378)

The product table is virtualised and wide (≈3,354 px with the default columns),
so horizontal scrolling is the primary way to reach the right-hand fields. The
preview therefore has exactly **one** horizontal scroll surface, in every display
mode and in both engines:

- `preview-table-scroll-container` (`AmazonProductTable.tsx`,
  `TemuProductTable.tsx`) is the only element with `overflow-x`. It owns the
  SAD-138 scrollbar styling, the `role="region"` label, `tabIndex={0}`, and the
  Arrow-key / Shift+wheel handlers; the virtualizer reads it as its scroll
  element.
- **Separate collapsible category sections must not introduce a nested
  horizontal scroller.** That mode re-uses the same container: the wrapper is
  `w-max min-w-full` (content width = widest table), each card is
  `overflow-clip` (clips to its border *without* becoming a scroll container,
  which would re-clamp the table and cancel `sticky`), and each header bar is
  `sticky left-0 w-[100cqw]`.
- `w-[100cqw]` resolves against `.preview-table-scroll`, which declares
  `container-type: inline-size` in `global.css`. Removing that declaration
  silently stretches the header bars to the table width instead of the visible
  panel width. Both the structure and the declaration are pinned by
  `tests/preview-sections-scroll-sad378.test.tsx`.

Sources: [`AmazonProductTable.tsx`](src/engines/amazon/ui/table/AmazonProductTable.tsx),
[`TemuProductTable.tsx`](src/engines/temu/ui/table/TemuProductTable.tsx),
[`global.css`](src/entrypoints/sidepanel/global.css).

---

## Extension Lifecycle (MV3)

### Service Worker Sleep/Wake

The background service worker can be terminated by Chrome at any time. PPHunt handles this (Phase 4, H-8):

- **Active-session pointer** — the in-memory pointer is mirrored to `chrome.storage.session` on every mutation and rehydrated before use; `storage.session` survives worker termination within a browser session and is wiped on browser close
- **IndexedDB fallback** — where `storage.session` is unavailable (Firefox / older Chrome), the worker falls back to the most recent active session row in IndexedDB
- **Startup reconciliation** — when the pointer is absent but `storage.session` exists (the signature of a browser restart), every leftover `'collecting'` session row is flipped to `'interrupted'`: at that moment nothing can legitimately be collecting (Phase 9, L-5)
- **Message handling** — messages wake the worker; the router hydrates the pointer before touching session state

### Content Script Injection

- WXT injects content scripts on page load (`runAt: 'document_idle'`)
- After tab reload, the content script is re-injected automatically
- Session recovery re-establishes the message channel
- If injection fails (CSP, about:blank), the background catches the error and notifies the side panel

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| **Dexie over chrome.storage** | IndexedDB handles large datasets (10k+ products) efficiently. chrome.storage.local has a default quota; storage APIs are asynchronous. |
| **Zustand over React Context** | Zustand manages UI state within each document; IndexedDB shares persisted data across side panel and overlay. No provider wrapping needed. |
| **Zod for messages** | Runtime validation catches malformed messages between contexts. 14 schema-defined message types; additional object fields are preserved by the validator. |
| **Centralized selectors** | Shared selector tables reduce duplication; parsers also contain structural and metadata fallbacks. |
| **Set-based dedup** | O(1) per lookup vs O(n) for array.includes(). Critical when collecting 1000+ products. |
| **±20% jitter on scroll** | Varies the scrolling cadence; this does not guarantee avoidance of anti-scraping detection. |
| **storage.session pointer (H-8)** | Module-scope state dies with the MV3 worker; `storage.session` survives for the browser session (survives worker bounces, cleared on browser close). |
| **Parse cache (Phase 5)** | A WeakMap keys cached results by card element; incomplete products are re-parsed so late hydration can enrich them. |
| **Bounded XLSX image embedding (Phase 8)** | Auto mode allows embedding only for at most 200 products, with 25 MiB fetched-image and 20-second image-fetch budgets. Always mode bypasses these auto budgets. They do not bound total workbook generation time or final file size. |
| **No shadows** | PPHunt design rule: depth via surface tones and 1px borders, never box-shadow. |
| **8px bottom-only radius** | PPHunt signature: buttons have flat tops, rounded bottoms only. |

---

## File Index

No line counts on purpose: they are wrong the moment anyone edits a file
(Phase 10, L-7). Path + responsibility only.

| Path | Purpose |
|------|---------|
| `wxt.config.ts` | WXT configuration, manifest permissions |
| `tailwind.config.js` | PPHunt design tokens |
| `src/entrypoints/background.ts` | Message router, tab tracking, mode preference, session-pointer hydration |
| `src/entrypoints/amazon.content.ts` | Content script: parsers, dedup, scroll, messaging |
| `src/entrypoints/popup/` | Mode chooser popup |
| `src/entrypoints/sidepanel/` | Main React UI (app shell, components, virtualized table, hooks, Zustand stores) |
| `src/lib/db/` | Dexie database + CRUD modules + storage.session pointer (`session-state.ts`) |
| `src/lib/schemas/` | Zod schemas (product, settings, messages, validation entry point) |
| `src/lib/scraper/` | Page detection, centralized selectors, per-page-type parsers, field parsers, dedup engine, parse cache, scroll controller, CAPTCHA detector, mutation debounce |
| `src/lib/export/` | CSV, Excel (SheetJS 0.20.3 patched, CFB image injection with budgets), clipboard engines, column mapping |
| `src/engines/amazon/background/` | Save pipeline (`save-job.ts`), job store + recovery (`job-store.ts`, `save-job-recovery.ts`), PDP enrichment (`enrichment-fetch.ts`, `enrich-saved-product.ts`), export service (`export-service.ts`, `export-collection.ts`), offscreen client, collection resolution |
| `src/engines/amazon/offscreen/` | Offscreen protocol, request dispatcher, PDP parser, export builder (the only context with `DOMParser` and `URL.createObjectURL`) |
| `src/engines/amazon/content/` | Card action layer/button, save-target capture, collection-choice dialog, save toast |
| `src/engines/amazon/scraper/extraction-diagnostics.ts` | Per-field extraction diagnostics: the five statuses, the collector, the counts and the one-line log formatter |
| `src/lib/overlay/` | Overlay host (iframe in closed shadow root) + open/allow logic |
| `src/lib/ui/` | Theme + opening-mode preferences |
| `src/lib/diagnostics/` | Error diagnosis (categories, recovery actions, clipboard report) |
| `src/lib/utils/` | Price parser, currency, formatters, a11y helpers |
| `src/types/` | TypeScript interfaces |
| `src/constants/` | Default values and target/scroll bounds; image budgets live in `src/lib/export/excel.ts` |
