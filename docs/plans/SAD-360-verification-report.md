# SAD-360 — Implementation & verification report (Temu engine diagnostics)

**Status: complete.** Steps 0–5 done on branch `feat/temu-engine`.

| Step | Commit | Content |
|---|---|---|
| 0 | `d410326` | Baseline + owner amendments A1–A3 |
| 1 | `b826132` | Diagnostics collector module + 38 unit tests |
| 2 | `f88ce8f` | PDP instrumentation (22 fields) + 22 tests |
| 3 | `b95f8a4` | Card/helper instrumentation (20 fields) + 12 tests |
| 4 | `f6358a4` | Transport, eligibility, service-worker logging + 14 tests |
| 5 | this file | Consolidated verification report |

## What a user can now do

Open the extension's **service-worker** console, filter on
`[PPHunt][Temu][Diagnostics]`, and read one line per product describing exactly
which supported fields were extracted, missing, partially extracted, unparseable
or never attempted — with the `goodsId`, the `sessionId`, the stage, and counts
that partition the field set.

```json
{"goodsId":"601099769178067","sessionId":"550e…","stage":"product_detail",
 "counts":{"extracted":18,"missing":3,"parseFailed":1,"partial":0,"unknown":0},
 "fields":[{"field":"price","status":"EXTRACTED","source":"dom","selector":"[data-type=\"price\"]"},
           {"field":"rating","status":"MISSING","source":"dom","reason":"no rating element"},
           {"field":"listPrice","status":"PARTIAL","source":"dom","validated":false,
            "reason":"parsed but failed validation"}]}
```

## Verification (measured, not asserted)

| Gate | Result |
|---|---|
| `npm run verify` (`tsc` + full vitest + `wxt build` + production audit) | **pass**, 0 vulnerabilities |
| Full suite | **92 files / 1132 tests passed** (baseline before SAD-360 was 89 / 1046 at step 0) |
| Focused Temu suites | 38 + 22 + 12 + 14 + 9 + 8 + 6 — all green |
| `npm run check:dead-exports` | pass (42 files) |
| **Amazon diff** (`src/engines/amazon/**`, `amazon.content.ts`) | **empty** |
| Selectors / manifest / lockfile | unchanged |
| Docs consistency suite | pass |

## Non-regression evidence

Every fixture was replayed against a detached worktree at `b826132`
(pre-instrumentation) and through the instrumented parsers **with and without**
a collector:

* PDP — 14 fixtures → **byte-identical JSON** (both comparisons)
* Cards — 7 scenarios → **byte-identical JSON** (both comparisons)
* Background — persisted rows identical with and without diagnostics (test)

## Requirements coverage

| Req | Where |
|---|---|
| R1 field-level status for every supported field, per stage | 22 PDP / 20 card fields; `DETAIL_DIAGNOSTIC_FIELDS` / `CARD_DIAGNOSTIC_FIELDS` |
| R2 goodsId, sessionId, field, status, reason, source + selector, validated | `FieldDiagnostic` + background formatter context |
| R3 failure causes distinguishable | precedence table in `ARCHITECTURE.md`; tests F3, F5–F7, F9–F11, C3 |
| R4 readable, filterable, grouped, counts partition, no values | one-line JSON, exact prefix, F16 + card log-hygiene tests |
| R5 no behaviour change, Amazon untouched | parity replays, empty Amazon diff |
| R6 tests + report | 92 files / 1132 tests; this document |

## Known limitations

1. **Not verified against live Temu pages.** All evidence is jsdom fixtures
   modelled on the selectors in `selectors.ts`. A live measurement pass (like
   `scripts/sad-359-diagnostics-measurement.mjs` for Amazon) has not been run.
2. Console output and the ledger write are not atomic: a crash between them can
   lose one line.
3. `browser.storage.session` is cleared on a full browser restart; keys are
   per-session, so a new session is unaffected, but a resumed *old* session id
   would re-log once.
4. The ledger keeps 20 000 keys (oldest evicted first); beyond that, a very old
   key could be re-logged.
5. Log volume on a large card collection is inherent to D1 + D4: one line per
   card. Each line is bounded by 20 fields.
6. `TEMU_PRODUCTS_COLLECTED` now carries up to 200 reports per message; a very
   large single batch is truncated by the content script at that bound (the
   remaining products simply have no diagnostics for that pass).
