# Phase 10 — Documentation & Project Identity

**Issues addressed:** L‑7 (documentation drift) · the identity half of the process finding
**Estimated effort:** Small · **Prerequisites:** all code phases complete · **Blocks:** nothing

Do this **last**, not first. Writing docs before the code settles guarantees they drift again, and the
drift documented here is precisely the residue of docs written against a plan rather than against a
build.

---

## Step 10.1 — Correct the project identity

### Objective
The repository should describe itself accurately.

### Root Cause
`package.json` still carries the WXT starter's identity:
```json
"name": "wxt-react-starter",
"version": "0.0.0",
"description": "manifest.json description"
```
The third value is a placeholder that reads like an instruction rather than a description. Meanwhile
`wxt.config.ts:10-12` sets the real manifest fields (`name: 'PPHunt'`,
`description: 'Collect, preview, and export Amazon product data with care.'`, `version: '1.0.0'`), so
the shipped extension is correct and only the package metadata is wrong.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `package.json` | modify | `name`, `version`, `description` (started in Phase 0 Step 0.1 — finish here) |

### Implementation Details
```jsonc
{
  "name": "pphunt",
  "version": "1.0.0",          // align with wxt.config.ts, not with 0.0.0
  "description": "Collect, preview, and export Amazon product data with care."
}
```
**Decision:** align `package.json.version` with `wxt.config.ts.manifest.version` (`1.0.0`), and note in
the README which one is authoritative for store submissions. Better still, have `wxt.config.ts` read
the version from `package.json` so there is one source of truth:
```ts
import pkg from './package.json';
manifest: { version: pkg.version, ... }
```
Verify WXT permits a JSON import in the config (it is an ESM/TS config, so it should) before committing
to this; otherwise keep the two in sync manually and add a CI assertion that they match.

### Testing and Verification
1. Phase 0's "Manifest sanity" CI step still passes.
2. Add a CI assertion: `package.json.version === dist/chrome-mv3/manifest.json.version`.
3. `npm pack --dry-run` shows the corrected name.

---

## Step 10.2 — Reconcile README, ARCHITECTURE.md, CHANGELOG.md and `spec/`

### Objective
Every claim in the documentation must be checkable against the shipped code.

### Root Cause
Verified drift, all of it in the direction of the docs describing an intended design rather than the
implementation:

**`ARCHITECTURE.md`**
- States *"All messages are Zod-validated"* — false until Phase 2. After Phase 2 it becomes true, so
  the sentence can stay, but it must be re-verified against the code, not assumed.
- States *"**No in-memory state** — all persistent data is in IndexedDB. Tab tracking — the background
  re-reads active sessions from IndexedDB on wake."* — false until Phase 4. Same treatment.
- Describes the overlay as "Shadow DOM". It is an **iframe at the extension origin inside a closed
  shadow root** (`src/lib/overlay/overlayHost.ts:31, 104`). The distinction matters: it is why the
  overlay can share IndexedDB with the side panel, and why M‑4's `postMessage` leak was possible.
- The File Index is wrong by up to 9×:

  | File | Documented | Actual |
  |---|---|---|
  | `src/lib/scraper/` | ~400 lines | **3,554** |
  | `src/lib/export/` | ~150 | **804** |
  | `src/entrypoints/background.ts` | ~180 | **704** |
  | `src/entrypoints/amazon.content.ts` | ~200 | **449** |
  | `src/entrypoints/sidepanel/App.tsx` | ~95 | 130 |
  | `wxt.config.ts` | 33 | 58 |
  | `tailwind.config.js` | 48 | 52 |

  **Recommendation: delete the line counts entirely.** They are wrong the moment anyone edits a file,
  and nothing is lost by their absence. Keep the file list and the one-line responsibility for each.

**`README.md`**
- Documents quick-select target chips as `10 / 50 / 100 / 250 / 500`;
  `src/constants/defaults.ts:14` is `[50, 100, 200, 300]`.
- The design-token table (lines 181-189) quotes the **dark** palette as if it were primary: Clay
  `#d97757` is `global.css:41`'s dark value, while light mode uses `#b04e30` (`global.css:18`). Its
  Hairline value `#b0aea5` matches **neither** theme (light is `#8a877d`).
- Claims "focus management" for modals — false until Phase 9 Step 9.3.
- The privacy claim — addressed in Phase 6 Step 6.4 (decision D2 keeps the remote fonts).

**`CHANGELOG.md`**
- Phase 3/4 entries describe a three-tab navigation (Collect | Preview | History) and an 8-column
  table. The app has **two** tabs (`uiStore.ts:3`, `Navigation.tsx:4-7`) and **24** export columns
  (`export/types.ts:144-188`). SAD‑136 removed the third tab.
- Repeats the wrong quick-select chip values.

**`spec/*.md`** (13 documents)
- `spec/11-messaging-protocol.md:161-170` specifies `MessageSchema.safeParse` validation — implemented
  in Phase 2, so the spec becomes accurate. Its `targetCount: positive integer` (lines 42, 83) matches
  the Phase 2 fix.
- `spec/06-phase-6-settings-ui.md:153` requires **Chrome notifications** as well as in-panel toasts.
  Phase 3 Step 3.1 deliberately scopes this down to toasts only, to avoid adding the `notifications`
  permission. **The spec must be amended to record that decision and its rationale**, otherwise the
  next reader will treat it as an unimplemented requirement.
- `PLAN.md:871` shows `parsePrice(priceEl?.textContent)` with one argument — the Phase 1 fix makes the
  code match the plan.
- `PLAN.md:1019, 1050` specify `.positive()` for `targetCount`; Phase 2 uses
  `.min(TARGET_MIN).max(TARGET_MAX)`. Amend the plan or the code — recommend amending `PLAN.md`, since
  the UI genuinely enforces bounds.

**Also add:** a new CHANGELOG entry describing this remediation, including the user-visible items —
that currency values on eurozone/Japanese storefronts were previously wrong and must be re-collected
(decision D7), that Settings now take effect, and that XLSX exports are now bounded.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `README.md` | modify | Chips, token table, focus-management claim, privacy claim (Phase 6) |
| `ARCHITECTURE.md` | modify | Overlay description, state claims, File Index |
| `CHANGELOG.md` | modify | Correct Phase 3/4 entries; add the remediation entry |
| `spec/06-phase-6-settings-ui.md` | modify | Record the notifications scope reduction |
| `spec/11-messaging-protocol.md` | modify | Confirm it now matches; note the bounds decision |
| `PLAN.md` | modify | `targetCount` bounds; mark implemented items |

### Implementation Details
Work through each file with the code open, and for every factual claim ask "how would a reader verify
this?" If the answer is not obvious, either make it obvious or delete the claim.

Two structural suggestions:
- **Replace numeric detail with pointers.** "`src/lib/scraper/` — page-type parsers, field extraction
  and the dedup engine" ages better than "~400 lines".
- **Add a CI doc-consistency check for the claims that are cheap to verify.** The quick-select chips and
  the design-token hex values are both machine-checkable against `constants/defaults.ts` and
  `global.css`. A small test that reads the README and asserts those two lists match the source would
  have caught both. This is the same principle as Phase 3's settings-consumer guard and Phase 9's
  dead-export guard: make the invariant executable rather than documented.

### Testing and Verification
1. New `tests/docs-consistency.test.ts`:
   - README's quick-select chip list === `QUICK_SELECT_TARGETS` in `constants/defaults.ts`
   - README's token hex values all appear in `global.css`
   - `package.json.version` === `wxt.config.ts` manifest version
2. Manual read-through of all four documents against a running build.
3. `grep -rn "~[0-9]\+ lines" ARCHITECTURE.md` returns nothing (line counts removed).

---

## Phase 10 exit criteria

- [ ] `package.json` name/version/description are correct and version-matched to the manifest
- [ ] Every factual claim in README, ARCHITECTURE.md and CHANGELOG.md is verifiable against the code
- [ ] `ARCHITECTURE.md`'s overlay description says iframe-in-closed-shadow-root
- [ ] `ARCHITECTURE.md`'s File Index has no line counts
- [ ] `spec/06` records the notifications scope reduction and its rationale
- [ ] CHANGELOG has a remediation entry naming the user-visible changes, including the currency re-collection note
- [ ] `tests/docs-consistency.test.ts` passes and runs in CI
- [ ] `tsc --noEmit` exits 0 · `vitest run` at **≥ 177** passing · `wxt build` OK · `npm audit --omit=dev` clean
