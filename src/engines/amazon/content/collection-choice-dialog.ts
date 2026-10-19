/**
 * SAD-287 (plan 7.4): the "Ask every time" dialog.
 *
 * Shown *after* the product has been written to History, so every visible action
 * is safe: "Add to current" is a no-op, "Create new collection" moves the row,
 * and "Cancel"/Escape/backdrop/timeout all leave it exactly where it is.
 *
 * Deliberately self-contained: a shadow root (Amazon's CSS cannot reach in, ours
 * cannot leak out), no text input, no form, no page navigation, and the host
 * element is removed - not just hidden - when the dialog closes, so nothing is
 * left covering the page's own controls.
 *
 * Dynamic strings (product title, collection label) are always assigned through
 * `textContent`: a page-controlled title must never be parsed as markup.
 */

export const COLLECTION_CHOICE_DIALOG_ID = 'pphunt-collection-choice';
export const COLLECTION_CHOICE_TIMEOUT_MS = 30_000;

export type CollectionChoice = 'current' | 'new' | 'cancel';

export interface CollectionChoiceRequest {
  jobId: string;
  /** Product name, when the page exposed one. Never fabricated. */
  productTitle?: string;
  /** Label of the collection the product was already saved into. */
  collectionLabel: string;
}

export interface CollectionChoiceQueueOptions {
  doc?: Document;
  timeoutMs?: number;
  /** Tests need to reach into the tree; production keeps the root closed. */
  shadowMode?: 'open' | 'closed';
  onChoice: (jobId: string, choice: CollectionChoice) => void;
}

export interface CollectionChoiceQueue {
  /** False when this jobId was already queued or answered (duplicate delivery). */
  enqueue: (request: CollectionChoiceRequest) => boolean;
  size: () => number;
  close: () => void;
}

const SEEN_LIMIT = 50;

const STYLES = `
  :host { all: initial; }
  .backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(17, 24, 39, 0.45);
    z-index: 2147483647;
  }
  .panel {
    width: min(420px, calc(100vw - 32px));
    background: #ffffff;
    color: #111827;
    border-radius: 12px;
    border: 1px solid #e5e7eb;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.35);
    padding: 18px 20px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: left;
  }
  .title { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 1.35; }
  .product { margin: 0 0 4px; font-size: 13px; color: #374151; overflow-wrap: anywhere; }
  .counter { margin: 0 0 12px; font-size: 11px; color: #6b7280; }
  .spacer { height: 12px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    font: inherit;
    font-size: 13px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid #d1d5db;
    background: #ffffff;
    color: #111827;
    cursor: pointer;
  }
  button.primary { background: #1f2937; border-color: #1f2937; color: #ffffff; }
  button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    .panel { background: #111827; color: #f9fafb; border-color: #374151; }
    .product { color: #d1d5db; }
    .counter { color: #9ca3af; }
    button { background: #1f2937; border-color: #4b5563; color: #f9fafb; }
    button.primary { background: #f9fafb; border-color: #f9fafb; color: #111827; }
  }
`;

/**
 * Builds the queue that guarantees one dialog per tab. Saves that finish while a
 * dialog is open are appended and shown afterwards with a `1 of N` counter; no
 * two dialogs are ever in the DOM at once.
 */
export function createCollectionChoiceQueue(
  options: CollectionChoiceQueueOptions,
): CollectionChoiceQueue {
  const doc = options.doc ?? document;
  const timeoutMs = options.timeoutMs ?? COLLECTION_CHOICE_TIMEOUT_MS;
  const shadowMode = options.shadowMode ?? 'closed';

  const queue: CollectionChoiceRequest[] = [];
  const seen = new Set<string>();
  let host: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onKeyDown: ((event: KeyboardEvent) => void) | null = null;
  let refreshCounter: (() => void) | null = null;
  let restoreFocus: HTMLElement | null = null;
  let closed = false;

  function rememberSeen(jobId: string): void {
    seen.add(jobId);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
  }

  function teardown(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (onKeyDown) {
      doc.removeEventListener('keydown', onKeyDown, true);
      onKeyDown = null;
    }
    host?.remove();
    host = null;
    refreshCounter = null;

    const target = restoreFocus;
    restoreFocus = null;
    if (target && target.isConnected && typeof target.focus === 'function') {
      try {
        target.focus();
      } catch {
        // Focus restoration is best effort; a detached element cannot take it.
      }
    }
  }

  function showNext(): void {
    if (closed) return;
    const request = queue[0];
    if (!request) return;

    const element = doc.createElement('div');
    element.id = COLLECTION_CHOICE_DIALOG_ID;
    const shadow = element.attachShadow({ mode: shadowMode });

    const style = doc.createElement('style');
    style.textContent = STYLES;

    const backdrop = doc.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.setAttribute('data-testid', 'collection-choice-backdrop');

    const panel = doc.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'pphunt-choice-title');

    const title = doc.createElement('h2');
    title.className = 'title';
    title.id = 'pphunt-choice-title';
    title.textContent = 'Where would you like to save this product?';

    const product = doc.createElement('p');
    product.className = 'product';
    product.setAttribute('data-testid', 'collection-choice-product');
    product.textContent = request.productTitle ?? 'This product';

    const actions = doc.createElement('div');
    actions.className = 'actions';

    const currentButton = doc.createElement('button');
    currentButton.type = 'button';
    currentButton.className = 'primary';
    currentButton.dataset.action = 'current';
    currentButton.textContent = `Add to "${request.collectionLabel}"`;

    const newButton = doc.createElement('button');
    newButton.type = 'button';
    newButton.dataset.action = 'new';
    newButton.textContent = 'Create new collection';

    const cancelButton = doc.createElement('button');
    cancelButton.type = 'button';
    cancelButton.dataset.action = 'cancel';
    cancelButton.textContent = 'Cancel';

    actions.append(currentButton, newButton, cancelButton);
    panel.append(title, product);

    // Always mounted so a save arriving while this dialog is open can grow the
    // counter in place ("1 of 1" -> "1 of 2") without re-rendering the panel.
    const counter = doc.createElement('p');
    counter.className = 'counter';
    counter.setAttribute('data-testid', 'collection-choice-counter');
    panel.append(counter);

    const syncCounter = () => {
      const remaining = queue.length;
      counter.textContent = remaining > 1 ? `1 of ${remaining}` : '';
      counter.hidden = remaining <= 1;
    };
    syncCounter();
    refreshCounter = syncCounter;

    panel.append(actions);
    backdrop.append(panel);
    shadow.append(style, backdrop);
    (doc.body ?? doc.documentElement).appendChild(element);
    host = element;
    restoreFocus = (doc.activeElement as HTMLElement | null) ?? null;

    const finish = (choice: CollectionChoice) => {
      if (!host) return;
      queue.shift();
      teardown();
      try {
        options.onChoice(request.jobId, choice);
      } finally {
        showNext();
      }
    };

    currentButton.addEventListener('click', () => finish('current'));
    newButton.addEventListener('click', () => finish('new'));
    cancelButton.addEventListener('click', () => finish('cancel'));

    // Backdrop click is Cancel; a click inside the panel must not be.
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish('cancel');
    });

    onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = [currentButton, newButton, cancelButton];
      const index = focusables.indexOf(doc.activeElement as HTMLButtonElement);
      event.preventDefault();
      const next =
        event.shiftKey
          ? focusables[(index <= 0 ? focusables.length : index) - 1]
          : focusables[(index + 1) % focusables.length];
      if (next) next.focus();
    };
    doc.addEventListener('keydown', onKeyDown, true);

    timer = setTimeout(() => finish('cancel'), timeoutMs);

    try {
      currentButton.focus();
    } catch {
      // A document without focus support (jsdom in some suites) still works.
    }
  }

  return {
    enqueue(request: CollectionChoiceRequest): boolean {
      if (closed || !request?.jobId || seen.has(request.jobId)) return false;
      rememberSeen(request.jobId);
      queue.push(request);
      if (!host) showNext();
      else refreshCounter?.();
      return true;
    },

    size(): number {
      return queue.length;
    },

    close(): void {
      closed = true;
      queue.length = 0;
      teardown();
    },
  };
}
