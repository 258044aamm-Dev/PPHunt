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

export interface SaveToastInput {
  state: SaveToastState;
  message: string;
  autoHideMs?: number;
  doc?: Document;
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

  toast.textContent = input.message;
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
