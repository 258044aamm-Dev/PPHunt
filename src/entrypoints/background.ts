import { initSaveProductContextMenu } from '@/engines/amazon/background/context-menu';
import { createAmazonBackgroundController } from '@/engines/amazon/background/handler';
import { saveJobStore } from '@/engines/amazon/background/job-store';
import { recoverAmazonSaveJobs } from '@/engines/amazon/background/save-job-recovery';
import { registerTemuBackgroundHandlers } from '@/engines/temu/background/handler';
import { openOverlayForTab } from '@/lib/overlay/openOverlay';
import {
  OPENING_MODE_KEY,
  readOpeningMode,
  type OpeningMode,
} from '@/lib/ui/openingMode';

export default defineBackground(() => {
  const amazonController = createAmazonBackgroundController();
  const temuHandlers = registerTemuBackgroundHandlers();

  // SAD-279: the "Save Product Details" menu item. Registration is idempotent
  // and re-runs on install/startup so a changed title or match list is applied.
  initSaveProductContextMenu();

  // SAD-289: a worker suspended mid-save leaves its job in `storage.session`.
  // Every worker start rehydrates that mirror and resumes what is still inside
  // the TTL - at most once per job - so a card never spins forever. A failure
  // here is contained: it must never take the rest of the wiring down with it.
  const resumeInterruptedSaves = () => {
    void recoverAmazonSaveJobs().catch(() => {
      // Recovery is best-effort; the product rows are already committed.
    });
  };
  resumeInterruptedSaves();

  try {
    browser.runtime?.onStartup?.addListener?.(() => {
      resumeInterruptedSaves();
      // Browser start clears `storage.session`; the sweep also keeps the
      // in-memory table from growing across a long-lived worker.
      saveJobStore.sweep();
    });
  } catch {
    // Ignore startup listener registration error
  }

  let currentOpeningMode: OpeningMode | null = null;
  let modeChangedBeforeInitialRead = false;

  const applyToolbarMode = (mode: OpeningMode | null) => {
    currentOpeningMode = mode;
    const popup = mode === null ? 'popup.html' : '';
    try {
      void browser.action?.setPopup?.({ popup });
    } catch {
      // Ignore action API error
    }
  };

  try {
    void browser.sidePanel?.setPanelBehavior?.({
      openPanelOnActionClick: false,
    });
  } catch {
    // Ignore when sidePanel API is unavailable
  }

  try {
    void browser.storage?.local
      ?.get?.(OPENING_MODE_KEY)
      ?.then((saved: Record<string, unknown> | undefined) => {
        if (modeChangedBeforeInitialRead) return;
        const mode = readOpeningMode(saved?.[OPENING_MODE_KEY]);
        applyToolbarMode(mode);
      })
      ?.catch(() => {
        if (!modeChangedBeforeInitialRead) {
          applyToolbarMode(null);
        }
      });
  } catch {
    // Ignore storage read error
  }

  try {
    browser.storage?.onChanged?.addListener?.(
      (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        areaName?: string,
      ) => {
        if (areaName && areaName !== 'local') return;
        if (OPENING_MODE_KEY in changes) {
          modeChangedBeforeInitialRead = true;
          const nextMode = readOpeningMode(changes[OPENING_MODE_KEY]?.newValue);
          applyToolbarMode(nextMode);
        }
      },
    );
  } catch {
    // Ignore storage listener error
  }

  try {
    browser.action?.onClicked?.addListener?.(
      async (tab: { id?: number; url?: string }) => {
        const tabId = tab?.id;
        if (typeof tabId !== 'number') return;

        if (currentOpeningMode === 'sidePanel') {
          try {
            await browser.sidePanel?.open?.({ tabId });
          } catch {
            // Ignore sidePanel open failure
          }
          return;
        }

        if (currentOpeningMode === 'overlay') {
          try {
            await openOverlayForTab(tabId, tab.url);
          } catch {
            try {
              await browser.action?.setBadgeText?.({ text: '!' });
            } catch {
              // Ignore badge failure
            }
            try {
              await browser.sidePanel?.open?.({ tabId });
            } catch {
              // Ignore fallback failure
            }
          }
        }
      },
    );
  } catch {
    // Ignore action click registration error
  }

  // Single unified runtime.onMessage listener (required by tests/background-router-robustness.test.ts)
  browser.runtime.onMessage.addListener(
    (
      rawMessage: unknown,
      sender: unknown,
      sendResponse?: (response?: unknown) => void,
    ) => {
      if (temuHandlers.handleTemuMessage(rawMessage, sender, sendResponse)) {
        return false;
      }

      return amazonController.handleMessage(
        rawMessage,
        sender as { tab?: { id?: number; url?: string } } | undefined,
        sendResponse,
      );
    },
  );

  try {
    browser.tabs?.onUpdated?.addListener?.(
      (
        tabId: number,
        changeInfo: { status?: string; url?: string },
        tab?: { id?: number; url?: string },
      ) => {
        temuHandlers.onTemuTabUpdated(tabId, changeInfo);
        amazonController.handleTabUpdated(tabId, changeInfo, tab);
      },
    );
  } catch {
    // Ignore tabs.onUpdated registration error
  }

  try {
    browser.tabs?.onRemoved?.addListener?.((tabId: number) => {
      temuHandlers.onTemuTabRemoved(tabId);
      amazonController.handleTabRemoved(tabId);
    });
  } catch {
    // Ignore tabs.onRemoved registration error
  }

  try {
    browser.tabs?.onActivated?.addListener?.(
      (activeInfo: { tabId: number }) => {
        amazonController.handleTabActivated(activeInfo);
      },
    );
  } catch {
    // Ignore tabs.onActivated registration error
  }
});
