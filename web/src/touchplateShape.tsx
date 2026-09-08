// To-scale schematics for the touch plate catalogue — one per entry in
// `touchplates.ts`, keyed by `id`.
//
// 🔴 WHY THESE ARE DRAWN AND NOT PHOTOGRAPHED. Two reasons, and the second is
// the stronger one.
//
// Legal: a manufacturer's — or a marketplace seller's — product photograph is
// copyrighted. This lane is AGPL-3.0-or-later, its output is distributed, and
// §13 offers the source to every user, so a downloaded product shot committed
// here would travel with the source to everyone who runs it. "It was on the
// listing" is not a licence.
//
// And a photograph cannot carry the load. The entire subject of this catalogue
// is that ONE OBJECT HAS TWO THICKNESSES that do different jobs: the TOP face
// sets Z, the outer WALL face sets X and Y, they are different numbers, and only
// the second is added to a tool radius. A photo of an anodised block shows a
// block. It shows neither face's role, neither number, and nothing about the
// radius. These drawings show exactly those, at one scale, on one picture.
//
// ⚠ The clean route to a real photograph exists and belongs to whoever owns the
// plate: you own the object, so you own the picture, and the caliper reading can
// be taken in the same minute. That is a better artefact than either. It is not
// this file's to produce.
//
// ---------------------------------------------------------------------------
// EVERYTHING IS IN MILLIMETRES. The SVG user unit IS one millimetre — the
// viewBox is 200 x 200 mm of real machine — so no drawing can quietly be
// off-scale. Every panel uses the SAME scale, which is the whole point: a 15 mm
// corner plate and a 90 mm tool setter must be comparable at a glance, and they
// are only comparable if nothing was enlarged "so you can see it".
//
// ---------------------------------------------------------------------------
// 🔴 THE ONE CONVENTION THAT MAKES THESE HONEST: A DASHED OUTLINE IS AN ASSUMED
// SHAPE.
//
// Twelve of the thirteen catalogue entries have `wallMm: null` and most have
// `topMm: null`, because nobody publishes them. A drawing still has to put a
// rectangle somewhere. So anywhere a number is unpublished, the body is drawn
// DASHED and its dimension reads `MEASURE` in the warning colour instead of a
// figure. A solid outline with a number beside it means the number is sourced.
//
// Without that rule these drawings would be the most confident-looking artefact
// in the lane while being mostly invention — a picture reads as knowledge in a
// way a `null` in a struct does not.
//
// ---------------------------------------------------------------------------
// FIVE KINDS, and the split between them IS the TODO #40 answer:
//
//   'corner'  Hooked over the corner of the WORKPIECE. Drawn with the plate on
//             the sheet, both thicknesses dimensioned, and TWO cutters — one
//             touching the top face with its TIP, one touching the wall with its
//             SIDE, with the radius bracketed. It moves when the sheet moves.
//   'bore'    Also on the workpiece, but X and Y come from centring in a BORE,
//             so the radius cancels and there is no wall to draw. Drawn with the
//             bore in plan and the tool down inside it.
//   'flat'    Z only, laid on the stock. Workpiece-referenced too — its datum is
//             the top face of THIS sheet. No wall, no corner, no radius.
//   'setter'  BOLTED TO THE TABLE, beside the work, never touching it. Drawn
//             with the stock separate and an arrow showing the stock can move
//             without the setter's number changing. This is the only kind that
//             genuinely belongs to the machine.
//   'datum'   No device at all: Z zeroed on the spoilboard.
//
// If 'corner' and 'setter' looked alike, the drawing would repeat the modelling
// defect the research found. They do not look alike, deliberately.
//
// ---------------------------------------------------------------------------
// COLOUR comes from the app's CSS custom properties and nowhere else — there is
// not one hex literal in this file (gate G-THEME). `var()` does NOT resolve in
// an SVG presentation attribute in any shipping browser, so the classes below
// are defined in a scoped <style> and every class name is `tps-`-prefixed so it
// cannot collide with the page.
//
//   --line    bed, spoilboard, frame, panel furniture
//   --muted   the stock itself, and captions
//   --ink     the device body — the thing you bought
//   --accent  the Z story: the top face, the tip touch, the safe fact
//   --warn    the X/Y story: the wall, the tool radius, and every MEASURE
//
// That colour split is not decoration. Z is the axis that works today and has no
// radius term; X and Y are the axis pair that carries the radius and displaces
// the whole program when it is wrong. The picture says which is which before any
// text is read.
//
// This module renders; it does not decide. Nothing here reads or writes app
// state, and the geometry is derived from `touchplates.ts` rather than re-keyed,
// so a corrected number cannot leave a stale drawing behind.

import type { ReactElement } from 'react';
import { findTouchPlate, TOUCH_PLATES, type TouchPlate } from './touchplates';

// -- the sheet of mm this drawing is a window onto ---------------------------

const VB_W = 200;
const VB_H = 200;

/** Plan panel: a top-down window on the bed. */
const PLAN_TOP = 14;
const PLAN_BOT = 72;

/** Side panel: the bed line, and the ceiling the drawing may not exceed.
 *  92 mm of headroom, which the 90 mm tool setter needs nearly all of. */
const SIDE_TOP = 84;
const BED_Y = 176;

/** Left/right margins, in mm of bed. */
const X0 = 6;
const X1 = 194;

/** Where the workpiece's near edge is, in both panels. Bed to the left of it,
 *  sheet to the right. */
const SHEET_X = 104;

/** The stock this lane cuts. 18 mm ply. */
const STOCK_MM = 18;

/** Where the workpiece's front edge is in plan. Stock is above it (+Y is up the
 *  screen), bed below. The corner is therefore at (SHEET_X, CORNER_Y). */
const CORNER_Y = PLAN_BOT - 20;

/** How far a plate body may reach up the PLAN panel before it would run out
 *  through the frame. The plan band is only 58 mm of bed tall, and a 50 mm
 *  plate drawn at true size ran straight out of the top of it in the first
 *  render — invisible to `tsc`, obvious the moment it was looked at. Anything
 *  longer than this is clipped and SAID SO, never silently shrunk. */
const PLAN_LEG_MAX = 28;

/** The cutter drawn in every side elevation. 1/4 inch, because that is the
 *  reference pin diameter Carbide ships and the diameter every one of these
 *  vendors assumes in its examples. It is DRAWN, not stored — no catalogue
 *  entry has a tool. */
const TOOL_DIA = 6.35;

/** How far a corner plate's wall hangs below the workpiece top face.
 *  🔴 A STAND-IN. No vendor publishes it, so it is always drawn dashed. */
const WALL_DROP = 10;

/** How far the top leg reaches onto the sheet when no footprint is published.
 *  Also a stand-in, also always dashed. */
const LEG_STANDIN = 40;

/** Stand-ins for the two numbers this whole file is about, used ONLY to have
 *  something to draw. Every appearance is dashed and labelled MEASURE. */
const TOP_STANDIN = 12;
const WALL_STANDIN = 8;

// -- what a drawing needs to know, derived from the catalogue ---------------

type Kind = 'corner' | 'bore' | 'flat' | 'setter' | 'datum';

/**
 * Pick the drawing from the entry's own fields. Deliberately derived rather than
 * hand-keyed in a second table: a catalogue correction that did not reach the
 * drawing would leave a picture asserting the old number, and a picture asserts
 * harder than a struct.
 */
function kindOf(p: TouchPlate): Kind {
  if (p.id === 'bed-datum-no-plate') return 'datum';
  if (p.references === 'machine') return 'setter';
  if (p.radiusTerm === 'bore') return 'bore';
  return p.axes === 'xyz' ? 'corner' : 'flat';
}

/** The one line under the drawing that says what the radius does here. */
function radiusLine(p: TouchPlate): string {
  switch (p.radiusTerm) {
    case 'radius':
      return 'X/Y offset = wall + TOOL RADIUS. The radius must be known.';
    case 'bore':
      return 'The tool centres in the bore, so the radius CANCELS.';
    case 'measured':
      return 'The plate measures the tool, so no radius is declared.';
    default:
      return 'Z only: the tip touches. There is no radius term.';
  }
}

// -- keeping the drawing inside its own frame -------------------------------
//
// Both helpers are lifted from `workholdingShape.tsx`, which learned them the
// hard way: its first browser render ran text off the right edge and drew a
// 141 mm body starting at -23 mm. Neither fault was visible in the source, in
// the types, or in `tsc`. A drawing is only checkable by looking at it.

/** Roughly how wide a string is, in mm, at the annotation font size. */
function textWidth(t: string): number {
  return t.length * 2.5;
}

/** An annotation that cannot leave the frame. */
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
  // loses its last.
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

/** Clip a body to the drawing and report whether it was clipped. */
function fitSpan(start: number, width: number): { x: number; w: number; broken: boolean } {
  const x = Math.max(start, X0 + 2);
  const right = Math.min(start + width, X1 - 2);
  return { x, w: Math.max(right - x, 2), broken: start < X0 + 2 || start + width > X1 - 2 };
}

/** The zigzag that says "this continues past the LEFT/RIGHT of the drawing". */
function Break({ x, y, h }: { x: number; y: number; h: number }): ReactElement {
  const step = h / 4;
  const d = `M ${x} ${y} l 2 ${step} l -4 ${step} l 4 ${step} l -2 ${step}`;
  return <path className="tps-break" d={d} />;
}

/** The same mark rotated: "this continues past the TOP of the drawing".
 *  🔴 It exists because the first render put a VERTICAL break on a body that
 *  had been clipped VERTICALLY, which says the wrong thing about the wrong
 *  axis — a break mark is a claim about which dimension is incomplete. */
function BreakH({ x, y, w }: { x: number; y: number; w: number }): ReactElement {
  const step = w / 4;
  const d = `M ${x} ${y} l ${step} 2 l ${step} -4 l ${step} 4 l ${step} -2`;
  return <path className="tps-break" d={d} />;
}

// -- dimensions, and the MEASURE case ---------------------------------------

/** The text beside a dimension. `null` is not blank and not zero — it is the
 *  instruction to go and measure, and it renders in the warning colour so an
 *  unpublished number is louder than a published one rather than quieter. */
function dimText(v: number | null, suffix: string): { text: string; cls: string } {
  return v === null
    ? { text: `MEASURE${suffix}`, cls: 'tps-warntext' }
    : { text: `${v} mm${suffix}`, cls: 'tps-dimtext' };
}

/** A vertical dimension with arrow ticks and its own figure. */
function VDim({
  x,
  topY,
  botY,
  value,
  suffix,
  left = false,
}: {
  x: number;
  topY: number;
  botY: number;
  value: number | null;
  suffix: string;
  /** Put the figure on the LEFT of the dimension line, right-aligned to it.
   *  Needed wherever a right-hand label would land on top of a neighbouring
   *  annotation — which it did, on the first render, every time. */
  left?: boolean;
}): ReactElement {
  const t = dimText(value, suffix);
  const midY = (topY + botY) / 2 + 1.4;
  return (
    <g>
      <line className="tps-dim" x1={x} y1={topY} x2={x} y2={botY} />
      <line className="tps-dim" x1={x - 2} y1={topY} x2={x + 2} y2={topY} />
      <line className="tps-dim" x1={x - 2} y1={botY} x2={x + 2} y2={botY} />
      {left ? (
        <text className={t.cls} x={x - 3} y={midY} textAnchor="end">
          {t.text}
        </text>
      ) : (
        <Note x={x + 3} y={midY} cls={t.cls} text={t.text} />
      )}
    </g>
  );
}

/** A horizontal dimension with arrow ticks and its own figure. */
function HDim({
  y,
  x1,
  x2,
  value,
  suffix,
  anchorRight = false,
}: {
  y: number;
  x1: number;
  x2: number;
  value: number | null;
  suffix: string;
  anchorRight?: boolean;
}): ReactElement {
  const t = dimText(value, suffix);
  return (
    <g>
      <line className="tps-dim" x1={x1} y1={y} x2={x2} y2={y} />
      <line className="tps-dim" x1={x1} y1={y - 2} x2={x1} y2={y + 2} />
      <line className="tps-dim" x1={x2} y1={y - 2} x2={x2} y2={y + 2} />
      {anchorRight ? (
        // 12 mm of clearance, not 3: a 10 mm wall dimension right-aligned to its
        // own line landed underneath the side-probe cutter, which is 6.35 mm
        // wide and starts exactly there.
        <text className={t.cls} x={x1 - 12} y={y - 2} textAnchor="end">
          {t.text}
        </text>
      ) : (
        <Note x={x2 + 3} y={y + 1.4} cls={t.cls} text={t.text} />
      )}
    </g>
  );
}

// -- shared furniture --------------------------------------------------------

/** The two panel frames, their titles, and the bed in the side view. */
function Frame({ sideNote }: { sideNote: string }): ReactElement {
  return (
    <g>
      <text className="tps-cap" x={X0} y={PLAN_TOP - 4}>
        PLAN — looking down at the spoilboard
      </text>
      <rect
        className="tps-frame"
        x={X0}
        y={PLAN_TOP}
        width={X1 - X0}
        height={PLAN_BOT - PLAN_TOP}
      />
      <text className="tps-cap" x={X0} y={SIDE_TOP - 4}>
        SIDE — {sideNote}
      </text>
      <rect className="tps-frame" x={X0} y={SIDE_TOP} width={X1 - X0} height={BED_Y - SIDE_TOP} />
      <rect className="tps-spoil" x={X0} y={BED_Y} width={X1 - X0} height={5} />
      <line className="tps-bed" x1={X0} y1={BED_Y} x2={X1} y2={BED_Y} />
    </g>
  );
}

/** The stock, in both panels. In plan it fills the region above/right of the
 *  corner; in side it sits on the bed to the right of the edge. */
function Stock({ from = SHEET_X, planFrom = SHEET_X }: { from?: number; planFrom?: number }): ReactElement {
  const top = BED_Y - STOCK_MM;
  return (
    <g>
      <rect
        className="tps-stock"
        x={planFrom}
        y={PLAN_TOP + 2}
        width={X1 - planFrom - 2}
        height={CORNER_Y - PLAN_TOP - 2}
      />
      <rect className="tps-stock" x={from} y={top} width={X1 - from} height={STOCK_MM} />
      <text className="tps-tick" x={from + 4} y={top + STOCK_MM / 2 + 1.5}>
        18 mm ply
      </text>
    </g>
  );
}

/** Is there room in the side panel to draw a cutter reaching down to `tipY`? */
function hasHeadroom(tipY: number): boolean {
  return tipY - (SIDE_TOP + 3) >= 10;
}

/**
 * A cutter, drawn at its true 6.35 mm diameter. `axis` is the tool centreline;
 * it descends from the top of the panel to `tipY`.
 *
 * 🔴 Renders NOTHING when there is no room. The 90 mm tool setter's top face
 * sits 2 mm below the panel ceiling, and the first version computed a rect of
 * height -1 there: SVG dropped it silently, so the drawing showed a probe with
 * no probe in it and nothing complained. Callers must check `hasHeadroom` and
 * say where the tool came from instead.
 */
function Cutter({ axis, tipY }: { axis: number; tipY: number }): ReactElement | null {
  if (!hasHeadroom(tipY)) return null;
  const r = TOOL_DIA / 2;
  return (
    <g>
      <rect className="tps-tool" x={axis - r} y={SIDE_TOP + 3} width={TOOL_DIA} height={tipY - SIDE_TOP - 3} />
      <line className="tps-toolaxis" x1={axis} y1={SIDE_TOP + 3} x2={axis} y2={tipY + 3} />
    </g>
  );
}

// -- the five kinds ----------------------------------------------------------

/**
 * 🔴 THE DRAWING THIS WHOLE FILE EXISTS FOR. A corner plate, with BOTH
 * thicknesses dimensioned on one picture, each labelled with the axis it feeds,
 * and both cutters shown: the tip on the top face, the SIDE on the wall, with
 * the tool radius bracketed between the cutter's axis and the face it touches.
 *
 * The radius bracket is the thing a photograph can never show and the thing that
 * displaces every coordinate in the program when it is wrong.
 */
function Corner(p: TouchPlate): ReactElement {
  const top = p.topMm ?? TOP_STANDIN;
  const wall = p.wallMm ?? WALL_STANDIN;
  const topDashed = p.topMm === null;
  const wallDashed = p.wallMm === null;
  const leg = p.footprintMm ? Math.min(p.footprintMm[0], LEG_STANDIN + 20) : LEG_STANDIN;
  const legDashed = p.footprintMm === null;
  const planLeg = Math.min(leg, PLAN_LEG_MAX);
  const planClipped = planLeg < leg;

  const stockTop = BED_Y - STOCK_MM;
  const plateTop = stockTop - top;
  const wallX = SHEET_X - wall;
  const r = TOOL_DIA / 2;

  // The side probe: the cutter stands off to the left, its RIGHT flank on the
  // wall's outer face, at some depth below the plate's top face. That depth is
  // `probe_xy_depth_mm` and no vendor publishes it, so it is drawn mid-wall and
  // dimensioned MEASURE.
  const sideProbeY = plateTop + top + WALL_DROP / 2;
  const sideAxis = wallX - r;

  return (
    <g>
      <Stock />
      {/* ---------------------------------------------------------- PLAN -- */}
      {/* The plate hooks the corner: it reaches onto the sheet in both
          directions and stands `wall` proud of both edges. The plan band is
          only 58 mm of bed tall, so a long plate is CLIPPED and captioned —
          never quietly shrunk, which would put an off-scale drawing in a file
          whose whole claim is that it is to scale. */}
      <rect
        className={legDashed ? 'tps-bodydash' : 'tps-body'}
        x={wallX}
        y={CORNER_Y - planLeg}
        width={leg + wall}
        height={planLeg + wall}
      />
      <rect className="tps-hidden" x={SHEET_X} y={CORNER_Y - planLeg} width={leg} height={planLeg} />
      {/* Only when a REAL footprint was clipped. A break mark on a stand-in body
          would claim a known size continues past the frame, when no size is
          known at all — and it landed on the caption saying exactly that. */}
      {planClipped && !legDashed && <BreakH x={wallX} y={CORNER_Y - planLeg} w={leg + wall} />}
      <Note
        x={X0 + 3}
        y={PLAN_TOP + 12}
        cls="tps-tick"
        text={
          legDashed
            ? 'footprint not published — the body shown is a stand-in'
            : `${p.footprintMm?.[0]} x ${p.footprintMm?.[1]} mm${planClipped ? ', clipped by the frame' : ''}`
        }
      />
      {/* The two side probes, in plan, driving INTO the wall from outside. */}
      <line className="tps-probe" x1={wallX - 22} y1={CORNER_Y - planLeg / 2} x2={wallX - 2} y2={CORNER_Y - planLeg / 2} />
      <path
        className="tps-arrowhead"
        d={`M ${wallX - 5} ${CORNER_Y - planLeg / 2 - 2} L ${wallX - 5} ${CORNER_Y - planLeg / 2 + 2} L ${wallX - 1} ${CORNER_Y - planLeg / 2} Z`}
      />
      <line className="tps-probe" x1={SHEET_X + leg / 2} y1={CORNER_Y + 16} x2={SHEET_X + leg / 2} y2={CORNER_Y + 2} />
      <path
        className="tps-arrowhead"
        d={`M ${SHEET_X + leg / 2 - 2} ${CORNER_Y + 5} L ${SHEET_X + leg / 2 + 2} ${CORNER_Y + 5} L ${SHEET_X + leg / 2} ${CORNER_Y + 1} Z`}
      />
      <Note x={X0 + 3} y={PLAN_TOP + 6} cls="tps-warntext" text="X and Y come from the WALL — two side touches" />
      <Note
        x={X0 + 3}
        y={PLAN_BOT - 3}
        cls="tps-tick"
        text="hooked over the workpiece corner — it MOVES when the workpiece moves"
      />

      {/* ---------------------------------------------------------- SIDE -- */}
      {/* Top leg: lies ON the workpiece top face. Its thickness IS the Z term. */}
      <rect
        className={topDashed ? 'tps-bodydash' : 'tps-body'}
        x={SHEET_X}
        y={plateTop}
        width={leg}
        height={top}
      />
      {/* Wall: hangs down the OUTSIDE of the workpiece edge. Its thickness is
          the X and Y term — a different number, on a different axis of the
          drawing, which is the entire point of showing them together. */}
      <rect
        className={wallDashed ? 'tps-bodydash' : 'tps-body'}
        x={wallX}
        y={plateTop}
        width={wall}
        height={top + WALL_DROP}
      />
      <VDim x={SHEET_X + leg + 4} topY={plateTop} botY={stockTop} value={p.topMm} suffix="  TOP → Z" />
      <HDim y={stockTop + WALL_DROP + 7} x1={wallX} x2={SHEET_X} value={p.wallMm} suffix="  WALL → X,Y" anchorRight />

      {/* Z probe: the TIP, on the tool axis, no radius term. */}
      <Cutter axis={SHEET_X + leg / 2} tipY={plateTop} />
      <Note x={SHEET_X + leg / 2 + 5} y={plateTop - 5} cls="tps-accenttext" text="TIP on the TOP face → Z" />

      {/* XY probe: the SIDE, one radius off the axis. The heavy bar between the
          tool axis and the wall face IS the radius term — the thing a product
          photograph can never show and the thing that displaces the whole
          program when it is wrong. */}
      <Cutter axis={sideAxis} tipY={sideProbeY + 8} />
      <line className="tps-radius" x1={sideAxis} y1={sideProbeY} x2={wallX} y2={sideProbeY} />
      <Note x={X0 + 3} y={plateTop - 13} cls="tps-warntext" text="SIDE on the WALL face → X,Y, one TOOL RADIUS off the axis" />
      <VDim
        x={wallX - TOOL_DIA - 10}
        topY={plateTop}
        botY={sideProbeY}
        value={p.xyDepthMm}
        suffix=" XY depth"
        left
      />
    </g>
  );
}

/** X and Y from a BORE. There is no wall, the radius cancels, and the plan view
 *  is the only place the geometry is visible at all. */
function Bore(p: TouchPlate): ReactElement {
  const top = p.topMm ?? TOP_STANDIN;
  const topDashed = p.topMm === null;
  const bore = p.boreMm ?? 15;
  const leg = LEG_STANDIN;
  const planLeg = Math.min(leg, PLAN_LEG_MAX);
  const stockTop = BED_Y - STOCK_MM;
  const plateTop = stockTop - top;
  const cx = SHEET_X + leg / 2;
  const cyPlan = CORNER_Y - planLeg / 2;
  return (
    <g>
      <Stock />
      {/* PLAN: the block, and the bore inside it. The bore is the feature — it
          is drawn solid because its diameter IS published (in gSender's source,
          which is more than the vendor manages). */}
      <rect className="tps-bodydash" x={SHEET_X - 6} y={CORNER_Y - planLeg} width={leg + 6} height={planLeg + 6} />
      <circle className="tps-boreline" cx={cx} cy={cyPlan} r={bore / 2} />
      <circle className="tps-tool" cx={cx} cy={cyPlan} r={TOOL_DIA / 2} />
      {/* Four touches from the centre outward: that is what makes the radius
          cancel, and four arrows say it better than a sentence. */}
      {[
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].map(([dx, dy]) => (
        <line
          key={`${dx},${dy}`}
          className="tps-probe"
          x1={cx + (dx * TOOL_DIA) / 2}
          y1={cyPlan + (dy * TOOL_DIA) / 2}
          x2={cx + (dx * bore) / 2}
          y2={cyPlan + (dy * bore) / 2}
        />
      ))}
      <Note x={X0 + 3} y={PLAN_TOP + 6} cls="tps-accenttext" text={`bore Ø${bore} mm — four touches find its CENTRE`} />
      <Note x={X0 + 3} y={PLAN_BOT - 3} cls="tps-accenttext" text="no wall anywhere: the tool radius cancels instead of adding" />

      {/* SIDE: the block on the sheet with the tool down inside the bore. */}
      <rect className={topDashed ? 'tps-bodydash' : 'tps-body'} x={SHEET_X - 6} y={plateTop} width={leg + 6} height={top} />
      <rect className="tps-void" x={cx - bore / 2} y={plateTop} width={bore} height={top} />
      <Cutter axis={cx} tipY={stockTop} />
      <VDim x={SHEET_X + leg + 4} topY={plateTop} botY={stockTop} value={p.topMm} suffix="  TOP → Z" />
      <Note x={X0 + 3} y={plateTop - 6} cls="tps-warntext" text="this app has NO bore model — it would demand a wall that is not there" />
    </g>
  );
}

/** Z only, lying on the stock. Workpiece-referenced all the same. */
function Flat(p: TouchPlate): ReactElement {
  const top = p.topMm ?? TOP_STANDIN;
  const topDashed = p.topMm === null;
  const span = fitSpan(SHEET_X - 30, 70);
  const stockTop = BED_Y - STOCK_MM;
  const plateTop = stockTop - top;
  return (
    <g>
      <Stock from={X0 + 20} planFrom={X0 + 20} />
      {/* PLAN: it sits anywhere on the sheet. No corner, so nothing registers
          against an edge, so there is nothing to draw at the edge. */}
      <rect className={topDashed ? 'tps-bodydash' : 'tps-body'} x={span.x} y={PLAN_TOP + 12} width={span.w} height={26} />
      {span.broken && <Break x={span.x} y={PLAN_TOP + 12} h={26} />}
      <Note x={X0 + 3} y={PLAN_TOP + 8} cls="tps-accenttext" text="no corner and no wall — put it anywhere on the workpiece" />
      <Note x={X0 + 3} y={PLAN_BOT - 3} cls="tps-tick" text="still WORKPIECE-referenced: its datum is the top of THIS workpiece" />

      {/* SIDE */}
      <rect className={topDashed ? 'tps-bodydash' : 'tps-body'} x={span.x} y={plateTop} width={span.w} height={top} />
      {span.broken && <Break x={span.x} y={plateTop} h={top} />}
      <Cutter axis={span.x + span.w / 2} tipY={plateTop} />
      <VDim x={span.x + span.w + 4} topY={plateTop} botY={stockTop} value={p.topMm} suffix="  TOP → Z" />
      <Note x={X0 + 3} y={plateTop - 6} cls="tps-accenttext" text="the TIP touches. There is no radius term on Z." />
    </g>
  );
}

/**
 * 🔴 THE CONTRAST DRAWING. Bolted to the table, standing clear of the work,
 * with the stock drawn SEPARATE and an arrow saying it can be moved without the
 * setter's number changing. That is what "machine-referenced" means, and it is
 * the one fact TODO #40 turns on.
 */
function Setter(p: TouchPlate): ReactElement {
  const h = p.standingHeightMm ?? 60;
  const hDashed = p.standingHeightMm === null;
  const dia = p.footprintMm ? p.footprintMm[0] : 20;
  const baseDia = dia * 2.2; // 🔴 stand-in: no vendor publishes a base. Dashed.
  const cx = X0 + 44;
  const topY = BED_Y - h;
  const travel = p.probeMaxMm;
  return (
    <g>
      <Stock from={SHEET_X} planFrom={SHEET_X} />
      {/* PLAN: the setter sits on the BED, off the sheet entirely. Its contact
          face is solid (published); its base is dashed (never published). */}
      <circle className="tps-bodydash" cx={cx} cy={CORNER_Y - 14} r={baseDia / 2} />
      <circle className="tps-body" cx={cx} cy={CORNER_Y - 14} r={dia / 2} />
      <Note x={cx + baseDia / 2 + 3} y={CORNER_Y - 14} cls="tps-tick" text={`Ø${dia} mm contact face; base not published`} />
      {/* The stock moving, and the setter not caring. */}
      <line className="tps-probe" x1={SHEET_X + 20} y1={PLAN_TOP + 12} x2={SHEET_X + 56} y2={PLAN_TOP + 12} />
      <path
        className="tps-arrowhead"
        d={`M ${SHEET_X + 52} ${PLAN_TOP + 10} L ${SHEET_X + 52} ${PLAN_TOP + 14} L ${SHEET_X + 56} ${PLAN_TOP + 12} Z`}
      />
      <Note x={SHEET_X + 20} y={PLAN_TOP + 8} cls="tps-accenttext" text="move the workpiece — nothing here changes" />
      <Note x={X0 + 3} y={PLAN_BOT - 3} cls="tps-accenttext" text="bolted to the machine. It never touches the work." />

      {/* SIDE: the column, its standing height dimensioned from the BED. */}
      <rect className="tps-bodydash" x={cx - baseDia / 2} y={BED_Y - 6} width={baseDia} height={6} />
      <rect className={hDashed ? 'tps-bodydash' : 'tps-body'} x={cx - dia / 2} y={topY} width={dia} height={h} />
      {hasHeadroom(topY) ? (
        <Cutter axis={cx} tipY={topY} />
      ) : (
        // 🔴 A 90 mm setter's face is 2 mm below the panel ceiling. There is no
        // room to draw the tool, so SAY the tool comes down rather than draw a
        // rect of negative height that SVG silently discards — which is what
        // the first version did, producing a probe drawing with no probe in it.
        <g>
          <line className="tps-toolaxis" x1={cx} y1={SIDE_TOP + 1} x2={cx} y2={topY} />
          <Note x={cx + 5} y={SIDE_TOP + 7} cls="tps-accenttext" text="tool comes down from above the frame" />
        </g>
      )}
      <VDim x={cx + dia / 2 + 5} topY={topY} botY={BED_Y} value={p.standingHeightMm} suffix="  above the SPOILBOARD" />
      {travel !== null && (
        <g>
          <line className="tps-radius" x1={cx - dia / 2 - 4} y1={topY} x2={cx - dia / 2 - 4} y2={topY + travel} />
          <line className="tps-lead" x1={cx - dia / 2 - 4} y1={topY + travel} x2={cx - dia / 2 - 10} y2={SIDE_TOP + 19} />
          <Note x={X0 + 3} y={SIDE_TOP + 22} cls="tps-warntext" text={`${travel} mm of plunger travel — all the overshoot you get`} />
        </g>
      )}
      {/* Two fixed rows, not two positions derived from the setter height: on a
          90 mm setter the derived positions coincided and the two warnings were
          printed on top of each other, which reads as one unreadable line. */}
      <Note x={X0 + 3} y={SIDE_TOP + 32} cls="tps-warntext" text="a MACHINE-Z datum, NOT a plate thickness to subtract" />
    </g>
  );
}

/** No device at all: Z zeroed on the spoilboard. */
function Datum(): ReactElement {
  const stockTop = BED_Y - STOCK_MM;
  const cx = SHEET_X + 30;
  return (
    <g>
      <Stock from={X0 + 46} planFrom={X0 + 46} />
      <Note x={X0 + 3} y={PLAN_TOP + 8} cls="tps-accenttext" text="nothing on the machine and nothing on the workpiece" />
      <Note x={X0 + 3} y={PLAN_BOT - 3} cls="tps-tick" text="the datum is the machine, so it does not move when the workpiece does" />
      {/* The tool goes THROUGH the sheet to the bed — which is why no plate can
          live under the workpiece, and why the datum can. */}
      <Cutter axis={cx} tipY={BED_Y} />
      <line className="tps-probe" x1={cx + 12} y1={stockTop} x2={cx + 12} y2={BED_Y - 2} />
      <path className="tps-arrowhead" d={`M ${cx + 10} ${BED_Y - 6} L ${cx + 14} ${BED_Y - 6} L ${cx + 12} ${BED_Y - 2} Z`} />
      <Note x={cx + 16} y={stockTop - 4} cls="tps-accenttext" text="Z0 here, on the spoilboard" />
      <VDim x={X0 + 32} topY={stockTop} botY={BED_Y} value={STOCK_MM} suffix="" left />
      <Note x={X0 + 3} y={stockTop - 12} cls="tps-warntext" text="18 mm is NOMINAL — this is the dimension that varies" />
      <Note x={X0 + 3} y={SIDE_TOP + 8} cls="tps-warntext" text="a pocket depth now moves instead. Pick per JOB, not per machine." />
    </g>
  );
}

/**
 * The bottom line, which has to be true for THIS drawing and not for drawings in
 * general.
 *
 * 🔴 The first version tested only `topMm === null` and therefore told a tool
 * setter's reader to "measure the unpublished numbers" — but a tool setter has
 * no top thickness to measure, by nature rather than by omission. That is a
 * false red, and a false red gets muted along with the true ones. It also told
 * a Sienci reader "every dimension shown is sourced" while an XY-depth
 * dimension on the same picture read MEASURE — a caption contradicting its own
 * drawing.
 *
 * Every string here is kept under ~72 characters, because `Note` gives up and
 * lets a longer one run off the frame, and the first render truncated this line
 * mid-word on four of the six panels.
 */
function footer(p: TouchPlate, kind: Kind): { text: string; cls: string } {
  if (kind === 'setter' || kind === 'datum') {
    return {
      text: 'Machine-referenced: it does not move when the work does.',
      cls: 'tps-accenttext',
    };
  }
  if (kind === 'bore') {
    return {
      text: 'No wall to measure — the bore is the geometry. Solid = sourced.',
      cls: 'tps-accenttext',
    };
  }
  if (kind === 'flat') {
    // A Z-only plate has NO wall, so telling its reader to measure one is the
    // same false instruction the setter footer used to give — and worse here,
    // because it invents a feature the object does not have.
    return p.topMm === null
      ? { text: 'DASHED = assumed. Measure the TOP. A Z plate has no wall.', cls: 'tps-warntext' }
      : { text: 'Solid = sourced. Z only, so there is no wall and no radius.', cls: 'tps-accenttext' };
  }
  if (p.topMm === null || p.wallMm === null) {
    return {
      text: 'DASHED = assumed shape. Measure the top and the wall yourself.',
      cls: 'tps-warntext',
    };
  }
  return {
    text: 'Solid = sourced. The XY depth is yours to set; nobody prints it.',
    cls: 'tps-accenttext',
  };
}

// -- the component -----------------------------------------------------------

export interface TouchPlateShapeProps {
  /** A `TouchPlate.id`. An unknown id renders an explicit PENDING panel — it
   *  must never render an empty box that reads as "there is nothing to know". */
  id: string;
  className?: string;
}

/**
 * A to-scale plan + side schematic of one touch plate entry.
 *
 * Renders a visible PENDING panel for an unknown id rather than nothing. A blank
 * drawing where a plate should be is an absence rendered as a reassuring state,
 * which is the same failure a check that cannot run reports PENDING to avoid.
 */
export function TouchPlateShape({ id, className }: TouchPlateShapeProps): ReactElement {
  // 🔴 The entry and its kind travel together or not at all.
  //
  // `kindOf` is TOTAL — every catalogue entry has a `references` and an `axes`,
  // both non-optional, so there is no such thing as a known plate of unknown
  // kind. The only way "no kind" arises is "no entry", i.e. an id that is not in
  // the catalogue, and that already has an answer: the PENDING panel.
  //
  // Pairing them in one nullable object says exactly that, and it is why there
  // is no `!` here. A non-null assertion would have made the two states
  // "unknown plate" and "some default plate" indistinguishable to the renderer,
  // which is the failure this whole file is built to avoid — a drawing that
  // looks definite about something nobody knows.
  const entry = ((): { p: TouchPlate; kind: Kind } | null => {
    const found = findTouchPlate(id);
    return found ? { p: found, kind: kindOf(found) } : null;
  })();
  const kind = entry?.kind ?? null;
  const p = entry?.p;
  const sideNote =
    kind === 'setter'
      ? 'it is bolted to the MACHINE — heights are from the spoilboard'
      : kind === 'datum'
        ? 'no device at all: Z is zeroed on the spoilboard'
        : 'it registers on the WORKPIECE — it moves when the workpiece does';
  return (
    <svg
      className={className}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width="100%"
      role="img"
      aria-label={
        p
          ? `Scale schematic of ${p.name}: plan view and side elevation. ` +
            `References the ${p.references}. ` +
            `Top thickness ${p.topMm === null ? 'not published' : `${p.topMm} mm`}, ` +
            `wall thickness ${p.wallMm === null ? 'not published' : `${p.wallMm} mm`}.`
          : `No schematic for ${id}.`
      }
    >
      <style>{`
        .tps-frame  { fill: none; stroke: var(--line); stroke-width: .4; }
        .tps-bed    { stroke: var(--line); stroke-width: 1.2; }
        .tps-spoil  { fill: var(--line); opacity: .18; }
        .tps-stock  { fill: var(--muted); opacity: .16; stroke: var(--muted); stroke-width: .4; }
        .tps-body   { fill: var(--ink); fill-opacity: .22; stroke: var(--ink); stroke-width: .6; }
        .tps-bodydash { fill: var(--ink); fill-opacity: .07; stroke: var(--warn); stroke-width: .6; stroke-dasharray: 3 2; }
        .tps-hidden { fill: none; stroke: var(--accent); stroke-width: .5; stroke-dasharray: 2 2; }
        .tps-void   { fill: var(--line); opacity: .35; stroke: none; }
        .tps-boreline { fill: none; stroke: var(--accent); stroke-width: .8; }
        .tps-tool   { fill: var(--accent); fill-opacity: .35; stroke: var(--accent); stroke-width: .5; }
        .tps-toolaxis { stroke: var(--accent); stroke-width: .3; stroke-dasharray: 4 1.5 1 1.5; }
        .tps-probe  { stroke: var(--warn); stroke-width: .7; }
        .tps-radius { stroke: var(--warn); stroke-width: 1.1; }
        .tps-arrowhead { fill: var(--warn); }
        .tps-break  { fill: none; stroke: var(--muted); stroke-width: .7; }
        .tps-lead   { stroke: var(--warn); stroke-width: .3; }
        .tps-dim    { stroke: var(--ink); stroke-width: .4; }
        .tps-cap    { fill: var(--muted); font: 4.6px var(--sans, sans-serif); letter-spacing: .3px; }
        .tps-tick   { fill: var(--muted); font: 4px var(--mono, monospace); }
        .tps-dimtext{ fill: var(--ink); font: 4.4px var(--mono, monospace); }
        .tps-accenttext { fill: var(--accent); font: 4.2px var(--mono, monospace); }
        .tps-warntext   { fill: var(--warn); font: 4.2px var(--mono, monospace); }
      `}</style>

      {!entry && (
        <text className="tps-warntext" x={X0} y={PLAN_TOP + 10}>
          PENDING — no schematic for &quot;{id}&quot;. Not &quot;there is nothing to know&quot;.
        </text>
      )}

      {entry && (
        <g>
          <Frame sideNote={sideNote} />
          {entry.kind === 'corner' && Corner(entry.p)}
          {entry.kind === 'bore' && Bore(entry.p)}
          {entry.kind === 'flat' && Flat(entry.p)}
          {entry.kind === 'setter' && Setter(entry.p)}
          {entry.kind === 'datum' && Datum()}
          <Note x={X0} y={VB_H - 12} cls="tps-tick" text={radiusLine(entry.p)} />
          <Note
            x={X0}
            y={VB_H - 4}
            cls={footer(entry.p, entry.kind).cls}
            text={footer(entry.p, entry.kind).text}
          />
        </g>
      )}
    </svg>
  );
}

/** Ids that have a drawing. It is EVERY catalogue id, because the geometry is
 *  derived from `TOUCH_PLATES` rather than hand-keyed into a second table — so
 *  a new entry cannot ship without a picture, and a corrected number cannot
 *  leave a stale one behind. Exported so a caller can assert that rather than
 *  assume it. */
export const DRAWN_IDS: string[] = TOUCH_PLATES.map((p) => p.id);
