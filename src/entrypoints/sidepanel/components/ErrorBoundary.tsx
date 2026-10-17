import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * M-10 (SAD-169): contains render-time throws to the section that failed.
 *
 * Sits inside App around `renderTabContent()` — a table or tab crash shows
 * this fallback while the header, navigation and overlays stay usable.
 * Styled after ErrorModal's card so failures look consistent.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      '[PPHunt] Panel section crashed:',
      error,
      info.componentStack
    );
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="m-3 bg-surface border border-hairline-soft rounded-md p-5 shadow-lg"
      >
        <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-[11px] font-sans font-medium bg-clay/15 text-clay border border-clay/30 mb-2">
          PANEL ERROR
        </span>
        <h2 className="font-serif text-base font-semibold text-ink mb-1.5">
          This section stopped responding
        </h2>
        <p className="font-serif text-sm text-ink-muted mb-3 leading-relaxed">
          Your collected products are safe in storage. Reload the panel to
          continue — if it happens again, open Settings and restore defaults.
        </p>
        <pre className="mb-3 px-3 py-2 rounded-sm bg-surface-soft border border-hairline-soft text-xs font-mono text-ink-muted whitespace-pre-wrap break-words">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-3 py-1.5 rounded-sm bg-clay text-white text-xs font-sans font-medium hover:bg-clay/90"
        >
          Reload panel
        </button>
      </div>
    );
  }
}
