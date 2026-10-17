# Corrections to the Investigation Report

While writing this plan I re-read the relevant source to confirm exact line numbers, and found
**three claims in `/home/user/PPHunt-investigation-report.md` that are wrong or imprecise.**

The underlying *findings* all stand. Two of the stated *mechanisms* were incorrect, and one
measurement context was misdescribed. They are recorded here so the plan is not built on a false
premise, and so the report is not trusted where it should not be.

---

## Correction 1 — H‑9 / M‑2: the MutationObserver does not watch `attributes`, and the overlay does not retrigger parses

**Report claimed** (Key Results #5):
> "MutationObserver (`childList+subtree+attributes`, 300 ms debounce) re-parses the whole page;
> overlay host div is appended to `document.documentElement` so overlay renders retrigger parses."

**Actual code**, `src/entrypoints/amazon.content.ts:111-114`:
```ts
observer.observe(document.body, {
  childList: true,
  subtree: true,
});
```
There is **no `attributes: true`**. Attribute-only mutations (class changes on hover, `src` swaps on
lazy images, style updates) do **not** trigger the observer at all.

And the overlay host is appended to `document.documentElement`
(`src/lib/overlay/overlayHost.ts:104`), which is the **parent** of `body`. The observer watches
`document.body`'s subtree, so overlay renders are outside the observed range and do **not** retrigger
parses. The report's own sentence contained the fact that disproved its conclusion.

**What remains true:** the observer does watch the entire `document.body` subtree with
`childList + subtree`, Amazon pages mutate constantly, and the 300 ms debounce is trailing-only and
reset on every mutation — so both the wasted-work and the starvation concerns in H‑9 are real. Phase 5
Step 5.2 is unchanged; only its rationale narrows.

**Plan impact:** none on the fix, one on the test list — the "overlay render does not trigger a parse"
test is unnecessary and has been dropped.

---

## Correction 2 — M‑2: `staleCount++` is *not* skipped, and there is no `nextPage` code to miss

**Report claimed** (UNVERIFIED #19):
> "Automatic mode never reaches end-of-page reliably: `countProducts` counts all `/dp/` links;
> `onNewProducts` early-returns on empty batch, skipping `staleCount++`; never clicks `nextPage`."

**Actual code**, `src/lib/scraper/scroll-controller.ts:98-137`:
```ts
const currentCount = countProducts();
if (currentCount > this.lastProductCount) {
  this.staleCount = 0;
  this.loadingWaitCount = 0;
  this.lastProductCount = currentCount;
  onNewProducts(currentCount);
} else if (isLoading?.() && this.loadingWaitCount < maxLoadingTicks) {
  this.loadingWaitCount++;
  return;
} else {
  this.staleCount++;              // ← incremented here, in tick(), never inside onNewProducts
}

const maxStale = Math.ceil(this.config.maxWaitForNew / this.config.scrollInterval);
if (this.staleCount >= maxStale) { this.stop(); onEndOfPage(); return; }
```
`staleCount++` lives in `tick`'s own `else` branch. `onNewProducts` is a callback the controller
invokes; nothing it does can skip the increment, because the increment happens in the *other* branch.
The end-of-page exit therefore **does** work: with defaults, `maxStale = 5000 / 500 = 10` ticks.

The `nextPage` claim is also wrong — there is no pagination code in `scroll-controller.ts` at all, so
nothing is "never clicked". Automatic mode is scroll-only by design.

**What remains true, and it is the actual defect:** `countProducts` is over-broad
(`amazon.content.ts:248-254` unions in `[data-asin]` and `a[href*="/dp/"]`, matching recommendation
carousels, sponsored slots and footer links — measured 1,500 nodes on a 480-card page, 92 ms, on every
tick). When peripheral content lazy-loads, the raw count grows, `tick` resets `staleCount = 0` and
calls `onNewProducts`, which runs a **full page re-parse** that dedup then reduces to zero new
products. So the real consequences are (a) wasted full re-parses and (b) end-of-page detection being
postponed by carousel churn — not a skipped increment.

**Plan impact:** Phase 5 Step 5.3 was rewritten around the correct mechanism. The recommended fix is
also *smaller* than the report implied: narrowing the selector is sufficient, and the
`onNewProducts`-returns-boolean signature change is now explicitly optional and gated behind manual
verification.

---

## Correction 3 — the report's `background.ts` line numbers were offset by −13

**Report claimed** various line numbers in `src/entrypoints/background.ts` (e.g. `:426` for the
`START_COLLECTION` destructure, `:164` for the `executeScript` path, `:429-431` for sessionKey
minting, `:533` for the progress clamp).

The `executeScript` path figure (`:164`) is correct — `tsc` independently confirms
`background.ts(164,21): error TS2820`. The router line numbers are **13 higher** than stated: the
`onMessage` listener begins at line **413** (the report's `sed -n '412,442p'` window started one line
early), `START_COLLECTION`'s destructure is at **426**, and the `COLLECT_PRODUCTS` payloads are at
**442-443** and **473-474**.

**Plan impact:** none on any conclusion. All line numbers in this plan were re-verified against the
working tree, and the plan's numbers are the correct ones. Recorded so that anyone cross-referencing
the two documents does not chase a phantom discrepancy.

---

## Items re-verified as correct during plan writing

These were checked again and are accurate as reported:

| Claim | Verification |
|---|---|
| `parsePrice` receives a URL at 10 call sites | Re-grepped: `field-parsers.ts:571,859,876,902,923`; `product-detail.ts:295,310,317,331,525`. Only `field-parsers.ts:1306` uses `inferCurrencyFromUrl`. |
| `parsePriceFromElements` is worse than `parsePrice` | Confirmed: `price-parser.ts:190` defaults `fallbackCurrency ?? 'USD'`, so a URL argument yields the URL, losing even the `USD` safety net. |
| Router throws on 7 message types with a missing payload | Re-confirmed by probe; also confirmed there is **no `try/catch`** around the `switch` and that `sendResponse?.({ok:true})` sits *after* it at line 638. |
| `bg-forest` / `text-ink-faint` produce no CSS | Re-confirmed against `dist/chrome-mv3/assets/global-DnoJmkHH.css`. Also re-confirmed that `.shadow-lg` **is** present, so the earlier suspicion about `boxShadow: { none: 'none' }` remains a non-issue. |
| `ErrorCodeSchema` covers every code the app sends | Newly verified: `src/` uses 8 codes; the schema declares 12. **No gap** — so enabling validation will not start rejecting error messages. |
| `ScrapedProduct.source` matches the schema enum | Newly verified: `ProductSource = 'search' \| 'detail' \| 'category'` (`types/common.ts:8`) exactly matches `ProductSchema`'s `source` enum. The page-detector's `'bestsellers'` never becomes a `source`. |
| `WXT` requires a leading slash on `ScriptPublicPath` | Newly verified against `.wxt/types/paths.d.ts:5-18`: the union contains `"/content-scripts/amazon.js"`. |
| `tsc` error totals | Re-run: **111** distinct errors — 96 in `src/` (71 in `table/columns.tsx`, 25 elsewhere), 15 in `tests/`. The report's earlier figure of 93 was from a partial count; 111 is correct. |
| `clearAllHistory` also clears products | Re-confirmed at `db/history.ts:46-49`. |
| Two rapid settings toggles lose the first | Re-confirmed by probe: `title` persists as `true`, `asin` as `false`. |
| `OverlayDrawer` / `ProductsTab` / `CollectionsTab` reachability | Re-confirmed. `CollectionsTab` is imported at `App.tsx:6` but rendered only from a `default:` branch unreachable given `ActiveTab = 'collect' \| 'history'`. |
