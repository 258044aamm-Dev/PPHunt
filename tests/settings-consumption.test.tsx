/**
 * Step 3.1 (SAD-167) — H-1a: the settings that need no protocol change
 * actually take effect, legacy 'xlsx' rows upgrade transparently, and the
 * guard test stops an unwired setting from ever being added again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/database';
import { SettingsSchema } from '@/lib/schemas/settings';
import type { AppSettings } from '@/types/settings';
import type { Product } from '@/types/product';
import App from '@/entrypoints/sidepanel/App';
import { ExportModal } from '@/entrypoints/sidepanel/components/ExportModal';
import { useCollectionStore } from '@/entrypoints/sidepanel/store/collectionStore';
import { useToastStore } from '@/entrypoints/sidepanel/components/ToastContainer';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';
import { buildCSVContent } from '@/lib/export/csv';
import { getExportColumnsFromSettings } from '@/lib/export/types';
import * as csvModule from '@/lib/export/csv';

const PRODUCTS: Product[] = [
  {
    asin: 'B08N5WRWNW',
    url: 'https://www.amazon.de/dp/B08N5WRWNW',
    title: 'Anker Charger',
    price: 39.99,
    currency: 'EUR',
    collectedAt: '2026-10-17T00:00:00.000Z',
    sessionKey: 'session-consume',
    source: 'search',
  },
];

type OnMessageListener = (msg: unknown, sender?: unknown) => unknown;

function stubBrowserForApp(listeners: OnMessageListener[]) {
  vi.stubGlobal('browser', {
    runtime: {
      onMessage: {
        addListener: (fn: OnMessageListener) => {
          listeners.push(fn);
        },
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
    },
    action: {
      setPopup: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
      onClicked: { addListener: vi.fn() },
    },
  });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  useCollectionStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
});

afterEach(async () => {
  cleanup();
  await db.delete();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('H-1a: defaultMode / defaultTargetCount take effect', () => {
  it('applies persisted defaults to the collection store on App mount', async () => {
    await db.settings.put(
      SettingsSchema.parse({ defaultMode: 'automatic', defaultTargetCount: 250 })
    );
    stubBrowserForApp([]);
    expect(useCollectionStore.getState().mode).toBe('manual'); // pre-wiring constant

    render(<App />);

    await waitFor(() => {
      const s = useCollectionStore.getState();
      expect(s.mode).toBe('automatic');
      expect(s.targetCount).toBe(250);
    });
  });

  it('never clobbers a session restored by useSessionRecovery (non-idle guard)', async () => {
    await db.settings.put(
      SettingsSchema.parse({ defaultMode: 'automatic', defaultTargetCount: 250 })
    );
    stubBrowserForApp([]);
    // Simulate a restored, paused session (what useSessionRecovery produces)
    useCollectionStore.setState({
      status: 'paused',
      mode: 'manual',
      targetCount: 77,
    });

    render(<App />);

    // give effects a chance to run against the loaded settings row
    await waitFor(async () => expect(await db.settings.count()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    const s = useCollectionStore.getState();
    expect(s.status).toBe('paused');
    expect(s.mode).toBe('manual');
    expect(s.targetCount).toBe(77);
  });

  it('fresh install keeps the Step-3.0 snapshot values (manual / 50)', async () => {
    stubBrowserForApp([]);
    render(<App />);
    await waitFor(async () => expect(await db.settings.count()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    const s = useCollectionStore.getState();
    expect(s.mode).toBe('manual');
    expect(s.targetCount).toBe(50);
  });
});

describe('H-1a: export defaults take effect in ExportModal', () => {
  function renderModal(isOpen = true) {
    return render(
      <ExportModal
        isOpen={isOpen}
        onClose={() => {}}
        allProducts={PRODUCTS}
        selectedProducts={[]}
        filteredProducts={PRODUCTS}
        hasFilter={false}
        hasSelection={false}
      />
    );
  }

  const selectedFormat = () =>
    ['CSV', 'Excel', 'Copy'].find((label) =>
      screen
        .getByRole('button', { name: label })
        .className.includes('border-ink')
    );

  it("persisted exportFormat pre-selects the modal's format", async () => {
    await db.settings.put(
      SettingsSchema.parse({ exportFormat: 'clipboard' }) as AppSettings
    );
    renderModal();
    await waitFor(() => expect(selectedFormat()).toBe('Copy'));
  });

  it("legacy 'xlsx' row loads as 'excel' and nothing throws", async () => {
    // A row persisted before the enum harmonisation:
    await db.settings.put({
      ...SettingsSchema.parse({}),
      exportFormat: 'xlsx',
    } as unknown as AppSettings);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderModal();

    await waitFor(() => expect(selectedFormat()).toBe('Excel'));
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[PPHunt] Stored settings are invalid; falling back to defaults',
      expect.anything()
    );
  });

  it('exportFilename is used literally; blank falls back to the dated template', async () => {
    await db.settings.put(
      SettingsSchema.parse({ exportFilename: 'my-export' }) as AppSettings
    );
    renderModal();
    await waitFor(() =>
      expect(screen.getByDisplayValue('my-export')).toBeTruthy()
    );

    cleanup();
    await db.settings.put(SettingsSchema.parse({ exportFilename: '' }));
    renderModal();
    const date = new Date().toISOString().split('T')[0];
    await waitFor(() =>
      expect(screen.getByDisplayValue(`pphunt-export-${date}`)).toBeTruthy()
    );
  });

  it('includeBOM:false reaches the CSV exporter — no \\uFEFF at position 0', async () => {
    await db.settings.put(
      SettingsSchema.parse({
        includeBOM: false,
        exportFormat: 'csv',
        exportFilename: 'bom-test',
      })
    );
    const spy = vi
      .spyOn(csvModule, 'exportCSV')
      .mockImplementation(() => undefined);
    renderModal();
    // wait until the settings row has actually driven the modal state
    await waitFor(() => expect(screen.getByDisplayValue('bom-test')).toBeTruthy());
    expect(selectedFormat()).toBe('CSV');

    fireEvent.click(screen.getByRole('button', { name: /Export 1 products/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const includeBOMArg = spy.mock.calls[0]![3];
    expect(includeBOMArg).toBe(false);
    // and the exporter honours it at the content level:
    const content = buildCSVContent(
      PRODUCTS,
      getExportColumnsFromSettings(SettingsSchema.parse({}).enabledFields),
      false
    );
    expect(content.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('close → change settings → reopen resets to the new defaults', async () => {
    await db.settings.put(
      SettingsSchema.parse({ exportFormat: 'csv', exportFilename: 'reset-test' })
    );
    const view = renderModal(true);
    // wait until the row has driven the modal, so the user pick below is not
    // raced by the settings-load reset
    await waitFor(() => expect(screen.getByDisplayValue('reset-test')).toBeTruthy());
    expect(selectedFormat()).toBe('CSV');

    // user changes format in the open modal, then closes without exporting
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(selectedFormat()).toBe('Copy'));
    view.rerender(
      <ExportModal
        isOpen={false}
        onClose={() => {}}
        allProducts={PRODUCTS}
        selectedProducts={[]}
        filteredProducts={PRODUCTS}
        hasFilter={false}
        hasSelection={false}
      />
    );

    // settings change while closed...
    await db.settings.put(
      SettingsSchema.parse({ exportFormat: 'excel' }) as AppSettings
    );
    await waitFor(async () => {
      const row = await db.settings.get('default');
      expect(row?.exportFormat).toBe('excel');
    });

    // ...reopen → back to the settings default, not the stale user pick
    view.rerender(
      <ExportModal
        isOpen
        onClose={() => {}}
        allProducts={PRODUCTS}
        selectedProducts={[]}
        filteredProducts={PRODUCTS}
        hasFilter={false}
        hasSelection={false}
      />
    );
    await waitFor(() => expect(selectedFormat()).toBe('Excel'));
  });
});

describe('H-1a: notifications gate in-panel toasts', () => {
  async function dispatchErrorUpdate(settingsRow: Record<string, unknown>) {
    await db.settings.put({
      ...SettingsSchema.parse({ defaultTargetCount: 321 }),
      ...settingsRow,
    } as unknown as AppSettings);
    const listeners: OnMessageListener[] = [];
    stubBrowserForApp(listeners);
    render(<App />);
    // wait until the settings row was consumed (defaults applied), so the
    // notifications ref reflects the stored toggle
    await waitFor(() =>
      expect(useCollectionStore.getState().targetCount).toBe(321)
    );
    for (const listener of listeners) {
      listener({
        type: 'UPDATE_PROGRESS',
        payload: {
          collected: 3,
          target: 10,
          status: 'error',
          error: 'CAPTCHA detected',
          sessionKey: 'session-toast',
        },
      });
    }
  }

  it('notifications:false suppresses the error toast', async () => {
    await dispatchErrorUpdate({ notifications: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('notifications:true still shows the error toast (unchanged behaviour)', async () => {
    await dispatchErrorUpdate({ notifications: true });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.length).toBeGreaterThan(0)
    );
  });
});

describe('guard: no setting may be write-only again', () => {
  it('every SettingsSchema key is referenced outside SettingsOverlay/schemas/types/constants', () => {
    // Step 3.4 landed: the scroll four + duplicateDetection now have real
    // consumers (background.ts buildScrollConfig + amazon.content.ts), so the
    // only exemptions left are row plumbing, not user-facing settings.
    const WIRED_IN_STEP_34 = new Set<string>();
    const ROW_PLUMBING = new Set(['id', 'version']);

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });

    const sources = walk('src')
      .filter(
        (f) =>
          /\.(ts|tsx)$/.test(f) &&
          !f.endsWith('SettingsOverlay.tsx') &&
          !f.includes('/lib/schemas/') &&
          !f.includes('/types/') &&
          !f.includes('/constants/')
      )
      .map((f) => [f, readFileSync(f, 'utf8')] as const);
    expect(sources.length).toBeGreaterThan(10);

    for (const key of Object.keys(SettingsSchema.shape)) {
      if (WIRED_IN_STEP_34.has(key) || ROW_PLUMBING.has(key)) continue;
      const re = new RegExp(`\\b${key}\\b`);
      const consumers = sources.filter(([, c]) => re.test(c)).map(([f]) => f);
      expect(
        consumers.length,
        `setting "${key}" is write-only — no consumer outside the settings UI (${consumers.join(', ')})`
      ).toBeGreaterThan(0);
    }
  });
});
