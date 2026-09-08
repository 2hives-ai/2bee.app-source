/**
 * Readers for an emitted G-code program, shared by the specs in this directory.
 *
 * 🔴 A MODULE, NOT A SPEC, AND THAT IS THE POINT. This reader used to live
 * inside `slicer.spec.ts`, where nothing could test it: a spec file that
 * imports another spec file registers that file's tests a second time, so the
 * only way to put a reader under test is to take it out of a spec. It was
 * moved on 2026-08-11 after it was found silently truncating part names — see
 * `coordsByPart` — and `gcode-reader.spec.ts` is the test it could not have.
 */

/**
 * The banner comment that opens an operation's moves, as `core` writes it.
 *
 * 🔴 THE FORMAT IS OWNED BY `core/src/toolpath.rs::banner`, which emits
 * `<prefix><op name> [<tool name>]`, and `core/src/post_grblhal.rs` wraps every
 * comment as `( … )`. Both halves are asserted here — the leading `( ` and the
 * trailing ` )` — because the closing paren is what makes the tool bracket
 * findable from the RIGHT. `(` and `)` inside a name are sanitised to `_` by
 * the post before it writes them, so a program line carries exactly one pair.
 *
 * `mark:` has no producer in `core` today. It is accepted because the Rust-side
 * reader (`core/src/fixtures.rs::by_part`) accepts it, and a reader that is
 * narrower than the gate's is a reader that goes quiet first.
 */
const BANNER = /^\(\s*(?:op|drill|mark):\s*(.+?)\s*\)$/;

/**
 * The part a banner names, with the tool and any `-holeN` suffix removed.
 *
 * 🔴 THE NAME ENDS AT THE **LAST** ` [`, NOT AT THE FIRST SPACE. A drawing's id
 * is a name a person chose — `Hive super end` — so an operation is routinely
 * `( op: Hive super end/part1 [End Mill - Down-cut 6mm 2F] )`. Until 2026-08-11
 * this took `(\S+)` and read that as a part called `Hive`: a lookup for the
 * real name then MISSED, and a miss in a test helper reads as the app having
 * failed to emit the part. Measured, not reasoned about — the producer emits
 * the banner above for `2bee-slice nest --id "Hive super end"`.
 *
 * ⚠ AND THE LAST BRACKET, NOT THE FIRST, for the reason `toolpath.rs::banner`
 * gives in its own header: a part called `bracket [v2]` is a real name, and the
 * producer accepts it — `( drill: bracket [v2]/part1-hole1 [End Mill …] )` is a
 * program this CLI emits today. Taking the first `[` would name that part
 * `bracket`, which is the same defect one character along, and widening to a
 * greedy `(.+)` over the whole line would swallow the tool instead. Both fail
 * silently and both look identical from a test's side.
 *
 * ⚠ `-holeN` is folded away because the post names a hole after the part it is
 * in (`toolpath.rs`: `format!("{}-hole{}", part.name, i + 1)`), and a test
 * asking "did THIS drawing move" wants the drawing.
 *
 * ⚠ The one place this deliberately differs from the Rust reader
 * (`fixtures.rs::by_part`) is the hole fold: that one splits on the first
 * `-hole` anywhere, this one strips `-holeN` only at the END, which is where
 * the producer puts it. On any program `core` can emit the two agree; on a part
 * a person named `corner-hole-jig` only this one is right.
 */
function partOfBanner(inner: string): string {
  const open = inner.lastIndexOf(' [');
  const name = (open === -1 ? inner : inner.slice(0, open)).trimEnd();
  return name.replace(/-hole\d+$/, '');
}

/** A part named by a banner, or one positioned move under whichever part is open. */
export type ProgramEvent =
  | { kind: 'part'; part: string }
  | { kind: 'move'; part: string | null; x: number; y: number };

/**
 * 🔴 **THE ONE XY SCANNER. There were THREE.**
 *
 * `slicer.spec.ts` carried two more of this loop written out by hand — one
 * inside the drag test, one inside the rotation test — and the file's own
 * comment above them claimed the multi-drawing assertions read through *"ONE
 * reader"*. That was true of {@link coordsByPart} from 2026-08-11 and false of
 * the scanner underneath it on the same day.
 *
 * ⚠ **The argument for consolidating is not tidiness, it is the one
 * `39ca45c288` already paid for.** The part reader was broken — it stopped a
 * part name at the first space — *because nothing watched it*, and a helper
 * living inside a spec file cannot be watched: importing a spec registers its
 * tests a second time, so there is no file a test could live in. The scanner is
 * the layer BELOW that reader: a drag test and a rotation test both assert on
 * emitted positions, and if this loop miscounts, both fail for a reason that is
 * not the app's, in a suite where ~17 tests fail environmentally anyway.
 *
 * The rules it encodes, all measured against what `post_grblhal.rs` emits:
 *
 * - **A word is `X`/`Y` followed by a number and nothing else.** `G1`, `F800`
 *   and `Z-3.5` are not positions; a looser match reads a feed rate as an X.
 * - **X and Y are MODAL and persist across lines**, including across a banner.
 *   The post omits an axis whose value has not changed, so a line reading `Y40`
 *   alone is a move to the last X — dropping it would silently thin the sample.
 * - **A move is only reported once BOTH axes are known.** A program's first
 *   positioned move can carry one axis; there is no position yet, and inventing
 *   a `0` for the other is how a phantom point at the origin gets into a span.
 * - **Comments are skipped, banners are events.** A banner is a comment, so
 *   order matters here: match it first or it is thrown away as a comment.
 */
export function* readProgram(g: string): Generator<ProgramEvent> {
  let part: string | null = null;
  let x: number | null = null;
  let y: number | null = null;
  for (const line of g.split('\n')) {
    const t = line.trim();
    const c = BANNER.exec(t);
    if (c) {
      part = partOfBanner(c[1]);
      yield { kind: 'part', part };
      continue;
    }
    if (!t || t.startsWith('(')) continue;
    let moved = false;
    for (const w of t.split(/\s+/)) {
      const m = /^([XY])(-?\d+(?:\.\d+)?)$/.exec(w);
      if (!m) continue;
      if (m[1] === 'X') x = Number(m[2]);
      else y = Number(m[2]);
      moved = true;
    }
    if (moved && x !== null && y !== null) yield { kind: 'move', part, x, y };
  }
}

/**
 * Every positioned move in the program, in emission order, ignoring which part
 * it belongs to.
 *
 * This is what a single-drawing assertion wants: "the whole program moved by
 * exactly `dx,dy`" is a statement about the points, not about their parts.
 * ⚠ It counts moves that arrive BEFORE any banner, which {@link coordsByPart}
 * cannot attribute and therefore drops — so the two lengths are allowed to
 * differ and neither is wrong.
 */
export function coords(g: string): [number, number][] {
  const out: [number, number][] = [];
  for (const e of readProgram(g)) if (e.kind === 'move') out.push([e.x, e.y]);
  return out;
}

/**
 * The bounding span of the emitted moves: how many, how wide, how tall.
 *
 * 🔴 Read from the PROGRAM, never from the picture. A quarter turn applied to
 * the render alone leaves `w` and `h` exactly as they were and the viewport
 * looks perfect — which is the failure this measurement exists to catch.
 *
 * 🔴 **`w`/`h` are `NaN` on a program with no positioned moves, and the `NaN` is
 * WRITTEN rather than inherited.** Left to itself this returns `Math.max() -
 * Math.min()` = `-Infinity - Infinity` = **`-Infinity`** — measured, after this
 * header first claimed `NaN` and the negative control in `gcode-reader.spec.ts`
 * said otherwise. That difference is the whole point of forcing it: `-Infinity`
 * **satisfies** `expect(w).toBeLessThan(...)` and `toBeCloseTo` on a small
 * target, so an empty program would pass a caller's tolerance check as though
 * it were a very good result. `NaN` fails every comparison there is, which is
 * the only honest answer to "how wide is a program that does not exist".
 * A `0` would be worse still — it reads as "a part with no size".
 */
export function spanOf(g: string): { n: number; w: number; h: number } {
  const pts = coords(g);
  if (pts.length === 0) return { n: 0, w: NaN, h: NaN };
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  return {
    n: pts.length,
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Per-part XY coordinates out of an emitted program, keyed by the part name the
 * post writes on its own section headers — the only place the G-code names a
 * part at all.
 *
 * A part with a banner and no moves after it still gets an entry, so "the
 * program never named this part" and "the program named it and cut nothing"
 * stay separable at the call site.
 */
export function coordsByPart(g: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const e of readProgram(g)) {
    if (e.kind === 'part') {
      if (!out.has(e.part)) out.set(e.part, []);
    } else if (e.part !== null) {
      out.get(e.part)!.push([e.x, e.y]);
    }
  }
  return out;
}
