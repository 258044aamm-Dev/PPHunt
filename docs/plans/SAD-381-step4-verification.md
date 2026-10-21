# SAD-381 — step 4: verification and measurement

**Status: partially verified. The live-page gate is still open** — see §5. Everything that
could be verified without a logged-in Temu session has been, against Temu's own shipped
DOM contract and against the pre-change parser as a control.

Date: 2026-10-21 · branch `feat/temu-engine` · base `127cd9e` · implementation `e84a682`, `127b647`

---

## 1. Why the live page is not in this document

The ticket asks to "test against actual Temu product pages". This build environment cannot
load one:

| Attempt | Result |
|---|---|
| `curl` with desktop / Googlebot / Android user agents | SSR shell only — `<div id="main"></div>`, zero JSON-LD |
| Playwright (Chromium, real UA, JS enabled) | `https://www.temu.com/login.html?from=…&login_scene=2` |

SAD-380 hit the same wall in the same sandbox (`docs/plans/SAD-380-step1-capture-2026-10-21.md`).
No authenticated PDP capture exists in the repository, and fixtures may not be invented, so
the live gate stays open rather than being claimed.

What *is* available is Temu's own client bundle, which is where the DOM contract comes from
(`…/m-assets/assets/modernjs/goods_3ec530fb9c64b2d4fc2a.js`, 207,822-char
`__InitialI18nStore__`, `GoodsDetailV2`, `DescriptionV2`, `GoodsPropertyTable`). The fixtures
in `tests/fixtures/` are built from that contract, not from guesswork.

---

## 2. What is verified now

| Layer | Evidence | Result |
|---|---|---|
| Contract fidelity | `tests/temu-pdp-details.test.ts` | 34 tests — labels (5), features (13), description (9), expand (4) |
| Parser wiring + statuses | `tests/temu-diagnostics-pdp.test.ts` | 27 tests, incl. 5 new SAD-381 cases (source, reason, PARTIAL precedence, meta-tag removal, right-column fallback) |
| End-to-end content script | `tests/temu-expand-details.test.ts` | 5 tests — flag off ⇒ zero clicks; flag on ⇒ one click and the revealed rows are stored; non-PDP never clicked |
| No regression elsewhere | full suite | **108 files / 1282 tests, 0 failures**; `src/engines/amazon` and `src/lib` diffs empty |
| Build | `npx wxt build` | 2.01 MB, `dist/chrome-mv3` emitted |

---

## 3. Before/after measurement (A/B, same fixture, same runner)

The pre-change parser was checked out at `127cd9e` in a git worktree, the current one at
HEAD, and both were run over the same bundle-derived contract page with a probe spec. This
is the measurement the ticket asks for, minus the live page.

**Fixture A** — the full contract page (`#goodsDetail` with a Highlights module, property
rows, a `<table>`, compliance text; `#rightContent` with a `Description` module; no JSON-LD).

| Build | `features` | `description` |
|---|---|---|
| `127cd9e` | `["Waist TypeMid"]` | `null` |
| HEAD | `["Breathable lining","Season: Spring, Autumn","Pattern Type: Solid","Style: Business Casual","Waist Type: Mid"]` | `"Material: 95% Polyester · Fit: Regular"` |

Two defects are visible in the baseline column: the `div`-rendered Highlights and property
rows are missed entirely, and the only row that survives (`<tr>`) is mangled — `th` and `td`
concatenated with no separator, because the old code read `tr.textContent`.

**Fixture B** — same page plus `meta[name="description"]` (the SEO template), as every real
Temu PDP carries.

| Build | `features` | `description` |
|---|---|---|
| `127cd9e` | `[]` | `"deals on mens suit set on Temu. Shop on Temu to start saving."` |
| HEAD | `["Breathable lining"]` | `"Material: 95% Polyester"` |

The baseline stored the SEO boilerplate *as the product description*; HEAD stores the
page's own Description module. The trailing "Shop on Temu to start saving." is Temu's
template, not product data.

---

## 4. The live replay harness

`tests/temu-pdp-captures.test.ts` closes the remaining gap in one command, using captures
the operator produces from a logged-in tab. `scripts/temu-dom-capture.js` now also emits
`dom.goodsDetail` / `dom.rightContent` (the two containers' `outerHTML`), so a capture is
enough to replay the real parser offline.

Procedure:

1. Open a real Temu PDP while logged in.
2. Paste `scripts/temu-dom-capture.js` into the DevTools console.
3. Save the downloaded `sad381-<goodsId>.json` into `tests/fixtures/temu-live/`
   (`TEMU_PDP_CAPTURE_DIR` overrides the directory; full-page `*.html` saves work too).
4. `npx vitest run tests/temu-pdp-captures.test.ts`

Invariants enforced per capture — these encode the ticket's "never fabricate / never include
unrelated content" rule directly:

1. **Backed by the page** — every feature and the description must occur in the capture's own
   text or `aria-label`/`title`/`alt`/`content` values, compared case-, punctuation- and
   whitespace-insensitively. A value that is invented, templated or reflowed fails.
2. **No UI leakage** — no collapse-control label (`See all details`, `See more`, …) may appear
   as a feature.
3. **No SEO template** — `description` may not equal `meta[name="description"]`, start with
   `" deals on "`, or contain `Shop on Temu to start saving`.
4. **Positive extraction** — a rendered `#goodsDetail` containing labelled rows must yield at
   least one feature.

With no captures present the suite prints what it is waiting for and skips; it never passes
silently. The harness itself was exercised on a probe capture before being committed:

```
[SAD-381] probe.json: features=5 description=38 chars      → 1 passed
```

---

## 5. Open gate (must close before In Review → Done)

- [ ] Capture ≥1 real PDP with collapsed rows **and** ≥1 with expanded rows
      (`tests/fixtures/temu-live/`).
- [ ] `npx vitest run tests/temu-pdp-captures.test.ts` — all invariants pass.
- [ ] Eyeball the captured `summary` block: `features` and `description` are plausible product
      data, not navigation, compliance text or SEO.
- [ ] Turn **Expand product details** on in the overlay and confirm on a live PDP that the
      revealed rows (not just the visible ones) are stored, and that the diagnostic reports
      `EXTRACTED` instead of `PARTIAL`.

Nothing above can be produced from this sandbox; it needs a browser that is logged in to
Temu. Until then the code path is verified against the shipped contract and against the
pre-change parser as a control, and the ticket should not be closed on that basis alone.
