# SAD-387 — the Deal field must hold the page's own text (not a template)

> Branch `fix/sad-387-deal-countdown`, from `main@7dc713d`.
>
> **Revision history**
> 1. First draft: canonicalise to a hard-coded `Limited time deal`. **Rejected by
>    the operator** — the field must carry the page's own text.
> 2. Second draft: page text with `NO_OF_*` templates dropped and exact repeats
>    collapsed (operator decisions D1/D1b/D1c/D2/D3).
> 3. **This version** adds the Phase 0 live capture, which was expected to be
>    impossible and turned out to work — and which removed one item from the
>    change set (§1.3).

---

## 0. Decisions

| # | Question | Decision |
|---|---|---|
| **D1** | What goes in the field when the page prints a countdown template? | **The page's own text**: `NO_OF_*` template segments dropped, exact repeated phrases collapsed. No label constants. |
| **D1b** | Keep real substituted numbers (`2 hours 15 minutes`) if printed? | **Yes.** A stored countdown is time-sensitive; accepted (§9). |
| **D1c** | Different granularity variants printed by the same badge | **Exact repeats collapse**; genuinely different variants are kept verbatim. |
| **D2** | Rows already saved with the blob | **Clean at read time** — cell/tooltip/expand modal, CSV/Excel/clipboard, table search. No DB write, no migration. |
| **D3** | Scope | **Amazon engine only.** Temu untouched. |
| **D4** | Fixture source | **Captured live markup for the shapes that exist live, plus the ticket string labelled `reported`.** |
| **D5** | The countdown badge (`Ends in 15:00:26`) | **In scope — store the page's own text.** Measured: the current parser already does this correctly, so this became a *regression pin*, not new code (§1.3). |

---

## 1. Evidence

### 1.1 The ticket's string, through the real parsers

Fed verbatim through all three storage paths (probe since deleted):

| Path | Before |
|---|---|
| `parseAmazonSearchResults` (collection) | **blob stored** — 217 characters |
| `extractProductFromCard` (one-click / right-click save) | **blob stored** |
| `parseAmazonProductDetail` + `parsePdpHtml` (PDP) | **blob stored** |
| SAD-386 evidence scan, blob in a plain wrapper | `Deal` — already refuses it |

String facts: **217** characters, **5** × `Limited time deal`, **6** tokens
(`NO_OF_HOURS` ×1, `NO_OF_MINUTES` ×3, `NO_OF_SECONDS` ×2). `grep -rn "NO_OF_"
src/ tests/` → **0 hits**: the tokens are Amazon's, not ours.

### 1.2 Live capture — Phase 0 (this is new)

Amazon answered **HTTP 200** when fetched through `moli` (the tool the operator
named), so the earlier conclusion in this project that "the sandbox is blocked"
does not hold for that client. Six pages captured:

| Page | Status | `NO_OF_` | deal badges | note |
|---|---|---|---|---|
| `amazon.com/s?k=limited+time+deal` | 200 | **0** | 29 | 20 print `Limited time deal`, 9 print `Ends in` + timer |
| `amazon.com/deals` | 200 | **0** | 0 | — |
| `amazon.com/gp/goldbox` | 200 | **0** | 0 | 21 countdown widgets, all nav/promo |
| `amazon.com/dp/B087GMJXMC` | 200 | **0** | 0 | this product shows no badge on its own page |
| `amazon.nl/s?…` | 200 | **0** | 1 | — |
| `amazon.de/s?…` | 200 | **0** | 0 | — |

Real badge markup captured (verbatim, now a repo fixture):

```html
<span id="DEAL_B087GMJXMC" class="a-badge" data-a-badge-type="deal">
  <span class="a-badge-label">
    <span class="a-badge-label-inner a-text-ellipsis">
      <span class="a-badge-text">Ends in </span>
      <span class="dealBadge-countdown-timer" data-target-time="2026-10-22T06:59:59Z">15:00:26</span>
    </span>
  </span>
</span>
```

```html
<span class="a-badge-text">Limited time deal</span>
```

Fixtures: `docs/plans/SAD-387-fixtures/search-card-limited-time-deal.real.html`
(asin `B0725WFLMB`) and `…-ends-in-countdown.real.html` (asin `B087GMJXMC`),
extracted verbatim from the capture.

**Consequence for honesty:** the `NO_OF_*` blob was **not** reproduced live today.
The fix is therefore written against the *token pattern*, not against a page
shape, so it is correct wherever the template appears. The `NO_OF_` fixture stays
labelled `reported (SAD-387)` — never `real`.

### 1.3 What the live capture changed in the plan

Running the **current** parser over the two real cards:

| Fixture | `dealBadge` today |
|---|---|
| `search-card-limited-time-deal.real.html` | `"Limited time deal"` ✓ |
| `search-card-ends-in-countdown.real.html` | `"Ends in 15:00:26"` ✓ (already correct) |

So the countdown form **already works** — the card path falls through to the
SAD-386 evidence scan, whose deal-specific containers accept
`[data-a-badge-type="deal"]` without a vocabulary test. Adding `ends in` to the
deal vocabulary would have been unnecessary code that changed extraction for
real products. **Dropped from the change set**; the behaviour is pinned by a test
instead.

---

## 2. Root cause

1. **Repetition** — Amazon renders the deal badge as one label per countdown
   granularity (hours; minutes ×2 for the pluralisation branches; seconds ×2).
   One `textContent` read concatenates all of them.
2. **Literal templates** — `NO_OF_*` placeholders present in the subtree instead
   of a substituted value. Not observed live today (§1.2); it is the ticket's
   reported shape and it round-trips through all three parsers.
3. **Why no guard caught it** — the 60-character cap lives **only** in
   `deal-evidence.ts`; the declarative selector loops that run *first* are
   uncapped (`field-parsers.ts:1177`, `product-detail.ts:1136`). An ordering
   problem, fixed at the value rather than by reordering (reordering would change
   which badge wins on every card).

---

## 3. The fix

One small pure module used by every **write** and every **read** path. No schema
change, no DB write, no vocabulary change, no label constants.

### 3.1 New: `src/engines/amazon/utils/deal-text.ts`

```ts
/**
 * SAD-387: Amazon prints a deal badge as one label per countdown granularity,
 * each carrying an i18n template (`NO_OF_MINUTES`). Reading the block's
 * `textContent` therefore yields the label several times plus the templates
 * (the ticket's case: 5 labels, 6 tokens, 217 characters).
 *
 * Operator decision D1: the value is the page's own text. Nothing is mapped or
 * invented here — templates are dropped, exact repeats collapse, and everything
 * else (including a real `Ends in 15:00:26`) is preserved.
 */

/** `NO_OF_HOURS hours` / `NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS` and friends. */
const TEMPLATE_SEGMENT =
  /(?:\bNO_OF_(?:HOURS?|MINUTES?|SECONDS?|DAYS?)\b(?:\s+(?:hours?|minutes?|seconds?|days?)\b)?[\s:.,\-–—]*)+/gi;

const EDGE_PUNCTUATION = /^[\s:.,\-–—]+|[\s:.,\-–—]+$/g;

function tidy(text: string): string {
  return text
    .replace(/[\u00A0\u202F\u2007\u200B-\u200F\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCTUATION, '')
    .trim();
}

function collapseRepeats(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {   // bounded; each pass only shortens
    const before = current;
    // (a) whole string is one unit repeated
    const words = current.split(' ').filter(Boolean);
    const n = words.length;
    for (let unit = 1; unit <= Math.floor(n / 2); unit += 1) {
      if (n % unit !== 0) continue;
      let repeated = true;
      for (let i = unit; i < n && repeated; i += 1) {
        if (words[i] !== words[i % unit]) repeated = false;
      }
      if (repeated) { current = words.slice(0, unit).join(' '); break; }
    }
    // (b) a phrase immediately repeated
    current = current
      .replace(/\b([A-Za-z0-9][A-Za-z0-9 '\x27-]{2,60}?)\b(?:\s+\1\b)+/gi, '$1')
      .trim();
    if (current === before) break;
  }
  return current;
}

/** The text to store for a deal badge; `undefined` when only templates were printed. */
export function sanitizeDealBadge(raw: string | null | undefined): string | undefined {
  const text = tidy(raw ?? '');
  if (!text) return undefined;
  if (!/NO_OF_/i.test(text)) return text;      // fast path: today's behaviour
  return collapseRepeats(tidy(text.replace(TEMPLATE_SEGMENT, ' '))) || undefined;
}

/** Read-time helper for rows saved before this fix (D2). */
export function dealBadgeForDisplay(raw: string | null | undefined): string | null {
  return sanitizeDealBadge(raw) ?? null;
}
```

**Measured behaviour**

| Input | Output |
|---|---|
| ticket blob | `Limited time deal` |
| `Ends in NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS` | `Ends in` |
| `Limited time deal NO_OF_HOURS:… ` repeated | `Limited time deal` |
| `Ends in 15:00:26` (real) | unchanged |
| `Limited time deal` (real) | unchanged |
| only tokens | `undefined` → no badge |
| `Prime Big Deal`, `Amazon's Choice`, `Save 15% with coupon`, a title with "Deal" | unchanged |

The `!NO_OF_` fast path is what keeps every existing expectation green.

### 3.2 Write paths (4 call sites)

| File | Line | Change |
|---|---|---|
| `field-parsers.ts` | ~1177 (card badge loop) | `const text = sanitizeDealBadge(normalizeWhitespace(el?.textContent));` before `DEAL_LABEL_PATTERN.test(text)` |
| `field-parsers.ts` | ~1193 (`adProps.dealString`) | `dealBadge = sanitizeDealBadge(adProps.dealString)` |
| `product-detail.ts` | ~1140 (PDP badge loop) | same substitution |
| `deal-evidence.ts` | 3 returns in `detectDealEvidence` | sanitise before the length/price checks |

Untouched: `DEAL_LABEL_PATTERN` (location **and** content — D5 proved no addition
is needed), `DERIVED_DEAL_LABEL`, `TREAT_STRUCK_LIST_PRICE_AS_DEAL`, container
selector lists, `skip`, `deriveDealFromPrices`, `dealBadgeDerived` semantics,
diagnostics (a sanitised value is still printed → `EXTRACTED`, source `dom`).

### 3.3 Read paths (D2)

| File | Line | Change |
|---|---|---|
| `ui/table/columns.tsx` | 311 | `const deal = dealBadgeForDisplay(info.getValue());` |
| `export/types.ts` | 63 | `Deal: (p) => dealBadgeForDisplay(p.dealBadge) \|\| 'No'` |
| `ui/table/AmazonProductTable.tsx` | 172 | search on `(dealBadgeForDisplay(p.dealBadge) ?? '').toLowerCase()` |

Temu's columns are not touched (D3); its parser rejects text over 90 characters
(`temu/scraper/field-parsers.ts:1088`), so it cannot store this blob.

---

## 4. Tests — `tests/sad-387-deal-countdown.test.tsx`

| # | Case | Asserts |
|---|---|---|
| 1 | **real** `Limited time deal` card | `'Limited time deal'` (regression pin) |
| 2 | **real** `Ends in` countdown card | `'Ends in 15:00:26'` (D5 regression pin) |
| 3 | ticket blob inside the real card's badge | `'Limited time deal'` — collection **and** `extractProductFromCard` |
| 4 | ticket blob on a PDP | `parseAmazonProductDetail` and `parsePdpHtml` → `'Limited time deal'` |
| 5 | blob in a plain wrapper | `'Limited time deal'`, `dealBadgeDerived` **not** set |
| 6 | `Ends in NO_OF_HOURS:NO_OF_MINUTES:NO_OF_SECONDS` | `'Ends in'` (no dangling separators) |
| 7 | only templates | `dealBadge` absent — nothing invented |
| 8 | positive controls: `Prime Big Deal`, `Amazon's Choice`, coupon text, a title with "Deal" | unchanged; SAD-386's "Choice is not a deal" holds |
| 9 | read-time: stored raw blob | cell/expand/export show `Limited time deal`; search finds the label, not `no_of` |
| 10 | read-time control: stored `Prime Big Deal` | unchanged |

Must stay green untouched: all six `tests/sad-386-*.test.ts`,
`tests/amazon-search-widgets.test.ts`, `tests/sad-386-diagnostics.test.ts`,
`tests/scraper-performance.test.ts`, `tests/temu-*.test.ts`,
`tests/docs-consistency.test.ts`.

---

## 5. Phases

| # | Commit | Gate |
|---|---|---|
| 1 | `docs(sad-387): root cause, live-capture evidence and the fix plan` | docs-consistency |
| 2 | `SAD-387 step 1: drop Amazon's countdown templates from the deal text` — `utils/deal-text.ts` + unit cases | `tsc`, new tests green |
| 3 | `SAD-387 step 2: the card and product-page loops use it` — 4 call sites + real-fixture tests | probes 3/4/5 green through every workflow |
| 4 | `SAD-387 step 3: clean old rows where they are shown` — 3 read sites | UI/export/search tests |
| 5 | `SAD-387 step 4: fixtures, changelog, architecture note, verification report` | full `npm run verify` |

Each step: `npx tsc --noEmit` → `npm run check:dead-exports` → `npx wxt build` →
`npx vitest run` → `npm audit --omit=dev` → push → Linear comment.
Baseline to beat: **1360 tests / 124 files** on `main@7dc713d`.

---

## 6. Falsified — do not build

| Candidate | Why not |
|---|---|
| A canonical label map / hard-coded `Limited time deal` | Rejected by the operator (D1). |
| Adding `ends in` to the deal vocabulary | **Measured unnecessary** — the real countdown card already extracts (§1.3). |
| Moving `DEAL_LABEL_PATTERN` into `utils/` | Only the rejected canonical map needed it. |
| Verbatim blob | Leaves the ticket's symptom on screen. |
| A generic 60-char cap in the selector loops | Changes every badge to fix one template. |
| DB migration / schema change | D2 is read-time; `dealBadge` is `z.string()`. |
| Temu parser/UI | D3; already rejects >90-character text. |
| `FILL_ONLY_FIELDS` / enrichment | Cannot overwrite `dealBadge` by design; D2 handles display. |

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A stored countdown goes stale (`Ends in 15:00:26` saved an hour ago) — the cost of D1b/D5 | **Certain by design** | Accepted by the operator; the cell shows exactly what the page said and nothing re-derives it |
| `NO_OF_` still not reproduced live | Known | The fix keys on the token pattern, not on a page shape; fixture labelled `reported`; the capture script can be re-run any time |
| Collapsing removes a legitimate repeat | Low | Only fires when `NO_OF_` is present; tests 8 pin the clean paths |
| UI imports a new module | Low | `utils/` is already imported by the side panel; the module is pure |
| Legacy search behaviour changes | Low | Test 9 pins both directions |
| Regression in SAD-386 deal assertions | Low | They pass template-free strings → unchanged fast path |

**Rollback:** one commit per phase, no data written. Reverting step 4 restores the
display; reverting step 3 restores the parser. Nothing to repair in the DB.

---

## 8. Tooling note

`moli` (installed with its documented installer) reached Amazon where `curl` and a
reader proxy were refused, so future live capture does not depend on a manual
browser. The binary lives outside the repository; this section records the
invocation rather than vendoring it:

```bash
moli fetch --dump json --wait domcontentloaded 'https://www.amazon.com/s?k=limited+time+deal'
```
