/**
 * SAD-286 (P3.2) - the panel's view of "where does the next save land".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeCollectionCurrent,
  readCurrentCollection,
} from '@/engines/amazon/ui/currentCollection';
import { db } from '@/lib/db/database';
import { addHistoryEntry } from '@/engines/amazon/db/history';
import { readOneClickCollection } from '@/engines/amazon/db/one-click-state';

function storageStub() {
  const map = new Map<string, unknown>();
  (globalThis as unknown as { browser?: unknown }).browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (map.has(key) ? { [key]: map.get(key) } : {})),
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
  storageStub();
});

function oneClickRow(sessionKey: string, name: string) {
  return {
    sessionKey,
    url: 'https://www.amazon.com/s?k=charger',
    mode: 'manual' as const,
    targetCount: 0,
    collectedCount: 0,
    startedAt: '2026-10-19T10:00:00.000Z',
    completedAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    status: 'completed' as const,
    name,
    origin: 'one-click' as const,
  };
}

describe('current collection', () => {
  it('reports nothing before the first save', async () => {
    expect(await readCurrentCollection()).toBeNull();
  });

  it('reports the pointer written by a save', async () => {
    await addHistoryEntry(oneClickRow('oc_1700000000000', 'Anker 65W Charger'));
    await makeCollectionCurrent('oc_1700000000000', 'Anker 65W Charger');

    expect(await readCurrentCollection()).toEqual({
      sessionKey: 'oc_1700000000000',
      name: 'Anker 65W Charger',
    });
  });

  it('make current replaces the pointer, so the next save follows it', async () => {
    await addHistoryEntry(oneClickRow('oc_1', 'First'));
    await addHistoryEntry(oneClickRow('oc_2', 'Second'));
    await makeCollectionCurrent('oc_1', 'First');
    await makeCollectionCurrent('oc_2', 'Second');

    expect((await readOneClickCollection())?.sessionKey).toBe('oc_2');
    expect((await readCurrentCollection())?.name).toBe('Second');
  });

  it('degrades to null when storage is unavailable', async () => {
    (globalThis as unknown as { browser?: unknown }).browser = undefined;

    expect(await readCurrentCollection()).toBeNull();
    await expect(makeCollectionCurrent('oc_1', 'First')).resolves.toBeUndefined();
  });
});

describe('deleted collections', () => {
  it('stops being current when its History row is deleted', async () => {
    await makeCollectionCurrent('oc_gone', 'Deleted');

    expect(await readOneClickCollection()).not.toBeNull();
    expect(await readCurrentCollection()).toBeNull();
  });
});
