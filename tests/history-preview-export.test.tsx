import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import App from '@/entrypoints/sidepanel/App';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { db } from '@/lib/db/database';

describe('Preview tab removal & History-integrated Preview/Export per record (SAD-136)', () => {
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
      selectedSessionKey: null,
    });

    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 201,
            url: 'https://www.amazon.com/s?k=headphones',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 201,
          url: 'https://www.amazon.com/s?k=headphones',
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
    await db.delete();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('removes the standalone Preview tab so Navigation shows only Collect and History', () => {
    render(<App />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Collect', 'History']);
    expect(screen.queryByRole('tab', { name: 'Preview' })).toBeNull();
  });

  it('renders Preview and Export buttons for each History extraction record and scopes them to that record', async () => {
    await db.history.bulkAdd([
      {
        sessionKey: 'session_keyboards',
        url: 'https://www.amazon.com/s?k=keyboards',
        mode: 'manual',
        targetCount: 50,
        collectedCount: 2,
        startedAt: '2026-10-16T09:00:00.000Z',
        completedAt: '2026-10-16T09:05:00.000Z',
        status: 'completed',
      },
      {
        sessionKey: 'session_monitors',
        url: 'https://www.amazon.com/s?k=monitors',
        mode: 'automatic',
        targetCount: 100,
        collectedCount: 1,
        startedAt: '2026-10-16T10:00:00.000Z',
        completedAt: '2026-10-16T10:10:00.000Z',
        status: 'completed',
      },
    ]);

    await db.products.bulkAdd([
      {
        asin: 'B08N5WRWNW',
        url: 'https://www.amazon.com/dp/B08N5WRWNW',
        title: 'Keychron K2 Mechanical Keyboard',
        price: 79.99,
        currency: 'USD',
        rating: 4.7,
        reviewCount: 1200,
        imageUrl: null,
        isSponsored: false,
        isPrime: true,
        brand: 'Keychron',
        availability: 'In Stock',
        seller: 'Keychron',
        description: null,
        features: [],
        collectedAt: '2026-10-16T09:01:00.000Z',
        sessionKey: 'session_keyboards',
        source: 'search',
      },
      {
        asin: 'B09XS7JWHH',
        url: 'https://www.amazon.com/dp/B09XS7JWHH',
        title: 'HHKB Professional Hybrid Keyboard',
        price: 299.0,
        currency: 'USD',
        rating: 4.9,
        reviewCount: 640,
        imageUrl: null,
        isSponsored: false,
        isPrime: true,
        brand: 'HHKB',
        availability: 'In Stock',
        seller: 'PFU',
        description: null,
        features: [],
        collectedAt: '2026-10-16T09:02:00.000Z',
        sessionKey: 'session_keyboards',
        source: 'search',
      },
      {
        asin: 'B0BSHF7WHW',
        url: 'https://www.amazon.com/dp/B0BSHF7WHW',
        title: 'LG UltraFine 27-Inch 4K Monitor',
        price: 399.99,
        currency: 'USD',
        rating: 4.6,
        reviewCount: 890,
        imageUrl: null,
        isSponsored: false,
        isPrime: true,
        brand: 'LG',
        availability: 'In Stock',
        seller: 'Amazon.com',
        description: null,
        features: [],
        collectedAt: '2026-10-16T10:02:00.000Z',
        sessionKey: 'session_monitors',
        source: 'search',
      },
    ]);

    render(<App />);

    // Switch to History tab
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));

    const keyboardsCard = await screen.findByTestId(
      'history-entry-session_keyboards'
    );
    const monitorsCard = await screen.findByTestId(
      'history-entry-session_monitors'
    );

    // Both cards have clearly labeled Preview and Export buttons
    expect(within(keyboardsCard).getByText('Preview')).toBeTruthy();
    expect(within(keyboardsCard).getByText('Export')).toBeTruthy();
    expect(within(monitorsCard).getByText('Preview')).toBeTruthy();
    expect(within(monitorsCard).getByText('Export')).toBeTruthy();

    // 1. Click Export on the keyboards session -> ExportModal shows 2 products
    fireEvent.click(within(keyboardsCard).getByText('Export'));
    await waitFor(() => {
      expect(screen.getByText('Export Products')).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Export 2 products' })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // 2. Click Export on the monitors session -> ExportModal shows 1 product
    fireEvent.click(within(monitorsCard).getByText('Export'));
    await waitFor(() => {
      expect(screen.getByText('Export Products')).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Export 1 products' })
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // 3. Click Preview on the keyboards session -> FullWidthPreviewModal opens scoped to session_keyboards (2 products)
    fireEvent.click(within(keyboardsCard).getByText('Preview'));
    const previewOverlay = await screen.findByTestId('fullwidth-preview-overlay');
    expect(useUIStore.getState().selectedSessionKey).toBe('session_keyboards');
    await waitFor(() => {
      expect(within(previewOverlay).getAllByText('2 products').length).toBeGreaterThan(0);
    });
  });

  it('deletes associated products for that sessionKey when a History entry is deleted, and clears all on Clear All', async () => {
    // L-6 (SAD-194): window.confirm() is gone - the ConfirmDialog renders in
    // its place and the flow continues from its confirm button.
    await db.history.bulkAdd([
      {
        sessionKey: 'session_one',
        url: 'https://www.amazon.com/s?k=one',
        mode: 'manual',
        targetCount: 50,
        collectedCount: 1,
        startedAt: '2026-10-16T08:00:00.000Z',
        completedAt: '2026-10-16T08:05:00.000Z',
        status: 'completed',
      },
      {
        sessionKey: 'session_two',
        url: 'https://www.amazon.com/s?k=two',
        mode: 'manual',
        targetCount: 50,
        collectedCount: 1,
        startedAt: '2026-10-16T09:00:00.000Z',
        completedAt: '2026-10-16T09:05:00.000Z',
        status: 'completed',
      },
    ]);

    await db.products.bulkAdd([
      {
        asin: 'B08N5WRWNW',
        url: 'https://www.amazon.com/dp/B08N5WRWNW',
        title: 'Session One Product',
        price: 19.99,
        currency: 'USD',
        collectedAt: '2026-10-16T08:01:00.000Z',
        sessionKey: 'session_one',
        source: 'search',
      },
      {
        asin: 'B09XS7JWHH',
        url: 'https://www.amazon.com/dp/B09XS7JWHH',
        title: 'Session Two Product',
        price: 29.99,
        currency: 'USD',
        collectedAt: '2026-10-16T09:01:00.000Z',
        sessionKey: 'session_two',
        source: 'search',
      },
    ]);

    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));

    const sessionOneCard = await screen.findByTestId('history-entry-session_one');
    fireEvent.click(within(sessionOneCard).getByText('Delete'));
    const deleteDialog = await screen.findByRole('dialog', { name: 'Delete history entry?' });
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }));

    await waitFor(async () => {
      expect(await db.history.count()).toBe(1);
      const remainingProducts = await db.products.toArray();
      expect(remainingProducts).toHaveLength(1);
      expect(remainingProducts[0]?.sessionKey).toBe('session_two');
    });

    // Clear All removes remaining history and products
    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }));
    const clearDialog = await screen.findByRole('dialog', { name: 'Clear all history?' });
    fireEvent.click(within(clearDialog).getByRole('button', { name: 'Clear All' }));
    await waitFor(async () => {
      expect(await db.history.count()).toBe(0);
      expect(await db.products.count()).toBe(0);
    });
  });
});
