# SAD-349 — Plan Only: "Warranty Description" field (scrape → UI → exports)

> **Status: PLAN ONLY — no application code changed.**
> Issue: https://linear.app/sad-mod/issue/SAD-349/warranty-description
> *"Add a new field named "Warranty Description" to the extension and implement the
> functionality to scrape the corresponding information from product pages. For example,
> the extracted value could be "1-year". Ensure the extracted data is displayed correctly
> in the UI and included in all relevant exports. Follow the existing architecture and
> coding conventions, preserve existing functionality, and avoid unnecessary changes to
> unrelated code."*
> Priority 1 · Label `Feature` · Project PPHunt · State In Progress.
> Repository state analysed: `8fa85da` (main).

---

## 0. Baseline — measured in this sandbox, not assumed

| Check | Command | Result |
|---|---|---|
| Install | `npm install --no-audit --no-fund` | OK, 606 packages, `wxt prepare` clean |
| Typecheck | `npx tsc --noEmit` | **clean** |
| Tests (cold, no `dist/`) | `npx vitest run` | **883 passed / 82 files passed**, 1 file failed |
| The 1 failure | `tests/manifest-permissions.test.ts` | `ENOENT dist/chrome-mv3/manifest.json` — it is a `describe.skipIf(!existsSync(manifestPath))` suite that needs a build first |
| Build | `npx wxt build` | OK, 1.89 MB |
| That suite after build | `npx vitest run tests/manifest-permissions.test.ts` | **11 passed** |

So the true baseline is **894 tests across 83 files** (883 + the 11 gated ones), which
reconciles exactly with the `83 files / 894 tests` figure in `docs/plans/SAD-348-...md`.
This is the same pre-existing condition SAD-330 §1.1 recorded. **Any plan step must
restore 894 passing, not 883.**

---

## 1. Decisions taken (from clarifying questions — not guessed)

| Question | Decision |
|---|---|
| Which engines? | **Amazon only.** No Temu changes at all. |
| Where does the value come from? | **Structured detail tables only** (strictest). No `#feature-bullets` fallback, no description-block scan. |
| Settings integration | **A per-field toggle in Settings → DATA FIELDS, default ON** (SAD-333 precedent for PDP-only fields). |
| What is stored/exported | **Both**: the compact token (`1-year`, `90-day`, `lifetime`) **and** the verbatim text, so nothing scraped is lost. |
| Missing value | **`No`** in the table and in every export (matches Discount/Deal/Coupon/Badge). |
| Label languages | **English only** in v1; one exported regex is the single extension point. |
| Git flow | One commit per step, pushed straight to `main` (matches the SAD-348 history). |

### 1.1 Why "Amazon only" is the correct reading of "the extension"

Verified, not assumed:

- Temu's selector registry has **no warranty landmark at all**. `TEMU_SELECTORS`
  (`src/engines/temu/scraper/selectors.ts`) has only `listing` and `productDetail`
  groups, and `productDetail` contains exactly 9 keys — `rootContainer`, `title`,
  `priceContainer`, `sellingPrice`, `listPrice`, `discountPercentage`,
  `reviewContainer`, `heroImage`, `breadcrumb`. There is no spec/details table concept.
- Temu has **no PDP enrichment path**. `src/engines/temu/background/handler.ts` has no
  analogue of `enrich-saved-product.ts` / `enrichment-fetch.ts` / `offscreen.ts`
  (those exist only under `src/engines/amazon/background/` and `.../offscreen/`).
- Temu's column visibility is driven by a different mechanism entirely
  (`defaultExportColumns: string[]` in `src/engines/temu/constants/defaults.ts`, not an
  `enabledFields` record), so "mirror the Amazon change" is not a mechanical copy.

A Temu warranty column would therefore be permanently empty — surface area with no data
behind it. **§6 lists Temu as explicitly out of scope.**

---

## 2. Verified current state of the codebase

### 2.1 Where the code lives (important: `src/lib/**` are re-export shims)

`src/engines/amazon/**` is the canonical source. `src/lib/**` and several
`src/entrypoints/sidepanel/**` files are thin re-export barrels:

```
src/types/product.ts               → export type { AmazonProduct, … } from '@/engines/amazon/types'
src/lib/export/csv.ts              → re-exports buildAmazonCSVContent, import DEFAULT_VISIBLE_COLUMNS from '@/engines/amazon/export/types'
src/entrypoints/sidepanel/table/ProductTable.tsx  → re-exports AmazonProductTable
src/entrypoints/sidepanel/table/columns.tsx       → re-exports columns, getColumnsForSettings
src/entrypoints/sidepanel/components/SettingsOverlay.tsx → re-exports SettingsOverlay
src/entrypoints/sidepanel/components/CollectTab.tsx      → re-exports CollectTab
```

**Consequence: every change below is made in `src/engines/amazon/**` only.** Editing
`src/lib/**` would be wrong. `node scripts/check-dead-exports.mjs` currently reports
*"all src/lib exports have consumers (42 files scanned)"* — this stays true because no
`src/lib` export is added or removed.

### 2.2 "Warranty" exists nowhere in the code today

```
$ grep -rni warranty src/ tests/ spec/ ARCHITECTURE.md CHANGELOG.md README.md
docs/plans/SAD-330-right-click-pdp-preview-audit.md:125:  … model number, date first available, warranty, return policy …
```

One prose hit, zero code hits. `docs/plans/SAD-330-...md` §3.2 already classifies
warranty as *"not in `ScrapedAmazonProduct`, not parsed, not stored, and have no
column"*, and calls surfacing it *"a schema expansion, not a bug fix"*. **SAD-349 is
exactly that expansion.** So there is no partial implementation to reconcile with.

### 2.3 The field pipeline, with the nine whitelists that decide whether a field survives

A new product field is dropped silently unless it is added at each of these gates.
This is the core risk of the ticket and the reason for the step-by-step in §5.

| # | Gate | File : anchor | What happens if skipped |
|---|---|---|---|
| G1 | TS interface | `src/engines/amazon/types/product.ts:31-33` (`description?`, `features?`) | compile error |
| G2 | Zod schema | `src/engines/amazon/schemas/product.ts:43-45` | `ScrapedProductSchema.safeParse` strips the key → **silently never stored** |
| G3 | Normalizer whitelist | `src/engines/amazon/scraper/field-parsers.ts:1379-1440` (`validateAndNormalizeScrapedProduct`) | key is dropped from the `normalized` object → **never leaves the parser** |
| G4 | Listing merge | `src/engines/amazon/scraper/dedup.ts:13-30` (`MERGEABLE_NULLABLE_FIELDS`) | lost when a duplicate ASIN is merged |
| G5 | Session re-collect fill | `src/engines/amazon/db/products.ts:13-30` (`nullableKeys`) | a later pass over the same ASIN cannot backfill it |
| G6 | One-click enrichment merge | `src/engines/amazon/background/enrich-saved-product.ts:29-47` (`DETAIL_FIELDS`) | **right-click save fetches the PDP, parses the warranty, then throws it away** |
| G7 | Settings toggle type | `src/engines/amazon/types/index.ts:147-148` (`EnabledFieldsConfig`) | no toggle |
| G8 | Settings toggle schema + default | `src/engines/amazon/schemas/settings.ts:43-44`, `src/engines/amazon/constants/defaults.ts:53-54` | toggle not persisted / not defaulted |
| G9 | Table + export surfaces | `ui/table/columns.tsx`, `export/types.ts`, `ui/components/SettingsOverlay.tsx` | not displayed / not exported |

G2/G3/G6 are the three that fail **silently**, which is exactly the failure mode
SAD-330 was filed for. They are the ones the tests in §7 must pin.

### 2.4 Two tests hard-pin the column set and WILL fail — by design

Both are contract tests, deliberately written to break on a column change. Extending
them is part of the work, not a regression:

1. **`tests/table-v9-contract.test.tsx`**
   - `LEGACY_COLUMN_IDS` (L58-83) — the pre-SAD-333 order, frozen.
   - `DEFAULT_COLUMN_IDS` (L86-90) — `LEGACY.slice(0,-1) + ['description','features','source']`.
   - `COLUMN_SIZING` (L94-121) — exact `[size, minSize, maxSize]` per column; the test
     throws `no recorded sizing for ${id}` for an unknown column.
   - `BASIC_SORT_IDS` (L123-130) — everything not listed must be `sortFn_alphanumeric`.
   - *"toggling each enabledFields key off removes exactly that column"* — iterates
     `Object.keys(DEFAULT_ENABLED_FIELDS)`, so a new key is automatically covered.
   - SAD-333 is the precedent for how to extend it: append before `'source'`.

2. **`tests/scraper-accuracy.test.tsx`** — **three** pins, not the two this plan
   originally listed. The third was found during Step 4 and is corrected here:
   - **L451 `expect(defaults.enabledFields).toEqual({ …23 exact keys… })`** — an exact
     object literal. Adding any `enabledFields` key breaks it immediately, i.e. at
     Step 4, before any column changes. *The original audit missed this one; it is
     recorded so the next field addition does not.*
   - L477-503 `expect(DEFAULT_VISIBLE_COLUMNS).toEqual([...25 exact headers...])`.
   - L510-511 `expect(columns).toHaveLength(26)` / `getColumnsForSettings(...) → 26`.
   - L528 `expect(getColumnsForSettings(bothOff)).toHaveLength(24)`.

**Audited and confirmed safe (no change needed)** — every other `enabledFields`
assertion in the suite is relative, not absolute (re-checked with
`grep -rn "enabledFields).toEqual\|enabledFields).toStrictEqual\|enabledFields: {" tests/`):
`tests/export-collection.test.ts:153` spreads `getExportColumnsFromSettings(...)`;
`tests/settings-consumption.test.tsx:231` derives from `SettingsSchema.parse({})`;
`tests/quick-save-settings-schema.test.ts:77` uses `toEqual(before.enabledFields)`;
`tests/settings-rapid-edits.test.tsx` uses `toMatchObject`;
`tests/settings-degradation.test.tsx` passes `enabledFields: {}` and reads one key.

### 2.5 No database migration is required (verified)

- `src/engines/amazon/db/database.ts` declares `products: '++id, asin, sessionKey, collectedAt, [sessionKey+asin]'`.
  Descriptive fields are **not indexed**, so a new non-indexed property needs **no
  `this.version(3)`**. Old rows simply lack the key → `undefined`.
- `CURRENT_SETTINGS_VERSION` stays at `1`. `upgradeStoredSettings()` exists only to flip
  a *stored* `false` → `true` for `description`/`features` (SAD-334). A brand-new key is
  filled by `parseStoredSettings()`:
  ```ts
  enabledFields: { ...DEFAULT_ENABLED_FIELDS, ...(record.enabledFields ?? {}) }
  ```
  An existing install therefore gets `warrantyDescription: true` on the very next read,
  with **no version bump and no migration code**. Bumping the version would be the
  unnecessary change here.

### 2.6 Snapshots: warranty does NOT go in (verified precedent)

`snapshotFromProduct()` (`src/engines/amazon/db/quick-save.ts:326-348`) emits a fixed
key list — `price, listPrice, discountPercentage, currency, rating, reviewCount,
bestSellersRank, availability, coupon, dealBadge, delivery`. A grep of that function for
`description|features` returns **0 matches**: descriptive PDP fields are deliberately
absent from `ProductSnapshot`. Warranty is descriptive, so it follows the same rule.
**This is what keeps `ProductSnapshot`, the Dexie `snapshots` store and
`tests/snapshot-store-migration.test.ts` completely untouched.**

---

## 3. Research: where warranty actually lives on an Amazon PDP

### 3.1 The field name is Amazon's own, and the example value matches a real render

`Warranty Description` is a real Amazon **seller-feed field**, not the ticket author's
invention — Seller Central, *Safety & Compliance → Warranty Description* (Manny_Amazon):

> "Manufacturer warranties (like **"1-year manufacturer warranty on parts and labor"**),
> extended warranties you're providing, specific warranty terms for defects…"

And that field renders on the consumer PDP inside **Product information**. Amazon.in
Seller Central forum, *"Warranty Description on listing inaccurate"* (Dec 2025):

> "…there is a section under **Product Information** that states **'Warranty Description
> 2 year manufacturer'**."

That single quote confirms, at once: (a) the on-page label is literally
`Warranty Description`, (b) it sits in the Product information block, and (c) the raw
value shape is `2 year manufacturer` — i.e. **a duration followed by a qualifier**, which
is precisely why the ticket's example is the bare token `1-year`.

### 3.2 The container shapes the parser must handle

The Product information block is not one widget — it is four different DOM shapes
depending on category and marketplace age. All four are already referenced by this
repo's own selector registry (`src/engines/amazon/scraper/selectors.ts:110-116`, the
`detail.bsr` list), which is the strongest evidence they are the right containers:

| Shape | Container | Row structure |
|---|---|---|
| Legacy tech-spec table | `#productDetails_techSpec_section_1`, `_section_2` | `<tr><th class="…prodDetSectionEntry">Label</th><td class="…prodDetAttrValue">Value</td></tr>` |
| Detail-bullets table | `#productDetails_detailBullets_sections1`, `#productDetails_db_sections` | `<tr><th>Label</th><td>Value</td></tr>` |
| Detail-bullets list | `#detailBulletsWrapper_feature_div` | `<li><span class="a-text-bold">Label:</span> Value</li>` |
| Product overview | `#productOverview_feature_div` | `<tr class="po-<attr>"><td>Label</td><td><span class="po-break-word">Value</span></td></tr>` |
| Wrapper of all of them | `#prodDetails`, `#productDetails_feature_div` | any of the above nested |

The list shape is why `normalizeWhitespace` matters: `src/engines/amazon/scraper/field-parsers.ts:52-58`
already strips `\u00A0 \u202F \u2007 \u200B-\u200F \u202A-\u202E`, and `\u200E` (LRM) is
the character that famously corrupts `#detailBullets` values. **It is already handled —
reuse the helper, do not re-implement it.**

### 3.3 The boilerplate trap (the one way this feature can ship garbage)

Every Amazon.com PDP has a **Warranty & Support** block whose content is a link, not data:

> "Warranty & Support — **Product Warranty:** For warranty information about this
> product, please click here"

A naive `label.includes('warranty') → take text` parser stores that sentence for
essentially **every** product on amazon.com. This is the single most important
correctness requirement of the ticket.

**It is neutralized structurally rather than by a blocklist:** the normalizer in §4.2
returns `null` unless it finds a *duration token*. The boilerplate contains no number and
no duration unit, so it yields `null` for free — no denylist to maintain, and no risk of
a new boilerplate variant slipping through.

### 3.4 Confirmed raw value shapes the normalizer must absorb

| Raw (source) | → canonical |
|---|---|
| `2 year manufacturer` (Amazon.in Product information) | `2-year` |
| `1-year manufacturer warranty on parts and labor` (Seller Central field guidance) | `1-year` |
| `1 Year Warranty` / `1 year` | `1-year` |
| `One-Year Limited Warranty` | `1-year` |
| `90-Day Limited Warranty` | `90-day` |
| `Two-Year Limited Warranty` / `Worry-Free Guarantee (Two-Year…)` | `2-year` |
| `For warranty information about this product, please click here` | `null` |

### 3.5 What could NOT be verified, stated plainly

- **No live PDP was fetched.** `curl https://www.amazon.com/dp/B08N5WRWNW` from this
  sandbox returned **HTTP 404, 1147 bytes** — Amazon's bot interstitial. This is the same
  block `docs/plans/SAD-338-enrichment-spike.md` §1 records for Node *and* for a real
  Chromium 131 under Playwright, and the same 404/503 the SAD-330 audit logged. **A
  selector verified against the live DOM from here is not obtainable**, and the plan does
  not pretend otherwise. Selector correctness is therefore pinned by fixture tests
  (§7.1) built from the documented shapes in §3.2, plus the manual pass in §8.
- **Localized labels were not verified.** The extension matches 23 marketplaces
  (`AMAZON_MARKETPLACE_DOMAINS`, `src/engines/amazon/utils/amazon-url.ts:7-31`) but I
  found verified evidence only for the English label forms. Shipping invented
  translations would be guessing. See the review gate in §4.1.

---

## 4. Design

### 4.1 Naming and label matching

- **Property key:** `warrantyDescription` (mirrors Amazon's field name and the ticket title).
- **Export header:** `Warranty Description` — export headers already carry multi-word
  names (`Best Sellers Rank`, `Monthly Sales`, `Collected At`).
- **Table column header:** `Warranty` — at ~110 px, "Warranty Description" would wrap.
  Trivially reversible; flagged as a review gate.
- **Label pattern** (one exported constant in `selectors.ts`, English-only in v1):

```ts
/** SAD-349: labels under which Amazon publishes the warranty period.
 *  English-only on purpose — see docs/plans/SAD-349-…md §3.5. */
export const AMAZON_WARRANTY_LABEL_PATTERN =
  /^(product\s+)?warranty(\s*(description|&|and|policy|type|period|coverage|information))?\s*:?$/i;
```

Anchored on the whole label so a row named e.g. `Warranty Provider` cannot be mistaken
for the duration row unless it is the only match — and, critically, the value must still
contain a duration token (§4.2) to be accepted, so even a mis-labelled row cannot inject
prose.

> **Review gate A.** v1 matches English labels only, so `amazon.de/.fr/.it/.es/.pl/.se/.nl/.tr/.jp/.cn`
> will return blank. Extending it means adding verified translations to that one regex —
> no structural change. Say the word and I will research the localized labels properly
> rather than guessing them.

### 4.2 Normalization spec (the whole of the new logic)

One new pure function in `field-parsers.ts`, next to `cleanSeller` / `cleanAvailability`:

```
normalizeWarrantyDescription(raw) → string | null
```

1. `normalizeWhitespace(raw)`; empty → `null`.
2. **Lifetime check** (before the duration scan, so "limited lifetime warranty" is not
   lost): matches `/\blifetime\b/i` → return `'lifetime'`.
3. **Duration scan** — first match of `<quantity> <unit>` where
   - quantity: `\d+` **or** a spelled number
     `one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[- ]four|thirty|sixty|ninety`
   - unit: `year|years|yr|yrs` → `year` · `month|months|mo|mos` → `month` ·
     `day|days` → `day` · `week|weeks` → `week`
   - the two may be separated by at most one word (`"2 year"`, `"one-year"`, `"90 days"`).
   → return `` `${n}-${unit}` `` with the **singular** unit. This reproduces the ticket's
   `1-year` example exactly and sorts correctly in a spreadsheet.
4. Anything else — including the §3.3 boilerplate, `"Manufacturer warranty"`,
   `"See description"`, `"Contact seller"` — → `null`.

Deliberate consequences, all stated so they are decisions rather than surprises:
- **First duration wins.** A pathological value like `"90 days from shipment or the
  remainder of the warranty period"` yields `90-day`. Acceptable for a table row value;
  documented in the JSDoc.
- **No duration ⇒ no output.** The field is blank rather than prose. This is what makes
  §3.3 safe by construction.
- The qualifier (`manufacturer`, `parts and labor`) is **discarded**. This is the
  tradeoff you accepted when choosing the compact form. See review gate B.

> **Review gate B.** Storing only `1-year` means "1-year manufacturer warranty on parts
> and labor" and "1-year seller warranty" become indistinguishable, and the raw text is
> not recoverable. If that matters, the minimal alternative is to keep the field verbatim
> and normalize at *export* time only. One-line change in `EXPORT_COLUMNS`; everything
> else in this plan is identical.

### 4.3 Extraction

New `extractDetailWarranty(doc)` in `product-detail.ts`, modelled line-for-line on the
existing `extractDetailBsr(doc)` (starts L188) — the house pattern for "find a labelled
row in the detail tables":

```
for each container selector in AMAZON_SELECTORS.detail.warrantyContainers:
    skip if isInsideExcludedDetailSubtree(container)
    walk its rows (both th/td and span.a-text-bold shapes, plus po-* rows)
    if label matches AMAZON_WARRANTY_LABEL_PATTERN:
        value = normalizeWarrantyDescription(valueText)
        if value → return value          // first real duration wins
return undefined
```

Row-walking is one small local helper because three of the four shapes are `th/td` and
one is `li > span.a-text-bold`. It stays private to `product-detail.ts` (not exported),
so `scripts/check-dead-exports.mjs` and the `src/lib` surface are unaffected.

`AMAZON_SELECTORS.detail.warrantyContainers` is added next to `detail.bsr`
(`selectors.ts:110`), reusing the same container list plus the two the BSR list omits:

```ts
warrantyContainers: [
  '#productDetails_techSpec_section_1',
  '#productDetails_techSpec_section_2',
  '#productDetails_detailBullets_sections1',
  '#productDetails_db_sections',
  '#detailBulletsWrapper_feature_div',
  '#productOverview_feature_div',
  '#prodDetails',
],
```

### 4.4 Empty-value rendering (aligned with SAD-348's final state)

SAD-348's closing note settled this: optional descriptive fields render **blank**
(`return null`); only Discount/Deal/Coupon/Badge render `No`. Warranty is descriptive,
like `delivery`/`brand`/`availability` → **blank in the table, `''` in every export**.
The export side needs no code for this: a plain property accessor goes through the
existing `raw == null ? '' : String(raw)` (`export/csv.ts:49`, `export/clipboard.ts:31`)
and `value ?? ''` (`export/excel.ts:459`).

> **Review gate C.** If you would rather warranty showed `No` when absent (matching
> Discount/Deal/Coupon/Badge), it is a one-line cell change plus a `|| 'No'` function
> accessor in `EXPORT_COLUMNS`.

### 4.5 Placement

Warranty joins the **PDP-only cluster** established by SAD-333, immediately after
`features` and before `source`, in all four ordered lists. Keeping the cluster contiguous
is what makes the contract-test diffs minimal and predictable.

| Surface | Becomes |
|---|---|
| Table columns | `… url, description, features, warrantyDescription, source` |
| `DEFAULT_VISIBLE_COLUMNS` | `… 'URL', 'Description', 'Features', 'Warranty Description', 'Source', 'Collected At'` |

---

## 5. Implementation steps (smallest sufficient diff, Amazon only)

**Step 1 — Data model (G1, G2).**
- `src/engines/amazon/types/product.ts` — after `features?: string[];` (L32) add
  `warrantyDescription?: string | null;`.
- `src/engines/amazon/schemas/product.ts` — after `features` (L44) add
  `warrantyDescription: z.string().nullable().optional(),`.
  **No `.default(null)`** — matching `listPrice`/`coupon`/`delivery`, so an absent key
  stays absent and snapshot shapes stay clean (per the interface's own doc comment:
  *"Optional deal/BSR keys are omitted when absent so snapshot shapes remain clean"*).

**Step 2 — Scraper (G3 + §4.2 + §4.3).**
- `selectors.ts`: add `AMAZON_WARRANTY_LABEL_PATTERN` (§4.1) and
  `detail.warrantyContainers` (§4.3).
- `field-parsers.ts`: add `normalizeWarrantyDescription` (§4.2) next to `cleanSeller`
  (L221-233). Add the key to the normalizer's optional block, in the
  `if (raw.coupon) { … }` style (after L1421, `badge`):
  ```ts
  if (raw.warrantyDescription) {
    normalized.warrantyDescription = raw.warrantyDescription;
  }
  ```
- `product-detail.ts`: add `extractDetailWarranty` (modelled on `extractDetailBsr`),
  call it beside the BSR call (L495-496), and add to the optional-candidate block
  (after L539, `coupon`):
  ```ts
  if (warrantyDescription !== undefined) candidate.warrantyDescription = warrantyDescription;
  ```
- **Do not touch** `search-results.ts:124-125` or `category-page.ts:175-176`. Cards have
  no warranty; like `description`/`features` the key is simply omitted, which is the
  intended "listing cannot provide this" signal.

**Step 3 — Merge paths (G4, G5, G6).** One line each, appended to the existing lists:
- `scraper/dedup.ts` `MERGEABLE_NULLABLE_FIELDS` (after `'description'`, L29).
  Justified, not speculative: collecting *on a PDP* routes through
  `parseAmazonProductDetail` → `AmazonDeduplicationEngine`
  (`src/entrypoints/amazon.content.ts`, `extractCurrentPageProducts`), so the value can
  be on the merge path today.
- `db/products.ts` `nullableKeys` (after `'description'`, L29).
- `background/enrich-saved-product.ts` `DETAIL_FIELDS` (after `'description'`, L40).
  **This is the highest-value line in the ticket** — without it a right-click save
  fetches and parses the PDP warranty and then discards it.
  **Not** in `FILL_ONLY_FIELDS` (L54): the PDP is authoritative for this field and it
  is not part of the price family.

**Step 4 — Settings toggle (G7, G8).** One line each:
- `types/index.ts` `EnabledFieldsConfig` (after L148) — `warrantyDescription: boolean;`
- `schemas/settings.ts` `EnabledFieldsSchema` (after L44) —
  `warrantyDescription: z.boolean().default(true),`
- `constants/defaults.ts` `DEFAULT_ENABLED_FIELDS` (after L54) —
  `warrantyDescription: true,`
- **No** `CURRENT_SETTINGS_VERSION` bump, **no** `upgradeStoredSettings` change (§2.5).

**Step 5 — Table column (G9).** In `ui/table/columns.tsx`:
- New `warrantyDescriptionColumn` accessor after `featuresColumn` (L631-652), cloning the
  `descriptionColumn` cell shape (`return null` when empty, `line-clamp-1`,
  `title={value}`, `data-testid={`product-warranty-${asin}`}`).
  `size: 110, minSize: 90, maxSize: 160`, `enableSorting: true`, `sortFn: sortFn_alphanumeric`
  (required — the contract test asserts every non-basic column is alphanumeric).
- Push into `amazonColumns` after `featuresColumn` (L709).
- In `getAmazonColumnsForSettings`, after L752:
  `if (enabledFields.warrantyDescription) active.push(warrantyDescriptionColumn);`
  (truthy check, exactly like `description`/`features` — SAD-333 style).
- `SettingsOverlay.tsx` `FIELD_LABELS` (after L409):
  `warrantyDescription: 'Warranty Description',`.
  (Without this the overlay's camelCase-fallback renderer shows
  "Warranty Description" anyway, but adding it is 1 line and matches the 23 existing
  explicit labels.)

**Step 6 — Exports (G9).** In `export/types.ts`:
- `EXPORT_COLUMNS` after `Features` (L81): `'Warranty Description': 'warrantyDescription',`
  — a **plain property accessor**, so `''`-when-missing is free (§4.4).
- `FIELD_KEY_TO_HEADER` after `features` (L137): `warrantyDescription: 'Warranty Description',`
- `DEFAULT_VISIBLE_COLUMNS` after `'Features'` (L179): `'Warranty Description',`
- `getExportColumnsFromSettings` after L220:
  `if (enabledFields.warrantyDescription) columns.push('Warranty Description');`

`export/csv.ts`, `export/excel.ts`, `export/clipboard.ts` need **no changes** — all three
resolve columns through `resolveExportColumns` + `EXPORT_COLUMNS`.

**Step 7 — Extend the two contract tests (§2.4), following the SAD-333 precedent.**
- `tests/table-v9-contract.test.tsx`: append `'warrantyDescription'` to
  `DEFAULT_COLUMN_IDS` (L86-90, before `'source'`) and
  `warrantyDescription: [110, 90, 160]` to `COLUMN_SIZING` (L94-120).
  `LEGACY_COLUMN_IDS` and `BASIC_SORT_IDS` are **not** touched — they are frozen history.
- `tests/scraper-accuracy.test.tsx`: add `'Warranty Description'` to the
  `DEFAULT_VISIBLE_COLUMNS` expectation (L477-503, after `'Features'`); update
  `26 → 27` at L510/L511/L519 and `24 → 25` at L528. Update the adjacent comment so it
  still explains the arithmetic.

**Step 8 — New tests (§7), then verify (§8).**

---

## 6. Explicitly NOT doing

| Not doing | Why |
|---|---|
| Any Temu change (schema, selectors, table, export, settings) | §1.1 — no data source exists; the column would be permanently empty |
| Dexie `version(3)` / `products` store change | §2.5 — descriptive fields are not indexed |
| `CURRENT_SETTINGS_VERSION` bump or `upgradeStoredSettings` change | §2.5 — the defaults merge fills a new key with no migration |
| `ProductSnapshot` / `snapshotFromProduct` / `snapshots` store change | §2.6 — `description`/`features` are absent there by design |
| `#feature-bullets` or description-block fallback extraction | Your decision: structured tables only |
| Edits to `src/lib/**` or `src/entrypoints/sidepanel/**` | §2.1 — those are re-export shims |
| `src/engines/amazon/scraper/drift-telemetry.ts` | `fieldCoverage` is a fixed 6-field drift signal (asin/title/price/rating/reviewCount/imageUrl); warranty is PDP-only and would always read 0 |
| Search/category card parsers | Cards have no warranty (§5 Step 2) |
| `formatters.ts`, sorting, filtering, search, messages, permissions, `wxt.config.ts` | Untouched by a descriptive field |
| New dependencies, new files under `src/`, new entrypoints | Nothing in the design needs them |

**Blast radius check.** The change is additive at every gate: a new optional interface
key, a new optional Zod key, a new `if (raw.x)` branch, four one-line list appends, one
new column definition, four one-line export/settings appends. No existing branch, list
entry or function signature is modified. Existing rows lack the key → `undefined` →
blank cell / `''` export, which is the already-tested empty-field path.

---

## 7. Tests

**7.1 New file `tests/warranty-description.test.ts`** (the only new test file):

- `normalizeWarrantyDescription` — table-driven over every row of §3.4, plus:
  the §3.3 boilerplate → `null`; `''`/whitespace → `null`; `"Manufacturer warranty"`
  (no duration) → `null`; `"Lifetime limited warranty"` → `'lifetime'`;
  `"Two-Year Limited Warranty"` → `'2-year'`; `"90 days"` → `'90-day'`;
  `"3 Month"` → `'3-month'`; a value carrying `\u200E` → normalized correctly
  (pins the reuse of `normalizeWhitespace`, §3.2).
- `parseAmazonProductDetail` against four inline fixtures, one per §3.2 shape
  (tech-spec `th/td`, detail-bullets table, `span.a-text-bold` list, `po-*` overview),
  each asserting the parsed product carries `warrantyDescription: '2-year'`.
- **The boilerplate fixture**: a PDP whose only warranty row is the "click here"
  sentence → `warrantyDescription` is `undefined`, not that sentence. This is the
  regression test for §3.3 and the one I would not ship without.
- A PDP with no warranty row → key absent (no fabricated value).
- `validateAndNormalizeScrapedProduct({ …, warrantyDescription: '1-year' })` preserves it
  — **this is the G3 pin**; without it the field would silently die in the parser.
- `mergeDetailIntoStored(stored, detail)` fills `warrantyDescription` and reports it in
  `fieldsChanged` — **the G6 pin**.
- `ScrapedProductSchema.safeParse` keeps the key — **the G2 pin**.

**7.2 Extend existing suites (no new files):**
- `tests/pricing-deals-bsr.test.tsx` — already renders products through `ProductTable`
  and asserts CSV/XLSX output. Add: a product with `warrantyDescription: '1-year'`
  renders `product-warranty-<ASIN>` with text `1-year` and exports the cell; a product
  without it renders an empty cell and exports `''`. This is the UI + export acceptance
  proof in one place, mirroring how SAD-348 proved its behaviour.
- `tests/enrich-saved-product.test.ts` — assert a PDP-only warranty reaches the stored
  row through the real merge (end-to-end proof of Step 3).

**7.3 Deliberately not adding** Temu tests, snapshot tests, settings-migration tests, or
message-schema tests — none of those surfaces change (§6).

---

## 8. Verification

```bash
npx tsc --noEmit                                   # must stay clean
npx vitest run tests/warranty-description.test.ts  # new suite
npx vitest run tests/table-v9-contract.test.tsx tests/scraper-accuracy.test.tsx \
                 tests/pricing-deals-bsr.test.tsx tests/enrich-saved-product.test.ts
npx wxt build                                      # must succeed first…
npx vitest run                                     # …so the gated manifest suite runs
node scripts/check-dead-exports.mjs                # must still print "all src/lib exports have consumers"
```

**Pass bar: 894 tests across 83 files, all passing** (the §0 baseline, plus the new
tests). Anything less than 83 files means `wxt build` was skipped and the manifest suite
was silently gated out.

**Manual pass — must be done by you on a residential connection.** Per
`docs/plans/SAD-338-enrichment-spike.md` §1 and my own HTTP 404 in §3.5, Amazon refuses
this sandbox, so live-DOM selector verification is not something I can honestly claim.
`scripts/browser-qa/card-flow.cjs` and the SAD-141 QA matrix (`Status: not executed`)
are the existing, still-unrun harnesses for it. Minimum: one `.com` electronics ASIN and
one `.in` ASIN (the marketplace where the `Warranty Description` row was reported),
checking the table cell, the CSV header/value, and a right-click save.

---

## 9. Acceptance criteria (mapped to the ticket)

- [ ] A PDP carrying a warranty row yields `warrantyDescription` as a canonical token
      (`1-year`, `2-year`, `90-day`, `lifetime`) — never prose.
- [ ] The Amazon boilerplate "For warranty information… click here" yields **no value**.
- [ ] The value appears in the Preview table (side panel, full-width preview modal,
      dedicated preview tab, History preview — all render through the same
      `AmazonProductTable`) with a `Warranty` header.
- [ ] The value appears in **CSV, Excel and clipboard** exports under
      `Warranty Description`, and in the one-click-save auto-download.
- [ ] A right-click "Save Product Details" enrichment lands the warranty on the stored row.
- [ ] Missing warranty renders a blank cell and exports `''` (never `—`, `null`,
      `undefined`).
- [ ] Settings → DATA FIELDS shows a "Warranty Description" toggle, default on, that
      removes the column and the export column when turned off.
- [ ] Existing installs pick the toggle up with no migration and no data loss.
- [ ] **Temu is byte-identical.**
- [ ] `tsc` clean · 894 tests / 83 files pass · `wxt build` OK · dead-export guard green.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Selector drift / never verified live** (§3.5) | Four fixture shapes from §3.2; containers reuse the repo's already-shipped `detail.bsr` list; manual pass in §8 is a hard gate, not optional |
| **Boilerplate pollution** (§3.3) | Structural: no duration token ⇒ no value. Pinned by a dedicated test |
| **Silent drop at G2/G3/G6** — the SAD-330 failure mode | Three explicit pins in §7.1, one per gate |
| **Contract-test churn** | Two files, extended exactly as SAD-333 extended them; `LEGACY_COLUMN_IDS` untouched |
| **Compact form loses the qualifier** | Review gate B; a one-line move to export-time normalization if you want the raw text kept |
| **Non-English marketplaces return blank** | Review gate A; isolated to one exported regex |
| **Temu expectations** (SAD-348 did both engines) | Decision recorded in §1/§1.1 with the evidence; §9 makes "Temu byte-identical" an acceptance criterion |

---

## 11. Review gates — ANSWERED (2026-10-20), superseding §4 where they differ

| | Question | **Decision** | Effect on §4 |
|---|---|---|---|
| **A** | English-only or localized labels? | **English-only** for v1 | §4.1 unchanged |
| **B** | Compact token, verbatim, or both? | **Both** | Two fields: `warrantyDescription` (token, displayed + exported) and `warrantyDescriptionRaw` (verbatim, preserved through every merge and exported as `Warranty Details`). The table cell shows the token with the raw text as its `title` tooltip — the existing house pattern for truncated cells. Both columns share the one `warrantyDescription` toggle, exactly as `listPrice` already pushes `'List Price', 'Discount', 'Deal'` from a single flag (`export/types.ts:196-198`). |
| **C** | Blank or `No` when missing? | **`No`** | Cell renders `<span className="text-ink-subtle">No</span>` (Discount/Deal/Coupon/Badge pattern); both export accessors become functions returning `\|\| 'No'` |
| — | Git flow | **Commit per step, pushed to `main`** | Matches `f92272d…8fa85da` |

Cosmetic defaults kept: export headers `Warranty Description` / `Warranty Details`,
table header `Warranty`, column sizing `[110, 90, 160]`.

