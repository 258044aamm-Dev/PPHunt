import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db } from '../../db/database';

import {
  makeCollectionCurrent,
  readCurrentCollection,
  type CurrentCollection,
} from '../currentCollection';
import { ONE_CLICK_COLLECTION_STORAGE_KEY } from '../../db/one-click-state';

interface StorageChangeArea {
  onChanged?: {
    addListener: (listener: (changes: Record<string, unknown>, area: string) => void) => void;
    removeListener?: (listener: (changes: Record<string, unknown>, area: string) => void) => void;
  };
}

/**
 * SAD-286: the current one-click collection, kept live through
 * `storage.onChanged` so the badge and the "new saves go to" line follow the
 * pointer without a reload.
 */
export function useCurrentCollection() {
  const [current, setCurrent] = useState<CurrentCollection | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setCurrent(await readCurrentCollection());
    setIsLoading(false);
  }, []);

  // Re-read when a history row is added or deleted, so a deleted collection
  // stops being "current" without waiting for the next save.
  const historyVersion = useLiveQuery(() => db.history.count(), []);

  useEffect(() => {
    void refresh();
  }, [refresh, historyVersion]);

  useEffect(() => {
    const g = globalThis as unknown as { browser?: { storage?: StorageChangeArea } };
    const onChanged = g.browser?.storage?.onChanged;
    if (!onChanged?.addListener) return;

    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local' && area !== undefined) return;
      if (!(ONE_CLICK_COLLECTION_STORAGE_KEY in (changes ?? {}))) return;
      void refresh();
    };

    onChanged.addListener(listener);
    return () => onChanged.removeListener?.(listener);
  }, [refresh]);

  const makeCurrent = useCallback(
    async (sessionKey: string, name: string) => {
      await makeCollectionCurrent(sessionKey, name);
      await refresh();
    },
    [refresh],
  );

  return { current, isLoading, makeCurrent, refresh };
}
