# Phase 3 — Settings & Export Defaults Wiring

**Issues addressed:** H‑1 (8 write-only settings) · M‑10 (`.parse()` during render)
**Estimated effort:** Medium · **Prerequisites:** Phase 2 (new payload fields must be validated) · **Blocks:** Phase 8

Today 10 of 13 settings are edited, persisted, re-displayed correctly — and consumed by nothing.
This phase connects them. It is split into a low-risk half (UI defaults, no protocol change) and a
half that extends the message protocol (scroll tuning), so the two can ship separately.

---

## Step 3.0 — Snapshot the current effective behaviour

Before changing anything, record what the app does today so "settings now take effect" is provable
and the *only* behavioural change is the intended one:

- `collectionStore` initial state is `mode: 'manual'`, `targetCount: 50` (`store/collectionStore.ts:48-50`)
- `ExportModal` initial state is `format: 'csv'`, `scope: 'all'`, `filename: pphunt-export-<date>`, `includeBOM: true` (`ExportModal.tsx:59-65`)
- `ScrollController` receives `scrollAmount: 800`, `scrollInterval: 500`, `waitAfterScroll: 1500`, `maxWaitForNew: 5000`, `maxLoadingWait: 15000` (`amazon.content.ts:192-198`)
- `DeduplicationEngine` is constructed unconditionally (`amazon.content.ts:45`)
- `showToast` is called unconditionally in `App.tsx`

These values all become the **schema defaults**, so a fresh install behaves identically to today. That
is the key property: this phase must not change behaviour for anyone who has never opened Settings.

---

## Step 3.1 — H‑1a: wire the settings that need no protocol change

### Objective
`defaultMode`, `defaultTargetCount`, `exportFormat`, `exportFilename`, `includeBOM`,
`duplicateDetection` and `notifications` take effect.

### Root Cause
Settings were implemented schema-first and UI-first, but every consumer was written against a
hardcoded constant and never connected. Verified by grepping all consumers of each key:

| Setting | Editable | Consumed | Where the constant lives instead |
|---|---|---|---|
| `defaultMode` | ✅ | ❌ | `collectionStore.ts:48` → `'manual'` |
| `defaultTargetCount` | ✅ | ❌ | `collectionStore.ts:50` → `50` |
| `exportFormat` | ✅ | ❌ | `ExportModal.tsx:59` → `'csv'` |
| `exportFilename` | ✅ | ❌ | `ExportModal.tsx:61-64` → template literal |
| `includeBOM` | ✅ | ❌ | `ExportModal.tsx:65` → `true` |
| `duplicateDetection` | ✅ | ❌ | `amazon.content.ts:45` → engine always constructed |
| `notifications` | ✅ | ❌ | `App.tsx` → `showToast` unconditional; `chrome.notifications` never used and the permission is not requested |
| `enabledFields` | ✅ | ✅ **works** | `columns.tsx:656-689`, `export/types.ts:144-188` |

There is also a latent enum mismatch: `settings.exportFormat` is `'csv' | 'xlsx' | 'clipboard'`
(`schemas/settings.ts:76`) while `ExportFormat` is `'csv' | 'excel' | 'clipboard'`
(`export/types.ts:4`). Wiring the raw value would match no `case` in `useExport.exportData`'s switch
(`useExport.ts:57-84`), which has **no `default` branch** — so the export would silently do nothing.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/schemas/settings.ts` | modify | Harmonise `exportFormat` to `'csv' \| 'excel' \| 'clipboard'` with a `.transform()` that maps legacy `'xlsx'` |
| `src/types/settings.ts` | modify | Mirror the type |
| `src/constants/defaults.ts` | modify | Add `DEFAULT_EXPORT_FORMAT`, `DEFAULT_INCLUDE_BOM` alongside the existing `TARGET_*` |
| `src/entrypoints/sidepanel/store/collectionStore.ts` | modify | Add `applySettingsDefaults(settings)` action |
| `src/entrypoints/sidepanel/App.tsx` | modify | Call `applySettingsDefaults` once on mount; gate `showToast` on `notifications` |
| `src/entrypoints/sidepanel/components/ExportModal.tsx` | modify | Initialise from settings **and re-initialise when the modal opens** |
| `src/entrypoints/sidepanel/hooks/useExport.ts` | modify | Add the missing `default:` branch |
| `src/entrypoints/amazon.content.ts` | modify | Gate the dedup engine on `duplicateDetection` (needs Step 3.4's payload field) |
| `src/entrypoints/sidepanel/components/SettingsOverlay.tsx` | modify | Update the `exportFormat` option value from `xlsx` to `excel` |

### Implementation Details

**Enum harmonisation with backward compatibility.** Existing users have `exportFormat: 'xlsx'`
persisted. A plain enum change would make `SettingsSchema.parse` throw on their row — which, because
of M‑10, white-screens the panel. Use a pre-transform:
```ts
// schemas/settings.ts
exportFormat: z
  .union([z.literal('csv'), z.literal('excel'), z.literal('clipboard'), z.literal('xlsx')])
  .transform((v) => (v === 'xlsx' ? 'excel' : v))
  .default('csv'),
```
`ValidatedSettings['exportFormat']` then becomes the clean 3-member union, and legacy rows upgrade
transparently on read.

**Collection defaults.** Add to `collectionStore`:
```ts
applySettingsDefaults: (s: { defaultMode: CollectionMode; defaultTargetCount: number }) =>
  set((state) => ({
    // Never override a collection that is already running or already configured by the user
    mode: state.status === 'idle' ? s.defaultMode : state.mode,
    targetCount: state.status === 'idle' ? s.defaultTargetCount : state.targetCount,
  })),
```
Called once from `App.tsx` inside the existing `useLiveQuery`/settings effect. The `status === 'idle'`
guard matters: `useSessionRecovery` may restore a paused session, and applying defaults after that
would clobber the restored target.

**ExportModal — the state-reset bug.** The component reads settings *after* its `useState`
initialisers run (`ExportModal.tsx:59-67`), and because it stays mounted while closed, those
initialisers never re-run. Wiring the defaults therefore requires an explicit reset on open:
```ts
const { settings } = useSettings();
const [format, setFormat] = useState<ExportFormat>('csv');
// ...
useEffect(() => {
  if (!isOpen || !settings) return;
  setFormat(settings.exportFormat);
  setIncludeBOM(settings.includeBOM);
  setFilename(settings.exportFilename?.trim() || `pphunt-export-${todayISO()}`);
}, [isOpen, settings]);
```
`exportFilename` needs a decision: treat it as a **prefix/template** or as a literal filename. The
schema calls it `exportFilename` and the UI label implies a literal name, so use it literally when
non-empty and fall back to the current date-based template otherwise. Record the choice in the UI
helper text.

**`useExport.ts:57-84`** — add the missing default so an unknown format is loud rather than silent:
```ts
default: {
  const exhaustive: never = format;
  throw new Error(`Unsupported export format: ${String(exhaustive)}`);
}
```
The `never` assignment gives compile-time exhaustiveness if a fourth format is ever added.

**`notifications`.** Two parts, both required by `spec/06-phase-6-settings-ui.md:153` ("Chrome
notifications **and** in-panel toasts"):
1. Gate every `showToast` call in `App.tsx` on `settings.notifications !== false`.
2. Decide the Chrome-notification half explicitly. Requesting the `notifications` permission in
   `wxt.config.ts` adds a permission prompt on update, which is a store-review and user-trust cost.
   **Recommendation: do not add the permission.** Instead, scope the toggle to in-panel toasts (which
   is what the code can do today) and correct `spec/06` + README to say so. This is recorded as a
   deliberate, documented scope reduction rather than a silent one — flag it for approval.

**`duplicateDetection`.** Requires the setting to reach the content script, so it is implemented in
Step 3.4 alongside the scroll fields.

### Dependencies and Order
- Depends on Phase 2 only for `duplicateDetection` (Step 3.4); Steps 3.1–3.3 could ship without it.
- **Blocks Phase 8**, which adds the `exportImages` setting to the same schema and the same modal.
- Interacts with **H‑4 (Step 3.2)**: wire the consumers *after* the merge bug is fixed, otherwise
  tests will observe lost writes and mask wiring errors.

### Testing and Verification
New `tests/settings-consumption.test.ts` (or extend `tests/settings-overlay.test.tsx`):

| Setting | Test |
|---|---|
| `defaultMode` | Write `'automatic'` → mount `App` → assert `collectionStore.mode === 'automatic'` |
| `defaultTargetCount` | Write `250` → mount → assert `targetCount === 250` and `TargetSelector` shows 250 |
| `exportFormat` | Write `'excel'` → open `ExportModal` → assert the Excel radio is selected |
| `exportFormat` legacy | Write `'xlsx'` directly to the DB → open → assert `'excel'` is selected and **nothing throws** |
| `exportFilename` | Write `'my-export'` → open → assert the filename input reads `my-export` |
| `includeBOM` | Write `false` → export CSV → assert no `\uFEFF` at position 0 |
| `notifications` | Write `false` → dispatch an `UPDATE_PROGRESS` with an error → assert no toast appears |
| Modal reset | Open → change format → close → reopen → assert it is back to the settings default |

**Guard test (the one that prevents recurrence):** enumerate `Object.keys(SettingsSchema.shape)` and
assert each key is referenced by at least one module outside `SettingsOverlay.tsx`, `schemas/`,
`types/` and `constants/`. Implement as a static grep-style assertion over the source tree using
`fs.readFileSync` in the test — crude, but it is the only thing that will stop an unwired setting
being added again.

**Regression:** `tests/settings-overlay.test.tsx` (5 tests) must pass unchanged except where it
asserts the literal `'xlsx'` option value.

---

## Step 3.2 — H‑4: stop losing rapid settings edits

### Objective
Two checkbox clicks within the 500 ms debounce window must both persist.

### Root Cause
Three interacting defects, reproduced by rendering the real `SettingsOverlay` and clicking twice:
```
initial checked: title= true  asin= true
click(title); click(asin);        // < 500 ms apart
PERSISTED → title = true   (expected false)  ← LOST
PERSISTED → asin  = false
UI state  → title = true   ← the checkbox visibly reverts
```
1. **Last-write-wins debounce** (`hooks/useSettings.ts:31-46`): `clearTimeout` on every call means
   only the final `partial` survives the window.
2. **Stale full-object snapshot**: `SettingsOverlay.tsx:313-366` sends the *entire*
   `enabledFields` object built from the render closure, so the second click re-asserts the first
   click's pre-change value.
3. **Shallow merge bypasses the correct DB logic**: the hook does
   `SettingsSchema.parse({ ...(current ?? {}), ...partial })` then `db.settings.put(merged)`.
   `src/lib/db/settings.ts:25-40` *already* deep-merges `enabledFields` against
   `DEFAULT_ENABLED_FIELDS` and the current row — the hook simply never calls it. Two functions named
   `updateSettings` with different semantics coexist.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/hooks/useSettings.ts` | modify | Accumulate pending partials; delegate persistence to the DB-layer function |

### Implementation Details
```ts
+ import { updateSettings as persistSettings } from '@/lib/db/settings';
+ const pendingRef = useRef<Partial<ValidatedSettings> | null>(null);

  const updateSettings = useCallback((partial: Partial<ValidatedSettings>) => {
+   // Accumulate rather than replace, deep-merging the nested enabledFields map
+   const prev = pendingRef.current;
+   pendingRef.current = {
+     ...prev,
+     ...partial,
+     enabledFields: { ...prev?.enabledFields, ...partial.enabledFields },
+   };
+
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
+     const pending = pendingRef.current;
+     pendingRef.current = null;
+     if (!pending) return;
      try {
-       const current = await db.settings.get('default');
-       const merged = SettingsSchema.parse({ ...(current ?? {}), ...partial });
-       await db.settings.put(merged);
+       await persistSettings(pending);
      } catch (err) {
        console.error('[PPHunt] Settings save error:', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }, []);
```
Delegating to `db/settings.ts:updateSettings` is what fixes defect 3 for free: that function
re-reads the current row and deep-merges `enabledFields`, so even a stale snapshot from the UI cannot
resurrect an old value. The `enabledFields` accumulation in the ref is still needed, because within a
single debounce window there is no DB round-trip between the two clicks.

Also add cleanup of both timers on unmount (the existing `timerRef` at line 20 is declared but never
used or cleared — remove it or wire it):
```ts
useEffect(() => () => {
  if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
}, []);
```

### Dependencies and Order
**Do this before Step 3.1's tests are trusted.** If settings writes are being lost, a wiring test can
pass for the wrong reason or fail for an unrelated one.

Recommended intra-phase order: **3.0 → 3.2 → 3.3 → 3.1 → 3.4**.

### Testing and Verification
1. **The reproducing test:** N=5 rapid distinct toggles → all 5 persisted.
2. Mixed keys in one burst: `enabledFields.title` + `defaultMode` + `scrollInterval` → all three
   persisted.
3. Slider drag: 10 rapid `scrollInterval` changes → the final value persists and intermediate writes
   do not corrupt other keys.
4. Existing `tests/settings-overlay.test.tsx` → *"continues to save edits without resetting unrelated
   settings"* already waits 566 ms against a 500 ms debounce, which is only a 66 ms margin. **Make the
   debounce injectable** (`useSettings({ saveDebounceMs })` or a module constant exported for tests) so
   the test is not wall-clock dependent.

---

## Step 3.3 — M‑10: stop parsing Zod during render

### Objective
A malformed settings row must degrade to defaults, not unmount the panel.

### Root Cause
`hooks/useSettings.ts:53`:
```ts
const parsed = settings ? SettingsSchema.parse(settings) : null;
```
`.parse()` throws. The hook is consumed by `ProductTable.tsx:57`, `ExportModal.tsx:67` and
`SettingsOverlay.tsx:38` — i.e. by the Preview table and the export modal, not just Settings. There
is **no error boundary anywhere in `App.tsx`**, so a throw during render unmounts the whole panel.
`db/settings.ts:13` (`getSettings`) merges `enabledFields` against defaults *before* parsing; the hook
does not, so the two read paths have different tolerance for the same row.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/hooks/useSettings.ts` | modify | `safeParse` with a defaults fallback |
| `src/entrypoints/sidepanel/App.tsx` | modify | Wrap tab content in an error boundary |
| `src/entrypoints/sidepanel/components/ErrorBoundary.tsx` | **create** | Class-component boundary with a retry affordance |

### Implementation Details
```ts
- const parsed = settings ? SettingsSchema.parse(settings) : null;
+ const parsed = useMemo(() => {
+   if (!settings) return null;
+   const result = SettingsSchema.safeParse({
+     ...settings,
+     enabledFields: { ...DEFAULT_ENABLED_FIELDS, ...(settings.enabledFields ?? {}) },
+   });
+   if (result.success) return result.data;
+   console.error('[PPHunt] Stored settings are invalid; falling back to defaults', result.error.issues);
+   return SettingsSchema.parse({});
+ }, [settings]);
```
The `enabledFields` spread mirrors `db/settings.ts:13-19` so both read paths tolerate the same rows.

The error boundary is a small class component rendering the existing `ErrorModal` styling with a
"Reload panel" button (`window.location.reload()`). It must sit **inside** the theme provider and
**outside** `renderTabContent()` so a table failure does not take the header and navigation with it.

### Testing and Verification
1. `db.settings.put({ id: 'default', defaultTargetCount: 999999, enabledFields: {} })` → render
   `<ProductTable/>` → asserts it renders with defaults and logs, rather than throwing.
2. A child component that throws → the boundary renders its fallback and the header survives.
3. `restoreDefaults()` from that state recovers.

---

## Step 3.4 — H‑1b: wire the scroll settings (requires a protocol change)

### Objective
`scrollSpeed`, `scrollInterval`, `waitAfterScroll` and `duplicateDetection` reach the content script.

### Root Cause
There is no channel. `COLLECT_PRODUCTS` carries only `{ mode, targetCount }`
(`background.ts:442-443` and `:473-474`; `schemas/messages.ts:74-80`), and
`amazon.content.ts:192-198` hardcodes:
```ts
scrollController = new ScrollController({
  scrollAmount: 800, scrollInterval: 500, waitAfterScroll: 1500,
  maxWaitForNew: 5000, maxLoadingWait: 15000,
});
```
`ScrollController`'s config type already accepts all five fields, so no change is needed there.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/schemas/messages.ts` | modify | Extend `CollectProductsMessageSchema.payload` |
| `src/entrypoints/background.ts` | modify | Read settings and forward them (2 call sites: 442 and 473) |
| `src/entrypoints/amazon.content.ts` | modify | Pass them to `ScrollController`; gate dedup |
| `src/lib/scraper/scroll-controller.ts` | modify | Only if clamping is desired (recommended) |

### Implementation Details
```ts
// schemas/messages.ts — CollectProductsMessageSchema.payload
export const ScrollConfigSchema = z.object({
  scrollAmount:   z.number().int().min(100).max(3000).default(800),
  scrollInterval: z.number().int().min(200).max(5000).default(500),
  waitAfterScroll:z.number().int().min(500).max(10000).default(1500),
  duplicateDetection: z.boolean().default(true),
});

payload: z.object({
  mode: CollectionModeSchema,
  targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
  scroll: ScrollConfigSchema.optional(),     // optional so an older content script still validates
  existingAsins: z.array(z.string()).optional(),   // Phase 4, Step 4.4 — added here to avoid a second protocol bump
}).strict(),
```
The bounds mirror `SettingsOverlay`'s slider ranges exactly. `.optional()` plus `.default()` inside
the object means a message from an older background still parses — important because during a
development reload the content script and background can briefly be different builds.

`background.ts` — read once, forward at both sites:
```ts
const settings = await getSettings();
await sendToContentScriptWithRecovery(tabId, {
  type: 'COLLECT_PRODUCTS',
  payload: {
    mode, targetCount,
    scroll: {
      scrollAmount: settings.scrollSpeed,
      scrollInterval: settings.scrollInterval,
      waitAfterScroll: settings.waitAfterScroll,
      duplicateDetection: settings.duplicateDetection,
    },
  },
});
```
Note `getSettings()` is async and the `START_COLLECTION` branch is currently synchronous up to the
`void sendToContentScriptWithRecovery(...)` call; wrap in an async IIFE as the
`RELOAD_AND_RETRY_COLLECTION` branch already does at lines 462-476.

`amazon.content.ts`:
```ts
- scrollController = new ScrollController({ scrollAmount: 800, scrollInterval: 500, waitAfterScroll: 1500, ... });
+ const scrollCfg = msg.payload.scroll;
+ scrollController = new ScrollController({
+   scrollAmount:    scrollCfg?.scrollAmount    ?? 800,
+   scrollInterval:  scrollCfg?.scrollInterval  ?? 500,
+   waitAfterScroll: scrollCfg?.waitAfterScroll ?? 1500,
+   maxWaitForNew: 5000,
+   maxLoadingWait: 15000,
+ });
+ dedupEnabled = scrollCfg?.duplicateDetection ?? true;
```
and gate the engine where it is consulted rather than where it is constructed, so toggling the
setting does not require reconstructing state:
```ts
const newProducts = dedupEnabled ? dedup.mergeAndFilterNew(batch) : batch;
```

**Behavioural-change warning (risk R5-adjacent):** once `scrollInterval` is honoured, the effective
scroll cadence changes for any user who moved the slider, which interacts with **Phase 5's M‑2
end-of-page detection** (both reason about tick counts and `maxWaitForNew`). Land Phase 3 before
Phase 5 and re-check M‑2's timing assumptions afterwards.

### Testing and Verification
1. Spy on the `ScrollController` constructor: write `scrollSpeed: 1200`, `scrollInterval: 2000`,
   `waitAfterScroll: 3000` → dispatch `COLLECT_PRODUCTS` → assert it receives exactly those numbers.
2. Defaults: with no settings row, assert `800 / 500 / 1500` — i.e. identical to today.
3. `duplicateDetection: false` → dispatch two identical batches → assert the second batch's products
   are **not** filtered.
4. Schema test: a `COLLECT_PRODUCTS` payload with no `scroll` key still validates (back-compat).
5. Extend `tests/message-schema-conformance.test.ts` (Step 2.3) with the new payload shape.
6. Update `tests/error-recovery-and-resilience.test.tsx` where it asserts the `COLLECT_PRODUCTS`
   payload — expect it to now include `scroll`.

---

## Phase 3 exit criteria

- [ ] Every key in `SettingsSchema` has at least one non-UI consumer, enforced by a guard test
- [ ] 5 rapid distinct toggles all persist; mixed-key bursts persist
- [ ] A malformed settings row degrades to defaults; an error boundary contains render throws
- [ ] `ScrollController` receives the configured scroll values; defaults match today's hardcoded numbers exactly
- [ ] `exportFormat: 'xlsx'` legacy rows load as `'excel'` without throwing
- [ ] `useExport.exportData` has an exhaustive `default` branch
- [ ] The `notifications` scope reduction (in-panel toasts only, no new permission) is explicitly approved and documented
- [ ] `tsc --noEmit` at **104** errors · `vitest run` at **≥ 129** passing · `wxt build` OK
