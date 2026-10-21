# SAD-384 — implementation and review handoff

Issue: https://linear.app/sad-mod/issue/SAD-384/brand-and-best-selling-rank

Branch: `fix/sad-384-collection-brand-rank`

Baseline inspected: `a10e174bc8f72dd4bab61ce54258eecdc68a5b93`

## Confirmed requirement

The owner explicitly chose missing brand and Best Sellers Rank fallback for every
collected product, regardless of the existing full-enrichment toggle or 25/50 cap.
No live failing URL/ASIN or installed version was provided. The verified cause is
the current policy gap: with the toggle off, or beyond its cap, collection did not
fetch the detail page. A specific live parser/transport failure is not claimed.

## Delivered in pushed steps

1. `520e4bf`: optional `brand-and-rank` scope on the shared enricher. Only missing
   target values can change, with consistent null/blank handling. Omitted scope
   retains the existing full merge used by right-click and icon saves.
2. `9a7f2e9`: collection scheduling independent of the full-detail budget, checking
   stored rows after batch persistence and assigning one scope per product.
3. `29a4b58`: dedicated `storage.session` collection metadata recovery, separate
   from save jobs. Persist before dispatch; restore scope/full-budget/dedupe;
   bound interruption/cooldown attempts; do not discard unrelated skipped work.
4. `397b408`: real-HTML integration tests, settings explanation, permission docs,
   changelog and policy-limitations documentation.

The final documentation commit adds this review record without changing runtime
code. Progress comments for the completed pushed steps are on the Linear issue.

## Product isolation

- Full enrichment remains opt-in and capped, using the existing shared parser,
  fetch guards, merge, concurrency limiter and snapshot path.
- Narrow fallback fills only missing `brand` and `bestSellersRank`; it does not
  update title, price, currency, rating, images, seller, features, Prime, warranty,
  placement, category, sponsorship or session identity.
- Existing fields are rechecked before fetching. Deleted rows are not recreated.
- Products qualifying for full enrichment get one fetch, not a second fallback
  fetch. Complete target-only rows need no new request.
- No product schema, DB migration, export definition or scraper selector change.
- Existing right-click/icon save callers and Temu implementation are unchanged.
- Collection counts/STOP do not wait for network enrichment. Metadata I/O is
  awaited to establish recovery state, not the request completion.

## Explicit behavior and lifetime changes

Missing-target rows can now cause requests even with Collection Enrichment OFF.
The old setting/cap controls full details, not the total PDP request count. This
network increase is intentional and necessary for the owner's clarified scope.

`alarms` is added for a named host-cooldown wakeup. Existing CAPTCHA, permission,
ASIN, timeout and circuit safeguards remain. A cooldown defers only its host;
row-specific skips do not drop another host's work. A job has at most two
dispatches, including interrupted/cooldown reattempts. Already queued work may
continue after collection completion or STOP, matching the previous queue policy.

Metadata survives worker suspension, **not browser exit**. Terminal dedupe records
expire after 24h. Recovery storage failure logs a warning and falls back to saved
listing data/in-memory work; pending-tail recovery then cannot be guaranteed.
Fields absent from Amazon stay absent, and successful title/price parsing is not
proof that brand/BSR exists. Historical collections are not backfilled.

## Final validation at runtime-code commit `397b408`

Executed in order:

```sh
npx tsc --noEmit
npm run build
npx vitest run
git diff --check
```

Results:

- TypeScript: passed.
- Chrome production build: passed, approximately 2.00 MB.
- Full suite: **1,251 tests passed across 108 files**.
- Whitespace/diff checks: clean.
- No uncommitted runtime changes after validation.

Coverage includes new OFF/25/50/all scope boundaries; real controller → guarded
fetcher with stub HTTP → actual offscreen HTML parser/normalizer → actual merge
and IndexedDB for Manual/Automatic; product 51; absent fields; duplicate batches;
restart persistence; cooldown/host isolation; storage errors; and the existing
save, context-menu, export, history, UI, MV3/router and Temu suites.

The new tests do not access live Amazon. Offscreen cross-context transport is
replaced in the integration test, not the HTML parser. The existing transport
suites still execute as part of the full suite.

Environment: Node 20.20.2. WXT 0.21.4 declares Node >=22; the above commands passed,
but maintainers should use the supported Node version in CI. Baseline dependency
audit findings from planning are not fixed or silently reclassified here; no
dependency changes were made.

## Reviewer manual checklist (not yet executed)

1. Load the built Chrome extension, including the new alarms permission.
2. Choose a listing with brand/BSR absent from cards but present on its PDP.
3. With full enrichment OFF, compare right-click/icon saves to Manual and
   Automatic collection; inspect stored rows, live preview and CSV/XLSX.
4. With full enrichment ON at 50, verify product 51 gets missing targets but not
   unrelated PDP fields. Verify at 25 and all as appropriate.
5. Check real CAPTCHA/permission failures retain listing rows without inventing
   values. With diagnostics enabled, compare collection-card, enrichment-parse
   and outcome records rather than relying on the `complete` status alone.
6. Test worker termination/restart with DevTools closed as well as open, pending
   queue recovery, cooldown wakeups, STOP and deletion during a request.
7. Confirm expected extra network traffic and post-collection asynchronous
   updates are acceptable; this is not zero-request behavior with the switch off.

Code implementation and automated verification are complete for review. Live
installed-extension acceptance is still a reviewer/release task, not a completed
measurement. Do not mark the issue Done on the basis of these automated tests alone.
