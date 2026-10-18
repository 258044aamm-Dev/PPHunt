import { useEffect } from 'react';
import { isAmazonUrl } from '../../utils/amazon-url';
import { useAmazonCollectionStore } from '../store/collectionStore';

function isExtensionPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return (
    /^(chrome|moz)-extension:\/\//i.test(url) && url.includes('/preview.html')
  );
}

/**
 * Re-queries the active browser tab on demand and updates the Amazon collection store.
 * Preserves an already-detected Amazon tab if the active tab is the extension's own `/preview.html` workspace.
 */
export async function refreshAmazonActiveTab(): Promise<void> {
  try {
    if (typeof browser === 'undefined' || !browser?.tabs?.query) return;
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return;
    const url = tab.url ?? '';
    if (
      isExtensionPreviewUrl(url) &&
      useAmazonCollectionStore.getState().isAmazonPage
    ) {
      return;
    }
    useAmazonCollectionStore
      .getState()
      .setActiveTab(tab.id ?? null, tab.url ?? null, isAmazonUrl(url));
  } catch {
    // Ignore in environments without full tabs API
  }
}

/**
 * Keeps the active browser tab state in sync for the Amazon engine while the side panel or overlay is open.
 */
export function useAmazonActiveTab(): void {
  useEffect(() => {
    let disposed = false;
    let requestId = 0;
    let windowId: number | null = null;

    const refresh = async () => {
      const currentRequest = ++requestId;
      try {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (disposed || currentRequest !== requestId) return;

        if (tab?.windowId != null) windowId = tab.windowId;
        if (
          isExtensionPreviewUrl(tab?.url) &&
          useAmazonCollectionStore.getState().isAmazonPage
        ) {
          return;
        }
        useAmazonCollectionStore
          .getState()
          .setActiveTab(
            tab?.id ?? null,
            tab?.url ?? null,
            isAmazonUrl(tab?.url ?? ''),
          );
      } catch (error) {
        if (disposed || currentRequest !== requestId) return;
        console.warn('[PPHunt] Could not query active tab:', error);
        useAmazonCollectionStore.getState().setActiveTab(null, null, false);
      }
    };

    const onActivated = (info: { windowId: number }) => {
      if (windowId === null || info.windowId === windowId) void refresh();
    };
    const onUpdated = (
      tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: { active: boolean; windowId: number },
    ) => {
      if (changeInfo.url === undefined && changeInfo.status !== 'complete') {
        return;
      }
      if (windowId !== null && tab.windowId !== windowId) return;
      if (
        tabId === useAmazonCollectionStore.getState().activeTabId ||
        tab.active
      ) {
        void refresh();
      }
    };
    const onRemoved = (tabId: number) => {
      if (tabId === useAmazonCollectionStore.getState().activeTabId) {
        void refresh();
      }
    };

    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    void refresh();

    return () => {
      disposed = true;
      requestId++;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
  }, []);
}

export { useAmazonActiveTab as useActiveBrowserTab };
