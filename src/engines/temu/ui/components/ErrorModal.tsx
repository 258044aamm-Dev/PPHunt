import { useCallback, useMemo, useState } from 'react';
import { formatDiagnosticReportForClipboard } from '@/lib/diagnostics/error-diagnosis';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import { diagnoseTemuError } from '../../diagnostics/error-diagnosis';
import { useTemuCollectionStore } from '../store/collectionStore';

export function TemuErrorModal() {
  const status = useTemuCollectionStore((s) => s.status);
  const errorMessage = useTemuCollectionStore((s) => s.errorMessage);
  const errorDiagnostic = useTemuCollectionStore((s) => s.errorDiagnostic);
  const collectedCount = useTemuCollectionStore((s) => s.collectedCount);
  const setError = useTemuCollectionStore((s) => s.setError);
  const setStatus = useTemuCollectionStore((s) => s.setStatus);
  const activeTabId = useTemuCollectionStore((s) => s.activeTabId);
  const activeTabUrl = useTemuCollectionStore((s) => s.activeTabUrl);
  const isTemuPage = useTemuCollectionStore((s) => s.isTemuPage);
  const collectionTabId = useTemuCollectionStore((s) => s.collectionTabId);
  const collectionTabUrl = useTemuCollectionStore((s) => s.collectionTabUrl);
  const currentSessionId = useTemuCollectionStore((s) => s.currentSessionId);
  const mode = useTemuCollectionStore((s) => s.mode);
  const targetCount = useTemuCollectionStore((s) => s.targetCount);

  const [showDetails, setShowDetails] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  const diagnostic = useMemo(() => {
    if (!errorMessage && !errorDiagnostic) return null;
    if (errorDiagnostic) return errorDiagnostic;
    return diagnoseTemuError(errorMessage, {
      url: collectionTabUrl ?? activeTabUrl,
      preservedCount: collectedCount,
    }).diagnostic;
  }, [
    errorMessage,
    errorDiagnostic,
    collectionTabUrl,
    activeTabUrl,
    collectedCount,
  ]);

  const handleRetry = useCallback(() => {
    const tabId = collectionTabId ?? (isTemuPage ? activeTabId : null);
    if (tabId === null) return;
    if (collectionTabId === null) {
      useTemuCollectionStore.getState().setCollectionTab(tabId, activeTabUrl);
    }
    setError(null);
    setStatus('collecting');
    browser.runtime
      .sendMessage({
        type: 'TEMU_START_COLLECTION',
        payload: {
          mode,
          targetCount,
          tabId,
          ...(currentSessionId ? { sessionId: currentSessionId } : {}),
        },
      })
      .catch(() => {});
  }, [
    setError,
    setStatus,
    mode,
    targetCount,
    activeTabId,
    activeTabUrl,
    isTemuPage,
    collectionTabId,
    currentSessionId,
  ]);

  const handleResume = useCallback(() => {
    const tabId = collectionTabId ?? (isTemuPage ? activeTabId : null);
    setError(null);
    if (tabId !== null) {
      if (collectionTabId === null) {
        useTemuCollectionStore.getState().setCollectionTab(tabId, activeTabUrl);
      }
      browser.runtime
        .sendMessage({
          type: 'TEMU_RESUME_COLLECTION',
          payload: { tabId },
        })
        .catch(() => {});
      setStatus('collecting');
    } else {
      setStatus('idle');
    }
  }, [
    setError,
    setStatus,
    collectionTabId,
    isTemuPage,
    activeTabId,
    activeTabUrl,
  ]);

  const handleDismiss = useCallback(() => {
    setShowDetails(false);
    setCopiedSummary(false);
    setError(null);
  }, [setError]);

  const focusTrapRef = useFocusTrap<HTMLDivElement>(true, handleDismiss);

  const handleCopyDiagnostic = useCallback(async () => {
    if (!diagnostic) return;
    const text = formatDiagnosticReportForClipboard(diagnostic);
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2500);
    } catch {
      setCopiedSummary(false);
    }
  }, [diagnostic]);

  if (status !== 'error' || !errorMessage || !diagnostic) return null;

  const isResumable =
    diagnostic.recoveryAction === 'resume' || diagnostic.code === 'CAPTCHA';
  const savedProductsCount = Math.max(
    collectedCount,
    diagnostic.safeContext.preservedProductsCount ?? 0
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60 p-3">
      <div
        ref={focusTrapRef}
        tabIndex={-1}
        className="bg-surface border border-hairline-soft rounded-md p-5 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-lg"
        {...modalAriaProps('temu-error-title')}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[11px] font-sans font-medium bg-clay/15 text-clay border border-clay/30">
            {diagnostic.category}
          </span>
          <span
            className="font-mono text-[10px] uppercase tracking-wider text-ink-subtle"
            data-testid="diagnostic-confidence"
          >
            {diagnostic.confidence === 'confirmed'
              ? 'Confirmed Cause'
              : diagnostic.confidence === 'likely'
                ? 'Likely Cause'
                : 'Uncertain Cause'}
          </span>
        </div>

        <h3
          id="temu-error-title"
          className="font-serif text-base font-semibold text-ink mb-1.5"
        >
          {diagnostic.title}
        </h3>

        <p className="font-serif text-sm text-ink mb-3 leading-relaxed">
          {diagnostic.summary}
        </p>

        {savedProductsCount > 0 && (
          <div
            className="mb-3 px-3 py-2 rounded-sm bg-surface-soft border border-hairline-soft text-xs font-sans text-ink-muted"
            data-testid="preserved-products-banner"
          >
            <strong className="text-ink">{savedProductsCount}</strong> collected
            product{savedProductsCount === 1 ? '' : 's'} safely preserved in
            this session.
          </div>
        )}

        <div className="space-y-2.5 mb-3 bg-canvas/70 border border-hairline-soft rounded-sm p-3">
          <div>
            <h4 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
              {diagnostic.confidence !== 'uncertain'
                ? 'Identified Root Cause'
                : 'What Is Known'}
            </h4>
            <p className="font-serif text-xs text-ink leading-relaxed">
              {diagnostic.confidence !== 'uncertain'
                ? diagnostic.rootCause
                : diagnostic.whatIsKnown}
            </p>
          </div>

          {diagnostic.whatIsUncertain && (
            <div className="pt-2 border-t border-hairline-soft">
              <h4 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                What Remains Uncertain
              </h4>
              <p className="font-serif text-xs text-ink-muted leading-relaxed">
                {diagnostic.whatIsUncertain}
              </p>
            </div>
          )}

          {diagnostic.potentialCauses.length > 0 && (
            <div className="pt-2 border-t border-hairline-soft">
              <h4 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                Potential Causes
              </h4>
              <ul className="list-disc list-inside space-y-1">
                {diagnostic.potentialCauses.map((cause, idx) => (
                  <li
                    key={idx}
                    className="font-serif text-xs text-ink-muted leading-relaxed"
                  >
                    {cause}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {diagnostic.troubleshootingSteps.length > 0 && (
          <div className="mb-3">
            <h4 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
              What To Do Next
            </h4>
            <ol className="space-y-1.5">
              {diagnostic.troubleshootingSteps.map((step, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 font-serif text-xs text-ink leading-relaxed"
                >
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-clay/15 text-clay font-mono text-[10px] font-semibold shrink-0 mt-0.5">
                    {idx + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mb-4 border-t border-hairline-soft pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowDetails((prev) => !prev)}
              className="font-sans text-[11px] text-ink-muted hover:text-ink underline underline-offset-2 transition-colors"
              aria-expanded={showDetails}
            >
              {showDetails
                ? 'Hide Diagnostic Details'
                : 'View Diagnostic Details'}
            </button>
            <button
              type="button"
              onClick={handleCopyDiagnostic}
              className="px-2.5 py-1 font-sans text-[11px] text-ink-muted hover:text-ink border border-hairline rounded-sm hover:bg-surface-soft transition-colors"
            >
              {copiedSummary ? 'Copied Summary' : 'Copy Diagnostic Summary'}
            </button>
          </div>

          {showDetails && (
            <div className="mt-2 p-2.5 rounded-sm bg-surface-soft border border-hairline-soft font-mono text-[11px] text-ink-muted space-y-1">
              <div>
                <span className="text-ink-subtle">Code:</span>{' '}
                {diagnostic.safeContext.errorCode}
              </div>
              <div>
                <span className="text-ink-subtle">Page:</span>{' '}
                {diagnostic.safeContext.sanitizedUrl ?? 'N/A'}
              </div>
              <div>
                <span className="text-ink-subtle">Saved Products:</span>{' '}
                {savedProductsCount}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={handleDismiss}
            className="px-3.5 py-2 font-sans text-xs text-ink-muted hover:text-ink border border-hairline rounded-sm hover:bg-surface-soft transition-colors"
          >
            Dismiss
          </button>
          {isResumable && (
            <button
              type="button"
              onClick={handleResume}
              className="px-3.5 py-2 font-sans text-xs text-clay font-medium border border-clay/50 rounded-sm hover:bg-clay/10 transition-colors"
            >
              Resume →
            </button>
          )}
          <button
            type="button"
            onClick={handleRetry}
            className="px-3.5 py-2 font-sans text-xs bg-clay text-clay-ink font-medium rounded-sm hover:bg-clay-active transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
