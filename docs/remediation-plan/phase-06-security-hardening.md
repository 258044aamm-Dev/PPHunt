# Phase 6 — Security, Manifest & Visible-CSS Hardening

**Issues addressed:** H‑10 (no-op Tailwind classes) · M‑3 (`web_accessible_resources`) · M‑4 (postMessage `'*'`) · M‑8 (fonts vs privacy claim)
**Estimated effort:** Small · **Prerequisites:** Phase 0 · **Blocks:** nothing

This phase is deliberately placed early in the recommended execution order: it is the highest
value-per-line-of-diff in the whole plan. H‑10 is seven string replacements that fix visibly broken
UI, and M‑3/M‑4 are manifest and postMessage one-liners. Nothing here depends on any other phase.

---

## Step 6.1 — H‑10: replace the three Tailwind classes that produce no CSS

### Objective
Remove UI elements that are currently invisible or unstyled.

### Root Cause
`forest` and `ink-faint` appear in neither `tailwind.config.js`'s `theme.extend.colors` nor as
`--color-forest` / `--color-ink-faint` custom properties in
`src/entrypoints/sidepanel/global.css`. Tailwind silently drops unknown utilities at build time — no
warning, no error. Verified against the emitted stylesheet
`dist/chrome-mv3/assets/global-DnoJmkHH.css`:

```
bg-forest        → ABSENT (no-op)
text-ink-faint   → ABSENT (no-op)
bg-moss          → PRESENT
shadow-lg        → PRESENT
```

Affected elements:
- `bg-forest` is the **status dot** beside the product count in `ExtractionCompleteModal.tsx:116` and
  `FullWidthPreviewModal.tsx:99` (`w-1.5 h-1.5 rounded-full bg-forest`). With no background rule the
  dot is invisible in both light and dark themes.
- `text-ink-faint` is applied to the diagnostic metadata labels in `ErrorModal.tsx:180, 321, 325, 329,
  333` — `Code:`, `Page:`, `Tab State:`, `Saved Products:` — and to an uppercase section label. These
  inherit the parent colour instead of the intended muted tone, which also means the contrast ratios
  documented in `global.css` do not describe what is actually rendered.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/components/ExtractionCompleteModal.tsx` | modify | line 116: `bg-forest` → `bg-moss` |
| `src/entrypoints/sidepanel/components/FullWidthPreviewModal.tsx` | modify | line 99: `bg-forest` → `bg-moss` |
| `src/entrypoints/sidepanel/components/ErrorModal.tsx` | modify | lines 180, 321, 325, 329, 333: `text-ink-faint` → `text-ink-subtle` |
| `tests/theme-and-contrast.test.tsx` | modify | Add a token-resolution guard |

### Implementation Details
Both replacements use tokens that already exist and are already documented with WCAG contrast ratios
in `global.css` for `:root` and `:root.dark`:
- `moss` is the design system's success colour — the correct semantic for a completion/preview status
  dot, and consistent with `StatusBar.tsx:7` which already uses `bg-moss` for `completed`.
- `ink-subtle` is the muted-text token used elsewhere in `ErrorModal`, so the diagnostic labels will
  match the surrounding typography.

**Alternative considered and rejected:** adding `forest` and `ink-faint` to `tailwind.config.js` +
`global.css` for both themes. That requires choosing two new hex values, documenting their contrast
ratios, and verifying them in dark mode — strictly more work and more design risk than using the
tokens the design system already defines. Take this route only if the design intent was genuinely a
distinct third green/grey.

### Testing and Verification
1. `grep -rn "bg-forest\|text-ink-faint" src` returns nothing.
2. `npx wxt build` then grep the emitted CSS for `.bg-moss` and `.text-ink-subtle` — both present.
3. **New guard test (prevents the whole class of bug):** scan `src/**/*.tsx` for `bg-*`, `text-*` and
   `border-*` utilities and assert each resolves to a key in `tailwind.config.js`'s colour palette or
   to an arbitrary-value/class from the allowlist. This is the only mechanism that would have caught
   the bug at authoring time — Tailwind itself stays silent.
4. Extend `tests/theme-and-contrast.test.tsx` (43 assertions today) to cover the completion-dot and
   diagnostic-label tokens in both themes.
5. Visual: open the extraction-complete dialog and the error modal in light and dark mode.

---

## Step 6.2 — M‑3: narrow `web_accessible_resources`

### Objective
Stop exposing the entire 919 kB JS bundle and compiled CSS to every HTTP and HTTPS site.

### Root Cause
`wxt.config.ts:34-39`:
```ts
// Only the overlay page and its bundles are embeddable on ordinary sites.
// The UI host itself is injected on demand with activeTab, not <all_urls>.
web_accessible_resources: [{
  resources: ['overlay.html', 'chunks/*', 'assets/*'],
  matches: ['http://*/*', 'https://*/*'],
}],
```
Verified in `dist/chrome-mv3/manifest.json`. The comment states the intent; the wildcards do not
implement it. `chunks/*` includes `global-DVF9avaX.js` (**919.70 kB** — React, Dexie, Zod, SheetJS,
TanStack), and `assets/*` includes the compiled CSS. Any website can probe
`chrome-extension://<id>/chunks/global-*.js` to detect that PPHunt is installed and fingerprint its
exact version. `http://*/*` additionally permits insecure origins.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `wxt.config.ts` | modify | Enumerate the overlay's actual dependencies instead of wildcards |
| `tests/` (new or existing manifest test) | modify | Assert no bare wildcard appears in the built manifest |

### Implementation Details
Two options, in order of preference:

**Option A — enumerate.** Build once, read `dist/chrome-mv3/overlay.html`, and list exactly the chunks
and assets it references:
```ts
web_accessible_resources: [{
  resources: [
    'overlay.html',
    'chunks/overlay-<hash>.js',
    'chunks/global-<hash>.js',
    'assets/overlay-<hash>.css',
  ],
  matches: ['https://*/*'],
}],
```
Downside: the hashes change every build, so this needs a post-build generation step. WXT can emit WAR
entries automatically for declared entrypoints — check whether `overlay.html` alone suffices, since
WXT already knows the overlay's dependency graph.

**Option B — dedicated output directory (recommended if WXT does not handle this automatically).**
Configure the overlay entrypoint to emit into its own subdirectory and expose only that:
```ts
resources: ['overlay.html', 'overlay/*'],
```
This is stable across builds, needs no hash tracking, and cannot accidentally expose the side panel's
or background's chunks.

**Both options:** drop `http://*/*` from `matches`. Amazon redirects to HTTPS, and the ten host
permissions in `wxt.config.ts:20-33` are all `*://*.amazon.*` — but plain-HTTP support should be an
explicit decision, not a wildcard default. If any supported storefront can serve HTTP, keep it and
record why.

### Testing and Verification
1. Rebuild; inspect `dist/chrome-mv3/manifest.json`; assert `resources` contains no bare `chunks/*`
   or `assets/*`.
2. **Functional check (this is the risk):** load unpacked and open Overlay mode on
   `https://www.amazon.com/s?k=laptop`. The iframe must render fully styled and interactive. Then
   open it on a non-Amazon HTTPS page and confirm it still renders — `isOverlayAllowed` permits any
   `http:`/`https:` URL except the Web Store, so this is a supported path.
3. Add a build-time assertion in CI (Phase 0's workflow) that the emitted manifest has no wildcard WAR
   entry.
4. Confirm from an ordinary web page that `fetch('chrome-extension://<id>/chunks/global-*.js')` now
   fails for a non-overlay chunk.

---

## Step 6.3 — M‑4: stop postMessaging to `'*'`

### Objective
The overlay iframe must not disclose extension presence and UI state to arbitrary host pages.

### Root Cause
`src/lib/overlay/openOverlay.ts:41-52` and `src/entrypoints/overlay/main.tsx:9-12`:
```ts
window.parent.postMessage({ type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth }, '*');
window.parent.postMessage({ type: 'PPHUNT_CLOSE_OVERLAY' }, '*');
```
The overlay iframe is appended to arbitrary host pages, so with `targetOrigin: '*'` the host document
receives these messages and can observe that PPHunt is installed, that the user opened the preview,
when they toggled full width, and when they closed it. The **inbound** direction is already correctly
guarded — `overlayHost.ts:81-102` checks both `event.source` and `event.origin` — so the leak is
one-way, outbound only.

The extension origin is available inside the iframe for free: the iframe's `src` is the extension's own
`overlay.html`, so `window.location.origin` **is** `chrome-extension://<id>`. The comment at
`overlay/main.tsx:10` even states the host "only honors this message from its own extension-origin
iframe" — the sender simply was not told which origin to target.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `src/lib/overlay/openOverlay.ts` | modify | line 47: `'*'` → `window.location.origin` |
| `src/entrypoints/overlay/main.tsx` | modify | line 11: `'*'` → `window.location.origin` |
| `tests/page-overlay.test.tsx` | modify | Assert the target origin |

### Implementation Details
```ts
- window.parent.postMessage({ type: 'PPHUNT_CLOSE_OVERLAY' }, '*');
+ window.parent.postMessage({ type: 'PPHUNT_CLOSE_OVERLAY' }, window.location.origin);
```
No change is needed in `overlayHost.ts` — its listener already filters on `event.origin`, and the
origin it compares against is unchanged.

**Edge case to handle:** if the overlay page is ever opened as a top-level tab rather than an iframe,
`window.parent === window` and `openOverlay.ts:43` already guards on
`window.parent && window.parent !== window`, so no message is sent. Preserve that guard.

### Testing and Verification
1. Extend `tests/page-overlay.test.tsx` (4 tests today) to assert `postMessage` receives the extension
   origin, not `'*'`. jsdom's default origin is `http://localhost:3000`, so the assertion should be
   `expect(mock).toHaveBeenCalledWith(expect.anything(), window.location.origin)` rather than a
   hardcoded string.
2. Round-trip test: host receives the message and the close/full-width behaviour still works — this is
   what proves the origin change did not break the handshake.
3. Manual (Phase 11, item 6): open the overlay on a non-Amazon page with a
   `window.addEventListener('message', e => console.log(e.origin, e.data))` in the console; confirm no
   `PPHUNT_*` message arrives.

---

## Step 6.4 — M‑8: correct the privacy claim about Google Fonts

### Objective
Make the README factually accurate. **Per decision D2, the remote fonts stay.**

### Root Cause
All three extension pages load remote stylesheets and fonts:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Lora:wght@400;600&display=swap" rel="stylesheet" />
```
(`src/entrypoints/{sidepanel,popup,overlay}/index.html:7-9`; the sidepanel variant also requests
JetBrains Mono.) Verified present in the built `dist/chrome-mv3/*.html`.

`README.md` states: *"**Privacy-first** — All processing happens locally. No data is sent to external
servers."* That is false: every panel open sends the user's IP, User-Agent and timing to Google,
before any Amazon interaction. The overlay case is the most notable, since the request originates from
an iframe injected into a third-party page.

MV3's default CSP permits remote stylesheets and fonts, so this does not break at runtime — it is a
documentation accuracy and third-party-dependency issue, not a functional bug.

### Files Involved

| File | Action | Responsibility |
|---|---|---|
| `README.md` | modify | Reword the privacy claim to disclose the font request |
| `ARCHITECTURE.md` | modify | Note the external dependency in the relevant section (Phase 10 rewrites this file anyway) |

### Implementation Details
Replace the absolute claim with a precise one. Suggested wording:

> **Local-first** — All product data is scraped, stored and processed on your machine. Nothing is
> uploaded to any PPHunt server, and there is no analytics or telemetry. Two categories of network
> request do occur: (1) requests to Amazon and its image CDN (`media-amazon.com`,
> `ssl-images-amazon.com`) to fetch the pages you are viewing and the product thumbnails used in
> exports; (2) requests to Google Fonts to load the Lora, Poppins and JetBrains Mono typefaces used by
> the panel, popup and overlay UI. If you want zero third-party requests, block `fonts.googleapis.com`
> and `fonts.gstatic.com` — the interface falls back to Georgia, system-ui and ui-monospace.

That last sentence is worth verifying before publishing it: the `fontFamily` stacks in
`tailwind.config.js:27-31` do declare those fallbacks, so the claim is supportable, but confirm the
fallback rendering is acceptable rather than broken.

### Testing and Verification
1. Read the revised README against the actual network behaviour — every claim must be checkable.
2. Optional but cheap: temporarily block the two font domains in DevTools and confirm the UI still
   renders with fallbacks, which is what the new wording promises.
3. `tests/theme-and-contrast.test.tsx` unaffected (it asserts tokens, not loaded fonts).

**Note for the future:** if the Chrome Web Store review or an enterprise deployment ever requires zero
remote content, the self-hosting route (download the three families as `.woff2` into
`src/public/fonts/` with `@font-face` in `global.css`, delete the six `<link>` tags) costs roughly
400–500 KB of bundle growth. That option was considered and declined in decision D2; it remains
available and is a ~1 hour change.

---

## Phase 6 exit criteria

- [ ] `grep -rn "bg-forest\|text-ink-faint" src` returns nothing; a token-resolution guard test exists
- [ ] The completion status dot is visible in both themes; `ErrorModal` diagnostic labels are muted
- [ ] `dist/chrome-mv3/manifest.json` `web_accessible_resources` contains no bare `chunks/*` or `assets/*`, and no `http://*/*` unless explicitly justified
- [ ] Overlay mode verified working on an Amazon page **and** a non-Amazon HTTPS page after the WAR narrowing
- [ ] No `postMessage(..., '*')` remains in `src/`; `tests/page-overlay.test.tsx` asserts the origin
- [ ] README's privacy claim matches actual network behaviour
- [ ] `tsc --noEmit` at **≤ 104** errors · `vitest run` at **≥ 157** passing · `wxt build` OK
