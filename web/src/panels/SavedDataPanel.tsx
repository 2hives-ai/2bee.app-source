/**
 * SavedDataPanel — the "Saved data" section.
 *
 * Extracted from App.tsx to reduce component size.
 * Handles export/import of all saved objects (machines, workpieces, drawings).
 */

import { useState } from 'react';
import { Section } from './SectionPanel';
import { exportAll, importAll, schemaNote } from '../store';

interface SavedDataPanelProps {
  savedMachines: { refresh: () => void };
  savedWorkpieces: { refresh: () => void };
  savedDrawings: { refresh: () => void };
}

export function SavedDataPanel({ savedMachines, savedWorkpieces, savedDrawings }: SavedDataPanelProps) {
  const [storeNote, setStoreNote] = useState('');

  return (
    <Section title="Saved data" testid="panel-store" defaultOpen={false}>
      <p className="note">
        Machines, workpieces and drawings are kept in THIS BROWSER
        (IndexedDB). There is no server: nothing is uploaded, and clearing
        site data deletes them. Export writes one file you can keep with
        the machine.
      </p>
      {/* 🔴 ANOTHER BUILD OWNS THIS DATABASE — the one fact Chrome's
          `VersionError` was carrying, said by code that chose to say it
          instead of arriving as an exception that killed every collection.
          `store.ts::schemaNote()` returns `null` when there is nothing to
          report, which is every ordinary browser, so this is absent rather
          than reassuring. It is a NOTE and not a `.bad`: the app is
          working, and rendering it red would re-teach the operator exactly
          the thing that was wrong.

          ⚠ IT REPORTS THE LAST SUCCESSFUL OPEN and is not reactive — it
          cannot appear before the store has been touched once. Every panel
          that lists saved objects touches it on mount, so by the time this
          section can be opened the answer is there; if it is ever mounted
          somewhere colder, that is the thing to check first. */}
      {schemaNote() && (
        <p className="note" data-testid="store-schema-note">
          {schemaNote()}
        </p>
      )}
      <div className="row">
        <button
          data-testid="store-export"
          onClick={async () => {
            const text = await exportAll();
            const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            /* The product's name, and it is user-visible: this string is
               the filename in the operator's downloads folder. It said
               `2bee-slicer-store.json` until 2026-08-11 — the same dead
               name the header carried. `importAll` reads the file's
               CONTENT, never its name, so nothing depends on this and an
               already-exported file still imports. */
            a.download = '2bee-app-store.json';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export all
        </button>
        <label className="filebtn">
          Import
          <input
            type="file"
            accept="application/json,.json"
            data-testid="store-import"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const r = await importAll(await f.text(), Date.now());
                /* 🔴 THE LISTS DO NOT KNOW THIS HAPPENED. `importAll`
                   writes straight to IndexedDB, behind every `useSaved`
                   hook, so without these three the import lands in Chrome
                   and NOT in the app: the note below says "imported: 1
                   new" while the picker still shows only what was there
                   before. Measured in the browser 2026-08-11 — see
                   `SavedCollection.refresh`. Re-read them all, because the
                   file carries every collection and there is no per-key
                   answer in `r` to narrow it by. */
                savedMachines.refresh();
                savedWorkpieces.refresh();
                savedDrawings.refresh();
                setStoreNote(
                  `imported: ${r.added} new` +
                    (r.replaced.length ? `, replaced ${r.replaced.join(', ')}` : '')
                );
              } catch (err) {
                setStoreNote(String(err instanceof Error ? err.message : err));
              }
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {storeNote ? (
        <p className="note" data-testid="store-note">
          {storeNote}
        </p>
      ) : null}
    </Section>
  );
}
