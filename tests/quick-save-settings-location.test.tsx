/**
 * SAD-332 — "Right-Click Save Behavior" belongs in Settings, not on the Collect
 * tab. The control itself must keep working exactly as before; only its host
 * changed.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { db } from '@/lib/db/database';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { CollectTab } from '@/entrypoints/sidepanel/components/CollectTab';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { useAmazonCollectionStore } from '@/engines/amazon/ui/store/collectionStore';

const GROUP_NAME = 'Right-Click Save Behavior';

function stubBrowser() {
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();

  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: vi.fn((listener: (changes: Record<string, unknown>, area: string) => void) => {
          listeners.add(listener);
        }),
        removeListener: vi.fn((listener: (changes: Record<string, unknown>, area: string) => void) => {
          listeners.delete(listener);
        }),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  });
}

describe('SAD-332 — right-click save settings live in Settings', () => {
  beforeEach(async () => {
    stubBrowser();
    await db.delete();
    await db.open();
    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
    useAmazonCollectionStore.setState({ isAmazonPage: true });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('no longer renders on the Collect tab', async () => {
    render(
      <StrictMode>
        <CollectTab />
      </StrictMode>,
    );

    // Give the tab a beat to mount its own asynchronous sections.
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: GROUP_NAME })).toBeNull());
    expect(screen.queryByText('Add to Current Collection')).toBeNull();
    expect(screen.queryByText('New Collection per Product')).toBeNull();
    expect(screen.queryByText('Ask Every Time')).toBeNull();
  });

  it('renders inside Settings', async () => {
    render(
      <StrictMode>
        <Header />
        <SettingsOverlay />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const group = await screen.findByRole('radiogroup', { name: GROUP_NAME }, { timeout: 3000 });
    expect(group).toBeTruthy();
    expect(screen.getByText('RIGHT-CLICK SAVE')).toBeTruthy();

    // Scoped to the group: the overlay also offers a similar-sounding
    // collection-mode control elsewhere.
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(within(group).getByText('Add to Current Collection')).toBeTruthy();
    expect(within(group).getByText('New Collection per Product')).toBeTruthy();
    expect(within(group).getByText('Ask Every Time')).toBeTruthy();
  });

  it('still persists the choice, exactly as it did on the Collect tab', async () => {
    render(
      <StrictMode>
        <Header />
        <SettingsOverlay />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    await screen.findByRole('radiogroup', { name: GROUP_NAME }, { timeout: 3000 });

    const ask = screen.getByRole('radio', { name: /Ask Every Time/i }) as HTMLInputElement;
    fireEvent.click(ask);

    await waitFor(async () => {
      const stored = await db.settings.get('default');
      expect(stored?.quickSaveCollectionBehavior).toBe('ask');
    });

    expect((screen.getByRole('radio', { name: /Ask Every Time/i }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('shows where new saves will land', async () => {
    render(
      <StrictMode>
        <Header />
        <SettingsOverlay />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    await screen.findByRole('radiogroup', { name: GROUP_NAME }, { timeout: 3000 });
    expect(screen.getByText(/New saves go to:/)).toBeTruthy();
  });
});
