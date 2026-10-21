# Changelog

All notable changes to PPHunt will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — Collection brand and Best Sellers Rank (SAD-384)

### Fixed
- Manual and Automatic collections attempt missing brand/Best Sellers Rank even
  with full enrichment off or beyond the 25/50 cap. Those requests fill only the
  two missing fields, preserving all other listing observations.
- Eligible full-detail products share one request with the fallback; the existing
  full-enrichment switch, defaults, budget and save merge behavior remain intact.
- A skipped row no longer discards unrelated queue items. Host cooldowns defer
  only that host, with bounded reattempts via the `alarms` permission.

### Changed
- Collection queue metadata is mirrored into a dedicated `storage.session` key
  before dispatch and recovered after worker suspension, preserving scopes and
  budgets. At most two dispatches per item; terminal dedupe retained for 24h.
- Settings now explain that the cap controls full details, not all PDP requests.
  STOP and collection completion still do not wait for network enrichment.

### Limitations
- Amazon can omit fields or block requests; nothing is inferred or fabricated.
- Session metadata does not survive browser exit. Recovery-storage failures log
  a warning and preserve listing rows, but cannot guarantee pending-tail recovery.
- Existing historical collections are not automatically backfilled.

The SAD-379 entry below records the previous behavior; its off/no-fetch and
in-memory-only statements are superseded by SAD-384.

## [Unreleased] — Ratings in Collection Mode (SAD-383)

A product's **rating** and **review count** were extracted correctly by the
right-click menu and by the per-card save button, but were missing from rows
added by Collection Mode — Manual and Automatic alike. Both gestures parse the
same card, so the difference was not the parser: a save continues into the
product page (`enrichSavedProduct`) and a collection did not.

The cause is in the markup, not in the scraper. On the layouts where the bug was
reported there is **no rating node on the card at all** — a `/deals` faceout
carries an image, a price and a title, and nothing to scrape. Measured on
2026-10-21: `/gp/bestsellers/kitchen` prints a rating on 30/30 cards, `/deals`
prints **0** on 8/8 faceouts. Nothing the card parser does can produce a number
that the page never rendered, so the field has to come from somewhere else.

### Added
- **Ratings backfill for collected products.** When a collected product is
  missing `rating` or `reviewCount`, the background now fills it after the row is
  written, from Amazon's own average-customer-review popover for that ASIN — the
  same numbers the product page shows, in ~3 KB instead of the ~2.6 MB page.
  Only the missing field is fetched and only that field is written: a value the
  card printed is never replaced, an existing value is never overwritten, and a
  product with no reviews is left empty rather than stamped `0.0`.
- **Settings → Collection Enrichment → *Backfill ratings*.** **On by default.**
  This is the one place where SAD-383 deliberately differs from SAD-379: turning
  the enrichment stage off is a bandwidth decision, but leaving the backfill off
  would leave the reported bug in place, because the cards in question print
  nothing to fall back on. Switching it off restores the previous behaviour
  exactly — no request, no queue, no write.
- The backfill is a stage of its own. `Enrich collected products` (SAD-379)
  remains **off by default** and the two switches are independent: either, both
  or neither can be on.
- Card diagnostics now report whether a rating node was **seen** (`nodeSeen`) as
  distinct from whether a value was parsed, so "Amazon did not render it" and
  "we failed to read it" are no longer the same line in the log.

### Fixed
- Collecting from a page whose cards carry no rating now produces rows with the
  same `rating` and `reviewCount` a save of the same card produces. This is the
  ticket's acceptance criterion and it is pinned as a test: the same real deals
  card taken through both pipelines ends with identical values (4.6 / 142,457).
- A saved row that already had a rating could lose it when the product page was
  slow or blocked. The parse cache now re-parses when the DOM it is handed
  differs from the DOM it cached, instead of returning the earlier (possibly
  rating-less) object for the same page signature.

### Unchanged
- **Other surfaces are untouched.** Search results, bestseller and category
  grids, product-page collections, the save pipeline, the export, the filter and
  sort logic and the Temu engine behave as before; the backfill only reads and
  fills two nullable columns on rows that already exist.
- **No settings migration.** `backfillCollectedRatings` is a
  required-with-default key like its predecessors: a settings row written before
  this change still parses, and `settingsVersion` is not bumped.
- **A collection never fails on the backfill.** A failed fetch, an unparseable
  response and a rejected write are each contained to the one product; the run
  continues. Nothing on the message path is awaited, so progress and Stop
  Collection never wait on a request. When the shared circuit breaker opens, the
  remainder of that run's backfill stops after one attempt instead of hammering
  Amazon.
- Ratings are still only ever *read* — no rating, review or price is invented,
  rounded or reformatted, and the fields remain nullable.

### Known limitations
- The backfill queue lives in memory, like SAD-379's: an MV3 worker suspension
  mid-run drops the remaining tail. Rows already written are unaffected.
- The popover is fetched per ASIN, one at a time. On a very large collection this
  is one small request per product that needed a rating; that is the intended
  cost of unbounded backfill, bounded only by the breaker.
- Deal and browse-node carousels are still not discovered as cards by
  `parseAmazonCategoryPage` — a separate, cross-surface defect recorded in
  `docs/plans/SAD-383-rating-and-rating-count-plan.md` §12. It is why a `/deals`
  collection can return very few rows; the rating fix cannot apply to rows that
  are never created.


## [Unreleased] — Collection enrichment (SAD-379)

A collection used to stop where a save kept going. Both pipelines parse the same
listing card, but a save then fetches the product page and merges the detail
fields, while a collection wrote the card and moved on — so a collected row
carried what the card printed (measured: 7 fields) and a saved row carried what
the product page added (median 19). Same card, same scraper, different result.

A collection now runs the save pipeline's enrichment stage.

### Added
- **Settings → Collection Enrichment.** *Enrich collected products* is **off by
  default**; when on, a per-run limit of **25 / 50 / every collected product**
  (default 50) bounds how many products pay for an extra request.
- A collection that enriches writes the same detail snapshot a save does, with a
  deterministic per-collection job id, so a repeated batch cannot invent a second
  observation for the same product.

### Unchanged
- With the switch off (the default) a collection run is byte-identical to before:
  no fetch, no queue, no storage write.
  *Amended by SAD-383:* this holds for the **enrichment stage**. A collection
  that needs no rating backfill is still byte-identical with the switch off,
  but SAD-383 adds an independent, **on-by-default** stage that fetches a
  rating for products whose card printed none. See the SAD-383 entry above;
  switching that stage off restores exact byte-identical behaviour.
- `enrichSavedProduct` itself is untouched — collection calls the same function,
  so merged fields, the price-family rules (the listing price still wins), the
  currency-mismatch freeze and the diagnostics log apply identically.
- One failed enrichment leaves the collected row exactly as it was and never
  fails the collection; a `skipped` outcome (breaker open or no host permission)
  stops the run's remaining fetches instead of hammering Amazon.
- Nothing is awaited by the collection's message path, so progress messages and
  Stop Collection never wait on a product-page fetch.

### Known limitations
- The pending queue is in memory: an MV3 worker suspension mid-run drops the
  remaining tail (rows are untouched). The `job-store` recovery pattern remains
  the upgrade path if this is observed in the field.

## [Unreleased] — Preview horizontal scrolling (SAD-378)

The preview table could not be scrolled sideways while **Separate collapsible
category sections** was on: each category card owned its own horizontal
scrollbar, painted at the bottom of a section that can be thousands of pixels
tall, and the table area itself had no horizontal overflow at all. There is now
**one horizontal scrollbar for the whole table** in every mode.

### Fixed
- **Sections mode scrolls sideways from the top of the panel.** The table area
  (`preview-table-scroll-container`) is the single horizontal scroll surface
  again: the sections wrapper is sized to its widest table (`w-max min-w-full`),
  the per-section `overflow-x-auto` is gone, and each card uses `overflow-clip`
  so it clips to its border without becoming a scroll container. Arrow keys and
  Shift+wheel scroll the table immediately, without scrolling down first. The
  fix applies to the side panel (Sidebar and Overview) and the dedicated
  `preview.html` tab, because all three render the same component.
- **Section header bars stay readable while scrolling.** Each bar is pinned to
  the left edge of the visible table area (`sticky left-0 w-[100cqw]`, backed by
  `container-type: inline-size` on the scroller) instead of stretching to the
  full table width.
- **The sort controls no longer clip in a narrow panel.** Below roughly 420 px
  the `+ Sort Field` select wrapped out of view behind `overflow-hidden`; the
  control group now wraps onto a second row. This affects Amazon and Temu alike,
  since both use the shared table toolbar.

### Unchanged
- The default (Sections off) table, Temu's table, sorting, filtering, category
  pills, row selection, delete, cell expand, export scopes and export order are
  untouched. Measured before/after geometry is recorded in
  `docs/plans/sad-378-scroll-measurement-2026-10-21.json`.
- Sections mode still renders every row rather than virtualising per section.
  That cost predates this change and is left as a separate follow-up.

## [Unreleased] — Diagnostics in every situation + an enable/disable setting (SAD-369)

> **Behaviour change:** extraction diagnostics are now **off by default**.
> This changes the unconditional logging shipped in SAD-359. Turn on
> **Enable extraction diagnostics** in Amazon Settings to opt in.

### Added
- **Card-level reports** for both listing parsers and both card-save entry
  points (right-click and the card icon). Each card report has the same 24
  fields as a product-page report: 20 fields the card can carry and 4
  card-inapplicable fields (`description`, `features`, `weight`,
  `warrantyDescription`) reported `MISSING` with an explanatory reason.
- **Per-product collection reports** sent to the service worker under the
  `collection-card` stage. The first 50 unique products with a report in each
  collection run are logged; re-parses do not consume slots, and the counter
  resets for a new run. Saves are not subject to the collection cap.
- **Explicit unparseable-price diagnostics**: when a card price node exists
  but its text cannot be parsed and no fallback tier succeeds, the report
  records `PARSE_FAILED` and the tier that first observed it; extracted price,
  currency and price tier remain unchanged.
- **A privacy-preserving, opt-in setting** in Amazon Settings. All four
  diagnostics stages (`detail-page`, `enrichment-parse`, `card`,
  `collection-card`) respect the switch.

### Changed
- The aggregate listing **drift line now prints in the service-worker
  console**, alongside the other diagnostics (D10). It retains the same prefix
  and JSON shape; it no longer prints in the page console.
- Collection reports ride on `PRODUCTS_COLLECTED` as an optional,
  ASIN-identified subset, not a parallel array. A report is delivered at most
  once per product per run even when a collection batch re-sends existing
  products.

### Unchanged
- Amazon extraction results, collection behavior, saves, enrichment, and
  persisted product values. Diagnostics are a side channel. The Temu engine is
  untouched; its diagnostics behavior remains independent.

## [Unreleased] — Temu per-field extraction diagnostics (SAD-360)

The Temu engine now reports, per product, which supported fields were extracted,
missing, partially extracted, unparseable or never attempted — for both the PDP
parser and the search/category card parser.

### Added
- **Temu-native diagnostics module (`src/engines/temu/scraper/extraction-diagnostics.ts`):**
  five statuses (`EXTRACTED` / `MISSING` / `PARSE_FAILED` / `PARTIAL` /
  `UNKNOWN`), stage-specific field sets (**22 PDP / 20 card**), validation
  reconciliation, partitioning counts and a one-line formatter.
- **Parser instrumentation:** `parseTemuProductDetail` and
  `parseTemuSearchResults` accept an optional trailing collector;
  `parseTemuCategoryPage` forwards it. The shared helpers in
  `field-parsers.ts` record candidate-level evidence (a node existed but was
  rejected vs. no node at all) without any new DOM query.
- **Additive transport:** `TEMU_PRODUCTS_COLLECTED` accepts an optional
  `productDiagnostics` array, so an older content script keeps working.
- **Service-worker logging:** one `[PPHunt][Temu][Diagnostics]` line per product
  the session actually holds, with the resolved `sessionId`, the stage and the
  five counts. Suppressed per `(sessionId, goodsId, stage)` across worker
  restarts via `browser.storage.session` (fail-open on storage errors).

### Notes
- **Diagnostics only.** No selector, extraction strategy, field mapping, data
  model, persistence, export, UI or Amazon behaviour changed. Every fixture is
  replayed with and without a collector and compared byte-for-byte.
- Products rejected by the background get no diagnostic line; the existing
  rejected-count path is unchanged. A PDP with no resolvable `goodsId` still
  emits one line with `goodsId: null`; id-less card skips stay silent.

## [Unreleased] — Per-field extraction diagnostics (SAD-359)

Amazon products are scraped by a 4-tier self-healing parser that decides
*why* a field is missing but used to throw that decision away. The engine
now keeps it: every supported field of a parsed product is reported with a
status, the source it came from, the selector that won, the reason it was
not usable, and whether the value survived validation.

### Added
- **Five field statuses (`src/engines/amazon/scraper/extraction-diagnostics.ts`):**
  `EXTRACTED` (value present and kept), `MISSING` (source searched, field not
  found), `PARSE_FAILED` (source **was** found and the extraction logic failed
  on it), `PARTIAL` (a value was obtained but is incomplete — a JSON-LD rescue
  over a rejected DOM candidate, or a value validation dropped) and `UNKNOWN`
  (the parser never reached the field, so nothing is claimed about it). The
  five counts partition the report, so every field is accounted for.
- **Per-field report for all 24 modelled detail fields**, including the
  product **URL** and its source: every entry carries `field`, `status`,
  `source` (`dom` / `json-ld` / `legacy` / `derived` / `url`), the winning
  `selector` or buybox `tier`, a `reason` for every non-extracted field, and
  `validated` where the value went through `validateAndNormalizeScrapedProduct`.
- **Readable console output:** one line of JSON behind the prefix
  `[PPHunt][Amazon][Diagnostics]`, carrying the extraction `jobId`, the ASIN,
  the `stage` and the per-status counts. Only statuses, sources, selectors,
  reasons and counts are logged — never titles, prices, or page content. The
  aggregate card-drift line a listing parse emits uses the same prefix with a
  `drift` tag, so one DevTools filter finds every diagnostic line.
- **Measurement harness (`scripts/sad-359-diagnostics-measurement.mjs`):** a
  spike tool (not bundled, not in CI) that drives the built extension against
  real product pages and checks the report against the row the extension
  actually stored.

### Changed
- **A rejected candidate is no longer reported as "partially extracted".** The
  19 detail-parser call sites that recorded *a node was found and the
  cleaner/parser refused it* now report `PARSE_FAILED`; `PARTIAL` is reserved
  for the two outcomes that really mean "incomplete". The reason strings are
  unchanged — only the status they are filed under.
- **A field the parser never reached is no longer reported as absent.** It is
  `UNKNOWN`, so the report never claims absence it cannot establish.
- **Absent fields now record where they were looked for** (`source`), so every
  entry answers "which source did we search?".

### Notes
- **Diagnostics only.** No selector, extraction strategy, field mapping, data
  model, enrichment, persistence, export or UI behaviour changed, and the
  Temu engine is untouched. The parsed product is byte-identical with and
  without the collector — pinned by a parity test.
- The log sink is the **service worker** console: for a PDP save the relevant
  DevTools context is the extension's *Service worker* target, not the page.
  The content-side aggregate (drift) line lands in the page console.
- Verified against live Amazon pages: 12 products parsed through the built
  extension, every per-field status agreeing with the row the extension
  stored, zero disagreements.

## [Unreleased] — Variations & Weight fields (SAD-357)

Add two first-class fields — **Variations** (`variations`) and **Weight**
(`weight`) — across the Amazon engine's scraping, persistence, background PDP
enrichment, sorting, preview table, modal expansion, settings, and exports.

### Added
- **Data model, settings & exports (`26` data-field toggles):** Added optional
  `variations` and `weight` fields to `ScrapedAmazonProduct` / `AmazonProduct`,
  default-on toggles in Settings → Data Fields, and `Variations` / `Weight`
  columns across CSV, Clipboard TSV, and Excel (`.xlsx`) with blank empty cells
  (`""` / `null`, per `SAD-348`).
- **Variations extraction & search → PDP upgrade:** Search and category cards
  extract `.s-color-swatch-container` swatches and `+N other colors/patterns`
  counts; PDPs run a 3-tier waterfall (`twister-js-init-dpx-data` balanced JSON
  with `dimensionValuesDisplayData` fallback → inline/classic Twister DOM →
  `#tmmSwatches` format editions), rejecting singletons (`<= 1`) and upgrading
  partial card swatch hints when an authoritative `detail` record merges.
- **Weight extraction waterfall:** Extracts physical mass (`mg`, `g`, `kg`, `oz`,
  `lb`/`lbs`, and compound `lb oz`) across legacy spec tables, 2026
  `#productDetails_expanderTables_*` containers, `detailBullets`, `Package Weight`
  and semicolon `Product Dimensions` fallbacks, and `#aplus` brand tables while
  ignoring excluded comparison/sponsored subtrees.
- **Physical-mass sorting & `SAD-358` cell expand:** `product-sorter.ts` sorts
  `weight` accurately by gram mass and `variations` numerically by option count;
  `variationsColumn` integrates with `ExpandableCell` + `CellExpandModal` to show
  a structured total-count pill and bulleted per-dimension breakdown without
  lossy truncation. Temu engine files remain untouched.

## [Unreleased] — Deal-page images (SAD-351)

Product thumbnails collected from the `/deals` grid never rendered, because the
image URL was stored truncated. Amazon puts a comma *inside* its size token
(`…_AC_SF226,226_QL85_.jpg`), and the parser split `srcset` on every comma, so
every deal card ended up pointing at `…_AC_SF452` — a URL the media CDN answers
with HTTP 400, which made the preview table fall back to the placeholder icon.

### Fixed
- **`srcset` candidates are split comma-aware** (`src/engines/amazon/scraper/field-parsers.ts`):
  a comma separates candidates only when the next token starts a URL, so Amazon's
  comma-bearing size tokens survive intact.
- **Candidates are ranked instead of first/last-matched.** The highest descriptor
  wins (`2x` before `1x`, `452w` before `226w`), and a URL that names an image
  file outranks one that does not. That tie-break is the guard against a
  truncated URL coming back; it is a preference, never a rejection, so an input
  whose candidates all lack an extension still resolves as before.
- **`img.currentSrc` is a trusted input.** It is the URL the browser actually
  fetched, so it cannot contain a split artefact. It ranks below every parsed
  candidate — the `2x` selection on search, best-seller and product-detail pages
  is unchanged — and wins only when nothing better parses.

### Notes
- No selector, schema, message, database, setting, export or UI change. The fix
  is confined to one function in one file; search, best-seller, category,
  product-detail, one-click save and offscreen enrichment keep their previous
  output (pinned by 9 parity tests in `tests/deal-page-images-sad351.test.tsx`).
- Temu is untouched: its parser has its own image logic and its URLs carry no
  commas today.
- Verified against live pages: 30/30 `amazon.com/deals` cards broken before,
  25/25 healthy after (every stored URL requested, HTTP 200 `image/jpeg`).

## [Unreleased] — Warranty Description field (SAD-349)

Scrape, display and export a product's warranty, which Amazon publishes in the
*Product information* block of the detail page and which PPHunt did not model
before (flagged as a gap in `docs/plans/SAD-330-right-click-pdp-preview-audit.md`).

### Added
- **A `Warranty Description` data field**, toggleable in Settings → Data Fields
  and on by default. Like `Description` and `Features` it can only come from the
  product page, so hiding it by default would make a right-click save look like
  data loss.
- **Two stored values.** `warrantyDescription` holds a compact token
  (`1-year`, `2-year`, `90-day`, `24-month`, `lifetime`); `warrantyDescriptionRaw`
  holds the verbatim cell (`"2 year manufacturer"`). Amazon's real copy is
  `<duration> <qualifier>`, so without the second field the qualifier would be
  unrecoverable at export time.
- **PDP extraction across all four Amazon spec-row shapes** —
  `#productDetails_techSpec_section_1`/`_2`, `#productDetails_detailBullets_sections1`,
  `#productDetails_db_sections`, `#detailBulletsWrapper_feature_div`,
  `#productOverview_feature_div` and `#prodDetails` — reusing the container list
  `detail.bsr` already ships.
- **A `Warranty` table column** showing the token with the verbatim text as its
  tooltip, and `No` when a listing states none.
- **`Warranty Description` and `Warranty Details` export columns** in CSV,
  clipboard TSV and XLSX.

### Changed
- Settings → Data Fields now has 24 toggles. The preview table gains one column
  and the default export gains two.

### Notes
- **No database migration and no settings-version bump.** Descriptive fields are
  unindexed, and `parseStoredSettings` already merges stored values over the
  defaults, so an existing install gains the field on its next read.
- **Amazon's warranty boilerplate is rejected structurally, not by blocklist.**
  `Product Warranty: For warranty information about this product, please click
  here` contains no duration, so it yields no token and the extractor keeps
  scanning — a real warranty row later in the same table still wins.
- **Labels are matched in English only**, as decided on the ticket. The other 22
  supported marketplaces will return no warranty rather than a wrong one; the
  label pattern is a single exported regex if localized labels are added later.
- **Selectors are validated against documented DOM shapes and fixtures only.**
  Live Amazon fetches are bot-blocked from CI, so a manual pass on a real product
  page is required before merge.

## [Unreleased] — One-click product saving (SAD-141)

Save a single Amazon product into History without leaving the page.

### Changed
- **The per-card save button now reads as PPHunt at rest** (SAD-329). It was a
  near-white chip with a 1.125 px grey stroke, a 1.51:1 hairline border and no
  brand colour until hover — on a listing page it read as a small dark smudge.
  It is now a solid clay control with a cream 18 px glyph at a 2 px stroke
  (1.5 CSS px), a fill per state (clay → moss → crimson), an inset focus ring
  that stays visible on the fill, and a haloed badge for partial enrichment.
  Every glyph/state pair passes WCAG AA (5.01:1 to 7.26:1). Behaviour is
  unchanged: same six states, click-safety, mounting, tooltips and labels.

### Added
- **Right-click → "Save Product Details"** on any Amazon listing or product page.
  The item is registered from one shared marketplace list, is re-registered on
  install/startup, and never removes the native menu items.
- **A per-card save button** (idle → queued → extracting → enriching →
  completed, or failed with retry), mounted through a single `IntersectionObserver`
  so a virtualised or re-rendered listing cannot produce duplicate buttons, and
  clicks never activate the card's link.
- **One shared pipeline** for both entries: identity → job → listing extract →
  background PDP enrichment (no tab is opened or switched to) → History →
  collection behaviour → CSV/XLSX → notification.
- **Right-Click Save Behavior** setting: *Add to Current* (default), *New
  Collection per product*, *Ask Every Time*. Cancelling the dialog keeps the
  product in the collection it was already saved to.
- **A `snapshots` store** (database v2) recording each observed price/availability
  with its source (`listing` / `detail`) and job id, so history is never rewritten.
- **Background PDP enrichment** with a bounded concurrency of 2, a per-marketplace
  circuit breaker and a typed outcome (`complete` / `partial` / `failed` / `skipped`).
- **MV3 worker recovery**: jobs are mirrored into `storage.session` and resumed at
  most once after a suspension; a job that dies twice is reported `interrupted`
  rather than leaving a card spinning.
- **CSV/XLSX export** of a one-click collection, built in the offscreen document
  through the same writers the panel uses, plus a **Download** action on the
  completion toast and an opt-in `quickSaveAutoDownload` setting (default off).
- **Description and Features are visible by default** (SAD-333). Both fields can
  only ever come from the product page, so hiding them made a right-click save
  look like data loss. They remain ordinary per-field toggles under
  Settings → Data Fields.

### Migrated
- **Existing installs pick up the two new default columns once (SAD-334).** A
  stored row written before this build has no `settingsVersion`, so the first
  read upgrades it: when both `description` and `features` were off, both are
  turned on and the row is stamped `settingsVersion: 1`. The upgrade runs
  exactly once — a second launch never rewrites the row — and touches nothing
  else in the stored settings. Turning either column back off afterwards sticks.
  **Trade-off:** the migration cannot tell an untouched old default from a
  deliberate "both off" choice, because older builds did not record one. It runs
  once, and both toggles remain reversible in Settings.

### Fixed
- `amazon.co.za` was missing from the content-script match patterns, so the
  extension did not load there at all.
- 12 supported marketplaces had no `host_permissions` entry (the manifest only
  covered 10), which broke background fetches on those domains. Both lists are
  now derived from `AMAZON_MARKETPLACE_DOMAINS`.

### Notes
- **Browser verification for SAD-141 is still pending** (tracked as SAD-293). The
  behaviour above is covered by unit/integration tests, not by a real Chrome run.
- Product fulfilment is not modelled (`delivery`, `seller` and `isPrime` are), so
  no `fulfillment` export column is produced.
- Clipboard export remains panel-only: an unfocused worker cannot write the
  clipboard, so the quick-save path refuses that format explicitly.
- The `downloads` permission adds Chrome's "Manage your downloads" install
  warning; the no-permission alternative is not verified yet (D10).

## [Unreleased] — Remediation 2026-10 (Phases 0–10)

Hardening & reliability pass over the whole extension (59 tracked issues, including phase parents).
User-visible changes:

### Fixed
- **Currency values were wrong on eurozone and Japanese storefronts (and any
  non-USD domain).** The stored `currency` field used to hold a URL instead of
  an ISO code, and prices rendered with hardcoded US formatting. **Action for
  existing users (decision D7):** rows collected before this update may carry a
  URL in `currency` — they are not auto-migrated. Re-collect the affected
  sessions (or re-export after re-collection) to get correct prices; the
  corrupted value shows up as a URL in the Currency column, so affected rows
  are easy to spot.
- **Settings now actually take effect** — every setting is consumed by the
  code paths it describes (scroll behavior, field toggles, export defaults).
- Prices render in their own locale: `1.299,00 €` on amazon.de, `￥3,980` on
  amazon.co.jp (no fake decimals), lakh grouping for INR.
- Worker termination can recover the active-session pointer from session storage.
  Browser-startup reconciliation marks leftover collecting sessions **Interrupted**;
  tab-close handling records interruption rather than leaving a stale collection.
- Row numbers (`#`) stay correct and gap-free under sort, filter and delete,
  and cost O(1) per cell instead of a full table scan.

### Changed
- Destructive actions (delete history, clear all, delete selected, restore
  defaults) now use a themed in-panel confirm dialog with proper focus
  handling instead of the blocking browser `confirm()`.
- All modals trap focus, close on Escape, and return focus to the element
  that opened them.
- XLSX auto image mode embeds only for exports of at most 200 products, with
  25 MiB fetched-image and 20-second image-fetch budgets. Always mode bypasses
  these auto limits. Missing/skipped images retain URL text; these limits do not
  bound total workbook-generation time or final file size.
- Excel engine moved to a patched SheetJS 0.20.3 (advisory-free; the npm
  registry's 0.18.5 carries unfixable advisories).
- Target count is clamped to 1–1000 everywhere (input, store, database,
  message schemas).
- Notifications are in-panel toasts only — the optional browser
  `notifications` permission was deliberately not added (notifications scope decision).

### Security
- Overlay iframe pinned to the extension origin with a strict message-origin
  allowlist (M-4); CSP tightened; remote fonts kept but fully disclosed
  (decision D2); production-dependency audit is a blocking CI gate.

## [1.0.0] — 2026-10-15

> Historical development record, not a verified release checklist. Original
> feature descriptions below may have been superseded by the remediation entry
> above and current README/ARCHITECTURE; manual release validation was skipped.

### Added

#### Phase 1: Project Scaffolding & Core Infrastructure
- WXT project with React 19 + TypeScript
- Tailwind CSS with full PPHunt design tokens (11 colors, 3 font families)
- Dexie.js database with 4 typed tables (products, sessions, settings, history)
- Zod schemas for Product (15+ fields), Settings (13 settings), Messages (14-type discriminated union)
- Zustand stores: collectionStore and uiStore
- TypeScript types for Product, Session, Settings, Common
- Background service worker with `setPanelBehavior`
- Content script matching 10 Amazon domains at `document_idle`
- Side panel with full PPHunt-styled UI shell

#### Phase 2: Content Script & Scraping Engine
- Page type detector (search, product detail, category, bestsellers)
- Centralized CSS selectors for 3 Amazon page types
- Search results parser (ASIN, title, price, rating, reviews, image, sponsored, prime)
- Product detail parser (15+ fields including features, seller, brand)
- Category page parser for browse/bestsellers layouts
- Deduplication engine with Set-based ASIN + URL lookup (O(1))
- Auto-scroll controller with ±20% jitter and end-of-page detection
- CAPTCHA/sign-in/blocked page detection
- Price parser handling $, €, £, ¥, thousands separators, whole+fraction
- ASIN extraction from all Amazon URL formats
- Full message protocol between content script and background

#### Phase 3: Side Panel UI — Collection Interface
- Header with logo and settings gear
- Navigation tabs (Collect | History) with clay active underline — a dedicated Preview tab was removed pre-release (SAD-136); the virtualized table lives in the full-width Preview overlay (`FullWidthPreviewModal`) and on `/preview.html`, the Collect tab holds the collection controls only, and History entries carry per-session Preview/Export
- Collection mode toggle (Manual / Automatic)
- Target selector with quick-select chips (50/100/200/300) and custom input (1–1000)
- Status bar with animated color dots (5 states)
- Live counter with percentage display
- Progress bar with clay gradient
- Collection controls (Start / Pause / Resume / Stop)
- Amazon page warning banner
- Error modal with Retry / Resume / Dismiss
- Settings overlay (slide-in from right)
- Empty states for Collections, Products, and History tabs
- Utility: formatNumber, formatCurrency, formatPercent, pluralize, truncate

#### Phase 4: Preview Table with Virtual Scrolling
- 24 default columns (checkbox, row number, image, title, ASIN, price, list price, discount, deal, currency, rating, reviews, BSR, monthly sales, coupon, badge, delivery, brand, seller, availability, sponsored, prime, source, collected-at) driven by the settings field toggles
- TanStack Table v9 integration with sorting, filtering, column resizing
- Row virtualization via @tanstack/react-virtual (52px rows, 10x overscan)
- Row selection with select all / deselect / delete selected
- Global search filter with icon and clear button
- Live updates via Dexie useLiveQuery

#### Phase 5: Export System
- CSV export with proper escaping and UTF-8 BOM for Excel compatibility
- Excel export via SheetJS with bold headers and auto-sized columns
- Clipboard copy as TSV (tab-separated values)
- Export scope: all products, selected rows, or filtered results
- Custom filename with date-based default
- Export modal with format selector, scope selector, filename input
- Toast notifications for success and error cases
- useExport hook with isExporting state and 5s auto-dismiss

#### Phase 6: Settings UI
- Full settings panel with 7 sections: UI Mode, General, Automatic Scrolling, Data Fields, Behavior, Export Defaults, Danger Zone
- UI Mode toggle: Side Panel / Page Overlay with chrome.storage.local persistence
- Overlay width slider (300–800px)
- General settings: default mode toggle, default target count input
- Automatic scrolling: 3 range sliders (speed, interval, wait)
- Data fields: 15-field checkbox grid with 2-column layout
- Behavior toggles: duplicate detection, notifications
- Export defaults: format dropdown, filename input, UTF-8 BOM toggle
- Restore defaults with confirmation dialog
- Auto-save on change (debounced 500ms)
- 200ms slide-in animation

#### Phase 7: Session Persistence & Recovery
- Session recovery on side panel mount: checks IndexedDB for active sessions
- Tab existence verification via `browser.tabs.get`
- Collection state restoration or interruption notice
- Session creation on collection start
- Session status updates on pause/resume
- History entry written on collection stop
- History tab with live data from IndexedDB
- History entry cards with status, count, mode, dates, View Products + Delete
- Clear all history with confirmation

#### Phase 8: Error Handling, Accessibility & Polish
- Toast notification system (Zustand store, max 2, 5s auto-dismiss)
- Context-aware error modal (detects CAPTCHA, sign-in, blocked)
- Targeted guidance messages for each error type
- Resume button for CAPTCHA and sign-in errors
- ARIA attributes: role=status, role=progressbar, role=tab, role=dialog
- Keyboard navigation: Arrow Left/Right for tabs, Escape to close
- Roving tabindex pattern for tab navigation
- Focus management utilities (trapFocus for modals)

#### Phase 9: Dual-Mode UI System
- Popup chooser: Side Panel / Page Overlay with "Remember my choice"
- Overlay drawer: floating panel over the page, slides from right, user-resizable
- Floating trigger button: 40×48px, ink background, clay hover, chevron rotation
- Mode preference system: chrome.storage.local sync, background behavior toggle
- Settings UI Mode toggle wired to storage
- Both modes render the same React app sharing IndexedDB

### Dependencies

**Runtime:**
- react, react-dom (19.x)
- @tanstack/react-table (9.x)
- @tanstack/react-virtual
- dexie, dexie-react-hooks
- zustand
- zod
- xlsx (SheetJS)
- file-saver

**Development:**
- wxt (0.21.x)
- tailwindcss (3.x)
- postcss, autoprefixer
- typescript

[1.0.0]: https://github.com/258044aamm-Dev/PPHunt/releases/tag/v1.0.0