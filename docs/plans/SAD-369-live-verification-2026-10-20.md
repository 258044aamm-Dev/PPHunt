# SAD-369 — Live verification report

**Date:** 2026-10-20  
**Build:** Chrome MV3 extension from step-3 source (`npm run build`)  
**Runner:** `scripts/sad-359-diagnostics-measurement.mjs`, extended for SAD-369, run in headed Chromium under `xvfb-run` with the built extension loaded. Playwright captured page and service-worker consoles separately.  
**Environment:** sandbox Chromium, normal Amazon pages loaded. This is a browser run of the real extension; it is not the owner's interactive Chrome profile.

## Results

| Check | Result | Evidence |
|---|---|---|
| L1 — switch off; save; no diagnostics line in either console | **Pass** | `sad-369-live-off-2026-10-20.json`: 0 worker lines, 0 page lines, stored product row present. |
| L2 — right-click save on product page | **Pass** | `sad-369-live-on-2026-10-20.json`: exactly 1 `detail-page` line, 24 field entries and counts summing to 24; report agrees with the stored product (0 mismatches). |
| L3 — right-click save on listing card | **Pass** | Same report: exactly 1 `card` line and 1 `enrichment-parse` line; runner verified the shared jobId. |
| L4 — card icon save | **Pass** | Same report: real, unforced click on a visible card-icon host; host was in the viewport; exactly 1 `card` line. |
| L5 — manual collection, at most 50 products | **Pass** | Search listing, target 20: 19 products stored and 19 `collection-card` lines, all one-line JSON with 24 fields and five counts summing to 24. |
| L6 — collection of more than 50 products | **Not exercised live** | Requested target 60 on an Amazon Best Sellers page and sent 15 normal wheel scrolls; that page run stored only 30 distinct products and emitted 30 collection lines. The live page did not supply >50 collected products, so this run does **not** prove the live cap. The automated 60-card test does prove exactly 50 reports and excludes the 51st. |
| L7 — drift line in service-worker console, not page console | **Pass** | Listing drift line captured from the service worker; runner found no drift line in the page console. Prefix and JSON shape retained. |
| L8 — flip setting both directions without reload | **Pass** | One save printed 1 line with the setting on, 0 after switching off, and 1 after switching on again, all on the same open page. |

## Additional checks

- Product-detail and collection-card diagnostics were parsed as JSON. Their reports had 24 field rows; the five status counts summed to 24.
- The live runner rejected value-bearing report properties and checked that the captured lines did not contain the stored title or URL. Collection-line JSON and privacy checks passed on both search and category pages. (A raw numeric-price substring check was intentionally not used: a price such as `1` can coincide with a count in otherwise value-free JSON. The structural checks reject a product/price property and any per-field `value`/`extractedValue` property.)
- Product-page report statuses were compared field-by-field with the actual IndexedDB row: **zero mismatches**.
- Step-3 automated tests cover the 50-item cap with 60 card reports; duplicates/re-parses do not consume cap slots; a second run resets state; an `updatedExisting` resend does not log a report twice; saves are independent of the cap; and drift routing is gated and worker-side.
- Full final automated gates: `npx tsc --noEmit` clean; `npx vitest run` **96 files / 1092 tests passed**; `npm run build` succeeded (1.98 MB; existing large-chunk advisory); `npm run check:dead-exports` passed (42 files); diffs from step-0 baseline `804da50` for `src/engines/temu/` and `wxt.config.ts` were empty.

## Limitations / not claimed

1. **L6 remains unverified in a live >50-product browser run.** The attempted search and category pages returned fewer than 50 distinct products, even after ordinary scrolling. The 60-card automated test passes, but it does not replace the owner-browser acceptance check on a collection that actually exceeds 50.
2. The side-panel product table was not visually compared against a separate baseline build in this sandbox. Product-parity tests and the live product-detail-to-IndexedDB comparison passed; no extraction, storage, sorting, or UI behavior change was observed or intended.
3. Automatic collection mode was not separately driven live; the automated parity suite covers the shared collection reporting path, while this browser run exercised manual collection.
4. The live run used a fresh sandbox browser profile, not the owner's normal Chrome profile. Results are bounded to the pages and products Amazon served during these runs.

Raw machine-readable evidence: `sad-369-live-off-2026-10-20.json`, `sad-369-live-on-2026-10-20.json`, and `sad-369-live-l6-2026-10-20.json` in this directory. The L6 JSON records `not-exercised-target-unreached` and the limitation; it is not reported as a pass.
