import { extractCardAsinWithTier } from '../scraper/field-parsers';

/**
 * SAD-283 (plan 8.2): the per-card save control.
 *
 * Rules that keep it safe on someone else's page:
 *   - closed shadow root, so Amazon's CSS and scripts cannot reach in and the
 *     page cannot accidentally restyle the control;
 *   - mount point is never inside an `<a>` (interactive nesting is invalid HTML
 *     and would navigate on click);
 *   - every pointer event that could bubble into the card's own handlers is
 *     stopped, and `click` is also prevented;
 *   - the only DOM change outside the shadow root is an inline `position` on the
 *     mount point when it is `static`, and that exact value is restored on
 *     `destroy()`.
 */

export const CARD_ACTION_HOST_ATTRIBUTE = 'data-pphunt-save-host';
export const CARD_ACTION_HOST_SELECTOR = `[${CARD_ACTION_HOST_ATTRIBUTE}]`;
export const CARD_ACTION_COMPLETED_RESET_MS = 2_500;

export type CardActionState =
  | 'idle'
  | 'queued'
  | 'extracting'
  | 'enriching'
  | 'completed'
  | 'failed';

export type CardActionTheme = 'light' | 'dark' | 'auto';

export interface CardActionActivation {
  asin: string;
  retry: boolean;
}

export interface CardActionStateOptions {
  /** Product row is saved but some detail fields were unavailable. */
  partial?: boolean;
  /** Short, user-facing reason shown on `failed`. */
  reason?: string;
}

export interface CardActionButtonOptions {
  asin: string;
  title?: string | null;
  theme?: CardActionTheme;
  doc?: Document;
  completedResetMs?: number;
  onActivate: (activation: CardActionActivation) => void;
}

export interface CardActionButtonHandle {
  host: HTMLElement;
  button: HTMLButtonElement;
  shadowRoot: ShadowRoot;
  getState: () => CardActionState;
  setState: (state: CardActionState, options?: CardActionStateOptions) => void;
  setTheme: (theme: CardActionTheme) => void;
  destroy: () => void;
}

const WORKING_STATES: ReadonlySet<CardActionState> = new Set([
  'queued',
  'extracting',
  'enriching',
]);

const LIGHT_TOKENS = `
  --pph-surface: #faf9f5;
  --pph-surface-card: #efe9de;
  --pph-ink: #141413;
  --pph-ink-muted: #57554f;
  --pph-hairline-soft: #d2cdc1;
  --pph-clay: #b04e30;
  --pph-clay-active: #943e24;
  --pph-clay-ink: #faf9f5;
  --pph-moss: #455e2d;
  --pph-crimson: #a3302d;
  --pph-golden: #856214;
  --pph-moss-ink: #faf9f5;
  --pph-crimson-ink: #faf9f5;
  --pph-badge-halo: #faf9f5;
`;

const DARK_TOKENS = `
  --pph-surface: #1d1c1a;
  --pph-surface-card: #252421;
  --pph-ink: #f5f2eb;
  --pph-ink-muted: #b8b4aa;
  --pph-hairline-soft: #3e3c37;
  --pph-clay: #d97757;
  --pph-clay-active: #e68f73;
  --pph-clay-ink: #141413;
  --pph-moss: #91b370;
  --pph-crimson: #e87672;
  --pph-golden: #e0ba5c;
  --pph-moss-ink: #141413;
  --pph-crimson-ink: #141413;
  --pph-badge-halo: #1d1c1a;
`;

const ICON_BOOKMARK = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4.6L5.5 21V4.5a1 1 0 0 1 1-1Z"/>
    <path d="M12 7.5v5M9.5 10h5"/>
  </svg>`;

const ICON_CHECK = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m4.5 12.5 5 5 10-11"/>
  </svg>`;

const ICON_RETRY = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 12a8 8 0 1 1-2.4-5.7"/>
    <path d="M20.5 4.5v5h-5"/>
  </svg>`;

const STYLE_TEXT = `
  :host {
    all: initial;
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 10;
    ${LIGHT_TOKENS}
  }

  :host([data-theme="dark"]) {
    ${DARK_TOKENS}
  }

  @media (prefers-color-scheme: dark) {
    :host(:not([data-theme="light"])) {
      ${DARK_TOKENS}
    }
  }

  .wrap {
    position: relative;
    display: block;
  }

  button {
    -webkit-appearance: none;
    appearance: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    margin: 0;
    cursor: pointer;
    /* SAD-329: filled clay controls read as PPHunt at rest instead of as a
       grey chip. The fill is its own boundary, so no border is needed. */
    color: var(--pph-clay-ink);
    background: var(--pph-clay);
    border: 0;
    border-radius: 8px;
    box-shadow: none;
    font: inherit;
    line-height: 0;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: background-color 120ms ease;
    /* Anchors the state mark below without adding a DOM node. */
    position: relative;
  }

  /* Scoped to idle so hovering a completed or failed control never repaints
     it back to clay. */
  button[data-state="idle"]:hover { background: var(--pph-clay-active); }

  /* SAD-329: the ring has to live *inside* the fill. An outer clay ring on a
     clay control is 1:1; cream-on-clay is 5.0:1 and ink-on-clay-dark 5.9:1. */
  button:focus-visible {
    outline: 2px solid var(--pph-clay-ink);
    outline-offset: -4px;
  }

  button[data-state="queued"],
  button[data-state="extracting"],
  button[data-state="enriching"] {
    cursor: progress;
  }

  /* SAD-329: dimming a coloured fill drops the glyph to 2.98:1, so the
     queued state keeps an opaque fill; the static ring and aria-busy carry
     the state instead. */
  button[data-state="queued"] { cursor: default; }

  button[data-state="completed"] {
    background: var(--pph-moss);
    color: var(--pph-moss-ink);
  }

  button[data-state="failed"] {
    background: var(--pph-crimson);
    color: var(--pph-crimson-ink);
  }

  /* SAD-329: 18px at a 2px stroke on the 24 grid is 1.5 CSS px on screen.
     The previous 15px at 1.8 was 1.125 px, which anti-aliased to ~3.85:1. */
  svg {
    display: none;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  button[data-state="idle"] .icon-bookmark,
  button[data-state="queued"] .icon-bookmark { display: block; }
  button[data-state="completed"] .icon-check { display: block; }
  button[data-state="failed"] .icon-retry { display: block; }

  .ring {
    display: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    /* currentColor tracks the state ink, so the ring is always legible on
       whatever fill the state uses. */
    border: 1.6px solid currentColor;
    border-right-color: transparent;
    animation: pph-spin 800ms linear infinite;
  }

  button[data-state="queued"] .ring,
  button[data-state="extracting"] .ring,
  button[data-state="enriching"] .ring { display: block; }

  button[data-state="queued"] .ring { animation: none; opacity: 0.55; }

  /* SAD-329 (plan 8.2): enriching is "ring with a small +". Drawn as two
     gradients in currentColor so no extra element enters the shadow root. */
  button[data-state="enriching"]::after {
    content: '';
    position: absolute;
    inset: 0;
    margin: auto;
    width: 5px;
    height: 5px;
    pointer-events: none;
    background:
      linear-gradient(currentColor, currentColor) center / 100% 1.5px no-repeat,
      linear-gradient(currentColor, currentColor) center / 1.5px 100% no-repeat;
  }

  .dot {
    display: none;
    position: absolute;
    top: 3px;
    right: 3px;
    width: 6px;
    height: 6px;
    box-sizing: border-box;
    border-radius: 50%;
    /* SAD-329: golden on a clay fill is 1.06:1, i.e. invisible. The halo
       restores 5.3:1 around the badge and 5.0:1 against the fill. */
    background: var(--pph-golden);
    border: 1.5px solid var(--pph-badge-halo);
  }

  :host([data-partial="true"]) .dot { display: block; }

  .pulse {
    position: absolute;
    inset: 0;
    border-radius: 8px;
    box-shadow: 0 0 0 0 var(--pph-clay);
    opacity: 0;
    pointer-events: none;
  }

  :host([data-pulse="true"]) .pulse {
    animation: pph-pulse 420ms ease-out;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes pph-spin { to { transform: rotate(360deg); } }

  @keyframes pph-pulse {
    0% { opacity: 0.55; box-shadow: 0 0 0 0 var(--pph-clay); }
    100% { opacity: 0; box-shadow: 0 0 0 8px var(--pph-clay); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ring { animation: none; }
    :host([data-pulse="true"]) .pulse { animation: none; }
    button { transition: none; }
  }
`;

function statusText(
  state: CardActionState,
  options: CardActionStateOptions,
  title: string,
): { label: string; tooltip: string } {
  const suffix = title ? `: ${title}` : '';

  switch (state) {
    case 'idle':
      return {
        label: `Save product details${suffix}`,
        tooltip: 'Save product details',
      };
    case 'queued':
      return { label: `Save queued${suffix}`, tooltip: 'Save queued' };
    case 'extracting':
      return {
        label: `Saving product${suffix}`,
        tooltip: 'Saving product…',
      };
    case 'enriching':
      return {
        label: `Fetching product details${suffix}`,
        tooltip: 'Fetching product details…',
      };
    case 'completed':
      return options.partial
        ? {
            label: `Saved — details unavailable${suffix}`,
            tooltip: 'Saved — details unavailable',
          }
        : { label: `Saved${suffix}`, tooltip: 'Saved' };
    case 'failed':
      return {
        label: `Retry saving${suffix}`,
        tooltip: options.reason ? `Could not save: ${options.reason}` : 'Could not save — retry',
      };
    default:
      return { label: `Save product details${suffix}`, tooltip: 'Save product details' };
  }
}

function shortTitle(title: string | null | undefined): string {
  const trimmed = (title ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

interface MountRecord {
  handle: CardActionButtonHandle;
  mountPoint: Element;
  changedPosition: boolean;
  previousInlinePosition: string;
}

const mountRecords = new WeakMap<Element, MountRecord>();
const allRecords = new Set<MountRecord>();

export function createCardActionButton(
  options: CardActionButtonOptions,
): CardActionButtonHandle {
  const doc = options.doc ?? document;
  const title = shortTitle(options.title);
  const completedResetMs = options.completedResetMs ?? CARD_ACTION_COMPLETED_RESET_MS;

  const host = doc.createElement('div');
  host.setAttribute(CARD_ACTION_HOST_ATTRIBUTE, '');
  host.setAttribute('data-asin', options.asin);
  host.setAttribute('draggable', 'false');
  host.style.position = 'absolute';
  host.style.top = '8px';
  host.style.right = '8px';
  host.style.zIndex = '10';

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = STYLE_TEXT;

  const wrap = doc.createElement('div');
  wrap.className = 'wrap';

  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute('draggable', 'false');

  const bookmark = doc.createElement('span');
  bookmark.className = 'icon-bookmark';
  bookmark.innerHTML = ICON_BOOKMARK;

  const ring = doc.createElement('span');
  ring.className = 'ring';
  ring.setAttribute('aria-hidden', 'true');

  const check = doc.createElement('span');
  check.className = 'icon-check';
  check.innerHTML = ICON_CHECK;

  const retry = doc.createElement('span');
  retry.className = 'icon-retry';
  retry.innerHTML = ICON_RETRY;

  const dot = doc.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');

  const pulse = doc.createElement('span');
  pulse.className = 'pulse';
  pulse.setAttribute('aria-hidden', 'true');

  const live = doc.createElement('span');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  wrap.append(pulse, bookmark, ring, check, retry, dot);
  button.append(wrap, live);
  shadow.append(style, button);

  let state: CardActionState = 'idle';
  let destroyed = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;

  const clearResetTimer = () => {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  };

  const applyState = (next: CardActionState, stateOptions: CardActionStateOptions) => {
    state = next;
    if (destroyed) return;

    const { label, tooltip } = statusText(next, stateOptions, title);

    button.dataset.state = next;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', tooltip);
    live.textContent = next === 'idle' ? '' : tooltip;

    if (WORKING_STATES.has(next)) {
      button.setAttribute('aria-busy', 'true');
    } else {
      button.removeAttribute('aria-busy');
    }

    if (next === 'completed' && stateOptions.partial) {
      host.setAttribute('data-partial', 'true');
    } else {
      host.removeAttribute('data-partial');
    }
  };

  const setState = (next: CardActionState, stateOptions: CardActionStateOptions = {}) => {
    clearResetTimer();
    applyState(next, stateOptions);

    if (next === 'completed' && completedResetMs > 0) {
      resetTimer = setTimeout(() => {
        resetTimer = null;
        if (!destroyed && state === 'completed') {
          applyState('idle', {});
        }
      }, completedResetMs);
    }
  };

  const pulseOnce = () => {
    host.setAttribute('data-pulse', 'true');
    if (pulseTimer !== null) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      host.removeAttribute('data-pulse');
    }, 450);
  };

  const stop = (event: Event) => {
    event.stopPropagation();
  };

  const onPointerDown = (event: Event) => {
    stop(event);
  };

  const onMouseDown = (event: Event) => {
    stop(event);
  };

  const onClick = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();

    if (destroyed) return;

    if (WORKING_STATES.has(state)) {
      // A second click must never start a second job: acknowledge it visually.
      pulseOnce();
      return;
    }

    const retryClick = state === 'failed';
    setState('queued');
    try {
      options.onActivate({ asin: options.asin, retry: retryClick });
    } catch (error) {
      console.warn('[PPHunt] card action activation failed:', error);
      setState('failed', { reason: 'unexpected error' });
    }
  };

  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('mousedown', onMouseDown);
  button.addEventListener('click', onClick);

  applyState('idle', {});
  if (options.theme) {
    host.setAttribute('data-theme', options.theme);
  }

  const handle: CardActionButtonHandle = {
    host,
    button,
    shadowRoot: shadow,
    getState: () => state,
    setState,
    setTheme: (theme) => {
      host.setAttribute('data-theme', theme);
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      clearResetTimer();
      if (pulseTimer !== null) {
        clearTimeout(pulseTimer);
        pulseTimer = null;
      }
      button.removeEventListener('pointerdown', onPointerDown);
      button.removeEventListener('mousedown', onMouseDown);
      button.removeEventListener('click', onClick);
      host.remove();
    },
  };

  return handle;
}

/** The image tile when it exists and is not inside a link, else the card itself. */
export function resolveCardActionMountPoint(card: Element): Element {
  const candidates = [
    card.querySelector('[data-component-type="s-product-image"]'),
    card.querySelector('.s-product-image-container'),
    card.querySelector('img')?.parentElement ?? null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    let node: Element | null = candidate;
    while (node && node !== card) {
      if (node.tagName === 'A') {
        node = null;
        break;
      }
      node = node.parentElement;
    }
    if (node === card) return candidate;
  }

  return card;
}

export interface MountCardActionButtonOptions extends Omit<CardActionButtonOptions, 'asin'> {
  /** Captured at click time by the caller when the DOM attribute is missing. */
  asinHint?: string;
}

/**
 * Mounts (or returns the already-mounted) control for one card. Returns null when
 * the card has no ASIN, which is also what keeps the control off product-detail
 * pages: those have no cards to mount on.
 */
export function mountCardActionButton(
  card: Element,
  options: MountCardActionButtonOptions,
): CardActionButtonHandle | null {
  const existing = mountRecords.get(card);
  if (existing && existing.handle.host.isConnected) {
    return existing.handle;
  }

  const asin =
    card.getAttribute('data-asin') || extractCardAsinWithTier(card).value || options.asinHint;
  if (!asin) return null;

  const mountPoint = resolveCardActionMountPoint(card);
  const doc = options.doc ?? card.ownerDocument ?? document;

  let changedPosition = false;
  let previousInlinePosition = '';
  try {
    const view = doc.defaultView;
    const computed = view?.getComputedStyle(mountPoint)?.position ?? '';
    if (!computed || computed === 'static') {
      previousInlinePosition = (mountPoint as HTMLElement).style.position;
      (mountPoint as HTMLElement).style.position = 'relative';
      changedPosition = true;
    }
  } catch {
    // A resisting page must not stop the button from mounting.
  }

  const handle = createCardActionButton({
    ...options,
    asin,
    doc,
    title: options.title ?? card.textContent?.trim().slice(0, 120) ?? '',
  });

  mountPoint.appendChild(handle.host);

  const record: MountRecord = {
    handle,
    mountPoint,
    changedPosition,
    previousInlinePosition,
  };
  mountRecords.set(card, record);
  allRecords.add(record);

  const originalDestroy = handle.destroy;
  handle.destroy = () => {
    originalDestroy();
    if (changedPosition) {
      (mountPoint as HTMLElement).style.position = previousInlinePosition;
    }
    mountRecords.delete(card);
    allRecords.delete(record);
  };

  return handle;
}

/**
 * Destroys every control mounted from this module, restoring inline positions.
 * P2.3 calls this on navigation and through `__PPHUNT_CONTENT_CLEANUP__`.
 */
export function unmountAllCardActionButtons(): void {
  for (const record of Array.from(allRecords)) {
    record.handle.destroy();
  }
  allRecords.clear();
}
