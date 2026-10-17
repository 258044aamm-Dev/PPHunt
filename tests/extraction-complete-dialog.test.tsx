import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from '@/entrypoints/sidepanel/App';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { db } from '@/lib/db/database';
import { mountOverlayHost } from '@/lib/overlay/overlayHost';

describe('post-extraction completion dialog & full-width preview overlay (SAD-135)', () => {
  let messageListeners: Array<(msg: unknown) => void>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    useUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      exportModalOpen: false,
    });

    messageListeners = [];
    sendMessage = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('browser', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => {
            messageListeners.push(fn);
          },
          removeListener: (fn: (msg: unknown) => void) => {
            messageListeners = messageListeners.filter((l) => l !== fn);
          },
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 101,
            url: 'https://www.amazon.com/s?k=mechanical+keyboard',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 101,
          url: 'https://www.amazon.com/s?k=mechanical+keyboard',
        }),
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
  });

  afterEach(async () => {
    cleanup();
    document.getElementById('pphunt-extension-overlay-host')?.remove();
    await db.delete();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('automatically displays the completion dialog with all 3 options when extraction finishes', async () => {
    await db.products.bulkAdd([
      {
        sessionKey: 'session-dialog',
        asin: 'B08N5WRWNW',
        url: 'https://www.amazon.com/dp/B08N5WRWNW',
        title: 'Keychron K2 Wireless Mechanical Keyboard',
        price: 79.99,
        currency: 'USD',
        rating: 4.7,
        reviewCount: 3420,
        imageUrl: 'https://m.media-amazon.com/images/I/keychron.jpg',
        isSponsored: false,
        isPrime: true,
        brand: 'Keychron',
        availability: 'In Stock',
        seller: 'Keychron Official',
        description: null,
        features: [],
        collectedAt: new Date().toISOString(),
        source: 'search',
      },
    ]);

    render(<App />);

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: { collected: 1, target: 50, status: 'completed' },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Extraction Complete')).toBeTruthy();
      expect(screen.getByText('1 Product Extracted')).toBeTruthy();
    });

    expect(
      screen.getByRole('button', { name: /Preview Current Extraction/i })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Export Current Extraction/i })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Try Another Extraction/i })
    ).toBeTruthy();
  });

  it('does not display the success dialog when extraction fails with an error', async () => {
    render(<App />);

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: {
            collected: 0,
            target: 50,
            status: 'error',
            error: 'A CAPTCHA was detected. Solve it in the browser, then resume collection.',
          },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('CAPTCHA Detected')).toBeTruthy();
    });

    expect(screen.queryByText('Extraction Complete')).toBeNull();
    expect(screen.queryByText('No Products Extracted')).toBeNull();
  });

  it('handles 0-result extractions gracefully by disabling Preview and Export while keeping Try Another Extraction active', async () => {
    render(<App />);

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: { collected: 0, target: 50, status: 'completed' },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('No Products Extracted')).toBeTruthy();
      expect(screen.getByText('0 Products Found on This Page')).toBeTruthy();
    });

    const previewBtn = screen.getByRole('button', {
      name: /Preview Current Extraction/i,
    }) as HTMLButtonElement;
    const exportBtn = screen.getByRole('button', {
      name: /Export Current Extraction/i,
    }) as HTMLButtonElement;
    const tryAnotherBtn = screen.getByRole('button', {
      name: /Try Another Extraction/i,
    }) as HTMLButtonElement;

    expect(previewBtn.disabled).toBe(true);
    expect(exportBtn.disabled).toBe(true);
    expect(tryAnotherBtn.disabled).toBe(false);
  });

  it('preserves extracted products in IndexedDB and returns to idle Collect state when Try Another Extraction is clicked', async () => {
    await db.products.bulkAdd([
      {
        sessionKey: 'session-dialog',
        asin: 'B08N5WRWNW',
        url: 'https://www.amazon.com/dp/B08N5WRWNW',
        title: 'Preserved Product 1',
        price: 49.99,
        currency: 'USD',
        rating: 4.5,
        reviewCount: 120,
        imageUrl: null,
        isSponsored: false,
        isPrime: true,
        brand: 'Acme',
        availability: 'In Stock',
        seller: 'Amazon.com',
        description: null,
        features: [],
        collectedAt: new Date().toISOString(),
        source: 'search',
      },
      {
        sessionKey: 'session-dialog',
        asin: 'B09XS7JWHH',
        url: 'https://www.amazon.com/dp/B09XS7JWHH',
        title: 'Preserved Product 2',
        price: 89.99,
        currency: 'USD',
        rating: 4.8,
        reviewCount: 540,
        imageUrl: null,
        isSponsored: false,
        isPrime: true,
        brand: 'Acme',
        availability: 'In Stock',
        seller: 'Amazon.com',
        description: null,
        features: [],
        collectedAt: new Date().toISOString(),
        source: 'search',
      },
    ]);

    render(<App />);

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: { collected: 2, target: 50, status: 'completed' },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('2 Products Extracted')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Try Another Extraction/i })
    );

    expect(useUIStore.getState().completionDialogOpen).toBe(false);
    expect(useCollectionStore.getState().status).toBe('idle');
    expect(useUIStore.getState().activeTab).toBe('collect');

    const storedAfter = await db.products.toArray();
    expect(storedAfter).toHaveLength(2);
  });

  it('opens ExportModal for CSV and Excel (.xlsx) when Export Current Extraction is clicked', async () => {
    await db.products.add({
      sessionKey: 'session-dialog',
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Exportable Product',
      price: 29.99,
      currency: 'USD',
      rating: 4.6,
      reviewCount: 88,
      imageUrl: null,
      isSponsored: false,
      isPrime: true,
      brand: 'BrandX',
      availability: 'In Stock',
      seller: 'Amazon.com',
      description: null,
      features: [],
      collectedAt: new Date().toISOString(),
      source: 'search',
    });

    render(<App />);

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: { collected: 1, target: 50, status: 'completed' },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Extraction Complete')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Export Current Extraction/i })
    );

    await waitFor(() => {
      expect(screen.getByText('Export Products')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'CSV' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Excel' })).toBeTruthy();
    });
  });

  it('opens the structured FullWidthPreviewModal and expands/restores the page overlay host on Preview Current Extraction', async () => {
    await db.products.add({
      sessionKey: 'session-dialog',
      asin: 'B08N5WRWNW',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      title: 'Full Width Preview Product',
      price: 129.99,
      currency: 'USD',
      rating: 4.9,
      reviewCount: 2048,
      imageUrl: null,
      isSponsored: false,
      isPrime: true,
      brand: 'Sony',
      availability: 'In Stock',
      seller: 'Amazon.com',
      description: null,
      features: [],
      collectedAt: new Date().toISOString(),
      source: 'search',
    });

    render(<App />);

    act(() => {
      for (const listener of messageListeners) {
        listener({
          type: 'UPDATE_PROGRESS',
          payload: { collected: 1, target: 50, status: 'completed' },
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Extraction Complete')).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole('button', { name: /Preview Current Extraction/i })
    );

    await waitFor(() => {
      expect(screen.getByTestId('fullwidth-preview-overlay')).toBeTruthy();
    });

    // Verify closing the preview overlay returns cleanly
    fireEvent.click(
      screen.getByRole('button', { name: 'Close preview overlay' })
    );
    expect(screen.queryByTestId('fullwidth-preview-overlay')).toBeNull();

    // Verify mountOverlayHost responds to PPHUNT_SET_OVERLAY_FULLWIDTH messages
    vi.stubGlobal('chrome', {
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
    });
    const createElementSpy = vi.spyOn(document, 'createElement');
    const overlayUrl = 'chrome-extension://extension-id/overlay.html';
    expect(mountOverlayHost(overlayUrl, 400)).toBe(true);

    const host = document.getElementById('pphunt-extension-overlay-host')!;
    const created = createElementSpy.mock.results.map(
      (call) => call.value as HTMLElement
    );
    const frame = created.find(
      (el) => el?.tagName === 'IFRAME'
    ) as HTMLIFrameElement;

    expect(host.style.width).toBe('400px');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'chrome-extension://extension-id',
        source: frame.contentWindow,
        data: { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth: true },
      })
    );
    expect(host.getAttribute('data-fullwidth')).toBe('true');
    expect(Number.parseInt(host.style.width, 10)).toBeGreaterThan(400);

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'chrome-extension://extension-id',
        source: frame.contentWindow,
        data: { type: 'PPHUNT_SET_OVERLAY_FULLWIDTH', fullWidth: false },
      })
    );
    expect(host.getAttribute('data-fullwidth')).toBeNull();
    expect(host.style.width).toBe('400px');
  });
});
