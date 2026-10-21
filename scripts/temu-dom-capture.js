/**
 * SAD-381 — Temu PDP structural capture (operator tool).
 *
 * Not bundled, not imported by src/, not part of the test suite. Paste the body
 * of this file into the DevTools **Console** of a loaded Temu product page,
 * press Enter, then paste the clipboard content into the issue / chat.
 *
 * Why not `document.querySelector('#goodsDetail').outerHTML`?
 *   - The details section can be 200 KB+ (description image floors), which is
 *     unusable in a chat message;
 *   - Temu's CSS-module class names are hashed and rotate every deploy, so they
 *     carry no information for this ticket (the repo forbids using them anyway);
 *   - We need *structure + text + stable attributes*, and a measured summary.
 *
 * What it emits: one JSON object with
 *   summary  — booleans/counts that answer "does the assumed contract hold?"
 *   labels   — the i18n strings for this storefront (English fallback noted)
 *   tree     — an indented structural dump of #goodsDetail and #rightContent
 *              (class/style dropped, image URLs shortened, long text clipped)
 *
 * Privacy: it keeps product text (needed) but strips class/style; it does not
 * read cookies, storage or any network response.
 */
(() => {
  const MAX_TEXT = 160;
  const MAX_ATTR = 100;
  const MAX_DEPTH = 14;
  const SKIP = new Set(['script', 'style', 'noscript', 'link', 'meta']);

  const clip = (s, n) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  const describe = (el) => {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      if (/^(src|srcset|href|data-src)$/.test(a.name)) {
        attrs[a.name] = clip(a.value, 60);
        continue;
      }
      attrs[a.name] = clip(a.value, MAX_ATTR);
    }
    return attrs;
  };

  const walk = (el, depth, out) => {
    if (!el || depth > MAX_DEPTH) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;

    const kids = [...el.children].filter((c) => !SKIP.has(c.tagName.toLowerCase()));
    const line = {
      tag,
      ...(Object.keys(describe(el)).length ? { attrs: describe(el) } : {}),
    };

    if (kids.length === 0) {
      const text = clip(el.textContent, MAX_TEXT);
      if (text) line.text = text;
    } else {
      line.children = [];
      for (const kid of kids) walk(kid, depth + 1, line.children);
    }

    if (el.children.length > 8) {
      line.hiddenChildren = el.children.length - kids.length;
    }
    out.push(line);
  };

  const treeOf = (root) => {
    if (!root) return null;
    const nodes = [];
    walk(root, 0, nodes);
    return nodes;
  };

  /* ---------- labels ---------- */
  const labels = (() => {
    const fallback = {
      highlight: 'Highlights',
      description: 'Description',
      details: 'Product details',
      seeAll: 'See all details',
      seeAllDimensions: 'See all details and dimensions',
      seeMore: 'See more',
    };
    try {
      const script = [...document.querySelectorAll('script:not([src])')].find((s) =>
        (s.textContent ?? '').includes('__InitialI18nStore__')
      );
      const text = script?.textContent ?? '';
      const at = text.indexOf('window.__InitialI18nStore__');
      const start = at >= 0 ? text.indexOf('{', at) : -1;
      if (start < 0) return { source: 'fallback', values: fallback };
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { end = i; break; }
      }
      if (end < 0) return { source: 'fallback', values: fallback };
      const store = JSON.parse(text.slice(start, end + 1));
      const lang = Object.keys(store)[0];
      const goods = store[lang]?.goods ?? {};
      const pick = (group, key) =>
        typeof group?.[key] === 'string' && group[key].trim() ? group[key].trim() : null;
      return {
        source: 'store',
        lang,
        bytes: end - start,
        values: {
          highlight: pick(goods.main_detail, 'highlight') ?? fallback.highlight,
          description: pick(goods.main_detail, 'descriptionTitle') ?? fallback.description,
          details: pick(goods.goodsDetail, 'goodsDetailTitle') ?? fallback.details,
          seeAll: pick(goods.goodsDetail, 'descriptionSeeAll') ?? fallback.seeAll,
          seeAllDimensions:
            pick(goods.goodsDetail, 'descriptionMoreWithDimension') ?? fallback.seeAllDimensions,
          seeMore: pick(goods.main_detail, 'descriptionMore') ?? fallback.seeMore,
        },
      };
    } catch (e) {
      return { source: 'fallback', error: String(e), values: fallback };
    }
  })();

  /* ---------- roots + summary ---------- */
  const details = document.querySelector('#goodsDetail');
  const right = document.querySelector('#rightContent');
  const left = document.querySelector('#leftContent');
  const price = document.querySelector('#goods_price');

  const modules = (root) =>
    root ? [...root.querySelectorAll('[data-id="module"]')] : [];

  const moduleSummary = (root) =>
    modules(root).map((m) => ({
      title: clip(m.firstElementChild?.textContent, 60),
      rows: m.querySelectorAll('[aria-label]').length,
      dollarRows: m.querySelectorAll('[aria-label^="$"]').length,
      buttons: [...m.querySelectorAll('[role="button"],button')].map((b) =>
        clip(b.getAttribute('aria-label') || b.textContent, 40)
      ).slice(0, 6),
    }));

  const summary = {
    url: location.href,
    title: document.title.slice(0, 120),
    lang: document.documentElement.lang,
    theme: document.documentElement.getAttribute('data-theme'),
    has: {
      goodsDetail: !!details,
      rightContent: !!right,
      leftContent: !!left,
      goods_price: !!price,
      jsonLd: document.querySelectorAll('script[type="application/ld+json"]').length,
    },
    metaDescription: clip(
      document.querySelector('meta[name="description"]')?.getAttribute('content'),
      200
    ),
    counts: {
      detailsModules: modules(details).length,
      rightModules: modules(right).length,
      detailsTableRows: details ? details.querySelectorAll('table tr').length : 0,
      detailsListItems: details ? details.querySelectorAll('li').length : 0,
      detailsDollarRows: details ? details.querySelectorAll('[aria-label^="$"]').length : 0,
      detailsDivRows: details ? details.querySelectorAll('div').length : 0,
    },
    detailsModules: moduleSummary(details),
    rightModules: moduleSummary(right),
    // DescriptionV2 rows are also role="button" with an aria-label; only the
    // non-"$" ones are real controls ("See more" / "See all details").
    collapseControls: [...document.querySelectorAll('#goodsDetail [role="button"], #rightContent [role="button"]')]
      .map((b) => clip(b.getAttribute('aria-label') || b.textContent, 40))
      .filter((t) => Boolean(t) && !t.startsWith('$'))
      .slice(0, 20),
    headings: [...document.querySelectorAll('#goodsDetail h1,#goodsDetail h2,#goodsDetail h3,#rightContent h1,#rightContent h2,#rightContent h3')]
      .map((h) => `${h.tagName}: ${clip(h.textContent, 60)}`)
      .slice(0, 20),
  };

  /* ---------- compact digest (paste-friendly when the JSON is large) ---------- */
  const digest = (() => {
    const lines = [];
    const render = (el, depth) => {
      if (!el || depth > 10 || lines.length > 260) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const id = el.id ? `#${el.id}` : '';
      const module = el.getAttribute('data-id') === 'module' ? '[data-id=module]' : '';
      const aria = el.getAttribute('aria-label') ? `[aria-label="${clip(el.getAttribute('aria-label'), 50)}"]` : '';
      const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ');
      const kids = [...el.children].filter((c) => !SKIP.has(c.tagName.toLowerCase()));
      const text = kids.length === 0 ? clip(el.textContent, 70) : clip(own, 70);
      lines.push(
        `${'  '.repeat(depth)}${tag}${id}${module}${role}${aria}${text ? ` "${text}"` : ''}`
      );
      if (lines.length > 260) {
        lines.push(`${'  '.repeat(depth)}… truncated`);
        return;
      }
      for (const kid of kids) render(kid, depth + 1);
    };
    lines.push('## #goodsDetail');
    if (details) for (const kid of details.children) render(kid, 1);
    else lines.push('  (absent)');
    lines.push('## #rightContent');
    if (right) for (const kid of right.children) render(kid, 1);
    else lines.push('  (absent)');
    return lines.join('\n');
  })();

  /* ---------- emit ---------- */
  const payload = {
    capturedAt: new Date().toISOString(),
    summary,
    labels,
    digest,
    tree: {
      goodsDetail: treeOf(details),
      rightContent: treeOf(right),
    },
    // SAD-381 step 4: the two containers' markup, so `tests/temu-pdp-captures.test.ts`
    // can replay the real parser offline against this exact page.
    dom: {
      goodsDetail: details ? details.outerHTML : null,
      rightContent: right ? right.outerHTML : null,
    },
  };

  const json = JSON.stringify(payload, null, 2);
  const bytes = new Blob([json]).size;

  if (typeof copy === 'function') copy(json);

  // Large captures are easier to attach than to paste: also offer a download.
  const goodsId = (location.href.match(/-g-(\d{6,22})\.html/) ?? [])[1] ?? 'unknown';
  try {
    const blobUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `sad381-${goodsId}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } catch {
    /* download is best-effort; the clipboard copy above already happened */
  }
  console.log(
    `[SAD-381] captured ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB). ` +
      `Clipboard ${typeof copy === 'function' ? 'updated' : 'unavailable — copy the object below'}.`
  );
  console.log(payload.summary);
  console.log(payload.labels);
  console.log(digest);
  return { bytes, summary };
})();
