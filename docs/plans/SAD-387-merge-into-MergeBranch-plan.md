# SAD-387 → `MergeBranch` — Plan Only

> **Status: PLAN ONLY.** Nothing was merged, pushed, or changed on any branch.
> The only work done was investigation: fetching `MergeBranch`, a dry-run merge,
> and **one real merge simulation in a throw-away worktree** (`/tmp`, outside the
> repository) that resolved the conflicts and ran the full gate.
>
> Target branch: [`MergeBranch`](https://github.com/MakeTheNewHistory/PPHunt/tree/MergeBranch) — treated as the main branch, per instruction.
> Source: `fix/sad-387-deal-countdown` (`b358d63`).

---

## 0. Decisions (operator, this session)

| # | Question | Decision |
|---|---|---|
| **B1** | Merge sequencing | **Two-phase** — bring `MergeBranch` into the feature branch, gate, push; then `--no-ff` merge into `MergeBranch`. Same shape as SAD-386 and as `MergeBranch`'s own precedent (`9d043d7`). |
| **B2** | CI on `MergeBranch` | **Add `MergeBranch` to the triggers** in `.github/workflows/ci.yml`, so every future merge into it is verified. |
| **B3** | Linear after landing | **SAD-387 stays In Review**, and a docs commit records the merge SHA + gate numbers (precedent: `c379da6`). |
| **B4** | `main` | **Untouched.** `MergeBranch` is the integration branch; nothing is pushed to `main`. |

---

## 1. What the target branch actually is — measured

| Fact | Value |
|---|---|
| `MergeBranch` head | **`c379da6`** — *docs(sad-392): record the MergeBranch merge SHA and gate numbers* |
| `main` head | `2ec7eaf` |
| Does `MergeBranch` contain `main`'s tip? | **Yes** — `git log mb/MergeBranch..mb/main` is empty, so nothing on `main` is missing from it |
| Does it contain my branch's base (`7dc713d`)? | **Yes** |
| Does it already contain my work? | **No** — `git merge-base --is-ancestor fix/sad-387-deal-countdown` fails |
| Integration work already there | SAD-388, SAD-389, SAD-390, SAD-392, SAD-393 (+ the parse-cache union repairs `3676dfc`, `6723b04`) |

So this is **not** a merge into an older main: it is a merge into a *newer* branch
that already holds five tickets' worth of parser work touching the same files.

## 2. Conflict surface — measured, not guessed

Dry run (`git merge-tree`) and a real simulation both give **exactly two
conflicts**, both documentation:

```
CONFLICT (content): ARCHITECTURE.md
CONFLICT (content): CHANGELOG.md
Auto-merging src/engines/amazon/scraper/field-parsers.ts
Auto-merging src/engines/amazon/scraper/product-detail.ts
Auto-merging src/engines/amazon/ui/table/columns.tsx
Auto-merging src/engines/amazon/ui/table/AmazonProductTable.tsx
```

Four code files auto-merge, so the risk is a *silent* semantic loss, not a text
conflict. The simulation verified all seven call sites survive verbatim:

| File | Survives |
|---|---|
| `scraper/field-parsers.ts:1299, 1314` | card badge loop + ad `dealString` |
| `scraper/product-detail.ts:1190` | product-page badge loop |
| `scraper/deal-evidence.ts:142, 161, 184` | all three evidence-scan returns |
| `ui/table/columns.tsx:317` | cell / tooltip / expand modal |
| `ui/table/AmazonProductTable.tsx:174` | table search |
| `export/types.ts:65` | CSV/Excel/clipboard `Deal` |

## 3. Simulation result (the evidence this plan rests on)

Worktree at `c379da6`, merge performed for real, two doc conflicts resolved as in
§4, then the full gate:

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run check:dead-exports` | clean (42 files) |
| `npx wxt build` | OK, `dist` **2.05 MB** |
| `npx vitest run` | **1597 passed / 139 files** (138 passed + 1 skipped) |
| `tests/sad-387-deal-countdown.test.tsx` alone | 22 / 22 pass in the merged tree |

The single skipped file is **pre-existing on `MergeBranch`**, not caused by this
merge: `tests/temu-pdp-captures.test.ts:98` uses
`describe.skipIf(captures.length === 0)` (SAD-381 — needs real Temu PDP captures).

---

## 4. The conflict resolution, in full

Both conflicts are "two `[Unreleased]` sections at the top of one file". Resolution
is a **union that keeps every section from both sides** — no text is dropped.

### 4.1 `CHANGELOG.md`

Take `MergeBranch`'s file and insert this branch's section **above** the first
`## [Unreleased]` heading (newest ticket first, matching the file's order):

```
## [Unreleased] — The Deal field shows the page's own text (SAD-387)   ← inserted
## [Unreleased] — Availability holds the page's message; Source follows the PDP (SAD-392)
## [Unreleased] — Warranty and badge fields (SAD-393)
...
```

### 4.2 `ARCHITECTURE.md`

Take `MergeBranch`'s file and insert this branch's note
(`#### The Deal text comes from the page (SAD-387)`) immediately **above** the
existing `#### Deal and discount evidence (SAD-386)` section — the two describe the
same field family and must stay adjacent.

### 4.3 `tests/docs-consistency.test.ts`

No change required: it passed in the simulation with the union in place.

---

## 5. Phase A — rebase the base onto `MergeBranch` (on the feature branch)

```bash
cd PPHunt
git fetch origin MergeBranch
git switch fix/sad-387-deal-countdown
git merge --no-ff --no-commit origin/MergeBranch
# resolve exactly as §4.1 and §4.2
git add -A
git commit   # message per §5.1
```

### 5.1 Commit message (Phase A)

```
Merge MergeBranch into fix/sad-387-deal-countdown

Two documentation conflicts, both "two Unreleased sections at the top of one
file". Each is resolved as a union that keeps every section from both sides:
SAD-387's CHANGELOG entry goes above SAD-392/SAD-393, and its ARCHITECTURE note
goes directly above the SAD-386 note it complements. No prose is dropped.

The four code files (field-parsers, product-detail, columns, AmazonProductTable)
auto-merged; all seven sanitizeDealBadge / dealBadgeForDisplay call sites were
verified present after the merge, and the full suite runs 1597 tests / 139 files
with the SAD-387 file 22/22.
```

### 5.2 Docs accuracy in the same phase

The SAD-387 plan and verification report say the branch is *"from `main@7dc713d`"*.
After this merge that sentence is stale, so both get the one-line correction to
*"from `main@7dc713d`, merged with `MergeBranch@c379da6` before landing"*. No other
claim changes.

### 5.3 CI trigger change (B2)

`.github/workflows/ci.yml`, one line:

```yaml
on:
  push:
    branches: [main, MergeBranch]   # was: [main]
  pull_request:
```

Separate commit: `ci: verify pushes to MergeBranch`. Its effect is only observable
**after** the Phase B push (the workflow file must already exist on the branch being
pushed to), so it is validated by watching the run in Phase C.

### 5.4 Phase A gate (must match §3 exactly)

```bash
npx tsc --noEmit
npm run check:dead-exports
npx wxt build
npx vitest run                 # expect 139 files / 1597 tests
npm audit --omit=dev           # expect 0 vulnerabilities
node -e "const m=require('./dist/chrome-mv3/manifest.json'); if(!m.name||m.name==='manifest.json description')process.exit(1)"
git push origin fix/sad-387-deal-countdown
```

---

## 6. Phase B — land it on `MergeBranch`

```bash
git switch -c MergeBranch --track origin/MergeBranch   # or switch if local exists
git merge --no-ff fix/sad-387-deal-countdown \
  -m "Merge fix/sad-387-deal-countdown (SAD-387 deal countdown text) into MergeBranch"
git push origin MergeBranch
```

**Conflict-free by construction**: after Phase A the feature branch contains
`MergeBranch@c379da6`, so this merge is a fast-forwardable superset (proven in the
simulation). Message follows the branch's own convention:
`Merge fix/sad-392-availability-source (SAD-392 …) into MergeBranch`.

**Post-push checks**

| Check | Expectation |
|---|---|
| `git log --oneline -1 origin/MergeBranch` | the merge commit |
| `git branch -r --contains b358d63` | includes `origin/MergeBranch` |
| `git diff --stat c379da6 origin/MergeBranch` | only SAD-387's 14 files (+ the CI one-liner) |
| CI run on `MergeBranch` | **runs now** (B2) — typecheck, dead-exports, test, build, both audits, manifest sanity all green |
| `main` | unchanged at `2ec7eaf` (B4) |

---

## 7. Phase C — record the merge (B3)

Small docs commit **on `MergeBranch`**, following `c379da6`'s precedent:

- append to `docs/plans/SAD-387-verification-report.md` a "Merge record" row set:
  merge SHA, `MergeBranch` head before (`c379da6`), tests `1597 / 139`, build size,
  audit result, CI run URL;
- push;
- Linear comment on SAD-387 with the same numbers; **issue stays In Review**.

---

## 8. Per-step reporting (your standing workflow)

Each phase ends with a push **and** a Linear comment:

| Step | Push | Linear |
|---|---|---|
| A | feature branch | comment: conflicts + resolution + Phase A gate numbers |
| B | `MergeBranch` | comment: merge SHA + CI run link |
| C | `MergeBranch` | comment: merge recorded, gate numbers, "stays In Review" |

---

## 9. Rollback

| Situation | Action |
|---|---|
| Wrong before Phase B push | `git merge --abort` / `git reset --hard c379da6` locally |
| Wrong after Phase B push | `git revert -m 1 <merge-sha>` on `MergeBranch` — never a force-push |
| Only the CI trigger is unwanted | revert that single commit (`.github/workflows/ci.yml`) |
| Only SAD-387 is unwanted | revert the merge commit; `main` is unaffected (it never received it) |

The feature branch is **kept** after landing (SAD-387 stays In Review).

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| An auto-merged code file silently loses a call site | Low — **verified in simulation**: all 7 present, 22/22 of the ticket's tests pass in the merged tree | re-verify with `grep -rn "sanitizeDealBadge\|dealBadgeForDisplay" src/` after the real merge, not just the tests |
| A MergeBranch ticket pins deal text that my rule would alter | Very low — the whole suite is green in the merged tree, including SAD-393's badge work | if Phase A fails, the failing test names the conflict; fix before pushing, never after |
| CI trigger change breaks other workflows | Low — additive to `branches:` only | validated by the Phase C CI run; revert is one commit |
| Double CI cost (every MergeBranch push now runs the suite) | Certain, and intended (B2) | that is the point of the decision |
| `main` drifts further from `MergeBranch` | Known (B4) | out of scope by decision; `main` is not the integration branch any more |
| Docs claim a stale base | Certain if unaddressed | §5.2 corrects it in Phase A; §7 records the merge SHA in Phase C |

---

## 11. Out of scope

- No change to `main`, no force-push, no tag, no branch deletion.
- No product/behaviour change: this ticket's code already landed on the feature
  branch; the merge moves it, it does not modify it.
- No new tests beyond what exists, except nothing — the merge adds **no** new test
  code; it proves the existing ones still pass on the merged tree.
- No Temu change (the merge touches no `engines/temu/**` file).
