# SAD-359 — Per-field extraction diagnostic logging (plan)

Status: Step 0 (decisions locked 2026-10-20). Diagnostics only — no extraction,
merge, persistence, schema-of-record, manifest or UI behaviour change. Temu untouched.

## What the audit found (all verified at `3c3cbe2`)

- **PDP detail parser has zero diagnostics.** `parseAmazonProductDetail`
  (`scraper/product-detail.ts`, used by offscreen enrichment *and* on-PDP saves)
  runs, per field: selector list → cleaner/parser → JSON-LD fallback. Which
  selector won and why a candidate was rejected are discarded. This is the
  blind spot behind SAD-352's buybox fingerprint (price/seller/delivery/
  discount/monthly-sales missing together while brand/BSR/features land).
- **Card parsing already computes per-field tiers** (`AmazonExtractionTier`,
  6 tracked fields) aggregated by `AmazonDriftTelemetry`, but `getReport()`
  has **no production consumer** — it is invisible to the owner. `missing`
  conflates "absent from HTML" with "found but unparseable"; no per-ASIN
  detail, reasons or selectors.
- **SAD-352's outcome line** gives presence/absence only
  (`detailPresentFields` / `missingDetailFields`) — no PARTIAL, no reason.
- **Validation has two layers**: cleaners return `null` per field
  (`cleanBrand`, `parsePrice`, `parseRating`, …), and
  `validateAndNormalizeScrapedProduct` then nulls invalid
  price/rating/reviewCount/imageUrl/listPrice (whole-product reject only for
  ASIN/URL/title). Both are observable at parse time.
- **`Variations` and `Weight` are not modelled anywhere** in the Amazon
  engine (no type field, no extractor). Per decision below they are out of
  scope here.
- Transport is additive-safe: the SW casts the offscreen parse response
  without strict validation; the `SAVE_PRODUCT` Zod schema follows an
  established "optional, so older senders still validate" pattern
  (SAD-343/SAD-344).

## Decisions (owner, 2026-10-20)

- `stage_scope = detail_plus_drift` — per-field diagnostics for the PDP
  detail parser, plus surface the existing card drift report once per
  listing parse. No per-card logs.
- `new_fields = modelled_only` — classify only fields the engine extracts.
- `log_sink = sw_json` — one-line JSON in the service-worker console,
  `[PPHunt] extraction diagnostics {...}`, grouped by `jobId` + ASIN, next to
  the SAD-352 outcome line. On-PDP parse diagnostics ride along with
  `SAVE_PRODUCT` so they land in the same console.
- `partial_verbosity` — owner delegated; chosen: **every field, every parse,
  JSON-LD rescue counts as `PARTIAL`** (matches the issue text; surfaces DOM
  selector rot even when JSON-LD saves the value).

## Classification rules

- `EXTRACTED` — final value present. Records `source`
  (`dom|json-ld|legacy|derived|url`), winning `selector` where DOM, card
  `tier` for buybox pricing, and `validated: true` if it survived
  `validateAndNormalizeScrapedProduct`.
- `PARTIAL` — a candidate existed but was rejected: selector matched a node
  whose text the cleaner/parser refused; a regex/label matched but no value
  could be parsed; DOM failed and JSON-LD had to rescue (strict rule); or the
  value was parsed but **dropped by validation** (`validated: false`).
  Always carries a `reason`.
- `MISSING` — no candidate in the HTML at all (no selector matched outside
  excluded subtrees, no JSON-LD value). Carries a `reason`.
- Nodes inside excluded subtrees (ads/similar items) never count as
  candidates — same exclusion the parser already applies.

Detail-stage field set (21): asin, title, brand, price, listPrice,
discountPercentage, dealBadge, coupon, currency, pastMonthSales, rating,
reviewCount, availability, delivery, seller, features, description,
imageUrl, bestSellersRank, warrantyDescription, isPrime.
(`warrantyDescriptionRaw` travels with the token; `badge` is never extracted
at the detail stage, so it is excluded rather than logging permanent noise.)

Known approximation: buybox pricing comes from the shared card extractor
`extractCardPricingAndDiscounts`, which is **not** instrumented internally
(shared with the card path — touching it is out of scope). For price,
"buybox scope element present" counts as candidate presence; the winning
scope selector and `priceTier` are recorded.

## Design (smallest targeted change)

1. **New pure module** `scraper/extraction-diagnostics.ts`: types
   (`FieldDiagnostic`, `ExtractionDiagnosticsReport`), a collector
   (`extracted/missing/partial/rescued`, last-write-wins, `build()` fills
   unrecorded fields as `MISSING 'not attempted'`), `applyValidationResults`
   (compares candidate vs normalized product), counts + one-line formatter.
   No DOM dependencies.
2. **`product-detail.ts`**: optional third parameter `diagnostics?` on
   `parseAmazonProductDetail` (all existing callers/tests unaffected).
   Mechanical bookkeeping inside the existing loops (winning/rejected
   selector locals); `extractDetailAsin/Bsr/Warranty` gain the same optional
   parameter. No extraction logic changes — parity is pinned by test.
3. **`offscreen/parse.ts` + `protocol.ts`**: collector created per parse;
   report attached as optional `fieldDiagnostics` on success **and** on
   parser-ran errors (no-product / rejected / ASIN mismatch).
4. **`background/enrich-saved-product.ts`**: after `parse(...)`, log the
   report once (`stage: 'enrichment-parse'`) from the response, for both ok
   and error outcomes. Existing outcome line unchanged.
5. **On-PDP saves**: `content/save-product.ts` collects diagnostics on the
   PDP branch; `SAVE_PRODUCT` payload gains additive optional
   `extractionDiagnostics` (Zod schema + `SaveProductPayload`, house pattern);
   `background/save-job.ts` logs it beside the SAD-352 save-job line
   (`stage: 'detail-page'`).
6. **Drift surfacing**: `logDriftReport(telemetry, stage)` one-line JSON at
   the end of `parseAmazonSearchResults` / `parseAmazonCategoryPage`, using
   the same telemetry instance the parse used; silent when zero cards were
   inspected. This runs in the content script, so this one line lands in the
   **page console** (documented deviation: content-side aggregate telemetry
   cannot reach the SW console without new messaging; per-product extraction
   diagnostics proper are SW-logged per decision).

## Steps

- **Step 0** — this plan; Linear progress comment. Commit.
- **Step 1** — diagnostics module + detail-parser instrumentation +
  collector/parser tests (fields & scenarios below).
- **Step 2** — offscreen transport + enrichment SW log line + tests.
- **Step 3** — on-PDP ride-along (content → schema → save-job log) + tests.
- **Step 4** — drift-report surfacing + tests.
- **Step 5** — full verify, dead-export guard, Temu-diff check; test report
  in the Linear comment; In Review; owner test zip.

## Test matrix (fields & scenarios)

Parser-level (jsdom fixtures, `parseAmazonProductDetail` with collector):
full PDP (core fields `EXTRACTED` with selectors); buybox-less PDP (the
SAD-352 fingerprint → price/seller/delivery `MISSING`, absent reasons);
unparseable price text in a present buybox (`PARTIAL` candidate-rejected);
JSON-LD-only price/rating (`EXTRACTED` source `json-ld`); garbage DOM price
+ valid JSON-LD (`PARTIAL` strict rescue); JSON-LD non-HTTP image
(`PARTIAL`, `validated:false`); BSR label without rank pattern (`PARTIAL`);
no-title page (product `null`, diagnostics still built, title `MISSING`);
**parity**: product deep-equal with vs without the collector.
Transport/log-level: offscreen success + error responses carry
`fieldDiagnostics`; enrichment logs exactly one diagnostics line with
jobId/ASIN/stage/counts and leaves the existing outcome line untouched;
absent diagnostics → no line; `SAVE_PRODUCT` schema accepts payload with and
without diagnostics; save-job logs the ride-along once; drift line emitted
for a non-empty listing parse and silent at zero cards.

## Non-goals / invariants

- No change to extraction results, enrichment status, merge, DB, export, UI,
  manifest, or message *meanings* (one additive optional field only).
- No new fields extracted (Variations/Weight are future feature work).
- No per-card logging; no raw HTML or values beyond field metadata in logs
  (no titles/prices — statuses, selectors, reasons, counts only).
- Temu byte-identical; `PRODUCTS_COLLECTED` untouched.
- Push note: SAD-352's `3c3cbe2` is still unpushed (GitHub PAT returns 401
  from the sandbox). SAD-359 commits stack locally until a fresh token lands.
