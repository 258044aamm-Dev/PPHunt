# SAD-381 — Plan only: merging `feat/temu-engine` into `main`

> **Status: PLAN ONLY. Nothing has been merged, committed, or pushed.**
> The work in this document was investigation: fetch `origin`, run the merge for real in a
> throw-away worktree (`/tmp/m381`, outside the repository), resolve the single conflict, run
> every gate, and measure a second clean worktree at `origin/main` as the baseline.
> `feat/temu-engine` is still at `e4731d4`; `main` has not moved.

Date: 2026-10-21 · Branch `feat/temu-engine` = `e4731d4` · `origin/main` = `7dc713d` · merge base `fbab2bd`

---

## 0. Decisions (operator, this session)

| # | Question | Decision |
|---|---|---|
| **M1** | Scope — the branch carries SAD-380 *and* SAD-381 | **Merge the whole branch.** Both tickets land; SAD-380 is the base SAD-381 was built on. |
| **M2** | Strategy | **`--no-ff` merge commit, pushed straight to `main`** (repo precedent: `e1729fa` for SAD-360, `fcb9794` for SAD-386). |
| **M3** | The open live-capture gate on SAD-381 | **Merge now.** The checklist stays open on the ticket; it is not silently closed. |
| **M4** | After the merge | **SAD-380 → Done · SAD-381 stays In Review · branch kept.** |

---

## 1. What is actually being merged (measured, not assumed)

`git log --oneline origin/main..feat/temu-engine` → **12 commits**, in two stacked tickets:

| Ticket | Commits | What it does |
|---|---|---|
| **SAD-380** (Temu `listPrice`) | 5 — `08cdc76`, `3032825`, `ef4403a`, `e31649d`, `127cd9e` | Live capture, failing-first fixtures, the candidate pool + `> price` rule, `srOnly` segments, struck-leaf fallback, PDP two-scope search, verification record |
| **SAD-381** (Temu `features` / `description`) | 7 — `9c01c0f` … `e4731d4` | Plan + capture tool, `pdp-details.ts`, parser wiring + diagnostics, opt-in expand setting, capture replay harness, CHANGELOG |

`origin/main` is **31 commits ahead** of the merge base — SAD-383, SAD-384, SAD-385, SAD-386
and two merge commits. Local `main` in this workspace is **stale at `a10e174`** and must be
fast-forwarded before Phase B.

**File overlap between the two sides is exactly one file.** `main` touched **zero** files
under `src/engines/temu/`, `tests/*temu*` or `scripts/temu-dom-capture.js`:

```
$ git diff --name-only fbab2bd origin/main | grep -i temu
NONE
$ comm -12 <(branch files) <(main files)
CHANGELOG.md
```

That is why the risk here is a documentation-ordering conflict, not a code collision — the
opposite of SAD-386, where `parse-cache.ts` was a genuine design collision.

---

## 2. Dry run

`git merge-tree --write-tree origin/main feat/temu-engine` (read-only), then a real
`git merge --no-ff --no-commit feat/temu-engine` inside `/tmp/m381`:

```
Auto-merging CHANGELOG.md
CONFLICT (content): Merge conflict in CHANGELOG.md
```

**One conflict, one file, documentation only.** All 25 other files auto-merge.

The merge adds up to **26 files, +4497 / −123**, with no file under `src/engines/amazon`,
no manifest, no `package.json`, no permission and no schema change:

```
A  src/engines/temu/scraper/pdp-details.ts          M  src/engines/temu/scraper/product-detail.ts
M  src/engines/temu/scraper/field-parsers.ts        M  src/engines/temu/scraper/selectors.ts
M  src/engines/temu/types/index.ts                  M  src/engines/temu/schemas/{settings,messages}.ts
M  src/engines/temu/constants/defaults.ts           M  src/engines/temu/ui/components/SettingsOverlay.tsx
M  src/engines/temu/background/handler.ts           M  src/entrypoints/temu.content.ts
A  scripts/temu-dom-capture.js                      M  CHANGELOG.md
A  tests/temu-pdp-details.test.ts  A  tests/temu-expand-details.test.ts
A  tests/temu-listprice-sad380.test.ts  A  tests/temu-pdp-captures.test.ts
M  tests/temu-diagnostics-pdp.test.ts  M  tests/temu-scraper.test.ts  M  tests/fixtures/temu-pdp-fixtures.ts
A  docs/plans/{SAD-380,SAD-381}-*.md, docs/plans/sad-380-live-2026-10-21.json, tests/fixtures/temu-live/README.md
```

---

## 3. The conflict, and its exact resolution

### 3.1 What collided

Both sides prepended `## [Unreleased]` sections at the top of `CHANGELOG.md`:

| Side | Sections at the top |
|---|---|
| `origin/main` | SAD-386, SAD-385, SAD-384, SAD-383, SAD-379 |
| `feat/temu-engine` | SAD-381, SAD-380 |

### 3.2 Resolution — union, nothing deleted

The branch block goes above `main`'s block (each merge prepends its own new entries; this is
what the SAD-386 plan did, and it keeps the file's newest-first shape). Every section from
both sides is preserved verbatim — no bullet is rewritten and no numbering is changed.

Resolved order (17 `## ` sections):

```
SAD-381 · SAD-380 · SAD-386 · SAD-385 · SAD-384 · SAD-383 · SAD-379 · SAD-378 ·
SAD-369 · SAD-360 · SAD-359 · …
```

Verified programmatically against both parents:

| Check | Result |
|---|---|
| Conflict markers left | **0** |
| Sections in `main` that are missing from the result | **none** (15/15) |
| Sections in the branch missing from the result | **none** (12/12) |
| Duplicate headings | **none** |
| Order = branch block, then `main`'s block unchanged | **true** |

This is a documentation ordering choice only. `tests/docs-consistency.test.ts` asserts
specific strings, not section order, and it passes on the resolved file (§4).

---

## 4. Gates, measured on the resolved merge

Run inside `/tmp/m381` (merge applied, conflict resolved, **not committed**), in CI's order:

| Gate | Command | Result |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npx tsc --noEmit` | **clean** |
| Dead exports | `npm run check:dead-exports` | clean, 42 files scanned |
| Build | `npx wxt build` | **2.03 MB**, exit 0 |
| Tests | `npx vitest run` | **127 passed + 1 skipped = 128 files, 1418 tests, 0 failures** |
| Audit | `npm audit --omit=dev` | **0 vulnerabilities** |

**The numbers reconcile exactly** — this is the proof that nothing was dropped:

| | Files | Tests |
|---|---|---|
| `origin/main` in a second clean worktree | 124 | 1360 |
| + `tests/temu-pdp-details.test.ts` | +1 | 34 |
| + `tests/temu-expand-details.test.ts` | +1 | 5 |
| + `tests/temu-listprice-sad380.test.ts` | +1 | 14 |
| + `tests/temu-diagnostics-pdp.test.ts` (SAD-381 rules) | — | 5 |
| + `tests/temu-pdp-captures.test.ts` (skips: no captures) | +1 | 0 |
| **Merged result** | **128** | **1418** |

`1360 + 58 = 1418`; `124 + 4 = 128`. No file lost tests, no test changed its verdict.

---

## 5. Execution (two phases, `--no-ff`, direct push)

### Phase A — merge `main` into the branch (one commit)

```bash
cd PPHunt
git remote add origin https://github.com/MakeTheNewHistory/PPHunt.git   # if config was wiped
git fetch origin --prune
git switch feat/temu-engine
git merge --no-ff --no-commit origin/main        # stops on CHANGELOG.md only
# resolve: union, branch block then main's block, as §3.2
git add -A
git commit -m "SAD-381 step 6: merge main and take both sides of the changelog"
git push origin feat/temu-engine
```

Commit body records: the single conflict was `CHANGELOG.md`; both sides kept; no source file
needed a manual merge because `main` touched no Temu file since `fbab2bd`; the gate numbers
above.

**This step is skippable in principle** (Phase B merges the same two trees), but doing it
makes Phase B conflict-free by construction and puts the resolved, green tree on the remote
where CI can see it. Repo precedent is to do it.

### Phase B — land it on `main`

```bash
git switch main
git merge --ff-only origin/main                  # local main is stale at a10e174
git merge --no-ff feat/temu-engine \
  -m "Merge branch 'feat/temu-engine' — SAD-380 list price and SAD-381 features & description"
git push origin main
```

After Phase A the branch already contains `main`, so this merge **cannot conflict**.

**Gate before `git push origin main`** — re-run on `main` itself, because `main` could have
moved since §4:

```bash
npx tsc --noEmit && npm run check:dead-exports && npx wxt build && npx vitest run && npm audit --omit=dev
```

Expected: identical to §4 (128 files / 1418 tests). If `origin/main` moved, re-fetch and
repeat Phase A first.

---

## 6. Post-push checks

| Check | How | Expect |
|---|---|---|
| CI on `main` | `.github/workflows/ci.yml` runs on push to `main` | green — CI runs the same five commands measured in §4 |
| The work is on `main` | `git log --oneline -1 origin/main` | the merge commit |
| Both tickets are ancestors | `git branch -r --contains e4731d4` | includes `origin/main` |
| Nothing else changed | `git diff --stat 7dc713d origin/main` | only the 26 files in §2 |
| Branch still exists | `git ls-remote --heads origin feat/temu-engine` | present (M4) |

---

## 7. Rollback

| Situation | Action |
|---|---|
| Wrong before push | `git merge --abort` (Phase A) / `git reset --hard 7dc713d` (Phase B, local only) |
| Wrong after push | `git revert -m 1 <merge-sha>` and push — a revert commit, **never** a force-push of `main` |
| Only SAD-381 is wrong | revert its merge is not separable (one merge commit); fix forward on a new branch |
| CI fails after push | fix forward on a new branch and merge again; `main` stays deployable because the merge is one revertable commit |

No tag, no force-push, no history rewrite, no branch deletion.

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `main` moves again between Phase A and B | Medium | re-fetch and re-run the gate on `main`; the merge is repeatable |
| CI disagrees with local (Node 22 in CI vs 20 here) | Low | `wxt@0.21.4` declares `engines.node >= 22`; local runs were still green, CI has been green on this repo since `8d04f92` |
| The changelog union reads as two "newest" blocks | Low, cosmetic | branch block first matches how SAD-386 landed; flipping it is a one-line reorder of two blocks with no test impact |
| The skipped capture suite is mistaken for a failure | Low | it prints `[SAD-381] no live captures in …` and reports `1 skipped`, not `1 failed` |
| Someone treats the merge as closing SAD-381's live gate | **Medium** | M3 + the Linear comment in §9 state explicitly that it does not |

---

## 9. After the merge (per M4)

1. **SAD-380 → Done** (state id `20caf607-4362-400c-a2bd-394fae1a81d0`) — it has no open item.
2. **SAD-381 stays In Review.** Its live-page gate is still open; the merge does not close it.
3. **One Linear comment on SAD-381** recording: merge commit SHA, branch SHA `e4731d4`, the
   Phase A commit, the conflict (`CHANGELOG.md`, union), and the measured numbers
   (128 files / 1418 tests, 0 vulnerabilities, `main` baseline 124/1360).
4. **Branch kept** on the remote.
5. **Open item carried forward, unchanged by this merge:** one real Temu PDP capture →
   `tests/fixtures/temu-live/` → `npx vitest run tests/temu-pdp-captures.test.ts`, then §5 of
   `docs/plans/SAD-381-step4-verification.md`.

---

## 10. Out of scope for this merge

- **No source change.** The only line of code touched in either phase is the `CHANGELOG.md`
  layout; every `src/**` file arrives exactly as reviewed on the branch.
- No version bump (`package.json` stays `1.0.0`; changes live under `[Unreleased]`).
- No manifest, dependency, permission, schema or database change.
- No Amazon file is touched (`git diff 7dc713d <merge> -- src/engines/amazon` must be empty).
- No lint/format sweep, no refactor, no doc rewrite beyond the changelog union.
- No force-push, no tag, no branch deletion.

---

## 11. Environment notes for whoever executes this

- `node_modules/` is **not** in the workspace snapshot — `npm ci` first (606 packages).
- The git remote **does not survive** a snapshot; re-add `origin` with the PAT before pushing.
- `npx vitest run` must come **after** `npx wxt build`, because
  `tests/manifest-permissions.test.ts` reads `dist/chrome-mv3/manifest.json`.
- This document is intentionally **uncommitted**. On execution it can either be included in
  the Phase A merge commit or left untracked — say which.
