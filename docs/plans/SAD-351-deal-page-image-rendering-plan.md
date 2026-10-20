# SAD-351 — Plan Only: product images not rendering for deal-page rows

> **Status: IMPLEMENTED — steps 0-4 done, verification green, ticket In Review.**
> Outcome is recorded in §16; the analysis below is preserved as written at planning time.
> Issue: https://linear.app/sad-mod/issue/SAD-351/image-not-rendering-in-deal-page-extracted-data
> *"When collecting product data from a deal page, product images are not rendering in the
> preview. Investigate the root cause and fix the issue so that all successfully extracted
> product images display correctly in the preview. Ensure the fix does not break image
> rendering for products collected from other page types, preserve existing functionality,
> and avoid unnecessary changes to unrelated code."*
> Priority 1 · Label `Bug` · Project PPHunt · State Todo · Assignee MakeTheNewHistory.
> Repository state analysed: `32c11fc` (main) — re-pulled before implementation started.

---

## 0. Baseline — measured in this sandbox, not assumed

| Check | Command | Result |
|---|---|---|
| Install | `npm ci --no-audit --no-fund` | OK, 606 packages, `wxt prepare` clean |
| Typecheck | `npx tsc --noEmit` | **clean** (exit 0) |
| Build | `npx wxt build` | OK, **1.90 MB** |
| Tests (after build, so the gated manifest suite runs) | `npx vitest run` | **947 passed / 84 files** — the true baseline |

The first diagnosis run was made at `080196b` (**938 / 84**). Before implementation,
`main` advanced to `32c11fc` (SAD-352: 2 commits, +9 tests, no image code touched — see
`git diff --stat 080196b 32c11fc`), so the baseline was re-measured and is **947 / 84**.
This reconciles with `docs/plans/SAD-349-warranty-description-plan.md` §0 (894 at the
time; SAD-348/349/352 added the rest). **Any step below must restore 84 files / 947 tests,
plus the new ones.**

> Note for future runs: SAD-349 §8 recorded that Amazon refused this sandbox. It did
> **not** on 2026-10-20 — `curl` and headless Chromium both got HTTP 200 from
> `amazon.com/deals`. That is the only reason this bug could be diagnosed from evidence
> instead of guessed. §14 has the exact reproduction kit.

---

## 1. Decisions taken (your answers, 2026-10-20)

| Question | Decision |
|---|---|
| Which page? | **`amazon.com/deals` "Today's Deals" grid** — the `data-testid="product-card"` cards. |
| Fix scope | **B** — correct the `srcset` parsing **and** use the browser-resolved `img.currentSrc` as a trusted input. |
| Defensive guard | *"Choose the best option"* → **preference, not rejection, and only inside the srcset path** (§6.1). Rationale below. |
| Workflow | **Repo convention**: plan doc → one commit per step (`SAD-351: … (step N)`) → CHANGELOG/ARCHITECTURE → `npm run verify`. |

### 1.1 Why the guard is a *preference*, not a rejection (decided here, with the reasoning)

A hard rule ("Amazon image URLs must end in `.jpg/.jpeg/.png/.webp/.gif`, else drop the
URL") would have caught this bug. It is still the wrong place to put the check:

- In `extractBestImageUrl`'s `src` / `data-src` / dynamic-JSON branches, a rejection rule
  would change behaviour for **page types that work today** — exactly what the ticket
  forbids. The same function also feeds PDP hero images (`product-detail.ts:562`) and
  fetched-PDP enrichment (`offscreen/parse.ts`), where an unusual but valid URL must not
  become `null`.
- A **second** copy of the rule in `validateAndNormalizeScrapedProduct`
  (`field-parsers.ts:1470`) would additionally apply to one-click saves and to
  JSON-LD-sourced PDP images.

So the guard is implemented as a **ranking rule inside the srcset parser only**: among the
candidates of one `srcset`, a URL that looks like a real image file outranks one that does
not. If *every* candidate lacks an extension, the first-ranked candidate is still returned
(today's permissive behaviour), so no input that works today can start failing.

---

## 2. What the bug actually is — evidence, not inference

### 2.1 The deals page has two lives, and they are different pages

| Probe on `https://www.amazon.com/deals` | Server HTML (`curl`, 780,231 bytes) | Hydrated DOM (Chromium, 6× wheel scroll) |
|---|---|---|
| `[data-testid="product-card"]` | 0 | **30** |
| `.dcl-product` (carousel card) | **29** | 0 |
| `.a-carousel-card` | 34 | 0 |
| `[data-asin]` | 0 | **30** |
| `a[href*="/dp/"]` | 31 | 162 |
| `parseAmazonCategoryPage(doc, url)` | **1** product ("Amazon Business Card", a nav link) with `imageUrl: null` | **30** products, **30 non-null `imageUrl`, all 30 broken** |

The static snapshot is the old carousel layout (`li.a-carousel-card > div.dcl-product`)
which the collectors deliberately skip (`.closest('.a-carousel-card')` in
`category-page.ts:262/275`, `search-results.ts:291/302/319`,
`field-parsers.ts:1568`). The user's browser sees the hydrated layout — a
`ProductCard-module` grid — and that is what the extension parses. So the ticket is
**not** "no products collected"; products *are* collected, and every one of them carries a
broken image URL.

### 2.2 The hydrated card's image markup (verbatim, only `data-csa-c-*` attrs removed)

```html
<div class="ProductCard-module__card_uyr_Jh7WpSkPx4iEpn4w"
     data-asin="B0FB59FN5M" data-testid="product-card" role="group">
  <div class="… ProductCard-module__imageWrapper_…">
    <a href="https://www.amazon.com/Shark-…/dp/B0FB59FN5M?ref=dlx_deals_…" data-testid="product-card-link">
      <div class="…">
        <picture>
          <source srcset="…_AC_SF226,226_QL85_.jpg?aicid=… 1x, …_AC_FMavif_SF339,339_QL58_.jpg?aicid=… 1.5x, …_AC_FMavif_SF452,452_QL58_.jpg?aicid=… 2x" type="image/avif">
          <source srcset="… 1x, … 1.5x, … 2x" type="image/webp">
          <source srcset="… 1x, …_AC_SF339,339_QL80_.jpg?aicid=… 1.5x, …_AC_SF452,452_QL80_.jpg?aicid=… 2x" type="image/jpg">
          <img class="a-amazon-image ProductCardImage-module__image_SU6C7KYJpko3vQ2fK7Kf"
               height="226" width="226" loading="lazy"
               src="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte"
               srcset="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=… 1x,
                       https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF339,339_QL80_.jpg?aicid=… 1.5x,
                       https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=… 2x"
               alt="Shark PowerPro Reveal Plus …">
        </picture>
```

**The comma is part of Amazon's size token** (`_AC_SF226,226_` = "size: fill 226×226").
It is inside the *file name*, not a srcset separator. This token shape is new on the
`ProductCard` grid; the older search/best-seller markup uses `_AC_UY218_` / `_AC_UL320_`
with no comma, which is why nobody noticed.

### 2.3 What PPHunt extracts today (probe against the hydrated DOM)

```
pageType: category
category products: 30   withImage: 30
{ asin: 'B0FB59FN5M', price: 199.99, title: 'Shark PowerPro Reveal Plus Cordless',
  img: 'https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452' }
{ asin: 'B0CFGYFCYL', price: 8.99,   title: 'OLANLY Bathroom Rugs 30x20, Extra S',
  img: 'https://m.media-amazon.com/images/I/91TX4I0i8DL._AC_SF452' }
… 28 more, all truncated at the comma
```

`extractCardImageWithTier(card)` reports this as a **hit**: the element is
`tier3_structural` (no `data-old-hires`/`data-a-dynamic-image`, and the class is
`a-amazon-image`, not `s-image`), with the **truncated** value. Telemetry therefore
records a successful image extraction, which is why nothing in the app ever reported a
miss. (Verified by running the helper against the real card.)

### 2.4 The URLs are objectively dead (HTTP, no referrer)

| URL | Result |
|---|---|
| `https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452` (what we store) | **HTTP 400**, `text/plain`, 11 bytes |
| `https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=…` (what we should store) | **HTTP 200**, `image/jpeg`, 17,156 bytes |
| `https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=…` (1×) | **HTTP 200**, `image/jpeg`, 7,055 bytes |

So the CDN is fine, `?aicid=…` is fine, and a no-referrer request is fine. The URL itself is
wrong.

### 2.5 The browser already holds a working URL

On the live page, for every card:

```
img.src === img.currentSrc === '…/_AC_SF226,226_QL85_.jpg?aicid=…'
img.complete === true, img.naturalWidth === 226
```

`currentSrc` is the URL the browser actually fetched and rendered. It cannot contain a
splitting artefact. That is the input decision **B** asks us to use.

### 2.6 Why the user sees an empty thumbnail

`ProductImageCell` (`src/engines/amazon/ui/table/columns.tsx:25-71`) renders
`<img src={imageUrl} referrerPolicy="no-referrer" onError={() => setFailedUrl(url)}>` and
swaps in an SVG placeholder (`data-testid="product-image-placeholder-<ASIN>"`) on error.
The 400 fires `onError` on every row → 30 placeholder icons. Nothing else in the pipeline
catches it: `validateAndNormalizeScrapedProduct` only checks `^https?://`
(`field-parsers.ts:1470`), `ScrapedProductSchema`/`ProductSchema` use `z.string().url()`
(`schemas/product.ts:37`) — a truncated URL is a *valid* URL — `upgradeAmazonImageUrl`
(`amazon-url.ts:299`) only normalises through `new URL()`, and `addProducts`
(`db/products.ts`) stores it as-is.

---

## 3. Root cause — one line, three consequences

`src/engines/amazon/scraper/field-parsers.ts:385-402` (inside `extractBestImageUrl`):

```ts
let srcset = img.getAttribute('srcset')?.trim();
if (!srcset) { /* first <picture><source srcset> */ }
if (srcset) {
  const urls = srcset
    .split(',')                                  // ← the bug
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)));
  const last = urls[urls.length - 1];            // ← "highest" = last
  if (last) return upgradeAmazonImageUrl(last) || null;
}
```

Trace of the real srcset through that code:

| Fragment after `split(',')` | Kept? | Why |
|---|---|---|
| `https://…/_AC_SF226` | ✅ | starts with `https://` |
| `226_QL85_.jpg?aicid=… 1x` | ❌ | fragment does not start with a scheme |
| `https://…/_AC_SF339` | ✅ | |
| `339_QL80_.jpg?aicid=… 1.5x` | ❌ | |
| `https://…/_AC_SF452` | ✅ | |
| `452_QL80_.jpg?aicid=… 2x` | ❌ | |

The last survivor — and therefore the returned value — is `…_AC_SF452`: a syntactically
valid, semantically truncated URL.

Consequences:

1. **It wins over the correct attribute.** Precedence today is
   `data-old-hires` → `data-a-hires` → `data-a-dynamic-image` → **`srcset`** → `src`.
   Because this card has a `srcset`, the perfectly good `src` (the one the browser
   rendered) is never reached. The bug *shadows* its own fallback.
2. **Every downstream check passes** (§2.6), so the bad URL is persisted and exported.
3. **It is invisible in telemetry**: the tier recorded is `tier2_semantic`
   (`img.s-image`-ish class match) — a "hit", not a miss.

---

## 4. Why 938 tests are green today

- The only `srcset` fixture in the suite is `tests/preview-images-rownumbers-export.test.tsx:51`
  (SAD-139), and its URLs are `_AC_SL1000_.jpg` / `_AC_SL1500_.jpg` — **no commas**, so the
  naive split happens to work.
- The rest of the image tests exercise the branches *above* `srcset`:
  `tests/amazon-engine-v2.test.tsx:127` and `tests/scraper-accuracy.test.tsx:154`
  (`data-a-dynamic-image`), `tests/baseline-snapshot.test.ts:443` (`data-old-hires`),
  `tests/scraper-accuracy.test.tsx:157` (direct `extractBestImageUrl` on a hires image).
- SAD-139's "deal page" fixture (`tests/preview-images-rownumbers-export.test.tsx:44-113`)
  is the *old* `deal-card-outer` / `deal-badge` shape. No test has ever contained a
  `ProductCard-module` card, `data-testid="product-card"`, or a comma-bearing image URL.

**Conclusion:** the regression surface is exactly one untested input shape, not a systemic
design flaw. The fix belongs in the one function that mis-parses it.

---

## 5. Blast radius — every consumer of `extractBestImageUrl`

Two production call sites, both switch to the fixed behaviour automatically:

| Call site | Card / page markup | `srcset` has commas? | Today | After fix |
|---|---|---|---|---|
| `extractCardImageWithTier` (`field-parsers.ts:1050`) ← search cards | `img.s-image`, `_AC_UY218_ / _UY327_ / _UY436_` (live-checked) | no | ✅ works | **identical** (still picks 2×) |
| … ← best-seller/category cards | `#gridItemRoot img`, `_AC_UL320_` | no | ✅ works | **identical** |
| … ← **deals grid cards** | `ProductCard-module`, `_AC_SF226,226_` | **yes** | ❌ **30/30 broken** | ✅ fixed (2× `…,452_`) |
| `parseAmazonProductDetail` (`product-detail.ts:562`) | `#landingImage` etc. with `data-old-hires` / dynamic JSON | n/a — early return | ✅ works | **identical** |
| One-click save (`save-product.ts:26` → search/category card parsers) | same cards | — | same as collect | fixed too (same function) |
| Offscreen PDP enrichment (`offscreen/parse.ts`) | fetched PDP HTML | n/a | ✅ works | **identical** |
| Temu engine | `src/engines/temu/scraper/field-parsers.ts` (own code) | — | untouched | **byte-identical** |

Ordering of the branches is unchanged, so nothing that currently returns a hires/dynamic
URL can start returning a srcset URL.

---

## 6. Design

### 6.1 New private helpers in `field-parsers.ts` (not exported → no dead-export risk)

```ts
/** A URL that plainly names an image file. Used to rank srcset candidates, never to reject. */
const IMAGE_FILE_RE = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;

/**
 * A comma separates srcset candidates only when the next token starts a URL.
 * Amazon embeds commas inside its size token (`_AC_SF226,226_QL85_.jpg`), so
 * `split(',')` truncates the file name and yields a URL that 400s.
 */
const SRCSET_SEPARATOR_RE = /,\s*(?=(?:https?:)?\/\/)/i;

/** `1x`, `1.5x`, `226w` … */
const SRCSET_DESCRIPTOR_RE = /^(\d+(?:\.\d+)?)(w|x)$/i;

interface ImageCandidate {
  url: string;
  /** Higher wins. `452w` → 452, `2x` → 2000, no descriptor → 1. */
  score: number;
  /** Prefers a candidate whose URL names a real image file. */
  renderable: boolean;
}

function parseSrcsetCandidates(raw: string | null | undefined): ImageCandidate[] {
  if (!raw) return [];
  const candidates: ImageCandidate[] = [];
  for (const part of raw.split(SRCSET_SEPARATOR_RE)) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url || !/^(?:https?:)?\/\//i.test(url)) continue;
    const match = descriptor ? SRCSET_DESCRIPTOR_RE.exec(descriptor) : null;
    const score = match
      ? Number(match[1]) * (match[2]!.toLowerCase() === 'x' ? 1000 : 1)
      : 1;
    candidates.push({ url, score, renderable: IMAGE_FILE_RE.test(url) });
  }
  return candidates;
}

function pickBestImageCandidate(candidates: readonly ImageCandidate[]): string | null {
  let best: ImageCandidate | null = null;
  for (const candidate of candidates) {
    if (!best) { best = candidate; continue; }
    if (candidate.renderable !== best.renderable) {
      if (candidate.renderable) best = candidate;
      continue;
    }
    if (candidate.score > best.score) best = candidate;
  }
  return best?.url ?? null;
}
```

`currentSrc` joins the same list with `score: 0` — so:

- a **renderable** `currentSrc` beats a non-renderable srcset winner (the guard),
- a renderable **srcset** candidate always beats `currentSrc`
  (keeps today's `2x` selection on search/best-seller/PDP pages),
- if the srcset yields nothing, `currentSrc` is the answer (new safety net).

### 6.2 The replacement block (drop-in for `field-parsers.ts:385-402`)

```ts
  const ownSrcset = img.getAttribute('srcset')?.trim() || null;
  const pictureSrcset =
    ownSrcset || !img.closest('picture')
      ? null
      : safeQuerySelector(img.closest('picture')!, 'source[srcset]')
          ?.getAttribute('srcset')
          ?.trim() ?? null;

  const currentSrc =
    typeof (img as Partial<HTMLImageElement>).currentSrc === 'string'
      ? (img as HTMLImageElement).currentSrc.trim()
      : '';
  const currentSrcUsable = /^https?:\/\//i.test(currentSrc);

  const fromSrcset = pickBestImageCandidate([
    ...parseSrcsetCandidates(ownSrcset ?? pictureSrcset),
    ...(currentSrcUsable
      ? [{ url: currentSrc, score: 0, renderable: IMAGE_FILE_RE.test(currentSrc) }]
      : []),
  ]);
  if (fromSrcset) {
    return upgradeAmazonImageUrl(fromSrcset) || null;
  }
```

Everything above (`width/height="1"`, `deal-badge`, `data-old-hires`, `data-a-hires`,
`data-a-dynamic-image`) and below (`src` / `data-src` / `data-lazy-src` + the placeholder
blocklist) stays **byte-identical**. Total diff: ≈50 added lines, 14 removed, one file.

### 6.3 Why the results are right for every known shape

| Input | Old output | New output |
|---|---|---|
| Deals card (comma srcset) | `…_AC_SF452` ❌ | `…_AC_SF452,452_QL80_.jpg?aicid=…` ✅ |
| Search card srcset (`1x, 1.5x, 2x`, no commas) | 2× URL | 2× URL (identical) |
| `<picture><source srcset>` only, no `img[srcset]` | last of first source | last of first source (identical; AVIF preference unchanged on purpose) |
| `data-old-hires` present | hires | hires (identical) |
| `data-a-dynamic-image` present | largest area | largest area (identical) |
| `1×1` / `.deal-badge` | `null` | `null` (identical) |
| `src` is a base64 placeholder, srcset valid | srcset | srcset (identical) |
| srcset candidates all lack an extension | last one | last one (ranking, not rejection) |
| srcset malformed, `currentSrc` valid | `src` | `currentSrc` (new, better) |

### 6.4 Alternatives considered and rejected

1. **Repair the URL at render time** (`_AC_SF452` → `_AC_SF452,452_QL80_.jpg`). Impossible
   in general: the lost part is the size token, which we cannot reconstruct, and guessing
   `_AC_SL1500_` may 404 on the CDN.
2. **Prefer `src` over `srcset`.** Would fix deals but silently *lower* resolution on
   search/best-seller pages (they rely on `srcset` for the 2× variant) — a regression on
   page types that work today.
3. **Strictly prefer `currentSrc` over `srcset`** (the most literal reading of B). Works,
   but downgrades search/best-seller thumbnails from 436 px to 218 px and changes the
   stored/exported URL for every row on those pages. Rejected as a default; it is a
   one-line reorder in §6.2 if you decide you want it (§12, gate G1).
4. **Reject non-image URLs globally** — see §1.1.

---

## 7. Implementation steps (smallest sufficient diff)

| Step | Commit message | Content |
|---|---|---|
| 0 | `SAD-351: plan for the deal-page image fix (step 0: root cause reproduced)` | this document |
| 1 | `SAD-351: parse srcset candidates comma-aware (step 1)` | §6.1 helpers + §6.2 replacement in `src/engines/amazon/scraper/field-parsers.ts` |
| 2 | `SAD-351: regression tests for the deals-grid image URLs (step 2)` | `tests/deal-page-images-sad351.test.tsx` (§8) |
| 3 | `SAD-351: document image extraction precedence + changelog (step 3)` | CHANGELOG `[Unreleased]` → Fixed; `ARCHITECTURE.md` scraper section note; `spec/10-amazon-selectors.md` image row |
| 4 | `SAD-351: full verification passed — 84→85 files, 938→N tests, tsc, wxt build (step 4)` | verification run (§10) |
| 5 | *(optional, only if you want it)* `SAD-351: follow-up note — deals carousel cards are still excluded (step 5)` | Linear comment / doc note for §12(a), no code |

Nothing else in `src/` changes. No selector, schema, message, DB, settings, export or UI
file is touched.

---

## 8. Tests to add — `tests/deal-page-images-sad351.test.tsx`

Fixture: two **real** cards from the hydrated page, trimmed (only `data-csa-c-*`,
inline `style`, the add-to-cart SVG and Amazon's truncation widgets removed — every
attribute the parser reads is verbatim). Appendix A has the exact text; keep it in the
test file, no network, no large HTML blob. The fixture was dry-run against the current
parser: it yields 2 products, both with `imageUrl: '…_AC_SF452'` — i.e. it reproduces the
bug before the fix. Assertions must target **`asin` and `imageUrl`**; the trimmed markup
is not normative for title/price text.

**A. Unit — `extractBestImageUrl` (imported from `@/lib/scraper/field-parsers`, the shim the
app uses):**

1. Comma-bearing `img[srcset]` → returns `…_AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte`
   and **not** `…_AC_SF452` (assert `expect(url).toContain('.jpg')` too).
2. Same card without `img[srcset]`, only `<picture><source>` → 2× AVIF URL, comma intact
   (pins the "first source" rule).
3. Regression: comma-free search srcset (`1x, 1.5x, 2x`) → still the 3rd URL.
4. Regression: `data-old-hires` present **and** comma srcset → hires wins.
5. Regression: `data-a-dynamic-image` present → largest area wins.
6. Regression: `width="1"` and `class="deal-badge"` → `null`.
7. Regression: `src="data:image/gif;base64,…"` + `data-lazy-src` → the lazy URL.
8. New: `picture`-less img with a malformed srcset and a `currentSrc` set via
   `Object.defineProperty(img, 'currentSrc', { value })` → returns `currentSrc`
   (**jsdom has no real `currentSrc`; the property must be defined explicitly**).
9. New: ranking — srcset winner is extension-less, `currentSrc` is image-like → `currentSrc`.

**B. Parse-level integration:**

10. `parseAmazonCategoryPage(fixtureDoc, 'https://www.amazon.com/deals')` → 2 products,
    `source: 'category'`, both `imageUrl` values end in `.jpg?aicid=…` and contain `,`.
11. `validateAndNormalizeScrapedProduct()` keeps a comma URL unchanged (proves no schema layer
    mangles it), and `ScrapedProductSchema.safeParse()` accepts it.

**C. UI (proves the reported symptom is gone):**

12. Render the production table (`ProductTable` from
    `@/entrypoints/sidepanel/table/ProductTable`, which re-exports `AmazonProductTable`) with
    one stored row whose `imageUrl` is the fixed URL → `data-testid="product-image-<ASIN>"`
    exists with `src` equal to that URL and `referrerpolicy="no-referrer"`. Reuse the
    `vi.mock('@tanstack/react-virtual', …)` trick from
    `tests/preview-images-rownumbers-export.test.tsx:18-31` — without it jsdom renders zero
    rows.
13. Keep (do not duplicate) the existing `onError → placeholder` test in SAD-139's suite.

**D. End-to-end shape (optional, cheap):**

14. `parseAmazonCategoryPage` → `addProducts(products, 'session-x')` → `db.products.toArray()`
    → every `imageUrl` survives the DB write unchanged (catches a future whitelist edit).

---

## 9. Docs to update

| File | Change |
|---|---|
| `CHANGELOG.md` | `## [Unreleased] — Deal-page images (SAD-351)` with **Fixed**: "product thumbnails on the `/deals` grid were stored as comma-truncated URLs and 400'd; srcset candidates are now split comma-aware". |
| `ARCHITECTURE.md` | One paragraph under *Scraping Pipeline* stating the image precedence: `data-old-hires`/`data-a-hires` → `data-a-dynamic-image` → `srcset` (comma-aware, image-file preferred) → `img.currentSrc` → `src`/`data-src`/`data-lazy-src`, plus the fact that Amazon size tokens may contain commas. |
| `spec/10-amazon-selectors.md` | The image rows (lines 33, 46, 72, 102) gain a note: `srcset` candidates can carry commas inside the file name; never split on `,` alone. |

No README change (no user-facing setting, permission, marketplace or column changes), so
`tests/docs-consistency.test.ts` stays satisfied.

---

## 10. Verification

```bash
npx tsc --noEmit                                    # must stay clean
npx vitest run tests/deal-page-images-sad351.test.tsx    # new suite, 0 failures
npx vitest run tests/preview-images-rownumbers-export.test.tsx \
                 tests/amazon-engine-v2.test.tsx \
                 tests/scraper-accuracy.test.tsx \
                 tests/baseline-snapshot.test.ts \
                 tests/table-v9-contract.test.tsx \
                 tests/enrich-saved-product.test.ts \
                 tests/export-image-budgets.test.tsx     # image-adjacent suites
npx wxt build                                       # must succeed FIRST…
npx vitest run                                      # …so the gated manifest suite runs
node scripts/check-dead-exports.mjs                 # new helpers are private → must stay green
npm run verify                                      # tsc + vitest + wxt build + npm audit
```

**Pass bar:** 938 + new tests across 85 files, all green, `tsc` clean, build OK,
dead-export guard green.

**Manual pass — must be done by you in a real browser** (the sandbox proves the parser, not
the extension UX):

1. Load the unpacked build, open `https://www.amazon.com/deals`, collect ~20 items →
   every row shows a thumbnail, none shows the placeholder icon.
2. Spot-check non-deal pages for parity: `https://www.amazon.com/s?k=power+bank` (search),
   `/gp/bestsellers/electronics/` (best sellers) and one PDP (`/dp/<ASIN>` while collecting +
   right-click → *Save Product Details*).
3. Export CSV/XLSX from the deals collection; the `Image URL` column must contain the full
   `…_AC_SF452,452_QL80_.jpg?aicid=…` string, and XLSX embedded images must appear.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `currentSrc` is not implemented in jsdom → tests can pass while the browser path is untested | Tests 8/9 define the property explicitly; §10 manual pass includes a real browser |
| `currentSrc` may be a `data:` URI while lazy-loading | `^https?://` gate + the existing placeholder blocklist |
| Protocol-relative `//m.media-amazon.com/…` srcset candidates are newly accepted (they were filtered out by `^https?:` before) | `upgradeAmazonImageUrl` already rewrites them to `https:`; same image, no behaviour loss |
| Ranking could reorder a srcset whose URLs lack extensions | Only a *preference*; all-extension-less input still returns today's value (§6.3, last row) |
| Perf: parsing runs per `<img>` on every parse pass | O(candidates) string work, ~1 µs; the parse cache (`AmazonParseCache`) already memoises cards |
| A regression on search/PDP pages | §5 table + tests 3-7 pin every branch that exists today |
| Telemetry tier semantics change (`imageUrl` tier) | Tier is derived from attributes, not from the URL — unchanged |

---

## 12. Explicitly NOT doing (out of scope) + follow-ups

**(a) The `dcl-product` carousel cards are still never collected.** On the *server* HTML of
`/deals` (and on `amazon.in/deals`, 43 cards) the cards are
`li.a-carousel-card > div.dcl-product-wrapper > div.dcl-product`. They are excluded on
purpose by `closest('.a-carousel-card')` in `category-page.ts:262/275`,
`search-results.ts:291/302/319`, `field-parsers.ts:1568`, `save-target.ts:59` and
`count-products.ts:33` — the same rule that keeps PDP "similar items" rails out of a
collection. Loosening it would change what every page type collects and risks double
counting. **Separate ticket if you want SSR-carousel deals supported** (they are invisible
in a normal browser session, so the priority is low).

**(b) Temu has the same naive split** (`src/engines/temu/scraper/field-parsers.ts:727-741`).
Temu image URLs (`kwcdn.com`) carry no commas today, and the repo rule is that Temu stays
byte-identical. Follow-up ticket, not this one.

**(c) `parseAmazonSearchResults` on the hydrated deals page returns 85 products with only
16 images** — an artefact of the search fallback running over a page it was not written
for. It never runs on `/deals` in production (the category parser returns 30 first, see
`amazon-content.ts:105-118`), so it is not part of this bug; recorded here only so it is
not re-discovered as "new".

**(d) A no-JS `/deals` fetch yields one bogus product ("Amazon Business Card")** — the
structural fallback matching a nav link. Pre-existing, unrelated to images.

**(e) Export image embedding** (`src/lib/export/excel.ts`, 25 MiB / 20 s budgets) needs no
change: it fetches the stored `imageUrl`, which is the thing being repaired.

---

## 13. Acceptance criteria (mapped to SAD-351)

- [ ] Collecting from `amazon.com/deals` stores full image URLs
      (`…/_AC_SF452,452_QL80_.jpg?aicid=…`), never a comma-truncated one.
- [ ] Every extracted product image renders in the preview table (side panel, full-width
      modal, preview tab, history preview — all use `AmazonProductTable`).
- [ ] The same holds on `amazon.in` (25/25 cards use the same token shape).
- [ ] Search, best-seller, category and PDP collections produce **byte-identical**
      `imageUrl` values to before (tests 3-7).
- [ ] Temu output unchanged.
- [ ] CSV/XLSX/clipboard exports carry the correct URL; XLSX images embed.
- [ ] No selector, schema, message, DB, setting or UI file changed.
- [ ] `tsc` clean · 938 + new tests / 85 files green · `wxt build` OK · dead-export guard green.

---

## 14. Reproduction kit (so the next person does not have to re-derive it)

```bash
# 1. Server HTML is the WRONG page to reason about (carousel layout):
curl -sL --compressed -A "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36" \
     https://www.amazon.com/deals -o deals.html

# 2. Hydrated DOM is the page the content script sees — capture it with Chromium:
node scripts/…/playwright-snippet.cjs   # see below
```

```js
// Playwright: dump the DOM the extension actually parses
const { chromium } = require('playwright');
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
const p = await ctx.newPage();
await p.goto('https://www.amazon.com/deals', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 1200); await p.waitForTimeout(800); }
require('fs').writeFileSync('deals-hydrated.html', await p.content());
await b.close();
```

Then, in the repo, a throw-away `tests/__probe.test.ts`:

```ts
const doc = new DOMParser().parseFromString(readFileSync('deals-hydrated.html', 'utf8'), 'text/html');
console.log(parseAmazonCategoryPage(doc, 'https://www.amazon.com/deals')
  .map((p) => [p.asin, p.imageUrl]));
// → every imageUrl ends in `_AC_SF<size>` (truncated) before the fix
```

Verified on 2026-10-20: 30/30 cards broken on `.com`, 25/25 on `.in`; search-page images
(`_AC_UY218_`, no commas) unaffected.

---

## Appendix A — trimmed real fixture for the regression test

```html
<div class="ProductCard-module__card_uyr_Jh7WpSkPx4iEpn4w" data-asin="B0FB59FN5M"
     data-testid="product-card" role="group">
  <div class="a-section a-spacing-mini ProductCard-module__imageWrapper_ytp7KTuzmF4mDTFCQLzr">
    <a class="a-link-normal ProductCard-module__cardContainingLink_OkTYz2ZO_0za69shksJ7"
       data-testid="product-card-link"
       href="https://www.amazon.com/Shark-FloorDetect-Dirt-Reveal-Rechargeable-IZ376H/dp/B0FB59FN5M?ref=dlx_deals_dg_dcl">
      <div class="a-image-container a-dynamic-image-container">
        <picture>
          <source type="image/avif" srcset="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte 1x, https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_FMavif_SF339,339_QL58_.jpg?aicid=discounts-widgets-horizonte 1.5x, https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_FMavif_SF452,452_QL58_.jpg?aicid=discounts-widgets-horizonte 2x">
          <source type="image/jpg" srcset="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte 1x, https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF339,339_QL80_.jpg?aicid=discounts-widgets-horizonte 1.5x, https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte 2x">
          <img class="a-amazon-image ProductCardImage-module__image_SU6C7KYJpko3vQ2fK7Kf"
               alt="Shark PowerPro Reveal Plus Cordless Vacuum Cleaner" height="226" width="226" loading="lazy"
               src="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte"
               srcset="https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte 1x, https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF339,339_QL80_.jpg?aicid=discounts-widgets-horizonte 1.5x, https://m.media-amazon.com/images/I/71BSpB-pRaL._AC_SF452,452_QL80_.jpg?aicid=discounts-widgets-horizonte 2x">
        </picture>
      </div>
    </a>
  </div>
  <a class="a-link-normal" href="https://www.amazon.com/Shark-FloorDetect-Dirt-Reveal-Rechargeable-IZ376H/dp/B0FB59FN5M?ref=dlx_deals_dg_dcl">
    <div class="a-section a-spacing-mini ProductCard-module__priceContainer_m0ycNRDHrTYDub6rnxSJ">
      <span class="a-price"><span class="a-offscreen">Deal Price: $199.99</span></span>
      <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">List: $329.99</span></span>
    </div>
    <p class="a-spacing-none ProductCard-module__title_awabIOxk6xfKvxKcdKDH" id="title-B0FB59FN5M">
      <span><span class="a-truncate">Shark PowerPro Reveal Plus Cordless Vacuum Cleaner - Charcoal - IZ376H</span></span>
    </p>
  </a>
</div>
```

Second card for the multi-card assertion: `<div … data-asin="B0CFGYFCYL" data-testid="product-card">`
with image base `https://m.media-amazon.com/images/I/91TX4I0i8DL.` and the same
`_AC_SF226,226_QL85_` → `_AC_SF452,452_QL80_` token sequence, title
`OLANLY Bathroom Rugs 30x20, Extra Soft`, price `$8.99`.

---

## 15. Open review gates

| Gate | Question | Default if you don't answer |
|---|---|---|
| G1 | Keep `currentSrc` *behind* a correctly-parsed srcset (preserves 2× resolution on search/PDP) or *ahead* of it (most literal reading of B, but downgrades to the 1× variant)? | **Behind** (§6.3), unless you say otherwise |
| G2 | Commit straight to `main` one step at a time (SAD-348/349 history), or open a branch/PR? | Straight to `main` |
| G3 | Do you want the manual browser pass handed off as a Linear comment with the three URLs from §10? | Yes |

---

## 16. Implementation outcome (filled in after the work — measured, not claimed)

| Step | Commit | What landed |
|---|---|---|
| 0 | `45f00e9` | this plan |
| 1 | `b48d2a0` | comma-aware `srcset` + `currentSrc` ranking in `field-parsers.ts` (+108 / −9, one file) |
| 2 | `d072ecc` | `tests/deal-page-images-sad351.test.tsx` — 16 tests |
| 3 | `d86b751` | CHANGELOG, ARCHITECTURE, `spec/10-amazon-selectors.md` |
| 4 | (this commit) | verification record + Linear |

**Live verification (headless Chromium, `amazon.com/deals`):**

| | before the fix | after the fix |
|---|---|---|
| Cards parsed | 30 | 25 (session-dependent) |
| `imageUrl` present | 30/30 | 25/25 |
| URLs that are complete image files | **0/30** | **25/25** |
| HTTP status when requested | `…_AC_SF452` → **400** | **25/25 → 200 `image/jpeg`** |

**Parity harness — the same 14 scenarios run against `45f00e9` and against the fix:**

| Result | Count | Scenarios |
|---|---|---|
| Byte-identical before and after | **9** | comma-free 2x search srcset, `data-old-hires`, `data-a-dynamic-image`, 1x1, `deal-badge`, `data-a-hires`, `data-lazy-src`, relative URL, extension-less candidates |
| Changed (the intended fix) | **5** | comma `img[srcset]`, comma `<picture><source>`, malformed srcset + `currentSrc`, srcset-vs-`currentSrc` ranking, `currentSrc`-only |

**Verification commands (step 4):**

```
npx tsc --noEmit                                   clean
npm run verify                                     tsc + vitest + wxt build + npm audit → exit 0
  vitest                                           85 files / 963 tests passed  (947 baseline + 16 new)
  wxt build                                        1.90 MB, OK
  npm audit --omit=dev                             0 vulnerabilities
node scripts/check-dead-exports.mjs                all src/lib exports have consumers (42 files)
```

**Regression proof:** running the new suite against the pre-fix file (`45f00e9`)
gives **7 failed / 9 passed**; against the fix **16 passed**. The 9 that pass in
both runs are the parity guards.

**Deliberately not done** (unchanged from §12): the `dcl-product` carousel cards
are still excluded, and Temu's own `srcset` splitter was not touched.
