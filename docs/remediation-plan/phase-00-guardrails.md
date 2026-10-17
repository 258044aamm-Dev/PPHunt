# Phase 0 — Guardrails & Baseline

**Issues addressed:** the process root cause (no CI, no lint, no typecheck enforcement) · part of L‑3
**Estimated effort:** Small · **Prerequisites:** none · **Blocks:** every other phase

---

## Step 0.1 — Establish the CI gate

### Objective
Make it impossible for a red typecheck, a failing test, a broken build or a vulnerable dependency to
land on `main` again. This is the process root cause behind the entire investigation: 71 tests passed
and the build succeeded while 111 type errors and a currency-corruption bug shipped unnoticed.

### Root Cause
No `.github/` directory exists in the repository. No ESLint or Prettier config. No pre-commit hook.
`npm run compile` (`tsc --noEmit`) exists as a script but nothing invokes it automatically, and
`wxt build` uses esbuild, which strips types without checking them — so a successful build gives a
false signal of health.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `.github/workflows/ci.yml` | **create** | Runs install → typecheck → test → build → audit on push and PR |
| `package.json` | modify | Add a single `verify` script mirroring the CI pipeline; fix identity fields |

### Implementation Details

`.github/workflows/ci.yml` — four jobs in one workflow, sequential within a single job so they share
the install cache:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }   # wxt@0.21.4 declares engines.node >= 22
      - run: npm ci
      - name: Typecheck
        run: npx tsc --noEmit
        continue-on-error: true                  # ← non-blocking until Phase 7; flipped there
      - name: Test
        run: npx vitest run
      - name: Build
        run: npx wxt build
      - name: Audit (production deps)
        run: npm audit --omit=dev
        continue-on-error: true                  # ← non-blocking until Phase 8; flipped there
      - name: Manifest sanity
        run: node -e "const m=require('./dist/chrome-mv3/manifest.json');
                      if(!m.name||m.name==='manifest.json description')process.exit(1)"
```

Two notes on the shape of this:
- **Node 22, not 20.** `npm install` currently emits `EBADENGINE` warnings because `wxt@0.21.4`
  requires Node ≥ 22 while the sandbox has 20.20.2. CI should use the version the dependency
  declares; the local sandbox staying on 20 is a known, tolerated deviation and is recorded in
  Phase 11.
- **`continue-on-error` on exactly two steps**, with a comment naming the phase that removes it.
  This is deliberate: adding a blocking typecheck today would make CI red from commit one and
  provide no signal. The ratchet is "errors may never increase", tracked in each phase's
  verification section.

`package.json`:
```jsonc
{
  "name": "pphunt",                       // was "wxt-react-starter"
  "version": "0.1.0",                     // was "0.0.0"
  "description": "Amazon product research scraper — collect, preview and export product data from Amazon search, category and detail pages.",
  "scripts": {
    "verify": "tsc --noEmit; vitest run && wxt build && npm audit --omit=dev",
    // ... existing scripts unchanged
  }
}
```
`verify` uses `;` after `tsc` (not `&&`) so it mirrors CI's current warn-only posture; Phase 7
changes it to `&&`. The `name`/`version`/`description` fixes are pulled forward from Phase 10
because `wxt.config.ts` reads the description into the generated manifest — the "Manifest sanity"
CI step above asserts this, so the two must land together.

### Dependencies and Order
First step of the first phase. Nothing depends on it functionally, but every subsequent phase's
verification relies on it existing.

### Testing and Verification
1. `npm run verify` locally reproduces the CI pipeline and reports the known state:
   typecheck fails with 111 errors, tests pass 71/71, build succeeds, audit reports 1 high.
2. `npx wxt build && node -e "..."` — the manifest sanity check passes.
3. Push to a branch and confirm the workflow runs and the two `continue-on-error` steps are
   annotated as warnings rather than failures.
4. **Regression:** none possible — no application source is touched.

---

## Step 0.2 — Remove statically unreachable components

### Objective
Delete three components with zero live references. One of them (`OverlayDrawer.tsx`, 219 lines) is a
**second, conflicting implementation of the overlay feature** that duplicates `Navigation`,
`ErrorModal` and `SettingsOverlay`, and is a maintenance trap for anyone reading the codebase during
the remaining phases.

### Root Cause
`OverlayDrawer.tsx` predates the iframe-based overlay in `src/lib/overlay/overlayHost.ts` (SAD‑138)
and was never deleted. `ProductsTab.tsx` and `CollectionsTab.tsx` predate the navigation reduction
to two tabs (SAD‑136). `OverlayDrawer` also uses bare `chrome.*` globals instead of WXT's `browser`
import, which is why it contributes 3 of the 111 type errors.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/components/OverlayDrawer.tsx` | **remove** | 219 lines, 0 imports |
| `src/entrypoints/sidepanel/components/ProductsTab.tsx` | **remove** | 13 lines, 0 imports |
| `src/entrypoints/sidepanel/components/CollectionsTab.tsx` | **remove** | 36 lines, imported only by `App.tsx` |
| `src/entrypoints/sidepanel/App.tsx` | modify | Drop the `CollectionsTab` import (line 6) and the unreachable `default:` branch (line 98) |

### Implementation Details

Verified reachability before deletion:

```
$ grep -rn "OverlayDrawer" src tests      → only its own definition
$ grep -rn "ProductsTab"    src tests     → only its own definition
$ grep -rn "CollectionsTab" src tests     → App.tsx:6 (import), App.tsx:98 (render)
```

`App.tsx:90-100` currently reads:
```tsx
const renderTabContent = () => {
  switch (activeTab) {
    case 'collect': return <CollectTab />;
    case 'history': return <HistoryTab />;
    default:        return <CollectionsTab />;   // ← unreachable
  }
};
```
`ActiveTab` is `'collect' | 'history'` (`src/entrypoints/sidepanel/store/uiStore.ts:3`), and
`Navigation.tsx:4-7` defines `TABS` with exactly those two keys. The `default:` branch is therefore
statically unreachable and TypeScript already knows it. Replace with:
```tsx
switch (activeTab) {
  case 'collect': return <CollectTab />;
  case 'history': return <HistoryTab />;
}
```
A `switch` over an exhaustive union with no `default` is preferred here: if a third tab is ever added
to `ActiveTab`, `tsc` reports the non-exhaustive path instead of silently rendering a stale component.

### Dependencies and Order
Independent. Do it early — it removes 3 type errors and 268 lines of misleading code before anyone
else reads the overlay path in Phase 6.

### Testing and Verification
1. `npx tsc --noEmit` drops from **111 → 108** errors, and no *new* error appears.
2. `npx vitest run` stays at **71/71**. `tests/collection-tab-routing.test.tsx` and
   `tests/toolbar-routing.test.tsx` exercise tab switching and must pass unchanged — they are the
   proof that removing the `default:` branch broke nothing.
3. `grep -rn "OverlayDrawer\|ProductsTab\|CollectionsTab" src` returns nothing.
4. `npx wxt build` succeeds and the emitted `sidepanel` chunk shrinks.
5. **Regression risk:** effectively zero — no runtime path reaches any of the three files.

---

## Step 0.3 — Golden snapshot of current parser output

### Objective
Record the exact current output of `validateAndNormalizeScrapedProduct` for every fixture already in
the test suite, so that Phase 1 (currency) and Phase 5 (parser performance) can prove they changed
*only* what they intended to change.

### Root Cause
Not a defect — a safety measure. Phase 1 touches 10 call sites in the two hottest parser files, and
every existing price fixture uses a symbol-bearing price (`€49,99`, `$19.99`) that resolves correctly
today. Without a snapshot, a fix that accidentally overrides an explicit symbol with the URL-derived
code would pass every existing test.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `tests/baseline-snapshot.test.ts` | **create** | Reuses the DOM fixtures from `tests/scraper-accuracy.test.tsx` and `tests/pricing-deals-bsr.test.tsx`; asserts the full normalised product object |

### Implementation Details
For each existing fixture, build the document, run the appropriate parser
(`parseSearchResults` / `parseCategoryPage` / `parseProductDetail`), pipe through
`validateAndNormalizeScrapedProduct`, and assert the complete resulting object with
`toMatchInlineSnapshot()`. Cover at minimum: US search, DE search, UK search, JP search, a deals
page, a category page, and a product-detail page.

Deliberately **exclude** the `currency` field from the Phase‑0 snapshot for the symbol-less
fixtures, or snapshot it with a `// KNOWN BUG: fixed in Phase 1` comment and update it in Phase 1 as
a named, reviewed change. Recording a known-wrong value as "golden" without a marker is how
snapshots start defending bugs.

### Dependencies and Order
After Step 0.2 (so the snapshot reflects the post-deletion codebase). Must exist before Phase 1.

### Testing and Verification
The file passes on creation with ~4 tests. Its value is realised in Phase 1 and Phase 5, where it is
re-run and any diff must be explicitly justified.

---

## Step 0.4 — Record the starting state

### Objective
Fix the baseline numbers in writing so "did this phase make things worse?" is answerable objectively.

### Files Involved
None (recorded in the phase's PR description and in `CHANGELOG.md` at Phase 10).

### Implementation Details
Capture and commit to the PR description:

```
tsc --noEmit      : 111 errors  (96 src / 15 tests; 71 in table/columns.tsx)
vitest run        : 71 passing, 15 files
wxt build         : OK, 1.27 MB, warning: chunks/global-*.js = 919.70 kB
npm audit --omit=dev : 1 high (xlsx)
```

### Testing and Verification
`npm run verify` reproduces all four numbers.

---

## Phase 0 exit criteria

- [ ] `.github/workflows/ci.yml` exists and runs green (with the two documented `continue-on-error` steps)
- [ ] `npm run verify` exists and mirrors CI
- [ ] `OverlayDrawer.tsx`, `ProductsTab.tsx`, `CollectionsTab.tsx` deleted; `App.tsx` updated
- [ ] `tsc --noEmit` at **108** errors, `vitest run` at **≥ 75** passing, `wxt build` OK
- [ ] `tests/baseline-snapshot.test.ts` committed with the golden parser output
- [ ] Baseline numbers recorded
