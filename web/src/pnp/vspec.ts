// The tray geometry the BROWSER build reads: `cad`'s generated JSON, imported, so
// the bundle carries the file as it was at build time. Not a copy in this tree —
// `npm run build` re-reads it every time, and the CLI and tests read the same file
// from disk (`VSPEC_PATH` below). If `cad` regenerates it, the next build follows.
//
// ⚠ A malformed file throws HERE, at import, and the tab says so instead of
// planning against nothing — see `PnpTab.tsx`.

import raw from '../../../../../hardware/cad/2bee_pnp/pnp_blinds_vspec.json';
import { parseVspec, type Vspec } from './manifest';

/** Repo-relative, for messages. */
export const VSPEC_SOURCE = 'hardware/cad/2bee_pnp/pnp_blinds_vspec.json';

export function bundledVspec(): Vspec {
  return parseVspec(raw);
}
