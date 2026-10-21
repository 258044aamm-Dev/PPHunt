# SAD-378 — Preview Horizontal Scroll Behaviour: Detailed Implementation Plan

> **Status:** plan only. No file under `src/` or `tests/` was modified in this repository.
> The candidate patch described in §7 was typed into a **separate throwaway clone**
> (`/home/user/trial`, an independent `git clone` of this repo) and measured there, so the
> numbers quoted below are observations of real layout, not predictions.
>
> Linear: <https://linear.app/sad-mod/issue/SAD-378/preview-horizontal-scroll-behavior>
> Team: Sad_mod · Project: PPHunt · Label: Bug · Priority: 1 (Urgent)
> Description: "Fix the preview so users can scroll horizontally to view content that exceeds the
> available width. Ensure horizontal scrolling works correctly without breaking the existing layout
> or vertical scrolling."

---

## 0. How this plan was produced (anti-guessing audit)

Nothing in this document is inferred from source comments or from how similar code "usually"
behaves. Every claim is one of: **(R)** read directly from the code with a `file:line`
reference, **(M)** measured in a real Chromium against the real components, or **(T)** measured
by running the project's own toolchain.

| Kind | What was done | Where |
| ---- | ------------- | ----- |
| R | Full read of the preview render path: `src/entrypoints/preview/PreviewPageApp.tsx`, `src/engines/amazon/ui/components/FullWidthPreviewModal.tsx`, `src/engines/amazon/ui/table/AmazonProductTable.tsx`, `src/engines/temu/ui/table/TemuProductTable.tsx`, `src/entrypoints/sidepanel/components/TableToolbar.tsx`, `src/entrypoints/sidepanel/global.css`, `src/lib/preview/previewStateSync.ts`, `src/engines/amazon/ui/hooks/useAmazonSettings.ts`, `src/engines/amazon/ui/table/columns.tsx` | this repo @ `5e24561` |
| M | A throwaway Vite harness (`{repo}/.harness/main.tsx`, deleted again) that mounts the **real** `PreviewPageApp` and the **real** `AmazonFullWidthPreviewModal`, seeds `PPHuntDB` / `PPHuntTemuDB` with synthetic rows through Dexie, and is driven by Playwright/Chromium (headless_shell) at `320×560 … 1440×900`. Every number in §4 and §9 comes from `getBoundingClientRect()`, `clientWidth`, `scrollWidth`, `scrollLeft` and `getComputedStyle()` on the live DOM. | `compare.mjs` (appendix A) |
| T | `npx tsc --noEmit` and `npx vitest run` were executed **on the patched clone** to prove the change compiles and breaks nothing: `tsc` exit 0; **1182/1182 tests pass**, 1 suite errors only because `dist/` was not built (`tests/manifest-permissions.test.ts` needs `wxt build`) | `/home/user/trial` |
| R/W | `jsdom` cannot lay out pages, so the existing `tests/preview-horizontal-scroll.test.tsx` asserts class tokens and `scrollLeft` arithmetic only — it structurally **cannot** see the defect this ticket is about. That was confirmed by reading that test and by the fact that it passes on `main` while the bug is reproducible in Chromium (§4). | `tests/preview-horizontal-scroll.test.tsx` |

Reproduction one-liner for a reviewer (after `npm ci`):

```bash
npx vite --config vite.harness.config.ts   # harness app, host 0.0.0.0:5179
# open  http://localhost:5179/?mode=overlay&previewMode=sidebar&sections=1&count=60
#       → try to scroll the table sideways: it does not move (before the fix)
#       → same URL with &sections=0 (default) scrolls fine
```

---

## 1. The reported behaviour, restated precisely

The reporter's own words, which match what was measured:

> "All of them, but my requirement is that all horizontal discoveries are visible, but I can't
> scroll it. For that, I require it to move down, and then I can scroll. If I am at the top of the
> panel, at the top of the preview section, and I want to scroll horizontally, then I can't."
> — **Symptom:** *only the per-category sections scroll separately*; **Sections toggle: ON**.

So the ticket is **not** "there is no horizontal scrollbar anywhere". On `main`:

* **Sections OFF (default)** — horizontal scrolling already works on every surface (§4.1).
* **Sections ON** — the table area is **not scrollable at all**; each of the three
  *Organic / Sponsored / Recommendations* cards owns a private horizontal scrollbar that is
  **painted at the bottom of that section**, which for a real collection is **thousands of pixels
  below the fold**. To scroll sideways the user must first scroll down to the bottom of a
  section, use *that* section's bar, and repeat per section — exactly the complaint.
* **All surfaces, ≤ ~420 px wide** — the sort controls in the toolbar overflow their row and are
  clipped by `overflow-hidden`, so `+ Sort Field` is unreachable (§4.3).

"All of them" (side panel in *Sidebar* mode, *Overview* overlay, and the dedicated
`preview.html` tab) is explained by the fact that all three surfaces render the **same component**
(`AmazonProductTable`, §2.2) — one defect, three hosts.

---

## 2. Codebase map of the preview surfaces

### 2.1 The three preview hosts (`PreviewDisplayMode = 'sidebar' | 'overview' | 'tab'`)

| Mode | Entry | Renders |
| ---- | ----- | ------- |
| `tab` | `src/entrypoints/preview/main.tsx` → `PreviewPageApp` (`src/entrypoints/preview/PreviewPageApp.tsx:340-365`) | `<AmazonProductTable fullHeight … />` inside `<main className="flex-1 min-h-0 min-w-0 p-5 flex flex-col overflow-hidden">` |
| `overview` / `sidebar` | `src/engines/amazon/ui/components/FullWidthPreviewModal.tsx:189` (mounted from `AmazonEngineApp`, alias re-exported at `src/entrypoints/sidepanel/components/FullWidthPreviewModal.tsx` for legacy imports) | `<AmazonProductTable fullHeight … />` inside `fixed inset-0 … flex flex-col p-4 overflow-hidden` |
| Temu equivalents | `src/engines/temu/ui/components/FullWidthPreviewModal.tsx:184`, `src/entrypoints/preview/PreviewPageApp.tsx:343` | `<TemuProductTable … />` |

`PreviewModeSwitcher` (`src/entrypoints/sidepanel/components/PreviewModeSwitcher.tsx`) and
`previewStateSync` only move the *session/sort/filter snapshot* between hosts; they do not affect
layout. No change is needed there.

### 2.2 The single component that owns scrolling

`src/engines/amazon/ui/table/AmazonProductTable.tsx` (732 lines) is the only scroll owner for
Amazon, in **both** section modes:

| Line(s) | What it is |
| ------- | ---------- |
| `120` | `const parentRef = useRef<HTMLDivElement>(null)` — the scroll element |
| `240` | `const totalTableWidth = table.getCenterTotalSize()` (TanStack `columnSizingFeature.utils.js:266`; it is *not* the whole table — only unpinned columns) |
| `243-248` | `useVirtualizer({ count, getScrollElement: () => parentRef.current, estimateSize: () => ROW_HEIGHT (52), overscan: 10 })` |
| `253-280` | `handleKeyDown` — ArrowLeft/ArrowRight → `parentRef.current.scrollLeft ± 120` (`KEYBOARD_SCROLL_STEP`, line 33) |
| `282-288` | `handleWheel` — Shift+wheel → `scrollLeft += deltaY` |
| `341-342` | root: `<div className="flex flex-col h-full flex-1 min-h-0 min-w-0 w-full">` |
| `343-357` | `<TableToolbar … />` |
| `360-372` | the scroll container: `data-testid="preview-table-scroll-container"`, `role="region"`, `tabIndex={0}`, `onKeyDown`, `onWheel`, `className="preview-table-scroll flex-1 min-h-0 min-w-0 w-full overflow-x-auto overflow-y-auto …"`, `style={fullHeight ? undefined : { maxHeight: 'calc(100vh - 220px)' }}` |
| `373-…` | `separateCategorySections ? (<sections>) : (<single table>)` |

`TemuProductTable.tsx` is the same shape (scroll container at line 307-316, virtualizer 191-201,
same `handleKeyDown`/`handleWheel`), but it has **no sections mode** — `TableToolbar` is called
there without the category props (`TemuProductTable.tsx:292-305`). Temu therefore only needs to
survive the fix unchanged (§9.2).

### 2.3 The sections branch (where the defect lives), `main` line numbers

```
373        {separateCategorySections ? (
374-377      <div className="flex flex-col gap-3 p-2.5" data-testid="collapsible-category-sections">
379-410        [section descriptors: organic / sponsored / recommendation]
411            .filter(visible by categoryFilter).map((section) => {
412-414        sectionRows = rows.filter(matchesListingCategoryFilter(...))     ← NOT virtualised
424-428        <div data-testid={`category-section-${category}`}
                    className="border border-hairline-soft rounded-sm overflow-hidden bg-surface">
429-431          <button data-testid={`category-section-toggle-${category}`} aria-expanded={!isCollapsed}
                      className={`w-full flex flex-wrap …`}>                        ← header bar
459-460          {!isCollapsed && (<div className="overflow-x-auto">                ← private scroller #1..#3
461-465            <table className="border-collapse table-fixed" style={{ width: `${totalTableWidth}px`, minWidth: `${totalTableWidth}px` }}>
```

Three independent things follow from those lines, and all three were measured:

1. Each `<table>` is `3354 px` wide (`totalTableWidth`) inside a **card that is only as wide as the
   scrollport** (`overflow-hidden` clamps it), so the only thing that can scroll is the *inner*
   `overflow-x-auto` div.
2. Because the wrapper (`374`) and the cards are all scrollport-width, the **outer** container
   (`360`) has `scrollWidth === clientWidth`, i.e. **nothing to scroll**: its `overflow-x-auto` is
   inert.
3. `handleKeyDown`/`handleWheel` are bound to the **outer** container (`onKeyDown`/`onWheel` on
   line 367-368). Key/pixel events bubble from the inner scroller up to the outer one, which
   cannot scroll, so Arrow keys and Shift+wheel are dead too — the *only* input that works is
   grabbing a section's own scrollbar.

That is the "requires me to move down first" behaviour: the inner bar lives at the bottom of a
13,000 px-tall section (§4.2).

### 2.4 The setting that switches modes

`separateCategorySections` is a persisted Amazon setting:
`src/engines/amazon/ui/table/AmazonProductTable.tsx:122` (`useAmazonSettings`),
toggled from the toolbar pill (`TableToolbar.tsx:281-292`, `Sections: On/Off`) and from
*Settings → Preview* (`SettingsOverlay.tsx:501-503`). Value survives restarts, which is why the
reporter "always" has it on. Both toggle paths must be exercised (§10, step 4).

### 2.5 Styling contract that must be preserved

`src/entrypoints/sidepanel/global.css:96-124` — `.preview-table-scroll` owns the SAD-138
high-visibility scrollbars (`::-webkit-scrollbar { height: 10px }`, thumb `--color-hairline` →
`--color-clay` on hover, `scrollbar-gutter: stable`, styled corner). Imported by both
`sidepanel/main.tsx:4` and `preview/main.tsx:5`, so any change here is a **three-surface,
two-engine** change — treat with care.

---

## 3. Why the existing test suite is green while the bug ships

`tests/preview-horizontal-scroll.test.tsx` (SAD-138) asserts:

* `scrollContainer.className` contains `preview-table-scroll`, `overflow-x-auto`,
  `overflow-y-auto`, `flex-1`, `min-h-0`, `min-w-0`;
* `scrollContainer.style.maxHeight === ''` in `fullHeight` mode;
* `<table>.style.width` parses to `> 1000` and `minWidth === width`;
* ArrowRight/ArrowLeft/Shift-wheel arithmetic on `scrollLeft` (jsdom implements `scrollLeft` as a
  plain settable number, so the handlers "pass" without any layout).

Every assertion is satisfied by the *broken* sections markup, because the test only renders the
**default** (`separateCategorySections: false`) table and jsdom does no layout. Nothing in the
repo renders the sections branch inside a layout engine — `tests/product-categorization.test.tsx:317-378`
only checks that the section test-ids appear/disappear and that collapsing works.

**Consequence for this plan:** a jsdom-only test is *insufficient evidence*. The plan therefore
pairs (a) cheap jsdom structural guards that will fail on regression (§8.1) with (b) a repeatable
Chromium measurement script that asserts the real geometry (§8.2), modelled on the existing
`scripts/sad-359-diagnostics-measurement.mjs` precedent.

---

## 4. Measured baseline on `main` (`5e24561`) — the defect, in numbers

Harness: real components, 60 seeded Amazon rows (3 sections populated), Chromium 400×800 /
900×700. `scrollport` = the `preview-table-scroll-container`; `outerScrollWorks` = `scrollLeft`
can be set to 600 and stays there; `nestedHScrollers` = `.overflow-x-auto` descendants.

### 4.1 Horizontal scrolling per surface

| Scenario | viewport | scrollport w | scrollWidth | nested H-scrollers | outer scroll works | inner (per-section) scroll works |
| --- | --- | --- | --- | --- | --- | --- |
| Overlay · **Sections OFF** · 400 px | 400×800 | 358 | **3354** | 0 | ✅ yes | — |
| Overlay · **Sections ON** · 400 px | 400×800 | 358 | **358** | **3** | ❌ **no** | ✅ yes (per card) |
| Tab · **Sections ON** · 900 px | 900×700 | 850 | **850** | **3** | ❌ **no** | ✅ yes (per card) |
| Tab · Temu · 400 px | 400×800 | 350 | 3068 | 0 | ✅ yes | — |
| Tab · Amazon default · 1440 px | 1440×900 | 1390 | 3354 | 0 | ✅ yes | — |

Vertical scrolling works in every row above, and the outer bar is inside the viewport in every
row — so the failure is *purely* "the outer container has no horizontal overflow to give".

### 4.2 Why the working bar is out of reach (Sections ON, 300 products, tab 400×800)

```
outer           cw 350   sw 350     (nothing to scroll)   ch 322   sh 19,704
section 1 card  cw 328   sw 3354    spans y = 534 … 13,383
section 2 card  cw 328   sw 3354    spans y = 13,479 … 19,928
section 3 card  cw 328   sw 3354    spans y = 20,053 … 20,150
first section's own horizontal scrollbar: 533 px + 13,383 px tall section  →  ≈ 12,583 px BELOW the fold
```

Also measured in the same run: default mode renders **1,698** DOM nodes / 17 virtual rows for 300
products; Sections mode renders **27,011** nodes / 300 rows, because `sectionRows` maps every row
(line 412-414) instead of using `virtualItems`. That is **pre-existing** behaviour, unchanged by
this ticket, and is listed as an out-of-scope risk in §11 (with a noted follow-up).

### 4.3 Second defect surface: toolbar clipping at narrow widths (`main`)

The sort group is `flex items-center gap-1.5 shrink-0` (`TableToolbar.tsx:164`) and its two
`<select>`s have no `max-width`, so the group's intrinsic width is **407 px**. Its parent row is
`flex flex-wrap items-center gap-2` inside `overflow-hidden` ancestors, but a `shrink-0` flex item
whose *children* cannot shrink will overflow the row instead of wrapping.

| Scenario | toolbar container | overflowing nodes | preset `<select>` visible | `+ Sort Field` visible |
| --- | --- | --- | --- | --- |
| Overlay 320 px | 288 | 2 (group 407 px, `+ Sort Field` 194 px) | ✅ | ❌ **clipped** |
| Tab 360 px | 320 | 2 | ✅ | ❌ **clipped** |
| Overlay 420 px | 388 | 2 | ✅ | ❌ **clipped** |

The documented design target is a 320–360 px side panel (see `docs/plans/SAD-358-cell-expand-plan.md:182`,
"sidepanel width 360px"), so this is in-scope for "all horizontal discoveries are visible".

---

## 5. Root cause (three defects, one owner)

| # | Defect | Mechanism | Blast radius |
| - | ------ | --------- | ------------ |
| **A** | Sections mode is not one horizontal scroll surface | cards are scrollport-width (`overflow-hidden`) and the tables are 3354 px wide *inside* a private `overflow-x-auto` (line 459); the outer `preview-table-scroll` therefore has `scrollWidth == clientWidth` and its `overflow-x-auto` + key/wheel handlers (`253-288`) have nothing to act on | Amazon preview, **all three hosts**, only when `separateCategorySections` is ON |
| **B** | (would be introduced by a naive fix of A) a 3354 px-wide header bar | if the cards/wrapper are simply widened, the section header `<button>` stretches to the table width and its right-hand side (`description`, `1 × 3` etc.) sits ~3,000 px to the right; the bar also scrolls out of view | Amazon preview, Sections ON |
| **C** | Toolbar sort controls clipped < ~420 px | `shrink-0` group, 407 px intrinsic, non-shrinking `<select>`s | Amazon **and** Temu (shared `TableToolbar`), all hosts |

Defect A is the ticket. B is the trap that the first obvious fix falls into; C is the other
"can't reach the content" report and the user explicitly asked for it (§12 decision D7).

---

## 6. Design decisions (locked) and alternatives rejected

**D1 — One scroll owner per table area, in both modes.**
The `preview-table-scroll-container` (`AmazonProductTable.tsx:360`) stays the *only* horizontal
scroll surface. Rationale: the existing keyboard (`253-280`), wheel (`282-288`), `focus-visible`
ring, `role="region"` + `aria-label`, SAD-138 scrollbar styling, `tabIndex={0}`, `scrollbar-gutter`,
and the virtualizer's `getScrollElement` all already target exactly this element. Every other
option duplicates or moves those contracts.

**D2 — Give the wrapper an intrinsic content width: `w-max min-w-full`.**
The sections wrapper (line 374) becomes `w-max min-w-full`: content-width = widest child
(3,376 px measured = 3,354 px table + 2×10 px padding + 2 px border), never narrower than the
scrollport. `min-w-full` prevents a jitter-free narrow state when every section is collapsed.

**D3 — Delete the per-section `overflow-x-auto` (line 459).**
It is the thing that "eats" the overflow before the outer container can see it. Keeping it would
mean two nested horizontal scrollers — the current bug, plus double scrollbars.

**D4 — Section card `overflow-hidden` → `overflow-clip`.**
`overflow-hidden` makes the card a **scroll container**, which (i) would clamp the 3354 px table
again and (ii) becomes the containing block that cancels `position: sticky` on the header bar.
`overflow: clip` still clips to the card's rounded border but is *not* a scroll container, so
sticky keeps resolving against the table scroller. Browsers: `overflow: clip` is supported in
Chrome 90+, Edge 90+, Firefox 81+, Safari 16+ (all below this extension's floor).

**D5 — Section header bars: `sticky left-0 z-10 w-[100cqw]` + `.preview-table-scroll { container-type: inline-size }`.**
`100cqw` = 100 % of the nearest size-container's content box = **the scrollport's `clientWidth`**
(measured: 358 / 850 exactly), so each bar is exactly as wide as the visible table area and pinned
to its left edge while the table scrolls under it (`sticky`, offset measured 1 px = the card border).
Container queries/`cq*` units are supported in Chrome/Edge 105+, Safari 16+, Firefox 110+
(MDN: "well established … available across browsers since February 2023"), below the Chrome 114
floor implied by the `sidePanel` permission in `wxt.config.ts`.
*Rejected alternative — measure with JS (`ResizeObserver` + `useState`):* I implemented it first and
measured it returning **0**: the effect that observes `parentRef` runs while the component is still
in its loading/empty early-returns (`AmazonProductTable.tsx:329-339`), so the scroller is not
mounted yet and no dependency changes afterwards → `data-scrollport="0"` → bars fell back to
card width (494/631/784 px, measured). It can be made to work with a callback ref, but it costs a
re-render of every rendered row on each resize and adds state to a hot component for something CSS
does declaratively. Keep it documented in §11 as the fallback if a future refactor makes the
size container impossible.
*Rejected alternative — pin the first columns (`columnPinning`) instead:* does not address the
missing outer scroll, changes export/render contracts, and would fight the 3-sections layout.

**D6 — Toolbar: wrap instead of overflow.**
`shrink-0` → `flex-wrap … min-w-0 max-w-full` on the sort group, plus `max-w-full` on both
`<select>`s. Result (measured): 0 overflowing nodes at 320/360/420 px in both hosts, the preset
select stays on row 1, `+ Sort Field` wraps to row 2 fully visible. No new markup, no change to the
`data-testid`s, the presets list, `matchSortPresetId`, or the sort state plumbing → export/sort
behaviour untouched.

**D7 — Scope, per the user's own instruction ("everything I reproduced").**
Include A + B + C. Explicitly exclude: column pinning, per-section virtualisation, changes to
sorting/filter/export, changes to `PreviewModeSwitcher`/`previewStateSync`, any Temu behaviour
change, and any redesign of the toolbar.

**D8 — No API, schema, storage, message or permission changes.**
The patch touches JSX class names + one CSS declaration. Nothing in
`src/lib/schemas/**`, `src/engines/**/schemas/**`, `wxt.config.ts`, Dexie versions, or the message
registry is modified, so `tests/message-schema-conformance.test.ts`,
`tests/manifest-permissions.test.ts` and `tests/docs-consistency.test.ts` stay green by construction
(verified: §9.1).

---

## 7. The change set (verified: 3 files, 10 insertions, 7 deletions)

Reproduced verbatim from the throwaway clone (`git diff` in `/home/user/trial`).

### 7.1 `src/engines/amazon/ui/table/AmazonProductTable.tsx`

```diff
@@ 373-377   (sections wrapper)
         {separateCategorySections ? (
           <div
-            className="flex flex-col gap-3 p-2.5"
+            className="flex flex-col gap-3 p-2.5 w-max min-w-full"
             data-testid="collapsible-category-sections"
           >
@@ 424-428   (section card)
                   <div
                     key={section.category}
                     data-testid={`category-section-${section.category}`}
-                    className="border border-hairline-soft rounded-sm overflow-hidden bg-surface"
+                    className="border border-hairline-soft rounded-sm overflow-clip bg-surface"
                   >
@@ 429-434   (section header bar)
                     <button
                       type="button"
                       data-testid={`category-section-toggle-${section.category}`}
                       aria-expanded={!isCollapsed}
                       onClick={() => toggleSectionCollapsed(section.category)}
-                      className={`w-full flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-hairline-soft text-left transition-colors cursor-pointer ${section.headerClass}`}
+                      className={`sticky left-0 z-10 w-[100cqw] flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-hairline-soft text-left transition-colors cursor-pointer ${section.headerClass}`}
                     >
@@ 459-460   (per-section scroller — removed)
                     {!isCollapsed && (
-                      <div className="overflow-x-auto">
+                      <div>
                         <table
```

Notes for the implementer:

* `w-full` on the bar is replaced by `w-[100cqw]` (not added to) — `w-full` inside the widened card
  means 3,354 px, which is the whole point of defect B.
* `sticky left-0` needs the *card* to be non-scrolling (D4) and the *scroller* to be the nearest
  scroll container (D1). Both are enforced by this same patch, so do not split it across commits.
* No `useState`/`useEffect`/`ResizeObserver` is introduced; the component's prop surface,
  `meta`, `getRowId`, sorting and selection plumbing are untouched.

### 7.2 `src/entrypoints/sidepanel/global.css` (shared by sidepanel + preview entrypoints)

```diff
@@ 95-98
   /* High-visibility pinned horizontal & vertical scrollbar for Preview table (SAD-138) */
   .preview-table-scroll {
     scrollbar-gutter: stable;
+    /* SAD-378: the table area is a size container so sections-mode header bars
+       can be pinned to the visible width (`100cqw`) instead of the table width. */
+    container-type: inline-size;
   }
```

Containment side effects reviewed and measured (§9.2): `container-type: inline-size` implies
`contain: layout style inline-size`, which (a) makes the scroller a containing block for `fixed`/
`absolute` descendants and (b) creates a stacking context. The **only** `position: fixed` element in
the subtree is `CellExpandModal` (`CellExpandModal.tsx:212`, `fixed inset-0 z-50`), and it is
rendered as a **sibling** of the scroller (`AmazonProductTable.tsx:715`), not inside it — verified
in Chromium: the dialog still covers `0,0 → 400,800` of the 400×800 viewport. The sticky `thead`
(`z-10`) and the sticky bars are inside the containment context, so their stacking is unaffected
(measured: header still pinned after `scrollTop = 300`).

### 7.3 `src/entrypoints/sidepanel/components/TableToolbar.tsx` (shared by Amazon + Temu)

```diff
@@ 163-170   (sort control group)
         {onSortingChange && (
-          <div className="flex items-center gap-1.5 shrink-0">
+          <div className="flex flex-wrap items-center gap-1.5 min-w-0 max-w-full">
             <select … data-testid="table-sort-preset-select"
-              className="bg-surface border border-hairline rounded-sm text-ink font-sans text-xs px-2.5 py-2 focus:border-ink focus:outline-none transition-colors cursor-pointer"
+              className="bg-surface border border-hairline rounded-sm text-ink font-sans text-xs px-2.5 py-2 max-w-full focus:border-ink focus:outline-none transition-colors cursor-pointer"
@@ 186-193   (add-sort select)
               <select … data-testid="table-add-sort-select"
-                className="bg-surface-card border border-hairline-soft rounded-sm text-ink-muted hover:text-ink font-sans text-xs px-2 py-2 focus:border-ink focus:outline-none transition-colors cursor-pointer"
+                className="bg-surface-card border border-hairline-soft rounded-sm text-ink-muted hover:text-ink font-sans text-xs px-2 py-2 max-w-full focus:border-ink focus:outline-none transition-colors cursor-pointer"
```

`min-w-0` is what allows the group to become narrower than its content; `flex-wrap` is what makes
the second `<select>` move to its own row instead of being clipped; `max-w-full` on each `<select>`
keeps a very long preset label inside the panel instead of overflowing it.

### 7.4 File-change matrix

| File | Change | Lines | Risk |
| --- | --- | --- | --- |
| `src/engines/amazon/ui/table/AmazonProductTable.tsx` | 4 class-name edits in the sections branch | 4 | low — sections branch only; default branch untouched |
| `src/entrypoints/sidepanel/global.css` | +3 (1 declaration + comment) on `.preview-table-scroll` | 3 | low/medium — shared class, mitigated & measured (§9.2) |
| `src/entrypoints/sidepanel/components/TableToolbar.tsx` | 3 class-name edits | 3 | low — layout only |
| **No other file** | — | — | — |

Deliberately **not** touched: `TemuProductTable.tsx`, `PreviewPageApp.tsx`,
`FullWidthPreviewModal.tsx` (both engines), `columns.tsx`, `previewStateSync.ts`, stores, hooks,
schemas, `wxt.config.ts`.

---

## 8. Test plan

### 8.1 jsdom guards (fast, run in CI) — extend `tests/preview-horizontal-scroll.test.tsx`

Keep the existing SAD-138 tests exactly as they are (they are the "default mode is a single
scroller" guard) and add a second `describe` block: *"Sections mode is a single horizontal scroll
surface (SAD-378)"*. Seed a `db.settings` row with `separateCategorySections: true` (the
`product-categorization.test.tsx:340-360` pattern), open the overlay via
`useUIStore.getState().openPreviewOverlay(sessionKey, 'sidebar')`, mock `@tanstack/react-virtual`
as the other suites do, then assert:

1. **Exactly one horizontal scroller.** `screen.getByTestId('preview-table-scroll-container')`
   still carries `overflow-x-auto overflow-y-auto preview-table-scroll`, and
   `container.querySelectorAll('.overflow-x-auto').length === 0` (this single assertion would have
   caught the bug).
2. **The wrapper can create overflow.** `collapsible-category-sections` has `w-max` and
   `min-w-full`.
3. **Cards are not scroll containers.** every `category-section-*` has `overflow-clip` and **not**
   `overflow-hidden`.
4. **Header bars are pinned and scrollport-sized.** every `category-section-toggle-*` has
   `sticky`, `left-0`, `z-10`, `w-[100cqw]` and **does not** contain `w-full`.
5. **The container query host exists.** read `src/entrypoints/sidepanel/global.css` with
   `readFileSync` (the `docs-consistency.test.ts` pattern) and assert the `.preview-table-scroll`
   block contains `container-type: inline-size`. This is the only way to police a CSS-file change
   from jsdom, and it is the guard that keeps `100cqw` meaningful.
6. **Input methods reach the outer scroller in sections mode.** `ArrowRight` on the container →
   `scrollLeft === 120`; `ArrowLeft` → 0; Shift+wheel `deltaY: 160` → `scrollLeft === 160`;
   `ArrowLeft` inside the filter input does **not** move the container (mirrors the existing
   SAD-138 assertions, now with sections ON).
7. **Collapse still works** (`aria-expanded` flips, `tbody` disappears) — proves D4 did not break
   the toggle contract pinned by `tests/product-categorization.test.tsx:363-365`.

### 8.2 Chromium layout assertions (where the real defect is visible) — new script

`scripts/preview-scroll-measurement.mjs`, written exactly like
`scripts/sad-359-diagnostics-measurement.mjs`: loads `playwright` dynamically with a friendly
"install it" error, is npm-invoked (`"measure:preview-scroll": "node scripts/preview-scroll-measurement.mjs"`),
**never** imported by `src/`, and is not part of `npm run verify`. It builds the extension
(`wxt build`), launches Chromium with `--load-extension`, seeds `PPHuntDB` through the service
worker (as SAD-359 does), then for each viewport asserts the table in §9.4. Appendix A contains the
working harness code that produced §4/§9 numbers; the shipped script is the same logic with the
extension-loading front-end and a non-zero exit on failure.

Minimum assertion set (all measured to pass with the patch, fail without it):

| Assertion | 400 px | 900 px | 1440 px |
| --- | --- | --- | --- |
| sections ON: `scrollportSW > scrollportCW` | 3376 > 358 | 3376 > 850 | 3376 > 1390 |
| sections ON: `scrollLeft = 600` sticks | ✅ | ✅ | ✅ |
| sections ON: nested `.overflow-x-auto` count | 0 | 0 | 0 |
| sections ON: every bar width == `clientWidth` ±1 | 358 | 850 | 1390 |
| sections ON: bars still visible after `scrollLeft = 600` | ✅ | ✅ | ✅ |
| sections ON: `scrollTop = 300` works, `thead`/bars stay put | ✅ | ✅ | ✅ |
| sections OFF: unchanged DOM shape + sticky `thead` | ✅ | ✅ | ✅ |
| Temu: `sw 3068`, `scrollLeft` works, `thead` sticky | ✅ | ✅ | — |
| toolbar @320/360/420: 0 overflowing nodes, both selects fully visible | ✅ | — | — |

### 8.3 Suites to re-run (all were run on the patched clone; see §9.1)

`tests/preview-horizontal-scroll.test.tsx`, `tests/product-categorization.test.tsx`,
`tests/preview-modes-and-sorting.test.tsx`, `tests/table-v9-contract.test.tsx`,
`tests/toolbar-routing.test.tsx`, `tests/a11y-focus.test.tsx`, `tests/cell-expand-sad358.test.tsx`,
`tests/row-numbers.test.tsx`, `tests/preview-images-rownumbers-export.test.tsx`,
`tests/history-preview-export.test.tsx`, `tests/temu-isolation.test.ts`, plus the full
`npm test`.

---

## 9. Verification evidence for the patch (measured, not assumed)

### 9.1 Toolchain on the patched clone

```
npx tsc --noEmit                      → exit 0 (no diagnostics)
npx vitest run                        → Test Files 1 failed | 100 passed (101)
                                        Tests 1182 passed (1182)
   the single "failed" suite is tests/manifest-permissions.test.ts erroring on
   ENOENT .../dist/chrome-mv3/manifest.json — it requires `wxt build` to have run first
   (pre-existing behaviour of that suite, unrelated to this change)
npx vite build (harness)              → renders, no runtime errors captured on any probe
```

### 9.2 Containment side effects (the only risky line, §7.2)

| Probe | Result with `container-type: inline-size` |
| --- | --- |
| `CellExpandModal` (only `position: fixed` in the subtree) | dialog rect = `0,0 → 400,800` = full viewport ✅ unchanged |
| default-mode sticky `thead` after `scrollTop = 300` | `top` unchanged (396 → 396) ✅ |
| default-mode table intrinsic width | 3354 px, `style.width = "3354px"` ✅ unchanged |
| virtualizer inside a size container | 16–24 rows rendered at 400/900/1440 (same band as before) ✅ |
| Temu table (same CSS class) | `cw 350 / sw 3068`, `scrollLeft` works, `thead` sticky, rows render ✅ |
| `sticky` bars inside a `contain: layout` scroller | bars pinned at +1 px after `scrollLeft = 600`, width == `clientWidth` ✅ |

### 9.3 Before / after, same harness, same seeds (`compare.mjs`)

```
BEFORE main 5e24561
{"name":"overlay sidebar · Sections ON · 400px","scrollportCW":358,"scrollportSW":358,"nestedHScrollers":3,"outerScrollWorks":false,"innerScrollWorks":true,"verticalScrollWorks":true}
{"name":"preview tab · Sections ON · 900px","scrollportCW":850,"scrollportSW":850,"nestedHScrollers":3,"outerScrollWorks":false,"innerScrollWorks":true,"verticalScrollWorks":true}
{"name":"overlay sidebar · Sections OFF · 400px","scrollportCW":358,"scrollportSW":3354,"nestedHScrollers":0,"outerScrollWorks":true,"verticalScrollWorks":true}
{"name":"preview tab · Temu · 400px","scrollportCW":350,"scrollportSW":3068,"scrollX":true,"theadSticky":true,"rows":19}
{"name":"toolbar · overlay 320px","containerW":288,"overflowingToolbarNodes":2,"presetFullyVisible":true,"addSortFullyVisible":false}
{"name":"toolbar · tab 360px","containerW":320,"overflowingToolbarNodes":2,"presetFullyVisible":true,"addSortFullyVisible":false}
{"name":"toolbar · overlay 420px","containerW":388,"overflowingToolbarNodes":2,"presetFullyVisible":true,"addSortFullyVisible":false}

AFTER patch
{"name":"overlay sidebar · Sections ON · 400px","scrollportCW":358,"scrollportSW":3376,"nestedHScrollers":0,"outerScrollWorks":true,"verticalScrollWorks":true}
{"name":"preview tab · Sections ON · 900px","scrollportCW":850,"scrollportSW":3376,"nestedHScrollers":0,"outerScrollWorks":true,"verticalScrollWorks":true}
{"name":"overlay sidebar · Sections OFF · 400px","scrollportCW":358,"scrollportSW":3354,"nestedHScrollers":0,"outerScrollWorks":true,"verticalScrollWorks":true}
{"name":"preview tab · Temu · 400px","scrollportCW":350,"scrollportSW":3068,"scrollX":true,"theadSticky":true,"rows":18}
{"name":"toolbar · overlay 320px","containerW":288,"overflowingToolbarNodes":0,"presetFullyVisible":true,"addSortFullyVisible":true}
{"name":"toolbar · tab 360px","containerW":320,"overflowingToolbarNodes":0,"presetFullyVisible":true,"addSortFullyVisible":true}
{"name":"toolbar · overlay 420px","containerW":388,"overflowingToolbarNodes":0,"presetFullyVisible":true,"addSortFullyVisible":true}
```

Additional post-patch probes:

* **Runtime toggle, not just mount:** Sections **OFF** (`sw 3354`, scrolls) → click
  `Sections: Off` → **ON**: `cw 358 / sw 3376`, `scrollLeft = 500` sticks, `nested = 0`,
  bar widths `[358, 358, 358]` ✅. So the fix works for users who flip the setting mid-session,
  which is the reporter's likely path.
* **Sections geometry at 120 rows:** bars `[358,358,358]` @400 px and `[850,850,850]` @900 px,
  tables share one left edge (`tablesSameLeft: true`), `stickyLeftAfterScroll: [1,1,1]` ✅.
* **Keyboard / wheel parity with sections ON:** ArrowRight `0 → 120`, ArrowLeft `→ 0`,
  Shift+wheel `deltaY 160 → 160` ✅ (identical to the default-mode numbers the SAD-138 test pins).

### 9.4 Visual confirmation

Screenshots taken from the patched clone at 400×800 (Sidebar overlay, 60 rows): the section bar
reads `▼ ● Organic Search Results [40] (Organic)` / `Primary organic search listings`, stays on one
line-pair, and the table below starts at the `#` column — i.e. no 3,000 px-wide bar and no
content pushed out of reach. Toolbar in the same shot: preset select on row 1, `+ Sort Field` on
row 2, both fully visible.

---

## 10. Implementation & verification checklist

Run in this order; each step's expected result is stated.

1. **Branch** `fix/sad-378-preview-horizontal-scroll` off `main` (`5e24561`).
2. **Apply §7** (3 files, 10+/7-). `git diff --stat` must read exactly:
   `AmazonProductTable.tsx 8 ±`, `TableToolbar.tsx 6 ±`, `global.css 3 +`.
3. `npx tsc --noEmit` → exit 0.
4. **Chromium probe** (`npm run measure:preview-scroll`, or appendix A by hand) → every row of
   §8.2 matches. This is the gate; do not accept a jsdom-only result.
5. **Toggle path**: sidebar overlay → click `Sections: Off` then `Sections: On`; the table must
   scroll horizontally immediately after each toggle, in both directions, with the bars pinned.
6. **Panels**: side panel at 320 and 360 px wide, Overview overlay, and the dedicated
   `preview.html` tab at 900 and 1440 px; Amazon **and** Temu, sections off and on where available.
7. **Behaviour frozen**: sort by preset, Shift+click a second header, filter, category pills,
   collapse/expand each section, select rows, delete selected, open the cell-expand modal
   (must cover the full viewport), open the export modal and export CSV/Excel/Clipboard.
8. `npm test` → 1182+ passing (plus the new SAD-378 assertions); no new failures.
9. `npm run build` then `npm run verify` (`tsc && vitest && wxt build && npm audit`) → green
   (this also produces `dist/` so the manifest suites run).
10. `npm run check:dead-exports` → unchanged (no exports added/removed).
11. **Docs** (§13) and the measurement artifact committed:
    `docs/plans/sad-378-scroll-measurement-<date>.json`.

---

## 11. Risks, edge cases, out of scope

| Risk / edge | Assessment | Mitigation |
| --- | --- | --- |
| `container-type: inline-size` on a shared class | Low. Measured on all three hosts + Temu (§9.2). Only `fixed` descendant is outside the scroller. | Keep the §8.1(5) CSS guard + the §8.2 layout gate. |
| `cqw` unavailable (Firefox < 110) | Low. Firefox support arrived 110 (Feb 2023); the extension's `sidePanel` path already requires newer Chrome. Degrades to `width: auto` → bar spans the table width (defect B returns, scrolling still works). | Accept; note in the changelog entry. |
| Overlay (macOS-style) scrollbars | `container-type` queries the **content box**, so `100cqw` tracks the scrollport with or without a classic scrollbar. | Verified with a classic bar (10 px) at all widths. |
| Panel resize while Sections is ON | Pure CSS → recomputes on layout; no observers to leak. | Resizing probe in §8.2 (same page, three viewports). |
| All three sections collapsed | Wrapper `min-w-full` keeps the scroller from having zero width; no scrollbar appears (correct — nothing to scroll). | Manual step 5 in §10. |
| Filter that empties a section | Section still renders a header + "No … in current view" row inside a `3354 px` table; the outer scroller still scrolls. | Manual step 7. |
| `overflow: clip` on old Safari (<16) | Falls back to `visible`: sticky still works, corners lose clipping. Not a supported target. | — |
| Sections mode renders **all** rows (27,011 nodes at 300 products, measured) | **Pre-existing**, unchanged by this ticket: `sectionRows` bypasses `virtualItems`. Fixing the scroll surfaces makes this the dominant cost while scrolling right. | Out of scope here; propose follow-up ticket "virtualise per-category sections" (numbers in §4.2 make the case). |
| RTL / `writing-mode` | App is LTR-only (no `dir` handling anywhere in `src/`); `left-0`/`overflow-x` assumptions unchanged. | — |
| Export / clipboard / sorting contracts | Untouched by the diff. | Full suite + manual step 7. |

---

## 12. Decisions taken from your answers (change these if you disagree)

| Question | Your answer | What the plan does |
| --- | --- | --- |
| Which surface | "All of them … I can't scroll it … at the top of the preview section" | Fixes the shared component once, validated on all three hosts (§4.1, §9.3) |
| Symptom | "Only the per-category sections scroll separately" | Root cause A (§5) is exactly that; one scroll surface end-to-end |
| Sections toggle | ON | Both mount-time and runtime-toggle paths are gates (§9.3, §10.5) |
| Scope | "Everything I reproduced" | A + B + C, and nothing else (§6 D7) |
| "No unnecessary code" | — | 10 inserted lines, 0 new components/hooks/state/files; no schema/storage/message changes |

Two judgement calls worth your explicit sign-off before implementation:

1. **Header bars stay pinned** (`sticky left-0`) while the table scrolls under them, and their
   right-hand description text is clipped at panel width instead of trailing 3,000 px to the right.
   The alternative is a bar that scrolls away with the table (simplest, but the count/description
   disappears as soon as you scroll right).
2. **`+ Sort Field` moves to a second toolbar row** below ~420 px rather than being clipped or
   collapsed into an overflow menu. A "⋮ more" menu would be nicer but is more code than this
   ticket warrants.

---

## 13. Docs & commit plan (repo convention: one step per commit, SAD-xxx prefix)

| Commit | Content |
| --- | --- |
| `SAD-378 step 0: plan for preview horizontal scroll (decisions locked)` | this file |
| `SAD-378 step 1: one horizontal scroll surface for sections mode + toolbar wrapping` | §7 (3 files) |
| `SAD-378 step 2: regression guards for sections-mode scrolling` | §8.1 tests (+ §8.2 script if it lands in the same step) |
| `SAD-378 step 3: measurement artifact, changelog and docs` | `docs/plans/sad-378-scroll-measurement-<date>.json`, `CHANGELOG.md` entry under the current version (`### Fixed` → "Preview: horizontal scrolling in Sections mode, pinned section headers, and the sort controls no longer clip in a narrow side panel (SAD-378)"), plus one line in `ARCHITECTURE.md`'s preview-table section stating the invariant: *"the preview table area is the only horizontal scroll surface; sections mode re-uses it (`w-max` wrapper, `overflow-clip` cards, `sticky left-0 w-[100cqw]` header bars) and must never introduce a nested horizontal scroller."* |

`tests/docs-consistency.test.ts` constraints to respect while editing docs: it greps `README.md`
for the permission list, target range `(TARGET_MIN–TARGET_MAX)`, quick-select chips, marketplace
domains, `N data-field toggles`, and every design-token hex; and `ARCHITECTURE.md` for
`N boolean field toggles`. Add prose only — do not renumber those claims.

---

## Appendix A — the measurement harness (working code, reproduces §4 and §9)

> Throwaway, deliberately outside `src/`: run it, read the numbers, delete it. `{repo}/.harness/`
> is not part of `wxt`'s `srcDir`, so it never enters the extension bundle.

`{repo}/vite.harness.config.ts`

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.harness',
  resolve: { alias: { '@': '/absolute/path/to/repo/src' } },
  css: { postcss: '/absolute/path/to/repo' },
  server: { host: '0.0.0.0', port: 5179, strictPort: true, allowedHosts: true },
});
```

`{repo}/.harness/index.html` — `<div id="root"></div><script type="module" src="./main.tsx"></script>`

`{repo}/.harness/main.tsx` — mounts the **real** components and seeds both Dexie databases:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/entrypoints/sidepanel/global.css';
import { db } from '@/engines/amazon/db/database';
import { temuDb } from '@/engines/temu/db/database';
import { PreviewPageApp } from '@/entrypoints/preview/PreviewPageApp';
import { AmazonFullWidthPreviewModal } from '@/engines/amazon/ui/components/FullWidthPreviewModal';
import { useAmazonUIStore } from '@/engines/amazon/ui/store/uiStore';

const params = new URLSearchParams(window.location.search);

const amazonRow = (i: number) => ({
  asin: `B0HARNESS${String(i).padStart(3, '0')}`,
  title: `Harness Product ${i} — a deliberately long product title that keeps going past the column width`,
  price: 10 + i, listPrice: 20 + i, currency: 'USD', rating: 4.5, reviewCount: 100 + i,
  brand: `Brand ${i}`, seller: `Seller ${i}`, availability: 'In Stock',
  isSponsored: i % 3 === 0, isPrime: true,
  url: `https://www.amazon.com/dp/B0HARNESS${i}`,
  imageUrl: null, description: null, features: [],
  collectedAt: new Date(Date.now() - i * 1000).toISOString(),
  source: 'search', sectionLabel: i % 3 === 0 ? 'Sponsored' : 'Organic',
  placements: [], sessionKey: 'session_harness',
});

const temuRow = (i: number) => ({
  goodsId: `60109976917${8000 + i}`, asin: `60109976917${8000 + i}`,
  title: `Temu Harness Product ${i} — a deliberately long product title`,
  price: 5 + i, currency: 'USD', rating: 4.6, reviewCount: 50 + i,
  brand: `TemuBrand ${i}`, seller: `TemuSeller ${i}`, availability: 'In Stock',
  isSponsored: false, url: `https://www.temu.com/goods.html?goods_id=60109976917${8000 + i}`,
  imageUrl: null, collectedAt: new Date(Date.now() - i * 1000).toISOString(),
  source: 'search', sessionId: 'session_harness',
});

async function main() {
  const count = Number(params.get('count') ?? '60');
  await db.delete(); await db.open();
  await db.products.bulkAdd(Array.from({ length: count }, (_, i) => amazonRow(i)) as never);
  if (params.get('sections') === '1') {
    await db.settings.put({ id: 'default', separateCategorySections: true } as never);
  }
  await temuDb.delete(); await temuDb.open();
  await temuDb.products.bulkAdd(Array.from({ length: 40 }, (_, i) => temuRow(i)) as never);

  const mount = (node: React.ReactNode) =>
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>{node}</React.StrictMode>,
    );

  if (params.get('mode') === 'overlay') {
    const previewMode = (params.get('previewMode') ?? 'sidebar') as 'sidebar' | 'overview';
    useAmazonUIStore.setState({ previewMode });
    useAmazonUIStore.getState().openPreviewOverlay('session_harness', previewMode);
    return mount(<AmazonFullWidthPreviewModal />);
  }
  mount(<PreviewPageApp />);
}

void main();
```

`compare.mjs` (Playwright) — run once per build (`BASE`, `LABEL`), prints one JSON line per scenario:

```js
import { chromium } from 'playwright';
const BASE = process.env.BASE, LABEL = process.env.LABEL;
const b = await chromium.launch();
const rows = [];

const probe = (fn) => fn.toString();

async function run(name, url, w, h, fn) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + url, { waitUntil: 'load' });
  await p.waitForSelector('[data-testid="preview-table-scroll-container"]', { timeout: 60000 });
  await p.waitForTimeout(1800);
  rows.push({ name, ...(await p.evaluate(fn)), errs: errs.slice(0, 1) });
  await p.close();
}

const sections = () => {
  const c = document.querySelector('[data-testid="preview-table-scroll-container"]');
  const r = c.getBoundingClientRect();
  c.scrollLeft = 600; const outerScroll = c.scrollLeft === 600; c.scrollLeft = 0;
  const inner = [...c.querySelectorAll('.overflow-x-auto')];
  const bars = [...c.querySelectorAll('[data-testid^="category-section-toggle-"]')];
  const barsVisible = bars.map((x) => { const q = x.getBoundingClientRect(); return q.right > r.left && q.left < r.right; });
  let innerScroll = null;
  if (inner[0]) { inner[0].scrollLeft = 600; innerScroll = inner[0].scrollLeft === 600; inner[0].scrollLeft = 0; }
  c.scrollTop = 300; const vert = c.scrollTop === 300; c.scrollTop = 0;
  return { scrollportCW: c.clientWidth, scrollportSW: c.scrollWidth, nestedHScrollers: inner.length,
           outerScrollWorks: outerScroll, innerScrollWorks: innerScroll,
           sectionHeaderBarsVisibleAtTop: barsVisible, verticalScrollWorks: vert,
           hBarInViewport: r.bottom <= window.innerHeight };
};

const def = () => {
  const c = document.querySelector('[data-testid="preview-table-scroll-container"]');
  const r = c.getBoundingClientRect(), th = c.querySelector('thead');
  const top0 = Math.round(th.getBoundingClientRect().top);
  c.scrollTop = 300; const stuck = Math.abs(Math.round(th.getBoundingClientRect().top) - top0) <= 1;
  c.scrollLeft = 500; const x = c.scrollLeft === 500; c.scrollLeft = 0; c.scrollTop = 0;
  return { scrollportCW: c.clientWidth, scrollportSW: c.scrollWidth, scrollX: x, theadSticky: stuck,
           hBarInViewport: r.bottom <= window.innerHeight, rows: c.querySelectorAll('tbody tr[data-index]').length };
};

const toolbar = () => {
  const root = document.querySelector('[data-testid="preview-table-scroll-container"]').parentElement;
  const rr = root.getBoundingClientRect();
  const over = [...root.querySelectorAll('*')].filter((el) => !el.closest('table'))
    .filter((el) => el.getBoundingClientRect().right > rr.right + 1);
  const vis = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; };
  return { containerW: Math.round(rr.width), overflowingToolbarNodes: over.length,
           presetFullyVisible: vis('[data-testid="table-sort-preset-select"]'),
           addSortFullyVisible: vis('[data-testid="table-add-sort-select"]') };
};

for (const [w, h, url, label] of [
  [400, 800, '?mode=overlay&previewMode=sidebar&sections=1&count=60', 'overlay sidebar · Sections ON · 400px'],
  [900, 700, '?sections=1&count=60', 'preview tab · Sections ON · 900px'],
  [400, 800, '?mode=overlay&previewMode=sidebar&count=60', 'overlay sidebar · Sections OFF · 400px'],
  [400, 800, '?engine=temu&count=40', 'preview tab · Temu · 400px'],
]) await run(label, url, w, h, label.includes('Sections') ? sections : def);

for (const [w, url, label] of [
  [320, '?mode=overlay&previewMode=sidebar&count=60', 'toolbar · overlay 320px'],
  [360, '?count=60', 'toolbar · tab 360px'],
  [420, '?mode=overlay&previewMode=sidebar&count=60', 'toolbar · overlay 420px'],
]) await run(label, url, w, 800, toolbar);

console.log('##### ' + LABEL);
for (const r of rows) console.log(JSON.stringify(r));
await b.close();
```

> In this sandbox Chromium lacks some system libraries; the probes here were run with
> `LD_LIBRARY_PATH` pointing at locally extracted `libnspr4/libnss3/libatk*/libxkbcommon/libasound`
> and `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`. On a normal machine
> `npx playwright install --with-deps chromium` is enough. This is an environment quirk, not a
> project requirement.

---

## Appendix B — the exact reporting bug, in one sentence per audience

* **Product:** With *Sections* on, the preview splits into three cards that each own a private
  sideways scrollbar drawn at the bottom of a 13,000 px column, so at the top of the panel nothing
  scrolls sideways; the table area itself has no horizontal overflow at all.
* **Engineering:** `AmazonProductTable`'s outer scroller gets no scrollable overflow because the
  section cards are scrollport-width and clamp 3,354 px tables inside nested `overflow-x-auto`
  divs; keyboard/wheel handlers are bound to the outer (inert) element.
* **Fix:** make the table area the single horizontal scroll surface (`w-max` wrapper, no nested
  scroller, `overflow-clip` cards, `sticky left-0 w-[100cqw]` header bars backed by
  `container-type: inline-size`), and let the toolbar's sort controls wrap instead of clipping.
  10 inserted lines, 7 deleted, across 3 files; 1,182 existing tests still pass.

---

## Appendix C — what is currently lying around (safe to delete)

| Path | What it is |
| ---- | ---------- |
| `docs/plans/SAD-378-preview-horizontal-scroll-plan.md` | **this plan** — the only file added to the repo |
| `.harness/` (repo root, untracked) | the throwaway Vite harness app from appendix A (mounts the real components, seeds both Dexie DBs) |
| `vite.harness.config.ts` (repo root, untracked) | harness Vite config (`root: '.harness'`, host `0.0.0.0:5179`) |
| `/home/user/trial` | a separate `git clone` of this repo with the §7 patch applied and verified; it is **not** part of this workspace's repo and can be deleted |
| local Vite dev servers on `:5179` (`main` = buggy) and `:5180` (`trial` = patched) | live side-by-side reproduction; `/` = dedicated preview tab, `?mode=overlay&previewMode=sidebar&sections=1&count=60` = the reported case |

Nothing else in the repo changed: `git status` shows only the plan file (plus the two untracked
harness paths above), and no file under `src/` or `tests/` was modified.
