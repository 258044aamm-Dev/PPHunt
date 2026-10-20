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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--asins') options.asins = String(argv[++i]).split(',').filter(Boolean);
    else if (arg === '--out') options.out = resolve(ROOT, String(argv[++i]));
    else if (arg === '--settle') options.settleMs = Number(argv[++i]);
    else if (arg === '--listing') options.listing = String(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
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
    const attached = new WeakSet();
    const attachWorker = (target) => {
      if (!target || attached.has(target)) return;
      attached.add(target);
      target.on('console', (message) => {
        const text = message.text();
        allSwLines.push(text);
        if (text.startsWith(PREFIX)) swLines.push(text);
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
     * own. The aggregate card-drift line is a content-script line, so the
     * page console has to be watched too.
     */
    const pageLines = [];
    page.on('console', (message) => {
      const text = message.text();
      pageLines.push(text);
      if (text.startsWith(PREFIX)) swLines.push(text);
    });

    return { context, page, swLines, allSwLines, pageLines, attachWorker };
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
      const liveWorker = context.serviceWorkers()[0];
      const rows = liveWorker ? await readStoredRows(liveWorker) : [];
      const stored = rows.find((row) => row.asin === asin) ?? null;

      const mismatches = [];
      for (const field of report.fields ?? []) {
        const problem = verifyField(field, stored);
        if (problem) {
          mismatches.push({ field: field.field, status: field.status, problem });
        }
      }

      results.push({
        asin,
        url,
        landedUrl,
        title,
        gate,
        jobId: report.jobId,
        stage: report.stage,
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
      const { page, pageLines } = session;
      const gate = await openProductPage(page, options.listing);
      // A listing is only parsed when a collection runs, so ask the extension
      // to collect. The drift line is emitted by the content script at the end
      // of that parse, into the page console.
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('pphunt:command', {
            detail: {
              type: 'COLLECT_PRODUCTS',
              payload: { mode: 'manual', targetCount: 20 },
            },
          }),
        );
      });
      await page.waitForTimeout(options.settleMs);
      const driftLine = pageLines.find((line) => line.startsWith(`${PREFIX} drift `));
      results.push({
        listing: options.listing,
        gate,
        driftLine: driftLine ? driftLine.slice(0, 400) : null,
        driftLineSeen: Boolean(driftLine),
        pageConsoleSample: pageLines.filter((l) => l.startsWith(PREFIX)).slice(-4),
      });
    } finally {
      await session.context.close();
    }
  }

  const mismatched = results.filter((r) => (r.mismatches?.length ?? 0) > 0);
  const report = {
    tool: 'scripts/sad-359-diagnostics-measurement.mjs',
    generatedAt: new Date().toISOString(),
    prefix: PREFIX,
    results,
  };

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  /* ---------------------------------------------------------- console summary */
  console.log(`\nSAD-359 live measurement — ${options.asins.length} product(s)\n`);
  for (const result of results) {
    if (result.listing) {
      console.log(`listing ${result.listing}  gate=${result.gate}`);
      console.log(`  ${result.driftLine ?? '(no drift line captured)'}`);
      continue;
    }
    if (result.error) {
      console.log(`${result.asin}  ERROR: ${result.error}`);
      continue;
    }
    const c = result.counts ?? {};
    console.log(
      `${result.asin}  ${c.extracted ?? 0} extracted · ${c.missing ?? 0} missing · ` +
        `${c.parseFailed ?? 0} parse-failed · ${c.partial ?? 0} partial · ${c.unknown ?? 0} unknown` +
        `   (stored: ${result.storedProductPresent ? 'yes' : 'no'})`,
    );
    const flagged = result.fields.filter(
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


  if (mismatched.length > 0) {
    console.error(
      `\n${mismatched.length} product(s) disagreed with the stored row — the diagnostics do not match the extraction.`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = await main();
