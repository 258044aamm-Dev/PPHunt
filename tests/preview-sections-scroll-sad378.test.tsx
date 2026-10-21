import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { FullWidthPreviewModal } from '@/entrypoints/sidepanel/components/FullWidthPreviewModal';
import { useAmazonUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { db } from '@/lib/db/database';

/**
 * SAD-378 — "Preview horizontal scroll behavior".
 *
 * Sections mode (`separateCategorySections: true`) used to give every category
 * card its own `overflow-x-auto` around a `totalTableWidth`-wide table. The
 * outer `preview-table-scroll-container` therefore had `scrollWidth ===
 * clientWidth`: it could not scroll at all, and the Arrow/Shift+wheel handlers
 * bound to it were dead. The only working scrollbar was painted at the bottom
 * of a section that is thousands of pixels tall — users had to scroll down
 * before they could scroll sideways.
 *
 * jsdom performs no layout, so the *geometry* proof lives in the Chromium
 * harness recorded on SAD-378 and in the plan at
 * `docs/plans/SAD-378-preview-horizontal-scroll-plan.md` §8.2. These tests pin
 * the *structural* contract that makes that geometry possible:
 *
 *   1. exactly one horizontal scroll surface (no nested `.overflow-x-auto`),
 *   2. the sections wrapper can actually produce overflow (`w-max min-w-full`),
 *   3. cards are clipped but are NOT scroll containers (`overflow-clip`),
 *   4. header bars are pinned and scrollport-sized (`sticky left-0 w-[100cqw]`),
 *   5. `100cqw` has a size container to resolve against (`container-type`),
 *   6. keyboard / wheel input reaches the one scroll surface,
 *   7. collapsing a section still works (unchanged SAD-265 behaviour).
 *
 * The pre-existing SAD-138 suite in `preview-horizontal-scroll.test.tsx` is
 * left untouched: it covers the default (Sections OFF) table, which this change
 * must not alter.
 *
 * Which of these actually fail on the unfixed code (verified by running this
 * file against `main` @ 5e24561): the structure test, the `container-type`
 * test and the toolbar test — 3 of 5. The other two are deliberate contract
 * guards: jsdom cannot see that the old outer container had no overflow, so the
 * Arrow/Shift+wheel test passes either way and exists to keep the *routing* of
 * those inputs on the one scroll surface, and the collapse test must stay green
 * both before and after (it protects SAD-265 behaviour from this refactor).
 */

// jsdom does no layout, so render every row instead of relying on measurements.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        end: (index + 1) * 52,
        size: 52,
      })),
  }),
}));

const SESSION_KEY = 'session_sections_378';

function product(asin: string, overrides: Record<string, unknown> = {}) {
  return {
    asin,
    title: `Sections product ${asin}`,
    price: 19.99,
    currency: 'USD',
    rating: 4.5,
    reviewCount: 120,
    brand: 'TestBrand',
    seller: 'TestSeller',
    availability: 'In Stock',
    isSponsored: false,
    isPrime: true,
    url: `https://www.amazon.com/dp/${asin}`,
    imageUrl: null,
    description: null,
    features: [],
    collectedAt: '2026-10-21T03:00:00.000Z',
    source: 'search',
    sessionKey: SESSION_KEY,
    ...overrides,
  };
}

async function openSectionsPreview() {
  await db.products.bulkAdd([
    product('B0SECTIONS1', { sectionLabel: 'Organic' }),
    product('B0SECTIONS2', { isSponsored: true, sectionLabel: 'Sponsored' }),
  ] as never);

  act(() => {
    useAmazonUIStore.getState().openPreviewOverlay(SESSION_KEY, 'sidebar');
  });

  render(<FullWidthPreviewModal />);

  return waitFor(() =>
    screen.getByTestId('preview-table-scroll-container'),
  );
}

describe('Preview Sections mode uses one horizontal scroll surface (SAD-378)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    useCollectionStore.getState().reset();
    useAmazonUIStore.setState({
      activeTab: 'collect',
      settingsOpen: false,
      exportModalOpen: false,
      completionDialogOpen: false,
      previewOverlayOpen: false,
      previewMode: 'sidebar',
      selectedSessionKey: null,
    });
    // The reported case: "Separate collapsible category sections" is ON.
    await db.settings.put({
      id: 'default',
      separateCategorySections: true,
    } as never);

    vi.stubGlobal('browser', {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 21, url: 'https://www.amazon.com/s?k=monitors' },
        ]),
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
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

  it('renders sections inside the single preview-table-scroll container with no nested horizontal scroller', async () => {
    const container = await openSectionsPreview();

    // The sections branch is actually rendered (otherwise the rest proves nothing).
    const wrapper = container.querySelector(
      '[data-testid="collapsible-category-sections"]',
    );
    expect(wrapper).toBeTruthy();

    // 1. One horizontal scroll surface only — the outer container.
    expect(container.className).toContain('preview-table-scroll');
    expect(container.className).toContain('overflow-x-auto');
    expect(container.className).toContain('overflow-y-auto');
    expect(container.querySelectorAll('.overflow-x-auto')).toHaveLength(0);

    // 2. The wrapper can produce horizontal overflow for the outer container.
    expect(wrapper!.className).toContain('w-max');
    expect(wrapper!.className).toContain('min-w-full');

    // 3. Cards clip to their rounded border but are not scroll containers,
    //    which is what lets the outer container own the scrollbar and keeps
    //    `position: sticky` on the header bar pointing at the scroller.
    for (const category of ['organic', 'sponsored', 'recommendation']) {
      const card = screen.getByTestId(`category-section-${category}`);
      expect(card.className).toContain('overflow-clip');
      expect(card.className).not.toContain('overflow-hidden');
      // The table itself is still full width — it is what overflows now.
      const table = card.querySelector('table');
      expect(table).toBeTruthy();
      expect(Number.parseInt(table!.style.width || '0', 10)).toBeGreaterThan(1000);
      expect(table!.style.minWidth).toBe(table!.style.width);
    }

    // 4. Header bars are pinned to the scrollport and sized to it, not to the
    //    ~3354px table (`w-full` inside the widened card would be the table).
    for (const category of ['organic', 'sponsored', 'recommendation']) {
      const toggle = screen.getByTestId(`category-section-toggle-${category}`);
      expect(toggle.className).toContain('sticky');
      expect(toggle.className).toContain('left-0');
      expect(toggle.className).toContain('z-10');
      expect(toggle.className).toContain('w-[100cqw]');
      expect(toggle.className).not.toContain('w-full');
    }
  });

  it('keeps a size container on the scroll surface so `100cqw` resolves to the visible width', () => {
    // A CSS-file change is invisible to jsdom, so pin the declaration itself:
    // without `container-type`, `w-[100cqw]` falls back to auto and the header
    // bars stretch to the table width again.
    const css = readFileSync(
      join(__dirname, '..', 'src', 'entrypoints', 'sidepanel', 'global.css'),
      'utf8',
    );
    const blockStart = css.indexOf('.preview-table-scroll {');
    expect(blockStart).toBeGreaterThan(-1);
    const block = css.slice(blockStart, css.indexOf('}', blockStart));
    expect(block).toContain('container-type: inline-size');
  });

  it('routes Arrow keys and Shift+wheel to the single scroll surface in Sections mode', async () => {
    const container = await openSectionsPreview();

    expect(container.scrollLeft).toBe(0);

    fireEvent.keyDown(container, { key: 'ArrowRight' });
    expect(container.scrollLeft).toBe(120);

    fireEvent.keyDown(container, { key: 'ArrowRight' });
    expect(container.scrollLeft).toBe(240);

    fireEvent.keyDown(container, { key: 'ArrowLeft' });
    expect(container.scrollLeft).toBe(120);

    fireEvent.wheel(container, {
      deltaY: 160,
      deltaX: 0,
      shiftKey: true,
    });
    expect(container.scrollLeft).toBe(280);

    // Typing in the filter input must not scroll the table (unchanged SAD-138
    // contract, re-checked with sections ON).
    const searchInput = screen.getByPlaceholderText(/Filter by title or ASIN/i);
    fireEvent.keyDown(searchInput, { key: 'ArrowLeft' });
    expect(container.scrollLeft).toBe(280);
  });

  it('still collapses and expands a section after the card stopped being a scroll container', async () => {
    await openSectionsPreview();

    const organicCard = screen.getByTestId('category-section-organic');
    const toggle = screen.getByTestId('category-section-toggle-organic');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(organicCard.querySelector('table')).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(organicCard.querySelector('table')).toBeNull();
    });

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(organicCard.querySelector('table')).toBeTruthy();
    });
  });

  it('wraps the sort controls instead of clipping them in a narrow panel (SAD-378)', async () => {
    await openSectionsPreview();

    const preset = screen.getByTestId('table-sort-preset-select');
    const addSort = screen.getByTestId('table-add-sort-select');
    const group = preset.parentElement!;

    // The group used to be `shrink-0` with no wrap, so its 407px intrinsic
    // width overflowed the row and `overflow-hidden` clipped `+ Sort Field`.
    expect(group.className).toContain('flex-wrap');
    expect(group.className).not.toContain('shrink-0');
    expect(group.className).toContain('min-w-0');
    expect(group.className).toContain('max-w-full');
    expect(preset.className).toContain('max-w-full');
    expect(addSort.className).toContain('max-w-full');
  });
});
