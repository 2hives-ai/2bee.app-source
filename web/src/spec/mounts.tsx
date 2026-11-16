/**
 * Where the specification shows: one small wrapper per tab, so each tab mounts it with
 * one line and owns none of the lookup.
 *
 *   CadSpec  cad tab — the design on screen (saved name, else catalogue path); a change
 *            the review asks for goes to the cad chat (`onAsk` = the gates' autoAsk path)
 *   CncSpec  cnc tab — the chosen design(s); "Open in cad to change" opens the design in
 *            cad and hands the change to cad's chat once THAT design is on screen
 *   PcbSpec  lives in pcbMount.tsx: it needs Vite's import.meta.glob, and node tests import
 *            this file through CadTab.
 */
import { useEffect, useState } from 'react';
import { loadDesign } from '../shop/catalogue';
import { requestOpenIn } from '../shop/handoff';
import { SpecPanel } from './SpecPanel';
import { catalogueOnce, findEntry, ownerSpecFor, resolveDrawingName } from './cadSpecs';
import { claimCadAsk, requestCadAsk, subscribeCadAsk } from './specHandoff';
import type { ShopEntry } from '../shop/catalogue';

function useCatalogueEntries(): ShopEntry[] | null {
  const [entries, setEntries] = useState<ShopEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    void catalogueOnce().then((s) => live && setEntries(s.kind === 'ready' ? s.index.entries : []));
    return () => {
      live = false;
    };
  }, []);
  return entries;
}

export function CadSpec({ selfPath, savedName, source, onAsk }: { selfPath: string | null | undefined; savedName: string | null | undefined; source: string; onAsk: (text: string) => void }) {
  const entries = useCatalogueEntries();
  /* A change request carried from cnc: delivered only once THIS design is on screen. */
  useEffect(() => {
    const deliver = () => {
      const t = claimCadAsk(selfPath);
      if (t) onAsk(t);
    };
    deliver();
    return subscribeCadAsk(deliver);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfPath]);
  const entry = entries ? findEntry(entries, selfPath) : null;
  const key = savedName || selfPath || null;
  const title = savedName || entry?.title || (selfPath ? selfPath.split('/').pop()!.replace(/\.scad$/, '') : 'new design');
  return (
    <SpecPanel
      kind="cad"
      testid="cad-spec"
      designKey={key}
      title={title}
      ownerKey={`${entries ? 'r' : 'l'}|${selfPath ?? ''}`}
      loadOwner={async () => (entries ? ownerSpecFor(entry) : { kind: 'none', owner: 'cad', why: 'the catalogue is still loading' })}
      designSource={() => source}
      onChangeDesign={onAsk}
      changeLabel="Change the design (cad chat)"
    />
  );
}

export function CncSpec({ names, onOpenIn }: { names: string[]; onOpenIn: (target: string) => void }) {
  const entries = useCatalogueEntries();
  const [pick, setPick] = useState(0);
  if (names.length === 0) return null;
  const name = names[Math.min(pick, names.length - 1)];
  const res = entries ? resolveDrawingName(entries, name) : null;
  const entry = res?.entry ?? null;
  return (
    <div className="spec-cnc" data-testid="cnc-spec-wrap">
      {names.length > 1 ? (
        <select aria-label="Which design's specification" value={Math.min(pick, names.length - 1)} onChange={(e) => setPick(Number(e.target.value))}>
          {names.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
      ) : null}
      <SpecPanel
        kind="cad"
        testid="cnc-spec"
        designKey={entry?.path ?? name}
        title={entry?.title ?? name}
        ownerKey={`${entries ? 'r' : 'l'}|${name}`}
        loadOwner={async () =>
          !res ? { kind: 'none', owner: 'cad', why: 'the catalogue is still loading' } : res.entry ? ownerSpecFor(res.entry) : { kind: 'none', owner: 'cad', why: res.why }
        }
        designSource={async () => {
          if (!entry) return `(no source: ${name} is not a catalogue design; review against the specification text only)`;
          const d = await loadDesign(entry.id);
          return d.sources[d.path];
        }}
        onChangeDesign={
          entry
            ? async (text) => {
                const d = await loadDesign(entry.id);
                requestOpenIn('cad', { id: entry.id, title: entry.title, path: d.path, source: d.sources[d.path], files: d.sources });
                requestCadAsk({ path: d.path, text });
                onOpenIn('cad');
              }
            : undefined
        }
        changeLabel="Open in cad to change"
        noChangeWhy="This design is not one of cad’s catalogue designs, so there is no source to open in cad. Change it where it was made."
      />
    </div>
  );
}
