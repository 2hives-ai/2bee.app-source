// The sidebar's vocabulary, in the eight files that were swept back to it.
//
// Founder ruling 2026-08-10, verbatim: *"Axes: The sheet is TURNED … use
// terminologies from the left sidebar on all messages (there is no sheet!)"* —
// said of a message that read `the sheet is TURNED` while the panel in front of
// him read **Workpiece**. Canon: `docs/terminology.md`.
//
// ══════════════════════════════════════════════════════════════════════════
//  🔴 WHAT THIS DELIBERATELY CANNOT SEE — read this before trusting a green
// ══════════════════════════════════════════════════════════════════════════
//
//  1. **THE RIGHT WORD ABOUT THE WRONG RECTANGLE.** This matches VOCABULARY.
//     `terminology.md` §11 says it outright: *"S1 is not a vocabulary property
//     and no term scan can reach it."* A message reading *"the workpiece is
//     turned"* said of the spoilboard passes every needle here. The worst live
//     instance found in the sweep that produced this file was the opposite
//     direction — `Viewport.tsx`'s *"a hole through a board that keeps 12mm"*,
//     where `board` meant the WORKPIECE and every other use of `board` in the
//     tree means the spoilboard. A needle told me `sheet` was on that line; it
//     could never have told me `board` was wrong on it.
//
//  2. **A CLAIM THAT AVOIDS THE TERM.** A needle list is a floor, not a ceiling.
//
//  3. **`table`, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT.** The 2026-08-11
//     audit adjudicated every row by hand: `sheet`+`bed` came out at **57%
//     precision**, `table` at **37.5%**, and `stock`/`board`/`fixture`/`bit`/
//     `blank` at **20%** — four false positives per real defect. Canon §11.1 and
//     the audit both predict what happens next: *"a gate that fires four times
//     per real defect gets switched off."* So this checks the two needles worth
//     mechanising and no others. `table`, `board` and `stock` in these files
//     were adjudicated BY HAND in the same pass and are not guarded here.
//
//  4. **COMMENTS.** Canon §0 binds them (they seed the next sweep) and they are
//     out of scope here, because the sweep this file guards corrected strings
//     and JSX text — the population the audit actually adjudicated. Comments in
//     these files still carry retired terms. Stated, not discovered later.
//
//  5. ⚠ **CORRECTED 2026-08-27 — THIS ROW USED TO BE THE HOLE.** It read
//     *"EVERY OTHER FILE … scoped to the eight files the sweep cleaned"*, and
//     named `web/src/cad/**`, `cam.ts`, `jobMaterial.ts`, `materials.ts` and
//     `samples/index.ts` as unguarded. **The scope is now DISCOVERED** — every
//     `.ts`/`.tsx` under `web/src` is swept and a new file cannot land outside
//     the check. The row is corrected in place rather than deleted because a
//     deleted caveat is indistinguishable from one that was never written, and
//     the next reader would re-derive the enumerated list as safe.
//     🔴 What is STILL not covered: `web/e2e/`, `gates/`, `core/`, `cli/` and
//     `docs/` — this file reaches only `web/src`. `core/`'s own retired terms
//     are guarded by the Rust suite, and nothing guards `gates/` or `docs/`.
//     ⚠ **AND THE OLD SCOPE BOUGHT SOMETHING THIS ONE DOES NOT.** Its stated
//     reason was *"so it cannot go red on another lane's live tree"*, and that
//     reason was real: `web/src/cad/**` and `panels/**` are edited by other
//     sessions, and this file was seen going red twice inside one evening on
//     a half-written `panels/SummaryPanel.tsx` that was green again minutes
//     later. **That is the correct trade and it is made knowingly** — a check
//     that cannot see a lane is not cheaper than one that occasionally catches
//     it mid-edit. If you meet such a red, re-run before believing it; if it
//     survives a re-run it is a finding, not a race.
//
//  6. The allowlist is LINE-GRANULAR (and now, for two rows, REGION-granular).
//     A retired term added to a line that already earns an exception is
//     invisible to this check.
//
//  7. **THE NEWLY-COVERED FILES WERE NEVER ADJUDICATED BY ANY SWEEP.** Canon
//     §13d lists findings for the ten files below and for `cam.ts`,
//     `jobMaterial.ts` and `samples/index.ts`. It says nothing about `cad/**`,
//     `units.ts`, `panels/**`, `AuthGate.tsx`, `RunTab.tsx`, `Tabs.tsx` or
//     `toolShape.tsx`. Every exception added for those on 2026-08-27 is a NEW
//     ruling made in this file, not a canon clause transcribed into it.
//
// ══════════════════════════════════════════════════════════════════════════
//
// Structure follows `terminology.md` §11's four legs — and §11's own warning
// that any one leg alone produces a green that means nothing:
//   1. scope by artefact class (STRING + JSXTEXT spans only, never identifiers)
//   2. one needle per retired term, widest inflection, whole-word
//   3. exceptions by explicit allowlist, each keyed to the reason that earns it
//   4. a NEGATIVE CONTROL — three of them, below, plus positive controls, so a
//      "fix" that empties the needle list or blesses the exceptions goes red too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '..', 'src');
/**
 * 🔴 `web/scripts` IS SWEPT TOO, AND IT IS NOT A TIDINESS ADDITION.
 *
 * This sweep reached only `web/src`, and `web/scripts/build-shop-catalogue.ts`
 * writes strings STRAIGHT ONTO OPERATOR CARDS — it generates the Designs
 * catalogue, and its `kindOf()` labelled ten of them "sheet part — cut on the
 * CNC". A retired term was on screen, through a directory this check could not
 * see, while the check reported clean. Found 2026-09-02 only because an
 * unrelated edit tripped the rule inside `web/src`.
 *
 * ⚠ THE GENERAL SHAPE, worth more than the instance: this file's scope is
 * "where operator-facing strings live", and that was silently equated with one
 * directory. A build step that emits UI text is a source of operator strings no
 * matter where it sits, so the scope follows the STRINGS, not the folder.
 */
const SCRIPTS_DIR = join(here, '..', 'scripts');
const srcPath = (p: string) => join(here, '..', 'src', p);
const read = (p: string) => readFileSync(srcPath(p), 'utf8');
const docPath = (p: string) => join(here, '..', '..', 'docs', p);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LEG 5 — THE SCOPE IS DISCOVERED, NEVER ENUMERATED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔴 THIS USED TO BE A HARDCODED LIST OF TEN FILES, AND THAT WAS THE DEFECT.
 * Its own doc comment stated the rule — *"a new file with operator-facing
 * strings joins this list in the change that creates it"* — and **nothing
 * anywhere enforced that rule against the directory.** A rule whose only
 * mechanism is the memory of whoever writes the next file is not a rule; it is
 * a promise made by the person least able to keep it.
 *
 * When the scope was measured against `web/src` on 2026-08-27 the list held 10
 * files and the directory held 63. The 53 outside included `AuthGate.tsx` —
 * the ONE surface an unauthenticated visitor of a served deployment ever sees,
 * and one that had just gained new operator-facing text — plus `RunTab.tsx`,
 * `Tabs.tsx`, every `panels/*.tsx`, `toolShape.tsx` and all of `cad/`.
 *
 * The idiom is gate `CADT`'s (`gates/slicer_gate_check.mjs`, and read it there
 * rather than trusting this paraphrase): `readdirSync` finds the files, the
 * only hardcoded names are the EXCLUSIONS, and **a stale exclusion is itself a
 * failure** — an exclusion naming a file that no longer exists is a file
 * quietly dropped back out of coverage with nothing to say so.
 *
 * ⚠ The failure mode discovery TRADES INTO is under-discovery: a walker that
 * stops recursing returns a smaller set and every check over it goes green.
 * That is why `coverageProblems` below is a check in its own right, with its
 * own plant, rather than a helper nobody asserts on.
 */
function discoverSources(dir: string = SRC_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...discoverSources(join(dir, e.name), `${prefix}${e.name}/`));
    else if (/\.tsx?$/.test(e.name)) out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}


/**
 * The ONLY way a discovered file leaves the sweep, and it costs a sentence.
 *
 * `.d.ts` is handled as a RULE below rather than as rows here, because
 * `web/src/wasm/*.d.ts` is GENERATED by `wasm-pack` — listing generated files
 * by name would make this list go stale on someone else's build step, and a
 * stale exclusion is the failure this leg exists to prevent.
 *
 * 🔴 The list is EMPTY on purpose and that is a claim, not an oversight: every
 * non-generated file under `web/src` is swept today. An entry here must name
 * the file AND say why the vocabulary rule does not reach it — "it has no
 * operator-facing strings" is a measurement that goes stale the next time
 * somebody adds one, so prefer sweeping a clean file over excluding it. A file
 * that is swept and clean costs nothing; a file that is excluded costs a green
 * that means nothing.
 */
const EXCLUDED: { why: string; file: string }[] = [];

/** Generated `.d.ts` declarations carry no prose an operator reads. */
const isGeneratedDeclaration = (f: string) => f.endsWith('.d.ts');

/**
 * What must be true of a discovered set before a green over it means anything.
 * Takes the set as an argument so a PLANT can hand it a damaged one — a guard
 * that can only ever be run over the real thing has never been watched go red.
 */
function coverageProblems(files: string[]): string[] {
  const problems: string[] = [];

  // ① Anchors at three different depths. A walker that returned only the top
  //    level, or that lost one subdirectory, still returns a long plausible
  //    list — the count alone cannot tell you which files went.
  const ANCHORS = [
    'App.tsx', // root of web/src
    'AuthGate.tsx', // the pre-auth surface; the reason this leg was written
    'panels/SummaryPanel.tsx', // one directory down
    'cad/menu.tsx', // a different directory, another lane's live tree
    'run/protocol.ts', // a third, and a `.ts` rather than a `.tsx`
  ];
  for (const a of ANCHORS) {
    if (!files.includes(a)) {
      problems.push(
        `\`${a}\` was NOT discovered under web/src. Either it moved — in which case this anchor ` +
          'is stale and must be repointed, not deleted — or the walker stopped recursing and the ' +
          'sweep silently narrowed. A smaller set is not a cleaner tree.'
      );
    }
  }

  // ② A floor. Files are deleted and renamed, so this is deliberately far
  //    below the 63 measured on 2026-08-27: it is here to catch a walker that
  //    returns a handful, not to pin the tree's size.
  if (files.length < 40) {
    problems.push(
      `only ${files.length} source file(s) discovered under web/src; 63 were present on ` +
        '2026-08-27 and this floor is 40. A collapse this large is a broken walker, not a tidy-up.'
    );
  }

  // ③ Every directory that holds a source file must be represented. This is
  //    NOT an independent enumeration — it reads the same directories through
  //    the same syscall — so it cannot catch a `web/src` that has been moved
  //    wholesale. It catches a lost recursion branch and a broken extension
  //    filter, which are the two ways this walker can plausibly go wrong.
  const dirsWithSource = new Set<string>();
  const walkDirs = (dir: string, prefix = '') => {
    let hasSource = false;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkDirs(join(dir, e.name), `${prefix}${e.name}/`);
      else if (/\.tsx?$/.test(e.name)) hasSource = true;
    }
    if (hasSource) dirsWithSource.add(prefix);
  };
  walkDirs(SRC_DIR);
  const covered = new Set(files.map((f) => (f.includes('/') ? `${f.slice(0, f.lastIndexOf('/'))}/` : '')));
  for (const d of [...dirsWithSource].sort()) {
    if (!covered.has(d)) {
      problems.push(
        `no file was discovered in \`web/src/${d}\`, which holds source files — the walker lost a ` +
          'directory and every string in it is now outside this check'
      );
    }
  }

  // ④ A stale exclusion drops a file back out of coverage silently. CADT
  //    carries the same guard over RUN's two hardcoded names, for the same
  //    reason.
  for (const e of EXCLUDED) {
    if (!files.includes(e.file)) {
      problems.push(
        `\`${e.file}\` is EXCLUDED from this sweep and does not exist under web/src — the ` +
          `exclusion is stale, so its reason ("${e.why}") is being applied to nothing. If the ` +
          'file was renamed, the new name is UNSWEPT until this row is repointed.'
      );
    }
  }

  return problems;
}

/** The scope this run actually swept. */
const SWEPT = discoverSources().filter(
  (f) => !isGeneratedDeclaration(f) && !EXCLUDED.some((e) => e.file === f)
);

/**
 * Leg 2. Whole word or hyphen-joined, so `spreadsheet`, `sheet_id` and
 * `below_sheet` do not match — those are §0 identifiers and are not defects.
 */
const NEEDLE =
  /(?<![A-Za-z0-9_])(sheet|sheets|sheet's|Sheet|Sheets|SHEET|bed|beds|Bed|BED)(?![A-Za-z0-9_])/g;

/**
 * Leg 3. Each row is scoped to the narrowest pattern that earns it, with the
 * canon clause it comes from. An exception granted to a NAME leaks to
 * everything that name covers, so none of these is a whole file or a whole rule.
 *
 * ⚠ **WIDENING THE SCOPE WIDENED THESE ROWS' REACH.** The rows written before
 * 2026-08-27 carry no `file`, so each now applies to all 63 files rather than
 * the ten it was adjudicated against. That was MEASURED rather than assumed:
 * running the scan over the newly-covered files with the allowlist emptied and
 * then restored moved exactly ONE line — `units.ts:228`, *"invent a sheet size
 * no supplier sells"*, absorbed by the `sheet size` row, which is the same
 * X1/§10a reason that row was granted for. The pre-existing rows are left
 * unpinned so this change does not alter what is asserted about the ten files
 * that were already covered; a later pass may pin them, and the measurement
 * above is what it should re-run first.
 */
interface Allow {
  /** The clause that earns it. A row with no reason is a veto nobody audits. */
  why: string;
  /** Matched against the LINE the needle landed on. */
  re?: RegExp;
  /** Narrows to ONE file. Without it a row reaches every file in the tree. */
  file?: string;
  /**
   * Narrows to ONE needle family, matched against the matched term. This is
   * what lets a catalogue keep `sheet` while `bed` stays armed inside it —
   * `bed` is the word that collapsed the spoilboard and the travel (canon S1)
   * and no exception in this file has ever been worth granting it wholesale.
   */
  term?: RegExp;
  /**
   * Narrows to the byte region between two literal markers — for a data
   * structure whose every row is an instance of one exception, where a
   * per-line pattern would be twenty-five near-identical rows nobody reads.
   * If a marker stops matching the region collapses and the findings come
   * BACK, which is the safe direction; `the region markers still resolve`
   * below turns that into a named failure rather than twenty-five mystery ones.
   */
  within?: [string, string];
}

const ALLOW: Allow[] = [
  // X1 — a purchasable panel product at a supplier. "MDF workpiece 2400 × 1200"
  // would be a claim the source page does not make.
  { why: 'X1 supplier product term: sheet goods', re: /'sheet goods —/ },
  { why: 'X1/§10a: a sheet is a PUBLISHED STOCK SIZE, not the object in the job', re: /a (researched )?sheet size/ },
  { why: 'X1/§10a: the catalogue row kind, beside saved workpieces', re: /'sheet · fit not checked yet'/ },
  { why: 'X1/§10a: the shipped catalogue rows, not the object in the job', re: /the shipped sheets/ },
  // X9 — different words that happen to collide.
  { why: "X9 collision: 3M's 410M DATA sheets", re: /'sheets both timed out/ },
  // X4 / §0 — persistence and wire contracts. Renaming orphans saved stores.
  // (`\w+\??\.kind` covers the parse result under ANY local name — `parsed`,
  // `p` — because `e2a8352c1c` added a `p?.kind === 'sheet'` check that the
  // name-pinned form of this exception did not reach.)
  { why: 'X4 row-id kind, parsed back out of a saved store', re: /(rowId\('sheet'|parseRowId\(|\w+\??\.kind === 'sheet')/ },
  { why: "X4 the Shape union's kind tag, switched on by name", re: /(type Kind =|kind: 'bed',|s\.kind === 'bed')/ },
  { why: 'X4 CSS class name, not prose', re: /(className="(whs|tps)-bed"|^\s*\.(whs|tps)-bed\s)/ },
  { why: 'X4 catalogue id, driven by name from touchplateShape', re: /'bed-datum-no-plate'/ },

  // ═══════════════════════════════════════════════════════════════════════════
  //  ADDED 2026-08-27 WITH THE SCOPE CHANGE. Canon §13d adjudicated none of
  //  these files, so each reason below is a NEW ruling made here — not a canon
  //  clause transcribed. Whoever disagrees is disagreeing with this file.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    why:
      'X1/§10a — inside SHEET_SIZES every `sheet` names a PUBLISHED STOCK SIZE at a named ' +
      'supplier, quoted from the page with its read date. Canon §X1 grants `web/src/materials.ts` ' +
      '(SHEET_SIZES) by name, and "MDF workpiece 2400 × 1200" would be a claim the source page ' +
      'does not make. Scoped to the catalogue REGION and to the `sheet` family only, so `bed` ' +
      'stays armed inside it: no catalogue row has any business saying `bed`, and S1 is the ' +
      'distinction that word destroys.',
    file: 'materials.ts',
    term: /^sheet(s|'s)?$/i,
    within: ['export const SHEET_SIZES', '\n];'],
  },
  {
    why:
      'X1/§10a — UNITS_ABSENT is the register of units this app deliberately does not offer, and ' +
      'its `sheet` is the trade word in "every sheet a supplier quotes". Same reasoning as the ' +
      'catalogue: a supplier quotes sheets, a job holds a workpiece. `bed` stays armed.',
    file: 'units.ts',
    term: /^sheet(s|'s)?$/i,
    within: ['export const UNITS_ABSENT', '\n];'],
  },
  {
    why:
      'X1/§10a — UNITS_NOT_CONVERTED explains why a NOMINAL is not converted, and a nominal is a ' +
      'trade designation for a supplier product ("an 18mm sheet is not 18mm"). Converting it ' +
      'would invent a stock size no supplier sells. `bed` stays armed.',
    file: 'units.ts',
    term: /^sheet(s|'s)?$/i,
    within: ['export const UNITS_NOT_CONVERTED', '\n];'],
  },
  {
    why:
      "X9 collision — OpenSCAD desktop's own Help ▸ Cheat Sheet item, named in the list of that " +
      'application\'s features this tab does NOT implement. It is another product\'s menu label; ' +
      'renaming it would misdescribe the thing the sentence exists to disclaim.',
    file: 'cad/menu.tsx',
    re: /cheat sheet/,
  },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  🔴 REAL FINDINGS THIS TEST FILE CANNOT FIX. **NOT EXCEPTIONS.**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Widening the scope surfaced a defect in a file this change may not edit. The
 * wrong move is an ALLOW row — that would bless it, and an annotation written
 * to kill an alarm becomes a false all-clear. The wrong move is also leaving
 * the suite red, because a red nobody can clear gets skipped and takes every
 * other assertion in the file with it.
 *
 * So it is recorded here with the exact text, the reason it is wrong and the
 * correction, and it is asserted THREE ways below: the line must still be
 * present (a row that stops matching is stale and says so), the scanner must
 * still report it (a row that blesses a non-finding is a fabricated veto), and
 * the register may not grow past its stated ceiling without a deliberate edit.
 *
 * ⚠ **Fixing the source turns this file RED**, on purpose: the row is then
 * stale and the failure message says to delete it. That is the discharge
 * condition. A register with no discharge condition becomes a list of blessings.
 */
const OPEN_DEFECTS: { file: string; term: string; text: string; why: string; fix: string }[] = [
  /* ✅ EMPTY, AND IT HAS BEEN NON-EMPTY EXACTLY ONCE.
   *
   * `cad/record.ts:471` read *"a plausible wrong part with no symptom until it is
   * ON THE BED"* — inside the `detail` of a REFUSAL an operator reads, which is
   * the highest-consequence string surface there is. `bed` is the word canon S1
   * retires: ambiguous between the spoilboard (MATERIAL) and the travel envelope
   * (REACH), and the sentence meant neither. It meant *"until the part has been
   * cut"*, and it now says that.
   *
   * 🔴 THE REGISTER DID ITS JOB IN BOTH DIRECTIONS, WHICH IS THE ONLY REASON IT
   * IS ALLOWED TO EXIST. It held the finding visible instead of blessing it with
   * an ALLOW row, and when the source was fixed it went RED and told whoever
   * fixed it to delete the row — a suppression with no discharge condition is
   * how a known defect becomes a permanent exemption. Kept empty rather than
   * deleted so the mechanism, and the fact that it fired, survive the fix.
   *
   * ⚠ An entry here is a defect somebody has SEEN and not yet fixed. It is not a
   * place to put a string you disagree with the rule about — that is an ALLOW row
   * with a stated reason, and it is adjudicated, not parked. */
];

/** Deliberate ceiling. Adding a second open defect is an edit somebody makes on purpose. */
const OPEN_DEFECT_CEILING = 1;

/** Leg 1. CODE / COMMENT / STRING / JSXTEXT, so identifiers are out by construction. */
function userFacingSpans(src: string): boolean[] {
  const n = src.length;
  const kind = new Array<string>(n).fill('CODE');
  const mark = (a: number, b: number, k: string) => {
    for (let x = a; x < Math.min(b, n); x++) kind[x] = k;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      mark(i, j, 'COMMENT');
      i = j;
      continue;
    }
    if (two === '/*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      mark(i, j, 'COMMENT');
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j += 1;
          break;
        }
        if (src[j] === '\n') break;
        j += 1;
      }
      mark(i, j, 'STRING');
      i = j;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`') {
          j += 1;
          break;
        }
        j += 1;
      }
      mark(i, j, 'STRING');
      i = j;
      continue;
    }
    i += 1;
  }
  // JSX text: a `>…<` run with letters in it and no comment inside. Multi-line
  // runs included deliberately — the audit's own tokenizer missed five findings
  // that were on screen, in a drawing, purely because the run began with a
  // newline. Braces are allowed through so `{' '}` does not end a sentence.
  for (const m of src.matchAll(/>([^<>]{3,}?)</gs)) {
    const a = m.index! + 1;
    const b = a + m[1].length;
    if (!/[A-Za-z]{3}/.test(m[1])) continue;
    let clean = true;
    for (let x = a; x < b; x++) if (kind[x] === 'COMMENT') clean = false;
    if (!clean) continue;
    for (let x = a; x < b; x++) if (kind[x] === 'CODE') kind[x] = 'JSXTEXT';
  }
  return kind.map((k) => k === 'STRING' || k === 'JSXTEXT');
}

interface Finding {
  file: string;
  line: number;
  term: string;
  text: string;
}

/**
 * Does one allowlist row reach this hit?
 *
 * 🔴 A row that carries neither `re` nor `within` would be a WHOLE-FILE
 * blanket, which is the thing leg 3 exists to forbid — so it is refused here
 * rather than trusted to review, and `no ALLOW row is a whole-file blanket`
 * asserts the same thing statically so the refusal cannot be reached by
 * accident and read as "that file is clean".
 */
function allowApplies(a: Allow, file: string, text: string, term: string, off: number, src: string): boolean {
  if (!a.re && !a.within) return false;
  if (a.file && a.file !== file) return false;
  if (a.term && !a.term.test(term)) return false;
  if (a.re && !a.re.test(text)) return false;
  if (a.within) {
    const s = src.indexOf(a.within[0]);
    if (s < 0) return false;
    const e = src.indexOf(a.within[1], s);
    if (e < 0 || off < s || off > e) return false;
  }
  return true;
}

/** The check itself, over arbitrary source so a plant can be run through it. */
function scan(file: string, src: string): Finding[] {
  const live = userFacingSpans(src);
  const lines = src.split('\n');
  const starts: number[] = [];
  let p = 0;
  for (const l of lines) {
    starts.push(p);
    p += l.length + 1;
  }
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: Finding[] = [];
  const seen = new Set<string>();
  NEEDLE.lastIndex = 0;
  for (const m of src.matchAll(NEEDLE)) {
    if (!live[m.index!]) continue;
    const li = lineOf(m.index!);
    const text = lines[li];
    if (ALLOW.some((a) => allowApplies(a, file, text, m[0], m.index!, src))) continue;
    const key = `${li}:${m[0].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line: li + 1, term: m[0], text: text.trim() });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE CHECK
// ═══════════════════════════════════════════════════════════════════════════

const isOpenDefect = (f: Finding) =>
  OPEN_DEFECTS.some((d) => d.file === f.file && d.term === f.term && d.text === f.text);

test('no retired term reaches the operator from ANY source file under web/src', () => {
  const found = SWEPT.flatMap((f) => scan(f, read(f))).filter((f) => !isOpenDefect(f));
  assert.deepEqual(
    found.map((f) => `${f.file}:${f.line} [${f.term}] ${f.text.slice(0, 110)}`),
    [],
    'a retired term is back in a string or JSX text an operator reads'
  );
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LEG 6 — BUILD STEPS EMIT OPERATOR TEXT TOO, AND THIS SWEEP COULD NOT SEE IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔴 THE DEFECT THAT EARNED THIS LEG WAS LIVE ON SCREEN.
 * `web/scripts/build-shop-catalogue.ts` generates the Designs catalogue, and
 * its `kindOf()` wrote **"sheet part — cut on the CNC"** onto TEN cards. `sheet`
 * is retired (canon S1 — the word that collapsed the spoilboard and the
 * travel), the operator was reading it, and the check above reported clean
 * throughout, because its scope was `web/src` and this file is `web/scripts`.
 *
 * Found 2026-09-02 by accident: an unrelated edit tripped the rule INSIDE
 * `web/src`, and chasing that one line is what exposed the ten that no rule
 * could reach. Nothing about the miss was detectable from inside the passing
 * check — which is the property that makes it worth a leg of its own.
 *
 * ⚠ THE GENERAL SHAPE. This file's scope is *"wherever operator-facing strings
 * live"*, and that had been silently equated with one directory. A build step
 * that writes UI text is a source of operator strings wherever it sits, so the
 * scope has to follow the STRINGS. Any future generator under `web/scripts`
 * is covered from the moment it lands, because — like leg 5 — the file list is
 * DISCOVERED, never enumerated.
 *
 * ⚠ IT SHARES THE ALLOWLIST DELIBERATELY. `scan()` applies the same rows, so an
 * exception granted for `web/src` reaches here as well. That is the honest
 * trade: one vocabulary, one set of exceptions. A second allowlist would drift.
 */
test('no retired term reaches the operator from a BUILD STEP under web/scripts', () => {
  const files = discoverSources(SCRIPTS_DIR);
  /* A vacuity counter, because "found nothing" and "swept nothing" are the same
   * empty array. If the directory is renamed or the walker breaks, this fails
   * rather than reporting a clean sweep of zero files. */
  assert.ok(files.length > 0, 'web/scripts holds no .ts files — the sweep swept nothing');
  const found = files
    .flatMap((f) => scan(`scripts/${f}`, readFileSync(join(SCRIPTS_DIR, f), 'utf8')))
    .filter((f) => !isOpenDefect(f));
  assert.deepEqual(
    found.map((f) => `${f.file}:${f.line} [${f.term}] ${f.text.slice(0, 110)}`),
    [],
    'a retired term is back in a string a build step writes onto an operator surface'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
//  LEG 5 — THE SCOPE ITSELF IS CHECKED. Everything above is green over
//  whatever `SWEPT` happens to contain; these say what it must contain.
// ═══════════════════════════════════════════════════════════════════════════

test('the swept scope is DISCOVERED and covers every source file under web/src', () => {
  const all = discoverSources();
  assert.deepEqual(
    coverageProblems(all),
    [],
    'the discovery walker did not return the tree it is supposed to sweep'
  );

  // The set the check above actually ran over, stated: `SWEPT` is `all` minus
  // the generated declarations and minus EXCLUDED, and the difference between
  // the two is the entire uncovered surface of this file within `web/src`.
  const uncovered = all.filter((f) => !SWEPT.includes(f));
  assert.deepEqual(
    uncovered.filter((f) => !isGeneratedDeclaration(f)),
    EXCLUDED.map((e) => e.file).sort(),
    'a file is out of the sweep for a reason that is not written down'
  );
});

test('PLANT: a file the walker fails to find is NAMED, not silently dropped', () => {
  // The failure discovery trades into. A smaller set passes every check over
  // it, so the plant removes ONE file and asserts the guard says which.
  const real = discoverSources();
  assert.deepEqual(coverageProblems(real), [], 'precondition: the real tree is covered');

  const planted = real.filter((f) => f !== 'AuthGate.tsx');
  assert.notEqual(planted.length, real.length, 'the plant did not apply — the check below is vacuous');

  const problems = coverageProblems(planted);
  assert.ok(problems.length > 0, 'a lost file read as a clean sweep');
  assert.ok(
    problems.some((p) => p.includes('AuthGate.tsx') && p.includes('NOT discovered')),
    `the guard went red without naming the lost file: ${problems.join(' | ')}`
  );
});

test('PLANT: a STALE EXCLUSION — a file excluded that no longer exists — goes RED', () => {
  // Asserted against a fabricated row rather than the live `EXCLUDED`, which is
  // empty: a guard that can only be exercised once somebody adds the first
  // exclusion has never been exercised at the moment it starts mattering.
  const real = discoverSources();
  EXCLUDED.push({ file: 'AGateThatWasRenamed.tsx', why: 'a reason that stopped being true' });
  try {
    const problems = coverageProblems(real);
    assert.ok(
      problems.some((p) => p.includes('AGateThatWasRenamed.tsx') && p.includes('stale')),
      `a stale exclusion did not go red: ${problems.join(' | ')}`
    );
  } finally {
    EXCLUDED.pop();
  }
  assert.deepEqual(coverageProblems(real), [], 'the plant leaked out of its own test');
});

test('no ALLOW row is a whole-file or whole-term blanket', () => {
  // Leg 3, mechanised. `allowApplies` refuses such a row at runtime, but a row
  // that is refused matches nothing and reads as an exception that is simply
  // never needed — so it is caught here, where the message says what is wrong.
  for (const a of ALLOW) {
    assert.ok(
      a.re || a.within,
      `an ALLOW row grants an exception with no line or region pattern — it would cover a whole ` +
        `file or the whole tree: ${a.why}`
    );
    assert.ok(a.why.length > 20, `an ALLOW row must carry the clause that earns it, not a label: ${a.why}`);
  }
});

test('the region markers still resolve, and the regions still hold the rows they exempt', () => {
  // A `within` row whose marker has been renamed collapses to nothing and the
  // findings come back — the safe direction, but as twenty-five unexplained
  // failures. This turns that into one sentence naming the marker.
  for (const a of ALLOW) {
    if (!a.within) continue;
    assert.ok(a.file, `a region exception must name its file: ${a.why}`);
    const src = read(a.file!);
    const s = src.indexOf(a.within[0]);
    assert.ok(
      s >= 0,
      `the region marker \`${a.within[0]}\` no longer exists in ${a.file} — this exception now ` +
        'covers nothing. Repoint it; do not widen it.'
    );
    assert.ok(
      src.indexOf(a.within[1], s) > s,
      `the region opened by \`${a.within[0]}\` in ${a.file} has no end marker \`${a.within[1]}\``
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE OPEN-DEFECT REGISTER — a defect this file may not fix, kept loud.
// ═══════════════════════════════════════════════════════════════════════════

test('every OPEN_DEFECT is still a real, still-present finding', () => {
  assert.ok(
    OPEN_DEFECTS.length <= OPEN_DEFECT_CEILING,
    `the open-defect register has grown to ${OPEN_DEFECTS.length}. It is a SHRINKING list of ` +
      'source strings a test file could not edit, not a place to park findings. Raising the ' +
      'ceiling is a decision somebody makes on purpose and says why.'
  );

  for (const d of OPEN_DEFECTS) {
    assert.ok(SWEPT.includes(d.file), `OPEN_DEFECTS names ${d.file}, which this sweep does not cover`);

    // ① Still present. If it is gone the fix landed — delete the row.
    assert.ok(
      read(d.file).includes(d.text),
      `the OPEN_DEFECT line in ${d.file} is gone: ${d.fix}. If the fix landed, DELETE this row — ` +
        'this red is its discharge condition, not a regression. If the line merely moved, ' +
        're-adjudicate it rather than repointing the text, because the words may have changed too.'
    );

    // ② Still a finding. A row that suppresses something the scanner would not
    //    report is a fabricated veto: it would hide the next real defect on
    //    that line and nothing would ever question it.
    const raw = scan(d.file, read(d.file));
    assert.ok(
      raw.some((f) => f.term === d.term && f.text === d.text),
      `OPEN_DEFECTS suppresses a finding the scanner does not produce in ${d.file} — the row is ` +
        'blessing nothing, and it is line-granular, so it would hide a real defect landing beside it'
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LEG 4 — THE NEGATIVE CONTROLS. A green nobody has watched go red is not a
//  green. Each plant is applied to a COPY of the source in memory; nothing is
//  written to the tree.
// ═══════════════════════════════════════════════════════════════════════════

test('PLANT: the founder’s own sentence, put back into the axes note, goes RED', () => {
  const clean = read('Viewport.tsx');
  assert.equal(scan('Viewport.tsx', clean).length, 0, 'precondition: the file is clean');

  const planted = clean.replace(
    "text: 'Axes — the workpiece is laid square,",
    "text: 'Axes — the sheet is laid square,"
  );
  assert.notEqual(planted, clean, 'the plant did not apply — the check below would be vacuous');

  // Asserted as a DELTA against the clean file, not as `length === 1`: an
  // unrelated real defect elsewhere in the file must make the CHECK red, not
  // this control, or one regression prints two failures and neither explains it.
  const found = scan('Viewport.tsx', planted);
  assert.equal(found.length - scan('Viewport.tsx', clean).length, 1, 'the plant did not go red');
  assert.ok(
    found.some((f) => /Axes — the sheet is laid square/.test(f.text)),
    'the plant went red on something other than the planted line'
  );
});

test('PLANT: a retired term inside a REFUSAL — the highest-consequence surface — goes RED', () => {
  // `label` is display text interpolated into `🔴 OVERLAPS ${label} — cutting
  // one destroys the other`. It did not look like a sentence, which is why it
  // survived every earlier pass and why canon wrongly exempted its sibling.
  const clean = read('Viewport.tsx');
  const planted = clean.replace("out.push({ label: 'workpiece',", "out.push({ label: 'sheet',");
  assert.notEqual(planted, clean, 'the plant did not apply');
  const found = scan('Viewport.tsx', planted);
  assert.equal(
    found.length - scan('Viewport.tsx', clean).length,
    1,
    'a bare word constant feeding a refusal did not go red'
  );
  assert.ok(found.some((f) => /label: 'sheet'/.test(f.text)));
});

test('PLANT: a JSX checkbox label, on its own line, goes RED', () => {
  // Multi-line JSX text is the gap the 2026-08-11 audit's own tokenizer had:
  // five findings that were on screen were missed purely because the `>…<` run
  // started with a newline. This asserts that gap is closed here.
  const clean = read('App.tsx');
  const planted = clean.replace(
    '              I have checked the machine is clear\n',
    '              I have checked the bed is clear\n'
  );
  assert.notEqual(planted, clean, 'the plant did not apply');
  const found = scan('App.tsx', planted);
  assert.equal(found.length - scan('App.tsx', clean).length, 1, 'a bare JSX text node did not go red');
  assert.ok(found.some((f) => /I have checked the bed is clear/.test(f.text)));
});

// ⚠ A plant proves SENSITIVITY only. Without these, the cheapest way to make
// the check pass is to ban the exceptions — and it would look like a fix.
test('POSITIVE CONTROL: the X1 supplier terms and the X4 identifiers stay GREEN', () => {
  const cases: [string, string][] = [
    ['workholding.ts', "'sheet goods — but note that its hold is proportional to sealed area, and ' +"],
    ['App.tsx', "  ? `a researched sheet size, read ${s.source.read}`"],
    ['App.tsx', "  id: rowId('sheet', s.id),"],
    ['workholdingShape.tsx', "  kind: 'bed',"],
    ['touchplates.ts', "  id: 'bed-datum-no-plate',"],
    ['workholdingShape.tsx', '  <line className="whs-bed" x1={X0} y1={BED_Y} x2={X1} y2={BED_Y} />'],
  ];
  for (const [file, line] of cases) {
    assert.equal(
      scan(file, `const x = 1;\n${line}\n`).length,
      0,
      `an exception that canon grants was reported as a defect: ${line.trim()}`
    );
  }
});

test('POSITIVE CONTROL: a pure identifier is out of scope by construction', () => {
  // §0. `Stock`, `sheet_id`, `below_sheet` and `panel-stock` are wire and test
  // contracts. Renaming one to improve a WORD silently breaks a THING.
  const code = 'const sheet_id = 1;\nconst below_sheet = sheet_id;\ntype T = BelowSheet;\n';
  assert.equal(scan('x.ts', code).length, 0, 'the check reached into identifiers');
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE CANON EXEMPTION THAT WAS WRONG
//
//  `docs/terminology.md` exempted `publishSnap('sheet', …)` as *"an identifier
//  — do not move"*. It is not: the argument is interpolated into
//  `${what} snapped: …` and published to the UI. A wrong exemption is the one
//  error that compounds — it survives every future sweep and gets quoted back
//  as authority — so it is guarded here rather than only corrected.
// ═══════════════════════════════════════════════════════════════════════════

const CANON = readFileSync(docPath('terminology.md'), 'utf8');

/** The claim that must never come back, in the shape it was written in. */
const WRONG_EXEMPTION = /snap key `publishSnap\('sheet', …\)`[^]{0,60}\*\*identifiers — do not move\*\*/;

test('the corrected canon exemption is not reverted', () => {
  assert.equal(
    WRONG_EXEMPTION.test(CANON),
    false,
    "terminology.md exempts publishSnap('sheet', …) as an identifier again — it is display text"
  );
  assert.match(
    CANON,
    /CORRECTED 2026-08-11[^]{0,400}exemption was WRONG/,
    'the correction, and the reason it was wrong, must stay in canon — a deleted exemption is ' +
      'indistinguishable from one that was never written, and the next sweep re-grants it'
  );
});

test('PLANT: restoring the wrong exemption goes RED', () => {
  const planted =
    CANON +
    "\n\n- `web/src/Viewport.tsx` — the snap key `publishSnap('sheet', …)` at `2913` are\n" +
    '  **identifiers — do not move**\n';
  assert.equal(WRONG_EXEMPTION.test(planted), true, 'the guard cannot see the claim it exists for');
});

test('the call site canon wrongly exempted is display text, and says so', () => {
  const vp = read('Viewport.tsx');
  assert.match(vp, /publishSnap\('workpiece', out\)/, 'the snap label is a retired term again');
  assert.match(
    vp,
    /publishSnap\(`clamp \$\{c\?\.name \?\? draggingClamp\.index\}`, out\)/,
    'the sibling call site no longer passes a human phrase — the evidence that the first ' +
      'argument is a LABEL rather than a key'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE store.ts CONTRADICTION
//
//  The `case 'drawings'` header claimed a bad entry is *"DROPPED BY NAME rather
//  than taking the whole list with it"*. Every `return null` under it takes the
//  whole key. `whyDropped` and the `DrawingOrigin` doc both said so correctly,
//  so the comment was the odd one out — and it is the artefact a reader trusts.
//  The per-entry rule is real, one layer up, in `App.tsx`'s restore loop.
// ═══════════════════════════════════════════════════════════════════════════

test('store.ts `drawings` is all-or-nothing, and the comment beside it says so', () => {
  const store = read('store.ts');
  const start = store.indexOf("case 'drawings': {");
  assert.ok(start > 0, 'the drawings case moved — this guard is now blind, not green');
  const body = store.slice(start, store.indexOf("\n    }\n", start));

  // The BEHAVIOUR: every failure path takes the whole key.
  assert.ok(
    (body.match(/return null;/g) ?? []).length >= 6,
    'the all-or-nothing failure paths are gone — if that was deliberate, the comment and ' +
      '`whyDropped` have to move with it'
  );

  // The COMMENT must not claim the other layer's rule.
  assert.equal(
    /DROPPED BY NAME rather than taking the\s*\/\/\s*whole list with it/.test(body),
    false,
    'the header claims per-entry dropping while the code returns null for the whole key'
  );
  assert.match(body, /ALL OR NOTHING/, 'the header no longer states the rule the code implements');

  // And the operator-facing text has to keep agreeing with both.
  assert.match(
    store,
    /NOTHING from it was restored/,
    'whyDropped stopped telling the operator the whole list went'
  );
});

test('PLANT: restoring the store.ts contradiction goes RED', () => {
  const body =
    "case 'drawings': {\n" +
    '      // 🔴 PER ENTRY, and a bad entry is DROPPED BY NAME rather than taking the\n' +
    '      // whole list with it.\n' +
    '      if (!Array.isArray(v)) return null;\n';
  assert.equal(
    /DROPPED BY NAME rather than taking the\s*\/\/\s*whole list with it/.test(body),
    true,
    'the guard cannot see the contradiction it exists for'
  );
});

test('the per-entry rule really does live in App.tsx’s restore loop', () => {
  // Asserted rather than assumed: the corrected store.ts comment now POINTS at
  // this loop, and a comment that points at something that is not there is the
  // same defect one level down.
  const app = read('App.tsx');
  const start = app.indexOf('const refs = RESTORED.values.drawings;');
  assert.ok(start > 0, 'the restore loop moved — the corrected comment now points at nothing');
  const loop = app.slice(start, start + 6000);
  assert.match(loop, /A FAILURE DROPS ONE ENTRY BY NAME/);
  assert.ok(
    (loop.match(/fail\(`the /g) ?? []).length >= 2 && loop.includes('continue;'),
    'the loop no longer drops one entry and continues'
  );
});
