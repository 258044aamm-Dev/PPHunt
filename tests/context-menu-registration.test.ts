/**
 * SAD-279 (P1.2) - the menu item is registered exactly once, scoped to the
 * Amazon match patterns, and a click becomes one SAVE_CONTEXT_PRODUCT message
 * to the tab (never DOM work in the background).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchToAmazonTab = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock('@/engines/amazon/background/handler', () => ({
  dispatchToAmazonTab: (...args: unknown[]) => dispatchToAmazonTab(...args),
}));

import {
  buildSaveProductMenuProps,
  handleSaveProductContextMenuClick,
  initSaveProductContextMenu,
  registerSaveProductContextMenu,
  resetContextMenuRegistrationForTests,
  SAVE_PRODUCT_MENU_ID,
  SAVE_PRODUCT_MENU_TITLE,
} from '@/engines/amazon/background/context-menu';
import { AMAZON_MATCH_PATTERNS } from '@/engines/amazon/constants/match-patterns';

type Listener = (info: unknown, tab: unknown) => void;

function createFakeBrowser() {
  const create = vi.fn();
  const remove = vi.fn().mockResolvedValue(undefined);
  const onClickedListeners: Listener[] = [];
  const installedListeners: (() => void)[] = [];
  const startupListeners: (() => void)[] = [];

  const fake = {
    contextMenus: {
      create,
      remove,
      onClicked: {
        addListener: (listener: Listener) => onClickedListeners.push(listener),
        removeListener: (listener: Listener) => {
          const index = onClickedListeners.indexOf(listener);
          if (index >= 0) onClickedListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      onInstalled: { addListener: (listener: () => void) => installedListeners.push(listener) },
      onStartup: { addListener: (listener: () => void) => startupListeners.push(listener) },
    },
  };

  return { fake, create, remove, onClickedListeners, installedListeners, startupListeners };
}

beforeEach(() => {
  resetContextMenuRegistrationForTests();
  dispatchToAmazonTab.mockReset();
  dispatchToAmazonTab.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildSaveProductMenuProps', () => {
  it('is a top-level item with the exact requested label', () => {
    const props = buildSaveProductMenuProps();

    expect(props.id).toBe(SAVE_PRODUCT_MENU_ID);
    expect(props.title).toBe('Save Product Details');
    expect(props.contexts).toEqual(['page', 'image', 'link', 'selection']);
    expect(props.parentId).toBeUndefined();
  });

  it('is scoped to exactly the Amazon match patterns', () => {
    const props = buildSaveProductMenuProps() as { documentUrlPatterns: string[] };

    expect(props.documentUrlPatterns).toEqual([...AMAZON_MATCH_PATTERNS]);
    expect(props.documentUrlPatterns).toContain('*://*.amazon.co.za/*');
  });
});

describe('registerSaveProductContextMenu', () => {
  it('replaces any previous item with the same id, then creates it', async () => {
    const { fake, create, remove } = createFakeBrowser();
    vi.stubGlobal('browser', fake);

    await expect(registerSaveProductContextMenu()).resolves.toBe(true);

    expect(remove).toHaveBeenCalledWith(SAVE_PRODUCT_MENU_ID);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(buildSaveProductMenuProps());
  });

  it('creates only once for concurrent callers', async () => {
    const { fake, create } = createFakeBrowser();
    vi.stubGlobal('browser', fake);

    const [first, second] = await Promise.all([
      registerSaveProductContextMenu(),
      registerSaveProductContextMenu(),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('re-registers when forced (install/update)', async () => {
    const { fake, create } = createFakeBrowser();
    vi.stubGlobal('browser', fake);

    await registerSaveProductContextMenu();
    await registerSaveProductContextMenu({ force: true });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('tolerates a missing item on first install', async () => {
    const { fake, create, remove } = createFakeBrowser();
    remove.mockRejectedValueOnce(new Error('Cannot find menu item with id'));
    vi.stubGlobal('browser', fake);

    await expect(registerSaveProductContextMenu()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports failure and retries instead of caching it', async () => {
    const { fake, create } = createFakeBrowser();
    create.mockRejectedValueOnce(new Error('duplicate id')).mockResolvedValueOnce(undefined);
    vi.stubGlobal('browser', fake);

    await expect(registerSaveProductContextMenu()).resolves.toBe(false);
    await expect(registerSaveProductContextMenu()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('is inert when the API is unavailable', async () => {
    vi.stubGlobal('browser', {});
    await expect(registerSaveProductContextMenu()).resolves.toBe(false);
  });
});

describe('handleSaveProductContextMenuClick', () => {
  it('sends exactly one SAVE_CONTEXT_PRODUCT to the clicked tab', async () => {
    vi.stubGlobal('browser', {});

    const handled = await handleSaveProductContextMenuClick(
      { menuItemId: SAVE_PRODUCT_MENU_ID },
      { id: 7, url: 'https://www.amazon.com/s?k=charger' },
    );

    expect(handled).toBe(true);
    expect(dispatchToAmazonTab).toHaveBeenCalledTimes(1);
    const [tabId, message] = dispatchToAmazonTab.mock.calls[0] as [
      number,
      { type: string; payload: { requestedAt: string } },
    ];
    expect(tabId).toBe(7);
    expect(message.type).toBe('SAVE_CONTEXT_PRODUCT');
    expect(Date.parse(message.payload.requestedAt)).not.toBeNaN();
  });

  it('does not flag a top-frame click as a sub-frame click (SAD-344)', async () => {
    vi.stubGlobal('browser', {});

    await handleSaveProductContextMenuClick(
      { menuItemId: SAVE_PRODUCT_MENU_ID, frameId: 0 },
      { id: 7, url: 'https://www.amazon.com/s?k=charger' },
    );

    const [, message] = dispatchToAmazonTab.mock.calls[0] as [
      number,
      { payload: Record<string, unknown> },
    ];
    expect(message.payload).not.toHaveProperty('fromSubframe');
  });

  it('flags a click that happened inside an iframe (SAD-344)', async () => {
    vi.stubGlobal('browser', {});

    await handleSaveProductContextMenuClick(
      { menuItemId: SAVE_PRODUCT_MENU_ID, frameId: 3 },
      { id: 7, url: 'https://www.amazon.com/s?k=charger' },
    );

    const [, message] = dispatchToAmazonTab.mock.calls[0] as [
      number,
      { type: string; payload: { fromSubframe?: boolean } },
    ];
    expect(message.type).toBe('SAVE_CONTEXT_PRODUCT');
    expect(message.payload.fromSubframe).toBe(true);
  });

  it('treats a browser that reports no frameId as the top frame (SAD-344)', async () => {
    vi.stubGlobal('browser', {});

    await handleSaveProductContextMenuClick(
      { menuItemId: SAVE_PRODUCT_MENU_ID },
      { id: 7, url: 'https://www.amazon.com/s?k=charger' },
    );

    const [, message] = dispatchToAmazonTab.mock.calls[0] as [
      number,
      { payload: Record<string, unknown> },
    ];
    expect(message.payload).not.toHaveProperty('fromSubframe');
  });

  it('ignores other menu items', async () => {
    vi.stubGlobal('browser', {});

    await expect(
      handleSaveProductContextMenuClick(
        { menuItemId: 'some-other-item' },
        { id: 7, url: 'https://www.amazon.com/' },
      ),
    ).resolves.toBe(false);
    expect(dispatchToAmazonTab).not.toHaveBeenCalled();
  });

  it('ignores a click without a tab id', async () => {
    vi.stubGlobal('browser', {});

    await expect(
      handleSaveProductContextMenuClick({ menuItemId: SAVE_PRODUCT_MENU_ID }, {}),
    ).resolves.toBe(false);
    expect(dispatchToAmazonTab).not.toHaveBeenCalled();
  });

  it('ignores a tab that navigated away from Amazon', async () => {
    vi.stubGlobal('browser', {});

    await expect(
      handleSaveProductContextMenuClick(
        { menuItemId: SAVE_PRODUCT_MENU_ID },
        { id: 7, url: 'https://example.com/' },
      ),
    ).resolves.toBe(false);
    expect(dispatchToAmazonTab).not.toHaveBeenCalled();
  });

  it('reports the dispatch result', async () => {
    vi.stubGlobal('browser', {});
    dispatchToAmazonTab.mockResolvedValueOnce(false);

    await expect(
      handleSaveProductContextMenuClick(
        { menuItemId: SAVE_PRODUCT_MENU_ID },
        { id: 9, url: 'https://www.amazon.de/s?k=x' },
      ),
    ).resolves.toBe(false);
  });
});

describe('initSaveProductContextMenu', () => {
  it('registers eagerly, listens to clicks and re-registers on install/startup', async () => {
    const { fake, create, onClickedListeners, installedListeners, startupListeners } =
      createFakeBrowser();
    vi.stubGlobal('browser', fake);

    const dispose = initSaveProductContextMenu();

    expect(onClickedListeners).toHaveLength(1);
    expect(installedListeners).toHaveLength(1);
    expect(startupListeners).toHaveLength(1);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    installedListeners[0]?.();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    startupListeners[0]?.();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));

    dispose();
    expect(onClickedListeners).toHaveLength(0);
  });

  it('routes a listener call through the same click handler', async () => {
    const { fake, onClickedListeners } = createFakeBrowser();
    vi.stubGlobal('browser', fake);

    initSaveProductContextMenu();
    onClickedListeners[0]?.(
      { menuItemId: SAVE_PRODUCT_MENU_ID },
      { id: 3, url: 'https://www.amazon.co.za/s?k=x' },
    );

    await vi.waitFor(() => expect(dispatchToAmazonTab).toHaveBeenCalledTimes(1));
  });

  it('is inert when the API is unavailable', () => {
    vi.stubGlobal('browser', {});
    expect(() => initSaveProductContextMenu()()).not.toThrow();
  });
});
