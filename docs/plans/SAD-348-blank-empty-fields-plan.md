# SAD-348 — Plan Only: Blank (instead of `—`) for empty optional product fields

> **Status: IMPLEMENTATION IN PROGRESS** (approved 2026-10-20). Decisions confirmed:
> push directly to `main` after each step, Linear Todo → In Progress → In Review,
> 13-field list in §3 as written (incl. List Price, Description, Features).
> Issue: https://linear.app/sad-mod/issue/SAD-348/improvement — *"Some product fields are
> empty because the product has no info for example no discount, deal offer, coupon, or
> badge. Currently, these fields display a dash (-) … Update the UI so that these fields
> remain completely blank instead of displaying a dash … Preserve the existing behavior for
> fields that contain valid data, and avoid making unrelated changes."*
> No comments, relations, or attachments exist on the issue (checked 2026-10-20).

---

## 1. Decisions taken (from clarifying questions — not guessed)

| Question | Decision |
|---|---|
| Which fields go blank? | **Optional / promotional fields only.** The 4 named fields + other non-essential fields. Core fields (Price, Rating, Reviews, …) **keep** `—`. Exact list in §3. |
| Which engines? | **Amazon + Temu** (both tables, kept consistent). |
| UI only or UI + export? | **UI + export.** Audit CSV / Excel / clipboard for both engines; fix only if a dash is found there. |
| How should a blank cell be rendered? | *Deferred to implementer → chosen option in §4:* **truly empty cell (`return null`)**, no sort/filter/search change. Rationale given in §4. |

## 2. Verified current state (evidence, not assumptions)

### 2.1 UI — the dash is rendered in exactly two files
Both engines have a near-identical TanStack column definition file. Every empty-value
branch returns the same element: `<span className="text-ink-subtle">—</span>` (em dash).

- Amazon: `src/engines/amazon/ui/table/columns.tsx`
  - Discount L278, Deal L299, Coupon L424, Badge L446 — the 4 fields named in the issue.
  - Same pattern also in: Price L235, List Price L257, Currency L321, Rating L339,
    Reviews L362, BSR L380, Monthly Sales L402, Delivery L468, Brand L490, Seller L511,
    Availability L532, URL L591, Description L615, Features L636, Title (`title ?? '—'`) L206.
- Temu: `src/engines/temu/ui/table/columns.tsx` — identical set/pattern
  (Discount L213, Deal L234, Coupon L359, Badge L381, etc.).

These column files are the **only** product-field dash renderers: a repo-wide grep for
`'—'` in `src/**/*.tsx` returns only these two files (other hits are prose/comments).
They feed every table surface, because all surfaces reuse the same table components:

- Side panel: `src/entrypoints/sidepanel/table/ProductTable.tsx` → `AmazonProductTable`
- Full preview page: `src/entrypoints/preview/PreviewPageApp.tsx` (Amazon L351, Temu L343)
- Full-width preview modal: `src/engines/{amazon,temu}/ui/components/FullWidthPreviewModal.tsx`
- History preview: `HistoryEntry.tsx` opens the dedicated preview tab
  (`openDedicatedPreviewTab`), i.e. the same tables — confirmed in Step 1 (2026-10-20).
  Step 1 also re-confirmed: the two `columns.tsx` files are still the only dash
  renderers, and no existing test expects `—` in a table cell.

No other UI renders these fields: grep for `discountPercentage|dealBadge|.coupon|.badge`
in `*.tsx` outside `ui/table/columns.tsx` hits only Settings labels and the tables'
search filter. There is no card/detail renderer to change.

### 2.2 Export — already blank today (for Amazon, proven by an existing test)
- Amazon export maps missing values to `''`: `src/engines/amazon/export/types.ts:109`
  (`value ?? ''`) and `src/engines/amazon/export/excel.ts:459` (`value ?? ''`).
  No `'—'` exists in any export module (grep over `src/engines/*/export/`, `src/lib/export/`).
- Existing regression proof: `tests/pricing-deals-bsr.test.tsx` already asserts, for a
  product with `discountPercentage/dealBadge/bestSellersRank/coupon/badge/delivery = null`:
  - CSV row: `'24.5,,,,USD,4.3,190,,,,,'` (empty fields are empty), and
  - XLSX: `'List Price': '', Discount: '', Deal: '', 'Best Sellers Rank': ''`.
- Temu export (`src/engines/temu/export/types.ts`, `csv.ts`, `excel.ts`, `clipboard.ts`)
  has no `'—'` either, but **no equivalent blank-value test was found** — so Temu export
  and both clipboards are *audit + test* items, not assumed-correct items (§5, Step 3).

### 2.3 What does NOT produce the dash (out of scope, do not touch)
- `src/engines/amazon/utils/formatters.ts` (`formatCurrency/formatNumber/formatRating`
  return `'—'` for null): these format **core** values (price/rating/counts) and are also
  used outside the table (counters, modals). The issue's scope decision keeps core fields
  as-is → **leave this file untouched.**
- Scrapers (`src/engines/*/scraper/*`), DB, and product schemas: missing fields are
  already stored as `null`/`undefined`. **No data-layer change.**
- `isPrime`/`isSponsored` cells render `No`, not `—` → untouched.

## 3. Exact field classification (the §1 "optional fields" decision, enumerated)

**→ Becomes blank when empty** (both Amazon and Temu columns files):

| Field (accessor) | Column header (Amazon / Temu) | Dash line (Amazon / Temu) |
|---|---|---|
| `discountPercentage` | Discount | L278 / L213 |
| `dealBadge` | Deal | L299 / L234 |
| `coupon` | Coupon | L424 / L359 |
| `badge` | Badge | L446 / L381 |
| `listPrice` | List Price | L257 / L192 |
| `bestSellersRank` | Best Sellers Rank / Category Rank | L380 / L315 |
| `pastMonthSales` | Monthly Sales / Sales Volume | L402 / L337 |
| `delivery` | Delivery | L468 / L403 |
| `brand` | Brand | L490 / L425 |
| `seller` | Seller / Seller / Mall | L511 / L443 |
| `availability` | Availability | L532 / L464 |
| `description` | Description | L615 / L547 |
| `features` | Features (empty array) | L636 / L568 |

**→ Unchanged (keeps `—` / current rendering):** Title, Price, Currency, Rating,
Reviews, URL, ASIN/Goods ID, Image, Prime/Local, Sponsored, Source, row number, selection.
*Rationale:* Price/Rating/Reviews/Currency are the core at-a-glance values the §1 decision
explicitly preserved; Title/URL are identity/link cells, not "no applicable info" fields.

> ⚠️ **Review gate:** `listPrice`, `description`, and `features` are the three judgement
> calls in the list above (promotional/descriptive rather than named in the issue). They
> are included because the chosen scope was "other non-essential fields". If the reviewer
> wants any of them to keep `—`, remove that row **before** implementation — the rest of
> the plan is unaffected. No other field is ambiguous.

## 4. Chosen rendering for a blank cell: `return null` (truly empty)

For each in-scope cell, replace
`if (!value) return <span className="text-ink-subtle">—</span>;` with `if (!value) return null;`

Why this is the best of the three options offered:

1. **Minimal & behaviour-preserving.** Sorting (`sortFn` on the accessor),
   filtering/search (`AmazonProductTable.tsx:156-161` and Temu equivalent already do
   `(p.coupon ?? '')…`), and export all operate on the **raw product value**, never on
   rendered cell text. Returning `null` therefore cannot change sort order, search,
   filtering, or exports — satisfying "preserve existing behavior / no unrelated changes"
   by construction, not by extra code.
2. **No accessibility regression worth extra markup.** The column header already
   announces the field to assistive tech; an empty cell is the standard table idiom for
   "not applicable". The rejected alternative (sr-only text like "No discount") would
   add hidden text that diverges from the visual UI, would surface in text-based
   assertions/copy, and adds 13×2 near-duplicate strings to maintain — unnecessary code
   for this ticket.
3. **Zero new code.** No helper, no shared component, no CSS. Each change is one line in
   a pattern that already exists identically 13 times per file. (A shared `EmptyCell`
   helper was considered and rejected: it would return `null` anyway.)
4. **Testable.** Populated cells keep their existing `data-testid`
   (`product-discount-<ASIN>`, `product-deal-…`, `product-coupon-…`, `product-badge-…`, …);
   an empty cell then has `textContent === ''` and no such testid — both assertable.

Row height/layout: cells are single-line spans in fixed-height virtualized rows; an
empty cell does not change row height. No layout code to change (verify visually in §6).

## 5. Implementation steps (for the follow-up pass — smallest sufficient diff)

1. **Re-confirm surface coverage (5 min, read-only).** Grep `—` in `src/**/*.tsx` and
   confirm the only renderers are still the two `columns.tsx` files, and that History
   preview renders through `AmazonProductTable`/`TemuProductTable`. If a new renderer
   is found, stop and amend §2.1/§3 rather than improvising.
2. **Amazon table.** In `src/engines/amazon/ui/table/columns.tsx`, change only the 13
   in-scope empty branches (§3) from the dash span to `return null;`. Do not touch the
   core columns, `formatters.ts`, column sizes, sorting, or testids.
3. **Temu table.** Same 13 changes in `src/engines/temu/ui/table/columns.tsx`
   (Temu line numbers in §3). Keep the two files semantically in sync, as they are today.
4. **Export audit (no change expected).**
   - Amazon CSV/Excel: already proven blank by `tests/pricing-deals-bsr.test.tsx` (§2.2)
     — just re-run it.
   - Audit Amazon clipboard (`src/engines/amazon/export/clipboard.ts`), and Temu
     CSV/Excel/clipboard (`src/engines/temu/export/*`), for how a `null` in-scope field
     is emitted. **Only if** a dash (or the string `"null"`/`"undefined"`) is found, fix
     it at the export value-mapper (`types.ts` level, e.g. the existing `value ?? ''`
     pattern) — never in the scrapers or stored data. If all emit `''`, change nothing
     and record that in the PR description.
5. **Tests (extend existing files; no new test framework/files unless noted).**
   - Extend `tests/pricing-deals-bsr.test.tsx` (Amazon, already renders a null-field
     product `B0PRV00002` in `ProductTable`): assert the in-scope cells for that product
     render empty (`textContent === ''`; `queryByTestId('product-discount-B0PRV00002')`
     etc. are absent), and that a core cell (e.g. Price/Rating) still shows its value.
     The existing populated-product assertions (`68% off`, `Limited-time deal`, …) must
     keep passing unchanged — they are the "valid data preserved" proof.
   - Temu mirror: add the equivalent render assertions where Temu table tests already
     live (`tests/preview-modes-and-sorting.test.tsx` references `TemuProductTable`;
     otherwise `tests/temu-isolation.test.ts` is the fallback home — pick whichever
     already renders the Temu table, do not create both).
   - Export: keep the existing Amazon CSV/XLSX blank assertions; add Temu CSV (and
     clipboard, for both engines if currently untested) assertions that a product with
     null Discount/Deal/Coupon/Badge exports those cells as `''`.
   - Run any existing test that asserts a dash in an in-scope cell and update **only**
     that assertion (find via `grep -rn "—" tests/` before starting).
6. **Verify.** `npm run compile` (tsc), targeted `vitest run` for the touched test
   files, then the full suite (`npm test`), then `npx wxt build` to confirm the
   extension still builds. Rebuild the Chrome zip only if a distributable is requested.
7. **Explicitly not doing:** no scraper/DB/schema changes, no `formatters.ts` change,
   no sort/filter/search changes, no Settings changes, no new dependencies, no
   redesign of populated-cell chips/badges.

## 6. Acceptance criteria (map 1:1 to the issue)

- [ ] A product with no discount/deal/coupon/badge shows **empty** Discount, Deal,
      Coupon, Badge cells (Amazon and Temu tables; side panel, preview page, preview
      modal — all via the shared table components).
- [ ] All other §3 "becomes blank" fields are likewise empty when missing.
- [ ] Price, Rating, Reviews, Currency, Title, URL still show `—` when missing (unchanged).
- [ ] Products **with** values render exactly as before (existing populated-cell tests pass unmodified).
- [ ] Sorting, search, and filtering results are unchanged for the same dataset
      (existing sorting/search tests pass; no code in those paths was touched).
- [ ] CSV, Excel, and clipboard exports contain empty cells (never `—`, `null`, or
      `undefined`) for missing in-scope fields, for both engines.
- [ ] Full test suite + typecheck + `wxt build` pass.

## 7. Risks / notes

- **Two-file duplication:** Amazon and Temu `columns.tsx` are maintained as mirrors;
  changing only one is the main regression risk → §5 steps 2–3 and mirrored tests.
- **Snapshot/baseline tests:** `tests/baseline-snapshot.test.ts` (and any theme/contrast
  test) may contain `—` expectations; grep first (§5.5) so failures are anticipated,
  not discovered.
- **Whitespace-only strings:** cells use `if (!value)`, so a whitespace-only string
  would still render. Scrapers already trim/normalize (out of scope); do **not** add
  trimming as part of this ticket unless a failing test proves it is needed.

## 8. Implementation log (2026-10-20)

- Step 1 (coverage re-confirmed): commit `f92272d`.
- Step 2 (Amazon table, 13 cells): commit `9230a30`.
- Step 3 (Temu table, 13 cells): commit `4a156d9`.
- Step 4 (export audit): **no export code change needed.** All six builders
  (Amazon + Temu x CSV/Excel/clipboard) already map `null`/`undefined` to an
  empty value (`raw == null ? '' : String(raw)` in csv/clipboard; `value ?? ''` /
  null cell in excel). No `—`, `"null"`, or `"undefined"` is emitted. Regression
  assertions for this are added in Step 5 instead of changing export code.
- Step 5 (tests — Amazon table/clipboard, Temu table, Temu CSV/clipboard): commit `e762cfe`.
  Targeted run: 3 files, 13 tests passed.
- Step 6 (full verification): `tsc --noEmit` PASS; full suite 83 files / 894 tests PASS;
  `npx wxt zip` build PASS. No existing feature affected. Status → In Review.
