import { useCallback, useMemo, useState } from 'react';
import { useCollectionStore } from '../store/collectionStore';
import {
  diagnoseError,
  formatDiagnosticReportForClipboard,
} from '@/lib/diagnostics/error-diagnosis';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';

/**
 * Comprehensive Error Diagnosis & Recovery Modal (SAD-137).
 *
 * Displays:
 * - Error category badge & diagnosis confidence indicator
 * - Clear explanation of what happened and preserved product count reassurance
 * - Identified Root Cause (or "What Is Known" & "What Remains Uncertain" when uncertain)
 * - Potential Causes & Numbered Actionable Troubleshooting Steps ("What To Do Next")
 * - Collapsible sanitized Diagnostic Details panel with "Copy Diagnostic Summary"
 * - Context-aware recovery actions: Resume →, Reload Tab & Retry, Retry, and Dismiss
 */
export function ErrorModal() {
  const status = useCollectionStore((s) => s.status);
  const errorMessage = useCollectionStore((s) => s.errorMessage);
  const errorDiagnostic = useCollectionStore((s) => s.errorDiagnostic);
  const collectedCount = useCollectionStore((s) => s.collectedCount);
  const setError = useCollectionStore((s) => s.setError);
  const setStatus = useCollectionStore((s) => s.setStatus);
  const activeTabId = useCollectionStore((s) => s.activeTabId);
  const activeTabUrl = useCollectionStore((s) => s.activeTabUrl);
  const isAmazonPage = useCollectionStore((s) => s.isAmazonPage);
  const collectionTabId = useCollectionStore((s) => s.collectionTabId);
  const collectionTabUrl = useCollectionStore((s) => s.collectionTabUrl);
  const currentSessionKey = useCollectionStore((s) => s.currentSessionKey);
  const mode = useCollectionStore((s) => s.mode);
  const targetCount = useCollectionStore((s) => s.targetCount);

  const [showDetails, setShowDetails] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  const diagnostic = useMemo(() => {
    if (!errorMessage && !errorDiagnostic) return null;
    if (errorDiagnostic) return errorDiagnostic;
    return diagnoseError(errorMessage, {
      url: collectionTabUrl ?? activeTabUrl,
      preservedCount: collectedCount,
    });
  }, [
    errorMessage,
    errorDiagnostic,
    collectionTabUrl,
    activeTabUrl,
    collectedCount,
  ]);

  const handleRetry = useCallback(() => {
    const tabId = collectionTabId ?? (isAmazonPage ? activeTabId : null);
    if (tabId === null) return;
    if (collectionTabId === null) {
      useCollectionStore.getState().setCollectionTab(tabId, activeTabUrl);
    }
    setError(null);
    setStatus('idle');
    browser.runtime.sendMessage({
      type: 'START_COLLECTION',
      payload: {
        mode,
        targetCount,
        tabId,
        ...(currentSessionKey ? { sessionKey: currentSessionKey } : {}),
      },
    });
    setStatus('collecting');
  }, [
    setError,
    setStatus,
    mode,
    targetCount,
    activeTabId,
    activeTabUrl,
    isAmazonPage,
    collectionTabId,
    currentSessionKey,
  ]);

  const handleReloadAndRetry = useCallback(() => {
    const tabId = collectionTabId ?? (isAmazonPage ? activeTabId : null);
    if (tabId === null) return;
    if (collectionTabId === null) {
      useCollectionStore.getState().setCollectionTab(tabId, activeTabUrl);
    }
    setError(null);
    setStatus('collecting');
    browser.runtime.sendMessage({
      type: 'RELOAD_AND_RETRY_COLLECTION',
      payload: {
        mode,
        targetCount,
        tabId,
        ...(currentSessionKey ? { sessionKey: currentSessionKey } : {}),
      },
    });
  }, [
    setError,
    setStatus,
    mode,
    targetCount,
    activeTabId,
    activeTabUrl,
    isAmazonPage,
    collectionTabId,
    currentSessionKey,
  ]);

  const handleResume = useCallback(() => {
    const tabId = collectionTabId ?? (isAmazonPage ? activeTabId : null);
    setError(null);
    if (tabId !== null) {
      if (collectionTabId === null) {
        useCollectionStore.getState().setCollectionTab(tabId, activeTabUrl);
      }
      browser.runtime.sendMessage({
        type: 'RESUME_COLLECTION',
        payload: { tabId },
      });
      setStatus('collecting');
    } else {
      setStatus('idle');
    }
  }, [
    setError,
    setStatus,
    collectionTabId,
    isAmazonPage,
    activeTabId,
    activeTabUrl,
  ]);

  const handleDismiss = useCallback(() => {
    setShowDetails(false);
    setCopiedSummary(false);
    setError(null);
  }, [setError]);

  // L-6 (SAD-194): trap focus while the modal is mounted (it renders null when
  // closed); Escape dismisses; focus returns to the trigger on unmount.
  const focusTrapRef = useFocusTrap<HTMLDivElement>(true, handleDismiss);

  const handleCopyDiagnostic = useCallback(async () => {
    if (!diagnostic) return;
    const text = formatDiagnosticReportForClipboard(diagnostic);
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2500);
    } catch {
      // Fallback if clipboard is unavailable
      setCopiedSummary(false);
    }
  }, [diagnostic]);

  if (status !== 'error' || !errorMessage || !diagnostic) return null;

  const isResumable =
    diagnostic.recoveryAction === 'resume' ||
    diagnostic.code === 'CAPTCHA' ||
    diagnostic.code === 'SIGN_IN';
  const showReloadAndRetry = diagnostic.recoveryAction === 'reload-and-retry';
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
        {...modalAriaProps('error-title')}
      >
        {/* Category Badge & Confidence Pill */}
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

        {/* Title */}
        <h3
          id="error-title"
          className="font-serif text-base font-semibold text-ink mb-1.5"
        >
          {diagnostic.title}
        </h3>

        {/* Summary */}
        <p className="font-serif text-sm text-ink mb-3 leading-relaxed">
          {diagnostic.summary}
        </p>

        {/* Preserved Products Reassurance Banner */}
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

        {/* Root Cause OR What Is Known / What Remains Uncertain */}
        <div className="space-y-2.5 mb-3 bg-canvas/70 border border-hairline-soft rounded-sm p-3">
          {diagnostic.confidence !== 'uncertain' ? (
            <div>
              <h4 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                Identified Root Cause
              </h4>
              <p className="font-serif text-xs text-ink leading-relaxed">
                {diagnostic.rootCause}
              </p>
            </div>
          ) : (
            <div>
              <h4 className="font-sans text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                What Is Known
              </h4>
              <p className="font-serif text-xs text-ink leading-relaxed">
                {diagnostic.whatIsKnown}
              </p>
            </div>
          )}

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

          {/* Potential Causes */}
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

        {/* Actionable Troubleshooting Steps (What You Can Do Next) */}
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

        {/* Collapsible Sanitized Diagnostic Details & Copy Summary */}
        <div className="mb-4 border-t border-hairline-soft pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowDetails((prev) => !prev)}
              className="font-sans text-[11px] text-ink-muted hover:text-ink underline underline-offset-2 transition-colors"
              aria-expanded={showDetails}
              aria-label="Toggle diagnostic details"
            >
              {showDetails
                ? 'Hide Diagnostic Details'
                : 'View Diagnostic Details'}
            </button>
            <button
              type="button"
              onClick={handleCopyDiagnostic}
              className="px-2.5 py-1 font-sans text-[11px] text-ink-muted hover:text-ink border border-hairline rounded-sm hover:bg-surface-soft transition-colors"
              aria-label="Copy diagnostic summary"
            >
              {copiedSummary ? 'Copied Summary' : 'Copy Diagnostic Summary'}
            </button>
          </div>

          {showDetails && (
            <div
              className="mt-2 p-2.5 rounded-sm bg-surface-soft border border-hairline-soft font-mono text-[11px] text-ink-muted space-y-1"
              data-testid="diagnostic-details-panel"
            >
              <div>
                <span className="text-ink-subtle">Code:</span>{' '}
                {diagnostic.safeContext.errorCode}
              </div>
              <div>
                <span className="text-ink-subtle">Page:</span>{' '}
                {diagnostic.safeContext.sanitizedUrl ?? 'N/A'}
              </div>
              <div>
                <span className="text-ink-subtle">Tab State:</span>{' '}
                {diagnostic.safeContext.tabStatus ?? 'active'}
              </div>
              <div>
                <span className="text-ink-subtle">Saved Products:</span>{' '}
                {savedProductsCount}
              </div>
            </div>
          )}
        </div>

        {/* Context-Aware Recovery Actions */}
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={handleDismiss}
            className="px-3.5 py-2 font-sans text-xs text-ink-muted hover:text-ink border border-hairline rounded-sm hover:bg-surface-soft transition-colors"
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
          {isResumable && (
            <button
              type="button"
              onClick={handleResume}
              className="px-3.5 py-2 font-sans text-xs text-clay font-medium border border-clay/50 rounded-sm hover:bg-clay/10 transition-colors"
              aria-label="Resume collection after solving issue"
            >
              Resume →
            </button>
          )}
          {showReloadAndRetry && (
            <button
              type="button"
              onClick={handleReloadAndRetry}
              className="px-3.5 py-2 font-sans text-xs text-clay font-medium border border-clay/50 rounded-sm hover:bg-clay/10 transition-colors"
              aria-label="Reload tab and retry collection"
            >
              Reload Tab & Retry
            </button>
          )}
          <button
            type="button"
            onClick={handleRetry}
            className="px-3.5 py-2 font-sans text-xs bg-clay text-clay-ink font-medium rounded-sm hover:bg-clay-active transition-colors"
            aria-label="Retry collection"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
