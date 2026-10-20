# SAD-360 — Review of "Add diagnostic logging to the existing Temu Engine" + amended implementation plan

**Mode: PLANNING / REVIEW ONLY.** No source code was changed for this review. All owner decisions (D1–D8) are locked; this plan is pushed on `feat/temu-engine` per owner instruction, **not** `main`, pending implementation approval. (Branch history: first pushed onto `feat/temu-engine` at its older base, then rebased onto `origin/main` (`6f168df`) the same day, so this branch is exactly `main` + this plan commit and the `034cb12` audit base is in its history.)
Repo: `MakeTheNewHistory/PPHunt`, cloned fresh, reviewed at `034cb12` (then-current `origin/main`).
Issue: [SAD-360](https://linear.app/sad-mod/issue/SAD-360/add-diagnostic-logging-to-the-existing-temu-engine) (Todo, priority 1, project PPHunt). No comments, relations, or attachments exist on the issue.
Baseline verified during review: `tests/temu-scraper.test.ts`, `tests/temu-schemas.test.ts`, `tests/extraction-diagnostics.test.ts` = **34/34 pass**; `tsc --noEmit` clean.

---

## 1. Verdict

**The plan is sound in intent but is NOT implementable as written for Temu. Proceed only with the amendments below.**

SAD-360 is a near-verbatim mirror of SAD-359 (Amazon, "Add diagnostic logging"), which is already implemented and gap-closed on this repo (`src/engines/amazon/scraper/extraction-diagnostics.ts`, 5-status taxonomy, `[PPHunt][Amazon][Diagnostics]` one-line JSON, service-worker sink). The Temu text inherits Amazon assumptions that do not transfer. Four of those were put to the owner and are now **locked** (§3). The rest are engineering gaps (§2) that the amended plan (§5–§8) closes without touching extraction behaviour.

Constraint honoured throughout: **nothing in this plan changes selectors, extraction strategies, field mappings, data models, enrichment behaviour, persistence, exports, or UI.** Diagnostics are an optional out-parameter + one additive optional message field + log lines wrapped so they can never throw into a save.

---

## 2. Gaps found in the issue as written (evidence from the Temu code)

| # | Gap | Evidence |
|---|---|---|
| **G1 — Contradictory field list** | Req 1 lists "variations, weight", but the Temu engine does not model them at all: no `variations`/`weight` in `TemuScrapedProduct` (`src/engines/temu/types/index.ts`), `TemuProduct` (`src/engines/temu/types/product.ts`), either Zod schema, or any Temu extractor. (Amazon has them only because SAD-357 added them there.) Req 1 simultaneously says "Do not introduce unsupported fields." | Owner decision resolves this: modelled-only, variations/weight excluded (§3). |
| **G2 — Scope unspecified (3 parse paths, not 1)** | Amazon SAD-359 had a PDP parser + card telemetry. Temu has `parseTemuProductDetail` (1 product, `src/engines/temu/scraper/product-detail.ts:46`), `parseTemuSearchResults` (dozens–thousands of cards, `search-results.ts:21`), and `parseTemuCategoryPage` (delegates to search, `category-page.ts:13`). "When I collect a Temu product" is dominated by the card flow, not PDP. A single field set also can't serve both: on cards `description: null` and `features: []` are **hardcoded** (`search-results.ts`), so reporting them would be permanent meaningless `MISSING` noise — the exact trap Amazon avoided by excluding card-only `badge` from its detail report. | Owner decision: both paths, per product (§3). Stage-specific field sets required (§6). |
| **G3 — No Amazon-style transport exists on Temu** | Amazon's SW-console design rode on offscreen enrichment + `SAVE_PRODUCT`. Temu has **no offscreen parse, no enrichment, no save-job, and no "job ID"**. Its only product transport is `TEMU_PRODUCTS_COLLECTED` (content → background; `src/engines/temu/schemas/messages.ts:116`, sent at `temu.content.ts:122` and `:153`), and its only identifier is `sessionId`. The issue's "extraction job ID, when available" and "API response" source have no Temu counterpart — the Temu scraper makes **zero** fetch/API calls (DOM + JSON-LD only). | SW sink is still achievable (§3), but needs a new additive ride-along + logging inside the background persist path (§5), and `sessionId` as the job-equivalent. |
| **G4 — `MISSING` vs `PARSE_FAILED` is not observable today** | This is the biggest feasibility gap. Temu's shared helpers return only final values: `extractTemuPricing` (`field-parsers.ts:439`), `extractTemuRatingAndReviews` (`:624`), `extractTemuSalesVolume` (`:595`), `extractTemuCardTitle` (`:360`), `findBestTemuCardImage` (`:755`), and the regex-scan `extractTemuCardMetadata` (`:807`) all collapse "node absent" and "node present but unparseable" into the same `null`. A caller-side-only implementation would have to **guess** which occurred — violating Req 3 and the no-guessing rule. Amazon could do it because its detail parser loops selectors inline; Temu's decisions live *inside* these helpers, which are shared by **both** card and PDP paths. | Plan must thread an **optional** diagnostics collector *into* the helpers (§5.3). Parity test (product deep-equal with vs without collector) is the guard. |
| **G5 — Modelled ≠ reportable 1:1** | Several modelled slots are not page-extractions: `asin` is a byte-for-byte mirror of `goodsId` (would double-count one extraction in the summary), `source` is assigned by the caller, `currency` is partly *derived* (`extractTemuPricing` falls back to `USD`; `validateAndNormalizeTemuScrapedProduct` defaults it when a price exists), and `isSponsored`/`isPrime` are booleans where `false` is a legitimate value (Amazon's `applyValidationResults` already special-cases `isPrime` for this reason). JSON-LD `categoryBreadcrumb` is extracted on PDP (`product-detail.ts:245`) but is **not** a product field — exclude. | Counting/classification rules in §6; two sub-decisions flagged OPEN-1/OPEN-2 (§9), to be locked before coding, not guessed. |
| **G6 — Validation happens twice, in two places** | Products are validated in the content script (inside the parsers, via `validateAndNormalizeTemuScrapedProduct`, `field-parsers.ts:942`) **and again** in the background (`persistTemuCollectedProducts`, `handler.ts:316`, which re-normalizes, re-checks `TemuProductSchema`, counts `rejectedCount`, and upserts under `state.sessionId`). "Passed the engine's existing validation checks" (Req 2) is ambiguous about which layer — and a product the background rejects must not be logged as successfully collected. Note also many per-field drops happen *inside* the field parsers (e.g. rating range in `parseTemuRating`), before either validator sees a value. | §5.5: `validated` is defined at the parse-time validator; the SW log is emitted **inside/after** persist, for products that survived background validation, keyed by the resolved `sessionId`. |
| **G7 — Volume / spam risk (chosen scope makes this real)** | Per-product logging on the card path meets `TEMU_TARGET_MAX = 10000` (presets 50–300, `src/engines/temu/constants/defaults.ts:59-63`), a `TemuParseCache`, dedup re-sends, and a `TEMU_PRODUCTS_COLLECTED` branch that re-sends the **entire** `collectedSoFar` array when merges update existing products (`temu.content.ts:122`). Naïve instrumentation would re-log the same card on every scroll/re-parse and inflate the runtime message with a ~22-field report per product. | §5.4/§5.5: diagnostics are generated per parse but **only transmitted/logged for the bounded new products actually sent** (`sendProductsToBackground`, `temu.content.ts:135`); never on the re-send branch, never for cache-hit/deduped cards. Statuses/selectors/reasons/counts only — no titles, prices, or HTML (Req 4). Logging wrapped in try/catch (Amazon precedent: "never let the console break a save"). |

**Also confirmed:** Temu currently has *no* extraction-diagnostics module (`src/engines/temu/scraper/` has no `extraction-diagnostics.ts`; only error-path `console.warn('[PPHunt:Temu] …')` lines exist). Do **not** import the Amazon module — the engines are deliberately duplicated/isolated (guarded by `tests/temu-isolation.test.ts`); a Temu-native sibling module follows the house pattern. Badged prefix note: existing Temu logs use `[PPHunt:Temu]`; the issue's `[PPHunt][Temu][Diagnostics]` is a *new* prefix for diagnostics only — pin it exactly, do not restyle existing logs (out of scope).

---

## 3. Decisions locked by the owner (2026-10-20, via interactive questions — no guessing)

| # | Decision | Locked value |
|---|---|---|
| D1 | `scope` | **Both**: per-field diagnostics for PDP (`parseTemuProductDetail`) **and** per-product diagnostics for search/category cards (`parseTemuSearchResults`; category inherits via delegation). |
| D2 | `field_set` | **Modelled fields only.** Variations & weight are **out of scope** (unsupported on Temu; Req 5 forbids adding extraction to satisfy logs). Only fields in `TemuScrapedProduct`/`TemuProduct` are classified. |
| D3 | `log_sink` | **Service-worker console only** (mirror SAD-359): diagnostics ride along to the background and are logged there. Content-script/page console gets nothing new. |
| D4 | `format + grouping + enablement` | **Always-on** (no settings toggle — no settings schema/UI change), **one-line JSON per product**: `[PPHunt][Temu][Diagnostics] {json}` with `goodsId`, `sessionId` (the Temu job-equivalent), `stage`/`pageType`, 5-bucket counts, and per-field entries. One-line JSON is deliberate (SAD-352 lesson: console objects collapse to `…` when pasted out of DevTools; one line survives copy-paste and stays greppable/filterable). Values (titles/prices) are never logged. |

Second round of owner decisions (2026-10-20, interactive — the former OPEN-1…OPEN-4, now locked):

| # | Decision | Locked value |
|---|---|---|
| D5 | `asin`/`source` entries | **Exclude both** from the report. `goodsId` is the envelope/identifier; `source` is carried as the log's `stage`/`pageType`. Counts partition only real page extractions. |
| D6 | Booleans `isSponsored`/`isPrime` | Marker found → `EXTRACTED`; marker absent → `MISSING` with reason `'no … marker found'` (Amazon `isPrime` precedent); **never** `validated:false` on a legitimate `false`. |
| D7 | PDP with no resolvable `goodsId` | Still emit **one** SW line with `goodsId: null` (attempted fields classified, rest `UNKNOWN`). Card skips without `goodsId` stay silent (non-product nodes; no spam). |
| D8 | Background-rejected products | **No per-field line.** Only products that survived background validation in `persistTemuCollectedProducts` get diagnostic lines; rejects stay on the existing `rejectedCount` path, unchanged. The SW log therefore always reflects what was actually collected. |

From the issue itself (not re-asked, unambiguous): 5 statuses `EXTRACTED / MISSING / PARSE_FAILED / PARTIAL / UNKNOWN` (Req 1 + Req 3's UNKNOWN clause); Amazon-only clause is inverted — **Amazon engine must not be modified** (Req 5).

---

## 4. Clause-by-clause audit (SAD-360 vs Temu code)

| Clause | Verdict after D1–D4 |
|---|---|
| R1 every supported field | ✅ with stage-specific sets (§6); variations/weight excluded per D2 |
| R1 statuses incl. `PARSE_FAILED` | ⚠️ achievable **only** with in-helper instrumentation (G4) |
| R2 product ID | ✅ `goodsId` envelope (also per report) |
| R2 job ID | ✅ reinterpreted as `sessionId`, supplied by the background itself (`state.sessionId` in `handler.ts`) — no content-side plumbing needed, since the logger lives there |
| R2 source (DOM selector / embedded JSON / API) | ✅ `dom` / `json-ld` / `url` / `derived`; **API source: not applicable on Temu** (no API extraction exists — stating this, not inventing one) |
| R2 passed validation | ⚠️ define as parse-time `validateAndNormalizeTemuScrapedProduct` + survive background re-validation before logging (G6) |
| R3 absent vs parse-failed vs validation-failed vs incomplete vs legitimately-unavailable vs UNKNOWN | ✅ mapping in §6.1 (absent→`MISSING`; present-unparseable→`PARSE_FAILED`; dropped-by-validation→`PARTIAL, validated:false`; DOM-rejected→JSON-LD-rescued→`PARTIAL`; legitimately unavailable→`MISSING` with field-specific reason; never-attempted/aborted→`UNKNOWN`, never `MISSING`) |
| R4 readable, filterable, grouped, summarised, no dumps | ✅ D4 format; counts buckets `{extracted, missing, parseFailed, partial, unknown}` partition the field set |
| R5 Temu-only, minimum supporting code, no behaviour change | ✅ design §5; Amazon diff must be empty, verified like SAD-359 did ("Temu-diff check" → here "Amazon-diff check") |
| R6 inspect first, tests for success/missing/partial/parse-failure/unknown, report files/tests/limits | ✅ §7 test matrix; this review is the inspection record |

---

## 5. Target design (smallest change that satisfies D1–D4 + R5)

1. **New Temu-native module** `src/engines/temu/scraper/extraction-diagnostics.ts` (do not import Amazon's): DOM-free collector mirroring the Amazon API shape — `FieldExtractionStatus` (5), `FieldExtractionSource = 'dom' | 'json-ld' | 'url' | 'derived'`, `createFieldDiagnosticsCollector()` (`extracted/missing/parseFailed/partial/rescued/setGoodsId/build`, last-write-wins, `build()` fills un-attempted fields as `UNKNOWN 'not attempted'`), `applyValidationResults` (candidate vs normalized; booleans handled per OPEN-2), `summarizeFieldDiagnostics`, `formatTemuExtractionDiagnosticsLog` → `` `[PPHunt][Temu][Diagnostics] ${JSON.stringify({sessionId, goodsId, stage, counts, fields})}` ``.
2. **PDP instrumentation:** optional trailing `diagnostics?` param on `parseTemuProductDetail(document, url?, diagnostics?)` — all existing callers/tests unaffected. Records per-field outcomes at the existing DOM→JSON-LD merge points; malformed JSON-LD (currently swallowed in `extractTemuJsonLdMetadata`) is candidate-present evidence where it claims the field. Early return on missing `goodsId` still builds a report (goodsId `UNKNOWN`/null envelope) — see OPEN-3.
3. **Card instrumentation (shared helpers, G4):** optional trailing collector param on `extractTemuPricing`, `extractTemuRatingAndReviews`, `extractTemuSalesVolume`, `extractTemuCardTitle`, `findBestTemuCardImage`/`extractTemuBestImageUrl`, `extractTemuCardMetadata`, and on `validateAndNormalizeTemuScrapedProduct` (for `validated` flags) — all in `field-parsers.ts`; optional param on `parseTemuSearchResults(document, pageUrl?, cache?, source?, diagnosticsByGoodsId?)`. `parseTemuCategoryPage` delegates, so it inherits with its `source` label. Helpers record candidate-found-but-rejected internally (e.g. `[data-type="price"]` node whose text `parseTemuPrice` refuses → `PARSE_FAILED`; no node → `MISSING`). **No helper logic, ordering, or return value changes.**
4. **Transport (additive, optional):** `TemuProductsCollectedMessageSchema.payload` gains `productDiagnostics?: Array<{ goodsId, fields }>` aligned by `goodsId` to `products` (products already ride as `z.array(z.unknown())`). Content attaches diagnostics **only** for the bounded new products in `sendProductsToBackground` (`temu.content.ts:153`); the `collectedSoFar` re-send branch (`:122`) sends none. Absent diagnostics (older content script) must still validate and persist exactly as today.
5. **SW logging:** in `handler.ts`, log inside/after `persistTemuCollectedProducts` (both its normal and finalized-session branches) — one line per product that **survived background validation**, using the resolved `sessionId`, `stage = pageType`. Products rejected by the background are not logged as collected (optionally one `PARSE_FAILED`-style rejected line — OPEN-4). Whole logging block try/catch-isolated from persistence. No change to `rejectedCount`, upsert, session, history, or broadcast behaviour.
6. **Explicitly untouched:** Amazon engine (all of `src/engines/amazon/**`, `src/entrypoints/amazon.content.ts`), Temu selectors file (selector *strings* are only read as labels), schemas of record (`TemuProductSchema`/`TemuScrapedProductSchema` unchanged — diagnostics never enter the DB), exports, UI, settings, manifest.

## 6. Field sets & classification

### 6.1 Status semantics (Temu wording of the SAD-359 five)
`EXTRACTED` final value present & kept · `MISSING` searched, evidence of absence · `PARSE_FAILED` candidate found, parser/cleaner rejected it · `PARTIAL` value obtained but incomplete (JSON-LD rescue of a rejected DOM candidate; or dropped by validation, `validated:false`) · `UNKNOWN` parser never reached it / no evidence either way.

### 6.2 Per-stage field sets (modelled only, D2)
- **PDP (detail):** `goodsId`(envelope), `url, title, price, listPrice, discountPercentage, currency, rating, reviewCount, pastMonthSales, imageUrl, brand, seller, availability, dealBadge, badge, coupon, delivery, bestSellersRank, description, features, isSponsored, isPrime`.
- **Cards (search/category):** same **minus `description`, `features`** (hardcoded on cards — not attempted, not `MISSING` noise).
- Excluded everywhere: `variations`, `weight` (unsupported), `categoryBreadcrumb` (extracted but not a product field), `source` (assigned, OPEN-1), `asin` (alias of `goodsId`, OPEN-1).

## 7. Test matrix (new file `tests/temu-extraction-diagnostics.test.ts` + targeted additions)

- **Collector unit:** five statuses, `build()` UNKNOWN-fill, counts partition, one-line format prefix/no-values.
- **PDP fixtures (jsdom, existing `temu-scraper.test.ts` style):** full PDP → core `EXTRACTED` w/ source+selector; no-price PDP → `MISSING`; present-but-unparseable price node → `PARSE_FAILED`; JSON-LD-only price/rating → `EXTRACTED source:'json-ld'`; garbage DOM + valid JSON-LD → `PARTIAL` (strict rescue); non-http image dropped by validation → `PARTIAL, validated:false`; malformed JSON-LD claiming price → not silently `MISSING`; missing-`goodsId` PDP → product `null`, report still built honestly.
- **Card fixtures:** full card `EXTRACTED`; card without rating/discount → `MISSING` w/ reason; price node present, text unparseable → `PARSE_FAILED`; **no `description`/`features` entries on card reports.**
- **⭐ Parity (non-regression proof):** for every fixture, product(s) deep-equal with vs without the collector — on both paths. Plus existing suites green: `temu-scraper`, `temu-schemas`, `temu-isolation`, message-schema/registry suites.
- **Transport/SW:** schema accepts `TEMU_PRODUCTS_COLLECTED` with and without `productDiagnostics`; background logs exactly one `[PPHunt][Temu][Diagnostics]` line per persisted product (with `sessionId`, counts), stays silent when diagnostics absent, logs nothing for background-rejected products, and persistence results are identical either way; dedup/cache re-parse produces **no duplicate** diagnostic lines; re-send branch emits none.
- **Full verify:** `npm run verify` (`tsc` + full vitest + `wxt build`) + dead-export guard + **empty Amazon diff** check.

## 8. Steps (when implementation is approved — not in this review)

0. ~~Lock OPEN-1…OPEN-4~~ **Done** — locked as D5–D8 (§3/§9) and recorded in this note, pushed on `feat/temu-engine` (not `main`). Remaining Step-0 action at implementation time: comment D1–D8 on SAD-360.
1. Diagnostics module + collector tests.
2. PDP instrumentation + PDP fixtures + parity.
3. Shared-helper + card instrumentation + card fixtures + parity.
4. Message ride-along + SW logging + transport tests (no duplicate/dedup cases).
5. Full verify, Amazon-diff check, test report + limitations as a SAD-360 comment; move to In Review.

**Estimated files changed (implementation phase):** new `src/engines/temu/scraper/extraction-diagnostics.ts`, `tests/temu-extraction-diagnostics.test.ts`; edited `scraper/product-detail.ts`, `scraper/search-results.ts`, `scraper/field-parsers.ts`, `schemas/messages.ts`, `entrypoints/temu.content.ts`, `background/handler.ts` (+ message-conformance test touch-ups only if they enumerate payloads). Nothing else.

## 9. Sub-decisions — LOCKED by the owner (2026-10-20)

All four former open items are decided (see D5–D8 in §3): exclude `asin`/`source` as fields; booleans are `EXTRACTED`-on-marker / `MISSING`-without-marker and never `validated:false` on `false`; a goodsId-less PDP still emits one `goodsId: null` line (cards stay silent); background-rejected products get no per-field line. Nothing in §5–§8 remains to be guessed at coding time. (In-text references to OPEN-1…OPEN-4 mean D5–D8 respectively.)

## 10. Impact on existing features (the owner's constraint)

Extraction results, dedup/cache behaviour, DB writes, sessions/history, exports, UI, and Amazon are **byte-for-byte unaffected by design**: collector is an optional out-param (parity-tested), message field is additive-optional (old senders validate), logging is post-persist and throw-isolated. Residual risks are (a) log volume on large card collections — mitigated in §5.4, inherent to D1+D4; (b) in-helper instrumentation touching shared `field-parsers.ts` — mitigated by optional params + parity tests + full-suite verify. Settings/UI risk is zero (always-on, D4).

**Recommendation: approve SAD-360 with D1–D8 and §5–§9 as the amended plan; do not implement the issue text literally.**
