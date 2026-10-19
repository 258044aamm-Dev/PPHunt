/**
 * SAD-339 — browser QA for the card save flow.
 *
 * Drives the **built** extension in Chromium against a local Amazon-shaped
 * fixture, because the QA environment may have no access to live Amazon. It is
 * evidence about this extension's behaviour, not about Amazon's markup.
 *
 * Not part of the build, the test suite or CI: nothing in `src/` imports it and
 * Playwright is deliberately not a dependency. To run it:
 *
 *   npm run build
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/browser-qa/card-flow.cjs
 *
 * It prints one line per check and then a JSON block, which is what goes into
 * `docs/plans/SAD-141-qa-matrix.md`. Add rows here rather than testing by hand
 * anything that can be tested this way.
 */

/**
 * Scratch browser-QA runner for SAD-339. Not committed: it needs Playwright,
 * which is not a repo dependency. It loads the built extension in Chromium and
 * drives the card flow against a locally-served Amazon-shaped fixture.
 */
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(
    'This runner needs Playwright, which is not a repository dependency:\n' +
      '  npm i --no-save playwright && npx playwright install chromium\n' +
      'then run it again.',
  );
  process.exit(1);
}
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { rmSync } = require('node:fs');

const EXT = join(__dirname, '..', '..', 'dist', 'chrome-mv3');
const PROFILE = join(tmpdir(), 'pphunt-qa-profile');

const asinFor = (n) => `B0QA${String(n).padStart(4, '0')}AA`;
const productUrl = (asin) => `/Fixture-${asin}/dp/${asin}`;

function card(asin, index) {
  return `<div data-component-type="s-search-result" data-asin="${asin}" id="card-${index}">
    <a class="a-link-normal s-no-outline" href="${productUrl(asin)}">
      <img class="s-image" src="https://m.media-amazon.com/images/I/fixture.jpg" alt="">
    </a>
    <h2 class="a-size-mini"><a class="a-link-normal" href="${productUrl(asin)}"><span>Fixture Product ${index}</span></a></h2>
    <div data-cy="price-recipe"><span class="a-price"><span class="a-price-symbol">$</span><span class="a-price-whole">19</span><span class="a-price-fraction">99</span></span></div>
    <button name="submit.addToCart" id="cart-${index}">Add to Cart</button>
  </div>`;
}

function searchPage(count) {
  const cards = Array.from({ length: count }, (_, i) => card(asinFor(i), i)).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Amazon.com: fixture</title>
    <style>body{margin:0;font-family:sans-serif}#cards{display:flex;flex-wrap:wrap}
    [data-component-type="s-search-result"]{width:300px;margin:8px;border:1px solid #ddd;padding:8px}
    .s-image{width:100%;height:120px;background:#eee;display:block}
    </style></head>
    <body><div class="s-main-slot s-result-list" id="cards">${cards}</div></body></html>`;
}

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  console.log(`${status.toUpperCase().padEnd(6)} ${id} — ${detail}`);
}

async function readStore(page, name) {
  return page.evaluate(
    (storeName) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('PPHuntDB');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) return resolve([]);
          const tx = db.transaction(storeName, 'readonly');
          const all = tx.objectStore(storeName).getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
    name,
  );
}

async function saveButtonCount(page) {
  return page.evaluate(() => document.querySelectorAll('[data-pphunt-save-host]').length);
}

async function scrollThrough(page) {
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height; y += 600) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
}

(async () => {
  rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;

  const page = await context.newPage();
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });

  const PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );
  await context.route('https://m.media-amazon.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }),
  );

  const FIXTURE_60 = searchPage(60);
  await page.route('https://www.amazon.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/s')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_60 });
    }
    // Anything else (a PDP fetch) gets a challenge page, which is what a
    // datacenter IP actually receives and what the classifier must catch.
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: 'To discuss automated access to Amazon data please contact api-services-support@amazon.com',
    });
  });

  const ua = await page.evaluate(() => navigator.userAgent);
  const chromeVersion = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown';
  console.log(`\nChromium ${chromeVersion}\n`);

  /* ---------------------------------------------------------- card matrix */

  await page.goto('https://www.amazon.com/s?k=fixture', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await scrollThrough(page);
  await page.waitForTimeout(1200);

  const afterSixty = await saveButtonCount(page);
  record(
    'card-60',
    afterSixty === 60 ? 'pass' : 'fail',
    `${afterSixty} save control(s) for 60 cards`,
  );

  const uniqueAsins = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-pphunt-save-host]')];
    return new Set(hosts.map((h) => h.getAttribute('data-asin'))).size;
  });
  record(
    'card-60-unique',
    uniqueAsins === 60 ? 'pass' : 'fail',
    `${uniqueAsins} distinct ASIN(s) across the mounted controls`,
  );

  /* --------------------------------------------------- infinite scroll x3 */

  for (let batch = 0; batch < 3; batch += 1) {
    await page.evaluate(({ start, count }) => {
      const container = document.getElementById('cards');
      for (let i = start; i < start + count; i += 1) {
        const asin = `B0QA${String(i).padStart(4, '0')}AA`;
        // Built from markup, not cloned from a live card: a clone would carry
        // the already-mounted save host and fake a duplicate.
        const el = document.createElement('div');
        el.setAttribute('data-component-type', 's-search-result');
        el.setAttribute('data-asin', asin);
        el.innerHTML =
          '<a class="a-link-normal" href="/Fixture-' + asin + '/dp/' + asin + '">' +
          '<img class="s-image" src="https://m.media-amazon.com/images/I/fixture.jpg" alt=""></a>' +
          '<h2 class="a-size-mini"><a class="a-link-normal" href="/Fixture-' + asin + '/dp/' + asin + '">' +
          '<span>Fixture Product ' + i + '</span></a></h2>' +
          '<div data-cy="price-recipe"><span class="a-price"><span class="a-price-symbol">$</span>' +
          '<span class="a-price-whole">19</span></span></div>';
        container.appendChild(el);
      }
    }, { start: 60 + batch * 20, count: 20 });
    await page.waitForTimeout(400);
    await scrollThrough(page);
    await page.waitForTimeout(900);
  }

  const afterScroll = await saveButtonCount(page);
  const distinctAfterScroll = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-pphunt-save-host]')];
    return new Set(hosts.map((h) => h.getAttribute('data-asin'))).size;
  });
  record(
    'card-infinite-scroll',
    afterScroll === 120 && distinctAfterScroll === 120 ? 'pass' : 'fail',
    `${afterScroll} controls / ${distinctAfterScroll} distinct ASIN(s) after +60 cards in 3 batches (expected 120/120, no duplicates)`,
  );

  /* ------------------------------------------- theme attribute (SAD-331) */

  // SAD-331: the control must follow PPHunt's stored theme while the OS stays
  // light, and must change without reloading the page.
  const themePage = await context.newPage();
  await themePage.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  const writeTheme = (value) =>
    themePage.evaluate(
      (stored) =>
        stored === null
          ? chrome.storage.local.remove('pphuntTheme')
          : chrome.storage.local.set({ pphuntTheme: stored }),
      value,
    );
  const readControlTheme = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-pphunt-save-host]');
      return host ? host.getAttribute('data-theme') : null;
    });

  await writeTheme(null);
  await page.waitForTimeout(500);
  const themeDefault = await readControlTheme();

  await writeTheme('dark');
  await page.waitForTimeout(600);
  const themeDark = await readControlTheme();

  await writeTheme('light');
  await page.waitForTimeout(600);
  const themeLight = await readControlTheme();

  await writeTheme(null);
  await page.waitForTimeout(600);
  const themeReset = await readControlTheme();

  record(
    'theme-follows-setting',
    themeDefault === 'auto' && themeDark === 'dark' && themeLight === 'light' && themeReset === 'auto'
      ? 'pass'
      : 'fail',
    `OS light throughout — nothing stored → ${JSON.stringify(themeDefault)}, stored dark → ${JSON.stringify(themeDark)}, stored light → ${JSON.stringify(themeLight)}, key removed → ${JSON.stringify(themeReset)}`,
  );

  /* ------------------------------------------------- keyboard reachability */

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.body.focus());
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const onControl = await page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active && active.hasAttribute && active.hasAttribute('data-pphunt-save-host'));
    });
    if (onControl) { reached = true; break; }
  }
  record(
    'a11y-tab-reaches-control',
    reached ? 'pass' : 'fail',
    reached ? 'Tab reached the save control (focus landed on its shadow host)' : 'Tab never reached the save control in 40 presses',
  );

  /* ------------------------------------------------------ quick save (online) */

  /* ------------------------------------------------------------- offline */

  // Offline before the click: the save itself is a message, so it completes,
  // and the enrichment fetch is what fails — exactly the matrix row.
  // The fixture card wraps its image in a link. A click on the save control
  // retargets to the shadow host, but a near-miss would navigate and reload the
  // document, wiping the card's state — so links are inert for this step.
  await page.evaluate(() => {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('a')) event.preventDefault();
    }, true);
  });

  await context.setOffline(true);
  const firstHost = page.locator('[data-pphunt-save-host]').first();
  await firstHost.click({ force: true });
  await page.waitForTimeout(500);
  record(
    'save-click-stayed-on-page',
    page.url().includes('/s?k=') ? 'pass' : 'fail',
    `after clicking the control the page is ${page.url().includes('/s?k=') ? 'still the listing' : `at ${page.url()}`}`,
  );

  // The card's partial marker is transient (the control resets itself), so it
  // has to be sampled immediately — this was 20 s late in an earlier run and
  // reported a false negative.
  let partialAt = null;
  let partialClearedAt = null;
  const clickStarted = Date.now();
  for (let i = 0; i < 40; i += 1) {
    const seen = await page.evaluate(() => {
      const host = [...document.querySelectorAll('[data-pphunt-save-host]')]
        .find((element) => element.getAttribute('data-partial') === 'true');
      return host ? host.getAttribute('data-asin') : null;
    });
    if (seen && partialAt === null) partialAt = Date.now() - clickStarted;
    if (!seen && partialAt !== null && partialClearedAt === null) {
      partialClearedAt = Date.now() - clickStarted;
      break;
    }
    await page.waitForTimeout(200);
  }

  let toastText = await page.evaluate(() => {
    const toast = document.getElementById('pphunt-save-toast');
    return toast ? toast.textContent ?? '' : '';
  });
  await context.setOffline(false);

  const hostState = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-pphunt-save-host]')];
    const partial = hosts.find((h) => h.getAttribute('data-partial') === 'true');
    return {
      count: hosts.length,
      partialAsin: partial ? partial.getAttribute('data-asin') : null,
      attributes: partial ? partial.getAttributeNames() : [],
    };
  });
  record(
    'save-offline-card-state',
    partialAt !== null ? 'pass' : 'fail',
    `data-partial=true on the saved card was first seen ${partialAt ?? 'never'} ms after the click` +
      `${partialClearedAt !== null ? ` and had reset by ${partialClearedAt} ms` : ''} — the card surface reports the degraded save for roughly ${partialClearedAt ?? '>8000'} ms`,
  );
  record(
    'save-offline-toast',
    'not-run',
    `toast text was ${JSON.stringify(toastText.slice(0, 120))} — the enrichment warning toast is only shown on the right-click path (gated on pendingSaveJobId), so the card path cannot produce it. Row needs the native context menu.`,
  );

  /* ------------------------------------------------------------- the row */

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/preview.html`, { waitUntil: 'domcontentloaded' });
  await ext.waitForTimeout(1500);

  const products = await readStore(ext, 'products');
  const snapshots = await readStore(ext, 'snapshots');
  const sessionKey = products[0]?.sessionKey ?? null;

  if (sessionKey) {
    await ext.goto(
      `chrome-extension://${extensionId}/preview.html?engine=amazon&sessionKey=${encodeURIComponent(sessionKey)}`,
      { waitUntil: 'domcontentloaded' },
    );
    await ext.waitForTimeout(2500);
  }

  record(
    'save-row-intact',
    products.length >= 1 ? 'pass' : 'fail',
    `${products.length} product row(s) after one offline save; description=${JSON.stringify(products[0]?.description ?? null)}, features=${Array.isArray(products[0]?.features) ? products[0].features.length : 'n/a'}`,
  );
  record(
    'save-snapshot',
    snapshots.length >= 1 ? 'pass' : 'fail',
    `${snapshots.length} snapshot(s); source=${JSON.stringify(snapshots[0]?.source ?? null)}`,
  );

  /* ------------------------------------------- preview columns (SAD-330) */

  const headers = await ext.evaluate(() =>
    [...document.querySelectorAll('th')].map((cell) => (cell.textContent ?? '').trim()).filter(Boolean),
  );
  const hasDescription = headers.includes('Description');
  const hasFeatures = headers.includes('Features');
  record(
    'preview-columns',
    hasDescription && hasFeatures ? 'pass' : 'fail',
    `preview.html (sessionKey=${sessionKey ? 'yes' : 'none'}) renders ${headers.length} headers; Description=${hasDescription} Features=${hasFeatures}`,
  );
  const modeResults = [];
  for (const mode of ['Sidebar', 'Overview']) {
    const button = ext.getByRole('button', { name: mode, exact: true });
    if ((await button.count()) === 0) {
      modeResults.push(`${mode}=absent`);
      continue;
    }
    await button.first().click();
    await ext.waitForTimeout(900);
    const modeHeaders = await ext.evaluate(() =>
      [...document.querySelectorAll('th')].map((cell) => (cell.textContent ?? '').trim()),
    );
    modeResults.push(
      `${mode}=${modeHeaders.includes('Description') && modeHeaders.includes('Features') ? `ok(${modeHeaders.length})` : 'missing'}`,
    );
  }
  record(
    'preview-modes',
    modeResults.every((entry) => entry.includes('=ok')) ? 'pass' : 'fail',
    `preview.html view modes: ${modeResults.join(', ')}`,
  );

  record(
    'preview-header-order',
    headers.includes('URL') &&
      headers.indexOf('Description') === headers.indexOf('URL') + 1 &&
      headers.indexOf('Features') === headers.indexOf('Description') + 1
      ? 'pass'
      : 'fail',
    `order: ${headers.slice(-5).join(' → ')}`,
  );

  record(
    'page-console-errors',
    pageErrors.length === 0 ? 'pass' : 'observed',
    pageErrors.length === 0 ? 'no console errors on the fixture page' : `${pageErrors.length} console error(s): ${pageErrors.slice(0, 3).join(' | ')}`,
  );

  await context.close();

  console.log('\n---JSON---');
  console.log(JSON.stringify({ chromeVersion, results }, null, 2));
})().catch((error) => {
  console.error('FAILED:', error);
  process.exitCode = 1;
});
