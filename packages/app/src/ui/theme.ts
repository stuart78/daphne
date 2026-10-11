/**
 * Theme selection, applied before React renders anything.
 *
 * The drawing surfaces are canvases: they read the palette out of the CSS
 * custom properties at paint time rather than inheriting it. That makes them
 * sensitive to *when* the theme attribute lands. React runs child effects
 * before parent effects, so a parent that sets the attribute in an effect does
 * it too late — every pad has already painted itself from the bare `:root`
 * palette, and nothing marks them dirty afterwards, so they stay the wrong
 * colour until something else forces a repaint.
 *
 * Setting the attribute at module scope, before `createRoot().render()`, sides
 * step the ordering question entirely. The body is empty until React renders,
 * so there is nothing to flash.
 */

export type Theme = 'light' | 'sepia' | 'blueprint' | 'dark' | 'midnight' | 'phosphor';

/**
 * The themes on offer, in the order the picker lists them: the light ones, then
 * the dark. Adding one means a palette in styles.css under
 * `:root[data-theme="..."]` and an entry here.
 */
export const THEMES: { id: Theme; label: string; dark: boolean; note: string }[] = [
  { id: 'light', label: 'Paper', dark: false, note: 'Light: the printed sheet' },
  { id: 'sepia', label: 'Sepia', dark: false, note: 'Light: warm paper and brown ink' },
  { id: 'blueprint', label: 'Blueprint', dark: false, note: 'Light: drawing-office blue' },
  { id: 'dark', label: 'Charcoal', dark: true, note: 'Dark: the studio at night' },
  { id: 'midnight', label: 'Midnight', dark: true, note: 'Dark: blue-black and cyan' },
  { id: 'phosphor', label: 'Phosphor', dark: true, note: 'Dark: green on an oscilloscope' },
];

/** Where the chosen theme is kept, so it survives a quit. */
const STORED = 'daphne:theme';

const known = (value: string | null): value is Theme =>
  THEMES.some((t) => t.id === value);

/** What was chosen last, or whichever of the two originals matches the desktop. */
export const initialTheme = (): Theme => {
  try {
    const saved = window.localStorage?.getItem(STORED);
    if (known(saved)) return saved;
  } catch {
    // Private windows and locked-down shells can refuse storage. Not a reason
    // to come up without a theme.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

export const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage?.setItem(STORED, theme);
  } catch {
    // As above: the theme still applies, it just will not be remembered.
  }
};
