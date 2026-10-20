# SAD-359 — Diagnostic logging: gap-closure plan

**Status:** Plan only. No production code written. Owner decisions locked 2026-10-20.
**Scope:** close the requirement clauses the shipped implementation misses. Touch
nothing else. Diagnostics only — extraction, enrichment, persistence, exports,
UI and Temu stay byte-identical.

---

## 0. Executive summary — read this first

**SAD-359 is already implemented and pushed.** `origin/main` = `aad6913` contains
the whole feature:

| Commit | Content |
|---|---|
| `3cd9713` | Plan doc (step 0) |
| `99cf6cb` | Per-field diagnostics collector + PDP detail-parser instrumentation (step 1) |
| `ab494be` | Offscreen transport + enrichment service-worker log line (step 2) |
| `2e91a41` | On-PDP ride-along via `SAVE_PRODUCT` + save-job log line (step 3) |
| `219bdc0` | Card-drift report surfacing for listing parses (step 4) |
| `c769ef1` | Implementation + verification record |
| `aad6913` | SAD-357 step 4 — `variations` + `weight` wired into the diagnostics |

The shipped module is `src/engines/amazon/scraper/extraction-diagnostics.ts`
(257 lines) with 14 tests in `tests/extraction-diagnostics.test.ts`. Baseline
measured on this clone: **87 test files / 1029 tests pass** (the only failing
suite is `tests/manifest-permissions.test.ts`, which needs `dist/` — it passes
once the extension is built, exactly as the existing plan doc records).

**The issue text is not fully satisfied.** A clause-by-clause audit of the
issue against the code found **5 real gaps** (G1–G5) and one additive
refinement (G6). Every one of them is a *reporting* defect, not an extraction
defect. This plan closes them and nothing more.

| # | Gap | Issue clause | Evidence in code |
|---|---|---|---|
| **G1** | No `PARSE_FAILED` status — "source present, parse failed" is conflated with "value obtained but incomplete" | R1: *"clear statuses such as `EXTRACTED`, `MISSING`, `PARTIAL`, and `PARSE_FAILED`"*; R3 bullets 2 & 4 | `extraction-diagnostics.ts:18` declares only 3 statuses |
| **G2** | No `UNKNOWN` status; fields the parser never reached are reported as `MISSING` | R3: *"Do not report a field as definitively absent when the engine cannot establish that… Use an appropriate `UNKNOWN`"* | `extraction-diagnostics.ts:148-158` — `build()` fills every unrecorded field with `MISSING / 'not attempted'` |
| **G3** | `url` (product URL) is not a diagnostic field | R1 field list explicitly includes *"product URL"* | `DETAIL_DIAGNOSTIC_FIELDS` (`:55-77`) has 23 entries, none is `url`; the parser computes it at `product-detail.ts:1440` |
| **G4** | Log prefix is `[PPHunt] extraction diagnostics` | R4: *"an identifiable prefix, such as `[PPHunt][Amazon][Diagnostics]`"* | `extraction-diagnostics.ts:256` |
| **G5** | Counts have no "failed" bucket | R4: *"Summarize the total number of fields extracted, missing, partially extracted, **and failed**"* | `summarizeFieldDiagnostics` (`:225-232`) returns `{extracted, missing, partial}` |
| **G6** | `source` is absent from `MISSING` entries | R2: *"The extraction source … when applicable"* | all 22 `missing()` call sites pass no `source` |

**Why G1 and G2 are the substantive ones.** All **19** `partial()` call sites
in `product-detail.ts` are the same failure shape — *a candidate node was found
and the cleaner/parser refused it* — which is precisely the issue's
`PARSE_FAILED`. The issue's *other* bucket, "a value being extracted
successfully but remaining incomplete", is the **JSON-LD rescue** path
(`rescued()`, 7 sites) plus the **validation-drop** path
(`applyValidationResults`). Today all 26 of those are one status. Separating
them is what lets the owner tell *"the parser is broken"* from *"the fallback
saved the day"*.

G2 is the one place the current code **over-claims**. When the parser aborts
early (e.g. no title ⇒ `product-detail.ts:857` returns `null`), `build()`
synthesises `MISSING` for all 22 remaining fields. The report therefore says
"21 fields are absent from the page" when the truth is "the parser stopped
after field 2 and never looked". The issue explicitly forbids that reading.

---

## 1. Verified current state (no guessing — every claim below was read or run)

### 1.1 Module map

| File | Lines | Role in SAD-359 |
|---|---|---|
| `src/engines/amazon/scraper/extraction-diagnostics.ts` | 257 | Pure, DOM-free collector: types, `createFieldDiagnosticsCollector`, `applyValidationResults`, `summarizeFieldDiagnostics`, `formatExtractionDiagnosticsLog` |
| `src/engines/amazon/scraper/product-detail.ts` | 1494 | The only producer. `parseAmazonProductDetail(doc, pageUrl, diagnostics?)` — optional 3rd out-param (`:798-806`); helpers `extractDetailAsin` (`:170`), `extractDetailBsr` (`:231`), `extractDetailWarranty` (`:335`), `extractDetailWeight` (`:383`), `extractDetailVariations` (`:680`) take the same optional sink |
| `src/engines/amazon/offscreen/parse.ts` | 118 | `parsePdpHtml` creates the collector (`:79`), attaches the report on success **and** parser-ran errors (`:88`, `:96`, `:116`) |
| `src/engines/amazon/offscreen/protocol.ts` | — | `OffscreenParseSuccess.fieldDiagnostics` (`:101`), `OffscreenError.fieldDiagnostics` (`:108`) — both optional |
| `src/engines/amazon/background/enrich-saved-product.ts` | — | Logs once after `parse(...)`, `stage: 'enrichment-parse'` (`:374-388`) |
| `src/engines/amazon/content/save-product.ts` | — | `resolveSaveCandidate` collects diagnostics on the PDP branch only (`:130-141`); rides along as `ResolvedSaveCandidate.extractionDiagnostics` |
| `src/entrypoints/amazon.content.ts` | — | Forwards `extractionDiagnostics` in the `SAVE_PRODUCT` payload (`:195-198`) |
| `src/engines/amazon/schemas/messages.ts` | — | `FieldDiagnosticSchema` (`:207-214`), `ExtractionDiagnosticsReportSchema` (`:216-219`), `SaveProductMessageSchema.payload.extractionDiagnostics` optional (`:228`) |
| `src/engines/amazon/background/save-job.ts` | — | Logs the ride-along, `stage: 'detail-page'` (`:236-250`) |
| `src/engines/amazon/scraper/drift-telemetry.ts` | — | `logDriftReport(telemetry, stage)` — the previously consumer-less card-drift report, now surfaced (`:158-172`) |
| `src/engines/amazon/schemas/messages.ts` / `src/engines/amazon/types/index.ts` | — | `SaveProductPayload.extractionDiagnostics` optional |

### 1.2 Complete call-site inventory (`product-detail.ts`)

| Outcome | Count | Sites |
|---|---|---|
| `extracted()` | 26 | 17 in `parseAmazonProductDetail` (`diag?.`), 9 in helpers (`diagnostics?.`) |
| `partial()` | **19** | `853, 894, 1002, 1031, 1060, 1086, 1110, 1146, 1186, 1218, 1246, 1274, 1299, 1327, 1365, 1408` (main) + `260` (BSR), `359` (warranty), `463` (weight) (helpers) |
| `rescued()` | 7 | `843, 883, 993, 1178, 1209, 1354, 1397` |
| `missing()` | 22 | `224, 266, 364, 469, 784, 857, 898, 1004, 1037, 1066, 1090, 1114, 1152, 1190, 1222, 1252, 1278, 1303, 1329, 1369, 1412, 1437` |

**Every one of the 19 `partial()` sites is "candidate present, value
unparseable"** — e.g. `:1002` `'buybox/price node present but no parseable
price'`, `:1186` `'rating node present but unparseable'`, `:260` BSR label
without a rank pattern. None of them is an "extracted but incomplete" case.
That is the evidence for G1.

### 1.3 Live baseline (already measured — see §7 for the method)

A real Amazon PDP was parsed by the **built extension** in Chromium, and the
service worker emitted:

```
[PPHunt] extraction diagnostics {"jobId":"50350616-…","asin":"B0D1XD1ZV3",
 "stage":"detail-page","counts":{"extracted":15,"missing":8,"partial":0},
 "fields":[{"field":"asin","status":"EXTRACTED","source":"url","validated":true},
           {"field":"title","status":"EXTRACTED","source":"dom","selector":"#productTitle","validated":true},
           {"field":"price","status":"EXTRACTED","source":"dom","selector":"#corePriceDisplay_desktop_feature_div","tier":"tier2_semantic","validated":true},
           {"field":"listPrice","status":"MISSING","reason":"no list price shown on the page"}, …]}
```

This is the "before" row of the verification table in §7. Note what it shows
today: `MISSING` for every absent field, **no** `url` field, **no**
`parseFailed`/`unknown` buckets, and the old prefix.

---

## 2. Clause-by-clause audit of the issue against the code

| Issue clause | Current state | Verdict |
|---|---|---|
| R1 · log status of every supported field | 23 detail fields + 6 card fields via drift | ⚠️ `url` missing (G3) |
| R1 · classify with `EXTRACTED`/`MISSING`/`PARTIAL`/`PARSE_FAILED` | 3 of 4 | ❌ **G1** |
| R1 · no unsupported fields assumed | `badge` deliberately excluded (card-only field) | ✅ |
| R2 · product ID / identifier | `asin` in the envelope + per-field `asin` | ✅ |
| R2 · extraction job ID | `jobId` in the log payload (both log sites) | ✅ |
| R2 · field name + status | `field` + `status` per entry | ✅ |
| R2 · explanation when missing / partial / unparseable | `reason` on every non-`EXTRACTED` entry | ✅ |
| R2 · extraction source (DOM selector / embedded JSON) | `source` + `selector` + `tier`; **`source` absent on `MISSING`** | ⚠️ **G6** |
| R2 · passed the engine's validation | `validated` set by `applyValidationResults` (`product-detail.ts:1486`) | ✅ |
| R3 · absent from page/response | `MISSING` | ✅ |
| R3 · present but logic failed to parse | folded into `PARTIAL` | ❌ **G1** |
| R3 · extracted but failed validation | `PARTIAL` + `validated:false` + reason `'parsed but failed validation'` | ✅ |
| R3 · extracted but incomplete | `PARTIAL` (JSON-LD rescue) | ✅ (but shares a status with G1) |
| R3 · legitimately unavailable / inapplicable | `MISSING` + field-specific reason | ✅ (mapping pinned in §4.2) |
| R3 · **must not** report absence it cannot establish | `build()` reports un-attempted fields as `MISSING` | ❌ **G2** |
| R4 · structured, filterable, readable | one-line JSON (SAD-352 step 1a.1 lesson) | ✅ |
| R4 · grouped by product and job | `jobId` + `asin` + `stage` in the envelope | ✅ |
| R4 · identifiable prefix | `[PPHunt] extraction diagnostics` | ❌ **G4** |
| R4 · summary counts incl. "failed" | `{extracted, missing, partial}` | ❌ **G5** |
| R4 · no HTML / large payloads / big objects | statuses, selectors, reasons, counts only — no titles, no prices | ✅ |
| R5 · only the Amazon engine, minimum supporting code | 9 files, all Amazon-engine | ✅ |
| R5 · Temu untouched | `src/engines/temu/**` has zero diff; `tests/temu-isolation.test.ts` guards DB/UI separation | ✅ (re-run) |
| R5 · no selector / strategy / mapping / model / enrichment / UI change | none | ✅ (re-run) |
| R5 · diagnostics separate from results; enabling them changes no collected data | collector is an out-param; parity test exists (`extraction-diagnostics.test.ts:312`) | ✅ (re-run) |
| R6 · inspect before changing | done (§1) | ✅ |
| R6 · tests for success / missing / partial / parse-failure / unknown | success, missing, partial, validation-drop covered; **parse-failure and unknown not distinguished** | ❌ **G1 + G2** |
| R6 · verify output reflects actual results | unit-tested only | ⚠️ §7 adds a live session |
| R6 · report files changed, tests executed, limitations | to do | §8, §11 |

---

## 3. Decisions locked (owner, 2026-10-20)

| # | Decision | Value |
|---|---|---|
| D1 | `scope` | Close the remaining requirement gaps. No rewrite, no extraction work. |
| D2 | `taxonomy` | **Five** first-class statuses: `EXTRACTED` / `MISSING` / `PARSE_FAILED` / `PARTIAL` / `UNKNOWN`. |
| D3 | `log_sink` | **Service-worker console only** — unchanged from the recorded `log_sink = sw_json` decision in `docs/plans/SAD-359-extraction-diagnostics-plan.md`. The drift line stays in the content-script (page) console; the two are documented as separate sinks. |
| D4 | `verification` | Automated tests **+** a written verification report **+** a live Amazon measurement session. |
| D5 | `field_set` | `modelled_only` — 24 detail fields (23 + `url`). No new extraction. |
| D6 | `stage_scope` | `detail_plus_drift` — unchanged. |

---

## 4. Target model

### 4.1 The five statuses

| Status | Meaning | Where it is produced | `reason` always present? | `validated` |
|---|---|---|---|---|
| `EXTRACTED` | The final value is present and was kept. | `extracted()` — 26 sites | no | `true` when the value survived validation |
| `MISSING` | A candidate was searched for and **not found** in the source. The engine has evidence of absence. | `missing()` — 22 sites | **yes** | n/a |
| `PARSE_FAILED` | A candidate **was found** in the source and the extraction logic could not turn it into a value (empty text, unparseable number, label without its value, URL rejected, text rejected by the cleaner). | `parseFailed()` — **new**, 19 sites (every current `partial()`) | **yes** | `false` (nothing to validate) |
| `PARTIAL` | A value **was obtained** but it is incomplete: either JSON-LD had to rescue a rejected DOM candidate, or validation dropped/nulled the parsed value. | `rescued()` — 7 sites; `applyValidationResults` — 1 path | **yes** | `true` (rescue) or `false` (validation drop) |
| `UNKNOWN` | The engine could **not establish** presence or absence — the parser never reached this field (it aborted earlier). No conclusion is claimed. | `build()` filler — **new** | **yes** | absent |

### 4.2 Requirement 3's five causes → status

| Issue R3 bullet | Status | Why |
|---|---|---|
| field/source data absent from the page or response | `MISSING` | the search ran and found nothing |
| source data present, extraction logic failed to parse it | `PARSE_FAILED` | the candidate node existed and was rejected |
| value extracted but failed validation | `PARTIAL` + `validated:false` | the value existed, `validateAndNormalizeScrapedProduct` nulled it |
| value extracted successfully but incomplete | `PARTIAL` | JSON-LD rescued a rejected DOM candidate — the value is real but the primary source is rotten |
| field legitimately unavailable / inapplicable to this product | `MISSING` with a field-specific reason | e.g. `'no coupon shown on the page'`. The engine *does* hold evidence of absence (the marker is not on the page). What it cannot rule out is selector rot — which is exactly what the `selector` on candidate-found entries and the `reason` on absent entries make visible. This mapping is the honest reading of R3's "where the available evidence permits". |
| *(R3's closing sentence)* engine cannot establish presence/absence | `UNKNOWN` | the parser never got there — reporting `MISSING` here would be a false claim of absence |

**Consequence for `isPrime`:** unchanged. `isPrime` is a derived boolean
(`product-detail.ts:1434-1437`); a missing Prime marker is literally an
absent marker on the page, so it stays `MISSING` with reason `'no Prime
marker found'`. `applyValidationResults` already skips `isPrime`
(`extraction-diagnostics.ts:200`) because `false` is a legitimate normalized
value, not an absence. No change.

**Consequence for `badge`:** unchanged and explicitly *not* added.
`ScrapedAmazonProduct.badge` is a listing-card field; the detail parser never
sets it, so listing it would print a permanent, meaningless `MISSING` on
every PDP — the exact noise the original plan avoided. The card path's six
tracked fields (`asin`, `title`, `price`, `rating`, `reviewCount`, `imageUrl`)
are covered by the drift report instead.

### 4.3 Field set — 24 fields

`DETAIL_DIAGNOSTIC_FIELDS` (`extraction-diagnostics.ts:55-77`) keeps its
current order and gains one entry:

```
asin, url, title, brand, price, listPrice, discountPercentage, dealBadge,
coupon, currency, pastMonthSales, rating, reviewCount, availability,
delivery, seller, features, description, imageUrl, bestSellersRank,
warrantyDescription, variations, weight, isPrime
```

`url` is placed next to `asin` because both identify the product. It is
produced at `product-detail.ts:1440` (`resolveProductUrl(null, asin, activeUrl)`)
and recorded as `EXTRACTED / source: 'url'`. Because the parser returns `null`
when no ASIN is resolved (`product-detail.ts:816-818`), `url` is derivable
whenever the parser runs — it can only be missing in the never-attempted case.
`ExtractionDiagnosticsReportSchema.fields` is `.max(64)` (`messages.ts:218`),
so 24 entries stay inside the wire limit.

### 4.4 Log line format

```
[PPHunt][Amazon][Diagnostics] {"jobId":"…","asin":"B0D1XD1ZV3","stage":"detail-page",
 "counts":{"extracted":15,"missing":6,"parseFailed":1,"partial":0,"unknown":2},
 "fields":[{"field":"price","status":"PARSE_FAILED","source":"dom",
            "selector":"#corePriceDisplay_desktop_feature_div",
            "reason":"buybox/price node present but no parseable price"}, …]}
```

and the drift line:

```
[PPHunt][Amazon][Diagnostics] drift {"stage":"search-results", …}
```

One-line `JSON.stringify` is kept deliberately — the SAD-352 step 1a.1 lesson
(`docs/plans/SAD-352-measurement-2026-10-20.md`): console *objects* collapse
to `…` when pasted out of DevTools, one-line JSON survives copy-paste and
stays greppable. Both lines share the prefix, so one DevTools filter
`[PPHunt][Amazon][Diagnostics]` catches both sinks.

**Counts key naming.** The issue says *"extracted, missing, partially
extracted, and failed"*. The status is named `PARSE_FAILED`, so the count key
is `parseFailed` — self-describing and unambiguous. `unknown` is added so the
five statuses and the five counts stay in bijection (`extracted + missing +
parseFailed + partial + unknown = total fields`).

---

## 5. Changes, file by file

### 5.1 `src/engines/amazon/scraper/extraction-diagnostics.ts` (the only real logic change)

| Edit | Detail |
|---|---|
| **E1** — status type | `export type FieldExtractionStatus = 'EXTRACTED' \| 'MISSING' \| 'PARSE_FAILED' \| 'PARTIAL' \| 'UNKNOWN';` (`:18`) |
| **E2** — new collector method | `parseFailed(field: string, reason: string, options?: RecordOptions): void` on `FieldDiagnosticsCollector` (`:88-109`), recorded as `{ field, status: 'PARSE_FAILED', reason, …options }`. Mirrors `partial()` exactly, one line of implementation. |
| **E3** — `build()` filler | `extraction-diagnostics.ts:148-158`: unrecorded fields become `{ field, status: 'UNKNOWN', reason: 'not attempted — the parser stopped before this field' }` instead of `MISSING / 'not attempted'`. **This is the G2 fix.** |
| **E4** — `applyValidationResults` | `:188-215` — the "dropped by validation" branch keeps `status: 'PARTIAL'` and `validated: false`; unchanged. Add a one-line comment stating that `PARTIAL` here means *obtained-then-invalid*, distinct from `PARSE_FAILED`. |
| **E5** — counts | `summarizeFieldDiagnostics` (`:225-232`) returns `{ extracted, missing, parseFailed, partial, unknown }`. `FieldDiagnosticCounts` (`:219-223`) gains `parseFailed` and `unknown`. |
| **E6** — log prefix | `:245-257` — `formatExtractionDiagnosticsLog` returns `[PPHunt][Amazon][Diagnostics] ${JSON.stringify(payload)}`; payload gains the two new count keys. The function signature and its callers stay untouched. |
| **E7** — field list | `:55-77` — add `'url'` after `'asin'`. |
| **E8** — doc comments | Refresh the module header to state the five statuses and the R3 mapping table (§4.2) so the contract lives with the code. |

**Deliberately not changed:** `FieldExtractionSource` (`dom | json-ld | legacy |
derived | url`) — it already covers the issue's "DOM selector, embedded JSON"
cases; there is no API-response source in this engine (enrichment fetches HTML,
not an API — `background/enrichment-fetch.ts`), so adding one would be fiction.

### 5.2 `src/engines/amazon/scraper/product-detail.ts`

| Edit | Detail |
|---|---|
| **E9** — reclassify 19 sites | Every `partial(` → `parseFailed(`: `853, 894, 1002, 1031, 1060, 1086, 1110, 1146, 1186, 1218, 1246, 1274, 1299, 1327, 1365, 1408` (main) and `260, 359, 463` (helpers). **The `reason` strings do not change** — only the status they are filed under. |
| **E10** — add `url` | At `product-detail.ts:1440`, after `const url = resolveProductUrl(null, asin, activeUrl);` add `diag?.extracted('url', { source: 'url' });`. One line. |
| **E11** — `source` on absent fields (G6) | Add `{ source: 'dom' }` to the 22 `missing()` calls that search the DOM, so every entry carries its extraction source per R2. `asin` (`:224`) keeps `source: 'url'`-flavoured wording in its reason. **Optional** — flag to the owner; it is additive and touches no logic. |

**The `rescued()` sites (7) are untouched** — they already are "obtained but
incomplete" and now mean exactly that, because `PARTIAL` no longer shares a
status with `PARSE_FAILED`.

**No change to:** any selector, any cleaning/parsing call, any field
assignment, the `candidate` object, the `normalized` result, the early
`return null` paths, or `applyValidationResults` placement. The diff is
bookkeeping only — the same discipline the shipped step-1 commit used, and
pinned by the existing parity test.

### 5.3 `src/engines/amazon/schemas/messages.ts`

| Edit | Detail |
|---|---|
| **E12** | `FieldDiagnosticSchema.status` (`:208`): `z.enum(['EXTRACTED','MISSING','PARSE_FAILED','PARTIAL','UNKNOWN'])`. **Widening, not narrowing** — a payload carrying the old three statuses still validates, so an older content script talking to a newer worker is unaffected (the same "optional, so older senders still validate" pattern the field already documents at `:201-206`). |

### 5.4 `src/engines/amazon/scraper/drift-telemetry.ts`

| Edit | Detail |
|---|---|
| **E13** | `logDriftReport` (`:169`): prefix `[PPHunt] drift report ` → `[PPHunt][Amazon][Diagnostics] drift `. Behaviour, counters and the "silent at zero cards" rule are unchanged. |

### 5.5 Log sites — **no signature changes**

`background/enrich-saved-product.ts:374-388` and `background/save-job.ts:236-250`
already call `formatExtractionDiagnosticsLog(report, { jobId, asin, stage })`.
The prefix and the count keys change inside the formatter; the call sites are
untouched. Both remain best-effort (`try { … } catch { }`) so a logging
failure can never fail an enrichment or a save.

### 5.6 Files that must **not** change

`src/engines/temu/**` · `src/lib/**` (the legacy mirror — `src/lib/scraper/product-detail.ts`
has no diagnostics and is not the live engine) · `src/engines/amazon/scraper/selectors.ts` ·
`field-parsers.ts` · `types/product.ts` · the DB layer · the export layer ·
the UI layer · `wxt.config.ts` · the manifest.

---

## 6. Test plan

### 6.1 `tests/extraction-diagnostics.test.ts` — extend (14 tests today)

| Test | Action |
|---|---|
| `reports a present-but-unparseable price as PARTIAL` (`:220`) | → rename to `…as PARSE_FAILED`; assert `status: 'PARSE_FAILED'` |
| `reports a rank label without a parseable rank as PARTIAL` (`:275`) | → `PARSE_FAILED` |
| `reports unparseable weight rows as PARTIAL and singleton twister data as MISSING` (`:284`) | weight row → `PARSE_FAILED`; singleton twister → `MISSING` (unchanged) |
| `counts a JSON-LD rescue over a rejected DOM candidate as PARTIAL` (`:248`) | **unchanged** — this is now the only thing `PARTIAL` means for a rescue |
| `reports a value dropped by validation as PARTIAL with validated:false` (`:262`) | **unchanged** |
| `still builds a full report when the parser rejects the page (no title)` (`:298`) | assert the 22 unreached fields are `UNKNOWN` (was `MISSING / 'not attempted'`) and carry the new reason |
| `fills unrecorded fields and lets the final write win` (`:331`) | `build()` filler now `UNKNOWN` |
| `classifies every modelled field on a complete PDP` (`:154`) | add `url` → `EXTRACTED / source: 'url'`; assert the total is 24 |
| **new** — `separates "source present but unparseable" from "obtained but incomplete"` | one fixture where the DOM price is garbage and JSON-LD supplies a price: DOM-only read ⇒ `PARSE_FAILED`; with the JSON-LD rescue ⇒ `PARTIAL`; assert the two statuses are different |
| **new** — `never claims absence for a field the parser did not reach` | title-less page ⇒ every unreached field is `UNKNOWN`, and **no** field carries status `MISSING` with reason `'not attempted'` |
| **new** — `counts every status exactly once` | 24 fields ⇒ `extracted + missing + parseFailed + partial + unknown === 24` |
| **new** — `uses the issue's log prefix` | `expect(line.startsWith('[PPHunt][Amazon][Diagnostics] {')).toBe(true)` and the payload has `counts.parseFailed` / `counts.unknown` |
| **new** — `parity: the product is identical with and without the collector` | re-run of the existing parity assertion across the new statuses (extend the existing test at `:312`, do not duplicate it) |

### 6.2 Update the 4 fixture files that hard-code the old statuses

| File | Lines | Change |
|---|---|---|
| `tests/extraction-diagnostics.test.ts` | `:385` | prefix assertion |
| `tests/offscreen-handlers.test.ts` | `:114, 116, 127` | fixture statuses stay valid (widened enum) — add one `PARSE_FAILED` case to prove transport carries it |
| `tests/save-product.test.ts` | `:176, 179, 180` | add a `PARSE_FAILED` case through the content-script path |
| `tests/save-job-pipeline.test.ts` | `:358, 361, 367`, `:380` | fixture gains a `PARSE_FAILED` field; prefix assertion updated |
| `tests/enrich-saved-product.test.ts` | `:638, 641, 647`, `:656` | same |
| `tests/amazon-engine-v2.test.tsx` | `:334, 407` | drift prefix assertion updated to `[PPHunt][Amazon][Diagnostics] drift ` |

### 6.3 Gates

```
npx tsc --noEmit          # must be clean
npx vitest run            # 87 files / 1029 tests today → 87+ files, ≥1036 tests
npm run build             # wxt build → dist/chrome-mv3 (also un-breaks manifest-permissions.test.ts)
npm run check:dead-exports
```

Plus the invariant diffs:

```
git diff --stat -- src/engines/temu/            # must be empty
git diff --stat -- wxt.config.ts                # must be empty
git diff --stat -- src/engines/amazon/schemas/product.ts src/engines/amazon/types/   # must be empty
```

---

## 7. Live verification session (D4)

**Goal (R6):** prove the diagnostic output reflects the engine's *actual*
extraction results against real Amazon pages, and that the new taxonomy
separates the causes the owner actually sees.

**Method — already proven end-to-end in this sandbox** (a spike of this exact
procedure produced the live line quoted in §1.3):

1. `npm run build` → `dist/chrome-mv3`.
2. Launch Chromium with the extension loaded:
   `chromium.launchPersistentContext(tmpProfile, { headless: false, args: ['--disable-extensions-except=<ext>', '--load-extension=<ext>', '--no-sandbox', '--disable-gpu'] })`
   — **headed** is required *in this sandbox*: under headless the extension's
   MV3 service worker never registered (the page's own service worker did),
   whereas in headed mode it registered immediately as
   `chrome-extension://…/background.js`. Run under
   `xvfb-run -a --server-args="-screen 0 1600x1000x24"` (Xvfb is present in
   the sandbox).
3. Attach a console listener to the extension's service worker via
   `ctx.serviceWorkers()[0]` — verified to resolve to
   `chrome-extension://…/background.js`.
4. Navigate to a real PDP. Amazon serves a **soft bot wall** to a fresh
   profile (a ~3.7 KB `/errors_page/validateCaptcha` page). Clicking
   *Continue shopping* once clears it and the real PDP then loads (verified:
   1.46 MB, `#productTitle` / `.a-price-whole` / `#acrPopover` / `#feature-bullets`
   all present). This is the same wall the SAD-352 measurement hit (2 of 42
   fetches).
5. Trigger a save **through the extension's own DOM bridge** — no native
   context-menu clicking required:
   `window.dispatchEvent(new CustomEvent('pphunt:command', { detail: { type: 'SAVE_CONTEXT_PRODUCT', payload: { requestedAt: String(Date.now()), fromSubframe: false } } }))`
   → `amazon.content.ts:581-586` → `handleSaveContextProduct` (`:171`) →
   `resolveSaveCandidate` → PDP branch → diagnostics collected → `SAVE_PRODUCT`
   → worker logs it. **Verified working.**
6. Capture the `[PPHunt][Amazon][Diagnostics]` line and the
   `[PPHunt] save job` line, and assert they share the same `jobId`.

**Harness location:** `scripts/sad-359-diagnostics-measurement.mjs` — a
**spike tool**, exactly like the existing `scripts/enrichment-spike.ts`:
nothing in `src/` imports it, it is not bundled, it never runs in CI, and
`package.json` gains a `measure:diagnostics` script. It resolves Playwright
through `createRequire` (the sandbox exposes it at
`/opt/playwright/node_modules`, `NODE_PATH=/opt/playwright/node_modules`);
if Playwright is absent it prints a clear message and exits non-zero rather
than failing obscurely.

**Sample:** ≥5 real PDPs across categories (the AirPods Pro 2 already
measured is one), plus ≥2 **deliberately degraded** cases:

| Case | Purpose |
|---|---|
| A normal PDP | the `EXTRACTED` baseline |
| A PDP with a buybox but no price text | must show `price: PARSE_FAILED`, not `MISSING` — the G1 proof |
| A PDP with no JSON-LD and an empty title node | `title: PARSE_FAILED`; every later field `UNKNOWN` — the G2 proof |
| A PDP with a non-HTTP image | `imageUrl: PARSE_FAILED` + `validated:false` — the validation-drop case |
| A listing page | the drift line under the new prefix |

**Output:** `docs/plans/SAD-359-live-measurement-2026-10-20.md` — the table of
every field, its status, its source and its reason, per ASIN, with the
before/after counts side by side.

**Acceptance:** the report's per-field statuses must agree with the product
the extension actually stored. Cross-check: every field the report says
`EXTRACTED` must be non-empty in the saved row, and every field the report
says `MISSING`/`PARSE_FAILED` must be empty or non-conforming in it. A
disagreement is a **bug in the diagnostics**, not a licence to change
extraction.

---

## 8. Documentation

| File | Change |
|---|---|
| `docs/plans/SAD-359-extraction-diagnostics-plan.md` | Add a "Gap closure" section pointing at this document; keep the original plan and implementation record intact |
| `docs/plans/SAD-359-diagnostics-gap-closure-plan.md` | This document |
| `docs/plans/SAD-359-live-measurement-2026-10-20.md` | The live session (new) |
| `CHANGELOG.md` | New `## [Unreleased] — Per-field extraction diagnostics (SAD-359)` entry: the five statuses, the `url` field, the prefix, the counts. Keep the existing SAD-357 / SAD-351 / SAD-349 entries untouched |
| `ARCHITECTURE.md` | One row/paragraph in the diagnostics section describing the five statuses and the two log sinks |

The repo has an executable docs guard (`tests/docs-consistency.test.ts`) —
new claims must be statements the code can check.

---

## 9. Commit plan (repo convention: one step per commit, plan doc first)

| # | Commit | Contents |
|---|---|---|
| 0 | `SAD-359 gap closure: plan for the remaining diagnostic clauses` | this document + a Linear progress comment |
| 1 | `SAD-359 gap closure: five-status taxonomy + unknown-for-unattempted` | E1–E8 + `messages.ts` E12 + the §6.1 test changes |
| 2 | `SAD-359 gap closure: reclassify candidate-rejected fields as PARSE_FAILED` | E9 (19 sites) + E10 (`url`) + E11 (optional `source`) + §6.2 fixture updates |
| 3 | `SAD-359 gap closure: align the log prefix and the count buckets` | E6, E13 + the prefix assertions in `amazon-engine-v2.test.tsx`, `save-job-pipeline.test.ts`, `enrich-saved-product.test.ts` |
| 4 | `SAD-359 gap closure: live measurement session + verification report` | the harness, the live report, the CHANGELOG/ARCHITECTURE updates, the full-gate output |

Each commit is independently green (`tsc` + `vitest`).

---

## 10. Invariants & risk register

| Risk | Mitigation |
|---|---|
| A status change alters the extracted product | Impossible by construction — the collector is an out-param; the existing parity test (`:312`) is extended, not replaced. Every `diag?.` call only records |
| Widening the wire enum breaks an older worker | A *widening* cannot invalidate a payload that validated before. The optionality of `extractionDiagnostics` is unchanged |
| `build()`'s `UNKNOWN` filler hides real absences | The filler only applies to fields the parser **never reached**. Reached-but-absent fields still record `MISSING` at their call site. A test asserts no field carries `MISSING / 'not attempted'` |
| The 19 reclassified sites could change a count the owner relies on | Counts are diagnostic-only; no stored data depends on them. The live report shows the before/after so the change is auditable |
| Log-line size growth | The envelope gains two count keys; the field array is unchanged in length (23 → 24). Still one line, still no values, no HTML, no prices |
| Temu drift | Temu is not touched; `tests/temu-isolation.test.ts` plus an empty `git diff -- src/engines/temu/` gate |
| Live session blocked by Amazon's bot wall | The soft wall is passable (verified). If a hard wall appears, the session falls back to the owner running the same run-book in their own Chrome — the workflow the SAD-352 measurement used — and the harness still ships |
| Dead exports | `npm run check:dead-exports` — new exports (`parseFailed` is a *method*, not an export) are consumed inside the module and in tests |

---

## 11. Limitations (to be reported, per R6)

1. **The engine cannot distinguish "legitimately absent" from "selector rot"**
   for a `MISSING` field. It searched the documented selectors and found
   nothing; whether the page lacked the data or a selector went stale is
   exactly the question the diagnostics are meant to help answer — they
   narrow it (the winning selector on every candidate-found entry, the
   reason on every absent entry) but cannot close it without a second
   independent source.
2. **Buybox pricing is not instrumented internally.** Price, discount and
   the other buybox-family fields come from the shared card extractor
   `extractCardPricingAndDiscounts`, which is used by the card path too and
   is out of scope to touch. The buybox *scope* selector and the `priceTier`
   are recorded; what happened inside the shared extractor is not.
3. **The log sink is the service-worker console.** The issue's expected
   outcome says "open Chrome DevTools"; for a PDP save the relevant context
   is the extension's *Service worker* target, not the page. The content-side
   aggregate (drift) line lands in the page console. Both are documented in
   the CHANGELOG.
4. **The enrichment (offscreen) parse is logged by the worker only** — the
   offscreen document's own console is a separate DevTools target.
5. **Live coverage is a sample**, not a census: Amazon serves different PDP
   variants per geo/session, so the same ASIN can parse differently for the
   owner than for the sandbox (SAD-352 §"Sandbox re-parse" recorded exactly
   this for 4 ASINs).
6. **`badge`, `coupon`, `dealBadge` and `pastMonthSales` are frequently
   absent by product nature.** That is real signal, not noise, and stays
   `MISSING` — but it means "8 missing" on a healthy PDP is not a fault.

---

## 12. Definition of done

- [ ] `tsc --noEmit` clean; `vitest run` green with the new/updated tests
- [ ] `npm run build` succeeds; `npm run check:dead-exports` passes
- [ ] `git diff -- src/engines/temu/` and `git diff -- wxt.config.ts` are empty
- [ ] The extracted product is byte-identical with and without the collector (parity test)
- [ ] A live Amazon session produced a `[PPHunt][Amazon][Diagnostics]` line whose per-field statuses match the stored product, and the report is committed
- [ ] CHANGELOG + ARCHITECTURE updated; the verification report lists files changed, tests executed and the §11 limitations
- [ ] Linear issue SAD-359 moved to *In Review* with a comment summarising the closure
