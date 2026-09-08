// 2bee.cad — resolving `include <...>` and `use <...>` against a folder the
// operator picked.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS IS FOR, AND WHY IT IS A PATH MAP RATHER THAN A NAME LOOKUP
// ═══════════════════════════════════════════════════════════════════════════
//
// `scad.ts` implements both imports and resolves NEITHER — by design: a browser
// tab has no file system, so the parser asks a {@link ScadFileHost} and refuses
// by name when there is none. `CadTab.tsx` passed no host, so every import in
// this tab refused. This file is the host.
//
// 🔴 THE GRAPH IT HAS TO SATISFY IS DIRECTORY-RELATIVE AND DEEP. The founder's
// target is `hardware/cad/2bee_hive/2bee_hive_brood_assembly.scad` and
// `hardware/cad/2bee_solar_box/solar_box_assembly.scad`, and those two and their
// siblings pull in **37 distinct imports** shaped like:
//
//   use <2bee_hive_joinery.scad>                      same directory
//   use <../2bee_connectors.scad>                     up one
//   use <../lib/langstroth_box.scad>                  up and across
//   use <../2bee_vent_node/vent_node_inwall_3d.scad>  up and into a sibling
//   include <../archive/2bee_weight/2bee_weight.scad>
//
// ⇒ **`../2bee_connectors.scad` is a PATH, not a name.** A store keyed on a
// saved model's name cannot express "up one directory" and cannot tell two files
// with the same basename in different folders apart — and this tree has those.
// So the library is a map from NORMALISED PATH to source, and every spec is
// resolved against the directory of the file doing the importing.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHERE THE FILES COME FROM: `<input type="file" webkitdirectory>`
// ═══════════════════════════════════════════════════════════════════════════
//
// The operator picks a folder once; the browser hands back every file in it with
// a RELATIVE PATH (`File.webkitRelativePath`), which is exactly the key this map
// needs. Chrome, Edge, Firefox and Safari all implement it.
//
// 🔴 IT IS RECURSIVE, AND THIS FILE NEVER WALKS ANYTHING. `webkitdirectory`
// enumerates the WHOLE SUBTREE and hands back one flat `FileList` whose members
// each carry their full relative path, so subdirectories arrive for free and
// arrive DISTINGUISHED — `2bee_hive/box.scad` and `lib/box.scad` are two keys,
// not one. Because nothing here descends, none of the usual walk hazards are
// reachable from this code: no symlink loop to detect, no depth to bound, no
// per-directory permission to lose halfway down. The bounds that DO apply are
// on what came back — {@link MAX_LIBRARY_FILES} and {@link MAX_LIBRARY_BYTES} —
// and both refuse loudly rather than truncating quietly.
//
// ⚠ THE FILE SYSTEM ACCESS API IS DELIBERATELY NOT USED. It would give a live
// handle instead of a snapshot, and it is Chrome/Edge only — one route that
// works everywhere beats two that each work somewhere. Named here so the choice
// is a decision on the record rather than an omission.
//
// 🔴 THIS IS A SNAPSHOT, AND THE UI MUST SAY SO. The sources are read at pick
// time and held in memory. **If a file on disk changes afterwards, this library
// does not follow it** — the parse is then against a version of the library the
// operator can no longer see. There is no checksum that could detect it from
// inside a tab, so {@link ScadLibrary.pickedAt} is carried and stated rather
// than a staleness claim nothing can check. Re-pick the folder to refresh.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 A MISS IS REPORTED WITH WHAT IT LOOKED FOR AND WHAT EXISTS
// ═══════════════════════════════════════════════════════════════════════════
//
// `ScadFileHost.read` can only return a file or `null`, and the parser's refusal
// then says the path could not be resolved — true, and not enough to act on. So
// the host RECORDS every miss ({@link LibraryHost.misses}) with the spec, the
// path it resolved to, why it missed, and the nearest names that do exist. An
// operator staring at an empty module needs "you have `2bee_connectors.scad` in
// `2bee_hive/`, not in the folder you picked", not "unresolved".
//
// ⚠ AND AN UNRESOLVED IMPORT IS NEVER AN EMPTY FILE. That property is the
// parser's and is not re-implemented here — `read` returns `null`, never an
// empty source. An empty file would turn every module the library defines into
// "unknown module" and blame the operator's typing for our resolution failure.

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE FOLDER IS ALREADY RECURSIVE, AND CHOOSING A SUBSET IS A GRAPH PROBLEM
// ═══════════════════════════════════════════════════════════════════════════
//
// Founder 2026-08-11: *"Should look recursive in all subdirs; before importing
// all files, able to select in a list which files need to be imported."*
//
// ⚠ THE FIRST HALF WAS ALREADY TRUE AND NOTHING SAID SO. `<input
// webkitdirectory>` hands back **every file in every subdirectory**, and
// `webkitRelativePath` is the full relative path — which is the key this map
// is built on, so the depth was never lost. Measured against the real
// `hardware/cad/` on 2026-08-11: **1,255 files offered, 517 `.scad` kept, at
// depths 1/2/3/4 (6 / 227 / 165 / 119)**, and `2bee_hive_brood_assembly.scad`
// read **32 files with 0 misses** across six different directories. So the
// change for that half is a SENTENCE, not a walk: a capability nobody can see
// is one an operator will build a workaround for.
//
// 🔴 THE SECOND HALF IS THE DANGEROUS ONE, AND IT IS NOT A FILTER. Deselect a
// file that a selected file imports and the import is refused BY NAME, the tree
// renders MINUS every subtree that file defines, and the picture still looks
// like a model. "I kept 5 files and got 3 objects" must never be something the
// operator is left to notice. So the selection is checked against the IMPORT
// GRAPH before it is mounted — see {@link importEdges} and
// {@link selectionNeeds}.
//
// 🔴 AND NOTHING IS COPIED ANYWHERE. "Import" here means *"is reachable from
// `host.read`"*, not *"is written into the browser's saved-drawings store"*.
// The mounted folder stays a path map that `CadTab.tsx` holds and resolves
// against on demand. That is the whole reason this file exists: the store is
// keyed on a FLAT NAME and cannot express `../lib/langstroth_box.scad`, so
// copying selected files into it would break every path-based import — the
// exact loss the `Open…` merge was built to avoid. Selecting is therefore a
// choice about what is LISTED AND RESOLVABLE, and it can only ever narrow.

/* 🔴 `./scad.ts` WITH THE EXTENSION, AND IT IS THE ONE FILE HERE THAT NEEDS IT.
 *
 * `tools/scad_oracle` imports this module through node's own TypeScript support,
 * which does NOT resolve an extensionless specifier — see the dated note at the
 * top of `mesh.ts`, which hit this on 2026-08-11 and solved it by making its
 * import TYPE-ONLY. That escape is not available here: `importEdges` genuinely
 * CALLS `parseScad`, so the import has to carry a value.
 *
 * The alternative was to re-implement `resolveSpec`/`normalisePath` inside the
 * harness. That was rejected: the gate would then measure a resolver that is not
 * the one the product ships, which is the "a gate that exercises a different
 * build than the product" failure this lane already has a rule about. One
 * extension keeps the oracle on the REAL resolver.
 *
 * `allowImportingTsExtensions` is on in `web/tsconfig.json`, and Vite resolves
 * it unchanged. */
import { parseScad, type ScadFileHost } from './scad.ts';

/** Only these are read. A folder of STLs is not a library. */
export const SCAD_EXTENSION = '.scad';

/** Refuse absurd inputs rather than hanging a tab on a picked home directory. */
export const MAX_LIBRARY_FILES = 2000;
export const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;

/**
 * Split a path into segments, resolving `.` and `..`.
 *
 * 🔴 IT NORMALISES BOTH SEPARATORS AND DOES NOT TOUCH CASE. `\` is accepted
 * because a spec may have been written on Windows; case is left alone because
 * the trees this reads are case-sensitive and folding it would make
 * `Box.scad` and `box.scad` the same file, which on the machine that authored
 * them they are not.
 *
 * @returns `null` when the path climbs above its own root — `../../etc/passwd`
 *          is a REFUSAL by name, never a silent miss, because the two are
 *          different facts and only one of them is the operator's typo.
 */
export function normalisePath(path: string): string | null {
  const out: string[] = [];
  for (const raw of path.split(/[\\/]+/)) {
    const seg = raw.trim();
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** The directory part of a normalised path, `''` at the root. */
export function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * Where a spec written inside `<>` points, given the file that wrote it.
 *
 * A spec beginning with `/` is taken as relative to the picked folder's root —
 * there is no other root a tab could mean, and treating it as the machine's
 * would resolve nothing while looking like it might.
 *
 * @returns `null` when the result escapes the picked folder. See
 *          {@link normalisePath}.
 */
export function resolveSpec(spec: string, from: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === '') return null;
  if (/^[\\/]/.test(trimmed)) return normalisePath(trimmed);
  const base = dirOf(normalisePath(from) ?? '');
  return normalisePath(base === '' ? trimmed : `${base}/${trimmed}`);
}

/** One `.scad` file, keyed by its path relative to the folder that was picked. */
export interface ScadLibrary {
  /** Normalised path → source. */
  files: Map<string, string>;
  /** The folder's own name, as the picker reported it. For the UI only. */
  rootName: string;
  /** When the snapshot was taken. It does NOT follow the disk — see the header. */
  pickedAt: number;
  /**
   * Files that were offered and NOT taken, with the reason. Reported, never
   * silently dropped: a library that quietly ignored half a folder and one that
   * was given half a folder look identical.
   *
   * ⚠ `neededBy` IS THE ONE ENTRY THAT IS NOT MERELY INFORMATIONAL. It is set
   * only by {@link selectLibrary}, only on a file the operator dropped that a
   * file they KEPT imports, and it names the importers. It travels on the
   * library rather than in a component's state so that the fact survives the
   * panel being closed and reopened — the mount outlives the dialog that made
   * it, and so must the reason it is incomplete.
   */
  skipped: { path: string; why: string; neededBy?: string[] }[];
}

export const EMPTY_LIBRARY: ScadLibrary = {
  files: new Map(),
  rootName: '',
  pickedAt: 0,
  skipped: [],
};

/** What a `read` asked for and did not get. */
export interface LibraryMiss {
  /** Exactly what was between the angle brackets. */
  spec: string;
  /** The importing file. `''` for the root source. */
  from: string;
  /** Where it resolved to, or `null` when it escaped the folder. */
  resolved: string | null;
  why: 'escapes-the-folder' | 'no-such-file' | 'no-library';
  /**
   * Paths that exist and are plausibly what was meant — same basename first,
   * then near-misses on the basename. Never a guess that gets USED; a near-miss
   * silently resolved is how a model is drawn from the wrong file.
   */
  candidates: string[];
}

export interface LibraryHost extends ScadFileHost {
  /**
   * Every miss since this host was made, in order.
   *
   * ⚠ IT IS MUTABLE STATE ON THE HOST, and that is deliberate: `read` returns a
   * file or `null` and has nowhere else to put a reason. A fresh host is built
   * per parse (see {@link makeLibraryHost}'s caller) so the list is never a
   * mixture of two parses.
   */
  readonly misses: LibraryMiss[];
  /** Paths actually read, in order, deduplicated. The resolution evidence. */
  readonly reads: string[];
}

/** Case-insensitive basename, for suggesting near-misses only. */
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

/**
 * Names that exist and might be what was meant.
 *
 * 🔴 SUGGESTED, NEVER SUBSTITUTED. The whole reason a near-miss is dangerous is
 * that the wrong file parses perfectly and draws a plausible wrong part.
 */
export function candidatesFor(spec: string, files: Iterable<string>): string[] {
  const want = baseOf(spec);
  const exact: string[] = [];
  const near: string[] = [];
  for (const p of files) {
    const b = baseOf(p);
    if (b === want) exact.push(p);
    else if (want.length >= 4 && (b.includes(want) || want.includes(b))) near.push(p);
  }
  return [...exact, ...near].slice(0, 8);
}

/**
 * The host itself.
 *
 * ⚠ ONE PER PARSE. `misses` and `reads` describe a single parse; reusing a host
 * across parses would report a resolution failure that has since been fixed, and
 * a stale red reads exactly like a stale green.
 */
export function makeLibraryHost(lib: ScadLibrary): LibraryHost {
  const misses: LibraryMiss[] = [];
  const reads: string[] = [];
  return {
    misses,
    reads,
    read(spec, from) {
      if (lib.files.size === 0) {
        misses.push({ spec, from, resolved: null, why: 'no-library', candidates: [] });
        return null;
      }
      const resolved = resolveSpec(spec, from);
      if (resolved === null) {
        /* 🔴 CLIMBING OUT OF THE PICKED FOLDER IS A REFUSAL BY NAME, not a miss.
         * The operator chose a root; a spec that leaves it is asking for a file
         * they did not offer, and saying "not found" would send them looking for
         * a typo that is not there. */
        misses.push({ spec, from, resolved: null, why: 'escapes-the-folder', candidates: [] });
        return null;
      }
      const source = lib.files.get(resolved);
      if (source === undefined) {
        misses.push({
          spec,
          from,
          resolved,
          why: 'no-such-file',
          candidates: candidatesFor(resolved, lib.files.keys()),
        });
        return null;
      }
      if (!reads.includes(resolved)) reads.push(resolved);
      return { path: resolved, source };
    },
  };
}

/**
 * Build a library from what a directory `<input>` handed back.
 *
 * ⚠ NON-`.scad` FILES ARE SKIPPED WITH A REASON, not filtered silently — see
 * {@link ScadLibrary.skipped}. A folder that is mostly STLs is a normal thing to
 * pick, and the operator should be able to see that we knew.
 *
 * ⚠ TWO PATHS THAT NORMALISE TO ONE KEY ARE BOTH REFUSED. Keeping the first
 * would make which file wins depend on the browser's enumeration order, and a
 * library whose contents depend on the order they arrived in is a library that
 * draws a different part on a different day.
 */
export async function libraryFromFiles(
  picked: readonly File[],
  now: number = Date.now(),
): Promise<ScadLibrary> {
  const files = new Map<string, string>();
  const skipped: { path: string; why: string }[] = [];
  const collided = new Set<string>();
  let bytes = 0;
  let rootName = '';

  const scads = picked.filter((f) => relPathOf(f).toLowerCase().endsWith(SCAD_EXTENSION));
  for (const f of picked) {
    const rel = relPathOf(f);
    if (rootName === '') rootName = rel.split(/[\\/]/)[0] ?? '';
    if (!rel.toLowerCase().endsWith(SCAD_EXTENSION)) {
      skipped.push({ path: rel, why: `not a ${SCAD_EXTENSION} file` });
    }
  }

  if (scads.length > MAX_LIBRARY_FILES) {
    return {
      files,
      rootName,
      pickedAt: now,
      skipped: [
        {
          path: rootName,
          why:
            `${scads.length} ${SCAD_EXTENSION} files is more than the ${MAX_LIBRARY_FILES} this reads ` +
            'in one go. Nothing was loaded — pick the folder the models actually live in.',
        },
      ],
    };
  }

  for (let i = 0; i < scads.length; i++) {
    const f = scads[i] as File;
    const rel = relPathOf(f);
    const key = normalisePath(rel);
    if (key === null || key === '') {
      skipped.push({ path: rel, why: 'the path does not normalise to anything inside the folder' });
      continue;
    }
    bytes += f.size;
    if (bytes > MAX_LIBRARY_BYTES) {
      /* 🔴 A BOUND THAT STOPS MUST SAY HOW MUCH IT LEFT. This used to read
       * "this file and any after it were not read" — true, and unusable: the
       * operator cannot tell one dropped file from four hundred, and a list
       * that ends without a number reads as a list that ended. The count of
       * what is NOT here is the whole point of the entry. */
      const rest = scads.length - i;
      skipped.push({
        path: rel,
        why:
          `the folder passed ${MAX_LIBRARY_BYTES} bytes of ${SCAD_EXTENSION} source at this file. ` +
          `${rest} file(s) were NOT read — this one and the ${rest - 1} after it. ` +
          `${files.size} file(s) were read before the limit and ARE mounted, so this library is a ` +
          'PREFIX of the folder, not the folder.',
      });
      break;
    }
    if (files.has(key) || collided.has(key)) {
      collided.add(key);
      files.delete(key);
      skipped.push({
        path: rel,
        why: `two files in this folder normalise to "${key}". BOTH were dropped — which one won would otherwise depend on the order the browser listed them.`,
      });
      continue;
    }
    /* 🔴 A FILE THAT CANNOT BE READ IS A SKIP WITH A REASON, NOT A DEAD MOUNT.
     * `webkitdirectory` hands back a snapshot of names taken at the moment of
     * the click; `text()` reads the bytes later, and in between a file can be
     * moved, deleted, or become unreadable. This used to throw all the way out
     * of here, so ONE unreadable file in a subdirectory lost the other 516 and
     * the panel said only "the folder could not be read" — which is the shape
     * this codebase warns about in the other direction too: the operator cannot
     * tell "empty" from "unread". Now the mount survives and the file is named.
     *
     * ⚠ AND THIS IS THE ONLY WAY ACCESS IS LOST PARTWAY DOWN A TREE HERE. The
     * File System Access API's per-directory handle — the thing that can be
     * granted for a folder and refused for its child — is deliberately not used
     * (see the header). There is one gesture, one snapshot, no descent, and so
     * no handle to lose; what remains is this, per file, and it is stated. */
    try {
      files.set(key, await f.text());
    } catch (e) {
      skipped.push({
        path: rel,
        why: `it could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { files, rootName, pickedAt: now, skipped };
}

/**
 * `webkitRelativePath` where the browser supplies it, the plain name otherwise.
 *
 * ⚠ The property is non-standard-but-universal and is not on TypeScript's `File`.
 * It is read defensively rather than asserted, because a `File` from a plain
 * (non-directory) input has it as `''` and that must degrade to the name rather
 * than to an empty key.
 */
export function relPathOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel !== '' ? rel : f.name;
}

/** The `.scad` files, sorted, for a picker. */
export function libraryPaths(lib: ScadLibrary): string[] {
  return [...lib.files.keys()].sort((a, b) => a.localeCompare(b));
}

/**
 * How deep each file sits, for a UI that claims recursion and should have to
 * show it.
 *
 * ⚠ `depth` IS THE NUMBER OF `/` IN THE KEY, which counts the picked folder's
 * own name as one level — because that is what `webkitRelativePath` supplies and
 * this reports the keys it actually has rather than a number derived from an
 * assumption about them. So a file sitting directly in the picked folder is
 * **1**, and one in a sub-sub-directory is **3**. On the real `hardware/cad/`,
 * 2026-08-11: 6 / 227 / 165 / 119 at depths 1 / 2 / 3 / 4. Read it as a
 * comparison between files, not as an absolute — a library assembled by a test
 * harness with no root prefix reports one level shallower, correctly.
 */
export function depthHistogram(lib: ScadLibrary): { depth: number; files: number }[] {
  const by = new Map<number, number>();
  for (const p of lib.files.keys()) {
    const d = p.split('/').length - 1;
    by.set(d, (by.get(d) ?? 0) + 1);
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([depth, files]) => ({ depth, files }));
}

/* ══════════════════════════════════════════════════════════════════════════
   THE IMPORT GRAPH
   ══════════════════════════════════════════════════════════════════════════ */

/** One `use`/`include` a file's parse ATTEMPTS, and where it points. */
export interface ImportEdge {
  /** The importing file. */
  from: string;
  /** Exactly what was between the angle brackets. */
  spec: string;
  /** Where it resolves to, or `null` when it climbs out of the picked folder. */
  resolved: string | null;
}

/** path → the imports that file attempts, in source order. */
export type ImportEdges = ReadonlyMap<string, readonly ImportEdge[]>;

/**
 * Every import edge in the folder, **read by the parser, not by a regex**.
 *
 * 🔴 THIS IS THE SAME ENGINE THAT WILL DO THE REAL RESOLUTION, WITH RESOLUTION
 * SUPPRESSED — the host records the spec and returns `null`, so the parse does
 * not recurse and each file is parsed exactly once. That is the whole argument
 * for it: a second opinion about what an import *is* can disagree with the
 * parser, and a graph that disagrees with the parser warns about the wrong
 * files. **Measured on the real tree, 2026-08-11:** the parser finds **714**
 * edges across 517 files; a careful `(use|include)\s*<...>` regex finds **929**
 * and disagrees with the parser on **119 of the 517 files** — commented-out
 * imports, mostly, plus `use <2bee_cables.scad>` written inside a comment that
 * *documents* how to use the file. Every one of those 215 extra edges would
 * have become a file the operator was told they must keep.
 *
 * ⚠ WHAT IT COSTS: 253 ms for the 517-file `hardware/cad/` tree (7.4 MB of
 * source) on the machine this was measured on. It is one pass per pick, never
 * per selection change — {@link selectionNeeds} walks this map and re-parses
 * nothing.
 *
 * ⚠ AND WHERE IT IS NOT EXACT, IN THE SAFE DIRECTION. `parseScad` recovers from
 * a syntax error by skipping to the next statement boundary, so an import
 * hidden inside a skipped span is not in this map — but it is not in the real
 * parse either, for the same reason and by the same code, so the graph and the
 * behaviour agree. What this map CAN over-report is a file the real parse would
 * never reach because it hit `MAX_IMPORTS` or `MAX_IMPORT_DEPTH` first; that
 * makes {@link selectionNeeds} ask for a file that would not have been read,
 * which costs an unnecessary tick and never a missing subtree.
 */
export function importEdges(lib: ScadLibrary): ImportEdges {
  const edges = new Map<string, ImportEdge[]>();
  for (const [path, source] of lib.files) {
    const found: ImportEdge[] = [];
    const host: ScadFileHost = {
      read(spec, from) {
        found.push({ from: path, spec, resolved: resolveSpec(spec, from) });
        return null;
      },
    };
    try {
      parseScad(source, { host, path });
    } catch {
      /* A file this build cannot parse at all contributes NO edges, and that is
       * stated rather than thrown: the graph is an advisory over a folder the
       * operator chose, and one unparseable file must not stop them mounting
       * the other 516. The real parse of that same file will fail the same way,
       * loudly, in front of them. */
    }
    edges.set(path, found);
  }
  return edges;
}

/** A file a selection needs and does not contain. */
export interface MissingDependency {
  /** The file that must be kept. It IS in the folder — this is a selection defect. */
  path: string;
  /** Files in the needed set that import it, nearest cause first. */
  neededBy: string[];
}

/** What a selection would ask for and not get. */
export interface SelectionNeeds {
  /**
   * The transitive closure of the selection over the folder — every file that
   * would actually be read. Always a superset of the selection.
   */
  needed: Set<string>;
  /**
   * 🔴 THE HAZARD. Files inside the closure that the operator did NOT select.
   * Each one is an import that will be refused by name, and a subtree that will
   * not be drawn. Empty is the only safe value, and it is fixable by ticking.
   */
  missing: MissingDependency[];
  /**
   * Imports reachable from the selection that resolve to nothing **even with
   * the whole folder mounted** — a wrong path, or a file that is not in the
   * tree at all. Kept apart from {@link missing} on purpose: the operator's
   * selection did not cause these and no amount of ticking fixes them.
   * (135 of these exist in `hardware/cad/` today, across 65 files, mostly under
   * `archive/`.)
   */
  unresolvable: ImportEdge[];
}

/**
 * Walk the graph from a selection and say what it is short of.
 *
 * 🔴 IT WALKS THE WHOLE CLOSURE, NOT ONE LEVEL. A selected file needs `A`, `A`
 * needs `B`, and `B` was dropped — the tree loses `B`'s subtree just as surely
 * as if the operator had dropped it themselves, and a one-level check would
 * report nothing at all.
 *
 * ⚠ A CYCLE TERMINATES. `A` includes `B` includes `A` is refused by name in the
 * parser; here it is simply a node already visited.
 */
export function selectionNeeds(
  lib: ScadLibrary,
  edges: ImportEdges,
  selected: Iterable<string>,
): SelectionNeeds {
  const chosen = new Set(selected);
  const needed = new Set<string>();
  const causes = new Map<string, string[]>();
  const unresolvable: ImportEdge[] = [];
  const seenEdge = new Set<string>();

  const queue = [...chosen].filter((p) => lib.files.has(p));
  for (const p of queue) needed.add(p);

  while (queue.length > 0) {
    const from = queue.shift() as string;
    for (const e of edges.get(from) ?? []) {
      if (e.resolved === null || !lib.files.has(e.resolved)) {
        const key = `${e.from}\u0000${e.spec}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          unresolvable.push(e);
        }
        continue;
      }
      const to = e.resolved;
      const why = causes.get(to);
      if (why === undefined) causes.set(to, [from]);
      else if (!why.includes(from)) why.push(from);
      if (!needed.has(to)) {
        needed.add(to);
        queue.push(to);
      }
    }
  }

  const missing: MissingDependency[] = [];
  for (const p of needed) {
    if (chosen.has(p)) continue;
    missing.push({ path: p, neededBy: causes.get(p) ?? [] });
  }
  missing.sort((a, b) => a.path.localeCompare(b.path));
  return { needed, missing, unresolvable };
}

/**
 * The library narrowed to the files the operator kept.
 *
 * 🔴 EVERY DROPPED FILE BECOMES A `skipped` ENTRY SAYING WHO DROPPED IT. The
 * skipped list is the one place this tab admits a folder is not all here, and a
 * file that vanished because of a tick must be in it for the same reason a file
 * that vanished because it was an STL is: a library that quietly holds half a
 * folder and one that was given half a folder look identical from the outside.
 *
 * ⚠ IT CAN ONLY NARROW. A path in `keep` that is not in `lib` is ignored rather
 * than invented — this returns a subset of what was actually read, always.
 *
 * 🔴 A DROPPED FILE THAT A KEPT FILE IMPORTS GETS A LOUDER ENTRY AND A
 * `neededBy` LIST, and that is why `needs` is a parameter rather than something
 * the caller renders and throws away. The panel that made the selection can say
 * "3 of these are imported by files you kept" while it is on screen; the moment
 * it closes, the only surviving record of an incomplete mount is the library
 * itself. A warning that lives in a dialog is a warning that is true until the
 * operator presses Close.
 */
/**
 * The sentence every deselection reason starts with, and the predicate that
 * recognises one.
 *
 * ⚠ IT IS EXPORTED SO THE PANEL DOES NOT RE-TYPE THE STRING. `open.tsx` needs to
 * count "files that were read and you did not keep" out of a skipped list that
 * also holds STLs, collisions and unreadable files, and a prefix match written
 * at the reading end is a copy of a sentence owned at the writing end — the two
 * drift the first time either is reworded, and the symptom is a count silently
 * going to zero.
 */
export const DESELECTED = 'you did not select it';
export const wasDeselected = (s: { why: string }): boolean => s.why.startsWith(DESELECTED);

export function selectLibrary(
  lib: ScadLibrary,
  keep: ReadonlySet<string>,
  needs?: SelectionNeeds,
): ScadLibrary {
  const wanted = new Map<string, string[]>();
  for (const m of needs?.missing ?? []) wanted.set(m.path, m.neededBy);

  const files = new Map<string, string>();
  const dropped: { path: string; why: string; neededBy?: string[] }[] = [];
  for (const [path, source] of lib.files) {
    if (keep.has(path)) {
      files.set(path, source);
      continue;
    }
    const neededBy = wanted.get(path);
    if (neededBy === undefined) {
      dropped.push({ path, why: `${DESELECTED} when the folder was mounted` });
    } else {
      dropped.push({
        path,
        why:
          `${DESELECTED}, and ${neededBy.length} file(s) you DID select import it — ` +
          'every one of those imports is refused BY NAME and the parts they define are NOT drawn.',
        neededBy,
      });
    }
  }
  return {
    files,
    rootName: lib.rootName,
    pickedAt: lib.pickedAt,
    skipped: [...lib.skipped, ...dropped],
  };
}
