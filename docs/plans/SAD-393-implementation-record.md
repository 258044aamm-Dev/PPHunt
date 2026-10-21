# SAD-393 — Implementation record: warranty and badge fields

Branch `fix/sad-393-warranty-badge` from `main` @ `2ec7eaf`. Owner gates:
Steps 0–5 + 7 and Step 6a; fraction token `1.5-year`; badge stores label
only; branch from `main` (not stacked on SAD-387). Steps 6b (PDP badge) and
6c (read-time warranty healing) were **not** adopted — no PDP badge specimen
has ever been captured, and no evidence of fractional values in stored rows
justified healing.

| Step | Commit | What landed |
|---|---|---|
| 0 | `7a46515` | moli evidence, 6 verbatim fixtures + `baseline-parse.json`, plan |
| 1 | `3759102` | rio capsule selector; all-matches scan; deal-subtree exclusion; apostrophe folding; 9 tests |
| 2 | `8fffca8` | badge diagnostics; card reports 24→25 fields (`CARD_DIAGNOSTIC_FIELDS`), PDP stays 24 |
| 3 | `efaa85f` | parse-cache badge freshness (third late family); 6 tests |
| 4 | `1d7ac0e` | `#tech` + `Warranty and Service` label; Kindle 1-year / Echo 90-day; +5 tests |
| 5 | `f0ef486` | normalizer: mid-number garble fixed, `1.5-year`, `(5)` forms, dash folding; +11 tests |
| 6a | `c01312f` | `brand-and-rank` merge fills warranty pair fill-only; eligibility unchanged |
| 7 | (this record's commit) | A/B parity replay, ARCHITECTURE + CHANGELOG, full gates |

## Step-7 finding: weight containment

The Step-4 container walk is shared: `extractDetailWeight` iterated
`detail.warrantyContainers`. On the full Echo PDP dump (not the trimmed
table), appending `#tech` made weight newly return `"10.7 oz"` from
`#tech`'s own Size-and-Weight rows — true data, but a third field changing
on a badge/warranty ticket. Weight now walks its own `weightContainers`
(the exact pre-SAD-393 list), pinned by a containment test in
`tests/sad-393-parity.test.ts` and re-verified on the full dump
(warranty `90-day` via `#tech`, weight back to pre-fix MISSING). Adding
`#tech` to the weight walk is a separate, separately-evidenced decision.

## Verification

- A/B parity: `tests/sad-393-parity.test.ts` replays all six step-0
  captures against `baseline-parse.json`; only `badge` / the warranty pair
  differ. Old-markup Overall Pick product is byte-identical.
- Gates: `npx tsc --noEmit`, `npx wxt build`, full Vitest,
  `node scripts/check-dead-exports.mjs` — see the step-7 commit / Linear
  SAD-393 for the recorded counts. Temu diff: empty; `src/lib`: untouched.
- New/changed tests: `tests/sad-393-badge.test.ts` (13),
  `tests/sad-393-cache-freshness.test.ts` (6), `tests/sad-393-parity.test.ts`
  (7), `tests/warranty-description.test.tsx` (+16),
  `tests/enrich-saved-product.test.ts` (+3, 1 amended); deliberate 24→25
  pin amendments in the card-diagnostics family.

## Still open (operator, cannot be done headlessly)

moli proves page-side truth but cannot run the extension. Before release:
load the built extension in Chrome on a residential connection, re-run the
step-0 search URLs + canary PDPs (`B0725WFLMB` rio Best Seller,
`B0CFPJYX7P` Kindle, `B09B93ZDG4` Echo, `B00ET5VMTU` Dewalt, `B09FT58QQP`
TOZO negative) via collection and one-click save; confirm Badge/Warranty
columns and CSV/XLSX; one run with diagnostics ON (badge lines present),
one OFF (identical products). Non-.com marketplaces have no captured
evidence (sandbox-blocked) — English labels only, as before.
