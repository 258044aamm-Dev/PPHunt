/**
 * SAD-281: the only visible feedback the one-click flow adds to an Amazon page.
 *
 * Deliberately tiny and dependency-free: one fixed-position element, inline
 * styles (no stylesheet to collide with Amazon's), `role="status"` so screen
 * readers announce it, and no listener that could swallow a page click.
 */

export const SAVE_TOAST_ID = 'pphunt-save-toast';
export const SAVE_TOAST_DEFAULT_MS = 4_000;

export type SaveToastState = 'queued' | 'completed' | 'failed';

export interface SaveToastAction {
  label: string;
  onClick: () => void;
}

export interface SaveToastInput {
  state: SaveToastState;
  message: string;
  autoHideMs?: number;
  doc?: Document;
  /**
   * SAD-336: a second, quieter line explaining what the save could not do —
   * today that is an enrichment warning ("the product page was not fetched").
   * Kept separate from `message` so the headline stays a clean "Saved to …" and
   * every existing assertion on the message element still holds.
   */
  detail?: string;
  /**
   * SAD-291: one optional action (the completion toast's "Download"). The toast
   * itself keeps `pointer-events: none` so it can never eat a page click; only
   * the button turns pointer events back on.
   */
  action?: SaveToastAction;
}

const COLORS: Record<SaveToastState, { background: string; border: string }> = {
  queued: { background: '#1f2937', border: '#374151' },
  completed: { background: '#14532d', border: '#166534' },
  failed: { background: '#7f1d1d', border: '#991b1b' },
};

let hideTimer: ReturnType<typeof setTimeout> | null = null;

function getOrCreateToast(doc: Document): HTMLElement {
  const existing = doc.getElementById(SAVE_TOAST_ID);
  if (existing) return existing;

  const toast = doc.createElement('div');
  toast.id = SAVE_TOAST_ID;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.style.position = 'fixed';
  toast.style.right = '16px';
  toast.style.bottom = '16px';
  toast.style.zIndex = '2147483647';
  toast.style.maxWidth = '320px';
  toast.style.padding = '10px 14px';
  toast.style.borderRadius = '8px';
  toast.style.borderWidth = '1px';
  toast.style.borderStyle = 'solid';
  toast.style.fontFamily = 'system-ui, -apple-system, Segoe UI, sans-serif';
  toast.style.fontSize = '13px';
  toast.style.lineHeight = '1.4';
  toast.style.color = '#f9fafb';
  toast.style.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.28)';
  toast.style.pointerEvents = 'none';

  (doc.body ?? doc.documentElement).appendChild(toast);
  return toast;
}

/** Shows (or replaces the content of) the single save toast. */
export function showSaveToast(input: SaveToastInput): void {
  const doc = input.doc ?? document;
  if (!doc?.body) return;

  const toast = getOrCreateToast(doc);
  const palette = COLORS[input.state];

  // Rebuilt every call: a queued toast has no action, so a stale button from a
  // previous message must not survive into the next one.
  toast.replaceChildren();
  const label = doc.createElement('span');
  label.dataset.pphuntToastMessage = 'true';
  label.textContent = input.message;
  toast.appendChild(label);

  // SAD-336: the reason lives on its own line. Inline styles only — the toast
  // must not depend on a stylesheet it cannot see, and must not inherit
  // anything from Amazon's page CSS.
  if (input.detail) {
    const detail = doc.createElement('span');
    detail.dataset.pphuntToastDetail = 'true';
    detail.textContent = input.detail;
    detail.style.display = 'block';
    detail.style.marginTop = '3px';
    detail.style.fontSize = '12px';
    detail.style.lineHeight = '1.35';
    detail.style.opacity = '0.85';
    toast.appendChild(detail);
  }

  if (input.action) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.pphuntToastAction = 'true';
    button.textContent = input.action.label;
    button.style.pointerEvents = 'auto';
    button.style.marginLeft = '10px';
    button.style.padding = '3px 8px';
    button.style.borderRadius = '6px';
    button.style.border = '1px solid rgba(255, 255, 255, 0.45)';
    button.style.background = 'rgba(255, 255, 255, 0.14)';
    button.style.color = '#f9fafb';
    button.style.font = 'inherit';
    button.style.cursor = 'pointer';
    button.addEventListener('click', (event) => {
      // A click inside the toast must never reach a product card underneath.
      event.preventDefault();
      event.stopPropagation();
      // One click, one download: the worker's `uniquify` would happily make a
      // second copy, so the button disables itself immediately.
      button.disabled = true;
      button.style.cursor = 'default';
      button.style.opacity = '0.6';
      input.action?.onClick();
    });
    toast.appendChild(button);
  }

  toast.dataset.state = input.state;
  toast.style.background = palette.background;
  toast.style.borderColor = palette.border;

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  const autoHideMs = input.autoHideMs ?? SAVE_TOAST_DEFAULT_MS;
  if (autoHideMs > 0) {
    hideTimer = setTimeout(() => {
      toast.remove();
      hideTimer = null;
    }, autoHideMs);
  }
}

export function removeSaveToast(doc: Document = document): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  doc.getElementById(SAVE_TOAST_ID)?.remove();
}
