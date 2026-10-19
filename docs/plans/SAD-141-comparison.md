# SAD-141 — Side-by-side review of the two plans

**Purpose:** compare our plan (v1, `docs/plans/SAD-141-one-click-product-saving.md`, Linear comments `77a5ea54…` + `4dcb3ea3…`) with the independently revised plan posted in the same thread (Linear comment `8fdc9555…` Part 1 + `62daab08…` Part 2, workspace copy `docs/plans/SAD-141-one-click-save.md`), then fold the stronger ideas into **v2** of our plan rather than picking a winner wholesale.

**Baseline:** both plans target the same commit, `f7a8478` (main). Both report the same baseline numbers (tsc clean, 385 tests / 48 files, `wxt build` OK, `npm audit` 0 vulns), which match what we measured ourselves.

---

## 0. Evidence boundary — what could and could not be read

The Linear connector elides the middle of long comment bodies, so neither plan is fully readable through the API. This review only compares text that was actually retrieved; nothing is attributed by inference.

| Source | Readable | Not readable |
|---|---|---|
| Their Part 1 (`8fdc9555…`) | §0 verification log, §1 executive summary, §2.1–§2.5 (topology, assumptions-vs-reality, data model, message registries, integration surfaces), §3 gap table, §4 field map (head only) | §4 tail, §5.1–§5.4 (their resolver + affordance design) |
| Their Part 2 (`62daab08…`) | §5.5 routing, §5.6 persistence/MV3, §5.7 enrichment, §5.8 export, §5.9 messages, §5.10 manifest/permissions, §5.12 UI impact, §6 file list, §7 Phases 1–2 (partial), Appendix A (why not `sessions`), B (`addProducts` safety), C (jsdom spike 7/7) | §7 Phase 3–6 details, §8–§11 |
| Our plan v1 | Everything (workspace) | — |

Two consequences, both load-bearing for fairness:

1. **Their resolver, card-UI and risk sections were never read.** Where our plan has more visible detail (§8 button states, §12 field map, §14 tests, §15 risks, App C traceability), that reflects *readability*, not necessarily absence in theirs. The scorecard says "not comparable" instead of scoring those.
2. **Our earlier reading of "their §7.2" was wrong.** The text "Pointer missing, history has → most recent history entry becomes current" and "`createSession(tabId ?? 0, …)`" that appeared in a truncated connector payload is **our own v1 text** (matched by `ASSIGN_SAVED_PRODUCT`, `1 of 2`). It is not their design, so it is not used as a point against them — but it did surface a real defect in *our* plan (see §3.1).

---

## 1. Verdict

Both plans converge on the same spine — content script owns DOM, background owns state, offscreen document owns `DOMParser`, one shared pipeline, `sessionKey` as the collection identity, `addProducts` for dedupe, save-first-then-route for Ask, no auto-download by default, and never reusing `UPDATE_PROGRESS`. That convergence is itself the strongest signal in either document: two independent passes over the same commit reached the same architecture.

The differences are concentrated in **collection persistence semantics** — and there their plan is materially better than ours:

- It persists one-click collections as `history` + `products` rows **only**, deliberately without a `sessions` row (Appendix A).
- It keeps the one-click pointer in its own `storage.local` key, separate from the full-page controller's pointer.
- It names the three concrete failure modes of reusing `sessions`, two of which our v1 actually triggers, one of which is **silent data loss after 30 days**.

Everything else is a trade-off (download permission vs. dependency-freedom), a tie, or ours is stronger (message contract with `jobId` + retry + error taxonomy, field coverage, acceptance traceability, risk register, button state machine).

**v2 therefore adopts 8 items from their plan, rejects 3, and keeps 9 of ours.** The adopted items are all in §3; the full change list is §5.

---

## 2. Scorecard

Legend: **◀ theirs** = their plan is stronger · **ours ▶** = our plan is stronger · **=** = converge or equal · **n/c** = not comparable (unreadable section).

### 2.1 Architecture, persistence, state

| # | Dimension | Our v1 | Their revised | Verdict | Evidence |
|---|---|---|---|---|---|
| A1 | Verification log | Baseline commands + results (§1, §13) | Same commands, same numbers, plus per-item "what jsdom cannot prove" caveat | = | Both executable; theirs explicitly scopes the spike's limits |
| A2 | Routing of a "collection" | `sessionKey` on `products`/`history` (§6) | Same, with `oc_<epochMs>` prefix | = | `db.products.where('sessionKey')`, `addHistoryEntry` upsert |
| A3 | **Persistence of one-click collections** | Writes a `sessions` row (`createSession` + `updateSessionStatus('completed')`) in Option B | **No `sessions` row ever**; history + products only (App A) | **◀ theirs** | `pruneOldSessions()` deletes products for any non-active session older than 30 days (`db/sessions.ts:204–232`) → our Option B silently deletes curated one-click collections a month later |
| A4 | **Current-collection pointer** | One key `pphuntCurrentCollection`, also written on `START_COLLECTION`; stale pointer falls back to *most recent history entry* | Dedicated `pphunt.oneClickCollection`; missing/stale ⇒ create `oc_<ts>` | **◀ theirs** | Ours lets a finished full-page session be adopted silently, and a *new* one-click save can land inside an unrelated 500-product collection. Their rule is create-new, never adopt |
| A5 | Save into a **live** `collecting` session | Explicitly allowed ("quick-saves join it", §7.5) | Not stated in readable text; App A argues one-click must stay out of the session state machine entirely | **◀ theirs (by implication)** | Joining a live run mutates a target-counted collection mid-scrape; `active.lastCollectedCount` (`handler.ts:387`) then disagrees with the DB until completion recomputes it |
| A6 | MV3 restart survival of in-flight jobs | Job state + `storage.session` mirror (§9) | `Map<asin, JobState>` + `storage.session` mirror; restart ⇒ `partial` (not `failed`) | = | Same mechanism; ours already defines `enrichmentStatus: 'partial'` and "never `failed` after the row is persisted" |
| A7 | Ask-every-time safety property | Persist first, then dialog; Cancel keeps the row (§7.4) | "Save first, then route"; Cancel leaves the row where it was | **=** | Independently identical; the strongest single convergence in either document |
| A8 | Dedupe / no blanking | Reuses `addProducts` (§2) | Reuses `addProducts`, plus an explicit App B walk-through | = | `addProducts` dedupes against existing rows for the sessionKey and calls `enrichStoredProductFields` fill-only (`db/products.ts:67–140`) |
| A8b | Re-save policy for volatile fields | Explicit `upsertProductFromQuickSave()`: non-null overwrite of price/BSR/availability **+** a snapshot per save (§6.4) | Pure `addProducts` fill-only; a changed price never updates the row, and price history is deferred to their snapshot phase | **ours ▶** | With snapshots present, refreshing the current price is non-destructive and keeps the table honest; the guard is that enrichment merges stay fill-only and nulls never overwrite |
| A9 | Concurrency between saves | `pendingProductsChain` reuse | Same, named explicitly | = | `handler.ts:191` |

### 2.2 Extraction, UI, enrichment

| # | Dimension | Our v1 | Their revised | Verdict | Evidence |
|---|---|---|---|---|---|
| B1 | Right-click target capture | `contextmenu` + pointer-move `elementFromPoint` fallback (§8.1) | Same constraint identified (§1.4), design in their §5.4 (unread) | = / n/c | Chrome gives no element or coordinates in `OnClickData` |
| B2 | Element → card resolution | Explicit tiers: excluded subtrees → known card selectors → clamp nested cards → structural `/dp/` anchor → PDP fallback (§8.1) | "Walk up to the nearest card root, then let the parser veto", ~30 lines (App C) | **ours ▶** | Ours specifies exclusion scopes, nested-card clamping and the PDP branch; theirs is a shorter summary (may be equal in their §5.4, unread) |
| B3 | Resolver evidence | Research only | **Executed** jsdom spike, 7/7 (App C) | **◀ theirs**, now matched | We reproduced an 8/8 equivalent independently (§4) — see the caveat we found in B4 |
| B4 | Structural fallback source | Hand-rolled `structuralCardFromAnchor` | Not stated | **◀ theirs (implicitly)** — neither uses what exists | `discoverStructuralProductCards()` (`field-parsers.ts:1453`) already does anchor→ASIN→bounded-ancestor discovery with subtree exclusions; v2 reuses it instead of new code |
| B5 | Card button states | Full 6-state machine + visual/interaction table + partial-enrichment warning dot (§8.2) | Module named; states covered by their §8–§9 (unread) | n/c | Ours is explicit; no basis to compare |
| B6 | Injection performance / teardown | `MutationObserver` + `IntersectionObserver`, dedupe by `data-asin`, `__PPHUNT_CONTENT_CLEANUP__` | `card-affordance.ts`: fixed overlay layer, IntersectionObserver, MutationObserver, teardown | = | Same primitives, same cleanup hook (`amazon.content.ts`) |
| B7 | Enrichment transport | Background `fetch` → offscreen `DOM_PARSER` → `parseAmazonProductDetail` → fill-only merge (§10) | Same, plus option table rejecting hidden tabs / SW parse / tab navigation | = | Content-script CORS since Chrome 85 forbids the content-script path; SW has no `DOMParser` |
| B8 | Offscreen lifecycle | `getContexts` mentioned once | `getContexts` + idempotent `createDocument`, single justification | **◀ theirs (marginally)** | `hasDocument()` (116+) / `getContexts()` (116+) / catch-on-create is the robust triad; ours should specify all three |
| B9 | `<base href>` before `DOMParser` | Absent | Claimed necessary "so relative `href`/`src` resolve correctly" | **ours ▶ (claim corrected)** | **No parser reads `document.baseURI`.** `parseAmazonProductDetail` uses `getAttribute('href'/'src')` and rejects non-absolute image URLs (`field-parsers.ts:239–326`); ASIN extraction runs on the raw attribute string. `<base>` is harmless insurance, not a correctness fix — v2 keeps it with the corrected rationale |
| B10 | Enrichment guardrails | Concurrency 1–2, retry, breaker 3, captcha → skip, skip during full-page run (§10) | Concurrency 1, 1 retry, breaker 3, skip during full-page run, captcha ⇒ `enrichmentSkipped: 'blocked'` | = | Same thresholds; our breaker count identical |
| B11 | Enrichment failure taxonomy | `ENRICH_FETCH_FAILED` / `ENRICH_PARSE_FAILED` / `OFFSCREEN_UNAVAILABLE` + `enrichmentStatus` | `enrichmentSkipped: 'blocked'` | **ours ▶** | Our error codes are part of the message contract and testable |

### 2.3 Export, permissions, panel

| # | Dimension | Our v1 | Their revised | Verdict | Evidence |
|---|---|---|---|---|---|
| C1 | Export default | On-demand, toast action, `quickSaveAutoDownload` default `false` (§11.3) | No auto-download by default, `autoDownloadOnSave` off, toast action | **=** | Same reading of "generate a file" vs "no duplicate downloads" |
| C2 | Download mechanism | Offscreen Blob URL → `chrome.downloads.download` (§11.2) | Offscreen `Blob` + `<a download>`, no `downloads` permission; flagged "must verify gesture" | **trade-off** | Ours is deterministic and supports `conflictAction`; theirs avoids a permission warning but rests on an unverified gesture rule. v2 keeps `downloads` as shipping default **behind an explicit drop-it verification gate** (§3.6) |
| C3 | Permission set | `contextMenus` + `offscreen` + `downloads` | `contextMenus` + `offscreen` only | **◀ theirs on least privilege**, ours on determinism | Both silent except `downloads` ("Manage your downloads") |
| C4 | Message contract | 6 types, `jobId`, `ASSIGN_SAVED_PRODUCT`, `RETRY_SAVE_PRODUCT`, `EXPORT_SAVED_PRODUCT`, `errorCode` enum, `requiresCollectionChoice` | 4 types, `ONE_CLICK_SAVE_STATUS` with `status: pending/saved/enriching/failed/no_product` | **ours ▶** | `jobId` is what makes retry, per-card state and dedupe of concurrent clicks possible; `no_product` maps to our `errorCode: 'NO_PRODUCT'` |
| C5 | `UPDATE_PROGRESS` isolation | Explicitly not reused (§5.3, App A) | Explicitly not reused, with the exact failure (`sidepanel/App.tsx` sets `collecting`, overwrites counter, flips `currentSessionKey`) | **=** | Confirmed in `sidepanel/App.tsx:136–190` |
| C6 | Host-permission gap | 12 of 22 content-match domains missing; fix by deriving patterns from `AMAZON_MARKETPLACE_DOMAINS` (§2, §13) | Same 12, **plus** the sharper consequence: on those 12, `dispatchToAmazonTab`'s `scripting.executeScript` re-injection has no permission, so a context-menu save silently fails after a service-worker restart; **plus** `amazon.co.za` in `isAmazonUrl()` but absent from `matches` | **◀ theirs** | Verified: `wxt.config.ts:31–46` lists 10 Amazon domains; `amazon.content.ts:19–42` matches 22 (no `co.za`); `amazon-url.ts:15` has `amazon.co.za` |
| C7 | Panel UI impact | Settings section, `HistoryEntry` label/origin, `HistoryTab` empty state, `useCurrentCollection`, "Make current" | Same three edits with line refs (`HistoryEntry.tsx:66,84`, `HistoryTab.tsx:96`), plus optional Collect-tab card as open question D7 | **=** | `CollectTab.tsx` has no table; the table lives only in `FullWidthPreviewModal` (`sessionKey={selectedSessionKey}`) |

### 2.4 Process, tests, risk

| # | Dimension | Our v1 | Their revised | Verdict | Evidence |
|---|---|---|---|---|---|
| D1 | Test plan | 9 new suites incl. enrichment, offscreen export, harness-mock updates (§14) | 5 suites incl. **`message-registry-sync`** | =, **adopt one** | Three registries (union / Zod discriminated union / `AMAZON_MESSAGE_TYPES`) silently drop unknown types; a sync test is cheap and catches a real trap |
| D2 | Acceptance traceability | Appendix C maps every ticket clause to a section | None readable | **ours ▶** | Directly answers the ticket's "acceptance criteria met" deliverable |
| D3 | Field coverage | §12 row-by-row map with ✅/◐/➕/⏭ and "never fabricate" rule | §4 head only (readable rows agree with ours) | **ours ▶** (on readable evidence) | Identical conclusions where both are readable |
| D4 | Effort estimates | Phases, no durations | 0.5 d foundation, 1 d context menu, table to ~7–8 dev-days | **◀ theirs** | Estimates are required to schedule; v2 adds them |
| D5 | Risks | 9-row table incl. stale target, permission warnings, Firefox offscreen, WAR | Not readable | **ours ▶** | — |
| D6 | Data retention | Silent | App A notes the trade-off: one-click collections are **not** auto-pruned after 30 days | **◀ theirs (it raises it)** | Our v1 would prune them — a bug, not a feature |

---

## 3. Adopted into v2 (with the exact change)

### 3.1 One-click collections never touch the `sessions` table *(theirs, App A)*

Our v1 Option B did `createSession(...)` + `updateSessionStatus(..., 'completed')`. That row makes `pruneOldSessions()` — which deletes `products` for every non-active session older than 30 days (`db/sessions.ts:204–232`, called on panel mount at `sidepanel/App.tsx:107` and on History mount at `HistoryTab.tsx:63`) — **silently delete hand-curated collections after a month.** It also makes one-click rows visible to `getActiveSession()` (`db/sessions.ts`) and to `reconcileInterruptedSessions()`.

**v2:** one-click collections are `history` + `products` rows only. `deleteHistory()` already tolerates a missing session row (`db/history.ts:49–66`), so Preview / Export / Delete / Clear-All keep working unchanged. Retention becomes explicit: one-click collections are never auto-pruned (manual delete only).

### 3.2 A dedicated pointer, and no silent adoption of an old collection

**v2:** `storage.local['pphunt.oneClickCollection'] = { sessionKey, label, createdAt, updatedAt }`, written only by (a) the first save into a new one-click collection and (b) explicit **Make current**. Never written by `START_COLLECTION`.

`START_COLLECTION` no longer repoints one-click saves at the user's full-page session, and the "most recent history entry becomes current" fallback is **removed** — it could drop a single product into an unrelated 500-item collection with no visible signal. On a missing/stale pointer, create `oc_<epochMs>` named from the product (or page) title.

Trade-off, stated in the plan: after a full-page run, the next right-click save opens a *new* one-click collection instead of appending to it. The toast always names the target collection, and History → **Make current** makes joining deliberate.

### 3.3 Never join a `collecting` session

**v2:** if the resolved collection is a session with `status === 'collecting'|'paused'`, or the background's `activeCollection` is non-null, the save creates/uses a one-click collection instead. Rationale: `targetCount` semantics, `lastCollectedCount` (`handler.ts:387`), and the completion dialog all belong to the full-page run; a right-click product landing inside it is invisible until the scrape ends.

### 3.4 Reuse `discoverStructuralProductCards()` for the structural fallback

Both plans hand-rolled this path. `discoverStructuralProductCards(root)` (`field-parsers.ts:1453`) already groups `/dp/` anchors by ASIN, skips carousels/sponsored/recommendation subtrees, and climbs at most 8 ancestors to the smallest card container. **v2:** tier 3 of the resolver = `discoverStructuralProductCards(document.body)` filtered to the card that contains the clicked element (via `isWithinAnyCard(el, cardSet)`), computed once per URL and cached. Less new code, already covered by existing tests.

### 3.5 Layered offscreen creation

**v2:** `runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` (Chrome 116+) → else `offscreen.hasDocument()` → else `createDocument()`, with a catch-and-retry on the "only a single offscreen document may be created" race. One `justification`, reasons `['DOM_PARSER']` for enrichment and `['BLOBS']` only when an export is actually built, so the reason list stays honest.

### 3.6 `downloads` permission behind an explicit verification gate

**v2:** ship with `downloads` (deterministic `conflictAction: 'uniquify'`, survives offscreen teardown, works without a user gesture). Add a one-paragraph gate: after Phase 5, test the offscreen `<a download>` path on Chrome + Edge; if both accept it without a gesture, drop `downloads` and switch to it. Do not *pre-commit* to the unverified path, and do not discover it in production.

### 3.7 `message-registry-sync` test

**v2:** new `tests/message-registry-sync.test.ts` asserting the three registries agree (union ↔ Zod union ↔ `AMAZON_MESSAGE_TYPES`), plus a negative case (`'ONE_CLICK_NOPE'` → `'unknown'`). Cheap, and it guards the exact trap both plans identified.

### 3.8 Effort estimates + sharper host-permission framing

**v2:** per-phase dev-day column (~1 d menu+resolver, ~1.5 d card UI, ~2 d pipeline/collections, ~2 d enrichment, ~1 d export, ~1.5 d hardening/QA ≈ 8–9 d), and the host-permission gap reframed around the *re-injection* failure, not just `fetch`. `amazon.co.za` is added to the derived pattern list: verified present in `AMAZON_MARKETPLACE_DOMAINS` (`amazon-url.ts:15`) and in `currency.ts:28`, absent from both `AMAZON_MATCH_PATTERNS` (`amazon.content.ts:19–42`) and `host_permissions` (`wxt.config.ts:31–46`).

---

## 4. Independently verified claims

| Claim | Source | Method | Result |
|---|---|---|---|
| `amazon.co.za` in `isAmazonUrl()` but absent from content-script `matches` | theirs §5.10 | `sed` on `amazon.content.ts:19–42` + `wxt.config.ts` + `amazon-url.ts` | ✅ **True** (22 patterns, no `co.za`; domain list has it; host permissions have neither) |
| 12 of 22 content-match domains missing from `host_permissions` | both | diff of the two literal lists | ✅ **True** (missing: `.mx .br .nl .se .pl .sg .ae .sa .com.tr .com.be .eg .cn`) |
| `scripting.executeScript` re-injection fails on those 12 | theirs §5.10 | `dispatchToAmazonTab` (`handler.ts:104–160`) reads permissions from the manifest | ✅ **True by construction** — the call is in the SW, so `host_permissions` governs it |
| Resolver works against the real parsers (7/7) | theirs App C | Our own throwaway spike, 8 assertions, `npx vitest run`, deleted after | ✅ **8/8** (price / title / image / background-null / footer-null / card parse / category card / PDP detect+parse) |
| `<base href>` is required for correct parsing | theirs §5.7 | grep for `baseURI`/`new URL()` in `scraper/*` + read `extractBestImageUrl` | ❌ **Overstated** — no parser reads `baseURI`; relative image URLs are rejected by design |
| `addProducts` makes repeat saves idempotent | theirs App B | `db/products.ts:67–140` | ✅ **True** — DB-level dedupe by `(sessionKey, asin)` + fill-only patch |
| `HistoryEntry` already renders `max(entry, live)` | theirs §7.2 (unread; found in ours) | `HistoryEntry.tsx:32–40` | ✅ **True** — `effectiveCount = Math.max(entry.collectedCount, liveSessionCount)` |
| `deleteHistory` tolerates a missing `sessions` row | theirs §2.3 | `db/history.ts:49–66` | ✅ **True** |

**New finding from reproducing the spike** (added to §10 of v2): the PDP price parser is **buybox-scoped** (`#corePriceDisplay_desktop_feature_div`, `#corePrice_feature_div`, `#apex_desktop`, `#buybox`, …). A fetched PDP that lacks those containers — variant redirect, stripped/mobile markup, or a bot interstitial — parses fine but returns `price: null`. Because `addProducts` is fill-only, the listing price survives; the job must therefore report `enrichmentStatus: 'partial'`, not `complete`. Our first fixture failed exactly this way until the buybox wrapper was added.

---

## 5. Rejected from their plan (and why)

| Item | Why not adopted |
|---|---|
| Offscreen `<a download>` as the **primary** export path | Still unverified for the no-gesture case; choosing it also removes the ability to set `conflictAction`/filename handling that `chrome.downloads` gives. Kept as a **verification gate**, not the default |
| `<base href>` as a correctness requirement | Verified unnecessary; kept as one line of defensive code with the honest rationale, plus a test pinning parity with/without it |
| Optional "current one-click collection" card on the Collect tab (their D7) | The user's recorded answer is *no new UI surfaces, edits to existing components only*. The card is an edit, not a new surface, so it is listed as an explicitly deferred follow-up — not in scope for this PR |
| `no_product` as a separate job status | Our state machine is `queued|extracting|enriching|completed|failed`; "no product here" is a terminal `failed` with `errorCode: 'NO_PRODUCT'`. Adding a sixth status would fork every state renderer for no gain |

*(One internal inconsistency in their text could not be checked — their §7.4 is unreadable, so the relationship between `ONE_CLICK_ROUTE_PRODUCT` (§5.9) and any assignment message is unknown. Not counted either way.)*

---

## 6. Retained from v1 (unchanged in v2)

1. Six-type message contract keyed by `jobId`, with `RETRY_SAVE_PRODUCT`, `ASSIGN_SAVED_PRODUCT`, `EXPORT_SAVED_PRODUCT` and an `errorCode` enum.
2. Full 6-state card button design (§8.2) including the partial-enrichment warning dot and the rule that a persisted row can never report `failed`.
3. §12 field-coverage map with the explicit ✅/◐/➕/⏭ legend and "never fabricate" rule, including which fields are deferred rather than faked.
4. Appendix C acceptance traceability (the ticket's own deliverable requirement).
5. §15 risk register (stale right-click target, permission warnings, Firefox offscreen absence, WAR untouched, stale `pendingProductsChain` ordering).
6. `AMAZON_MATCH_PATTERNS` extraction into a shared module so the menu's `documentUrlPatterns`, content-script `matches`, and `host_permissions` cannot drift — extended in v2 to include `amazon.co.za`.
7. Snapshot table (Dexie v2) as the only schema change, **plus** an explicit volatile-field refresh on an explicit user save (§6.4, A8b). Base `addProducts` stays fill-only, so enrichment can never blank or re-price a row; snapshots keep every observation.
8. "No new side-panel surface" — three edits to existing components.
9. `enrichmentStatus` partial semantics + `warning` string on the job update.

---

## 7. What v2 changes (section map)

| v2 section | Change | Origin |
|---|---|---|
| §1 TL;DR | Three permissions → notes the `downloads` gate; pointer bullet rewritten | ours + §3.6 |
| §2.2 / §3 gap 9 | Host-permission framing (re-injection failure) + `amazon.co.za` | theirs §5.10, verified |
| §5.2 modules | Add `db/collections.ts`; `enrichment.ts` gains offscreen-lifecycle triad | theirs §6 |
| §6 data model | One-click collections: history-only, no `sessions` row; retention rule | theirs App A |
| §7.1–§7.2 | Dedicated pointer, no adoption of most-recent history, no `START_COLLECTION` repoint | theirs §5.5 + our §3.2 |
| §7.3 | `createSession`/`updateSessionStatus` steps deleted | theirs App A |
| §7.5 | Never join a `collecting` session | our §3.3 |
| §8.1 | Structural fallback = `discoverStructuralProductCards` + `isWithinAnyCard` | our §3.4 |
| §10.2 | `<base href>` rationale corrected; offscreen triad; buybox-price caveat | theirs §5.7 + our spike |
| §11.2 | `downloads` gate; anchor path demoted to fallback | theirs §5.8 + ours |
| §13 | Dev-day estimates per phase | theirs §7 |
| §14 | `message-registry-sync` test; pointer/stale-pointer/retention/no-join tests | theirs §6 + ours |
| §15 | Retention trade-off; live-session capture risk | theirs App A |
| §16 | Decisions D1–D9 updated; D10 (downloads gate), D11 (retention), D12 (no-adopt) added | this review |
| §17 | **New**: comparison summary + adoption log | this document |

---

## 8. Open decisions for the user

| # | Decision | Default in v2 | Cost to flip |
|---|---|---|---|
| 1 | Should a completed full-page collection become the one-click target? | No — explicit **Make current** only | Low (one pointer write) |
| 2 | Keep `downloads` permission, or take the anchor path after verification? | Keep, with a gate | Low (manifest + one module) |
| 3 | Auto-download on every save for users who want it? | `autoDownloadOnSave` default `false` | Trivial |
| 4 | Add the optional "current collection" card to the Collect tab? | Deferred | ~40–60 lines |
| 5 | Snapshot table in this PR or a follow-up? | In this PR (Dexie v2, additive) | Medium |

---

## 9. Reproducing the checks

```bash
git -C PPHunt rev-parse --short HEAD          # f7a8478
npx tsc --noEmit                              # 0 diagnostics
npx vitest run                                # 48 files / 385 tests
npx wxt build                                 # dist/chrome-mv3
npm audit --omit=dev                          # 0 vulnerabilities
# resolver spike (throwaway, deleted after use): 8/8 assertions
```
