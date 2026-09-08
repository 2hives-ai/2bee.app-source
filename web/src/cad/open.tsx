// 2bee.cad — opening a saved model back into the editor.
//
// 🔴 THE DEFECT THIS CLOSES. `saveCadModel` has existed since 2026-08-10 and
// `loadCadModel` was written beside it — with no UI caller. A model could be
// written into the drawings list and never re-opened, which made the save a
// one-way trip and this tab an editor you could not return to. The store had
// the door; nothing had the handle.
//
// 🔴 A RECORD WHOSE VERIFICATION FAILS DOES NOT OPEN SILENTLY.
// `verifyCadRecord` answers a question a reader cannot answer by looking: does
// this mesh still belong to this source? — and it says WHICH HALF MOVED. A
// stale record opened without a word puts source in the editor that does not
// describe the geometry stored beside it, and the geometry is what the CNC tab
// cuts. So a failed verification is stated in the record's own sentence and
// costs a second, explicit press.
//
// ⚠ OPENING REPLACES WHAT IS IN THE EDITOR — and as of 2026-08-11 that costs no
// press at all. This file used to confirm whenever the editor held unsaved work.
// It no longer does: `replace.ts` stashes the text every replacement displaces
// and the tab offers ONE put-back control, which costs nothing in the ordinary
// case and actually recovers the mis-click in the bad one. A confirm did the
// opposite of both. **The confirm that remains is the one about the RECORD** —
// see above — because that is a refusal, not an interruption.
//
// ⚠ THIS PANEL IS NOT ON SCREEN UNTIL IT IS ASKED FOR. It used to be a permanent
// block above the editor, headed "Open a saved model", offering the capability a
// second time next to `File → Open…` and holding vertical space on every model
// anyone ever edited (founder, 2026-08-11: *"remove Open a saved model"*). The
// menu command is now the only door, and it MOUNTS this panel rather than
// scrolling to it — the two were coupled before, and deleting the block would
// have deleted Open.
//
// ONE LIST, NOT TWO. `ObjectPicker` is the house component and already carries
// the tag, provenance, search and properties machinery, so this uses it rather
// than growing a second picker with its own conventions. Single-select, because
// opening two models into one editor is not a thing. The row conventions are
// `App.tsx`'s: a `YOURS` tag at the front of `detail`, "Where this came from" as
// the first property, and surface-prefixed ids.
//
// ⚠ Those conventions are MIRRORED rather than imported. They are module-local
// helpers in `App.tsx`, which is the CNC tab and is not this change's to
// restructure; importing it here would make the CAD tab pull in the whole CNC
// app. The duplication is named here so the next person changing either one
// knows the other exists.
//
// ⚠ AND THIS LIST IS SAVED DRAWINGS ONLY. The shipped samples are deliberately
// absent — see the note where the rows are built. The founder's "one list"
// ruling was about the CNC tab's DRAWING picker, where a sample and a saved
// file are both things you can cut; here they are not both things you can open,
// and a list of mostly-disabled rows is not the same courtesy.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 ONE `Open…`, TWO SOURCES — AND THE FOLDER MOUNT WAS NOT DELETED
// ═══════════════════════════════════════════════════════════════════════════
//
// Founder 2026-08-11: *"merge the Open … and Open library folder … — have just
// 1 open!"*. So there is one menu item and one panel, and the panel offers BOTH.
//
// 🔴 THE MERGE IS A MERGE OF THE DOOR, NEVER OF THE CAPABILITY, and deleting the
// folder mount to satisfy the request would have taken the founder's own
// workflow with it. Measured before touching anything: this file reads
// `store.ts` and nothing else — **it has no file input at all** — so the folder
// mount is the ONLY route from disk into this tab. His assemblies import BY PATH
// (`use <../lib/components/skr_pro_v12.scad>`), and `library.ts` records why a
// store keyed on a flat name cannot express *"up one directory"*. Without a
// mounted folder those imports are refused by name, the tree renders MINUS every
// subtree they define, and the result still looks like a model. That failure is
// silent in the only way that matters: the picture is a plausible wrong part.
//
// ⚠ SO THE DISTINCTION THE OLD SECOND MENU ITEM CARRIED HAS TO SURVIVE INSIDE
// THIS PANEL. The two actions differ in WHAT THEY DESTROY — opening replaces the
// operator's source; mounting a folder replaces nothing — and that difference is
// now made by two headed sections and by each control saying which it is, rather
// than by two labels in a menu. A merged panel whose two halves look alike is
// the same trap the two menu items were built to avoid, arriving one level down.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 2026-08-11 — "RECURSIVE, AND LET ME CHOOSE WHAT COMES IN"
// ═══════════════════════════════════════════════════════════════════════════
//
// Founder: *"Should look recursive in all subdirs; before importing all files,
// able to select in a list which files need to be imported."*
//
// ⚠ FIRST HALF: MEASURED BEFORE BUILDING, AND IT WAS ALREADY TRUE.
// `<input webkitdirectory>` walks the subtree in the browser and returns one
// flat list whose members each carry `webkitRelativePath`; `library.ts` keys on
// that path. Against the real `hardware/cad/` on 2026-08-11: **1,255 files
// offered, 517 `.scad` kept at depths 1–4 (6 / 227 / 165 / 119)**, and the
// founder's `2bee_hive_brood_assembly.scad` read **32 files with 0 misses**
// across six directories. **Nothing was built for recursion, because there was
// nothing to build** — what was missing was any statement that it happened, so
// what this change owes that half is the directory count and the depth
// histogram printed from the files that actually arrived.
//
// 🔴 SECOND HALF: "IMPORT" HAD TO BE PINNED DOWN FIRST, BECAUSE THE TWO
// READINGS BEHAVE DIFFERENTLY. It could have meant *copy the chosen files into
// the browser's saved-drawings store* — and that would have been a disaster
// dressed as a feature: the store is keyed on a FLAT NAME, so
// `use <../lib/langstroth_box.scad>` could not be expressed, and the 32-file
// assembly would have collapsed to whatever resolves by basename. It does not
// mean that and it must not: the folder is **mounted**, held in `CadTab.tsx`,
// and `makeLibraryHost` resolves against it on demand. Selecting therefore
// chooses **what is resolvable**, copies nothing, and can only ever narrow.
//
// 🔴 AND NARROWING IS THE DANGEROUS DIRECTION — see {@link LibrarySection} for
// the three places a shortfall is named. The rule the whole design serves:
// *"I kept 5 files and got 3 objects"* must never be something the operator is
// left to discover for themselves.
//
// ⚠ THE ORDER IS DELIBERATE: the folder comes FIRST. It is the prerequisite —
// a file opened out of the folder resolves its own imports against that folder,
// and a saved model opened before the folder is mounted parses with every import
// refused. Putting the non-destructive, enabling step above the destructive one
// is also the safer reading order.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import ObjectPicker, { type ObjectItem } from '../ObjectPicker';
import { list, loadCadModel } from '../store';
import {
  depthHistogram,
  importEdges,
  libraryFromFiles,
  libraryPaths,
  selectionNeeds,
  selectLibrary,
  wasDeselected,
  type ImportEdges,
  type ScadLibrary,
  type SelectionNeeds,
} from './library';
import {
  cadRowDetail,
  describeCadRecord,
  isCadRecord,
  verifyCadRecord,
  type CadVerification,
  type SavedCadDrawing,
} from './record';

/**
 * 🔴 THE ONE SENTENCE THAT TELLS AN OPERATOR HOW TO FIX AN UNRESOLVED IMPORT,
 * AND IT NAMES A CONTROL — so it is only true while that control is named that.
 *
 * It moved here from `CadTab.tsx` in the merge. The old text ended *"File →
 * Open library folder…"*, an item that no longer exists: a refusal that names a
 * non-existent fix sends the operator hunting through a menu for something that
 * was removed, and concluding the message is wrong is the best case. It is a
 * constant rather than a literal because it has three readers — the import
 * report, the editor's gutter mark, and the test that checks it against the menu.
 */
export const MOUNT_A_FOLDER =
  'File → Open… , then “Mount a folder of .scad files”. Picking the folder READS it — press ' +
  'Mount to make the files resolvable; a file you untick there is not mounted and imports of it ' +
  'are refused exactly like this.';



const YOURS_TAG = 'YOURS';

const withTag = (tag: string, rest?: string): string => (rest ? `${tag} · ${rest}` : tag);

const rowId = (surface: string, name: string): string => `${surface}:${name}`;
function parseRowId(id: string): { surface: string; name: string } | null {
  const at = id.indexOf(':');
  return at < 0 ? null : { surface: id.slice(0, at), name: id.slice(at + 1) };
}

/**
 * ⚠ THE TYPE EXCLUDES `'ok'` ON PURPOSE. Only a record that did NOT verify ever
 * reaches the confirm, and saying so in the type is what makes `why` reachable
 * without a second `status === 'ok'` test the compiler cannot connect to
 * {@link openDecision}'s answer. A fourth status joins this automatically;
 * `'ok'` cannot.
 */
type FailedVerification = Exclude<CadVerification, { status: 'ok' }>;

/**
 * 🔴 THE RULE, AS A FUNCTION, so it can be watched going red.
 *
 * `'open'` means open immediately; `'confirm'` means stop and make the user
 * press again with the reason in front of them. Extracted from the click
 * handler on purpose: a rule that lives only inside an async event handler in a
 * component with no DOM in the test harness is a rule nothing asserts, and this
 * is the one rule in this file whose failure is silent — a stale record that
 * opens without a word looks exactly like a good one that opened.
 *
 * ⚠ `'open'` is the NARROW case and it is written as an equality against the ONE
 * good status rather than as a `switch` over the bad ones, so a fourth
 * `CadVerification` status added later confirms by construction instead of
 * falling through to silence.
 *
 * ⚠ IT NO LONGER TAKES `dirty` (2026-08-11). Unsaved work in the editor used to
 * force a confirm here; it is now recovered by the tab's put-back, which costs
 * nothing when the open was wanted. What survives is the confirm that states a
 * REFUSAL — a record whose mesh no longer belongs to its source.
 */
export function openDecision(verification: CadVerification): 'open' | 'confirm' {
  return openRefusal(verification) === null ? 'open' : 'confirm';
}

/**
 * The same rule, returning the thing that has to be SHOWN.
 *
 * 🔴 ONE RULE, TWO CALLERS. The click handler needs the failed verification in
 * order to render `why`, and the type system cannot connect "`openDecision`
 * said confirm" to "`status` is not `'ok'`". Writing the narrowing as a second
 * `status === 'ok'` test in the handler would be a second opinion that could
 * one day disagree with the first, which is the defect this file's own header
 * warns about elsewhere; so {@link openDecision} is defined in terms of THIS
 * and there is still only one place the answer is decided.
 */
export function openRefusal(verification: CadVerification): FailedVerification | null {
  return verification.status === 'ok' ? null : verification;
}

interface Pending {
  name: string;
  record: SavedCadDrawing;
  verification: FailedVerification;
}

/**
 * How many entries of a long list are printed before it says how many it did not
 * print. The number is arbitrary; **saying the remainder is not**.
 */
const SHOWN = 40;

/**
 * A list that is longer than it prints, printing the fact.
 *
 * 🔴 SILENT TRUNCATION READS AS COMPLETENESS. The skipped-files list rendered
 * `slice(0, 40)` with no trailing line, so a folder with 738 non-`.scad` files
 * printed 40 of them and stopped — a reader who scrolled to the end of that list
 * had no way to know 698 more existed. The summary above it carried the true
 * count, which is exactly the shape that makes this hard to notice: one honest
 * number and one list quietly disagreeing with it.
 */
function Truncated<T>({ all, render }: { all: readonly T[]; render(t: T): ReactNode }) {
  const rest = all.length - SHOWN;
  return (
    <>
      {all.slice(0, SHOWN).map((t, i) => (
        <li key={i}>{render(t)}</li>
      ))}
      {rest > 0 ? (
        <li className="warn">
          … and <strong>{rest}</strong> more not shown. This list is cut at {SHOWN}; the count above is
          the whole number.
        </li>
      ) : null}
    </>
  );
}

/** `2bee_hive/box.scad` → `2bee_hive`, and `''` for a file at the folder's root. */
const dirLabel = (p: string): string => {
  const at = p.lastIndexOf('/');
  return at < 0 ? '' : p.slice(0, at);
};

/**
 * Mount a folder of `.scad` files so `use <../lib/foo.scad>` resolves.
 *
 * 🔴 MOVED HERE WHOLE FROM `CadTab.tsx` IN THE `Open…` MERGE, not rewritten. It
 * was `LibraryPanel` behind its own menu item; it is now the first section of
 * the one Open panel. Every `data-testid` came with it, because renaming them
 * would have silently retired the assertions that already watch this control.
 *
 * ⚠ IT OPENS NOTHING AND REPLACES NOTHING — until you choose a file from it,
 * which is a replacement like any other and says so at the point of choosing.
 *
 * ⚠ IT IS A SNAPSHOT. See `library.ts` — the sources are read when the folder is
 * picked and do not follow the disk afterwards. The panel prints when it was
 * taken rather than claiming a freshness nothing in a tab could check.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 PICKING NO LONGER MOUNTS. THE FOLDER IS STAGED, AND THE OPERATOR CHOOSES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Founder 2026-08-11: *"Should look recursive in all subdirs; before importing
 * all files, able to select in a list which files need to be imported."*
 *
 * ⚠ THE RECURSION WAS ALREADY THERE AND NOTHING SAID SO — see `library.ts`.
 * `webkitdirectory` hands back the whole subtree with each file's relative path,
 * so what this change owes that half is EVIDENCE ON SCREEN: the directory count
 * and the depth histogram, printed from the files that actually arrived. A
 * capability an operator cannot see is one they will work around.
 *
 * 🔴 THE SELECTION IS THE PART THAT CAN HURT SOMEONE, AND IT IS NOT A FILTER.
 * Untick a file that a ticked file imports and the import is refused by name,
 * the tree draws MINUS that subtree, and the picture still looks like a model.
 * So the selection is walked against the import graph — transitively, because
 * `A` needs `B` needs `C` — and a shortfall is named in THREE places, at
 * decreasing speed and increasing permanence:
 *
 *   1. **In the list, before mounting.** The rows that are needed and unticked
 *      say so, and the block above them names them with who needs them and
 *      offers to tick them.
 *   2. **In the mount button.** It refuses to read as an ordinary confirm: it
 *      says how many imports will be refused if pressed as it stands.
 *   3. **On the mounted library, permanently.** `selectLibrary` writes
 *      `neededBy` onto the dropped file's skipped entry, so the fact survives
 *      this panel being closed. A warning that only exists in a dialog is true
 *      until the operator presses Close.
 *
 * ⚠ AN INCOMPLETE SELECTION IS ALLOWED, NOT BLOCKED. It is a legitimate thing
 * to want — mount a subdirectory and read one leaf file out of it — and a
 * refusal here would be this lane deciding what the operator meant. What is not
 * allowed is doing it quietly.
 *
 * ⚠ DEFAULT IS EVERYTHING TICKED, and that is a regression control rather than
 * a convenience: pick-then-Mount with no other action mounts exactly the set
 * the old pick-mounts-immediately code mounted, so the founder's 32-file
 * assembly reads 32 files with 0 misses whether or not he ever looks at the
 * list. The selection can only ever narrow.
 *
 * ⚠ EVERY `.scad` FILE IS STILL READ AT PICK TIME, including ones that end up
 * unticked, and the panel says so. The graph cannot be built without the text,
 * and a graph is what makes the warning above possible. **Reading is not
 * mounting**: an unticked file is not in the path map, so nothing can `use` it.
 */
function LibrarySection({
  library,
  onLibrary,
  onOpenFile,
}: {
  library: ScadLibrary;
  onLibrary(lib: ScadLibrary): void;
  /** Load one file from the library into the editor. A replacement like any other. */
  onOpenFile(path: string, source: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Read from disk, graphed, and NOT yet mounted. `null` between picks. */
  const [staged, setStaged] = useState<ScadLibrary | null>(null);
  const [edges, setEdges] = useState<ImportEdges | null>(null);
  const [keep, setKeep] = useState<ReadonlySet<string>>(() => new Set<string>());
  const paths = useMemo(() => libraryPaths(library), [library]);
  const stagedPaths = useMemo(() => (staged ? libraryPaths(staged) : []), [staged]);

  const take = async (list: FileList | null) => {
    if (!list) return;
    setBusy(true);
    setNote(null);
    setStaged(null);
    setEdges(null);
    try {
      const lib = await libraryFromFiles([...list]);
      /* Yield once so "reading the folder…" is actually on screen before the
       * graph pass, which is synchronous and took 253 ms on the 517-file tree
       * this was measured against. A busy flag set in the same tick as the work
       * it describes never paints. */
      await new Promise((r) => setTimeout(r, 0));
      setEdges(importEdges(lib));
      setStaged(lib);
      setKeep(new Set(lib.files.keys()));
    } catch (e) {
      setNote(`the folder could not be read: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** Recomputed on every tick. It walks the graph; it never re-parses. */
  const needs: SelectionNeeds | null = useMemo(
    () => (staged && edges ? selectionNeeds(staged, edges, keep) : null),
    [staged, edges, keep],
  );
  const missingSet = useMemo(
    () => new Set((needs?.missing ?? []).map((m) => m.path)),
    [needs],
  );

  const mount = () => {
    if (!staged) return;
    onLibrary(selectLibrary(staged, keep, needs ?? undefined));
    setStaged(null);
    setEdges(null);
  };

  /* 🔴 THE SHORTFALL THAT SURVIVED THE MOUNT. Read off the library rather than
   * off this component's state, so it is still here after the panel is closed
   * and reopened — which is when an operator comes back wondering why a part is
   * missing. */
  const shortfall = library.skipped.filter((s) => s.neededBy && s.neededBy.length > 0);
  const deselected = library.skipped.filter(wasDeselected);

  const stagedRows = useMemo(
    (): ObjectItem[] =>
      stagedPaths.map((path) => {
        const imports = (edges?.get(path) ?? []).map((e) => e.spec);
        const wanted = missingSet.has(path);
        return {
          id: path,
          name: path,
          detail: wanted
            ? `🔴 NEEDED — a file you kept imports this one · ${imports.length} import(s)`
            : `${staged?.files.get(path)?.split('\n').length ?? 0} lines · ${imports.length} import(s)`,
          properties: [
            {
              label: 'Where it sits',
              value:
                dirLabel(path) === ''
                  ? 'at the top of the folder you picked'
                  : `${dirLabel(path)} — a subdirectory of the folder you picked`,
            },
            {
              label: 'What it imports',
              value:
                imports.length === 0
                  ? 'nothing — it imports no other file, so dropping it cannot break anything else.'
                  : imports.join(', '),
            },
            {
              label: 'What unticking it does',
              value:
                'It is NOT mounted, so every include and use that points at it is refused BY NAME ' +
                'and the parts it defines are not drawn. Nothing is deleted from your disk.',
            },
          ],
        };
      }),
    [stagedPaths, staged, edges, missingSet],
  );

  const rows = useMemo(
    (): ObjectItem[] =>
      paths.map((path) => ({
        id: path,
        name: path,
        detail: `${library.files.get(path)?.split('\n').length ?? 0} lines`,
        properties: [
          {
            label: 'What opening it does',
            value:
              'It puts this file’s source in the editor, replacing what is there — the toolbar ' +
              'offers to put that back. Its own imports resolve against this folder.',
          },
        ],
      })),
    [paths, library],
  );

  const depths = useMemo(() => (staged ? depthHistogram(staged) : []), [staged]);
  const dirCount = useMemo(
    () => new Set(stagedPaths.map(dirLabel)).size,
    [stagedPaths],
  );

  return (
    <div data-testid="cad-library" style={{ marginBottom: 10 }}>
      <strong>1 · Mount a folder of .scad files — where include and use look</strong>
      <p className="note">
        Pick the folder your <code>.scad</code> files live in. <strong>Every subdirectory under it is
        read too</strong>, as deep as it goes, and each file keeps its path — so{' '}
        <code>2bee_hive/box.scad</code> and <code>lib/box.scad</code> stay two different files. Every{' '}
        <code>include</code> and <code>use</code> is then resolved RELATIVE TO THE IMPORTING FILE inside
        it, so <code>use &lt;../lib/langstroth_box.scad&gt;</code> works the same way it does on disk.
        Without a folder every import is refused by name — nothing is silently treated as an empty file,
        and an assembly opened without one draws MINUS every part it imports.{' '}
        <strong>Mounting replaces nothing in the editor.</strong>
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }}>
        <input
          type="file"
          data-testid="cad-library-input"
          aria-label="pick a folder of .scad files"
          multiple
          /* ⚠ NON-STANDARD BUT UNIVERSAL, and not in React's typings. It is also
           * what makes this RECURSIVE: the browser walks the subtree itself and
           * hands back one flat list whose members carry `webkitRelativePath`.
           * The File System Access API would give a live handle instead of a
           * snapshot and is Chrome/Edge only — `library.ts` records the choice. */
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => void take(e.target.files)}
        />
      </div>

      {busy ? <p className="note">reading the folder and working out what imports what…</p> : null}
      {note ? (
        <p className="bad" data-testid="cad-library-error">
          {note}
        </p>
      ) : null}

      {/* ── staged: read, graphed, NOT mounted ───────────────────────────── */}
      {staged ? (
        <div
          data-testid="cad-library-staged"
          style={{ border: '1px solid var(--line)', borderRadius: 4, padding: 8, marginTop: 6 }}
        >
          <p className="warn" style={{ margin: '0 0 4px' }}>
            <strong>Nothing is mounted yet.</strong> {staged.files.size} <code>.scad</code> file(s) were
            read from <strong>{staged.rootName || 'the folder'}</strong>, across {dirCount} directory(s)
            {depths.length > 0 ? (
              <>
                {' '}
                and {depths.length} nesting level(s) —{' '}
                {depths.map((d) => `${d.files} at depth ${d.depth}`).join(', ')} (depth counts the
                folder you picked as level 1)
              </>
            ) : null}
            . Choose which ones to mount, then press Mount below.
          </p>
          <p className="note" style={{ margin: '0 0 6px' }}>
            Every file above was READ, so this list can tell you what imports what. Reading is not
            mounting: an unticked file is not in the path map, so nothing can <code>use</code> it and
            nothing is written anywhere — this folder is resolved against on demand and never copied
            into the browser’s saved drawings.
          </p>

          {needs && needs.missing.length > 0 ? (
            /* 🔴 THE ONE FAILURE THIS FEATURE CREATES, NAMED BEFORE IT HAPPENS. */
            <div data-testid="cad-library-missing" style={{ margin: '6px 0' }}>
              <p className="bad" style={{ margin: '0 0 4px' }}>
                <strong>
                  🔴 {needs.missing.length} file(s) you have UNTICKED are imported by files you have
                  KEPT.
                </strong>{' '}
                Mount as it stands and those imports are refused by name: the model draws MINUS every
                part they define, and it will still look like a model.
              </p>
              <ul className="notes" style={{ margin: '0 0 4px' }}>
                <Truncated
                  all={needs.missing}
                  render={(m) => (
                    <>
                      <code>{m.path}</code> — needed by{' '}
                      {m.neededBy
                        .slice(0, 3)
                        .map((p) => p)
                        .join(', ')}
                      {m.neededBy.length > 3 ? ` and ${m.neededBy.length - 3} more` : ''}
                    </>
                  )}
                />
              </ul>
              <button
                type="button"
                data-testid="cad-library-keep-needed"
                onClick={() => setKeep(new Set(needs.needed))}
              >
                {`Also keep the ${needs.missing.length} file(s) they import`}
              </button>
            </div>
          ) : null}

          {needs && needs.unresolvable.length > 0 ? (
            /* ⚠ A DIFFERENT FACT, KEPT APART. These fail with the WHOLE folder
             * mounted, so no amount of ticking fixes them and putting them in
             * the red block above would make the fixable warning look unfixable. */
            <details data-testid="cad-library-unresolvable" style={{ margin: '6px 0' }}>
              <summary className="warn" style={{ cursor: 'pointer' }}>
                {needs.unresolvable.length} import(s) reachable from your selection point at files that
                are not in this folder at all — ticking cannot fix these
              </summary>
              <ul className="notes">
                <Truncated
                  all={needs.unresolvable}
                  render={(e) => (
                    <>
                      <code>{e.from}</code> asks for <code>{e.spec}</code> —{' '}
                      {e.resolved === null
                        ? 'it climbs out of the folder you picked'
                        : `resolves to ${e.resolved}, which is not here`}
                    </>
                  )}
                />
              </ul>
            </details>
          ) : null}

          <ObjectPicker
            label="Which files to mount — untick anything you do not want resolvable"
            testid="cad-library-select"
            mode="multi"
            defaultOpen
            placeholder="choose the files to mount…"
            searchPlaceholder="path…"
            items={stagedRows}
            selectedIds={[...keep]}
            onChange={(ids) => setKeep(new Set(ids))}
            emptyMessage="This folder holds no .scad files, in any subdirectory."
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" data-testid="cad-library-mount" onClick={mount}>
              {needs && needs.missing.length > 0
                ? `Mount ${keep.size} of ${staged.files.size} — ${needs.missing.length} import(s) WILL be refused`
                : `Mount ${keep.size} of ${staged.files.size} file(s)`}
            </button>
            <button
              type="button"
              data-testid="cad-library-select-all"
              onClick={() => setKeep(new Set(staged.files.keys()))}
            >
              Select all
            </button>
            <button
              type="button"
              data-testid="cad-library-select-none"
              onClick={() => setKeep(new Set())}
            >
              Select none
            </button>
            <button
              type="button"
              data-testid="cad-library-cancel"
              onClick={() => {
                setStaged(null);
                setEdges(null);
              }}
            >
              Cancel — mount nothing
            </button>
          </div>

          {staged.skipped.length > 0 ? (
            <details data-testid="cad-library-staged-skipped" style={{ marginTop: 6 }}>
              <summary className="warn" style={{ cursor: 'pointer' }}>
                {staged.skipped.length} file(s) in that folder were NOT read at all
              </summary>
              <ul className="notes">
                <Truncated
                  all={staged.skipped}
                  render={(k) => (
                    <>
                      <code>{k.path}</code> — {k.why}
                    </>
                  )}
                />
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* ── mounted ───────────────────────────────────────────────────────── */}
      {library.files.size > 0 ? (
        <>
          <p className="note" data-testid="cad-library-snapshot">
            <strong>{library.files.size}</strong> file(s) mounted from{' '}
            <strong>{library.rootName || 'the folder'}</strong>, read at{' '}
            {new Date(library.pickedAt).toLocaleTimeString()}
            {deselected.length > 0 ? (
              <>
                {' '}
                — and <strong>{deselected.length}</strong> more that were read and you did NOT select,
                so nothing can import them
              </>
            ) : null}
            . 🔴 This is a SNAPSHOT: a file changed on disk after that moment is NOT what is being
            parsed here, and a browser tab has no way to notice. Pick the folder again to refresh it.
            {staged ? ' This is the folder mounted BEFORE the pick above; it stays mounted until you press Mount.' : ''}
          </p>

          {shortfall.length > 0 ? (
            /* 🔴 THE SAME WARNING AS THE STAGED ONE, BUT ABOUT WHAT IS ACTUALLY
             * MOUNTED, AND IT OUTLIVES THE DIALOG. This is the state the CNC tab
             * eventually cuts from. */
            <div className="bad" data-testid="cad-library-shortfall" style={{ margin: '4px 0' }}>
              <strong>
                🔴 {shortfall.length} file(s) that the mounted files import are NOT mounted.
              </strong>{' '}
              You unticked them. Every one of those imports is refused by name and the parts they define
              are not drawn — pick the folder again and keep them to fix it.
              <ul className="notes">
                <Truncated
                  all={shortfall}
                  render={(s) => (
                    <>
                      <code>{s.path}</code> — needed by {(s.neededBy ?? []).slice(0, 3).join(', ')}
                      {(s.neededBy ?? []).length > 3 ? ` and ${(s.neededBy ?? []).length - 3} more` : ''}
                    </>
                  )}
                />
              </ul>
            </div>
          ) : null}

          <ObjectPicker
            label="Open one of these into the editor — this DOES replace what is there"
            testid="cad-library-picker"
            mode="single"
            placeholder="choose a file…"
            searchPlaceholder="path…"
            items={rows}
            selectedIds={[]}
            onChange={(ids) => {
              const path = ids[0];
              const source = path ? library.files.get(path) : undefined;
              if (path && source !== undefined) onOpenFile(path, source);
            }}
            emptyMessage="This folder holds no .scad files."
          />
        </>
      ) : null}

      {library.skipped.length > 0 ? (
        /* 🔴 SKIPPED FILES ARE SAID, AND THE LIST SAYS WHEN IT IS SHORTER THAN
         * THE COUNT. A library that quietly ignored half a folder and one that
         * was given half a folder look identical from here. */
        <details data-testid="cad-library-skipped" style={{ marginTop: 6 }}>
          <summary className="warn" style={{ cursor: 'pointer' }}>
            {library.skipped.length} file(s) in that folder were NOT loaded
          </summary>
          <ul className="notes">
            <Truncated
              all={library.skipped}
              render={(k) => (
                <>
                  <code>{k.path}</code> — {k.why}
                </>
              )}
            />
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export interface CadOpenProps {
  /** Hand the stored source back to the editor. Called only after any confirm. */
  onOpen(source: string, name: string): void;
  /** Dismiss the panel. Present because the panel is opened on demand. */
  onClose(): void;
  /** The folder currently mounted, if any. See {@link LibrarySection}. */
  library: ScadLibrary;
  /** A new folder snapshot was taken. */
  onLibrary(lib: ScadLibrary): void;
  /**
   * Put one of the folder's files in the editor. Separate from {@link onOpen}
   * because it also carries the file's PATH, which is what makes `../` in that
   * file mean the directory it actually sits in.
   */
  onOpenFile(path: string, source: string): void;
}

export function CadOpen({ onOpen, onClose, library, onLibrary, onOpenFile }: CadOpenProps) {
  const [saved, setSaved] = useState<{ name: string; savedAt: number; data: unknown }[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    list('drawings')
      .then((items) => {
        setSaved(items.map((i) => ({ name: i.name, savedAt: i.saved_at, data: i.data })));
        setReadError(null);
      })
      /* 🔴 A FAILED READ IS SAID, not swallowed into an empty list. "You have
       * saved nothing" and "I could not read what you saved" are different
       * facts, and only the first is a reason to stop looking. */
      .catch((e) => setReadError(String(e instanceof Error ? e.message : e)));
  }, []);
  useEffect(refresh, [refresh]);

  const items = useMemo((): ObjectItem[] => {
    const rows: ObjectItem[] = [];

    /* Openable first. A list whose top half cannot be used reads as a broken
     * list, however well each row explains itself. */
    for (const s of saved) {
      if (!isCadRecord(s.data)) continue;
      const rec = s.data;
      const v = verifyCadRecord(rec);
      rows.push({
        id: rowId('saved', s.name),
        name: s.name,
        detail: withTag(YOURS_TAG, cadRowDetail(rec)),
        properties: [
          {
            label: 'Where this came from',
            value:
              `YOU saved this in THIS browser on ${new Date(s.savedAt).toLocaleString()}. ` +
              'Clearing site data deletes it — there is no server copy.',
          },
          /* 🔴 The record's OWN description, unedited, and it leads with what is
           * MISSING and whether the mesh still matches its source. That order is
           * `describeCadRecord`'s argument, not this file's, and re-ordering it
           * here would put a caveat under the numbers it qualifies. */
          ...describeCadRecord(rec, v),
        ],
      });
    }

    /* Saved, but not a 2bee.cad model: an imported DXF/SVG/STL. Listed rather
     * than filtered, because a name that is in the drawings list and NOT in
     * this list reads as data loss. */
    for (const s of saved) {
      if (isCadRecord(s.data)) continue;
      rows.push({
        id: rowId('other', s.name),
        name: s.name,
        detail: withTag(YOURS_TAG, 'an imported drawing — no 2bee.cad source'),
        disabled: true,
        disabledReason:
          'This is a drawing you imported from a file, not a model designed in this tab. There is no ' +
          '2bee.cad source stored with it, so there is nothing to put in the editor. It is still usable ' +
          'in the CNC tab.',
      });
    }

    /* ⚠ THE SHIPPED SAMPLES ARE NOT ROWS HERE, and the picker's EMPTY STATE says
     * why rather than leaving their absence to be noticed. They are real
     * DXF/SVG/STL files — a mesh and a drawing, never 2bee.cad source — so
     * there is nothing any of them could put in this editor. They would be a
     * screenful of permanently disabled rows above the handful that work.
     *
     * The SAVED non-CAD drawings above ARE listed, because those share a
     * namespace with the models this tab writes: a name that is in the drawings
     * list and missing from this one would read as data loss, which is not true
     * of a sample that was never in it. */
    return rows;
  }, [saved]);

  const openable = items.filter((i) => !i.disabled).length;

  const choose = async (ids: string[]) => {
    setNote(null);
    const id = ids[0];
    if (!id) return;
    const p = parseRowId(id);
    if (!p || p.surface !== 'saved') return;

    const got = await loadCadModel(p.name);
    if (!got) {
      /* Reachable: the row was built from a list read that has since gone
       * stale (another tab deleted it, or it stopped being a CAD record). */
      setNote(`"${p.name}" could not be opened — it is no longer a 2bee.cad model in this browser.`);
      refresh();
      return;
    }

    const refusal = openRefusal(got.verification);
    if (refusal === null) {
      /* Nothing to refuse: the record verifies. A confirm here would be a press
       * that always says yes, which is how people learn to press through the one
       * that matters — and whatever this replaced can be put back from the
       * toolbar without having cost anyone a press. */
      onOpen(got.item.data.cad.source, p.name);
      /* 🔴 NO "opened X" NOTE. The editor now holds the model — the state IS the
       * confirmation, and a strip that only ever says the thing worked is what
       * teaches an operator to stop reading strips. The panel closes instead. */
      onClose();
      return;
    }
    setPending({ name: p.name, record: got.item.data, verification: refusal });
  };

  const confirmOpen = () => {
    if (!pending) return;
    onOpen(pending.record.cad.source, pending.name);
    /* 🔴 THE NOTE SURVIVES ONLY ON THE UNVERIFIED PATH, and the panel stays open
     * to carry it. This is a stated absence — the mesh beside that source is not
     * a mesh of it — and it is the one thing about the open the operator cannot
     * see by looking at the editor. */
    setNote(
      `opened "${pending.name}" — the record did NOT verify (${pending.verification.status}). ` +
        'The source is now in the editor; the mesh stored with it does not belong to it. Re-save to ' +
        'make them agree.',
    );
    setPending(null);
  };

  return (
    <div className="block" data-testid="cad-open" style={{ marginBottom: 8 }}>
      <LibrarySection library={library} onLibrary={onLibrary} onOpenFile={onOpenFile} />

      <div style={{ height: 1, background: 'var(--line)', margin: '10px 0' }} />

      <strong>2 · Open a model saved in this browser</strong>
      <p className="note" style={{ marginTop: 2 }}>
        These are models designed in this tab and saved into the drawings list. Opening one REPLACES
        what is in the editor — the toolbar offers to put it back.{' '}
        <strong>They are not files on your disk</strong>; a model that lives in a folder is above.
      </p>

      <ObjectPicker
        label="Open a model designed in this tab"
        testid="cad-open-picker"
        mode="single"
        /* 🔴 THE LIST IS UP THE MOMENT THE MENU ITEM IS PRESSED (founder,
         * 2026-08-11: *"File Open.. should straight bring up the list of files
         * in 2bee.cad"*). `Open…` with an ellipsis is a promise that a chooser
         * appears; a command that merely reveals a panel further down the page
         * reads as a menu item that did nothing. */
        defaultOpen
        placeholder={
          openable
            ? 'choose a model designed in this tab…'
            : 'nothing designed in this tab is saved in this browser'
        }
        searchPlaceholder="name…"
        items={items}
        selectedIds={[]}
        onChange={(ids) => void choose(ids)}
        /* 🔴 THE LIMIT THAT USED TO BE A FOUR-LINE NOTE ABOVE THIS PICKER LIVES
         * HERE AND IN THE DISABLED ROWS' OWN REASONS. An empty list is exactly
         * the moment someone wonders where their imported DXF and the shipped
         * samples went, so the answer is in the empty state rather than in a
         * paragraph that was on screen every other time as well. */
        emptyMessage={
          'Nothing designed in this tab is saved in this browser yet. Only a model designed here ' +
          'carries 2bee.cad SOURCE, and source is the only thing that can go back in the editor — a ' +
          'drawing you imported from a file appears in this list with the reason it cannot be opened, ' +
          'and the shipped samples are not in it at all: they are DXF, SVG and STL, and a mesh has no ' +
          'source to recover. All of them are still usable in the CNC tab.'
        }
      />

      {readError ? (
        <p className="bad" data-testid="cad-open-read-error" style={{ margin: '6px 0 0' }}>
          Could not read the saved drawings: {readError}. This list is NOT empty — it is unread, and the
          two look identical.
        </p>
      ) : null}

      {pending ? (
        /* The ONLY confirm left in this file, and it states a refusal rather
         * than asking permission: this record's mesh is not a mesh of this
         * record's source. */
        <div data-testid="cad-open-confirm" style={{ marginTop: 8 }}>
          <p className="bad" data-testid="cad-open-unverified" style={{ margin: '0 0 6px' }}>
            <strong>
              {pending.verification.status === 'stale'
                ? '🔴 THIS RECORD DID NOT VERIFY — the mesh and its source have drifted apart.'
                : '🔴 THIS RECORD CANNOT BE READ BY THIS BUILD.'}
            </strong>{' '}
            {pending.verification.why} Opening puts the stored SOURCE in the editor; it does not repair
            the stored mesh, and the CNC tab cuts the mesh.
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" data-testid="cad-open-go" onClick={confirmOpen}>
              {`Open "${pending.name}" anyway`}
            </button>
            <button type="button" data-testid="cad-open-cancel" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {note ? (
        <p className="bad" data-testid="cad-open-note" style={{ marginBottom: 6 }}>
          {note}
        </p>
      ) : null}

      <button type="button" data-testid="cad-open-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export default CadOpen;
