# SAD-369 — Diagnostics in every situation + an enable/disable setting (design plan)

**Status:** implementation steps 0–4 are pushed to `main` and in Linear
review as of 2026-10-20. The live >50-product check (L6) was not exercised
because the live pages returned only 30 distinct products; that limitation is
explicitly reported, and the automated 60-card cap test passes. The original
design analysis remains below; the final gates, live checks, deviations and
limitations are recorded in §14.
**Scope:** the Amazon engine only. The Temu engine is not touched.
**Linear:** [SAD-369](https://linear.app/sad-mod/issue/SAD-369) · origin
[SAD-368](https://linear.app/sad-mod/issue/SAD-368).
**Step-by-step guide:** `docs/plans/SAD-369-diagnostics-everywhere-and-toggle-implementation-guide.md`
— read that one to *do* the work; this one explains *why* it is shaped that way.

---

## 0. Executive summary

SAD-359 shipped a per-field extraction report for the **product-detail** parse
and an aggregate **card-drift** line for the listing parse. The owner has now
asked for three things this does not yet do:

1. **A log in every situation** — a manual collection, an automatic
   collection, a right-click save, and a card-icon save must each produce a
   diagnostics log.
2. **An enable/disable option in Settings** for the diagnostics.
3. The per-field report must use **one field model everywhere** — a listing
   card reports the same 24 fields as a product page.

Today:

| Interaction | Log today | Gap |
|---|---|---|
| Right-click → Save, **on a product page** | ✅ per-field, `stage: "detail-page"` | needs the toggle |
| Right-click → Save, **on a card** | ⚠️ per-field, `stage: "enrichment-parse"` — **only if the background enrichment succeeds** | no log at all when enrichment fails |
| The **card save icon** | ⚠️ same as above | same |
| **Manual collection** | ⚠️ aggregate drift line only | no per-field report |
| **Automatic collection** | ⚠️ aggregate drift line only | no per-field report |
| Collection started **on a product page** | ❌ nothing | no log at all |

And there is **no on/off switch anywhere** — every `[PPHunt][Amazon][Diagnostics]`
line is emitted unconditionally today.

The work is therefore: **one setting**, **one card-level report**, **one
collection path** that carries card reports to the worker, and a **50-item
cap** so a large collection cannot flood the console.

**Nothing in this plan changes what is extracted.** Diagnostics remain a pure
side-channel.

---

## 1. The requirement, in the owner's words

> "if I scrub data from choosing collection mode (like manual collection mode
> or automatic collection mode), or right-click or click the add product icon.
> in every situation, the log should be Display and in settings to enable and
> disable Option"

Restated as testable acceptance criteria:

| # | Criterion |
|---|---|
| A1 | A manual collection produces a diagnostics log. |
| A2 | An automatic collection produces a diagnostics log. |
| A3 | A right-click save produces a diagnostics log. |
| A4 | A card-icon save produces a diagnostics log. |
| A5 | A collection produces a log **per product**, not only an aggregate. |
| A6 | A card save produces a log **even when the background enrichment fails**. |
| A7 | A card report carries the **same 24 fields** as a product-page report. |
| A8 | Settings has an **enable/disable** control for the diagnostics. |
| A9 | When disabled, **no** `[PPHunt][Amazon][Diagnostics]` line is emitted from any path. |
| A10 | A collection of **more than 50 items** emits **no** logs. |

---

## 2. Locked decisions

Every item below was answered by the owner on 2026-10-20. Nothing here is a
guess.

| # | Decision | Why it matters |
|---|---|---|
| **D1** | The setting is **OFF by default**. | Behaviour changes: a fresh install logs nothing until the owner turns it on. Must be in the CHANGELOG. |
| **D2** | **Amazon engine only.** The Temu engine and its extraction logic are not touched. | Matches the standing constraint from SAD-359. |
| **D3** | The card report uses the **same 24-field model** as the product-page report. | One model everywhere; a card report has 24 rows. |
| **D4** | The 4 fields a card cannot carry are reported **`MISSING` with a reason saying it is card-inapplicable**. | `MISSING` + reason, not `UNKNOWN`: the engine *can* establish that a listing card does not carry `description`. The reason string is what distinguishes it from a genuine "searched the card, not found". |
| **D5** | A **card-level report** is added, so every save logs at least once. | Closes A6 — the case where enrichment fails and the save currently logs nothing. |
| **D6** | Collection logs go to the **service worker** console. | One DevTools target for the per-product reports. |
| **D7** | The **50-item cap** is based on the **number of products actually scraped so far** in the run: the first 50 log, the rest of that run does not. | A run can end up partly logged. |
| **D8** | The cap applies to **collection runs only**, not to saves. | The owner scoped it to "automatic collection and manual collection mode". |

### Follow-up decisions locked during implementation (2026-10-20)

| # | Decision | Implementation rule |
|---|---|---|
| **D9 / E9** | Owner approved the additive-only unparseable-price observation. | Add optional `unparseablePriceTier` only when no tier yields a price; keep `{ price, currency, priceTier }` unchanged; report `PARSE_FAILED` rather than claiming absence. |
| **D10** | Move the aggregate drift line to the service-worker console too. | Route counts-only `DRIFT_REPORT` through the worker; preserve the exact prefix and JSON shape; the page console is no longer a production destination. |
| **D11** | Collection reports are sent once per product per run, not as a parallel array. | First report per normalized ASIN wins; a `sentReportAsins` set filters reports from resend batches; each message carries only unsent reports as an ASIN-identified subset. |

### Two consequences worth stating explicitly

**D1 changes shipped behaviour.** Today the logs are unconditional. After
this work they are off until the owner enables them. Four test files assert
those log lines (`tests/extraction-diagnostics.test.ts`,
`tests/amazon-engine-v2.test.tsx`, `tests/save-job-pipeline.test.ts`,
`tests/enrich-saved-product.test.ts` — 6 assertions) and must now enable the
diagnostics explicitly rather than relying on the default.

**D3 means a card report has 4 permanently-absent rows.** The 24 modelled
fields split as **20 card-extractable** and **4 card-inapplicable**
(`description`, `features`, `weight`, `warrantyDescription`). Note also that
`badge` is **not** in the 24 — it was deliberately excluded because the
*detail* stage never extracts it, even though it *is* a card field
(`extraction-diagnostics.ts:79-82`). A card report therefore does not show
`badge`. This follows from D3 ("the same 24") and is listed as a limitation.

---

## 3. Verified current state

Everything below was read in the source at `6f168df`.

### 3.1 The two log sites and the two collector sites

| Kind | Producer | Sink |
|---|---|---|
| Per-field report | `formatExtractionDiagnosticsLog` — `src/engines/amazon/scraper/extraction-diagnostics.ts:320-332` | — |
| ↳ `stage: "detail-page"` | `src/engines/amazon/background/save-job.ts:239-247` | service worker |
| ↳ `stage: "enrichment-parse"` | `src/engines/amazon/background/enrich-saved-product.ts:377-388` | service worker |
| Card-drift aggregate | `logDriftReport` — `src/engines/amazon/scraper/drift-telemetry.ts:162-175` | **page** console |

The 24 modelled fields live in one constant — `DETAIL_DIAGNOSTIC_FIELDS`,
`src/engines/amazon/scraper/extraction-diagnostics.ts:84-110` — and the five
statuses in `FieldExtractionStatus` (`extraction-diagnostics.ts:42-47`).

A collector is created in exactly two places:

| Site | File | Parses |
|---|---|---|
| Content script | `src/engines/amazon/content/save-product.ts:112` | the **live DOM** of a product page |
| Offscreen document | `src/engines/amazon/offscreen/parse.ts:82` | **fetched** product-page HTML |

`createFieldDiagnosticsCollector()` (`extraction-diagnostics.ts:153`) takes no
arguments, and `build(fields = DETAIL_DIAGNOSTIC_FIELDS)`
(`extraction-diagnostics.ts:193-212`) takes the field list as a **parameter**.
A card report therefore needs **no new collector type** — the same factory and
the same 24-field list are reused verbatim.

### 3.2 Why the two save entries report on different stages

`src/engines/amazon/background/save-job.ts:288-296`:

```ts
const savedFromProductPage =
  payload.context?.pageType === 'product-detail';
const shouldEnrich = Boolean(deps.enrich) && !savedFromProductPage;
```

and `src/engines/amazon/content/save-product.ts:110-124` creates the
collector **only** on the `product-detail` branch. So:

* a product-page save → live-DOM report (`detail-page`), **no** enrichment;
* a card save → **no** report of its own; the enrichment fetch produces
  `enrichment-parse` — **if the fetch succeeds**.

### 3.3 The card icon is listing-only

`src/entrypoints/amazon.content.ts:611-613`:

> "Per-card control: listing pages only - a product-detail page has no card,
> and the right-click entry covers that page."

So the card icon and the right-click entry are complementary, not overlapping.

### 3.4 The collection path has no collector

* `src/entrypoints/amazon.content.ts:78-80` — the product-detail branch of
  `extractCurrentPageProducts` calls `parseAmazonProductDetail(doc, url)`
  with **no** collector.
* `src/entrypoints/amazon.content.ts:84-101` — the listing branches call
  `parseAmazonSearchResults` / `parseAmazonCategoryPage`, whose options
  (`search-results.ts:39-43`) carry `cache`, `telemetry`, `extractPricing`
  and **no** collector.
* `src/engines/amazon/scraper/search-results.ts:357` and
  `category-page.ts:304` — each card is parsed with
  `parseAmazonSearchCard(el, activeUrl, options)` /
  `parseAmazonCategoryCard(el, activeUrl, options)`; the shared `options`
  object flows through, so a new option reaches the card parser.

### 3.5 What a listing card can actually carry

From `parseAmazonSearchCard` (`search-results.ts:61-171`), the candidate
product is built from: `asin`, `url`, `title`, `brand`, `price`, `currency`,
`rating`, `reviewCount`, `imageUrl`, `isSponsored`, `isPrime`, `availability`,
`seller`, plus the optional `listPrice`, `discountPercentage`, `dealBadge`,
`bestSellersRank`, `pastMonthSales`, `coupon`, `badge`, `delivery`,
`variations`.

Against the 24 modelled fields:

| Card-extractable (20) | Card-inapplicable (4) |
|---|---|
| asin, url, title, brand, price, listPrice, discountPercentage, dealBadge, coupon, currency, pastMonthSales, rating, reviewCount, availability, delivery, seller, imageUrl, bestSellersRank, variations, isPrime | `description`, `features`, `weight`, `warrantyDescription` |

`description` and `features` are hard-coded to `null` / `[]` on a card
(`search-results.ts:127-128`); `weight` and `warrantyDescription` are never
set. **A card report is therefore 20 meaningful rows plus 4 rows that are
always `MISSING` with the card-inapplicable reason (D4).**

### 3.6 The card pricing cascade cannot distinguish "absent" from "unparseable"

`extractCardPricingAndDiscounts` (`field-parsers.ts:849+`) walks four tiers
and falls through whenever a tier's node is missing **or** its text will not
parse. It exposes `priceTier`, which is `'missing'` in both cases. So today a
card price that exists but cannot be parsed is indistinguishable from a card
with no price at all.

This matters because R3 forbids claiming a field is absent when the engine
cannot establish that. §5 (E9) proposes the one additive change that fixes
it, and §10 records what happens if the owner declines it.

### 3.7 The settings infrastructure

| Thing | Where | Notes |
|---|---|---|
| Main settings schema | `src/engines/amazon/schemas/settings.ts` — `AmazonSettingsSchema` | Zod; `enabledFields` is a nested sub-schema |
| Main settings store | `src/engines/amazon/db/settings.ts` — `getSettings()` / `updateSettings()` | IndexedDB, row `id = 'default'`, serialized write queue, `settingsVersion` migration |
| Factory defaults | `src/engines/amazon/constants/defaults.ts` — `DEFAULT_AMAZON_SETTINGS` | |
| Settings UI | `src/engines/amazon/ui/components/SettingsOverlay.tsx` | sections: UI MODE (188), GENERAL (293), AUTOMATIC SCROLLING (349), DATA FIELDS (381), BEHAVIOR (446), RIGHT-CLICK SAVE (473), EXPORT DEFAULTS (477), DATA (547) |
| Cross-context preferences | `browser.storage.local` — `pphuntTheme` (`src/lib/ui/theme.ts`), `pphuntDefaultMode` (`src/lib/ui/openingMode.ts`) | readable by content scripts |
| Content-script read pattern | `src/engines/amazon/content/card-action-theme.ts` | `storage.local.get` once + `storage.onChanged` for live sync, with a disposer |

**A content script cannot read the extension's IndexedDB** — it runs in the
page's origin. So a setting the content script must read has to live in
`browser.storage.local` (the theme's pattern) or be fetched over
`runtime.sendMessage`.

### 3.8 The message shapes

| Schema | Where | Note |
|---|---|---|
| `SaveProductMessageSchema` | `schemas/messages.ts:227-236` | already carries `extractionDiagnostics: ExtractionDiagnosticsReportSchema.optional()` — **reusable for the card report unchanged** |
| `ExtractionDiagnosticsReportSchema` | `schemas/messages.ts:222-225` | `{ asin: string \| null, fields: FieldDiagnostic[] }`, max 64 fields |
| `ProductsCollectedMessageSchema` | `schemas/messages.ts:112-119` | `{ products, totalCount, isNewBatch }` — **needs an optional reports array** |
| `CollectionProgressMessageSchema` | `schemas/messages.ts:121-128` | |

The background receives the collection batch at
`src/engines/amazon/background/handler.ts:422-470` (`processProductsCollected`)
and `handler.ts:554-568` (`handleProductsCollected`). The collection's
`sessionKey` (`types/index.ts:190`) is the natural job id for collection logs.

### 3.9 The injection points for the toggle

`SaveJobDeps` (`save-job.ts:68-84`) already uses the repo's
"absent by default, so every existing caller and test keeps the old behaviour"
pattern (`store?`, `enrich?`). The same pattern fits the toggle.

---

## 4. The gaps

| Gap | Statement | Closed by |
|---|---|---|
| **G7** | There is no way to turn the diagnostics off; every `[PPHunt][Amazon][Diagnostics]` line is unconditional. | E1–E4 |
| **G8** | A card save (right-click a card, card icon) produces **no** report of its own; if the background enrichment fails, that save logs **nothing**. | E5–E7 |
| **G9** | A collection run produces **no per-product report** — only the aggregate drift line. | E8, E10–E12 |
| **G10** | A collection run on a product-detail page produces **nothing at all** (`amazon.content.ts:78-80` parses without a collector). | E8, E10–E12 |
| **G11** | A card report does not exist, so a card has no field-level view. | E5–E7 |
| **G12** | A large collection would emit an unbounded number of lines. | E13 (the 50-item cap) |

---

## 5. Changes, file by file

### The setting

**E1 — the key and its default.** New module
`src/engines/amazon/constants/diagnostics.ts`:

```ts
export const DIAGNOSTICS_ENABLED_KEY = 'pphuntDiagnosticsEnabled';
export const DEFAULT_DIAGNOSTICS_ENABLED = false;   // D1
export function readDiagnosticsEnabled(raw: unknown): boolean;
```

`readDiagnosticsEnabled` returns `true` only for a literal `true`; a missing
key, `undefined`, or any other value is `false`. A corrupt or absent value
must never enable logging by accident.

**Why `browser.storage.local` and not the IndexedDB settings row.** The
content script needs the flag and cannot read the extension's IndexedDB
(§3.7). `storage.local` is readable from every extension context *and* from
the content script, and the repo already uses it for exactly this class of
preference (`pphuntTheme`, `pphuntDefaultMode`). Putting the flag in the
IndexedDB settings row as well would create two sources of truth that can
diverge. One key, one writer (the Settings UI), read by all three contexts.

**E2 — the accessor.** New module
`src/engines/amazon/utils/diagnostics-flag.ts` (mirrors
`content/card-action-theme.ts`):

* `getDiagnosticsEnabled(): boolean` — a cached, synchronous read;
* `refreshDiagnosticsEnabled(): Promise<void>` — one `storage.local.get`;
* `setDiagnosticsEnabled(value: boolean): Promise<void>` — the write;
* a `storage.onChanged` subscription that refreshes the cache live, so
  toggling the setting takes effect **without a page reload**.

The cache starts at `false` (D1). Every context therefore fails **closed**:
if the read has not resolved, nothing is logged. The content script awaits
`refreshDiagnosticsEnabled()` before the first save or collection action, so
the first action of a session is never skipped by a race.

**E3 — the Settings UI.** `src/engines/amazon/ui/components/SettingsOverlay.tsx`
gains a **DIAGNOSTICS** section (after GENERAL, before AUTOMATIC SCROLLING),
with one toggle:

* label: **"Enable extraction diagnostics"**
* description: *"Log per-field extraction status for every product the Amazon
  engine parses. Off by default. Open the extension's Service worker DevTools
  to read the lines."*

It writes the `storage.local` key directly (the Settings UI is an extension
page and can), and reads the current value from the same cache module. The
existing "reset to defaults" control in the DATA section (`:547`) must also
reset the flag to `false`.

**E4 — gate the existing log sites.** All four existing/new log sites consult
the flag:

| Site | File | Gate |
|---|---|---|
| `detail-page` | `background/save-job.ts:239` | `deps.diagnosticsEnabled?.() ?? false` |
| `enrichment-parse` | `background/enrich-saved-product.ts:377` | the shared reader |
| drift aggregate | `scraper/drift-telemetry.ts:162` | the shared reader |
| `card` / `collection-card` | new (§5.2, §5.3) | the shared reader |

`SaveJobDeps` gains:

```ts
/**
 * Whether the per-field diagnostics may be logged. Absent means OFF, so a
 * caller that forgets to pass it fails closed — and every existing test
 * keeps the production default rather than a test-only one.
 */
diagnosticsEnabled?: () => boolean;
```

Both production call sites (`handler.ts:800-811` and
`save-job-recovery.ts:196-206`) pass the shared reader.

**D10 supersedes the original location decision:** production drift lines
are routed to the service-worker console through `DRIFT_REPORT`, including
listing parses outside collections. The message is counts-only; the content
script injects the transport and disposes it during cleanup. Direct-call tests
and non-extension contexts retain the `console.info` default. The page console
is not a production destination after SAD-369.

### The card-level report

**E5 — one shared recorder.** New module
`src/engines/amazon/scraper/card-diagnostics.ts`:

```ts
/** The 4 modelled fields a listing card never carries. */
export const CARD_INAPPLICABLE_FIELDS = [
  'description', 'features', 'weight', 'warrantyDescription',
] as const;

export const CARD_INAPPLICABLE_REASON =
  'not available on a listing card — this field is only extracted from the product page';

export function recordCardDiagnostics(
  collector: FieldDiagnosticsCollector,
  input: CardDiagnosticsInput,
): void;
```

`CardDiagnosticsInput` is the **already-computed** extraction result of one
card: the ASIN, the title, the brand, the pricing result, the rating and
review results, the image result, and the optional strings. The function
records each field as `EXTRACTED` (with the winning `tier` where the card
extractors expose one) or `MISSING` (with a field-specific reason), and
records the 4 card-inapplicable fields as `MISSING` with
`CARD_INAPPLICABLE_REASON` (D4).

**One function, two card parsers.** `parseAmazonSearchCard` and
`parseAmazonCategoryCard` are separate implementations with near-identical
field logic. Putting the 20+ record calls in each would duplicate ~60 lines
of near-identical code, so both call this one recorder. That is the whole
point of putting it in its own module.

**E6 — thread the collector into the card parsers.**
`SearchResultsParseOptions` (`search-results.ts:39-43`) and the equivalent
`CategoryPageParseOptions` gain one member:

```ts
/** Receives one finished report per parsed card. Absent → no diagnostics. */
diagnosticsSink?: ExtractionDiagnosticsSink;
```

```ts
// extraction-diagnostics.ts
export interface ExtractionDiagnosticsSink {
  /** One finished per-field report, one call per parsed product. */
  accept(report: ExtractionDiagnosticsReport): void;
}
```

The **sink** (rather than a shared collector) is the right shape because a
listing parse produces *many* products and each needs its **own** collector —
one collector per card, one report per card, delivered to the caller.

Inside `parseAmazonSearchCard` / `parseAmazonCategoryCard`:

```ts
const diagnostics = options.diagnosticsSink
  ? createFieldDiagnosticsCollector()
  : undefined;
...
recordCardDiagnostics(diagnostics!, { /* the card's extraction results */ });
...
if (diagnostics) options.diagnosticsSink.accept(diagnostics.build());
```

When `diagnosticsSink` is absent (the toggle is off) **no collector is
allocated per card at all** — the cost is one `undefined` check.

**E7 — the card save path.** Two call sites resolve a card to a product:

| Call site | Trigger |
|---|---|
| `src/engines/amazon/content/save-product.ts:129` — `extractProductFromCard` | right-click on a card |
| `src/entrypoints/amazon.content.ts:617` — the card icon | the card save icon |

Both must create a collector, pass a sink, and attach the finished report to
the `SAVE_PRODUCT` payload. The payload schema already accepts it
(`messages.ts:234`) and the report type is identical
(`ExtractionDiagnosticsReportSchema`) — **no schema change is needed for the
card save.**

The worker then logs it at `save-job.ts` with a **new stage**, `card`:

```
[PPHunt][Amazon][Diagnostics] {"jobId":"…","asin":"B0…","stage":"card","counts":{…},"fields":[…]}
```

A card save therefore produces **two** lines when the enrichment succeeds —
`card` (the live card) and `enrichment-parse` (the fetched product page) —
which is what D5 ("include all") asks for. The two carry the **same jobId**,
so they can be paired.

### The collection path

**E8 — a card report for every collected product.** The collection parses
cards through `parseAmazonSearchResults` / `parseAmazonCategoryPage`
(`amazon.content.ts:84-101`). Both now receive a `diagnosticsSink`
(§5.2 E6), so every collected card yields a report.

**The product-detail branch of a collection** (`amazon.content.ts:78-80`) also
gains a collector, so a collection started on a product page reports too
(G10).

**E9 — the card pricing cascade, one additive change.**
`extractCardPricingAndDiscounts` (`field-parsers.ts:854+`) gains one
**optional** observation: which tier found a node whose text would not parse.
It is returned as a new optional field on the existing result object and is
**ignored by every existing consumer**. The extracted price, the currency and
the tier are **byte-identical** before and after — a test pins that.

Without it, a card price that exists but will not parse is reported
`MISSING`, which is the one thing R3 forbids. With it, the card report can
say `PARSE_FAILED`, which is the distinction the whole taxonomy exists for.

**Owner-approved (D9, 2026-10-20):** E9 belongs to step 3/SAD-373. The
change is additive-only and returns the first tier that found an unparseable
price node only when no tier produced a price. Existing extracted price,
currency and `priceTier` stay identical; the card report says `PARSE_FAILED`
for this proven-present-but-unparseable case.

**E10 — carry the reports to the worker.**
`ProductsCollectedMessageSchema` (`messages.ts:112-119`) and the matching
`AmazonExtensionMessage` member in `types/index.ts` gain an optional
`extractionDiagnostics` array. The registry-sync test protects the type/schema
pairing. `processProductsCollected` and `handleProductsCollected`
(`handler.ts:422, 554`) receive it and log each valid report at
`collection-card`, with the active collection `sessionKey` as job id. The
existing `pendingProductsChain` preserves collection order.

**E11 — one report per ASIN, exactly once (D11).** The reports array is **not
parallel** to `products`. It is a subset whose entries identify themselves by
ASIN. A batch may contain all run products (`updatedExisting`) or only new
ones; the content script sends only reports not already sent in this run,
in batch order. This prevents duplicate logs on resend and allows products
past the cap to have no report.

**E12 — one sink for the whole run.** The content script keeps a
`Map<normalized ASIN, ExtractionDiagnosticsReport>` plus a set of sent ASINs
for the current run. The first report for an ASIN wins; both sink and lookup
keys use the same ASIN normalizer. The map, sent set, and counter reset at the
same `handleCollectProducts` boundary as `collectedProducts`. The
`SAVE_PRODUCT` path uses its own single-report sink — the two never mix.

**E13 — the 50-item cap (D7, D8).** `COLLECTION_DIAGNOSTICS_LIMIT = 50` is a
named constant. Count unique products for which a report was accepted; check
the cap before accepting a new ASIN so duplicates and re-parses never consume
a slot. The first 50 reportable unique products in a run can be logged; the
rest of that run do not. The cap applies only to collection runs, not saves.

### Summary of the four stages

| Stage | Emitted by | Product source | Sink |
|---|---|---|---|
| `detail-page` | worker | live product-page DOM | service worker |
| `card` | worker | the live card, at save time | service worker |
| `collection-card` | worker | the live card, during a collection run | service worker |
| `enrichment-parse` | worker | fetched product-page HTML | service worker |
| *(drift)* | worker | a whole listing parse | service worker (D10) |

---

## 6. What the logs look like

### A card save (right-click a card, or the card icon)

```
[PPHunt][Amazon][Diagnostics] {"jobId":"9f2c…","asin":"B0BXYKQBDC","stage":"card",
 "counts":{"extracted":11,"missing":13,"parseFailed":0,"partial":0,"unknown":0},
 "fields":[{"field":"asin","status":"EXTRACTED","source":"dom","tier":"tier2_semantic"},
           {"field":"price","status":"EXTRACTED","source":"dom","tier":"tier2_semantic"},
           {"field":"description","status":"MISSING","source":"dom",
            "reason":"not available on a listing card — this field is only extracted from the product page"},
           …]}
```

A card report carries **`tier` but not `selector`**: the card extractors
resolve through a 4-tier cascade rather than a single winning selector, so
the tier is the honest "how did we get it" signal. The product-page report
keeps its `selector`.

### A collection

```
[PPHunt][Amazon][Diagnostics] {"jobId":"1754…","asin":"B0BXYKQBDC","stage":"collection-card",
 "counts":{"extracted":11,"missing":13,"parseFailed":0,"partial":0,"unknown":0},"fields":[…]}
```

One line per product, in collection order, up to 50 per run.

---

## 7. Test matrix

### The setting

| # | Test | File |
|---|---|---|
| T1 | `readDiagnosticsEnabled`: missing / `undefined` / `false` / garbage → `false`; `true` → `true` | new `tests/diagnostics-setting.test.ts` |
| T2 | Default is OFF: a fresh settings read yields `false` | same |
| T3 | The Settings UI toggle writes the key and reflects the stored value | `tests/settings-*.test.ts` (extend) |
| T4 | "Reset to defaults" resets the flag to OFF | same |
| T5 | Toggle OFF → a product-page save sends `SAVE_PRODUCT` **without** `extractionDiagnostics` | `tests/save-product.test.ts` |
| T6 | Toggle ON → it sends it | same |
| T7 | Toggle OFF → no `[PPHunt][Amazon][Diagnostics]` line at the `detail-page` site | `tests/save-job-pipeline.test.ts` |
| T8 | Toggle ON → the line is emitted | same |
| T9 | Toggle OFF → no line at the `enrichment-parse` site | `tests/enrich-saved-product.test.ts` |
| T10 | Toggle ON → the line is emitted | same |
| T11 | Toggle OFF → the drift line is not emitted | `tests/extraction-diagnostics.test.ts` |
| T12 | Toggle ON → it is | same |

### The card report

| # | Test | File |
|---|---|---|
| T13 | A search card yields a 24-field report; the 4 card-inapplicable fields are `MISSING` with `CARD_INAPPLICABLE_REASON` | new `tests/card-diagnostics.test.ts` |
| T14 | The report's counts sum to 24 | same |
| T15 | A card whose price text will not parse → the price entry is `PARSE_FAILED` (E9) | same |
| T16 | A card with no ASIN → the card is rejected and **no** report is produced | same |
| T17 | A category card produces the same 24-field shape as a search card | same |
| T18 | The extracted product is byte-identical with and without a sink | same (the parity invariant) |

### The card save

| # | Test | File |
|---|---|---|
| T19 | Right-click on a card → `SAVE_PRODUCT` carries a card report → the worker logs `stage: "card"` | `tests/save-product.test.ts`, `tests/save-job-pipeline.test.ts` |
| T20 | The card icon → the same | `tests/save-product.test.ts` |
| T21 | A card save with a successful enrichment logs **two** lines (`card`, `enrichment-parse`) with the same jobId | `tests/save-job-pipeline.test.ts` |
| T22 | A card save whose enrichment **fails** still logs the `card` line (A6) | same |

### The collection

| # | Test | File |
|---|---|---|
| T23 | A collection of 10 cards → 10 reports reach the worker, logged at `stage: "collection-card"` | new `tests/collection-diagnostics.test.ts` |
| T24 | A collection of 60 cards → **exactly 50** reports (D7) | same |
| T25 | The 51st product of a run is not logged, but the run's first 50 are | same |
| T26 | A second collection run resets the cap | same |
| T27 | An `updatedExisting` resend does not re-log reports; each report is logged once per run and its ASIN belongs to the run (D11) | same |
| T28 | A collection started on a product page produces a report (G10) | same |
| T29 | The 50-item cap does **not** apply to a save (D8) | `tests/save-job-pipeline.test.ts` |

### Regression

| # | Test | Note |
|---|---|---|
| T30 | The whole suite stays green | 88 files / 1046 tests today |
| T31 | The 6 existing log assertions now enable the diagnostics explicitly | 4 test files |
| T32 | The extraction-result parity test still passes | diagnostics never change the product |
| T33 | `git diff -- src/engines/temu/` and `git diff -- wxt.config.ts` are empty | D2 |
| T34 | The dead-export guard passes | the new modules must be consumed |

---

## 8. Live verification

The recipe proven in the SAD-359 live session
(`docs/plans/SAD-359-live-measurement-2026-10-20.md`) is reused:

```bash
npm run build
xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npm run measure:diagnostics -- --asins … --listing … --out …
```

The harness must be extended to (a) turn the diagnostics **on** in the
extension's `storage.local` before the run and (b) assert the **absence** of
lines when the toggle is off. The extension's `storage.local` is reachable
from the service-worker context, so the harness can write the key there.

Manual checks in a real browser (the owner's own machine, normal connection):

| # | Check | Expected |
|---|---|---|
| L1 | Toggle OFF → any action | **no** `[PPHunt][Amazon][Diagnostics]` line anywhere |
| L2 | Toggle ON → right-click save on a product page | one `detail-page` line |
| L3 | Toggle ON → right-click save on a card | one `card` line (+ one `enrichment-parse` line if the fetch succeeds) |
| L4 | Toggle ON → the card icon | one `card` line |
| L5 | Toggle ON → a manual collection of N ≤ 50 cards | N `collection-card` lines in the **service worker** console |
| L6 | Toggle ON → a collection of more than 50 | exactly 50 lines, and the run continues collecting normally |
| L7 | Toggle ON → the drift line | in the **service-worker** console, same prefix and JSON shape (D10) |
| L8 | Toggle flipped while a page is open | takes effect without a reload |

L6 is the expensive one — a real collection of 51+ products needs a long
scroll. It may be run once, on a slow connection, and recorded in the report.

---

## 9. Documentation

* `CHANGELOG.md` — a new `## [Unreleased] — <Feature> (SAD-3xx)` section
  recording: the new setting (default **off**, and the behaviour change it
  makes), the card-level report, the collection reports, the 50-item cap, and
  the four stages.
* `ARCHITECTURE.md` — extend the SAD-359 section with the setting, the sink,
  the card field split (20 + 4), the four stages and the single service-worker console (D10).
* `docs/plans/SAD-359-live-measurement-2026-10-20.md` — a follow-up
  "Scope extension" section, or a new measurement document.
* The new plan document, renamed to the new issue's number.

---

## 10. Commit plan

One step per commit, each pushed to `main` and reported on the Linear issue
before the next begins — the workflow established for SAD-359.

| Step | Commit | Contents | Gates |
|---|---|---|---|
| 0 | plan | this document | — |
| 1 | the setting | E1–E4: the key, the accessor, the Settings UI, and the gating of all four log sites | tsc clean, suite green, Temu/`wxt.config.ts` diffs empty |
| 2 | the card report | E5–E7: the shared recorder, the sink, the card parsers, the card save path, the `card` stage | tsc clean, suite green, parity test green |
| 3 | the collection path | E8–E13: the collection sink, optional `PRODUCTS_COLLECTED` subset, the 50-item cap, `collection-card`, E9, and D10 drift routing (3 message registries) | tsc clean, suite green |
| 4 | live + docs | the live verification, the CHANGELOG, the ARCHITECTURE, the report | tsc clean, suite green, build OK, live checks L1–L8 |

**E9 (the shared pricing cascade) is called out separately in step 3**
because it is the only change to a function the product-page buybox also
uses. It is additive-only, and a test pins that the extracted price is
byte-identical.

---

## 11. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | The diagnostics being **off by default** hides a feature the owner was relying on. | **Certain** | Stated in the CHANGELOG and called out in the Linear comment; the setting is one click in Settings. |
| R2 | The 50-item cap hides problems in a large collection. | Medium | The cap is the owner's explicit instruction; the CHANGELOG states it, and the collection still *runs* normally. |
| R3 | The card report adds cost to every card parse. | Low | No collector is allocated when the sink is absent (the toggle is off). |
| R4 | The `PRODUCTS_COLLECTED` payload grows by ~24 entries per product. | Low | Bounded at 50 products per run by the cap. |
| R5 | E9 touches the shared pricing extractor. | Low | Owner-approved (D9); additive-only and the parity pin keeps `{ price, currency, priceTier }` byte-identical. |
| R6 | Reports could be re-logged or attached to the wrong product on a resend. | Medium | Reports self-identify by ASIN; `sentReportAsins` enforces once-per-run delivery; T27 pins the rule (D11). |
| R7 | The content script's flag read races the first action. | Low | The content script awaits the read before the first save or collection action; the cache fails closed. |

---

## 12. Limitations (reported, per R6)

1. **A card report has 4 permanently-absent rows** (`description`, `features`,
   `weight`, `warrantyDescription`) and does **not** include `badge`, because
   D3 fixes the model at the same 24 fields.
2. **A card report carries `tier`, not `selector`** — the card extractors
   resolve by a cascade, not a single selector.
3. **Card-level `PARSE_FAILED` is implemented for price only** (E9/D9).
   Rating/reviewCount extractors retain their existing absent-vs-unparseable
   ambiguity.
4. **Drift lines now require the service worker to be alive** (D10); if the
   worker cannot receive the message, the diagnostics-only line is dropped
   rather than printed in the page console.
5. **The cap is per collection run**, not per page or per session; a run can
   end up partly logged (D7).
6. **The `enrichment-parse` stage still depends on the background fetch
   succeeding.** A card save logs its `card` line regardless, but the
   product-page view of that product is missing when the fetch fails.
7. **Live L6 (>50 products) was not exercised**: Amazon listing pages served
   at most 30 distinct products in the headed Chromium runs even after normal
   scroll input. The 60-card automated cap test passes, but it does not replace
   the live >50-product acceptance check. See
   `docs/plans/SAD-369-live-verification-2026-10-20.md`.
8. The live browser checks used a fresh sandbox Chromium profile, not the
   owner's normal Chrome profile. The side-panel product table was not
   visually compared against a separate baseline build, and automatic mode
   was not separately run live. The automated parity suite and live product
   detail-to-IndexedDB comparison passed.
9. **The Temu engine is not covered** (D2).

---

## 13. Definition of done

- [x] `tsc --noEmit` clean; full suite **96 files / 1092 tests** green
- [x] `npm run build` succeeds; `npm run check:dead-exports` passes
- [x] Diffs from baseline `804da50` for `src/engines/temu/` and `wxt.config.ts` are empty
- [x] Extracted product byte-identical with and without collectors/sinks (parity tests + E9 pin)
- [x] Setting defaults to **off**, reachable in Settings, and live without reload (L8)
- [x] **Off** → no diagnostics line from any path in the live save check (L1)
- [x] **On** → live detail save, right-click card save, card-icon save, manual collection, and worker-side drift observed (L2–L5, L7)
- [ ] A real live collection of more than 50 products emits exactly 50 lines (L6); not exercised because the pages served only 30 products. Automated 60-card cap test passes.
- [x] Live verification report and raw evidence committed, including checks not exercised
- [x] CHANGELOG + ARCHITECTURE updated
- [ ] Linear SAD-369 moved to **In Review** with summary and limitations (final step-4 Linear update)

---

## 14. Implementation record (2026-10-20)

The plan's locked decisions and correction log are binding; implementation did
not use assumptions where the plan/tickets differed. One commit per code step,
pushed to `main`:

| Step | Issue | Commit | Verification |
|---|---|---|---|
| 0 — plan, guide, verified baseline | SAD-370 (Done) | `d46c08f` (plan), `804da50` (guide + verified baseline) | baseline: 88 files / 1046 tests; `tsc`, build and dead-export checks clean |
| 1 — setting and log gates | SAD-371 (In Review) | `e4f71a7` | 90 files / 1059 tests; `tsc`, build and dead-export checks clean |
| 2 — card report and both save paths | SAD-372 (In Review) | `b9d895b` | 92 files / 1071 tests; parity invariant green; Temu diff empty |
| 3 — collection reports/cap, E9, drift to worker | SAD-373 (In Review) | `982993d` | 96 files / 1092 tests; T23–T29/E9/D10 tests green; Temu diff empty |
| 4 — live verification, docs, record | SAD-374 (In Review) | this record's commit: `SAD-369 step 4: live verification, changelog and implementation record` | final gates as above; live L1–L5/L7–L8 pass; live L6 explicitly not exercised; limitations recorded below and in the report |

### Deviations and corrections recorded

- **D9/E9 sequencing:** §6.1 of the original plan placed the unparseable-price
  branch in step 2, while §7.1 and SAD-373 assigned E9/T15 to step 3. The
  SAD-372 ticket scope controlled: step 2 used the no-price-node `MISSING`
  branch; step 3 added `unparseablePriceTier` and `PARSE_FAILED`. This is
  documented on SAD-372 and SAD-373. Product output is parity-pinned.
- **D11:** reports are an ASIN-identified subset of each `PRODUCTS_COLLECTED`
  message, not a parallel array. The worker's pre-validation envelope fast
  path also rebuilt the payload and dropped unknown fields; it was updated to
  carry the optional report array, with per-report schema validation still at
  the print site. The evidence test caught this before the step-3 push.
- **D10:** the drift line's destination changed from the page console to the
  service-worker console. `DRIFT_REPORT` is in all three registries; the
  content-script transport is reset during cleanup. Prefix and serialized JSON
  shape are preserved.
- The collection sink is a small separately testable module, rather than
  closures inside `amazon.content.ts`; this keeps the D7/D11 rules directly
  testable without widening production behavior.
- **Live L6 limitation:** normal scrolling on the tested live search/category
  pages yielded at most 30 distinct products. No claim is made that the live
  >50 run passed; the 60-card automated test passes. An owner-browser run on a
  listing that actually yields >50 products remains the appropriate follow-up.
- The first live L3 harness attempt dispatched a synthetic contextmenu event
  and did not capture a save target; it was replaced by a real Playwright
  right-click. The corrected run produced exactly one `card` line and one
  `enrichment-parse` line with the same jobId. The harness now uses a normal,
  unforced click on the visible closed-shadow card-icon host for L4.
- The live runner initially treated a numeric price substring as a possible
  product-value leak; a legitimate collision with count data demonstrated
  that test could false-positive. The final privacy check uses structural
  value-key checks plus actual stored title/URL comparisons.

### Verification artifacts

- Human-readable L1–L8 results and limitations:
  `docs/plans/SAD-369-live-verification-2026-10-20.md`.
- Machine-readable live runs:
  `docs/plans/sad-369-live-off-2026-10-20.json`,
  `docs/plans/sad-369-live-on-2026-10-20.json`, and
  `docs/plans/sad-369-live-l6-2026-10-20.json`.

---
