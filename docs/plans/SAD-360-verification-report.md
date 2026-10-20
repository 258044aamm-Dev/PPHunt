# SAD-360 — Implementation & verification report (Temu engine diagnostics)

**Status: complete and merged.** Steps 0–5 were built on `feat/temu-engine` and merged into `main` at `e1729fa` (merge commit, reviewed on the merged tree: 101 files / 1193 tests green).

| Step | Commit | Content |
|---|---|---|
| 0 | `d410326` | Baseline + owner amendments A1–A3 |
| 1 | `b826132` | Diagnostics collector module + 38 unit tests |
| 2 | `f88ce8f` | PDP instrumentation (22 fields) + 22 tests |
| 3 | `b95f8a4` | Card/helper instrumentation (20 fields) + 12 tests |
| 4 | `f6358a4` | Transport, eligibility, service-worker logging + 14 tests |
| 5 | `195461c` | Consolidated verification report (this file) |
| — | `c026756` | Live measurement harness + 15 tests (added after step 5) |

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
| Full suite | **93 files / 1147 tests passed** (re-measured 2026-10-20 at `c026756`; baseline at step 0, `d410326`, was **88 files / 1046 tests**) |
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
| R6 tests + report | 93 files / 1147 tests; this document |

## Live measurement (harness shipped, run pending)

`scripts/temu-diagnostics-measurement.mjs` (`npm run measure:diagnostics:temu`)
drives the built extension against real Temu pages and checks every report
against the rows the extension actually stored in `PPHuntTemuDB`.

```bash
npm run build
xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npm run measure:diagnostics:temu -- --pdps 601099769178067
npm run measure:diagnostics:temu -- \
  --listing "https://www.temu.com/search_result.html?search_key=earbuds"
```

It starts a **manual** collection by sending the same `TEMU_COLLECT_PRODUCTS`
message the background sends, so no product is saved by a path a user cannot
take. It reports a verification challenge instead of defeating it. A mismatch
between a report and the stored row exits non-zero.

The harness's comparison logic (the part that judges a live run) is covered by
15 unit tests in `tests/temu-diagnostics-measurement.test.ts`; the browser parts
cannot run in CI.

## Deviations from the step guide (required by SAD-367)

The per-step sub-issues (SAD-361 … SAD-367) were written from the pre-amendment
guide. Where the locked decisions on SAD-360 conflict with it, the locked
decisions won. Each deviation, with its reason:

| # | Guide / sub-issue text | What was shipped | Why |
|---|---|---|---|
| 1 | Branch `feat/sad-360-temu-extraction-diagnostics` | `feat/temu-engine` | The owner directed all SAD-360 work onto the long-lived Temu branch. |
| 2 | 24 PDP fields / 18 card fields (SAD-362, SAD-364, SAD-365) | **22 PDP / 20 card** | Locked D2: only fields modelled in `TemuScrapedProduct` are diagnostically reported. The pre-amendment count included `goodsId` and `source`, which D5 excludes from the field list, so card reports are PDP minus `description`/`features`. |
| 3 | Logs land in the **Temu tab's** DevTools console (SAD-366, SAD-367) | Logs land in the **service-worker** console | Locked D3: mirror the Amazon SAD-359 sink, one DevTools target for every line, nothing added to the page console. The content script only attaches reports to the message. |
| 4 | Docs named `SAD-360-temu-diagnostic-logging-plan.md` / `-implementation-guide.md` | `SAD-360-temu-diagnostics-review-and-plan.md`, `SAD-360-steps-2-3-parser-instrumentation-plan.md`, this report | The plan document was renamed when it was amended to D1–D8; the step records continue in a second file rather than a separate guide. |
| 5 | Nothing beyond step 5 | `scripts/temu-diagnostics-measurement.mjs` + `tests/temu-diagnostics-measurement.test.ts` (`c026756`) | Known limitation 1 (no live evidence) had no tool to close it. The harness is a spike tool: not bundled, not in CI. |
| 6 | Isolation check "`git diff --stat <baseline> -- src/engines/temu/schemas` prints nothing" (SAD-367) | `src/engines/temu/schemas/messages.ts`, **+28 lines**: an optional `productDiagnostics` array (max 200) on `TEMU_PRODUCTS_COLLECTED` | Requirement 5 explicitly permits "one additive optional message field". It is optional, so a message from an older content script still validates and persists unchanged — both cases are tested in `tests/temu-diagnostics-transport.test.ts`. |

Steps 0–5 themselves were executed as written — one commit per step, each pushed
and reported on SAD-360 before the next began.

## Known limitations

1. **Live verification not yet executed.** The harness above exists and is
   tested, but it has not been run against live Temu from this environment
   (no browser with the built extension, and Temu challenges datacenter IPs).
   Until it is, every fixture-level claim is jsdom-only evidence modelled on
   the selectors in `selectors.ts`.
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
