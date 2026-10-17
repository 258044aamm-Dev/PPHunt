# Phase 2 — Messaging Foundation

**Issues addressed:** C‑2 (dead + throwing validation layer) · H‑3 (router throws) · L‑1 (`targetCount` bounds) · L‑5 (`'interrupted'` enum gap) · H‑2 (invalid `executeScript` path)
**Estimated effort:** Medium · **Prerequisites:** Phase 0 · **Blocks:** Phase 3, Phase 4

> ⚠️ **This is the highest-risk phase in the plan (risk R1).** Enabling validation can break
> collection outright if the schema disagrees with what the app actually sends. The steps below are
> therefore ordered so that the schema is *repaired and proven conformant* before any router is wired
> to it. **Do not reorder Step 2.3 and Step 2.4.**

---

## Step 2.1 — Create the missing `ScrapedProductSchema`

### Objective
Make `src/lib/schemas/messages.ts:2` resolve. Today it imports a member that does not exist, which is
why `z.array(undefined)` is constructed and why the whole module throws at parse time.

### Root Cause
`messages.ts:2` reads `import { ScrapedProductSchema } from './product'`, but
`src/lib/schemas/product.ts` exports only `ProductSchema` and `ValidatedProduct`. In Zod 4,
`z.array(undefined)` does **not** throw at construction — it throws lazily at parse time when it
dereferences `undefined._zod`. Verified by probe:
```
ProductsCollectedMessageSchema.safeParse({ ... products: [ {…} ] })
  → THREW: TypeError: Cannot read properties of undefined (reading '_zod')
```
An **empty** `products: []` reports `success: true`, which is why a naive smoke test would pass.
Because `amazon.content.ts:13` imports the module with `import type`, esbuild elides it entirely —
`grep -rl "ExtensionMessageSchema" dist/` returns nothing, confirming the file is absent from every
shipped bundle.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/schemas/scraped-product.ts` | **create** | `ScrapedProductSchema` mirroring the `ScrapedProduct` interface |
| `src/lib/schemas/product.ts` | modify | Re-export `ScrapedProductSchema` so the existing `./product` import path resolves |
| `src/lib/schemas/index.ts` | **create** | Barrel: `ExtensionMessageSchema`, `type Message`, and the individual message schemas |

### Implementation Details

`ProductSchema` **cannot** simply be re-exported as `ScrapedProductSchema`: it requires `collectedAt`
and `sessionKey` (`product.ts:28-29`), which the content script does not send — those are added by
`background.ts` during persistence. The wire shape is defined by
`src/types/common.ts:57-82`:

```ts
// src/lib/schemas/scraped-product.ts
import { z } from 'zod';

/**
 * Wire format sent by the content script inside PRODUCTS_COLLECTED.
 * Deliberately looser than ProductSchema: `collectedAt` and `sessionKey` are
 * stamped by the background script during persistence, not by the scraper.
 */
export const ScrapedProductSchema = z.object({
  asin: z.string().min(1),
  url: z.string(),                                   // see note below — not .url()
  title: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  listPrice: z.number().nullable().optional(),
  discountPercentage: z.string().nullable().optional(),
  dealBadge: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  reviewCount: z.number().nullable().optional(),
  bestSellersRank: z.string().nullable().optional(),
  pastMonthSales: z.string().nullable().optional(),
  coupon: z.string().nullable().optional(),
  badge: z.string().nullable().optional(),
  delivery: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  isSponsored: z.boolean().optional(),
  isPrime: z.boolean().optional(),
  brand: z.string().nullable().optional(),
  availability: z.string().nullable().optional(),
  seller: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  features: z.array(z.string()).optional(),
  source: z.enum(['search', 'detail', 'category']),
});

export type ScrapedProductWire = z.infer<typeof ScrapedProductSchema>;
```

Three deliberate loosenings relative to `ProductSchema`, each of which prevents a real product from
being silently discarded once validation goes live:

1. **`url: z.string()` not `z.string().url()`.** The scraper emits relative or protocol-less URLs in
   some paths; `resolveProductUrl` (`field-parsers.ts:1305`) is what canonicalises them, and that runs
   *after* the message is accepted. A strict `.url()` here would reject products the app currently
   stores fine.
2. **`imageUrl` / `rating` / `reviewCount` unvalidated beyond type.** Same reasoning — normalisation
   is the parser's job, and the message layer's job is to reject *structurally wrong* messages.
3. **`source` enum matches `ProductSource` exactly** (`types/common.ts:8`). Verified: the
   `page-detector`'s `'bestsellers'` page type never becomes a `source` value, so no gap exists here.

`src/lib/schemas/product.ts` gains one line so the existing import path keeps working:
```ts
export { ScrapedProductSchema } from './scraped-product';
```

`src/lib/schemas/index.ts` (new barrel) exports `ExtensionMessageSchema`, the 14 individual message
schemas, `ProductSchema`, `ScrapedProductSchema`, `SettingsSchema`, and — critically — the type the
content script has been trying to import:
```ts
export type Message = z.infer<typeof ExtensionMessageSchema>;
```
This resolves the second type error, `amazon.content.ts(13,15): TS2305: Module '"@/lib/schemas/messages"' has no exported member 'Message'`, by changing that import to `@/lib/schemas`.

### Testing and Verification
- `npx tsc --noEmit` drops by 2 (the two TS2305 errors).
- New test in `tests/message-schema-conformance.test.ts` (created in Step 2.3): `safeParse` with a
  **single-element** `products` array returns `success: true` — this is the assertion that fails
  today with a `TypeError`.
- Round-trip test: take the output of `validateAndNormalizeScrapedProduct` for an existing fixture
  and assert `ScrapedProductSchema.safeParse(...)` succeeds. This proves the wire schema accepts what
  the scraper really produces.

---

## Step 2.2 — L‑1 + L‑5: reconcile schema bounds and enums with the app

### Objective
Make the schema agree with what the UI allows and what the app writes, **before** validation is
turned on. Skipping this step and going straight to Step 2.4 would break collection.

### Root Cause
**L‑1.** `targetCount` is `z.number().int().min(10).max(500)` at `messages.ts:35, 45, 78`. But:
- `src/constants/defaults.ts:16-17` defines `TARGET_MIN = 1`, `TARGET_MAX = 1000`
- `TargetSelector.tsx:92-93` and `SettingsOverlay.tsx:262-263` use those constants
- `SettingsSchema:35` allows `min(1).max(1000)`
- `spec/11-messaging-protocol.md:42,83` says "positive integer"; `PLAN.md:1019,1050` says `.positive()`

Verified by probe: `1 → INVALID (>=10)`, `9 → INVALID`, `10 → VALID`, `500 → VALID`,
`501 → INVALID (<=500)`, `1000 → INVALID`.

**L‑5.** `CollectionStatusSchema` (`messages.ts:6-12`) lists 5 statuses; `src/types/session.ts:1-7`
lists 6 including `'interrupted'`. `background.ts:682` and `useSessionRecovery.ts:72, 86, 112` all
write `'interrupted'`. Probe confirms `CollectionStatusSchema.safeParse('interrupted') → INVALID`.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/schemas/messages.ts` | modify | `targetCount` bounds (3 sites), `CollectionStatusSchema` enum |
| `src/constants/defaults.ts` | modify | Export `TARGET_MIN`/`TARGET_MAX` as the single source the schema also reads |

### Implementation Details
```ts
// messages.ts
+ import { TARGET_MIN, TARGET_MAX } from '@/constants/defaults';

  export const CollectionStatusSchema = z.enum([
    'idle', 'collecting', 'paused', 'completed', 'error',
+   'interrupted',
  ]);

- targetCount: z.number().int().min(10).max(500),
+ targetCount: z.number().int().min(TARGET_MIN).max(TARGET_MAX),
```
Importing the constants rather than duplicating `1`/`1000` is what makes this stick: the UI, the
settings schema and the message schema then cannot drift apart again.

`CollectionStatusSchema` is used by both `CollectionProgressMessageSchema` and
`UpdateProgressMessageSchema`, so adding `'interrupted'` also lets the UI's `setStatus` accept it
(see Phase 9 / `StatusBar.tsx` note below).

**Watch item — `StatusBar.tsx:3-9`.** `STATUS_CONFIG` is `Record<CollectionStatus, ...>` keyed on the
*store's* `CollectionStatus` type, and `StatusBar.tsx:21` does
`const { label, color } = STATUS_CONFIG[status]` with no guard. If Phase 4 ever forwards
`'interrupted'` to the store, this destructures `undefined` and throws. Phase 2 must **not** change
the store's type; Phase 4 Step 4.4 explicitly maps `'interrupted'` → `'paused'` at the UI boundary and
adds the guard. This cross-phase constraint is recorded here so it is not lost.

### Testing and Verification
- Probe cases become assertions: `targetCount` accepts 1 and 1000, rejects 0 and 1001;
  `CollectionStatusSchema` accepts all six statuses.
- `tests/settings-overlay.test.tsx` writes `defaultTargetCount: 250` (line 60) — currently valid
  under both bounds, must stay valid.
- A guard test asserting `TARGET_MIN`/`TARGET_MAX` are the *only* places those numbers appear in
  `src/` (prevents re-drift).

---

## Step 2.3 — Conformance test: prove the schema accepts every message the app sends

### Objective
Before wiring validation, mechanically prove that every message the app actually emits passes
`ExtensionMessageSchema`. This is the control that makes Step 2.4 safe.

### Root Cause
Not a defect — the mitigation for risk R1. The schema has never been executed, so nobody knows
whether it matches reality.

### Files Involved
| File | Action | Responsibility |
|---|---|---|
| `tests/message-schema-conformance.test.ts` | **create** | One case per message type, built from the real call sites |

### Implementation Details
Enumerate every `runtime.sendMessage` / `tabs.sendMessage` call site and assert its literal payload
shape validates. The complete inventory, gathered by grep:

| Message | Emitted at | Payload shape to test |
|---|---|---|
| `START_COLLECTION` | `CollectionControls.tsx` | `{mode, targetCount, tabId, sessionKey}` |
| `RELOAD_AND_RETRY_COLLECTION` | `CollectionControls.tsx`, `App.tsx` | same |
| `PAUSE_COLLECTION` / `RESUME_COLLECTION` / `STOP_COLLECTION` | `CollectionControls.tsx` | `{tabId}` |
| `COLLECT_PRODUCTS` | `background.ts:442-443`, `background.ts:473-474` | `{mode, targetCount}` + Phase 3's scroll fields + Phase 4's `existingAsins` |
| `PAUSE_SCROLLING` / `RESUME_SCROLLING` / `STOP_COLLECTION_CMD` | `background.ts` | **no payload** |
| `PRODUCTS_COLLECTED` | `amazon.content.ts:99-104, 221-226, 317-322` | `{products, totalCount, isNewBatch}` |
| `COLLECTION_PROGRESS` | `amazon.content.ts` | `{collected, target, status}` |
| `CONTENT_ERROR` | `amazon.content.ts` | `{code, message, diagnostic?}` |
| `UPDATE_PROGRESS` | `background.ts` | `{collected, target, status, error, sessionKey?, diagnostic?}` |
| `TAB_STATUS_CHANGED` | `background.ts` | `{tabId, url, isAmazon, pageType}` |

Two things this test must specifically cover, because both are payload-less and therefore exercise
the `undefined` path that H‑3 crashes on:
- `PAUSE_SCROLLING`, `RESUME_SCROLLING`, `STOP_COLLECTION_CMD` have **no `payload` key at all** in
  the schema (`messages.ts:82-92`) and none at the call sites. The schema must accept their absence
  and the router must not destructure it.
- Every `ErrorCodeSchema` member is asserted to be a superset of the codes actually used. Verified
  already: `src/` uses 8 codes (`BLOCKED`, `CAPTCHA`, `NOT_AMAZON`, `RATE_LIMITED`,
  `SCRIPT_DISCONNECTED`, `SIGN_IN`, `TAB_CLOSED`, `UNKNOWN`); the schema declares 12. **No gap.**

### Testing and Verification
The file itself is the deliverable: ~16 tests, all passing after Steps 2.1–2.2. If any fails, the
schema is wrong and Step 2.4 must not proceed.

---

## Step 2.4 — H‑3 + C‑2: wire validation into both routers

### Objective
`spec/11-messaging-protocol.md:161-170` and `ARCHITECTURE.md` both state that every message is
Zod-validated and that invalid messages are discarded **without throwing**. Make that true.

### Root Cause
**H‑3.** `background.ts:421` does `const msg = message as { type: string; payload?: any }` — a type
assertion, not validation. `payload` is declared optional then destructured unconditionally at lines
426, 463, 482, 491, 500, 512, 531, 595. There is **no `try/catch` around the `switch`**, and
`sendResponse?.({ ok: true })` sits at line 638 *after* the switch, so a throw skips it and the
sender sees a closed channel. Verified by driving the real listener:

```
START_COLLECTION     → THREW: Cannot destructure property 'mode'      of 'msg.payload' as it is undefined.
PAUSE_COLLECTION     → THREW: Cannot destructure property 'tabId'     of 'msg.payload' as it is undefined.
RESUME_COLLECTION    → THREW: Cannot destructure property 'tabId'     of 'msg.payload' as it is undefined.
STOP_COLLECTION      → THREW: Cannot destructure property 'tabId'     of 'msg.payload' as it is undefined.
PRODUCTS_COLLECTED   → THREW: Cannot destructure property 'products'  of 'msg.payload' as it is undefined.
COLLECTION_PROGRESS  → THREW: Cannot destructure property 'collected' of 'msg.payload' as it is undefined.
CONTENT_ERROR        → THREW: Cannot destructure property 'code'      of 'msg.payload' as it is undefined.
sendResponse calls: 0
```
The content script's own handler (`amazon.content.ts:302-346`) *does* have a top-level `try/catch` and
does not destructure — so the two routers have inconsistent robustness today.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/background.ts` | modify | Validate at the top of the `onMessage` listener; keep a `try/catch` as belt-and-braces |
| `src/entrypoints/amazon.content.ts` | modify | Same treatment for its listener; import `Message` from the barrel |
| `tests/background-router-robustness.test.ts` | **create** | All message types × malformed payloads → no throw, `sendResponse` called once |

### Implementation Details

**`background.ts`** — replace the cast at line 421 and guard before the switch:
```ts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
-  const msg = message as { type: string; payload?: any };
-  if (!msg?.type) return false;
+  const parsed = ExtensionMessageSchema.safeParse(message);
+  if (!parsed.success) {
+    console.warn('[BG] Discarding invalid message', parsed.error.issues);
+    sendResponse?.({ ok: false, error: 'INVALID_MESSAGE' });
+    return false;
+  }
+  const msg = parsed.data;

+  try {
     switch (msg.type) { ... }
+  } catch (err) {
+    console.error('[BG] Unhandled error in message router', err);
+    sendResponse?.({ ok: false, error: 'INTERNAL_ERROR' });
+    return false;
+  }

   sendResponse?.({ ok: true });
   return false;
});
```
Two design points:
- The `try/catch` stays **even though** validation should make it unreachable. `spec:170` says "do NOT
  crash or throw", and a handler that can throw synchronously (e.g. a Dexie `DatabaseClosedError`
  during teardown — already visible in the test log as
  `[PPHunt] Settings initialization error: [DexieError [DatabaseClosedError]]`) must not take the
  whole listener down.
- Because `msg` is now a discriminated union, `msg.payload` is correctly typed per branch and the
  `payload?: any` escape hatch disappears. This is what makes the payload-less message types safe:
  their branches simply don't reference `msg.payload`.

**Type narrowing caveat.** Several branches currently pass `msg.payload` fields into helpers typed
against looser shapes (e.g. `persistCollectedProducts(products)` expects `ScrapedProduct[]`). Once
`msg` is the inferred union, `PRODUCTS_COLLECTED`'s `products` is `ScrapedProductWire[]`, which may
need a cast or a signature widening at the helper. Budget for 2–4 small signature adjustments; do
**not** reintroduce `as any`.

**`amazon.content.ts`** — same pattern at its listener, and change line 13 from
`import type { Message } from '@/lib/schemas/messages'` to `import type { Message } from '@/lib/schemas'`.
Note the content script **acks immediately** at line 278
(`sendResponse?.({ ok: true })` before doing work) to avoid the message channel timing out during
heavy DOM parsing — that ordering must be preserved, so validation must happen before the ack, not
after.

### Dependencies and Order
- **Hard prerequisite:** Steps 2.1, 2.2 and 2.3 must all be complete and green.
- **Phase 3 depends on this** — it adds new payload fields (`scrollSpeed`, `scrollInterval`,
  `waitAfterScroll`, `existingAsins`) to `CollectProductsMessageSchema`, which only matters once the
  schema is actually enforced.
- **Phase 4 depends on this** for the same reason.

### Testing and Verification
**New `tests/background-router-robustness.test.ts`** — the test that fails today:
```
for each of the 14 message types:
  for each payload in [undefined, null, {}, { wrong: 'shape' }]:
    → listener does NOT throw
    → sendResponse called exactly once
    → returns false
```
Plus:
- Unknown `type` → `false`, no `sendResponse` (preserves current behaviour at `background.ts:634-635`).
- A valid `PRODUCTS_COLLECTED` with one product still persists (end-to-end through the real router).
- `grep -q "ExtensionMessageSchema" dist/chrome-mv3/background.js` after `npx wxt build` — proves the
  schema is no longer tree-shaken out. Add this as a CI assertion in Phase 10.

**Regression:** all 71 pre-existing tests, plus everything added in Phases 0–1.
`tests/error-recovery-and-resilience.test.tsx` sends messages through a mocked `browser.runtime`;
those mocks must now send schema-valid payloads — expect 1–3 fixture updates in that file, each of
which is a *correct* tightening.

---

## Step 2.5 — H‑2: fix the `executeScript` path and the fallback that it disables

### Objective
Make content-script re-injection work, and make its DOM-bridge fallback reachable when injection
fails.

### Root Cause
`background.ts:164` (inside `sendToContentScriptWithRecovery`, lines 130-247):
```ts
files: ['content-scripts/amazon.js'],
```
WXT's generated `.wxt/types/paths.d.ts:5-18` enumerates canonical public paths; the content script is
`"/content-scripts/amazon.js"` — **with** a leading slash. `tsc` confirms:
```
background.ts(164,21): error TS2820: Type '"content-scripts/amazon.js"' is not assignable to type
'ScriptPublicPath'. Did you mean '"/content-scripts/amazon.js"'?
```

The worse half is the control flow. The `func`-based DOM bridge (added in commit `bea9836`) is nested
*inside* the same `try` as the `files`-based injection:
```ts
try {
  if (browser.scripting?.executeScript) {
    await browser.scripting.executeScript({ target:{tabId}, files:['content-scripts/amazon.js'] });  // (A)
    try { await browser.tabs.sendMessage(...); return; }
    catch { ... await browser.scripting.executeScript({ func: ... }); return; }                       // (B) fallback
  }
} catch (retryErr) { finalErr = retryErr; }                                                           // (C)
```
If (A) rejects, control jumps to (C) and **(B) is never reached** — the one bug disables both the
primary recovery and the safety net built for it. Any `executeScript` rejection (tab closed,
restricted page, `INJECTION_BLOCKED`) permanently disables the bridge.

`tests/error-recovery-and-resilience.test.tsx:284-289` asserts the **broken string** and its mock
always resolves `[{ result: true }]`, so the invalid path is never rejected. The test enshrines the
defect and will fail when it is corrected — that failure is expected and intentional.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/background.ts` | modify | Path literal at line 164; restructure the nested `try` |
| `tests/error-recovery-and-resilience.test.tsx` | modify | Update the assertion at line 287; add a rejecting-`executeScript` case |

### Implementation Details
```ts
- files: ['content-scripts/amazon.js'],
+ files: ['/content-scripts/amazon.js'],
```
and restructure so the bridge runs on injection failure:
```ts
let injected = false;
try {
  await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/amazon.js'] });
  injected = true;
} catch (injectErr) {
  console.warn('[BG] executeScript(files) failed, falling back to DOM bridge', injectErr);
}

if (injected) {
  try { await browser.tabs.sendMessage(tabId, message); return; }
  catch { /* fall through to the bridge */ }
}

try {
  await browser.scripting.executeScript({ target: { tabId }, func: /* bridge installer */ });
  // dispatch via CustomEvent
  return;
} catch (bridgeErr) {
  finalErr = bridgeErr;
}
```
The behavioural change is that the bridge now runs when injection fails, not only when injection
succeeds but `sendMessage` fails.

### Dependencies and Order
Independent of Steps 2.1–2.4. Should land in the same phase because it is the last remaining
`background.ts` type error and because both touch the same file.

### Testing and Verification
1. Update `error-recovery-and-resilience.test.tsx:287` to `files: ['/content-scripts/amazon.js']`.
2. **New test that fails today:** `executeScript` **rejects** on the first call → assert the
   `func`-based bridge call still happens. Currently it does not.
3. `npx tsc --noEmit` drops the TS2820 error.
4. **Manual (Phase 11, item 1) — this is the part that could not be verified in the sandbox.** Chrome
   may in practice tolerate the slash-less path; the type contract forbids it either way, and the
   control-flow defect is real regardless. Load `dist/chrome-mv3` unpacked, orphan the content script
   (reload the extension mid-session), press Start, and confirm recovery succeeds with a clean
   service-worker console.

---

## Phase 2 exit criteria

- [ ] `ScrapedProductSchema` exists; `safeParse` with a non-empty `products` array returns `success: true`
- [ ] `export type Message` resolves; `amazon.content.ts` imports it from `@/lib/schemas`
- [ ] `targetCount` accepts 1–1000; `CollectionStatusSchema` includes `'interrupted'`
- [ ] All 14 message types validate against real call-site payloads (`tests/message-schema-conformance.test.ts`)
- [ ] All 14 message types × 4 malformed payloads → no throw, `sendResponse` called once
- [ ] `executeScript` uses `'/content-scripts/amazon.js'` and the bridge runs when injection rejects
- [ ] `grep -q "ExtensionMessageSchema" dist/chrome-mv3/background.js` succeeds after a build
- [ ] `tsc --noEmit` at **104** errors · `vitest run` at **≥ 117** passing · `wxt build` OK
