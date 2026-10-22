# SAD-392 → MergeBranch: merge plan + execution record

**Date:** 2026-10-22 · **Branches:** `fix/sad-392-availability-source` (dcaf42e at start) →
`MergeBranch` (dee5255 at start, treated as the main branch; `main` untouched — A1) ·
**Result:** merged as `bca14d7`, all gates green. This file was reconstructed after a workspace
rollback destroyed the uncommitted original; every number below is measured, not remembered.

## 1. Binding decisions (user answers via ask_user)

| # | Decision |
|---|----------|
| A1 | `main` stays untouched; `MergeBranch` is the integration target. |
| D-M1 | Reconcile **on the fix branch first** (repo precedent: SAD-381 step 6, SAD-385, SAD-386 step 7), then merge back. |
| D-M2 | CHANGELOG both-sides resolution: SAD-392 section topmost, then SAD-393, then the existing order (SAD-381, …). |
| D-M4 | **Unify the strippers now**: keep SAD-390's `extractCleanElementText` (measured superset), retire SAD-392's `extractAmazonElementText`, protocol U1–U6 below, behavior pins of both tickets unchanged or STOP. |
| D-M5 | Merge message: `Merge fix/sad-392-availability-source (SAD-392 availability & source fields) into MergeBranch`. |
| D-M6 | Full gate chain on every pushed tree: tsc → dead-exports → wxt build → full vitest → npm audit. |
| D-M7 | Direct merge + push (no PR). |
| D-M8 | SAD-392 stays **In Review**; merge-record Linear comment with SHA + gate numbers; docs commit `docs(sad-392): record the MergeBranch merge SHA and gate numbers`. |
| Gate-0 stop rule | MergeBranch red **before us** → do not merge onto a red base, do not attribute their breakage to our merge. User answer: *repair MergeBranch first* — clearly-attributed separate commits, then re-run gate 0 and merge on a green base. |

## 2. Pre-merge analysis (probes S1–S8, measured on dee5255 × dcaf42e)

- **S1 merge-tree simulation:** the only textual conflict is `CHANGELOG.md` (both sides added an
  `[Unreleased]` section at the top). `ARCHITECTURE.md`, `field-parsers.ts`, `product-detail.ts`
  auto-merge clean; `database.ts` / `db/products.ts` / `dedup.ts` / migration tests are ours-only
  (database v3 is uniquely ours; MergeBranch stayed on v2).
- **S2 case-5 delivery pin:** our whole-card pin (`tests/sad-392-availability-source.test.ts`,
  case 5) recorded the dirty 1416-char Prime-signup delivery blob from a main-based branch.
  MergeBranch carries SAD-390's clean-delivery extractor → the pin was **expected to fail and be
  re-recorded from the merged parser's measured output** (availability:null and all other fields
  held). This is a hand-off SAD-392 made deliberately (D5).
- **S3 stock-span identity:** SAD-390's delivery tests read clean fixtures → our stripped stock
  read keeps them green (identity where no script/style descendant exists).
- **S7 unification direction:** `extractCleanElementText` (walk-based; skips
  script/style/noscript/template, `[hidden]`, `.aok-hidden`, `.a-hidden`, `.a-popover-preload`,
  optional extra class; block-boundary spaces; always normalized; `''` never null; root-exclusion
  check) is a superset of `extractAmazonElementText` (clone-based; script/style/noscript only;
  raw textContent otherwise; null-safe). Our downstream contract (`cleanAvailability` normalizes;
  `''`/null equally falsy at both call sites) absorbs the differences.

## 3. Gate 0 — MergeBranch was red before us (repairs, separately attributed)

Gate 0 on dee5255 failed to even compile, then failed 10 tests. Provenance (measured):
`dee5255` merged `af7feee` (MergeBranch pre-393, carrying SAD-389's parse-cache lane) with
`8360a69` (SAD-393 tip, carrying the badge freshness gate); **neither parent contained the
other's parse-cache evolution**, and the hand-built content union was botched. Each parent was
verified green on the affected suites (af7feee 66/66, 8360a69 24/24) — the breakage belongs to
the merge resolution alone. Repairs, each its own attributed commit on MergeBranch:

1. **`6723b04`** — `parse-cache.ts:44` carried the comment terminator ` */` twice (TS1109/TS1161;
   both parents provably single). One-line deletion.
2. **`3676dfc`** — the parse-cache union itself, repaired test-driven from both parents:
   SAD-383's signature-match branch had been dropped entirely (re-parse storms: 5 parses instead
   of 1 on unchanged cards); the settled (price-family + badge) early return bypassed SAD-389's
   recovery lane (a settled badge froze out late sales); and an invented "badge_in_lane" fill
   contradicted SAD-393's parser-call-count pins. Restored: af7feee's lane verbatim
   (coupon/sales-only) + 8360a69's `getOrParse` structure (settled check, signature branch,
   `badgeCouldHaveArrived` gate falling through to a full re-parse) with **every** early return
   routed through the lane. Fixed 6 of the 10 failures.
3. **`f3ffda9`** — the remaining 4 failures were legitimate cross-ticket pin staleness any correct
   union must reconcile: SAD-389's diagnostics-count pin 24 → 25 (SAD-393's step 2 adds `badge`
   to the card report — its own ticket text says "25-field card report"); and SAD-393's step-0
   parity baseline was recorded on a main-based branch **without SAD-390**, so its two stored
   delivery blobs (1416 chars) were stale against the cleaned delivery read (122 chars). Baseline
   re-recorded by a one-off script that first *proved* delivery was the only differing field
   (byte-identical remainder under the parity test's own exclusions), then rewrote the JSON by
   raw-text replacement (formatting untouched; badge values unchanged).

**Gate 0 re-run on `f3ffda9`: tsc green, dead-exports green, wxt build green, vitest 1549/1549,
audit 0** → green base, merge proceeded.

## 4. Phase 1 — reconciliation on the fix branch (pushed as `e6f30cc`)

1. **`9d043d7`** — `git merge origin/MergeBranch` into the fix branch. Conflicts: CHANGELOG.md
   only, exactly as simulated. Resolved per D-M2 (marker removal; SAD-392 topmost → SAD-393 →
   SAD-381 → …). SAD-388/389/390 added no changelog sections (verified).
2. **`53bc91d`** — S2 re-record, measured: the merged suite failed **only** the case-5 delivery
   edges (1574/1575). Replaced the three measured-edge assertions (length 1416 / dirty head /
   tail) with a single exact `toBe` of the merged parser's output — the same 122-char clean
   sentence measured twice during the SAD-393 baseline re-record: `Join Prime to get FREE
   delivery Fri, Oct 23 Or Non-members get FREE delivery Mon, Oct 26 on $35 of items shipped by
   Amazon`. Whole-object pin held byte-identical (availability:null, badge `Overall Pick`,
   pastMonthSales, …); cases 1–4 and 6–11 untouched.
3. **`e6f30cc`** — D-M4 unification, protocol U1–U6:
   - **U1 inventory:** our stripper had exactly two call sites — the PDP availability loop
     (`product-detail.ts`, `cleanAvailability(·)`) and the card stock read (`field-parsers.ts`,
     `normalizeWhitespace(·)`).
   - **U2 equivalence matrix (measured before the swap):** one-off probe over every element of
     all 17 committed fixtures of SAD-389/390/392/393 — **1263 elements**, compared at both
     call-site contracts. **1082 identical; 181 divergent, every one in a designed superset
     class:** 98 hidden/preload/template skips, 58 block-boundary spacing (equal once whitespace
     is squashed), 25 root-level script/style elements (neither call site can pass one:
     `#availability`-family selectors and a `.a-color-price` span). **Zero unexplained
     divergences; no STOP condition touched.** Probe deleted after the run.
   - **U3/U4 swap:** both call sites moved to `extractCleanElementText` (stock read drops the
     now-redundant `normalizeWhitespace` wrapper — the survivor is already normalized).
   - **U5 retirement:** `extractAmazonElementText` deleted; no residual references in `src/` or
     `tests/` (one historical mention survives in a comment and in the fix-task plan doc).
     SAD-392's step-1 unit describe re-points at the survivor with its contract (normalized
     `In Stock`; `''`-safe instead of null-safe) — end-to-end pins of both tickets unchanged.
   - **U6 docs:** ARCHITECTURE.md §availability and the CHANGELOG SAD-392 bullet now describe the
     unified read; `availability-text.ts` doc-comment reference updated. Temu keeps its own
     stripper (separate engine, untouched).
   - Gates on `e6f30cc`: tsc ✓, dead-exports ✓, build 2.05 MB ✓, **vitest 1575/1575** ✓, audit 0 ✓.

## 5. Phase 2 — the merge itself

`bca14d7` — `git merge --no-ff origin/fix/sad-392-availability-source` onto MergeBranch with the
D-M5 message. Zero conflicts by construction (the fix-branch tip is a descendant of `f3ffda9`);
merged tree verified **byte-identical** to `e6f30cc`'s tree. Gates re-run on the merge commit
(D-M6): tsc green · dead-exports green (42 files) · wxt build green (2.05 MB, ~3.1 s) ·
**vitest 1575/1575 (137 files passed, 1 skipped)** · npm audit 0 vulnerabilities. Pushed.

## 6. Phase 3 — records

This file + the verification-report merge section (`docs/plans/SAD-392-verification-report.md`
§9), committed as `docs(sad-392): record the MergeBranch merge SHA and gate numbers`, then the
Linear merge-record comment on SAD-392 (state stays **In Review** per D-M8).

## 7. Commit map (all pushed)

| SHA | Branch | What |
|-----|--------|------|
| `6723b04` | MergeBranch | gate-0 repair 1: duplicated comment terminator from dee5255 |
| `3676dfc` | MergeBranch | gate-0 repair 2: parse-cache SAD-389×SAD-393 union, test-driven |
| `f3ffda9` | MergeBranch | gate-0 repair 3: SAD-389 diagnostics count + SAD-393 baseline delivery re-record |
| `9d043d7` | fix branch | MergeBranch merged in; CHANGELOG resolved per D-M2 |
| `53bc91d` | fix branch | case-5 delivery pin re-recorded (S2, measured) |
| `e6f30cc` | fix branch | stripper unification (D-M4, U2 matrix measured) |
| `bca14d7` | MergeBranch | **the merge** (`--no-ff`, D-M5 message, gates green) |
