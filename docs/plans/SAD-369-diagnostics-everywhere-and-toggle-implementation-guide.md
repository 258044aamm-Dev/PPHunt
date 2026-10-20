# SAD-369 — Implementation guide (step by step, beginner-friendly)

**What this guide is for.** You have never touched this code before and you
have been asked to build a feature in it. This guide walks you through it one
small step at a time. Every step says *what you are building*, *which files
you open*, *what to type*, and *how to check it worked*.

**Linear ticket:** [SAD-369](https://linear.app/sad-mod/issue/SAD-369) ·
each step below is a separate Linear sub-issue.
**Design plan (the "why"):** `docs/plans/SAD-369-diagnostics-everywhere-and-toggle-plan.md`
**Repo:** `MakeTheNewHistory/PPHunt`, branch `main`.

> **One rule for the whole job:** the diagnostics must never change what gets
> extracted. If a step makes the collected data different, that step is wrong
> — not the test. There is a test that checks exactly this (§B.0, "the parity
> test").

---

## Part A — Before you start

### A.1 Get the code and make sure it works

```bash
git clone https://github.com/MakeTheNewHistory/PPHunt.git
cd PPHunt
npm install
npm run build          # <- important, see A.3
npx vitest run         # should say "88 files / 1046 tests passed"
```

### A.2 The five commands you will use every single time

```bash
npx tsc --noEmit                    # 1. does the TypeScript compile?
npx vitest run                     # 2. do all the tests still pass?
npm run build                      # 3. does the extension still build?
npm run check:dead-exports         # 4. is any shared export now unused?
git status --short                 # 5. what did I actually change?
```

**Run all five before every commit.** If any fails, fix it before you commit.
A step that leaves the tree red is not "mostly done" — it is not done.

### A.3 A known quirk — do not "fix" it

On a clean checkout `npx vitest run` can report **1 failed file**:
`tests/manifest-permissions.test.ts`. That test reads `dist/chrome-mv3/manifest.json`,
which does not exist until you build. **Run `npm run build` first** and it
passes 11/11. This is pre-existing and unrelated to this job.

### A.4 Words you will see

| Word | What it means here |
|---|---|
| **content script** | code that runs inside the Amazon page (the page you are looking at) |
| **service worker** | the extension's background code; it is where the per-field log lines are printed |
| **offscreen document** | a hidden page the extension uses to parse HTML with `DOMParser` |
| **collector** | the object that records *why* a field did or did not come out (`createFieldDiagnosticsCollector()`) |
| **report** | the finished list of 24 field outcomes for one product |
| **sink** | a callback that receives each finished report |
| **stage** | which kind of parse produced the report: `detail-page`, `card`, `collection-card`, `enrichment-parse` |
| **parity** | "the extracted product is the same with and without the collector" |

### A.5 The 30-second map

```
src/engines/amazon/
  scraper/
    extraction-diagnostics.ts   <- the collector, the 24 fields, the formatter  (READ THIS ONE FIRST)
    product-detail.ts            <- parses a PRODUCT PAGE
    search-results.ts            <- parses a SEARCH CARD
    category-page.ts             <- parses a CATEGORY CARD
    drift-telemetry.ts           <- prints the "drift" line
  content/
    save-product.ts              <- turns a right-click into a product
  background/
    save-job.ts                  <- saves a product; prints the "detail-page" line
    enrich-saved-product.ts      <- fetches the product page; prints the "enrichment-parse" line
    handler.ts                   <- receives collected products
  ui/components/
    SettingsOverlay.tsx          <- the Settings screen
  constants/defaults.ts          <- where the default settings live
src/entrypoints/
  amazon.content.ts              <- the Amazon content script (cards, collection, card icon)
```

### A.6 Read these files, in this order

1. `src/engines/amazon/scraper/extraction-diagnostics.ts` — the whole file.
   It is the heart of the feature and it is well commented.
2. `src/engines/amazon/content/save-product.ts` — how a right-click becomes a
   product, and where the collector is created today.
3. `src/engines/amazon/background/save-job.ts` — lines 230–300. Where the
   `detail-page` line is printed and where the decision "enrich or not" is made.
4. `src/engines/amazon/scraper/search-results.ts` — lines 39–171. The card parser.
5. `src/entrypoints/amazon.content.ts` — lines 78–101 (which parser runs for
   which page type) and lines 326–400 (the collection loop).

### A.7 The commands to use when you need to look something up

```bash
# find every place that prints a diagnostics line
grep -rn "PPHunt\]\[Amazon\]\[Diagnostics\]" src/

# find every place that creates a collector
grep -rn "createFieldDiagnosticsCollector" src/

# find every place a card is parsed
grep -rn "parseAmazonSearchCard\|parseAmazonCategoryCard" src/

# check the 24 fields
grep -n -A30 "DETAIL_DIAGNOSTIC_FIELDS" src/engines/amazon/scraper/extraction-diagnostics.ts
```

---

## Part B — The five steps

Each step is one commit, one push, one Linear comment. **Do not start step N+1
until step N is pushed and commented on.**

### B.0 The parity test (read this before you write any code)

There is already a test that proves the collector does not change the
extracted product. Find it:

```bash
grep -rn "parity\|toEqual" tests/extraction-diagnostics.test.ts | head
```

**If you break the parity test, you have changed extraction behaviour. That
is the one thing this job must never do.** Every step must leave it green.

---

### B.1 Step 1 — the on/off switch, and gating every log line

**Linear:** SAD-371 · **Design:** plan §5 "The setting" (E1–E4) ·
**What you are building:** a single setting in Settings that turns the
diagnostics on and off, and making every existing log line respect it.

**The reason this is a whole step:** today the diagnostics always print. With
this step they print only when the owner asks for them. **This changes
shipped behaviour** — the CHANGELOG entry in step 4 must say so.

#### 1.1 Create the key and the default

New file `src/engines/amazon/constants/diagnostics.ts`:

```ts
/**
 * SAD-369: the switch that turns the per-field extraction diagnostics on.
 *
 * It lives in `browser.storage.local`, not in the IndexedDB settings row,
 * because a content script cannot read the extension's IndexedDB - it runs in
 * the page's origin. `storage.local` is readable from every extension
 * context *and* from the content script, exactly like `pphuntTheme`.
 */
export const DIAGNOSTICS_ENABLED_KEY = 'pphuntDiagnosticsEnabled';

/** SAD-369 D1: off until the owner turns it on. */
export const DEFAULT_DIAGNOSTICS_ENABLED = false;

/**
 * Only a literal `true` enables the diagnostics. A missing key, `undefined`
 * or any other value is `false` - a corrupt value must never turn logging on
 * by accident.
 */
export function readDiagnosticsEnabled(raw: unknown): boolean {
  return raw === true;
}
```

#### 1.2 Create the accessor

New file `src/engines/amazon/utils/diagnostics-flag.ts`.

Copy the pattern from `src/engines/amazon/content/card-action-theme.ts` — that
file already does exactly this for the theme: read once, then keep in sync.

```ts
import {
  DEFAULT_DIAGNOSTICS_ENABLED,
  DIAGNOSTICS_ENABLED_KEY,
  readDiagnosticsEnabled,
} from '../constants/diagnostics';

let cached = DEFAULT_DIAGNOSTICS_ENABLED;

export function getDiagnosticsEnabled(): boolean {
  return cached;
}

export async function refreshDiagnosticsEnabled(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(DIAGNOSTICS_ENABLED_KEY);
    cached = readDiagnosticsEnabled(stored?.[DIAGNOSTICS_ENABLED_KEY]);
  } catch {
    // A restricted context must not break the page: stay off.
    cached = DEFAULT_DIAGNOSTICS_ENABLED;
  }
}

export async function setDiagnosticsEnabled(value: boolean): Promise<void> {
  cached = value;
  await browser.storage.local.set({ [DIAGNOSTICS_ENABLED_KEY]: value });
}
```

Also export a `subscribeDiagnosticsEnabled(listener)` that hooks
`browser.storage.onChanged` and calls `listener` with the new value whenever
the key changes — that is what makes the switch work **without a page
reload**.

> **Why a cache instead of reading every time?** The content script parses
> cards in a tight loop. A `storage.local.get` per card would be slow. One
> read at start-up, then keep in sync, is the right shape.

#### 1.3 Add the toggle to Settings

Open `src/engines/amazon/ui/components/SettingsOverlay.tsx`.

Find the `<SettingsSection title="GENERAL">` block (around line 293) and add a
**new section after it**:

```tsx
<SettingsSection title="DIAGNOSTICS">
  <div className="space-y-4">
    <ToggleRow
      label="Enable extraction diagnostics"
      description="Log per-field extraction status for every product the Amazon engine parses. Off by default. Read the lines in the extension's Service worker DevTools."
      checked={diagnosticsEnabled}
      onChange={(v) => setDiagnosticsEnabled(v)}
    />
  </div>
</SettingsSection>
```

Use whatever component the existing toggles in that file use (look for
`notifications` or `duplicateDetection` and copy that row's shape exactly).
Read the current value with `getDiagnosticsEnabled()` and keep it in state.

Also: the "reset to defaults" control in the DATA section must set the
diagnostics flag back to `false`.

#### 1.4 Gate the log sites

Now make each print site check the switch first.

**a. `src/engines/amazon/background/save-job.ts`** (around line 239)

Add to the `SaveJobDeps` interface (around line 68):

```ts
/**
 * Whether the per-field diagnostics may be logged. Absent means OFF, so a
 * caller that forgets to pass it fails closed, and every existing test
 * keeps the production default rather than a test-only one.
 */
diagnosticsEnabled?: () => boolean;
```

Then change the log site to:

```ts
if (payload.extractionDiagnostics && deps.diagnosticsEnabled?.()) {
```

**b. `src/engines/amazon/background/enrich-saved-product.ts`** (around line 377)

Same idea — check `getDiagnosticsEnabled()` before printing.

**c. `src/engines/amazon/scraper/drift-telemetry.ts`** (around line 162)

`logDriftReport` prints into the **page** console, so it must read the switch
from the same cached accessor. Return early if it is off.

#### 1.5 Pass the switch at the two production call sites

- `src/engines/amazon/background/handler.ts` (around line 800) — the
  `SAVE_PRODUCT` case.
- `src/engines/amazon/background/save-job-recovery.ts` (around line 199).

Both should pass `diagnosticsEnabled: () => getDiagnosticsEnabled()`.

#### 1.6 Check it worked

```bash
npx tsc --noEmit && npx vitest run && npm run build && npm run check:dead-exports
```

**Six existing tests will now fail.** They assert that a diagnostics line is
printed, and the switch is now off by default. Open each and make it turn the
switch on first, so the test says "with diagnostics on, the line is
printed":

- `tests/extraction-diagnostics.test.ts` (2 assertions)
- `tests/amazon-engine-v2.test.tsx` (2 assertions)
- `tests/save-job-pipeline.test.ts` (1 assertion)
- `tests/enrich-saved-product.test.ts` (1 assertion)

> **Do not delete these assertions and do not weaken them.** They are the
> proof that the line still prints when it should. Just enable the switch
> first.

**Then add the new tests** (plan §7, T1–T12). The important ones:

- a new `tests/diagnostics-setting.test.ts`:
  - missing key → `false`; `true` → `true`; `false` → `false`; garbage → `false`
  - the default is **off**
- the switch **off** → no diagnostics line from any of the three sites
- the switch **on** → the line is printed from each site

#### 1.7 Commit, push, comment

```bash
git add -A
git commit -m "SAD-369 step 1: add the diagnostics on/off setting and gate every log site"
git push origin main
```

Then comment on **SAD-371** with: the files changed, the test results, and
the command output. Move **SAD-371** to **In Review** after the step is
complete; SAD-370 is the separate step-0 issue and remains **Done**. Keep the
parent SAD-369 **In Progress** until step 4 is complete.

---

### B.2 Step 2 — the card-level report, and the card save path

**Linear:** SAD-372 · **Design:** plan §6 "The card-level report" (E5–E7)
**What you are building:** the ability to say "here is what happened to every
field of **this one listing card**", and to print it when a card is saved.

**Why:** today, right-clicking a card produces a log **only if** the
background fetch of the product page succeeds. If the fetch fails, the save
logs nothing. After this step, a card save always logs at least once.

#### 2.1 Understand what a card can carry

A **card** is the little product box in a search-results list. It has far less
information than a product page. Of the 24 modelled fields, a card can carry
**20**. It can never carry these **4**:

| Field | Why it cannot be there |
|---|---|
| `description` | the card parser hard-codes it to `null` |
| `features` | the card parser hard-codes it to `[]` |
| `weight` | only ever comes from the product page |
| `warrantyDescription` | only ever comes from the product page |

Those 4 are reported as `MISSING` with the reason *"not available on a
listing card — this field is only extracted from the product page"* (decision
D4). The **reason** is what tells a reader this is normal, not a fault.

#### 2.2 Create the shared recorder

New file `src/engines/amazon/scraper/card-diagnostics.ts`.

**Why one shared function?** `parseAmazonSearchCard` and
`parseAmazonCategoryCard` are two separate implementations that do almost the
same thing. Writing the recording calls twice would duplicate ~60 lines that
would drift apart. One function, called by both.

```ts
import type {
  FieldDiagnosticsCollector,
  ExtractionDiagnosticsReport,
} from './extraction-diagnostics';

/** The 4 modelled fields a listing card never carries (SAD-369 D4). */
export const CARD_INAPPLICABLE_FIELDS = [
  'description',
  'features',
  'weight',
  'warrantyDescription',
] as const;

export const CARD_INAPPLICABLE_REASON =
  'not available on a listing card — this field is only extracted from the product page';

export function recordCardDiagnostics(
  collector: FieldDiagnosticsCollector,
  input: CardDiagnosticsInput,
): void {
  // ...record each field as EXTRACTED or MISSING ...
  // ...then record the 4 card-inapplicable fields as MISSING with
  //    CARD_INAPPLICABLE_REASON ...
}
```

`CardDiagnosticsInput` is the **already-computed** result of parsing one
card: the ASIN, the title, the brand, the pricing result, the rating and
review results, the image result, and the optional strings.

Two rules while you write it:

1. **`EXTRACTED` means we got a value.** `MISSING` means we looked and it was
   not there. Give every `MISSING` a reason that says *what was looked for*.
2. **A card report carries `tier`, not `selector`.** The card extractors work
   as a 4-tier cascade, not a single selector, so the tier is the honest
   "how did we get this" signal. The product-page report keeps its selector.

#### 2.3 Add the sink

In `src/engines/amazon/scraper/extraction-diagnostics.ts` add:

```ts
/**
 * Receives one finished report per parsed product. A listing parse produces
 * many products and each needs its own collector, so the reports are
 * delivered through a sink rather than through one shared collector.
 */
export interface ExtractionDiagnosticsSink {
  accept(report: ExtractionDiagnosticsReport): void;
}
```

#### 2.4 Thread it into the card parsers

`src/engines/amazon/scraper/search-results.ts`:

- `SearchResultsParseOptions` (line 39) gains
  `diagnosticsSink?: ExtractionDiagnosticsSink;`
- the same for the category-page options.

Inside `parseAmazonSearchCard` (line 61) and `parseAmazonCategoryCard`
(line 114 in `category-page.ts`):

```ts
const diagnostics = options.diagnosticsSink
  ? createFieldDiagnosticsCollector()
  : undefined;

...the existing extraction calls, unchanged...

if (diagnostics) {
  recordCardDiagnostics(diagnostics, { /* the results you already have */ });
  options.diagnosticsSink.accept(diagnostics.build());
}
```

> **When the sink is absent, not one collector is allocated per card.** That
> is the whole performance argument for the switch: with diagnostics off, the
> card loop does exactly what it did before — one `undefined` check.

> **`build()` with no argument already uses the 24-field list.** You do not
> need a new field list. The card report has the same 24 rows as a
> product-page report (decision D3).

#### 2.5 Attach the report to the two card save paths

Two places turn a card into a product:

| File | Line | What it is |
|---|---|---|
| `src/engines/amazon/content/save-product.ts` | 129 | right-click on a card |
| `src/entrypoints/amazon.content.ts` | 617 | the card save icon |

In each, create a collector, pass a sink that captures the one report, and
attach it to the `SAVE_PRODUCT` payload as `extractionDiagnostics`. **The
payload already accepts it** — `SaveProductMessageSchema` already has
`extractionDiagnostics: ExtractionDiagnosticsReportSchema.optional()`. You do
not need to change the schema.

#### 2.6 Print it in the worker, under a new stage

`src/engines/amazon/background/save-job.ts` — the report now has to say
*which* parse produced it. The `detail-page` report and the `card` report
both arrive on `payload.extractionDiagnostics`.

Give the report a `stage` when you attach it, and print that stage. The
existing print site is around line 239. Two stages now exist:
`detail-page` (the product page) and `card` (a listing card).

#### 2.7 Check it worked

```bash
npx tsc --noEmit && npx vitest run && npm run build && npm run check:dead-exports
```

New tests (plan §7, T13–T22). The ones that matter most:

- a search card produces a 24-field report, and the 4 card-inapplicable
  fields are `MISSING` with `CARD_INAPPLICABLE_REASON`
- the five counts sum to 24
- **the extracted product is byte-identical with and without a sink** (the
  parity test)
- right-clicking a card → the worker prints a `card` line
- a card save whose enrichment **fails** still prints the `card` line
- a card save whose enrichment **succeeds** prints **two** lines (`card` and
  `enrichment-parse`) with the **same** job id

#### 2.8 Commit, push, comment

```bash
git commit -m "SAD-369 step 2: add the card-level diagnostics report and the card save path"
git push origin main
```

---

### B.3 Step 3 — the collection path, 50-item cap, E9 and drift move

**Linear:** SAD-373 · **Design:** plan §7 "The collection path" (E8–E13, E9, D10)
**What you are building:** one diagnostics line **per collected product**, and
the rule that a run stops printing after 50 products.

#### 3.1 The rule, in plain words

* A collection run scrapes products one at a time.
* The **first 50** products of the run each print one line.
* From the 51st onwards, that run prints **nothing more** (decision D7).
* The counter resets when a **new** collection starts.
* The cap applies to **collections only** — saving a product always prints
  (decision D8).

#### 3.2 Give the content script a sink for the whole run

`src/entrypoints/amazon.content.ts`:

- Keep a `Map<normalized ASIN, ExtractionDiagnosticsReport>` for the current
  run, a `Set<normalized ASIN>` for reports already sent, and a `loggedThisRun`
  counter. Normalize both the report ASIN and the product ASIN with the same
  `normalizeASIN` helper.
- Clear the map, set, and counter in `handleCollectProducts`, right where
  `collectedProducts` is reset to `[]` — that is where a new run begins.
- Keep the first report per unique ASIN. Re-parses of the same card do not
  burn cap slots; check the cap **before** accepting a new ASIN:

```ts
const runReports = new Map<string, ExtractionDiagnosticsReport>();
const sentReportAsins = new Set<string>();
let loggedThisRun = 0;

const sink: ExtractionDiagnosticsSink = {
  accept(report) {
    const key = normalizeASIN(report.asin);
    if (!key || runReports.has(key)) return; // duplicate/re-parse
    if (loggedThisRun >= COLLECTION_DIAGNOSTICS_LIMIT) return; // first 50
    loggedThisRun += 1;
    runReports.set(key, report); // first report wins
  },
};
```

When a batch is built, send only the reports for batch products not already
sent this run, in batch order. Mark each report's normalized ASIN sent at the
same time. An `updatedExisting` batch re-sends the whole product run, so a
parallel array would misalign and repeat reports; reports are a subset that
self-identify by ASIN (D11), not a parallel array.

Put `COLLECTION_DIAGNOSTICS_LIMIT = 50` in
`src/engines/amazon/constants/defaults.ts` next to the other constants, with
a comment saying what it means.

Pass that sink into the listing parsers in `extractCurrentPageProducts`
(lines 84–101).

Also give the **product-page branch** of `extractCurrentPageProducts`
(lines 78–80) a collector, so a collection started on a product page also
reports (currently it reports nothing at all).

#### 3.3 Carry the reports to the worker

`src/engines/amazon/schemas/messages.ts` — `ProductsCollectedMessageSchema`
(line 112) gains:

```ts
/**
 * SAD-369 D11: a subset of this message's products, self-identified by ASIN;
 * not a parallel array. Only reports not sent earlier this run are included.
 */
extractionDiagnostics: z.array(ExtractionDiagnosticsReportSchema).optional(),
```

The `AmazonExtensionMessage` member in `types/index.ts` gains the matching
optional field (the registry-sync test protects the type/schema pairing).
The content script attaches the reports not yet sent for the current batch,
in batch order. Products after the cap or parsed while diagnostics are off
have no report. A duplicate/re-sent product never causes the worker to log the
same report twice in one run (D11).

#### 3.4 Print them in the worker

`src/engines/amazon/background/handler.ts` — `processProductsCollected`
(line 422) and `handleProductsCollected` (line 554) receive the new array.
Print one line per report under the stage **`collection-card`**, using the
collection's `sessionKey` as the job id.

The background already serialises this work through `pendingProductsChain`,
so the lines come out in collection order.

#### 3.5 E9/D9: telling "absent" from "unparseable"

> **Owner-approved, required scope (D9):** this is diagnostics-only and
> additive. Read plan §7.1 and SAD-373 before editing; preserve the exact
> `{ price, currency, priceTier }` parity invariant.

`extractCardPricingAndDiscounts` (`src/engines/amazon/scraper/field-parsers.ts`,
around line 849) walks 4 tiers and falls through whether a price node is
**missing** or **present but unparseable**. Today those two look the same.

The diagnostics rule says: never report a field as absent when the engine
cannot prove it. So the card report should say `PARSE_FAILED` when a price
node was there but would not parse.

The change: record **which tier found a node whose text would not parse**, and
return it as one **new optional field**. Nothing else changes — the same
price, the same currency, the same tier come out. Every existing caller
ignores the new field.

**Prove it:** write a test that parses the same card with and without the
change and asserts the extracted product is byte-identical. If it is not, you
have changed extraction — undo it.

This E9 change is part of SAD-373, not an optional extra: the owner
approved the additive `unparseablePriceTier` field. A price node present but
unparseable is `PARSE_FAILED`; an actually absent node remains `MISSING`.

#### 3.6 Move the drift line to the service worker (D10)

`logDriftReport` keeps its emission points and exact one-line format, but
production no longer prints drift in the Amazon page console. In
`drift-telemetry.ts`, add a pure `formatDriftLogLine` and injectable
`setDriftTransport`; the content script sets a transport that sends
`DRIFT_REPORT` and resets it in `__PPHUNT_CONTENT_CLEANUP__`. The default
transport remains `console.info` so direct-call tests and non-extension
contexts keep their existing behavior.

Register `DRIFT_REPORT` in **all three** places: the
`AmazonExtensionMessage` union (`types/index.ts`), the Zod union
(`schemas/messages.ts`), and `AMAZON_MESSAGE_TYPES` (`validate-message.ts`).
The worker handles the message, checks its cached diagnostics switch, and
prints `formatDriftLogLine(validated.payload)`. Keep the report counts-only;
no product values cross the message boundary (C2).

#### 3.7 Check it worked

```bash
npx tsc --noEmit && npx vitest run && npm run build && npm run check:dead-exports
```

New tests (plan §7, T23–T29, adjusted for D11):

- a collection of 10 cards → 10 reports reach the worker, printed as
  `collection-card` with the collection session key as jobId
- a collection of 60 cards → **exactly 50** reports; the 51st is not printed
- a **second** collection run resets the counter and sent-report set
- re-parses do not consume cap slots; an `updatedExisting` resend does not
  print any report a second time; every report ASIN belongs to the run
- a collection started on a product page produces a `collection-card` report
- the cap does **not** apply to a save
- E9 parity: an unparseable price keeps `{ price, currency, priceTier }`
  unchanged and the report says `PARSE_FAILED`
- `DRIFT_REPORT`: transport sends the message with no page-console line; the
  worker prints the byte-identical line when on and nothing when off; the
  message-registry sync test covers the new type

#### 3.8 Commit, push, comment

```bash
git commit -m "SAD-369 step 3: per-product collection reports with the 50-item cap; drift line to the service worker"
git push origin main
```

---

### B.4 Step 4 — live verification and documentation

**Linear:** SAD-374 · **Design:** plan §8 and §9
**What you are building:** proof that it works in a real browser, and the
documentation.

#### 4.1 Run the full gate

```bash
npm run build
npx tsc --noEmit
npx vitest run
npm run check:dead-exports
git diff --stat <the commit before step 1> -- src/engines/temu/    # must be EMPTY
git diff --stat <the commit before step 1> -- wxt.config.ts        # must be EMPTY
```

#### 4.2 Check it in a real browser

1. `npm run build`, then load `dist/chrome-mv3` at `chrome://extensions`
   (Developer mode → Load unpacked).
2. Open the side panel → **Settings** → turn **Enable extraction diagnostics**
   **on**.
3. Open `chrome://extensions` → PPHunt → the **"Service worker"** link. That
   opens the single console where the per-field and drift lines appear. The
   page console receives no diagnostics lines (D10).
4. Work through this table:

| # | Do this | Expect |
|---|---|---|
| L1 | Turn the switch **off**, then save anything | **no** `[PPHunt][Amazon][Diagnostics]` line anywhere |
| L2 | Switch on, right-click a **product page** | one `detail-page` line |
| L3 | Switch on, right-click a **card** | one `card` line (+ one `enrichment-parse` line if the fetch works) |
| L4 | Switch on, the **card icon** | one `card` line |
| L5 | Switch on, a **manual collection** of N ≤ 50 | N `collection-card` lines in the service-worker console |
| L6 | Switch on, a collection of **more than 50** | **exactly 50** lines, and the collection still runs normally |
| L7 | Switch on, any listing | the drift line in the **service-worker** console, same prefix and JSON shape (D10) |
| L8 | Flip the switch with the page open | it takes effect without a reload |

> **L6 is slow** — it needs a real collection of 51+ products, which means
> scrolling a long page. Do it once, on a normal connection, and record the
> result honestly in the report, including if you could not complete it.

#### 4.3 Write the documentation

* **`CHANGELOG.md`** — a new `## [Unreleased] — <Feature> (SAD-369)` section.
  Say plainly that the diagnostics are now **off by default** and that this
  changes the behaviour shipped in SAD-359. Mention the card report, the
  collection reports, the 50-item cap and the four stages.
* **`ARCHITECTURE.md`** — extend the SAD-369 section with the switch, the
  sink, the 20 + 4 field split for cards, the four stages and the single
  service-worker console (D10).
* **The plan doc** — add an implementation record: one line per step with
  its commit, the final test count, and **any deviation and its reason**.
  Deviations are fine; undocumented ones are not.

#### 4.4 Commit, push, comment, close

```bash
git commit -m "SAD-369 step 4: live verification, changelog and implementation record"
git push origin main
```

Comment on **SAD-374**: the files changed, the tests added and run, the
command output, live-check results and limitations (including anything not
exercised). Then move **SAD-369** to **In Review**.

---

## Part C — Rules that hold for every step

### C.1 Never change what is extracted

No selector, no extraction strategy, no field mapping, no data model, no
enrichment behaviour, no persistence, no export, no UI behaviour. The
diagnostics are a **side channel** that watches; it must never touch.

### C.2 Never log product values

Log statuses, sources, selectors, tiers, reasons and counts. **Never** a
title, a price, a URL, an HTML fragment or a large object. The existing
formatter already does this — keep using it.

### C.3 The Temu engine is out of bounds

```bash
git diff --stat <baseline> -- src/engines/temu/   # must always be EMPTY
```

The switch key is Amazon-scoped, so it cannot affect the Temu logger.

### C.4 Never break an existing feature

The full suite must stay green. If a test fails because you changed a
behaviour on purpose, that is a red flag, not a licence.

### C.5 One commit per step, pushed, then commented on

Push to `main` with `git push origin main`, then comment on the step's Linear
sub-issue. Authenticate through a secure Git credential mechanism; never write
a personal access token into the repository, remote configuration or a
committed file. Do not start the next step until the push and the comment are
done.

### C.6 When you get stuck

Ask before guessing. Write down exactly what you tried, what you expected and
what happened. "I expected X and got Y" is a good bug report; "it does not
work" is not.

---

## Part D — Where things live

| Thing | Where |
|---|---|
| The collector, the 24 fields, the formatter | `src/engines/amazon/scraper/extraction-diagnostics.ts` |
| The card recorder (new) | `src/engines/amazon/scraper/card-diagnostics.ts` |
| The switch key and default (new) | `src/engines/amazon/constants/diagnostics.ts` |
| The switch accessor (new) | `src/engines/amazon/utils/diagnostics-flag.ts` |
| The card parsers | `src/engines/amazon/scraper/search-results.ts`, `category-page.ts` |
| The content script | `src/entrypoints/amazon.content.ts` |
| The save path | `src/engines/amazon/content/save-product.ts`, `background/save-job.ts` |
| The enrichment path | `src/engines/amazon/background/enrich-saved-product.ts` |
| The collection path | `src/entrypoints/amazon.content.ts`, `background/handler.ts` |
| The Settings screen | `src/engines/amazon/ui/components/SettingsOverlay.tsx` |
| The message schemas | `src/engines/amazon/schemas/messages.ts` |
| The design plan | `docs/plans/SAD-369-diagnostics-everywhere-and-toggle-plan.md` |
| The live-measurement harness | `scripts/sad-359-diagnostics-measurement.mjs` |
iagnostics-measurement.mjs` |
