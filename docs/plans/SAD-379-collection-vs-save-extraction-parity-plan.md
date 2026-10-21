# SAD-379 — Investigation (root cause)

> **Decisions are recorded in `docs/plans/SAD-379-collection-save-parity-implementation-plan.md`** (§0.4, §9):
> default off, configurable 25/50/All cap defaulting to 50, no listing snapshots,
> per-row status deferred, SAD-370 lands first.

> **Ticket:** [SAD-379 — Automatic mode and manual mode](https://linear.app/sad-mod/issue/SAD-379/automatic-mode-and-manual-mode)
> Priority 1 · Label `Bug` · Project PPHunt · Assignee MakeTheNewHistory
> **Status: PLAN ONLY / INVESTIGATION.** No `src/` file has been modified. §7 states
> the root cause; §8 lists the options and the decision I need from you; §9 sketches
> the step plan **only for the option you pick**. Nothing is implemented yet — the
> ticket explicitly asks for the root cause first.

Repository state analysed: `5e24561` (main, SAD-369 merged).
Baseline re-measured in this sandbox today: `tsc --noEmit` clean, `wxt build` 1.99 MB,
`vitest run` **1193 passed / 101 files**.

---

## 0. How this was established (evidence discipline)

Same rule as SAD-370: every claim carries its source.

| Tag | Source | What it proves |
|---|---|---|
| **[LOG]** | The console log you attached last session (`last-console-1792515244323.log`), parsed programmatically — 80 `card` reports, 74 `collection-card` reports, 80 `enrichment outcome` lines | What each path actually stored, on your real run |
| **[CODE]** | Repository at `5e24561`, with `file:line` | Which stage runs on which path |
| **[BASE]** | Measured here today (install → tsc → build → 1193 tests) | The tree this plan starts from |
| **[MEASURED]** | Arithmetic over the log, scripted (not eyeballed) | The field-count delta per product |

The log is the decisive artefact for this ticket because it contains **both paths for
the same products in the same session**: `card` reports are produced by the save paths
(right-click and card-icon) and `collection-card` reports by the collection run. That
makes the comparison direct rather than inferred.

---

## 1. Answer in one paragraph

Collection mode does not extract less — **it stops one stage earlier.** All three entry
points run the *same* card parser and produce the *same* product (`§3`), and the log
proves it: the `card` reports from your saves and the `collection-card` reports from
your collection have byte-identical field statuses and identical "missing" reasons
(`§5.2`). The extra data you see on a right-click save is fetched afterwards, by a
stage that only the save pipeline has: the background fetches the **product detail
page over HTTP**, parses it in the offscreen document, and merges 22 detail-authoritative
fields into the row (`enrichSavedProduct`). On your session that stage added a median
of **12 fields per product**, taking a saved row from **7 → 19 fields**, while every
collected row stayed at **7** (`§5.1`). Manual and automatic mode are irrelevant to
this: the mode only drives scrolling, and both modes hand the page to the same
`extractCurrentPageProducts` (`§6.1`).

---

## 2. The three methods as they exist today

### 2.1 Entry points

```
                         ┌──────────────────────────────────────────────┐
RIGHT-CLICK / CARD ICON  │ amazon.content.ts  onSave / resolveSaveCandidate
                         │   extractProductFromCard(card)               │ save-product.ts:39
                         │     parseAmazonSearchCard  ??                 │ search-results.ts:63
                         │     parseAmazonCategoryCard                   │ category-page.ts:124
                         └───────────────┬──────────────────────────────┘
                                         │  SAVE_PRODUCT { product, context }
                                         ▼
                         ┌──────────────────────────────────────────────┐
                         │ background/handler.ts case 'SAVE_PRODUCT'     │ :842
                         │   handleSaveProduct(payload, { enrich: … })   │ save-job.ts:167
                         │     saveQuickProduct(row)                     │ :290
                         │     enrichSavedProduct({ jobId, asin, … })    │ :330  ← ★
                         │       fetchPdpHtml → parsePdpHtmlViaOffscreen │
                         │       mergeDetailIntoStored → db.update       │
                         └──────────────────────────────────────────────┘

COLLECTION (manual OR auto)
                         ┌──────────────────────────────────────────────┐
                         │ amazon.content.ts  extractCurrentPageProducts │ :78
                         │   search   → parseAmazonSearchResults         │
                         │   category → parseAmazonCategoryPage          │
                         │   product  → parseAmazonProductDetail         │
                         └───────────────┬──────────────────────────────┘
                                         │  PRODUCTS_COLLECTED { products }
                                         ▼
                         ┌──────────────────────────────────────────────┐
                         │ background/handler.ts case 'PRODUCTS_COLLECTED'│ :842
                         │   processProductsCollected                    │ :413
                         │     validateAndNormalizeScrapedProduct        │
                         │     addProducts(validProducts, sessionKey)    │ :560
                         │   ── no fetch, no detail parse, no merge ──    │
                         └──────────────────────────────────────────────┘
```

### 2.2 The one structural difference — **[CODE]**

| Stage | Right-click save | Card-icon save | Collection | Source |
|---|---|---|---|---|
| Card parser | `parseAmazonSearchCard ?? parseAmazonCategoryCard` | same | `parseAmazonSearchResults` / `parseAmazonCategoryPage` → same two functions | `save-product.ts:39-46`, `search-results.ts:63`, `category-page.ts:124` |
| Zod validate + normalise | background | background | background | `handler.ts:505`, `save-product.ts` |
| Row upsert | `saveQuickProduct` (volatile-refresh) | same | `addProducts` (fill-only) | `db/quick-save.ts:104`, `db/products.ts:66` |
| **PDP fetch over HTTP** | **yes** | **yes** | **no** | `save-job.ts:330` vs `handler.ts:413-560` |
| **Detail parse (offscreen)** | **yes** | **yes** | **no** | `enrich-saved-product.ts:392` |
| **Merge of 22 detail fields** | **yes** | **yes** | **no** | `enrich-saved-product.ts:120-170` |
| Detail snapshot row | `appendSnapshot(source:'detail')` | same | none | `enrich-saved-product.ts:437` |
| Enrichment diagnostics line | `enrichment outcome` | same | none | `enrich-saved-product.ts:253` |

`enrich:` is passed in exactly two places in the whole codebase —
`handler.ts:863` (`case 'SAVE_PRODUCT'`) and `save-job-recovery.ts:199` (resume of a
save job). **No collection branch passes it**, and `processProductsCollected` never
imports the enrichment module. That single omission is the discrepancy.

### 2.3 What "the same data" would require

`DETAIL_FIELDS` (`enrich-saved-product.ts:30-52`) is the list the merge writes, and it
is 22 fields. Of those, **five are structurally unreachable from any listing card** —
the same five `card-diagnostics.ts:30` declares card-inapplicable:

`description`, `features`, `weight`, `warrantyDescription`, `warrantyDescriptionRaw`

So no amount of card-parser improvement can close the gap; only a product-page read can.

---

## 3. Are the two *card* parsers really identical? Yes — proved by your own log **[LOG]**

A single collection run stores products through
`parseAmazonCategoryPage`/`parseAmazonSearchResults`, while a save calls
`parseAmazonSearchCard` first. Two different call sites could in principle return
different data. They do not:

| Field | `card` reports (saves, `jobId` = per save) | `collection-card` reports (one run) |
|---|---|---|
| reports | 80 (80 distinct jobIds) | 74 (56 unique ASINs, 2 runs) |
| `asin`, `url`, `title`, `price`, `listPrice`, `currency`, `imageUrl` | EXTRACTED **80/80** each | EXTRACTED **74/74** each |
| `rating`, `reviewCount`, `brand`, `availability`, `seller`, `delivery`, `pastMonthSales`, `bestSellersRank`, `variations`, `discountPercentage`, `dealBadge`, `coupon`, `isPrime` | MISSING **80/80** each, identical reason strings | MISSING **74/74** each, **identical** reason strings |
| tiers | asin/title/price `tier2_semantic`, image `tier3_structural` | **same tiers, same counts** |

Field-for-field and reason-for-reason identical. **The card parse is not the problem**,
and any theory that blames the collection parser is contradicted by the data.

---

## 4. What each stage can possibly deliver **[CODE] + [MEASURED]**

| Field | From a listing card | From a fetched PDP | Card-possible? |
|---|---|---|---|
| `asin`, `url`, `title`, `price`, `listPrice`, `currency`, `imageUrl` | ✅ (deals card) | ✅ | yes |
| `rating`, `reviewCount` | ✗ on `/deals`; ✅ on search cards (`cardFields.rating`, `selectors.ts:310`) | ✅ | **layout-dependent** |
| `brand`, `availability`, `seller`, `delivery`, `pastMonthSales` | ✗ on `/deals` | ✅ | layout-dependent |
| `bestSellersRank`, `variations`, `discountPercentage`, `dealBadge`, `coupon`, `badge`, `isPrime` | ✗ on `/deals` | ✅ (mostly) | layout-dependent |
| `description`, `features`, `weight`, `warrantyDescription`, `warrantyDescriptionRaw` | **✗ never** | ✅ | **no** |

Only the last row is a *structural* gap. The rest is "the deals grid does not print it",
and the PDP read is what supplies it on the save path.

---

## 5. Measured on your session **[MEASURED]**

### 5.1 The field budget, per product

Method: every `card` report (save) is paired with the `enrichment outcome` line that
carries the same ASIN; `fieldsChanged` is exactly what the merge wrote into the row.

| Metric (80 paired saves) | Value |
|---|---|
| Fields the card parse produced | **7** (every save) |
| Fields enrichment then added | **median 12** (min 0, max 16) |
| Fields in the final saved row | **median 19** (min 7, max 23) |
| Fields in every collected row | **7** (56 unique products, all exactly 7: `asin, url, title, price, listPrice, currency, imageUrl`) |

Fields the enrichment stage contributed, with the number of the 80 saves that gained each:

| Field | Saves gaining it | Field | Saves gaining it |
|---|---|---|---|
| `reviewCount` | 70 | `discountPercentage` | 27 |
| `features` | 70 | `seller` | 25 |
| `rating` | 70 | `description` | 17 |
| `availability` | 70 | `warrantyDescription` | 15 |
| `imageUrl` (upgraded) | 70 | `warrantyDescriptionRaw` | 15 |
| `brand` | 69 | `isPrime` | 14 |
| `bestSellersRank` | 67 | `pastMonthSales` | 28 |
| `variations` | 66 | `delivery` | 28 |
| `title` (upgraded) | 52 | `weight` | 46 |

**So the observed discrepancy is 12 fields per product, median — and it is produced
entirely by a stage the collection path never calls.**

### 5.2 What the user sees

The preview table has 27 product columns (`ui/table/columns.tsx:126-878`). A collected
row from the `/deals` grid fills 8 of them (`imageUrl, title, asin, price, listPrice,
currency, url, source`, plus `isPrime:false`/`isSponsored` defaults) and leaves **17
empty**: `discountPercentage, dealBadge, rating, reviewCount, bestSellersRank,
pastMonthSales, coupon, badge, delivery, brand, seller, availability, description,
features, variations, weight, warrantyDescription`. A saved row leaves ~4-6 empty.
Exports read the same row (`export-collection.ts:148`), so the CSV/XLSX inherits the
difference.

---

## 6. Hypotheses examined and eliminated (so the fix is not aimed at a ghost)

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Collection uses a different/weaker card parser | **Eliminated** | §3 — identical statuses, reasons and tiers across `card` vs `collection-card` |
| H2 | Collection parses too early, before cards hydrate, so lazy fields are missed | **Eliminated** | The save path parses the same card *later*, at click time, and its `card` report is identical (7 fields, same reasons). If timing mattered, the two would differ |
| H3 | Manual vs automatic mode changes extraction | **Eliminated** | `mode` is only read into `currentMode` (`amazon.content.ts:478`) and drives scrolling; there is no branch on mode anywhere in the parse path. Both modes call `extractCurrentPageProducts` (`:78`) |
| H4 | Field toggles (`enabledFields`, 26 keys) suppress extraction during collection | **Eliminated** | The toggles are consumed only by the table column builder (`columns.tsx:919-930`) and the export column builder (`export-collection.ts:148`). They never reach a parser |
| H5 | The DB layer or `addProducts` drops detail fields | **Eliminated** | A collection started **on a product page** goes through the same `addProducts` and stores the full PDP product (`extractCurrentPageProducts` PDP branch, `:96`); `enrichStoredProductFields` (`db/products.ts:7`) backfills nullable keys |
| H6 | Schema validation strips or rejects the richer rows | **Eliminated** | `AmazonProductSchema` (`schemas/product.ts:13`) accepts all 27 fields; saves validate the same shape |
| H7 | Dedup merges collected rows down to the poorest variant | **Eliminated** | `dedup.mergeAndFilterNew` + `mergeScrapedProductFields` fill non-null values; nothing nulls a populated field |
| H8 | Collection *does* enrich but the result is discarded | **Eliminated** | `enrichSavedProduct` has exactly two callers (`handler.ts:863`, `save-job-recovery.ts:199`); neither is on the collection path |
| H9 | The save row looks richer only in the UI (display-layer difference) | **Eliminated** | §5.1 is measured from stored-row merges (`fieldsChanged`) and from the same table component for both |
| H10 | Saves fetch details because of a setting you enabled | **Eliminated** | Enrichment is unconditional for non-PDP saves (`save-job.ts:310`: `shouldEnrich = Boolean(deps.enrich) && !savedFromProductPage`). There is no enrichment setting in the schema |

**The only surviving explanation is the absence of the enrichment stage on the collection
path.**

---

## 7. Root cause — precise statement

1. **Collection and saves share the extraction stage exactly.** Same parsers, same
   validation, same field model. [CODE §2.2] [LOG §3]
2. **The save pipeline has a second stage that the collection pipeline does not.**
   After writing the row, `handleSaveProduct` calls `enrichSavedProduct`, which (a)
   fetches the product page over HTTP from the service worker, (b) parses it in the
   offscreen document, (c) merges the 22-field `DETAIL_FIELDS` whitelist into the
   existing row, and (d) stores a detail snapshot. [CODE `save-job.ts:296-350`,
   `enrich-saved-product.ts:392-460`]
3. **`processProductsCollected` has no equivalent step, and no code path can add one
   implicitly.** The collection handler ends at `addProducts`. [CODE `handler.ts:413-560`]
4. **Therefore the field gap is by construction, not by defect:** a collected row can
   only ever contain what the listing card printed; everything the product page carries
   stays missing — including the five fields a card can never carry. [MEASURED §5.1]

One-line root cause:

> **Enrichment is a save-only pipeline stage.** Collection mode extracts exactly what
> the right-click path extracts; what it lacks is the follow-up product-page fetch +
> offscreen parse + detail merge that only `SAVE_PRODUCT` runs.

### 7.1 A note on the mode names

The ticket title is "Automatic mode and manual mode", but the modes are not the cause
(H3). `manual` vs `automatic` changes *who scrolls*: automatic drives
`scroll-controller.ts` for you, manual relies on you. Both then hand the same DOM to the
same parser on the same debounce. Whatever fix is chosen applies to both modes
identically.

---

## 8. Options (decision required — nothing below is implemented)

Constraints that bound any option, all measured or in code:

| Constraint | Value | Source |
|---|---|---|
| Enrichment cost per product | median **2.36 s**, p90 **3.0 s**, max 3.4 s | [LOG] 80 outcomes |
| Concurrency | **2** in flight | `enrich-saved-product.ts:27` |
| Circuit breaker | 3 captchas in a row, or 3 × 429 in 60 s → **60 s cooldown** for that host | `enrichment-fetch.ts:28-30, 96-120` |
| Fetch timeout | 12 s, one retry, body cap 3 MB | `enrichment-fetch.ts:24-27` |
| Durability | MV3 can suspend the worker mid-queue; saves are protected by `job-store` + `save-job-recovery` | `job-store.ts:1-20`, `save-job-recovery.ts` |
| Real load already tolerated | **80 enrichments in one session** (≈194 s of cumulative work) with 1 captcha failure | [LOG] |

That last row matters: enriching a collection is **not new load** — your saves already
produced exactly this volume and pattern in the same session.

| Option | What it does | Effort | Risk | User-visible result |
|---|---|---|---|---|
| **A. Enrich each collection batch** (mirror the save pipeline) | After `addProducts` in `processProductsCollected`, enqueue the new ASINs; a worker-local queue calls the existing `enrichSavedProduct` per row, respecting concurrency + breaker, with `storage.session` persistence and resume | Medium | Medium — runs *during* scrolling, competes with the collection; needs an in-flight guard against later batches re-writing the same ASIN | Rows visibly upgrade to save quality while you collect |
| **B. Enrich at collection completion** | Same machinery, triggered once when the run ends | Medium | Lower — no contention with scrolling; a long tail after "completed" | Rows upgrade a few minutes after the run ends |
| **C. On-demand enrichment** | A per-row or per-collection action ("Fetch details") reusing `enrichSavedProduct` over the session's ASINs | Low-medium | Low — explicit user action, bounded traffic | Nothing changes unless asked; parity on request |
| **D. Opt-in setting + cap** | A new `enrichCollectedProducts` setting (default off) + `enrichCollectedLimit` (e.g. 25/50/all), wrapped around A or B | Low on top of A/B | Low | You choose the behaviour per run |
| **E. Label, don't fetch** | Mark rows as "card data" in the table + keep the manual path | Low | Very low | The difference becomes explicit instead of surprising |

### 8.1 What I recommend (and why)

**D on top of B**, for three measured reasons:

1. **B avoids contention.** During automatic scrolling the content script is already
   debouncing DOM mutations (`mutation-debounce.ts`), and enrichment at that moment adds
   network + offscreen work to the same worker that is routing collection batches.
2. **D keeps the default behaviour honest.** Automatic enrichment is a real change in
   outbound traffic (one request per collected product); making it a setting with a cap
   means nobody's collection silently triples in requests. The cap also bounds the
   failure mode when the breaker trips.
3. **The existing breaker does the safety work for free** — 3 captchas take the host out
   of service for 60 s, and a failed enrichment leaves the card-quality row intact
   (`enrich-saved-product.ts:22-24`: "the row already exists… left byte-identical").

**Option A is the alternative** if you want the rows to fill in *while* you watch, and it
is the closest behavioural match to "collection behaves like saving each card".

I do **not** recommend C alone: it reproduces the current asymmetry but keeps the
collection's data poorer than the save's unless you click, which is what SAD-379 is
about.

---

## 9. If Option D/B is chosen — step sketch (not started, not committed)

Only after you pick. Nothing here is written yet, and each step keeps its own
`npm run verify` gate.

| # | Step | Files (expected) | Proof |
|---|---|---|---|
| 0 | Re-measure the baseline on a fresh run: collect N on `/deals` with diagnostics on, then right-click the same N; record both field sets | harness script (spike, unbundled) | a table like §5.1 for *that* run, not the attached log |
| 1 | Extract the enrichment queue into a reusable module (`enrichment-queue.ts`): enqueue(sessionKey, asin, url), concurrency 2, breaker-aware, `storage.session` persisted, resumes after suspension | new module + `job-store`-style store + tests | unit tests for ordering, dedupe, resume, breaker stop |
| 2 | Call it from `processProductsCollected` behind the new setting (default off), after `addProducts` | `handler.ts`, `schemas/settings.ts`, `constants/defaults.ts` | collection run with the setting off is byte-identical to today |
| 3 | Trigger on collection completion (Option B) rather than per batch, and mark rows in progress | `handler.ts` (`handleCollectionProgress`/`handleStopCollection`) | a stopped run still finishes its queue or leaves rows intact |
| 4 | Surface quality: an `enrichmentStatus`/`detailsFetched` indicator or a "Fetch details" action | `ui/table/columns.tsx`, `ui/components/*` | UI test; no column shows a value it does not have |
| 5 | Settings UI row + docs | `SettingsOverlay.tsx`, `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md` | `docs-consistency` test green |

Regression constraints for every step:

- **`addProducts` stays fill-only.** Collection writes must not start overwriting rows a
  save enriched. The merge policy for collection enrichment is
  `mergeDetailIntoStored` (fill-only price family), not `addProducts`.
- **The diagnostics switch keeps gating every `enrichment-*` line.**
- **Temu untouched** (`temu-isolation.test.ts`).
- **No new permission.** The PDP fetch already relies on `host_permissions` +
  offscreen.
- **Manual and automatic behave identically**, as they do today.

---

## 10. Risks if enrichment is added to collection

| Risk | Why | Mitigation |
|---|---|---|
| Breaker trips mid-collection → most rows stay card-quality | 3 captchas → 60 s cooldown, and a run of 160 products is 160 requests | cap + stop-on-open-circuit + resume later; the row keeps card data |
| Worker suspended mid-queue | MV3 idle timeout between two `await`s | persist the queue in `storage.session`, resume on wake (the `save-job-recovery` pattern) |
| Double-write race: batch N+1 re-adds an ASIN that is being enriched | `addProducts` is fill-only for nullable keys, so a race cannot erase data — but it can cause two `db.update` calls | per-ASIN in-flight set, as `save-job.ts:283` already does with `inFlightByAsin` |
| Collection slow-down while scrolling | enrichment shares the worker with the collection message chain | Option B (after completion) or a serialized queue that never blocks `pendingProductsChain` |
| User collects 300 and expects 300 detail pages | target count goes to 1000 (`clampTargetCount`) | cap + a visible progress/quality indicator |
| A richer row changes export shapes | exports read the same columns | no column list change; values simply stop being empty |

---

## 11. Open questions — I need these before any implementation

| # | Question | Options | Why it changes the design |
|---|---|---|---|
| **Q1** | What should collection mode do? | (i) enrich every collected product automatically — (ii) opt-in setting with a cap — (iii) only on demand — (iv) label only, never fetch | decides A/B/C/D/E, the settings schema, and whether the collection run gains network work at all |
| **Q2** | If automatic: **when**? | (i) during the run, per batch — (ii) after the run completes | during-run risks contention and needs the in-flight guard; after-run needs a durable tail |
| **Q3** | If capped: what cap? | first 25 / first 50 / the run's target / all | must stay under the breaker's tolerance and the user's patience |
| **Q4** | Should a collected row show its quality (e.g. "details fetched 12/17") or stay silent? | indicator / silent | decides whether step 4 exists at all |

---

## 12. Appendix A — reproduction recipe (for step 0)

1. Build: `npx wxt build`.
2. Load `dist/chrome-mv3`, enable **Amazon → Enable extraction diagnostics**.
3. Open `https://www.amazon.com/deals`, start a collection of ~10 in **automatic** mode.
4. Capture the `[PPHunt][Amazon][Diagnostics] {"stage":"collection-card"…}` lines —
   expect 7 `EXTRACTED` per product.
5. On the same page, right-click 3 of those cards → **Save Product Details**. Expect for
   each: a `{"stage":"card"…}` line with the **same 7**, then an
   `[PPHunt] enrichment outcome … "fieldsChanged":[…]` line listing ~12 more.
6. Compare the two stored rows in the panel/export: 7 vs ~19 populated columns.
7. `IndexedDB → PPHuntDB → products` shows the same difference at the data level, so the
   gap is not a rendering artefact.

## 13. Appendix B — exact code references

| Concern | Location |
|---|---|
| Collection parse entry | `entrypoints/amazon.content.ts:78-160` |
| Collection message | `entrypoints/amazon.content.ts:408-425` |
| Collection handler (no enrichment) | `background/handler.ts:413-560`, `:842` |
| Save handler (`enrich:` dependency) | `background/handler.ts:842-870` |
| Save pipeline + `shouldEnrich` | `background/save-job.ts:167-399`, `:310` |
| Enrichment step | `background/enrich-saved-product.ts:340-482` |
| Detail field whitelist / fill-only set | `enrich-saved-product.ts:30-76` |
| Merge policy | `enrich-saved-product.ts:120-170` |
| Fetch + breaker | `background/enrichment-fetch.ts:24-120` |
| Offscreen parse | `background/offscreen.ts`, `offscreen/parse.ts:52` |
| Detail parser | `scraper/product-detail.ts:800` |
| Card parsers | `scraper/search-results.ts:63`, `scraper/category-page.ts:124` |
| Column model (27 product columns) | `ui/table/columns.tsx:126-878` |
| `addProducts` fill-only backfill | `db/products.ts:7-90` |
| Quick-save upsert (volatile refresh) | `db/quick-save.ts:104-200` |
| Job durability pattern to copy | `background/job-store.ts`, `background/save-job-recovery.ts` |

---

## 14. Summary

The three methods extract identically; two of them then fetch the product page, and you
were comparing a **post-fetch row** with a **pre-fetch row**. The log proves it beyond
argument: saves and collections report the same 7 fields with the same reasons on the
same cards, and enrichment adds a median of 12 further fields (7 → 19) to each saved row
while every collected row stays at 7. Manual and automatic mode are irrelevant — the mode
only decides who scrolls. Any fix is therefore not an extraction fix but a question of
**when, if ever, a collected product should also get its product page fetched**, and that
is the decision in §11.
