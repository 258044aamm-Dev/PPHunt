/**
 * L-6 (SAD-194): focus trap + ConfirmDialog.
 *
 * Covers:
 *  - ConfirmDialog: focus moves in on open, Tab/Shift+Tab wrap at both ends,
 *    Escape cancels, confirm/cancel resolve the promise correctly, focus
 *    returns to the trigger on close, and the dialog is a labelled modal.
 *  - useFocusTrap in isolation: wrapping both directions + focus restore.
 *  - Source scan: window.confirm/alert/prompt are fully gone from src/
 *    (the SAD-194 verification `grep -rn "confirm(" src` must stay empty).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useConfirmDialog } from '@/entrypoints/sidepanel/components/ConfirmDialog';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';

afterEach(cleanup);

/* ── Harnesses ─────────────────────────────────────────────────── */

function ConfirmHarness({ onResult }: { onResult: (v: boolean) => void }) {
  const { askConfirm, confirmDialog } = useConfirmDialog();
  return (
    <div>
      <button
        data-testid="trigger"
        onClick={() => {
          void askConfirm({
            title: 'Delete everything?',
            message: 'This cannot be undone.',
            tone: 'danger',
          }).then(onResult);
        }}
      >
        Do dangerous thing
      </button>
      {confirmDialog}
    </div>
  );
}

function TrapHarness({ open }: { open: boolean }) {
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  return (
    <div>
      <button data-testid="outside">outside</button>
      {open && (
        <div ref={trapRef} tabIndex={-1} data-testid="trap">
          <button data-testid="first">first</button>
          <button data-testid="middle">middle</button>
          <button data-testid="last">last</button>
        </div>
      )}
    </div>
  );
}

/* ── ConfirmDialog ─────────────────────────────────────────────── */

describe('ConfirmDialog (SAD-194 / L-6)', () => {
  it('is a labelled modal and receives focus on open', async () => {
    render(<ConfirmHarness onResult={() => {}} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();

    await act(async () => {
      fireEvent.click(trigger);
    });

    const dialog = await screen.findByRole('dialog', { name: 'Delete everything?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Focus moved INTO the dialog (first focusable = Cancel).
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('wraps Tab at both ends instead of escaping to the page', async () => {
    render(<ConfirmHarness onResult={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger'));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Delete everything?' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });

    // Forward from the last focusable wraps to the first.
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    // Backward from the first focusable wraps to the last.
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('resolves true on confirm and restores focus to the trigger', async () => {
    const results: boolean[] = [];
    render(<ConfirmHarness onResult={(v) => results.push(v)} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();

    await act(async () => {
      fireEvent.click(trigger);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Delete everything?' });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    });

    expect(results).toEqual([true]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // L-6: focus returns to the element that opened the dialog.
    expect(document.activeElement).toBe(trigger);
  });

  it('resolves false on Cancel and on Escape', async () => {
    const results: boolean[] = [];
    render(<ConfirmHarness onResult={(v) => results.push(v)} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();

    // Escape cancels.
    await act(async () => {
      fireEvent.click(trigger);
    });
    let dialog = await screen.findByRole('dialog', { name: 'Delete everything?' });
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(results).toEqual([false]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Explicit Cancel button.
    await act(async () => {
      fireEvent.click(trigger);
    });
    dialog = await screen.findByRole('dialog', { name: 'Delete everything?' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });
    expect(results).toEqual([false, false]);
  });
});

/* ── useFocusTrap in isolation ─────────────────────────────────── */

describe('useFocusTrap (SAD-194 / L-6)', () => {
  it('focuses the first focusable on open and wraps Tab both directions', () => {
    render(<TrapHarness open />);
    const trap = screen.getByTestId('trap');
    const first = screen.getByTestId('first');
    const last = screen.getByTestId('last');

    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(last, { key: 'Tab', shiftKey: true });
    // shift from last stays natural (browser would move back); our trap only
    // intercepts at the ends — verify the ends explicitly:
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(trap.contains(document.activeElement)).toBe(true);
  });

  it('restores focus to the previously focused element on close', () => {
    const outside = (() => {
      const view = render(<TrapHarness open={false} />);
      return view;
    })();
    const outsideBtn = screen.getByTestId('outside');
    outsideBtn.focus();

    outside.rerender(<TrapHarness open />);
    expect(document.activeElement).toBe(screen.getByTestId('first'));

    outside.rerender(<TrapHarness open={false} />);
    expect(document.activeElement).toBe(outsideBtn);
  });
});

/* ── Source scan: no blocking dialogs left in src/ ─────────────── */

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('window.confirm/alert/prompt removal (SAD-194 / L-6)', () => {
  it('finds no blocking-dialog call sites anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(join(__dirname, '..', 'src'))) {
      const raw = readFileSync(file, 'utf8');
      // Strip block and line comments so documentation mentions don't count.
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const match = code.match(/(?<![\w$.])(?:window\s*\.\s*)?(?:confirm|alert|prompt)\s*\(/);
      if (match) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
