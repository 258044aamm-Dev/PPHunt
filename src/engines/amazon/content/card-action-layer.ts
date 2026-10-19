import { createCardObserver } from './card-observer';
import {
  mountCardActionButton,
  unmountAllCardActionButtons,
  type CardActionButtonHandle,
  type CardActionState,
} from './card-action-button';
import { extractCardAsinWithTier } from '../scraper/field-parsers';

/**
 * SAD-284 (plan 8.4): one button per card, one job per card at a time.
 *
 * The layer owns the three maps the plan asks for:
 *   - `handles`  asin -> control, so a `SAVE_JOB_UPDATE` can find its card
 *   - `jobs`     jobId -> asin, so an update can be attributed to a card
 *   - `states`   asin -> state, so a second click is refused while one runs
 *
 * It never talks to the extension messaging layer itself; `onSave` is the single
 * seam the content script wires to `SAVE_PRODUCT`.
 */

export interface CardActionSaveRequest {
  card: Element;
  asin: string;
  jobId: string;
  retry: boolean;
  title: string | null;
}

export interface CardActionJobUpdate {
  jobId?: string;
  asin: string;
  state: string;
  enrichmentStatus?: string;
  warning?: string;
  message?: string;
  /* SAD-287: carried through so the content script can open the Ask dialog. */
  collectionKey?: string;
  collectionLabel?: string;
  requiresCollectionChoice?: boolean;
  defaultCollectionKey?: string;
  productTitle?: string;
}

export interface CardActionLayerOptions {
  onSave: (request: CardActionSaveRequest) => void;
  doc?: Document;
  win?: Window;
  theme?: 'light' | 'dark' | 'auto';
  /** Injectable for tests; defaults to crypto.randomUUID with a fallback. */
  mintJobId?: () => string;
}

export interface CardActionLayer {
  start: () => void;
  stop: () => void;
  mountCard: (card: Element) => CardActionButtonHandle | null;
  applyJobUpdate: (update: CardActionJobUpdate) => boolean;
  getButton: (asin: string) => CardActionButtonHandle | null;
  getState: (asin: string) => CardActionState | null;
}

const WORKING: ReadonlySet<CardActionState> = new Set([
  'queued',
  'extracting',
  'enriching',
]);

function defaultMintJobId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through
  }
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toButtonState(state: string): CardActionState {
  switch (state) {
    case 'queued':
    case 'extracting':
    case 'enriching':
    case 'completed':
    case 'failed':
      return state;
    default:
      return 'idle';
  }
}

export function createCardActionLayer(options: CardActionLayerOptions): CardActionLayer {
  const doc = options.doc ?? document;
  const mintJobId = options.mintJobId ?? defaultMintJobId;

  const handles = new Map<string, CardActionButtonHandle>();
  const jobs = new Map<string, string>();
  const states = new Map<string, CardActionState>();

  const observer = createCardObserver({
    doc,
    win: options.win,
    onCardVisible: (card) => {
      mountCard(card);
    },
    onNavigate: () => {
      handles.clear();
      jobs.clear();
      states.clear();
      unmountAllCardActionButtons();
    },
    onTeardown: () => {
      handles.clear();
      jobs.clear();
      states.clear();
    },
  });

  function titleFor(card: Element): string | null {
    const text = card.textContent?.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 120) : null;
  }

  function mountCard(card: Element): CardActionButtonHandle | null {
    const asin =
      card.getAttribute('data-asin') || extractCardAsinWithTier(card).value || null;
    if (!asin) return null;

    const existing = handles.get(asin);
    if (existing?.host.isConnected) return existing;

    const title = titleFor(card);
    const handle = mountCardActionButton(card, {
      doc,
      title,
      theme: options.theme,
      onActivate: ({ asin: activatedAsin, retry }) => {
        activate(card, activatedAsin, retry, title);
      },
    });

    if (!handle) return null;

    handles.set(asin, handle);
    states.set(asin, handle.getState());
    return handle;
  }

  function activate(card: Element, asin: string, retry: boolean, title: string | null): void {
    const current = states.get(asin) ?? handles.get(asin)?.getState() ?? 'idle';

    // The control refuses too, but the layer is the authority: the state map is
    // what guarantees "one job per card" across closures and re-mounts.
    if (WORKING.has(current)) return;

    const jobId = mintJobId();
    jobs.set(jobId, asin);
    states.set(asin, 'queued');

    try {
      options.onSave({
        card,
        asin,
        jobId,
        retry,
        title,
      });
    } catch (error) {
      console.warn('[PPHunt] card save request failed:', error);
      states.set(asin, 'failed');
      handles.get(asin)?.setState('failed', { reason: 'unexpected error' });
    }
  }

  function applyJobUpdate(update: CardActionJobUpdate): boolean {
    const asin = update.asin;
    if (!asin) return false;

    const handle = handles.get(asin);
    if (!handle) return false;

    const next = toButtonState(update.state);
    const partial =
      update.enrichmentStatus === 'partial' || Boolean(update.warning);

    handle.setState(next, {
      partial: next === 'completed' && partial,
      reason: update.message,
    });
    states.set(asin, next);

    if (!WORKING.has(next) && update.jobId) {
      // Terminal state: the job is done, a new click may start a new extraction.
      jobs.delete(update.jobId);
    }

    return true;
  }

  return {
    start: () => observer.start(),
    stop: () => {
      observer.stop();
      unmountAllCardActionButtons();
      handles.clear();
      jobs.clear();
      states.clear();
    },
    mountCard,
    applyJobUpdate,
    getButton: (asin) => handles.get(asin) ?? null,
    getState: (asin) => states.get(asin) ?? null,
  };
}
