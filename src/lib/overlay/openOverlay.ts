import { mountOverlayHost } from './overlayHost';
import { isAmazonUrl } from '@/lib/utils/amazon-url';
import { isTemuUrl } from '@/engines/temu/utils/temu-url';

/**
 * Resolves the target marketplace engine ('amazon' | 'temu') from a tab URL,
 * or returns null for non-marketplace pages.
 */
export function detectOverlayEngine(url: string | undefined): 'amazon' | 'temu' | null {
  if (!url) return null;
  if (isTemuUrl(url)) return 'temu';
  if (isAmazonUrl(url)) return 'amazon';
  return null;
}

/** Only ordinary HTTP(S) pages can accept an injected page overlay. */
export function isOverlayAllowed(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const page = new URL(url);
    if (!['http:', 'https:'].includes(page.protocol)) return false;
    // Chrome also prohibits injection into its Web Store despite the HTTPS URL.
    if (page.hostname === 'chromewebstore.google.com') return false;
    if (page.hostname === 'chrome.google.com' && page.pathname.startsWith('/webstore')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function openOverlayForTab(tabId: number, url: string | undefined): Promise<void> {
  if (!isOverlayAllowed(url)) {
    throw new Error('Page Overlay is unavailable here. Open in Sidebar instead.');
  }

  const saved = await browser.storage.local.get('pphuntOverlayWidth');
  const requested = saved.pphuntOverlayWidth;
  const width = typeof requested === 'number' && Number.isFinite(requested) ? requested : 400;
  const result = await browser.scripting.executeScript({
    target: { tabId },
    func: mountOverlayHost,
    args: [browser.runtime.getURL('/overlay.html'), width],
  });
  if (!result?.some((entry) => entry.result === true)) {
    throw new Error('Page Overlay could not be created on this page.');
  }
}

/**
 * Notifies the host page overlay (if running inside the overlay iframe) to
 * expand to full width (95vw) for the structured table preview or restore its
 * normal drawer width when the preview closes.
 */
export function setOverlayFullWidthMode(fullWidth: boolean): void {
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      // M-4 (SAD-183): target the extension origin, never '*'. This code runs
      // inside the overlay iframe, whose src is the extension's own
      // overlay.html — so window.location.origin IS chrome-extension://<id>.
      // With '*' the arbitrary host page received the message and could
      // observe that PPHunt is installed and when the preview was toggled.
      window.parent.postMessage(
        { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth },
        window.location.origin
      );
    }
  } catch {
    // Ignore cross-frame messaging errors in restricted environments
  }
}
