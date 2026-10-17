import type {
  ErrorCode,
  ErrorDiagnostic,
  SafeDiagnosticContext,
} from '@/types/common';

export interface DiagnoseContextInput {
  code?: ErrorCode;
  url?: string | null;
  pageType?: string | null;
  tabStatus?: string | null;
  preservedCount?: number;
  rawReason?: string | null;
  occurredAt?: string;
}

/**
 * Strips query parameters, hashes, credentials, and sensitive tokens from a URL
 * so diagnostic reports never leak session IDs, tracking parameters, or user data.
 */
export function sanitizeUrlForDiagnostics(
  rawUrl?: string | null
): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(trimmed)) {
    const scheme = trimmed.split(':')[0]?.toLowerCase() ?? 'browser';
    return `${scheme}://[browser-page]`;
  }

  try {
    const parsed = new URL(trimmed);
    // Keep only protocol + hostname + sanitized top-level path segments
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 3)
      .map((seg) => {
        // Preserve standard ASINs (10 uppercase alphanumeric) or short route names
        if (/^[A-Z0-9]{10}$/.test(seg)) return seg;
        if (/^[a-zA-Z0-9_-]{1,24}$/.test(seg)) return seg;
        return '[segment]';
      });
    const cleanPath = segments.length > 0 ? `/${segments.join('/')}` : '/';
    return `${parsed.protocol}//${parsed.hostname}${cleanPath}`;
  } catch {
    return null;
  }
}

/**
 * Removes stack traces, internal file/extension URLs, query parameters, tokens,
 * and email addresses from raw error text so sensitive technical internals are
 * never exposed to end users.
 */
export function redactSensitiveText(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';

  return raw
    // Remove stack frames like "at fn (/path/file.js:10:2)"
    .replace(/\s+at\s+[^\n]+/g, '')
    // Remove extension/file URLs
    .replace(
      /\b(?:chrome-extension|moz-extension|file):\/\/[^\s)]+/gi,
      '[internal-resource]'
    )
    // Remove Unix/Windows absolute file paths
    .replace(/(?:\/home\/|\/Users\/|\/var\/|[A-Z]:\\)[^\s:)]+/g, '[local-path]')
    // Remove URL query strings
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1')
    // Remove key=value tokens/session/auth params
    .replace(
      /\b(?:token|session[-_]?id|api[-_]?key|password|secret|auth|cookie|promotionsSearchLastSeenAsin)=[^\s&]+/gi,
      '[redacted]'
    )
    // Remove email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Comprehensive error diagnosis engine (SAD-137).
 *
 * Inspects error messages, error codes, and tab/page metadata to determine the
 * underlying root cause, potential causes, and actionable troubleshooting steps.
 * When the root cause cannot be determined automatically with certainty, clearly
 * separates What Is Known, What Remains Uncertain, and What To Do Next.
 */
export function diagnoseError(
  errorInput: string | Error | Partial<ErrorDiagnostic> | null | undefined,
  ctx: DiagnoseContextInput = {}
): ErrorDiagnostic {
  const nowIso = ctx.occurredAt ?? new Date().toISOString();
  const sanitizedUrl = sanitizeUrlForDiagnostics(ctx.url);
  const preservedProductsCount =
    typeof ctx.preservedCount === 'number' && ctx.preservedCount >= 0
      ? ctx.preservedCount
      : 0;

  // If a full ErrorDiagnostic was already supplied, normalize its context
  if (
    errorInput &&
    typeof errorInput === 'object' &&
    !(errorInput instanceof Error) &&
    'rootCause' in errorInput &&
    'troubleshootingSteps' in errorInput &&
    Array.isArray(errorInput.troubleshootingSteps)
  ) {
    const existing = errorInput as ErrorDiagnostic;
    return {
      ...existing,
      safeContext: {
        errorCode: existing.code ?? ctx.code ?? 'UNKNOWN',
        confidence: existing.confidence ?? 'uncertain',
        sanitizedUrl: existing.safeContext?.sanitizedUrl ?? sanitizedUrl,
        pageType: existing.safeContext?.pageType ?? ctx.pageType ?? null,
        tabStatus: existing.safeContext?.tabStatus ?? ctx.tabStatus ?? null,
        preservedProductsCount:
          existing.safeContext?.preservedProductsCount ?? preservedProductsCount,
        occurredAt: existing.safeContext?.occurredAt ?? nowIso,
      },
    };
  }

  const rawMessage =
    typeof errorInput === 'string'
      ? errorInput
      : errorInput instanceof Error
        ? errorInput.message
        : '';
  const combinedText = `${rawMessage} ${ctx.rawReason ?? ''}`.trim();
  const cleanMessage = redactSensitiveText(rawMessage);

  const preservedNote =
    preservedProductsCount > 0
      ? `All ${preservedProductsCount} product(s) collected so far remain safely saved.`
      : 'No previously saved products were affected.';

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

  // 1. CAPTCHA / Bot Challenge
  if (
    ctx.code === 'CAPTCHA' ||
    /captcha|not a robot|automated access|type the characters/i.test(combinedText)
  ) {
    return {
      code: 'CAPTCHA',
      category: 'Bot Verification Challenge',
      title: 'CAPTCHA Detected',
      confidence: 'confirmed',
      summary:
        cleanMessage ||
        'Amazon displayed a CAPTCHA verification challenge that paused product collection.',
      rootCause:
        'Amazon’s automated traffic protection interrupted the page with a character verification form before serving additional product listings.',
      whatIsKnown: `A CAPTCHA challenge form was detected on ${sanitizedUrl ?? 'the Amazon tab'}. ${preservedNote}`,
      whatIsUncertain: null,
      potentialCauses: [
        'Rapid scrolling or frequent page loads triggered Amazon’s anti-bot verification.',
        'Your current IP address, VPN, or shared network was flagged for additional verification.',
      ],
      troubleshootingSteps: [
        'Switch to the Amazon browser tab and solve the CAPTCHA prompt shown on the page.',
        'Confirm that Amazon reloads the product listing normally.',
        'Click "Resume →" below to continue collecting from where the session paused.',
      ],
      recoveryAction: 'resume',
      safeContext: buildSafeContext('CAPTCHA', 'confirmed'),
    };
  }

  // 2. Sign-In Wall
  if (
    ctx.code === 'SIGN_IN' ||
    /sign.?in|ap_email|authentication required/i.test(combinedText)
  ) {
    return {
      code: 'SIGN_IN',
      category: 'Authentication Required',
      title: 'Sign-In Required',
      confidence: 'confirmed',
      summary:
        cleanMessage ||
        'Amazon requested account sign-in before displaying the page content.',
      rootCause:
        'The active tab was redirected to an Amazon Sign-In form instead of a public product listing.',
      whatIsKnown: `An Amazon Sign-In form (#ap_email / signIn) is active on ${sanitizedUrl ?? 'the current tab'}. ${preservedNote}`,
      whatIsUncertain: null,
      potentialCauses: [
        'Your Amazon login session expired while browsing.',
        'The current page or personalized deal requires an authenticated Amazon account.',
      ],
      troubleshootingSteps: [
        'Sign in to your Amazon account in the browser tab (or navigate back to a public search/category page).',
        'Verify that products are visible on the Amazon page.',
        'Click "Resume →" below to resume product extraction.',
      ],
      recoveryAction: 'resume',
      safeContext: buildSafeContext('SIGN_IN', 'confirmed'),
    };
  }

  // 3. Tab Closed Mid-Collection
  if (
    ctx.code === 'TAB_CLOSED' ||
    /tab was closed|tab closed|no tab with id/i.test(combinedText)
  ) {
    return {
      code: 'TAB_CLOSED',
      category: 'Tab Lifecycle Interruption',
      title: 'Collection Tab Was Closed',
      confidence: 'confirmed',
      summary:
        cleanMessage ||
        'The Amazon tab where extraction was running was closed before completion.',
      rootCause:
        'The browser tab hosting the active Amazon page was closed, terminating the page connection.',
      whatIsKnown: `The target Amazon tab is no longer open. ${preservedNote}`,
      whatIsUncertain: null,
      potentialCauses: [
        'The Amazon browser tab or window was closed manually during extraction.',
        'The browser unloaded or crashed the tab process.',
      ],
      troubleshootingSteps: [
        preservedProductsCount > 0
          ? `Open the "History" tab in PPHunt to preview or export the ${preservedProductsCount} saved product(s).`
          : 'Open a new Amazon search, category, or deals tab in your browser.',
        'Navigate to an Amazon listing page and click "Start" to begin a new extraction.',
      ],
      recoveryAction: 'dismiss',
      safeContext: buildSafeContext('TAB_CLOSED', 'confirmed'),
    };
  }

  // 4. Rate Limit / HTTP 503 / Dogs of Amazon
  if (
    ctx.code === 'RATE_LIMITED' ||
    /503|service unavailable|dogs of amazon|rate.?limit|throttl/i.test(
      combinedText
    )
  ) {
    return {
      code: 'RATE_LIMITED',
      category: 'Rate Limit / HTTP 503',
      title: 'Amazon Temporarily Rate-Limited Requests',
      confidence: 'confirmed',
      summary:
        cleanMessage ||
        'Amazon returned a temporary rate-limit or service unavailability page (HTTP 503).',
      rootCause:
        'Amazon temporarily throttled page requests from this browser session and served an error placeholder ("Dogs of Amazon" / HTTP 503) instead of products.',
      whatIsKnown: `Amazon returned a rate-limit / service unavailable indicator on ${sanitizedUrl ?? 'the active tab'}. ${preservedNote}`,
      whatIsUncertain: null,
      potentialCauses: [
        'High-frequency scrolling or multiple concurrent Amazon tabs exceeded Amazon’s request threshold.',
        'Amazon’s deals or search server experienced a temporary traffic spike.',
      ],
      troubleshootingSteps: [
        'Wait 30 to 60 seconds to allow Amazon’s temporary rate limit to reset.',
        'Click "Reload Tab & Retry" below to reload the Amazon listing and resume extraction.',
        'If throttling repeats, switch Collection Mode to "Manual" to scroll at a slower pace.',
      ],
      recoveryAction: 'reload-and-retry',
      safeContext: buildSafeContext('RATE_LIMITED', 'confirmed'),
    };
  }

  // 5. Blocked / Access Restricted Page
  if (
    ctx.code === 'BLOCKED' ||
    /blocked|restricted|dogpage|errorpage/i.test(combinedText)
  ) {
    return {
      code: 'BLOCKED',
      category: 'Page Access Restriction',
      title: 'Page Blocked',
      confidence: 'likely',
      summary:
        cleanMessage ||
        'Amazon returned an error or restriction page instead of product listings.',
      rootCause:
        'The page DOM matched an Amazon error or access-restriction screen rather than a valid product catalog view.',
      whatIsKnown: `An error or block screen was detected on ${sanitizedUrl ?? 'the Amazon tab'}. ${preservedNote}`,
      whatIsUncertain:
        'Whether the restriction was triggered by temporary IP rate-limiting, a VPN/proxy filter, or an expired promotion link.',
      potentialCauses: [
        'Temporary rate-limiting or security filtering on your current network or VPN.',
        'The Amazon URL points to an expired deal, unavailable item, or restricted regional storefront.',
      ],
      troubleshootingSteps: [
        'Inspect the Amazon browser tab to see if an error banner or "Dogs of Amazon" screen is visible.',
        'If using a VPN or proxy, disable it or switch to a residential connection.',
        'Click "Reload Tab & Retry" below, or navigate to a different Amazon search/category page.',
      ],
      recoveryAction: 'reload-and-retry',
      safeContext: buildSafeContext('BLOCKED', 'likely'),
    };
  }

  // 6. Non-Amazon or Browser-Internal Page
  if (
    ctx.code === 'NOT_AMAZON' ||
    (sanitizedUrl && sanitizedUrl.includes('[browser-page]')) ||
    /not an amazon|chrome:\/\/|chromewebstore|cannot access a chrome/i.test(
      combinedText
    )
  ) {
    return {
      code: 'NOT_AMAZON',
      category: 'Unsupported Page URL',
      title: 'Unsupported Page for Extraction',
      confidence: 'confirmed',
      summary:
        'The target tab is not on a supported Amazon marketplace page.',
      rootCause:
        'Product extraction can only run on supported Amazon storefront pages (such as search results, category listings, deals, or product detail pages).',
      whatIsKnown: `Current tab URL (${sanitizedUrl ?? 'non-Amazon page'}) does not match a supported Amazon storefront. ${preservedNote}`,
      whatIsUncertain: null,
      potentialCauses: [
        'The browser tab navigated away from Amazon to another website or a browser system page.',
        'The current Amazon regional domain is not in the supported marketplace list.',
      ],
      troubleshootingSteps: [
        'Navigate the active browser tab to an Amazon search, category, deals, or product page (e.g., amazon.com, amazon.co.uk, amazon.de).',
        'Wait for the product listings to finish loading on the page.',
        'Click "Retry" or "Start" to begin extraction.',
      ],
      recoveryAction: 'retry',
      safeContext: buildSafeContext('NOT_AMAZON', 'confirmed'),
    };
  }

  // 7. Content Script Disconnected / Injection or Channel Failure
  if (
    ctx.code === 'SCRIPT_DISCONNECTED' ||
    ctx.code === 'INJECTION_BLOCKED' ||
    /could not access the amazon page|could not connect to the amazon page|receiving end does not exist|message channel closed|message port closed|cannot access contents of url|script/i.test(
      combinedText
    )
  ) {
    const isTabStillLoading = ctx.tabStatus === 'loading';
    const isPermissionError =
      /cannot access contents|permission|manifest/i.test(combinedText);

    return {
      code: isPermissionError ? 'INJECTION_BLOCKED' : 'SCRIPT_DISCONNECTED',
      category: isPermissionError
        ? 'Site Access Permission Blocked'
        : 'Page Connection Interrupted',
      title: isPermissionError
        ? 'Site Access Permission Needed'
        : isTabStillLoading
          ? 'Amazon Page Still Loading'
          : 'Page Connection Interrupted',
      confidence: isTabStillLoading || isPermissionError ? 'confirmed' : 'likely',
      summary: isPermissionError
        ? 'Browser permissions prevented PPHunt from accessing the Amazon tab.'
        : isTabStillLoading
          ? 'The Amazon page was still loading when extraction tried to connect.'
          : 'PPHunt lost its communication channel with the Amazon page helper script.',
      rootCause: isPermissionError
        ? 'The browser restricted script execution on this tab because site access permissions for this Amazon domain are not granted.'
        : isTabStillLoading
          ? 'The Amazon tab had not finished loading its document (status: loading) before the extraction command timed out.'
          : 'The page helper script in the Amazon tab was disconnected or did not respond in time (which commonly happens if the extension was recently updated/reloaded while the tab stayed open, or if the tab navigated mid-command).',
      whatIsKnown: `Target tab (${sanitizedUrl ?? 'Amazon tab'}, status: ${ctx.tabStatus ?? 'active'}) did not complete the collection handshake. ${preservedNote}`,
      whatIsUncertain:
        isTabStillLoading || isPermissionError
          ? null
          : 'Whether the disconnection was caused by an extension reload, browser tab discarding/hibernation, or an in-page navigation event.',
      potentialCauses: [
        'The extension was installed, updated, or reloaded while the Amazon tab was already open.',
        'The Amazon tab was still loading or navigating to a new URL (such as a deals filter change) during connection.',
        'Browser site-access settings for PPHunt are set to "On click" instead of allowing access on Amazon sites.',
      ],
      troubleshootingSteps: [
        'Click "Reload Tab & Retry" below to automatically reload the Amazon tab and reconnect the page helper.',
        'Wait 2–3 seconds after the Amazon page finishes loading before starting collection.',
        'If the issue persists, right-click the PPHunt extension icon → "Manage Extension" → ensure "Site access" is enabled for Amazon sites.',
      ],
      recoveryAction: 'reload-and-retry',
      safeContext: buildSafeContext(
        isPermissionError ? 'INJECTION_BLOCKED' : 'SCRIPT_DISCONNECTED',
        isTabStillLoading || isPermissionError ? 'confirmed' : 'likely'
      ),
    };
  }

  // 8. Export or Storage Failure
  if (
    ctx.code === 'EXPORT_FAILED' ||
    ctx.code === 'STORAGE_ERROR' ||
    /clipboard|export failed|quota|indexeddb|database/i.test(combinedText)
  ) {
    const isClipboard = /clipboard/i.test(combinedText);
    return {
      code: isClipboard ? 'EXPORT_FAILED' : 'STORAGE_ERROR',
      category: isClipboard ? 'Clipboard Permission Error' : 'Storage / Export Error',
      title: isClipboard ? 'Clipboard Access Denied' : 'Data Storage or Export Error',
      confidence: 'confirmed',
      summary:
        cleanMessage ||
        'The requested export or storage operation could not be completed.',
      rootCause: isClipboard
        ? 'The browser blocked write access to the system clipboard because the panel lost focus or clipboard permissions are restricted.'
        : 'The browser encountered an error while writing or downloading the extracted dataset.',
      whatIsKnown: `Operation failed with message: "${cleanMessage || 'Storage/Export error'}". ${preservedNote}`,
      whatIsUncertain: null,
      potentialCauses: [
        isClipboard
          ? 'The PPHunt panel was not the focused window when copying to the clipboard.'
          : 'Browser download settings or low disk/IndexedDB storage quota blocked the file write.',
      ],
      troubleshootingSteps: [
        isClipboard
          ? 'Click directly inside the PPHunt panel and try "Copy" again, or export as CSV / Excel (.xlsx) instead.'
          : 'Try exporting in CSV format or clearing old sessions in the History tab to free browser storage.',
      ],
      recoveryAction: 'dismiss',
      safeContext: buildSafeContext(
        isClipboard ? 'EXPORT_FAILED' : 'STORAGE_ERROR',
        'confirmed'
      ),
    };
  }

  // 9. Fallback for Unknown / Uncertain Root Cause
  return {
    code: ctx.code ?? 'UNKNOWN',
    category: 'Uncertain Root Cause',
    title: 'Collection Error',
    confidence: 'uncertain',
    summary:
      cleanMessage ||
      'An unexpected error interrupted product extraction on the current page.',
    rootCause:
      'The exact root cause could not be determined automatically from the page signals.',
    whatIsKnown: `Extraction stopped on ${sanitizedUrl ?? 'the current tab'}${ctx.tabStatus ? ` (tab status: ${ctx.tabStatus})` : ''}. ${preservedNote}${cleanMessage ? ` Reported detail: "${cleanMessage}".` : ''}`,
    whatIsUncertain:
      'Whether the interruption was caused by a temporary network drop, a dynamic Amazon page layout change, or a browser extension communication timeout.',
    potentialCauses: [
      'A temporary network or page-loading glitch interrupted Amazon’s product feed.',
      'Amazon dynamically updated the page layout or URL state while extraction was running.',
      'The browser temporarily suspended the tab or extension background worker.',
    ],
    troubleshootingSteps: [
      'Check the Amazon browser tab to confirm product listings are visible and not blocked by a prompt.',
      'Click "Reload Tab & Retry" below to refresh the page connection and restart extraction.',
      'If you already collected products, open the "History" tab to preview or export the saved results.',
    ],
    recoveryAction: 'reload-and-retry',
    safeContext: buildSafeContext(ctx.code ?? 'UNKNOWN', 'uncertain'),
  };
}

/**
 * Formats a sanitized, user-friendly plain-text diagnostic summary suitable
 * for copying to the clipboard when troubleshooting or reporting an issue.
 */
export function formatDiagnosticReportForClipboard(
  diagnostic: ErrorDiagnostic
): string {
  const lines: string[] = [
    `PPHunt Diagnostic Summary`,
    `Title: ${diagnostic.title}`,
    `Category: ${diagnostic.category} (${diagnostic.safeContext.errorCode})`,
    `Diagnosis Confidence: ${diagnostic.confidence.toUpperCase()}`,
    `Root Cause: ${diagnostic.rootCause}`,
    `What Is Known: ${diagnostic.whatIsKnown}`,
  ];

  if (diagnostic.whatIsUncertain) {
    lines.push(`What Remains Uncertain: ${diagnostic.whatIsUncertain}`);
  }

  if (diagnostic.potentialCauses.length > 0) {
    lines.push(
      `Potential Causes: ${diagnostic.potentialCauses.join(' | ')}`
    );
  }

  if (diagnostic.troubleshootingSteps.length > 0) {
    lines.push(
      `Recommended Steps: ${diagnostic.troubleshootingSteps
        .map((s, idx) => `${idx + 1}. ${s}`)
        .join(' ')}`
    );
  }

  lines.push(
    `Context: URL=${diagnostic.safeContext.sanitizedUrl ?? 'N/A'}, TabStatus=${diagnostic.safeContext.tabStatus ?? 'N/A'}, SavedProducts=${diagnostic.safeContext.preservedProductsCount}, Time=${diagnostic.safeContext.occurredAt}`
  );

  return lines.join('\n');
}
