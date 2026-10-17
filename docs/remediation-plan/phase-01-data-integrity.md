# Phase 1 — Data Integrity

**Issues addressed:** C‑1 (currency corruption + 1000× price error) · H‑6 (formula injection)
**Estimated effort:** Medium · **Prerequisites:** Phase 0 (baseline snapshot) · **Blocks:** nothing

This phase fixes the two defects that silently corrupt data the user exports and acts on. Neither
change alters any interface, storage schema or UI, which is why it goes first after the guardrails.

---

## Step 1.1 — C‑1: currency inference and the EUR/JPY separator coupling

### Objective
Every product's `currency` field must be a valid ISO‑4217 code (or `null`), and prices written with a
`.` thousands separator must parse correctly on eurozone storefronts.

### Root Cause
Two distinct defects with a single shared cause.

1. **Argument-type confusion.** `parsePrice(text, fallbackCurrency?)` and
   `parsePriceFromElements(whole, fraction, symbol, fallbackCurrency?)` both take an **ISO currency
   code** as their last parameter (`src/lib/utils/price-parser.ts:142-145, 178-182`). Ten call sites
   pass the page **URL** instead:

   | File | Line | Current argument |
   |---|---|---|
   | `src/lib/scraper/field-parsers.ts` | 571 | `parsePrice(text, baseUrl)` |
   | | 859 | `parsePrice(el.textContent, baseUrl)` |
   | | 876 | `parsePriceFromElements(..., baseUrl)` |
   | | 902 | `parsePrice(el.textContent, baseUrl)` |
   | | 923 | `parsePrice(labeledMatch[1], baseUrl)` |
   | `src/lib/scraper/product-detail.ts` | 295 | `parsePrice(el.textContent, baseUrl)` |
   | | 310 | `parsePrice(el.textContent, baseUrl)` |
   | | 317 | `parsePriceFromElements(..., baseUrl)` |
   | | 331 | `parsePrice(hiddenPriceInput.value, baseUrl)` |
   | | 525 | `parsePrice(...)` |

   `resolveCurrencyToken` (`price-parser.ts:68-83`) ends with `return fallbackCurrency ?? null`, so
   an unresolved symbol returns the URL verbatim. `parsePrice` then also returns it at line 174
   (`currency: currency ?? fallbackCurrency ?? null`). `validateAndNormalizeScrapedProduct`
   (`field-parsers.ts:1338`) applies `cleanText(...)?.toUpperCase()` — which upper-cases the URL
   rather than rejecting it — and the value reaches `db.products.currency` and every exporter.

   Note that `parsePriceFromElements` is worse than `parsePrice`: line 190 defaults to
   `fallbackCurrency ?? 'USD'`, so passing a URL yields the URL, not even the `USD` safety net.

2. **Locale-aware separator handling is gated on the corrupted currency.**
   `parseNumericPriceString` (`price-parser.ts:125-135`) only strips `.` as a group separator when
   `currency === 'EUR'`; line 116 has a matching `currency !== 'JPY'` guard. Because the value is a
   URL, neither branch is ever taken, so `"1.299"` → `parseFloat("1.299")` → **1.3**.

   The correct helper `inferCurrencyFromUrl` exists (`price-parser.ts:55`) and is used at exactly one
   of eleven places — `field-parsers.ts:1306`, *after* parsing, never as the parse-time fallback.
   `PLAN.md:871` shows the intended call as `parsePrice(priceEl?.textContent)` with one argument.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/utils/currency.ts` | **create** | `resolvePageCurrency(pageUrl)` → `string \| null`, plus an `isIsoCurrency()` guard. Single source of truth so the ten call sites cannot drift again. |
| `src/lib/utils/price-parser.ts` | modify | Harden `resolveCurrencyToken` so a non-ISO value can never escape as a currency |
| `src/lib/scraper/field-parsers.ts` | modify | 5 call sites |
| `src/lib/scraper/product-detail.ts` | modify | 5 call sites |
| `src/lib/schemas/product.ts` | modify | Add a `currency` refinement so a bad value can never reach IndexedDB again |
| `tests/price-parser-currency.test.ts` | **create** | Symbol-less prices across all 10 storefronts; EUR/JPY separators |
| `tests/baseline-snapshot.test.ts` | modify | Update the `currency` values for symbol-less fixtures, as a named and reviewed change |

### Implementation Details

**`src/lib/utils/currency.ts` (new)**
```ts
import { inferCurrencyFromUrl } from './price-parser';

const ISO_4217 = /^[A-Z]{3}$/;

/** True only for a bare three-letter uppercase code. */
export function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && ISO_4217.test(value);
}

/**
 * Resolves the currency implied by an Amazon page URL.
 * Returns null (never a URL, never a guess) when the host is not recognised.
 */
export function resolvePageCurrency(pageUrl: string | null | undefined): string | null {
  const inferred = inferCurrencyFromUrl(pageUrl);
  return isIsoCurrency(inferred) ? inferred : null;
}
```
Returning `null` rather than defaulting to `'USD'` is deliberate: `HOST_CURRENCY_MAP`
(`price-parser.ts:42`) covers the supported storefronts, and silently labelling an unknown storefront
as USD is exactly the class of wrong-but-plausible data this step exists to eliminate. The existing
`?? 'USD'` default at `field-parsers.ts:1306` is left as-is because that path is post-parse
normalisation, not parse-time inference.

**`src/lib/utils/price-parser.ts`** — one guard, in `resolveCurrencyToken`:
```ts
-  if (!rawSymbol) return fallbackCurrency ?? null;
+  if (!rawSymbol) return isIsoCurrency(fallbackCurrency) ? fallbackCurrency : null;
   ...
-  return fallbackCurrency ?? null;
+  return isIsoCurrency(fallbackCurrency) ? fallbackCurrency : null;
```
and the same at `parsePrice:174` (`currency: currency ?? (isIsoCurrency(fallbackCurrency) ? fallbackCurrency : null)`).
This is defence in depth: even if a future call site passes junk again, a URL can no longer become a
currency. It also means the `CAD`/`AUD` special case at lines 76-78 keeps working, since those
comparisons are against literals.

**The ten call sites.** In each of the two scraper files, resolve once per parse invocation rather
than per element — `extractCardPricingAndDiscounts` and `extractDetailPrice` each receive `baseUrl`
and call the parser several times:
```ts
// top of the function that owns `baseUrl`
const pageCurrency = resolvePageCurrency(baseUrl);
...
- const parsed = parsePrice(el.textContent, baseUrl);
+ const parsed = parsePrice(el.textContent, pageCurrency);
```
This keeps the diff to one added line plus ten mechanical argument swaps, and avoids ten repeated
`new URL()` constructions (relevant to Phase 5's performance work).

**`src/lib/schemas/product.ts`** — make the invariant permanent:
```ts
currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code').nullable().default(null),
```
Any product that still carries a URL now fails `ProductSchema.safeParse` in
`background.ts:271-283` and is dropped — which is why Step 5.4 (M‑7, logging rejections) should
ideally land in the same release, so a drop is not silent. Until then the Phase‑1 tests assert the
correct value is produced in the first place.

### Dependencies and Order
- Requires Phase 0 Step 0.3 (the golden snapshot) so the "no unintended change" claim is provable.
- Independent of every other phase.
- Note the interaction with **Phase 5**: `resolvePageCurrency` is called once per card-parse
  invocation, and Phase 5's memoisation must not move it inside a per-element loop.

### Testing and Verification

**New test file `tests/price-parser-currency.test.ts`** — the test that fails without the fix:

| Case | Input | Must produce |
|---|---|---|
| DE, symbol-less | `parsePrice('49,99', resolvePageCurrency('https://www.amazon.de/s?k=x'))` | `{ value: 49.99, currency: 'EUR' }` |
| DE, thousands | `parsePrice('1.299', 'EUR')` | `{ value: 1299, currency: 'EUR' }` |
| DE, full | `parsePrice('1.299,99', 'EUR')` | `{ value: 1299.99, currency: 'EUR' }` |
| JP, symbol-less | `parsePrice('3,980', 'JPY')` | `{ value: 3980, currency: 'JPY' }` |
| JP, split elements | `parsePriceFromElements(whole='3,980', fraction=null, symbol='￥', 'JPY')` | `{ value: 3980, currency: 'JPY' }` |
| Guard | `parsePrice('49.99', 'https://www.amazon.de/s?k=x')` | `currency === null` (**not** the URL) |
| Guard | `parsePrice('49.99', 'usd')` | `currency === null` (lowercase is not ISO) |
| All 10 storefronts | `resolvePageCurrency(url)` for `.com .de .co.uk .fr .it .es .ca .com.au .co.jp .in` | the documented code for each; `null` for `https://example.com` |

**End-to-end parser tests** (extend `tests/scraper-accuracy.test.tsx` rather than duplicating
fixtures): add a DE search fixture whose price nodes use split `.a-price-symbol` / `.a-price-whole` /
`.a-price-fraction` markup **and** a variant with the symbol only in `.a-offscreen`. Assert every
returned product satisfies `/^[A-Z]{3}$/` on `currency`, and that the `1.299` case yields `1299`.

**Regression checks**
1. `tests/baseline-snapshot.test.ts` — every symbol-bearing fixture must be **byte-identical**. Only
   the symbol-less fixtures' `currency` values may change, and each such change must be listed in the
   PR description.
2. All existing assertions in `scraper-accuracy` (which use `€`, `£`, `$`, `￥`) must pass unchanged —
   they are the proof that an explicit symbol still wins over URL inference.
3. `npx tsc --noEmit` stays at 108 errors (this step adds none and removes none).
4. Manual: export a DE collection to CSV and confirm the Currency column reads `EUR`.

---

## Step 1.2 — H‑6: neutralise spreadsheet formula injection in CSV and clipboard export

### Objective
A product field whose value begins with a formula trigger must not be evaluated when the user opens
the export in Excel or Google Sheets.

### Root Cause
`escapeCSV` (`src/lib/export/csv.ts:76-81`) implements only RFC 4180 structural escaping — it quotes
values containing `,`, `"` or `\n` and doubles internal quotes. It never addresses the leading
character. `exportClipboard` (`src/lib/export/clipboard.ts:38`) strips only `\t` and `\n`. Every
string field originates from seller-authored Amazon listing content (title, brand, seller, badges,
coupons, delivery text), so this is attacker-influenced input reaching a spreadsheet that evaluates
formulas.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/export/sanitize.ts` | **create** | `neutralizeSpreadsheetFormula(value: string): string` — one implementation shared by all exporters |
| `src/lib/export/csv.ts` | modify | Apply inside `escapeCSV`, before quoting |
| `src/lib/export/clipboard.ts` | modify | Apply inside the per-cell mapper at line 38 |
| `src/lib/export/excel.ts` | modify | Apply to the **string** branch only (`excel.ts:415` `return value ?? ''`) |
| `tests/export-injection.test.ts` | **create** | Payload matrix across all three exporters |

### Implementation Details

**`src/lib/export/sanitize.ts` (new)**
```ts
/**
 * Characters that cause Excel / Google Sheets / LibreOffice Calc to interpret a
 * cell as a formula rather than text when the value is loaded from CSV or pasted
 * from the clipboard. Tab and CR are included because they are documented
 * bypasses of naive `=`-only filters.
 */
const FORMULA_LEAD = /^([=+\-@\t\r])/;

/**
 * Prefixes a leading apostrophe so the value is treated as literal text.
 * Returns the input unchanged when it does not start with a trigger character.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}
```
A leading apostrophe is the standard mitigation and is invisible in the spreadsheet's rendered cell
while being preserved in the formula bar. The alternative (prefixing a space) alters visible content
and breaks downstream `VLOOKUP`/`TRIM`-free workflows, so it is not used.

**`csv.ts`** — one line inside `escapeCSV`, applied **before** the quoting decision so the added
apostrophe is itself quoted correctly when the value also contains a comma:
```ts
function escapeCSV(value: string): string {
  const safe = neutralizeSpreadsheetFormula(value);
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
```

**`clipboard.ts:38`**
```ts
- return value.replace(/\t/g, ' ').replace(/\n/g, ' ');
+ return neutralizeSpreadsheetFormula(value.replace(/[\t\n]/g, ' '));
```
Order matters: strip the structural characters first (so a value that *only* started with a tab is
not needlessly prefixed), then neutralise.

**`excel.ts:415`** — apply to the string branch only. The numeric early-returns at lines 394-406
(`Price`, `List Price`, `Rating`, `Reviews`) must be left untouched so those cells stay real numbers
and remain sortable/summable:
```ts
- return value ?? '';
+ return typeof value === 'string' ? neutralizeSpreadsheetFormula(value) : (value ?? '');
```
SheetJS's `aoa_to_sheet` writes a JS string as an inline string cell (`t="s"`), which Excel does not
auto-evaluate, so this is belt-and-braces for the current engine. It becomes **load-bearing in
Phase 8**: `exceljs` assigns cell types by inspection and will interpret a leading `=` as a formula,
so this line must be in place before that rewrite. A Phase‑8 verification step re-checks it.

### Dependencies and Order
Independent of Step 1.1 and of every other phase. Must land **before** Phase 8 (exceljs), because
exceljs actively evaluates leading `=` in string assignments.

### Testing and Verification

**New `tests/export-injection.test.ts`** — payload matrix, each asserted through CSV, clipboard and
XLSX:

```
=1+1
+1+1
-1+1
@SUM(A1:A2)
=cmd|'/C calc'!A0
=HYPERLINK("http://evil.example";"Click")
\t=1+1        (tab-prefixed bypass)
=DDE("cmd";"/C calc";"A1")
```
Assertions: the emitted cell never begins with `= + - @ \t \r`. For CSV, also assert the value is
still correctly quoted when it contains a comma (e.g. `=cmd|'/C calc'!A0,A1`).

**Non-regression assertions in the same file (risk R6):**
- A title of `"Wireless Charger, 20W"` still exports as `"Wireless Charger, 20W"` — quoted, no
  apostrophe.
- `product.price = -5` exports as the **number** `-5`, not the string `'-5'`.
- A `discountPercentage` accessor returning `"-68%"` (a string) exports as `'-68%"` — prefixed.
  Confirm this is acceptable: it is a string field, and the prefix is the correct mitigation.
- `includeBOM: true` still emits `\uFEFF` at position 0, before any apostrophe.

**Regression checks**
1. `tests/history-preview-export.test.tsx` and `tests/preview-images-rownumbers-export.test.tsx`
   assert CSV/XLSX output for normal fixtures — must pass unchanged, since no fixture value starts
   with a trigger character. **Verify this assumption first**: grep the fixtures for values beginning
   with `-` or `+` before running.
2. `npx vitest run` count does not decrease.

---

## Step 1.3 — Optional: one-off migration for already-stored corrupt rows

### Objective
Existing users' IndexedDB rows may already contain a URL in `currency`. Per decision **D7** this is
*not* done by default — the CHANGELOG tells users to re-collect. This step is here if you prefer an
automatic repair.

### Root Cause
Rows persisted before Step 1.1 carry `currency: "HTTPS://WWW.AMAZON.DE/..."`.

### Files Involved
| File | Action | Responsibility |
|---|---|---|
| `src/lib/db/database.ts` | modify | Bump `db.version(N+1)` and add an `upgrade` that rewrites bad `currency` values |

### Implementation Details
```ts
this.version(N + 1).stores({ /* unchanged */ }).upgrade(async (tx) => {
  const products = tx.table('products');
  await products.toCollection().modify((p) => {
    if (typeof p.currency === 'string' && !/^[A-Z]{3}$/.test(p.currency)) {
      p.currency = inferCurrencyFromUrl(p.url) ?? null;
    }
  });
});
```
`p.url` is the product's own Amazon URL, which is the correct source for re-inference. The
`price` value **cannot** be repaired by migration — `"1.299"` was already stored as `1.3`, and the
original text is gone. That is the strongest argument for the D7 default: re-collection fixes both
fields, migration fixes only one.

### Testing and Verification
Test: seed `db.products` with a row carrying `currency: 'HTTPS://WWW.AMAZON.DE/S?K=X'` and
`url: 'https://www.amazon.de/dp/B0X'`, close and reopen the DB at the new version, assert
`currency === 'EUR'`. Existing rows with a valid code must be untouched.

---

## Phase 1 exit criteria

- [ ] `grep -rn "parsePrice(.*baseUrl\|parsePriceFromElements(.*baseUrl" src` returns nothing
- [ ] No product reaching `db.products` can have a `currency` that fails `/^[A-Z]{3}$/`
- [ ] `parsePrice('1.299', 'EUR') === 1299` and `parsePrice('3,980', 'JPY') === 3980`
- [ ] No exported CSV/TSV/XLSX cell begins with `= + - @ \t \r`
- [ ] `tests/baseline-snapshot.test.ts` diffs are limited to symbol-less fixtures' `currency`, each listed in the PR
- [ ] `tsc --noEmit` at **108** errors · `vitest run` at **≥ 93** passing · `wxt build` OK
