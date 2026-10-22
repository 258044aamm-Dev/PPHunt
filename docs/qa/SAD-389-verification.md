# SAD-389 — implementation and verification

**Issue:** [Monthly Sales and Coupon](https://linear.app/sad-mod/issue/SAD-389/the-monthly-sales-and-coupon)  
**Branch:** `fix/sad-389-monthly-sales-coupon`  
**Verified application commit:** `abc969d54648a7ad2611166bb6b13f3336521711`  
**Base:** `2ec7eaf024687c499a1bc2fcc077bd411509040e`  
**Verification date:** 21 October 2026 (capture timestamps below are UTC).

## Outcome

The reproduced Amazon defects are fixed. Sales/coupon text is now read from eligible product-owned nodes; coupon CSS/navigation is removed; missing targets can recover on previously frozen cards; manual collection notices relevant text and visibility changes.

The fix does **not** invent sales or a coupon where Amazon supplies no eligible signal. `New on Amazon in past month` is not numeric monthly sales. The field remains Amazon's displayed string, not an inferred exact sales count. Coupon amounts do not reduce the stored selling price.

No merge to `main` is part of this work. The changes are ready for PR review, subject to the boundaries below.

## What changed

| Area | Change |
|---|---|
| Shared field readers | Semantic selectors followed by bounded, ownership-aware text reading. Split-child and paragraph sales signals work. Script/style/template, explicitly hidden branches, excluded recommendation/review/title/description regions and different-ASIN subtrees are rejected. |
| Coupon cleaning | Read meaningful offer text without mutating the DOM. Remove CSS and “Shop items / Terms” navigation; continue past rejected/excluded first candidates. Amount-only offer text is accepted only in a recognized coupon container. |
| Coupon vs discount | A semantic coupon's percentage is not treated as a product discount merely because the label omits the word “coupon.” Existing selling/list-price and deal policies are otherwise unchanged. |
| PDP ownership | Shared readers replace duplicate coupon logic and the unrestricted whole-body sales fallback. Descendant exclusions apply as well as ancestor exclusions. |
| Cache | On paths that previously returned a frozen card, fill only missing `pastMonthSales` / `coupon`; do not mutate a previously returned object. Existing rating/deal full-parser triggers remain intact. No TTL, polling timer or cache-owned observer. |
| Manual observer | Add relevant character-data and class/hidden/style notifications; ignore unrelated hover/color/shipping/header churn. Preserve 300 ms debounce, 2,000 ms max wait and stop/disconnect behavior. |
| Diagnostics | Reuse `EXTRACTED`, `MISSING`, `PARSE_FAILED` and validation reconciliation. No new stored metadata, status enum, report cap or first-report-only policy. |
| Performance | Avoid broad sales scans when there is no evidence, while retaining rejected explicit-marker diagnostics. Query coupon candidates once without changing selector priority. |

Only nine production files changed, all in the Amazon scraper/content path; see [the file list and machine-readable checks](sad-389/verification.json). Temu, shared UI, database/schema/version, manifests/permissions, dependency files, export formats and enrichment policies are unchanged. No retroactive data rewrite or automatic refetch was added.

## Final verification

| Check | Result |
|---|---|
| TypeScript | Passed, Node 22.23.3 |
| Full Vitest run | **1,487 passed**, 132 test files passed; one existing empty Temu live-capture file skipped (133 files total) |
| Snapshots | **7 matched**, none updated |
| New SAD-389 coverage | **69 tests** across five files |
| Dead-export guard | Passed, 42 files |
| Production WXT build | Passed |
| Manifest sanity | Passed |
| Production dependency audit | **0 vulnerabilities** |
| Full dependency audit | Existing informational development-dependency result: 16 (3 moderate, 8 high, 5 critical). No dependency upgrades/fixes applied. |
| Protected-scope / whitespace diff | Passed |
| Final native Moli | **27 checks on PDP + 28 on search**, all passed |
| Final built Chromium extension | **14 checks**, all passed; no recorded console errors |

The full suite also exercises existing rating/deal hydration, field settings, diagnostics budgets, save/collection policies, UI/export behavior and Temu isolation. It is regression evidence, not a claim that every possible Amazon layout or user configuration has been observed.

### Performance

The existing 480-card cold limit remains **4,000 ms**, and warm work must stay below one quarter of cold work. No threshold was relaxed.

A new 480-hidden-coupon stress case in the successful full run measured:

- Cold: **3,363 ms**
- Warm: **252 ms** (~7.5% of cold)
- Reveal/recovery: **471 ms**
- Additional full-card pricing parses during warm/recovery passes: **0**

An earlier full run failed the existing cold gate at 4,086 ms. The selector-scan optimization above was applied, then the entire suite passed. The final native browser runs were repeated on the optimized application commit.

## Native Moli evidence

Moli **1.1.18** executed the production parser/cache imports in its native DOM, not JSDOM. The live site was public, logged out and English Amazon.com.

### Coupon PDP — 17:35:43 UTC

URL: `https://www.amazon.com/dp/B0HCZ5ZF7J?language=en_US`

The baseline and fixed parser ran sequentially on the same visit. The observed target DOM was unchanged between passes (`targetDOMStable: true`; other page DOM may still hydrate).

- Baseline coupon included `Shop items`, `.cxcwEmphasisLink { padding-left: … }`, `Terms`, and `[data-selector="cxcwPopoverLink"]` CSS.
- Fixed coupon: **`Apply 50% coupon`**.
- Selling price stayed **$59.99**; no discount percentage was invented.
- Monthly sales stayed absent on this new-on-Amazon product.

[Recorded comparison, source label HTML and 27 checks](sad-389/moli-pdp.json).

### Search — 17:36:04 UTC

URL: `https://www.amazon.com/s?k=wireless+earbuds&language=en_US`

This visit produced **26 parsed products, 15 monthly-sales values and 0 coupon values**. Those are visit-specific parser observations, not a claim that every product is eligible or that all possible coupon layouts were covered. A positive search-coupon case is independently pinned by the earlier real captured card fixture (`You pay $29.99 with coupon`).

On a detached clone of the real `B0HDB173YV` card, removing its original sales node produced a missing value. Restoring the node using the **same cache** recovered **`5K+ bought in past month`**, preserving $19.97, the list price, deal, rating and review count. This is controlled remove/restore timing, **not** evidence that Amazon naturally delivered that precise hydration sequence.

[Recorded search observations, real-card timing and 28 checks](sad-389/moli-search.json).

The native observer checks use the actual production subscription and predicate: text changes, coupon reveals and legacy insertion wake it; unrelated text/color changes do not.

## Built-extension evidence

Chromium **156.0.8078.4**, final run at **17:36:06 UTC**, loaded the actual production `dist/chrome-mv3` extension. A dedicated temporary profile and controlled Amazon-shaped network fixtures were used.

Verified through real extension components:

1. Manual collection initially stores missing targets, then an attribute-only reveal updates the existing row.
2. Automatic collection recovers the same targets at its existing next parse. On an unchanged grid that is the end-of-page callback (~20 seconds with defaults), **not every scroll tick**; scheduling policy was not changed.
3. The actual closed-shadow card-save button saves and enriches the product.
4. A real right-click captures the card; the valid context-menu save command is then dispatched programmatically. The OS menu-item click itself was not automated.
5. Product-page collection carries clean coupon and monthly-sales text.
6. Five distinct products produce five stored rows, without duplicates.
7. Real service-worker fetches, the actual offscreen document/DOMParser, and IndexedDB are used. Listing price stays $59.99 where appropriate; the detail snapshot keeps its $79.99 observation.
8. Snapshot schema remains unchanged: coupon is present; monthly sales is not newly added to snapshots.
9. CSV **and** XLSX generated by the actual offscreen document contain the same target strings and prices as the stored rows.

[All 14 checks, exported cell values and request ownership](sad-389/chromium.json).

## Reproduction

Use Node 22 and the repository's existing dependencies:

```bash
npm ci
npm run compile
npm run check:dead-exports
npx vitest run --maxWorkers=2
npm run build
npm audit --omit=dev
```

Native Moli (the builder emits a standalone evaluation script):

```bash
node scripts/browser-qa/build-sad389-moli.mjs /tmp/sad389-moli.js
moli fetch --eval-file /tmp/sad389-moli.js --wait done --delay-ms 2000 \
  --timeout 45000 'https://www.amazon.com/dp/B0HCZ5ZF7J?language=en_US'
moli fetch --eval-file /tmp/sad389-moli.js --wait done --delay-ms 1500 \
  --timeout 30000 'https://www.amazon.com/s?k=wireless+earbuds&language=en_US'
```

The builder's optional second input is the original baseline Moli evaluation bundle, for a same-visit comparison. The committed JSON contains that comparison even without the historical bundle.

Built extension (install Playwright/Chromium outside the repository; it is not a project dependency):

```bash
NODE_PATH=/path/to/ephemeral/node_modules \
PLAYWRIGHT_BROWSERS_PATH=/path/to/ephemeral/browser-binaries \
SAD389_CHROME_PROFILE=/path/to/dedicated-temporary-qa-profile \
node scripts/browser-qa/sad389-extension.cjs /path/to/qa-result.json
```

Use a **dedicated disposable profile path**: the runner resets that profile. It never uses a signed-in user browser. No account access, coupon clipping, cart action or purchase was performed.

## Boundaries and review notes

- The user's original failing URLs/exports were unavailable. Evidence combines real public captures, fresh native Moli observations and explicitly controlled timing/layout/network cases.
- Live Amazon Chrome extension/worker behavior, signed-in offers, non-English variants and a hydrated live Deals grid remain unverified. Controlled category/PDP/save paths are tested.
- Eligible field absence remains absence. There is no inferred zero, sales count or coupon-from-price calculation. Existing export placeholder conventions are unchanged.
- Previously saved bad values are not migrated. A new collection, fresh save or full detail enrichment uses the corrected readers under the existing merge policies.
- Initial regression commits used expected-failure assertions to pin the baseline; **none remain** in the final SAD-389 tests.
- QA development uncovered harness-only problems: a whole-document native Moli clone exceeded the evaluation limit; an asynchronous browser-wait predicate needed explicit polling; automatic unchanged-grid cadence exceeded an initial 15-second wait; overly broad fixture CSS affected the save host; and the programmatic context-menu command needed its required timestamp. These were corrected in the QA harness, without changing production scheduling, UI or message contracts. Final complete runs are the evidence linked above.
- Rollback is a revert of this PR as a unit; there is no schema migration or backfill to undo.
