/**
 * ConfirmDialog (SAD-194 / L-6) — replaces window.confirm().
 *
 * window.confirm() is a blocking browser dialog: unstyled, unthemeable, and it
 * does not trap focus or announce itself. This promise-returning dialog is the
 * drop-in replacement for the four call sites (SettingsOverlay restore-defaults,
 * HistoryTab delete/clear-all, ProductTable delete-selected).
 *
 * Usage:
 *   const { askConfirm, confirmDialog } = useConfirmDialog();
 *   ...
 *   if (!(await askConfirm({ title: 'Delete?', tone: 'danger' }))) return;
 *   ...
 *   return <>{...}{confirmDialog}</>;
 */
import { useCallback, useState } from 'react';
import { modalAriaProps } from '@/lib/utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' styles the confirm button red for destructive actions. */
  tone?: 'default' | 'danger';
}

interface ConfirmDialogProps extends Required<Pick<ConfirmOptions, 'title'>> {
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape cancels; focus enters on open, wraps, and restores on close.
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  return (
    // z-[60]: above every existing overlay (settings z-40, modals z-50) so the
    // confirmation is never buried under the surface that asked for it.
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 dark:bg-black/60 p-4">
      <div
        ref={trapRef}
        tabIndex={-1}
        {...modalAriaProps('confirm-dialog-title')}
        className="bg-surface border border-hairline-soft rounded-md p-5 max-w-sm w-full shadow-lg"
      >
        <h3 id="confirm-dialog-title" className="font-serif text-base font-semibold text-ink">
          {title}
        </h3>
        {message && <p className="mt-2 font-sans text-xs leading-relaxed text-ink-muted">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-sm font-sans text-xs font-medium text-ink-muted bg-surface-card border border-hairline-soft hover:text-ink hover:bg-surface-soft transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              tone === 'danger'
                ? 'px-3 py-1.5 rounded-sm font-sans text-xs font-semibold text-white bg-crimson hover:bg-crimson/90 transition-colors'
                : 'px-3 py-1.5 rounded-sm font-sans text-xs font-semibold text-clay-ink bg-clay hover:bg-clay/90 transition-colors'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook wiring: askConfirm() returns a promise that resolves true when the user
 * confirms and false on Cancel/Escape/backdrop-free dismissal. The `confirmDialog`
 * element must be rendered by the calling component.
 */
export function useConfirmDialog() {
  const [request, setRequest] = useState<{
    options: ConfirmOptions;
    resolve: (value: boolean) => void;
  } | null>(null);

  const askConfirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setRequest({ options, resolve });
      }),
    []
  );

  const settle = useCallback((value: boolean) => {
    setRequest((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const confirmDialog = request ? (
    <ConfirmDialog
      title={request.options.title}
      message={request.options.message}
      confirmLabel={request.options.confirmLabel ?? 'Confirm'}
      cancelLabel={request.options.cancelLabel ?? 'Cancel'}
      tone={request.options.tone ?? 'default'}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { askConfirm, confirmDialog };
}
