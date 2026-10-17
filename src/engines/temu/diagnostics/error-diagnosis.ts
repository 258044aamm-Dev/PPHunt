import {
  redactSensitiveText,
  sanitizeUrlForDiagnostics,
} from '@/lib/diagnostics/error-diagnosis';
import type { ErrorCode, ErrorDiagnostic, SafeDiagnosticContext } from '@/types/common';
import type { TemuErrorCategory, TemuErrorInfo } from '../types';

export interface TemuDiagnoseContextInput {
  code?: string;
  category?: TemuErrorCategory;
  title?: string;
  remedy?: string;
  url?: string | null;
  pageType?: string | null;
  tabStatus?: string | null;
  preservedCount?: number;
  rawReason?: string | null;
  occurredAt?: string;
}

/**
 * Diagnoses Temu collection errors into both the rich `ErrorDiagnostic` format
 * (used by ErrorBanner / DiagnosticModal) and `TemuErrorInfo` (used by `TEMU_COLLECTION_ERROR`).
 */
export function diagnoseTemuError(
  errorInput: string | Error | Partial<TemuErrorInfo> | null | undefined,
  ctx: TemuDiagnoseContextInput = {}
): { errorInfo: TemuErrorInfo; diagnostic: ErrorDiagnostic } {
  const nowIso = ctx.occurredAt ?? new Date().toISOString();
  const sanitizedUrl = sanitizeUrlForDiagnostics(ctx.url);
  const preservedProductsCount =
    typeof ctx.preservedCount === 'number' && ctx.preservedCount >= 0
      ? ctx.preservedCount
      : 0;

  const rawMessage =
    typeof errorInput === 'string'
      ? errorInput
      : errorInput instanceof Error
        ? errorInput.message
        : typeof errorInput?.message === 'string'
          ? errorInput.message
          : '';
  const combinedText = `${rawMessage} ${ctx.rawReason ?? ''}`.trim();
  const cleanMessage = redactSensitiveText(rawMessage);

  const preservedNote =
    preservedProductsCount > 0
      ? `All ${preservedProductsCount} Temu product(s) collected so far remain safely saved.`
      : 'No previously saved Temu products were affected.';

  const buildSafeContext = (
    errorCode: ErrorCode,
    confidence: 'confirmed' | 'likely' | 'uncertain'
  ): SafeDiagnosticContext => ({
    errorCode,
    confidence,
    sanitizedUrl,
    pageType: ctx.pageType ?? null,
    tabStatus: ctx.tabStatus ?? null,
    preservedProductsCount,
    occurredAt: nowIso,
  });

  // 1. CAPTCHA / Security Verification
  if (
    ctx.code === 'TEMU_CAPTCHA_DETECTED' ||
    ctx.category === 'captcha' ||
    /captcha|verification|verify your identity|security verification|slider/i.test(
      combinedText
    )
  ) {
    const summary =
      cleanMessage ||
      'Temu displayed a security verification challenge that paused product collection.';
    return {
      errorInfo: {
        code: 'TEMU_CAPTCHA_DETECTED',
        category: 'captcha',
        title: 'Verification Required',
        message: summary,
        remedy:
          'Switch to the Temu browser tab, complete the security verification prompt, and click Resume in PPHunt.',
      },
      diagnostic: {
        code: 'CAPTCHA',
        category: 'Bot Verification Challenge',
        title: 'Temu Verification Required',
        confidence: 'confirmed',
        summary,
        rootCause:
          'Temu’s anti-bot security verification interrupted the page with a verification dialog before loading additional product cards.',
        whatIsKnown: `A verification challenge was detected on ${sanitizedUrl ?? 'the Temu tab'}. ${preservedNote}`,
        whatIsUncertain: null,
        potentialCauses: [
          'Rapid scrolling or repeated page loads triggered Temu’s verification dialog.',
          'Your current IP address, VPN, or shared network was flagged for verification.',
        ],
        troubleshootingSteps: [
          'Switch to the Temu browser tab and complete the verification prompt on the page.',
          'Confirm that Temu displays product cards normally.',
          'Click "Resume →" below to continue collecting from where the session paused.',
        ],
        recoveryAction: 'resume',
        safeContext: buildSafeContext('CAPTCHA', 'confirmed'),
      },
    };
  }

  // 2. Tab Closed Mid-Collection
  if (
    ctx.code === 'TEMU_TAB_CLOSED' ||
    ctx.code === 'TAB_CLOSED' ||
    /tab was closed|tab closed|no tab with id/i.test(combinedText)
  ) {
    const summary =
      cleanMessage ||
      'The Temu tab where extraction was running was closed before completion.';
    return {
      errorInfo: {
        code: 'TEMU_TAB_CLOSED',
        category: 'page_compatibility',
        title: 'Collection Tab Was Closed',
        message: summary,
        remedy:
          'Open a Temu search, category, or product detail tab to start a new extraction, or view saved products in History.',
      },
      diagnostic: {
        code: 'TAB_CLOSED',
        category: 'Tab Lifecycle Interruption',
        title: 'Temu Collection Tab Was Closed',
        confidence: 'confirmed',
        summary,
        rootCause:
          'The browser tab hosting the active Temu page was closed, terminating the page connection.',
        whatIsKnown: `The target Temu tab is no longer open. ${preservedNote}`,
        whatIsUncertain: null,
        potentialCauses: [
          'The Temu browser tab or window was closed manually during extraction.',
          'The browser unloaded or discarded the tab process.',
        ],
        troubleshootingSteps: [
          preservedProductsCount > 0
            ? `Open the "History" tab in PPHunt to preview or export the ${preservedProductsCount} saved Temu product(s).`
            : 'Open a new Temu search, category, or product detail tab in your browser.',
          'Navigate to a Temu listing page and click "Start" to begin a new extraction.',
        ],
        recoveryAction: 'dismiss',
        safeContext: buildSafeContext('TAB_CLOSED', 'confirmed'),
      },
    };
  }

  // 3. Access Restricted / Rate Limited
  if (
    ctx.code === 'TEMU_ACCESS_RESTRICTED' ||
    /restricted|unusual traffic|access denied|403|429|503/i.test(combinedText)
  ) {
    const summary =
      cleanMessage ||
      'Temu temporarily restricted access or rate-limited requests on this page.';
    return {
      errorInfo: {
        code: 'TEMU_ACCESS_RESTRICTED',
        category: 'page_compatibility',
        title: 'Access Temporarily Restricted',
        message: summary,
        remedy:
          'Wait 30–60 seconds, verify the Temu tab loads normally, and click Reload Tab & Retry.',
      },
      diagnostic: {
        code: 'BLOCKED',
        category: 'Page Access Restriction',
        title: 'Temu Access Temporarily Restricted',
        confidence: 'likely',
        summary,
        rootCause:
          'Temu returned a temporary traffic restriction or verification wall instead of product listings.',
        whatIsKnown: `An access restriction indicator was detected on ${sanitizedUrl ?? 'the Temu tab'}. ${preservedNote}`,
        whatIsUncertain:
          'Whether the restriction was triggered by temporary IP rate-limiting or a VPN/proxy connection.',
        potentialCauses: [
          'High-frequency scrolling or concurrent requests exceeded Temu’s rate threshold.',
          'Temporary security filtering on your current network or VPN.',
        ],
        troubleshootingSteps: [
          'Inspect the Temu browser tab and complete any verification prompt if shown.',
          'Wait 30–60 seconds, or switch Collection Mode to "Manual" to scroll at a slower pace.',
          'Click "Reload Tab & Retry" below to refresh the Temu listing.',
        ],
        recoveryAction: 'reload-and-retry',
        safeContext: buildSafeContext('BLOCKED', 'likely'),
      },
    };
  }

  // 4. Content Script Disconnected / Injection Blocked
  if (
    ctx.code === 'TEMU_SCRIPT_DISCONNECTED' ||
    ctx.code === 'SCRIPT_DISCONNECTED' ||
    /receiving end does not exist|message channel closed|message port closed|cannot access contents|script/i.test(
      combinedText
    )
  ) {
    const isPermissionError =
      /cannot access contents|permission|manifest/i.test(combinedText);
    const summary = isPermissionError
      ? 'Browser permissions prevented PPHunt from accessing the Temu tab.'
      : 'PPHunt lost its communication channel with the Temu page helper script.';
    return {
      errorInfo: {
        code: isPermissionError
          ? 'TEMU_INJECTION_BLOCKED'
          : 'TEMU_SCRIPT_DISCONNECTED',
        category: 'page_compatibility',
        title: isPermissionError
          ? 'Site Access Permission Needed'
          : 'Page Connection Interrupted',
        message: summary,
        remedy:
          'Reload the Temu tab and try again, or verify site access permissions for temu.com.',
      },
      diagnostic: {
        code: isPermissionError ? 'INJECTION_BLOCKED' : 'SCRIPT_DISCONNECTED',
        category: isPermissionError
          ? 'Site Access Permission Blocked'
          : 'Page Connection Interrupted',
        title: isPermissionError
          ? 'Site Access Permission Needed'
          : 'Temu Page Connection Interrupted',
        confidence: 'likely',
        summary,
        rootCause: isPermissionError
          ? 'The browser restricted script execution on this tab because site access permissions for temu.com are not granted.'
          : 'The page helper script in the Temu tab was disconnected or did not respond in time.',
        whatIsKnown: `Target tab (${sanitizedUrl ?? 'Temu tab'}, status: ${ctx.tabStatus ?? 'active'}) did not complete the collection handshake. ${preservedNote}`,
        whatIsUncertain: isPermissionError
          ? null
          : 'Whether the disconnection was caused by an extension reload, tab hibernation, or an in-page navigation event.',
        potentialCauses: [
          'The extension was installed, updated, or reloaded while the Temu tab was already open.',
          'The Temu tab was still loading or navigating when collection started.',
        ],
        troubleshootingSteps: [
          'Refresh the Temu browser tab and wait 2–3 seconds for product cards to load.',
          'Click "Start" or "Retry" in PPHunt to reconnect.',
        ],
        recoveryAction: 'reload-and-retry',
        safeContext: buildSafeContext(
          isPermissionError ? 'INJECTION_BLOCKED' : 'SCRIPT_DISCONNECTED',
          'likely'
        ),
      },
    };
  }

  // 5. Fallback
  const summary =
    cleanMessage ||
    'An unexpected error interrupted product extraction on the Temu page.';
  return {
    errorInfo: {
      code: ctx.code ?? 'TEMU_UNKNOWN_ERROR',
      category: ctx.category ?? 'unknown',
      title: ctx.title ?? 'Collection Error',
      message: summary,
      remedy:
        ctx.remedy ??
        'Check that the Temu tab shows product listings normally, refresh the tab if needed, and try again.',
    },
    diagnostic: {
      code: 'UNKNOWN',
      category: 'Uncertain Root Cause',
      title: ctx.title ?? 'Temu Collection Error',
      confidence: 'uncertain',
      summary,
      rootCause:
        'The exact root cause could not be determined automatically from the page signals.',
      whatIsKnown: `Extraction stopped on ${sanitizedUrl ?? 'the current Temu tab'}. ${preservedNote}`,
      whatIsUncertain:
        'Whether the interruption was caused by a temporary network glitch, a dynamic Temu layout update, or a tab navigation event.',
      potentialCauses: [
        'A temporary network or page-loading glitch interrupted Temu’s product feed.',
        'Temu dynamically updated the page state while extraction was running.',
      ],
      troubleshootingSteps: [
        'Check the Temu browser tab to confirm product listings are visible.',
        'Refresh the Temu tab and start extraction again.',
      ],
      recoveryAction: 'reload-and-retry',
      safeContext: buildSafeContext('UNKNOWN', 'uncertain'),
    },
  };
}
