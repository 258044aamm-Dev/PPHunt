import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db/database';
import { SettingsSchema } from '@/lib/schemas/settings';
import { Header } from '@/entrypoints/sidepanel/components/Header';
import { SettingsOverlay } from '@/entrypoints/sidepanel/components/SettingsOverlay';
import { useUIStore } from '@/entrypoints/sidepanel/store/uiStore';

function renderSettings() {
  render(
    <StrictMode>
      <Header />
      <SettingsOverlay />
    </StrictMode>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
}

describe('settings gear', () => {
  beforeEach(async () => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
    await db.delete();
    await db.open();
    useUIStore.setState({ activeTab: 'collect', settingsOpen: false });
  });

  afterEach(async () => {
    cleanup();
    await db.delete();
    vi.unstubAllGlobals();
  });

  it('opens the settings form on a fresh install and persists defaults', async () => {
    expect(await db.settings.count()).toBe(0);
    renderSettings();

    await screen.findByText('GENERAL', {}, { timeout: 3000 });
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('50');
    expect(await db.settings.get('default')).toMatchObject({
      id: 'default',
      defaultMode: 'manual',
      defaultTargetCount: 50,
    });
  });

  it('preserves existing settings and the selected tab when closed and reopened', async () => {
    const savedSettings = SettingsSchema.parse({ defaultMode: 'automatic', defaultTargetCount: 250 });
    await db.settings.put(savedSettings);
    useUIStore.setState({ activeTab: 'history' });

    renderSettings();
    await screen.findByText('GENERAL', {}, { timeout: 3000 });
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('250');

    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[1]!);
    expect(screen.queryByText('GENERAL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByText('GENERAL', {}, { timeout: 3000 });

    expect(useUIStore.getState().activeTab).toBe('history');
    expect(await db.settings.get('default')).toEqual(savedSettings);
  });

  it('continues to save edits without resetting unrelated settings', async () => {
    await db.settings.put(SettingsSchema.parse({ defaultMode: 'automatic', defaultTargetCount: 250 }));
    renderSettings();
    await screen.findByText('GENERAL', {}, { timeout: 3000 });

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '75' } });
    await waitFor(async () => {
      expect(await db.settings.get('default')).toMatchObject({
        defaultMode: 'automatic',
        defaultTargetCount: 75,
      });
    });
  });

  it('lets users remember a mode or clear it to ask every time', async () => {
    renderSettings();
    await screen.findByText('UI MODE', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Page Overlay' }));
    await waitFor(() => expect(browser.storage.local.set).toHaveBeenCalledWith({ pphuntDefaultMode: 'overlay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Every Time' }));
    await waitFor(() => expect(browser.storage.local.remove).toHaveBeenCalledWith('pphuntDefaultMode'));
  });

  it('displays a saved legacy mode and persists the overlay default width', async () => {
    (browser.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      pphuntDefaultMode: 'sidepanel', pphuntOverlayWidth: 580,
    });
    renderSettings();
    await screen.findByText('UI MODE', {}, { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Side Panel' }).className).toContain('border-ink'));
    const widthSlider = screen.getAllByRole('slider')[0] as HTMLInputElement;
    expect(widthSlider.value).toBe('580');
    fireEvent.change(widthSlider, { target: { value: '620' } });
    expect(browser.storage.local.set).toHaveBeenCalledWith({ pphuntOverlayWidth: 620 });
  });
});
