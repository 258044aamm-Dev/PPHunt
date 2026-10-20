# SAD-352 — Right-click / card-icon save: are product-page details actually collected?

**Detailed, evidence-first implementation plan. No application code was changed to produce this document.**
Repository state audited: `8fa85da` (main, cloned 2026-10-20). Issue: [SAD-352 "Right-click."](https://linear.app/sad-mod/issue/SAD-352/right-click) (Bug, Urgent, Todo; no comments, attachments or relations at audit time).

| | |
|---|---|
| Mode | **Plan only.** This document is the deliverable. Implementation starts only after review. |
| Owner decisions (2026-10-20) | **Amazon engine only** · symptom = **modelled fields blank** · strategy = **diagnose first, then decide** · observed on **listing-card saves** |
| Baseline before any change | `npx tsc --noEmit` clean · targeted save/enrichment suites **98/98 pass** · full suite: **883 tests pass**, 1 file failed in the first run only because `dist/` was not built yet (the manifest suites pass after a build — verified separately, 30/30). See Appendix A. |
| Method | Full read of both trigger paths and the whole enrichment chain at `8fa85da`; git archaeology since the SAD-330 audit baseline (`cf78288`); Linear SAD-330/338/339 re-checked; a live fetch + production-parser probe (temporary harness, removed — `git status` clean); MV3 platform research from primary sources (Appendix B). |
| Hard constraint | The fix **must not change the behaviour of any existing feature**: full-page collection, History, preview surfaces, export, the Temu engine, settings, and the SAD-136 layout stay as they are unless a phase below explicitly says otherwise and is separately approved. |

> **Post-pull delta & kickoff (2026-10-20, after the audit above):** the owner landed SAD-349 (Warranty Description, 9 commits, `8fa85da → 080196b`) before implementation started. Re-audit of that delta: `save-job.ts`, `handler.ts`, `context-menu.ts`, `enrichment-fetch.ts`, `offscreen/*`, `amazon.content.ts` and all Temu paths are unchanged, so every §4–§9 conclusion stands. Two adjustments: (1) `DETAIL_FIELDS` is now **19 fields** (adds `warrantyDescription`, `warrantyDescriptionRaw`) and the model carries those two extra fields — field *counts* in §0/§5 predate this, but all Phase-1 logic below is list-driven off `DETAIL_FIELDS`, so the new fields are covered automatically; line references inside `enrich-saved-product.ts` after `DETAIL_FIELDS` shift by +6. (2) `080196b` documents a pre-existing `extractDetailBsr` bug (greedy regex over the whole detail table) — recorded under H4 as a known field-*quality* defect; its fix belongs to SAD-140's parser work, not to this ticket. Baseline re-run at `080196b`: `tsc` clean, 142 targeted tests pass (the 98 from §3.2 + SAD-349's suite). **Kickoff decisions (owner, 2026-10-20):** diagnostics = service-worker console only (§8.1.1 default); step commits go directly to `main`; measurement target = **amazon.com / Chrome**.

---

## 0. Direct answers to the issue's questions

**Q: When I click "Save Product Info" from the right-click menu or tap the icon on a product card, does the extension open that product's detail page in the background?**

> **No tab is ever opened. But the detail page *is* accessed in the background by another mechanism, and that mechanism is implemented and wired in production.**

Verified facts (all at `8fa85da`):

1. The menu item is titled **"Save Product Details"** (`SAVE_PRODUCT_MENU_TITLE`, `src/engines/amazon/background/context-menu.ts:16`).
2. There is no `tabs.create` anywhere in the save/enrichment path. Repository-wide, the only `tabs.create` is the preview page (`src/lib/preview/previewStateSync.ts:232`, `active: true`).
3. Instead, after the card row is saved, the **service worker `fetch()`es the canonical PDP URL** (`https://<marketplace>/dp/<ASIN>`) with `credentials: 'omit'` (`src/engines/amazon/background/enrichment-fetch.ts:289`), the returned HTML is parsed with the **same** `parseAmazonProductDetail()` the live page uses, inside an **offscreen document** (`src/engines/amazon/offscreen/parse.ts`), and the result is merged into the saved row (`src/engines/amazon/background/enrich-saved-product.ts`).
4. This is not dead code: the production `SAVE_PRODUCT` handler passes the real enrichment step (`src/engines/amazon/background/handler.ts:800-811` — `enrich: (input) => enrichSavedProduct(input)`), and worker-restart recovery re-runs the same step (`recoverAmazonSaveJobs`, `src/engines/amazon/background/save-job-recovery.ts`).
5. Both triggers converge on that one pipeline: context menu (`triggeredBy: 'context-menu'`, `src/entrypoints/amazon.content.ts:173-193`) and card icon (`triggeredBy: 'card-button'`, `src/entrypoints/amazon.content.ts:606-629`) both send `SAVE_PRODUCT`.

**Q: Then why is the saved data missing many details?**

> **Honest answer: the code alone cannot prove which of several distinct failure modes the user is hitting — and today the extension does not keep the evidence that would distinguish them. That observability gap is itself a code-verified defect, and it is why this plan is diagnose-first.**

What *is* proven (§5–§7):

- The two causes found by the SAD-330 audit (Description/Features columns off by default; enrichment failures reported as clean successes) **have already been fixed** on current main (SAD-333…337 — verified in code and git, §6). Re-proposing them would be wrong.
- When a real PDP *is* fetched, the static-HTML parse *can* produce the fields in question: the probe in §3.3 parsed a live-fetched PDP with the production parser and got 19/24 displayable fields including Brand, Seller, BSR, Availability, Description and 10 feature bullets. The parser is not categorically broken.
- But enrichment is **best-effort by design, with at least seven distinct failure exits** (captcha/blocked/404/timeout, `asin-mismatch`, a 3 MB size cap, circuit-breaker skip, offscreen-unavailable, worker suspension, and a "complete" verdict that requires only title+price). The outcome, the reason, and the list of fields actually changed are **computed and then discarded** — they live only in a transient `SAVE_JOB_UPDATE`, a toast, and a card badge that resets after 2.5 s. Nothing is persisted on the product row, so a user (or a developer) looking at History later cannot tell "enrichment never ran" from "enrichment ran and the PDP genuinely had no seller node".

So the root-cause *statement* that can be made without guessing is:

> **Enrichment exists and works when the cookieless background fetch returns a real, ≤3 MB, same-ASIN PDP that parses with a title and a price. Every deviation from that happy path leaves the row at card quality, and the current build records almost nothing about which deviation occurred. SAD-352 therefore has two deliverables, in order: (1) make every enrichment outcome observable and measure the real failure distribution on the user's connection; (2) apply only the targeted fixes that distribution justifies — up to and including a real background-tab fallback, but only behind a data gate.**

---

## 1. Scope, non-goals, and invariants

### In scope (SAD-352)

- Amazon engine only: the two listing-save triggers (context menu, card icon) and the enrichment chain behind `SAVE_PRODUCT`.
- The 24 already-modelled displayable fields (§5.1). Symptom confirmed by the owner: these columns exist but are blank after a listing-card save.
- Observability, measurement, and — phase-gated — reliability fixes to fetch/parse/merge/report.

### Out of scope / non-goals

- **Temu**: no context menu, card button, quick-save or enrichment exists there (verified: no matches in `src/engines/temu/**` / `src/entrypoints/temu.content.ts`). `src/engines/temu/**` must remain **byte-identical**; a Temu right-click save would be a new feature and a separate issue.
- **Schema expansion**: Amazon "Product information" specs (dimensions, weight, model number, variations, …) are not modelled today (`src/engines/amazon/types/product.ts`) and are *not* added by this plan. The owner confirmed the symptom is blank modelled fields.
- **UI changes**: no new tab (SAD-136 stands), no new settings surface, no restyle. The only permitted user-visible change is warning *text* accuracy if Phase 2 redefines `partial` (§8.2A) — and even that rides the existing toast/card mechanisms.
- **Price policy**: listing values win over PDP values for the price family (`FILL_ONLY_FIELDS`, `enrich-saved-product.ts:54-60`); detail observations stay in `snapshots`. Unchanged.
- **No new manifest permissions** in Phases 0–2. Phase 3 (background-tab fallback) is designed to need none either (`tabs`, `scripting` and the Amazon `host_permissions` already exist in `wxt.config.ts`); anything needing `declarativeNetRequest` or cookies is explicitly rejected in §9.3.
- **No speculative transport change.** The owner chose *diagnose first*: no header, credential or breaker value changes before the Gate-1 measurement (§8, Phase 1).

### Invariants every phase must preserve

1. **The row is written before enrichment starts, and enrichment can never lose or corrupt it** (current design: `save-job.ts` commits via `saveQuickProduct()` first; `enrichSavedProduct()` never throws and never re-creates a deleted row).
2. **Null never erases** a known value; a different-ASIN page is never merged into a row.
3. `mergeDetailIntoStored()` stays the **single merge point** — no second merge implementation for any new transport.
4. `PRODUCTS_COLLECTED` (full-page collection), History CRUD, preview tables and export read exactly the same `products` rows as today; no Dexie schema change in Phases 0–1, and any later one is additive and non-indexed (§8.1.2).
5. A save made **on** a PDP keeps the SAD-337 behaviour (live-DOM parse, no re-fetch) unless a later phase's data says the PDP-origin parse itself is sparse — the owner reports listing saves, so PDP-origin is observe-only in this plan.
6. Every existing test suite listed in §10.1 stays green **unmodified**, except the amendments each phase names explicitly.

---

## 2. How the issue text maps to the code

| Issue wording | Code reality (verified) |
|---|---|
| "Save Product Info" | Menu title is `Save Product Details` (`context-menu.ts:16`), contexts `['page','image','link','selection']`, scoped by `AMAZON_MATCH_PATTERNS`; registered idempotently on install/startup (`initSaveProductContextMenu`, wired in `src/entrypoints/background.ts:20`). |
| "or by tapping the corresponding icon on an individual product card" | The per-card save control (`src/engines/amazon/content/card-action-*.ts`), listing pages only (not mounted on PDPs, `amazon.content.ts:605`). Same `SAVE_PRODUCT` pipeline. |
| "does the extension open that specific product's detail page in the background" | No tab/window. Service-worker HTTP fetch + offscreen `DOMParser` (§4). Functionally "background access", literally not "opening a page": no JavaScript on the PDP ever executes, no cookies are sent, nothing renders. This distinction matters for H4 (§7). |
| "saved product data is missing many details that should be available on the product's detail page" | Owner clarified: **modelled fields blank** after **listing-card** saves. Consistent with "row stayed at card quality" — a search card hard-codes `description: null, features: []` (`src/engines/amazon/scraper/search-results.ts:124-125`) and only sometimes carries brand/seller/BSR. |
| "Do not assume the functionality is absent without verifying" | Done: it is present, wired, and unit-tested (§3, §6). |
| "Preserve the current UI and unrelated functionality" | Encoded as §1 invariants + §10 regression plan. |

---

## 3. Evidence base (what was actually run — no inference dressed as fact)

### 3.1 Static audit at `8fa85da`

Full read of: `context-menu.ts`, `save-target.ts`, `save-product.ts`, `amazon.content.ts` (save sections), `card-action-{button,layer}.ts` (state/reset), `handler.ts` (`SAVE_PRODUCT` case), `save-job.ts`, `enrich-saved-product.ts`, `enrichment-fetch.ts`, `background/offscreen.ts`, `offscreen/{parse,protocol,handlers}.ts`, `scraper/product-detail.ts`, `scraper/search-results.ts` (URL/field origin), `utils/amazon-url.ts` (`resolveProductUrl`), `db/quick-save.ts`, `save-job-recovery.ts`, `job-store.ts` (enrichment fields), `types/product.ts`, `constants/defaults.ts`, `schemas/{messages,settings}.ts`, `wxt.config.ts`, plus the SAD-330/338 audit docs, `SAD-141-qa-matrix.md`, `scripts/enrichment-spike.ts`, and git history `cf78288..HEAD`.

Greps that ground §0: `tabs.create` (1 hit, preview only), `contextMenus` (Amazon engine only), `enrichmentStatus` in `db/` + `types/product.ts` + `ui/` (**no hits** — §5.3), `db.snapshots` in any UI dir (**no hits** — §5.3), Temu feature grep (**no hits** — §1).

### 3.2 Test baseline (this machine, 2026-10-20)

`npm ci` → `npx tsc --noEmit` clean → targeted suites (`enrichment-fetch`, `enrich-saved-product`, `save-job-enrichment`, `context-menu-registration`, `save-job-pipeline`, `save-job-recovery`) **98/98 pass** → full `npx vitest run`: **883 tests passed**; 1 test *file* failed in that first run because `dist/` did not exist yet, the same sequencing artefact the SAD-330 audit recorded; after a build existed, `manifest-permissions` + `manifest-war` + `docs-consistency` pass 30/30. Conclusion: current main is a sound starting point; all enrichment behaviour is covered by **mocked** fetch/parse (`tests/enrich-saved-product.test.ts` injects `fetchImpl` and `parse:`; `tests/enrichment-fetch.test.ts` injects `fetchImpl`). No automated test exercises a live Amazon response, a real service worker, or a real offscreen document — by design, but it means green tests say nothing about the production failure the user sees.

### 3.3 Live probe (single sample — read the caveats before quoting it)

From this sandbox (datacenter IP, 2026-10-20), `GET https://www.amazon.com/dp/B09XS7JWHH` with a desktop-Chrome UA and `Accept: text/html,application/xhtml+xml`, **no cookies**:

- **HTTP 200**, real PDP (title "Sony WH-1000XM5 …" — a third-party-seller offer), **2,352,456 bytes decoded** (439,607 on the wire, gzip). **That is within 21% of the 3,000,000-char rejection cap** (`MAX_PDP_HTML_BYTES`, `enrichment-fetch.ts:27`) — the cap is close enough to be a plausible systematic failure for richer PDPs (H2, §7), which the code comment ("a fetched PDP is ~1-2 MB") does not anticipate.
- Response carried **`x-frame-options: SAMEORIGIN`** (live-verified; also consistent with public reports, Appendix B) — this kills the offscreen `DOM_SCRAPING`-iframe alternative (§9.3).
- Fed through the **production** `parsePdpHtml()` (temporary vitest harness, deleted afterwards, `git status` clean): `ok: true`, **19/24 displayable fields populated** — title, price 199.99, USD, rating 4.2, 20,213 reviews, BSR, past-month sales, delivery, hi-res image, Prime, **brand "Sony"**, **availability**, **seller**, **description**, **10 features**. Absent: `listPrice`, `discountPercentage`, `dealBadge`, `coupon`, `badge` — for this offer those may genuinely not exist; the probe cannot distinguish "absent on page" from "selector missed it" (that distinction is exactly what Phase 1 measures, §8).

**Caveats that forbid generalising from §3.3:** one ASIN, one marketplace, one moment; `curl`'s TLS/client-hints differ from a Chrome service worker (the SAD-338 spike doc makes the same point about its Node transport); a datacenter IP was *blocked* during SAD-338 (every PDP a ~3.7 KB bot interstitial) yet *served* today — Amazon's answer clearly varies with conditions nobody here controls. §3.3 proves only: *"when a real PDP is returned, today's parser + merge path can fill the fields the user finds blank."* It does **not** prove the user's browser receives real PDPs.

### 3.4 What has never been verified anywhere (the honest gap list)

- **SAD-338 is still unmeasured**: "Status: harness delivered, measurement not taken" (`docs/plans/SAD-338-enrichment-spike.md`); Linear state *In Progress*. The results table is empty by design ("never blank — write `not run`" was honoured by leaving the whole table unrun).
- **SAD-339 browser QA**: fixture runs in Chromium 131.0.0.0 passed for column visibility, but every row that needs live Amazon or the native context menu is `not run`, and the rest of the QA matrix is still 43×`TODO` (`docs/plans/SAD-141-qa-matrix.md`). `CHANGELOG.md` still says: *"Browser verification for SAD-141 is still pending (SAD-293). The behaviour above is covered by unit/integration tests, not by a real Chrome run."*
- Therefore: **nobody has ever confirmed, in a real browser on a residential connection, that a right-click save enriches.** SAD-352 is, with high likelihood, the first real-world report against that unmeasured path. (Phrased as likelihood, not fact: the issue does not state browser/marketplace, and Phase 1 must capture both.)

---

## 4. As-built flow for a listing-card save (the in-scope path)

```
TRIGGER (either)
├─ Right-click ─ document contextmenu/mousedown (capture) ─────────────── amazon.content.ts:592-601
│     └─ captureSaveTarget() remembers element ────────────────────────── content/save-target.ts
│     └─ menu "Save Product Details" onClicked ────────────────────────── background/context-menu.ts:144-163
│           └─ dispatchToAmazonTab(SAVE_CONTEXT_PRODUCT) ──────────────── context-menu.ts:111-141
│                 └─ resolveSaveCandidate(capture, 'context-menu') ────── content/save-product.ts:97-124
│                       └─ parseAmazonSearchCard / CategoryCard ───────── scraper/search-results.ts, category-page.ts
└─ Card icon ─ createCardActionLayer.onSave ───────────────────────────── amazon.content.ts:606-629
      └─ extractProductFromCard(card) ─────────────────────────────────── content/save-product.ts:24-33
            (both) ──► SAVE_PRODUCT { jobId, product, context } ────────► background/handler.ts:800
                              └─ handleSaveProduct() ──────────────────── background/save-job.ts:155
                                   ├─ job-store.begin (storage.session mirror, SAD-289)
                                   ├─ resolveOneClickCollection()
                                   ├─ saveQuickProduct()  ── ROW COMMITTED HERE (card fields)
                                   │     └─ products row + snapshots row (source:'listing')
                                   ├─ report { state:'enriching' }   (skipped if pageType==='product-detail', SAD-337)
                                   └─ enrich = enrichSavedProduct() ─ handler.ts:811
                                         ├─ semaphore, MAX_CONCURRENT_ENRICHMENTS = 2        enrich-saved-product.ts:26
                                         ├─ fetchPdpHtml(product.url, asin)                    enrichment-fetch.ts
                                         │     SW fetch, credentials:'omit', 12 s timeout,
                                         │     1 retry (timeout/5xx only), ≤3,000,000 chars,
                                         │     captcha text-probe, final-URL ASIN check,
                                         │     per-marketplace circuit breaker (3 strikes / 60 s)
                                         ├─ parsePdpHtmlViaOffscreen(html, url, asin)          background/offscreen.ts
                                         │     └─ offscreen DOM_PARSER doc (Chrome)
                                         │        or inline DOMParser fallback (Firefox event page)
                                         │        └─ parsePdpHtml = DOMParser + parseAmazonProductDetail
                                         │           + validateAndNormalize + expected-ASIN check  offscreen/parse.ts
                                         ├─ mergeDetailIntoStored(stored, detail)              enrich-saved-product.ts:103-147
                                         │     └─ db.products.update(id, patch)  (only if fields changed)
                                         ├─ appendSnapshot(source:'detail')                    db/quick-save.ts
                                         └─ status: complete iff title && price!=null          enrich-saved-product.ts:262
                              └─ report { state:'completed', enrichmentStatus, warning? }
                                   ├─► originating tab: menu path → toast (amazon.content.ts:215-247,
                                   │     gated on pendingSaveJobId, set ONLY by the menu path);
                                   │     card path → card badge via applyJobUpdate (2.5 s reset)
                                   └─► side panel toast (SAD-343, sidepanel/App.tsx:309) if open
```

Key structural facts the plan relies on:

- **The fetched URL is canonical by construction.** Card parsers build `product.url` via `resolveProductUrl(null, asin, pageUrl)` → `https://<host>/dp/<ASIN>` (`amazon-url.ts:256-276`), so sponsored click-redirect URLs (`/sspa/click…`) never reach the fetcher. An `asin-mismatch` can therefore only come from Amazon redirecting the canonical URL itself (variant parent/child resolution, interstitials).
- **Enrichment input is minimal**: `{ jobId, asin, productUrl, sessionKey }` (`save-job.ts:46-51`, `enrich-saved-product.ts:62-68`). The listing `pageUrl`, the originating `tabId` (present in `SaveJobDeps` for reporting), and the trigger are *not* passed into enrichment today — relevant to fix options 2D and Phase 3 (§8–§9).
- **Enrichment result is richer than its consumption.** `EnrichSavedProductResult` carries `fieldsChanged`, `snapshotCreated`, `reason`, `currencyMismatch` — `save-job.ts` reads only `status` + `errorCode` and discards the rest. Phase 1 exploits this: the data needed for diagnosis already exists at one choke point.
- **Save-from-PDP is a different animal** (out of scope, observe-only): `resolveSaveCandidate` parses the live DOM (`save-product.ts:104-114`), the row is written with `source:'detail'`, enrichment is skipped and status forced to `complete` (`save-job.ts:251-270`, SAD-337). If that live parse is sparse (selector drift, page not settled), there is deliberately no second pass.
- **Worker suspension**: the job (incl. `productUrl`, `sessionKey`, `tabId`) is mirrored to `storage.session`; on worker start, `recoverAmazonSaveJobs()` re-runs enrichment **at most once**, then settles for `interrupted` (`save-job-recovery.ts`). Chrome terminates an idle extension service worker after ~30 s and can cut a fetch whose response takes >30 s (Appendix B) — the 12 s fetch timeout (×2 attempts + 1.5 s delay ≈ 25.5 s worst case) lives just inside that envelope, which is why recovery exists.

---

## 5. Field-level audit: what a PDP can add, what the merge allows, what the row remembers

### 5.1 The model (27 fields; 24 displayable)

`ScrapedAmazonProduct` (`types/product.ts:9-36`): `asin, url, title, price, listPrice, discountPercentage, dealBadge, currency, rating, reviewCount, bestSellersRank, pastMonthSales, coupon, badge, delivery, imageUrl, isSponsored, isPrime, brand, availability, seller, description, features, source` (24 with table/export columns) + `listingCategory, sectionLabel, placements` (grouping/context, no column).

### 5.2 The merge whitelist (where "collected" can still mean "not saved to the row")

`mergeDetailIntoStored()` merges **only** `DETAIL_FIELDS` (17: title, price, listPrice, discountPercentage, rating, reviewCount, bestSellersRank, availability, seller, brand, description, imageUrl, coupon, delivery, dealBadge, pastMonthSales, badge) **+** `features` (wholesale replace) **+** `isPrime` (OR). Rules: detail `null`/empty never overwrites; the price family (`price, listPrice, discountPercentage, availability, currency`) is *fill-only* and skipped entirely on currency mismatch.

Consequences that are intentional (do not "fix" without a product decision) — and one to verify:

| Field | Behaviour today | Verdict |
|---|---|---|
| `price/listPrice/discountPercentage/availability` | Fill-only: the value the user saw on the card wins; PDP value goes to the snapshot. | Intentional (SAD-296). If the card value is a *placeholder* rather than absent, the PDP can never correct it — **verify in Phase 1 what card parsers emit for these on the failing pages** before calling it a bug. |
| `currency` | Named in `FILL_ONLY_FIELDS`/`PRICE_FAMILY` but **absent from `DETAIL_FIELDS`**, so the loop never merges it. | Harmless *iff* card parsers always set currency (they resolve it from the page/marketplace). Phase 1 instrument check; do not change on suspicion. |
| `source` | Not merged: an enriched card row still displays Source = `search`. | Provenance gap (SAD-330 RC4, still true). Cosmetic today; becomes relevant only if §8.1.2 persists provenance. |
| `badge` | In `DETAIL_FIELDS`, but `parseAmazonProductDetail` never sets it (its candidate object has no `badge`). | Dead merge slot; card value is the only source. Not a SAD-352 fix. |
| `isSponsored`, listing context | Never taken from the PDP (PDP hard-codes `false`). | Correct by design — merging would erase listing context; this is why `mergeScrapedProductFields` is deliberately *not* reused here. |

### 5.3 The row remembers nothing about enrichment (the observability defect)

- No `enrichmentStatus` (or reason/time/fields-changed) exists on `Product`/`AmazonProduct`, in `db/`, or in any UI component (grep-verified, §3.1). It exists only on the transient `SAVE_JOB_UPDATE` payload and in the `storage.session` job mirror (TTL-swept).
- The `snapshots` store *does* record a `source:'detail'` observation per successful enrichment — but **no UI reads `db.snapshots`** (grep-verified), and a *failed* enrichment writes no snapshot at all. Post-hoc, "no detail snapshot" is the only forensic trace, and it cannot say *why*.
- User-visible signals are ephemeral and asymmetric: the completion **toast** (which carries the SAD-335/336 warning text) is produced only for the **menu** path — `handleSaveJobUpdate` returns early unless `payload.jobId === pendingSaveJobId`, which only `handleSaveContextProduct` sets (`amazon.content.ts:188,215`). The **card icon** shows a partial badge, which auto-resets after `CARD_ACTION_COMPLETED_RESET_MS = 2_500` ms (`card-action-button.ts:20`) — the SAD-339 fixture run measured the partial signal living ~2.2 s. The side-panel toast (SAD-343) helps only if the panel is open and looking at the right tab.
- `complete` is defined as `Boolean(detail.title) && detail.price !== null` (`enrich-saved-product.ts:262`). A PDP that yields title+price but no brand/seller/BSR/availability/description/features is reported **`complete` — silently**. This is a code-proven way to get exactly the reported symptom ("it said Saved, fields are blank") *even when fetch and parse both "succeed"*. (Which fields were missing is not recorded anywhere.)

### 5.4 Ruled out (so implementation does not chase them again)

Carried over from the SAD-330 harness and re-verified by reading at `8fa85da`: Zod does not strip PDP fields; the `[sessionKey+asin]` compound index exists and is used by both write and enrichment lookup; `src/lib/db/*` are re-export shims (one database); snapshots are append-only and cannot overwrite the row; the two PDP-only columns are now built by default (§6). Storage is not the suspect. **Transport, parse completeness, and reporting are.**

---

## 6. Delta since the SAD-330 audit — already fixed; do not redo

SAD-352 reads like SAD-330, but the codebase has moved. Every SAD-330 fix below was verified present at `8fa85da`:

| Issue | Fix | Present at `8fa85da` (evidence) |
|---|---|---|
| SAD-333 | Description/Features default-on | `defaults.ts:50-54`, `schemas/settings.ts:42-43`, commit `144fa9f` |
| SAD-334 | One-time `settingsVersion` migration for existing installs | `constants/defaults.ts:57-62`, commit `db33f07`, `tests/settings-migration.test.ts` |
| SAD-335 | `failed`/`skipped`/`interrupted` enrichment all warn (only `complete` is silent) | `enrichmentWarningFor()`, `save-job.ts:124-143`, commit `1cee452` |
| SAD-336 | Warning rendered in the completion toast | `amazon.content.ts:224-225`, commit `959def6` (menu path only — §5.3) |
| SAD-337 | No redundant PDP re-fetch for saves made on a PDP | `save-job.ts:251-270`, commit `26b704a` |
| SAD-341 | Right-click capture survives an open menu (was 5 s TTL) | commit `481b60a` |
| SAD-343 | Side-panel feedback for quick saves | `sidepanel/App.tsx:233,309`, commits `693cb98`/`eda89ac` |
| SAD-344 | Subframe right-click explains itself | `context-menu.ts:124-133`, commit `fbefcdf` |
| SAD-340/342/345/346 | Doc corrections; dead `RETRY_SAVE_PRODUCT` removed; export toggles honoured; export column single-owner | commits `de18360`, `6e8a6fa`, `0ad7075`, `bdbc4b0` |
| SAD-339 | Browser QA rows added; fixture rows executed | `SAD-141-qa-matrix.md` SAD-330 section; **live-Amazon rows still `not run`** |
| SAD-338 | Measurement harness (`npm run spike:enrichment`) | `scripts/enrichment-spike.ts`, commit `ddf7a0e`; **measurement still not taken** |

**Net:** of SAD-330's root causes, RC1 (hidden columns) and RC2 (silent failure) are fixed *as designed*; RC3 (fetch fragility + breaker) was deliberately left to measurement and remains **completely uncharacterised**; RC4 (no provenance) remains; RC5 (unmodelled fields) is out of scope per the owner. SAD-352 is therefore *not* a duplicate of SAD-330: it is the field report that says blanks persist **after** the visibility fixes — pointing at RC3/RC4 and at the §5.3 completeness definition.

One correction to SAD-338's own recommendation, found by the research in Appendix B: the spike doc says adding the winning headers later is *"a two-line change"*. In a browser service worker that is not true — `Referer` cannot be set via `fetch` headers at all (only via the `referrer` init option, whose cross-origin behaviour from an extension origin must be verified in-browser), and Chrome **silently drops** a programmatic `User-Agent` on fetch requests (crbug 571722; the SW already sends the browser's real UA anyway). Any header-based fix must be re-costed accordingly (§8.2D).

---

## 7. Ranked hypotheses for "modelled fields blank after a listing save"

Each hypothesis states the code that makes it possible, the **signature** Phase 1 instrumentation must look for, and what would refute it. Nothing here is asserted as the cause until its signature is observed.

| # | Hypothesis | Mechanism in today's code | Signature in Phase-1 data | Refuted by |
|---|---|---|---|---|
| **H1** | The cookieless SW fetch is refused/challenged on the user's network | `fetchPdpHtml` classifications: `captcha` (text probe, `enrichment-fetch.ts:150-160`), `blocked` (403/429/other non-ok), `not-found` (404/410), `timeout`; one retry for timeout/5xx only. SAD-338 observed exactly this from a datacenter IP. | Outcome log dominated by `status:'failed', reason:'captcha'/'blocked'` with small `htmlBytes` (~3.7 KB interstitial) | ≥90% `ok` fetches at full size (§8, Gate 1) |
| **H2** | Real PDPs exceed the 3 MB cap | `MAX_PDP_HTML_BYTES = 3_000_000` rejects on declared `content-length` *or* decoded `html.length` → `parse-failed`. Probe PDP was 2.35 MB decoded (§3.3); the offscreen layer would accept 5,000,000 (`protocol.ts:21`) — the fetch cap is the binding one. | `reason:'parse-failed'` + `message:'…too large…'`; spike `bytes` distribution with a >3 MB tail | No sample >3 MB; no too-large outcomes |
| **H3** | Amazon redirects the canonical URL to another ASIN (variant parent⇄child, format redirect) | Final-URL ASIN must equal the saved ASIN (`enrichment-fetch.ts:390-400`) and the parse is re-checked against it (`offscreen/parse.ts:84-96`); mismatch abandons enrichment entirely (by design — merging another product would corrupt the row). | `reason:'asin-mismatch'` share, concentrated in apparel/variant categories | Mismatch ≈ 0 in the sample |
| **H4** | Fetch+parse "succeed" but the static HTML (no JS executed, no session/location cookies) lacks nodes the live DOM would have — or selectors drifted | Offscreen parse runs `DOMParser` on raw HTML; anything Amazon hydrates, lazy-loads, personalises (delivery block, buybox variants) or A/B-serves can be absent; §3.3 shows SSR covers *one* sample fully, which proves possibility, not parity. Compounded by §5.3: title+price ⇒ reported `complete`. | `status:'complete'` **with non-empty `missingDetailFields[]`**; live-DOM save of the same ASIN fills fields the fetched parse left null (parity check, §8.1.4) | `complete` outcomes with empty `missingDetailFields[]`; parity check finds no field the live DOM has that the fetch lacks |
| **H5** | The breaker turns a few failures into blanket skips during a save session | 3 consecutive captchas **or** 3×429/60 s → 60 s `circuit-open` per marketplace (`enrichment-fetch.ts:28-30`); while open, saves are `skipped` *without any request*. Breaker state is a module-scope `Map` — it resets whenever the worker restarts, so its real behaviour is bursty and unobserved. | Time-clustered `skipped:circuit-open` after the first few saves of a session | No `circuit-open` outcomes; or skips only from `no-permission`/`not-amazon` (different bug) |
| **H6** | The service worker is suspended mid-enrichment and the single recovery re-run also fails/dies | Job mirror + at-most-once recovery (`save-job-recovery.ts`); terminal fallback is `interrupted`. Fetches >30 s can be cut by Chrome (Appendix B); worst-case fetch path ≈ 25.5 s (§4). | `interrupted` outcomes; jobs whose row exists with only a `listing` snapshot and a long enrich latency | No `interrupted`; enrich latencies ≪ timeouts |
| **H7** | The offscreen parse step is unavailable/failing in the user's browser | Chrome: race-safe single document, 30 s idle close (`background/offscreen.ts`). Firefox: no `browser.offscreen` → inline `DOMParser` fallback in the event page; if neither exists → `PARSE_UNAVAILABLE`. Firefox runtime compatibility is declared unverified in the repo (SAD-330 §8). | `ENRICH_PARSE_FAILED` with `PARSE_UNAVAILABLE`/offscreen messages, browser-correlated | Parse failures absent, or present equally with `PARSER_REJECTED` (→ H4, not H7) |
| **H8** | Page-type misclassification makes a listing save take the PDP branch (no enrichment, live-parse of the wrong document) | `detectAmazonPageType` returns `'product-detail'` when `pattern.test(...) \|\| extractASIN(activeUrl)` inside the detail-pattern loop (`page-detector.ts:58-62`) — i.e. *any* ASIN anywhere in a listing URL classifies it as a PDP before the search checks run. Then `buildSaveContext`/`save-job` treat it as a PDP save (enrichment skipped, status forced `complete`). | Saves whose `context.pageType==='product-detail'` while `pageUrl` is a search/category URL (log both — §8.1.1) | No such rows in the sample. Cheap to settle with a unit test either way (§8.2F). |

Also record, for completeness, the **null hypothesis H0**: on the sampled products the PDPs genuinely do not expose the blank fields (no seller node for Amazon-sold items in some layouts, no BSR block, buybox-less pages…). H0 is what remains when enrichment outcomes are `complete`, `fieldsChanged` is non-empty, and a manual look at the same PDP confirms the field is not on the page. H0 outcomes need *no code change* — only the §12 owner confirmation that those blanks are acceptable (and, after SAD-348, they already render as blank/"No" rather than looking like corruption).

---

## 8. Implementation plan (phased, gated)

Sequencing rule (from the owner's diagnose-first decision): **Phase 1 ships alone and produces numbers. Gate 1 (§8.1.5) selects at most the Phase-2 items the data justify. Phase 3 requires a second, explicit decision.** Each phase is one reviewable commit (or a short commit series) with its own issue under SAD-352 (§13), matching the SAD-330 working style. Branch suggestion: `feat/sad-352-enrichment-diagnostics` for Phase 1; one branch per Phase-2 item. Nothing lands on `main` mid-phase without `npm run verify` green (§10).

### Phase 0 — Guardrails and reproducible baseline (no behaviour change) · size S

1. Record this plan under `docs/plans/` (this file) and link it from the SAD-352 issue.
2. Freeze the must-not-change surface for the whole ticket: `src/engines/temu/**`, `src/entrypoints/temu.content.ts`, the Dexie `[sessionKey+asin]` index, `mergeScrapedProductFields` (collection path), SAD-136 navigation, settings UI. The regression check is mechanical: `git diff --stat main -- src/engines/temu src/entrypoints/temu.content.ts` must stay empty in every SAD-352 PR.
3. Reproduce the baseline and paste results into the Phase-1 issue: `npm ci && npx tsc --noEmit && npx vitest run <6 targeted suites in §3.2> && npm run build && npx vitest run` (build before the full run, per the §3.2 artefact).
4. Agree the sample set *before* measuring (§8.1.4) so results cannot be cherry-picked.

### Phase 1 — Observability + measurement (diagnose; no user-visible change) · size M

**Design principle:** add evidence at the one choke point that already computes it (`enrichSavedProduct`), keep every existing contract intact, and make the whole phase revertible by deleting a logger.

#### 8.1.1 Structured outcome log (the only production-code change in Phase 1)

- In `src/engines/amazon/background/enrich-saved-product.ts`, at every return point of `enrichSavedProduct()` (today: the two `stop(...)` early returns, row-missing, success, and the `catch`), emit **one** structured line via the existing best-effort pattern (`try { console.warn/info } catch {}` — mirror `logFailure` in `enrichment-fetch.ts`; a logging failure must never fail a save). Single tag for filterability, e.g. `[PPHunt] enrichment outcome`, payload:
  `{ jobId, asin, status, reason?, errorCode?, httpStatus?, htmlBytes?, fieldsChanged[], missingDetailFields[], snapshotCreated, currencyMismatch, ms }`.
- To fill `httpStatus`/`htmlBytes` for the ok path, extend the *internal* hand-off inside `enrichSavedProduct` only (it already holds the `EnrichmentOutcome`); **do not** change `EnrichmentOutcome`, `EnrichSavedProductResult` consumers, or any message schema in this phase. `reason` already exists on the result; `missingDetailFields` is new, computed as: after the merge (or on the parsed detail when no merge happened), the subset of `DETAIL_FIELDS + features` still `null`/undefined/empty on the stored row. Implement it as a small pure helper next to `mergeDetailIntoStored` so it is unit-testable without a browser.
- Also log the save context needed to test H8: `context.pageType` and `context.triggeredBy` are known in `handleSaveProduct` but not passed to `enrich`. Cheapest non-invasive route: include them in the *existing* `SAVE_JOB_UPDATE` debug surface only if already present — they are not. So: log them from `handleSaveProduct` in the same structured line family at job start (`[PPHunt] save job`), zero contract change. **Do not** widen `EnrichmentStepInput` in Phase 1.
- Console-only is the default sink (service-worker console, inspectable via `chrome://extensions` → *Inspect views: service worker*). **Decision for the implementer to confirm with the owner before writing code:** if console-only proves too lossy for the user's repro (worker restarts clear nothing in the console, but the user must have it open *during* the saves), the fallback is a bounded diagnostics ring (last ~50 outcomes) in `storage.local` under one new key, written by the same logger — no UI, read back via DevTools. Pick one; do not build both speculatively.
- Tests (new, `tests/enrich-saved-product.test.ts` + helper unit tests): every return path emits exactly one outcome with the documented payload shape; `missingDetailFields` computation (empty on full detail; lists brand/seller/etc. on sparse detail; features `[]` counts as missing); logger throwing does not change the returned result (inject a throwing console). No existing test changes — outcomes/statuses are untouched in Phase 1.

#### 8.1.2 (Only if the owner wants provenance to survive the session) persist the outcome on the row — deferred decision

If measurement shows users need to see *later* which rows are card-only (RC4), the minimal additive change is three **optional, non-indexed** fields on `AmazonProduct` (`enrichmentStatus?`, `enrichedAt?`, `enrichmentReason?`) written by the same `db.products.update` the merge already performs (and by a status-only update when enrichment fails — note: today a failed enrichment writes *nothing*; this adds one small write on failure paths and must keep the "never resurrect a deleted row" guard). Before implementing, the implementer must read `src/engines/amazon/db/database.ts` version history and confirm whether a Dexie version bump is required for non-indexed additions under the repo's conventions; if a bump is required, it ships with migration tests in the style of `tests/settings-migration.test.ts`/`tests/snapshot-store-migration.test.ts`. No UI column in SAD-352 (History rendering would be its own issue). **Default for this plan: skip 8.1.2 unless Gate 1 shows it is needed.**

#### 8.1.3 Finish SAD-338 with an upgraded harness (scripts/docs only)

- Run `npm run spike:enrichment -- --count 30` on a **residential** connection for the owner's primary marketplace, with the metadata the spike doc demands (connection type, country, marketplace, date, sizes). Fill the SAD-338 table or write `not run` per row — no silent blanks.
- Extend the harness in `scripts/enrichment-spike.ts` only (zero production risk): it already records `bytes` per sample; add (a) a `> MAX_PDP_HTML_BYTES` counter imported from production constants, and (b) optional field-coverage per `ok` sample by running the production `parsePdpHtml` over the fetched HTML in jsdom (the §3.3 probe pattern, productised). This upgrades the spike from "did HTTP succeed" to "did the *fields the user is missing* come back" — the H4 test the current harness cannot perform.
- Add one in-browser probe result the spike cannot provide: from a real unpacked build's service-worker console, test whether `fetch(pdpUrl, { referrer: listingUrl })` throws or is honoured from the extension origin (settles the §6 header correction before 2D is even considered).

#### 8.1.4 Guided reproduction on the real extension (the user-visible truth)

Protocol (record browser + version, marketplace, connection, timestamps for every row):

1. Unpacked build of the Phase-1 branch; service-worker console open and filtered to `[PPHunt]`.
2. Sample: ≥20 products across ≥4 categories, deliberately including: a variant-parent product (colour/size), a third-party-seller offer, an Amazon-sold offer, a buybox-less/used-only offer if findable. Owner to nominate ASINs from their real workflow (Open Question Q3, §12).
3. For each: save once via **card icon**, and for a 5-product subset also via **context menu** (same pipeline — asymmetry would itself be a finding). Record: outcome log line, toast/card signal, `fieldsChanged`, `missingDetailFields`, and the stored row via DevTools → Application → IndexedDB → `PPHuntDB.products` (plus whether a `detail` snapshot exists).
4. Burst test: 6 saves in <60 s (H5); repeat one save with DevTools offline (control); terminate the service worker mid-enrichment once (`chrome://extensions`, H6).
5. Parity subset (H4): for 5 ASINs, also save from the PDP itself (live-DOM path) into a separate collection and diff the two rows field-by-field.
6. Write results to `docs/plans/measurements/SAD-352-<date>.md` (JSON alongside, spike-style). Every row: `pass/fail/not run` + reason.

#### 8.1.5 Gate 1 — decision matrix (thresholds fixed now, before data)

| Observed distribution (sample §8.1.4 + spike §8.1.3) | Conclusion | Authorised next step |
|---|---|---|
| H1 dominant (fetch `captcha/blocked` > ~25% of attempts) | Cookieless SW fetch is not viable as the only transport on this network | 2D **only if** a variant materially beats A *and* is shippable in-browser (§6 correction); otherwise **Phase 3** decision |
| H2 present (any systematic too-large share) | Cap is mis-sized vs real PDPs | 2B |
| H3 present (mismatch clustered on variants) | Correctness guard working; UX honesty lacking | 2C (reporting only; merging a different ASIN stays forbidden) |
| H4 dominant (`complete` + `missingDetailFields` non-empty; parity favours live DOM) | Static parse insufficient for those fields *and/or* completeness lies | 2A (always) + 2E; if parity gap is structural (nodes absent from HTML entirely) → **Phase 3** decision |
| H5 present | Breaker mis-tuned for human save bursts | 2F (threshold change justified by the sequence data, not taste) |
| H6/H7 present | Platform-path defect | 2G targeted fix + browser matrix row |
| H8 rows found | Detector defect | 2H (detector fix + pins) — independent, ship regardless of other rows |
| Everything ≥ ~90% `ok`, `missingDetailFields` empty, blanks match H0 on page inspection | Pipeline works; perceived bug was pre-SAD-333 builds / genuine absence | Close with 2A-lite (honest `partial` only if §5.3 still mislabels any observed row) + docs; **no transport work** |

Phase 1 exit criteria: measurement files committed, Gate-1 row selected *in the SAD-352 issue thread* with the numbers attached, Phase-2 sub-issues filed for exactly the selected items (§13).

### Phase 2 — Targeted fixes (only the items Gate 1 selects; each its own PR) · size S each unless noted

**2A. Honest completeness semantics** *(the one Phase-2 item justified by code alone — §5.3 — but still sized/shaped by Gate-1 field data).*
Redefine the success verdict in `enrichSavedProduct` so `complete` means what the user thinks it means. Default proposal (owner confirms field list at Gate 1, Q1 §12): after merge, `complete` iff (title && price) **and** none of a core detail set remains empty on the stored row — proposed core set: `brand, seller, availability, bestSellersRank, description, features`. Everything else that parsed is `partial` (existing status, existing warning sentence «Saved, but the product page had no complete details», existing card partial badge — **no new UI, no message-schema change**). Tests: amend `tests/enrich-saved-product.test.ts` «is partial, not failed, when the page has no price» family with sparse-but-priced cases; `tests/save-job-enrichment.test.ts` stays green (it keys off status, not field content). Risk: rows whose PDP genuinely lacks a core field now warn `partial` forever — that is the intended honesty, and it is why the core set needs owner sign-off with H0 data in hand.

**2B. Size-cap alignment.** If H2 fires: raise `MAX_PDP_HTML_BYTES` from 3,000,000 to at most the offscreen cap 5,000,000 (`MAX_OFFSCREEN_HTML_LENGTH`), keeping both rejection points (declared length, decoded length) and updating the stale "~1–2 MB" comment with measured percentiles. Tests: `tests/enrichment-fetch.test.ts` oversized cases re-parameterised on the constant (they already import behaviour, not the number — verify), plus a just-under/just-over pair. Note `html.length` counts UTF-16 code units, not bytes — name/semantics cleanup only if it doesn't churn callers.

**2C. asin-mismatch honesty.** If H3 fires: keep refusing the merge (correctness), but stop reporting it as a generic fetch failure. Minimal route: map this outcome to its own warning sentence through the existing plumbing — `EnrichmentErrorCode`/`SaveErrorCode` enums + `enrichmentWarningFor` gain one member (schema: `SaveEnrichmentStatusSchema`/`SaveErrorCode` in `schemas/messages.ts`, registry sync tests `tests/message-registry-sync.test.ts` must be extended, per repo convention). No variant-family modelling in SAD-352; if mismatch share is large, file the "record rejected detail observation" idea as a separate issue (SAD-338 Q3 left it open deliberately).

**2D. Fetch-shape adjustment.** Only if the §8.1.3 numbers demand it **and** the in-browser probe (§8.1.3, bullet 3) proves the mechanism works from a service worker: for a Referer win, plumb `context.pageUrl` through `EnrichmentStepInput` (`save-job.ts:46-51`) → `EnrichSavedProductInput` → `fetchPdpHtml(..., { referrer })` using the fetch **`referrer` init option** (never a `Referer` header — §6). Recovery path (`save-job-recovery.ts`) has no pageUrl; it must degrade to no-referrer, which is today's behaviour. A UA win has **no** shippable fetch mechanism in Chrome (§6) and is **not** to be re-attempted via `declarativeNetRequest` in this ticket (new permission + store review + header-spoofing surface; separate decision if ever). Tests: `enrichment-fetch.test.ts` asserts the init object gains `referrer` only when provided; `save-job-enrichment.test.ts` asserts pageUrl forwarding; recovery tests assert absence is tolerated.

**2E. Parser/selector repair for static HTML.** If H4 localises to *selectors* (nodes present in fetched HTML, missed by `AMAZON_SELECTORS.detail.*`): capture the failing HTML, **sanitize** it (strip any tokens/nonces; today's fetch is cookieless so no session data is expected — verify before committing any fixture; when in doubt, hand-minimise the fragment in the style of existing scraper tests instead of committing a page), add failing-then-passing cases to `tests/scraper-accuracy.test.tsx`/`tests/offscreen-handlers.test.ts`, and fix at the selector/helper layer (`selectors.ts`, `field-parsers.ts`). ⚠️ **Highest collateral risk in Phase 2:** `parseAmazonProductDetail` and the field parsers are shared with live collection. The full scraper suites (§10.1) are the gate; no PDP-save-only parser fork.

**2F. Breaker retune.** If H5 fires: change only `CIRCUIT_*` constants (and say why, with the sequence data, in the comment next to them). Tests already pin the state machine in `tests/enrichment-fetch.test.ts` («threshold → circuit-open» family) — re-pin numbers deliberately.

**2G. Offscreen/browser path repair.** If H7 fires: fix at `background/offscreen.ts` (e.g. creation-race or Firefox fallback) with `tests/offscreen-client.test.ts` cases; add Firefox to §10.2 manual rows. No behaviour change for Chrome happy path.

**2H. Page-detector ASIN short-circuit.** If H8 fires (or a 10-minute unit probe settles it earlier): in `page-detector.ts:58-62`, make the detail decision depend on the detail *path patterns* (and the document probe that already exists below), not on `extractASIN(url)` alone. ⚠️ `detectAmazonPageType` is used by collection, tab status and save-context alike — full suite + §10.2 listing rows are the gate; add detector unit cases for ASIN-bearing search URLs first (red), then fix (green).

### Phase 3 — Background-tab fallback (ONLY behind Gate 2) · size L, separate issue(s)

**Gate 2:** Gate-1 data show the cookieless fetch *structurally* cannot deliver the fields (H1 unfixable by 2D, or H4 parity gap is "nodes only exist after page JS/session"), **and** the owner explicitly accepts the UX fact in §9.1 (a real, briefly-visible background tab). If Gate 2 is not met, this section stays a design record and SAD-352 closes after Phase 2.

Design (§9 gives the full option analysis; this is the buildable sketch):

1. **Seam, not rewrite.** `enrichSavedProduct` gains a second *transport* behind its existing deps (`deps.fetchDetail?` alongside today's fetch+parse): `tabDetailFetcher(input) → Promise<ScrapedProduct | {status/reason}>`. Everything downstream — `mergeDetailIntoStored`, snapshot, status, semaphore — is reused verbatim. The fetch transport remains primary; the tab transport runs **only** for outcomes Gate 1 proved unrecoverable by fetch (`captcha/blocked` and/or sparse-parse), never for `not-amazon/no-permission`. A module-level constant (not a user setting — §1) controls enablement for rollback.
2. **Tab lifecycle.** `browser.tabs.create({ url: canonicalPdpUrl, active: false })` (`tabs` permission already granted). Register `tabs.onUpdated` wait-for-`complete` with a hard timeout in the fetch path's order of magnitude (~15 s, final value from Phase-1 latency data); the content script already auto-runs on PDPs. New request/response message (name it for what it does, e.g. `EXTRACT_PRODUCT_DETAIL`): background → tab `{ asin }`; content script waits for the buybox/title selectors to settle (reuse existing selector constants + a bounded MutationObserver/poll already in the codebase's idiom — do not invent a second waiting mechanism if `mutation-debounce`/parse-cache patterns suffice), runs `parseAmazonProductDetail(document, location.href)`, applies the existing captcha detector (`scraper/captcha-detector.ts`), and returns the `ScrapedProduct` (validated by a new Zod schema in `schemas/messages.ts` + registry-sync test updates).
3. **Cleanup is unconditional.** `finally { tabs.remove(tabId) }`; user-closed-tab mid-flight ⇒ typed failure, row untouched; ASIN re-verified in background exactly as the fetch path does (final URL + parsed ASIN) before merge.
4. **Worker suspension while a tab is open** (the hard part — design before code): the job mirror already stores `productUrl`/`sessionKey`; add the enrichment `tabId` to the **job-store record only** (session-scoped, no Dexie change) so recovery can close an orphaned enrichment tab and re-run via the normal path at most once. Recovery must never close a tab it did not open (tag by jobId; when in doubt, leave the tab).
5. **Concurrency & politeness:** reuse `MAX_CONCURRENT_ENRICHMENTS = 2` as the tab ceiling too (consider 1 for tabs — decide from burst-test data); breaker outcomes from the tab path feed the *same* per-marketplace breaker (a captcha in a tab is still a captcha).
6. **Tests:** tab-fetcher unit tests with mocked `browser.tabs` (create/onUpdated/remove, timeout, user-close, wrong-ASIN, captcha) in the style of `tests/enrichment-fetch.test.ts`; merge/status integration via `tests/enrich-saved-product.test.ts` with the new transport injected; message-schema conformance additions; a §10.2 browser row proving focus is never stolen and no orphan tabs remain after worker termination.

---

## 9. Options analysis for "access the PDP in the background" (research-grounded)

The owner asked whether the PDP is *opened* in the background. For completeness, all realistic mechanisms, with the platform facts that bound them (sources in Appendix B):

### 9.1 Background tab — `tabs.create({ active: false })` + existing content-script parser

- **What it is:** a real tab loading the real page (JS executes, user's session/location apply, page looks like a navigation), parsed by the *same* `parseAmazonProductDetail` already shipped for live PDPs, then closed.
- **Platform facts:** Chrome has **no truly hidden tabs** — `active: false` creates a visible tab-strip entry that simply doesn't take focus. Background tabs are also subject to timer/render throttling, so "page complete" needs the settle-wait in §8 Phase 3. No new permissions (`tabs` + host permissions + content-script matches already exist).
- **Verdict:** highest fidelity, heaviest weight (full page load per save, tab-strip flicker, orphan-tab edge cases). Justified **only** as a Gate-2 fallback for transport failures, never as the default for every save.

### 9.2 Keep service-worker fetch (today) — measure, then micro-tune

- **Platform facts:** extension-origin fetches bypass CORS for hosts in `host_permissions` (all 23 marketplaces already listed) — this is why the fetch lives in the worker. §3.3 proves the happy path can return a parseable, field-complete PDP. Weaknesses are empirical (H1/H2/H4), hence Phase 1.

### 9.3 Rejected, with reasons (recorded so they are not re-proposed blind)

| Option | Why rejected |
|---|---|
| Offscreen `DOM_SCRAPING` iframe loading the PDP inside the offscreen document | Amazon serves `X-Frame-Options: SAMEORIGIN` (live-verified §3.3; the header refuses cross-origin framing) — the iframe body would be empty. Stripping the header needs `declarativeNetRequest` response-header modification: new permission, security weakening, store-review surface. **Rejected.** |
| Tab-side fetch from the listing tab (`credentials: 'include'`) | Technically permitted same-marketplace (same-origin ⇒ page CORS satisfied since Chrome 85; no manifest change) — SAD-338 §2.2 is correct on the mechanics. **Rejected for SAD-352** because it (a) sends the user's Amazon session cookies by design — the product deliberately chose `'omit'`; changing that is a privacy/product decision the owner did not take (they chose *diagnose first*); (b) breaks cross-marketplace and post-restart recovery saves (no Amazon tab guaranteed); (c) still parses static HTML, so it fixes H1-class failures only, not H4. Revisit only as an explicit, separate product decision. |
| Setting `User-Agent`/`Referer` as fetch headers | Not shippable: Chrome silently drops programmatic UA on fetch (crbug 571722); `Referer` is a forbidden header (only the `referrer` init option exists, and its extension-origin behaviour is unverified — §8.1.3 probe). Node-side spike wins for these variants therefore do **not** translate directly. |
| Third-party product APIs / PA-API | New credentials, cost, ToS surface, data-model mismatch; nothing in the repo gestures at it. Out of scope. |

---

## 10. Regression-safety and verification plan

### 10.1 Automated gates (every phase)

- `npm run verify` (= `tsc --noEmit && vitest run && wxt build && npm audit --omit=dev`) **and** `npm run check:dead-exports`. Note the §3.2 artefact: build once before judging manifest-suite failures on a fresh clone.
- Suites that must stay green **unmodified** (amendments allowed only where §8 names them):
  `save-job-pipeline`, `save-product`, `collection-resolution`, `quick-save-data-layer`, `assign-saved-product`, `product-assignment`, `export-collection`, `export-service`, `history-preview-export`, `table-v9-contract`, `preview-*`, `scraper-accuracy`, `temu-isolation`, `temu-schemas`, `temu-scraper`, `manifest-permissions`, `manifest-war`, `message-registry-sync`, `message-schema-conformance`, `job-store`, `mv3-state-survival`, `offscreen-client`, `offscreen-handlers`, `context-menu-registration`, `card-action-*`, `save-target-resolver`, `settings-migration`, `settings-consumption`, `session-lifecycle`.
- Mechanical scope checks per PR: `git diff --stat` shows no Temu paths; no `wxt.config.ts` permission additions (Phases 0–3 as designed); no changes under `src/entrypoints/sidepanel/**` or `src/engines/amazon/ui/**` unless a phase explicitly calls for warning-text consumption (none do — text originates in `save-job.ts`).
- Data-integrity checks (Phase ≥1): pre-existing collections open unchanged; detail snapshots still cascade on History delete; *Ask Every Time* assignment still happens after enrichment (ordering in `save-job.ts` preserved); a row deleted mid-enrichment is not resurrected (existing guard — keep its test).

### 10.2 Browser QA (new "SAD-352 enrichment" section in `docs/plans/SAD-141-qa-matrix.md`)

Every row ends `pass / fail / not run` + browser + version (repo rule). Minimum rows:

1. Search page → card icon save → outcome log `complete`, History row shows brand/seller/description/features; Preview (Sidebar *and* Overview *and* `/preview.html`) shows them; CSV + XLSX export contains them.
2. Same via right-click menu → toast text matches outcome (silent on complete, warning otherwise).
3. Six rapid saves → no `circuit-open` surprises beyond what Gate-1 predicted; card states all settle.
4. Variant-parent product → outcome recorded honestly (2C text if shipped); row keeps card fields, never another ASIN's.
5. Offline save → row survives, warning shown, outcome logged as fetch failure.
6. Terminate service worker mid-enrichment → recovery completes or reports `interrupted`; no stuck spinner; (Phase 3 only) no orphan tabs.
7. PDP-origin save → SAD-337 behaviour unchanged (no network fetch in the log).
8. Full-page collection on the same page afterwards → counts/dedup unaffected by prior quick saves.
9. Delete the collection → products + snapshots gone.
10. Firefox build → enrichment outcome logged via the fallback path (or explicitly `not run` with reason).
11. (Phase 3 only) Fallback tab: focus never leaves the listing tab; tab appears inactive and closes itself; closing it manually mid-flight degrades to a warning, row intact.

### 10.3 Rollback

Phase 1 reverts by deleting the logger (+ helper + tests) — no data written, nothing to migrate. Each Phase-2 item is independently revertible (constants/status logic/scoped plumbing). Phase 3 ships behind its enable constant; disabling restores today's behaviour exactly, with the message schema remaining as inert additive surface until a follow-up removes it.

---

## 11. File-by-file change map (anticipated; Gate 1 may delete rows, never silently add)

| File | Ph.1 | Ph.2 (if selected) | Ph.3 (if gated in) |
|---|---|---|---|
| `docs/plans/SAD-352-*.md` (this file), `docs/plans/measurements/*`, `docs/plans/SAD-338-enrichment-spike.md` (results), `docs/plans/SAD-141-qa-matrix.md` (rows) | ✔ write | update | update |
| `src/engines/amazon/background/enrich-saved-product.ts` | ✔ outcome log + `missingDetailFields` helper | 2A completeness | transport seam |
| `src/engines/amazon/background/enrichment-fetch.ts` | — (read) | 2B cap, 2D `referrer`, 2F breaker | outcome feeds same breaker |
| `src/engines/amazon/background/save-job.ts` | ✔ job-start context log only | (2A rides existing warning logic) | forwards `tabId/pageUrl` to enrich input |
| `src/engines/amazon/background/handler.ts` | — | — | passes sender tab id if seam needs it (already has it) |
| `src/engines/amazon/background/save-job-recovery.ts`, `job-store.ts` | — | — | orphan-tab bookkeeping |
| `src/engines/amazon/background/offscreen.ts`, `offscreen/*` | — | 2G only | — |
| `src/engines/amazon/scraper/{selectors,field-parsers,product-detail,page-detector}.ts` | — | 2E selectors, 2H detector | — (reuse as-is) |
| `src/engines/amazon/schemas/messages.ts`, `types/index.ts` | — | 2C new error-code member | new `EXTRACT_PRODUCT_DETAIL` schema |
| `src/engines/amazon/db/quick-save.ts`, `db/database.ts` | — | §8.1.2 only if approved | — |
| `src/entrypoints/amazon.content.ts`, `content/*` | — | — | handle `EXTRACT_PRODUCT_DETAIL` in the tab |
| `src/engines/amazon/ui/**`, `src/entrypoints/sidepanel|preview|overlay/**` | — | — | — |
| `wxt.config.ts` (permissions) | — | — | — (by design; a diff here fails review) |
| `src/engines/temu/**`, `src/entrypoints/temu.content.ts` | **never** | **never** | **never** |
| `scripts/enrichment-spike.ts` | ✔ harness extension | — | — |
| `tests/*` | new logging/helper tests | per-item amendments (§8) | tab-transport + schema tests |
| `CHANGELOG.md`, `ARCHITECTURE.md` | — | entry per shipped item; keep §3.4's "browser verification pending" wording honest until §10.2 runs | same |

---

## 12. Open questions to settle at the gates (not blockers for Phase 0–1)

- **Q1 (Gate 1, blocks 2A):** which fields form the `complete` core set? Proposal in §8.2A; decide with H0 data (fields Amazon often legitimately omits should not make every save "partial").
- **Q2 (Phase 1 kickoff):** diagnostics sink — service-worker console only, or the bounded `storage.local` ring (§8.1.1)? Decide before coding; build one.
- **Q3 (Phase 1 kickoff):** owner to nominate the real-world ASIN sample + primary marketplace(s) + browser (Chrome/Edge/Firefox?) for §8.1.4 — the failure distribution is only meaningful on the workflow that reported SAD-352.
- **Q4 (Gate 2 only):** accept a visible background tab as a fallback (§9.1), including during bursts (up to the concurrency ceiling)? And the standing rejection of session cookies (§9.3) — confirm it remains rejected.
- **Q5 (any time):** does the owner want §8.1.2 row-level provenance as a follow-up feature (e.g. a History completeness indicator)? Deliberately *not* bundled into SAD-352's fix phases.

## 13. Suggested Linear breakdown (file only on owner request / at Gate 1)

Parent **SAD-352**, in execution order (mirrors the SAD-330 → SAD-333…339 pattern):

1. *Phase 0/1a:* baseline + structured enrichment outcome logging (`missingDetailFields`) — no behaviour change.
2. *Phase 1b:* spike upgrade + residential measurement (closes the SAD-338 measurement debt; link SAD-338, do not duplicate it).
3. *Phase 1c:* guided repro §8.1.4 + Gate-1 decision recorded with numbers.
4. One issue per selected Phase-2 item (2A…2H) — created **after** Gate 1, titled by mechanism (e.g. "Redefine enrichment `complete` to require the core detail fields").
5. *Phase 3 (conditional):* background-tab enrichment fallback — parented separately, blocked by Gate 2.
6. *Close-out:* §10.2 QA rows executed/recorded; SAD-339/SAD-293 matrices updated; CHANGELOG.

Relations to set when filing: Phase-1b *relates to* SAD-338 (same measurement); Phase 2 items *blocked by* the Gate-1 issue; Phase 3 *blocked by* the Gate 2 decision comment. SAD-352 itself is *related to* SAD-330 (same pipeline, different residual causes — §6).

---

## Appendix A — Commands run for this plan and their results

```console
$ git clone https://github.com/MakeTheNewHistory/PPHunt.git   # main @ 8fa85da
$ npm ci
$ npx tsc --noEmit                                            # clean
$ npx vitest run tests/enrichment-fetch.test.ts \
    tests/enrich-saved-product.test.ts tests/save-job-enrichment.test.ts \
    tests/context-menu-registration.test.ts tests/save-job-pipeline.test.ts \
    tests/save-job-recovery.test.ts                           # 98/98 pass
$ npx vitest run                                              # 883 pass; 1 file failed pre-build (dist/ artefact)
$ npx vitest run tests/manifest-permissions.test.ts \
    tests/manifest-war.test.ts tests/docs-consistency.test.ts # 30/30 after build existed
$ curl -sI  https://www.amazon.com/dp/B08N5WRWNW              # x-frame-options: SAMEORIGIN
$ curl -s   https://www.amazon.com/dp/B09XS7JWHH              # 200, 2,352,456 bytes decoded (gzip)
# temporary vitest harness → production parsePdpHtml() on that HTML: ok, 19/24 fields (§3.3)
# harness deleted; final `git status` shows only this plan file as new.
```

Linear consulted via API: SAD-352 (issue text §2; comments/attachments/relations: none), SAD-330 (Todo, archived 2026-10-20), SAD-338 (*In Progress*, measurement checkboxes open), SAD-339 (*In Review*).

## Appendix B — Platform research sources (accessed 2026-10-20)

- Chrome *tabs* API — `active: false` semantics; discarded tabs "still visible in the tab strip" (no hidden-tab primitive): <https://developer.chrome.com/docs/extensions/reference/api/tabs>; corroborated for the scraping use-case: <https://www.xjavascript.com/blog/web-scraping-in-a-google-chrome-extension-javascript-chrome-apis/> ("Chrome extensions cannot create truly 'hidden' tabs… `tabs.create({active:false})` creates a visible background tab").
- Chrome *offscreen* API — purpose ("use DOM APIs in a hidden document without interrupting the user experience by opening new windows or tabs"), one document at a time, `runtime` only, `DOM_PARSER` vs `DOM_SCRAPING` ("embed an iframe and scrape its DOM") reasons: <https://developer.chrome.com/docs/extensions/reference/api/offscreen>.
- Content-script fetches obey the *page's* CORS since Chrome 85; extension-origin (service-worker) fetches bypass CORS under `host_permissions`: <https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/> and <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>.
- Service-worker lifetime: 30 s idle termination; a `fetch()` response taking >30 s can be cut; events/API calls reset the timer (Chrome 110+): <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>, <https://developer.chrome.com/blog/longer-esw-lifetimes>.
- Forbidden request headers: `Referer` cannot be set as a header (only via fetch's `referrer` option); `User-Agent` "used to be forbidden, but no longer is. However, Chrome still silently drops the header from Fetch requests (Chromium bug 571722)": <https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header>.
- `X-Frame-Options: SAMEORIGIN` on Amazon product pages: live response header observed in §3.3; public corroboration: <https://stackoverflow.com/questions/11914491/amazon-products-dont-show-up-in-iframes>; header semantics: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options>.

## Appendix C — One-paragraph summary for the issue thread

SAD-352 verified at `8fa85da`: the extension never opens the PDP in a tab, but background enrichment exists and is wired — the service worker fetch()es the canonical PDP (cookieless), parses it offscreen with the live parser, and merges a 17-field whitelist (+features/Prime) into the row saved from the card. The SAD-330 visibility causes are already fixed (SAD-333–337); a live probe proves the parse can fill brand/seller/BSR/availability/description/features when a real PDP is returned. What remains unproven — because SAD-338 was never measured and the build discards every enrichment outcome/reason/fields-changed after a 2.5 s card badge — is *which* of seven failure exits (challenge/block, >3 MB cap, ASIN-mismatch, sparse static parse reported as "complete" on title+price alone, breaker skip, worker suspension, offscreen unavailability) produces the blanks on the user's connection. Plan: Phase 1 adds choke-point outcome logging + finishes the residential measurement; Gate 1 then authorises only the targeted Phase-2 fixes the data support; a real background-tab fallback is fully designed but gated behind proof that the fetch transport cannot work. Temu, UI, schema and price policy are untouched throughout.
