# SAD-385 — live verification protocol

> **Status: not yet executed.** This workspace has no browser, no installed
> extension and no Amazon session, so nothing below has been run against
> amazon.com. Every claim in this file is a **step to perform**, not a
> result. The automated evidence (unit + integration, 107 files / 1232 tests)
> is in `docs/plans/SAD-385-collection-weight-variations-plan.md` §14 and in the
> Linear thread.
>
> Run this on the build from branch `feat/sad-385-collection-weight-variations`,
> then paste the step-5 lines into this file and tick §6.

---

## 0. Build and load

```bash
git checkout feat/sad-385-collection-weight-variations
npm install            # runs `wxt prepare` via postinstall
npm run build          # → .output/chrome-mv3
```

1. `chrome://extensions` → Developer mode → **Load unpacked** →
   `.output/chrome-mv3`.
2. Open the side panel on any `amazon.` page.

## 1. The control is reachable (the reported "no settings in the UI")

Open **Settings**. Confirm a section named **COLLECTION ENRICHMENT** sits
between **RIGHT-CLICK SAVE** and **EXPORT DEFAULTS**
(`ui/components/SettingsOverlay.tsx:530`), containing:

- a paragraph beginning *"After a collection stores a product, its product page
  is fetched …"*;
- a **Per-run limit** radio group with three options, **Every collected product**
  selected by default;
- **no** *Enrich collected products* checkbox (SAD-385 removed it).

If the section is missing, the build is not the branch build — that was the
other half of the original report.

## 2. Turn on the measurement

**Settings → Diagnostics** on (SAD-369). Nothing below appears in the console
without it.

## 3. Manual run

1. Open a category page, e.g. `https://www.amazon.com/deals`.
2. Collection Mode: **Manual**, target **20**.
3. Scroll by hand until the target is reached; then press **Stop**.

## 4. Automatic run

1. Same surface, a **new** session.
2. Collection Mode: **Automatic**, target **20**.
3. Let it scroll; stop when it completes.

## 5. Console evidence (service worker)

`chrome://extensions` → PPHunt → **service worker** → Console. For each collected
ASIN expect one line:

```
[PPHunt] enrichment outcome {"jobId":"collect:<sessionKey>:<asin>", …}
```

Check, for both runs:

- [ ] one `collect:` line per collected product, in both modes;
- [ ] `"fieldsChanged"` contains `weight` and/or `variations` for the products
      whose page prints them;
- [ ] `"missingDetailFields"` no longer lists `weight` or `variations` on those
      products;
- [ ] no `"reason":"parse-failed"` with *"The product page is too large to
      enrich from"* (if one appears, it is the SAD-370 step-1 size cap, not this
      ticket — record the ASIN);
- [ ] a `captcha` or `circuit-open` outcome stops the remaining fetches of that
      run instead of repeating them (the pump drains on `skipped`).

## 6. Acceptance checks

| # | Check | Pass |
|---|---|---|
| 1 | Both modes produce `collect:` outcome lines for their products | ☐ |
| 2 | **Weight** column shows a value in the preview table for enriched rows (Settings → Data Fields → *Weight* on) | ☐ |
| 3 | **Variations** column shows the twister summary (e.g. `3 (Color: Black, Blue, White)`) | ☐ |
| 4 | A CSV export contains both columns with those values | ☐ |
| 5 | Right-click save of one of the same ASINs produces the **same** `weight` and `variations` values | ☐ |
| 6 | Right-click save on a listing card still reaches `state: completed` with its enrichment status | ☐ |
| 7 | Right-click save **on a product page** still saves with no extra fetch (`savedFromProductPage`) | ☐ |
| 8 | The per-card extraction icon still saves and enriches as before | ☐ |
| 9 | Per-run limit honoured: set **25**, collect 40 → exactly 25 `collect:` lines, no 26th | ☐ |
| 10 | Changing the limit takes effect on the next batch with no extension reload | ☐ |
| 11 | Restore Defaults sets the limit back to *Every collected product* | ☐ |
| 12 | A Temu page load behaves exactly as before (no Amazon enrichment runs) | ☐ |
| 13 | Stop Collection still returns immediately, even mid-enrichment | ☐ |

## 7. Where the fields come from (for the reader)

`weight` → `scraper/product-detail.ts:375-472` (4-tier waterfall over the PDP
spec tables and `#aplus`). `variations` → `scraper/product-detail.ts:674-790`
(3-tier twister waterfall). Neither is produced by the listing-card parsers:
`extractCardVariations` (`scraper/field-parsers.ts:500`) needs swatch markup that
the measured `/deals` and search cards do not carry
(`docs/plans/SAD-370-extraction-gap-closure-plan.md:120-121`: `variations`
missing on 154/154 cards, `weight` declared card-inapplicable).

## 8. Follow-ups this protocol can create

| Observation | Where it belongs |
|---|---|
| `parse-failed` / *"too large to enrich from"* lines | SAD-370 step 1 (3 MB → 5 MB cap), already planned |
| Products whose page prints no weight at all | not a defect — record the ASINs and note the share |
| Tails still missing after Stop | the durable-queue follow-up (plan §13), with the ASINs |
| Several captchas in one run | add a pacing constant between fetches (plan §10, exit trigger) |
