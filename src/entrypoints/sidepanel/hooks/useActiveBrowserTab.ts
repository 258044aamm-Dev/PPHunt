import { useEffect } from 'react';
import { isAmazonUrl } from '@/lib/utils/amazon-url';
import { useCollectionStore } from '../store/collectionStore';

/** Keep the viewed page in sync while the side panel remains open. */
export function useActiveBrowserTab() {
  useEffect(() => {
    let disposed = false;
    let requestId = 0;
    let windowId: number | null = null;

    const refresh = async () => {
      const currentRequest = ++requestId;
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (disposed || currentRequest !== requestId) return;

        if (tab?.windowId != null) windowId = tab.windowId;
        useCollectionStore.getState().setActiveTab(
          tab?.id ?? null,
          tab?.url ?? null,
          isAmazonUrl(tab?.url ?? '')
        );
      } catch (error) {
        if (disposed || currentRequest !== requestId) return;
        console.warn('[PPHunt] Could not query active tab:', error);
        useCollectionStore.getState().setActiveTab(null, null, false);
      }
    };

    const onActivated = (info: { windowId: number }) => {
      if (windowId === null || info.windowId === windowId) void refresh();
    };
    const onUpdated = (
      tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: { active: boolean; windowId: number }
    ) => {
      if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
      if (windowId !== null && tab.windowId !== windowId) return;
      if (tabId === useCollectionStore.getState().activeTabId || tab.active) void refresh();
    };
    const onRemoved = (tabId: number) => {
      if (tabId === useCollectionStore.getState().activeTabId) void refresh();
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
