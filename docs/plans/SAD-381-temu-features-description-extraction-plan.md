# SAD-381 — Temu `description` & `features` extraction: root cause, verified DOM contract, and implementation plan

> **Status: PLAN ONLY — no application source changed.**
> Issue: <https://linear.app/sad-mod/issue/SAD-381> · Team `SAD` · Project **PPHunt**
> Priority **1 (Urgent)** · Labels **Bug**, **Temu** · State **Todo**
>
> *"Currently, the Temu Engine does not extract the `feature` and `description` fields.
> Investigate the existing extraction logic thoroughly to identify the root cause. Determine
> how Temu presents product features and descriptions on actual product pages, and implement
> a robust extraction solution that accurately captures both fields."*
>
> **Base:** `feat/temu-engine @ 127cd9e` (the owner-locked Temu branch — the same branch SAD-360
> and SAD-380 shipped on). `main` is at `a10e174`; the branch differs from it only by SAD-380's
> price work plus SAD-379's Amazon commits, and **neither touches this ticket's target code**
> (§2.10). Working tree clean apart from build output, which is git-ignored.

---

## 0. How this plan was produced (anti-guessing audit)

Every claim below is tagged with the evidence that produced it. Nothing about Temu's markup
is asserted from memory.

| Claim type | How it was established | Artifact |
|---|---|---|
| Current behaviour of the parser | Read the code **and replayed it** against a DOM built from the verified contract, using the repo's own vitest + jsdom | §2.8 (temporary scratch test, deleted after measurement) |
| Temu's real DOM contract | Read Temu's **own PDP JavaScript bundle** (`goods_3ec530fb9c64b2d4fc2a.js`, 725,988 B, served by `static.kwcdn.com` for the live product page) and traced every component that renders the details/description sections | §2.3, §2.4 |
| Temu's server HTML | `curl` of the real PDP with desktop Chrome, Googlebot and Android UAs (HTTP 200, 248–318 KB) | §2.1 |
| Temu's localisation store | Parsed `window.__InitialI18nStore__` out of the live SSR HTML; it is valid JSON (207,822 chars) and contains every label the plan uses | §2.6 |
| Hydrated DOM | **NOT obtained.** A real Playwright Chromium (1440×1200, real UA, `--no-sandbox`) is redirected to `/login.html?…&login_scene=2` from this datacenter IP. Logged as a hard limitation, not worked around | §2.2, §12 |
| Baseline | `npm install` → `npx tsc --noEmit` → `npx vitest run` → `npx wxt build`, re-run on `feat/temu-engine @ 127cd9e` | §10.1 |

**What is therefore still unproven**, and is deferred to your captures (§12): the exact
`outerHTML` a real hydrated PDP produces, whether the details section is lazily mounted
below the fold, and whether some products render the property list in a different order.
The plan's algorithm is designed so that each of those unknowns degrades to a *diagnosable*
status instead of silently producing wrong data.

---

## 1. The problem, restated precisely

The Temu engine's product type already models both fields
(`src/engines/temu/types/product.ts:77-81`), the Zod schemas accept them
(`schemas/product.ts:64-66`, `schemas/scraped-product.ts:59-61`), they are default columns
(`constants/defaults.ts:47-48`), default visible exports (`constants/defaults.ts:101-102`),
and default table columns (`ui/table/columns.tsx:622-679, 768-769`). **The whole downstream
pipeline already works — only the producer is broken.**

Observable symptom on a real product page:

```json
{ "description": "deals on 2pcs mens suit set … on Temu. Shop on Temu to start saving.",
  "features": [] }
```

The first value is Temu's SEO boilerplate; the second is empty. Both are wrong in opposite
directions: `description` contains **unrelated content**, `features` contains **nothing**.

**Acceptance criteria (from the issue, made testable):**

| # | Criterion | Testable form |
|---|---|---|
| A1 | Features and description extracted **separately**, meanings preserved | Two different sources, asserted independently (§5) |
| A2 | Layout variations handled; missing fields never filled with unrelated content | Table-driven variants + a "noise never leaks" test (§10.2) |
| A3 | Only real page data; never fabricated | Absence fixtures return `null` / `[]` (§10.2) |
| A4 | No regression in any other field | Byte-identical output for every non-target field on every existing fixture (§10.5) |
| A5 | Field-level diagnostics: extracted / missing / partially extracted | Status matrix (§7) |
| A6 | Verified against real Temu pages | Capture + harness protocol (§12) |

---

## 2. Root cause

### 2.1 What Temu actually serves (measured, three user agents)

```
$ curl -A "<Chrome 131 desktop>"   …-g-601099769178067.html   → HTTP 200, 318,633 B
$ curl -A "Googlebot/2.1"          …-g-601099769178067.html   → HTTP 200, 272,437 B
$ curl -A "<Android Pixel Chrome>" …-g-601099769178067.html   → HTTP 200, 248,999 B
```

All three responses contain:

| Probe | Count |
|---|---|
| `<div id="main"></div>` (empty shell) | 1 |
| `<h1` | **0** |
| `id="rightContent"` / `id="leftContent"` / `id="goods_price"` / `id="goodsDetail"` | **0** |
| `application/ld+json` | **0** |
| `meta[name="description"]` | 1 — the SEO template below |

```html
<meta name="description" content="  deals on 2pcs mens suit set fashionable jacket and
trousers elegant for business casual banquets and parties   pocket square   regular fit
formal style lapel long sleeve regalo on Temu. Shop on Temu to start saving."/>
```

So: **the product page is client-rendered, and the server response carries no JSON-LD and no
product DOM.** Everything the parser needs exists only after hydration.

### 2.2 The hydrated DOM is not reachable from here (hard limitation)

A Playwright Chromium with a real UA and a 1440×1200 viewport lands on
`/login.html?from=…&login_scene=2&refer_page_name=goods&refer_page_id=…`. Temu gatekeeps PDP
data by IP/risk, not by user agent: Googlebot and mobile UA spoofing both return the same
empty shell (§2.1). This is the same class of constraint the repo already documents for
Amazon (`docs/plans/SAD-338-enrichment-spike.md`, `SAD-360-verification-report.md`
"Known limitation 1"), and the sibling Temu ticket hit it one day earlier
(`docs/plans/SAD-380-step1-capture-2026-10-21.md`: *"all redirected to `/login.html`"*). It is
why §12 asks you for captures.

### 2.3 The real DOM contract (from Temu's own bundle)

`goods_3ec530fb9c64b2d4fc2a.js` is the PDP bundle the live page loads. Its React component
names are preserved (`W4({name:"GoodsDetailV2"})`, `name:"DescriptionV2"`, …), so the emitted
structure is recoverable exactly:

| Anchor | How it is emitted | Stability |
|---|---|---|
| `id="goodsDetail"` | `createElement("div",{className:…, id:"goodsDetail"})` in `GoodsDetailV2` | **stable id** |
| `id="rightContent"` | `createElement("div",{className:…, id:"rightContent"})` in the right column | **stable id** |
| `id="leftContent"`, `id="goods_price"`, `id="reviewContent"` | same pattern | stable ids |
| `data-id="module"` | on both `Highlight` and `DescriptionV2` module roots | **stable data attribute** |
| `aria-label="…"` on module rows | Highlight: `aria-label={text}`; DescriptionV2: `` aria-label={`$${values}`} `` | stable attribute, row semantics |
| `<table><tr><th/><td/></th>` | `GoodsPropertyTable`, data from `moduleMap.productDetailExtensionModule.data.goodsPropertyTable.table` | semantic elements |
| hashed classes (`_1KPuZ1IQ`, `_25CXdX7D`, …) | CSS-module classes | **forbidden by repo rule** (`selectors.ts` header) — never used |

Structure inside `#goodsDetail` (`GoodsDetailV2`), in render order:

```
#goodsDetail
├─ <h2>                       “Product details”      ← goodsDetail.goodsDetailTitle
├─ [data-id=module]           Highlights module     ← items are div[aria-label], NOT li
├─ compliance instructions    (warning text — must be excluded)
├─ property list              div rows: “Key: value”  ← goodsProperty; NOT li/tr
├─ <ul><li>…                  attribute chips (names only)
├─ table<tr><th><td>          extended property table
└─ description image floors   productDetail.floorList (image groups)
```

Right column (`#rightContent`) additionally renders:

```
#rightContent
├─ h1[aria-label]  title
├─ #goods_price
├─ [data-id=module]           Highlights (duplicate of the one above)
└─ [data-id=module]           Description module: rows are div[role=button][aria-label="$…"]
                              collapsed to `rows ?? 6` rows + a “See more” control
```

Temu's own AI-spec prompt in the same bundle confirms the data model it considers
authoritative for this content:

```js
`Product Attributes: ${goods.goodsProperty.map(e => `${e.key}: ${e.values?.join(", ")}`).join("; ")}
 ${productDetail.floorList.map(e => e.items?.map(i => i.text).filter(Boolean).join(", ")).join(", ")}`
```

### 2.4 Root cause 1 — `features` can only ever match `li` / `tr`

`src/engines/temu/scraper/product-detail.ts:616-656`:

```ts
const scope =
  document.querySelector('#goodsDetail, #leftContent, #rightContent') ?? document;

const items = Array.from(scope.querySelectorAll('li, tr'));
```

Three independent defects in six lines:

1. **`querySelector` with a selector list returns the first match in document order, not all
   three.** On a real PDP the gallery (`#leftContent`) sits above the detail column, so the
   scope is frequently *the gallery* — zero candidates.
2. **Temu does not use `li`/`tr` for this content.** Highlights rows, the property list and the
   Description rows are all `div`s (§2.3). Only `GoodsPropertyTable` emits real `<tr>` rows.
3. When the scope misses entirely, the fallback is `document` — the whole page — so on a
   non-PDP the extractor can harvest navigation/footer `<li>`s. That is unrelated content
   flowing into a product field (violates A2/A3).

### 2.5 Root cause 2 — `description` reads two sources that are never the description

`src/engines/temu/scraper/product-detail.ts:510-524`:

```ts
const domDescription =
  ldMeta.description === null
    ? cleanTemuText(document.querySelector('meta[name="description"]')?.getAttribute('content'))
    : null;
const description = ldMeta.description ?? domDescription;
```

* `ldMeta.description` comes from `application/ld+json` — **0 blocks** in the live response
  (§2.1). The bundle shows JSON-LD is generated by a conditional `GoogleShopping` component
  (`googleShoppingJson` store), so it cannot be relied on.
* `meta[name="description"]` is Temu's SEO template (§2.1). The parser accepts it verbatim —
  which is how a marketing sentence with a leading space became a product `description`.

### 2.6 Root cause 3 — the label vocabulary was never modelled

Temu's details/description modules are identified in its own code by i18n keys, not by
markup: `goodsDetail.goodsDetailTitle`, `main_detail.highlight`, `main_detail.descriptionTitle`,
`goodsDetail.descriptionSeeAll`, `goodsDetail.descriptionMoreWithDimension`,
`main_detail.descriptionMore`. The extension has no notion of these, so even a correct DOM
walk could not tell "Highlights" from "Description". Verified against the live page's own
store:

```
main_detail.descriptionTitle            = "Description"
main_detail.highlight                   = "Highlights"
main_detail.descriptionMore             = "See more"
goodsDetail.goodsDetailTitle            = "Product details"
goodsDetail.descriptionSeeAll           = "See all details"
goodsDetail.descriptionMoreWithDimension= "See all details and dimensions"
```

### 2.7 Collapse behaviour (why "partial" is a real state, not an edge case)

From the bundle: `DescriptionV2` renders `u.slice(0, p)` where `p = +(rows) || 6`; the property
list renders `+goods.rows || 3` rows (0 when enhanced properties exist, 3 otherwise). Both add
a "See more" control. So **even a perfect selector returns only a prefix of the data** unless
the user expands the section. This is why the diagnostics need `PARTIAL` with a concrete
reason, and why the expand behaviour is a setting (§8).

### 2.8 Measured proof (scratch test, run then deleted)

A DOM built strictly from §2.3 (`#leftContent` → `#rightContent` with a module titled
"Description" and `$`-prefixed row labels → `#goodsDetail` with a Highlights module, a
`Key: value` property list, a `<table>`, plus page chrome: "Report this item", a compliance
warning, a "See all details" button; no JSON-LD; Temu's real meta description):

```
CURRENT  → { "description": "deals on 2pcs mens suit set … on Temu. Shop on Temu to start saving.",
             "features": [] }

PROPOSED → { "description": "Material: 95% Polyester, 5% Spandex\nFit: Regular\nClosure: Button",
             "features": [ "Breathable lining for all-day wear",
                           "Season: Spring, Autumn", "Pattern Type: Solid",
                           "Style: Business Casual", "Sleeve Length: Long Sleeve",
                           "Waist Type: Mid", "Occasion: Party, Business" ] }
```

The prototype was additionally validated against: missing i18n store (English fallback),
Spanish labels, absent `#goodsDetail` (→ `[]` / `null`), absent Description module (→ `null`),
and a noise-leak test for `Report this item`, `See all details`, `See more`, the compliance
sentence and `Temu`. **7/7 passed** before the file was removed.

The code printed in §5 is not pseudocode — it was executed verbatim against the same fixture
(5/5 passed) and produced:

```
FEATURES      { "features": ["Breathable lining", "Season: Spring, Autumn", "Pattern Type: Solid",
                             "Style: Business Casual", "Waist Type: Mid"],
                "collapsed": true, "candidates": 5, "source": "details-section" }
DESCRIPTION   { "description": "Material: 95% Polyester · Fit: Regular",
                "source": "description-module", "collapsed": true, "candidates": 2 }
```

`collapsed: true` in both is the evidence path that turns into `PARTIAL` in §7: the page shows a
"See all details"/"See more" control, so the extractor knows it captured a prefix.

### 2.9 Live evidence from the operator's browser (2026-10-21)

From the console log of a real session on the Canadian storefront:

| Observation | Implication |
|---|---|
| `[PPHunt:Temu] Page type: product_detail` on `https://www.temu.com/ca/smart-trash-cans-…-g-605420315850055.html` (after `category` on `/ca/category.html`) | `detectTemuPageType` already classifies a real PDP correctly — the bug is downstream, in the two field extractors, not in page detection |
| The page loads `goods_3ec530fb9c64b2d4fc2a.js` | **the same bundle hash analysed in §2.3** is the one serving live — the DOM contract in this plan is from the running code, not a stale copy |
| `window.__InitialI18nStore__` is present in the page | D4's label source exists on real pages (SSR copy is also what the content script can read from the DOM) |
| `copy(...)` → `undefined` with nothing pasted | why §12.1 now ships `scripts/temu-dom-capture.js` instead of raw `outerHTML` commands |
| No `application/ld+json` script was produced for this product | confirms §2.5: `description` cannot rely on JSON-LD |

Still missing from that session: the structural capture itself (§12.1).


### 2.10 Relationship to SAD-380 (pulled 2026-10-21) — no overlap

SAD-380 is the other Temu extraction bug, shipped on the same branch. Verified rather than
assumed:

```
$ git diff --stat fbab2bd origin/feat/temu-engine -- src/engines/temu
 src/engines/temu/scraper/field-parsers.ts    | 299 ++++++++++-
 src/engines/temu/scraper/product-detail.ts   |  28 +-
 src/engines/temu/scraper/selectors.ts        |  12 +-
```

| Check | Result |
|---|---|
| Where SAD-380 edits `product-detail.ts` | lines **248-285 only** — the pricing block (`listPrice` wider-scope pass, SAD-380 F1) |
| Where this ticket edits `product-detail.ts` | lines **510-524** (both field values) — 225 lines below, no overlapping hunk |
| `field-parsers.ts` | SAD-380 touched only pricing helpers; `grep -E '^[+-].*(features\|description)'` over its diff → **no hits**. `cleanTemuText` / `extractTemuElementText`, which §5 reuses, have **unchanged definitions** — SAD-380 only added new call sites to them |
| `selectors.ts` | SAD-380 added `listPrice` aria variants; the `productDetail` group this plan extends is otherwise unchanged |
| settings / types / schemas / UI / `temu.content.ts` / fixtures | **not modified at all** by SAD-380 (`git diff --stat` empty) — so §8's setting plumbing and §10's fixture work start from the same shape as before |
| Test baseline | 1238 green on the branch (§10.1) |

**Consequence for execution:** SAD-381 branches from `127cd9e`, and its commits will sit on top of
SAD-380's. No rebase of SAD-380 is needed, and §10.5's non-regression diff must be taken against
`127cd9e` (not `23b3182`), which is what the checklist says.

**One thing SAD-380 did *not* produce:** a real PDP DOM capture. Its step-1 record
(`docs/plans/SAD-380-step1-capture-2026-10-21.md`) hit the identical wall — *"Headless Chromium
render: US search, US PDP, category … all redirected to `/login.html`"* — and its one successful
render was a home-feed page, later overwritten. SAD-380 therefore shipped with the same
"live authenticated validation outstanding" caveat this plan carries, and it solved it the same
way: owner capture instructions. That is corroboration for §12, not a reason to relax it.


---

## 3. Decisions locked with you

| # | Question | Decision |
|---|---|---|
| D1 | Mapping | **features = Highlights + spec rows + table rows; description = the page's "Description" module text** |
| D2 | `meta[name="description"]` | **Rejected entirely** — never used, not even as a last resort |
| D3 | Collapsed content | **A per-run setting**, default **off** (no clicks unless enabled) |
| D4 | Localisation | **Resolve labels from the page's own `__InitialI18nStore__`**, English fallback |
| D5 | Fixtures | **You will capture real PDP DOM** for 3–5 products |

Consequences worth stating plainly:

* D2 means a product with no JSON-LD and no Description module reports `description: null`.
  That is correct: null is "the page did not provide it", not a failure.
* D3 means default runs capture only the *rendered* prefix. Diagnostics say `PARTIAL` with
  the reason, so the state is never mistaken for "the page has only 3 attributes".
* D5 means implementation starts after your captures land; §12 gives the exact procedure and
  the fallback if a capture is impossible.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Reuse the Amazon extractor patterns (`#feature-bullets`, tables) | Amazon-specific; no analogue on Temu. |
| Hardcode hashed CSS classes (`._1YBVObhm`, `._3xcJKtRB`) | Violates the `selectors.ts` future-proofing rule; those rotate per deploy. (They *corroborate* the structure: a third-party "Temu Scraper 2.0" extension, CRX v2.1.0, expands `._3xcJKtRB` and reads `._1YBVObhm`, falling back to `#goodsDetail`. Independent confirmation that `#goodsDetail` is the container.) |
| Read Temu's MobX store / `goods.description` directly | Page globals are invisible to an isolated-world content script; hooking page internals is fragile and out of policy. |
| Make `parseTemuProductDetail` async to wait for hydration | Ripples through every caller and 42 tests for a case already covered by the existing MutationObserver + `updatedExisting` re-send path (§11). |
| Extract only from `description` JSON-LD | It is absent on live pages (§2.5). |

---

## 4. Semantics: what each field means

| Field | Type | Meaning | Sources (in order) | Never contains |
|---|---|---|---|---|
| `features` | `string[]` | Short, discrete product claims and attribute rows | 1. module rows inside `#goodsDetail` (Highlights) · 2. `Key: value` property rows · 3. `<table><tr>` rows joined `Key: Value` · 4. *(only if 1–3 are empty)* right-column Highlights module | page chrome, warnings, buttons, shipping/seller/promo lines, the description text |
| `description` | `string \| null` | The page's own long-form description block | 1. JSON-LD `description` (when a page has it) · 2. the `Description` module rows in `#rightContent` | `meta[name=description]`, SEO copy, warnings, "See more" labels |

Rules applied to both:

* `cleanTemuText` on every value (existing helper, `field-parsers.ts:38-45`).
* Features: length 4–200 chars, case-insensitive dedupe, **cap 15** (preserves today's cap at
  `product-detail.ts:611`), order = source order.
* Description: rows joined with `' · '` (U+00B7) because `cleanTemuText` collapses newlines
  during normalisation (`field-parsers.ts:41`); empty → `null`.
* Denylisted keys (case-insensitive, whole key): `seller`, `sold by`, `ships from`,
  `shipping`, `delivery`, `returns`, `return`, `warranty` is **kept** (it is a real attribute),
  `price`, `coupon`, `discount`, `stock`, `availability`.
  Rationale: those already have dedicated fields; letting them into `features` would duplicate
  and pollute (A2).
* Nothing is ever synthesised: if a source is absent the field stays `[]` / `null`.

---

## 5. The algorithm

### 5.1 Label resolution (D4)

```ts
// src/engines/temu/scraper/pdp-details.ts
export interface TemuPdpLabels {
  highlight: string; description: string; details: string;
  seeAll: string; seeAllDimensions: string; seeMore: string;
}

const FALLBACK_LABELS: TemuPdpLabels = {
  highlight: 'Highlights', description: 'Description', details: 'Product details',
  seeAll: 'See all details', seeAllDimensions: 'See all details and dimensions',
  seeMore: 'See more',
};

/**
 * Temu renders its whole i18n dictionary into an inline script:
 *   <script>window.__InitialI18nStore__={ "en": { "goods": { … } } }</script>
 * A content script runs in an isolated world, so it cannot read the page's
 * `window` object — it must read the script TEXT from the DOM. Verified against
 * the live PDP (207,822-char, valid JSON, keys used below all present).
 */
export function readTemuPdpLabels(doc: Document): TemuPdpLabels {
  try {
    const store = readInitialI18nStore(doc);
    const goods = store ? Object.values(store)[0]?.goods : null;
    const pick = (group: unknown, key: string): string | null => {
      const value = (group as Record<string, unknown> | null)?.[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    return {
      highlight:   pick(goods?.main_detail, 'highlight')            ?? FALLBACK_LABELS.highlight,
      description: pick(goods?.main_detail, 'descriptionTitle')     ?? FALLBACK_LABELS.description,
      details:     pick(goods?.goodsDetail, 'goodsDetailTitle')      ?? FALLBACK_LABELS.details,
      seeAll:      pick(goods?.goodsDetail, 'descriptionSeeAll')     ?? FALLBACK_LABELS.seeAll,
      seeAllDimensions:
        pick(goods?.goodsDetail, 'descriptionMoreWithDimension')     ?? FALLBACK_LABELS.seeAllDimensions,
      seeMore:     pick(goods?.main_detail, 'descriptionMore')       ?? FALLBACK_LABELS.seeMore,
    };
  } catch {
    return FALLBACK_LABELS;   // diagnostics never depend on this succeeding
  }
}
```

`readInitialI18nStore` locates `window.__InitialI18nStore__` in the script text, then walks
braces with a string/escape-aware scanner (`~15` lines) and `JSON.parse`s the slice. Cached per
`Document` in a `WeakMap` — one parse per page, ~1–2 ms for 208 KB.

### 5.2 Features

```ts
export interface FeatureEvidence {
  features: string[];
  /** true when the details section was rendered but collapsed controls remain */
  collapsed: boolean;
  /** candidates seen before filtering — distinguishes "absent" from "rejected" */
  candidates: number;
  source: 'details-section' | 'right-column-highlights' | 'none';
}

export function extractTemuPdpFeatures(doc: Document, labels: TemuPdpLabels): FeatureEvidence {
  const details = doc.querySelector('#goodsDetail');

  const seen = new Set<string>();
  const out: string[] = [];
  let candidates = 0;

  const push = (raw: string | null): void => {
    const text = cleanTemuText(raw);
    if (!text) return;
    candidates++;
    if (text.length < 4 || text.length > 200) return;
    const key = text.split(':', 1)[0].trim().toLowerCase();
    if (FEATURE_KEY_DENYLIST.has(key)) return;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey) || out.length >= 15) return;
    seen.add(dedupeKey);
    out.push(text);
  };

  // 1–3 only when the details section is actually mounted.
  if (details) {
    // 1. Module blocks inside the details section (Highlights).
    //    Locale-independent: we do NOT require the module title to match.
    for (const block of Array.from(details.querySelectorAll('[data-id="module"]'))) {
      moduleRowTexts(block).forEach(push);
    }

    // 2. The property list: a container whose every direct child is "Key: value".
    propertyRows(details).forEach(push);

    // 3. The extended-property table.
    for (const tr of Array.from(details.querySelectorAll('table tr'))) {
      const th = cleanTemuText(tr.querySelector('th')?.textContent);
      const td = cleanTemuText(tr.querySelector('td')?.textContent);
      if (th && td) push(`${th}: ${td}`);
    }
  }

  const collapsed = details ? hasCollapsedControl(details, labels) : false;
  if (out.length > 0) return { features: out, collapsed, candidates, source: 'details-section' };

  // 4. Last resort only: the right column's Highlights module.
  const right = doc.querySelector('#rightContent');
  const highlight = right
    ? Array.from(right.querySelectorAll('[data-id="module"]'))
        .find((m) => cleanTemuText(m.firstElementChild?.textContent) === labels.highlight)
    : undefined;
  if (highlight) moduleRowTexts(highlight).forEach(push);

  return {
    features: out, collapsed, candidates,
    source: out.length > 0 ? 'right-column-highlights' : 'none',
  };
}

/** Innermost `[aria-label]` rows; strips Temu's trailing "Open in new tab." suffix. */
function moduleRowTexts(block: Element): string[] {
  const rows: string[] = [];
  for (const el of Array.from(block.querySelectorAll('[aria-label]'))) {
    if (el.querySelector('[aria-label]')) continue;          // innermost only
    const label = cleanTemuText(el.getAttribute('aria-label'));
    if (!label) continue;
    const text = label
      .replace(/^\$/, '')                                     // DescriptionV2 signature
      .replace(/\.\s*Open in new tab\.$/i, '')
      .trim();
    if (CONTROL_LABEL.test(text)) continue;                    // "See more", "Copy", …
    rows.push(text);
  }
  return rows;
}
```

Constants referenced above (module scope, in `pdp-details.ts`):

```ts
/** Keys that already have dedicated fields; never duplicated into `features`. */
const FEATURE_KEY_DENYLIST = new Set([
  'seller', 'sold by', 'ships from', 'shipping', 'delivery',
  'returns', 'return', 'price', 'coupon', 'discount', 'stock', 'availability',
]);
/** Buttons rendered inside the same containers; never data. */
const CONTROL_LABEL = /^(see more|see all details|see all details and dimensions|copy|report this item)$/i;
const KEY_VALUE = /^[A-Za-z][^:]{1,40}:\s*\S/;
```

`propertyRows` finds the **largest** container inside `#goodsDetail` (excluding
`[data-id="module"]`, `table`, `nav`, `ul`, `ol` and `[role="button"]` subtrees) where:

* it has **≥ 3** direct `div` children (matches Temu's `rows ?? 3` default), and
* **every** child's text matches `^[A-Za-z][^:]{1,40}:\s*\S` and is 4–200 chars.

Only then are those children returned. A container that partially matches is ignored — that is
what keeps compliance warnings and "Report this item" out.

### 5.3 Description

```ts
export interface DescriptionEvidence {
  description: string | null;
  source: 'description-module' | 'none';
  collapsed: boolean;
  candidates: number;
}

export function extractTemuPdpDescription(
  doc: Document,
  labels: TemuPdpLabels
): DescriptionEvidence {
  const right = doc.querySelector('#rightContent');
  if (!right) return { description: null, source: 'none', collapsed: false, candidates: 0 };

  const blocks = Array.from(right.querySelectorAll('[data-id="module"]'));
  const byTitle = blocks.find(
    (m) => cleanTemuText(m.firstElementChild?.textContent) === labels.description
  );
  // Locale-independent signature of DescriptionV2 rows: aria-label="$<value>".
  const bySignature = blocks.find((m) => m.querySelector('[aria-label^="$"]'));
  const chosen = byTitle ?? bySignature;
  if (!chosen) return { description: null, source: 'none', collapsed: false, candidates: 0 };

  const rows = moduleRowTexts(chosen).filter((t) => !CONTROL_LABEL.test(t));
  return {
    description: rows.length > 0 ? rows.join(' · ') : null,
    source: rows.length > 0 ? 'description-module' : 'none',
    collapsed: hasCollapsedControl(chosen, labels),
    candidates: rows.length,
  };
}
```

`hasCollapsedControl` returns true when a `[role="button"]` inside the scope carries one of
`labels.seeAll`, `labels.seeAllDimensions`, `labels.seeMore` (or the accessible label
`accessSeeMoreProductDetails`). That is the evidence used for `PARTIAL` (§7).

### 5.4 Expand-on-click (D3)

```ts
/**
 * Best-effort, bounded, never throws. Returns how many controls were clicked.
 * Only called when settings.expandProductDetails is true.
 */
export function expandTemuDetailSections(doc: Document, labels: TemuPdpLabels): number {
  const wanted = new Set([labels.seeAll, labels.seeAllDimensions, labels.seeMore].map((s) => s.toLowerCase()));
  let clicked = 0;
  for (const scope of ['#goodsDetail', '#rightContent']) {
    const root = doc.querySelector(scope);
    if (!root) continue;
    for (const el of Array.from(root.querySelectorAll('[role="button"][aria-label], [role="button"]'))) {
      const text = (cleanTemuText(el.getAttribute('aria-label')) ?? cleanTemuText(el.textContent) ?? '')
        .toLowerCase();
      if (!wanted.has(text)) continue;
      try { (el as HTMLElement).click(); clicked++; } catch { /* detached: ignore */ }
    }
  }
  return clicked;
}
```

Integration keeps every existing path untouched when the setting is **off** (§8.3).

---

## 6. Wiring into the parser

`src/engines/temu/scraper/product-detail.ts` — two surgical edits.

**Before** (lines 510-524):

```ts
const features = extractTemuPdpFeatures(document, diag);
const domDescription =
  ldMeta.description === null ? cleanTemuText(document.querySelector('meta[name="description"]')?.getAttribute('content')) : null;
const description = ldMeta.description ?? domDescription;
```

**After:**

```ts
const labels = readTemuPdpLabels(document);
const featureEvidence = extractTemuPdpFeatures(document, labels);          // no `document` fallback
const features = featureEvidence.features;

const descriptionEvidence = extractTemuPdpDescription(document, labels);
const description = ldMeta.description ?? descriptionEvidence.description;
```

Diagnostics for both fields are rewritten in the same block (§7). The old private
`extractTemuPdpFeatures` (`product-detail.ts:616-656`) and its `document`-wide fallback are
**deleted**; its behaviour moves to `pdp-details.ts` with the evidence object the diagnostics
need.

Everything else in `parseTemuProductDetail` is untouched: title, price, listPrice, discount,
currency, rating, reviewCount, sales, image, seller, brand, availability, badges, delivery,
`url`, validation, and the JSON-LD reader.

---

## 7. Diagnostics contract (A5)

`DETAIL_DIAGNOSTIC_FIELDS` already contains `description` and `features`, and
`applyValidationResults` already reconciles them — no schema change.

| Field | Condition | Status | `source` | `reason` (static, no values) |
|---|---|---|---|---|
| `features` | ≥1 row from details section | `EXTRACTED` | `dom` | `highlights, spec rows and table rows` |
| | only the right-column Highlights module yielded rows | `EXTRACTED` | `dom` | `right-column highlights fallback` |
| | rows found **and** a collapse control remains | `PARTIAL` | `dom` | `collapsed rows not expanded` |
| | `#goodsDetail` absent | `MISSING` | `dom` | `no details section rendered` |
| | section present, zero candidates | `MISSING` | `dom` | `no feature rows in the details section` |
| | section present, candidates all filtered | `PARSE_FAILED` | `dom` | `feature candidates rejected by length, denylist or dedup` |
| `description` | JSON-LD `description` used | `EXTRACTED` | `json-ld` | — |
| | Description module rows used | `EXTRACTED` | `dom` | `description module rows` |
| | module rows found + collapse control remains | `PARTIAL` | `dom` | `collapsed rows not expanded` |
| | no JSON-LD, no module | `MISSING` | `dom` | `no description module and no JSON-LD description` |
| | malformed JSON-LD block (existing rule) | `UNKNOWN` | — | `malformed JSON-LD block; attribution unknown` |

**Precedence:** the two `PARTIAL` rows are evaluated **before** the matching `EXTRACTED` row —
a collapsed section always reports `PARTIAL`, even when rows were captured. That is the whole
point of the status: "the page has more than we could read without clicking".

`meta[name="description"]` disappears from the code path entirely, so no diagnostic can ever
point at it again. Existing `recordFallback` / `recordAbsence` helpers keep their semantics;
`description` uses the same precedence rules as `title` (a DOM rejection rescued by JSON-LD is
`PARTIAL` via `recordFallback`).

---

## 8. Settings and transport (D3)

### 8.1 The setting

| File | Line | Change |
|---|---|---|
| `src/engines/temu/types/index.ts` | 124 | `expandProductDetails: boolean;` after `autoSavePartial` |
| `src/engines/temu/schemas/settings.ts` | 69 | `expandProductDetails: z.boolean().default(false),` |
| `src/engines/temu/constants/defaults.ts` | 58 | `expandProductDetails: false,` |
| `src/engines/temu/ui/components/SettingsOverlay.tsx` | ~393 | one `ToggleSetting`: label **"Expand product details"**, description *"Click 'See all details' before extracting features and description"* |

Default **false** is what keeps current page interaction byte-identical.

### 8.2 Transport (additive, optional)

`src/engines/temu/schemas/messages.ts:84-96` — add to the payload object:

```ts
/** SAD-381: expand collapsed detail rows before parsing (optional, default false). */
expandDetails: z.boolean().optional(),
```

A message from an older content script without the key still validates (existing tests
`temu-diagnostics-transport.test.ts` pin that pattern).

`src/engines/temu/background/handler.ts:172-200` — `buildTemuScrollConfig()` returns
`expandDetails: s.expandProductDetails`, and both send sites (~611, ~649) forward it.

`src/entrypoints/temu.content.ts:520-536` — destructure `expandDetails` and pass it to
`startCollection`.

### 8.3 The only branching point, default-off identical

```ts
// inside startCollection(), just before the first parse (currently line 347)
const shouldExpand =
  expandDetails === true &&
  detectTemuPageType(window.location.href, document) === 'product_detail';

// The existing code path, unchanged, when the setting is off:
if (!shouldExpand) {
  const initialProducts = parseCurrentPage();
  /* … exactly as today … */
} else {
  const clicked = expandTemuDetailSections(document, readTemuPdpLabels(document));
  window.setTimeout(() => runInitialParseAndObserve(), clicked > 0 ? 400 : 0);
}
```

`runInitialParseAndObserve()` is the existing body extracted verbatim (initial parse → send →
`setupMutationObserver()`), so the only behavioural delta in the whole ticket sits behind a
setting that defaults to off.

---

## 9. File-by-file change set

| # | File | Nature | Size |
|---|---|---|---|
| 1 | `src/engines/temu/scraper/pdp-details.ts` | **new** — labels, features, description, expand helper | ~230 lines incl. docs |
| 2 | `src/engines/temu/scraper/product-detail.ts` | delete private features fn; rewire the two fields + diagnostics | −45 / +40 |
| 3 | `src/engines/temu/scraper/selectors.ts` | add 3 stable anchors to `productDetail` | +6 |
| 4 | `src/engines/temu/types/index.ts` | one setting field | +1 |
| 5 | `src/engines/temu/schemas/settings.ts` | one schema field | +1 |
| 6 | `src/engines/temu/constants/defaults.ts` | one default | +1 |
| 7 | `src/engines/temu/ui/components/SettingsOverlay.tsx` | one toggle | +7 |
| 8 | `src/engines/temu/schemas/messages.ts` | optional `expandDetails` | +2 |
| 9 | `src/engines/temu/background/handler.ts` | forward the flag (2 sites + config) | +4 |
| 10 | `src/entrypoints/temu.content.ts` | accept flag; extract-and-guard the initial parse | +18 / −2 |
| 11 | `tests/temu-pdp-details.test.ts` | **new** unit suite (§10.2) | ~35 tests |
| 12 | `tests/fixtures/temu-pdp-fixtures.ts` + 3 suites | modernise fixtures to the real contract (§10.4) | ~120 lines changed |
| 13 | `CHANGELOG.md` | `## [Unreleased] — Temu features & description extraction (SAD-381)` | +20 |

`src/engines/temu/scraper/selectors.ts` additions:

```ts
/** Details section container (SAD-381). Real id, verified in Temu's goods bundle. */
detailsSection: '#goodsDetail',
/** Stable module wrapper emitted by Temu's Highlight/DescriptionV2 components. */
moduleBlock: '[data-id="module"]',
/** Extended-property table rows (`GoodsPropertyTable`). */
propertyTable: 'table tr',
```

No `src/lib/**` export is added or removed, so `npm run check:dead-exports` stays green.

---

## 10. Test plan

### 10.1 Baseline (measured on this clone, `feat/temu-engine @ 127cd9e`)

| Gate | Result |
|---|---|
| `npm install` | 606 packages, `wxt prepare` clean |
| `npx tsc --noEmit` | **clean** (exit 0) |
| `npx wxt build` | **OK, 2.00 MB**, `dist/chrome-mv3` emitted |
| `npx vitest run` (after the build, so the gated manifest suite runs) | **106 files / 1238 tests passed, 0 failed** |
| Cross-check | these numbers equal SAD-380's step-5 record (`106 files / 1238 tests`) on the same commit — the tree is the one being shipped |

**Acceptance: 106 files / ≥1238 tests, 0 failures, `tsc` clean, build clean, Amazon diff empty.**
(The previous draft of this plan quoted `102 files / 1198 tests` from `main @ 23b3182`; the
branch has since gained SAD-379's and SAD-380's suites. The guard is still "no file loses tests".)

### 10.2 New suite `tests/temu-pdp-details.test.ts`

| Group | Cases |
|---|---|
| Labels | parses the real store shape; English fallback when store missing; Spanish labels; truncated JSON → fallback, never throws; WeakMap cache returns the same object |
| Features | Highlights module rows; `Key: value` rows; table rows joined; source order preserved; dedupe case-insensitive; cap 15; 3-char row dropped; 201-char row dropped; denylisted key dropped; right-column fallback only when the details section yields nothing; `#goodsDetail` absent → `[]`; container with 2 children is not a property list; container with one non-matching child is rejected wholesale |
| Description | module found by localised title; found by `$` signature when the store is missing; absent → `null`; "See more" row excluded; rows joined with ` · `; whitespace collapsed; JSON-LD wins when both exist; **meta description never used** (assert `description !== meta`) |
| Noise | none of `Report this item`, compliance sentence, `See all details`, `See more`, `Temu` appear in either field |
| Parity | with and without a diagnostics collector the returned product is byte-identical (preserves the SAD-360 invariant) |
| Expand helper | clicks each matching control once; returns 0 when absent; ignores detached nodes; never throws |

### 10.3 Suites that must stay green, and why

| Suite | Why it is at risk | Guard |
|---|---|---|
| `tests/temu-scraper.test.ts` | its PDP fixture nests `#rightContent` inside `#goodsDetail` with `<ul><li>` — a shape real Temu does not produce | replace that fixture with the §2.3 shape; assertions become "description comes from the module, features from module + property rows"; the non-fabrication test is untouched |
| `tests/temu-diagnostics-pdp.test.ts` (160-166, 247-251, 345) | `FULL_PDP` features come from `li`; `FEATURES_ABSENT/REJECTED` use `li` | modernise the three fixtures; the *statuses* they assert stay identical (`EXTRACTED` / `MISSING` / `PARSE_FAILED`). Only two `reason` strings change, deliberately: `no feature/spec list nodes` → `no details section rendered`, and `feature candidates rejected by length or dedup filters` → `feature candidates rejected by length, denylist or dedup` |
| `tests/temu-schemas.test.ts`, `temu-isolation.test.ts`, `temu-diagnostics-*.test.ts` | settings schema + transport | new field is optional/defaulted; run unchanged |
| Amazon suites | must be untouched | `git diff --stat -- src/engines/amazon src/entrypoints/amazon.content.ts` must print nothing |

### 10.4 Fixture modernisation is deliberate, and is not a "test edit to go green"

The three old fixtures encode the assumption that broke. Replacing them with the verified
contract is the point of the ticket; the *assertions* (which behaviours are expected) are
preserved verbatim, and a new negative test asserts that `li`-only markup no longer produces
features — pinning the fix.

### 10.5 Non-regression proof for the other 20 fields

For every fixture in `PDP_FIXTURES` and `CARD_FIXTURES`, parse twice — old code (a detached
worktree at `127cd9e`) and new code — and diff the product JSON **excluding**
`description`/`features`. Expected: zero diffs. This is the same technique SAD-360 used and
must be reported in the PR.

---

## 11. Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Property-list container is mistaken for a spec list on some layout | Medium | require ≥3 children, all `Key: value`, exclude module/table/list/button subtrees; list negatives in tests |
| `#goodsDetail` not yet mounted when the user collects | Medium | existing MutationObserver re-parses and `parseCurrentPage`'s `updatedExisting` branch re-sends `collectedSoFar` (`temu.content.ts:167-177`), and `db/products.ts` merges `description`/`features` into the stored row — verified by reading both merge lists |
| Temu renames `data-id="module"` | Low | features do not depend on it for the property list or table; description additionally matches by `$` signature; both paths degrade to `MISSING` with a reason |
| i18n store shape changes | Low | English fallback + structural `$` signature; `readTemuPdpLabels` never throws |
| Expand clicks the wrong control | Low (setting is opt-in) | match on localised label text only; buttons are inside `#goodsDetail`/`#rightContent`; failures ignored |
| Non-English storefronts | Medium | D4 label resolution + locale-independent features + `$` signature |
| Image-only descriptions (common on Temu) | High | legitimate `null`; diagnostics say `MISSING` with an explicit reason, never a fabricated sentence |

---

## 12. Verification against real pages (A6) — what I need from you

### 12.1 Captures (D5) — exact procedure

Use the repo's own capture tool: **`scripts/temu-dom-capture.js`** (not bundled, not imported by
`src/`, not in the test suite). It exists because the obvious commands do not work:

* `document.querySelector('#goodsDetail').outerHTML` puts 200 KB+ on the clipboard and
  `copy()` returns `undefined`, so nothing readable ever reaches a chat message;
* Temu's class names are hashed (`_1KPuZ1IQ`, `_25CXdX7D`) and rotate per deploy, so raw
  `outerHTML` is mostly noise (and `selectors.ts` forbids using them anyway).

For 3–5 products on a normal connection:

1. Open the product page. **Scroll down until the "Product details" section is visible**
   (otherwise it may not be mounted yet).
2. DevTools → Console → paste the whole body of `scripts/temu-dom-capture.js` → Enter.
   (Type `allow pasting` first if Chrome asks.)
3. The script copies a **bounded JSON** to the clipboard, downloads
   `sad381-<goodsId>.json`, and prints three things you can paste directly:
   * `summary` — `has.goodsDetail`, `has.rightContent`, `has.jsonLd`, module titles, row
     counts, `detailsTableRows`, `detailsListItems`, `detailsDollarRows`, `collapseControls`;
   * `labels` — the resolved i18n strings for this storefront (`source: "store"` or
     `"fallback"`);
   * `digest` — a ~60-line indented structure tree of `#goodsDetail` and `#rightContent`.
4. Paste the **summary + labels + digest** into the issue. Attach (or paste) the downloaded
   JSON only if the digest is truncated.

If the console refuses `copy()`, right-click the printed object → *Copy object*, or send the
downloaded file.

What the digest must show for the plan's contract to hold (this is the acceptance check for
this step):

```
## #goodsDetail
  h2 "Product details"
  div[data-id=module]                       ← Highlights module
    …
  div                                       ← property list (>= 3 "Key: value" rows)
    div
      div "Season: …"
  table → tbody → tr → th "…", td "…"       ← extended properties
## #rightContent
  h1[aria-label="…"]
  div#goods_price
  div[data-id=module]                       ← Highlights (duplicate)
  div[data-id=module]                       ← Description
    div[role=button][aria-label="$…"]       ← rows (the "$" is DescriptionV2's signature)
```

If any block is missing or shaped differently, say so — that is a plan change, not an
implementation detail. §5's algorithm already degrades gracefully for the missing cases
(`MISSING` / `PARSE_FAILED` with reasons), but the *sources* would need re-mapping.

**Quick confirmation of the bug itself** (optional, 30 s): with the extension installed, open
the PDP → PPHunt → Temu → Start Collection (target 1) → open the **service-worker** DevTools →
filter `[PPHunt][Temu][Diagnostics]`. Today's line shows `description` `EXTRACTED` (from
`meta[name=description]`) and `features` `MISSING`/`PARSE_FAILED` — the two defects in §2
measured on your own machine.

### 12.2 Live run (you, on a normal connection)

```bash
npm run build
# Chrome → chrome://extensions → Load unpacked → dist/chrome-mv3
# Open a Temu PDP → PPHunt → Temu tab → Start Collection (target 1)
# service-worker DevTools console, filter: [PPHunt][Temu][Diagnostics]
```

Pass criteria, per product:

* `features` `EXTRACTED` (or `PARTIAL` when the collapse control is present) and non-empty for
  products that visibly show a Highlights/spec list.
* `description` `EXTRACTED` when the page visibly shows a "Description" block; `MISSING` when
  it does not.
* The stored row in the Temu table equals what the page shows — spot-check 3 rows.
* Toggle **Expand product details** on, repeat: `PARTIAL` must become `EXTRACTED` and the row
  count must grow.

### 12.3 Harness alternative

`npm run measure:diagnostics:temu -- --pdps <goodsId>` already exists
(`scripts/temu-diagnostics-measurement.mjs`) and compares every report against the stored row.
It is the cheapest way to produce A6 evidence; the manual checklist above is the fallback.

---

## 13. Execution checklist (one commit per step, `SAD-381` prefix)

Branch: `feat/temu-engine`, branched from `127cd9e` (owner-locked Temu branch, per SAD-360/SAD-380).

| Step | Content | Exit criterion |
|---|---|---|
| 0 | Commit captures under `tests/fixtures/real/` + this plan | captures committed, `npm test` still 1238 green |
| 1 | `pdp-details.ts` + unit tests (labels, features, description) — not yet wired | new suite green; parser behaviour unchanged |
| 2 | Wire `product-detail.ts` (both fields + diagnostics), delete the old private extractor | new + updated fixtures green; §10.5 non-regression diff empty |
| 3 | Setting + schema + default + UI toggle + message field + handler + content wiring | settings/transport suites green; default-off run byte-identical |
| 4 | Expand helper + opt-in path + tests | toggle-on run yields more rows in jsdom |
| 5 | Live verification record (`docs/plans/SAD-381-verification-<date>.md`) + CHANGELOG | A6 evidence attached to the issue |

---

## 14. Open questions (non-blocking — defaults chosen)

| # | Question | Default in this plan | Change it if… |
|---|---|---|---|
| 1 | Description row separator | `' · '` (U+00B7) | you want `'; '` / `' — '` / newline-preserving (the latter would require changing `cleanTemuText`, which is shared — not recommended) |
| 2 | Features cap | **15** (today's cap) | you want the full spec list (30–60 rows on some products); that also affects the table's joined cell length |
| 3 | Should `features` include the right-column Highlights when `#goodsDetail` also has them? | No — the details section is authoritative; the right column is only a fallback | duplicates become visible in exports |

---

## 15. Explicitly out of scope

* No change to `TemuScrapedProduct`, `TemuProduct`, the Zod schemas, IndexedDB, dedup, the
  table, the export columns, or the diagnostics field list. All already support both fields.
* No change to card/search/category extraction (`features: []`, `description: null` by design —
  `search-results.ts:126-127`).
* No Amazon changes.
* No new permissions, no new dependencies, no `manifest` change.
* No async refactor of `parseTemuProductDetail`.
* No reading of Temu's page globals or private APIs.

---

## Appendix A — Evidence index

| Evidence | Location |
|---|---|
| Live Temu SSR HTML for `601099769178067` (318,633 B) | captured by `curl`, temp only |
| Hydrated DOM redirected to login (Playwright) | `/tmp/temu_dom.html` (ephemeral) |
| Temu goods bundle `goods_3ec530fb9c64b2d4fc2a.js` (725,988 B) | `static.kwcdn.com/m-assets/assets/modernjs/` |
| Component traces (`GoodsDetailV2`, `DescriptionV2`, `Highlight`, `GoodsPropertyTable`) | §2.3, offsets 195,314 / 298,867 / 173,442 / 168,238 |
| i18n store parse (207,822 chars, all six labels) | §2.6 |
| Third-party corroboration: "Temu Scraper 2.0" v2.1.0, CRX extracted, `content_scrape_product.js` | reads `#goodsDetail`, expands `._3xcJKtRB`, reads `._1YBVobhm` |
| Scratch measurement (current vs proposed) | §2.8 (file deleted after the run) |
| Live console evidence (page type, bundle hash, i18n store) | §2.9 |
| Capture tool shipped for the operator | `scripts/temu-dom-capture.js` (tested in jsdom: 2,821 B on a minimal fixture, 6,133 B on the full contract fixture) |
| SAD-380 overlap audit (§2.10) | `git diff --stat fbab2bd origin/feat/temu-engine -- src/engines/temu` |
| SAD-380's failed live capture (precedent) | `docs/plans/SAD-380-step1-capture-2026-10-21.md` on `feat/temu-engine` |

## Appendix B — One-sentence summary per audience

* **Issue reader:** the parser looked for `li`/`tr` in a container Temu never fills with
  `li`/`tr`, and read the description from JSON-LD/meta tags that Temu does not publish — so
  features were always empty and description was the SEO blurb.
* **Reviewer:** the fix is one new pure module plus two call sites; every other field's code
  path is untouched and proven so by a field-excluding diff of every fixture.
* **QA:** flip **Expand product details** on to see `PARTIAL` become `EXTRACTED` on the same
  product, which proves both the extraction and the diagnostics.
