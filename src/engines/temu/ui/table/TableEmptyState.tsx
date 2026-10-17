/**
 * Empty state for the Temu product table.
 * Matches the existing PPHunt TableEmptyState 100%.
 */
export function TemuTableEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-14 h-14 rounded-full bg-surface-card border border-hairline-soft flex items-center justify-center mb-3">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-ink-muted"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </div>
      <h3 className="font-serif text-base font-semibold text-ink mb-1.5">
        No products yet
      </h3>
      <p className="font-serif text-xs text-ink-muted max-w-xs leading-relaxed">
        Start a collection from the Collect tab. Products will appear here as
        they are scraped from Temu.
      </p>
    </div>
  );
}
