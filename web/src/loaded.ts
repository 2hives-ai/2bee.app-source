/**
 * Which work tabs have something loaded (founder 2026-10-16: "cad/cnc/3d .. etc
 * tabs should be disabled if nothing is loaded into").
 *
 * A tab is marked when something is OPENED INTO it: a design page "Open in …",
 * cad's "Open in cnc / 3d", a job sent to cnc.run. The mark is kept in this
 * browser so a reload does not lock a tab that still holds the work. Tabs that
 * are catalogues or setup (design, cnc.tools, machines) are never disabled.
 *
 * The flag only decides whether the tab can be CLICKED. It never vouches for the
 * content: each tab still shows and checks what it holds.
 */
import { useEffect, useState } from 'react';
import type { TabId } from './Tabs';

export type LoadableTab = 'cad' | 'cnc' | 'run' | 'pnp' | 'print3d' | 'pcb';
export const LOADABLE: readonly string[] = ['cad', 'cnc', 'run', 'pnp', 'print3d', 'pcb'];
const KEY = '2bee.app.loaded';
const EVENT = '2bee-loaded';

export type LoadedMap = Partial<Record<LoadableTab, boolean>>;

export function readLoaded(store: Pick<Storage, 'getItem'> | null | undefined): LoadedMap {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: LoadedMap = {};
    for (const [k, on] of Object.entries(v as Record<string, unknown>)) if (LOADABLE.includes(k) && on === true) out[k as LoadableTab] = true;
    return out;
  } catch {
    return {};
  }
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Mark (or clear) a tab as holding something. Unknown ids are ignored. */
export function markLoaded(tab: string, on = true): void {
  if (!LOADABLE.includes(tab)) return;
  const s = store();
  const next = { ...readLoaded(s), [tab]: on };
  if (!on) delete next[tab as LoadableTab];
  try {
    s?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage refused: the in-page event below still enables the tab for this visit */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

/** True when the tab may be clicked: never-gated tabs always, loadable ones once marked. */
export function tabEnabled(id: TabId, loaded: LoadedMap): boolean {
  return !LOADABLE.includes(id) || loaded[id as LoadableTab] === true;
}

export function useLoaded(): LoadedMap {
  const [m, setM] = useState<LoadedMap>(() => readLoaded(store()));
  useEffect(() => {
    const on = (e: Event) => setM({ ...((e as CustomEvent<LoadedMap>).detail ?? readLoaded(store())) });
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return m;
}
