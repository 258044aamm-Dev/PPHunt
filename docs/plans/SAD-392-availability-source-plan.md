# SAD-392 — Availability must hold the page's message (not Amazon's embedded script text); Source must follow the PDP observation

> **Plan-only artifact.** Branch to create: `fix/sad-392-availability-source`, from `main@2ec7eaf`.
> Nothing in this document is implemented yet; Phase 1 step 1 is committing this plan plus the
> fixture files already staged (untracked) under `docs/plans/SAD-392-fixtures/`.
>
> Ticket: [SAD-392 "The availability and source fields"](https://linear.app/sad-mod/issue/SAD-392/the-availability-and-source-fields) (Bug, Urgent, project PPHunt).
> Operator inputs: engine **Amazon**, workflow **PDP (collect / preview / one-click save)**, the ticket's
> unreadable value pasted verbatim, source semantics left to reproduction; decisions D1/D2/D4 below were
> made by the operator on 2026-10-21 after the evidence in §1 was presented.

---

## 0. Decisions (operator record)

| # | Question | Decision |
|---|---|---|
| **D1** | What should `source` mean when a stored product is observed again on its PDP? | **Upgrade to `'detail'` on observation merges; never downgrade.** `search`/`category` rows re-observed on a PDP (collection, Collect More, PDP one-click save) become `detail`. A `detail` row re-observed on a listing stays `detail`. |
| **D1a** | Correction to an earlier analysis claim | Earlier drafts of this investigation said quick-save "refreshes" `source`. **Measured false**: `pickVolatile` includes `source` in its refresh object (`quick-save.ts:76`), but `mergeScrapedProductFields` never reads or writes `.source` — today `source` is **first-write-wins on every path** (collection merge, quick-save, enrichment). The decision stands on the measured behaviour. |
| **D1b** | Does background PDP **enrichment** promote `source`? | **No.** `mergeDetailIntoStored` (`enrich-saved-product.ts`) is untouched: enrichment is an HTTP fetch, not a user observation, and promoting there would flip nearly every enriched listing row to `detail`, emptying the Source column of its meaning. Pinned by test. |
| **D2** | Rows already stored with the 1011-character script blob | **One-time DB cleanup** (operator chose this over SAD-387's read-time approach): Dexie version bump **v2 → v3** with an `upgrade()` that sanitizes `products.availability` in place. No read-time display hooks are added. |
| **D2b** | Do `snapshots` rows get cleaned too? | **Yes** (recommended default, operator veto possible): no UI reads `snapshot.availability` today (verified — no component renders it), but snapshots are the same class of stored observation and cleaning them in the same upgrade keeps the DB internally consistent for any future snapshot view. |
| **D3** | Engine scope | **Amazon engine only.** Temu untouched: its card matcher caps candidate text at 90 characters and gates on a stock-phrase regex (`temu/scraper/field-parsers.ts` `extractTemuCardMetadata`), so this blob class cannot be stored there; the ticket sample is Amazon's AOD script. |
| **D4** | Card-path availability read (`extractCardDeliveryAndAvailability`) | **Harden it with the same script/style-stripping helper.** Live captures show the card path is clean *today* (0/64 polluted), and the strip is provably identity on every captured shape, so this is zero-behaviour-change prevention, not a bug fix. |
| **D5** | The polluted `delivery` values found during reproduction (49/64 cards carry a CSS+JS blob) | **Out of scope — SAD-390 ("The delivery and seller fields", In Progress).** This plan touches no delivery/seller statement. The captured fixture `search-card-delivery-recipe.real.html` is handed to that ticket as evidence (§1.2). |
| **D6** | Fixture labelling | SAD-387 convention: live-captured markup is `*.real.html`; markup reconstructed from the ticket paste is `*.reported.html` — never labelled `real`. |
| **D7** | Value policy | **The page's own text.** No canonical label map, no invented `In Stock`, no truncation of a legitimate message. The fix removes what the page did not render as text (script/style bytes), and keeps everything it did. |

---

## 1. Evidence

All measurements below were taken on **2026-10-21/22** in the sandbox, with the repo at `main@2ec7eaf`,
through the **real** parsers (`parseAmazonProductDetail`, `parsePdpHtml`, `parseAmazonSearchResults`,
`mergeScrapedProductFields`) — not through paraphrase. Capture tool: **moli v1.1.18** (the operator-named
tool; prebuilt `moli-x86_64-unknown-linux-gnu` binary, installed outside the repo — §8).

### 1.1 The ticket's string, reproduced end-to-end

The operator pasted the unreadable cell value: an Amazon **AOD (All Offers Display) asset-loader
script** followed by the real buybox message *"This item cannot be shipped to your selected delivery
location. Please choose a different delivery location."*

Probe harness (scratch vitest file, since deleted; formalized as the step-1 test file): took the live
capture of `amazon.com/dp/B087GMJXMC` (2,581,917 bytes, HTTP 200 via moli), set **every** `#availability`
element's content to the reported shape (`<script>` + bare text, no `<span>`), and ran the real parser:

| Probe | Path | Result |
|---|---|---|
| B2 | `parseAmazonProductDetail` (live-DOM path: PDP collection + right-click save) | `availability` = **1011 characters**, starts `P.when("A", "load").execute("aod-assets-loaded", function(A){…`, **ends with the real message** — the ticket's value, byte-for-byte in shape. `source` = `'detail'`. |
| A | `parsePdpHtml` (offscreen path: enrichment/preview), unmutated live capture | `ok: true`, `availability` = `"In Stock"` (clean — see §1.2 for why), `source` = `'detail'`. |
| C | live capture unmutated, live-DOM path | `detectAmazonPageType` → `'product-detail'`; `availability` = `"In Stock"`; `source` = `'detail'`. |
| E | live **search** capture (`/s?k=aa+batteries`, 1,948,578 bytes, 50 cards) through `parseAmazonSearchResults` | 64 products; `source` = `'search'` on all; **availability: 0/64 populated, none polluted**; **delivery: 49/64 populated with the CSS+JS blob** (→ SAD-390, D5). |
| D | `mergeScrapedProductFields(searchRow, detailObservation)` | fields merge (availability, description, features fill in) but **`target.source` stays `'search'`** — the provenance divergence behind the ticket's "source not as expected". |

### 1.2 Live capture — what Amazon actually serves in `#availability`

Four PDPs fetched through moli, all HTTP 200, none captcha-walled:
`/dp/B087GMJXMC`, `/dp/B09RTVD1GF`, `/dp/B00NTCH52W`, `/dp/B00MNV8E0C`.

Every one carries the same shape — and **two elements with `id="availability"`** (duplicate ID; the
buybox one plus a second buybox-variant block later in the document):

```html
<div id="availability" class="a-section a-spacing-base a-spacing-top-micro }">
  <span class="a-size-medium a-color-success primary-availability-message"> In Stock </span>
  <script type="a-state" data-a-state="{&quot;key&quot;:&quot;social-proofing-page-state&quot;}">{"isInternal":false,"showInsightsHub":false,"isRobot":false,"showFaceout":true,"merchantId":"ATVPDKIKX0DER","availableBadges":"","loggedIn":false,"asin":"B087GMJXMC","showBadge":false,"ingressFaceout":"","availableFaceouts":"TK_BOUGHT"}</script>
  <br>
</div>
```

Measured facts:

* `#availability.textContent` on the live page = `In Stock {"isInternal":false,…}` — **the script's JSON is
  part of the div's text on every captured PDP**. Only the selector order (`#availability span` runs first)
  keeps today's values clean.
* The ticket's page is the variant where **no `<span>` exists inside any `#availability`** (the message is a
  bare text node behind the AOD loader script). Then selector 1 misses and the fallback selector
  `#availability` stores script-text + message. That is the whole bug (§2).
* Search cards: `[data-cy="delivery-recipe"]` hosts an inline `<style>` (`.prime-brand-color {color: #0064f9; }`)
  and an inline `<script>` (Prime signup ingress, `(function(f){var _np=(window.P._namespace(…`) — proof that
  Amazon embeds executable/style text inside buybox-area containers generally, i.e. the leak class is not
  hypothetical on listing pages either (its `delivery` victim belongs to SAD-390; the availability stock read
  in the same block is hardened per D4).
* Fetch reliability note: the first search-page fetch returned Amazon's **`bm-verify` interstitial**
  (2,236-byte meta-refresh shell). An immediate retry with `--wait load` returned the full page. The
  verification protocol (§9) must treat the interstitial as "retry once", not as a wall.

Committed fixtures (staged, untracked, `docs/plans/SAD-392-fixtures/`):

| File | Kind | Content |
|---|---|---|
| `pdp-availability-in-stock.real.html` | real | buybox `#availability` verbatim (span + a-state script), B087GMJXMC |
| `pdp-availability-duplicate-id.real.html` | real | the second `id="availability"` div, verbatim |
| `pdp-availability-aod-script.reported.html` | **reported** | ticket string inside the real div's attributes, span removed |
| `search-card-delivery-recipe.real.html` | real | the polluted delivery-recipe block (SAD-390 hand-off, D5) |
| `search-card-B09RTVD1GF.real.html` | real | one full search card as captured |

The full 2.58 MB PDP capture and 1.95 MB search capture stay **outside** the repo (sandbox paths recorded in
§8); the step-5 verification re-runs the parser over freshly captured full pages locally.

### 1.3 Static audit — every write path for the two fields (Amazon engine)

Availability writes:

| # | Path | Code | Exposure |
|---|---|---|---|
| W1 | PDP live-DOM parse (collection on PDP, right-click/context-menu save via `resolveSaveCandidate`) | `product-detail.ts:1334–1344`: selector loop `['#availability span', '#availability', '#outOfStock .a-color-price']` (`selectors.ts:192–196`) → `cleanAvailability(el.textContent)` | **Vulnerable — reproduced.** `cleanAvailability` (`field-parsers.ts:245`) is `normalizeWhitespace` only; `textContent` serializes `<script>`/`<style>` descendants |
| W2 | PDP offscreen parse (enrichment, preview) | `offscreen/parse.ts` `parsePdpHtml` → same `parseAmazonProductDetail` | Same defect, same fix (probe A) |
| W3 | Card stock read (collection, card save) | `field-parsers.ts` `extractCardDeliveryAndAvailability:1617–1621`: `stockSpan.textContent` of `.a-color-price` inside `[data-cy="delivery-recipe"]`, gated by unanchored `/left in stock|out of stock|unavailable/i` | Not polluted in any capture (0/64), but the container provably hosts script/style siblings → hardened per D4 |
| W4 | Card leaf-node fallback | same function, `:1641–1655`: `node.children.length > 0 → skip`, then **full-string** regex | Structurally script-safe (a `<script>` element counts as a child). **No change — pinned by test** |
| W5 | Snapshot projection | `quick-save.ts:343` `availability: product.availability ?? null` | Pass-through of W1–W4; fixed at the source |
| W6 | Merges | `scraper/dedup.ts` `MERGEABLE_NULLABLE_FIELDS` (fill-only), `db/products.ts` `enrichStoredProductFields` (fill-only), `enrich-saved-product.ts` (`availability` ∈ `DETAIL_FIELDS` **and** ∈ `FILL_ONLY_FIELDS` — SAD-296: the user's listing observation wins over the PDP), `quick-save.ts` `QUICK_SAVE_VOLATILE_FIELDS` (quick-save **does** refresh availability) | Consequence: a garbage value that lands first via collection **sticks forever** (fill-only), and a clean value can never replace it — which is why D2 (cleaning stored rows) is required, not optional |

Source writes:

| # | Path | Value | Verified |
|---|---|---|---|
| S1 | `parseAmazonProductDetail` (`product-detail.ts:1572`) | `'detail'` | probes A/B/C |
| S2 | `parseAmazonSearchResults`/`parseAmazonSearchCard` (`search-results.ts:145`) | `'search'` | probe E |
| S3 | `parseAmazonCategoryPage`/`parseAmazonCategoryCard` (`category-page.ts:195`) | `'category'` | static |
| S4 | `detectAmazonPageType` (`page-detector.ts`) routing in `amazon.content.ts extractCurrentPageProducts:89–147` | PDP → S1; search → S2 (fallback S3); bestsellers/category → S3 (fallback S2); `'other'` → S2/S3 fallback over whatever cards exist | static; live PDP classified `'product-detail'` (probe C). Note the DOM fallback (`#productTitle`) rescues unusual PDP URLs |
| S5 | Content-side dedup merge `mergeScrapedProductFields` | **never touches `.source`** (only reads it for the SAD-357 variations-upgrade condition, `dedup.ts:85–93`) | probe D |
| S6 | DB collection merge `enrichStoredProductFields` (`db/products.ts`) | **never patches `source`** | static |
| S7 | Quick-save (`upsertProductFromQuickSave` → `pickVolatile` → `mergeScrapedProductFields`) | includes `source` in the refresh object but the merge ignores it (D1a) | static |
| S8 | Enrichment `mergeDetailIntoStored` | `source` ∉ `DETAIL_FIELDS` → untouched | static |
| S9 | Snapshot `source` (`'listing' | 'detail'`, `save-job.ts:294`) | different concept (observation provenance of a snapshot row), not the product field | not touched by this ticket |

**Conclusion for the source half of the ticket:** no PDP path mis-assigns the enum; the divergence the
operator can observe is S5/S6 — a product first collected from a listing keeps `Source: search` forever even
after its PDP observation (or PDP-filled fields) arrive, while every other field on the row upgrades. D1
defines the expected semantics; §3.4 implements them.

### 1.4 Baseline to beat

`main@2ec7eaf`, sandbox, 2026-10-21: **1415 tests passed / 127 files passed (+3 skipped / 128), 164.76 s**
(`npx vitest run`). `tsc --noEmit`, `wxt build` green at plan time is assumed from CI; step gates re-run all
of it (§5).

---

## 2. Root cause

### 2.1 Availability — embedded script text is serialized by `textContent`

1. Amazon embeds non-rendered text **inside** the buybox availability container: an `a-state` JSON
   `<script>` on every captured PDP, and — on the ticket's page variant — the executable AOD asset-loader
   `<script>` with the message as a bare text sibling (no `<span>`).
2. The parser's first selector (`#availability span`) usually rescues the value; when no span exists in any
   `#availability` element (duplicate-ID document, §1.2), the loop falls through to `#availability` and
   reads `el.textContent`, which by DOM specification includes every descendant `<script>`/`<style>` text
   node.
3. `cleanAvailability` only normalizes whitespace; the zod schema (`z.string()`) has no length or content
   gate; nothing downstream inspects the value. A 1011-character script blob is stored, exported, searched
   and displayed verbatim — "extracted data … unreadable", exactly as the ticket says.
4. The Temu engine already solved this class with `extractTemuElementText` (clone → remove
   `script, style, noscript` → `textContent`, `temu/scraper/field-parsers.ts:50–61`). **The Amazon engine
   has no equivalent** — that missing helper is the defect.

Why nothing else caught it: unlike deal text (60-char cap in `deal-evidence.ts`, SAD-387) or card
availability leaves (full-string regex), the PDP availability fallback has **no cap and no vocabulary** —
by design, because legitimate messages vary ("In Stock", "Only 3 left in stock…", "This item cannot be
shipped…", localized variants). The fix therefore removes the *cause* (non-rendered bytes) instead of
pattern-matching the *symptom* (D7).

### 2.2 Source — first-write-wins provenance, no promotion on a stronger observation

`source` is not scraped; it is the parser's page-type stamp (S1–S3). It is written once at row creation and
no merge path ever updates it (S5–S8, probes D). A row collected from search and later completed from its
PDP shows PDP-sourced description/features/availability under a `search` badge — "the source field is not
being extracted as expected". The codebase already treats a `detail` observation as authoritative for
upgrades (SAD-357 variations use exactly the `incoming.source === 'detail' && existing.source !== 'detail'`
condition in both merge functions); D1 extends that established precedent to the `source` column itself,
upgrade-only.

---

## 3. The fix

Four surgical changes + one migration. No schema change, no selector-list change, no diagnostics-contract
change, no Temu change, no delivery/seller change (D5).

### 3.1 New DOM helper — text without non-rendered descendants (write paths)

Add to `src/engines/amazon/scraper/field-parsers.ts` (exported), mirroring the Temu precedent:

```ts
/**
 * SAD-392: Amazon embeds <script>/<style> text inside buybox containers (the
 * a-state JSON on every PDP `#availability`, the AOD loader on the ticket's
 * variant, the Prime-signup ingress inside `delivery-recipe`). `textContent`
 * serializes those bytes into field values. Read text the way the page renders
 * it: identical to `el.textContent` whenever no script/style/noscript
 * descendant exists (every captured clean shape), stripped when one does.
 */
export function extractAmazonElementText(el: Element | null | undefined): string | null {
  if (!el) return null;
  if (!el.querySelector('script, style, noscript')) return el.textContent;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
  return clone.textContent;
}
```

Call sites (2 — availability reads only):

| File | Line | Change |
|---|---|---|
| `scraper/product-detail.ts` | ~1337 (W1/W2 availability loop) | `availability = cleanAvailability(extractAmazonElementText(el));` — covers all three selectors incl. `#outOfStock .a-color-price` |
| `scraper/field-parsers.ts` | ~1617 (W3 card stock read) | `const stockText = normalizeWhitespace(extractAmazonElementText(stockSpan));` (helper is null-safe) |

Untouched: W4 leaf fallback (structurally safe — pinned), every delivery/seller/coupon statement (D5 and
SAD-389/390 territory), `cleanAvailability` itself, `normalizeWhitespace`, the selector lists, diagnostics
call sites (a stripped value that is still non-empty reports `EXTRACTED` with the same selector; an
empty-after-strip value takes the existing `parseFailed`/`missing` branches unchanged).

**Identity property (why this cannot affect working features):** for any element without
script/style/noscript descendants the helper returns `el.textContent` unchanged — the same string the code
reads today. Every clean capture (§1.2 span shapes, all card shapes) is in that class. The clone branch runs
only where today's code would have stored the blob.

### 3.2 New value sanitizer — for already-stored strings only (migration path)

New file `src/engines/amazon/utils/availability-text.ts` (pure, DOM-free):

```ts
/** SAD-392: cleans availability strings stored before the write-side fix. */
export function sanitizeAvailabilityText(raw: string | null | undefined): string | null
```

Algorithm (signature-gated, mirroring `sanitizeDealBadge`'s fast-path discipline):

1. `null`/empty → `null`. Normalize whitespace (same table as `normalizeWhitespace`).
2. **Fast path:** if the text contains none of the script signatures —
   `P.when(`, `function(`, `function (`, `ueLogError`, `window.ue`, `setTimeout(`, `{color:`,
   `{"`, `":"`, `data-a-state`, `_namespace(` — return the input **unchanged**. No legitimate availability
   message observed or documented (EN/DE/FR/ES/NL stock phrases, shipping-restriction sentences) contains
   these; the fast path keeps every clean stored row byte-identical.
3. Strip balanced `{…}` segments with the string/escape-aware brace scanner technique already proven in
   `product-detail.ts` (`extractJsonObject`, ~lines 484–527) — removes the a-state JSON and CSS rule bodies.
4. Strip balanced `P.when(…)` call expressions (paren-aware scan, consuming one trailing `;`) — removes the
   AOD loader. Repeat steps 3–4 to a bounded fixpoint (≤ 4 passes, each pass strictly shortens).
5. Tidy leftover edge punctuation/whitespace; empty → `null`.

Required measured behaviour (becomes unit tests, both directions):

| Input | Output |
|---|---|
| ticket blob (1011 chars, §1.1 B2) | `This item cannot be shipped to your selected delivery location. Please choose a different delivery location.` |
| `In Stock {"isInternal":false,…}` (live a-state shape, span-less) | `In Stock` |
| `In Stock` / `Only 5 left in stock` / `Temporarily out of stock` / `Currently unavailable` / `Auf Lager` | unchanged (fast path) |
| `null`, `''`, whitespace | `null` |
| only script text, no message | `null` |

This function is used **only** by the migration (§3.3) and its tests — not at write time (the write side
removes the cause at the DOM, §3.1) and not at read/display time (D2 chose migration; adding both would be
double machinery).

### 3.3 Dexie v3 upgrade — one-time cleanup of stored rows (D2/D2b)

`src/engines/amazon/db/database.ts`:

```ts
// v3 (SAD-392): clean availability values polluted by embedded <script> text
// before the write-side fix. Data-only upgrade: no store shape changes, and the
// upgrade must never throw — a failed Dexie upgrade blocks every DB open
// (side panel, worker) and would take the whole extension down.
this.version(3).stores({}).upgrade(async (tx) => {
  const cleanTable = async (name: 'products' | 'snapshots'): Promise<void> => {
    try {
      await tx.table(name).toCollection().modify((row) => {
        const next = sanitizeAvailabilityText(row.availability);
        if (next === row.availability) return 0; // Dexie: leave the row untouched
        row.availability = next;
      });
    } catch {
      // Contained: an unreadable row never blocks the upgrade or the DB open.
    }
  };
  await cleanTable('products');
  await cleanTable('snapshots'); // D2b
});
```

Properties, all pinned by tests (§4): runs once per profile (Dexie versioning); idempotent (fast path makes
a re-run a no-op); touches **only** `availability` and **only** rows whose value changes; never throws;
per-row fault isolation; `stores({})` inherits the v2 schema unchanged. Temu's `PPHuntTemuDB` is a separate
database and is untouched (D3).

### 3.4 Source promotion on PDP observations (D1)

Two merge functions, one rule each — upgrade to `'detail'` only, never downgrade, never sideways:

* `src/engines/amazon/scraper/dedup.ts` — in `mergeScrapedProductFields`, **after** the SAD-357 variations
  block (ordering hazard: that block's condition reads the pre-promotion `target.source !== 'detail'`;
  promoting first would silently kill the variations upgrade — pinned by test):

```ts
// SAD-392 (D1): a PDP observation is authoritative for provenance, mirroring the
// SAD-357 variations upgrade above. Upgrade-only: a listing re-observation never
// downgrades a 'detail' row.
if (source.source === 'detail' && target.source !== 'detail') {
  target.source = 'detail';
  changed = true;
}
```

  Coverage: content-side dedup during a collection run (search page → PDP → Collect More), and the
  quick-save volatile pass (PDP re-save of a listing-saved row) — both call this function.

* `src/engines/amazon/db/products.ts` — in `enrichStoredProductFields`, after the variations condition:

```ts
if (incoming.source === 'detail' && existing.source !== 'detail') {
  patch.source = 'detail';
  hasChanges = true;
}
```

  Coverage: the background write when a re-observed PDP product reaches an existing row (`addProducts`).

Explicitly **not** changed (D1b): `mergeDetailIntoStored` (enrichment), rating backfill (rating columns
only), snapshot `source` (S9), `resolveSaveCandidate`/parser stamps (already correct), Temu merges (D3).

### 3.5 Change-set summary

| File | Change | Kind |
|---|---|---|
| `src/engines/amazon/scraper/field-parsers.ts` | + `extractAmazonElementText` (exported); W3 stock read uses it | 1 helper + 1 line |
| `src/engines/amazon/scraper/product-detail.ts` | W1 availability loop uses the helper | 1 line |
| `src/engines/amazon/utils/availability-text.ts` | new pure sanitizer | new small module |
| `src/engines/amazon/db/database.ts` | `version(3)` upgrade | ~20 lines |
| `src/engines/amazon/scraper/dedup.ts` | source promotion (after variations block) | 4 lines |
| `src/engines/amazon/db/products.ts` | source promotion patch | 4 lines |
| `tests/sad-392-availability-source.test.ts` | new test file (§4) | new |
| `docs/plans/SAD-392-*` (this plan, fixtures, evidence JSON, verification report), `ARCHITECTURE.md` note, `CHANGELOG.md` | docs | — |

Nothing else. No UI component changes (the migration cleans the data the existing cells/exports already
render), no export-mapping changes, no zod/schema changes, no manifest/permissions changes.

---

## 4. Tests — `tests/sad-392-availability-source.test.ts`

Fixtures: the five files in `docs/plans/SAD-392-fixtures/` embedded in a minimal PDP/listing skeleton
built from the real captures (title node, buybox landmarks as needed). The full 2.58 MB page is exercised
only in the §9 local verification, not committed.

| # | Case | Asserts |
|---|---|---|
| 1 | **real** fixture (both duplicate-ID divs) through `parseAmazonProductDetail` | `'In Stock'` — regression pin of today's correct behaviour |
| 2 | **reported** fixture (AOD script, bare message, no span) through `parseAmazonProductDetail` | availability === the exact message; excludes `P.when`; length < 200; `source === 'detail'` |
| 3 | reported fixture through `parsePdpHtml` (offscreen/enrichment parity) | same as 2, `ok: true` |
| 4 | a-state shape with the span removed (`In Stock {json}`) | `'In Stock'` — script JSON stripped at write time |
| 5 | **real** full search card fixture through `extractProductFromCard`/`parseAmazonSearchResults` | availability stays `null` (no stock phrase printed); no field regressed vs. pre-fix snapshot of the same fixture |
| 6 | W3 hardening: `.a-color-price` containing a `<script>` plus `Only 5 left in stock` | `'Only 5 left in stock'` |
| 7 | W4 pin: leaf-node fallback where the only match hosts a `<script>` child | skipped (structural safety preserved) |
| 8 | sanitizer unit matrix (§3.2 table, both directions) | ticket blob → message; clean strings byte-identical; `null`/empty → `null`; script-only → `null` |
| 9 | migration (fake-indexeddb): seed a v2 DB — garbage row, clean row, `null` row, row **without** the key, garbage snapshot, plus a malformed row (`availability: 42`) | after open: garbage → message; clean/`null` rows deep-equal (ids, `collectedAt`, all other fields untouched); snapshots cleaned; malformed row survives and never throws; reopen = no further writes (idempotent) |
| 10 | source promotion: (a) `mergeScrapedProductFields(search, detail)` → `'detail'`; (b) `(detail, search)` → stays `'detail'`; (c) `addProducts` integration over a seeded search row + PDP re-collection → row `source === 'detail'`; (d) quick-save PDP re-save over a search row → `'detail'`; (e) **SAD-357 ordering pin**: detail incoming carrying `variations` upgrades variations *and* promotes source; (f) D1b pin: `mergeDetailIntoStored(storedSearchRow, detail)` → patch contains **no** `source` key | D1 semantics exactly |
| 11 | diagnostics contract: reported fixture with a collector | availability `EXTRACTED`, `source: 'dom'`, selector `'#availability'`; span-empty reject path still `PARSE_FAILED` with the existing reason strings |
| 12 | export pin: a migrated row through `EXPORT_COLUMNS.Availability` + CSV builder | cell === the message (post-migration data is clean at rest; no read hooks exist) |

Must stay green **untouched**: the full baseline (1415/127), in particular `quick-save-data-layer`,
`enrich-saved-product`, `collection-save-parity`, `offscreen-handlers`, `baseline-snapshot`,
`extraction-diagnostics`, SAD-357 variations tests, `sad-384/385/386*`, every `temu-*` file, and
`docs-consistency`.

---

## 5. Phases (repo step-commit convention)

| # | Commit | Contents | Gate |
|---|---|---|---|
| 1 | `docs(sad-392): root cause, live-capture evidence and the fix plan` | this plan + `docs/plans/SAD-392-fixtures/*` + `docs/plans/sad-392-live-2026-10-22.json` (machine-readable probe record, SAD-380 convention) | `docs-consistency` green |
| 2 | `SAD-392 step 1: read availability text without Amazon's embedded scripts` | §3.1 helper + W1/W2 call site + tests 1–4, 11 | `npx tsc --noEmit` → `npm run check:dead-exports` → `npx wxt build` → `npx vitest run` (≥ 1415 passed) → `npm audit --omit=dev` → push → Linear comment |
| 3 | `SAD-392 step 2: the card stock read uses the same stripped text` | W3 call site + tests 5–7 | same gate chain |
| 4 | `SAD-392 step 3: Source follows the PDP observation` | §3.4 both merges + test 10 | same |
| 5 | `SAD-392 step 4: clean stored availability in one DB upgrade` | §3.2 sanitizer + §3.3 v3 upgrade + tests 8, 9, 12 | same |
| 6 | `SAD-392 step 5: verification record, architecture note, changelog` | `docs/plans/SAD-392-verification-report.md` (§9 results incl. fresh moli capture), `ARCHITECTURE.md` (availability text reads strip non-rendered descendants; Source promotion rule; DB v3), `CHANGELOG.md` | full `npm run verify` |

Each phase is independently revertable; steps 2–5 share no lines with each other.

---

## 6. Falsified — do not build

| Candidate | Why not |
|---|---|
| Add `.primary-availability-message` as a new first selector | The reported page has **no span at all** — a class selector cannot rescue it; and on every captured clean page the existing span selector already wins. Adds precedence risk for zero gain (§1.2) |
| Value-level regex sanitizer applied at **write** time | The DOM strip removes the cause; pattern-matching fresh page text risks eating legitimate messages (D7). The sanitizer exists only for legacy stored strings (§3.2) |
| Read-time display cleanup (SAD-387 D2 style: cell/search/export hooks) | Operator chose the DB migration (D2). Read hooks would be permanent per-render machinery for a one-time pollution, and would double-clean post-migration rows |
| Length cap or vocabulary whitelist on availability | Legitimate messages are long (the ticket's own is 113 chars) and open-vocabulary incl. localized markets; a cap truncates the page's text (violates D7), a whitelist invents labels (violates SAD-387 D1 precedent) |
| Promote `source` in `mergeDetailIntoStored` (enrichment) | D1b: mass-flips listing rows on a background fetch; Source would stop describing where the user collected |
| Bidirectional "last observation wins" source | Operator decision D1: never downgrade |
| Any Temu change | D3: Temu's 90-char cap + phrase-gated matcher cannot store this blob class |
| Handling the duplicate `id="availability"` specially | `querySelector` document-order semantics are stable and both duplicates carry the same message; test 1 pins the behaviour. "Fixing" Amazon's invalid HTML is not our defect |
| Schema/zod change (max length, new field) | None needed — same reasoning as SAD-387 §6 |
| Touching delivery/seller/coupon reads found polluted in probe E | SAD-390/SAD-389 own those fields (both In Progress). Fixture handed off (D5) |

---

## 7. Risks & coordination

| Risk | Likelihood | Mitigation |
|---|---|---|
| A throwing Dexie upgrade blocks **every** DB open (extension-wide outage) | Low | `never throw` rule: whole-body + per-row try/catch (§3.3); malformed-row test 9; worst case = rows stay dirty, DB opens |
| Sanitizer over-strips a legitimate stored value | Low | Signature fast path; no observed message contains `{`, `":"`, `P.when(`; both-direction tests (8); migration only rewrites rows whose value actually changes |
| **Parallel tickets touch adjacent lines**: SAD-390 (In Progress) edits the delivery branch of `extractCardDeliveryAndAvailability`; step 3 edits the stock branch of the same function. SAD-387 branch edits `product-detail.ts` deal loop (~1140), ours is ~1337. SAD-391 may edit `mergeScrapedProductFields` (isPrime/isSponsored) | Certain (textual), benign (semantic) | Steps are small and field-scoped; merge rule: whoever lands second rebases and keeps both statements; §3.5 lists every line this ticket owns |
| Source promotion surprises the operator ("rows changed by themselves") | Low | It is D1, upgrade-only, and only on a fresh PDP observation of that ASIN; test 10 pins every direction |
| Migration perf on large profiles | Low | Bounded by per-session target counts (hundreds–thousands of rows); one-time; `modify()` writes only changed rows |
| Amazon serves the `bm-verify` interstitial during verification capture | Observed once | Retry once with `--wait load` (§1.2); record the retry in the verification report, never bypass (product rule, SAD-380 precedent) |
| Test-suite time grows (jsdom over fixtures) | Low | Fixtures are small extracted blocks, not full pages (§4 preamble) |

**Rollback:** revert per phase. The v3 migration is forward-only but harmless: cleaned values are the page's
own text; reverting step 5's code leaves cleaned data cleaned and simply stops future cleaning; reverting
steps 2–3 restores today's `textContent` reads; reverting step 4 restores first-write-wins. No repair work
is created in any direction.

---

## 8. Tooling note (moli)

moli v1.1.18, prebuilt `moli-x86_64-unknown-linux-gnu.tar.gz` from
`github.com/lexmount/moli/releases/latest`, extracted outside the repo
(`~/.moli-bin/moli-v1.1.18-x86_64-unknown-linux-gnu/moli`). Amazon answered **HTTP 200** for PDPs and (on
retry) search — consistent with SAD-387's tooling note; `curl`-style static fetches remain insufficient.

Exact invocations used for this plan's evidence (re-run in step 5):

```bash
moli fetch --disable-js --eval-file probe-availability.js "https://www.amazon.com/dp/B087GMJXMC"
moli fetch --disable-js --dump html   "https://www.amazon.com/dp/B087GMJXMC"  > capture-pdp.html    # 2,581,917 B
moli fetch --disable-js --dump html --wait load "https://www.amazon.com/s?k=aa+batteries" > capture-search.html  # 1,948,578 B; retry once past bm-verify
```

Sandbox artifacts (kept for the implementation session, not committed): `/home/user/capture-B087GMJXMC.html`,
`/home/user/capture-search-aa2.html`, `/home/user/sad-392-evidence/*`, probe scripts
`/home/user/probe-availability.js`, `/home/user/probe-availability2.js`, `/home/user/probe-cards.js`.

---

## 9. Verification protocol (step 5)

1. **Automated:** full `npm run verify` (`tsc --noEmit`, `vitest run`, `wxt build`, `npm audit --omit=dev`)
   — baseline to beat: **1415 passed / 127 files**.
2. **Fresh live capture:** re-run the §8 moli commands; parse the fresh PDP capture through `parsePdpHtml`
   and the reported-shape mutation through `parseAmazonProductDetail`; record outputs (availability clean on
   real shapes; message-only on reported shape; `source: 'detail'`) in
   `docs/plans/SAD-392-verification-report.md` plus the machine-readable
   `docs/plans/sad-392-live-<date>.json`.
3. **Owner browser QA** (loaded unpacked build, diagnostics toggle ON):
   a. open the side panel once on an existing profile → v3 upgrade runs; a previously polluted row now shows
   the readable message (before/after screenshot for the report);
   b. collect on the ticket's kind of PDP (region-restricted item) → Availability readable, Source `detail`;
   c. collect a search page → navigate to one collected product's PDP → Collect More → that row's Source
   promotes to `detail`, siblings stay `search`;
   d. right-click save on a PDP, then re-save the same ASIN from a search card → Source stays `detail`
   (no downgrade);
   e. listing save with PDP enrichment enabled → Source stays `search` (D1b), availability clean;
   f. CSV + Excel + clipboard export and table search for `shipped` / `In Stock` → cleaned values only;
   g. service-worker console diagnostics line for availability → `EXTRACTED`, `source: dom`.
4. **Ticket hygiene:** Linear comment per phase (repo convention); final comment links the verification
   report; SAD-390 gets a comment with the `search-card-delivery-recipe.real.html` evidence (D5 hand-off);
   issue state → In Review.
