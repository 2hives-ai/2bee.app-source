// To-scale schematics for the workholding catalogue — one per entry in
// `workholding.ts`, keyed by `id`.
//
// 🔴 WHY THESE ARE DRAWN AND NOT PHOTOGRAPHED. A manufacturer's product
// photograph is copyrighted. This lane is AGPL-3.0-or-later, its output is
// distributed, and §13 offers the source to every user — so a Rockler or
// Schmalz product shot committed here would make the distribution infringing.
// "It was on their website" is not a licence. An image is a dependency with no
// compiler to catch it, and this lane licence-checks its dependencies.
//
// Drawing them is also the BETTER answer, not merely the lawful one. A product
// photo shows a nice render of an object on a white background and hides both
// numbers a CAM system needs: how much of the sheet it eats, and how far above
// the bed the cutter must clear. Those are exactly the fields the catalogue
// records, so those are what the picture shows.
//
// ---------------------------------------------------------------------------
// EVERYTHING IS IN MILLIMETRES. The SVG user unit IS one millimetre — the
// viewBox is 200 x 194 mm of real bed — so no drawing can quietly be off-scale.
// Every panel uses the SAME scale, which is the whole point: a 50 mm vacuum pod
// and a 0.13 mm strip of tape must be comparable at a glance, and they are only
// comparable if nothing was enlarged "so you can see it".
//
// Consequence, stated rather than fixed: 0.13 mm tape renders THINNER THAN THE
// STROKE USED TO OUTLINE IT. That is not a bug in the drawing, it is the fact.
// Tape is labelled with a leader instead of being fattened up.
//
// ---------------------------------------------------------------------------
// 🔴 THE ONE THING THESE DRAWINGS EXIST TO SEPARATE.
//
// `workholding.ts` warns that `obstructs: false` is at least three different
// facts and the boolean cannot hold them. A picture can. There are six `kind`s
// below and four of them are the shades of "does not obstruct":
//
//   'under'   A vacuum pod is an obstruction UNDER the stock. The sheet sits ON
//             it. A rapid over it is completely safe and a through-cut destroys
//             it. It eats NO sheet area. Drawn with the stock LIFTED off the
//             bed and the pod beneath it — the opposite arrangement to
//             everything else in this file.
//   'film'    Tape is 0.13 mm of something. Drawn at true scale, i.e. as a line
//             you cannot see, between stock and bed.
//   'through' A screw or a composite nail is full-depth, below the stock top,
//             and nothing stands above the bed. Screws are steel and a strike
//             breaks the cutter; composite nails are MEANT to be cut through.
//             Same geometry, opposite verdict — so they are drawn in the same
//             kind and coloured oppositely (`cuttable`).
//   'bed'     A vacuum table or a dog-hole grid: nothing is there at all.
//
// If those four looked alike, the drawing would repeat the modelling defect the
// research found. They do not look alike, deliberately.
//
// The remaining two:
//   'proud'   Stands on the bed, reaches over the sheet edge, eats sheet area
//             and forces rapid clearance. The ordinary case.
//   'tool'    Travels with the spindle. Not a bed feature at all, so it has no
//             fixed x/y and cannot be a `Clamp`.
//
// ---------------------------------------------------------------------------
// COLOUR comes from the app's CSS custom properties and nowhere else — there is
// not one hex literal in this file (gate G-THEME). `var()` does NOT resolve in
// an SVG presentation attribute in any shipping browser, so the classes below
// are defined in a scoped <style> and every class name is `whs-`-prefixed so it
// cannot collide with the page.
//
//   --line    bed, spoilboard, frame, dimension lines
//   --muted   the stock itself, and captions
//   --ink     the device body — the thing you would bolt down
//   --accent  the hold, and "this may be cut on purpose"
//   --warn    the danger: steel in the path, clearance the cutter must make
//
// This module renders; it does not decide. Nothing here reads or writes app
// state, and it is deliberately importable without touching the panel.

import type { ReactElement } from 'react';
import { WORKHOLDING } from './workholding';

// -- the sheet of mm this drawing is a window onto ---------------------------

const VB_W = 200;
const VB_H = 194;

/** Plan panel: a top-down window on the bed. */
const PLAN_TOP = 14;
const PLAN_BOT = 72;

/** Side panel: bed surface, and the ceiling the drawing may not exceed.
 *  80 mm of headroom, which the 50 mm pod + 18 mm sheet needs all of. */
const BED_Y = 168;
const SIDE_TOP = 88;

/** Left/right margins, in mm of bed. */
const X0 = 6;
const X1 = 194;

/** Where the stock's edge is. Bed to the left of it, sheet to the right. */
const SHEET_X = 78;

/** The stock this lane cuts. 18 mm ply — the thickness every datum note in
 *  `workholding.ts` converts against. */
const STOCK_MM = 18;

/**
 * The margin `Fixturing::clearance_z` adds on top of the clamp, in mm.
 *
 * 🔴 THIS PANEL PRINTED THE THRESHOLD 2 mm SHORT UNTIL 2026-08-28, and short is
 * the dangerous direction. `core/src/fixture.rs`'s `clearance_z` is
 * `safe_z.max((tallest − stock).max(0) + 2)`; the leader here printed only
 * `height − stock`, so the tallest clamp in the catalogue drew **24.4 mm** where
 * the check enforces **26.4**. An operator who read the picture and set
 * `Safe Z` to the number on it gets a `RapidBelowClamp` refusal on a value they
 * had just been told was enough — which reads as the software being wrong about
 * a number the software drew.
 *
 * ⚠ AND IT IS STILL NOT THE WHOLE ANSWER, so the caption may not claim to be.
 * `clearance_z` takes the TALLEST clamp in the whole fixture and floors the
 * result at the machine's `safe_z_mm` — neither of which a per-device schematic
 * can know. What this leader states is THIS DEVICE'S OWN DEMAND. The real
 * threshold is that or the machine's safe Z, whichever is greater, over every
 * clamp declared.
 *
 * ⚠ A HAND-COPIED CONSTANT IS THE DEFECT THIS FILE JUST REMOVED FROM ITS
 * GEOMETRY, so it is named rather than inlined and it is stated where it comes
 * from — and it is the last one. It is not reachable from the wasm boundary
 * today; if `clearance_z`'s margin ever moves, this is the copy that will not.
 */
const CLEARANCE_MARGIN_MM = 2;

/** Vertical centre of the plan panel, for devices drawn on the edge. */
const PLAN_MID = (PLAN_TOP + PLAN_BOT) / 2;

// -- what a drawing needs to know -------------------------------------------

type Kind = 'proud' | 'under' | 'film' | 'through' | 'bed' | 'tool';

interface ShapeSpec {
  kind: Kind;
  /**
   * 🔴 THE DRAWN FOOTPRINT, AND IT MAY ONLY DIFFER FROM THE KEEPOUT ON A
   * DEVICE THAT OBSTRUCTS NOTHING.
   *
   * `Workholding.footprintMm` is the **keepout** the core checks a toolpath
   * against. For tape it is `[0, 0]` — correct, because tape is under the work
   * and a cutter never has to avoid it — but a picture of a zero-by-zero strip
   * shows the operator nothing. Those two entries, and only those, declare what
   * to DRAW here, with the reason beside it.
   *
   * Any entry with `obstructs: true` is refused this override by
   * `web/tests/workholding-drawing.test.ts`: on an obstructing device the
   * picture and the keepout are answers to the SAME question, and a device that
   * a cutter must avoid may not be drawn at a size the check does not use.
   */
  drawnFootprintMm?: [number, number];
  /** Required with {@link drawnFootprintMm}. An override with no stated reason
   *  is indistinguishable from the drift this replaced. */
  drawnFootprintWhy?: string;
  /** How far the body reaches ONTO the sheet, mm. This is the number that
   *  costs usable area, and almost nobody publishes it. */
  intrusionMm?: number;
  /** 'through' only: a cutter may pass through this by design. */
  cuttable?: boolean;
  /** 'through' only: total fastener length, mm. What is left after the 18 mm of
   *  ply is what is sitting in the spoilboard, where the surfacing pass goes. */
  depthMm?: number;
  /** 'bed' only: draw a hole grid at this pitch instead of a vacuum field. */
  gridPitchMm?: number;
  /** 'bed' only: does the bed itself hold anything? A dog-hole grid does not. */
  holds?: boolean;
  /** One line under the drawing. The number the picture is making the case for. */
  caption: string;
  /** Optional second line, in --warn, for the thing that bites. */
  warn?: string;
}

/** A {@link ShapeSpec} with its geometry resolved from the catalogue. */
interface Shape extends ShapeSpec {
  /** Above the bed, mm. TAKEN FROM `Workholding.heightMm`, never restated. */
  heightMm: number;
  /** Plan footprint [across the sheet edge, along it], mm. */
  footprintMm: [number, number];
}

// -- what to DRAW, keyed exactly as `workholding.ts` ids ---------------------
//
// 🔴 THE GEOMETRY IS NO LONGER HERE. It is read from `workholding.ts` at
// {@link shapeFor}, and this table carries only what a PICTURE needs and the
// catalogue does not have: which elevation to draw, how far the body reaches
// onto the sheet, the caption, the warning.
//
// ⚠ THIS HEADER USED TO SAY: *"Every number here is the number in
// `workholding.ts`, or is derived from it in the comment."* **It was false, and
// it was the sentence that stopped the next reader checking.** Measured
// 2026-08-27 by parsing both tables — 19 ids on each side, three disagreed:
//
//   machinable-low-profile-clamp  catalogue [25.4, 18.0]  drawing [18, 25.4]  AXES SWAPPED
//     ↳ RESOLVED 2026-08-31 in the DRAWING's favour (`bom`, raw vendor table):
//       18.0 across the clamped edge, 25.4 along it. The catalogue was
//       transposed, and deriving the drawing from it had quietly adopted the
//       wrong number — see the note in `App.tsx`'s picker.
//   double-sided-tape             catalogue 0.13mm/[0,0]  drawing 0.127mm/[19.05,120]
//   tape-and-ca-glue              catalogue [0, 0]        drawing [24, 120]
//
// `App.tsx`'s picker comment asserted the same thing in stronger words — *"the
// schematic beside each is drawn to scale from the SAME numbers, so a picture
// and a keepout cannot disagree"* — while one of them was a steel clamp at
// 43 RC drawn with its axes transposed against the box gate `P7` clears a
// toolpath against. **A picture asserts harder than a struct**, and nothing
// read either copy: `workholding` appears nowhere in `gates/`.
//
// ⚠ AND THE PROSE IS THE OTHER HALF, corrected 2026-08-27 in the same pass that
// caught a doc saying the same thing. Two `warn` captions here read *"it demands
// 34 mm on every rapid"* / *"9 mm on every rapid"* — the retracted claim, in an
// OPERATOR-FACING string rather than a comment. `clearance_z` does not raise a
// rapid: the consequence is a **REFUSED PROGRAM**, scoped to the rapids that
// actually cross that footprint. An operator reading "every rapid" concludes the
// pod lifts the whole job's clearance and either avoids declaring one or mutes
// the finding. `workholding.ts` carries the correction and the reason it was
// believable, and `docs/workholding-research.md` said it three more times.
//
// ⚠ AND ONE CAPTION RESTATED A NUMBER THE DRAWING NOW DERIVES. `double-sided-tape`
// read *"Drawn to scale: 0.127 mm"* while `Film()` prints `${s.heightMm} mm` from
// the catalogue (`0.13`) on a leader in the SAME PANEL — one picture, two
// thicknesses for one tape, and `0.127` is the exact drift this file was rewritten
// to remove. 🔴 **The five tests below cannot see it: none of them reads `caption`
// or `warn`.** A number in prose beside a number that is derived is the same defect
// the derivation fixed, one field along, and it is why these strings should not
// carry figures the drawing already prints.
//
// The lane had already solved this one file along and the reasoning is quoted
// here so it is not solved differently a third time — `touchplateShape.tsx`:
// *"Deliberately derived rather than hand-keyed in a second table: a catalogue
// correction that did not reach the drawing would leave a picture asserting the
// old number."* That file imports its catalogue. This one now does too.

const SHAPES: Record<string, ShapeSpec> = {
  'toggle-clamp-vertical': {
    kind: 'proud',
    intrusionMm: 40,
    caption: '42.4 mm above the spoilboard — taller than every clamp here, though not than the T-track and pod entries.',
    warn: 'The rapids that cross it must clear it, or the program is REFUSED. Default safe Z is 5 mm.',
  },
  'toggle-clamp-horizontal': {
    kind: 'proud',
    intrusionMm: 30,
    caption: 'Clearance under the arm is 16.5 mm.',
    warn: 'The stock is 18 mm. It will not close over this workpiece.',
  },
  'edge-clamp-low-profile': {
    kind: 'proud',
    intrusionMm: 5.8, // published, and the only published intrusion anywhere
    caption: '5.6 mm above the material + 18 mm ply = 23.6 mm above the spoilboard.',
    warn: 'Eats 5.8 mm of workpiece per clamped edge — a published number.',
  },
  'machinable-low-profile-clamp': {
    kind: 'proud',
    intrusionMm: 4,
    caption: '6.35 mm above the spoilboard — a tenth of a toggle clamp, and it pulls DOWN.',
    warn: 'Steel at 43 RC. "Machinable" means by a mill, not by a router bit.',
  },
  't-track-hold-down-cnc': {
    kind: 'proud',
    intrusionMm: 22,
    caption: '60 mm — the only T-track hold-down height any vendor publishes.',
    warn: 'Aluminium alloy: a strike takes the cutter, the clamp and the part.',
  },
  'hot-glue-bead': {
    kind: 'proud',
    intrusionMm: 3,
    caption: 'A fillet where the part edge meets the spoilboard. Every number is a stand-in.',
    warn: 'It sits where the profile pass runs: the perimeter, at full depth.',
  },
  't-track-hold-down': {
    kind: 'proud',
    intrusionMm: 45,
    caption: '55 mm is a STAND-IN — no vendor publishes this height.',
    warn: 'The steel T-bolt is what a cutter actually meets, not the plastic arm.',
  },
  'inline-cam-clamp': {
    kind: 'proud',
    intrusionMm: 0, // sits off the sheet entirely, pushing against its edge
    caption: 'Sits beside the workpiece and pushes. Total cam throw: 1.6 mm.',
    warn: 'Resists nothing in Z. Stock 2 mm undersize is loose and looks clamped.',
  },
  'fence-and-side-pressure': {
    kind: 'proud',
    intrusionMm: 0,
    caption: 'Must be THINNER than the stock, or the cutter finds it. Both are stand-ins.',
    warn: 'Resists lateral only, and bowed stock defeats it entirely.',
  },
  'vacuum-pod-console': {
    kind: 'under',
    caption: 'The workpiece sits ON it. 50 mm of obstruction UNDER the workpiece, none beside it.',
    warn: 'Entered as a clamp it demands 34 mm of clearance on the rapids that cross it, and REFUSES the program — a false red.',
  },
  'vacuum-block-low-profile': {
    kind: 'under',
    caption: 'Same arrangement as the pod, half the height: 25 mm, under the workpiece.',
    warn: 'A smaller false red is still a false red: 9 mm demanded on the rapids that cross it.',
  },
  'vacuum-table-full': {
    kind: 'bed',
    holds: true,
    caption: 'The only entry that genuinely puts NOTHING above the spoilboard.',
    warn: 'Hold is proportional to sealed area, and the cut destroys the seal.',
  },
  'double-sided-tape': {
    kind: 'film',
    drawnFootprintMm: [19.05, 120],
    drawnFootprintWhy:
      'the catalogue keepout is [0, 0] because tape sits UNDER the work and a cutter never avoids it. A zero-by-zero strip draws nothing, so the picture uses the physical tape: 19.05mm wide, 120mm run.',
    caption: 'Thinner than the line drawn around it.',
    warn: 'Strong in shear, weak in PEEL — and an upcut bit peels the fresh edge.',
  },
  'tape-and-ca-glue': {
    kind: 'film',
    drawnFootprintMm: [24, 120],
    drawnFootprintWhy:
      'same as double-sided-tape: keepout [0, 0] is correct and undrawable. 24mm tape plus the glue bead, 120mm run.',
    caption: 'Two tape layers glued face to face. The 0.3 mm is a stand-in.',
    warn: 'The failure surface is tape-to-wood: dusty ply halves it.',
  },
  'screws-into-spoilboard': {
    kind: 'through',
    cuttable: false,
    depthMm: 32, // a stand-in: screw length is bounded by a spoilboard thickness nobody recorded
    caption: 'Nothing above the spoilboard. The whole keepout points DOWN, at full depth.',
    warn: 'Steel: "hitting one of the screws will often break the cutter."',
  },
  'composite-nails': {
    kind: 'through',
    cuttable: true,
    depthMm: 25.4, // B/18-100, the longest 18-gauge brad RAPTOR publishes
    caption: 'A 25.4 mm brad through 18 mm ply leaves 7.4 mm sitting in the spoilboard.',
    warn: 'Cuttable on the VENDOR’S WORD, and no shank diameter is published anywhere.',
  },
  'dog-hole-grid-20mm': {
    kind: 'bed',
    gridPitchMm: 96,
    holds: false,
    caption: '20 mm holes on 96 mm centres. Holds nothing, blocks nothing.',
    warn: 'It QUANTISES placement: a clamp moves 96 mm, or it does not move.',
  },
  'dog-hole-bench-dog': {
    kind: 'proud',
    intrusionMm: 0,
    caption: 'The 0.7 in dog: 17.8 mm, so it sits 0.2 mm BELOW an 18 mm workpiece.',
    warn: 'The same kit ships a 2 in dog at 50.8 mm — taller than the toggle clamp.',
  },
  'spindle-pressure-foot': {
    kind: 'tool',
    caption: 'Rides the spindle and presses AT the cut. Its position is the toolpath.',
    warn: 'Not a machine-mounted feature, so it cannot be a Clamp — it has no fixed x/y.',
  },
};

// -- keeping the drawing inside its own frame -------------------------------
//
// Both helpers below exist because the FIRST browser render of this file ran
// text off the right edge and drew a 141 mm clamp body starting at -23 mm — off
// canvas. Neither was visible in the source, in the types, or in `tsc`. A
// drawing is only checkable by looking at it, which is the same reason a gate
// carries a negative control.

/** Roughly how wide a string is, in mm, at the annotation font size. Mono at
 *  4.2 px is close enough to 2.35 units per character for a fit test. */
function textWidth(t: string): number {
  return t.length * 2.5;
}

/** An annotation that cannot leave the frame: it right-aligns at the margin
 *  rather than running off the edge, because a note you cannot read is worse
 *  than one in an awkward place. */
function Note({
  x,
  y,
  text,
  cls,
}: {
  x: number;
  y: number;
  text: string;
  cls: string;
}): ReactElement {
  const w = textWidth(text);
  if (x + w <= X1 - 2) {
    return (
      <text className={cls} x={x} y={y}>
        {text}
      </text>
    );
  }
  // Wider than the whole frame: right-aligning would push the START off the
  // left edge, and a caption that loses its first words is worse than one that
  // loses its last. Left-align and let the tail run.
  if (w > X1 - X0 - 4) {
    return (
      <text className={cls} x={X0} y={y}>
        {text}
      </text>
    );
  }
  return (
    <text className={cls} x={X1 - 2} y={y} textAnchor="end">
      {text}
    </text>
  );
}

/** Clip a body to the drawing and report whether it was clipped. A clipped body
 *  gets a conventional BREAK mark and its true size in the caption — it is
 *  never silently shrunk, because a silently shrunk body is an off-scale
 *  drawing in a file whose whole claim is that it is to scale. */
function fitSpan(start: number, width: number): { x: number; w: number; broken: boolean } {
  const x = Math.max(start, X0 + 2);
  const right = Math.min(start + width, X1 - 2);
  return { x, w: Math.max(right - x, 2), broken: start < X0 + 2 || start + width > X1 - 2 };
}

/** The zigzag that says "this continues past the edge of the drawing". */
function Break({ x, y, h }: { x: number; y: number; h: number }): ReactElement {
  const step = h / 4;
  const d = `M ${x} ${y} l 2 ${step} l -4 ${step} l 4 ${step} l -2 ${step}`;
  return <path className="whs-break" d={d} />;
}

// -- shared furniture --------------------------------------------------------

/** The two panel frames, their titles, and the bed/spoilboard in the side view.
 *  Drawn first so everything else sits on top of it. */
function Frame({ sideNote }: { sideNote: string }): ReactElement {
  return (
    <g>
      <text className="whs-cap" x={X0} y={PLAN_TOP - 4}>
        PLAN — looking down at the spoilboard
      </text>
      <rect
        className="whs-frame"
        x={X0}
        y={PLAN_TOP}
        width={X1 - X0}
        height={PLAN_BOT - PLAN_TOP}
      />
      <text className="whs-cap" x={X0} y={SIDE_TOP - 4}>
        SIDE — {sideNote}
      </text>
      <rect className="whs-frame" x={X0} y={SIDE_TOP} width={X1 - X0} height={BED_Y - SIDE_TOP} />
      {/* Spoilboard. The bed line is the datum every height in the catalogue
          is measured from, so it is the heaviest line in the drawing. */}
      <rect className="whs-spoil" x={X0} y={BED_Y} width={X1 - X0} height={6} />
      <line className="whs-bed" x1={X0} y1={BED_Y} x2={X1} y2={BED_Y} />
      <text className="whs-tick" x={X1} y={BED_Y + 4.6} textAnchor="end">
        spoilboard — the datum every height is measured from
      </text>
    </g>
  );
}

/** The stock, in both views. `liftMm` raises it off the bed — which only a pod
 *  does, and which is the entire point of that drawing. */
function Stock({ lift = 0, from = SHEET_X }: { lift?: number; from?: number }): ReactElement {
  const top = BED_Y - lift - STOCK_MM;
  return (
    <g>
      <rect
        className="whs-stock"
        x={from}
        y={PLAN_TOP}
        width={X1 - from}
        height={PLAN_BOT - PLAN_TOP}
      />
      <text className="whs-tick" x={from + 4} y={PLAN_TOP + 6}>
        stock
      </text>
      <rect className="whs-stock" x={from} y={top} width={X1 - from} height={STOCK_MM} />
      {/* Inside the slab, not above it: the space above the stock top is where
          every clearance annotation lives, and a label there gets sat on. */}
      <text className="whs-tick" x={from + 4} y={top + STOCK_MM / 2 + 1.5}>
        18 mm ply
      </text>
    </g>
  );
}

/** A vertical height dimension with its own figure, in the side view. */
function HeightDim({ x, topY, label }: { x: number; topY: number; label: string }): ReactElement {
  return (
    <g>
      <line className="whs-dim" x1={x} y1={topY} x2={x} y2={BED_Y} />
      <line className="whs-dim" x1={x - 2} y1={topY} x2={x + 2} y2={topY} />
      <line className="whs-dim" x1={x - 2} y1={BED_Y} x2={x + 2} y2={BED_Y} />
      <Note x={x + 3} y={(topY + BED_Y) / 2} cls="whs-dimtext" text={label} />
    </g>
  );
}

// -- the six kinds -----------------------------------------------------------

/** Stands on the bed and reaches over the sheet edge. The ordinary case: it
 *  costs sheet area AND forces rapid clearance. */
function Proud(s: Shape, hatch: string): ReactElement {
  const [across, along] = s.footprintMm;
  const intrude = s.intrusionMm ?? 0;
  // The body's far edge lands `intrude` mm onto the sheet; it extends back
  // across the edge onto the bed by whatever is left of its length. A 141 mm
  // toggle clamp reaching 40 mm onto the sheet starts at -23 mm, i.e. off the
  // drawing — hence fitSpan and the break mark rather than a quiet rescale.
  const span = fitSpan(SHEET_X + intrude - across, across);
  const maxAlong = PLAN_BOT - PLAN_TOP - 10;
  const bh = Math.min(along, maxAlong);
  const by = PLAN_MID - bh / 2;
  const topY = BED_Y - s.heightMm;
  const alongClipped = along > maxAlong;
  return (
    <g>
      <Stock />
      {/* PLAN: the keepout. Hatched because it is an AREA the tool may not
          enter, not an outline it may not cross. */}
      <rect className="whs-body" x={span.x} y={by} width={span.w} height={bh} />
      {/* The hatch goes on as a SEPARATE overlay with an inline style. A
          `fill=` presentation attribute loses to `.whs-body { fill }` in the
          cascade, so the first version of this drew the keepout as a plain
          block and nothing said so. */}
      <rect
        x={span.x}
        y={by}
        width={span.w}
        height={bh}
        style={{ fill: `url(#${hatch})` }}
      />
      {span.broken && <Break x={span.x} y={by} h={bh} />}
      {intrude > 0 && (
        <g>
          <rect className="whs-eaten" x={SHEET_X} y={by} width={intrude} height={bh} />
          <Note
            x={SHEET_X + intrude + 3}
            y={by - 2}
            cls="whs-warntext"
            text={`${intrude} mm of workpiece eaten, per clamped edge`}
          />
        </g>
      )}
      {(span.broken || alongClipped) && (
        <Note
          x={X0 + 3}
          y={PLAN_BOT - 3}
          cls="whs-tick"
          text={`body continues past the frame — it is ${across} x ${along} mm`}
        />
      )}
      {/* SIDE */}
      <rect className="whs-body" x={span.x} y={topY} width={span.w} height={s.heightMm} />
      {span.broken && <Break x={span.x} y={topY} h={s.heightMm} />}
      <HeightDim x={span.x + span.w + 5} topY={topY} label={`${s.heightMm} mm`} />
      {/* Does the rapid ACTUALLY have to be lifted? Only if the body stands
          above the STOCK TOP — which is the datum conversion the catalogue
          keeps warning about, arriving here as a picture. A 6.35 mm wedge
          clamp beside an 18 mm sheet needs no lift at all, and drawing a
          clearance line over it would be a false red. False reds get muted,
          and they take the true ones with them. */}
      {s.heightMm > STOCK_MM ? (
        <g>
          <line className="whs-rapid" x1={X0 + 3} y1={topY - 6} x2={X1 - 3} y2={topY - 6} />
          <text className="whs-warntext" x={X0 + 5} y={topY - 8}>
            rapid must clear this — {(s.heightMm - STOCK_MM + CLEARANCE_MARGIN_MM).toFixed(1)} mm
            above the stock top
          </text>
        </g>
      ) : (
        <g>
          <line
            className="whs-safe"
            x1={X0 + 3}
            y1={BED_Y - STOCK_MM - 6}
            x2={X1 - 3}
            y2={BED_Y - STOCK_MM - 6}
          />
          <text className="whs-accenttext" x={X0 + 5} y={BED_Y - STOCK_MM - 8}>
            shorter than the stock — no rapid is lifted. The danger is XY, at depth.
          </text>
        </g>
      )}
    </g>
  );
}

/** 🔴 THE ONE DRAWN UPSIDE-DOWN RELATIVE TO EVERY OTHER. The stock is LIFTED
 *  and the obstruction is beneath it. Nothing is hatched in plan, because a pod
 *  eats no sheet area at all — it is under the part, not beside it. */
function Under(s: Shape): ReactElement {
  const [across, along] = s.footprintMm;
  const bh = Math.min(along, PLAN_BOT - PLAN_TOP - 14);
  const by = PLAN_MID - bh / 2 - 3;
  const span = fitSpan(X0 + 24, across);
  const mid = span.x + span.w / 2;
  const stockTop = BED_Y - s.heightMm - STOCK_MM;
  return (
    <g>
      {/* A pod is used INSIDE the sheet, not at its edge, so the sheet covers
          the whole bed here — and it is LIFTED, which is the finding. */}
      <Stock lift={s.heightMm} from={X0} />
      {/* PLAN: dashed, because it is a HIDDEN line — it is underneath. No
          hatch anywhere: a pod has no keepout in XY for a rapid, and it eats
          no sheet area at all. That absence is the drawing's whole argument. */}
      <rect className="whs-hidden" x={span.x} y={by} width={span.w} height={bh} />
      {span.broken && <Break x={span.x} y={by} h={bh} />}
      <Note
        x={span.x}
        y={by + bh + 5}
        cls="whs-accenttext"
        text={`under the workpiece: ${across} x ${along} mm of hidden line, no keepout`}
      />
      {/* SIDE: the block, the sheet ON TOP of it, and the gap between the
          sheet and the bed that no other entry in this file has. */}
      <rect
        className="whs-body"
        x={span.x}
        y={BED_Y - s.heightMm}
        width={span.w}
        height={s.heightMm}
      />
      {span.broken && <Break x={span.x} y={BED_Y - s.heightMm} h={s.heightMm} />}
      <HeightDim x={span.x + span.w + 4} topY={BED_Y - s.heightMm} label={`${s.heightMm} mm`} />
      {/* A rapid sails over. Drawn in accent, not warn: it is SAFE. */}
      <line className="whs-safe" x1={X0 + 3} y1={stockTop - 4} x2={X1 - 3} y2={stockTop - 4} />
      <Note
        x={X0 + 4}
        y={stockTop - 6}
        cls="whs-accenttext"
        text="rapid over a pod is SAFE — nothing stands above the workpiece"
      />
      {/* The real danger, which points DOWN and has no geometry in the model. */}
      <line className="whs-plunge" x1={mid} y1={stockTop + 2} x2={mid} y2={BED_Y - 3} />
      <path
        className="whs-arrowhead"
        d={`M ${mid - 2} ${BED_Y - 7} L ${mid + 2} ${BED_Y - 7} L ${mid} ${BED_Y - 3} Z`}
      />
      <Note
        x={mid + 4}
        y={BED_Y - s.heightMm - 4}
        cls="whs-warntext"
        text="a through-cut destroys it"
      />
    </g>
  );
}

/** Tape. Drawn at true thickness, which is the point: you cannot see it. */
function Film(s: Shape): ReactElement {
  const [across, along] = s.footprintMm;
  const bh = Math.min(along, PLAN_BOT - PLAN_TOP - 14);
  const by = PLAN_MID - bh / 2 - 3;
  // Three strips, because the real cost of tape is that it must live UNDER the
  // parts, and a nest tight enough to be worth cutting leaves nowhere for it.
  const strips = [X0 + 30, X0 + 78, X0 + 126];
  const stockTop = BED_Y - s.heightMm - STOCK_MM;
  const lx = strips[1] + across / 2;
  return (
    <g>
      <Stock lift={s.heightMm} from={X0} />
      {/* PLAN: costs no perimeter at all — nothing is at the sheet edge. The
          cost is AREA, in the middle of the sheet, where the parts are. */}
      {strips.map((x) => (
        <rect className="whs-film" key={x} x={x} y={by} width={across} height={bh} />
      ))}
      <Note
        x={X0 + 3}
        y={by + bh + 5}
        cls="whs-accenttext"
        text={`${across} mm strips, and they must be UNDER the parts`}
      />
      {/* SIDE: a filled sliver at TRUE scale. At any sane render size this is a
          sub-pixel line — which is the finding, so it gets a leader rather
          than being fattened up until it can be seen. */}
      {strips.map((x) => (
        <rect
          className="whs-film"
          key={x}
          x={x}
          y={BED_Y - s.heightMm}
          width={across}
          height={s.heightMm}
        />
      ))}
      <line className="whs-lead" x1={lx} y1={BED_Y - 1} x2={lx + 16} y2={BED_Y - 30} />
      <Note
        x={lx + 18}
        y={BED_Y - 31}
        cls="whs-accenttext"
        text={`${s.heightMm} mm — the entire standing height, drawn to scale`}
      />
      <line className="whs-safe" x1={X0 + 3} y1={stockTop - 4} x2={X1 - 3} y2={stockTop - 4} />
      <Note x={X0 + 4} y={stockTop - 6} cls="whs-accenttext" text="nothing to clear" />
    </g>
  );
}

/** Screws and composite nails: identical geometry, opposite verdict. Both are
 *  full-depth and stand nothing above the bed; one breaks the cutter and the
 *  other is designed to be cut. The only difference in the drawing is colour,
 *  because the only difference in the world is the material. */
function Through(s: Shape): ReactElement {
  const cls = s.cuttable ? 'whs-cuttable' : 'whs-steel';
  const depth = s.depthMm ?? STOCK_MM + 5;
  const at = [SHEET_X + 24, SHEET_X + 60, SHEET_X + 96];
  const keep = Math.max(s.footprintMm[0], 12);
  const stockTop = BED_Y - STOCK_MM;
  return (
    <g>
      <Stock from={SHEET_X - 40} />
      {at.map((x) => (
        <g key={x}>
          {/* PLAN: the keepout is a ring around the fastener, not the head —
              it has to cover placement error plus the cutter radius. */}
          <rect
            className={s.cuttable ? 'whs-hidden' : 'whs-keep'}
            x={x - keep / 2}
            y={PLAN_MID - keep / 2}
            width={keep}
            height={keep}
          />
          <circle className={cls} cx={x} cy={PLAN_MID} r={2.2} />
          {/* SIDE: down through the stock and into the spoilboard. Nothing
              above the stock top — so no rapid clearance is owed. */}
          <rect className={cls} x={x - 1.6} y={stockTop} width={3.2} height={depth} />
        </g>
      ))}
      <line className="whs-safe" x1={X0 + 3} y1={stockTop - 4} x2={X1 - 3} y2={stockTop - 4} />
      <Note
        x={X0 + 4}
        y={stockTop - 6}
        cls="whs-accenttext"
        text="nothing above the spoilboard — no rapid clearance is owed"
      />
      <Note
        x={X0 + 4}
        y={SIDE_TOP + 8}
        cls={s.cuttable ? 'whs-accenttext' : 'whs-warntext'}
        text={
          s.cuttable
            ? 'non-metal, and a cutter may pass THROUGH it by design'
            : 'steel, full depth, and the whole danger is here in XY'
        }
      />
      <Note
        x={X0 + 4}
        y={PLAN_BOT - 3}
        cls="whs-tick"
        text={
          s.footprintMm[0] > 0
            ? `${s.footprintMm[0]} mm keepout — placement error plus cutter radius`
            : 'no keepout: it is meant to be cut, so none is declared'
        }
      />
    </g>
  );
}

/** A property of the bed, with nothing standing on it: a vacuum table that
 *  holds everywhere, or a dog-hole grid that holds nowhere. */
function Bed(s: Shape): ReactElement {
  const stockTop = BED_Y - STOCK_MM;
  const holes: ReactElement[] = [];
  if (s.gridPitchMm) {
    // 🔴 AT THE PUBLISHED PITCH, NOT HALF OF IT. The first version stepped by
    // pitch/2 and captioned itself "96 mm centres" — a to-scale drawing
    // disagreeing with its own caption about the only number it exists to
    // show. Two columns across 188 mm is the honest answer, and the fact that
    // 96 mm looks that coarse IS the point of the entry.
    for (let x = X0 + 22; x < X1 - 12; x += s.gridPitchMm) {
      for (let y = PLAN_TOP + 20; y < PLAN_BOT - 12; y += s.gridPitchMm) {
        holes.push(<circle className="whs-hole" key={`${x}-${y}`} cx={x} cy={y} r={10} />);
      }
      // In section the holes are VOIDS in the spoilboard, not obstructions.
      holes.push(
        <rect className="whs-hole" key={`s${x}`} x={x - 10} y={BED_Y} width={20} height={6} />,
      );
    }
  }
  const pulls: ReactElement[] = [];
  if (s.holds) {
    for (let x = X0 + 16; x < X1 - 10; x += 22) {
      pulls.push(
        <g key={x}>
          <line className="whs-plunge" x1={x} y1={stockTop + 3} x2={x} y2={BED_Y - 2} />
          <path className="whs-arrowhead" d={`M ${x - 2} ${BED_Y - 5} L ${x + 2} ${BED_Y - 5} L ${x} ${BED_Y - 1} Z`} />
        </g>,
      );
    }
  }
  return (
    <g>
      <Stock from={X0} />
      {holes}
      {pulls}
      <line className="whs-safe" x1={X0 + 3} y1={stockTop - 4} x2={X1 - 3} y2={stockTop - 4} />
      <Note
        x={X0 + 4}
        y={stockTop - 6}
        cls="whs-accenttext"
        text={
          s.holds
            ? 'held from below over the whole area — nothing stands anywhere'
            : 'nothing above the spoilboard, and nothing holding either'
        }
      />
      {s.holds && (
        <Note
          x={X0 + 4}
          y={SIDE_TOP + 8}
          cls="whs-warntext"
          text="and the cut destroys the seal as it goes"
        />
      )}
      {s.gridPitchMm && (
        <Note
          x={X0 + 4}
          y={PLAN_BOT - 3}
          cls="whs-warntext"
          text={`${s.gridPitchMm} mm centres — a clamp moves ${s.gridPitchMm} mm or not at all`}
        />
      )}
    </g>
  );
}

/** Rides the spindle. Its x/y is the toolpath, so a fixed rectangle on the bed
 *  is meaningless for it — which is why the plan view shows it moving. */
function Tool(): ReactElement {
  const stockTop = BED_Y - STOCK_MM;
  const cx = SHEET_X + 55;
  return (
    <g>
      <Stock from={X0} />
      {/* PLAN: a ring around the cutter, and an arrow saying it does not stay. */}
      <circle className="whs-hidden" cx={cx} cy={PLAN_MID} r={22} />
      <circle className="whs-cuttable" cx={cx} cy={PLAN_MID} r={3} />
      <line className="whs-rapid" x1={cx + 24} y1={PLAN_MID} x2={cx + 70} y2={PLAN_MID} />
      <path
        className="whs-arrowhead"
        d={`M ${cx + 66} ${PLAN_MID - 2} L ${cx + 66} ${PLAN_MID + 2} L ${cx + 70} ${PLAN_MID} Z`}
      />
      <Note
        x={X0 + 4}
        y={PLAN_BOT - 3}
        cls="whs-accenttext"
        text="travels with the tool — it has no fixed x/y to declare"
      />
      {/* SIDE: spindle, foot, stock. */}
      <rect className="whs-body" x={cx - 9} y={SIDE_TOP + 4} width={18} height={30} />
      <rect className="whs-body" x={cx - 26} y={stockTop - 8} width={52} height={8} />
      <rect className="whs-cuttable" x={cx - 2} y={SIDE_TOP + 34} width={4} height={STOCK_MM + 12} />
      <Note
        x={X0 + 4}
        y={stockTop - 14}
        cls="whs-warntext"
        text="needs clearance around the cut — will not coexist with tall clamps"
      />
    </g>
  );
}

// -- the component -----------------------------------------------------------

/**
 * The drawing for `id`, with its geometry READ FROM THE CATALOGUE.
 *
 * 🔴 This function is the reason the numbers appear once. `heightMm` and the
 * keepout `footprintMm` come from `workholding.ts` — the same values
 * `App.tsx` copies into `ClampCfg` and gate `P7` clears a toolpath against —
 * so a catalogue correction reaches the picture in the same edit, and a picture
 * cannot assert a size the check does not use.
 *
 * `undefined` for an id with no drawing, and for an id the CATALOGUE does not
 * carry: a schematic for a device that is not in the list is a picture of
 * nothing, and drawing it from a table of its own is how this diverged.
 */
export function shapeFor(id: string): Shape | undefined {
  const spec = SHAPES[id];
  if (!spec) return undefined;
  const cat = WORKHOLDING.find((w) => w.id === id);
  if (!cat) return undefined;
  return {
    ...spec,
    heightMm: cat.heightMm,
    footprintMm: spec.drawnFootprintMm ?? cat.footprintMm,
  };
}

export interface WorkholdingShapeProps {
  /** A `Workholding.id`. An unknown id renders an explicit PENDING panel — it
   *  must never render an empty box that reads as "nothing is in the way". */
  id: string;
  className?: string;
}

/**
 * A to-scale plan + side schematic of one workholding entry.
 *
 * Deliberately renders a visible PENDING panel for an unknown id rather than
 * nothing. A blank drawing where a clamp should be is an absence rendered as a
 * reassuring state, and that is the failure mode this whole catalogue exists to
 * avoid — the same reason a check that cannot run reports PENDING, never PASS.
 */
export function WorkholdingShape({ id, className }: WorkholdingShapeProps): ReactElement {
  const s = shapeFor(id);
  const hatch = `whs-hatch-${id}`;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width="100%"
      role="img"
      aria-label={
        s
          ? `Scale schematic of ${id}: plan view and side elevation, ${s.heightMm} mm above the spoilboard.`
          : `No schematic for ${id}.`
      }
    >
      <style>{`
        .whs-frame  { fill: none; stroke: var(--line); stroke-width: .4; }
        .whs-bed    { stroke: var(--line); stroke-width: 1.2; }
        .whs-spoil  { fill: var(--line); opacity: .18; }
        .whs-stock  { fill: var(--muted); opacity: .16; stroke: var(--muted); stroke-width: .4; }
        .whs-body   { fill: var(--ink); fill-opacity: .22; stroke: var(--ink); stroke-width: .6; }
        .whs-hidden { fill: none; stroke: var(--accent); stroke-width: .6; stroke-dasharray: 3 2; }
        .whs-film   { fill: var(--accent); stroke: none; }
        .whs-keep   { fill: none; stroke: var(--warn); stroke-width: .6; stroke-dasharray: 2 1.5; }
        .whs-eaten  { fill: var(--warn); opacity: .3; }
        .whs-steel  { fill: var(--warn); stroke: none; }
        .whs-cuttable { fill: var(--accent); stroke: none; }
        .whs-hole   { fill: var(--line); opacity: .3; stroke: var(--muted); stroke-width: .4; }
        .whs-rapid  { stroke: var(--warn); stroke-width: .6; stroke-dasharray: 4 2; }
        .whs-safe   { stroke: var(--accent); stroke-width: .6; stroke-dasharray: 4 2; }
        .whs-plunge { stroke: var(--warn); stroke-width: .8; }
        .whs-arrowhead { fill: var(--warn); }
        .whs-lead   { stroke: var(--accent); stroke-width: .4; }
        .whs-break  { fill: none; stroke: var(--muted); stroke-width: .7; }
        .whs-dim    { stroke: var(--ink); stroke-width: .4; }
        .whs-hatchline { stroke: var(--warn); stroke-width: .5; }
        .whs-cap    { fill: var(--muted); font: 4.6px var(--sans, sans-serif); letter-spacing: .3px; }
        .whs-tick   { fill: var(--muted); font: 4px var(--mono, monospace); }
        .whs-dimtext{ fill: var(--ink); font: 4.4px var(--mono, monospace); }
        .whs-accenttext { fill: var(--accent); font: 4.2px var(--mono, monospace); }
        .whs-warntext   { fill: var(--warn); font: 4.2px var(--mono, monospace); }
      `}</style>
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse">
          <line className="whs-hatchline" x1="0" y1="4" x2="4" y2="0" />
        </pattern>
      </defs>

      {!s && (
        <text className="whs-warntext" x={X0} y={PLAN_TOP + 10}>
          PENDING — no schematic for &quot;{id}&quot;. Not &quot;nothing is in the way&quot;.
        </text>
      )}

      {s && (
        <g>
          <Frame
            sideNote={
              s.kind === 'under'
                ? 'the obstruction is UNDER the stock'
                : s.kind === 'tool'
                  ? 'it is on the spindle, not the machine'
                  : 'heights are from the SPOILBOARD, not the workpiece top'
            }
          />
          {s.kind === 'proud' && Proud(s, hatch)}
          {s.kind === 'under' && Under(s)}
          {s.kind === 'film' && Film(s)}
          {s.kind === 'through' && Through(s)}
          {s.kind === 'bed' && Bed(s)}
          {s.kind === 'tool' && Tool()}
          <Note x={X0} y={VB_H - 12} cls="whs-tick" text={s.caption} />
          {s.warn && (
            <Note x={X0} y={VB_H - 4} cls="whs-warntext" text={s.warn} />
          )}
        </g>
      )}
    </svg>
  );
}

/** Ids that have a drawing. Anything in `WORKHOLDING` and not in here renders
 *  PENDING — which is the honest state, not a gap to be hidden. */
export const DRAWN_IDS: string[] = Object.keys(SHAPES);
