import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { FullWidthPreviewModal } from '@/entrypoints/sidepanel/components/FullWidthPreviewModal';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { db } from '@/lib/db/database';

describe('Preview Section Horizontal Scrollbar & Input Methods in Small Sidebar (SAD-138)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    useUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      exportModalOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      selectedSessionKey: null,
    });
    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 21,
            url: 'https://www.amazon.com/s?k=monitors',
          },
        ]),
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('renders a unified scroll container with visible horizontal overflow in a small sidebar and no clipping maxHeight', async () => {
    await db.products.bulkAdd([
      {
        asin: 'B08N5WRWNW',
        title: 'UltraWide 34-Inch Curved Monitor',
        price: 399.99,
        currency: 'USD',
        rating: 4.7,
        reviewCount: 2450,
        brand: 'ProDisplay',
        seller: 'Amazon.com',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        url: 'https://www.amazon.com/dp/B08N5WRWNW',
        imageUrl: 'https://m.media-amazon.com/images/I/monitor1.jpg',
        description: null,
        features: [],
        collectedAt: '2026-10-16T12:00:00.000Z',
        source: 'search',
        sessionKey: 'session_scroll_1',
      },
    ]);

    act(() => {
      useUIStore.getState().openPreviewOverlay('session_scroll_1');
    });

    render(<FullWidthPreviewModal />);

    const scrollContainer = await waitFor(() =>
      screen.getByTestId('preview-table-scroll-container')
    );

    // Must be a single unified scroll container with overflow-x-auto, overflow-y-auto, and preview-table-scroll class
    expect(scrollContainer.className).toContain('preview-table-scroll');
    expect(scrollContainer.className).toContain('overflow-x-auto');
    expect(scrollContainer.className).toContain('overflow-y-auto');
    expect(scrollContainer.className).toContain('flex-1');
    expect(scrollContainer.className).toContain('min-h-0');
    expect(scrollContainer.className).toContain('min-w-0');

    // In fullHeight preview mode, maxHeight must not be set so the horizontal scrollbar stays pinned at the bottom of the flex container
    expect(scrollContainer.style.maxHeight).toBe('');

    const table = scrollContainer.querySelector('table');
    expect(table).toBeTruthy();
    const tableWidthPx = parseInt(table?.style.width ?? '0', 10);
    // Table width across all default columns (~1632px) exceeds a small sidebar width (360px)
    expect(tableWidthPx).toBeGreaterThan(1000);
    expect(table?.style.minWidth).toBe(`${tableWidthPx}px`);
  });

  it('allows horizontal scrolling via scrollbar (scrollLeft), Shift+Wheel, and Left/Right Arrow keys without interfering with search input', async () => {
    await db.products.bulkAdd([
      {
        asin: 'B09XS7JWHH',
        title: 'Mechanical Wireless Keyboard',
        price: 129.0,
        currency: 'USD',
        rating: 4.8,
        reviewCount: 890,
        brand: 'KeyCraft',
        seller: 'KeyCraft Official',
        availability: 'In Stock',
        isSponsored: false,
        isPrime: true,
        url: 'https://www.amazon.com/dp/B09XS7JWHH',
        imageUrl: 'https://m.media-amazon.com/images/I/keyboard1.jpg',
        description: null,
        features: [],
        collectedAt: '2026-10-16T12:05:00.000Z',
        source: 'search',
        sessionKey: 'session_scroll_2',
      },
    ]);

    act(() => {
      useUIStore.getState().openPreviewOverlay('session_scroll_2');
    });

    render(<FullWidthPreviewModal />);

    const scrollContainer = await waitFor(() =>
      screen.getByTestId('preview-table-scroll-container')
    );

    expect(scrollContainer.scrollLeft).toBe(0);

    // 1. Keyboard ArrowRight / ArrowLeft scrolling on the table region
    fireEvent.keyDown(scrollContainer, { key: 'ArrowRight' });
    expect(scrollContainer.scrollLeft).toBe(120);

    fireEvent.keyDown(scrollContainer, { key: 'ArrowRight' });
    expect(scrollContainer.scrollLeft).toBe(240);

    fireEvent.keyDown(scrollContainer, { key: 'ArrowLeft' });
    expect(scrollContainer.scrollLeft).toBe(120);

    // 2. Shift + Wheel horizontal scrolling
    fireEvent.wheel(scrollContainer, {
      deltaY: 160,
      deltaX: 0,
      shiftKey: true,
    });
    expect(scrollContainer.scrollLeft).toBe(280);

    // 3. Direct scrollbar position update
    scrollContainer.scrollLeft = 450;
    fireEvent.scroll(scrollContainer);
    expect(scrollContainer.scrollLeft).toBe(450);

    // 4. Pressing ArrowLeft inside the filter input does not scroll the table
    const searchInput = screen.getByPlaceholderText(
      /Filter by title or ASIN/i
    );
    fireEvent.keyDown(searchInput, { key: 'ArrowLeft' });
    expect(scrollContainer.scrollLeft).toBe(450);
  });
});
