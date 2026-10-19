import { AMAZON_MATCH_PATTERNS } from '../constants/match-patterns';
import { isAmazonUrl } from '../utils/amazon-url';
import { dispatchToAmazonTab } from './handler';

/**
 * SAD-279 (plan 8.0 / D1): one top-level menu item, registered idempotently.
 *
 * Chrome does not tell an extension which element was right-clicked
 * (`contextMenus.OnClickData` has no node and no coordinates — Chromium issue
 * 39507), so the background only *asks the tab to save*. The content script
 * remembers the element under the pointer from its own `contextmenu` listener
 * and resolves the card there.
 */

export const SAVE_PRODUCT_MENU_ID = 'pphunt-save-product';
export const SAVE_PRODUCT_MENU_TITLE = 'Save Product Details';

export interface ContextMenuClickInfo {
  menuItemId: string | number;
  frameId?: number;
  pageUrl?: string;
}

export interface ContextMenuTab {
  id?: number;
  url?: string;
}

interface ContextMenusApi {
  create: (props: Record<string, unknown>) => unknown;
  remove?: (id: string) => unknown;
  onClicked?: {
    addListener: (
      listener: (info: ContextMenuClickInfo, tab: ContextMenuTab) => void,
    ) => void;
    removeListener?: (
      listener: (info: ContextMenuClickInfo, tab: ContextMenuTab) => void,
    ) => void;
  };
}

interface RuntimeLifecycleApi {
  onInstalled?: { addListener: (listener: () => void) => void };
  onStartup?: { addListener: (listener: () => void) => void };
}

function getContextMenus(): ContextMenusApi | undefined {
  return (browser as unknown as { contextMenus?: ContextMenusApi })
    .contextMenus;
}

/** The exact `create()` payload, exported so a test can pin it. */
export function buildSaveProductMenuProps(): Record<string, unknown> {
  return {
    id: SAVE_PRODUCT_MENU_ID,
    title: SAVE_PRODUCT_MENU_TITLE,
    // Any of these right-clicks inside a card must offer the item. `page`
    // covers whitespace and text, `image`/`link` cover the card's own picture
    // and title, which is what a user naturally aims at.
    contexts: ['page', 'image', 'link', 'selection'],
    documentUrlPatterns: [...AMAZON_MATCH_PATTERNS],
  };
}

let registrationInFlight: Promise<boolean> | null = null;

/**
 * Registers the item, replacing any previous registration with the same id.
 * Concurrent callers share one promise, so an install event firing twice cannot
 * create two items.
 */
export function registerSaveProductContextMenu(
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (registrationInFlight && !options.force) return registrationInFlight;

  registrationInFlight = (async () => {
    const contextMenus = getContextMenus();
    if (!contextMenus) return false;

    try {
      // Targeted remove: `removeAll()` would also delete menu items other
      // features add later.
      try {
        await Promise.resolve(contextMenus.remove?.(SAVE_PRODUCT_MENU_ID));
      } catch {
        // "Cannot find menu item" on first install - expected.
      }

      await Promise.resolve(contextMenus.create(buildSaveProductMenuProps()));
      return true;
    } catch {
      // Let the next call try again instead of caching a failure forever.
      registrationInFlight = null;
      return false;
    }
  })();

  return registrationInFlight;
}

/** Test seam: forget the cached registration promise. */
export function resetContextMenuRegistrationForTests(): void {
  registrationInFlight = null;
}

/**
 * Routes a click to the tab. Returns false (and dispatches nothing) for other
 * menu items, for a click without a tab, and for a non-Amazon page.
 */
export async function handleSaveProductContextMenuClick(
  info: ContextMenuClickInfo,
  tab: ContextMenuTab | undefined,
): Promise<boolean> {
  if (!info || info.menuItemId !== SAVE_PRODUCT_MENU_ID) return false;

  const tabId = tab?.id;
  if (typeof tabId !== 'number') return false;

  // `documentUrlPatterns` already scopes the menu, but a click can still arrive
  // after the tab navigated away.
  if (tab?.url && !isAmazonUrl(tab.url)) return false;

  // SAD-344: the content script is top-frame only, so a click inside an
  // `<iframe>` arrives with a non-zero `frameId` and nothing captured in the
  // frame that will answer. Pass that on so the top frame can explain the
  // situation rather than reporting a miss. `frameId` is 0 for the top frame
  // and absent on browsers that do not report it — both mean "not a subframe".
  const fromSubframe = typeof info.frameId === 'number' && info.frameId !== 0;

  return dispatchToAmazonTab(tabId, {
    type: 'SAVE_CONTEXT_PRODUCT',
    payload: {
      requestedAt: new Date().toISOString(),
      ...(fromSubframe ? { fromSubframe: true } : {}),
    },
  });
}

/**
 * Installs the lifecycle hooks and registers the item once. Returns a disposer
 * so a test (or a future teardown path) can unhook without touching globals.
 */
export function initSaveProductContextMenu(): () => void {
  const contextMenus = getContextMenus();
  if (!contextMenus) return () => {};

  const runtime = (browser as unknown as { runtime?: RuntimeLifecycleApi })
    .runtime;

  const onClicked = (info: ContextMenuClickInfo, tab: ContextMenuTab) => {
    void handleSaveProductContextMenuClick(info, tab);
  };
  contextMenus.onClicked?.addListener(onClicked);

  const onLifecycle = () => {
    void registerSaveProductContextMenu({ force: true });
  };
  runtime?.onInstalled?.addListener(onLifecycle);
  runtime?.onStartup?.addListener(onLifecycle);

  void registerSaveProductContextMenu();

  return () => {
    contextMenus.onClicked?.removeListener?.(onClicked);
  };
}
