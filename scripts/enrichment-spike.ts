/**
 * SAD-338 — measurement harness for PDP enrichment.
 *
 * This is a **spike tool**, not production code: nothing in `src/` imports it,
 * it is not bundled into the extension, and it never runs in CI. It exists so
 * the three request variants can be measured on a *residential* connection in
 * one command, with the numbers written down instead of guessed.
 *
 * Run it with:
 *
 *   npm run spike:enrichment -- --count 30
 *   npm run spike:enrichment -- --dry-run          # no network, prints the plan
 *
 * Why a Node script and not the extension itself: the sandbox that produced the
 * audit could only ever reach Amazon from a datacenter IP, where every PDP
 * answered with a ~3.7 KB bot interstitial. The measurement has to happen on a
 * normal connection, so the work is packaged as a tool the operator runs.
 *
 * Fidelity note — read before trusting absolute numbers:
 * the *classifier* is the production one (`looksLikeChallenge`, imported from
 * `src/engines/amazon/background/enrichment-fetch.ts`), so the outcome labels
 * mean exactly what they mean in the extension. The *transport* is not
 * identical: Node's fetch sends `undici` defaults, has no `sec-ch-ua`/`sec-fetch`
 * client hints, and is not a service worker. Variant C exists precisely because
 * that gap is one of the things being measured.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { looksLikeChallenge } from '../src/engines/amazon/background/enrichment-fetch';

/* ------------------------------------------------------------------ types */

type VariantId = 'current' | 'referer' | 'ua';

type Outcome =
  | 'ok'
  | 'challenge'
  | 'asin_mismatch'
  | 'rate_limited'
  | 'http_4xx'
  | 'http_5xx'
  | 'timeout'
  | 'network_error';

interface Variant {
  id: VariantId;
  label: string;
  /** Human-readable "what differs from today". Shown in --dry-run and the doc. */
  differs: string;
  headers: (context: { referer: string; userAgent: string }) => Record<string, string>;
}

interface Sample {
  variant: VariantId;
  asin: string;
  url: string;
  outcome: Outcome;
  status: number | null;
  bytes: number;
  ms: number;
  challenge: boolean;
  asinPresent: boolean;
}

interface VariantSummary {
  variant: VariantId;
  n: number;
  ok: number;
  challenge: number;
  asin_mismatch: number;
  rate_limited: number;
  http_4xx: number;
  http_5xx: number;
  timeout: number;
  network_error: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/* -------------------------------------------------------------- constants */

/** A current desktop Chrome on Windows. Variant C sends exactly this. */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';

/** The production request, verbatim from enrichment-fetch.ts (fetch call). */
const PRODUCTION_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
};

const VARIANTS: readonly Variant[] = [
  {
    id: 'current',
    label: 'A — current production request',
    differs: 'baseline: credentials omit, redirect follow, Accept only',
    headers: () => ({ ...PRODUCTION_HEADERS }),
  },
  {
    id: 'referer',
    label: 'B — current + Referer from the listing page',
    differs: 'adds Referer: <the search/listing page the ASIN came from>',
    headers: ({ referer }) => ({ ...PRODUCTION_HEADERS, Referer: referer }),
  },
  {
    id: 'ua',
    label: 'C — current + desktop Chrome User-Agent',
    differs: 'adds a real desktop Chrome UA instead of Node undici',
    headers: ({ userAgent }) => ({ ...PRODUCTION_HEADERS, 'User-Agent': userAgent }),
  },
];

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_DELAY_MS = 3_000;
const DEFAULT_COUNT = 30;
/** Stop a variant early rather than hammering a host that is blocking us. */
const DEFAULT_MAX_CONSECUTIVE_CHALLENGES = 5;

/* ---------------------------------------------------------------- options */

interface Options {
  marketplace: string;
  searchUrl: string;
  asins: string[];
  count: number;
  delayMs: number;
  variants: VariantId[];
  outDir: string;
  dryRun: boolean;
  maxConsecutiveChallenges: number;
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const withoutPrefix = token.slice(2);
    const equals = withoutPrefix.indexOf('=');

    if (equals >= 0) {
      flags.set(withoutPrefix.slice(0, equals), withoutPrefix.slice(equals + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.set(withoutPrefix, true);
    }
  }

  const marketplace = String(flags.get('marketplace') ?? 'amazon.com');
  const variantFlag = flags.get('variants');

  return {
    marketplace,
    searchUrl: String(
      flags.get('search') ?? `https://www.${marketplace}/s?k=usb+c+charger`,
    ),
    asins: String(flags.get('asins') ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
    count: Number(flags.get('count') ?? DEFAULT_COUNT),
    delayMs: Number(flags.get('delay') ?? DEFAULT_DELAY_MS),
    variants:
      typeof variantFlag === 'string'
        ? (variantFlag.split(',').map((v) => v.trim()) as VariantId[])
        : VARIANTS.map((variant) => variant.id),
    outDir: String(flags.get('out') ?? 'docs/plans/measurements'),
    dryRun: flags.has('dry-run'),
    maxConsecutiveChallenges: Number(
      flags.get('max-consecutive-challenges') ?? DEFAULT_MAX_CONSECUTIVE_CHALLENGES,
    ),
  };
}

/* ------------------------------------------------------------------ utils */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productUrl(marketplace: string, asin: string): string {
  return `https://www.${marketplace}/dp/${asin}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

function classify(input: {
  status: number | null;
  html: string;
  asin: string;
  timedOut: boolean;
}): { outcome: Outcome; challenge: boolean; asinPresent: boolean } {
  const asinPresent = input.html.toUpperCase().includes(input.asin);

  if (input.timedOut) {
    return { outcome: 'timeout', challenge: false, asinPresent };
  }
  if (input.status === null) {
    return { outcome: 'network_error', challenge: false, asinPresent };
  }

  // The production classifier, unchanged — same phrases, same truncation.
  const challenge = looksLikeChallenge(input.html);

  if (input.status === 429) {
    return { outcome: 'rate_limited', challenge, asinPresent };
  }
  if (input.status >= 500) {
    return { outcome: 'http_5xx', challenge, asinPresent };
  }
  if (input.status >= 400) {
    return { outcome: 'http_4xx', challenge, asinPresent };
  }
  if (challenge) {
    return { outcome: 'challenge', challenge, asinPresent };
  }
  if (!asinPresent) {
    return { outcome: 'asin_mismatch', challenge, asinPresent };
  }
  return { outcome: 'ok', challenge, asinPresent };
}

function summarize(variant: VariantId, samples: Sample[]): VariantSummary {
  const of = (outcome: Outcome): number =>
    samples.filter((sample) => sample.outcome === outcome).length;
  const timings = samples
    .filter((sample) => sample.outcome !== 'timeout')
    .map((sample) => sample.ms);

  return {
    variant,
    n: samples.length,
    ok: of('ok'),
    challenge: of('challenge'),
    asin_mismatch: of('asin_mismatch'),
    rate_limited: of('rate_limited'),
    http_4xx: of('http_4xx'),
    http_5xx: of('http_5xx'),
    timeout: of('timeout'),
    network_error: of('network_error'),
    medianMs: median(timings),
    p95Ms: p95(timings),
  };
}

/* ------------------------------------------------------------ harvesting */

/** One search page, so the sample is real ASINs rather than made-up ones. */
async function harvestAsins(options: Options): Promise<string[]> {
  if (options.asins.length > 0) return options.asins.slice(0, options.count);

  console.log(`Harvesting ASINs from ${options.searchUrl}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(options.searchUrl, {
      credentials: 'omit',
      redirect: 'follow',
      headers: { ...PRODUCTION_HEADERS },
      signal: controller.signal,
    });
    const html = await response.text();

    if (looksLikeChallenge(html)) {
      throw new Error(
        'the search page itself came back as a challenge page — this connection is already blocked, so no sample can be taken',
      );
    }

    const seen = new Set<string>();
    for (const match of html.matchAll(/\/dp\/([A-Z0-9]{10})/g)) {
      const asin = match[1];
      if (asin) seen.add(asin);
      if (seen.size >= options.count) break;
    }

    return [...seen];
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- measuring */

async function measureVariant(
  variant: Variant,
  asins: string[],
  options: Options,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  let consecutiveChallenges = 0;

  for (const asin of asins) {
    if (consecutiveChallenges >= options.maxConsecutiveChallenges) {
      console.warn(
        `  ${variant.id}: stopped after ${consecutiveChallenges} consecutive challenges (${asins.length - samples.length} left unmeasured)`,
      );
      break;
    }

    const url = productUrl(options.marketplace, asin);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let status: number | null = null;
    let html = '';
    let timedOut = false;

    try {
      const response = await fetch(url, {
        // Mirrors production: public PDP data, no cookies, no session.
        credentials: 'omit',
        redirect: 'follow',
        headers: variant.headers({ referer: options.searchUrl, userAgent: DESKTOP_UA }),
        signal: controller.signal,
      });
      status = response.status;
      html = await response.text();
    } catch (error) {
      timedOut = (error as { name?: string }).name === 'AbortError';
      if (!timedOut) {
        console.error(`  ${variant.id} ${asin}: ${String(error)}`);
      }
    } finally {
      clearTimeout(timer);
    }

    const ms = Date.now() - startedAt;
    const { outcome, challenge, asinPresent } = classify({
      status,
      html,
      asin,
      timedOut,
    });

    consecutiveChallenges = outcome === 'challenge' ? consecutiveChallenges + 1 : 0;
    samples.push({
      variant: variant.id,
      asin,
      url,
      outcome,
      status,
      bytes: Buffer.byteLength(html, 'utf8'),
      ms,
      challenge,
      asinPresent,
    });

    console.log(
      `  ${variant.id} ${asin}: ${outcome}${status === null ? '' : ` HTTP ${status}`} ${ms}ms ${Buffer.byteLength(html, 'utf8')}B`,
    );

    // Human-paced: this tool must not look like a scraper.
    await sleep(options.delayMs + Math.floor(Math.random() * 1_000));
  }

  return samples;
}

/* ------------------------------------------------------------- reporting */

function formatSummaryTable(summaries: VariantSummary[]): string {
  const header =
    '| Variant | n | ok | challenge | asin-mismatch | 429 | 4xx | 5xx | timeout | median | p95 |';
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = summaries.map(
    (summary) =>
      `| ${summary.variant} | ${summary.n} | ${summary.ok} | ${summary.challenge} | ${summary.asin_mismatch} | ${summary.rate_limited} | ${summary.http_4xx} | ${summary.http_5xx} | ${summary.timeout} | ${summary.medianMs ?? '—'} ms | ${summary.p95Ms ?? '—'} ms |`,
  );
  return [header, rule, ...rows].join('\n');
}

function formatMarkdown(
  options: Options,
  summaries: VariantSummary[],
  startedAt: string,
): string {
  return [
    '# SAD-338 — enrichment measurement run',
    '',
    `- Started: ${startedAt}`,
    `- Marketplace: \`${options.marketplace}\``,
    `- Sample source: \`${options.searchUrl}\``,
    `- Products per variant: ${options.count} (fewer if a variant was stopped early)`,
    `- Delay between requests: ${options.delayMs} ms + up to 1 s jitter`,
    `- Timeout per request: ${DEFAULT_TIMEOUT_MS} ms, no retries (a retry would hide the first answer)`,
    `- Request origin: this machine. **Record whether it is residential or datacenter.**`,
    '',
    '## Results',
    '',
    formatSummaryTable(summaries),
    '',
    '## What each variant sends',
    '',
    ...VARIANTS.map((variant) => `- **${variant.label}** — ${variant.differs}`),
    '',
    '## Reading the numbers',
    '',
    '`challenge` means `looksLikeChallenge()` (the production classifier) matched the body.',
    '`asin_mismatch` means HTTP 200, no challenge, but the expected ASIN was not in the HTML —',
    'a variant redirect or a different product, which is question 3 in SAD-338.',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = VARIANTS.filter((variant) => options.variants.includes(variant.id));

  if (selected.length === 0) {
    throw new Error(
      `No known variant selected. Known: ${VARIANTS.map((v) => v.id).join(', ')}`,
    );
  }

  if (options.dryRun) {
    console.log('SAD-338 spike — dry run (no network)\n');
    console.log(`marketplace : ${options.marketplace}`);
    console.log(`search page : ${options.searchUrl}`);
    console.log(`sample      : ${options.count} products per variant`);
    console.log(`delay       : ${options.delayMs} ms + jitter`);
    console.log(`output      : ${options.outDir}\n`);

    for (const variant of selected) {
      const headers = variant.headers({
        referer: options.searchUrl,
        userAgent: DESKTOP_UA,
      });
      console.log(`${variant.label}`);
      console.log(`  ${variant.differs}`);
      console.log(`  headers: ${JSON.stringify(headers)}`);
      console.log(
        `  request: GET ${productUrl(options.marketplace, '<ASIN>')} (credentials: omit, redirect: follow)`,
      );
    }

    console.log(
      '\nNothing was sent. Drop --dry-run to take the measurement.',
    );
    return;
  }

  const startedAt = new Date().toISOString();
  const asins = await harvestAsins(options);

  if (asins.length === 0) {
    throw new Error(
      'No ASINs found. Pass --asins B0XXXXXXXX,B0YYYYYYYY to skip harvesting.',
    );
  }

  console.log(`\n${asins.length} product(s) per variant:\n${asins.join(', ')}\n`);

  const samples: Sample[] = [];
  for (const variant of selected) {
    console.log(`Measuring ${variant.label}`);
    samples.push(...(await measureVariant(variant, asins, options)));
    // Breathe between variants so one variant does not poison the next.
    await sleep(options.delayMs * 2);
  }

  const summaries = selected.map((variant) =>
    summarize(
      variant.id,
      samples.filter((sample) => sample.variant === variant.id),
    ),
  );

  console.log(`\n${formatSummaryTable(summaries)}\n`);

  const markdown = formatMarkdown(options, summaries, startedAt);
  await mkdir(options.outDir, { recursive: true });

  const stamp = startedAt.replace(/[:.]/g, '-');
  const jsonPath = join(options.outDir, `SAD-338-${stamp}.json`);
  const mdPath = join(options.outDir, `SAD-338-${stamp}.md`);

  await writeFile(
    jsonPath,
    `${JSON.stringify({ options, startedAt, summaries, samples }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(mdPath, markdown, 'utf8');

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(
    '\nPaste the table into docs/plans/SAD-338-enrichment-spike.md and state the connection type.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
