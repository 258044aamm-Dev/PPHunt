import type {
  AmazonErrorCode,
  ErrorDiagnostic,
  SafeDiagnosticContext,
} from '../types';

export type DiagnosticConfidence = 'confirmed' | 'likely' | 'uncertain';
export type DiagnosticRecoveryAction =
  | 'resume'
  | 'reload-and-retry'
  | 'retry'
  | 'switch-tab'
  | 'dismiss';

export interface DiagnosticInputOptions {
  code?: AmazonErrorCode | string;
  url?: string | null;
  pageType?: string | null;
  tabStatus?: string | null;
  preservedCount?: number;
  driftReasons?: string[];
}

export type ErrorDiagnosisReport = ErrorDiagnostic;

/**
 * Strips query parameters, hashes, session IDs, and internal browser URL details
 * so diagnostic reports never leak tracking or user session tokens.
 */
export function sanitizeUrlForDiagnostics(
  rawUrl: string | null | undefined,
): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return 'unknown-url';
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) return 'unknown-url';

  const browserSchemeMatch =
    /^(chrome|edge|about|moz-extension|chrome-extension):/i.exec(trimmed);
  if (browserSchemeMatch?.[1]) {
    const scheme = browserSchemeMatch[1].toLowerCase();
    return `${scheme}://[browser-page]`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${parsed.protocol}//[browser-page]`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return trimmed.split(/[?#]/)[0] || 'unknown-url';
  }
}

/**
 * Redacts query parameters on embedded URLs, extension bundle URLs, stack trace file paths,
 * email addresses, and sensitive session/token key-value pairs from free-form error text.
 */
export function redactSensitiveText(
  rawText: string | null | undefined,
): string {
  if (!rawText || typeof rawText !== 'string') return '';

  let text = rawText;

  text = text.replace(
    /(?:chrome-extension|moz-extension):\/\/[^\s)'"]+/gi,
    '[extension-resource]',
  );

  text = text.replace(/https?:\/\/[^\s)'"]+/gi, (matchedUrl) =>
    sanitizeUrlForDiagnostics(matchedUrl),
  );

  text = text.replace(
    /(?:\/home\/|\/Users\/|\/var\/|\/tmp\/|[A-Z]:\\)[^\s):'"]+(?::\d+(?::\d+)?)?/g,
    '[local-path]',
  );

  text = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[redacted-email]',
  );

  text = text.replace(
    /\b(?:session[-_]?id|token|auth|secret|api[-_]?key|promotionsSearchLastSeenAsin|promotionsSearchStartIndex)\s*=\s*[^\s&)'"]+/gi,
    '[redacted-param]',
  );

  return text.replace(/\s+/g, ' ').trim();
}

function classifyErrorCode(
  rawMessage: string,
  explicitCode?: string,
): AmazonErrorCode {
  if (explicitCode) {
    const upper = explicitCode.toUpperCase();
    if (
      upper === 'CAPTCHA' ||
      upper === 'RATE_LIMITED' ||
      upper === 'BLOCKED' ||
      upper === 'SIGN_IN' ||
      upper === 'SCRIPT_DISCONNECTED' ||
      upper === 'INJECTION_BLOCKED' ||
      upper === 'TAB_CLOSED' ||
      upper === 'NOT_AMAZON' ||
      upper === 'UNKNOWN'
    ) {
      return upper as AmazonErrorCode;
    }
  }

  const msg = rawMessage.toLowerCase();
  if (
    msg.includes('captcha') ||
    msg.includes('not a robot') ||
    msg.includes('characters you see')
  ) {
    return 'CAPTCHA';
  }
  if (
    msg.includes('503') ||
    msg.includes('rate limit') ||
    msg.includes('throttl') ||
    msg.includes('too many requests')
  ) {
    return 'RATE_LIMITED';
  }
  if (
    msg.includes('dogs of amazon') ||
    msg.includes('api-services-support') ||
    msg.includes('temporarily blocked')
  ) {
    return 'BLOCKED';
  }
  if (msg.includes('sign-in') || msg.includes('sign in')) {
    return 'SIGN_IN';
  }
  if (
    msg.includes('receiving end does not exist') ||
    msg.includes('message port closed') ||
    msg.includes('communication channel') ||
    msg.includes('helper script')
  ) {
    return 'SCRIPT_DISCONNECTED';
  }
  if (msg.includes('tab was closed') || msg.includes('tab closed')) {
    return 'TAB_CLOSED';
  }
  if (msg.includes('not on amazon') || msg.includes('not an amazon')) {
    return 'NOT_AMAZON';
  }

  return 'UNKNOWN';
}

/**
 * Produces a structured, privacy-safe diagnostic report with root cause confidence,
 * what is known, what remains uncertain, potential causes, and step-by-step recovery guidance.
 */
export function diagnoseError(
  rawMessage: string | null | undefined,
  options: DiagnosticInputOptions = {},
): ErrorDiagnostic {
  const messageText = rawMessage ?? 'An unexpected collection error occurred.';
  const sanitizedUrl = sanitizeUrlForDiagnostics(options.url);
  const sanitizedMessage = redactSensitiveText(messageText);
  const preservedCount = Math.max(0, options.preservedCount ?? 0);
  const tabStatus = options.tabStatus ?? 'complete';
  const code = classifyErrorCode(messageText, options.code);
  const nowIso = new Date().toISOString();

  const preservedSentence =
    preservedCount > 0
      ? `All ${preservedCount} product(s) collected so far remain safely saved.`
      : 'No previously collected products were lost.';

  const buildSafeContext = (
    confidence: DiagnosticConfidence,
  ): SafeDiagnosticContext => ({
    errorCode: code,
    confidence,
    sanitizedUrl,
    pageType: options.pageType ?? null,
    tabStatus,
    preservedProductsCount: preservedCount,
    preservedCount,
    sanitizedMessage,
    occurredAt: nowIso,
    timestamp: nowIso,
  });

  switch (code) {
    case 'CAPTCHA':
      return {
        code,
        category: 'Bot Verification Challenge',
        title: 'CAPTCHA Detected',
        confidence: 'confirmed',
        confidenceLabel: 'Confirmed Cause',
        summary:
          sanitizedMessage ||
          'Amazon displayed a verification challenge that paused product collection.',
        message: sanitizedMessage,
        recoveryAction: 'resume',
        rootCause:
          'Amazon presented an anti-bot verification challenge before serving additional product cards.',
        whatIsKnown: `Collection paused on ${sanitizedUrl} because a CAPTCHA form was detected. ${preservedSentence}`,
        whatIsUncertain: null,
        potentialCauses: [
          'Rapid automated scrolling or high request frequency from your current network IP.',
          'Amazon security checkpoint triggered on this marketplace domain.',
        ],
        troubleshootingSteps: [
          'Switch to the open Amazon tab in your browser.',
          'Complete the CAPTCHA verification challenge shown on the page.',
          'Wait for the product listing to reload, then click "Resume" below to continue without losing progress.',
        ],
        safeContext: buildSafeContext('confirmed'),
      };

    case 'RATE_LIMITED':
      return {
        code,
        category: 'Rate Limiting',
        title: 'Amazon Rate Limit / 503 Response',
        confidence: 'confirmed',
        confidenceLabel: 'Confirmed Cause',
        summary:
          sanitizedMessage ||
          'Amazon temporarily throttled requests from this browser session.',
        message: sanitizedMessage,
        recoveryAction: 'reload-and-retry',
        rootCause:
          'Amazon temporarily throttled requests from this browser session (HTTP 503 / rate-limit page).',
        whatIsKnown: `Amazon returned a temporary rate-limit response on ${sanitizedUrl}. ${preservedSentence}`,
        whatIsUncertain: null,
        potentialCauses: [
          'Continuous fast scrolling across many pages in a short window.',
          'Temporary regional load shedding on Amazon search or deals endpoints.',
        ],
        troubleshootingSteps: [
          'Wait 15–30 seconds before sending new requests.',
          'Increase "Scroll Interval" or "Wait After Scroll" in Settings to reduce request rate.',
          'Click "Reload Tab & Retry" to refresh the listing page and continue.',
        ],
        safeContext: buildSafeContext('confirmed'),
      };

    case 'BLOCKED':
      return {
        code,
        category: 'Page Error',
        title: 'Amazon Error / Dogs of Amazon Page',
        confidence: 'confirmed',
        confidenceLabel: 'Confirmed Cause',
        summary:
          sanitizedMessage ||
          'Amazon served an error screen ("Dogs of Amazon") instead of product cards.',
        message: sanitizedMessage,
        recoveryAction: 'reload-and-retry',
        rootCause:
          'Amazon served a fallback error page ("Dogs of Amazon") instead of product cards.',
        whatIsKnown: `The page at ${sanitizedUrl} rendered an Amazon error screen. ${preservedSentence}`,
        whatIsUncertain: null,
        potentialCauses: [
          'Temporary Amazon backend outage or expired deal/category URL parameters.',
          'Automated request block triggered on this page.',
        ],
        troubleshootingSteps: [
          'Verify that the Amazon page loads normally when refreshed manually.',
          'Pause for a brief interval if you have been running back-to-back collections.',
          'Click "Reload Tab & Retry" to reload the Amazon tab and restart extraction.',
        ],
        safeContext: buildSafeContext('confirmed'),
      };

    case 'SIGN_IN':
      return {
        code,
        category: 'Authentication Required',
        title: 'Amazon Sign-In Required',
        confidence: 'confirmed',
        confidenceLabel: 'Confirmed Cause',
        summary:
          sanitizedMessage ||
          'Amazon redirected the page to an authentication prompt.',
        message: sanitizedMessage,
        recoveryAction: 'resume',
        rootCause:
          'Amazon redirected the page to an authentication prompt before showing additional results.',
        whatIsKnown: `Sign-in form detected on ${sanitizedUrl}. ${preservedSentence}`,
        whatIsUncertain: null,
        potentialCauses: [
          'Browsing a member-only deal or age/account-gated category.',
          'Session cookie expiration during pagination.',
        ],
        troubleshootingSteps: [
          'Sign in to your Amazon account in the active tab, or navigate back to the public search results.',
          'Confirm product cards are visible on the page.',
          'Click "Resume" to continue collection.',
        ],
        safeContext: buildSafeContext('confirmed'),
      };

    case 'INJECTION_BLOCKED':
    case 'SCRIPT_DISCONNECTED': {
      const isLoading = tabStatus === 'loading';
      const confidence: DiagnosticConfidence = isLoading
        ? 'confirmed'
        : 'likely';
      return {
        code,
        category: 'Connection Interrupted',
        title: isLoading
          ? 'Amazon Page Still Loading'
          : 'Page Helper Script Disconnected',
        confidence,
        confidenceLabel: isLoading ? 'Confirmed Cause' : 'Likely Cause',
        summary:
          sanitizedMessage ||
          'PPHunt lost its communication channel with the Amazon page helper script.',
        message: sanitizedMessage,
        recoveryAction: 'reload-and-retry',
        rootCause: isLoading
          ? 'The Amazon tab is still loading its document and the content script has not finished initializing.'
          : 'The communication channel between the side panel and the Amazon page content script was interrupted.',
        whatIsKnown: `PPHunt could not reach the page helper script on ${sanitizedUrl} (tab status: ${tabStatus}). ${preservedSentence}`,
        whatIsUncertain: isLoading
          ? null
          : 'Whether the page navigated away mid-scroll or the browser discarded the tab context.',
        potentialCauses: [
          'Collection was started while the Amazon page was still navigating or refreshing.',
          'The extension was updated or reloaded while the Amazon tab remained open.',
          'A full-page redirect replaced the DOM document during collection.',
        ],
        troubleshootingSteps: [
          'Wait until the Amazon page finishes loading in the browser tab.',
          'Click "Reload Tab & Retry" below so PPHunt refreshes the tab and re-attaches its helper script.',
          'If the issue persists, switch to the Amazon tab once and click Retry.',
        ],
        safeContext: buildSafeContext(confidence),
      };
    }

    case 'TAB_CLOSED':
      return {
        code,
        category: 'Tab Lifecycle',
        title: 'Collection Tab Was Closed',
        confidence: 'confirmed',
        confidenceLabel: 'Confirmed Cause',
        summary:
          sanitizedMessage ||
          'The Amazon browser tab being scraped was closed before collection finished.',
        message: sanitizedMessage,
        recoveryAction: 'retry',
        rootCause:
          'The Amazon browser tab being scraped was closed before collection finished.',
        whatIsKnown: `The target tab for ${sanitizedUrl} was closed. ${preservedSentence}`,
        whatIsUncertain: null,
        potentialCauses: [
          'The Amazon tab or its browser window was closed manually.',
          'Browser tab-discarding closed the background tab under memory pressure.',
        ],
        troubleshootingSteps: [
          'Export the products already preserved in this session if needed.',
          'Open a new Amazon search or category tab to start a new collection.',
          'Keep the Amazon tab open while automatic scrolling is running.',
        ],
        safeContext: buildSafeContext('confirmed'),
      };

    case 'NOT_AMAZON':
      return {
        code,
        category: 'Unsupported Page',
        title: 'Unsupported Page URL',
        confidence: 'confirmed',
        confidenceLabel: 'Confirmed Cause',
        summary:
          sanitizedMessage ||
          'The target tab is no longer on a supported Amazon marketplace page.',
        message: sanitizedMessage,
        recoveryAction: 'switch-tab',
        rootCause:
          'The target tab is no longer on a supported Amazon marketplace page.',
        whatIsKnown: `Current tab URL (${sanitizedUrl}) is not a supported Amazon listing. ${preservedSentence}`,
        whatIsUncertain: null,
        potentialCauses: [
          'The tab navigated to an external site or a browser settings page.',
        ],
        troubleshootingSteps: [
          'Navigate the tab to an Amazon Search, Best Sellers, Deals, Category, or Product Detail page.',
          'Click "Retry" once product listings are visible.',
        ],
        safeContext: buildSafeContext('confirmed'),
      };

    case 'UNKNOWN':
    default:
      return {
        code: 'UNKNOWN',
        category: 'Unexpected Interruption',
        title: 'Unexpected Collection Interruption',
        confidence: 'uncertain',
        confidenceLabel: 'Uncertain Cause',
        summary:
          sanitizedMessage ||
          'Collection stopped due to an unclassified page or runtime interruption.',
        message: sanitizedMessage,
        recoveryAction: 'retry',
        rootCause:
          'Collection stopped due to an unclassified page or runtime interruption.',
        whatIsKnown: `Collection was interrupted on ${sanitizedUrl} (tab status: ${tabStatus}). ${preservedSentence}`,
        whatIsUncertain:
          'Whether the interruption was caused by a transient Amazon DOM layout update, a background tab suspension, or a temporary network stall.',
        potentialCauses: [
          'Amazon dynamically replaced the listing container or A/B tested a new card markup structure.',
          'Temporary network stall prevented lazy-loaded product cards from hydrating in time.',
          'Browser throttled timers in a backgrounded window during automatic scrolling.',
          ...(options.driftReasons ?? []),
        ],
        troubleshootingSteps: [
          'Check the Amazon tab to verify that product cards are still visible on screen.',
          'Click "Retry" or "Reload Tab & Retry" to re-synchronize with the page.',
          'If automatic scrolling repeatedly stalls, switch to Manual mode or copy the diagnostic summary below.',
        ],
        safeContext: buildSafeContext('uncertain'),
      };
  }
}

export const diagnoseAmazonError = diagnoseError;

/**
 * Formats a sanitized, human-readable diagnostic summary for clipboard export.
 */
export function formatDiagnosticReportForClipboard(
  report: ErrorDiagnostic,
): string {
  const lines: string[] = [
    '=== PPHunt Diagnostic Summary ===',
    `Title: ${report.title}`,
    `Code: ${report.code} (${report.confidenceLabel ?? report.confidence})`,
    `Page: ${report.safeContext.sanitizedUrl ?? 'unknown-url'}`,
    `Tab Status: ${report.safeContext.tabStatus ?? 'unknown'}`,
    `Preserved Products: ${report.safeContext.preservedProductsCount}`,
    `Summary: ${report.summary}`,
    '',
    'What Is Known:',
    `  ${report.whatIsKnown}`,
  ];

  if (report.whatIsUncertain) {
    lines.push('', 'What Remains Uncertain:', `  ${report.whatIsUncertain}`);
  }

  if (report.potentialCauses.length > 0) {
    lines.push('', 'Potential Causes:');
    for (const cause of report.potentialCauses) {
      lines.push(`  - ${cause}`);
    }
  }

  if (report.troubleshootingSteps.length > 0) {
    lines.push('', 'Recommended Steps:');
    report.troubleshootingSteps.forEach((step, idx) => {
      lines.push(`  ${idx + 1}. ${step}`);
    });
  }

  return lines.join('\n');
}
