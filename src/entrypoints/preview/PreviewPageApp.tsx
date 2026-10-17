import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { useLiveQuery } from 'dexie-react-hooks';
import { ErrorBoundary } from '@/entrypoints/sidepanel/components/ErrorBoundary';
import { PreviewModeSwitcher } from '@/entrypoints/sidepanel/components/PreviewModeSwitcher';
import { ToastContainer } from '@/entrypoints/sidepanel/components/ToastContainer';
import { db } from '@/engines/amazon/db/database';
import { AmazonExportModal } from '@/engines/amazon/ui/components/ExportModal';
import { useAmazonUIStore } from '@/engines/amazon/ui/store/uiStore';
import { AmazonProductTable } from '@/engines/amazon/ui/table/AmazonProductTable';
import { formatNumber } from '@/engines/amazon/utils/formatters';
import { temuDb } from '@/engines/temu/db/database';
import { TemuExportModal } from '@/engines/temu/ui/components/ExportModal';
import { useTemuUIStore } from '@/engines/temu/ui/store/uiStore';
import { TemuProductTable } from '@/engines/temu/ui/table/TemuProductTable';
import {
  buildPreviewTabUrl,
  loadPreviewStateSnapshot,
  parsePreviewTabQueryParams,
  savePreviewStateSnapshot,
  switchFromTabToPanelMode,
  type PreviewDisplayMode,
} from '@/lib/preview/previewStateSync';
import { sortProducts } from '@/lib/sorting/product-sorter';
import {
  initThemeSync,
  setThemePreference,
  type ResolvedTheme,
} from '@/lib/ui/theme';

export function PreviewPageApp() {
  const initialParsed = useMemo(
    () =>
      parsePreviewTabQueryParams(
        typeof window !== 'undefined' ? window.location.search : '',
      ),
    [],
  );

  const [engine, setEngine] = useState<'amazon' | 'temu'>(initialParsed.engine);
  const [sessionKey, setSessionKey] = useState<string | null>(
    initialParsed.sessionKey,
  );
  const [initialSorting, setInitialSorting] = useState<SortingState>(
    initialParsed.sorting,
  );
  const [initialGlobalFilter, setInitialGlobalFilter] = useState<string>(
    initialParsed.globalFilter,
  );
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  );

  useEffect(() => {
    return initThemeSync((_mode, resolved) => {
      setResolvedTheme(resolved);
    });
  }, []);

  const amazonSorting = useAmazonUIStore((s) => s.previewSorting);
  const amazonFilter = useAmazonUIStore((s) => s.previewGlobalFilter);
  const temuSorting = useTemuUIStore((s) => s.previewSorting);
  const temuFilter = useTemuUIStore((s) => s.previewGlobalFilter);

  const activeSorting = engine === 'temu' ? temuSorting : amazonSorting;
  const activeFilter = engine === 'temu' ? temuFilter : amazonFilter;

  // Hydrate from stored snapshot if URL had no explicit query parameters
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.length > 1) {
      return;
    }
    let cancelled = false;
    void loadPreviewStateSnapshot().then((snap) => {
      if (cancelled || !snap) return;
      setEngine(snap.engine);
      setSessionKey(snap.sessionKey);
      setInitialSorting(snap.sorting ?? []);
      setInitialGlobalFilter(snap.globalFilter ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep URL query bar and storage snapshot in sync with active state
  useEffect(() => {
    const nextSnapshot = {
      engine,
      sessionKey,
      sorting: activeSorting,
      globalFilter: activeFilter,
      mode: 'tab' as const,
    };
    void savePreviewStateSnapshot(nextSnapshot);

    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.history?.replaceState === 'function'
      ) {
        const nextUrl = buildPreviewTabUrl(nextSnapshot);
        const parsedUrl = new URL(nextUrl, window.location.origin);
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${parsedUrl.search}`,
        );
      }
    } catch {
      // Ignore history replaceState errors in synthetic test environments
    }
  }, [engine, sessionKey, activeSorting, activeFilter]);

  const amazonHistory = useLiveQuery(
    () => db.history.orderBy('startedAt').reverse().toArray(),
    [],
  );
  const temuHistory = useLiveQuery(
    () => temuDb.history.orderBy('startedAt').reverse().toArray(),
    [],
  );

  const amazonProducts = useLiveQuery(async () => {
    if (engine !== 'amazon') return [];
    if (sessionKey) {
      const scoped = await db.products
        .where('sessionKey')
        .equals(sessionKey)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? ''),
      );
    }
    return db.products.orderBy('collectedAt').reverse().toArray();
  }, [engine, sessionKey]);

  const temuProducts = useLiveQuery(async () => {
    if (engine !== 'temu') return [];
    if (sessionKey) {
      const scoped = await temuDb.products
        .where('sessionId')
        .equals(sessionKey)
        .toArray();
      return scoped.sort((a, b) =>
        (b.collectedAt ?? '').localeCompare(a.collectedAt ?? ''),
      );
    }
    return temuDb.products.orderBy('collectedAt').reverse().toArray();
  }, [engine, sessionKey]);

  const sortedAmazonProducts = useMemo(
    () => sortProducts(amazonProducts ?? [], amazonSorting),
    [amazonProducts, amazonSorting],
  );

  const filteredSortedAmazonProducts = useMemo(() => {
    if (!amazonFilter) return sortedAmazonProducts;
    const lower = amazonFilter.toLowerCase();
    return sortedAmazonProducts.filter(
      (p) =>
        (p.title ?? '').toLowerCase().includes(lower) ||
        p.asin.toLowerCase().includes(lower) ||
        (p.brand ?? '').toLowerCase().includes(lower) ||
        (p.seller ?? '').toLowerCase().includes(lower),
    );
  }, [sortedAmazonProducts, amazonFilter]);

  const sortedTemuProducts = useMemo(
    () => sortProducts(temuProducts ?? [], temuSorting),
    [temuProducts, temuSorting],
  );

  const filteredSortedTemuProducts = useMemo(() => {
    if (!temuFilter) return sortedTemuProducts;
    const lower = temuFilter.toLowerCase();
    return sortedTemuProducts.filter(
      (p) =>
        (p.title ?? '').toLowerCase().includes(lower) ||
        p.goodsId.toLowerCase().includes(lower) ||
        (p.brand ?? '').toLowerCase().includes(lower) ||
        (p.seller ?? '').toLowerCase().includes(lower),
    );
  }, [sortedTemuProducts, temuFilter]);

  const activeCount =
    engine === 'temu'
      ? (temuProducts?.length ?? 0)
      : (amazonProducts?.length ?? 0);

  const handleEngineSwitch = useCallback((nextEngine: 'amazon' | 'temu') => {
    setEngine(nextEngine);
    setSessionKey(null);
    setInitialSorting([]);
    setInitialGlobalFilter('');
  }, []);

  const handleModeSwitch = useCallback(
    async (mode: PreviewDisplayMode) => {
      if (mode === 'tab') return;
      await switchFromTabToPanelMode(mode, {
        engine,
        sessionKey,
        sorting: activeSorting,
        globalFilter: activeFilter,
      });
    },
    [engine, sessionKey, activeSorting, activeFilter],
  );

  const handleToggleTheme = useCallback(() => {
    const next: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    setResolvedTheme(next);
    void setThemePreference(next);
  }, [resolvedTheme]);

  return (
    <div
      data-testid="dedicated-preview-page"
      className="flex flex-col h-screen w-screen bg-surface text-ink overflow-hidden"
    >
      {/* Top workspace header */}
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 border-b border-hairline-soft bg-surface-card shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2.5 h-2.5 rounded-full bg-clay shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-sans text-sm font-semibold text-ink">
                PPHunt — Dedicated Preview Tab
              </h1>
              <span className="px-2 py-0.5 rounded-sm bg-surface border border-hairline-soft font-mono text-xs text-clay font-semibold">
                {formatNumber(activeCount)} item{activeCount !== 1 ? 's' : ''}
              </span>
            </div>
            <p className="font-serif text-xs text-ink-muted">
              Full-screen multi-sort workspace · Active sort order is preserved
              on export
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Engine Toggle */}
          <div
            role="group"
            aria-label="Active marketplace engine"
            className="inline-flex items-center rounded-sm border border-hairline bg-surface p-0.5"
          >
            <button
              type="button"
              data-testid="preview-page-engine-amazon"
              aria-pressed={engine === 'amazon'}
              onClick={() => handleEngineSwitch('amazon')}
              className={`px-2.5 py-1 rounded-sm font-sans text-xs font-medium transition-colors cursor-pointer ${
                engine === 'amazon'
                  ? 'bg-clay text-clay-ink font-semibold'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              Amazon
            </button>
            <button
              type="button"
              data-testid="preview-page-engine-temu"
              aria-pressed={engine === 'temu'}
              onClick={() => handleEngineSwitch('temu')}
              className={`px-2.5 py-1 rounded-sm font-sans text-xs font-medium transition-colors cursor-pointer ${
                engine === 'temu'
                  ? 'bg-clay text-clay-ink font-semibold'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              Temu
            </button>
          </div>

          {/* Session Selector */}
          <select
            aria-label="Select extraction session"
            data-testid="preview-page-session-select"
            value={sessionKey ?? ''}
            onChange={(e) => setSessionKey(e.target.value || null)}
            className="bg-surface border border-hairline rounded-sm text-ink font-sans text-xs px-2.5 py-1.5 focus:border-ink focus:outline-none transition-colors cursor-pointer max-w-[240px]"
          >
            <option value="">All Collected Products</option>
            {engine === 'amazon'
              ? (amazonHistory ?? []).map((entry) => (
                  <option
                    key={entry.id ?? entry.sessionKey}
                    value={entry.sessionKey ?? ''}
                  >
                    {entry.url || 'Amazon Extraction'} ({entry.collectedCount})
                  </option>
                ))
              : (temuHistory ?? []).map((entry) => (
                  <option
                    key={entry.id ?? entry.sessionId}
                    value={entry.sessionId ?? ''}
                  >
                    {entry.searchQuery || 'Temu Extraction'} (
                    {entry.collectedCount})
                  </option>
                ))}
          </select>

          {/* 3-Mode Switcher (Sidebar | Overview | Tab) */}
          <PreviewModeSwitcher
            currentMode="tab"
            onSelectMode={handleModeSwitch}
          />

          {/* Theme Toggle */}
          <button
            type="button"
            onClick={handleToggleTheme}
            aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            className="px-2.5 py-1.5 rounded-sm font-sans text-xs font-medium bg-surface border border-hairline text-ink-muted hover:text-ink transition-colors cursor-pointer"
          >
            {resolvedTheme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>

          {/* Export CTA */}
          <button
            type="button"
            data-testid="preview-page-export-button"
            disabled={activeCount === 0}
            onClick={() => setExportModalOpen(true)}
            className="px-3.5 py-1.5 rounded-sm font-sans text-xs font-semibold bg-clay text-clay-ink hover:bg-clay-active disabled:opacity-40 transition-colors cursor-pointer"
          >
            Export Current Extraction
          </button>
        </div>
      </header>

      {/* Main full-screen table area */}
      <main className="flex-1 min-h-0 min-w-0 p-5 flex flex-col overflow-hidden">
        <ErrorBoundary>
          {engine === 'temu' ? (
            <TemuProductTable
              key={`temu-${sessionKey ?? 'all'}`}
              fullHeight
              sessionId={sessionKey}
              initialSorting={initialSorting}
              initialGlobalFilter={initialGlobalFilter}
            />
          ) : (
            <AmazonProductTable
              key={`amazon-${sessionKey ?? 'all'}`}
              fullHeight
              sessionKey={sessionKey}
              initialSorting={initialSorting}
              initialGlobalFilter={initialGlobalFilter}
            />
          )}
        </ErrorBoundary>
      </main>

      {engine === 'temu' ? (
        <TemuExportModal
          isOpen={exportModalOpen}
          onClose={() => setExportModalOpen(false)}
          allProducts={sortedTemuProducts}
          selectedProducts={[]}
          filteredProducts={filteredSortedTemuProducts}
          hasFilter={!!temuFilter}
          hasSelection={false}
        />
      ) : (
        <AmazonExportModal
          isOpen={exportModalOpen}
          onClose={() => setExportModalOpen(false)}
          allProducts={sortedAmazonProducts}
          selectedProducts={[]}
          filteredProducts={filteredSortedAmazonProducts}
          hasFilter={!!amazonFilter}
          hasSelection={false}
        />
      )}

      <ToastContainer />
    </div>
  );
}
