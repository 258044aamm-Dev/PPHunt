/**
 * This function is serialized by chrome.scripting.executeScript. Keep it
 * self-contained: imported variables are not available in the page context.
 * Supports mounting the isolated PPHunt overlay drawer on both Amazon and Temu
 * (and any standard HTTP/HTTPS host page).
 */
export function mountOverlayHost(overlayUrl: string, preferredWidth: number): boolean {
  const hostId = 'pphunt-extension-overlay-host';
  if (document.getElementById(hostId)) return true; // Open is idempotent.
  if (!document.documentElement) return false;

  const host = document.createElement('div');
  host.id = hostId;
  host.setAttribute('aria-label', 'PPHunt page overlay');
  host.style.setProperty('display', 'block', 'important');
  host.style.setProperty('box-sizing', 'border-box', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('right', '0', 'important');
  host.style.setProperty('top', '0', 'important');
  host.style.setProperty('height', '100vh', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('background', '#f0eee6', 'important');
  host.style.setProperty('pointer-events', 'auto', 'important');
  host.style.setProperty('isolation', 'isolate', 'important');

  const maxWidth = Math.max(220, Math.min(800, Math.floor(window.innerWidth * 0.8)));
  const minWidth = Math.min(300, maxWidth);
  const clamp = (value: number) => Math.max(minWidth, Math.min(maxWidth, value));
  let savedDrawerWidth = clamp(preferredWidth);
  host.style.setProperty('width', `${savedDrawerWidth}px`, 'important');

  // The host's shadow root isolates its resize handle and iframe from the page CSS.
  // The iframe runs at the extension origin, sharing IndexedDB with the side panel.
  const shadow = host.attachShadow({ mode: 'closed' });
  const iframe = document.createElement('iframe');
  iframe.title = 'PPHunt Page Overlay';
  iframe.src = overlayUrl;
  iframe.style.display = 'block';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.background = '#f0eee6';

  const resizeHandle = document.createElement('div');
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', 'Resize PPHunt overlay');
  resizeHandle.style.position = 'absolute';
  resizeHandle.style.left = '0';
  resizeHandle.style.top = '0';
  resizeHandle.style.height = '100%';
  resizeHandle.style.width = '7px';
  resizeHandle.style.cursor = 'col-resize';
  resizeHandle.style.zIndex = '1';

  let startX = 0;
  let startWidth = 0;
  let resizing = false;
  resizeHandle.addEventListener('pointerdown', (event) => {
    resizing = true;
    startX = event.clientX;
    startWidth = host.getBoundingClientRect().width;
    resizeHandle.setPointerCapture?.(event.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    const nextWidth = clamp(startWidth + startX - event.clientX);
    savedDrawerWidth = nextWidth;
    host.removeAttribute('data-fullwidth');
    host.style.setProperty('width', `${nextWidth}px`, 'important');
  });
  const stopResizing = () => {
    if (!resizing) return;
    resizing = false;
    const width = Math.round(host.getBoundingClientRect().width);
    savedDrawerWidth = width;
    void Promise.resolve((globalThis as any).chrome.storage.local.set({ pphuntOverlayWidth: width }))
      .catch(() => {});
  };
  resizeHandle.addEventListener('pointerup', stopResizing);
  resizeHandle.addEventListener('pointercancel', stopResizing);

  const extensionUrl = new URL(overlayUrl);
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== extensionOrigin) return;
    if (event.data?.type === 'PPHUNT_CLOSE_OVERLAY') {
      window.removeEventListener('message', onMessage);
      host.remove();
      return;
    }
    if (event.data?.type === 'PPHUNT_SET_OVERLAY_FULLWIDTH') {
      if (event.data.fullWidth) {
        const fullWidthPx = Math.max(
          minWidth,
          Math.min(1600, Math.floor(window.innerWidth * 0.95))
        );
        host.setAttribute('data-fullwidth', 'true');
        host.style.setProperty('width', `${fullWidthPx}px`, 'important');
      } else {
        host.removeAttribute('data-fullwidth');
        host.style.setProperty('width', `${clamp(savedDrawerWidth)}px`, 'important');
      }
    }
  };
  window.addEventListener('message', onMessage);
  shadow.append(iframe, resizeHandle);
  document.documentElement.append(host);
  return true;
}
