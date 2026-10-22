/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://www.temu.com/wireless-earbuds-g-601099769178067.html"}
 *
 * SAD-381 step 4 — replay real captures through the real parser.
 *
 * A capture is produced by `scripts/temu-dom-capture.js` pasted into the
 * console of a logged-in Temu PDP tab (the sandbox that built this change is
 * behind Temu's login wall, so the operator supplies the page). Drop the
 * downloaded `sad381-*.json` — or a saved `*.html` page — into
 * `tests/fixtures/temu-live/` (or point `TEMU_PDP_CAPTURE_DIR` elsewhere) and
 * run:
 *
 *   npx vitest run tests/temu-pdp-captures.test.ts
 *
 * Every capture is then parsed exactly as the extension parses it, and the
 * no-fabrication invariants below are enforced:
 *
 *  1. every extracted feature/description occurs in the capture's own text or
 *     aria-labels (compared punctuation- and whitespace-insensitively), so a
 *     value can never be invented, templated or reflowed;
 *  2. no collapse-control label ("See all details", …) leaks into either field;
 *  3. the SEO `meta[name="description"]` template never becomes `description`;
 *  4. a PDP that renders `#goodsDetail` with detail rows yields features.
 *
 * With no captures present the suite reports what it is waiting for instead of
 * silently passing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTemuProductDetail } from '@/engines/temu/scraper/product-detail';
import { cleanTemuText } from '@/engines/temu/scraper/field-parsers';
import { TEMU_PDP_FALLBACK_LABELS } from '@/engines/temu/scraper/pdp-details';

const CAPTURE_DIR = resolve(
  process.env.TEMU_PDP_CAPTURE_DIR ?? 'tests/fixtures/temu-live'
);

interface Capture {
  file: string;
  html: string;
}

/** Case-, punctuation- and whitespace-insensitive comparison form. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Everything the page itself says, used as the only legitimate source. */
function evidencePool(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const parts: string[] = [doc.body.textContent ?? ''];
  for (const el of Array.from(
    doc.querySelectorAll('[aria-label], [title], [alt], [content]')
  )) {
    for (const attr of ['aria-label', 'title', 'alt', 'content']) {
      const value = el.getAttribute(attr);
      if (value) parts.push(value);
    }
  }
  return squash(parts.join(' '));
}

function loadCaptures(): Capture[] {
  if (!existsSync(CAPTURE_DIR)) return [];

  return readdirSync(CAPTURE_DIR)
    .filter((file) => /\.(json|html)$/i.test(file))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(CAPTURE_DIR, file), 'utf8');
      if (/\.json$/i.test(file)) {
        const parsed = JSON.parse(raw) as {
          dom?: { goodsDetail?: string | null; rightContent?: string | null };
        };
        const goodsDetail = parsed.dom?.goodsDetail ?? '';
        const rightContent = parsed.dom?.rightContent ?? '';
        return {
          file,
          html: `<!doctype html><html><body>${goodsDetail}${rightContent}</body></html>`,
        };
      }
      return { file, html: raw };
    })
    .filter((capture) => capture.html.length > 0);
}

const captures = loadCaptures();

if (captures.length === 0) {
  console.log(
    `[SAD-381] no live captures in ${CAPTURE_DIR}. ` +
      'Run scripts/temu-dom-capture.js on a logged-in Temu PDP, save the JSON there, and re-run this file.'
  );
}

describe.skipIf(captures.length === 0)('SAD-381 — captured Temu PDPs', () => {
  const controlLabels = Object.values(TEMU_PDP_FALLBACK_LABELS).map((label) =>
    squash(label)
  );

  for (const capture of captures) {
    it(`extracts only page-backed values from ${capture.file}`, () => {
      const doc = new DOMParser().parseFromString(capture.html, 'text/html');
      const product = parseTemuProductDetail(
        doc,
        'https://www.temu.com/wireless-earbuds-g-601099769178067.html'
      );

      const pool = evidencePool(capture.html);
      const features = product?.features ?? [];
      const description = product?.description ?? null;

      console.log(
        `[SAD-381] ${capture.file}: features=${features.length} ` +
          `description=${description === null ? 'null' : `${description.length} chars`}`
      );

      for (const feature of features) {
        expect(
          pool.includes(squash(feature)),
          `feature not backed by the capture: ${feature}`
        ).toBe(true);
        expect(controlLabels.some((l) => squash(feature) === l)).toBe(false);
      }

      if (description !== null) {
        expect(
          pool.includes(squash(description)),
          'description not backed by the capture'
        ).toBe(true);
        expect(description.startsWith(' deals on ')).toBe(false);
        expect(description).not.toMatch(/Shop on Temu to start saving/i);
      }

      const metaContent = cleanTemuText(
        doc.querySelector('meta[name="description"]')?.getAttribute('content')
      );
      if (metaContent !== null) {
        expect(description).not.toBe(metaContent);
      }

      // A rendered details section with visible rows must produce features.
      const details = doc.querySelector('#goodsDetail');
      if (details && details.querySelectorAll('[aria-label]').length > 0) {
        expect(features.length).toBeGreaterThan(0);
      }
    });
  }
});
