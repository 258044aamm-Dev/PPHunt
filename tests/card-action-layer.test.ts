/**
 * SAD-284 (P2.3) - one button per card, one job per card.
 *
 * The layer is the authority on "this card is busy": the control refuses too,
 * but a re-mounted control must not be able to start a second job, so the state
 * map has to live above the button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCardActionLayer } from '@/engines/amazon/content/card-action-layer';

const PAGE = `
  <div class="s-main-slot">
    <div data-component-type="s-search-result" data-asin="B0AAAAAAAA" id="card-a">
      <div data-component-type="s-product-image"><img src="https://m.media-amazon.com/images/I/a.jpg"></div>
      <h2><a href="/A/dp/B0AAAAAAAA">Anker 65W Charger</a></h2>
    </div>
    <div data-component-type="s-search-result" data-asin="B0BBBBBBBB" id="card-b">
      <div data-component-type="s-product-image"><img src="https://m.media-amazon.com/images/I/b.jpg"></div>
      <h2><a href="/B/dp/B0BBBBBBBB">Anker 30W Charger</a></h2>
    </div>
  </div>
`;

let layer: ReturnType<typeof createCardActionLayer> | null = null;

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

afterEach(() => {
  layer?.stop();
  layer = null;
  vi.useRealTimers();
});

function makeLayer(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  layer = createCardActionLayer({ onSave, ...overrides });
  return { onSave, layer };
}

function click(asin: string): void {
  const handle = layer?.getButton(asin);
  if (!handle) throw new Error(`no button for ${asin}`);
  handle.button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('mounting', () => {
  it('creates one control per card from the observer', () => {
    makeLayer();
    layer?.start();

    expect(document.querySelectorAll('[data-pphunt-save-host]')).toHaveLength(2);
    expect(layer?.getButton('B0AAAAAAAA')).not.toBeNull();
    expect(layer?.getState('B0AAAAAAAA')).toBe('idle');
  });

  it('does not mount twice for the same card', () => {
    makeLayer();
    layer?.start();
    const card = document.getElementById('card-a') as Element;

    layer?.mountCard(card);
    layer?.mountCard(card);

    expect(document.querySelectorAll('[data-pphunt-save-host]')).toHaveLength(2);
  });
});

describe('one job per card', () => {
  it('turns ten rapid clicks into one save request', () => {
    const { onSave } = makeLayer();
    layer?.start();

    for (let index = 0; index < 10; index += 1) {
      click('B0AAAAAAAA');
    }

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      asin: 'B0AAAAAAAA',
      retry: false,
    });
    expect(typeof onSave.mock.calls[0]?.[0]?.jobId).toBe('string');
  });

  it('keeps refusing while the job is extracting or enriching', () => {
    const { onSave } = makeLayer();
    layer?.start();

    click('B0AAAAAAAA');
    layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'extracting' });
    click('B0AAAAAAAA');
    layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'enriching' });
    click('B0AAAAAAAA');

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('unlocks after completed with a new job id', () => {
    const { onSave } = makeLayer();
    layer?.start();

    click('B0AAAAAAAA');
    const firstJobId = onSave.mock.calls[0]?.[0]?.jobId;

    layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'completed', jobId: firstJobId });
    expect(layer?.getState('B0AAAAAAAA')).toBe('completed');

    click('B0AAAAAAAA');

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]?.jobId).not.toBe(firstJobId);
  });

  it('turns a click after a failure into a retry', () => {
    const { onSave } = makeLayer();
    layer?.start();

    click('B0AAAAAAAA');
    layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'failed', message: 'network' });

    expect(layer?.getState('B0AAAAAAAA')).toBe('failed');
    click('B0AAAAAAAA');

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ retry: true });
  });

  it('does not let failure of one card unlock another', () => {
    const { onSave } = makeLayer();
    layer?.start();

    click('B0AAAAAAAA');
    layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'extracting' });
    click('B0BBBBBBBB');

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(layer?.getState('B0AAAAAAAA')).toBe('extracting');
    expect(layer?.getState('B0BBBBBBBB')).toBe('queued');
  });
});

describe('job updates', () => {
  it('routes an update to the right card only', () => {
    makeLayer();
    layer?.start();

    const applied = layer?.applyJobUpdate({ asin: 'B0BBBBBBBB', state: 'enriching' });

    expect(applied).toBe(true);
    expect(layer?.getState('B0BBBBBBBB')).toBe('enriching');
    expect(layer?.getState('B0AAAAAAAA')).toBe('idle');
  });

  it('ignores updates for a card this page does not host', () => {
    makeLayer();
    layer?.start();

    expect(layer?.applyJobUpdate({ asin: 'B0NOTMINE0', state: 'completed' })).toBe(false);
  });

  it('shows partial enrichment as a completed warning, not a failure', () => {
    makeLayer();
    layer?.start();

    click('B0AAAAAAAA');
    layer?.applyJobUpdate({
      asin: 'B0AAAAAAAA',
      state: 'completed',
      enrichmentStatus: 'partial',
    });

    const handle = layer?.getButton('B0AAAAAAAA');
    expect(layer?.getState('B0AAAAAAAA')).toBe('completed');
    expect(handle?.host.getAttribute('data-partial')).toBe('true');
  });

  it('treats a warning as partial even when the status says complete', () => {
    makeLayer();
    layer?.start();

    click('B0AAAAAAAA');
    layer?.applyJobUpdate({
      asin: 'B0AAAAAAAA',
      state: 'completed',
      warning: 'details unavailable',
    });

    expect(layer?.getButton('B0AAAAAAAA')?.host.getAttribute('data-partial')).toBe('true');
  });

  it('maps an unknown state to idle rather than leaving the button stuck', () => {
    makeLayer();
    layer?.start();

    layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'interrupted' });

    expect(layer?.getState('B0AAAAAAAA')).toBe('idle');
  });
});

describe('teardown', () => {
  it('removes every control and forgets every job', () => {
    makeLayer();
    layer?.start();
    click('B0AAAAAAAA');

    layer?.stop();

    expect(document.querySelectorAll('[data-pphunt-save-host]')).toHaveLength(0);
    expect(layer?.getButton('B0AAAAAAAA')).toBeNull();
    expect(layer?.applyJobUpdate({ asin: 'B0AAAAAAAA', state: 'completed' })).toBe(false);
  });

  it('survives a save callback that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    layer = createCardActionLayer({
      onSave: () => {
        throw new Error('messaging exploded');
      },
    });
    layer.start();

    expect(() => click('B0AAAAAAAA')).not.toThrow();
    expect(layer.getState('B0AAAAAAAA')).toBe('failed');
    warn.mockRestore();
  });
});
