/**
 * Steps 2.1 + 2.3 (SAD-161, SAD-163) — message schema conformance.
 *
 * Proves mechanically that the wire schema matches what the app really sends.
 * This file is the R1 control: Step 2.4 (wiring validation into the routers)
 * must not proceed unless every test here passes.
 */
import { describe, expect, it } from 'vitest';
import {
  ProductsCollectedMessageSchema,
  ScrapedProductSchema,
} from '@/lib/schemas';
import { validateAndNormalizeScrapedProduct } from '@/lib/scraper/field-parsers';
import { parseSearchResults } from '@/lib/scraper/search-results';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A real, normalized product — the exact shape the content script sends. */
export function realScrapedProduct() {
  const doc = createDoc(`
    <div data-component-type="s-search-result" data-asin="b08n5wrwnw">
      <h2><a href="/Anker-Charger/dp/B08N5WRWNW"><span>Anker USB-C 65W Fast Wall Charger</span></a></h2>
      <div data-cy="price-recipe">
        <span class="a-price">
          <span class="a-price-symbol">€</span>
          <span class="a-price-whole">39,</span>
          <span class="a-price-fraction">99</span>
        </span>
      </div>
      <img class="s-image" src="https://m.media-amazon.com/images/I/anker._AC_UL320_.jpg" />
    </div>
  `);
  const raws = parseSearchResults(doc, 'https://www.amazon.de/s?k=charger');
  expect(raws).toHaveLength(1);
  const normalized = validateAndNormalizeScrapedProduct(
    raws[0]!,
    'https://www.amazon.de/s?k=charger'
  );
  expect(normalized).not.toBeNull();
  return normalized!;
}

describe('Step 2.1 — ScrapedProductSchema exists and accepts real scraper output', () => {
  it('PRODUCTS_COLLECTED with a SINGLE-ELEMENT products array validates (this threw a TypeError before SAD-161)', () => {
    const result = ProductsCollectedMessageSchema.safeParse({
      type: 'PRODUCTS_COLLECTED',
      payload: {
        products: [realScrapedProduct()],
        totalCount: 1,
        isNewBatch: true,
      },
    });
    // Before the fix this did not merely fail — z.array(undefined) threw
    // "Cannot read properties of undefined (reading '_zod')" at parse time.
    expect(result.success).toBe(true);
  });

  it('an empty products array still validates (unchanged behaviour)', () => {
    const result = ProductsCollectedMessageSchema.safeParse({
      type: 'PRODUCTS_COLLECTED',
      payload: { products: [], totalCount: 0, isNewBatch: false },
    });
    expect(result.success).toBe(true);
  });

  it('round-trip: validateAndNormalizeScrapedProduct output passes ScrapedProductSchema', () => {
    const result = ScrapedProductSchema.safeParse(realScrapedProduct());
    expect(result.success).toBe(true);
  });

  it('rejects structurally wrong products (missing asin, bad source)', () => {
    expect(
      ScrapedProductSchema.safeParse({ url: 'https://x', source: 'search' })
        .success
    ).toBe(false);
    expect(
      ScrapedProductSchema.safeParse({
        asin: 'B0X',
        url: 'https://x',
        source: 'bestsellers',
      }).success
    ).toBe(false);
  });
});

// --- Step 2.2 (SAD-162): L-1 bounds + L-5 enum ---
import { readFileSync } from 'node:fs';
import {
  CollectionStatusSchema,
  StartCollectionMessageSchema,
} from '@/lib/schemas';

describe('Step 2.2 — targetCount bounds match the UI (L-1)', () => {
  const startWith = (targetCount: unknown) =>
    StartCollectionMessageSchema.safeParse({
      type: 'START_COLLECTION',
      payload: { mode: 'manual', targetCount, tabId: 1 },
    }).success;

  it('accepts the UI limits 1 and 1000 (both were INVALID before SAD-162)', () => {
    expect(startWith(1)).toBe(true);
    expect(startWith(1000)).toBe(true);
  });

  it('rejects out-of-range values 0 and 1001', () => {
    expect(startWith(0)).toBe(false);
    expect(startWith(1001)).toBe(false);
  });

  it('the old probe values now behave per spec (positive integer, max 1000)', () => {
    expect(startWith(9)).toBe(true); // was INVALID under min(10)
    expect(startWith(10)).toBe(true);
    expect(startWith(500)).toBe(true);
    expect(startWith(501)).toBe(true); // was INVALID under max(500)
    expect(startWith(1.5)).toBe(false); // int required
  });

  it('guard: TARGET_MIN/TARGET_MAX are the only source of these bounds in src/ (anti-drift)', () => {
    const messages = readFileSync('src/lib/schemas/messages.ts', 'utf8');
    const settings = readFileSync('src/lib/schemas/settings.ts', 'utf8');
    // The stale hardcoded bounds must never come back...
    expect(messages).not.toContain('.min(10).max(500)');
    expect(settings).not.toContain('defaultTargetCount: z.number().int().min(1).max(1000)');
    // ...every targetCount bound line reads the constants instead.
    const boundLines = [...messages.split('\n'), ...settings.split('\n')].filter(
      (l) => /targetCount/i.test(l) && /min\(/.test(l)
    );
    expect(boundLines.length).toBeGreaterThanOrEqual(4); // 3 message sites + 1 settings site
    for (const line of boundLines) {
      expect(line).toContain('TARGET_MIN');
      expect(line).toContain('TARGET_MAX');
    }
  });
});

describe('Step 2.2 — CollectionStatusSchema includes every status the app writes (L-5)', () => {
  it('accepts all six statuses from types/session.ts', () => {
    for (const status of [
      'idle',
      'collecting',
      'paused',
      'completed',
      'error',
      'interrupted', // was INVALID before SAD-162
    ]) {
      expect(CollectionStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('still rejects unknown statuses', () => {
    expect(CollectionStatusSchema.safeParse('stopped').success).toBe(false);
  });
});

// --- Step 2.3 (SAD-163): the R1 control — every message the app sends validates ---
import { ExtensionMessageSchema } from '@/lib/schemas';

describe('Step 2.3 — conformance: every message the app sends validates', () => {
  const product = realScrapedProduct();

  // Payload shapes transcribed from the real call sites (plan §2.3 inventory):
  // CollectionControls.tsx / App.tsx / background.ts / amazon.content.ts.
  const VALID_MESSAGES: Array<Record<string, unknown>> = [
    // Side Panel -> Background
    {
      type: 'START_COLLECTION',
      payload: { mode: 'automatic', targetCount: 100, tabId: 1, sessionKey: 'session_123' },
    },
    {
      type: 'START_COLLECTION',
      payload: { mode: 'manual', targetCount: 1, tabId: 1 }, // sessionKey optional at call sites
    },
    {
      type: 'RELOAD_AND_RETRY_COLLECTION',
      payload: { mode: 'automatic', targetCount: 1000, tabId: 2, sessionKey: 'session_123' },
    },
    { type: 'PAUSE_COLLECTION', payload: { tabId: 1 } },
    { type: 'RESUME_COLLECTION', payload: { tabId: 1 } },
    { type: 'STOP_COLLECTION', payload: { tabId: 1 } },
    // Background -> Content Script
    { type: 'COLLECT_PRODUCTS', payload: { mode: 'automatic', targetCount: 250 } },
    { type: 'PAUSE_SCROLLING' }, // no payload key at all — the H-3 crash path
    { type: 'RESUME_SCROLLING' },
    { type: 'STOP_COLLECTION_CMD' },
    // Content Script -> Background
    {
      type: 'PRODUCTS_COLLECTED',
      payload: { products: [product], totalCount: 42, isNewBatch: true },
    },
    {
      type: 'PRODUCTS_COLLECTED',
      payload: { products: [], totalCount: 0, isNewBatch: false },
    },
    {
      type: 'COLLECTION_PROGRESS',
      payload: { collected: 12, target: 100, status: 'collecting' },
    },
    {
      type: 'CONTENT_ERROR',
      payload: { code: 'CAPTCHA', message: 'Robot check detected' },
    },
    {
      type: 'CONTENT_ERROR',
      payload: {
        code: 'SCRIPT_DISCONNECTED',
        message: 'orphaned',
        diagnostic: { detail: 'context invalidated' },
      },
    },
    // Background -> Side Panel
    {
      type: 'UPDATE_PROGRESS',
      payload: { collected: 5, target: 100, status: 'paused', error: null },
    },
    {
      type: 'UPDATE_PROGRESS',
      payload: {
        collected: 5,
        target: 100,
        status: 'interrupted', // L-5: written by background.ts + useSessionRecovery
        error: 'Worker restarted',
        sessionKey: 'session_123',
      },
    },
    {
      type: 'TAB_STATUS_CHANGED',
      payload: { tabId: 1, url: 'https://www.amazon.de/s?k=x', isAmazon: true, pageType: 'search' },
    },
    {
      type: 'TAB_STATUS_CHANGED',
      payload: { tabId: 2, url: 'https://example.com', isAmazon: false, pageType: null },
    },
  ];

  it.each(
    VALID_MESSAGES.map((m, i) => [`${String(m.type)} #${i}`, m] as const)
  )('accepts %s', (_label, message) => {
    const result = ExtensionMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
  });

  it('the three payload-less command types have no payload key and still validate (H-3 path)', () => {
    for (const type of ['PAUSE_SCROLLING', 'RESUME_SCROLLING', 'STOP_COLLECTION_CMD']) {
      const message = { type };
      expect('payload' in message).toBe(false);
      expect(ExtensionMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it('rejects unknown message types and junk', () => {
    expect(ExtensionMessageSchema.safeParse({ type: 'NOPE' }).success).toBe(false);
    expect(ExtensionMessageSchema.safeParse(null).success).toBe(false);
    expect(ExtensionMessageSchema.safeParse('string').success).toBe(false);
    expect(ExtensionMessageSchema.safeParse({}).success).toBe(false);
    expect(
      ExtensionMessageSchema.safeParse({ type: 'START_COLLECTION' }).success
    ).toBe(false); // missing payload rejected, not thrown
  });

  it('accepts every error code the src/ tree actually emits (superset check)', () => {
    // Verified inventory (plan §2.3): src/ uses exactly these 8 codes.
    const CODES_USED_IN_SRC = [
      'BLOCKED',
      'CAPTCHA',
      'NOT_AMAZON',
      'RATE_LIMITED',
      'SCRIPT_DISCONNECTED',
      'SIGN_IN',
      'TAB_CLOSED',
      'UNKNOWN',
    ] as const;
    for (const code of CODES_USED_IN_SRC) {
      expect(
        ExtensionMessageSchema.safeParse({
          type: 'CONTENT_ERROR',
          payload: { code, message: 'x' },
        }).success
      ).toBe(true);
    }
  });
});

// --- Step 3.4 (SAD-170): scroll settings ride along on COLLECT_PRODUCTS ---
describe('Step 3.4 — COLLECT_PRODUCTS carries scroll config + existingAsins', () => {
  it('accepts the full wired payload (scroll + existingAsins)', () => {
    const result = ExtensionMessageSchema.safeParse({
      type: 'COLLECT_PRODUCTS',
      payload: {
        mode: 'automatic',
        targetCount: 250,
        scroll: {
          scrollAmount: 1200,
          scrollInterval: 2000,
          waitAfterScroll: 3000,
          duplicateDetection: false,
        },
        existingAsins: ['B0ABC12345'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('back-compat: a payload with no scroll key still validates (older background)', () => {
    expect(
      ExtensionMessageSchema.safeParse({
        type: 'COLLECT_PRODUCTS',
        payload: { mode: 'manual', targetCount: 50 },
      }).success
    ).toBe(true);
  });

  it('rejects scroll values outside the SettingsOverlay slider ranges', () => {
    for (const bad of [
      { scrollAmount: 50, scrollInterval: 500, waitAfterScroll: 1500, duplicateDetection: true },
      { scrollAmount: 800, scrollInterval: 100, waitAfterScroll: 1500, duplicateDetection: true },
      { scrollAmount: 800, scrollInterval: 500, waitAfterScroll: 100, duplicateDetection: true },
      { scrollAmount: 800, scrollInterval: 500, waitAfterScroll: 1500, duplicateDetection: 'yes' },
    ]) {
      expect(
        ExtensionMessageSchema.safeParse({
          type: 'COLLECT_PRODUCTS',
          payload: { mode: 'manual', targetCount: 50, scroll: bad },
        }).success
      ).toBe(false);
    }
  });
});
