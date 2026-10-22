/**
 * SAD-389 built-extension QA. Network is fulfilled with controlled Amazon-shaped
 * fixtures; actual content script, service worker, offscreen DOMParser/export,
 * messaging, IndexedDB, automatic scroll clock and card button are used.
 *
 * npm run build
 * NODE_PATH=/path/to/ephemeral/node_modules PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers \
 *   node scripts/browser-qa/sad389-extension.cjs /absolute/result.json
 * Playwright/browser binaries are intentionally not repository dependencies.
 * The native context-menu command is dispatched programmatically after a real
 * right-click capture; this does NOT claim an automated OS menu-item click.
 */
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');
const ROOT = resolve(__dirname, '../..');
const OUTPUT = resolve(process.argv[2] || '.cache/sad389-extension-result.json');
const PROFILE = process.env.SAD389_CHROME_PROFILE || join(dirname(OUTPUT), '.cache/sad389-chrome-profile');
const EXT = join(ROOT, 'dist/chrome-mv3');
const COUPON = readFileSync(join(ROOT, 'tests/fixtures/amazon-sad-389/pdp-coupon.real.html'), 'utf8');
const SALES = readFileSync(join(ROOT, 'tests/fixtures/amazon-sad-389/pdp-sales.real.html'), 'utf8');
const results = [];
const network = [];
const errors = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
  if (!pass) throw new Error(`Failed: ${name}`);
};
const asins = { manual: 'B0SAD38901', automatic: 'B0SAD38902', button: 'B0SAD38903', context: 'B0SAD38904', detail: 'B0SAD38905' };
function cardPage(asin, hidden) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Amazon.com: SAD-389 controlled QA</title><style>body{font:16px sans-serif;min-height:6000px}.aok-hidden{display:none}[data-component-type="s-search-result"]{position:relative;width:360px;margin:30px;padding:20px;border:1px solid #ccc}.s-image{width:100px;height:100px}</style></head><body><div class="s-main-slot"><div data-component-type="s-search-result" data-asin="${asin}"><h2><a href="/dp/${asin}">Controlled earbuds</a></h2><img class="s-image" src="https://m.media-amazon.com/images/I/sad389.jpg"><span class="a-price"><span class="a-offscreen">$59.99</span></span><span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$89.99</span></span><span class="a-icon-alt">4.5 out of 5 stars</span><span aria-label="17 ratings">17 ratings</span><div id="offers"${hidden ? ' class="aok-hidden"' : ''}><p id="proof">500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span></div></div></div></body></html>`;
}
function pdp(asin, signals) {
  return `<html><head><title>Amazon.com: controlled PDP</title><link rel="canonical" href="https://www.amazon.com/dp/${asin}"></head><body><div id="centerCol"><h1 id="productTitle">Controlled earbuds</h1><a id="bylineInfo">Visit the Fixture Store</a><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$79.99</span></span></div><img id="landingImage" src="https://m.media-amazon.com/images/I/sad389.jpg">${signals ? SALES + COUPON : ''}</div><div class="a-carousel-container"><div data-asin="B0SAD38999"><span>99K+ bought in past month</span><span class="s-coupon-unclipped">Save 99% with coupon</span></div></div></body></html>`;
}
const pick = p => ({ asin: p.asin, price: p.price, coupon: p.coupon ?? null, pastMonthSales: p.pastMonthSales ?? null, sessionKey: p.sessionKey });

(async () => {
  let context;
  let browserVersion;
  let offscreenContexts;
  try {
    // The directory is exclusively this runner's temporary test profile.
    rmSync(PROFILE, { recursive: true, force: true });
    context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    browserVersion = context.browser().version();
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    context.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await context.route('https://m.media-amazon.com/**', route => route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
    await context.route('https://www.amazon.com/**', route => {
      const u = new URL(route.request().url());
      const asin = /\/dp\/([A-Z0-9]{10})/.exec(u.pathname)?.[1];
      network.push({ url: u.href, serviceWorker: Boolean(route.request().serviceWorker()) });
      if (u.pathname === '/s') {
        const scenario = u.searchParams.get('scenario') || 'manual';
        return route.fulfill({ status: 200, contentType: 'text/html', body: cardPage(asins[scenario], scenario === 'manual' || scenario === 'automatic') });
      }
      if (asin) return route.fulfill({ status: 200, contentType: 'text/html', body: pdp(asin, ![asins.manual, asins.automatic].includes(asin)) });
      return route.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>Not part of the controlled fixture</body></html>' });
    });
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/popup.html`);
    await control.evaluate(() => {
      globalThis.__sad389Rows = store => new Promise((resolveRows, reject) => {
        const open = indexedDB.open('PPHuntDB');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) { db.close(); resolveRows([]); return; }
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => { db.close(); resolveRows(request.result); };
          request.onerror = () => { db.close(); reject(request.error); };
        };
      });
    });
    const store = name => control.evaluate(s => globalThis.__sad389Rows(s), name);
    const send = message => control.evaluate(m => chrome.runtime.sendMessage(m), message);
    const waitRow = async (asin, expected = {}, timeout = 15000) => {
      await expect.poll(async () => {
        const rows = (await store('products')).filter(p => p.asin === asin);
        return rows.length === 1 && Object.entries(expected).every(([k, v]) => (rows[0][k] ?? null) === v);
      }, { timeout, message: `Stored row ${asin}: ${JSON.stringify(expected)}` }).toBe(true);
      return (await store('products')).find(p => p.asin === asin);
    };
    const page = await context.newPage();
    const tabId = async () => control.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, page.url());

    for (const mode of ['manual', 'automatic']) {
      const asin = asins[mode];
      await page.goto(`https://www.amazon.com/s?k=sad389&scenario=${mode}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-pphunt-save-host]');
      const id = await tabId();
      await send({ type: 'START_COLLECTION', payload: { mode, targetCount: 10, tabId: id, sessionKey: `sad389-${mode}` } });
      const initial = await waitRow(asin, { coupon: null, pastMonthSales: null });
      record(`${mode}_initial_absence`, initial.price === 59.99, pick(initial));
      if (mode === 'manual') {
        // Attribute-only reveal: no insertion, no text-length change.
        await page.evaluate(() => document.getElementById('offers').classList.remove('aok-hidden'));
      } else {
        await page.evaluate(() => {
          document.getElementById('offers').classList.remove('aok-hidden');
          document.getElementById('proof').firstChild.nodeValue = '500+ bought in past month';
        });
      }
      // On an unchanged grid automatic mode re-parses at its existing end-of-page
      // callback (~20 s with default settings), not on every scroll tick.
      const hydrated = await waitRow(asin, { coupon: 'Save $5 with coupon', pastMonthSales: '500+ bought in past month' }, mode === 'automatic' ? 30000 : 15000);
      record(`${mode}_hydration_storage`, hydrated.price === 59.99, pick(hydrated));
      await send({ type: 'STOP_COLLECTION', payload: { tabId: id } });
    }

    for (const scenario of ['button', 'context']) {
      const asin = asins[scenario];
      await page.goto(`https://www.amazon.com/s?k=sad389&scenario=${scenario}`, { waitUntil: 'domcontentloaded' });
      const host = await page.waitForSelector('[data-pphunt-save-host]');
      if (scenario === 'button') {
        // Actual closed-shadow control: click its visible host (no injected save).
        await host.click({ force: true });
      } else {
        await page.locator('h2').click({ button: 'right' });
        await page.keyboard.press('Escape');
        const delivery = await control.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'SAVE_CONTEXT_PRODUCT', payload: { requestedAt: new Date().toISOString(), fromSubframe: false } }), await tabId());
        record('context_menu_command_delivery', delivery?.ok === true, delivery);
      }
      const row = await waitRow(asin, { coupon: 'Apply 50% coupon', pastMonthSales: '4K+ bought in past month' });
      record(`${scenario}_save_real_offscreen_enrichment`, row.price === 59.99, pick(row));
    }

    await page.goto(`https://www.amazon.com/dp/${asins.detail}`, { waitUntil: 'domcontentloaded' });
    await send({ type: 'START_COLLECTION', payload: { mode: 'manual', targetCount: 10, tabId: await tabId(), sessionKey: 'sad389-detail' } });
    const detailRow = await waitRow(asins.detail, { coupon: 'Apply 50% coupon', pastMonthSales: '4K+ bought in past month' });
    record('live_pdp_collection', detailRow.price === 79.99, pick(detailRow));
    const rows = await store('products');
    record('no_duplicate_rows', rows.length === 5 && new Set(rows.map(p => p.asin)).size === 5, rows.map(pick));
    const snapshots = await store('snapshots');
    record('snapshot_contract', snapshots.some(s => s.asin === asins.button && s.source === 'detail' && s.coupon === 'Apply 50% coupon' && s.price === 79.99) && snapshots.every(s => !Object.hasOwn(s, 'pastMonthSales')), { count: snapshots.length, detailCoupon: snapshots.find(s => s.asin === asins.button && s.source === 'detail')?.coupon });
    offscreenContexts = await control.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    record('real_offscreen_document', offscreenContexts.length === 1, offscreenContexts.map(c => c.documentUrl));
    for (const format of ['csv', 'xlsx']) {
      const file = await send({ target: 'pphunt-offscreen', type: 'OFFSCREEN_BUILD_EXPORT', format, products: rows, columns: ['ASIN', 'Monthly Sales', 'Coupon', 'Price'], filename: 'sad389-browser', includeBOM: false, embedImages: 'never' });
      if (!file?.ok) throw new Error(`Offscreen ${format}: ${JSON.stringify(file)}`);
      const book = XLSX.read(Buffer.from(file.base64, 'base64'), { type: 'buffer', raw: true });
      const table = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
      const cellsMatch = table.length === 6 && rows.every(p => {
        const cells = table.find(r => r[0] === p.asin);
        return cells?.[1] === p.pastMonthSales && cells?.[2] === p.coupon && Number(cells?.[3]) === p.price;
      });
      record(`${format}_actual_offscreen_export`, cellsMatch, table);
    }
    record('service_worker_fetch_was_exercised', network.some(r => r.serviceWorker && /\/dp\//.test(r.url)), { requests: network.length, workerPdpRequests: network.filter(r => r.serviceWorker && /\/dp\//.test(r.url)).length });
  } catch (error) {
    results.push({ name: 'runner', pass: false, detail: String(error.stack || error) });
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    const report = { candidateCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), capturedAt: new Date().toISOString(), browserVersion, passed: results.length > 0 && results.every(r => r.pass), results, network, consoleErrors: errors, limitations: ['Controlled network fixtures, not live Amazon Chrome coverage.', 'Context-menu dispatch programmatic after real capture; no OS menu-item click.', 'No account, coupon clipping, cart or purchase actions.'] };
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n');
    if (context) await context.close();
    console.log(`Report: ${OUTPUT}`);
  }
})();
