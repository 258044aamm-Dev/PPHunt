# SAD-391 → `MergeBranch` — Plan Only (re-verified against `MergeBranch@36589c3`)

> **Status: plan only.** Nothing has been committed, pushed or changed in the repository by this plan.
> Every number below was measured in throw-away worktrees on 2026-10-22; the resolved files, patches
> and logs are kept outside the repo (Appendix B). This document is written to be committed verbatim
> as `docs/plans/SAD-391-merge-into-MergeBranch-plan.md` (decision D2).

| | |
|---|---|
| Source | `fix/sad-391-prime-sponsored` @ `450a6a0` — 7 commits on `main@2ec7eaf`; Linear SAD-391 *In Review* |
| Target | `MergeBranch` @ `36589c3` (re-fetched this session; it moved from `dee5255` — see §2) |
| `main` | still `2ec7eaf`, untouched by this plan |
| Supersedes | the plan written against `dee5255` earlier today (its Step 1 is now upstream, §2) |

## 0. Decisions (operator, 2026-10-22)

| # | Decision | Consequence in this plan |
|---|---|---|
| D1 | Repair MergeBranch's own breakage as part of this effort | **Already done upstream** (`6723b04`, `3676dfc`, `f3ffda9`); verified equivalent to the repair this plan proposed — nothing left to do (§2) |
| D2 | Delivery reader = SAD-390's `extractCardDeliveryAndAvailability` + SAD-391's structural UDM message-row read | §5.3 |
| D3 | Landing shape: "choose the best option" → **two-phase, as SAD-392 and SAD-387 landed** (Phase A merge on the feature branch, Phase B conflict-free `--no-ff` into MergeBranch, Phase C record) | §6–§8. Chosen because (a) it is the convention of the two most recent integrations (`9d043d7`→`bca14d7`, `d9dd46a`→`3ccf2ce`); (b) the conflict resolution becomes one reviewable, independently gated commit instead of living only in a merge-commit body; (c) the MergeBranch merge is conflict-free by construction — proven in §4 |
| D4 | Plan document committed in the repo like SAD-392/387 | Phase A commit A0 adds this file; the SAD-391 implementation record gets a merge-record section in Phase C |
| D5 | Linear: comment with the merge SHA; SAD-391 stays *In Review* | §8 |

## 1. What the target branch is — measured

```
36589c3 docs(sad-387): record the MergeBranch merge SHA, conflicts and gate numbers
3ccf2ce Merge fix/sad-387-deal-countdown (SAD-387 deal countdown text) into MergeBranch
c379da6 docs(sad-392): record the MergeBranch merge SHA and gate numbers
bca14d7 Merge fix/sad-392-availability-source (SAD-392 availability & source fields) into MergeBranch
f3ffda9 test(amazon): reconcile SAD-389/SAD-393 pins with the merged MergeBranch parser
3676dfc fix(amazon): repair the SAD-389×SAD-393 parse-cache union left by the dee5255 merge
6723b04 fix(amazon): drop the duplicated comment terminator introduced by the dee5255 merge resolution
dee5255 Merge fix/sad-393-warranty-badge (SAD-393 warranty and badge fields) into MergeBranch
af7feee Merge fix/sad-390-… (SAD-390) · 3ed2a84 SAD-388 · bc0904f SAD-389 · 2ec7eaf = main
```

**Baseline gate of `36589c3` (fresh worktree, this session):** `tsc` clean · `vitest` **138 files passed | 1 skipped (139) — 1594 passed | 3 skipped (1597)** · `wxt build` OK. Matches the numbers recorded in `docs/plans/SAD-387-verification-report.md` ("1597 tests / 139 files"). CI (`.github/workflows/ci.yml`) now runs on pushes to `MergeBranch` and consists of: `tsc --noEmit`, `npm run check:dead-exports`, `vitest run`, `wxt build`, `npm audit --omit=dev`, `npm audit` (informational), manifest sanity. The gate in this plan is that exact list.

Not on MergeBranch: SAD-391 only (SAD-387/388/389/390/392/393 are all in).

## 2. What changed since the first plan, and what it means

| Finding of the first plan (against `dee5255`) | State on `36589c3` |
|---|---|
| F1 duplicated ` */` in `parse-cache.ts` (TS1109; build and engine tests broken) | fixed by `6723b04` |
| F2 `getOrParse` lost SAD-383's signature check, SAD-393's badge re-read and bypassed the SAD-389 lane (6 cache-test failures) | fixed by `3676dfc`. **Verified: its code is identical to the repair proposed by the first plan** — `diff` of the two files is 39 lines, all comments; both are the pure 3-way union of SAD-389's lane (verbatim, no badge fill) and SAD-393's conditions |
| F2 stale pins: `sad-389-fields` 24→25 and the two SAD-393 parity-baseline `delivery` strings | fixed by `f3ffda9`, content-identical to the first plan's Step 1 |
| "SAD-387 / SAD-392 may land first and overlap" | both landed. SAD-392 changed one line inside `extractCardDeliveryAndAvailability` (`stockText` now read with `extractCleanElementText`) and inserted a provenance-promotion block in `dedup.ts` immediately above SAD-391's placement-union guard; SAD-387 added `sanitizeDealBadge` imports/calls in both parsers (outside SAD-391's regions). Neither touched `card-diagnostics.ts`, so the field universe is still **PDP 25 / card 26** after SAD-391 |

Net effect: **Step 1 of the first plan is gone**; the merge itself is re-done against `36589c3` with one resolution hunk adapted (§5.3) and the CHANGELOG placement adapted (§5.6). Everything else is unchanged and re-measured.

## 3. Conflict surface — measured, not guessed

`git merge --no-ff --no-commit origin/fix/sad-391-prime-sponsored` on `36589c3` → **7 conflicted files, 12 hunks** (identical file list and hunk counts to the `dee5255` trial):

| File | Hunks | Nature |
|---|---|---|
| `CHANGELOG.md` | 1 | two "Unreleased" stacks at the top (SAD-387/392/393 vs SAD-391) |
| `src/engines/amazon/scraper/card-diagnostics.ts` | 1 | doc comment — SAD-393 (card-only `badge`) vs SAD-391 (`isSponsored`) |
| `src/engines/amazon/scraper/field-parsers.ts` | 3 | the delivery reader: SAD-390 + SAD-392's `stockText` line vs SAD-391's rewrite; SAD-391's `visibleTextContent` helper + 2 regex constants vs SAD-390's `DELIVERY_KEYWORD_RE` |
| `src/engines/amazon/scraper/product-detail.ts` | 3 | imports; two helper blocks inserted at the same place; SAD-390's two-pass delivery loop vs SAD-391's |
| `tests/card-diagnostics.test.ts` | 2 | header / D3 comments (counts) |
| `tests/collection-diagnostics-e2e.test.tsx` | 1 | PDP pin comment |
| `tests/sad-386-diagnostics.test.ts` | 1 | test title (count) |

Auto-merged but touched by both sides (reviewed, coherent): `category-page.ts`, `search-results.ts`, `selectors.ts` (SAD-393's `badge` next to SAD-391's `primeSignal`/`isSponsored` in the same literals), `dedup.ts` (SAD-392's `source` promotion at L112–121, SAD-391's `sourceHasListingContext` guard from L138 — independent fields, order irrelevant), `tests/save-product.test.ts`, `tests/card-icon-save-diagnostics.test.tsx`.

Three **silent semantic overlaps** git does not flag (unchanged from the first plan):
1. **Diagnostics count** — both sides moved pins 24→25 "identically", but the merged truth is PDP = 25 (`DETAIL_DIAGNOSTIC_FIELDS` + `isSponsored`) and card = 26 (+ card-only `badge`). Code is already right (`CARD_DIAGNOSTIC_FIELDS` derives from the detail list); only pins and prose need fixing.
2. **Delivery reader** — a naïve "take HEAD" of the conflicting hunks alone leaves SAD-391 identifiers referenced elsewhere in the function (`TS2304`); on `36589c3` the conflict block happens to enclose the whole stock-span read, but the function must still be taken **as a whole**.
3. **Brace folding in `product-detail.ts`** — "keep both" helper blocks drops the closing `}` of `isInsideSecondaryOfferSubtree` (shared hunk suffix) → `TS1005` at EOF unless re-added.

One **behavioural** difference between the two readers (SAD-391's test F5): on signed-in UDM markup the whole-block read returns `"One-Day FREE delivery Tomorrow, Oct 22"` (badge text leaks into Delivery). Reading `.udm-primary/secondary-delivery-message` first avoids it; logged-out cards are byte-identical either way.

## 4. Simulation result (the evidence this plan rests on)

Phase A simulated on a worktree at `36589c3` with the resolution of §5 applied, then Phase B simulated by merging that commit into a second worktree at `36589c3`:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run check:dead-exports` | "all src/lib exports have consumers (42 files scanned)" |
| `npx vitest run` | **143 files passed \| 1 skipped (144) — 1681 passed, 0 failed** (= 1597 baseline + SAD-391's 84 tests; 139 + 5 files) |
| `npx wxt build` | OK, 2.06 MB |
| `npm audit --omit=dev` | 0 vulnerabilities |
| manifest sanity | `name: PPHunt` |
| Live-capture replay (`/s?k=laptop`, 33 rows) | **identical** to the SAD-391 branch measurement: Prime 12, Sponsored 17, 0 CSS/JS leaks, 0 lost deliveries |
| Ticket suites | `sad-391-*` 22/36/9/9/8 · `sad-390-delivery-seller` 17/17 · `sad-392-availability-source` 26/26 · `sad-387-deal-countdown` 22/22 · `sad-393-badge` 13/13 · `sad-393-parity` 7/7 · `sad-393-cache-freshness` 6/6 |
| Phase B (`git merge --no-ff <PhaseA>` on `36589c3`) | **no conflicts; resulting tree byte-identical to the Phase A tree**; `git diff --stat 36589c3..` = **34 files, +2579 / −94** |

Note on the "3 skipped": `tests/manifest-permissions.test.ts` wraps three tests in `describe.skipIf(!existsSync('dist/chrome-mv3/manifest.json'))`, while `tests/manifest-war.test.ts` runs a real `npx wxt build` mid-suite. Whether the three run or skip depends on worker ordering (they ran in the merged simulation, skipped in the baseline run). Pre-existing and unrelated to this merge; both outcomes are green. Expect either **1681 passed** or **1678 passed | 3 skipped**.

## 5. The conflict resolution, in full

### 5.1 `src/engines/amazon/scraper/parse-cache.ts` — nothing
No longer in play: SAD-391 does not touch it and `36589c3` already carries the correct union (§2).

### 5.2 `src/engines/amazon/scraper/card-diagnostics.ts`
Doc comment (L30–32 and the paragraph above `CARD_DIAGNOSTIC_FIELDS`): merged wording — "25 detail fields (`isSponsored` since SAD-391) plus the card-only `badge` (SAD-393) = 26 on cards; PDP reports carry the 25 detail fields". Code untouched.

### 5.3 `src/engines/amazon/scraper/field-parsers.ts` (decision D2)
- Constants hunk: keep SAD-390's `DELIVERY_KEYWORD_RE`; **drop** SAD-391's `DELIVERY_WORD_PATTERN`, `DELIVERY_RECIPE_STOCK_PATTERN` and the `visibleTextContent` helper (no production caller remains; `extractCleanElementText` excludes the same tags plus hidden nodes and is tested by SAD-390/392).
- `extractCardDeliveryAndAvailability`: take **HEAD's whole function** (SAD-390's 8-locale reader with SAD-392's `const stockText = extractCleanElementText(stockSpan);`), then inside its `if (!delivery)` fallback insert, before the whole-block read:

```ts
      // SAD-391 (F5): a signed-in card renders the Prime badge
      // (`.udm-badge-block`, e.g. "One-Day") inside the same block as the
      // message rows; read the message rows first so badge text never
      // prefixes the delivery string. Logged-out cards have an empty badge
      // block and yield exactly the whole-block text.
      const primaryMessage = safeQuerySelector(udmBlock, '.udm-primary-delivery-message');
      if (primaryMessage) {
        const messageText = [
          extractCleanElementText(primaryMessage, 'a-color-price'),
          extractCleanElementText(
            safeQuerySelector(udmBlock, '.udm-secondary-delivery-message'),
            'a-color-price',
          ),
        ].filter(Boolean).join(' ');
        if (messageText && DELIVERY_KEYWORD_RE.test(messageText)) delivery = messageText;
      }
      if (!delivery) { /* SAD-390's whole-block read, unchanged */ }
```
- `tests/sad-391-delivery-recipe.test.ts`: remove the `visibleTextContent` import and its 3-assertion `describe` (8 tests remain, all passing; the F5 "One-Day" case is among them).

### 5.4 `src/engines/amazon/scraper/product-detail.ts`
Imports: both sides' sets (SAD-390 `extractCleanElementText`, SAD-387 `sanitizeDealBadge`, SAD-391 `findPrimeBadgeLabel`) **minus** `visibleTextContent`. Helpers: keep SAD-390's `SECONDARY_OFFER_SUBTREES` / `isHiddenDetailCandidate` / `isInsideSecondaryOfferSubtree` **and** SAD-391's `DETAIL_PRIME_*` + `detectDetailPrimeSignal`, re-inserting the `}` + blank line between them. Delivery loop: SAD-390's two-pass loop (it already strips inline code, which is all SAD-391's version added). SAD-392's `availability = cleanAvailability(extractCleanElementText(el))` and SAD-387's deal-badge line are outside the conflicts and stay.

### 5.5 Pins — PDP 25, card 26 (line numbers as in the resolved tree)
| File | Set to |
|---|---|
| `tests/card-diagnostics.test.ts` | L4, L71, L144 prose "26-field"; L86, L156 `toHaveLength(26)`; L122 `toBe(26)`; merged header/D3 comments |
| `tests/card-icon-save-diagnostics.test.tsx` | L120 → 26 |
| `tests/collection-diagnostics-e2e.test.tsx` | L152 → 26 (card); L257 stays 25 (PDP, comment merged); L298 → 26 (card save report) |
| `tests/sad-386-diagnostics.test.ts` | L54 title "26 fields (card universe: 25 detail fields since SAD-391 + badge since SAD-393)"; L56 `expected = 26` |
| `tests/sad-389-fields.test.ts` | L90 25 → 26, comment "24 on the SAD-389 branch, +1 `badge` (SAD-393), +1 `isSponsored` (SAD-391)" |
| `tests/sad-391-diagnostics.test.ts` | L81, L152 → 26; L127 sum → 26; L140 prose; L61–62 (`DETAIL_DIAGNOSTIC_FIELDS` = 25) and L173 (PDP) stay 25 |
| `tests/sad-393-badge.test.ts` | L152 prose, L155 → 26 |
| `tests/save-product.test.ts` | L157 → 26 (card); L205, L288 stay 25 (PDP) |

Untouched on purpose: `tests/scraper-accuracy.test.tsx` (`24` = enabled-field count), `tests/warranty-description.test.tsx` (`26` = `DEFAULT_ENABLED_FIELDS`), `tests/docs-consistency.test.ts` (does not pin these counts).

### 5.6 Docs inside the Phase A merge
- **`CHANGELOG.md`** — keep every section; SAD-391's entry goes **topmost** (newest integration first: SAD-391 → SAD-387 → SAD-392 → SAD-393 → …), exactly as SAD-387 placed itself above SAD-392/393. Two factual edits inside the SAD-391 entry:
  - the bullet **"Delivery text is read structurally"** → "On MergeBranch the delivery block is read with SAD-390's `extractCleanElementText` (SAD-390 and SAD-392 fixed the same inline-code and stock-span defects independently); SAD-391 adds the structural read of `.udm-primary-delivery-message` / `.udm-secondary-delivery-message` ahead of the whole-block fallback, so a signed-in card's Prime badge text (e.g. *One-Day*) never prefixes **Delivery**. Measured capture: 11 → 0 polluted values, 4 → 0 cards without delivery — unchanged after the merge."
  - the bullet **"`isSponsored` is the 25th modelled field (24 → 25)"** → append "On MergeBranch, where SAD-393's card-only `badge` already exists, card reports carry 26 fields and product-page reports 25."
- **`ARCHITECTURE.md`** (not touched by the branch; stale even there): L489 "Each of the **24** modelled detail fields" → **25**; L527–529 "models **25** fields — the detail stage's **24** plus card-only `badge` … PDP reports stay at **24**): **21 card-extractable**" → "models **26** fields — the detail stage's **25** (`isSponsored`, SAD-391) plus card-only `badge` … PDP reports stay at **25**): **22 card-extractable** fields and 4 card-inapplicable".
- **`docs/plans/SAD-391-implementation-record.md`** — append "## Integration into MergeBranch": base `36589c3`, the resolutions of §5 (incl. `visibleTextContent` superseded by `extractCleanElementText`), Phase A gate numbers, live-replay parity. Phase C adds the merge SHA line.
- `docs/plans/SAD-393-implementation-record.md` — **no change** (the first plan's note about the parse-cache repair is now covered by the SAD-392 verification report, which names `6723b04`/`3676dfc`/`f3ffda9`).

## 6. Phase A — merge `MergeBranch` into the feature branch

**Pre-flight (abort if either fails):** `git fetch origin`; `origin/MergeBranch == 36589c3`; `origin/fix/sad-391-prime-sponsored == 450a6a0`. If MergeBranch moved again, re-run the §3/§4 simulation before anything is pushed.

```bash
cd PPHunt && git switch fix/sad-391-prime-sponsored
# A0 — this document
cp <plan> docs/plans/SAD-391-merge-into-MergeBranch-plan.md
git add docs/plans/SAD-391-merge-into-MergeBranch-plan.md
git commit -m "docs(sad-391): plan for landing the fix on MergeBranch"
# A1 — the merge
git merge --no-ff --no-commit origin/MergeBranch     # 7 conflicts / 12 hunks (§3) — verified in this direction too
# resolve exactly as §5. Ready-made: copy the 13 drop-in files of Appendix B over the tree
#   cp -r <evidence>/merge2/resolved-files/. .
# (verified: after the copy the tree is byte-identical to the gated simulation of §4),
# then make the two ARCHITECTURE.md edits and append the record section (§5.6) by hand.
grep -rlE '^(<<<<<<<|=======|>>>>>>>) ' src tests docs CHANGELOG.md ARCHITECTURE.md   # must print nothing
git add -u && git add tests/sad-391-*.test.ts docs/plans          # never `git add -A` with a symlinked node_modules (see Appendix C)
git commit        # message below
```

**A1 commit message**
```
Merge MergeBranch into fix/sad-391-prime-sponsored

Brings SAD-387/388/389/390/392/393 and the parse-cache union repairs
(6723b04, 3676dfc, f3ffda9) under SAD-391 before landing.

Merge conflict resolutions:
- field-parsers.ts: SAD-390's extractCardDeliveryAndAvailability (with
  SAD-392's clean stock-span read) is kept whole; SAD-391's structural read of
  .udm-primary/secondary-delivery-message is grafted ahead of its whole-block
  fallback (signed-in cards: badge text never prefixes Delivery).
  visibleTextContent and its two patterns are retired in favour of
  extractCleanElementText.
- product-detail.ts: both helper blocks kept; SAD-390's two-pass delivery loop.
- Diagnostics universe is PDP 25 / card 26 (SAD-391 isSponsored + SAD-393
  card-only badge): pins and prose updated in 8 test files, card-diagnostics.ts,
  ARCHITECTURE.md.
- CHANGELOG: SAD-391 entry topmost above SAD-387/392/393; two bullets reworded
  for the merged tree.

Gate: tsc clean · dead-exports clean · vitest 144 files / 1681 tests ·
wxt build 2.06 MB · npm audit --omit=dev 0 · manifest sanity OK · live
/s?k=laptop replay identical to the branch (33 rows: Prime 12, Sponsored 17).
```

**Phase A gate (must reproduce §4):** `npx tsc --noEmit` · `npm run check:dead-exports` · `npx vitest run` (expect 144 files; 1681 passed or 1678 + 3 skipped; 0 failed) · `npx wxt build` · `npm audit --omit=dev` (0) · manifest sanity one-liner · live replay (`scripts/_tmp_table.mts`, 33 rows identical to the branch table; delete the script afterwards). Then:

```bash
git push https://x-access-token:$GITHUB_PAT@github.com/MakeTheNewHistory/PPHunt.git fix/sad-391-prime-sponsored
```
(`$GITHUB_PAT` supplied at run time; never written to git config, docs or logs.) CI does not run on this push (no PR on the branch); the local gate stands in, and CI runs on the Phase B push.

## 7. Phase B — land it on `MergeBranch`

```bash
git fetch origin && test "$(git rev-parse origin/MergeBranch)" = "$(git rev-parse 36589c3)"   # else: stop, re-simulate
git switch -c MergeBranch --track origin/MergeBranch     # or `git switch MergeBranch && git pull --ff-only`
git merge --no-ff fix/sad-391-prime-sponsored \
  -m "Merge fix/sad-391-prime-sponsored (SAD-391 Prime and Sponsored fields) into MergeBranch"
git push https://x-access-token:$GITHUB_PAT@github.com/MakeTheNewHistory/PPHunt.git MergeBranch
```
Conflict-free by construction (the feature branch contains `36589c3` after Phase A) — proven in §4: no conflicts, merged tree byte-identical to the Phase A tree.

**Post-push checks**
| Check | Expectation |
|---|---|
| `git log --oneline -1 origin/MergeBranch` | the merge commit; parents `36589c3` + Phase A tip |
| `git diff --stat 36589c3 origin/MergeBranch` | 34 files, +2579 / −94 (+ the plan doc from A0) |
| `git branch -r --contains 450a6a0` | includes `origin/MergeBranch` |
| CI run on `MergeBranch` | typecheck, dead-exports, test, build, both audits, manifest sanity — green |
| `origin/main` | unchanged at `2ec7eaf` |

## 8. Phase C — record the merge

Small docs commit **on `MergeBranch`**, following `c379da6` / `36589c3`: append to `docs/plans/SAD-391-implementation-record.md` a "Merge record (landed on MergeBranch)" block — merge SHA, head before (`36589c3`), Phase A SHA, tests/files, build size, audit, CI run URL — commit `docs(sad-391): record the MergeBranch merge SHA and gate numbers`, push. Then a Linear comment on SAD-391 with the same numbers; **state stays In Review** (the manual browser matrix from the SAD-391 record is still open).

## 9. Rollback
- After Phase A only: nothing on MergeBranch changed; `git push --force-with-lease origin 450a6a0:fix/sad-391-prime-sponsored` restores the branch tip.
- After Phase B: `git revert -m 1 <merge sha>` on MergeBranch (preferred — history stays linear-append like the other integrations); a force-push back to `36589c3` only if done immediately and no one has fetched.

## 10. Risks
- **MergeBranch moves again** before execution — the pre-flight in §6/§7 catches it; a re-simulation takes ~10 minutes with the Appendix B artifacts.
- **Signed-in Prime card delivery string** ("One-Day" exclusion) rests on the real 2025 UDM sample, not on an operator capture — same caveat as SAD-391 itself; logged-out behaviour is byte-identical to SAD-390.
- **Test-count nondeterminism** (3 manifest tests, §4) could confuse a strict numeric gate; the pass/fail criterion is 0 failed.
- SAD-391's **manual browser matrix** remains not run (hence *In Review*).

## 11. Out of scope / deliberately not done
No change to `main`; no rebase or rewrite of the SAD-391 commits; no squash; no change to the open PRs (#1–#7); no new behaviour beyond the one UDM message-row read that SAD-391 already shipped in another form; no change to `parse-cache.ts`.

---

## Appendix A — per-hunk recipe (sides as seen from the feature branch in Phase A: *ours* = SAD-391, *theirs* = MergeBranch)
| File | Hunk | Take |
|---|---|---|
| `CHANGELOG.md` | 1 | both stacks; SAD-391 section first, then SAD-387, SAD-392, SAD-393; §5.6 rewording |
| `card-diagnostics.ts` | 1 | merged comment (§5.2) |
| `field-parsers.ts` | 1 | theirs (`DELIVERY_KEYWORD_RE`); drop ours (`visibleTextContent` + 2 patterns) |
| `field-parsers.ts` | 2–3 | theirs, whole function; then the §5.3 graft |
| `product-detail.ts` | 1 | both import sets minus `visibleTextContent` |
| `product-detail.ts` | 2 | both helper blocks + the missing `}` and blank line |
| `product-detail.ts` | 3 | theirs (SAD-390 loop) |
| `tests/card-diagnostics.test.ts` | 1–2 | merged comments (26 = 25 + badge) |
| `tests/collection-diagnostics-e2e.test.tsx` | 1 | 25 (PDP) with merged comment |
| `tests/sad-386-diagnostics.test.ts` | 1 | title "26 fields …"; `expected = 26` two lines below |
Then §5.5 pins and §5.6 docs.

## Appendix B — evidence (workspace, not committed) — `/home/user/sad391-evidence/merge2/`
`mergebranch-36589c3-baseline-vitest.log` / `-build.log` (§1) · `trial2-vitest.log`, `trial2-build.log`, `trial2-dead-audit-manifest.log` (§4) · `table-trial2.txt` (live replay; identical to `../table-branch.txt`) · **`resolved-files/`** — the 13 files that differ from git's auto-merge, as complete drop-ins (`CHANGELOG.md`, `card-diagnostics.ts`, `field-parsers.ts`, `product-detail.ts`, 9 test files); copying them over the conflicted Phase A tree reproduces the gated tree byte-for-byte (verified in the true feature←MergeBranch direction) · `resolution2.patch` (730 lines; the same edits as a diff, but it only applies in the MergeBranch←feature direction because conflict markers swap sides) · `full-merge2-vs-36589c3.diff` (34 files) · `field-parsers.resolved.ts`, `product-detail.resolved.ts`, `CHANGELOG.resolved.md` (copies for reading). The ARCHITECTURE edits and the record section (§5.6) are **not** in the drop-ins — they are text edits to make during Phase A. The earlier `../merge/` folder (against `dee5255`) is kept as history; superseded.

## Appendix C — two execution footguns observed while simulating
1. `.gitignore` has `node_modules/` (trailing slash): a **symlinked** `node_modules` in a worktree is *not* ignored, and `git add -A` stages the symlink. Use `git add -u` plus explicit paths, and check `git status --porcelain` before committing.
2. Worktrees created from the repo lose the repo-local git identity when the sandbox resets; pass `-c user.name=… -c user.email=…` or re-set it before committing.
