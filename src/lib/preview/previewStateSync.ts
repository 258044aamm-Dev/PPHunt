import type { SortingState } from '@tanstack/react-table';

export type PreviewDisplayMode = 'sidebar' | 'overview' | 'tab';

export interface PreviewContextSnapshot {
  engine: 'amazon' | 'temu';
  sessionKey: string | null;
  sorting: SortingState;
  globalFilter: string;
  mode: PreviewDisplayMode;
  updatedAt: string;
}

export const PREVIEW_STATE_STORAGE_KEY = 'pphunt.previewState';

function getBrowserApi(): any {
  const g = globalThis as Record<string, any>;
  return g.browser ?? g.chrome ?? null;
}

/**
 * Serializes TanStack SortingState into a compact query parameter string
 * (e.g. `[{ id: 'price', desc: false }, { id: 'rating', desc: true }]` -> `"price:asc,rating:desc"`).
 */
export function serializeSortingToParam(sorting: SortingState): string {
  if (!Array.isArray(sorting) || sorting.length === 0) return '';
  return sorting
    .filter((s) => s && typeof s.id === 'string' && s.id.trim().length > 0)
    .map((s) => `${encodeURIComponent(s.id.trim())}:${s.desc ? 'desc' : 'asc'}`)
    .join(',');
}

/**
 * Parses a compact sorting query parameter string back into TanStack SortingState.
 */
export function parseSortingFromParam(
  raw: string | null | undefined,
): SortingState {
  if (!raw || typeof raw !== 'string') return [];
  const entries = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const result: SortingState = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const [rawId, rawDir] = entry.split(':');
    if (!rawId) continue;
    let id = rawId;
    try {
      id = decodeURIComponent(rawId).trim();
    } catch {
      id = rawId.trim();
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      desc: rawDir?.toLowerCase() === 'desc',
    });
  }

  return result;
}

/**
 * Builds the relative or extension-qualified URL for `/preview.html` with
 * engine, sessionKey, sorting, and search filter parameters encoded.
 */
export function buildPreviewTabUrl(
  snapshot: Partial<PreviewContextSnapshot>,
): string {
  const params = new URLSearchParams();
  const engine = snapshot.engine === 'temu' ? 'temu' : 'amazon';
  params.set('engine', engine);

  if (snapshot.sessionKey) {
    params.set('sessionKey', snapshot.sessionKey);
  }
  const sortStr = serializeSortingToParam(snapshot.sorting ?? []);
  if (sortStr) {
    params.set('sort', sortStr);
  }
  if (snapshot.globalFilter && snapshot.globalFilter.trim().length > 0) {
    params.set('q', snapshot.globalFilter);
  }

  const query = params.toString();
  const relativePath = `/preview.html${query ? `?${query}` : ''}`;

  const ext = getBrowserApi();
  try {
    if (ext?.runtime?.getURL) {
      return ext.runtime.getURL(relativePath);
    }
  } catch {
    // Fallback to relative path in non-extension test environments
  }
  return relativePath;
}

/**
 * Parses URL search parameters from `/preview.html?...` into a structured state object.
 */
export function parsePreviewTabQueryParams(search: string): {
  engine: 'amazon' | 'temu';
  sessionKey: string | null;
  sorting: SortingState;
  globalFilter: string;
} {
  const params = new URLSearchParams(search);
  const rawEngine = params.get('engine');
  const engine: 'amazon' | 'temu' = rawEngine === 'temu' ? 'temu' : 'amazon';
  const sessionKey = params.get('sessionKey') || null;
  const sorting = parseSortingFromParam(params.get('sort'));
  const globalFilter = params.get('q') ?? '';

  return {
    engine,
    sessionKey,
    sorting,
    globalFilter,
  };
}

/**
 * Persists the latest preview context snapshot in `browser.storage.local`
 * (with `localStorage` fallback in tests) for seamless cross-mode handoff.
 */
export async function savePreviewStateSnapshot(
  partial: Partial<PreviewContextSnapshot>,
): Promise<PreviewContextSnapshot> {
  const prev = await loadPreviewStateSnapshot();
  const next: PreviewContextSnapshot = {
    engine: partial.engine ?? prev?.engine ?? 'amazon',
    sessionKey:
      partial.sessionKey !== undefined
        ? partial.sessionKey
        : (prev?.sessionKey ?? null),
    sorting: partial.sorting ?? prev?.sorting ?? [],
    globalFilter: partial.globalFilter ?? prev?.globalFilter ?? '',
    mode: partial.mode ?? prev?.mode ?? 'overview',
    updatedAt: new Date().toISOString(),
  };

  const ext = getBrowserApi();
  try {
    if (ext?.storage?.local?.set) {
      await ext.storage.local.set({ [PREVIEW_STATE_STORAGE_KEY]: next });
    }
  } catch {
    // Ignore storage error
  }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREVIEW_STATE_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore localStorage error
  }

  return next;
}

/**
 * Loads the persisted preview context snapshot from `browser.storage.local` or `localStorage`.
 */
export async function loadPreviewStateSnapshot(): Promise<PreviewContextSnapshot | null> {
  const ext = getBrowserApi();
  try {
    if (ext?.storage?.local?.get) {
      const stored = await ext.storage.local.get(PREVIEW_STATE_STORAGE_KEY);
      const val = stored?.[PREVIEW_STATE_STORAGE_KEY];
      if (val && typeof val === 'object') {
        return val as PreviewContextSnapshot;
      }
    }
  } catch {
    // Fallback to localStorage
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PREVIEW_STATE_STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw) as PreviewContextSnapshot;
      }
    }
  } catch {
    // Ignore parse error
  }

  return null;
}

/**
 * Opens or focuses the dedicated `/preview.html` browser tab, preserving active
 * engine, sessionKey, sorting rules, and global search filter.
 */
export async function openDedicatedPreviewTab(
  snapshot: Partial<PreviewContextSnapshot>,
): Promise<string> {
  const saved = await savePreviewStateSnapshot({
    ...snapshot,
    mode: 'tab',
  });
  const url = buildPreviewTabUrl(saved);
  const ext = getBrowserApi();

  try {
    if (ext?.tabs?.query) {
      const allTabs = await ext.tabs.query({});
      const existingTab = Array.isArray(allTabs)
        ? allTabs.find(
            (t: any) =>
              typeof t?.url === 'string' && t.url.includes('/preview.html'),
          )
        : undefined;

      if (existingTab?.id != null && ext.tabs.update) {
        await ext.tabs.update(existingTab.id, { url, active: true });
        if (existingTab.windowId != null && ext.windows?.update) {
          await ext.windows.update(existingTab.windowId, { focused: true });
        }
        return url;
      }
    }

    if (ext?.tabs?.create) {
      await ext.tabs.create({ url, active: true });
      return url;
    }
  } catch {
    // Fallback below
  }

  try {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch {
    // Ignore in headless test environments
  }

  return url;
}

/**
 * Transitions from the Dedicated Preview Tab (`/preview.html`) back to Sidebar
 * or Overview mode, persisting the latest sorting/filter state and focusing the
 * active marketplace tab if one is open.
 */
export async function switchFromTabToPanelMode(
  targetMode: 'sidebar' | 'overview',
  snapshot: Partial<PreviewContextSnapshot>,
): Promise<PreviewContextSnapshot> {
  const saved = await savePreviewStateSnapshot({
    ...snapshot,
    mode: targetMode,
  });

  const ext = getBrowserApi();
  try {
    if (ext?.tabs?.query) {
      const tabs = await ext.tabs.query({});
      const hostTab = Array.isArray(tabs)
        ? tabs.find((t: any) => {
            const u = String(t?.url ?? '');
            return u.includes('amazon.') || u.includes('temu.com');
          })
        : undefined;
      if (hostTab?.id != null && ext.tabs.update) {
        await ext.tabs.update(hostTab.id, { active: true });
      }
    }
  } catch {
    // Ignore tab focus errors
  }

  return saved;
}
