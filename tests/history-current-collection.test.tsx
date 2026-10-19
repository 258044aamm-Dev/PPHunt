/**
 * SAD-286 (P3.2) - the Current badge and the Make current action.
 *
 * Both are additive: a row that is neither current nor a one-click collection
 * renders exactly the buttons it rendered before.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db/database';
import { AmazonHistoryEntry } from '@/engines/amazon/ui/components/HistoryEntry';
import type { CollectionHistory } from '@/engines/amazon/types';

function entry(overrides: Partial<CollectionHistory> = {}): CollectionHistory {
  return {
    id: 1,
    sessionKey: 'oc_1700000000000',
    url: 'https://www.amazon.com/s?k=charger',
    mode: 'manual',
    targetCount: 0,
    collectedCount: 2,
    startedAt: '2026-10-19T10:00:00.000Z',
    completedAt: '2026-10-19T10:00:00.000Z',
    status: 'completed',
    name: 'Anker 65W Charger',
    origin: 'one-click',
    ...overrides,
  };
}

const noop = () => undefined;

afterEach(cleanup);

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('current badge', () => {
  it('marks the collection new saves land in', () => {
    render(
      <AmazonHistoryEntry
        entry={entry()}
        onPreview={noop}
        onExport={noop}
        onDelete={noop}
        isCurrent
      />,
    );

    expect(
      screen.getByTestId('history-current-oc_1700000000000').textContent,
    ).toBe('Current');
  });

  it('shows no badge and no action on a plain row', () => {
    render(
      <AmazonHistoryEntry entry={entry()} onPreview={noop} onExport={noop} onDelete={noop} />,
    );

    expect(screen.queryByTestId('history-current-oc_1700000000000')).toBeNull();
    expect(screen.queryByTestId('history-make-current-oc_1700000000000')).toBeNull();
  });
});

describe('make current', () => {
  it('offers the action on a one-click collection that is not current', () => {
    const onMakeCurrent = vi.fn();
    render(
      <AmazonHistoryEntry
        entry={entry()}
        onPreview={noop}
        onExport={noop}
        onDelete={noop}
        onMakeCurrent={onMakeCurrent}
      />,
    );

    fireEvent.click(screen.getByTestId('history-make-current-oc_1700000000000'));

    expect(onMakeCurrent).toHaveBeenCalledTimes(1);
  });

  it('never offers it on a full-page collection', () => {
    render(
      <AmazonHistoryEntry
        entry={entry({ sessionKey: '12_1700000000000', origin: undefined, name: undefined })}
        onPreview={noop}
        onExport={noop}
        onDelete={noop}
        onMakeCurrent={vi.fn()}
      />,
    );

    expect(screen.queryByText('Make current')).toBeNull();
  });

  it('hides the action once the row is current', () => {
    render(
      <AmazonHistoryEntry
        entry={entry()}
        onPreview={noop}
        onExport={noop}
        onDelete={noop}
        isCurrent
        onMakeCurrent={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('history-make-current-oc_1700000000000')).toBeNull();
    expect(screen.getByTestId('history-current-oc_1700000000000')).toBeTruthy();
  });
});
