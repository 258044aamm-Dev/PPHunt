# SAD-392 — Verification report

Ticket: [SAD-392 "The availability and source fields"](https://linear.app/sad-mod/issue/SAD-392/the-availability-and-source-fields) ·
Branch: `fix/sad-392-availability-source` (from `main@2ec7eaf`) ·
Date: 2026-10-22 · Tooling: moli v1.1.18 (prebuilt x86_64-linux), vitest + fake-indexeddb, jsdom.

Plan: [`SAD-392-availability-source-plan.md`](./SAD-392-availability-source-plan.md) ·
Machine-readable capture record: [`sad-392-live-2026-10-22.json`](./sad-392-live-2026-10-22.json).

---

## 1. Automated gates (protocol §9.1)

| Gate | Baseline (`main@2ec7eaf`) | After the fix |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| `npm run check:dead-exports` | all exports consumed | all exports consumed (42 files) |
| `npx wxt build` | ✔ | ✔ (2.03 MB) |
| `npx vitest run` | **1415 passed / 127 files** (+1 skipped file) | **1444 passed / 128 files** (+1 skipped file) |
| `npm audit --omit=dev` | 0 vulnerabilities | 0 vulnerabilities |

Delta: **+29 tests, all new** (`tests/sad-392-availability-source.test.ts`, plan §4 cases 1–12 plus
helper/identity and hook-count pins) **+3 pre-existing manifest tests** that the `wxt build` gate
enables (`tests/manifest-permissions.test.ts` skips its built-manifest describe until `dist/`
exists — they ran and passed). **Zero baseline tests modified except one assertion:**
`tests/snapshot-store-migration.test.ts`'s `expect(upgraded.verno).toBe(2)` tracks the *latest*
schema and now expects `3`; the property it pins (a v1 database upgrades in place with every row
preserved) is asserted unchanged and green — its legacy product row has no `availability` key, so
the v3 pass leaves it untouched.

Full `npm run verify` (tsc + vitest + wxt build + audit): **green** — recorded in §6 below.

## 2. Fresh live capture (protocol §9.2) — 2026-10-22, after the fix

Commands (moli, same as plan §8):

```
moli fetch --disable-js --eval-file probe-verify-availability.js "https://www.amazon.com/dp/B087GMJXMC"
moli fetch --disable-js --dump html "https://www.amazon.com/dp/B087GMJXMC" > verify-B087GMJXMC.html
```

Results, measured:

| Observation | Value |
|---|---|
| HTTP status | 200 (both fetches; no interstitial, no CAPTCHA) |
| Capture size | 2,437,409 bytes |
| `#availability` elements (duplicate ids) | **2** (buybox + SNS accordion — still live) |
| Buybox span text | `In Stock` |
| `script[type="a-state"]` inside buybox div | **present** (leak mechanism still live on Amazon) |
| Raw div `textContent` head | `In Stock {"isInternal":false,"showInsightsHub":false,…` (script JSON serialized, as measured pre-fix) |
| Page title | `Energizer AA and AAA Batteries, 48 Count, Combo Pack Contains 24 Max Double A and 24 Max Triple A Batteries` |

The fresh capture through the **fixed** parsers (scratch vitest run over the real modules, deleted
after the run):

* **Unmutated fresh capture → `parsePdpHtml`** (the offscreen/enrichment chain):
  `ok: true`, **availability `"In Stock"`** (clean — the a-state JSON no longer leaks),
  **source `"detail"`**, title resolved, price parsed. *(The parser reported price `0.48` —
  today's page shows a per-count price in the winning buybox scope. Price extraction is untouched
  by this ticket and out of its scope; recorded for transparency.)*
* **Reported-shape mutation on the fresh capture → `parseAmazonProductDetail`**: every
  `#availability` element's inner HTML replaced with the reported fixture's (AOD loader script +
  bare message, no span — mutating only the first element would let the duplicate-id span rescue,
  the probe-B lesson). Result: parsed successfully, availability ===
  `This item cannot be shipped to your selected delivery location. Please choose a different delivery location.`
  (**108 characters**, exact ticket message), contains no `P.when`, **source `"detail"`**.

Pre-fix control for the same mutation (plan §1.1 B2, committed in the evidence JSON): 1011
characters starting `P.when("A", "load").execute("aod-assets-loaded", function(A){…`.

## 3. Migration verification (D2/D2b) — measured write minimality

`'updating'` hooks on `products` and `snapshots` during the v3 upgrade (fake-indexeddb,
`PPHuntDB` over a seeded v2 database — the SAD-275 migration-test convention):

| Scenario | Writes measured |
|---|---|
| v2 DB with 5 product rows (polluted, clean, `null`, key-absent, malformed `availability: 42`) + 1 polluted snapshot | **exactly 2** — the polluted product and the polluted snapshot |
| Same DB re-opened (already v3) | **0** — the upgrade does not re-run |
| v2 DB whose values are already clean, upgraded to v3 | **0** — the upgrade runs and writes nothing |

Values after upgrade: polluted → exact message (product and snapshot); clean/`null`/malformed rows
deep-equal to their seeds (ids, `collectedAt`, `sessionKey`, every field); key-absent row still has
no `availability` key. The upgrade never threw on the malformed row.

**Implementation finding (corrects plan §3.3):** Dexie 4.4.6 `Collection.modify` skips a row's write
only when the callback returns `false` — the shipped source gate is `modifyer(...) !== false`. The
plan's `return 0` idiom would have rewritten **every** row of both tables (measured: 5 hook fires
for 5 seeded rows before the correction; 2 after). The migration ships with `return false`.

## 4. Source-promotion verification (D1/D1b)

Pinned by tests 10a–f over the real functions (no mocks): `mergeScrapedProductFields` promotes
`search`→`detail` and `category`→`detail`, never downgrades, and fires **after** the SAD-357
variations upgrade (ordering pin: both the variations upgrade and the promotion land on the same
merge); `addProducts` promotes the stored row on a PDP re-collection; `upsertProductFromQuickSave`
re-save promotes and reports `source` in `updatedFields`; `mergeDetailIntoStored` (enrichment)
carries no `source` key in its patch (D1b) while its patch demonstrably works (title lands).

## 5. Owner browser QA checklist (protocol §9.3 — hand-off)

This environment cannot load an unpacked extension; the following is the owner's pass with the
built branch (`npx wxt build` → load `dist/chrome-mv3`, diagnostics toggle ON):

- [ ] a. Open the side panel once on an existing profile → the v3 upgrade runs; a previously
      polluted Availability cell shows the readable message (capture before/after screenshots for
      this report).
- [ ] b. Collect on a region-restricted PDP (the ticket's kind) → Availability readable,
      Source `detail`.
- [ ] c. Collect a search page → open one collected product's PDP → Collect More → that row's
      Source promotes to `detail`, siblings stay `search`.
- [ ] d. Right-click save on a PDP, then re-save the same ASIN from a search card → Source stays
      `detail` (no downgrade).
- [ ] e. Listing save with PDP enrichment enabled → Source stays `search` (D1b), availability
      clean.
- [ ] f. CSV + Excel + clipboard export and table search for `shipped` / `In Stock` → cleaned
      values only.
- [ ] g. Service-worker console diagnostics for availability → `EXTRACTED`, `source: dom`
      (reported shape: selector `#availability`).

## 6. Gate transcript (final phase, this branch)

* `npx tsc --noEmit` — clean.
* `npm run check:dead-exports` — "all src/lib exports have consumers (42 files scanned)".
* `npx wxt build` — ✔ finished, Σ 2.03 MB.
* `npx vitest run` — **1444 passed / 128 files (+1 skipped file), 0 failed** (164.34 s run;
  the 3 `manifest-permissions` built-manifest tests are enabled by the preceding build).
* `npm audit --omit=dev` — "found 0 vulnerabilities".
* `npm run verify` — the four of the above in one chain: **green** (run recorded at phase 6
  commit time; identical component results).

## 7. Deviations from the plan (all measured, none assumed)

1. **§3.3 snippet `return 0` → shipped `return false`** — Dexie 4.4.6 write-skipping semantics
   (see §3 above); the plan's intent ("leave the row untouched") is preserved exactly.
2. **`tests/snapshot-store-migration.test.ts` verno assertion 2 → 3** — the plan's "must stay
   green untouched" list did not include this file, and the assertion tracks the latest schema by
   design; its actual property is re-asserted unchanged (see §1).
3. **Message length is 108 characters** (plan pinned `< 200`; an early progress comment said 103
   from memory — corrected on the ticket). The exact-equality assertions never depended on it.

## 8. Ticket hygiene (protocol §9.4)

* Linear progress comment after every phase (5 commits: `a43801f`, `9f0cd1f`, `3c016e0`,
  `772ae2f`, `82ca30a` + this phase's docs commit), each pushed to GitHub before its comment.
* SAD-390 evidence hand-off comment posted: `docs/plans/SAD-392-fixtures/search-card-delivery-recipe.real.html`
  + probe-E measurements (49/64 cards' delivery polluted with the `.prime-brand-color` CSS +
  Prime-signup ingress JS blob) — delivery/seller extraction deliberately untouched here (D5).
* SAD-392 state → **In Review**.
