import {
  OFFSCREEN_DOCUMENT_PATH,
  OFFSCREEN_TARGET,
  offscreenError,
  type OffscreenBlobResponse,
  type OffscreenParseResponse,
  type OffscreenRequest,
  type OffscreenRevokeResponse,
} from '../offscreen/protocol';
import { parsePdpHtml } from '../offscreen/parse';

/**
 * SAD-295 (plan 10.2): the typed client the service worker uses to reach the
 * offscreen document.
 *
 * Creation is race-safe in two layers:
 *   1. one in-flight promise, so two enrichment jobs never call
 *      `createDocument()` twice from this process;
 *   2. `getContexts()` / `hasDocument()` before creating, and a re-check after a
 *      rejection, so a document created by *another* caller (or one that was
 *      already open) is adopted instead of duplicated - Chrome only allows one
 *      `DOM_PARSER` document at a time.
 *
 * The idle close is deliberately short and only ever runs when no request is in
 * flight: parsing is bursty, and holding a document open forever would keep a
 * renderer process alive for an idle extension.
 */

export const OFFSCREEN_IDLE_CLOSE_MS = 30_000;

export interface OffscreenApiLike {
  createDocument?: (options: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<unknown>;
  closeDocument?: () => Promise<unknown>;
  hasDocument?: () => Promise<boolean>;
}

export interface RuntimeApiLike {
  getURL?: (path: string) => string;
  getContexts?: (filter: {
    contextTypes: string[];
  }) => Promise<Array<{ contextType?: string; documentUrl?: string }>>;
  sendMessage?: (message: unknown) => Promise<unknown>;
}

export interface OffscreenEnvironment {
  offscreen: OffscreenApiLike | null;
  runtime: RuntimeApiLike | null;
}

function readEnvironment(): OffscreenEnvironment {
  try {
    const g = globalThis as unknown as {
      browser?: { offscreen?: OffscreenApiLike; runtime?: RuntimeApiLike };
      chrome?: { offscreen?: OffscreenApiLike; runtime?: RuntimeApiLike };
    };
    const api = g.browser ?? g.chrome;
    return {
      offscreen: api?.offscreen ?? null,
      runtime: api?.runtime ?? null,
    };
  } catch {
    return { offscreen: null, runtime: null };
  }
}

let creating: Promise<boolean> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeRequests = 0;

export function resetOffscreenForTests(): void {
  creating = null;
  activeRequests = 0;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export function isOffscreenSupported(
  env: OffscreenEnvironment = readEnvironment(),
): boolean {
  return typeof env.offscreen?.createDocument === 'function';
}

async function hasOffscreenDocument(
  env: OffscreenEnvironment = readEnvironment(),
): Promise<boolean> {
  if (typeof env.runtime?.getContexts === 'function') {
    try {
      const contexts = await env.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      // `getContexts` is authoritative on Chrome 116+: an empty list means
      // there is no offscreen document, so `hasDocument()` is not consulted.
      return (contexts ?? []).some((context) =>
        typeof context?.documentUrl === 'string'
          ? context.documentUrl.endsWith(OFFSCREEN_DOCUMENT_PATH)
          : context?.contextType === 'OFFSCREEN_DOCUMENT',
      );
    } catch {
      // Fall through to the older API.
    }
  }

  if (typeof env.offscreen?.hasDocument === 'function') {
    try {
      return await env.offscreen.hasDocument();
    } catch {
      return false;
    }
  }

  return false;
}

function scheduleIdleClose(env: OffscreenEnvironment): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
  }

  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeRequests === 0) {
      void closeOffscreen(env);
    }
  }, OFFSCREEN_IDLE_CLOSE_MS);
}

export interface EnsureOffscreenOptions {
  env?: OffscreenEnvironment;
  /** `BLOBS` is only claimed when a file is actually being built. */
  needsBlobs?: boolean;
}

/**
 * True once an offscreen document exists (created now or already open).
 * Concurrent callers share one creation attempt.
 */
export async function ensureOffscreen(
  options: EnsureOffscreenOptions = {},
): Promise<boolean> {
  if (creating) return creating;

  creating = (async () => {
    const env = options.env ?? readEnvironment();
    if (!isOffscreenSupported(env)) return false;

    if (await hasOffscreenDocument(env)) return true;

    const url =
      typeof env.runtime?.getURL === 'function'
        ? env.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)
        : OFFSCREEN_DOCUMENT_PATH;

    try {
      await env.offscreen?.createDocument?.({
        url,
        reasons: options.needsBlobs ? ['DOM_PARSER', 'BLOBS'] : ['DOM_PARSER'],
        justification:
          'Parse fetched Amazon product pages and build export files: the MV3 ' +
          'service worker has neither DOMParser nor URL.createObjectURL.',
      });
      return true;
    } catch {
      // "Only a single offscreen document may be created." If one exists now,
      // the race was benign and this call succeeded in effect.
      return hasOffscreenDocument(env);
    }
  })().finally(() => {
    creating = null;
  });

  return creating;
}

export async function closeOffscreen(
  env: OffscreenEnvironment = readEnvironment(),
): Promise<void> {
  if (typeof env.offscreen?.closeDocument !== 'function') return;

  try {
    await env.offscreen.closeDocument();
  } catch {
    // Already closed (or never created): nothing to repair.
  }
}

async function callOffscreen<T extends { ok: boolean }>(
  request: OffscreenRequest,
  options: EnsureOffscreenOptions,
  unavailable: T,
): Promise<T> {
  const env = options.env ?? readEnvironment();
  if (typeof env.runtime?.sendMessage !== 'function') return unavailable;

  const ready = await ensureOffscreen({ ...options, env });
  if (!ready) return unavailable;

  activeRequests += 1;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  try {
    const response = await env.runtime.sendMessage(request);
    if (!response || typeof response !== 'object') return unavailable;
    return response as T;
  } catch (error) {
    return {
      ...unavailable,
      message:
        error instanceof Error
          ? `Offscreen document did not answer: ${error.message}`
          : 'Offscreen document did not answer',
    } as T;
  } finally {
    activeRequests -= 1;
    if (activeRequests === 0) scheduleIdleClose(env);
  }
}

/**
 * Parses a fetched product page, falling back to an inline parse where the
 * service worker has a DOM (Firefox event pages) - the plan's "skip offscreen
 * entirely" path.
 */
export async function parsePdpHtmlViaOffscreen(
  html: string,
  productUrl: string,
  asin?: string,
  options: EnsureOffscreenOptions = {},
): Promise<OffscreenParseResponse> {
  const env = options.env ?? readEnvironment();

  if (!isOffscreenSupported(env)) {
    if (typeof DOMParser !== 'undefined') {
      return parsePdpHtml(html, productUrl, asin);
    }
    return offscreenError('PARSE_UNAVAILABLE', 'No offscreen document available');
  }

  return callOffscreen<OffscreenParseResponse>(
    {
      target: OFFSCREEN_TARGET,
      type: 'OFFSCREEN_PARSE_PRODUCT',
      html,
      productUrl,
      ...(asin ? { asin } : {}),
    },
    { ...options, env },
    offscreenError('PARSE_FAILED', 'The offscreen document did not answer'),
  );
}

export async function createBlobUrlViaOffscreen(
  mimeType: string,
  base64: string,
  options: EnsureOffscreenOptions = {},
): Promise<OffscreenBlobResponse> {
  return callOffscreen<OffscreenBlobResponse>(
    {
      target: OFFSCREEN_TARGET,
      type: 'OFFSCREEN_CREATE_BLOB_URL',
      mimeType,
      base64,
    },
    { ...options, needsBlobs: true },
    offscreenError('BLOB_FAILED', 'The offscreen document did not answer'),
  );
}

export async function revokeBlobUrlViaOffscreen(
  url: string,
  options: EnsureOffscreenOptions = {},
): Promise<OffscreenRevokeResponse> {
  return callOffscreen<OffscreenRevokeResponse>(
    { target: OFFSCREEN_TARGET, type: 'OFFSCREEN_REVOKE_URL', url },
    { ...options, needsBlobs: true },
    offscreenError('BLOB_FAILED', 'The offscreen document did not answer'),
  );
}
