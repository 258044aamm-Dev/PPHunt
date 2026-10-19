/**
 * SAD-285 (P3.1) - where a one-click save lands.
 *
 * The three behaviours must not be able to corrupt a full-page run: no pointer
 * is reused when its History row is gone, no pointer is reused when it points at
 * a `sessions` row, and nothing here ever writes `db.sessions`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { addHistoryEntry, getHistoryEntries } from '@/engines/amazon/db/history';
import { createSession } from '@/engines/amazon/db/sessions';
import {
  ONE_CLICK_COLLECTION_STORAGE_KEY,
  readOneClickCollection,
  writeOneClickCollection,
} from '@/engines/amazon/db/one-click-state';
import { updateSettings } from '@/engines/amazon/db/settings';
import {
  isFullPageSession,
  resolveCollectionTarget,
} from '@/engines/amazon/background/collections';
import {
  handleSaveProduct,
  resetSaveJobsForTests,
} from '@/engines/amazon/background/save-job';
import type { ScrapedProduct } from '@/engines/amazon/types';

const PAGE_URL = 'https://www.amazon.com/s?k=charger';

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.com/dp/B08N5WRWNW',
    title: 'Anker 65W Charger',
    price: 19.99,
    currency: 'USD',
    source: 'search',
    ...overrides,
  };
}

function storageStub() {
  const map = new Map<string, unknown>();
  (globalThis as unknown as { browser?: unknown }).browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) =>
          map.has(key) ? { [key]: map.get(key) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) map.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
          map.delete(key);
        }),
      },
    },
  };
  return map;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  resetSaveJobsForTests();
  storageStub();
});

describe('behavior: current (default)', () => {
  it('creates one collection and reuses it for the next product', async () => {
    const first = await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product() });
    const second = await resolveCollectionTarget({
      pageUrl: PAGE_URL,
      product: product({ asin: 'B0SECONDAA', title: 'Second Product' }),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(await db.history.count()).toBe(1);
  });

  it('uses the default setting without being told', async () => {
    const target = await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product() });
    const settings = await (await import('@/engines/amazon/db/settings')).getSettings();

    expect(settings.quickSaveCollectionBehavior).toBe('current');
    expect(target.sessionKey.startsWith('oc_')).toBe(true);
  });
});

describe('behavior: new', () => {
  it('creates a separate collection per product', async () => {
    const first = await resolveCollectionTarget({
      pageUrl: PAGE_URL,
      product: product(),
      behavior: 'new',
    });
    const second = await resolveCollectionTarget({
      pageUrl: PAGE_URL,
      product: product({ asin: 'B0SECONDAA', title: 'Second Product' }),
      behavior: 'new',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.sessionKey).not.toBe(first.sessionKey);
    expect(await db.history.count()).toBe(2);
    expect(await readOneClickCollection()).toMatchObject({
      sessionKey: second.sessionKey,
    });
  });

  it('de-duplicates the display label instead of rejecting the collection', async () => {
    const first = await resolveCollectionTarget({
      pageUrl: PAGE_URL,
      product: product(),
      behavior: 'new',
    });
    const second = await resolveCollectionTarget({
      pageUrl: PAGE_URL,
      product: product(),
      behavior: 'new',
    });

    expect(first.label).toBe('Anker 65W Charger');
    expect(second.label).toBe('Anker 65W Charger (2)');
  });
});

describe('behavior: ask', () => {
  it('persists into the current collection and reports that a choice is needed', async () => {
    const target = await resolveCollectionTarget({
      pageUrl: PAGE_URL,
      product: product(),
      behavior: 'ask',
    });

    expect(target.requiresChoice).toBe(true);
    expect(target.defaultCollectionKey).toBe(target.sessionKey);
    expect(target.created).toBe(true);
  });

  it('surfaces the choice fields through a real save', async () => {
    await updateSettings({ quickSaveCollectionBehavior: 'ask' });

    const result = await handleSaveProduct({
      jobId: 'job-ask',
      product: product(),
      context: {
        pageType: 'search',
        pageUrl: PAGE_URL,
        triggeredBy: 'card-button',
      },
    });

    expect(result.state).toBe('completed');
    expect(result.requiresCollectionChoice).toBe(true);
    expect(result.defaultCollectionKey).toBe(result.collectionKey);
  });
});

describe('guards', () => {
  it('creates a new collection when the pointed-at History row is gone', async () => {
    await writeOneClickCollection({
      sessionKey: 'oc_1700000000000',
      name: 'Deleted collection',
      createdAt: '2026-10-19T10:00:00.000Z',
      updatedAt: '2026-10-19T10:00:00.000Z',
    });

    const target = await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product() });

    expect(target.created).toBe(true);
    expect(target.sessionKey).not.toBe('oc_1700000000000');
  });

  it('never adopts a full-page run, even when a History row exists', async () => {
    const sessionKey = await createSession(7, PAGE_URL, 'manual', 20);
    await addHistoryEntry({
      sessionKey,
      url: PAGE_URL,
      mode: 'manual',
      targetCount: 20,
      collectedCount: 4,
      startedAt: '2026-10-19T09:00:00.000Z',
      completedAt: '2026-10-19T09:05:00.000Z',
      status: 'completed',
    });
    await writeOneClickCollection({
      sessionKey,
      name: 'Full page run',
      createdAt: '2026-10-19T09:00:00.000Z',
      updatedAt: '2026-10-19T09:05:00.000Z',
    });

    const target = await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product() });

    expect(target.created).toBe(true);
    expect(target.sessionKey).not.toBe(sessionKey);
    expect(await isFullPageSession(target.sessionKey)).toBe(false);
  });

  it('declares a full-page session as such and leaves it untouched', async () => {
    const sessionKey = await createSession(8, PAGE_URL, 'automatic', 20);
    const before = await db.sessions.get(sessionKey);

    const target = await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product() });

    expect(await isFullPageSession(sessionKey)).toBe(true);
    expect(await db.sessions.get(sessionKey)).toEqual(before);
    expect(target.sessionKey).not.toBe(sessionKey);
  });

  it('never creates a sessions row', async () => {
    await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product() });
    await resolveCollectionTarget({ pageUrl: PAGE_URL, product: product(), behavior: 'new' });
    await handleSaveProduct({
      jobId: 'job-1',
      product: product(),
      context: { pageType: 'search', pageUrl: PAGE_URL, triggeredBy: 'context-menu' },
    });

    expect(await db.sessions.count()).toBe(0);
    expect((await getHistoryEntries()).every((row) => row.origin === 'one-click')).toBe(
      true,
    );
  });

  it('reads a pointer written by a pre-SAD-285 build (`label`)', async () => {
    (globalThis as unknown as { browser: unknown }).browser = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [ONE_CLICK_COLLECTION_STORAGE_KEY]: {
              sessionKey: 'oc_legacy',
              label: 'Legacy label',
              createdAt: '2026-10-19T09:00:00.000Z',
              updatedAt: '2026-10-19T09:00:00.000Z',
            },
          })),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    };

    expect(await readOneClickCollection()).toEqual({
      sessionKey: 'oc_legacy',
      name: 'Legacy label',
      createdAt: '2026-10-19T09:00:00.000Z',
      updatedAt: '2026-10-19T09:00:00.000Z',
    });
  });
});
