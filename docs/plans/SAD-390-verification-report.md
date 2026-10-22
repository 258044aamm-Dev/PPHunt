# SAD-390 — Verification Report: `delivery` and `seller` Extraction

- **Issue**: [SAD-390 — The delivery and seller fields](https://linear.app/sad-mod/issue/SAD-390/the-delivery-and-seller-fields)
- **Branch**: `fix/sad-390-delivery-seller` (based on `main@2ec7eaf`)

---

## 1. Root Causes & Live Moli Reproductions

Using Moli (`moli fetch --wait-until done`, v1.1.18) against 6 live `amazon.com` search queries (120+ search cards) and 16 live `amazon.com` PDPs:

| Surface & Scenario | Live ASIN(s) Captured | Before (`main@2ec7eaf`) | After (`fix/sad-390-delivery-seller`) |
| :--- | :--- | :--- | :--- |
| **Search card `delivery` with Prime signup `<style>` + `<script>`** | `B01GJOMWVA`, `B0D8LXRHQ8`, `B0H9LC953P`, `B07S98411N` | `".prime-brand-color {color: #0064f9; }Join Prime(function(f){var _np=(window.P._namespace(\"udm-kata-sfx-prime-signup-ingress-script\"))..."` | `"Join Prime to get FREE delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26 on $35 of items shipped by Amazon"` |
| **Search card `delivery` with adjacent primary + secondary rows** | `B078NN17K3`, `B077K9YW7D` | `"FREE delivery Mon, Oct 26Or fastest delivery Sun, Oct 25"` (missing space) | `"FREE delivery Mon, Oct 26 Or fastest delivery Sun, Oct 25"` |
| **Search card with both `delivery` and low-stock `.a-color-price` notice** | `B0FTZZYP24`, `B0HFJ75YSY`, `B077KD11T1` | `delivery: undefined`, `availability: "Only 14 left in stock - order soon."` | `delivery: "FREE delivery Oct 28 - 30"`, `availability: "Only 14 left in stock - order soon."` |
| **1P non-accordion PDP `seller` (ODF `#merchantInfoFeature_feature_div`)** | `B0G66ZJG3Y`, `B0CNVCQZG1` | `seller: null` (`MISSING`) | `seller: "Amazon.com"` |
| **1P accordion PDP `seller` without Used row** | `B00MNV8E0C`, `B07MJL8NXR` | `seller: null` (`MISSING`) | `seller: "Amazon.com"` |
| **1P accordion PDP `seller` with collapsed `#usedAccordionRow`** | `B00AHAWWO0`, `B0DKVDZXSN`, `B0D7NXSQ44` | `seller: "Amazon Resale"` (contaminated from `#usedAccordionRow`) | `seller: "Amazon.com"` (active New offer row) |
| **Multi-row 3P accordion PDP `seller`** | `B0HDB173YV`, `B07ZPKN6YR` | Vulnerable to inactive accordion rows (`EVERJOY TECH TRADING LIMITED` / `RightBox` / `Amazon Resale`) | Active row seller (`"Fhumsh-CJ-US"` / `"WirelessSource"`) |
| **Used-only PDP `seller` & `delivery` (`#usedOnlyBuybox`)** | `B09V3KXJPB` | `#deliveryBlockMessage` contained inline `<script>` | `seller: "Amazon Resale"`, `delivery: "FREE delivery Tuesday, October 27"` |

---

## 2. Verification Gate Summary

All CI checks from `.github/workflows/ci.yml` were executed on the branch:

- **TypeScript (`npm run compile` / `tsc --noEmit`)**: Passed (0 errors).
- **Dead-export guard (`npm run check:dead-exports`)**: Passed (`all src/lib exports have consumers (42 files scanned)`).
- **Vitest (`npx vitest run`)**: **128 test files passed** (1 pre-existing live Temu capture file skipped), **1,432 tests passed** (3 skipped), **0 failures** — including 17 new tests in `tests/sad-390-delivery-seller.test.ts` and all existing suites (`tests/scraper-accuracy.test.tsx`, `tests/scraper-performance.test.ts`, `tests/extraction-diagnostics.test.ts`, `tests/pricing-deals-bsr.test.tsx`, `tests/sad-385-collection-detail-fields.test.ts`, `tests/enrich-saved-product.test.ts`, `tests/collection-brand-rank-sad384.test.ts`).
- **Production Build (`npm run build` / `wxt build`)**: Passed (`dist/chrome-mv3` built in 2.88 s, total size 2.04 MB, WAR narrowed to 10 entries).
- **Manifest Sanity Check**: Passed (`PPHunt 1.0.0`).
- **Scope & Non-Interference Check (`git diff --stat main`)**: Only `src/engines/amazon/scraper/{field-parsers,product-detail,selectors}.ts`, `tests/sad-390-delivery-seller.test.ts`, and `docs/plans/SAD-390*` were touched. Zero files in `src/engines/temu/`, `src/engines/amazon/db/`, `src/engines/amazon/schemas/`, or `package.json` were modified.
