/**
 * Step 3.3 (SAD-169) — M-10: a malformed settings row must degrade to
 * defaults, not unmount the panel; render throws are contained by a boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { db } from '@/lib/db/database';
import { SettingsSchema } from '@/lib/schemas/settings';
import { ProductTable } from '@/entrypoints/sidepanel/table/ProductTable';
import { ErrorBoundary } from '@/entrypoints/sidepanel/components/ErrorBoundary';
import { useSettings } from '@/entrypoints/sidepanel/hooks/useSettings';
import type { AppSettings } from '@/types/settings';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  cleanup();
  await db.delete();
  vi.restoreAllMocks();
});

describe('M-10: malformed settings degrade to defaults instead of throwing', () => {
  it('ProductTable renders on an out-of-range row (999999 target) and logs the fallback', async () => {
    // defaultTargetCount: 999999 exceeds TARGET_MAX -> schema-invalid row.
    // Before SAD-169 useSettings called .parse() during render and threw,
    // unmounting the whole panel (no error boundary existed).
    await db.settings.put({
      id: 'default',
      defaultTargetCount: 999999,
      enabledFields: {},
    } as unknown as AppSettings);
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    render(<ProductTable fullHeight sessionKey="session-m10" />);

    // Renders (empty state or table) instead of throwing:
    await waitFor(() => {
      expect(
        screen.queryByText(/This section stopped responding/i)
      ).toBeNull();
    });
    // ...and the invalid row was reported loudly, not silently.
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[PPHunt] Stored settings are invalid; falling back to defaults',
        expect.anything()
      );
    });
  });

  it('useSettings falls back to schema defaults for the malformed row', async () => {
    await db.settings.put({
      id: 'default',
      defaultTargetCount: 999999,
      enabledFields: {},
    } as unknown as AppSettings);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useSettings({ saveDebounceMs: 5 }));

    await waitFor(() => expect(result.current.settings).not.toBeNull());
    const defaults = SettingsSchema.parse({});
    expect(result.current.settings).toMatchObject({
      defaultTargetCount: defaults.defaultTargetCount,
      defaultMode: defaults.defaultMode,
    });
    // enabledFields merged against defaults, mirroring db/settings.ts
    expect(result.current.settings!.enabledFields.title).toBe(true);
  });

  it('restoreDefaults recovers from the malformed-row state', async () => {
    await db.settings.put({
      id: 'default',
      defaultTargetCount: 999999,
      enabledFields: {},
    } as unknown as AppSettings);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useSettings({ saveDebounceMs: 5 }));
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    await act(async () => {
      await result.current.restoreDefaults();
    });

    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row?.defaultTargetCount).toBe(
        SettingsSchema.parse({}).defaultTargetCount
      );
    });
    // and the hook now parses the row without falling back
    expect(result.current.settings!.defaultTargetCount).toBe(
      SettingsSchema.parse({}).defaultTargetCount
    );
  });
});

describe('M-10: ErrorBoundary contains render throws', () => {
  function Bomb(): null {
    throw new Error('table exploded');
  }

  it('renders the fallback for a throwing child while siblings survive', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <header>
          <h1>PPHunt</h1>
        </header>
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      </div>
    );

    // Fallback shown...
    expect(
      screen.getByText('This section stopped responding')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload panel' })).toBeTruthy();
    expect(screen.getByText('table exploded')).toBeTruthy();
    // ...header outside the boundary survived.
    expect(screen.getByRole('heading', { name: 'PPHunt' })).toBeTruthy();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>healthy content</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('healthy content')).toBeTruthy();
    expect(
      screen.queryByText('This section stopped responding')
    ).toBeNull();
  });
});
