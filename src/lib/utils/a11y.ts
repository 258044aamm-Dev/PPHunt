/**
 * Accessibility utilities for the side panel.
 */

/**
 * Returns ARIA props for a modal dialog.
 */
export function modalAriaProps(titleId: string) {
  return {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
  };
}
