#!/usr/bin/env node
/**
 * SAD-359 — live measurement harness for the per-field extraction diagnostics.
 *
 * This is a **spike tool**, not production code: nothing in `src/` imports
 * it, it is not bundled into the extension, and it never runs in CI. It
 * exists so the diagnostic report can be checked against *real* Amazon pages
 * with the numbers written down instead of guessed — the same reason
 * `scripts/enrichment-spike.ts` (SAD-338) exists.
 *
 * Run it with:
 *
 *   npm run build                                    # the extension must be built
 *   npm run measure:diagnostics -- --asins B0D1XD1ZV3,B0C7J2ZKQD
 *   npm run measure:diagnostics -- --out docs/plans/sad-359-measurement.json
 *
 * What it does, per ASIN:
 *   1. opens the real product page in Chromium with the built extension
 *      loaded (the extension's own service worker is the log sink),
 *   2. asks the extension to save the product through its DOM bridge — the
 *      same code path the right-click menu item uses,
 *   3. captures the service worker's `[PPHunt][Amazon][Diagnostics]` line,
 *   4. reads the row the extension actually stored, and
 *   5. checks the report against that row: every field the report calls
 *      EXTRACTED must be present in the stored product, and every field it
 *      calls MISSING / PARSE_FAILED / UNKNOWN must be absent from it.
 *
 * A mismatch is a bug in the *diagnostics*, not a licence to change
 * extraction. The harness reports it and exits non-zero.
 *
 * Notes on the environment:
 *   - The extension's MV3 service worker only registers in **headed** mode in
 *     this sandbox, so run it under a virtual display:
 *         xvfb-run -a --server-args="-screen 0 1600x1000x24" \
 *           npm run measure:diagnostics -- --asins B0D1XD1ZV3
 *   - Each product is visited **once, from a clean browser session**, the way
 *     a person opens a product page. The harness never defeats a block: if
 *     Amazon serves an explicit refusal (for example the "unauthorized AI
 *     agent" page) the harness records it and moves on to the next product.
 *     Only the ordinary cold-profile challenge — the "Continue shopping"
 *     form every fresh profile gets — is completed, because that is the
 *     normal flow of the page itself.
 *   - Like `scripts/enrichment-spike.ts` (SAD-338), this tool is packaged for
 *     the operator to run: a datacenter IP is answered with a bot
 *     interstitial, so the meaningful numbers come from a normal connection.
 *
 * SAD-369 step 4 extended this harness for the diagnostics switch:
 *   --flag on|off seeds `pphuntDiagnosticsEnabled` through the real
 *   storage path; `off` runs assert that NOTHING prints (L1); all lines —
 *   including the drift line, which moved to the service worker (D10) —
 *   are captured per-origin, so a line in the wrong console is a failure.
 *   --l3 exercises the card-save path, --l8 flips the switch without a
 *   reload, and --target drives the 50-line cap check.
 */

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXTENSION_DIR = join(ROOT, 'dist', 'chrome-mv3');
const PREFIX = '[PPHunt][Amazon][Diagnostics]';

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const options = {
    asins: ['B0D1XD1ZV3'],
    out: join(ROOT, 'docs', 'plans', 'sad-359-measurement.json'),
    settleMs: 9000,
    listing: null,
    /*
     * SAD-369 step 4 additions:
     *  --flag on|off   seed `pphuntDiagnosticsEnabled` into the extension's
     *                  storage.local before every action. With SAD-369 the
     *                  switch defaults to OFF, so a harness that wants lines
     *                  must turn it on explicitly — and a run with it off
     *                  asserts that NOTHING prints (L1).
     *  --target <n>    collection targetCount for the listing run.
     *  --scrolls <n>   normal mouse-wheel scrolls during collection (L6).
     *  --l3            on the listing, save the first card through the real
     *                  right-click/context-menu path and expect a `card` line.
     *  --l4            click the real visible card icon and expect a `card` line.
     *  --l8            on one product page: save on, flip off, save, flip on,
     *                  save — the switch must bite without a reload (L8).
     */
    flag: 'on',
    target: 20,
    scrolls: 0,
    l3: false,
    l4: false,
    l8: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--asins') options.asins = String(argv[++i]).split(',').filter(Boolean);
    else if (arg === '--out') options.out = resolve(ROOT, String(argv[++i]));
    else if (arg === '--settle') options.settleMs = Number(argv[++i]);
    else if (arg === '--listing') options.listing = String(argv[++i]);
    else if (arg === '--flag') options.flag = String(argv[++i]);
    else if (arg === '--target') options.target = Number(argv[++i]);
    else if (arg === '--scrolls') options.scrolls = Number(argv[++i]);
    else if (arg === '--l3') options.l3 = true;
    else if (arg === '--l4') options.l4 = true;
    else if (arg === '--l8') options.l8 = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.flag !== 'on' && options.flag !== 'off') {
    throw new Error(`--flag must be "on" or "off", got: ${options.flag}`);
  }
  return options;
}

function usage() {
  console.log(
    [
      'Usage: npm run measure:diagnostics -- [options]',
      '',
      '  --asins <a,b>    product ASINs to visit (default: B0D1XD1ZV3)',
      '  --listing <url>  an optional listing page to visit for the drift line',
      '  --out <path>     where to write the JSON report',
      '  --settle <ms>    how long to wait for the save to finish (default 9000)',
      '  --flag <on|off>  seed the diagnostics switch before every action (default: on)',
      '  --target <n>     collection targetCount for the listing run (default: 20)',
      '  --scrolls <n>    normal mouse-wheel scrolls during collection (L6)',
      '  --l3             save the first listing card via the context-menu path',
      '  --l4             click the first card icon (closed-shadow button)',
      '  --l8             flip the switch without a reload and re-save',
    ].join('\n'),
  );
}

/* -------------------------------------------------------------- playwright */

function loadPlaywright() {
  // The sandbox exposes Playwright on NODE_PATH; a normal checkout would
  // have it as a devDependency. Try both, then a couple of known locations.
  const candidates = [
    'playwright',
    '/opt/playwright/node_modules/playwright/index.js',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try the next one
    }
  }
  console.error(
    'Could not load Playwright.\n' +
      'Install it (`npm i -D playwright && npx playwright install chromium`) or ' +
      'make it resolvable, then run the harness again.',
  );
  process.exit(2);
}

/* ------------------------------------------------------------- verification */

/** Mirrors the emptiness rule the engine's own validator uses. */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Checks one field's diagnostic against the row the extension stored.
 *
 * `isPrime` is the one field whose absent form is a real value: `false`
 * means "this offer is not Prime", not "we could not tell". The engine
 * reports it MISSING when no Prime marker was found, and the stored row
 * carries `false` — so `false` counts as absent for it.
 */
function verifyField(field, stored) {
  const name = field.field;
  const value = stored?.[name];
  const empty = isEmpty(value) || (name === 'isPrime' && value === false);

  switch (field.status) {
    case 'EXTRACTED':
      // validated:false means the value was extracted and then dropped.
      if (field.validated === false) {
        return empty ? null : 'reported EXTRACTED but validation dropped it, yet the row still has a value';
      }
      return empty ? 'reported EXTRACTED but the stored row has no value' : null;
    case 'PARTIAL':
      // validated:false → the value was dropped by validation.
      if (field.validated === false) {
        return empty ? null : 'reported PARTIAL (validation drop) but the stored row still has a value';
      }
      return empty ? 'reported PARTIAL (rescue) but the stored row has no value' : null;
    case 'MISSING':
    case 'PARSE_FAILED':
    case 'UNKNOWN':
      return empty ? null : `reported ${field.status} but the stored row still has a value`;
    default:
      return `unknown status: ${field.status}`;
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    console.error(
      `The extension is not built. Run \`npm run build\` first (expected ${EXTENSION_DIR}/manifest.json).`,
    );
    return 2;
  }

  const { chromium } = loadPlaywright();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  /**
   * A clean browser session per product. Each page is requested once, the
   * way a person opens a product page — the harness does not accumulate a
   * challenged session and does not retry behind a block.
   */
  async function openSession() {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pphunt-sad359-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });

    let worker = context.serviceWorkers()[0];
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    }

    /**
     * The MV3 worker is stopped by Chrome when it goes idle, and a stopped
     * worker is a *new* object next time it wakes. So the console listener
     * has to follow every incarnation, not just the first one.
     */
    const swLines = [];
    const allSwLines = [];
    /**
     * SAD-369 step 4: lines of WORKER origin only, never merged with the
     * page console — the D10 checks must be able to tell the two apart.
     */
    const workerPrefixedLines = [];
    const attached = new WeakSet();
    const attachWorker = (target) => {
      if (!target || attached.has(target)) return;
      attached.add(target);
      target.on('console', (message) => {
        const text = message.text();
        allSwLines.push(text);
        if (text.startsWith(PREFIX)) {
          swLines.push(text);
          workerPrefixedLines.push(text);
        }
      });
    };
    attachWorker(worker);
    context.on('serviceworker', (target) => {
      attachWorker(target);
      worker = target;
    });

    const page =
      context.pages().find((p) => !p.url().startsWith('chrome://')) ??
      (await context.newPage());

    /**
     * The content script logs into the **page** console, the worker into its
     * own. Since SAD-369 (D10) the aggregate card-drift line is a WORKER
     * line — the page console is still watched so any diagnostics line that
     * leaks into it counts as a D10 violation.
     */
    const pageLines = [];
    page.on('console', (message) => {
      const text = message.text();
      pageLines.push(text);
      if (text.startsWith(PREFIX)) swLines.push(text);
    });

    /**
     * SAD-369 step 4: the diagnostics switch (off by default) is written
     * straight into the extension's `storage.local`, through the worker.
     * `storage.onChanged` fans the write out to every context — the same
     * path a toggle in the Settings panel takes — so this is the real
     * mechanism, not a backdoor.
     */
    async function setFlag(enabled) {
      const live = context.serviceWorkers()[0] ?? worker;
      if (!live) throw new Error('no service worker to write the flag through');
      attachWorker(live);
      await live.evaluate(async (value) => {
        await chrome.storage.local.set({ pphuntDiagnosticsEnabled: value });
      }, enabled);
      // Let storage.onChanged reach the worker's cached reader and the
      // content script's listener before the next action is taken.
      await page.waitForTimeout(400);
    }

    return {
      context,
      page,
      swLines,
      allSwLines,
      pageLines,
      workerPrefixedLines,
      attachWorker,
      setFlag,
    };
  }

  /**
   * Loads a product page.
   *
   * Amazon answers a cold profile with an ordinary "Continue shopping"
   * challenge — the page's own flow, completed here exactly as a person
   * would. An explicit refusal (Amazon's "unauthorized AI agent" page) is
   * NOT clicked through: the harness records it and stops for that product.
   */
  async function openProductPage(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const verdict = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      if (/unauthorized AI agent|violates Amazon's Conditions of Use/i.test(text)) {
        return 'refused';
      }
      return document.title === 'Amazon.com' ? 'challenge' : 'ok';
    });

    if (verdict === 'ok') return 'ok';
    if (verdict === 'refused') return 'refused';

    // The ordinary cold-profile challenge: a "Continue shopping" form.
    const button = page.locator('button.a-button-text').first();
    if (!(await button.count())) return 'challenge-uncleared';
    await button.click().catch(() => {});
    await page.waitForTimeout(4000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const after = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      if (/unauthorized AI agent|violates Amazon's Conditions of Use/i.test(text)) {
        return 'refused';
      }
      return document.title === 'Amazon.com' ? 'challenge' : 'ok';
    });
    return after === 'ok' ? 'challenge-cleared' : after;
  }

  /** Reads every stored product row out of the extension's IndexedDB. */
  async function readStoredRows(worker) {
    return worker.evaluate(async () => {
      const open = indexedDB.open('PPHuntDB');
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('indexedDB open blocked'));
      });
      if (!db.objectStoreNames.contains('products')) return [];
      const tx = db.transaction('products', 'readonly');
      const request = tx.objectStore('products').getAll();
      return await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  const results = [];
  const failures = [];
  const limitations = [];

  for (const asin of options.asins) {
    const url = `https://www.amazon.com/dp/${asin}`;
    const session = await openSession();
    const { context, page, swLines, allSwLines } = session;

    try {
      const gate = await openProductPage(page, url);
      const title = await page.title();
      const landedUrl = page.url();

      if (gate === 'refused') {
        results.push({
          asin,
          url,
          landedUrl,
          title,
          gate,
          error:
            'Amazon served an explicit refusal ("unauthorized AI agent"). ' +
            'The harness does not click through a refusal.',
        });
        continue;
      }

      // The worker may have stopped while the page loaded; wake it before the
      // save so its console output is not lost.
      const worker = context.serviceWorkers()[0];
      if (worker) {
        session.attachWorker(worker);
        await worker.evaluate(() => true).catch(() => {});
      }

      // SAD-369 step 4: seed the switch through the real storage path.
      await session.setFlag(options.flag === 'on');

      const before = swLines.length;
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('pphunt:command', {
            detail: {
              type: 'SAVE_CONTEXT_PRODUCT',
              payload: { requestedAt: String(Date.now()), fromSubframe: false },
            },
          }),
        );
      });
      await page.waitForTimeout(options.settleMs);

      const lines = swLines.slice(before);
      const diagnosticLine = lines.find((line) => line.startsWith(`${PREFIX} {`));
      const jobLine = lines.find((line) => line.startsWith('[PPHunt] save job'));

      // L1 (SAD-369): switch off ⇒ not one diagnostics line, page or worker,
      // while the save itself still runs. The silence only counts as
      // evidence when the save demonstrably happened — so the stored row is
      // checked too.
      if (options.flag === 'off') {
        const pagePrefixed = session.pageLines.filter((l) =>
          l.startsWith(PREFIX),
        );
        const liveWorkerOff = context.serviceWorkers()[0];
        const rowsOff = liveWorkerOff ? await readStoredRows(liveWorkerOff) : [];
        const storedOff = rowsOff.find((row) => row.asin === asin) ?? null;
        const ok = lines.length === 0 && pagePrefixed.length === 0;
        if (!ok) {
          failures.push(
            `${asin}: switch OFF but ${lines.length} worker + ${pagePrefixed.length} page diagnostics line(s) appeared (L1)`,
          );
        }
        if (!storedOff) {
          failures.push(
            `${asin}: switch OFF and the save stored no row — the silence proves nothing until the save runs (L1)`,
          );
        }
        results.push({
          asin,
          url,
          landedUrl,
          title,
          gate,
          flag: 'off',
          l1: ok,
          linesDuringSave: lines.length,
          pagePrefixedDuringRun: pagePrefixed.length,
          saveJobLogged: Boolean(jobLine),
          storedProductPresent: storedOff !== null,
        });
        continue;
      }

      if (!diagnosticLine) {
        results.push({
          asin,
          url,
          landedUrl,
          title,
          gate,
          error: 'no diagnostics line was logged',
          saveJobLogged: Boolean(jobLine),
          swLines: allSwLines.slice(-12),
        });
        continue;
      }

      const report = JSON.parse(diagnosticLine.slice(diagnosticLine.indexOf('{')));
      // L1–L8 supplemental safety checks: the line is one-line JSON; it
      // contains only field diagnostics (not product values); and the five
      // status counts partition the 24 modelled fields.
      const statusTotal = Object.values(report.counts ?? {}).reduce(
        (sum, value) => sum + (typeof value === 'number' ? value : 0),
        0,
      );
      const reportPrivacyOk =
        report.fields?.length === 24 &&
        !('title' in report) &&
        !('price' in report) &&
        !('url' in report) &&
        !('product' in report) &&
        (report.fields ?? []).every(
          (f) => !('value' in f) && !('extractedValue' in f),
        );
      if (report.fields?.length !== 24 || statusTotal !== 24) {
        failures.push(
          `${asin}: report has ${report.fields?.length ?? 0} field rows and counts sum to ${statusTotal}; expected 24/24`,
        );
      }
      if (!reportPrivacyOk) {
        failures.push(
          `${asin}: per-field line contains a value-bearing property or has no 24-field shape`,
        );
      }
      const liveWorker = context.serviceWorkers()[0];
      const rows = liveWorker ? await readStoredRows(liveWorker) : [];
      const stored = rows.find((row) => row.asin === asin) ?? null;
      const storedValueLeaks = [
        stored?.title,
        stored?.url,
      ].filter(
        (value) =>
          typeof value === 'string' && value.length > 0 && diagnosticLine.includes(value),
      );
      if (storedValueLeaks.length > 0) {
        failures.push(
          `${asin}: diagnostic line contained ${storedValueLeaks.length} stored product value(s) (privacy check)`,
        );
      }

      const mismatches = [];
      for (const field of report.fields ?? []) {
        const problem = verifyField(field, stored);
        if (problem) {
          mismatches.push({ field: field.field, status: field.status, problem });
        }
      }

      // L2 (SAD-369): a save from a product page prints exactly one
      // `detail-page` line; if enrichment's fetch succeeds, an
      // `enrichment-parse` line follows under the SAME jobId.
      const stageOf = (line) => {
        try {
          return JSON.parse(line.slice(line.indexOf('{'))).stage;
        } catch {
          return null;
        }
      };
      const detailPageCount = lines.filter(
        (l) => l.startsWith(`${PREFIX} {`) && stageOf(l) === 'detail-page',
      ).length;
      const enrichmentParseLines = lines.filter(
        (l) => l.startsWith(`${PREFIX} {`) && stageOf(l) === 'enrichment-parse',
      );
      if (report.stage !== 'detail-page') {
        failures.push(
          `${asin}: save from a product page printed stage "${report.stage}", expected "detail-page" (L2)`,
        );
      }
      if (detailPageCount !== 1) {
        failures.push(
          `${asin}: expected exactly 1 detail-page line, saw ${detailPageCount} (L2)`,
        );
      }
      for (const epLine of enrichmentParseLines) {
        const ep = JSON.parse(epLine.slice(epLine.indexOf('{')));
        if (ep.jobId !== report.jobId) {
          failures.push(
            `${asin}: enrichment-parse line has jobId ${ep.jobId}, save line has ${report.jobId} (L3 same-job rule)`,
          );
        }
      }

      results.push({
        asin,
        url,
        landedUrl,
        title,
        gate,
        flag: options.flag,
        jobId: report.jobId,
        stage: report.stage,
        detailPageCount,
        enrichmentParseLines: enrichmentParseLines.length,
        counts: report.counts,
        fields: report.fields,
        storedProductPresent: stored !== null,
        storedTitle: stored?.title ?? null,
        storedPrice: stored?.price ?? null,
        mismatches,
      });
    } finally {
      await context.close();
    }
  }

  if (options.listing) {
    const session = await openSession();
    try {
      const { page, pageLines, swLines, workerPrefixedLines } = session;
      const gate = await openProductPage(page, options.listing);

      if (gate === 'refused') {
        results.push({ listing: options.listing, gate, error: 'explicit refusal' });
      } else {
        // SAD-369 step 4: seed the switch, then run a real collection — a
        // listing is only parsed when a collection runs.
        await session.setFlag(options.flag === 'on');
        const before = swLines.length;
        const beforeWorker = workerPrefixedLines.length;
        await page.evaluate((target) => {
          window.dispatchEvent(
            new CustomEvent('pphunt:command', {
              detail: {
                type: 'COLLECT_PRODUCTS',
                payload: { mode: 'manual', targetCount: target },
              },
            }),
          );
        }, options.target);
        // Manual collection normally waits for the owner to scroll. `--scrolls`
        // uses ordinary browser wheel input so L6 can be exercised on a real
        // listing without changing collection mode or bypassing page behavior.
        for (let i = 0; i < options.scrolls; i += 1) {
          await page.mouse.wheel(0, 1000);
          await page.waitForTimeout(750);
        }
        await page.waitForTimeout(options.settleMs);

        const window_ = swLines.slice(before);
        const workerWindow = workerPrefixedLines.slice(beforeWorker);
        const stageOf = (line) => {
          try {
            return JSON.parse(line.slice(line.indexOf('{'))).stage;
          } catch {
            return null;
          }
        };

        // L7 (D10): the drift line now belongs to the SERVICE WORKER console
        // — the page console must stay clean.
        const driftInWorker = workerWindow.find((l) =>
          l.startsWith(`${PREFIX} drift `),
        );
        const driftInPage = pageLines.find((l) =>
          l.startsWith(`${PREFIX} drift `),
        );
        if (options.flag === 'on') {
          if (!driftInWorker) {
            failures.push(
              `listing: no drift line in the service-worker console (L7)`,
            );
          }
          if (driftInPage) {
            failures.push(
              `listing: drift line still printed in the PAGE console — D10 says worker-only (L7)`,
            );
          }
        } else if (driftInWorker || driftInPage) {
          failures.push(
            `listing: switch OFF but a drift line appeared (L1)`,
          );
        }

        // L5/L6: one collection-card line per collected product, capped at 50.
        const collectionCardLines = workerWindow.filter(
          (l) => l.startsWith(`${PREFIX} {`) && stageOf(l) === 'collection-card',
        );
        const liveWorker = session.context.serviceWorkers()[0];
        const rows = liveWorker ? await readStoredRows(liveWorker) : [];
        const storedCount = rows.length;
        const collectionCheckFailures = [];
        for (const line of collectionCardLines) {
          try {
            const payload = JSON.parse(line.slice(line.indexOf('{')));
            const countSum = Object.values(payload.counts ?? {}).reduce(
              (sum, value) => sum + (typeof value === 'number' ? value : 0),
              0,
            );
            if (payload.fields?.length !== 24 || countSum !== 24) {
              collectionCheckFailures.push(
                `ASIN ${payload.asin ?? 'unknown'}: ${payload.fields?.length ?? 0} fields / ${countSum} counts (expected 24/24)`,
              );
            }
            if (
              'title' in payload || 'price' in payload || 'url' in payload ||
              'product' in payload ||
              (payload.fields ?? []).some((field) => 'value' in field || 'extractedValue' in field)
            ) {
              collectionCheckFailures.push(
                `ASIN ${payload.asin ?? 'unknown'}: value-bearing key in per-product line`,
              );
            }
            const storedRow = rows.find((row) => row.asin === payload.asin);
            const leaks = [
              storedRow?.title,
              storedRow?.url,
            ].filter(
              (value) =>
                typeof value === 'string' && value.length > 0 && line.includes(value),
            );
            if (leaks.length > 0) {
              collectionCheckFailures.push(
                `ASIN ${payload.asin ?? 'unknown'}: line contains ${leaks.length} stored value(s)`,
              );
            }
          } catch (error) {
            collectionCheckFailures.push(`unparseable collection line: ${String(error)}`);
          }
        }
        if (collectionCheckFailures.length > 0) {
          failures.push(...collectionCheckFailures.map((item) => `listing: ${item}`));
        }
        const l6Status =
          options.flag !== 'on' || options.target <= 50
            ? 'not-requested'
            : storedCount > 50
              ? collectionCardLines.length === 50
                ? 'passed'
                : 'failed'
              : 'not-exercised-target-unreached';
        if (options.target > 50 && storedCount <= 50) {
          limitations.push(
            `L6 not exercised: requested target ${options.target}, but this live Amazon page run stored only ${storedCount} products; no more than 50 distinct products were available/collected. The synthetic 60-card test still verifies the cap, but this does not replace L6's real >50 browser check.`,
          );
        }
        if (options.flag === 'on') {
          if (collectionCardLines.length > 50) {
            failures.push(
              `listing: ${collectionCardLines.length} collection-card lines — the cap is 50 (L6)`,
            );
          }
          if (storedCount > 50 && collectionCardLines.length !== 50) {
            failures.push(
              `listing: ${storedCount} products stored but ${collectionCardLines.length} collection-card lines — expected exactly 50 (L6)`,
            );
          }
          if (storedCount > 0 && storedCount <= 50 && collectionCardLines.length < storedCount) {
            failures.push(
              `listing: ${storedCount} products stored but only ${collectionCardLines.length} collection-card lines (L5)`,
            );
          }
        } else if (collectionCardLines.length > 0) {
          failures.push(
            `listing: switch OFF but ${collectionCardLines.length} collection-card lines appeared (L1)`,
          );
        }

        results.push({
          listing: options.listing,
          gate,
          flag: options.flag,
          target: options.target,
          scrolls: options.scrolls,
          l6Status,
          driftLineSeen: Boolean(driftInWorker),
          driftLineConsole: driftInWorker ? 'service-worker' : driftInPage ? 'page' : 'none',
          driftLine: (driftInWorker ?? driftInPage)?.slice(0, 400) ?? null,
          collectionCardLines: collectionCardLines.length,
          collectionLinesJsonAndPrivacyPass: collectionCheckFailures.length === 0,
          storedProducts: storedCount,
        });

        // L3/L4: save the first card through the extension's own
        // context-menu code path (the icon and the menu share it).
        if (options.l3 && options.flag === 'on') {
          const l3Before = workerPrefixedLines.length;
          const card = page
            .locator('div[data-component-type="s-search-result"][data-asin]')
            .first();
          const cardFound = (await card.count()) > 0;
          if (!cardFound) {
            results.push({ listingCardSave: 'no card element found', l3: false });
          } else {
            // Use a real browser right-click, not dispatchEvent: the content
            // script's capture-phase listener must see the same contextmenu
            // path a person uses (captureSaveTarget checks the target/page).
            await card.scrollIntoViewIfNeeded();
            await card.click({ button: 'right', position: { x: 20, y: 20 } });
            await page.waitForTimeout(300);
            await page.evaluate(() => {
              window.dispatchEvent(
                new CustomEvent('pphunt:command', {
                  detail: {
                    type: 'SAVE_CONTEXT_PRODUCT',
                    payload: { requestedAt: String(Date.now()), fromSubframe: false },
                  },
                }),
              );
            });
            await page.waitForTimeout(options.settleMs);
            const l3Lines = workerPrefixedLines.slice(l3Before).filter((l) =>
              l.startsWith(`${PREFIX} {`),
            );
            const cardLines = l3Lines.filter((l) => stageOf(l) === 'card');
            if (cardLines.length !== 1) {
              failures.push(
                `listing: card save printed ${cardLines.length} "card" lines, expected exactly 1 (L3/L4)`,
              );
            }
            results.push({
              listingCardSave: options.listing,
              l3: cardLines.length === 1,
              cardLines: cardLines.length,
              enrichmentParseLines: l3Lines.filter(
                (l) => stageOf(l) === 'enrichment-parse',
              ).length,
              jobId: cardLines[0]
                ? JSON.parse(cardLines[0].slice(cardLines[0].indexOf('{'))).jobId
                : null,
            });
          }
        }

        // L4: click the real card-icon control. Its button lives in a closed
        // shadow root, so Playwright cannot locate it by text; click the host's
        // visible bounding-box center with the real browser mouse instead.
        if (options.l4 && options.flag === 'on') {
          const firstCard = page
            .locator('div[data-component-type="s-search-result"][data-asin]')
            .first();
          await firstCard.scrollIntoViewIfNeeded();
          await page.waitForTimeout(1000);
          const icon = page.locator('[data-pphunt-save-host]').first();
          const iconFound = (await icon.count()) > 0;
          if (!iconFound) {
            failures.push('listing: no card-icon host found (L4)');
            results.push({ listingCardIcon: options.listing, l4: false, reason: 'host not mounted' });
          } else {
            await icon.scrollIntoViewIfNeeded();
            const iconMetadata = await icon.evaluate((host) => {
              const rect = host.getBoundingClientRect();
              return {
                asin: host.getAttribute('data-asin'),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                inViewport:
                  rect.x >= 0 && rect.y >= 0 &&
                  rect.right <= window.innerWidth &&
                  rect.bottom <= window.innerHeight,
              };
            });
            const l4Before = workerPrefixedLines.length;
            // A normal, unforced locator click targets the visible host;
            // Chromium dispatches pointer events through its closed shadow
            // root to the real button, as the user's click does.
            await icon.click();
            await page.waitForTimeout(options.settleMs);
            const iconLines = workerPrefixedLines.slice(l4Before).filter((l) =>
              l.startsWith(`${PREFIX} {`),
            );
            const cardLines = iconLines.filter((l) => stageOf(l) === 'card');
            if (cardLines.length !== 1) {
              failures.push(
                `listing: card-icon save printed ${cardLines.length} "card" lines, expected exactly 1 (L4)`,
              );
            }
            results.push({
              listingCardIcon: options.listing,
              l4: cardLines.length === 1,
              iconMetadata,
              cardLines: cardLines.length,
              jobId: cardLines[0]
                ? JSON.parse(cardLines[0].slice(cardLines[0].indexOf('{'))).jobId
                : null,
            });
          }
        }
      }
    } finally {
      await session.context.close();
    }
  }

  // L8 (SAD-369): flipping the switch with the page open must bite without a
  // reload — off silences the next save, on brings it back.
  if (options.l8) {
    const asin = options.asins[0];
    const session = await openSession();
    try {
      const { page, swLines } = session;
      const gate = await openProductPage(page, `https://www.amazon.com/dp/${asin}`);
      if (gate === 'refused') {
        results.push({ l8: 'skipped', gate, reason: 'explicit refusal' });
      } else {
        const saveOnce = async () => {
          const before = swLines.length;
          await page.evaluate(() => {
            window.dispatchEvent(
              new CustomEvent('pphunt:command', {
                detail: {
                  type: 'SAVE_CONTEXT_PRODUCT',
                  payload: { requestedAt: String(Date.now()), fromSubframe: false },
                },
              }),
            );
          });
          await page.waitForTimeout(options.settleMs);
          return swLines.slice(before).filter((l) => l.startsWith(PREFIX)).length;
        };

        await session.setFlag(true);
        const onCount = await saveOnce();
        await session.setFlag(false);
        const offCount = await saveOnce();
        await session.setFlag(true);
        const onAgainCount = await saveOnce();

        if (onCount < 1) {
          failures.push(`l8: switch ON but the save printed nothing (L8)`);
        }
        if (offCount !== 0) {
          failures.push(`l8: switch flipped OFF but the save printed ${offCount} line(s) without a reload (L8)`);
        }
        if (onAgainCount < 1) {
          failures.push(`l8: switch flipped back ON but the save printed nothing without a reload (L8)`);
        }
        results.push({
          l8: { asin, gate, onCount, offCount, onAgainCount },
        });
      }
    } finally {
      await session.context.close();
    }
  }

  const mismatched = results.filter((r) => (r.mismatches?.length ?? 0) > 0);
  const report = {
    tool: 'scripts/sad-359-diagnostics-measurement.mjs',
    generatedAt: new Date().toISOString(),
    prefix: PREFIX,
    flag: options.flag,
    target: options.target,
    results,
    failures,
    limitations,
  };

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  /* ---------------------------------------------------------- console summary */
  console.log(`\nSAD-359/369 live measurement — ${options.asins.length} product(s), flag=${options.flag}\n`);
  for (const result of results) {
    if (result.listing !== undefined) {
      console.log(`listing ${result.listing}  gate=${result.gate}  flag=${result.flag ?? '-'}`);
      console.log(
        `  drift: ${result.driftLineSeen ? `seen in the ${result.driftLineConsole} console` : 'not seen'}` +
          (result.collectionCardLines !== undefined
            ? ` · collection-card lines: ${result.collectionCardLines} · stored products: ${result.storedProducts} · JSON/privacy: ${result.collectionLinesJsonAndPrivacyPass ? 'pass' : 'fail'} · L6: ${result.l6Status}`
            : ''),
      );
      if (result.driftLine) console.log(`  ${result.driftLine}`);
      continue;
    }
    if (result.listingCardSave !== undefined || result.listingCardIcon !== undefined) {
      const check = result.listingCardIcon !== undefined ? 'L4 card icon' : 'L3 right-click';
      console.log(
        `${check}: ${result.cardLines ?? 0} card line(s), ` +
          `${result.enrichmentParseLines ?? 0} enrichment-parse line(s), jobId=${result.jobId ?? '-'}`,
      );
      continue;
    }
    if (result.l8 !== undefined && typeof result.l8 === 'object') {
      const l8 = result.l8;
      console.log(
        `l8 flip-without-reload: on=${l8.onCount} line(s) → off=${l8.offCount} → on=${l8.onAgainCount}  (expected ≥1 / 0 / ≥1)`,
      );
      continue;
    }
    if (result.error) {
      console.log(`${result.asin}  ERROR: ${result.error}`);
      continue;
    }
    if (result.flag === 'off') {
      console.log(
        `${result.asin}  switch OFF (L1): ${result.linesDuringSave} worker + ` +
          `${result.pagePrefixedDuringRun} page diagnostics line(s) — ${result.l1 ? 'clean ✓' : 'LEAK'}` +
          `   (save job ran: ${result.saveJobLogged ? 'yes' : 'no'}, stored row: ${result.storedProductPresent ? 'yes' : 'no'})`,
      );
      continue;
    }
    const c = result.counts ?? {};
    console.log(
      `${result.asin}  ${c.extracted ?? 0} extracted · ${c.missing ?? 0} missing · ` +
        `${c.parseFailed ?? 0} parse-failed · ${c.partial ?? 0} partial · ${c.unknown ?? 0} unknown` +
        `   (stored: ${result.storedProductPresent ? 'yes' : 'no'}, stage: ${result.stage}, ` +
        `detail-page lines: ${result.detailPageCount}, enrichment-parse: ${result.enrichmentParseLines})`,
    );
    const flagged = (result.fields ?? []).filter(
      (f) => f.status !== 'EXTRACTED' && f.status !== 'UNKNOWN',
    );
    for (const field of flagged) {
      console.log(`    ${field.status.padEnd(13)} ${field.field.padEnd(20)} ${field.reason ?? ''}`);
    }
    for (const mismatch of result.mismatches ?? []) {
      console.log(`    !! MISMATCH ${mismatch.field}: ${mismatch.problem}`);
    }
  }
  console.log(`\nreport written to ${options.out}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} expectation(s) FAILED:`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
  }
  if (limitations.length > 0) {
    console.warn(`\n${limitations.length} live-check limitation(s):`);
    for (const limitation of limitations) console.warn(`  ! ${limitation}`);
  }

  if (mismatched.length > 0 || failures.length > 0) {
    if (mismatched.length > 0) {
      console.error(
        `${mismatched.length} product(s) disagreed with the stored row — the diagnostics do not match the extraction.`,
      );
    }
    return 1;
  }
  return 0;
}

process.exitCode = await main();
