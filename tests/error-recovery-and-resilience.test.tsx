import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseSearchResults } from '@/lib/scraper/search-results';
import { parseCategoryPage } from '@/lib/scraper/category-page';
import {
  detectPageIssues,
  hasActiveLoadingIndicator,
} from '@/lib/scraper/captcha-detector';
import { ErrorModal } from '@/entrypoints/sidepanel/components/ErrorModal';
import { SessionNotice } from '@/entrypoints/sidepanel/components/SessionNotice';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { db } from '@/lib/db/database';

function createDoc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('adaptive Tier-3 heuristics for future Amazon DOM changes', () => {
  it('recovers all core product fields when standard Amazon CSS classes are absent', () => {
    const doc = createDoc(`
      <main>
        <article data-asin="B09V3KXJPB" class="future-card-x92">
          <span>Sponsored</span>
          <a href="/Apple-AirPods-Pro/dp/B09V3KXJPB/ref=future_sr_1">
            <h3>Apple AirPods Pro (2nd Generation) Wireless Earbuds</h3>
          </a>
          <div>Visit the Apple Store</div>
          <div>$199.99</div>
          <div aria-label="4.8 out of 5 stars">★★★★☆</div>
          <a href="/dp/B09V3KXJPB#customerReviews">14,250 ratings</a>
          <span aria-label="Prime Eligible">Prime</span>
          <div>In Stock</div>
          <div>Sold by Amazon.com</div>
          <img src="https://m.media-amazon.com/images/I/airpods-pro._AC_SL1500_.jpg" alt="Apple AirPods Pro" />
        </article>
      </main>
    `);

    const searchParsed = parseSearchResults(
      doc,
      'https://www.amazon.com/s?k=airpods'
    );
    expect(searchParsed).toHaveLength(1);
    expect(searchParsed[0]).toEqual({
      asin: 'B09V3KXJPB',
      url: 'https://www.amazon.com/dp/B09V3KXJPB',
      title: 'Apple AirPods Pro (2nd Generation) Wireless Earbuds',
      price: 199.99,
      currency: 'USD',
      rating: 4.8,
      reviewCount: 14250,
      imageUrl: 'https://m.media-amazon.com/images/I/airpods-pro._AC_SL1500_.jpg',
      isSponsored: true,
      isPrime: true,
      brand: 'Apple',
      availability: 'In Stock',
      seller: 'Amazon.com',
      description: null,
      features: [],
      source: 'search',
    });
  });

  it('isolates per-card DOM exceptions so one corrupted card never drops valid cards in the batch', () => {
    const doc = createDoc(`
      <div data-component-type="s-search-result" data-asin="B08N5WRWNW" id="corrupted-card">
        <h2><a href="/dp/B08N5WRWNW"><span>Corrupted Card</span></a></h2>
      </div>
      <div data-component-type="s-search-result" data-asin="B09XS7JWHH">
        <h2><a href="/dp/B09XS7JWHH"><span>Valid Second Product</span></a></h2>
        <span class="a-price" data-a-color="base"><span class="a-offscreen">$89.50</span></span>
      </div>
    `);

    const corruptedCard = doc.getElementById('corrupted-card')!;
    vi.spyOn(corruptedCard, 'querySelector').mockImplementation(() => {
      throw new Error('Simulated unexpected DOM mutation error');
    });

    const products = parseSearchResults(doc, 'https://www.amazon.com/s?k=test');
    expect(products).toHaveLength(1);
    expect(products[0]?.asin).toBe('B09XS7JWHH');
    expect(products[0]?.title).toBe('Valid Second Product');
    expect(products[0]?.price).toBe(89.5);

    const categoryProducts = parseCategoryPage(
      doc,
      'https://www.amazon.com/b?node=123'
    );
    expect(categoryProducts).toHaveLength(1);
    expect(categoryProducts[0]?.asin).toBe('B09XS7JWHH');
  });
});

describe('page issue & loading indicator detection', () => {
  it('detects CAPTCHA, robot check text, sign-in walls, and blocked/dog pages', () => {
    expect(
      detectPageIssues(
        createDoc('<form action="/errors/validateCaptcha"><input id="captchacharacters" /></form>')
      )?.code
    ).toBe('CAPTCHA');

    expect(
      detectPageIssues(
        createDoc(
          '<body>Sorry, we just need to make sure you are not a robot. Enter the characters you see below.</body>'
        )
      )?.code
    ).toBe('CAPTCHA');

    expect(
      detectPageIssues(createDoc('<form name="signIn"><input id="ap_email" /></form>'))
        ?.code
    ).toBe('SIGN_IN');

    expect(
      detectPageIssues(
        createDoc('<body><img alt="Dogs of Amazon" /> api-services-support@amazon.com</body>')
      )?.code
    ).toBe('BLOCKED');

    expect(detectPageIssues(createDoc('<div>Normal product listing</div>'))).toBeNull();
  });

  it('detects active loading spinners and ignores hidden placeholders', () => {
    expect(
      hasActiveLoadingIndicator(
        createDoc('<div class="s-result-list-placeholder"></div>')
      )
    ).toBe(true);
    expect(
      hasActiveLoadingIndicator(
        createDoc('<div class="s-result-list-placeholder aok-hidden"></div>')
      )
    ).toBe(false);
  });
});

describe('UI error recovery & session notice actions', () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { runtime: { sendMessage } });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('dispatches RESUME_COLLECTION and preserves collectedCount when Resume is clicked in ErrorModal', () => {
    render(<ErrorModal />);
    act(() => {
      const store = useCollectionStore.getState();
      store.setCollectionTab(42, 'https://www.amazon.com/s?k=laptop');
      store.setCollectedCount(18);
      store.setError(
        'A CAPTCHA was detected. Solve it in the browser, then resume collection.'
      );
      store.setStatus('error');
    });

    const resumeBtn = screen.getByRole('button', {
      name: 'Resume collection after solving issue',
    });
    fireEvent.click(resumeBtn);

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'RESUME_COLLECTION',
      payload: { tabId: 42 },
    });
    expect(useCollectionStore.getState().status).toBe('collecting');
    expect(useCollectionStore.getState().errorMessage).toBeNull();
    expect(useCollectionStore.getState().collectedCount).toBe(18);
  });

  it('triggers onStartFresh and onKeepProducts callbacks in SessionNotice', () => {
    const onDismiss = vi.fn();
    const onStartFresh = vi.fn();
    const onKeepProducts = vi.fn();

    render(
      <SessionNotice
        notice={{
          type: 'page-reloaded',
          message: 'Previous collection had 25 products.',
          collectedCount: 25,
          sessionKey: '42_1000',
        }}
        onDismiss={onDismiss}
        onStartFresh={onStartFresh}
        onKeepProducts={onKeepProducts}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start Fresh' }));
    expect(onStartFresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Keep Products' }));
    expect(onKeepProducts).toHaveBeenCalledTimes(1);
  });
});

describe('background content-script auto-reinjection and batch persistence fallback', () => {
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

  it('auto-reinjects the content script and retries when initial tabs.sendMessage fails', async () => {
    tabsSendMessage
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValueOnce(undefined);

    for (const listener of onMessageListeners) {
      listener({
        type: 'START_COLLECTION',
        payload: { mode: 'manual', targetCount: 50, tabId: 77 },
      });
    }

    await waitFor(() => {
      expect(executeScript).toHaveBeenCalledWith({
        target: { tabId: 77 },
        files: ['/content-scripts/amazon.js'],
      });
      expect(tabsSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  it('still dispatches via the DOM bridge when executeScript re-injection rejects (H-2, SAD-165)', async () => {
    // Every tabs.sendMessage fails; the files-based injection rejects too.
    // Before the fix the rejection skipped the bridge entirely; now the
    // func-based bridge must still run.
    tabsSendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    executeScript.mockImplementation(
      async (options: { files?: string[]; func?: unknown }) => {
        if (options?.files) {
          throw new Error('Cannot access contents of the page');
        }
        return [{ result: { ok: true } }];
      }
    );

    for (const listener of onMessageListeners) {
      listener({ type: 'RESUME_COLLECTION', payload: { tabId: 88 } });
    }

    // The router forwards RESUME_SCROLLING to the tab; that is the message
    // the bridge must deliver when both sendMessage and file injection fail.
    await waitFor(() => {
      expect(executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 88 },
          func: expect.any(Function),
          args: [{ type: 'RESUME_SCROLLING' }],
        })
      );
    });
  });

  it('falls back to per-item db.products.add if bulkAdd fails so valid items are never lost', async () => {
    vi.spyOn(db.products, 'bulkAdd').mockRejectedValueOnce(
      new Error('Simulated bulkAdd transaction failure')
    );

    for (const listener of onMessageListeners) {
      listener(
        {
          type: 'PRODUCTS_COLLECTED',
          payload: {
            products: [
              {
                asin: 'B08N5WRWNW',
                url: 'https://www.amazon.com/dp/B08N5WRWNW',
                title: 'Resilient Product 1',
                price: 25.0,
                currency: 'USD',
                source: 'search',
              },
              {
                // Invalid ASIN item should be filtered out without affecting valid siblings
                asin: 'INVALID',
                url: 'https://www.amazon.com/dp/INVALID',
                title: 'Bad Item',
                source: 'search',
              },
              {
                asin: 'B09XS7JWHH',
                url: 'https://www.amazon.com/dp/B09XS7JWHH',
                title: 'Resilient Product 2',
                price: 49.99,
                currency: 'USD',
                source: 'search',
              },
            ],
            totalCount: 2,
            isNewBatch: true,
          },
        },
        { tab: { url: 'https://www.amazon.com/s?k=test' } }
      );
    }

    await waitFor(async () => {
      const stored = await db.products.toArray();
      expect(stored).toHaveLength(2);
      expect(stored.map((p) => p.asin).sort()).toEqual([
        'B08N5WRWNW',
        'B09XS7JWHH',
      ]);
    });
  });
});
