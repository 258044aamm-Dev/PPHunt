# SAD-357 — Variations & Weight Fields Implementation Plan (Re-Planned Post-Pull @ `a90f96b`)

> **Linear Issue:** [`SAD-357`](https://linear.app/sad-mod/issue/SAD-357/variationsweight) (`variations,weight`) · Priority: High (P2) · Label: `Feature`  
> **Repository Baseline (Pulled):** `MakeTheNewHistory/PPHunt` @ **`57e11e0`** (`origin/main`, incl. `SAD-352`, `SAD-351`, `SAD-358`)  
> **Feature Branch:** `feat/sad-357-variations-weight`  
> **Baseline Health Verified:** `npx tsc --noEmit` clean · `npx wxt build` clean (`1.91 MB`) · `npx vitest run` **86/86 files, 972/972 tests passing** · `node scripts/check-dead-exports.mjs` **42 files clean**  
> **Plan Mode:** Plan-Only — **zero application source files modified**; every claim, selector, line reference, and side effect is verified directly against `a90f96b` and real captured 2026 `amazon.com` HTML pages.

---

## 0. Post-Pull Delta Audit (`080196b` → `a90f96b`, 9 New Commits)

Pulling `origin/main` advanced the repository by **9 commits across 3 features/fixes** (`19 files changed, 3,679 insertions, 52 deletions`):

| Upstream Ticket | Commits | Files Touched on `main` | Direct Impact on `SAD-357` Re-Plan |
|---|---|---|---|
| **`SAD-352`** *(Right-click PDP enrichment diagnostics)* | `c3e182e8`, `32c11fc3` | `src/engines/amazon/background/enrich-saved-product.ts` (`+145`), `src/engines/amazon/background/save-job.ts` (`+17`), `tests/enrich-saved-product.test.ts` (`+173`), `tests/save-job-pipeline.test.ts` (`+36`) | 1. Added `collectMissingDetailFields(product)` (`enrich-saved-product.ts:170-189`) driven dynamically by `DETAIL_FIELDS` + `logEnrichmentOutcome()`. Adding `'variations'` and `'weight'` to `DETAIL_FIELDS` automatically instruments both fields in SW diagnostic logs with **zero extra code**.<br>2. **New Pinned Test Impact:** `tests/enrich-saved-product.test.ts:435-456` asserts `expect(collectMissingDetailFields(full)).toEqual([])` — `full` **must** now include `variations` and `weight` (and lines `458-475` should include them in `missing`), or CI would fail! |
| **`SAD-351`** *(Deal-page image rendering fix)* | `45f00e95` .. `83631e8d` | `src/engines/amazon/scraper/field-parsers.ts` (`+117`), `ARCHITECTURE.md` (`+24`), `CHANGELOG.md` (`+32`), `spec/10-amazon-selectors.md` (`+6`), `tests/deal-page-images-sad351.test.tsx` (`+346`) | 1. `field-parsers.ts` grew from `1,624` → **`1,723` lines**; Gate G2 (`validateAndNormalizeScrapedProduct`) shifted to **`lines 1623-1635`**.<br>2. `ARCHITECTURE.md` (`387` lines), `CHANGELOG.md` (`327` lines), and `spec/10-amazon-selectors.md` (`151` lines) establish exact documentation conventions for selector & pipeline additions. |
| **`SAD-358`** *(Expand option for truncated table cells)* | `6273ad93`, `b2196eb3`, `a90f96b6` | `src/entrypoints/sidepanel/components/ExpandableCell.tsx` (`+94`), `CellExpandModal.tsx` (`+216`), `src/engines/amazon/ui/table/columns.tsx` (`+135`, now `903` lines), `AmazonProductTable.tsx` (`+21`, now `731` lines), Temu equivalents, `tests/cell-expand-sad358.test.tsx` (`+389`) | **Major UX & Design Upgrade for `SAD-357`:**<br>1. `AmazonProductTable` already wires a singleton `<CellExpandModal>` via `table.options.meta.onExpand` (`AmazonProductTable.tsx:239-242, 712-716`).<br>2. Wrapping `variationsColumn` in `<ExpandableCell label="Variations" columnId="variations" ...>` + adding a type-aware `columnId === 'variations'` formatter in `CellExpandModal.tsx` lets users expand the clamped 1-line cell on hover/focus/tap to inspect **100% of every dimension and option value in a structured list with one-click Copy** — eliminating any need to truncate stored option lists with `+N more` on PDPs!<br>3. `weightColumn` (`"0.19 kg"`, `"9.12 oz"`, `"1 lb 4 oz"` inside `96px` mono column) stays crisp and un-truncated at rest (matching `price` `90px` / `listPrice` `96px` in `SAD-358` §2.2) so a `24px` hover button never clips short numeric text.<br>4. `tests/cell-expand-sad358.test.tsx` remains **100% green untouched** because empty `variations` returns `null` before `ExpandableCell` renders (satisfying AC #5: no dead affordance on empty values). |

---

## 1. Confirmed Scope & Product Decisions

1. **Engine Scope (`amazon_only`):**
   - Implement **Variations** (`variations`) and **Weight** (`weight`) across all 9 Amazon pipeline layers (`src/engines/amazon/**`) plus shared sorting (`src/lib/sorting/product-sorter.ts`) and shared cell-expand formatting (`src/entrypoints/sidepanel/components/CellExpandModal.tsx`).
   - Keep `src/engines/temu/**` byte-identical (0 edits).
2. **Variations Representation & Extraction Scope (`single_summary_pdp_and_search` + `SAD-358` Expand):**
   - Model `variations?: string | null` on `ScrapedAmazonProduct` / `AmazonProduct`, gated by `enabledFields.variations: boolean` (default `true`).
   - **Zero-Loss Structured Summary Format:** Because `SAD-358`'s `ExpandableCell` + `CellExpandModal` now displays unlimited content cleanly when expanded while `line-clamp-1` keeps the `52px` table row height invariant intact, PDP extraction preserves **every known dimension and option value verbatim** without lossy truncation:
     - Multi-dimension PDP example: `"10 (Size: 1 Pack, 6 Pack; Color: Black, Cobalt Blue, Miami, Purple, Red, White)"`
     - Large multi-dimension PDP example: `"88 (Size: 64GB, 128GB, 256GB; Color: Black, White, (PRODUCT) RED, Coral, Yellow, Blue; Service provider: AT&T, Cricket, GSM Carriers, Sprint, T-Mobile, Unlocked, Verizon; Product grade: Renewed, Renewed Premium)"`
     - Book / Media `#tmmSwatches` format matrix example: `"4 (Format: Kindle, Audiobook, Hardcover, Paperback)"`
     - Search / Category card swatch hints (where Amazon only renders visible swatches + an optional `+N` count link):
       - Named swatches + overflow link: `"6 (Color: Blue, Black, Red, White, +2 more)"`
       - Named swatches only: `"3 (Color: Blue, Black, Red)"`
       - Overflow link only (`+3 other colors/patterns`): `"4 (+3 other colors/patterns)"`
   - **Singleton Guard:** Products with only 1 variation (`num_total_variations <= 1` and `<= 1` option per dimension, or 1 search swatch with `0` overflow) return `undefined` — never `"1 variation"`.
   - **Search → PDP Upgrade Rule:** All three merge gates (`mergeScrapedProductFields`, `enrichStoredProductFields`, `mergeDetailIntoStored`) upgrade a search/category swatch hint when an authoritative `detail` record supplies non-empty `variations`, while **never** letting `null`/`undefined` or a search card overwrite a detail value.
   - **Modal Expansion (`SAD-358`):** Clicking Expand (or tapping on coarse-pointer devices) on any populated `Variations` cell opens `CellExpandModal` with a structured summary badge (`"88 variations"`) + per-dimension bulleted breakdown (`Size`, `Color`, etc.) + one-click `Copy`.
3. **Weight Formatting, Sorting & Empty-Cell Rule (`clean_source_unit_blank_empty`):**
   - Model `weight?: string | null` on `ScrapedAmazonProduct` / `AmazonProduct`, gated by `enabledFields.weight: boolean` (default `true`).
   - Preserve Amazon's numeric measurement paired with canonical unit symbols (`mg`, `g`, `kg`, `oz`, `lb`/`lbs`, plus compound imperial `"1 lb 4 oz"`), e.g. `"0.19 kg"`, `"9.12 oz"`, `"1.73 lbs"`, `"0.31 g"`.
   - **Physical-Mass Sorting (`src/lib/sorting/product-sorter.ts`):** Convert parsed weights to grams in `parseSortableWeightGrams` so ascending/descending sort orders accurately by physical mass (`0.31 g` < `0.02 kg` < `0.19 kg` < `9.12 oz` < `1.73 lbs`), and sort `Variations` numerically by leading variation count (`parseSortableVariationCount`) with alphabetical tie-breaking; missing values always sort last in both directions.
   - **Empty-Cell Convention (per `SAD-348`):** Render absent `variations` and `weight` as **`null` (blank cell, zero dead expand button)** in UI and **`""` (empty cell)** in CSV, Excel (`.xlsx`), and Clipboard TSV exports.

---

## 2. Empirical DOM & Codebase Verification Findings

1. **2026 Amazon Expander Spec-Table Container Gap (`selectors.ts:135-143` + `product-detail.ts:238-262`):**
   - Verified on real 2026 captured `amazon.com` PDPs (`apparel`, `ce`, `photo`, `wireless`): Amazon renders `<table class="a-keyvalue prodDetTable"><tr><th>Item Weight</th><td>0.19 kg</td></tr></table>` inside:
     - `div#productDetails_expanderTables_depthLeftSections`
     - `div#productDetails_expanderTables_depthRightSections`
     - `div#productDetails_expanderSectionTables`
     - `[data-feature-name="productDetailsHomeAndGarden_Updated"]`
     often **without** `#prodDetails` or `#productDetails_techSpec_section_1`.
   - Extending `AMAZON_SELECTORS.detail.warrantyContainers` with these 4 containers and adding `td:first-child strong, td:first-child b` to `iterDetailSpecRows` (`product-detail.ts:241`) captures 100% of legacy tech-spec tables, 2026 expander tables, `detailBullets` (`Item Weight \u200f : \u200e 1.73 pounds` — bidi marks already stripped by `normalizeWhitespace` at `field-parsers.ts:53-58`), `productOverview`, semicolon `Product Dimensions` (`10 x 5 x 3 inches; 1.25 Pounds`), and A+ brand spec grids while ignoring `#compare` and `#similarities_feature_div` (`isInsideExcludedDetailSubtree`).
2. **Embedded `twister-js-init-dpx-data` Script + Singleton Trap:**
   - Multi-variant PDPs embed `P.register('twister-js-init-dpx-data', function() { var dataToReturn = { ... }; })`. Because the outer JS object contains string concatenation (`"ajaxUrlParams": "..." + "..."`), each JSON key (`"dimensions"`, `"variationDisplayLabels"`, `"variationValues"`, `"dimensionValuesDisplayData"`, `"num_total_variations"`) is extracted individually via a string-aware balanced `[]`/`{}` scanner.
   - Even single-variant listings ship `twister-js-init-dpx-data` with `"num_total_variations": 1` and a 1-element `variationValues` array (`["1 Twin Pack"]`). Rejecting `totalCount <= 1 && dims.every(d => d.values.length <= 1)` prevents false positives on singletons.
3. **Search Card Swatch Zone & Badge False-Positive Guard:**
   - Search result swatches live strictly inside `.s-color-swatch-container` (`[data-csa-c-content-id="color-swatch-link"] a[aria-label]` + `[data-csa-c-content-id="color-swatch-more-link"]` / `a.s-color-swatch-link`). Scoping strictly to `.s-color-swatch-container` completely avoids sustainability links (`"Learn more about Global Recycled Standard"`, `"Recycled materials +2 more"`) and `"More Buying Choices"`.
4. **Canonical Field Placement Preserves Every Existing Contract Test:**
   - Placing `variations` and `weight` immediately after `features` and immediately before `warrantyDescription` (`... description, features, variations, weight, warrantyDescription, source`) keeps one identical canonical order across **all 8 configuration/UI/export surfaces** AND preserves `SAD-349`'s exact index assertion (`DEFAULT_VISIBLE_COLUMNS[i + 1] === 'Warranty Details'` and `DEFAULT_VISIBLE_COLUMNS[i + 2] === 'Source'` at `tests/warranty-description.test.tsx:513-516`) unmodified!

---

## 3. Complete File-by-File Change Matrix (Verified on `a90f96b`)

| # | File Path | Exact Lines on `a90f96b` | Gate / Layer | Change Summary |
|---|---|---|---|---|
| 1 | `src/engines/amazon/types/product.ts` | `34–46` | G1 Types | Add `variations?: string \| null;` and `weight?: string \| null;` to `ScrapedAmazonProduct` |
| 2 | `src/engines/amazon/types/index.ts` | `147–152` | G1 Types | Add `variations: boolean;` and `weight: boolean;` to `EnabledFieldsConfig` (`24` → `26`) |
| 3 | `src/engines/amazon/schemas/product.ts` | `43–50` | G1 Schema | Add `variations: z.string().nullable().optional()` and `weight: z.string().nullable().optional()` (`ScrapedProductSchema` inherits automatically) |
| 4 | `src/engines/amazon/constants/defaults.ts` | `51–58` | G1 Defaults | Add `variations: true` and `weight: true` to `DEFAULT_ENABLED_FIELDS` |
| 5 | `src/engines/amazon/schemas/settings.ts` | `43–52` | G1 Settings | Add `variations: z.boolean().default(true)` and `weight: z.boolean().default(true)` to `EnabledFieldsSchema` |
| 6 | `src/engines/amazon/scraper/selectors.ts` | `29–55`, `135–145`, `335–350` | Scraper | Add weight/dimension label regexes, expand `detail.warrantyContainers` with 2026 expander containers, add `detail.twister` & `cardFields.variationSwatches` |
| 7 | `src/engines/amazon/scraper/field-parsers.ts` | `305–465`, `1623–1635` | Scraper + G2 | Export `normalizeWeightValue`, `formatVariationDimensionsSummary`, `extractCardVariations`; pass `variations` & `weight` through `validateAndNormalizeScrapedProduct` |
| 8 | `src/engines/amazon/scraper/product-detail.ts` | `238–295`, `595–630` | PDP Scraper | Support `td:first-child strong/b` in `iterDetailSpecRows`; add `extractDetailWeight` (4-priority waterfall) & `extractDetailVariations` (3-tier Twister JSON → Twister DOM → `#tmmSwatches` waterfall); attach to `candidate` |
| 9 | `src/engines/amazon/scraper/search-results.ts` | `95–155` | Search Scraper | Call `extractCardVariations(card)` in `parseAmazonSearchCard` |
| 10 | `src/engines/amazon/scraper/category-page.ts` | `145–205` | Category Scraper | Call `extractCardVariations(card)` in `parseAmazonCategoryCard` |
| 11 | `src/engines/amazon/scraper/dedup.ts` | `12–75` | G3 Dedup / Upsert | Add `'variations'` & `'weight'` to `MERGEABLE_NULLABLE_FIELDS` + PDP upgrade rule in `mergeScrapedProductFields` |
| 12 | `src/engines/amazon/db/products.ts` | `12–60` | G4 Dexie CRUD | Add `'variations'` & `'weight'` to `nullableKeys` + PDP upgrade rule in `enrichStoredProductFields` |
| 13 | `src/engines/amazon/background/enrich-saved-product.ts` | `28–55` | G5 + `SAD-352` | Add `'variations'` & `'weight'` to `DETAIL_FIELDS` (upgrades partial search swatches on PDP enrichment AND feeds `collectMissingDetailFields` telemetry automatically) |
| 14 | `src/lib/sorting/product-sorter.ts` | `15–32`, `245–315` | G7 Sorting | Export `parseSortableWeightGrams` & `parseSortableVariationCount`, handle `weight` & `variations` in `compareFieldValues`, add both to `AMAZON_SORTABLE_FIELDS` |
| 15 | `src/entrypoints/sidepanel/components/CellExpandModal.tsx` | `65–95` | `SAD-358` Modal | Add `columnId === 'variations'` branch in `renderModalBody` rendering total count pill + per-dimension bulleted breakdown |
| 16 | `src/engines/amazon/ui/table/columns.tsx` | `785–903` | G6 + `SAD-358` | Add `variationsColumn` (`[180, 120, 320]`, wrapped in `ExpandableCell`) & `weightColumn` (`[96, 76, 150]`, crisp mono tabular-nums); register between `featuresColumn` and `warrantyDescriptionColumn` |
| 17 | `src/engines/amazon/ui/table/AmazonProductTable.tsx` | `168–188` | G6 Filter | Include `p.variations` & `p.weight` in `textFilteredProducts` search filter |
| 18 | `src/engines/amazon/ui/components/SettingsOverlay.tsx` | `386–415` | G8 Settings UI | Add `variations: 'Variations'` & `weight: 'Weight'` to `FIELD_LABELS` |
| 19 | `src/engines/amazon/export/types.ts` | `85–95`, `145–250` | G9 Exports | Add `Variations` & `Weight` to `EXPORT_COLUMNS`, `FIELD_KEY_TO_HEADER`, `DEFAULT_VISIBLE_COLUMNS`, and `getExportColumnsFromSettings` |
| 20 | `README.md`, `ARCHITECTURE.md`, `spec/10-amazon-selectors.md`, `CHANGELOG.md` | `README:27`, `ARCH:201,268`, `spec:110`, `CHANGELOG:7` | Docs | Update `24` → `26` field toggles, document Variations & Weight selectors/precedence, add `[Unreleased] — Variations & Weight fields (SAD-357)` entry |
| 21 | `tests/enrich-saved-product.test.ts`, `tests/table-v9-contract.test.tsx`, `tests/scraper-accuracy.test.tsx`, `tests/warranty-description.test.tsx` | Pinned assertions | Contract Tests | Add `variations` & `weight` to `collectMissingDetailFields` fixture (`enrich-saved-product.test.ts:435-475`), column contract arrays (`27` → `29`), toggle count (`24` → `26`), and explicit `EnabledFieldsConfig` literals |
| 22 | `tests/variations-weight.test.tsx` *(create)* | Full file | Feature Tests | Complete unit + DOM + pipeline + sorting + `CellExpandModal` + settings + CSV/XLSX/TSV test suite |

**Explicitly Untouched Files (Verified Safe on `a90f96b`):**
- `src/engines/temu/**` — byte-identical (`0` changes).
- `src/engines/amazon/db/database.ts` — Dexie v1/v2 stores & `[sessionKey+asin]` compound index untouched.
- `src/engines/amazon/db/quick-save.ts`, `src/engines/amazon/background/save-job.ts`, `src/engines/amazon/offscreen/parse.ts` — delegate through `ScrapedProductSchema`, `parseAmazonProductDetail`, and `mergeScrapedProductFields`.
- `src/engines/amazon/export/csv.ts`, `excel.ts`, `clipboard.ts` — dynamically iterate `EXPORT_COLUMNS` and coerce `null`/`undefined` to `""` with spreadsheet formula neutralization.
- `src/entrypoints/sidepanel/components/ExpandableCell.tsx` & `tests/cell-expand-sad358.test.tsx` — untouched and green.

---

## 4. Exact Code Snippets for Every Modified Module

### 4.1 Types, Schemas & Defaults (`types/product.ts`, `types/index.ts`, `schemas/product.ts`, `constants/defaults.ts`, `schemas/settings.ts`)

```ts
// src/engines/amazon/types/product.ts (lines 34-46)
  description?: string | null;
  features?: string[];
  /**
   * SAD-357: human-readable variation count and full dimension breakdown
   * (e.g. `10 (Size: 1 Pack, 6 Pack; Color: Black, White)`), extracted from PDP
   * twister data/DOM or search-card swatches and upgraded on PDP enrichment.
   * Omitted when the product is a singleton or states no variations.
   */
  variations?: string | null;
  /**
   * SAD-357: physical product weight with canonical unit
   * (e.g. `0.19 kg`, `9.12 oz`, `1.73 lbs`), extracted from PDP spec tables.
   */
  weight?: string | null;
  warrantyDescription?: string | null;
  warrantyDescriptionRaw?: string | null;
```

```ts
// src/engines/amazon/types/index.ts (lines 147-152)
  description: boolean;
  features: boolean;
  variations: boolean;
  weight: boolean;
  /** SAD-349: gates both the warranty token and its verbatim source column. */
  warrantyDescription: boolean;

// src/engines/amazon/constants/defaults.ts (lines 51-58)
  description: true,
  features: true,
  // SAD-357: default-on for the same reason as description/features/warranty —
  // weight and full twister variations come from the PDP / background enrichment.
  variations: true,
  weight: true,
  warrantyDescription: true,

// src/engines/amazon/schemas/settings.ts (lines 43-52)
  description: z.boolean().default(true),
  features: z.boolean().default(true),
  variations: z.boolean().default(true),
  weight: z.boolean().default(true),
  warrantyDescription: z.boolean().default(true),

// src/engines/amazon/schemas/product.ts (lines 43-50)
  description: z.string().nullable().optional().default(null),
  features: z.array(z.string()).optional().default([]),
  variations: z.string().nullable().optional(),
  weight: z.string().nullable().optional(),
  warrantyDescription: z.string().nullable().optional(),
  warrantyDescriptionRaw: z.string().nullable().optional(),
```

---

### 4.2 Selectors & Spec-Label Patterns (`src/engines/amazon/scraper/selectors.ts`)

```ts
/**
 * SAD-357: Priority-1 spec-row labels stating the item's own physical mass.
 * Anchored on the full normalized label so unrelated rows (`Maximum Weight
 * Recommendation`, `Supported Weight`, `Paper Weight`, `Line Weight`) cannot match.
 */
export const AMAZON_WEIGHT_ITEM_LABEL_PATTERN =
  /^(?:item\s+weight|product\s+weight|weight|item\s+display\s+weight|net\s+weight|unit\s+weight|artikelgewicht|poids(?:\s+de\s+l['’]article)?|peso(?:\s+del\s+producto|\s+articolo)?)\s*:?$/i;

/**
 * SAD-357: Priority-2 fallback labels when Amazon publishes only packaged/shipping mass.
 */
export const AMAZON_WEIGHT_PACKAGE_LABEL_PATTERN =
  /^(?:(?:item\s+)?package\s+weight|shipping\s+weight|boxed-product\s+weight|paketgewicht|poids\s+du\s+colis)\s*:?$/i;

/**
 * SAD-357: Priority-3 combined `L x W x H unit; Weight unit` rows.
 */
export const AMAZON_DIMENSIONS_LABEL_PATTERN =
  /^(?:product\s+dimensions|item\s+dimensions(?:\s+lxwxh)?|package\s+dimensions|parcel\s+dimensions|dimensions)\s*:?$/i;
```

In `AMAZON_SELECTORS.detail`:
```ts
    warrantyContainers: [
      '#productDetails_techSpec_section_1',
      '#productDetails_techSpec_section_2',
      '#productDetails_detailBullets_sections1',
      '#productDetails_db_sections',
      '#productDetails_expanderTables_depthLeftSections',
      '#productDetails_expanderTables_depthRightSections',
      '#productDetails_expanderSectionTables',
      '[data-feature-name="productDetailsHomeAndGarden_Updated"]',
      '#detailBulletsWrapper_feature_div',
      '#productOverview_feature_div',
      '#prodDetails',
    ],
    twister: {
      inlineRows: 'div[id^="inline-twister-row-"]',
      inlineDimTitle: '[id^="inline-twister-dim-title-"]',
      classicRows: '#twister [id^="variation_"]',
      mediaSwatches: '#tmmSwatches .swatchElement',
    },
```

In `AMAZON_SELECTORS.cardFields`:
```ts
    variationSwatches: {
      containers: '.s-color-swatch-container',
      swatchLinks:
        '[data-csa-c-content-id="color-swatch-link"] a[aria-label], .s-color-swatch-container a[aria-label]:not(.s-color-swatch-link)',
      moreLinks:
        '[data-csa-c-content-id="color-swatch-more-link"], .s-color-swatch-container a.s-color-swatch-link',
    },
```

---

### 4.3 Normalizers, Card Swatch Extractor & Gate G2 (`src/engines/amazon/scraper/field-parsers.ts`)

```ts
const WEIGHT_UNIT_CANONICAL: Record<
  string,
  { singular: string; plural: string }
> = {
  mg: { singular: 'mg', plural: 'mg' },
  milligram: { singular: 'mg', plural: 'mg' },
  milligrams: { singular: 'mg', plural: 'mg' },
  g: { singular: 'g', plural: 'g' },
  gm: { singular: 'g', plural: 'g' },
  gms: { singular: 'g', plural: 'g' },
  gram: { singular: 'g', plural: 'g' },
  grams: { singular: 'g', plural: 'g' },
  gramm: { singular: 'g', plural: 'g' },
  grammes: { singular: 'g', plural: 'g' },
  kg: { singular: 'kg', plural: 'kg' },
  kgs: { singular: 'kg', plural: 'kg' },
  kilogram: { singular: 'kg', plural: 'kg' },
  kilograms: { singular: 'kg', plural: 'kg' },
  kilogramm: { singular: 'kg', plural: 'kg' },
  kilogrammes: { singular: 'kg', plural: 'kg' },
  oz: { singular: 'oz', plural: 'oz' },
  ounce: { singular: 'oz', plural: 'oz' },
  ounces: { singular: 'oz', plural: 'oz' },
  lb: { singular: 'lb', plural: 'lbs' },
  lbs: { singular: 'lb', plural: 'lbs' },
  pound: { singular: 'lb', plural: 'lbs' },
  pounds: { singular: 'lb', plural: 'lbs' },
};

const COMPOUND_IMPERIAL_WEIGHT_RE =
  /(?:^|[^\d.])(\d+(?:[.,]\d+)?)\s*(lbs?|pounds?)\.?\s+(\d+(?:[.,]\d+)?)\s*(oz|ounces?)\.?(?![a-zA-Z])/i;

const SINGLE_WEIGHT_RE =
  /(?:^|[^\d.])(\d+(?:[.,]\d+)?)\s*(mg|milligrams?|g|gms?|grams?|gramm|grammes|kgs?|kilograms?|kilogramm|kilogrammes|oz|ounces?|lbs?|pounds?)\.?(?![a-zA-Z])/i;

function parsePositiveWeightNumber(rawNum: string): {
  numeric: number;
  display: string;
} | null {
  let cleaned = rawNum.trim();
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned =
      cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')
        ? cleaned.replace(/,/g, '')
        : cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    cleaned = /,\d{1,3}$/.test(cleaned)
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  }
  const numeric = Number.parseFloat(cleaned);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return { numeric, display: String(Number(cleaned)) };
}

/**
 * SAD-357: cleans an Amazon weight cell into a canonical value + unit string
 * (e.g. `"0.19 kg"`, `"9.12 oz"`, `"1.73 lbs"`, `"1 lb 4 oz"`).
 * Returns `null` when no positive physical mass unit is present.
 */
export function normalizeWeightValue(
  raw: string | null | undefined,
): string | null {
  const text = normalizeWhitespace(raw);
  if (!text) return null;

  const compound = COMPOUND_IMPERIAL_WEIGHT_RE.exec(text);
  if (compound) {
    const lbParsed = parsePositiveWeightNumber(compound[1]!);
    const ozParsed = parsePositiveWeightNumber(compound[3]!);
    if (lbParsed && ozParsed) {
      const lbUnit = lbParsed.numeric === 1 ? 'lb' : 'lbs';
      return `${lbParsed.display} ${lbUnit} ${ozParsed.display} oz`;
    }
  }

  const single = SINGLE_WEIGHT_RE.exec(text);
  if (!single) return null;

  const parsed = parsePositiveWeightNumber(single[1]!);
  if (!parsed) return null;

  const unitSpec = WEIGHT_UNIT_CANONICAL[single[2]!.toLowerCase()];
  if (!unitSpec) return null;

  const unitLabel =
    parsed.numeric === 1 ? unitSpec.singular : unitSpec.plural;
  return `${parsed.display} ${unitLabel}`;
}

export interface VariationDimensionSummaryInput {
  label: string;
  values: readonly string[];
}

/**
 * SAD-357: formats structured variation dimensions and total count into a
 * lossless human-readable string (full values preserved for exports and
 * SAD-358's CellExpandModal; clamped via `line-clamp-1` inside the table cell).
 * Returns `null` for singletons (`totalVariations <= 1` and `<= 1` option per dim).
 */
export function formatVariationDimensionsSummary(
  dimensions: readonly VariationDimensionSummaryInput[],
  totalVariations?: number | null,
): string | null {
  const cleanedDims: Array<{ label: string; values: string[] }> = [];

  for (const dim of dimensions) {
    const label = normalizeWhitespace(dim.label).replace(/:+$/, '').trim();
    if (!label) continue;
    const uniqueValues: string[] = [];
    for (const rawVal of dim.values) {
      const val = normalizeWhitespace(rawVal);
      if (val && !uniqueValues.includes(val)) {
        uniqueValues.push(val);
      }
    }
    if (uniqueValues.length > 0) {
      cleanedDims.push({ label, values: uniqueValues });
    }
  }

  const hasMultiOptionDim = cleanedDims.some((d) => d.values.length > 1);
  const validTotal =
    typeof totalVariations === 'number' && Number.isFinite(totalVariations)
      ? Math.trunc(totalVariations)
      : null;

  if ((validTotal === null || validTotal <= 1) && !hasMultiOptionDim) {
    return null;
  }

  const dimSummary = cleanedDims
    .map(({ label, values }) => `${label}: ${values.join(', ')}`)
    .join('; ');

  if (validTotal !== null && validTotal > 1 && dimSummary) {
    return `${validTotal} (${dimSummary})`;
  }
  if (dimSummary) {
    const inferredCount =
      cleanedDims.length === 1
        ? cleanedDims[0]!.values.length
        : Math.max(...cleanedDims.map((d) => d.values.length));
    return `${inferredCount} (${dimSummary})`;
  }
  if (validTotal !== null && validTotal > 1) {
    return `${validTotal} variations`;
  }
  return null;
}

const SWATCH_REMAINING_RE =
  /^\+\s*(\d+)\s+(?:other\s+)?(colors?(?:\/patterns?)?|patterns?|sizes?|styles?|flavors?|scents?|options?|designs?)\b/i;

/**
 * SAD-357: extracts variation hints from search/category result cards using
 * Amazon's `.s-color-swatch-container` region (immune to sustainability badges).
 */
export function extractCardVariations(card: Element): string | undefined {
  const container = safeQuerySelector(
    card,
    AMAZON_SELECTORS.cardFields.variationSwatches.containers,
  );
  if (!container) return undefined;

  const swatchNames: string[] = [];
  const swatchLinks = safeQuerySelectorAll(
    container,
    AMAZON_SELECTORS.cardFields.variationSwatches.swatchLinks,
  );
  for (const link of swatchLinks) {
    const rawLabel = normalizeWhitespace(
      link.getAttribute('aria-label') ||
        link.querySelector('img')?.getAttribute('alt'),
    );
    if (
      !rawLabel ||
      /^colors?\s+available$/i.test(rawLabel) ||
      SWATCH_REMAINING_RE.test(rawLabel)
    ) {
      continue;
    }
    if (!swatchNames.includes(rawLabel)) {
      swatchNames.push(rawLabel);
    }
  }

  let extraCount = 0;
  let overflowText: string | null = null;
  const moreNodes = safeQuerySelectorAll(
    container,
    AMAZON_SELECTORS.cardFields.variationSwatches.moreLinks,
  );
  for (const node of moreNodes) {
    const candidate = normalizeWhitespace(
      node.getAttribute('data-csa-c-swatch-remaining-count') ||
        node.getAttribute('aria-label') ||
        node.textContent,
    );
    const match = SWATCH_REMAINING_RE.exec(candidate);
    if (match) {
      extraCount = Number.parseInt(match[1]!, 10);
      overflowText = candidate;
      break;
    }
  }

  if (swatchNames.length > 0 && extraCount > 0) {
    const total = swatchNames.length + extraCount;
    return `${total} (Color: ${swatchNames.join(', ')}, +${extraCount} more)`;
  }

  if (swatchNames.length >= 2) {
    return (
      formatVariationDimensionsSummary(
        [{ label: 'Color', values: swatchNames }],
        swatchNames.length,
      ) ?? undefined
    );
  }

  if (extraCount > 0 && overflowText) {
    const total = (swatchNames.length || 1) + extraCount;
    return `${total} (${overflowText})`;
  }

  return undefined;
}
```

And inside `validateAndNormalizeScrapedProduct` (`src/engines/amazon/scraper/field-parsers.ts:1623-1635`):
```ts
    if (typeof raw.variations === 'string' && raw.variations.trim()) {
      normalized.variations = raw.variations.trim();
    }
    if (typeof raw.weight === 'string' && raw.weight.trim()) {
      normalized.weight = raw.weight.trim();
    }
```

---

### 4.4 PDP Extractors (`src/engines/amazon/scraper/product-detail.ts`)

1. **`iterDetailSpecRows` (`line 241`):**
   ```ts
   const header = row.querySelector(
     'th, .a-text-bold, td:first-child strong, td:first-child b',
   );
   ```
2. **`extractDetailWeight(doc: Document): string | undefined`:**
   ```ts
   function extractDetailWeight(doc: Document): string | undefined {
     let packageWeightFallback: string | undefined;
     let dimensionsWeightFallback: string | undefined;

     for (const selector of AMAZON_SELECTORS.detail.warrantyContainers) {
       const container = safeQuerySelector(doc, selector);
       if (!container || isInsideExcludedDetailSubtree(container)) continue;

       for (const { label, value } of iterDetailSpecRows(container)) {
         if (AMAZON_WEIGHT_ITEM_LABEL_PATTERN.test(label)) {
           const normalized = normalizeWeightValue(value);
           if (normalized) return normalized;
           continue;
         }

         if (
           packageWeightFallback === undefined &&
           AMAZON_WEIGHT_PACKAGE_LABEL_PATTERN.test(label)
         ) {
           const normalized = normalizeWeightValue(value);
           if (normalized) packageWeightFallback = normalized;
           continue;
         }

         if (
           dimensionsWeightFallback === undefined &&
           AMAZON_DIMENSIONS_LABEL_PATTERN.test(label) &&
           value.includes(';')
         ) {
           const weightSegment = value.split(';').slice(1).join(';');
           const normalized = normalizeWeightValue(weightSegment);
           if (normalized) dimensionsWeightFallback = normalized;
         }
       }
     }

     if (packageWeightFallback !== undefined) return packageWeightFallback;
     if (dimensionsWeightFallback !== undefined) return dimensionsWeightFallback;

     const aplusContainer = safeQuerySelector(doc, '#aplus');
     if (aplusContainer && !isInsideExcludedDetailSubtree(aplusContainer)) {
       for (const { label, value } of iterDetailSpecRows(aplusContainer)) {
         if (!AMAZON_WEIGHT_ITEM_LABEL_PATTERN.test(label)) continue;
         const normalized = normalizeWeightValue(value);
         if (normalized) return normalized;
       }
     }

     return undefined;
   }
   ```
3. **`extractDetailVariations(doc: Document): string | undefined`:**
   - **Tier 1:** Embedded `twister-js-init-dpx-data` balanced-JSON extractor (`dimensions`, `variationDisplayLabels`, `variationValues`, `dimensionValuesDisplayData`, `num_total_variations`), guarded by singleton rejection.
   - **Tier 2:** Inline twister `div[id^="inline-twister-row-"]` + classic `#twister [id^="variation_"]` DOM extractor.
   - **Tier 3:** Media/book `#tmmSwatches .swatchElement` format matrix extractor (`Kindle`, `Audiobook`, `Hardcover`, `Paperback`).

---

### 4.5 Merge & Persistence Gates (`dedup.ts`, `db/products.ts`, `background/enrich-saved-product.ts`)

```ts
// 1. src/engines/amazon/scraper/dedup.ts — MERGEABLE_NULLABLE_FIELDS + detail upgrade
const MERGEABLE_NULLABLE_FIELDS = [
  ...
  'description',
  'variations',
  'weight',
  'warrantyDescription',
  'warrantyDescriptionRaw',
] as const;

// After the MERGEABLE_NULLABLE_FIELDS loop in mergeScrapedProductFields:
if (
  source.source === 'detail' &&
  target.source !== 'detail' &&
  source.variations &&
  target.variations !== source.variations
) {
  target.variations = source.variations;
  changed = true;
}

// 2. src/engines/amazon/db/products.ts — nullableKeys + same detail upgrade in enrichStoredProductFields
// 3. src/engines/amazon/background/enrich-saved-product.ts — DETAIL_FIELDS
const DETAIL_FIELDS = [
  ...
  'badge',
  'variations',
  'weight',
  'warrantyDescription',
  'warrantyDescriptionRaw',
] as const;
```

---

### 4.6 Table Columns, `SAD-358` Expand Integration, Sorting & Export (`columns.tsx`, `CellExpandModal.tsx`, `AmazonProductTable.tsx`, `product-sorter.ts`, `export/types.ts`)

**`src/entrypoints/sidepanel/components/CellExpandModal.tsx` (type-aware `variations` body inside `renderModalBody`):**
```tsx
  if (columnId === 'variations') {
    const rawStr = typeof value === 'string' ? value : String(value ?? '');
    const parsedMatch = /^(\d+)\s*\((.+)\)$/.exec(rawStr.trim());
    if (parsedMatch) {
      const count = parsedMatch[1]!;
      const innerBody = parsedMatch[2]!;
      const dimParts = innerBody
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const hasDimensionColons = dimParts.some((part) => part.includes(':'));
      if (hasDimensionColons) {
        return (
          <div className="space-y-3" data-testid="cell-expand-variations-list">
            <span className="inline-block px-2 py-0.5 rounded-sm bg-surface-card border border-hairline-soft font-mono text-xs text-ink font-medium">
              {count} total variations
            </span>
            <ul className="list-disc list-inside space-y-1.5 font-sans text-sm text-ink leading-relaxed">
              {dimParts.map((part, idx) => {
                const colonIdx = part.indexOf(':');
                if (colonIdx <= 0) {
                  return (
                    <li key={idx} className="break-words">
                      {part}
                    </li>
                  );
                }
                const dimName = part.slice(0, colonIdx).trim();
                const dimValues = part.slice(colonIdx + 1).trim();
                return (
                  <li key={idx} className="break-words">
                    <span className="font-semibold">{dimName}:</span>{' '}
                    <span>{dimValues}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      }
    }
    return (
      <p className="font-sans text-sm text-ink break-words whitespace-pre-wrap leading-relaxed">
        {rawStr}
      </p>
    );
  }
```

**`src/engines/amazon/ui/table/columns.tsx` (`variationsColumn` with `ExpandableCell` + crisp `weightColumn`):**
```tsx
const variationsColumn = columnHelper.accessor('variations', {
  header: 'Variations',
  cell: (info) => {
    const variations = info.getValue();
    if (!variations) return null;
    const meta = info.table.options.meta as
      | { onExpand?: (p: ExpandedCellPayload) => void }
      | undefined;
    const inner = (
      <span
        className="font-sans text-xs text-ink line-clamp-1"
        title={variations}
        data-testid={`product-variations-${info.row.original.asin}`}
      >
        {variations}
      </span>
    );
    if (!meta?.onExpand) return inner;
    return (
      <ExpandableCell
        label="Variations"
        columnId="variations"
        value={variations}
        product={info.row.original}
        onExpand={meta.onExpand}
      >
        {inner}
      </ExpandableCell>
    );
  },
  size: 180,
  minSize: 120,
  maxSize: 320,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});

const weightColumn = columnHelper.accessor('weight', {
  header: 'Weight',
  cell: (info) => {
    const weight = info.getValue();
    if (!weight) return null;
    return (
      <span
        className="font-mono text-xs text-ink whitespace-nowrap tabular-nums"
        title={weight}
        data-testid={`product-weight-${info.row.original.asin}`}
      >
        {weight}
      </span>
    );
  },
  size: 96,
  minSize: 76,
  maxSize: 150,
  enableSorting: true,
  sortFn: sortFn_alphanumeric,
});
```

---

## 5. Step-by-Step Execution Sequence & Full Regression Plan

Following the repository's multi-step commit discipline (`SAD-349` / `SAD-351` / `SAD-352` / `SAD-358`):

1. **Step 1 — Core Schema, Scraper, Merge Gates, Sorting, Table (`ExpandableCell` + `CellExpandModal`), Settings & Export Integration:**
   - Implement edits in files `#1`–`#19` and update pinned assertions in the 4 contract suites:
     1. `tests/enrich-saved-product.test.ts` (`lines 435–475`): include `variations` & `weight` on `full` row and assert both in bare-row `missingDetailFields`.
     2. `tests/table-v9-contract.test.tsx` (`lines 86–128, 197–221`): add `'variations'`, `'weight'` to `DEFAULT_COLUMN_IDS`, `COLUMN_SIZING` (`variations: [180, 120, 320]`, `weight: [96, 76, 150]`), and `turnedOff`.
     3. `tests/scraper-accuracy.test.tsx` (`lines 451–570`): update `DEFAULT_ENABLED_FIELDS`, `DEFAULT_VISIBLE_COLUMNS`, and default column count (`27` → `29`).
     4. `tests/warranty-description.test.tsx` (`lines 380, 461–476, 565–580`): update toggle length (`24` → `26`) and add `variations: true, weight: true` on explicit `EnabledFieldsConfig` literals.
2. **Step 2 — Comprehensive Regression & Feature Test Suite (`tests/variations-weight.test.tsx`):**
   - Unit tests for `normalizeWeightValue`, `formatVariationDimensionsSummary`, `parseSortableWeightGrams`, `parseSortableVariationCount`.
   - Real 2026 HTML fixtures for PDP (`twister-js-init-dpx-data` multi-dim, `twister-js-init-dpx-data` singleton guard, inline twister DOM, classic `#twister`, book `#tmmSwatches`, 2026 expander `prodDetTable`, `detailBullets` bidi marks, `Package Weight` fallback, semicolon `Product Dimensions`, A+ `<td><strong>Weight</strong></td>` spec grid, `#similarities_feature_div` exclusion) and Search/Category cards (swatches + `+N other colors/patterns`, `0`-circle overflow, singleton swatch, `Global Recycled Standard` non-match).
   - End-to-end persistence & merge tests across `dedup.ts`, `db/products.ts`, `db/quick-save.ts`, `enrichSavedProduct` (search swatch upgraded by PDP twister, `null` never erases, `collectMissingDetailFields` includes `variations` & `weight`).
   - UI tests for `AmazonProductTable` empty-cell blank rendering (`SAD-348`), hover/click `ExpandableCell` opening `CellExpandModal` with per-dimension list & zero dead affordances on empty cells (`SAD-358`), mass/count sorting, global filter matching, `SettingsOverlay` toggles, and full CSV / Clipboard TSV / XLSX round-trips.
3. **Step 3 — Documentation & Changelog Sync (`README.md`, `ARCHITECTURE.md`, `spec/10-amazon-selectors.md`, `CHANGELOG.md`).**
4. **Step 4 — Full Verification Gate:**
   ```bash
   npx tsc --noEmit
   npx vitest run
   node scripts/check-dead-exports.mjs
   npx wxt build
   git status
   ```
   Target: **0 TypeScript errors**, **87/87 test files passing**, **0 dead exports**, clean `dist/chrome-mv3/` build, and `16/16` passing in `tests/docs-consistency.test.ts`.
