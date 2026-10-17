/**
 * Focus management for modals (SAD-194 / L-6).
 *
 * While `active`:
 *  - focus moves INTO the container on open (first focusable element, or the
 *    container itself when it has none — give it tabIndex={-1} for that case);
 *  - Tab / Shift+Tab wrap at both ends instead of escaping to the page;
 *  - Escape invokes the optional onEscape callback (close handler);
 *  - on close (active → false or unmount) focus is RESTORED to the element
 *    that had it before the modal opened.
 *
 * The focusable list is re-queried on every Tab press, so content that renders
 * later (async lists, collapsible sections) is trapped correctly. (Superseded
 * and replaced the old static `trapFocus` helper, removed in the L-3
 * dead-export pass.)
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void
) {
  const ref = useRef<T>(null);
  // Keep the latest callback without re-running the effect (which would
  // re-steal focus on every parent re-render).
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('disabled')
      );

    // Focus the first focusable element; fall back to the container itself.
    const initial = focusables();
    (initial[0] ?? container).focus();

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', handler);
    return () => {
      container.removeEventListener('keydown', handler);
      // Restore focus to the trigger element on close (WCAG 2.4.3).
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active]);

  return ref;
}
