import { useState, useCallback } from 'react';
import { formatNumber } from '@/lib/utils/formatters';
import { setOverlayFullWidthMode } from '@/lib/overlay/openOverlay';
import {
  TEMU_TARGET_MAX,
  TEMU_TARGET_MIN,
  TEMU_TARGET_PRESETS,
} from '../../constants/defaults';
import { addTemuHistory } from '../../db/history';
import {
  createTemuSession,
  getTemuSession,
  updateTemuSessionStatus,
} from '../../db/sessions';
import type { TemuCollectionMode, TemuCollectionStatus } from '../../types';
import { refreshTemuActiveTab } from '../hooks/useTemuActiveTab';
import { useTemuCollectionStore } from '../store/collectionStore';
import { useTemuUIStore } from '../store/uiStore';

const STATUS_CONFIG: Record<
  TemuCollectionStatus,
  { label: string; color: string }
> = {
  idle: { label: 'Ready', color: 'bg-sage' },
  collecting: { label: 'Collecting', color: 'bg-moss animate-pulse' },
  paused: { label: 'Paused', color: 'bg-golden' },
  completed: { label: 'Complete', color: 'bg-moss' },
  stopped: { label: 'Stopped', color: 'bg-golden' },
  error: { label: 'Error', color: 'bg-crimson' },
};

type ControlAction = 'start' | 'pause' | 'resume' | 'stop';

interface ControlButton {
  action: ControlAction;
  label: string;
  icon: string;
  isPrimary: boolean;
  isVisible: (status: TemuCollectionStatus) => boolean;
  isEnabled: (status: TemuCollectionStatus, isTemu: boolean) => boolean;
}

const CONTROLS: ControlButton[] = [
  {
    action: 'start',
    label: 'Start',
    icon: '▶',
    isPrimary: true,
    isVisible: (s) =>
      s === 'idle' || s === 'completed' || s === 'stopped' || s === 'error',
    isEnabled: (s, isTemu) =>
      isTemu &&
      (s === 'idle' || s === 'completed' || s === 'stopped' || s === 'error'),
  },
  {
    action: 'pause',
    label: 'Pause',
    icon: '⏸',
    isPrimary: false,
    isVisible: (s) => s === 'collecting',
    isEnabled: (s) => s === 'collecting',
  },
  {
    action: 'resume',
    label: 'Resume',
    icon: '▶',
    isPrimary: true,
    isVisible: (s) => s === 'paused',
    isEnabled: (s) => s === 'paused',
  },
  {
    action: 'stop',
    label: 'Stop',
    icon: '⏹',
    isPrimary: false,
    isVisible: (s) => s === 'collecting' || s === 'paused',
    isEnabled: (s) => s === 'collecting' || s === 'paused',
  },
];

export function TemuCollectTab() {
  const isTemuPage = useTemuCollectionStore((s) => s.isTemuPage);
  const mode = useTemuCollectionStore((s) => s.mode);
  const setMode = useTemuCollectionStore((s) => s.setMode);
  const status = useTemuCollectionStore((s) => s.status);
  const targetCount = useTemuCollectionStore((s) => s.targetCount);
  const setTarget = useTemuCollectionStore((s) => s.setTarget);
  const collected = useTemuCollectionStore((s) => s.collectedCount);
  const currentSessionId = useTemuCollectionStore((s) => s.currentSessionId);
  const activeTabId = useTemuCollectionStore((s) => s.activeTabId);
  const collectionTabId = useTemuCollectionStore((s) => s.collectionTabId);

  const [customValue, setCustomValue] = useState('');
  const isDisabled = status === 'collecting' || status === 'paused';

  const handleRefreshState = async () => {
    const store = useTemuCollectionStore.getState();
    const uiStore = useTemuUIStore.getState();
    uiStore.closeCompletionDialog();
    uiStore.closePreviewOverlay();
    setOverlayFullWidthMode(false);
    store.prepareForNewExtraction();
    await refreshTemuActiveTab();
  };

  const handleContinueSession = async () => {
    await refreshTemuActiveTab();
    const store = useTemuCollectionStore.getState();
    const uiStore = useTemuUIStore.getState();
    if (
      !store.isTemuPage ||
      store.activeTabId === null ||
      !store.activeTabUrl
    ) {
      return;
    }

    const tabId = store.activeTabId;
    const url = store.activeTabUrl;

    uiStore.closeCompletionDialog();
    uiStore.closePreviewOverlay();
    setOverlayFullWidthMode(false);

    const stepIncrement = store.mode === 'manual' ? 10 : 50;
    const effectiveTarget =
      store.collectedCount >= store.targetCount
        ? Math.min(
            TEMU_TARGET_MAX,
            Math.max(store.targetCount, store.collectedCount + stepIncrement),
          )
        : store.targetCount;

    if (effectiveTarget !== store.targetCount) {
      store.setTarget(effectiveTarget);
    }

    const resolvedSessionId =
      store.currentSessionId ??
      (await createTemuSession(tabId, url, store.mode, effectiveTarget));

    store.setCollectionTab(tabId, url);
    store.setCurrentSessionId(resolvedSessionId);
    store.setError(null);
    store.setStatus('collecting');

    await updateTemuSessionStatus(resolvedSessionId, 'collecting', {
      collected: store.collectedCount,
      target: effectiveTarget,
    }).catch(() => {});

    browser.runtime
      .sendMessage({
        type: 'TEMU_START_COLLECTION',
        payload: {
          mode: store.mode,
          targetCount: effectiveTarget,
          tabId,
          sessionId: resolvedSessionId,
        },
      })
      .catch(() => {});
  };

  const handleOpenPreview = () => {
    const uiStore = useTemuUIStore.getState();
    uiStore.openPreviewOverlay(
      currentSessionId ?? uiStore.selectedSessionId ?? null,
    );
  };

  const handleChipClick = useCallback(
    (count: number) => {
      setTarget(count);
      setCustomValue('');
    },
    [setTarget]
  );

  const handleCustomApply = useCallback(() => {
    const parsed = parseInt(customValue, 10);
    if (
      !isNaN(parsed) &&
      parsed >= TEMU_TARGET_MIN &&
      parsed <= TEMU_TARGET_MAX
    ) {
      setTarget(parsed);
    }
  }, [customValue, setTarget]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCustomApply();
      if (e.key === 'Escape') {
        setCustomValue('');
        (e.target as HTMLInputElement).blur();
      }
    },
    [handleCustomApply]
  );

  const handleAction = async (action: ControlAction) => {
    const store = useTemuCollectionStore.getState();
    const uiStore = useTemuUIStore.getState();

    switch (action) {
      case 'start': {
        if (
          !store.isTemuPage ||
          store.activeTabId === null ||
          !store.activeTabUrl
        ) {
          return;
        }
        const tabId = store.activeTabId;
        const url = store.activeTabUrl;

        uiStore.closeCompletionDialog();
        uiStore.closePreviewOverlay();
        setOverlayFullWidthMode(false);

        const sessionId = await createTemuSession(
          tabId,
          url,
          mode,
          targetCount
        );
        store.setCollectionTab(tabId, url);
        store.setCurrentSessionId(sessionId);
        store.setError(null);

        browser.runtime
          .sendMessage({
            type: 'TEMU_START_COLLECTION',
            payload: { mode, targetCount, tabId, sessionId },
          })
          .catch(() => {});
        store.setStatus('collecting');
        store.setCollectedCount(0);
        break;
      }

      case 'pause':
        if (store.collectionTabId === null) return;
        browser.runtime
          .sendMessage({
            type: 'TEMU_PAUSE_COLLECTION',
            payload: { tabId: store.collectionTabId },
          })
          .catch(() => {});
        store.setStatus('paused');
        if (store.currentSessionId) {
          await updateTemuSessionStatus(store.currentSessionId, 'paused', {
            collected: store.collectedCount,
            target: targetCount,
          });
        }
        break;

      case 'resume':
        if (store.collectionTabId === null) return;
        browser.runtime
          .sendMessage({
            type: 'TEMU_RESUME_COLLECTION',
            payload: { tabId: store.collectionTabId },
          })
          .catch(() => {});
        store.setStatus('collecting');
        if (store.currentSessionId) {
          await updateTemuSessionStatus(store.currentSessionId, 'collecting', {
            collected: store.collectedCount,
            target: targetCount,
          });
        }
        break;

      case 'stop': {
        if (store.collectionTabId === null) return;
        const stoppedSessionId = store.currentSessionId;
        browser.runtime
          .sendMessage({
            type: 'TEMU_STOP_COLLECTION',
            payload: { tabId: store.collectionTabId },
          })
          .catch(() => {});
        store.setStatus('completed');
        uiStore.openCompletionDialog(stoppedSessionId);

        if (stoppedSessionId) {
          const now = new Date().toISOString();
          const session = await getTemuSession(stoppedSessionId);
          await updateTemuSessionStatus(stoppedSessionId, 'completed', {
            collected: store.collectedCount,
            target: targetCount,
          });
          await addTemuHistory({
            sessionId: stoppedSessionId,
            url: store.collectionTabUrl ?? '',
            searchQuery: session?.searchQuery ?? null,
            pageType: session?.pageType ?? 'search',
            mode,
            targetCount,
            collectedCount: store.collectedCount,
            startedAt: session?.startedAt ?? now,
            completedAt: now,
            status: 'completed',
          });
        }
        store.setCollectionTab(null, null);
        break;
      }
    }
  };

  const { label: statusLabel, color: statusColor } = STATUS_CONFIG[status];
  const percent =
    targetCount > 0
      ? Math.min(100, Math.round((collected / targetCount) * 100))
      : 0;
  const barColor = status === 'error' ? 'bg-crimson' : 'bg-clay';

  const modeOptions: {
    key: TemuCollectionMode;
    label: string;
    desc: string;
  }[] = [
    { key: 'manual', label: 'Manual', desc: 'Passive — collects as you scroll' },
    { key: 'automatic', label: 'Automatic', desc: 'Auto-scrolls the page' },
  ];

  return (
    <div className="space-y-3">
      {!isTemuPage && (
        <div className="bg-golden/15 border border-golden/40 rounded-md p-3.5">
          <p className="font-sans text-xs font-semibold text-ink">
            ⚠ Not on Temu
          </p>
          <p className="font-serif text-xs text-ink-muted mt-1 leading-relaxed">
            Navigate to a Temu search, product, or category page to start
            collecting.
          </p>
        </div>
      )}

      {/* Collection Mode */}
      <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
        <h2 className="font-serif text-sm font-semibold text-ink mb-3">
          Collection Mode
        </h2>
        <div className="flex gap-2">
          {modeOptions.map(({ key, label, desc }) => {
            const isActive = mode === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                disabled={isDisabled}
                title={desc}
                className={`
                  flex-1 px-4 py-2 font-sans text-sm rounded-sm border transition-colors
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                  ${
                    isActive
                      ? 'bg-surface text-ink border-ink font-medium'
                      : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                  }
                  ${
                    isDisabled
                      ? 'opacity-50 cursor-not-allowed'
                      : 'cursor-pointer'
                  }
                `}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Target Products */}
      <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
        <h2 className="font-serif text-sm font-semibold text-ink mb-3">
          Target Products
        </h2>

        <div className="flex gap-2 mb-3 flex-wrap">
          {Array.from(TEMU_TARGET_PRESETS).map((count) => {
            const isActive = targetCount === count && customValue === '';
            return (
              <button
                key={count}
                type="button"
                onClick={() => handleChipClick(count)}
                disabled={isDisabled}
                className={`
                  px-3 py-1.5 font-mono text-xs rounded-sm border transition-colors
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                  ${
                    isActive
                      ? 'bg-surface text-ink border-ink font-semibold'
                      : 'bg-surface-soft/60 text-ink-muted border-hairline hover:text-ink hover:bg-surface-soft'
                  }
                  ${
                    isDisabled
                      ? 'opacity-50 cursor-not-allowed'
                      : 'cursor-pointer'
                  }
                `}
              >
                {count}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2.5">
          <label
            htmlFor="temu-custom-target-input"
            className="font-sans text-xs font-medium text-ink-muted shrink-0"
          >
            Custom:
          </label>
          <input
            id="temu-custom-target-input"
            type="number"
            min={TEMU_TARGET_MIN}
            max={TEMU_TARGET_MAX}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onBlur={handleCustomApply}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            placeholder={`${targetCount}`}
            className={`
              bg-surface border border-hairline rounded-sm text-ink placeholder:text-ink-subtle font-mono text-xs
              px-3 py-1.5 w-24 focus:border-ink focus:outline-none transition-colors
              ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          />
        </div>
      </div>

      {/* Status section */}
      <div className="bg-surface-card border border-hairline-soft rounded-md p-4">
        <div
          className="flex items-center gap-2 mb-3"
          role="status"
          aria-label={`Status: ${statusLabel}`}
        >
          <span
            className={`w-2.5 h-2.5 rounded-full ${statusColor} shrink-0`}
            aria-hidden="true"
          />
          <span className="font-serif text-sm font-medium text-ink">
            {statusLabel}
          </span>
        </div>

        <div className="flex items-center justify-between mb-2">
          <p className="font-mono text-xs text-ink tabular-nums">
            <span className="font-semibold">{formatNumber(collected)}</span>
            <span className="text-ink-muted">
              {' / '}
              {formatNumber(targetCount)}
            </span>
          </p>
          {isDisabled && (
            <p className="font-mono text-xs text-ink-muted tabular-nums">
              {percent}%
            </p>
          )}
        </div>

        <div
          className="w-full h-2 bg-surface-soft border border-hairline-soft rounded-full overflow-hidden"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Collection progress: ${percent}%`}
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${barColor}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-2.5 flex-wrap items-center pt-1">
        {CONTROLS.filter((c) => c.isVisible(status)).map((ctrl) => {
          const enabled =
            ctrl.isEnabled(status, isTemuPage) &&
            (ctrl.action === 'start'
              ? activeTabId !== null
              : collectionTabId !== null);
          return (
            <button
              key={ctrl.action}
              type="button"
              onClick={() => handleAction(ctrl.action)}
              disabled={!enabled}
              className={`
                px-5 py-2.5 font-sans text-sm rounded-sm transition-colors
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                ${
                  ctrl.isPrimary
                    ? 'bg-clay text-clay-ink font-medium hover:bg-clay-active border border-transparent'
                    : 'bg-surface text-ink border border-hairline hover:bg-surface-soft'
                }
                ${!enabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {ctrl.icon} {ctrl.label}
            </button>
          );
        })}

        {!isDisabled && collected > 0 && (
          <>
            <button
              type="button"
              onClick={() => void handleContinueSession()}
              disabled={!isTemuPage || activeTabId === null}
              aria-label="Collect More"
              title="Continue collecting products into the current session without losing previously extracted data"
              className={`
                px-3.5 py-2.5 font-sans text-sm rounded-sm border transition-colors
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay
                bg-surface text-ink border-hairline hover:bg-surface-soft
                ${!isTemuPage || activeTabId === null ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              + Collect More
            </button>
            <button
              type="button"
              onClick={handleOpenPreview}
              aria-label="Preview collected products"
              title="Reopen preview for current extraction"
              className="px-3.5 py-2.5 font-sans text-sm rounded-sm bg-surface text-ink border border-hairline hover:bg-surface-soft transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay"
            >
              👁 Preview ({collected})
            </button>
          </>
        )}

        {!isDisabled && (
          <button
            type="button"
            onClick={() => void handleRefreshState()}
            aria-label="Refresh extraction state"
            title="Refresh active tab & reset extraction progress (saved products remain in History)"
            className="px-3 py-2.5 font-sans text-sm rounded-sm bg-surface text-ink-muted hover:text-ink border border-hairline hover:bg-surface-soft transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-clay"
          >
            ↻ Refresh
          </button>
        )}
      </div>
    </div>
  );
}
