/**
 * SAD-358 — Expand option for truncated cells.
 *
 * Pins the acceptance criteria to the DOM so they fail loudly if they regress:
 *
 * 1. Every truncated cell renders an Expand button (hover-revealed via
 *    opacity-0 + group-hover:opacity-100, always visible on coarse pointers
 *    via the (hover:none) fallback and the max-[768px] utility).
 * 2. Clicking it opens a modal (role=dialog, aria-modal) whose body shows the
 *    COMPLETE value — no line-clamp/truncation classes inside the modal.
 * 3. Dismissal is easy and restores the table state: Close button, Escape,
 *    and backdrop click all close the modal, and focus returns to the
 *    trigger button (WCAG 2.4.3).
 * 4. Coarse-pointer devices can tap the cell itself (tap-cell) to expand.
 * 5. Empty values never render a dead affordance (no button, no tap handler).
 * 6. Both engines (Amazon + Temu) wire the singleton modal through the
 *    table-level meta.onExpand — one modal per table, not per row.
 *
 * Everything else (column ids/order/sizing, ROW_HEIGHT, sorting) is pinned by
 * tests/table-v9-contract.test.tsx and tests/preview-modes-and-sorting.test.tsx
 * and must stay green untouched.
 *
 * Note: per-row data-testids intentionally repeat across rows (one button per
 * row × column), so these tests either seed a single product or scope their
 * queries with getAll*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { AmazonProductTable } from '@/engines/amazon/ui/table/AmazonProductTable';
import { TemuProductTable } from '@/engines/temu/ui/table/TemuProductTable';
import { temuDb } from '@/engines/temu/db/database';
import { db } from '@/lib/db/database';

// Render every virtual row in jsdom without physical layout measurements
// (same mock as the other table tests).
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

const SESSION_AMZ = 'session-expand-amz';
const SESSION_TEMU = 'session-expand-temu';

const LONG_TITLE =
  'Ultra Premium Wireless Bluetooth 5.3 Headphones with Active Noise Cancelling, 60H Playtime, Hi-Res Audio, Memory Foam Ear Cups, Multipoint Connection, USB-C Fast Charging — Midnight Black';
// Joined with single spaces and NO trailing whitespace: getByText's default
// normalizer trims the DOM side of the comparison but not the expected string.
const LONG_DESCRIPTION = Array.from(
  { length: 8 },
  () =>
    'This is a deliberately long description that exceeds any line-clamp the table cell applies.'
).join(' ');
const FEATURES = [
  'Active Noise Cancelling with transparency mode',
  '60-hour battery life with USB-C fast charging',
  'Bluetooth 5.3 with multipoint pairing',
];

const AMAZON_BASE = {
  currency: 'USD',
  brand: 'ExpandCo',
  seller: 'Amazon',
  availability: 'In Stock',
  isSponsored: false,
  isPrime: true,
  imageUrl: null,
  source: 'search' as const,
  pageUrl: 'https://www.amazon.com/s?k=headphones',
  sessionKey: SESSION_AMZ,
};

/** One fully-populated product — every expandable cell has a value. */
async function seedAmazonProduct() {
  await db.products.bulkAdd([
    {
      ...AMAZON_BASE,
      asin: 'B0EXPAND01',
      title: LONG_TITLE,
      price: 129.99,
      rating: 4.5,
      reviewCount: 1234,
      bestSellersRank: '#3 in Over-Ear Headphones',
      pastMonthSales: '2K+ bought in past month',
      coupon: 'Save 10% with coupon',
      badge: 'Best Seller',
      delivery: 'FREE delivery Thu, Oct 22',
      url: 'https://www.amazon.com/dp/B0EXPAND01',
      description: LONG_DESCRIPTION,
      features: FEATURES,
      collectedAt: '2026-10-18T10:00:01.000Z',
    },
  ]);
}

/**
 * A second product without description/features — used to prove the
 * empty-value guard: only the row that HAS content gets an affordance.
 */
async function seedAmazonProductsWithoutExtras() {
  await seedAmazonProduct();
  await db.products.bulkAdd([
    {
      ...AMAZON_BASE,
      asin: 'B0EXPAND02',
      title: 'Plain Product Without Extras',
      price: 19.99,
      rating: 4,
      reviewCount: 10,
      url: 'https://www.amazon.com/dp/B0EXPAND02',
      description: null,
      features: [],
      collectedAt: '2026-10-18T10:00:02.000Z',
    },
  ]);
}

async function seedTemuProducts() {
  await temuDb.products.bulkAdd([
    {
      currency: 'USD',
      brand: 'TemuExpand',
      seller: 'Temu Direct',
      availability: 'In Stock',
      isSponsored: false,
      isPrime: false,
      imageUrl: null,
      source: 'search' as const,
      sessionId: SESSION_TEMU,
      goodsId: '601099000777',
      asin: '601099000777',
      title:
        'Omega Long Title That Definitely Needs Expanding In The Preview Table Cell',
      price: 25.5,
      rating: 4.4,
      reviewCount: 150,
      bestSellersRank: '#40 in Electronics',
      pastMonthSales: '1.2K+ sold',
      url: 'https://www.temu.com/goods.html?goods_id=601099000777',
      description: null,
      features: [],
      collectedAt: '2026-10-18T11:00:01.000Z',
    },
  ]);
}

describe('SAD-358 — Expand option for truncated cells', () => {
  beforeEach(async () => {
    await db.products.clear();
    await db.history.clear();
    await db.settings.clear();
    await temuDb.products.clear();
    await temuDb.history.clear();
    await temuDb.settings.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('renders an Expand button per truncated cell, hover-revealed and always visible on coarse-pointer layouts', async () => {
    await seedAmazonProduct();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    const titleBtn = await screen.findByTestId('cell-expand-button-title');
    expect(titleBtn.getAttribute('aria-label')).toBe('Expand Title');

    // Hover-reveal contract: hidden at rest, shown on row hover / focus, and
    // forced visible below 768px and on devices that cannot hover.
    const cls = titleBtn.className;
    expect(cls).toContain('opacity-0');
    expect(cls).toContain('group-hover:opacity-100');
    expect(cls).toContain('group-focus-within:opacity-100');
    expect(cls).toContain('max-[768px]:opacity-100');
    expect(cls).toContain('[@media(hover:none)]:opacity-100');

    // The other truncated fields of the seeded product expose buttons too.
    for (const columnId of [
      'bestSellersRank',
      'pastMonthSales',
      'coupon',
      'badge',
      'delivery',
      'brand',
      'seller',
      'availability',
      'url',
      'description',
      'features',
    ]) {
      expect(screen.getByTestId(`cell-expand-button-${columnId}`)).toBeTruthy();
    }
  });

  it('opens a modal with the complete, untruncated title and dismisses via the Close button with focus restored', async () => {
    await seedAmazonProduct();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    const titleBtn = await screen.findByTestId('cell-expand-button-title');
    titleBtn.focus();
    fireEvent.click(titleBtn);

    const modal = await screen.findByTestId('cell-expand-modal');
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');

    // The label header + full title body, with zero truncation styling inside
    // the modal — "complete content without truncation" (AC 3).
    expect(within(modal).getByText('Title')).toBeTruthy();
    const titleInModal = within(modal).getByText(LONG_TITLE);
    expect(titleInModal.className).not.toContain('line-clamp');
    expect(modal.className).not.toContain('line-clamp');
    // The title links to the product URL when available.
    expect(within(modal).getByTestId('cell-expand-title-link')).toBeTruthy();

    // Dismiss via Close button → modal gone, focus back on the trigger.
    fireEvent.click(screen.getByTestId('cell-expand-close-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('cell-expand-modal')).toBeNull();
      expect(document.activeElement).toBe(titleBtn);
    });

    // The table is fully usable afterwards (AC 5 — back to the table state).
    expect(screen.getByTestId('cell-expand-button-title')).toBeTruthy();
  });

  it('dismisses via Escape and via backdrop click', async () => {
    await seedAmazonProduct();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    const descBtn = await screen.findByTestId('cell-expand-button-description');

    // Escape
    fireEvent.click(descBtn);
    const modal = await screen.findByTestId('cell-expand-modal');
    fireEvent.keyDown(modal, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('cell-expand-modal')).toBeNull();
    });

    // Backdrop click (click-away)
    fireEvent.click(descBtn);
    await screen.findByTestId('cell-expand-modal');
    fireEvent.click(screen.getByTestId('cell-expand-backdrop'));
    await waitFor(() => {
      expect(screen.queryByTestId('cell-expand-modal')).toBeNull();
    });
  });

  it('shows the COMPLETE description and a formatted features list in the modal', async () => {
    await seedAmazonProduct();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    // Description: full text, no clamp inside the modal.
    fireEvent.click(await screen.findByTestId('cell-expand-button-description'));
    let modal = await screen.findByTestId('cell-expand-modal');
    const descInModal = within(modal).getByText(LONG_DESCRIPTION);
    expect(descInModal.tagName).toBe('P');
    expect(descInModal.className).toContain('whitespace-pre-wrap');
    expect(descInModal.className).not.toContain('line-clamp');
    fireEvent.click(screen.getByTestId('cell-expand-close-button'));
    await waitFor(() =>
      expect(screen.queryByTestId('cell-expand-modal')).toBeNull()
    );

    // Features: rendered as a real list, one <li> per feature, nothing dropped.
    fireEvent.click(await screen.findByTestId('cell-expand-button-features'));
    modal = await screen.findByTestId('cell-expand-modal');
    const list = within(modal).getByTestId('cell-expand-features-list');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(FEATURES);
  });

  it('shows the full URL with open + copy actions for the URL column', async () => {
    await seedAmazonProduct();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    fireEvent.click(await screen.findByTestId('cell-expand-button-url'));
    const modal = await screen.findByTestId('cell-expand-modal');
    const FULL_URL = 'https://www.amazon.com/dp/B0EXPAND01';
    expect(
      within(modal).getByTestId('cell-expand-url-value').textContent
    ).toBe(FULL_URL);
    const openLink = within(modal).getByTestId('cell-expand-url-open');
    expect(openLink.getAttribute('href')).toBe(FULL_URL);
    expect(openLink.getAttribute('target')).toBe('_blank');
    expect(within(modal).getByTestId('cell-expand-url-copy')).toBeTruthy();
  });

  it('tap-cell: on coarse pointers clicking the cell itself expands it (responsive/mobile criterion)', async () => {
    await seedAmazonProduct();

    // jsdom has no matchMedia — emulate a touch device for this test only.
    window.matchMedia = ((query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    const tapZone = await screen.findByTestId('cell-expand-tap-title');
    fireEvent.click(tapZone);
    expect(await screen.findByTestId('cell-expand-modal')).toBeTruthy();
    expect(
      within(screen.getByTestId('cell-expand-modal')).getByText(LONG_TITLE)
    ).toBeTruthy();
  });

  it('never renders a dead affordance for empty values (no button, no tap handler)', async () => {
    await seedAmazonProductsWithoutExtras();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    // Both rows have a title → two title affordances (per-row wiring).
    await waitFor(() => {
      expect(screen.getAllByLabelText('Expand Title')).toHaveLength(2);
    });

    // Row 2 has description=null and features=[] → the column returns null
    // before ExpandableCell ever renders: exactly one affordance each.
    expect(screen.getAllByLabelText('Expand Description')).toHaveLength(1);
    expect(screen.getAllByLabelText('Expand Features')).toHaveLength(1);
    expect(
      screen.getAllByTestId('cell-expand-tap-description')
    ).toHaveLength(1);
  });

  it('Temu wires the same singleton modal through meta.onExpand', async () => {
    await seedTemuProducts();
    render(<TemuProductTable fullHeight sessionId={SESSION_TEMU} />);

    const titleBtn = await screen.findByTestId('cell-expand-button-title');
    fireEvent.click(titleBtn);

    const modal = await screen.findByTestId('cell-expand-modal');
    expect(within(modal).getByText('Title')).toBeTruthy();
    expect(
      within(modal).getByText(
        'Omega Long Title That Definitely Needs Expanding In The Preview Table Cell'
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('cell-expand-footer-close'));
    await waitFor(() =>
      expect(screen.queryByTestId('cell-expand-modal')).toBeNull()
    );
  });

  it('opens exactly one modal at a time (singleton per table)', async () => {
    await seedAmazonProduct();
    render(<AmazonProductTable fullHeight sessionKey={SESSION_AMZ} />);

    fireEvent.click(await screen.findByTestId('cell-expand-button-brand'));
    await screen.findByTestId('cell-expand-modal');

    // Switch content by closing and opening another cell — only one modal node.
    fireEvent.click(screen.getByTestId('cell-expand-close-button'));
    await waitFor(() =>
      expect(screen.queryByTestId('cell-expand-modal')).toBeNull()
    );

    fireEvent.click(await screen.findByTestId('cell-expand-button-seller'));
    const modal = await screen.findByTestId('cell-expand-modal');
    expect(within(modal).getByText('Seller')).toBeTruthy();
    expect(screen.getAllByTestId('cell-expand-modal')).toHaveLength(1);
  });
});
