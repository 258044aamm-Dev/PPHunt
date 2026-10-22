# SAD-387 — implementation record and verification

> Branch `fix/sad-387-deal-countdown` from `main@7dc713d`, merged with
> `MergeBranch@c379da6` before landing.
> Plan and root cause: [`SAD-387-deal-countdown-plan.md`](SAD-387-deal-countdown-plan.md).

## 1. The defect

A Deal cell could show Amazon's countdown i18n template instead of a deal message:

```
Limited time deal NO_OF_HOURS hours NO_OF_MINUTES minutes Limited time deal
NO_OF_MINUTES minutes Limited time deal NO_OF_MINUTES minutes NO_OF_SECONDS
seconds Limited time deal NO_OF_SECONDS seconds Limited time deal
```

217 characters · 5 × `Limited time deal` · 6 placeholder tokens
(`NO_OF_HOURS` ×1, `NO_OF_MINUTES` ×3, `NO_OF_SECONDS` ×2).

## 2. Root cause

| # | Cause | Where |
|---|---|---|
| 1 | Amazon renders the badge as **one label per countdown granularity**, so a single `textContent` read concatenates five labels | the page |
| 2 | The `NO_OF_*` i18n placeholders are in the served markup instead of a substituted value (never observed live in this session — §4) | the page |
| 3 | The 60-character cap that would have rejected the blob lives **only** in `deal-evidence.ts`, while the declarative selector loops run *first* and are uncapped | `field-parsers.ts:1182`, `product-detail.ts:1143` |

Cause 3 is an ordering problem in *our* code: the value is fixed where it is read,
not by reordering the selectors (reordering would change which badge wins on every
card).

## 3. What shipped

| Step | Commit | Change |
|---|---|---|
| 1 | `b6b8467` | plan, root cause, live-capture evidence, two real fixtures |
| 2 | `35e7b15` | `utils/deal-text.ts` — the rule + 10 unit cases |
| 3 | `6ffa8bb` | wired into 4 write paths; integration cases on real markup |
| 4 | `8d9d434` | read-time cleaning on 3 surfaces; search + render cases |
| 5 | this commit | architecture note, this report, changelog finalised |

### The rule

```ts
sanitizeDealBadge(raw): string | undefined
```

- template segments dropped (`NO_OF_HOURS hours`, `NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS`)
- exact repeats folded (the ticket blob → `Limited time deal`)
- **no label constants** — everything else is the page's own text
- no template present → returned **byte for byte**
- only templates present → `undefined`, so no badge is invented

### Where it runs

| Direction | Surface |
|---|---|
| write | card badge selector loop (`field-parsers.ts`) |
| write | ad-attributes `dealString` (`field-parsers.ts`) |
| write | product-page badge loop (`product-detail.ts`) |
| write | bounded evidence scan, all three return points (`deal-evidence.ts`) |
| read | table cell + tooltip + expand modal (`ui/table/columns.tsx`) |
| read | CSV / Excel / clipboard `Deal` (`export/types.ts`) |
| read | table search (`ui/table/AmazonProductTable.tsx`) |

## 4. Evidence, and what could not be reproduced

**Reproduced:** the ticket's string round-trips through all three storage paths
(search collection, one-card save, product-page detail) and was stored verbatim
before this change.

**Not reproduced live.** Amazon was captured through `moli` (the tool the operator
named) — six pages, all HTTP 200:

| Page | `NO_OF_` | deal badges |
|---|---|---|
| `amazon.com/s?k=limited+time+deal` | 0 | 29 (20 `Limited time deal`, 9 `Ends in` + timer) |
| `amazon.com/deals` | 0 | 0 |
| `amazon.com/gp/goldbox` | 0 | 0 |
| `amazon.com/dp/B087GMJXMC` | 0 | 0 |
| `amazon.nl/s?…` | 0 | 1 |
| `amazon.de/s?…` | 0 | 0 |

So the blob stays a **reported** shape, and the rule is written against the token
pattern rather than one page shape. Two captured cards are committed verbatim:

- `docs/plans/SAD-387-fixtures/search-card-limited-time-deal.real.html` (B0725WFLMB)
- `docs/plans/SAD-387-fixtures/search-card-ends-in-countdown.real.html` (B087GMJXMC)

**A finding that removed work:** running the *existing* parser over the real
countdown card already yields `Ends in 15:00:26`, so no vocabulary change was
needed. Adding `ends in` to `DEAL_LABEL_PATTERN` was dropped and the behaviour is
pinned by a test instead.

## 5. Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run check:dead-exports` | clean (42 files) |
| `npx wxt build` | OK, `dist` 2.02 MB |
| `npm run verify` (the whole chain) | passed, `found 0 vulnerabilities` |
| CI's extra steps (`check:dead-exports`, manifest sanity) | passed |
| `npx vitest run` | **1382 passed / 125 files** (baseline 1360 / 124) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Baseline on `main@7dc713d` | 1360 tests / 124 files |
| After merging `MergeBranch@c379da6` | 1597 tests / 139 files (§9) |

`tests/sad-387-deal-countdown.test.tsx` — 22 cases:

| Group | Covers |
|---|---|
| the rule (10) | ticket blob, clock template, trailing template, templates only, printed numbers kept, different variants kept, ordinary badges byte-identical, idempotence, display helper, template-free repetition left alone (documented boundary) |
| real markup (2) | `Limited time deal` card, `Ends in 15:00:26` card |
| every write path (5) | collection, one-card save, product detail, offscreen enrichment, plain wrapper (printed, not derived) |
| read path (3) | export column, cell render (with tooltip/expand), empty → `No` |
| search (2) | finds `limited time deal`, does **not** find `no_of` |

## 6. Regression position

| Invariant | Proof |
|---|---|
| Every template-free badge keeps its exact bytes | unit case over 7 real values + the `!NO_OF_` fast path |
| SAD-386 deal behaviour unchanged | `sad-386-card-deal`, `sad-386-pdp-scope`, `sad-386-diagnostics`, `sad-386-cache-freshness`, `sad-386-workflow-parity` — all green, **unmodified** |
| Existing search-widget and pricing behaviour | `amazon-search-widgets`, `pricing-deals-bsr` — green, unmodified |
| No storage change | no file under `db/`, `schemas/` touched; no migration |
| No Temu change | no file under `engines/temu/**` touched; `temu-*` suites green |
| No parser dependency in the UI | `utils/deal-text.ts` is pure and DOM-free |
| Performance | no new DOM query; the extra work is one regex per candidate node, and the fast path skips it entirely for template-free text |

## 7. Known consequences (accepted, decided by the operator)

1. **A stored countdown is time-sensitive.** `Ends in 15:00:26` is kept as printed
   (decision D1b), so a row saved an hour ago shows the old countdown. The cell
   never re-derives it, and nothing in the pipeline recomputes it.
2. **Template-free repetition is left alone.** If a page ever prints the same
   phrase twice without a template, that is treated as the page's text (the rule
   only intervenes on the template artefact). This is the boundary that keeps
   existing values and stored rows stable.
3. **Different granularity variants are kept** (D1c), so a badge that really
   printed three different countdown strings stores all three.

## 8. How to check it by hand

```bash
git switch fix/sad-387-deal-countdown
npm ci
npx vitest run tests/sad-387-deal-countdown.test.tsx
npx wxt build           # load dist/chrome-mv3
```

Then open the preview table: a row whose stored value is the blob shows
`Limited time deal` in the Deal cell, in its tooltip, in the expand modal and in
an exported CSV — and searching `no_of` finds nothing.
