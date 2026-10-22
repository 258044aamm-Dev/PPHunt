import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardHtml } from './fixtures/amazon-sad-389/helpers';
import {
  AMAZON_COLLECTION_OBSERVER_OPTIONS,
  isRelevantAmazonCollectionMutation,
} from '@/engines/amazon/content/collection-mutations';

const hooks = vi.hoisted(() => ({ automaticBatch: undefined as (() => void) | undefined }));
vi.mock('@/engines/amazon/content/card-action-layer', () => ({
  createCardActionLayer: () => ({ start() {}, stop() {}, applyJobUpdate() { return true; } }),
}));
vi.mock('@/engines/amazon/content/card-action-theme', () => ({ syncCardActionTheme: () => () => {} }));
// Only the automatic scroll clock is substituted. Content lifecycle, parsers,
// cache, dedup, native MutationObserver and outgoing messages are real.
vi.mock('@/lib/scraper/scroll-controller', () => ({
  ScrollController: class {
    start(batch: () => void) { hooks.automaticBatch = batch; }
    stop() {} pause() {} resume() {}
  },
}));

type Message = { type: string; payload?: Record<string, any> };
let messages: Message[];
let listeners: Array<(m: Message, sender: unknown, response: () => void) => unknown>;
const batches = () => messages.filter(m => m.type === 'PRODUCTS_COLLECTED');
const dispatch = (m: Message) => listeners[0]!(m, {}, () => {});
const flush = async (ms = 350) => {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  hooks.automaticBatch = undefined;
  messages = [];
  listeners = [];
  vi.stubGlobal('defineContentScript', (cfg: unknown) => cfg);
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: { addListener: (f: (m: Message, sender: unknown, response: () => void) => unknown) => listeners.push(f), removeListener: vi.fn() },
      sendMessage: vi.fn(async (m: Message) => { messages.push(structuredClone(m)); return { ok: true }; }),
    },
    storage: {
      local: { get: vi.fn(async () => ({ pphuntDiagnosticsEnabled: true })), set: vi.fn(), remove: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

afterEach(() => {
  (window as unknown as { __PPHUNT_CONTENT_CLEANUP__?: () => void }).__PPHUNT_CONTENT_CLEANUP__?.();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start(mode: 'manual' | 'automatic' = 'manual') {
  const { default: script } = await import('@/entrypoints/amazon.content');
  (script as unknown as { main: () => void }).main();
  await flush(0);
  expect(listeners.length).toBeGreaterThan(0);
  dispatch({ type: 'COLLECT_PRODUCTS', payload: { mode, targetCount: 10 } });
  await flush(0);
  expect(batches()).toHaveLength(1);
  expect(batches()[0]!.payload!.totalCount).toBe(1);
}

describe('SAD-389: real content-script collection hydration', () => {
  it.each(['text', 'class', 'hidden', 'style'] as const)('manual %s mutation emits an updated row, not a duplicate', async mutation => {
    const initial = mutation === 'text'
      ? '<div id="offers"><p id="proof">Waiting for monthly data</p><span class="s-coupon-unclipped">Loading offer</span></div>'
      : `<div id="offers" ${mutation === 'class' ? 'class="aok-hidden"' : mutation === 'hidden' ? 'hidden' : 'style="display:none"'}><p id="proof">500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span></div>`;
    document.body.innerHTML = cardHtml(initial, true);
    await start();
    const first = batches()[0]!.payload!.products[0];
    expect(first.coupon).toBeUndefined();
    expect(first.pastMonthSales).toBeUndefined();

    if (mutation === 'text') {
      document.getElementById('proof')!.firstChild!.nodeValue = '500+ bought in past month';
      document.querySelector('.s-coupon-unclipped')!.firstChild!.nodeValue = 'Save $5 with coupon';
    } else {
      document.getElementById('offers')!.removeAttribute(mutation);
    }
    await flush();
    expect(batches()).toHaveLength(2);
    const update = batches()[1]!.payload!;
    expect(update.totalCount).toBe(1);
    expect(update.products).toEqual([{ ...first, pastMonthSales: '500+ bought in past month', coupon: 'Save $5 with coupon' }]);
    // Preserve the first-report-only policy: no new cap slots or re-logging.
    expect(batches()[0]!.payload!.extractionDiagnostics).toHaveLength(1);
    expect(update.extractionDiagnostics).toBeUndefined();
    await flush(2500);
    expect(batches()).toHaveLength(2);
  });

  it('automatic collection uses the same recovered targets at its next existing scroll batch', async () => {
    document.body.innerHTML = cardHtml('', true);
    await start('automatic');
    document.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', '<p>500+ bought in past month</p><span class="s-coupon-unclipped">Save $5 with coupon</span>');
    hooks.automaticBatch!();
    await flush(0);
    expect(batches()).toHaveLength(2);
    expect(batches()[1]!.payload!.products).toHaveLength(1);
    expect(batches()[1]!.payload!.products[0]).toMatchObject({ pastMonthSales: '500+ bought in past month', coupon: 'Save $5 with coupon' });
  });

  it('stopping cancels queued manual work and disconnects the observer', async () => {
    document.body.innerHTML = cardHtml('<p id="proof">Waiting for monthly data</p>', true);
    await start();
    document.getElementById('proof')!.firstChild!.nodeValue = '500+ bought in past month';
    await flush(50);
    dispatch({ type: 'STOP_COLLECTION_CMD' });
    await flush(2200);
    expect(batches()).toHaveLength(1);
    document.querySelector('[data-asin]')!.insertAdjacentHTML('beforeend', '<span class="s-coupon-unclipped">Save $5 with coupon</span>');
    await flush();
    expect(batches()).toHaveLength(1);
  });
});

describe('SAD-389: narrow native observer subscription', () => {
  it('ignores unrelated attributes/text and accepts signal text/visibility plus legacy node insertion', async () => {
    document.body.innerHTML = `<header id="outside">Header</header>${cardHtml('<p id="proof">500+ bought in past month</p><span id="shipping">Arrives tomorrow</span><span class="s-coupon-unclipped aok-hidden">Save $5 with coupon</span>', true)}`;
    const records: MutationRecord[] = [];
    const observer = new MutationObserver(ms => records.push(...ms));
    observer.observe(document.body, AMAZON_COLLECTION_OBSERVER_OPTIONS);
    const check = async (change: () => void, relevant: boolean) => {
      records.length = 0;
      change();
      await flush(0);
      expect(records.some(isRelevantAmazonCollectionMutation)).toBe(relevant);
    };
    const proof = document.getElementById('proof')!;
    await check(() => proof.classList.add('hover'), false);
    await check(() => proof.setAttribute('style', 'color:red'), false);
    await check(() => document.getElementById('outside')!.setAttribute('hidden', ''), false);
    await check(() => document.getElementById('shipping')!.firstChild!.nodeValue = 'Arrives next week', false);
    await check(() => proof.firstChild!.nodeValue = '1K+ bought in past month', true);
    await check(() => document.querySelector('.s-coupon-unclipped')!.classList.remove('aok-hidden'), true);
    await check(() => document.querySelector('[data-asin]')!.append(document.createElement('span')), true);
    observer.disconnect();
  });
});
