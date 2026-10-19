/**
 * SAD-286 (P3.2) - the panel's view of "where does the next save land".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeCollectionCurrent,
  readCurrentCollection,
} from '@/engines/amazon/ui/currentCollection';
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

beforeEach(() => {
  storageStub();
});

describe('current collection', () => {
  it('reports nothing before the first save', async () => {
    expect(await readCurrentCollection()).toBeNull();
  });

  it('reports the pointer written by a save', async () => {
    await makeCollectionCurrent('oc_1700000000000', 'Anker 65W Charger');

    expect(await readCurrentCollection()).toEqual({
      sessionKey: 'oc_1700000000000',
      name: 'Anker 65W Charger',
    });
  });

  it('make current replaces the pointer, so the next save follows it', async () => {
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
