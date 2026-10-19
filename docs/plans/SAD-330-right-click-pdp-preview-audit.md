# SAD-330 — Right-click → detail-page extraction → storage → Preview

**As-built audit and minimal-fix recommendation.**
No application code was changed. Repository state audited: `cf78288` (main).

| | |
|---|---|
| Baseline before any change | `tsc --noEmit` clean · **796/796 tests pass** (79 files) · `wxt build` OK, 1.88 MB |
| Method | Full read of the right-click path; an instrumented harness run through **parser → enrichment merge → Dexie → table column builder** (temporary file, removed — `git status` clean); a live fetch probe against Amazon; git + Linear history |
| Ticket premise checked | SAD-136 (Done) **deliberately removed the Preview tab**. The audit respects that: no tab is proposed. |

---

## 0. Verdict — the six questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | Does right-click actually open/access the product detail page and extract additional data? | **It never opens a tab.** Two paths: (a) right-click **on a PDP** → the content script parses the live DOM; (b) right-click **on a listing card** → the background fetches the PDP over HTTP (`credentials: 'omit'`) and parses it in the offscreen document. Path (b) is real enrichment, not a mock. |
| 2 | Which fields are extracted, which are missing? | PDP parser emits **22 of the 27 modelled fields** (the other 5 are listing-only or never set by a PDP). A search card sets **14 core fields plus up to 10 optional ones** (24 max), depending on the card's markup. `description` and `features` are **hard-coded to `null` / `[]` on the card** (`search-results.ts:124-125`) — they can only ever come from the PDP. See §3 for the full matrix. |
| 3 | Is the extracted data saved? | **Yes, losslessly.** The save writes `products` + `snapshots` + a `history` row in one transaction. Verified: a card row with **10** populated fields reaches **22** after the enrichment merge, and every one is readable from Dexie. Zod strips nothing. |
| 4 | Does Preview display all saved data? | **No — 22 of the 27 modelled fields by default** (absent: Description, Features, plus the three listing-context fields that have no column at all). The table is built from `enabledFields`; **Description and Features are `false` by default and their columns are never constructed** (`defaults.ts:50-51` → `columns.tsx:747-748`). Export has the same gate (`export/types.ts:204-205`). |
| 5 | If saved but not displayed — root cause? | **A display gate, not mapping, serialization or storage.** `DEFAULT_ENABLED_FIELDS.description/features = false`, and `getAmazonColumnsForSettings()` only pushes those columns when the flag is truthy. The data is in the row the whole time. |
| 6 | If not collected/saved — where does it fail? | **Background enrichment fails or skips, silently.** `enrichmentStatus: 'failed' | 'skipped'` produces **no warning** (`save-job.ts:234-237`), the toast still says *"Saved to …"*, and the card button renders a normal *completed* state. Separately, some fields Amazon shows are **not modelled at all** (specs, dimensions, variations) — no fix can surface them. |

**One-sentence root cause:** the pipeline collects and stores the PDP data correctly; the Preview hides the two PDP-only fields behind an off-by-default setting, and when enrichment does not land, the UI gives no indication — so blank cells look like a data-loss bug.

---

## 1. What I ran (evidence, not inference)

1. **Baseline**: `npx tsc --noEmit` → clean; `npx vitest run` → 796 passed / 79 files.
   The only failing suite was `tests/manifest-permissions.test.ts`, and only because `dist/` had not been built yet; after `npx wxt build` it passes.
2. **Instrumented harness** (temporary `tests/__audit-field-matrix.test.ts`, deleted afterwards):
   - parsed a representative PDP → **22 non-null fields**;
   - parsed a minimal search card → **10 non-null fields**;
   - ran `mergeDetailIntoStored()` → **15 fields** upgraded;
   - wrote through the real `saveQuickProduct()` into fake-indexeddb → **22 non-null fields** in the stored row, **1 snapshot**;
   - built the table columns with `DEFAULT_ENABLED_FIELDS` → **24 columns**, with Description/Features absent; **26** when both flags are turned on.
3. **Live fetch probe** with the extension's own headers (`Accept: text/html…`, no cookies) from this sandbox:
   - `amazon.com/dp/B08N5WRWNW` → **404**
   - `amazon.co.uk/dp/B08N5WRWNW` → **503**
   - `amazon.com|co.uk|de /dp/B09XS7JWHH` → **200, `text/html`, ~3.7 KB**, containing `api-services-support@amazon` and "automated access" — Amazon's bot interstitial. `looksLikeChallenge()` (`enrichment-fetch.ts:143`) **does** match it, so this is correctly classified as `captcha` → `ENRICH_FETCH_FAILED`.
   - Datacenter IP caveat: a home user may receive a full PDP. But the *failure classification and silent reporting* are the same either way.
4. **Docs/tests/Linear**: `docs/plans/SAD-141-qa-matrix.md` says **"Status: not executed"** — every browser check is `TODO`. `CHANGELOG.md` repeats: *"Browser verification for SAD-141 is still pending (SAD-293)."* So no one has ever confirmed the enrichment path on live Amazon.

---

## 2. The as-built flow

### 2.1 Right-click on a **listing card**

```
contextmenu (capture)                    amazon.content.ts:582
   └─ captureSaveTarget(event)           save-target.ts:59      (TTL 5 s)
Menu item "Save Product Details"          context-menu.ts:53-63
   └─ onClicked → dispatchToAmazonTab     context-menu.ts:111-128
        └─ SAVE_CONTEXT_PRODUCT  ──────► amazon.content.ts:517-521
             └─ resolveSaveCandidate()    save-product.ts:77
                  ├─ resolveCapturedCard()      save-target.ts:158
                  └─ parseAmazonSearchCard()    search-results.ts:64
                       └─ SAVE_PRODUCT ──────► background/handler.ts:800
                            └─ handleSaveProduct()          save-job.ts:117
                                 ├─ resolveOneClickCollection → oc_<epoch> history row
                                 ├─ saveQuickProduct()      db/quick-save.ts:369
                                 │     ├─ products row  (card fields only)
                                 │     └─ snapshots row (source: 'listing')
                                 └─ enrich()                save-job.ts:210-241
                                       ├─ fetchPdpHtml()    enrichment-fetch.ts:217
                                       │     (background fetch, credentials: 'omit')
                                       ├─ parsePdpHtmlViaOffscreen()  offscreen/parse.ts:48
                                       └─ mergeDetailIntoStored()     enrich-saved-product.ts:103
                                             └─ db.products.update(row, patch)
                                                + snapshots row (source: 'detail')
```

### 2.2 Right-click on a **product-detail page**

Same chain, but `resolveSaveCandidate()` takes the PDP branch (`save-product.ts:83-94`): **the live DOM is the product**. The row is written with `source: 'detail'` and all 22 fields immediately.

**Important inefficiency:** `handleSaveProduct()` still calls `enrich()` for these saves, so the background **re-fetches the same PDP** and re-parses it. That doubles the request load on exactly the pages that most reliably trip the breaker.

### 2.3 Where the data goes in the UI

- **No Preview tab exists.** `ActiveTab = 'collect' | 'history'` (`uiStore.ts:4`), pinned by `tests/history-preview-export.test.tsx:72-78`. SAD-136 removed it deliberately.
- Preview surfaces are: `FullWidthPreviewModal` (Sidebar/Overview) and `/preview.html` (the "Tab ↗" button), both rendering `AmazonProductTable`.
- `AmazonProductTable` queries `db.products.where('sessionKey')` and renders **`getAmazonColumnsForSettings(settings.enabledFields)`** (`AmazonProductTable.tsx:125-128`).

That last line is the bottleneck.

---

## 3. Field-by-field matrix

### 3.1 Modelled fields (27 in `ScrapedProductSchema`)

Legend: **✓** populated · **—** empty/absent · **✓\*** only when the markup has it · **n/a** not applicable

| Field | Card parser | PDP parser | In stored row after enrichment | Table column exists | **On by default** |
|---|---|:--:|:--:|:--:|:--:|
| `asin`, `url`, `title` | ✓ | ✓ | ✓ | ✓ (Title/ASIN/URL) | ✓ |
| `price` | ✓\* | ✓\* | ✓ (listing wins) | ✓ | ✓ |
| `listPrice`, `discountPercentage` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `currency` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `rating`, `reviewCount` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `bestSellersRank` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `pastMonthSales` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `coupon` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `badge` | ✓\* | — (never set) | card value kept | ✓ | ✓ |
| `dealBadge` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `delivery` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| `imageUrl` | ✓ | ✓ (hi-res) | ✓ | ✓ | ✓ |
| `isSponsored` | ✓ | — (always `false`) | listing value kept | ✓ | ✓ |
| `isPrime` | ✓\* | ✓\* | ✓ (OR) | ✓ | ✓ |
| `brand` | ✓\* | ✓ | ✓ | ✓ | ✓ |
| `availability` | ✓\* | ✓\* | ✓ (fill-only) | ✓ | ✓ |
| `seller` | ✓\* | ✓\* | ✓ | ✓ | ✓ |
| **`description`** | **null, by design** | **✓** | **✓** | **✓ but not built** | **✗** |
| **`features`** | **`[]`, by design** | **✓** | **✓** | **✓ but not built** | **✗** |
| `source` | ✓ (`'search'`) | ✓ (`'detail'`) | **stays `'listing'`** after enrichment | ✓ | ✓ |
| `listingCategory`, `sectionLabel` | ✓ | — | kept | ✗ (used for grouping/filtering) | n/a |
| `placements` | ✓\* | — | kept | ✗ | n/a |

### 3.2 Fields Amazon displays that PPHunt does **not model at all**

`specifications` / technical details, dimensions, weight, material, colour, manufacturer, model number, date first available, warranty, return policy, variation matrix (size/colour ASINs), rating breakdown, "Customers say" summary, A+ content, video.

These are **not in `ScrapedAmazonProduct`, not parsed, not stored, and have no column**. If the expectation is "Amazon's Product information section should appear in Preview", that is a schema expansion, not a bug fix — and it is the one class of "missing field" that no display change can solve.

---

## 4. Root causes, ranked

### RC1 — The Preview never builds the Description/Features columns (definitive)

```ts
// constants/defaults.ts:50-51
description: false,
features: false,

// ui/table/columns.tsx:747-748
if (enabledFields.description) active.push(descriptionColumn);
if (enabledFields.features) active.push(featuresColumn);
```

`getAmazonColumnsForSettings()` receives the persisted `enabledFields`. With defaults, these two columns **do not exist in the table model at all** — they are not hidden, they are absent. The same flag gates the export columns (`export/types.ts:204-205`).

This is precisely why "the additional data collected from the PDP does not appear": **the two fields that only a PDP can provide are the two fields that are off by default.**

Verified: 24 columns with defaults; 26 with both flags on. `tests/scraper-accuracy.test.tsx:465-515` explicitly pins this behaviour (24 / 26), so it is intentional today, not an accident.

### RC2 — Enrichment failures are silent (definitive)

```ts
// save-job.ts:234-237 — only 'partial' produces a warning
if (enriched?.status === 'partial') {
  enrichmentWarning = 'Saved, but the product page had no complete details';
}
```

- `failed` → `errorCode: 'ENRICH_FETCH_FAILED'` is set, but **`warning` is undefined**.
- `skipped` (no host permission / circuit open) → **no warning at all**.
- The only user-visible feedback is the completion toast, which renders `payload.message` — *"Saved to <collection> · 1 product"* (`amazon.content.ts:211-230`).
- The card button treats `partial || warning` as a warning state (`card-action-layer.ts:184-188`); `failed`/`skipped` therefore render as a **normal completed** tick.
- Nothing in the side panel listens to `SAVE_JOB_UPDATE`, so the panel shows nothing either.

Net effect: a row with 10 populated fields and 17 blanks is presented to the user as a fully successful save.

### RC3 — Enrichment is fragile against real Amazon, and the breaker makes it worse

- `fetchPdpHtml()` uses `credentials: 'omit'`, `redirect: 'follow'`, no `Referer`; one retry only for timeout/5xx (`enrichment-fetch.ts:282-401`).
- A redirect that resolves to a **different ASIN** (common for apparel/variant parents) returns `asin-mismatch` and enrichment is abandoned — by design, to avoid corrupting the row.
- Three captchas in a row, or three 429s in a minute, open a 60 s breaker (`CIRCUIT_*` constants). While open, every save is `skipped` **without even attempting a fetch**.
- Saves made **from a PDP** still re-fetch that same PDP (§2.2), so a user saving five products from a PDP generates five redundant requests against a breaker that opens after three failures.

So on a real Amazon session it is entirely plausible to get: save #1–#3 enrich → captcha/fail; save #4+ skip → every subsequent row stays card-only. All of them look successful.

### RC4 — No provenance: the row never says "this came from the PDP"

`source` is written at insert time (`'search'`/`'category'`/`'detail'`) and **is not part of `DETAIL_FIELDS`** (`enrich-saved-product.ts:29-47`), so an enriched card row still displays **Source = `search`**. The Product-row `snapshots` (which do record `source: 'detail'`, price, availability, ratings, BSR) are **never read by any UI component** — only by export statistics, delete cascades and recovery. `grep db.snapshots src/engines/amazon/ui src/entrypoints` → **no matches**.

Consequence: even when enrichment works perfectly, nothing in Preview indicates that detail data was merged; and the detail-price observation is invisible.

### RC5 — Not all "missing" fields are collected at all

See §3.2. If the expected fields are specs/dimensions/variations, the correct diagnosis is "not modelled", not "not displayed".

### Ruled out (so the fix does not go to the wrong layer)

| Suspect | Evidence against |
|---|---|
| Zod strips unknown keys | Every PDP field is declared in `AmazonProductSchema`; `ScrapedProductSchema` only omits `id/collectedAt/sessionKey`. Harness: all 22 survived `safeParse`. |
| Wrong Dexie index / missing compound index | `products` is defined with `[sessionKey+asin]` (`database.ts:25`) and the save/enrichment lookups use it; the harness wrote and read back successfully. (Note: `ARCHITECTURE.md` claims v2 *removed* this index — the doc is wrong and acting on it would break saving.) |
| Two parallel DB trees | `src/lib/db/*` are re-export shims for `src/engines/amazon/db/*`; one database. |
| Snapshot overwrites the row | Snapshots are append-only observations; the row is merged by `mergeDetailIntoStored` with null-never-erases and fill-only price. |
| Price policy erasing detail data | Intentional: listing price wins; the detail observation is kept in `snapshots`. |

---

## 5. Mapping your observations to causes

| What you saw | Cause |
|---|---|
| "Only some fields are populated, others are empty" | **RC2/RC3** — blank cells are genuinely blank in Dexie. The card supplied ~10 fields; the PDP enrichment that should fill brand/seller/BSR/availability never landed (or `partial`). |
| "The PDP data does not appear fully in Preview" | **RC1** — Description and Features are stored but their columns are never built while the defaults are `false`. |
| "I right-clicked a product page itself and still see sparse data" | Should not happen (live DOM parse = 22 fields). If it does: the PDP genuinely lacks those nodes, or the selectors drifted (§3.1 `✓*` rows). |
| "The Source column still says search after enrichment" | **RC4** — `source` is not merged. |
| "Amazon's Product information / dimensions never appear" | **RC5** — not modelled. |
| "It said Saved, so I assumed enrichment worked" | **RC2** — there is no failure signal. |

---

## 6. Recommended smallest targeted fix

> **If you change exactly one thing:** set `DEFAULT_ENABLED_FIELDS.description = true` and `features = true`
> (`constants/defaults.ts:50-51`), mirror it in `EnabledFieldsSchema` (`schemas/settings.ts:41-42`), and add the
> one-time settings migration so existing installs inherit it. Two constants + one migration. No schema change,
> no new component, no message change, no tab. Everything else below is optional hardening.

Ordered by (value ÷ risk). Nothing below changes a tab, the SAD-136 layout, the price policy, or the schema.

### Step 0 — Confirm the diagnosis with zero code (do this first, 30 seconds)

Open **Settings → Data Fields** and enable **Description** and **Features**, then reopen the preview for a right-clicked product.
If the text appears, **RC1 is confirmed** and the data was never lost. `SettingsOverlay.tsx:383-431` already exposes the toggles and `columns.tsx:747-748` already handles them.

### Step 1 — Make the two PDP-only fields visible by default *(the actual root-cause fix)*

**Files**

| File | Change |
|---|---|
| `src/engines/amazon/constants/defaults.ts:50-51` | `description: true`, `features: true` |
| `src/engines/amazon/schemas/settings.ts:41-42` | same two defaults in `EnabledFieldsSchema` |
| `src/engines/amazon/db/settings.ts` | one-time upgrade: if the stored row still equals the **old** defaults `{description:false, features:false}`, flip both to `true` |
| `tests/scraper-accuracy.test.tsx:465-515` | update the pinned expectation 24 → 26 (deliberate, not a regression) |
| `tests/table-v9-contract.test.tsx` | add a case: default settings render Description + Features |

**Why a migration is required:** `getSettings()` returns the persisted row, and `updateSettings()` merges `{...DEFAULT_ENABLED_FIELDS, ...current.enabledFields}` (`db/settings.ts:84-88`). Changing the constant alone only affects installs with **no** settings row — every existing user keeps `false` forever.

**The migration's one honest limitation:** the schema cannot distinguish "user deliberately turned this off" from "old default off". Mitigation: add a `settingsVersion` field (default `0`), flip only when `settingsVersion < 1 && description === false && features === false`, set it to `1`, and leave the toggles user-reversible. Document it in the CHANGELOG.

**Risk:** low. Two extra 200 px columns in the preview; the table already scrolls horizontally (`tests/preview-horizontal-scroll.test.tsx`). No data path changes.

**Alternative if you do not want to change any default:** drop Step 1's default flip and instead make the empty-state explicit — a subtle "detail fields hidden — show" affordance in the preview toolbar. Same outcome, more UI work, no migration.

### Step 2 — Stop reporting failed enrichment as a clean success *(8 lines, no schema change)*

| File | Change |
|---|---|
| `background/save-job.ts:234-237` | also set `enrichmentWarning` for `enriched.status === 'skipped'` (e.g. *"Saved, but the product page was not fetched — details may be incomplete"*) and for `'failed'` with a reason derived from `errorCode` |
| `entrypoints/amazon.content.ts:211-230` | render `payload.warning` next to `payload.message` in the completion toast (the field already exists on `SAVE_JOB_UPDATE` and already drives the card's warning state) |

This is the only change that makes Step 1's blanks *explainable*: a row that says "Saved · details incomplete" is not a bug report, it is information.

`tests/save-job-enrichment.test.ts:135-141` currently asserts the opposite (*"skipped … without a warning"*); that assertion is the bug and must be inverted deliberately.

### Step 3 — Do not re-fetch a page you just read *(3 lines, optional)*

In `handleSaveProduct()` skip `enrich()` when `payload.context.pageType === 'product-detail'`, and report `enrichmentStatus: 'complete'` (the live DOM is at least as authoritative as a cookieless fetch). This removes the single largest source of redundant requests and breaker trips.

### Explicit non-goals

- **No new tab, no change to SAD-136.** Preview stays per-History-record + modal + `/preview.html`.
- **No price-policy change.** Listing price continues to win; detail values stay in `snapshots`.
- **No schema expansion** for specs/dimensions. That is a separate feature (see §3.2).
- **No SAD-332 work here** (right-click settings live in the Collect tab, `QuickSaveBehavior.tsx`); it is a separate ticket and a separate review.

---

## 7. Regression-safety plan

**Tests to add**

1. `getAmazonColumnsForSettings(DEFAULT_ENABLED_FIELDS)` contains `Description` and `Features`; header count 26.
2. Settings migration: old-default row → flipped; user-modified row (e.g. `price:false`) → untouched except the two; idempotent on second open.
3. `handleSaveProduct` with `enrich → {status:'skipped'}` emits `state:'completed'` **with** a `warning`.
4. Enrichment is not called when `context.pageType === 'product-detail'` (Step 3).
5. Existing end-to-end save tests must stay green unchanged: `save-job-pipeline`, `save-job-enrichment`, `enrich-saved-product`, `quick-save-data-layer`, `history-preview-export`, `table-v9-contract`, `preview-*`.

**Must not change**

`src/engines/temu/**` (byte-identical), the `[sessionKey+asin]` index, `mergeDetailIntoStored` semantics (null never erases, price fill-only), SAD-136 navigation, `PRODUCTS_COLLECTED`/collection pipeline.

**Manual checks** (still unrun — `SAD-141-qa-matrix.md` is 100 % `TODO`, tracked as SAD-293)

1. Search page → right-click a card → save → History → Preview: ~22 populated cells, Description/Features present.
2. Same on a PDP → no duplicate fetch, no spinner stuck.
3. Save 4 products quickly → confirm whether enrichment degrades (breaker) and that the toast now says so.
4. Delete the collection → snapshots cascade (no orphans).
5. Sidebar/Overview and `/preview.html` both show the new columns.

---

## 8. What could not be verified here

- A real Amazon session from a residential IP. The sandbox received Amazon's automated-access interstitial for every PDP (correctly classified as `captcha`), so I can state what the code does with that response but not how often a home user receives a full PDP.
- Chrome/Edge runtime behaviour of the offscreen document and `downloads` (no browser in this environment).
- Firefox (the repo builds it but declares runtime compatibility unverified).

These are exactly the rows that SAD-293 exists to fill in.

---

## 9. Appendix — adjacent findings (out of scope, worth separate tickets)

1. **Right-click capture TTL is 5 s** (`save-target.ts:17`). Chrome keeps the context menu open indefinitely; a user who reads the menu for >5 s gets *"No product found here"*. The element reference stays valid — only the page URL check is needed.
2. **`RETRY_SAVE_PRODUCT` is dead**: present in the schema and type union, but no handler and no sender anywhere in `src/`.
3. **No side-panel listener for `SAVE_JOB_UPDATE`**, so in-panel feedback for quick saves does not exist; Dexie live queries mask it for History only.
4. **Iframes**: the content script is top-frame only; a save inside a deal widget iframe always reports "No product found here" (known limitation R11 in the SAD-141 plan).
5. **Export ignores two toggles**: `getExportColumnsFromSettings()` pushes `Best Sellers Rank` and `Monthly Sales` unconditionally (`export/types.ts:193`), so disabling those fields still exports them.
6. **Export has a `Collected At` column the table does not** (and `AMAZON_DEFAULT_VISIBLE_COLUMNS` lists it although no such column definition exists in `columns.tsx`).
7. **`ARCHITECTURE.md` says database v2 "removes the unused compound product index"** — false; `products` still declares `[sessionKey+asin]` and the whole save path depends on it. Anyone "fixing" the doc-code mismatch would break saving.
8. **`CHANGELOG.md:134` says "the virtualized table lives on the Collect tab"** — it does not; the Collect tab renders no table. Preview is the modal and `/preview.html`.
9. **SAD-332** (move Right-Click Save Behavior from the Collect tab to Settings) is real: `QuickSaveBehavior.tsx` is rendered by `CollectTab.tsx:41` and `SettingsOverlay` has no equivalent section.
10. **SAD-329 / SAD-331** (card icon visuals, theme not forwarded into `createCardActionLayer`) are unrelated to data flow but touch the same right-click surface; sequence them separately.

---

## 10. Decisions taken, and the issues filed

Recorded after review with the repository owner (19 Oct 2026). The audit itself changed no code.

### Decisions

| Question | Decision |
|---|---|
| Which symptom was observed? | **Blank Brand / Seller / BSR / Availability** — i.e. RC2/RC3, enrichment failing or skipping. RC1 (hidden Description/Features) is fixed alongside it because it is independent and equally visible. |
| Display fix | **Flip `description`/`features` to `true`** and expose them. |
| Existing installs | **Versioned one-time migration** (`settingsVersion`), user-reversible. |
| Enrichment failure | **Show it in the completion toast** (no History badge). |
| PDP re-fetch | **Skip it** — trust the live DOM. |
| Reliability | Beyond surfacing failures: **a measurement spike**, no speculative header/transport changes. |
| SAD-136 | Untouched. No tab added, removed or rearranged. |
| Scope | The SAD-330 fix **plus** all ten adjacent findings, plus SAD-332 as an independent issue. |

### Filed in Linear (team Sad_mod, project PPHunt, state Todo)

**Under SAD-330**

| Issue | Title | Priority |
|---|---|---|
| SAD-333 | Show Description and Features columns by default | Urgent |
| SAD-334 | Versioned one-time settings migration for description/features | High |
| SAD-335 | Report failed and skipped enrichment as a warning, not a clean success | High |
| SAD-336 | Render the enrichment warning in the completion toast | High |
| SAD-337 | Skip the PDP re-fetch when the save is already made on a product page | High |
| SAD-338 | Spike: measure PDP enrichment success on live Amazon and test request variants | Medium |
| SAD-339 | Browser QA for detail visibility and enrichment warnings | Medium |
| SAD-340 | Correct ARCHITECTURE.md and CHANGELOG claims that contradict the code | Medium |

**Adjacent defects (flat)**

| Issue | Title | Priority |
|---|---|---|
| SAD-341 | Right-click capture expires after 5 s while the context menu is still open | Medium |
| SAD-342 | RETRY_SAVE_PRODUCT is a declared message type with no handler | Medium |
| SAD-343 | The side panel ignores SAVE_JOB_UPDATE, so quick saves have no in-panel feedback | Medium |
| SAD-344 | Right-click saves inside iframes always report "No product found here" | Low |
| SAD-345 | Export ignores the Best Sellers Rank and Monthly Sales field toggles | Low |
| SAD-346 | Export's "Collected At" column has no table counterpart; default lists duplicated | Low |

SAD-332 (move Right-Click Save Behavior into Settings) is linked to SAD-330 as *related*; it is independent of the data-visibility problem and gets its own review.

### Relations

- **SAD-333 blocks SAD-334** — the migration exists to bring existing installs in line with the new default, so the default has to land first.
- **SAD-335 blocks SAD-336** — the toast can only render a warning that is actually emitted.
- **SAD-330 related to SAD-332**.

### Suggested execution order

1. SAD-335 → SAD-336 — makes every future blank field explainable, and unblocks diagnosis of the real reliability question.
2. SAD-333 → SAD-334 — makes the already-stored PDP data visible.
3. SAD-337 — removes the redundant fetches that trip the breaker.
4. SAD-339 — verify all of the above in Chrome and Edge.
5. SAD-338 — decide, with numbers, whether the fetch itself needs to change.
6. SAD-340 and the flat defect issues — in parallel.

A summary of this investigation was posted as a comment on SAD-330.
