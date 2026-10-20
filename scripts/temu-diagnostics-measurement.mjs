#!/usr/bin/env node
/**
 * SAD-360 — live measurement harness for the Temu per-field diagnostics.
 *
 * This is a **spike tool**, not production code: nothing in `src/` imports it,
 * it is not bundled into the extension and it never runs in CI. It exists so
 * the Temu diagnostic report can be checked against *real* Temu pages with the
 * numbers written down instead of guessed — the same reason
 * `scripts/sad-359-diagnostics-measurement.mjs` exists for Amazon.
 *
 * Run it with:
 *
 *   npm run build
 *   npm run measure:diagnostics:temu -- --pdps 601099769178067
 *   npm run measure:diagnostics:temu -- --listing "https://www.temu.com/search_result.html?search_key=earbuds"
 *   npm run measure:diagnostics:temu -- --pdps 601099769178067 --out docs/plans/sad-360-measurement.json
 *
 * What it does, per PDP / listing:
 *   1. opens the real page in Chromium with the built extension loaded (the
 *      extension's own service worker is the log sink),
 *   2. asks the **content script** to start a manual collection — the same
 *      `TEMU_COLLECT_PRODUCTS` message the background sends when you press
 *      Collect, so no product is saved by any path the user does not use,
 *   3. captures every `[PPHunt][Temu][Diagnostics]` line from the worker,
 *   4. reads the rows the extension actually stored in `PPHuntTemuDB`, and
 *   5. checks each report against its stored row: every field reported
 *      EXTRACTED must be present in the row, and every MISSING / PARSE_FAILED /
 *      UNKNOWN field must be absent from it.
 *
 * A mismatch is a bug in the *diagnostics*, not a licence to change extraction.
 * The harness reports it and exits non-zero.
 *
 * Environment notes:
 *   - The MV3 service worker only registers in **headed** mode, so run it under
 *     a virtual display when there is no screen:
 *         xvfb-run -a --server-args="-screen 0 1600x1000x24" \
 *           npm run measure:diagnostics:temu -- --pdps 601099769178067
 *   - Manual mode is used on purpose: a listing is parsed exactly as it is
 *     rendered when the collection starts. Automatic scrolling would collect a
 *     variable number of cards and make the run unrepeatable.
 *   - A verification challenge is recorded, never defeated. The harness does
 *     not click captchas, and a datacenter IP is usually challenged, so the
 *     meaningful numbers come from a normal connection.
 */

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXTENSION_DIR = join(ROOT, 'dist', 'chrome-mv3');

export const PREFIX = '[PPHunt][Temu][Diagnostics]';
export const TEMU_DB_NAME = 'PPHuntTemuDB';

/* ------------------------------------------------------------------ args */

export function parseArgs(argv) {
  const options = {
    pdps: [],
    listing: null,
    out: join(ROOT, 'docs', 'plans', 'sad-360-measurement.json'),
    settleMs: 9000,
    targetCount: 20,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pdps') {
      options.pdps = String(argv[++i] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === '--listing') options.listing = String(argv[++i]);
    else if (arg === '--out') options.out = resolve(ROOT, String(argv[++i]));
    else if (arg === '--settle') options.settleMs = Number(argv[++i]);
    else if (arg === '--target') options.targetCount = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function usage() {
  console.log(
    [
      'Usage: npm run measure:diagnostics:temu -- [options]',
      '',
      '  --pdps <id,id>     Temu goodsIds (or full product URLs) to visit',
      '  --listing <url>    a search/category page to parse once, in manual mode',
      '  --out <path>       where to write the JSON report',
      '  --settle <ms>      how long to wait for the collection (default 9000)',
      '  --target <n>       collection target for a listing (default 20)',
      '',
      'At least one of --pdps / --listing is required.',
    ].join('\n'),
  );
}

/** Accepts a bare goodsId or any Temu product URL. */
export function pdpUrl(input) {
  if (/^https?:\/\//i.test(input)) return input;
  return `https://www.temu.com/goods.html?goods_id=${input}`;
}

/* ----------------------------------------------------------- verification */

/** Mirrors the emptiness rule the engine's own validator uses. */
export function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Fields whose absent form is a real stored value.
 *
 * `isSponsored` / `isPrime` are booleans: the engine reports MISSING when the
 * marker was not found (decision D6) and the stored row carries `false`, so
 * `false` counts as "absent" for them.
 */
const BOOLEAN_MARKER_FIELDS = new Set(['isSponsored', 'isPrime']);

/**
 * Checks one field's diagnostic against the row the extension stored.
 * Returns an explanation string when they disagree, or null when they agree.
 */
export function verifyField(field, stored) {
  const name = field.field;
  const value = stored ? stored[name] : undefined;
  const empty =
    isEmpty(value) ||
    (BOOLEAN_MARKER_FIELDS.has(name) && value === false);

  switch (field.status) {
    case 'EXTRACTED':
      // validated:false would mean the value was dropped after extraction.
      if (field.validated === false) {
        return empty
          ? null
          : 'reported EXTRACTED but validation dropped it, yet the row still has a value';
      }
      return empty
        ? 'reported EXTRACTED but the stored row has no value'
        : null;
    case 'PARTIAL':
      if (field.validated === false) {
        return empty
          ? null
          : 'reported PARTIAL (validation drop) but the stored row still has a value';
      }
      return empty
        ? 'reported PARTIAL (rescue) but the stored row has no value'
        : null;
    case 'MISSING':
    case 'PARSE_FAILED':
    case 'UNKNOWN':
      return empty
        ? null
        : `reported ${field.status} but the stored row still has a value`;
    default:
      return `unknown status: ${field.status}`;
  }
}

/** Verifies every field of every report against the stored rows. */
export function verifyReports(reports, storedRows) {
  const byGoodsId = new Map();
  for (const row of storedRows) byGoodsId.set(row.goodsId, row);

  return reports.map((report) => {
    const stored =
      report.goodsId === null ? null : (byGoodsId.get(report.goodsId) ?? null);
    const mismatches = [];
    for (const field of report.fields ?? []) {
      const problem = verifyField(field, stored);
      if (problem) {
        mismatches.push({
          field: field.field,
          status: field.status,
          problem,
        });
      }
    }
    return {
      goodsId: report.goodsId,
      stage: report.stage,
      counts: report.counts,
      storedProductPresent: stored !== null,
      mismatches,
    };
  });
}

/* -------------------------------------------------------------- playwright */

function loadPlaywright() {
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

/** Reads every stored Temu product row out of the extension's IndexedDB. */
const READ_ROWS = async (dbName) => {
  const open = indexedDB.open(dbName);
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
};

/* -------------------------------------------------------------------- main */

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  if (options.pdps.length === 0 && !options.listing) {
    usage();
    return 2;
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

  async function openSession() {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pphunt-sad360-'));
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

    // An idle MV3 worker is stopped and wakes as a *new* target, so the console
    // listener has to follow every incarnation.
    const diagnosticLines = [];
    const allSwLines = [];
    const attached = new WeakSet();
    const attachWorker = (target) => {
      if (!target || attached.has(target)) return;
      attached.add(target);
      target.on('console', (message) => {
        const text = message.text();
        allSwLines.push(text);
        if (text.startsWith(`${PREFIX} {`)) diagnosticLines.push(text);
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

    return { context, page, diagnosticLines, allSwLines, attachWorker };
  }

  /** Loads a Temu page and reports a challenge instead of defeating it. */
  async function openTemuPage(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    return page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      const hasCaptcha =
        Boolean(document.querySelector('#captcha, .verificationDialog_wrapper')) ||
        /drag the slider|verify you are a human|unusual traffic/i.test(text);
      if (hasCaptcha) return 'captcha';
      if (/access (temporarily )?restricted/i.test(text)) return 'restricted';
      return 'ok';
    });
  }

  /** Sends the same message the background sends when Collect is pressed. */
  async function startCollection(worker, pageUrl, targetCount) {
    const tabId = await worker.evaluate(async (needle) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => (candidate.url ?? '').includes(needle));
      return tab?.id ?? null;
    }, new URL(pageUrl).hostname);

    if (tabId === null) throw new Error('could not resolve the Temu tab id');

    await worker.evaluate(
      async ({ id, count }) => {
        await chrome.tabs.sendMessage(id, {
          type: 'TEMU_COLLECT_PRODUCTS',
          payload: {
            mode: 'manual',
            targetCount: count,
            duplicateDetection: true,
          },
        });
      },
      { id: tabId, count: targetCount }
    );
    return tabId;
  }

  const results = [];

  async function runOne({ label, url, targetCount }) {
    const session = await openSession();
    const { context, page, diagnosticLines, allSwLines } = session;
    try {
      const gate = await openTemuPage(page, url);
      const title = await page.title();
      const landedUrl = page.url();

      if (gate !== 'ok') {
        results.push({
          label,
          url,
          landedUrl,
          title,
          gate,
          error:
            gate === 'captcha'
              ? 'Temu served a verification challenge. The harness does not defeat it.'
              : 'Temu served an access restriction page.',
        });
        return;
      }

      const worker = context.serviceWorkers()[0];
      if (worker) {
        session.attachWorker(worker);
        await worker.evaluate(() => true).catch(() => {});
      }
      if (!worker) {
        results.push({ label, url, landedUrl, title, gate, error: 'no service worker' });
        return;
      }

      await startCollection(worker, url, targetCount);
      await page.waitForTimeout(options.settleMs);

      const liveWorker = context.serviceWorkers()[0] ?? worker;
      const rows = await liveWorker
        .evaluate(READ_ROWS, TEMU_DB_NAME)
        .catch(() => []);

      const reports = diagnosticLines.map((line) =>
        JSON.parse(line.slice(line.indexOf('{')))
      );
      const verified = verifyReports(reports, rows);

      results.push({
        label,
        url,
        landedUrl,
        title,
        gate,
        storedRows: rows.length,
        reports: verified,
        swLinesWhenEmpty: reports.length === 0 ? allSwLines.slice(-12) : undefined,
      });
    } finally {
      await context.close();
    }
  }

  for (const entry of options.pdps) {
    await runOne({ label: entry, url: pdpUrl(entry), targetCount: 1 });
  }
  if (options.listing) {
    await runOne({
      label: 'listing',
      url: options.listing,
      targetCount: options.targetCount,
    });
  }

  const mismatched = results.filter((result) =>
    (result.reports ?? []).some((entry) => entry.mismatches.length > 0)
  );

  const report = {
    tool: 'scripts/temu-diagnostics-measurement.mjs',
    generatedAt: new Date().toISOString(),
    prefix: PREFIX,
    results,
  };

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  /* --------------------------------------------------------- console summary */
  console.log('\nSAD-360 live measurement\n');
  for (const result of results) {
    if (result.error) {
      console.log(`${result.label}  ERROR: ${result.error}`);
      continue;
    }
    if (result.reports.length === 0) {
      console.log(`${result.label}  no diagnostics line captured`);
      continue;
    }
    for (const entry of result.reports) {
      const c = entry.counts ?? {};
      console.log(
        `${entry.goodsId ?? 'null-goodsId'}  ${entry.stage}  ` +
          `${c.extracted ?? 0} extracted · ${c.missing ?? 0} missing · ` +
          `${c.parseFailed ?? 0} parse-failed · ${c.partial ?? 0} partial · ` +
          `${c.unknown ?? 0} unknown   (stored: ${entry.storedProductPresent ? 'yes' : 'no'})`
      );
      for (const mismatch of entry.mismatches) {
        console.log(`    !! MISMATCH ${mismatch.field}: ${mismatch.problem}`);
      }
    }
  }
  console.log(`\nreport written to ${options.out}`);

  if (mismatched.length > 0) {
    console.error(
      `\n${mismatched.length} page(s) disagreed with the stored rows — the diagnostics do not match the extraction.`
    );
    return 1;
  }
  return 0;
}

/* Only run when executed directly, so the pure helpers stay importable. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
