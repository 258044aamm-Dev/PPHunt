# SAD-386 — Plan Only: merging `feat/sad-386-deal-discount` into `main`

> **Status: PLAN ONLY. Nothing has been merged, pushed, or force-updated.**
> The only work done for this document was *investigation*: fetching `main`,
> running a dry-run merge, and building three candidate resolutions in a
> throw-away worktree (`/tmp`, outside the repository) to measure them.
> The branch `feat/sad-386-deal-discount` is still at `4210c36`; the workspace is
> dirty only with this file.

---

## 0. Decisions taken (operator, 2026-10-21)

| # | Question | Decision |
|---|---|---|
| **M1** | How to resolve the `parse-cache.ts` collision with SAD-383 | **Option C** — keep SAD-383's mechanism, add one condition (§3) |
| **M2** | Merge strategy | **`--no-ff` merge commit** (repo precedent) |
| **M3** | Delivery | **Merge and push straight to `main`** (no PR) |
| **M4** | After merge | **Keep the branch, leave SAD-386 In Review** (no Done, no branch delete) |

---

## 1. What changed under our feet — measured, not assumed

`main` moved while the branch was being built. Local `main` in this workspace is
still at the branch base `a10e174`; **remote `main` is `a7a3592`**, 20 commits
ahead, including three merged tickets:

| Commit | What it did | Why it matters here |
|---|---|---|
| `d66e7ae` SAD-383 step 1 | **"stop freezing a card before its reviews row exists"** — `parse-cache.ts` gained a DOM-signature invalidation | Directly overlaps SAD-386 step 4 (which rewrote the same file with a 2 s TTL) |
| `0be9eb1` SAD-383 step 2 | diagnostics see rating/review-count nodes — `card-diagnostics.ts`, `field-parsers.ts` | Same files SAD-386 step 5 touches (auto-merged cleanly) |
| `76b8fe1`/`6ff9a4e` SAD-385 | collection always enriches; enrichment tail reconciliation | Needs the same enrichment path SAD-386's workflow-parity test exercises |
| `8d04f92` | manifest test reads the built manifest in a hook | Explains why CI is green without a local build-first dance |

**Dry-run merge (git merge-tree, no working tree touched):** exactly **two
conflicts**

```
CONFLICT (content): CHANGELOG.md
CONFLICT (content): src/engines/amazon/scraper/parse-cache.ts
Auto-merging ARCHITECTURE.md
Auto-merging src/engines/amazon/scraper/card-diagnostics.ts
Auto-merging src/engines/amazon/scraper/field-parsers.ts
Auto-merging src/engines/amazon/scraper/product-detail.ts
```

`CHANGELOG.md` is a trivial two-"Unreleased" ordering conflict. **`parse-cache.ts`
is a design collision**: both tickets fixed "a card is frozen before Amazon
injects a late row", with different mechanisms.

---

## 2. The three resolutions, measured against current `main`

Each variant was applied in a throw-away worktree at `a7a3592`, with the merge
performed for real, then `tsc` + `wxt build` + full `vitest` run.

| Variant | Mechanism | Result |
|---|---|---|
| **A** — keep the branch's TTL, drop SAD-383's signature | 2 s expiry | **FAILED 4** — 3 × SAD-383 cache tests + **`H-9a: parse budget on a large page`** (`warm < cold/4`): on a slow 480-card page the TTL expires during the cold pass, so the "warm" pass re-parsed every card |
| **B** — widen SAD-383's settle rule ("settled" also needs a price-family value) | signature + wider settle | **FAILED 1** — SAD-383's explicit guarantee test *"a DOM change must not rewrite values the user was already shown"*; most cards legitimately have no discount, so they became permanently re-readable |
| **C** — keep SAD-383's rule, add "only re-read when price-family evidence appeared" | signature + one condition | **PASSED** — `tsc` clean, build 2.02 MB, **1360 tests / 124 files**, `check:dead-exports` clean, `npm audit --omit=dev` 0 vulnerabilities. **Zero existing tests changed** |

Variant A is refuted by the repo's own performance contract, variant B amends
another ticket's guarantee, variant C touches neither. **C is the plan.**

---

## 3. The conflict resolution, in full

### 3.1 `src/engines/amazon/scraper/parse-cache.ts` — take `main`'s file, add one block

The branch's TTL (`DEFAULT_PARSE_CACHE_TTL_MS`, `now`, `ttlMs`) is **dropped**.
Everything SAD-383 added is kept verbatim. Three additions:

```ts
import { DEAL_LABEL_PATTERN } from './deal-evidence';   // new import

/** SAD-386: does the stored product already carry any price-family value? */
function hasBadgeFamilyFields(product: ScrapedAmazonProduct): boolean {
  return Boolean(
    product.discountPercentage ||
      product.dealBadge ||
      (product.listPrice !== null && product.listPrice !== undefined),
  );
}

/** SAD-386: does the card's text show price-family evidence at all? */
function showsPriceFamilyEvidence(element: Element): boolean {
  const text = element.textContent ?? '';
  return text.includes('%') || DEAL_LABEL_PATTERN.test(text);
}
```

and in `getOrParse`, the branch's single rule becomes three ordered checks:

```ts
const entry = this.cache.get(element);
if (entry) {
  if (hasBadgeFamilyFields(entry.product)) return entry.product;      // SAD-386: nothing left to gain
  if (this.signatureOf(element) === entry.signature) return entry.product;  // SAD-383: unchanged → never re-read
  if (hasRatingFields(entry.product) && !showsPriceFamilyEvidence(element)) {
    return entry.product;   // SAD-383's guarantee still holds
  }
}
```

Everything else in the file — `isComplete`, `signatureOf`, `get`, `set`,
`clear`, the exports — is byte-identical to `main`. The full final file (verified
compiling and green) is the version measured in §2, variant C.

### 3.2 `CHANGELOG.md` — union, newest ticket first

`main`'s head is `## [Unreleased] — Weights and variations in Collection Mode (SAD-385)`.
The branch's SAD-386 section is inserted **above** it (newest first, matching the
file's existing order), and its cache bullet is rewritten from "2 s TTL" to the
signature rule. No SAD-385 text is removed:

```
## [Unreleased] — Deal and discount extraction (SAD-386)      ← branch, amended
## [Unreleased] — Weights and variations in Collection Mode (SAD-385)
## [Unreleased] — Collection enrichment (SAD-379)
```

### 3.3 `tests/sad-386-cache-freshness.test.ts` — rewritten to the merged semantics

The TTL assertions are gone (a TTL no longer exists). The file keeps four cases:
late badge picked up on DOM change (through `parseAmazonSearchResults`), zero
extra work for an unchanged unsettled card (counting parser), a settled card
never re-parsed even when the DOM changes, and an incomplete card still
re-parsing. All four pass against variant C.

### 3.4 Documents that must stop claiming a TTL

| File | Edit |
|---|---|
| `ARCHITECTURE.md` | the SAD-386 paragraph's TTL sentence → the signature rule (text drafted) |
| `docs/plans/SAD-386-deal-discount-plan.md` | §0 **D6** answered "TTL" → add the amendment note (repo precedent: SAD-383 step 5 amended the SAD-379 claim) |
| `docs/plans/SAD-386-verification-report.md` | cache row, step-4 description and the gate numbers (1267/112 → 1360/124) |

---

## 4. Phase A — bring `main` into the branch (one commit)

```bash
cd PPHunt
git fetch origin main
git switch feat/sad-386-deal-discount
git merge --no-commit origin/main          # stops on the two conflicts
# resolve exactly as §3.1-§3.3
git add -A
git commit -m "SAD-386 step 7: merge main and reconcile the parse cache with SAD-383"
```

Commit body must record: that a TTL was tried and measured to break the 480-card
budget, that SAD-383's guarantee is preserved, and that SAD-383's tests are
unchanged.

**Gate before pushing** (order matters — the manifest suites read `dist/`):

```bash
npx tsc --noEmit
npm run check:dead-exports
npx wxt build
npx vitest run            # expect 124 files / 1360 tests
npm audit --omit=dev      # expect 0 vulnerabilities
git push origin feat/sad-386-deal-discount
```

Expected: everything green, exactly as measured in §2 variant C.

## 5. Phase B — land it on `main` (merge commit, direct push)

```bash
git switch main
git merge --ff-only origin/main                        # local main is stale at a10e174
git merge --no-ff feat/sad-386-deal-discount \
  -m "Merge branch 'feat/sad-386-deal-discount' — SAD-386 deal and discount extraction"
git push origin main
```

After Phase A the branch already contains `main`, so this merge is
**conflict-free by construction** (proven in the §2 simulation) and does not
rewrite history. The `--no-ff` flag keeps the seven step commits visible, matching
`Merge branch 'feat/temu-engine' — SAD-360 …` and `Merge SAD-384: …`.

**Post-push checks**

| Check | How |
|---|---|
| CI on `main` | `.github/workflows/ci.yml` triggers on push to `main`: tsc → dead-exports → vitest → wxt build → audit → manifest sanity. Expect green (the same commands were run locally, and `8d04f92` fixed the manifest read in CI). |
| `main` contains the work | `git log --oneline -1 origin/main` = the merge commit; `git branch --contains 4210c36 -r` includes `origin/main` |
| Nothing else moved | `git diff --stat a7a3592 origin/main` shows only SAD-386 files |

---

## 6. Rollback

| Situation | Action |
|---|---|
| Merge is wrong before push | `git merge --abort` (Phase A) / `git reset --hard a7a3592` (Phase B, local only) |
| Merge is wrong after push | `git revert -m 1 <merge-sha>` and push — a revert commit, never a force-push of `main` |
| Only the cache rule is wrong | revert `parse-cache.ts` to `main`'s version in one commit; the rest of SAD-386 is independent |
| CI fails after push | fix forward on a new branch and merge again; `main` stays deployable because the merge is a single revertable commit |

The feature branch is **kept** (M4), so every step is re-readable from the remote.

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The signature rule re-reads a card whose badge text uses a locale word absent from `DEAL_LABEL_PATTERN` | Low | the pattern already covers `angebot/offre/oferta`; a bare `%` covers percentages; a missed locale word only costs a badge, never a wrong value |
| `showsPriceFamilyEvidence` runs per unsettled card on DOM change | Low | it is one `textContent` read plus a regex, only after the signature already changed |
| The `ARCHITECTURE.md` auto-merge leaves a TTL sentence behind | Medium | §3.4 lists it explicitly; `tests/docs-consistency.test.ts` runs in the gate |
| `main` moves again before Phase B | Medium | re-fetch and re-run the gate on `main` after the merge commit; the merge is then repeated on the newer base |
| Someone re-adds a TTL later | Low | `sad-386-cache-freshness.test.ts` pins the signature semantics; the CHANGELOG records why the TTL was rejected |

---

## 8. After the merge (per M4)

1. **SAD-386 stays In Review**; the branch stays on the remote.
2. One Linear comment recording: merge commit SHA, branch SHA, the Phase A commit,
   the conflict resolution (C) and the measured numbers (1360/124, 0 vulnerabilities),
   plus the note that SAD-383's tests were not changed.
3. **Open item carried forward** (unchanged by this merge): `scripts/sad-386-capture.mjs`
   still needs a real browser, because Amazon answers this sandbox with HTTP 503. Until
   it runs, the `detail.dealBadge` / `detail.discount` registry keys stay unshipped —
   the vocabulary + evidence fallbacks already cover those pages without them.

## 9. Out of scope for this merge

- No version bump (`package.json` stays `1.0.0`; the repo records changes in
  `CHANGELOG.md` under `[Unreleased]`).
- No change to `wxt.config.ts`, the manifest, permissions, schemas, DB, UI or exports.
- No Temu file is touched by any phase.
- No force-push, no tag, no branch deletion, no rewrite of `main`'s history.
