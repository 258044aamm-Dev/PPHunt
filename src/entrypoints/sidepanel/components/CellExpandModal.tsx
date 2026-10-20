import { useState } from 'react';
import { useFocusTrap } from '@/entrypoints/sidepanel/hooks/useFocusTrap';
import { modalAriaProps } from '@/lib/utils/a11y';

export interface ExpandedCellPayload<T = unknown> {
  columnId: string;
  label: string;
  value: string | string[] | null;
  raw?: string | null;
  product?: T;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

interface CellExpandModalProps<T = unknown> {
  open: boolean;
  onClose: () => void;
  payload: ExpandedCellPayload<T> | null;
}

function renderModalBody(payload: ExpandedCellPayload): React.ReactNode {
  const { columnId, value, raw, product } = payload as ExpandedCellPayload<Record<string, unknown>>;

  // Features: array or joined string
  if (columnId === 'features') {
    const list: string[] = Array.isArray(value)
      ? (value as string[])
      : typeof value === 'string'
        ? (value as string).split(' • ').filter(Boolean)
        : [];
    if (list.length === 0) {
      return <p className="font-serif text-sm text-ink-muted">No features</p>;
    }
    return (
      <ul
        className="list-disc list-inside space-y-1.5 font-serif text-sm text-ink leading-relaxed"
        data-testid="cell-expand-features-list"
      >
        {list.map((item, index) => (
          <li key={index} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    );
  }

  if (columnId === 'title') {
    const p = product as Record<string, unknown> | undefined;
    const url = typeof p?.url === 'string' ? (p.url as string) : null;
    const titleText = typeof value === 'string' ? value : String(value ?? '');
    return (
      <div className="space-y-2">
        <h3 className="font-serif text-sm font-semibold text-ink leading-snug break-words">
          {titleText || '—'}
        </h3>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex font-mono text-xs text-clay underline break-all hover:text-clay-active"
            data-testid="cell-expand-title-link"
          >
            {url}
          </a>
        )}
      </div>
    );
  }

  if (columnId === 'description') {
    return (
      <p className="font-serif text-sm text-ink leading-relaxed whitespace-pre-wrap break-words">
        {typeof value === 'string' ? value : String(value ?? '')}
      </p>
    );
  }

  if (columnId === 'warrantyDescription') {
    return (
      <div className="space-y-2">
        <p className="font-mono text-sm text-ink font-medium break-words">
          {typeof value === 'string' ? value : String(value ?? '')}
        </p>
        {raw && (
          <p className="font-serif text-xs text-ink-muted italic break-words" data-testid="cell-expand-warranty-raw">
            Original: “{raw}”
          </p>
        )}
      </div>
    );
  }

  if (columnId === 'url') {
    const urlValue = typeof value === 'string' ? value : String(value ?? '');
    return (
      <div className="space-y-3">
        <p
          className="font-mono text-xs text-ink break-all bg-canvas p-2.5 rounded-sm border border-hairline-soft"
          data-testid="cell-expand-url-value"
        >
          {urlValue}
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href={urlValue}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-sm bg-clay text-clay-ink font-sans text-xs font-medium hover:bg-clay-active transition-colors"
            data-testid="cell-expand-url-open"
          >
            Open link →
          </a>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(urlValue);
            }}
            className="px-3 py-1.5 rounded-sm bg-surface-card border border-hairline font-sans text-xs text-ink hover:bg-surface-soft transition-colors"
            data-testid="cell-expand-url-copy"
          >
            Copy
          </button>
        </div>
      </div>
    );
  }

  // Generic truncation cases: BSR, sales, coupon, badge, delivery, brand, seller, availability, deal
  return (
    <p className="font-sans text-sm text-ink break-words whitespace-pre-wrap leading-relaxed">
      {typeof value === 'string' ? value : String(value ?? '')}
    </p>
  );
}

export function CellExpandModal({ open, onClose, payload }: CellExpandModalProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const [copied, setCopied] = useState(false);

  if (!open || !payload) return null;

  const textToCopy = Array.isArray(payload.value)
    ? (payload.value as string[]).join('\n')
    : String(payload.value ?? '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors in test/unsupported env
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 dark:bg-black/60 p-4"
      data-testid="cell-expand-backdrop"
    >
      <div
        ref={trapRef}
        tabIndex={-1}
        {...modalAriaProps('cell-expand-title')}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-hairline-soft rounded-md p-5 max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden shadow-lg"
        data-testid="cell-expand-modal"
      >
        <div className="flex items-center justify-between gap-2 shrink-0">
          <h3 id="cell-expand-title" className="font-serif text-base font-semibold text-ink">
            {payload.label}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="px-2.5 py-1 rounded-sm bg-surface-card border border-hairline font-sans text-xs text-ink-muted hover:text-ink hover:bg-surface-soft transition-colors"
              data-testid="cell-expand-copy-button"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-surface-soft transition-colors"
              data-testid="cell-expand-close-button"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="1" y1="1" x2="13" y2="13" />
                <line x1="13" y1="1" x2="1" y2="13" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto font-serif text-sm text-ink leading-relaxed break-words">
          {renderModalBody(payload)}
        </div>

        <div className="mt-4 flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-sm bg-clay text-clay-ink font-sans text-xs font-medium hover:bg-clay-active transition-colors"
            data-testid="cell-expand-footer-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
