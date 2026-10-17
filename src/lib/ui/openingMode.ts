/** The absence of a preference keeps the toolbar chooser available. */
export const OPENING_MODE_KEY = 'pphuntDefaultMode';

export type OpeningMode = 'sidePanel' | 'overlay';

export function readOpeningMode(value: unknown): OpeningMode | null {
  if (value === 'overlay') return 'overlay';
  // The older spec used lowercase "sidepanel"; preserve that saved preference.
  if (value === 'sidePanel' || value === 'sidepanel') return 'sidePanel';
  return null;
}
