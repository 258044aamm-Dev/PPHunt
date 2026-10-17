# PPHunt — Remediation Implementation Plan

**Target repository:** `258044aamm-Dev/PPHunt` @ `41ce22c`
**Derived from:** a codebase investigation that identified 30 findings (2 Critical, 10 High, 10 Medium, 8 Low)
**Status:** Phases 0–9 implemented; Phase 10 implementation under final review on branch `remediation/phase-0` (PR #1); Phase 11 manual execution skipped at user request (2026-10-17), not verified. See §4a for actual outcomes.

> This plan is versioned at `docs/remediation-plan/`. Progress is tracked in Linear under team
> **Sad_mod (SAD)** with the label `remediation-2026-10`: one parent issue per phase and one
> sub-issue per step. See [`CORRECTIONS.md`](./CORRECTIONS.md) for three claims in the source
> investigation report that this plan corrects.

---

## 1. Scope

All 30 findings from the investigation, plus a CI gate, plus manual browser verification of the
7 items that could not be verified in the sandbox.

| Severity | Count | In scope |
|---|---|---|
| Critical | 2 | ✅ C‑1, C‑2 |
| High | 10 | ✅ H‑1 … H‑10 |
| Medium | 10 | ✅ M‑1 … M‑10 |
| Low | 8 | ✅ L‑1 … L‑7 (+ the L‑5 enum gap that blocks C‑2) |
| Process | 1 | ✅ CI gate (no CI, no lint, no typecheck enforcement) |
| Unverifiable in sandbox | 7 | ✅ Phase 11 manual checklist |

## 2. Decisions taken

The original proposal is retained below for traceability. Actual outcomes in §4a
supersede it, including the SheetJS fallback instead of exceljs.

**Yours (confirmed):**

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | **All 30 + CI gate**, including the TanStack v9 migration (M‑5) and the xlsx replacement (H‑7) |
| D2 | M‑8 Google Fonts | **Keep the remote fonts, fix the README** — reword the privacy claim to disclose the request. No font vendoring, no bundle growth. |

**Mine (delegated — flagged for your review):**

| # | Decision | Choice | Why |
|---|---|---|---|
| D3 | H‑7 xlsx | **Replace with `exceljs`; keep `xlsx` as a devDependency** for test read-back | Removes the unfixable advisory from production deps *and* deletes ~140 lines of fragile hand-rolled ZIP/DrawingML manipulation. `npm audit --omit=dev` goes clean. See §3 risk R2. |
| D4 | M‑6 image embedding | **New setting `exportImages: 'auto' \| 'always' \| 'never'`, default `'auto'`** + per-export override + byte/time budgets | Preserves current behaviour for typical exports, bounds the 1,000-product worst case, and is a *wired* setting (contributes to H‑1 rather than adding another dead control). |

Three smaller choices I made inside the plan, also open to override:

| # | Choice | Rationale |
|---|---|---|
| D5 | **ESLint deferred** to a follow-up; CI gate is `tsc --noEmit` + `vitest` + `wxt build` + `npm audit --omit=dev` | Adding ESLint to a codebase with 111 type errors would generate a second wave of noise unrelated to any of the 30 findings. The typecheck gate delivers most of the value. |
| D6 | **L‑6 destructive-action confirms** get a new `ConfirmDialog.tsx` rather than staying as native `confirm()` | Native blocking dialogs inside a side panel are inconsistent with the existing custom modal system and are the reason the "focus management" claim in the README is false. |
| D7 | **Existing IndexedDB rows with a URL in `currency` are not auto-migrated**; the CHANGELOG tells users to re-collect or re-export | A migration would need a schema version bump and a rewrite pass over every product row. Re-collection is cheap and the corrupted value is unambiguous. A one-off migration is offered as an optional Phase‑1b step if you prefer it. |

## 3. Top risks

| ID | Risk | Mitigation built into the plan |
|---|---|---|
| **R1** | Enabling Zod validation (C‑2) starts rejecting messages that work today, breaking collection entirely | Hard sequencing: L‑1 (`targetCount` bounds) and L‑5 (`'interrupted'` enum) are fixed **inside the same step** as the schema repair, and a conformance test replays every message the app actually sends through the schema *before* the router is wired. Validation wiring is the last commit of Phase 2, not the first. |
| **R2** | `exceljs` fails to bundle for the browser (pulls `stream`, `buffer`, `archiver`, Node polyfills) | Phase 8 Step 8.0 is a **spike**: add the dep, write a 20-line `XLSX.write` equivalent, run `wxt build`, load it in a browser, confirm the file opens. The spike is a go/no-go gate *before* any of `excel.ts` is rewritten. Documented fallback: vendor the patched SheetJS build from `cdn.sheetjs.com` (confirmed reachable) — that path keeps all existing code and tests unchanged. |
| **R3** | Parse memoisation (H‑9) stops late-hydrated field enrichment | `DeduplicationEngine.mergeAndFilterNew` (`dedup.ts:55-124`) depends on *re-parsing* already-seen cards so images/ratings/BSR that hydrate late get filled in. The cache therefore keys on card element **and** stores an `isComplete` flag; incomplete cards are always re-parsed. Explicit regression test added. |
| **R4** | TanStack v9 migration (M‑5) breaks column sizing, select-all, row numbers or virtualisation | The migration is gated on two things: `tsc` reaching **zero** errors in `src/entrypoints/sidepanel/table/`, and a manual browser pass over resize / sort / select-all / virtualise at 1,000 rows (Phase 11). Existing tests cover DOM structure only, never geometry. |
| **R5** | Session-lifecycle changes (H‑5/H‑8/M‑1) alter row counts asserted by `active-tab.test.tsx` and `history-preview-export.test.tsx` | Phase 4 Step 4.0 snapshots both files' assertions before the change; expectations are only adjusted where the new behaviour is the *intended* one, and each adjustment is listed in the phase's verification section. |
| **R6** | Formula neutralisation (H‑6) corrupts legitimate values starting with `-` | Neutralisation applies to **string-typed cells only**. `Price`, `List Price`, `Rating`, `Reviews`, `Discount %` are written as numbers (`excel.ts:394-405`) and are excluded. Explicit tests for a `-68% off` discount string and a negative price. |

## 4. Phase map

```
Phase 0  Guardrails & baseline        ← must be first; everything else depends on the gate
   │
   ├──► Phase 1  Data integrity       (C-1, H-6)                     ── independent
   │
   ├──► Phase 2  Messaging foundation (C-2, H-3, L-1, L-5, H-2)      ── prerequisite for 3 & 4
   │        │
   │        ├──► Phase 3  Settings & export defaults  (H-1, M-10)
   │        │        │
   │        │        └──► Phase 8  XLSX engine replacement (H-7, M-6)   ← needs Phase 3's setting
   │        │
   │        └──► Phase 4  Session lifecycle & MV3 state (H-5, H-8, M-1, M-9)
   │
   ├──► Phase 5  Scraper performance & auto-mode  (H-9, M-2, M-7)    ── independent
   │
   ├──► Phase 6  Security hardening   (H-10, M-3, M-4, M-8)          ── independent
   │
   ├──► Phase 7  TanStack v9 migration (M-5)  ── flips tsc gate to blocking
   │
   ├──► Phase 9  Quality & accessibility (L-2, L-4, L-6, M-5 residue)
   │
   └──► Phase 10 Documentation & identity (L-7, package.json)

Phase 11 Manual browser verification & release checklist   ← last, after all code lands
```

**Recommended execution order:** `0 → 1 → 2 → 6 → 3 → 4 → 5 → 7 → 8 → 9 → 10 → 11`

Rationale for the two deviations from the dependency graph:
- **Phase 6 moved early** (it contains H‑10, a 7-string change that fixes visibly broken UI, and M‑3/M‑4 which are one-line manifest/postMessage fixes). High value, near-zero risk, no dependencies.
- **Phase 8 moved late** because it is the largest single change and depends on Phase 3's new `exportImages` setting.

Parallelisable if you have more than one contributor: `{1, 5, 6}` are mutually independent and independent of `{2}`.

| Phase | Issues | Steps | Files touched | Est. effort |
|---|---|---|---|---|
| [0 — Guardrails & baseline](./phase-00-guardrails.md) | process, part of L‑3 | 4 | 6 (2 added, 4 modified/removed) | S |
| [1 — Data integrity](./phase-01-data-integrity.md) | C‑1, H‑6 | 3 | 8 | M |
| [2 — Messaging foundation](./phase-02-messaging-foundation.md) | C‑2, H‑3, L‑1, L‑5, H‑2 | 5 | 8 | M |
| [3 — Settings & export defaults](./phase-03-settings-wiring.md) | H‑1, M‑10 | 4 | 10 | M |
| [4 — Session lifecycle & MV3 state](./phase-04-session-lifecycle.md) | H‑5, H‑8, M‑1, M‑9 | 5 | 9 | L |
| [5 — Scraper performance & auto-mode](./phase-05-scraper-performance.md) | H‑9, M‑2, M‑7 | 4 | 7 | L |
| [6 — Security hardening](./phase-06-security-hardening.md) | H‑10, M‑3, M‑4, M‑8 | 4 | 8 | S |
| [7 — TanStack v9 migration](./phase-07-tanstack-migration.md) | M‑5 | 3 | 3 | L |
| [8 — XLSX engine replacement](./phase-08-xlsx-replacement.md) | H‑7, M‑6 | 5 | 8 | XL |
| [9 — Quality & accessibility](./phase-09-quality-a11y.md) | L‑2, L‑4, L‑6, L‑3 | 4 | 12 | M |
| [10 — Documentation & identity](./phase-10-docs-identity.md) | L‑7 | 2 | 5 | S |
| [11 — Manual verification](./phase-11-manual-verification.md) | the 7 unverifiable items | 8 checks | 0 | M |

### 4a. Actual outcomes (updated 2026-10-17, Phase 10)

| Phase | Outcome |
|---|---|
| 0 — Guardrails | ✅ CI gate live. Audit gate flipped **blocking** in Phase 8.4 (proved red via a seeded-vulnerability draft PR). |
| 1 — Data integrity | ✅ C‑1 currency codes + H‑6 formula neutralisation shipped; D7 stands (no auto-migration; CHANGELOG re-collection note added in Phase 10). |
| 2 — Messaging foundation | ✅ All 14 message types Zod-validated at the router; known malformed types → `INVALID_MESSAGE` ack; unknown types ignored; L‑1/L‑5 schema pieces landed here and were completed as full features in Phase 9 (SAD‑197). |
| 3 — Settings & export defaults | ✅ Every setting wired to a consumer; notifications scoped to in-panel toasts (notifications scope decision) — no `notifications` permission added; recorded in `spec/06`. |
| 4 — Session lifecycle | ✅ Transactional session upsert (no silent drops); `storage.session` pointer for MV3 survival (H‑8); history pruning. |
| 5 — Scraper performance | ✅ Parse cache keyed on card + completeness flag (R3 mitigation held); dedup and scroll-controller fixes. |
| 6 — Security hardening | ✅ CSP tightened; overlay iframe origin-pinned with strict message allowlist (M‑4); H‑10 selector fix; M‑8 fonts kept + disclosed (D2). |
| 7 — TanStack v9 | ✅ tsc gate at 0 and blocking; 24 default columns; row heights/keyboard scroll contract pinned by tests. |
| 8 — XLSX replacement | ✅ with the **documented R2 fallback**: the `exceljs` spike was **NO‑GO** (+650 kB net vs the +400 kB gate), so the fallback ran — patched SheetJS **0.20.3** from `cdn.sheetjs.com` (advisory-free; npm's 0.18.5 carries unfixable advisories). The CFB image injector stays. Auto mode permits embedding only for at most 200 products, with 25 MiB fetched-image / 20-second image-fetch budgets; always mode bypasses auto budgets. These are not total export-size/time guarantees. D3's "xlsx as devDependency" is superseded: `xlsx@0.20.3` is a production dep. |
| 9 — Quality & a11y | ✅ ConfirmDialog + focus traps (L‑6); locale-aware currency, locale-follows-currency per the recommended option (L‑2, decision (c) — flagged for veto); O(1) row numbers via `getDisplayIndex()` (L‑4); dead exports re-derived + CI guard (L‑3); `'interrupted'` status + targetCount clamps (L‑5/L‑1, SAD‑197). |
| 10 — Docs & identity | In review (independent documentation review pending; manual smoke skipped by user). This pass: README/ARCHITECTURE/CHANGELOG/spec/PLAN reconciled; `package.json` is the single version source (`wxt.config.ts` reads it); `tests/docs-consistency.test.ts` guards chips, token hexes, version pairing and the no-line-counts rule. |
| 11 — Manual verification | Skipped at user request (2026-10-17); NOT verified — the 7 sandbox-unverifiable items (real-table geometry, XLSX opening in Excel/LibreOffice/Sheets, NVDA/VoiceOver, live collection run, etc.). |


## 5. Original planned file inventory

Historical estimates below are not a current repository inventory; use the Git diff
for actual files changed.

**Counts: 21 files created · 3 files removed · 66 files modified.**

### Created (21)

| File | Phase | Responsibility |
|---|---|---|
| `.github/workflows/ci.yml` | 0 | CI gate: install → typecheck → test → build → audit |
| `tests/baseline-snapshot.test.ts` | 0 | Golden output for `validateAndNormalizeScrapedProduct` across all existing fixtures, so later phases can prove no unintended change |
| `src/lib/utils/currency.ts` | 1 | `resolvePageCurrency(pageUrl)` + `isIsoCurrency()` guard; `localeForCurrency()` added in Phase 9 |
| `src/lib/export/sanitize.ts` | 1 | `neutralizeSpreadsheetFormula()` — one implementation shared by CSV, clipboard and XLSX |
| `tests/price-parser-currency.test.ts` | 1 | Symbol-less prices across 10 storefronts; EUR/JPY thousands separators |
| `tests/export-injection.test.ts` | 1 | Formula-injection payloads through CSV, TSV/clipboard and XLSX |
| `src/lib/schemas/scraped-product.ts` | 2 | `ScrapedProductSchema` — the schema `messages.ts:2` has always tried to import |
| `src/lib/schemas/index.ts` | 2 | Barrel export; makes `Message` and the union available to both routers |
| `tests/message-schema-conformance.test.ts` | 2 | Replays every message the app actually sends through `ExtensionMessageSchema` |
| `tests/background-router-robustness.test.ts` | 2 | All message types × `{undefined, null, {}, malformed}` payload → no throw, `sendResponse` called once |
| `tests/settings-consumption.test.ts` | 3 | Per-setting "write it → assert it took effect", plus the guard that every schema key has a non-UI consumer |
| `src/entrypoints/sidepanel/components/ErrorBoundary.tsx` | 3 | Contains render throws so one bad component cannot unmount the whole panel |
| `src/lib/db/session-state.ts` | 4 | `chrome.storage.session` persistence + rehydration of the active-session pointer |
| `tests/session-lifecycle.test.ts` | 4 | startedAt/completedAt, upsert, pruning, deterministic recovery, worker-restart survival |
| `src/lib/scraper/parse-cache.ts` | 5 | Per-card memoisation with an `isComplete` flag so late-hydrating cards are still re-parsed |
| `tests/scraper-performance.test.ts` | 5 | Parse-time budget + "second parse of an unchanged document is O(1)" + enrichment preservation + end-of-page detection |
| `src/lib/export/exceljs-adapter.ts` | 8 | Isolates `exceljs` behind the existing `buildExcelWorkbookBuffer` contract (optional — folded into `excel.ts` if the spike shows it adds nothing) |
| `src/entrypoints/sidepanel/components/ConfirmDialog.tsx` | 9 | Accessible modal replacing the four native `confirm()` calls |
| `src/entrypoints/sidepanel/hooks/useFocusTrap.ts` | 9 | React wrapper around the existing unused `trapFocus` helper |
| `tests/docs-consistency.test.ts` | 10 | Asserts the README's chip list and token hex values match `constants/defaults.ts` and `global.css` |
| `tests/fixtures/*.html` | 11 | Real Amazon markup captured during manual verification, so selector changes become testable offline |

### Removed (3)

| File | Phase | Reason |
|---|---|---|
| `src/entrypoints/sidepanel/components/OverlayDrawer.tsx` | 0 | 219 lines, zero imports anywhere in `src/` or `tests/`; a **second, conflicting** overlay implementation superseded by the iframe approach in `src/lib/overlay/overlayHost.ts`. Source of 3 of the 111 type errors (bare `chrome.*` globals). |
| `src/entrypoints/sidepanel/components/ProductsTab.tsx` | 0 | 13 lines, zero imports. |
| `src/entrypoints/sidepanel/components/CollectionsTab.tsx` | 0 | 36 lines, imported only at `App.tsx:6` and rendered only from the `default:` branch of a `switch (activeTab)` where `ActiveTab = 'collect' \| 'history'` — statically unreachable. |

### Modified (66)

| File | Phases |
|---|---|
| `.github/workflows/ci.yml` | 7, 8 (tightening the gates added in Phase 0) |
| `package.json` | 0, 8, 10 |
| `wxt.config.ts` | 6, 10 |
| `src/lib/utils/price-parser.ts` | 1 |
| `src/lib/scraper/field-parsers.ts` | 1, 5 |
| `src/lib/scraper/product-detail.ts` | 1 |
| `src/lib/scraper/search-results.ts` | 5 |
| `src/lib/scraper/category-page.ts` | 5 |
| `src/lib/scraper/selectors.ts` | 5 |
| `src/lib/scraper/scroll-controller.ts` | 5 |
| `src/lib/scraper/dedup.ts` | 5 (only if the enrichment API needs widening) |
| `src/lib/schemas/product.ts` | 1, 5 |
| `src/lib/schemas/messages.ts` | 2, 3 |
| `src/lib/schemas/settings.ts` | 3, 8 |
| `src/types/settings.ts` | 3, 8 |
| `src/constants/defaults.ts` | 2, 3, 8 |
| `src/lib/export/csv.ts` | 1 |
| `src/lib/export/clipboard.ts` | 1 |
| `src/lib/export/types.ts` | 3, 8 |
| `src/lib/export/excel.ts` | 1, 8 |
| `src/lib/db/settings.ts` | 3 |
| `src/lib/db/sessions.ts` | 4 |
| `src/lib/db/history.ts` | 4 |
| `src/lib/db/products.ts` | 4, 9 |
| `src/lib/db/database.ts` | 1 (optional migration), 4, 9 |
| `src/lib/utils/a11y.ts` | 9 |
| `src/lib/utils/formatters.ts` | 9 |
| `src/lib/overlay/openOverlay.ts` | 6 |
| `src/entrypoints/background.ts` | 2, 3, 4, 5 |
| `src/entrypoints/amazon.content.ts` | 2, 3, 5 |
| `src/entrypoints/overlay/main.tsx` | 6 |
| `src/entrypoints/sidepanel/App.tsx` | 0, 3, 4 |
| `src/entrypoints/sidepanel/main.tsx` | 9 (duplicate `initThemeSync`) |
| `src/entrypoints/sidepanel/store/collectionStore.ts` | 3 |
| `src/entrypoints/sidepanel/hooks/useSettings.ts` | 3 |
| `src/entrypoints/sidepanel/hooks/useExport.ts` | 3, 8 |
| `src/entrypoints/sidepanel/hooks/useSessionRecovery.ts` | 4 |
| `src/entrypoints/sidepanel/components/SettingsOverlay.tsx` | 3, 8, 9 |
| `src/entrypoints/sidepanel/components/ExportModal.tsx` | 3, 8, 9 |
| `src/entrypoints/sidepanel/components/CollectionControls.tsx` | 4 |
| `src/entrypoints/sidepanel/components/HistoryTab.tsx` | 4, 9 |
| `src/entrypoints/sidepanel/components/HistoryEntry.tsx` | 4 (renders the corrected `startedAt`) |
| `src/entrypoints/sidepanel/components/ExtractionCompleteModal.tsx` | 6, 9 |
| `src/entrypoints/sidepanel/components/FullWidthPreviewModal.tsx` | 6, 9 |
| `src/entrypoints/sidepanel/components/ErrorModal.tsx` | 6, 9 |
| `src/entrypoints/sidepanel/components/Header.tsx` | 9 (`'system'` theme preference) |
| `src/entrypoints/sidepanel/components/StatusBar.tsx` | 2, 9 (guard against an unknown status) |
| `src/entrypoints/sidepanel/table/columns.tsx` | 7, 9 |
| `src/entrypoints/sidepanel/table/ProductTable.tsx` | 7, 9 |
| `tests/error-recovery-and-resilience.test.tsx` | 2 |
| `tests/preview-images-rownumbers-export.test.tsx` | 8 |
| `tests/pricing-deals-bsr.test.tsx` | 1, 8 |
| `tests/scraper-accuracy.test.tsx` | 1 |
| `tests/baseline-snapshot.test.ts` | 1, 5 (updating the golden values) |
| `tests/settings-overlay.test.tsx` | 3 |
| `tests/page-overlay.test.tsx` | 6 |
| `tests/theme-and-contrast.test.tsx` | 6, 9 |
| `tests/history-preview-export.test.tsx` | 4 |
| `tests/active-tab.test.tsx` | 4 |
| `tests/extraction-complete-dialog.test.tsx` | 6, 9 |
| `README.md` | 6, 10 |
| `ARCHITECTURE.md` | 10 |
| `CHANGELOG.md` | 10 |
| `PLAN.md` | 10 |
| `spec/06-phase-6-settings-ui.md` | 10 |
| `spec/11-messaging-protocol.md` | 10 |

`tailwind.config.js` and `src/entrypoints/sidepanel/global.css` are **not** modified — Phase 6 Step 6.1
resolves the no-op classes by switching to tokens that already exist (`moss`, `ink-subtle`), which is
the lower-risk of the two options considered there.

## 6. Coverage matrix — all 30 findings

| Finding | Phase · Step | Finding | Phase · Step |
|---|---|---|---|
| C‑1 currency = URL / 1000× price | 1 · 1.1 | M‑1 counter regresses after resume | 4 · 4.4 |
| C‑2 dead + throwing validation layer | 2 · 2.1–2.4 | M‑2 auto-mode never ends | 5 · 5.3 |
| H‑1 8 write-only settings | 3 · 3.1–3.4 | M‑3 over-broad `web_accessible_resources` | 6 · 6.2 |
| H‑2 invalid `executeScript` path | 2 · 2.5 | M‑4 postMessage to `'*'` | 6 · 6.3 |
| H‑3 router throws on missing payload | 2 · 2.4 | M‑5 71 table type errors | 7 · 7.1–7.2 |
| H‑4 rapid settings changes lost | 3 · 3.2 | M‑6 unbounded image fetching | 8 · 8.3 |
| H‑5 session lifecycle | 4 · 4.1–4.3 | M‑7 silent `ProductSchema` drops | 5 · 5.4 |
| H‑6 CSV/clipboard formula injection | 1 · 1.2 | M‑8 remote Google Fonts vs README | 6 · 6.4 |
| H‑7 `xlsx` advisories | 8 · 8.0–8.5 | M‑9 `clearAllHistory` wipes products | 4 · 4.5 |
| H‑8 MV3 in-memory state | 4 · 4.2 | M‑10 `.parse()` during render | 3 · 3.3 |
| H‑9 full-page re-parse | 5 · 5.1–5.2 | L‑1 `targetCount` bounds conflict | 2 · 2.2 |
| H‑10 no-op Tailwind classes | 6 · 6.1 | L‑2 `formatCurrency` hardcoded locale | 9 · 9.1 |
| | | L‑3 dead code | 0 · 0.2 + 9 · 9.4 |
| | | L‑4 O(rows) row numbers | 9 · 9.2 |
| | | L‑5 `'interrupted'` enum gap | 2 · 2.2 |
| | | L‑6 no modal focus trap; `confirm()` | 9 · 9.3 |
| | | L‑7 documentation drift | 10 · 10.1–10.2 |
| | | Process: no CI / no typecheck gate | 0 · 0.1 |

## 7. Testing strategy

### The gate (established in Phase 0, tightened in Phase 7)

Every phase must end with this command green:

```bash
npm ci && npx tsc --noEmit && npx vitest run && npx wxt build && npm audit --omit=dev
```

- `tsc --noEmit` starts at **111 errors** and is **non-blocking (warn-only)** in CI from Phase 0.
  Each phase records the expected error count; it must never increase. It reaches **0** at the end
  of Phase 7, at which point the CI job flips to **blocking**.
- `vitest run` starts at **71 passing** and is **blocking from Phase 0**. The count must never
  decrease; the plan adds ~70 new tests across 9 new files.
- `wxt build` is blocking from Phase 0.
- `npm audit --omit=dev` is non-blocking until Phase 8, then blocking (that is the phase that
  clears it).

### Test-count ledger

| Phase | Tests before | Added | Expected after | tsc errors after |
|---|---|---|---|---|
| 0 | 71 | ~4 (baseline snapshot) | 75 | 108 (−3, OverlayDrawer removed) |
| 1 | 75 | ~18 | 93 | 108 |
| 2 | 93 | ~24 | 117 | 104 (−2 messages.ts, −1 amazon.content.ts, −1 background.ts TS2820) |
| 3 | 117 | ~12 | 129 | 104 |
| 4 | 129 | ~14 | 143 | 104 |
| 5 | 143 | ~8 | 151 | 102 (−2 search-results, −2 scroll-controller … net) |
| 6 | 151 | ~6 | 157 | 102 |
| 7 | 157 | ~4 | 161 | **27** (all table errors gone) → gate flips to blocking |
| 8 | 161 | ~10 | 171 | 24 (−3 excel.ts) |
| 9 | 171 | ~6 | 177 | ~10 |
| 10 | 177 | 0 | 177 | **0** |

The counts are planning targets, not contracts. The binding constraints are: **never fewer passing
tests than the phase started with**, and **never more type errors than the phase started with**.

### Regression-protection principles applied throughout

1. **Snapshot before you change.** Phases 1, 4 and 7 each begin by recording the current observable
   behaviour (parser output, DB row counts, column definitions) so "unchanged where it should be"
   is provable rather than assumed.
2. **Every fix ships with a test that fails without it.** Each phase's verification section names
   the specific new test that reproduces the original defect.
3. **Deliberate test updates are listed explicitly.** Three existing assertions *encode* bugs and
   must change: `tests/error-recovery-and-resilience.test.tsx:287` (asserts the invalid
   `executeScript` path — H‑2) and the two image-embedding tests' defaults (M‑6). No other existing
   assertion is expected to change; if one does, that is a signal to stop and re-examine.
4. **No production behaviour change without a named finding.** Cosmetic refactors are out of scope.

### What tests cannot cover

jsdom performs no layout and there is no browser in this environment. These are handed to
Phase 11's manual checklist: `executeScript` path tolerance in real Chrome, table virtualisation
geometry, MV3 worker termination timing, whether the generated `.xlsx` opens in Excel without a
repair prompt, live Amazon selector validity, absolute parser timings in a real DOM, and the
Firefox build.

## 8. Definition of done

The remediation is complete when all of the following hold:

- [ ] `npx tsc --noEmit` exits 0 (was: 111 errors)
- [ ] `npx vitest run` exits 0 with ≥ 177 passing tests (was: 71)
- [ ] `npx wxt build` exits 0 and `npm audit --omit=dev` reports 0 vulnerabilities (was: 1 high)
- [ ] `.github/workflows/ci.yml` runs all four checks on every push and PR, all blocking
- [ ] Each of the 30 findings has a named test that fails if the fix is reverted
- [ ] `grep -rn "bg-forest\|text-ink-faint" src` returns nothing
- [ ] `grep -rn "OverlayDrawer\|ProductsTab\|CollectionsTab" src` returns nothing
- [ ] Every key in `SettingsSchema` has at least one non-UI consumer (enforced by a guard test)
- [ ] `ExtensionMessageSchema` appears in `dist/chrome-mv3/background.js` (proves it is no longer dead code)
- [ ] Phase 11's manual browser checklist is completed and its results recorded
- [ ] `README.md`, `ARCHITECTURE.md` and `CHANGELOG.md` match the shipped code

## 9. Phase documents

| # | Document |
|---|---|
| 0 | [phase-00-guardrails.md](./phase-00-guardrails.md) |
| 1 | [phase-01-data-integrity.md](./phase-01-data-integrity.md) |
| 2 | [phase-02-messaging-foundation.md](./phase-02-messaging-foundation.md) |
| 3 | [phase-03-settings-wiring.md](./phase-03-settings-wiring.md) |
| 4 | [phase-04-session-lifecycle.md](./phase-04-session-lifecycle.md) |
| 5 | [phase-05-scraper-performance.md](./phase-05-scraper-performance.md) |
| 6 | [phase-06-security-hardening.md](./phase-06-security-hardening.md) |
| 7 | [phase-07-tanstack-migration.md](./phase-07-tanstack-migration.md) |
| 8 | [phase-08-xlsx-replacement.md](./phase-08-xlsx-replacement.md) |
| 9 | [phase-09-quality-a11y.md](./phase-09-quality-a11y.md) |
| 10 | [phase-10-docs-identity.md](./phase-10-docs-identity.md) |
| 11 | [phase-11-manual-verification.md](./phase-11-manual-verification.md) |
| — | [CORRECTIONS.md](./CORRECTIONS.md) — three claims in the investigation report that this plan corrects |
