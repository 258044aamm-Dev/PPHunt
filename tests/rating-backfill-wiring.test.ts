/**
 * SAD-383 step 4 — wiring: a collection batch fills the two fields its cards
 * could not print, and only when the switch is on.
 *
 * This drives the **real** background listener (`@/entrypoints/background`), the
 * real settings row, the real queue, the real popover parser and the real
 * database. Only the network call is replaced — with the payload Amazon actually
 * served on 2026-10-21 — so a green test means the production message path works,
 * not that two mocks agree.
 *
 * The OFF case is the non-regression promise of this ticket: setting
 * `backfillCollectedRatings` to false must mean no request, no queue and no write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirror the loose listener signatures */

const POPOVER_HTML = readFileSync(
  join(__dirname, '..', 'docs', 'plans', 'SAD-383-fixtures', 'rating-popover.real.html'),
  'utf8',
);

const fetchRatingPopover = vi.fn();

vi.mock('@/engines/amazon/background/rating-fetch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The real function's contract is a classified outcome; only the request is faked.
    fetchRatingPopover: (...args: unknown[]) => fetchRatingPopover(...args),
  };
});

type Listener = (...args: any[]) => any;

function event() {
  const listeners: Listener[] = [];
  return {
    addListener: vi.fn((callback: Listener) => {
      listeners.push(callback);
    }),
    removeListener: vi.fn(() => {}),
    emit: (...args: any[]) => {
      for (const listener of [...listeners]) listener(...args);
    },
    current: () => listeners[0] ?? (() => {}),
  };
}

async function startBackground() {
  const onMessage = event();
  const mockBrowser = {
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: event(),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: event(),
    },
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    runtime: {
      onMessage,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getURL: vi.fn().mockReturnValue('chrome-extension://x/overlay.html'),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: true }]) },
  };
  vi.stubGlobal('browser', mockBrowser);
  vi.stubGlobal('defineBackground', (main: () => void) => main);

  const { default: main } = await import('@/entrypoints/background');
  (main as unknown as () => void)();
  await waitFor(() => expect(mockBrowser.action.setPopup).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { onMessage };
}

const SENDER = {
  id: 1,
  tab: { url: 'https://www.amazon.com/deals', status: 'complete' },
};

function drive(onMessage: ReturnType<typeof event>, message: unknown) {
  const sendResponse = vi.fn();
  const listener = onMessage.current() as (
    message: unknown,
    sender: unknown,
    respond: (response?: unknown) => void,
  ) => unknown;
  const result = listener(message, SENDER, sendResponse);
  return { result, sendResponse };
}

interface CardInput {
  asin: string;
  rating?: number;
  reviewCount?: number;
}

function collected(products: CardInput[]) {
  return {
    type: 'PRODUCTS_COLLECTED',
    payload: {
      products: products.map(({ asin, rating, reviewCount }) => ({
        asin,
        title: `Product ${asin}`,
        url: `https://www.amazon.com/dp/${asin}`,
        price: 19.99,
        currency: 'USD',
        imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
        source: 'category',
        ...(rating === undefined ? {} : { rating }),
        ...(reviewCount === undefined ? {} : { reviewCount }),
      })),
      totalCount: products.length,
      isNewBatch: true,
    },
  };
}

/** Distinct ASINs per test: the collection path dedupes against stored rows. */
let asinBase = 0;
const ASINS = (count: number): CardInput[] => {
  const start = asinBase;
  asinBase += count;
  return Array.from({ length: count }, (_, index) => ({
    asin: `B${String(start + index).padStart(9, '0')}`,
  }));
};

async function rowFor(asin: string) {
  const { db } = await import('@/engines/amazon/db/database');
  return db.products.where('asin').equals(asin).first();
}

beforeEach(async () => {
  vi.resetModules();
  // The settings row lives in one fake-indexeddb per file, so a test that turns
  // the switch off would otherwise leak into the next one.
  const { resetSettings } = await import('@/engines/amazon/db/settings');
  await resetSettings();
  fetchRatingPopover.mockReset();
  fetchRatingPopover.mockResolvedValue({ status: 'ok', html: POPOVER_HTML });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  const pump = await import('@/engines/amazon/background/rating-backfill');
  pump.resetRatingBackfillForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SAD-383: the switch is the only thing that decides', () => {
  it('with the switch OFF: no request, no queue, and the row is unchanged', async () => {
    const { updateSettings } = await import('@/engines/amazon/db/settings');
    await updateSettings({ backfillCollectedRatings: false });

    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/rating-backfill');
    const [card] = ASINS(1);

    drive(onMessage, collected([card!]));
    await pump.whenRatingBackfillIdle();
    await waitFor(async () => expect(await rowFor(card!.asin)).toBeDefined());

    expect(fetchRatingPopover).not.toHaveBeenCalled();
    const row = await rowFor(card!.asin);
    expect(row?.rating).toBeNull();
    expect(row?.reviewCount).toBeNull();
  });

  it('with the switch ON (the default): the row gains the pair a save would have', async () => {
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/rating-backfill');
    const [card] = ASINS(1);

    drive(onMessage, collected([card!]));
    await pump.whenRatingBackfillIdle();

    await waitFor(async () => {
      const row = await rowFor(card!.asin);
      expect(row?.rating).toBe(4.6);
    });

    const row = await rowFor(card!.asin);
    expect(row?.rating).toBe(4.6);
    expect(row?.reviewCount).toBe(142457);
    expect(fetchRatingPopover).toHaveBeenCalledTimes(1);
    // Fetched from the product's own URL, for the product's own ASIN.
    expect(fetchRatingPopover).toHaveBeenCalledWith(
      `https://www.amazon.com/dp/${card!.asin}`,
      card!.asin,
    );
  });

  it('never fetches for a product whose card already printed both values', async () => {
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/rating-backfill');

    const rated = ASINS(1)[0]!;
    const unrated = ASINS(1)[0]!;
    drive(
      onMessage,
      collected([
        { ...rated, rating: 4.1, reviewCount: 12 },
        unrated,
      ]),
    );
    await pump.whenRatingBackfillIdle();

    await waitFor(async () => expect((await rowFor(unrated.asin))?.rating).toBe(4.6));

    expect(fetchRatingPopover).toHaveBeenCalledTimes(1);
    expect(fetchRatingPopover).toHaveBeenCalledWith(
      expect.stringContaining(unrated.asin),
      unrated.asin,
    );
    // The card's own number is the value the user saw — it stays.
    const ratedRow = await rowFor(rated.asin);
    expect(ratedRow?.rating).toBe(4.1);
    expect(ratedRow?.reviewCount).toBe(12);
  });

  it('one ASIN is fetched once even though a later batch re-sends the run', async () => {
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/rating-backfill');
    const [card] = ASINS(1);

    drive(onMessage, collected([card!]));
    // The message path is deliberately not awaited by the sender, so wait for the
    // queue to pick the product up before asking it to drain.
    await waitFor(() => expect(fetchRatingPopover).toHaveBeenCalledTimes(1));
    await pump.whenRatingBackfillIdle();

    // `updatedExisting` re-sends the whole run; the same ASIN must not be re-fetched.
    drive(onMessage, collected([card!]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchRatingPopover).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch leaves the row exactly as the card described it', async () => {
    fetchRatingPopover.mockResolvedValue({ status: 'failed', reason: 'http' });
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/rating-backfill');
    const [card] = ASINS(1);

    drive(onMessage, collected([card!]));
    await pump.whenRatingBackfillIdle();
    await waitFor(async () => expect(await rowFor(card!.asin)).toBeDefined());

    const row = await rowFor(card!.asin);
    expect(row?.rating).toBeNull();
    expect(row?.title).toBe(`Product ${card!.asin}`);
  });

  it('a breaker-open outcome stops the rest of the run', async () => {
    fetchRatingPopover.mockResolvedValue({ status: 'skipped', reason: 'circuit-open' });
    const { onMessage } = await startBackground();
    const pump = await import('@/engines/amazon/background/rating-backfill');

    const cards = ASINS(5);
    drive(onMessage, collected(cards));
    await waitFor(() => expect(fetchRatingPopover).toHaveBeenCalled());
    await pump.whenRatingBackfillIdle();

    // One attempt proves the host is blocked; the remaining four are not tried.
    expect(fetchRatingPopover).toHaveBeenCalledTimes(1);
    for (const card of cards) {
      expect((await rowFor(card.asin))?.rating).toBeNull();
    }
  });
});
