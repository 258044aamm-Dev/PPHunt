import { OPENING_MODE_KEY, type OpeningMode } from '@/lib/ui/openingMode';
import { initThemeSync } from '@/lib/ui/theme';
import { openOverlayForTab } from '@/lib/overlay/openOverlay';

initThemeSync();

const sidebarButton = document.getElementById('sidepanel') as HTMLButtonElement;
const overlayButton = document.getElementById('overlay') as HTMLButtonElement;
const remember = document.getElementById('remember') as HTMLInputElement;
const errorNotice = document.getElementById('error') as HTMLParagraphElement;

let activeTab: { id: number; url?: string } | null = null;

function showError(message: string) {
  errorNotice.textContent = message;
  errorNotice.hidden = false;
}

function setBusy(busy: boolean) {
  sidebarButton.disabled = busy || !activeTab;
  overlayButton.disabled = busy || !activeTab;
}

async function choose(mode: OpeningMode) {
  if (!activeTab) return;
  setBusy(true);
  errorNotice.hidden = true;
  let pendingPreference: Promise<void> | undefined;
  try {
    if (mode === 'sidePanel') {
      // Dispatch the write before the popup potentially closes, but do not await
      // it before sidePanel.open: that API must run within this click gesture.
      pendingPreference = remember.checked
        ? browser.storage.local.set({ [OPENING_MODE_KEY]: mode })
        : browser.storage.local.remove(OPENING_MODE_KEY);
      const opening = browser.sidePanel.open({ tabId: activeTab.id });
      await Promise.all([opening, pendingPreference]);
    } else {
      await openOverlayForTab(activeTab.id, activeTab.url);
      if (remember.checked) await browser.storage.local.set({ [OPENING_MODE_KEY]: mode });
      else await browser.storage.local.remove(OPENING_MODE_KEY);
    }
    window.close();
  } catch (error) {
    if (mode === 'sidePanel' && pendingPreference && remember.checked) {
      // A failed opening must not silently leave a new direct-open preference.
      await pendingPreference.catch(() => {});
      await browser.storage.local.remove(OPENING_MODE_KEY).catch(() => {});
    }
    showError(error instanceof Error ? error.message : 'PPHunt could not open here.');
    setBusy(false);
  }
}

sidebarButton.addEventListener('click', () => { void choose('sidePanel'); });
overlayButton.addEventListener('click', () => { void choose('overlay'); });

browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.id) {
    showError('No active browser tab is available.');
    return;
  }
  activeTab = { id: tab.id, url: tab.url };
  setBusy(false);
}).catch(() => showError('Could not find the active browser tab.'));
