#!/usr/bin/env node
/**
 * SAD-386 Phase 0 — capture the live markup that decides which selectors may ship.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 * Amazon answers a datacenter/CI connection with HTTP 503 (measured in the
 * implementation sandbox: `curl https://www.amazon.com/s?k=laptop` -> 503,
 * 2,671 bytes; even a reader proxy returned Amazon's "Sorry! Something went
 * wrong" page). So the evidence has to be captured from a real, logged-out
 * *browser* on a residential connection, which is what this script drives.
 *
 * It is a spike tool: not bundled, not in CI — the same convention as
 * `scripts/sad-359-diagnostics-measurement.mjs`.
 *
 * WHAT IT DOES
 *  1. opens amazon.com first (a fresh session's first `/s` request 503s),
 *  2. visits a deal-filtered search page, a `/deals` page and N product pages,
 *  3. for every page prints whether each candidate container exists and what it
 *     says, then writes the trimmed `outerHTML` of the interesting region to
 *     `docs/plans/sad-386-evidence/`.
 *
 * HOW TO RUN
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/sad-386-capture.mjs                 # US storefront, defaults
 *   BASE=https://www.amazon.co.uk node scripts/sad-386-capture.mjs
 *
 * REVIEWING THE OUTPUT (this is the gate for selector work)
 *  - If NO captured card/page renders a deal badge, no selector may be added for
 *    it; the ticket keeps the markup-agnostic behaviour and reports honestly.
 *  - If a badge is rendered, note the container Amazon used in the run report;
 *    that container (and only that one) may be appended to the registry.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://www.amazon.com';
const OUT_DIR = join(process.cwd(), 'docs', 'plans', 'sad-386-evidence');
const DEAL_FILTER = process.env.DEAL_FILTER ?? 'p_n_deal_type:23566064011';
const PDP_COUNT = Number(process.env.PDP_COUNT ?? 6);

const CANDIDATES = [
  '[data-a-badge-type="deal"]',
  '[data-a-badge-type="deal"] .a-badge-text',
  '[data-component-type="s-status-badge-component"] .a-badge-text',
  '[data-deal-badge-automated="true"]',
  '[id*="dealBadge" i]',
  '[class*="dealBadge" i]',
  '[class*="s-background-color-platinum" i]',
  '#dealBadge_feature_div',
  '#promoPriceBlockMessage_feature_div',
  '.savingsPercentage',
  '[class*="saving" i]',
  '[class*="discount" i]',
  '[data-cy="price-recipe"]',
  '#corePriceDisplay_desktop_feature_div',
  '#apex_desktop',
];

const DEAL_WORDS = /deal|limited time|lightning|prime day|black friday|cyber monday|angebot|offre|oferta/i;

function survey() {
  const short = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const found = {};
  for (const selector of CANDIDATES) {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(selector)).slice(0, 4);
    } catch {
      els = [];
    }
    if (els.length) {
      found[selector] = els.map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.className?.toString().slice(0, 80), text: short(el) }));
    }
  }
  // Every short node whose text looks like a deal label, with its ancestry.
  const labels = [];
  for (const el of document.querySelectorAll('span, div, p, b, strong')) {
    if (el.children.length > 2) continue;
    const text = short(el);
    if (!text || text.length > 60 || !DEAL_WORDS.test(text)) continue;
    const path = [];
    let cursor = el;
    for (let i = 0; i < 4 && cursor; i += 1) {
      path.push(`${cursor.tagName?.toLowerCase()}${cursor.id ? `#${cursor.id}` : ''}${cursor.className ? `.${String(cursor.className).trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`);
      cursor = cursor.parentElement;
    }
    labels.push({ text, path: path.join(' < ') });
  }
  return { found, labels: labels.slice(0, 20) };
}

function trim(html) {
  return html
    .replace(/\s(data-csa-c-[a-z-]+|data-cel-widget|cel_widget_id|data-a-modal|data-csa-op-log-render)="[^"]*"/g, '')
    .replace(/\n\s*\n+/g, '\n');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const report = [];

  const settle = async () => {
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1000);
  };

  const visit = async (url, label, regionSelector) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle();
    const title = await page.title();
    if (/robot check|sorry! something went wrong/i.test(title)) {
      report.push({ label, url, blocked: true, title });
      console.log(`[capture] ${label}: BLOCKED (${title})`);
      return null;
    }
    const data = await page.evaluate(survey);
    const html = await page.evaluate((selector) => {
      const el = selector ? document.querySelector(selector) : document.body;
      return el ? el.outerHTML.slice(0, 400_000) : '';
    }, regionSelector);
    writeFileSync(join(OUT_DIR, `${label}.html`), trim(html), 'utf8');
    const cards = await page.evaluate(
      () => document.querySelectorAll('[data-component-type="s-search-result"], [data-testid="product-card"]').length,
    );
    report.push({ label, url, title, cards, ...data });
    console.log(`[capture] ${label}: ${cards} cards, ${data.labels.length} deal-like labels`);
    return data;
  };

  // 1. warm-up (a fresh session 503s on the first /s request)
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  // 2. deal-filtered search
  await visit(`${BASE}/s?k=laptop&rh=${encodeURIComponent(DEAL_FILTER)}`, 'search-deals', '.s-main-slot');

  // 3. deals grid
  await visit(`${BASE}/deals`, 'deals-grid', '[data-testid="product-card"], .ProductCard-module__card_uyr_Jh7WpSkPx4iEpn4w');

  // 4. product pages from the search results
  const asins = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('[data-asin]')) {
      const asin = card.getAttribute('data-asin');
      if (asin && /^[A-Z0-9]{10}$/.test(asin) && !out.includes(asin)) out.push(asin);
      if (out.length >= 8) break;
    }
    return out;
  });
  for (const asin of asins.slice(0, PDP_COUNT)) {
    await visit(`${BASE}/dp/${asin}`, `pdp-${asin}`, '#centerCol');
  }

  writeFileSync(
    join(OUT_DIR, `capture-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), report }, null, 2),
    'utf8',
  );
  const badges = report.reduce((sum, entry) => sum + (entry.labels?.length ?? 0), 0);
  console.log(`[capture] done: ${report.length} pages, ${badges} deal-like labels. Evidence in ${OUT_DIR}`);
  console.log(
    badges > 0
      ? '[capture] A deal label was captured — record its container path from the JSON before adding a selector.'
      : '[capture] NO deal label was captured — do not add a deal selector; keep the markup-agnostic behaviour.',
  );
  await browser.close();
}

main().catch((error) => {
  console.error('[capture] failed:', error);
  process.exit(1);
});
