import { useRef } from 'react';

import type { ExpandedCellPayload } from './CellExpandModal';

export interface ExpandableCellProps {
  label: string;
  columnId: string;
  value: string | string[] | null | undefined;
  raw?: string | null;
  product?: unknown;
  onExpand: (payload: ExpandedCellPayload) => void;
  children: React.ReactNode;
  showExpand?: boolean;
}

export function ExpandableCell({
  label,
  columnId,
  value,
  raw,
  product,
  onExpand,
  children,
  showExpand = true,
}: ExpandableCellProps) {
  const btnRef = useRef<HTMLButtonElement>(null);

  const isEmptyValue =
    value == null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);

  if (!showExpand || isEmptyValue) {
    return <>{children}</>;
  }

  const handleExpand = () => {
    onExpand({
      columnId,
      label,
      value: value as string | string[],
      raw: raw ?? null,
      product,
      triggerRef: btnRef,
    });
  };

  return (
    <div className="group flex items-start gap-1 min-w-0 relative">
      <span
        className="min-w-0 flex-1"
        data-testid={`cell-expand-tap-${columnId}`}
        onClick={(e) => {
          if (
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(pointer: coarse)').matches
          ) {
            const target = e.target as HTMLElement;
            if (target.closest('a')) return;
            e.preventDefault();
            handleExpand();
          }
        }}
      >
        {children}
      </span>
      <button
        ref={btnRef}
        type="button"
        aria-label={`Expand ${label}`}
        aria-expanded="false"
        data-testid={`cell-expand-button-${columnId}`}
        onClick={(e) => {
          e.stopPropagation();
          handleExpand();
        }}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-sm bg-surface-card border border-hairline-soft text-ink-muted hover:text-ink hover:border-hairline opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-clay transition-opacity duration-150 cursor-pointer max-[768px]:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 2H2v8h8V8M2 2l5 5M8 2h2v4" />
        </svg>
      </button>
    </div>
  );
}
