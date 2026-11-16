/**
 * The functional specification of a catalogue design, in the design page's 3D viewer.
 *
 * Founder 2026-10-16: *"where can I see/edit the functional spec of the design/pnp/cad/pcb?"*
 * Keyed exactly like `CadSpec` (the catalogue PATH), so an edit made here is the same
 * user copy the cad tab shows for that design. A change the review asks for goes the way
 * `CncSpec` sends it: the design opens in cad and the request waits for cad's chat until
 * THAT design is on screen (`spec/specHandoff.ts`).
 *
 * Only catalogue designs have a cad spec; a user's own saved model gets no card.
 */
import { useEffect, useState } from 'react';
import { SpecPanel } from '../spec/SpecPanel';
import { catalogueOnce, findEntry, ownerSpecFor } from '../spec/cadSpecs';
import { requestCadAsk } from '../spec/specHandoff';
import { loadDesign, type ShopEntry } from './catalogue';
import { requestOpenIn } from './handoff';

export function DesignSpec({ path, title, onOpenInCad }: { path: string; title: string; onOpenInCad?: () => void }) {
  const [entries, setEntries] = useState<ShopEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    void catalogueOnce().then((s) => live && setEntries(s.kind === 'ready' ? s.index.entries : []));
    return () => {
      live = false;
    };
  }, []);
  const entry = entries ? findEntry(entries, path) : null;
  return (
    <SpecPanel
      kind="cad"
      testid="design-spec"
      designKey={path}
      title={entry?.title ?? title}
      ownerKey={`${entries ? 'r' : 'l'}|${path}`}
      loadOwner={async () => (entries ? ownerSpecFor(entry) : { kind: 'none', owner: 'cad', why: 'the catalogue is still loading' })}
      designSource={async () => {
        if (!entry) return `(no source: ${path} is not a catalogue design; review against the specification text only)`;
        const d = await loadDesign(entry.id);
        return d.sources[d.path];
      }}
      onChangeDesign={
        entry && onOpenInCad
          ? async (text) => {
              const d = await loadDesign(entry.id);
              requestOpenIn('cad', { id: entry.id, title: entry.title, path: d.path, source: d.sources[d.path], files: d.sources });
              requestCadAsk({ path: d.path, text });
              onOpenInCad();
            }
          : undefined
      }
      changeLabel="Open in cad to change"
      noChangeWhy="Open this design in cad from its card to change it."
    />
  );
}
