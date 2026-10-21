/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://www.temu.com/wireless-earbuds-g-601099769178067.html"}
 *
 * SAD-381 step 3 — the opt-in "expand product details" setting.
 *
 * The contract under test:
 *  - the setting defaults to off, so the page is never clicked unless the user
 *    asked for it (current behaviour stays byte-identical);
 *  - when it is on and the page is a PDP, the collapse control is clicked
 *    *before* the first parse, so the rows it reveals are extracted;
 *  - the setting is validated through the message schema, so an older content
 *    script that omits it keeps working.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEMU_SETTINGS } from '@/engines/temu/constants/defaults';
import { TemuSettingsSchema } from '@/engines/temu/schemas/settings';
import { TemuCollectProductsMessageSchema } from '@/engines/temu/schemas/messages';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

const PDP_HTML = `
  <div id="goodsDetail">
    <div data-id="module">
      <div>Highlights</div>
      <div>
        <div aria-label="Breathable lining"></div>
        <div id="hidden-rows"></div>
      </div>
    </div>
    <div role="button" aria-label="See all details">See all details</div>
  </div>
  <div id="rightContent">
    <h1 aria-label="Wireless Bluetooth Earbuds">Wireless Bluetooth Earbuds</h1>
    <div id="goods_price">
      <span data-type="price"><span class="srOnly">US$12.49</span></span>
    </div>
    <div data-id="module">
      <div>Description</div>
      <div role="button" aria-label="$Material: ABS"></div>
    </div>
  </div>
  <script>{"goods_id":"601099769178067"}</script>
`;

type ContentListener = (
  msg: unknown,
  sender?: unknown,
  sr?: (r?: unknown) => void
) => unknown;

let contentListeners: ContentListener[];
let sentMessages: Array<{ type: string; payload?: Record<string, any> }>;
let clicks: number;

function installPdp() {
  document.body.innerHTML = PDP_HTML;
  const control = document.querySelector('[aria-label="See all details"]');
  expect(control).not.toBeNull();
  control!.addEventListener('click', () => {
    clicks += 1;
    // A real expand replaces the collapsed block with the full list.
    document.getElementById('hidden-rows')!.innerHTML =
      '<div aria-label="Lining: Cotton"></div>';
  });
}

async function startContentScript() {
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: ContentListener) => contentListeners.push(fn),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn().mockImplementation((msg: never) => {
        sentMessages.push(msg as never);
        return Promise.resolve({ ok: true });
      }),
    },
  });
  vi.stubGlobal('defineContentScript', (cfg: unknown) => cfg);
  const { default: contentScript } = await import('@/entrypoints/temu.content');
  (contentScript as unknown as { main: () => void }).main();
  expect(contentListeners.length).toBeGreaterThan(0);
}

function collect(payload: Record<string, unknown>): unknown {
  return contentListeners[0]!(
    { type: 'TEMU_COLLECT_PRODUCTS', payload: { mode: 'manual', targetCount: 5, sessionId: SESSION_ID, ...payload } },
    {},
    vi.fn()
  );
}

function firstProduct(): Record<string, any> | undefined {
  const message = sentMessages.find((m) => m.type === 'TEMU_PRODUCTS_COLLECTED');
  return (message?.payload?.products as Array<Record<string, any>>)?.[0];
}

beforeEach(async () => {
  vi.resetModules();
  contentListeners = [];
  sentMessages = [];
  clicks = 0;
  installPdp();
  await startContentScript();
});

afterEach(() => {
  (
    window as unknown as { __PPHUNT_TEMU_CONTENT_CLEANUP__?: () => void }
  ).__PPHUNT_TEMU_CONTENT_CLEANUP__?.();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SAD-381 — expandProductDetails setting', () => {
  it('defaults to off in both the constant and the parsed schema', () => {
    expect(DEFAULT_TEMU_SETTINGS.expandProductDetails).toBe(false);
    expect(TemuSettingsSchema.parse({}).expandProductDetails).toBe(false);
    expect(
      TemuSettingsSchema.parse({ expandProductDetails: true })
        .expandProductDetails
    ).toBe(true);
  });

  it('accepts a collect message with and without the optional flag', () => {
    const base = { mode: 'manual', targetCount: 5, sessionId: SESSION_ID };
    expect(TemuCollectProductsMessageSchema.safeParse({
      type: 'TEMU_COLLECT_PRODUCTS',
      payload: base,
    }).success).toBe(true);
    expect(TemuCollectProductsMessageSchema.safeParse({
      type: 'TEMU_COLLECT_PRODUCTS',
      payload: { ...base, expandDetails: true },
    }).success).toBe(true);
    expect(TemuCollectProductsMessageSchema.safeParse({
      type: 'TEMU_COLLECT_PRODUCTS',
      payload: { ...base, expandDetails: 'yes' },
    }).success).toBe(false);
  });

  it('never clicks the page when the flag is absent', async () => {
    collect({});
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(clicks).toBe(0);
    expect(firstProduct()?.features).toEqual(['Breathable lining']);
    expect(firstProduct()?.description).toBe('Material: ABS');
  });

  it('clicks the collapse control before the first parse when enabled', async () => {
    collect({ expandDetails: true });
    expect(clicks).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(firstProduct()?.features).toEqual([
      'Breathable lining',
      'Lining: Cotton',
    ]);
  });

  it('sends nothing while the page is not a PDP, even with the flag on', async () => {
    // Same flag, same page — only the URL classifies the page.
    document.body.innerHTML = '<div class="js-search-goodsList"></div>';
    history.replaceState({}, '', '/search_result.html?search_key=earbuds');
    clicks = 0;

    collect({ expandDetails: true });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(clicks).toBe(0);
    expect(firstProduct()).toBeUndefined();
  });
});
