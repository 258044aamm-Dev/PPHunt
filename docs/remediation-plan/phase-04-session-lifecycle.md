# Phase 4 — Session Lifecycle & MV3 State

**Issues addressed:** H‑5 (session lifecycle) · H‑8 (MV3 in-memory state) · M‑1 (counter regression) · M‑9 (destructive history clear)
**Estimated effort:** Large · **Prerequisites:** Phase 2 (protocol), Phase 3 (`getSettings` in background) · **Blocks:** nothing

These four findings share one root cause — session identity is managed in three places that do not
agree — so they are fixed as one coherent change rather than four patches.

---

## Step 4.0 — Snapshot current DB behaviour

`tests/active-tab.test.tsx` and `tests/history-preview-export.test.tsx` seed sessions and history
directly and assert row counts. Record their exact assertions before changing `db/sessions.ts` and
`db/history.ts`, so that any expectation change in this phase is a deliberate, listed decision rather
than a silent accommodation (risk R5).

Concretely, note down: how many `db.sessions` rows each test creates, which `status` values it uses,
and every `expect(...).toBe(n)` on a count.

---

## Step 4.1 — H‑5a: fix `startedAt`, and make `updateSessionStatus` an upsert

### Objective
History records a real duration, and a status update for a session the background minted itself is
never silently dropped.

### Root Cause
**(a) `startedAt === completedAt`, always.** `CollectionControls.tsx:142-156`:
```ts
const now = new Date().toISOString();
await updateSessionStatus(stoppedSessionKey, 'completed', {...});
await addHistory({ ..., startedAt: now, completedAt: now, ... });
```
The session's real `startedAt` — written by `createSession` at `db/sessions.ts:11,21` — is discarded.
Every History row reports a zero-duration collection, and `HistoryEntry.tsx:78` renders
`formatDate(entry.startedAt)`, so the UI shows the *end* time labelled as the start.

**(b) `updateSessionStatus` is a silent no-op when the row is missing.** `db/sessions.ts:50` uses
`db.sessions.update(sessionKey, updates)`, which resolves to `0` for a nonexistent key and throws
nothing. Rows are created **only** by `CollectionControls.tsx:86`. So `background.ts:541` (progress),
`:609` (content error) and `:680` (tab closed) all target `activeSessionKey`, which after a worker
restart is a background-minted `` `session_${tabId}_${Date.now()}` `` (`background.ts:429-431`) — a
*different format* from `createSession`'s `` `${tabId}_${Date.now()}` `` — with no row. The update is
dropped. `background.ts:550` then reads the row back, gets `undefined`, and falls back to
`activeSessionUrl ?? 'https://www.amazon.com/'`, so History can record a **fabricated URL**.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/db/sessions.ts` | modify | `updateSessionStatus` → upsert; add `ensureSession`; fix `getActiveSession` ordering |
| `src/entrypoints/sidepanel/components/CollectionControls.tsx` | modify | Read `startedAt` from the session row |
| `src/entrypoints/background.ts` | modify | Call `ensureSession` when it mints a key |

### Implementation Details

**`db/sessions.ts`** — replace the `update` with a transactional upsert that preserves the original
`startedAt`:
```ts
export async function updateSessionStatus(
  sessionKey: string,
  status: CollectionStatus,
  counts?: { collected: number; target?: number },
  errorMessage?: string
): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.get(sessionKey);
    const base: SessionState = existing ?? {
      id: sessionKey,
      tabId: parseTabIdFromSessionKey(sessionKey),
      url: '',
      status,
      mode: 'manual',
      targetCount: DEFAULT_TARGET_COUNT,
      collectedCount: 0,
      startedAt: now,
      updatedAt: now,
    };
    const next: SessionState = { ...base, status, updatedAt: now };
    if (counts) {
      next.collectedCount = counts.collected;
      if (typeof counts.target === 'number' && counts.target > 0) next.targetCount = counts.target;
    }
    if (status === 'completed' || status === 'interrupted') next.completedAt = now;
    if (errorMessage !== undefined) next.errorMessage = errorMessage;
    await db.sessions.put(next);
  });
}
```
`parseTabIdFromSessionKey` is a tiny helper reading the leading `` `${tabId}_` `` segment; it must
also tolerate the legacy `session_${tabId}_${ts}` format so in-flight sessions survive the upgrade.

**Normalise the key format.** Pick **one** format. Recommendation: keep `createSession`'s
`` `${tabId}_${Date.now()}` `` (it is the one already persisted in users' databases) and change
`background.ts:429-431` to mint the same shape. The `session_` prefix carries no information.

**`CollectionControls.tsx:142-156`** — read the real start time:
```ts
const session = await getSession(stoppedSessionKey);
const now = new Date().toISOString();
await updateSessionStatus(stoppedSessionKey, 'completed', {...});
await addHistory({
  ...,
  startedAt: session?.startedAt ?? now,
  completedAt: now,
});
```
This finally gives `getSession` (`db/sessions.ts:57`) a caller — it currently has zero.

### Testing and Verification
1. Start → advance a mocked clock by 30 s → stop → assert
   `history.completedAt - history.startedAt ≈ 30000`. **Fails today** (delta is 0).
2. `updateSessionStatus('never_existed', 'completed', ...)` → assert a row now exists with a sensible
   `startedAt`, and that `db.sessions.update` returning 0 is no longer reachable.
3. Pre-existing row → `updateSessionStatus` → assert `startedAt` is **unchanged**.
4. `HistoryEntry` renders the start time, not the end time.
5. `tests/history-preview-export.test.tsx` still passes; list any expectation that had to change.

---

## Step 4.2 — H‑8: survive MV3 service-worker termination

### Objective
After Chrome terminates and restarts the background worker mid-collection, products must land under
the **original** sessionKey and History must record the original `startedAt` / `url` / `mode` /
`targetCount` — not fabricated fallbacks.

### Root Cause
`ARCHITECTURE.md` states: *"**No in-memory state** — all persistent data is in IndexedDB. Tab
tracking — the background re-reads active sessions from IndexedDB on wake."* The code does the
opposite. `background.ts:16-24` holds nine module-scope variables:
```ts
let activeCollectionTabId, activeSessionKey, activeSessionMode, activeSessionTarget,
    activeSessionStartedAt, activeSessionUrl, lastCollectedCount, openingMode, preferenceRevision;
```
and `defineBackground` (line 12) only calls `configureAction()` — there is **no rehydration path**.
`getActiveSession()` (`db/sessions.ts:53`) exists for exactly this purpose and has zero call sites.

Consequences after a restart, traced per variable:

| Lost | Consequence |
|---|---|
| `activeSessionKey` | `persistCollectedProducts` (`background.ts:257-259`) mints a **new** key in a **different format**, splitting one run's products across two sessionKeys |
| `activeCollectionTabId` | `tabs.onRemoved` (`:658`) no longer matches → no `TAB_CLOSED` diagnostic, no `'interrupted'` status |
| `activeSessionTarget/Mode/StartedAt/Url` | `addHistory` (`:551-569`) falls back to `target ?? 50`, `mode ?? 'manual'`, `startedAt ?? completedAt`, `url ?? 'https://www.amazon.com/'` → **fabricated History** |
| `lastCollectedCount` | progress clamping restarts |
| `openingMode` | `action.onClicked` (`:74-77`) silently reconfigures instead of opening |

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/db/session-state.ts` | **create** | `chrome.storage.session` read/write/clear for the active-session pointer |
| `src/entrypoints/background.ts` | modify | Persist on every mutation; rehydrate lazily in the router |

### Implementation Details

**Why `chrome.storage.session` rather than IndexedDB.** It survives worker termination within a
browser session, is synchronous-ish and cheap, is cleared automatically when the browser closes
(matching the semantics wanted here), and does not require opening a Dexie connection in the worker's
first milliseconds. IndexedDB remains the source of truth for the session *row*; `storage.session`
holds only the pointer.

```ts
// src/lib/db/session-state.ts
const KEY = 'pphunt.activeSession';

export interface ActiveSessionPointer {
  tabId: number | null;
  sessionKey: string | null;
  mode: 'manual' | 'automatic';
  targetCount: number;
  startedAt: string | null;
  url: string | null;
  lastCollectedCount: number;
}

export async function readActiveSession(): Promise<ActiveSessionPointer | null> { ... }
export async function writeActiveSession(p: ActiveSessionPointer): Promise<void> { ... }
export async function clearActiveSession(): Promise<void> { ... }
```

`background.ts` changes:
1. Replace the nine `let` bindings with a single `let state: ActiveSessionPointer` plus a
   `hydrate()` that runs once, lazily, at the top of the message router:
   ```ts
   let hydrated = false;
   async function ensureHydrated() {
     if (hydrated) return;
     hydrated = true;
     state = (await readActiveSession()) ?? EMPTY_STATE;
     if (!state.sessionKey) {
       // Fall back to IndexedDB — covers a browser restart, not just a worker restart
       const row = await getActiveSession();
       if (row) state = pointerFromSessionRow(row);
     }
   }
   ```
2. Persist on every mutation: `START_COLLECTION`, `RELOAD_AND_RETRY_COLLECTION`, `PRODUCTS_COLLECTED`,
   `COLLECTION_PROGRESS`, `STOP_COLLECTION`, `tabs.onRemoved`.
3. Because `ensureHydrated()` is async, the router must await it before touching `state`. The listener
   already returns `false` synchronously and uses `sendResponse`, so awaiting inside is safe — but
   verify that no branch relies on `sendResponse` being called before the first `await`. Where it does
   (notably `amazon.content.ts:278`'s immediate ack pattern), keep the ack first.

`openingMode` and `preferenceRevision` are already backed by `browser.storage.local`
(`background.ts:32-36`) and re-read via `configureAction()`; leave them, but call `configureAction()`
on worker start (it already is, at line 38) and confirm `openingMode` is repopulated — it is, via
`readOpeningMode`.

### Testing and Verification
1. **The worker-restart test:** initialise the background, send `START_COLLECTION` with
   `sessionKey: 'K1'`, then re-import and re-invoke `defineBackground()` (simulating termination),
   send `PRODUCTS_COLLECTED`, and assert the products are stored under **`K1`** and that a subsequent
   History record has the original `startedAt`/`url`/`mode`. **Fails today.**
2. `tabs.onRemoved` for the collection tab after a simulated restart → assert an `'interrupted'`
   status is written.
3. `storage.session` unavailable (Firefox / older Chrome) → assert graceful degradation to the
   IndexedDB path rather than a throw. Guard with a feature check, since `chrome.storage.session`
   is MV3-only.
4. **Manual (Phase 11, item 4):** `chrome://extensions` → click the service worker's "Stop" button
   mid-collection → confirm the counter and History stay correct.

---

## Step 4.3 — H‑5b: deterministic recovery and session pruning

### Objective
Session recovery restores the *most recent* relevant session, and the sessions table stops growing
forever.

### Root Cause
**(a) Arbitrary recovery pick.** `useSessionRecovery.ts:37-40`:
```ts
const activeSession = await db.sessions.where('status').anyOf(['collecting','paused']).first();
```
Because sessions are never pruned (`deleteSession`/`clearAllSessions` at `db/sessions.ts:63-69` have
**zero call sites**) and a session left in `'collecting'` is never transitioned when the panel closes,
multiple rows can match. IndexedDB `first()` returns the lowest primary key, and the key is
`` `${tabId}_${Date.now()}` `` — a **string**, so ordering is lexicographic, not chronological
(`"10_1700..." < "9_1600..."`). Recovery can restore a years-old session and show *"Previous
collection had N products"* for the wrong run. `getActiveSession()` has the identical defect.

**(b) No pruning.** `SettingsOverlay.tsx:42` displays the ever-growing `db.sessions.count()` as a
"live stat".

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/db/sessions.ts` | modify | `getActiveSession(tabId?)` ordered by `startedAt`; `pruneOldSessions()` |
| `src/lib/db/database.ts` | modify | Add a `startedAt` index if not present |
| `src/entrypoints/sidepanel/hooks/useSessionRecovery.ts` | modify | Scope recovery to the current tab; use the ordered query |
| `src/lib/db/history.ts` | modify | Delete the session row alongside the history entry |

### Implementation Details
```ts
// db/sessions.ts
export async function getActiveSession(tabId?: number): Promise<SessionState | undefined> {
  const q = db.sessions.where('status').anyOf(['collecting', 'paused']);
  const rows = await q.toArray();
  const scoped = tabId != null ? rows.filter((r) => r.tabId === tabId) : rows;
  return scoped.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

/** Removes terminal sessions older than maxAgeMs, plus their orphaned products. */
export async function pruneOldSessions(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return db.transaction('rw', [db.sessions, db.products, db.history], async () => {
    const stale = await db.sessions.filter(
      (s) => ['completed', 'interrupted', 'error'].includes(s.status) &&
             Date.parse(s.updatedAt ?? s.startedAt) < cutoff
    ).toArray();
    for (const s of stale) {
      await db.products.where('sessionKey').equals(s.id).delete();
      await db.sessions.delete(s.id);
    }
    return stale.length;
  });
}
```
Sorting in JS after `toArray()` is deliberate: it avoids adding a compound index and the row count is
small. If the sessions table is ever large, add `.orderBy('startedAt')` — which requires the index
noted above.

Call `pruneOldSessions()` once per panel open from `App.tsx`'s mount effect (not from the render
path), and after `clearAllHistory`.

`deleteHistory` (Step 4.5) also deletes the matching session row, which is the main pruning path in
normal use.

### Testing and Verification
1. Create 3 sessions across 2 tabs with staggered `startedAt` values, leave 2 in `'collecting'` →
   mount the panel on tab 9 → assert recovery selects the most recent session **for tab 9**, not the
   lexicographically-first key. Construct the fixture so lexicographic and chronological order
   disagree (e.g. tabIds `9` and `10`) — **this is the case that fails today**.
2. `pruneOldSessions()` with a 30-day cutoff removes a 31-day-old `'completed'` session and its
   products, and keeps a 1-day-old one and any `'collecting'` one.
3. `SettingsOverlay`'s displayed session count is stable across panel reopens.

---

## Step 4.4 — M‑1: stop the progress counter from regressing

### Objective
After resume or reload-and-retry, the `N / target` counter must never decrease, and pre-existing
products must count toward the total.

### Root Cause
On every `COLLECT_PRODUCTS` — including the ones sent by `RESUME_SCROLLING` recovery and by
`RELOAD_AND_RETRY_COLLECTION` — the content script wipes its accumulator
(`amazon.content.ts:282-283`):
```ts
collectedProducts.length = 0;
dedup.clear?.();
```
The next `sendProgress()` therefore reports only what this run found. `background.ts:533` clamps with
`lastCollectedCount = Math.max(lastCollectedCount, collected)`, which protects the counter only while
the worker is alive (see Step 4.2). `App.tsx:53-59` accepts any positive value:
```ts
if (collected > 0 || status !== 'error' || currentCount === 0) { setCollectedCount(collected); }
```
so a smaller positive number is displayed and the counter visibly drops.

The intended mitigation exists but is dead: `amazon.content.ts:288-296` pre-seeds the dedup engine
from `msg.payload.existingAsins`, and **`background.ts` never sends that field** — grep confirms
`existingAsins` appears only in `amazon.content.ts`. `db/products.ts:36` exports
`getExistingASINs(sessionKey)` for exactly this purpose, with zero call sites.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/background.ts` | modify | Send `existingAsins` in both `COLLECT_PRODUCTS` payloads (442, 473) |
| `src/entrypoints/amazon.content.ts` | modify | Count pre-seeded ASINs toward the reported total |
| `src/lib/schemas/messages.ts` | modify | Already covered — `existingAsins` was added in Step 3.4 |

### Implementation Details
```ts
// background.ts, both COLLECT_PRODUCTS sites
const existing = sessionKey ? await getExistingASINs(sessionKey) : [];
payload: {
  mode, targetCount, scroll: {...},
  existingAsins: existing.slice(0, MAX_SEEDED_ASINS),   // bound the message size
}
```
`MAX_SEEDED_ASINS` (suggest 2000) bounds the message; above that, dedup is best-effort and the DB
remains correct because `persistCollectedProducts` dedups on write anyway.

On the content side, track the seed separately so the counter reflects reality:
```ts
let preSeededCount = 0;
...
case 'COLLECT_PRODUCTS': {
  const seeds = msg.payload.existingAsins ?? [];
  seeds.forEach((a) => dedup.addExisting?.(a));
  preSeededCount = seeds.length;
  ...
}
const sendProgress = (status) => browser.runtime.sendMessage({
  type: 'COLLECTION_PROGRESS',
  payload: { collected: preSeededCount + collectedProducts.length, target: targetCount, status },
});
```
Note this makes `dedup.clear()` at line 283 correct-then-reseeded rather than clear-and-forget; verify
`DeduplicationEngine`'s actual API name for adding a known ASIN (`dedup.ts`) and use it rather than
assuming.

### Testing and Verification
1. Seed `db.products` with 120 rows for sessionKey `K1` → dispatch `RESUME_SCROLLING` against a DOM
   containing 30 of those ASINs plus 10 new → assert every `COLLECTION_PROGRESS.collected` value is
   **monotonically non-decreasing** and ends at ≥ 130. **Fails today.**
2. Message-size guard: 5000 existing ASINs → assert the payload carries at most `MAX_SEEDED_ASINS`.
3. `getExistingASINs` now has a caller — remove it from the dead-export list in Phase 9.

---

## Step 4.5 — M‑9: scope and atomicise history deletion

### Objective
"Clear all history" must not destroy an in-flight session's products, and deletes must be atomic.

### Root Cause
`db/history.ts:46-49`:
```ts
export async function clearAllHistory(): Promise<void> {
  await db.history.clear();
  await db.products.clear();      // ← ALL products, including the in-flight session's
}
```
The dialog (`HistoryTab.tsx:44`) says only *"Clear all collection history? This cannot be undone."* —
it does not mention that every collected product is deleted. `db.sessions` is **not** cleared,
leaving `useSessionRecovery` to later surface a bogus "previous collection had N products" notice
pointing at deleted rows. `deleteHistory` (`:35-41`) has the same non-atomicity: history row deleted
first, then products; an interruption orphans the products.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/db/history.ts` | modify | Transactional, scoped deletes |
| `src/entrypoints/sidepanel/components/HistoryTab.tsx` | modify | Confirmation copy states that products are deleted |

### Implementation Details
```ts
export async function clearAllHistory(): Promise<void> {
  await db.transaction('rw', [db.history, db.products, db.sessions], async () => {
    const keys = (await db.history.toArray()).map((h) => h.sessionKey).filter(Boolean);
    await db.history.clear();
    for (const k of keys) await db.products.where('sessionKey').equals(k).delete();
    for (const k of keys) await db.sessions.delete(k);
  });
}
```
This scopes the product delete to sessions that actually have a history row. **Decision required:**
products belonging to a session with *no* history row (e.g. an interrupted run) currently survive
`clearAllHistory` under this implementation but are destroyed today. Preserving them is the safer and
more predictable behaviour; if you want a true "delete everything", expose it as a separate, more
explicitly-worded action. Flagged for approval.

`deleteHistory` gets the same transaction wrapper plus `db.sessions.delete(entry.sessionKey)`.

### Testing and Verification
1. Create 2 history entries + 1 active session with products → `clearAllHistory()` → assert the
   active session's products **survive**, both history rows are gone, and no orphaned session rows
   remain.
2. Kill the DB mid-transaction (simulate by throwing inside the transaction callback) → assert nothing
   was deleted.
3. `deleteHistory(id)` → assert history row, its products, and its session row are all gone, and other
   sessions are untouched.
4. `tests/history-preview-export.test.tsx` — check whether it asserts `clearAllHistory` wipes
   products; if so, that assertion encodes the current (destructive) behaviour and must be updated
   deliberately.

---

## Phase 4 exit criteria

- [ ] `history.startedAt < history.completedAt` for every recorded run
- [ ] `updateSessionStatus` never silently drops (upsert verified)
- [ ] One sessionKey format across `createSession` and `background.ts`
- [ ] After a simulated worker restart, products land under the original sessionKey and History is not fabricated
- [ ] Recovery selects the most recent session for the current tab, verified with a lexicographic-vs-chronological fixture
- [ ] `pruneOldSessions` exists and is called; `deleteSession`/`clearAllSessions`/`getActiveSession`/`getSession`/`getExistingASINs` all have callers
- [ ] `COLLECTION_PROGRESS.collected` is monotonically non-decreasing across resume and reload-and-retry
- [ ] `clearAllHistory` is transactional and scoped; the confirmation copy matches the behaviour
- [ ] `tsc --noEmit` at **104** errors · `vitest run` at **≥ 143** passing · `wxt build` OK
