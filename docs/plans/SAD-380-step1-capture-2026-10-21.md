# SAD-380 — Step 1 live-capture summary (2026-10-21)

Machine-readable artifact: [`sad-380-live-2026-10-21.json`](./sad-380-live-2026-10-21.json).
Code under test: `feat/temu-engine @ 08cdc76` (extractor unmodified).

## What was measured

| Attempt | Result |
|---|---|
| Static HTML (curl): US search, CA category, US PDP | JS shell only — 0 cards/prices. i18n store proves the concepts exist in en: a11y **"Original price {0}"** and the **"strikethrough price"** explanation (MSRP / merchant / reference price). No SSR product payload, no `marketPrice`/`listPrice` keys. |
| Headless Chromium render: US search, US PDP, category, best-sellers, CA category | All redirected to **`/login.html`** (fresh unauthenticated contexts). |
| Headless render: **US home feed** (first navigation of one fresh context) | ✅ **50 real cards rendered.** Per page: `[data-type="price"]` ×50 (e.g. text `"$27.48$27.48"` — accessible + visual duplication), `[data-type="priceText"]` ×**1** with text **`"Last day"`**, `del` ×0, `s` ×0, `goodContainer` ×50. |
| Further renders (US home ×2, CA home) | Login wall, then **`/bgn_verification.html` "Security verification"** — recorded, **not bypassed** (product rule). Capture from this sandbox stops here. |
| Owner evidence | Page-console paste: content script live on **`temu.com/ca/category.html`**, page type `category` (2026-10-21 10:54). Diagnostics lines were not in that console (they are in the service-worker console — instructions below). |

## Verdicts

* **G0 (root cause): PARTIAL.** For cards rendered like the captured feed, the failure mechanism
  is established: the extractor's assumed list-price sources (`[data-type="priceText"]` as a
  price, `del`/`s`) **do not carry a price** — the pool is empty/unparseable ⇒ `listPrice: null`
  (plan §7 branch 1/2). The exact node shapes on authenticated **search/category/PDP** remain
  unobserved from the sandbox and need the owner capture below.
* **G1 (`discountPrice`): DROPPED** per the owner's locked fallback — no third distinct price was
  observed anywhere (each price node carried one value, duplicated). Reopen only on owner
  evidence of a distinct third displayed price. No schema/UI/export change for `discountPrice`.
* **Implementation basis (Steps 2–3):** code-provable fixes (plan F1–F5/F7–F9) + one
  presentation-semantic fallback justified by Temu's own measured terms ("strikethrough price",
  "Original price {0}"): inside the existing price scope only, a currency-bearing
  **line-through** leaf strictly above the selling price. No hashed classes, no invented
  `data-type` values, no calculation.

## Owner capture (closes G0 for search/category/PDP — ~2 minutes)

1. **Service-worker diagnostics:** `chrome://extensions` → PPHunt **Details** → *Inspect views:
   service worker* → in that DevTools console filter `Diagnostics`, then run a normal Temu
   collection (category/search + open one PDP and collect). Copy 3–5 lines containing
   `"field":"listPrice"` (each line also shows `price` status and `stage`). These lines contain
   no product values — safe to paste on the ticket.
2. **In-page probe** (on a Temu CA category/search page with cards visible, open DevTools →
   Console, paste, copy the JSON output). It reads only DOM price nodes:

```js
(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cards = [...document.querySelectorAll('[data-tooltip^="goodContainer-"]')].slice(0, 5);
  const out = cards.map((card) => {
    const leaf = [...card.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && /\$|€|£/.test(el.textContent || '') && clean(el.textContent).length <= 44)
      .map((el) => ({ tag: el.tagName, dt: el.getAttribute('data-type'), aria: el.getAttribute('aria-label'), text: clean(el.textContent) }));
    const struck = [...card.querySelectorAll('*')]
      .filter((el) => { const cs = getComputedStyle(el); return (cs.textDecorationLine || '').includes('line-through') && clean(el.textContent).length > 0 && clean(el.textContent).length <= 60; })
      .map((el) => ({ tag: el.tagName, dt: el.getAttribute('data-type'), aria: el.getAttribute('aria-label'), text: clean(el.textContent) }));
    const sr = [...card.querySelectorAll('[class*="srOnly"], .sr-only')].map((el) => clean(el.textContent));
    const dts = {}; card.querySelectorAll('[data-type]').forEach((e) => { const v = e.getAttribute('data-type'); (dts[v] = dts[v] || []).push(clean(e.getAttribute('aria-label') || e.textContent).slice(0, 90)); });
    return { goods: card.getAttribute('data-tooltip'), leaf, struck, srOnly: sr, dataTypes: dts };
  });
  console.log(JSON.stringify({ url: location.href, cards: out }, null, 1));
})();
```

   On a **PDP**, run the same probe after replacing the first line's selector line with:
   `const cards = [document.querySelector('#goods_price') || document.querySelector('#rightContent')].filter(Boolean);`
3. Note beside each pasted block: the **visible** selling price and struck price (what your eyes
   see) for 2–3 of those products. Visible truth + DOM truth together close G0.

## Limitations (stated, not hidden)

No authenticated sandbox session; search/category/PDP rendering was walled; one successful feed
render; GBP/EUR unrendered; the serialized HTML of the successful render was overwritten by a
later login capture (the in-page probe numbers in the JSON artifact are the preserved evidence).
