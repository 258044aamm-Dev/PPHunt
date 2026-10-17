import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  diagnoseError,
  formatDiagnosticReportForClipboard,
  redactSensitiveText,
  sanitizeUrlForDiagnostics,
} from '@/lib/diagnostics/error-diagnosis';
import { ErrorModal } from '@/entrypoints/sidepanel/components/ErrorModal';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { db } from '@/lib/db/database';

describe('Comprehensive Error Diagnosis & Sanitization Engine (SAD-137)', () => {
  it('strips sensitive query tokens, stack traces, extension URLs, and local paths', () => {
    const rawDealsUrl =
      'https://www.amazon.com/deals?promotionsSearchLastSeenAsin=B0DJM1ZV5J&promotionsSearchStartIndex=60&session-id=142-9988776-1234567&token=secret_abc# deals-hash';
    expect(sanitizeUrlForDiagnostics(rawDealsUrl)).toBe(
      'https://www.amazon.com/deals'
    );

    expect(sanitizeUrlForDiagnostics('chrome://extensions/?id=abcdef')).toBe(
      'chrome://[browser-page]'
    );

    const rawErrorWithInternals = `Error: Failed to fetch https://www.amazon.com/deals?promotionsSearchLastSeenAsin=B0DJM1ZV5J&token=xyz987 from chrome-extension://abcdef123456/content-scripts/amazon.js
      at Object.run (/home/user/PPHunt/src/entrypoints/amazon.content.ts:44:12)
      Contact admin@internal-domain.org for session_id=998877`;

    const redacted = redactSensitiveText(rawErrorWithInternals);
    expect(redacted).not.toContain('promotionsSearchLastSeenAsin');
    expect(redacted).not.toContain('xyz987');
    expect(redacted).not.toContain('chrome-extension://');
    expect(redacted).not.toContain('/home/user/');
    expect(redacted).not.toContain('admin@internal-domain.org');
    expect(redacted).not.toContain('998877');
    expect(redacted).toContain('https://www.amazon.com/deals');
  });

  it('diagnoses specific root causes with potential causes and numbered troubleshooting steps', () => {
    const captchaDiag = diagnoseError('CAPTCHA detected on page', {
      code: 'CAPTCHA',
      url: 'https://www.amazon.com/s?k=headphones&crid=12345',
      preservedCount: 32,
    });
    expect(captchaDiag.code).toBe('CAPTCHA');
    expect(captchaDiag.confidence).toBe('confirmed');
    expect(captchaDiag.recoveryAction).toBe('resume');
    expect(captchaDiag.safeContext.sanitizedUrl).toBe(
      'https://www.amazon.com/s'
    );
    expect(captchaDiag.potentialCauses.length).toBeGreaterThanOrEqual(2);
    expect(captchaDiag.troubleshootingSteps.length).toBeGreaterThanOrEqual(3);

    const rateLimitDiag = diagnoseError('503 Service Unavailable', {
      code: 'RATE_LIMITED',
      url: 'https://www.amazon.com/deals?promotionsSearchStartIndex=30',
      preservedCount: 50,
    });
    expect(rateLimitDiag.code).toBe('RATE_LIMITED');
    expect(rateLimitDiag.confidence).toBe('confirmed');
    expect(rateLimitDiag.recoveryAction).toBe('reload-and-retry');
    expect(rateLimitDiag.rootCause).toContain('throttled');

    const loadingTabDiag = diagnoseError('Receiving end does not exist', {
      code: 'SCRIPT_DISCONNECTED',
      url: 'https://www.amazon.com/deals',
      tabStatus: 'loading',
      preservedCount: 12,
    });
    expect(loadingTabDiag.code).toBe('SCRIPT_DISCONNECTED');
    expect(loadingTabDiag.title).toBe('Amazon Page Still Loading');
    expect(loadingTabDiag.confidence).toBe('confirmed');
    expect(loadingTabDiag.recoveryAction).toBe('reload-and-retry');
  });

  it('clearly explains What Is Known, What Remains Uncertain, and What To Do Next when root cause is uncertain', () => {
    const unknownDiag = diagnoseError(
      'Unexpected DOM mutation stream interruption',
      {
        code: 'UNKNOWN',
        url: 'https://www.amazon.com/b?node=172282&ref=nb_sb_noss',
        tabStatus: 'complete',
        preservedCount: 19,
      }
    );

    expect(unknownDiag.confidence).toBe('uncertain');
    expect(unknownDiag.whatIsKnown).toContain('https://www.amazon.com/b');
    expect(unknownDiag.whatIsKnown).toContain(
      'All 19 product(s) collected so far remain safely saved.'
    );
    expect(unknownDiag.whatIsUncertain).toBeTruthy();
    expect(unknownDiag.whatIsUncertain).toContain('Whether the interruption');
    expect(unknownDiag.potentialCauses.length).toBeGreaterThan(0);
    expect(unknownDiag.troubleshootingSteps.length).toBeGreaterThan(0);

    const clipboardSummary = formatDiagnosticReportForClipboard(unknownDiag);
    expect(clipboardSummary).toContain('What Is Known:');
    expect(clipboardSummary).toContain('What Remains Uncertain:');
    expect(clipboardSummary).toContain('Recommended Steps:');
    expect(clipboardSummary).not.toContain('node=172282');
  });
});

describe('Upgraded Diagnostic ErrorModal UI & Context-Aware Recovery Actions (SAD-137)', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    sendMessage = vi.fn().mockResolvedValue(undefined);
    writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('renders What Is Known, What Remains Uncertain, Potential Causes, and What To Do Next for uncertain errors', async () => {
    render(<ErrorModal />);

    act(() => {
      const store = useCollectionStore.getState();
      store.setCollectionTab(
        88,
        'https://www.amazon.com/deals?promotionsSearchLastSeenAsin=B0DJM1ZV5J'
      );
      store.setCollectedCount(24);
      store.setError('An unexpected stream error occurred.');
      store.setStatus('error');
    });

    expect(screen.getByTestId('diagnostic-confidence').textContent).toContain(
      'Uncertain Cause'
    );
    expect(
      screen.getByTestId('preserved-products-banner').textContent
    ).toContain('24 collected products safely preserved in this session.');
    expect(screen.getByText('What Is Known')).toBeTruthy();
    expect(screen.getByText('What Remains Uncertain')).toBeTruthy();
    expect(screen.getByText('Potential Causes')).toBeTruthy();
    expect(screen.getByText('What To Do Next')).toBeTruthy();

    // Toggle sanitized diagnostic details panel
    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle diagnostic details' })
    );
    const detailsPanel = screen.getByTestId('diagnostic-details-panel');
    expect(detailsPanel.textContent).toContain('https://www.amazon.com/deals');
    expect(detailsPanel.textContent).not.toContain(
      'promotionsSearchLastSeenAsin'
    );

    // Copy sanitized diagnostic summary
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy diagnostic summary' })
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'PPHunt Diagnostic Summary'
    );
    expect(writeText.mock.calls[0]?.[0]).not.toContain(
      'promotionsSearchLastSeenAsin'
    );
  });

  it('dispatches RELOAD_AND_RETRY_COLLECTION when Reload Tab & Retry is clicked on a connection error', () => {
    render(<ErrorModal />);

    act(() => {
      const store = useCollectionStore.getState();
      store.setCollectionTab(55, 'https://www.amazon.com/deals');
      store.setMode('automatic');
      store.setTarget(50);
      store.setError(
        'PPHunt lost its communication channel with the Amazon page helper script.'
      );
      store.setStatus('error');
    });

    const reloadRetryBtn = screen.getByRole('button', {
      name: 'Reload tab and retry collection',
    });
    fireEvent.click(reloadRetryBtn);

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'RELOAD_AND_RETRY_COLLECTION',
      payload: {
        mode: 'automatic',
        targetCount: 50,
        tabId: 55,
      },
    });
    expect(useCollectionStore.getState().status).toBe('collecting');
    expect(useCollectionStore.getState().errorMessage).toBeNull();
  });
});

describe('Background MV3 async channel-closed protection (SAD-137)', () => {
  let onMessageListeners: Array<(msg: any, sender?: any) => any>;
  let tabsSendMessage: ReturnType<typeof vi.fn>;
  let executeScript: ReturnType<typeof vi.fn>;
  let runtimeSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    onMessageListeners = [];
    tabsSendMessage = vi.fn();
    executeScript = vi.fn().mockResolvedValue(undefined);
    runtimeSendMessage = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('browser', {
      sidePanel: {
        setPanelBehavior: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn() },
      },
      action: {
        setPopup: vi.fn().mockResolvedValue(undefined),
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
        setTitle: vi.fn().mockResolvedValue(undefined),
        onClicked: { addListener: vi.fn() },
      },
      runtime: {
        onMessage: {
          addListener: (fn: (msg: any, sender?: any) => any) => {
            onMessageListeners.push(fn);
          },
        },
        sendMessage: runtimeSendMessage,
      },
      tabs: {
        sendMessage: tabsSendMessage,
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        executeScript,
      },
    });
    vi.stubGlobal('defineBackground', (main: () => void) => main);
    const { default: main } = await import('@/entrypoints/background');
    (main as unknown as () => void)();
  });

  afterEach(async () => {
    await db.delete();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not re-inject duplicate content script or emit false error on MV3 async channel close', async () => {
    tabsSendMessage.mockRejectedValueOnce(
      new Error(
        'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'
      )
    );

    for (const listener of onMessageListeners) {
      listener({
        type: 'START_COLLECTION',
        payload: { mode: 'automatic', targetCount: 50, tabId: 150940693 },
      });
    }

    await new Promise((r) => setTimeout(r, 50));

    expect(executeScript).not.toHaveBeenCalled();
    expect(runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'UPDATE_PROGRESS',
        payload: expect.objectContaining({ status: 'error' }),
      })
    );
  });

  it('falls back to direct executeScript command dispatch when tabs.sendMessage continues to fail on /deals', async () => {
    tabsSendMessage.mockRejectedValue(
      new Error('The message port closed before a response was received.')
    );

    for (const listener of onMessageListeners) {
      listener({
        type: 'START_COLLECTION',
        payload: { mode: 'automatic', targetCount: 50, tabId: 901 },
      });
    }

    await waitFor(() => {
      expect(executeScript).toHaveBeenCalledWith({
        target: { tabId: 901 },
        files: ['/content-scripts/amazon.js'],
      });
    });

    expect(runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'UPDATE_PROGRESS',
        payload: expect.objectContaining({ status: 'error' }),
      })
    );
  });

  it('acknowledges COLLECT_PRODUCTS in amazon.content.ts via dedup.clear() without throwing and emits collected /deals products', async () => {
    const contentListeners: Array<
      (msg: any, sender?: any, sendResponse?: (res?: any) => void) => any
    > = [];
    const sentMessages: any[] = [];

    vi.stubGlobal('browser', {
      runtime: {
        onMessage: {
          addListener: (
            fn: (
              msg: any,
              sender?: any,
              sendResponse?: (res?: any) => void
            ) => any
          ) => {
            contentListeners.push(fn);
          },
          removeListener: vi.fn(),
        },
        sendMessage: vi.fn().mockImplementation((msg: any) => {
          sentMessages.push(msg);
          return Promise.resolve({ ok: true });
        }),
      },
    });
    vi.stubGlobal('defineContentScript', (cfg: { main: () => void }) => cfg);

    document.body.innerHTML = `
      <div data-testid="grid-deals-container">
        <div data-testid="deal-card" data-asin="B0DEAL9901">
          <a href="/Deal-Headphones/dp/B0DEAL9901">
            <span>Sony Wireless Deal Headphones</span>
          </a>
          <span data-a-badge-type="deal"><span class="a-badge-text">Limited-time deal</span></span>
          <span class="savingsPercentage">-40%</span>
          <span class="a-price" data-a-strike="true"><span class="a-offscreen">$199.99</span></span>
          <span class="a-price"><span class="a-offscreen">$119.99</span></span>
          <img src="https://m.media-amazon.com/images/I/71sonydeal._AC_SL1000_.jpg" alt="Sony Deal" />
        </div>
      </div>
    `;

    const { default: contentScript } = await import(
      '@/entrypoints/amazon.content'
    );
    (contentScript as unknown as { main: () => void }).main();

    expect(contentListeners.length).toBeGreaterThan(0);

    const sendResponse = vi.fn();
    const returnVal = contentListeners[0]?.(
      {
        type: 'COLLECT_PRODUCTS',
        payload: { mode: 'manual', targetCount: 50 },
      },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(returnVal).toBe(false);

    const collectedMsg = sentMessages.find(
      (m) => m.type === 'PRODUCTS_COLLECTED'
    );
    expect(collectedMsg).toBeTruthy();
    expect(collectedMsg.payload.products).toHaveLength(1);
    expect(collectedMsg.payload.products[0]).toMatchObject({
      asin: 'B0DEAL9901',
      price: 119.99,
      listPrice: 199.99,
      discountPercentage: '40% off',
      dealBadge: 'Limited-time deal',
    });
  });
});
