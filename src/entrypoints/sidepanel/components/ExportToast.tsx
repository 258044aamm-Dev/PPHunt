import type { ExportResult } from '@/lib/export/types';

interface ExportToastProps {
  result: ExportResult | null;
  onDismiss: () => void;
}

/**
 * Toast notification for export success/failure.
 * - Success: moss dot, serif text
 * - Error: crimson dot, serif text
 * - Auto-dismisses after 5s (handled by parent)
 * - Click to dismiss
 */
export function ExportToast({ result, onDismiss }: ExportToastProps) {
  if (!result) return null;

  return (
    <div
      onClick={onDismiss}
      className={`
        fixed bottom-4 left-4 right-4 z-50 cursor-pointer
        bg-surface-card border rounded-md p-3 flex items-start gap-2.5
        transition-all duration-300
        ${result.success ? 'border-moss/50' : 'border-crimson/50'}
      `}
      role="status"
    >
      <span
        className={`
          w-2.5 h-2.5 rounded-full shrink-0 mt-1
          ${result.success ? 'bg-moss' : 'bg-crimson'}
        `}
      />
      <p className="font-serif text-xs text-ink leading-relaxed">
        {result.message}
      </p>
    </div>
  );
}
