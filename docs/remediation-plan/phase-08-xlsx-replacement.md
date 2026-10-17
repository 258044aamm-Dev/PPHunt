# Phase 8 — XLSX Engine Replacement

**Issues addressed:** H‑7 (`xlsx` high-severity advisories, unfixable on npm) · M‑6 (unbounded image fetching)
**Estimated effort:** Extra-large — the largest single change in the plan
**Prerequisites:** Phase 1 (formula neutralisation), Phase 3 (`exportImages` setting), Phase 7 (green types)
**Blocks:** the CI audit gate becoming blocking

> ⚠️ **Step 8.0 is a go/no-go spike. Do not start Step 8.2 until it has passed.** If it fails, take
> the documented fallback and skip to Step 8.3.

---

## Step 8.0 — Spike: prove `exceljs` bundles and runs in the extension

### Objective
Answer one question before committing to the rewrite: does `exceljs` produce a valid `.xlsx` from
inside a Chrome extension page, at an acceptable bundle size?

### Root Cause
`exceljs` is written for Node. It references `stream`, `buffer`, `fs` and pulls `archiver`, `unzipper`,
`saxes` and `tmp`. Bundlers routinely fail or silently produce a broken build. The extension's side
panel and overlay are browser contexts with MV3 CSP, so this must be proven, not assumed.

### Files Involved
Scratch only — a temporary entrypoint or a throwaway test. Nothing committed unless the spike passes.

### Implementation Details
1. `npm install exceljs` (do **not** remove `xlsx` yet).
2. Write ~20 lines that build a workbook with one sheet, three columns, bold headers, a custom row
   height, a custom column width and one embedded PNG, then `await wb.xlsx.writeBuffer()`.
3. Run it three ways:
   - in **vitest** (Node) — establishes the expected bytes
   - in a **built extension page** via `npx wxt build` and a temporary button — establishes that the
     bundler succeeded
   - open the produced file in **LibreOffice Calc and, if available, Microsoft Excel** — establishes
     that the bytes are valid
4. Record: emitted chunk size delta versus today's 919.70 kB `global-*.js`, and whether any Vite
   `resolve.alias` or `optimizeDeps` entries were needed.

If the browser import path matters, try in order: `import ExcelJS from 'exceljs'`,
`import ExcelJS from 'exceljs/dist/exceljs.min.js'`, and
`import * as ExcelJS from 'exceljs/dist/exceljs.browser'`. Use whichever bundles cleanly.

### Decision gate

| Outcome | Action |
|---|---|
| All three runs pass, size delta acceptable (≤ +400 kB) | Proceed to Step 8.1 |
| Bundles but the file is rejected by Excel | Proceed only if LibreOffice opens it **and** the rejection cause is identified and fixable; otherwise fall back |
| Does not bundle, or size delta unacceptable | **Fall back:** install the patched SheetJS build from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (confirmed reachable). All existing `excel.ts` code and both test files stay unchanged; only `package.json` changes. Then skip to Step 8.3. |

### Testing and Verification
The spike's own three runs. Record the results in the PR description — this is the evidence that
justifies the rest of the phase.

---

## Step 8.1 — Move `xlsx` to devDependencies

### Objective
Clear the production advisory so `npm audit --omit=dev` reports zero vulnerabilities.

### Root Cause
```
xlsx  *
Severity: high
  Prototype Pollution in sheetJS                            — GHSA-4r6h-8v6p-xvw6
  SheetJS Regular Expression Denial of Service (ReDoS)      — GHSA-5pgg-2g8v-p4x9
No fix available
```
The lockfile resolves from `registry.npmjs.org`, and SheetJS withdrew patched releases (≥ 0.19.3 /
0.20.2) from npm; they are distributed only from `cdn.sheetjs.com`.

**Actual exposure is low** — PPHunt only *writes* workbooks (`aoa_to_sheet`, `write`) and re-reads its
own buffer (`CFB.read` on bytes it just produced). It never parses a user-supplied spreadsheet, so
neither advisory's vulnerable code path is reachable from untrusted input. The risk is supply-chain
posture: an unfixable high-severity advisory fails most scanners and store/enterprise review gates.

Keeping `xlsx` as a **devDependency** preserves the existing test harness — both
`tests/preview-images-rownumbers-export.test.tsx:402-426` and `tests/pricing-deals-bsr.test.tsx:331-332`
read workbooks back with `XLSX.read` / `XLSX.CFB.find` / `XLSX.utils.sheet_to_json`. A dev dependency
is excluded from `--omit=dev`, so the audit goes clean while the tests keep working unchanged.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `package.json` | modify | `xlsx` from `dependencies` → `devDependencies`; add `exceljs` to `dependencies` |
| `package-lock.json` | regenerate | — |

### Implementation Details
```bash
npm install exceljs
npm install --save-dev xlsx@0.18.5
npm uninstall xlsx   # only if npm placed it in both; verify the lockfile afterwards
```
Then confirm `xlsx` appears **only** under `devDependencies` and that no `src/` file imports it:
```bash
grep -rn "from 'xlsx'\|require('xlsx')" src    # must be empty
```

### Testing and Verification
1. `npm audit --omit=dev` → **0 vulnerabilities**.
2. `npm audit` (including dev) will still show the xlsx advisory — that is expected and should be
   documented in the PR so a future reader does not mistake it for a regression.
3. `npx vitest run` — both read-back test files still pass, because `xlsx` resolves fine from
   `devDependencies` during tests.
4. `npx wxt build` → confirm `xlsx` is **not** in the emitted bundle:
   `grep -rl "aoa_to_sheet\|CFB" dist/chrome-mv3/` returns nothing.

---

## Step 8.2 — Rewrite `excel.ts` on `exceljs`

### Objective
Same public API, same output semantics, ~140 fewer lines, and image embedding via a supported API
instead of hand-written ZIP surgery.

### Root Cause
`src/lib/export/excel.ts` (489 lines) uses only nine SheetJS APIs, four of which exist **solely** to
serve the hand-rolled image injector:

| API | Used for | exceljs equivalent |
|---|---|---|
| `XLSX.utils.aoa_to_sheet` | build the sheet | `worksheet.addRows(...)` |
| `XLSX.utils.book_new` / `book_append_sheet` | build the workbook | `new ExcelJS.Workbook()` / `addWorksheet` |
| `XLSX.utils.encode_cell` | address the header cells for bolding | `worksheet.getRow(1).font = { bold: true }` |
| `XLSX.write` | serialise | `await workbook.xlsx.writeBuffer()` |
| `XLSX.CFB.read` / `CFB.find` / `CFB.utils.cfb_add` / `CFB.write` | **inject images by rewriting the ZIP** | `workbook.addImage(...)` + `worksheet.addImage(...)` |

`injectEmbeddedImagesIntoXlsxBuffer` (lines 188-329) reopens the finished workbook as a compound-file
blob, hand-writes `xl/drawings/drawing1.xml`, `xl/drawings/_rels/drawing1.xml.rels`,
`xl/worksheets/_rels/sheet1.xml.rels` and `[Content_Types].xml` overrides, computes EMU offsets
manually (`THUMBNAIL_EXT_EMU = 44 * 9525`), and rewrites the archive. That is the most brittle code in
the export layer and the reason `escapeXmlAttr` (165), `encodeUtf8` (173) and `decodeUtf8` (177) exist.

**Incidental improvement worth noting:** `ws[cellRef].s = { font: { bold: true } }` at line 426 is a
no-op in the SheetJS *community* build — cell styling is a pro feature. So today's exported headers
are almost certainly **not** bold. `exceljs` writes real styles, so this phase fixes that too. Verify
during the spike and record the before/after.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/export/excel.ts` | modify | Replace the workbook-building half; **delete** the CFB injector and its three helpers |
| `src/lib/export/exceljs-adapter.ts` | **create** (optional) | Isolates the `exceljs` import behind `buildExcelWorkbookBuffer`'s existing contract, so a future swap is one file |

### Implementation Details

**Keep unchanged:** `detectImageExtension` (48-112), `defaultFetchProductImage` (113-164), the
`FetchedProductImage` interface, all the sizing constants, `ExcelExportBuildOptions`, the column/row
value mapping (380-417), and `exportExcel`'s public signature (474-489). `useExport.ts:68` calls
`exportExcel(products, visibleColumns, filename)` and must not need to change.

**Delete:** `escapeXmlAttr`, `encodeUtf8`, `decodeUtf8`, `injectEmbeddedImagesIntoXlsxBuffer`
(~165 lines).

**Replace the sheet-building block (420-468):**
```ts
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet(SHEET_NAME);

ws.columns = columns.map((col, i) => ({
  header: col,
  width: columnWidths[i],                  // computed exactly as today's `wch` logic
}));
ws.getRow(1).font = { bold: true };
ws.getRow(1).height = HEADER_ROW_HEIGHT_PT;

dataRows.forEach((row, rowIdx) => {
  const r = ws.addRow(row);
  r.height = embeddedByRow.has(rowIdx) ? IMAGE_ROW_HEIGHT_PT : DEFAULT_ROW_HEIGHT_PT;
});
```

**Replace the image injection:**
```ts
for (const img of embeddedList) {
  const imageId = wb.addImage({
    buffer: img.bytes,                     // exceljs accepts Uint8Array/Buffer/base64
    extension: img.extension === 'webp' ? 'png' : img.extension,   // see note
  });
  ws.addImage(imageId, {
    tl: { col: img.colIndex + 0.05, row: img.rowIndex + 0.08 },
    ext: { width: 44, height: 44 },
  });
}
const buffer = await wb.xlsx.writeBuffer();
return new Uint8Array(buffer);
```
**WebP note.** OOXML does not support WebP as a drawing image type. `detectImageExtension` already
returns `'webp'` as a possibility, and today's injector writes whatever bytes it has. Decide explicitly:
either transcode WebP → PNG (needs a canvas, available in the extension context) or fall back to the
URL text for WebP images. The fallback is simpler and matches the existing "graceful URL fallback"
behaviour; recommend that, and record the decision.

**Formula neutralisation (risk carried from Phase 1).** `exceljs` assigns cell types by inspection and
**will** interpret a leading `=` in a string as a formula — unlike SheetJS, which wrote it as an inline
string. The `neutralizeSpreadsheetFormula` call added at `excel.ts:415` in Phase 1 therefore becomes
load-bearing here. Re-run `tests/export-injection.test.ts` against the exceljs output and confirm it
still passes; if it does not, the neutralisation was applied at the wrong point in the mapping.

### Dependencies and Order
- After Phase 1 (neutralisation must already be in place).
- After Phase 3 (the `exportImages` setting must exist for Step 8.3).
- After Phase 7 (green types make the rewrite verifiable as it goes).

### Testing and Verification
1. `tests/pricing-deals-bsr.test.tsx:331-332` and
   `tests/preview-images-rownumbers-export.test.tsx:402-426` pass **unchanged** — they read the output
   back with the `xlsx` devDependency, which is the point of keeping it. If the CFB-path assertions
   (`CFB.find(cfb, '/xl/media/image1.png')`, `'/xl/drawings/drawing1.xml'`) fail because exceljs names
   parts differently, update the *expected part names* — but only after confirming with a real
   spreadsheet application that the images are actually there. That confirmation is the authority, not
   the test.
2. `tests/export-injection.test.ts` passes against the new engine.
3. **Manual, mandatory:** open an image-embedded export in Microsoft Excel and LibreOffice Calc. No
   repair prompt, headers bold, thumbnails visible and correctly positioned, column widths and row
   heights sane, numbers right-aligned and summable.
4. `npx wxt build` → record the new bundle size against today's 1.27 MB / 919.70 kB chunk.
5. `npm audit --omit=dev` → 0.

---

## Step 8.3 — M‑6: bound the image work

### Objective
XLSX export must complete in bounded time and memory, with the user in control.

### Root Cause
When the `Image` column is present (it is by default — `enabledFields.imageUrl` defaults to `true`),
`buildExcelWorkbookBuffer` fetches **every** product's image:
```ts
const IMAGE_FETCH_TIMEOUT_MS = 4000;
const IMAGE_FETCH_CONCURRENCY = 6;
for (let i = 0; i < queue.length; i += IMAGE_FETCH_CONCURRENCY) { await Promise.all(batch) }
```
For a 1,000-product session that is ~167 sequential batches. Worst case (all requests timing out) is
`167 × 4 s ≈ 11 minutes` with the modal blocked on `isExporting`. All bytes are retained in
`embeddedByRow` and injected into the workbook, so the file can reach hundreds of MB held entirely in
memory. There is **no user-facing control**: `enabledFields.imageUrl` toggles the *column*, not the
*embedding*, and `useExport.ts:68` passes no options.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/schemas/settings.ts` | modify | Add `exportImages: 'auto' \| 'always' \| 'never'` (default `'auto'`) |
| `src/types/settings.ts`, `src/constants/defaults.ts` | modify | Mirror |
| `src/lib/export/types.ts` | modify | Add the option to `ExportOptions` |
| `src/lib/export/excel.ts` | modify | Implement the budgets |
| `src/entrypoints/sidepanel/components/ExportModal.tsx` | modify | Per-export override control |
| `src/entrypoints/sidepanel/components/SettingsOverlay.tsx` | modify | Persisted default under Export Defaults |
| `src/entrypoints/sidepanel/hooks/useExport.ts` | modify | Thread the option through to `exportExcel` |

### Implementation Details

**Decision D4 — `'auto'` semantics.** Embed images only when all three budgets hold:
```ts
const AUTO_MAX_PRODUCTS   = 200;
const AUTO_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const AUTO_MAX_WALL_MS     = 20_000;
```
```ts
function resolveEmbedImages(
  mode: 'auto' | 'always' | 'never',
  productCount: number
): boolean {
  if (mode === 'never')  return false;
  if (mode === 'always') return true;
  return productCount <= AUTO_MAX_PRODUCTS;
}
```
Inside the fetch loop, accumulate bytes and elapsed time and stop early, falling back to the URL text
the exporter already writes when an image is unavailable:
```ts
if (totalBytes + bytes.length > AUTO_MAX_TOTAL_BYTES) break;   // remaining rows keep URL text
if (Date.now() - startedAt > AUTO_MAX_WALL_MS) break;
```
Breaking out of the loop rather than throwing is what makes this safe: rows already fetched stay
embedded, the rest degrade to URLs, and the export still succeeds.

**Surface progress.** With `isExporting` already true, add the fetched-so-far count to the
`ExportModal` so a 20 s wait is not indistinguishable from a hang. `useExport` already returns
`isExporting` and `lastResult`; extend `lastResult` or add an `onProgress` callback.

### Testing and Verification
Extend `tests/preview-images-rownumbers-export.test.tsx` (it already injects a fake `fetchImage`):
1. 300 products, mode `'auto'` → assert **0** fetch calls beyond the 200 threshold behaviour, and that
   rows past the threshold contain URL text.
2. 300 products, mode `'always'` → assert all 300 fetched.
3. Mode `'never'` → assert **0** fetch calls and no `/xl/media/*` parts.
4. A `fetchImage` stub that never resolves → assert the export completes within the wall-clock budget
   and every cell contains a URL. **This is the test that fails today.**
5. A byte-budget test: stub returning 5 MB images → assert embedding stops at the cap.
6. Setting persistence: write `exportImages: 'never'` → open `ExportModal` → assert the override
   reflects it.
7. Update the two existing image-embedding tests to set the flag explicitly rather than relying on the
   default, so a future default change does not silently break them.

---

## Step 8.4 — Flip the CI audit gate to blocking

### Files Involved
`.github/workflows/ci.yml`

### Implementation Details
Remove `continue-on-error: true` from the `Audit (production deps)` step.

### Testing and Verification
1. `npm audit --omit=dev` exits 0.
2. Add a temporary vulnerable production dependency on a branch → confirm CI fails → revert.

---

## Phase 8 exit criteria

- [ ] The Step 8.0 spike result is recorded, including the bundle-size delta
- [ ] `grep -rn "from 'xlsx'" src` returns nothing; `xlsx` appears only under `devDependencies`
- [ ] `injectEmbeddedImagesIntoXlsxBuffer`, `escapeXmlAttr`, `encodeUtf8`, `decodeUtf8` are deleted
- [ ] `exportExcel`'s public signature is unchanged and `useExport.ts` needed no edit for it
- [ ] Headers are genuinely bold in the output (they were not before)
- [ ] WebP handling is an explicit, recorded decision
- [ ] `exportImages` setting exists with `'auto'` default, three budgets enforced, per-export override in the modal
- [ ] An image-embedded export opens cleanly in Excel and LibreOffice with no repair prompt
- [ ] `npm audit --omit=dev` exits 0 and the CI audit step is blocking
- [ ] `tsc --noEmit` still exits 0 · `vitest run` at **≥ 171** passing · `wxt build` OK
