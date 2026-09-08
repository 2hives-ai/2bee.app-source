/**
 * Panel open/close persistence — extracted from App.tsx.
 *
 * Persists each Section's open/closed state in localStorage so it survives
 * a page refresh. Keyed on the section's `testid` prop.
 */

const PANELS_KEY = '2bee.app.panels.open';

const PANEL_OPEN: Record<string, unknown> = (() => {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    // An array, a string or `null` are all `typeof 'object'`-adjacent traps.
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    /* Storage disabled, quota gone, or somebody hand-edited it: the panels
     * simply open at their defaults. This is chrome; it never blocks the app. */
    return {};
  }
})();

/** `undefined` = never seen (or stored as something that is not a boolean). */
export function storedPanelOpen(testid: string | undefined): boolean | undefined {
  if (!testid) return undefined;
  const v = PANEL_OPEN[testid];
  return typeof v === 'boolean' ? v : undefined;
}

export function rememberPanelOpen(testid: string | undefined, open: boolean) {
  if (!testid) return;
  PANEL_OPEN[testid] = open;
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(PANEL_OPEN));
  } catch {
    /* Not remembered. The panel still opens and closes for this session — a
     * write that fails must not make the control itself stop working. */
  }
}
