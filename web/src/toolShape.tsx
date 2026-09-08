// A cutter, drawn from the numbers the core already holds.
//
// 🔴 WHY THIS FILE EXISTS INSTEAD OF A FOLDER OF PHOTOGRAPHS.
//
// The founder asked for "images for all tools". Manufacturer product shots are
// copyrighted, this app is AGPL-3.0-or-later, and §13 means its source is
// offered to every user who is served the page — so a copied Amana or Onsrud
// photo would travel with the distribution and make it infringing. "It was on
// the internet" is not a licence. The lawful routes, and the two openly-licensed
// photographs that were actually found, are recorded in `docs/tool-images.md`.
//
// The second reason is the better one: a photograph of a router bit is a shiny
// cylinder. It does not tell you the shank steps up from the cutter, how long
// the flutes are relative to the diameter, which way the helix runs, or what the
// tip does at the bottom. Those are exactly the facts this app refuses jobs
// over, and they are all in `core/src/tools.rs`. So the picture is drawn FROM
// the tool record, to scale, and it changes when the record changes.
//
// 🔴 A DRAWING IS A CLAIM. Everything here is drawn from a number that exists,
// or it is not drawn:
//
//   * No included angle on an angular tool  -> the tip is NOT drawn. The body
//     ends in a dashed line, not in a plausible 90° vee. Drawing a 90° vee for a
//     tool whose angle we never read is the picture lying about the tool the
//     operator is choosing, and it would lie most convincingly on the tools
//     where the angle matters most.
//   * No point angle on a drill            -> same; no cone.
//   * No flute direction                   -> no helix. A dashed centre line
//     says "flutes, direction not stated" and is deliberately different from the
//     evenly-spaced solid lines that mean "straight".
//     ⚠ STALE 🔴 CORRECTED 2026-08-09. This said `flute_type` was "NOT in the
//     JSON the core ships to the UI ... so today every tool takes this branch",
//     with a one-line fix pending in the core. That fix LANDED:
//     `fixtures.rs::tool_library_json_for` emits `"flute_type"`, `cam.ts`'s
//     `ToolRow` carries it, and the string is in the shipped
//     `src/wasm/twobee_cam_wasm_bg.wasm`. Measured in the running app the same
//     day — of 51 tool icons rendered, the direction breaks down 44 straight /
//     3 up / 3 down / 1 compression and **none** is `unstated`. The refusal
//     below is still correct and still reachable (an imported tool file need
//     not carry the field); what was false was "every tool takes it", which
//     read as a dead branch and would have got the code deleted.


//   * No shank diameter                    -> no shank. The body's top edge is
//     dashed and nothing is drawn above it.
//   * No diameter at all                   -> nothing but an empty dashed frame.
//
// `describeToolShape()` returns those refusals as sentences so the caller can
// show them in words. An absent line in a drawing reads as "fine" unless
// something says otherwise, and that is the whole failure this file is trying
// not to commit.
//
// 🔴 SCALE IS SHARED, NOT PER-TOOL. Every tool is drawn at the same px/mm, set
// by `maxDiameterMm` (the library's 25mm surfacing cutter). A 3mm bit is a third
// the width of a 9mm bit BETWEEN ROWS, which is the only place that comparison
// is worth anything. The one deliberate departure: a sub-millimetre tool would
// render narrower than one device pixel and vanish, so the drawn half-width has
// a 0.4px floor — below ~1.1mm the widths stop being faithful to each other.
// Nothing else is normalised, stretched or fitted.
//
// LENGTH. Overall tool length is not in the record — only `cutting_length_mm`.
// So the shank is ALWAYS drawn broken (a zig-zag, the drafting mark for
// "shortened, not shown to length"), and a flute too long for the frame is drawn
// broken too, at true diameter and true tip angle. The drawing never squashes a
// long tool to fit: squashing would keep the picture pretty and make the
// flute-length-against-diameter comparison — the reason to draw it at all — a
// lie.
//
// COLOUR. Only the five CSS custom properties, which resolve to `brand/
// tokens.css` (gate G-THEME). Cutting geometry is `--accent`; the shank, which
// cuts nothing, is `--muted`. No hex literal appears in this file.

import { useId } from 'react';

/** The library's largest cutter (25mm surfacing). The default shared scale. */
export const LIBRARY_MAX_DIAMETER_MM = 25;

/**
 * The fields of a tool row this drawing reads. Every one is optional: the
 * component's contract is that a missing number produces a missing feature and a
 * sentence saying so, never a default.
 */
export interface ToolShapeTool {
  id?: string;
  /** 'End Mill' | 'Ball Nose' | 'V-Bit' | 'Chamfer' | 'Drill' | 'Countersink' | 'Surfacing' | 'Engraving' | 'Thread Mill' */
  category?: string | null;
  diameter_mm?: number | null;
  shank_mm?: number | null;
  cutting_length_mm?: number | null;
  flutes?: number | null;
  included_angle_deg?: number | null;
  point_angle_deg?: number | null;
  /**
   * `'straight' | 'up-cut' | 'down-cut' | 'compression'`, as the core spells it
   * in the tool JSON.
   *
   * ⚠ Corrected 2026-08-09: this said the core "does not ship it". It does —
   * see the header. Absent here still means UNSTATED, and unstated is still
   * drawn as unstated rather than as straight; that is now the case for an
   * IMPORTED tool file rather than for the whole library.
   */
  flute_type?: string | null;
}

/** `row` sits in a 24px list row. `pane` is the properties view. Same drawing. */
export type ToolShapeSize = 'row' | 'pane';

export interface ToolShapeProps {
  tool: ToolShapeTool;
  size?: ToolShapeSize;
  /** Shared scale basis. Change it and EVERY row must change with it. */
  maxDiameterMm?: number;
  className?: string;
}

/** What the drawing says, and what it refuses to say. */
export interface ToolShapeReading {
  /** One line — the accessible name and the native tooltip. */
  title: string;
  /** Facts this drawing asserts, in the order it draws them. */
  drawn: string[];
  /**
   * Facts it will not assert, each naming the missing number. Show these: a
   * feature absent from a drawing is invisible, and invisible reads as fine.
   */
  notDrawn: string[];
}

/* ── Reading the record ────────────────────────────────────────────────────── */

const MUTED = 'var(--muted)';
const INK = 'var(--ink)';
const LINE = 'var(--line)';
const ACCENT = 'var(--accent)';
const BODY_FILL = 'var(--bg)';

function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** An angle we are willing to draw: (0°, 180°]. 180 is flat, and that is a fact. */
function angle(v: number | null | undefined): number | null {
  const n = positive(v);
  return n !== null && n <= 180 ? n : null;
}

/**
 * A category, normalised to a comparison key: lower-cased, letters only, so
 * `'V-Bit'`, `'v bit'` and `'vbit'` are one category and not three.
 *
 * Exported because a caller that resolves a tip through {@link resolveToolTip}
 * may still need to ask WHICH category the row landed in — the 3D marker does,
 * for one cross-check — and a second copy of this normalisation is a second
 * answer to "is this row a drill".
 */
export function toolCategoryKey(category: string | null | undefined): string {
  return (category ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export type ToolTipKind = 'flat' | 'ball' | 'cone' | 'none';

/** The cutting END of a tool, as far as the record supports drawing one. */
export interface ToolTip {
  kind: ToolTipKind;
  /** Height of the tip along the axis, mm. 0 for a flat end. */
  heightMm: number;
  /** Half the included/point angle, radians. Only set for `cone`. */
  halfRad: number;
  /**
   * Present when the tip is `none`: the NOUN that was missing — `'included
   * angle'`, `'point angle'`, `'category'`. Deliberately not a whole sentence:
   * the 2D drawing and the 3D marker refuse with different words (a dashed
   * bottom EDGE against an open solid inside a dashed RING) because they are
   * refusing in different pictures, and only the missing number is common.
   */
  missing: string | null;
  /** What the tip is, in words, when it IS drawn. */
  says: string | null;
}

const FLAT: ToolTip = { kind: 'flat', heightMm: 0, halfRad: 0, missing: null, says: null };
const NO_TIP = (missing: string): ToolTip => ({
  kind: 'none',
  heightMm: 0,
  halfRad: 0,
  missing,
  says: null,
});

function cone(deg: number, radiusMm: number, says: string): ToolTip {
  const halfRad = (deg / 2) * (Math.PI / 180);
  // 180° is a flat bottom — a brad point or a dowel bit. Not a cone of infinite
  // width, and not a defect.
  if (deg >= 179.9) return { ...FLAT, says: `flat ${deg}° end` };
  return { kind: 'cone', heightMm: radiusMm / Math.tan(halfRad), halfRad, missing: null, says };
}

/**
 * The tip IS the category. This is the one place the category becomes geometry,
 * and the one place it can refuse.
 *
 * 🔴 EXPORTED SO THERE IS ONE OF IT. The 3D tool marker in `Viewport.tsx` drew
 * the same cutter and, while this function was module-private, held a MIRROR of
 * this switch — kept honest by cross-checks that could only subtract a claim,
 * which is a floor under the damage and not a guarantee of agreement. The
 * mirror is deleted; the marker calls this.
 *
 * `radiusMm` is the radius the tip is being drawn AT, and every length returned
 * is in that same basis — so a caller drawing an oversize envelope passes the
 * TRUE radius and scales the result, rather than passing a scaled radius and
 * getting a scaled radius back in the words.
 */
export function resolveToolTip(tool: ToolShapeTool, radiusMm: number): ToolTip {
  const k = toolCategoryKey(tool.category);
  const inc = angle(tool.included_angle_deg);
  const pt = angle(tool.point_angle_deg);
  switch (k) {
    case 'ballnose':
      return {
        kind: 'ball',
        heightMm: radiusMm,
        halfRad: 0,
        missing: null,
        says: `ball nose, ${radiusMm.toFixed(radiusMm < 1 ? 2 : 1)} mm radius`,
      };
    case 'vbit':
    case 'chamfer':
    case 'countersink':
    case 'engraving':
      return inc === null
        ? NO_TIP('included angle')
        : cone(inc, radiusMm, `${inc}° included angle`);
    case 'drill':
      return pt === null ? NO_TIP('point angle') : cone(pt, radiusMm, `${pt}° point`);
    case 'endmill':
    case 'surfacing':
    case 'threadmill':
      return { ...FLAT, says: 'flat end' };
    default:
      // An unrecognised category is not an end mill. Refuse the tip rather than
      // fall back to the commonest shape, which is how a drawing acquires a
      // claim nobody made.
      return NO_TIP(tool.category ? `a tip shape for category "${tool.category}"` : 'category');
  }
}

export type ToolHelix = 'straight' | 'up' | 'down' | 'compression' | 'unstated';

function resolveHelix(flute: string | null | undefined): ToolHelix {
  // Same normalisation, applied to a different field — `'up-cut'`, `'UpCut'`
  // and `'up cut'` are one direction. The helper is named for its caller in
  // `Viewport.tsx`, not for this line.
  switch (toolCategoryKey(flute)) {
    case 'straight':
      return 'straight';
    case 'upcut':
    case 'up':
      return 'up';
    case 'downcut':
    case 'down':
      return 'down';
    case 'compression':
      return 'compression';
    default:
      return 'unstated';
  }
}

/**
 * Every field of a tool row this file will draw from, after the one rule that
 * governs all of them: a number that is absent, zero, negative or not finite is
 * `null`, and `null` is drawn as nothing rather than as a default.
 */
export interface ToolShapeFields {
  diaMm: number | null;
  shankMm: number | null;
  fluteMm: number | null;
  tip: ToolTip;
  helix: ToolHelix;
}

/**
 * Read a tool row. **The one reader** — the 2D drawing, its words, and the 3D
 * marker in `Viewport.tsx` all come through here, so a row cannot be read one
 * way in the tool list and another way in the scene.
 *
 * All lengths are millimetres in the tool's own basis: `tip` is resolved at the
 * TRUE radius (`diaMm / 2`), never at a drawing's inflated one.
 */
export function readToolShape(tool: ToolShapeTool): ToolShapeFields {
  const diaMm = positive(tool.diameter_mm);
  return {
    diaMm,
    shankMm: positive(tool.shank_mm),
    fluteMm: positive(tool.cutting_length_mm),
    tip: diaMm === null ? NO_TIP('diameter') : resolveToolTip(tool, diaMm / 2),
    helix: resolveHelix(tool.flute_type),
  };
}

const HELIX_WORDS: Record<ToolHelix, string> = {
  straight: 'straight flutes',
  up: 'up-cut — right-hand helix, chips lift',
  down: 'down-cut — left-hand helix, chips press down',
  compression: 'compression — up-cut below, down-cut above',
  unstated: '',
};

/**
 * What the drawing says, in words — for a tooltip, an accessible name, or a
 * caption under the properties pane.
 *
 * Pure and exported on purpose: the refusals are the interesting half, and a
 * caller that cannot get at them can only show a picture with a hole in it.
 */
export function describeToolShape(tool: ToolShapeTool): ToolShapeReading {
  const r = readToolShape(tool);
  const drawn: string[] = [];
  const notDrawn: string[] = [];

  if (r.diaMm === null) {
    return {
      title: 'No drawing — this tool states no diameter.',
      drawn: [],
      notDrawn: ['diameter is not stated, so nothing is drawn'],
    };
  }

  drawn.push(`Ø${r.diaMm} mm`);
  if (r.shankMm !== null) {
    const step =
      Math.abs(r.shankMm - r.diaMm) < 0.05
        ? 'same as the cutter'
        : r.shankMm > r.diaMm
          ? 'steps DOWN to the cutter'
          : 'steps UP to the cutter';
    drawn.push(`${r.shankMm} mm shank, ${step}`);
  } else {
    notDrawn.push('shank diameter is not stated, so no shank is drawn');
  }
  if (r.fluteMm !== null) drawn.push(`${r.fluteMm} mm flute length`);
  else notDrawn.push('cutting length is not stated, so the flute is drawn broken, not to length');

  if (r.tip.says) drawn.push(r.tip.says);
  if (r.tip.missing) {
    notDrawn.push(
      `${r.tip.missing} is not stated, so the tip is NOT drawn — the body ends in a dashed line`
    );
  }

  if (r.helix === 'unstated') {
    notDrawn.push('flute direction is not stated, so no helix is drawn (the core holds it; the tool JSON does not carry it)');
  } else {
    drawn.push(HELIX_WORDS[r.helix]);
    if (r.helix === 'compression') {
      notDrawn.push(
        'the height the two helices meet at is not in the tool record — they are drawn meeting mid-flute, which is not a measurement'
      );
    }
  }

  notDrawn.push('overall length is not in the tool record — the shank is always drawn broken');

  const title = [
    tool.category ?? 'Tool',
    ...drawn,
    ...(notDrawn.length ? [`not drawn: ${notDrawn.join('; ')}`] : []),
  ].join(' · ');

  return { title, drawn, notDrawn };
}

/* ── Drawing it ────────────────────────────────────────────────────────────── */

interface Frame {
  w: number;
  h: number;
  pad: number;
  /** Vertical space always kept for the (indeterminate) shank. */
  shankPx: number;
  stroke: number;
  /** Amplitude of a break zig-zag. */
  zig: number;
  dash: string;
}

const FRAMES: Record<ToolShapeSize, Frame> = {
  row: { w: 22, h: 24, pad: 1.5, shankPx: 5, stroke: 0.7, zig: 0.9, dash: '1.4 1.2' },
  pane: { w: 120, h: 224, pad: 8, shankPx: 26, stroke: 1.4, zig: 4, dash: '5 4' },
};

/** A zig-zag across `x0..x1` at `y` — the drafting mark for "shortened". */
function breakPath(x0: number, x1: number, y: number, amp: number): string {
  const w = x1 - x0;
  return [
    `M ${x0} ${y}`,
    `L ${x0 + w * 0.25} ${y - amp}`,
    `L ${x0 + w * 0.5} ${y + amp}`,
    `L ${x0 + w * 0.75} ${y - amp}`,
    `L ${x1} ${y}`,
  ].join(' ');
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Helix hatching for one span. `dir` +1 draws "/", -1 draws "\". */
function hatch(
  lx: number,
  rx: number,
  yTop: number,
  yBottom: number,
  dir: 1 | -1,
  pitch: number
): Line[] {
  const w = rx - lx;
  // Slope is the physical one: a router bit's helix is ~30° off the axis, so a
  // flute crosses the tool's width over ~1.7 diameters of length. That is why a
  // wide cutter's hatching looks shallow — it IS shallow.
  const lead = Math.max(w * 1.7, 3);
  const out: Line[] = [];
  for (let y = yBottom + lead; y > yTop - lead; y -= pitch) {
    out.push(
      dir === 1
        ? { x1: lx, y1: y, x2: rx, y2: y - lead }
        : { x1: lx, y1: y - lead, x2: rx, y2: y }
    );
    if (out.length > 40) break;
  }
  return out;
}

export function ToolShape({
  tool,
  size = 'row',
  maxDiameterMm = LIBRARY_MAX_DIAMETER_MM,
  className,
}: ToolShapeProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const f = FRAMES[size];
  const reading = describeToolShape(tool);
  const r = readToolShape(tool);

  const common = {
    className,
    width: f.w,
    height: f.h,
    viewBox: `0 0 ${f.w} ${f.h}`,
    role: 'img' as const,
    focusable: 'false' as const,
    'aria-label': reading.title,
    'data-tool-shape': size,
  };

  // No diameter, no drawing. An empty dashed frame is unmistakably "nothing was
  // drawn"; a generic bit shape would be a tool that does not exist.
  if (r.diaMm === null) {
    return (
      <svg {...common} data-tool-tip="none">
        <title>{reading.title}</title>
        <rect
          x={f.pad}
          y={f.pad}
          width={f.w - 2 * f.pad}
          height={f.h - 2 * f.pad}
          fill="none"
          stroke={LINE}
          strokeWidth={f.stroke}
          strokeDasharray={f.dash}
          rx={1}
        />
      </svg>
    );
  }

  const pxPerMm = (f.w - 2 * f.pad) / maxDiameterMm;
  const cx = f.w / 2;
  const top = f.pad;
  const tipY = f.h - f.pad;
  // 0.4px floor: below ~1.1mm a faithful half-width is narrower than a device
  // pixel and the tool would disappear. Documented in the header.
  const halfW = Math.max((r.diaMm / 2) * pxPerMm, 0.4);
  const shankHalfW = r.shankMm !== null ? Math.max((r.shankMm / 2) * pxPerMm, 0.4) : null;
  const availPx = tipY - top - f.shankPx;

  // The tip is drawn at TRUE slope. If it cannot fit, it is clipped — never
  // rescaled, because a rescaled cone is a different angle.
  const tipWantPx = r.tip.heightMm * pxPerMm;
  const tipPx = Math.min(tipWantPx, Math.max(availPx * 0.7, 0));
  const tipClipped = tipPx < tipWantPx - 1e-9;

  const bodyRoom = Math.max(availPx - tipPx, 1);
  const bodyWantPx = r.fluteMm !== null ? Math.max((r.fluteMm - r.tip.heightMm) * pxPerMm, 0) : null;
  const bodyBroken = bodyWantPx === null || bodyWantPx > bodyRoom;
  const bodyPx = Math.max(bodyBroken ? bodyRoom : bodyWantPx, 0.8);

  const tipTopY = tipY - tipPx;
  const bodyTopY = tipTopY - bodyPx;
  const lx = cx - halfW;
  const rx = cx + halfW;

  const bodyClip = `tsb-${uid}`;
  const lowerClip = `tsl-${uid}`;
  const upperClip = `tsu-${uid}`;
  const midY = (bodyTopY + tipTopY) / 2;

  const hatchLines: { lines: Line[]; clip: string }[] = [];
  const wideEnoughToHatch = 2 * halfW >= 2.2;
  // Spacing is a legibility choice, computed once from the WHOLE flute — not per
  // half, or a compression cutter's two halves each get their own dense screen
  // and the direction change, which is the entire point of drawing it, stops
  // being visible.
  const hatchPitch = Math.max(2.6, (tipTopY - bodyTopY) / 11, halfW * 0.7);
  if (wideEnoughToHatch) {
    if (r.helix === 'straight') {
      const n = Math.max(2, Math.min(4, Math.round((2 * halfW) / 3)));
      const lines: Line[] = [];
      for (let i = 1; i <= n; i++) {
        const x = lx + ((rx - lx) * i) / (n + 1);
        lines.push({ x1: x, y1: bodyTopY, x2: x, y2: tipTopY });
      }
      hatchLines.push({ lines, clip: bodyClip });
    } else if (r.helix === 'up' || r.helix === 'down') {
      hatchLines.push({
        lines: hatch(lx, rx, bodyTopY, tipTopY, r.helix === 'up' ? 1 : -1, hatchPitch),
        clip: bodyClip,
      });
    } else if (r.helix === 'compression') {
      // Up-cut below, down-cut above. The HEIGHT they meet at is a real number
      // on a real cutter and is NOT in the record, so they are drawn meeting at
      // the middle of the flute and the description says the transition height
      // is not stated. The claim is "both hands", not "the change is here".
      hatchLines.push({ lines: hatch(lx, rx, midY, tipTopY, 1, hatchPitch), clip: lowerClip });
      hatchLines.push({ lines: hatch(lx, rx, bodyTopY, midY, -1, hatchPitch), clip: upperClip });
    }
  }

  return (
    <svg {...common} data-tool-tip={r.tip.kind} data-tool-helix={r.helix}>
      <title>{reading.title}</title>
      <defs>
        <clipPath id={bodyClip}>
          <rect x={lx} y={bodyTopY} width={2 * halfW} height={Math.max(tipTopY - bodyTopY, 0)} />
        </clipPath>
        <clipPath id={lowerClip}>
          <rect x={lx} y={midY} width={2 * halfW} height={Math.max(tipTopY - midY, 0)} />
        </clipPath>
        <clipPath id={upperClip}>
          <rect x={lx} y={bodyTopY} width={2 * halfW} height={Math.max(midY - bodyTopY, 0)} />
        </clipPath>
      </defs>

      {/* Shank — non-cutting, so muted, and always broken off at the top
          because overall length is not a number we hold. */}
      {shankHalfW !== null && bodyTopY - (top + f.zig) > 0.5 && (
        <path
          d={
            `${breakPath(cx - shankHalfW, cx + shankHalfW, top + f.zig, f.zig)} ` +
            `L ${cx + shankHalfW} ${bodyTopY} L ${cx - shankHalfW} ${bodyTopY} Z`
          }
          fill={BODY_FILL}
          stroke={MUTED}
          strokeWidth={f.stroke}
          strokeLinejoin="round"
        />
      )}

      {/* Flute body. Its top edge is dashed when no shank is drawn, so the
          drawing does not appear to end there. */}
      <path
        d={`M ${lx} ${bodyTopY} L ${rx} ${bodyTopY}`}
        stroke={shankHalfW === null ? MUTED : INK}
        strokeWidth={f.stroke}
        strokeDasharray={shankHalfW === null ? f.dash : undefined}
        fill="none"
      />
      <rect
        x={lx}
        y={bodyTopY}
        width={2 * halfW}
        height={Math.max(tipTopY - bodyTopY, 0)}
        fill={BODY_FILL}
      />
      <path
        d={`M ${lx} ${bodyTopY} L ${lx} ${tipTopY} M ${rx} ${bodyTopY} L ${rx} ${tipTopY}`}
        stroke={INK}
        strokeWidth={f.stroke}
        fill="none"
      />

      {hatchLines.map((set, i) => (
        <g key={i} clipPath={`url(#${set.clip})`} stroke={MUTED} strokeWidth={f.stroke * 0.8}>
          {set.lines.map((l, j) => (
            <line key={j} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
          ))}
        </g>
      ))}

      {/* Direction unstated: ONE dashed centre line. Deliberately unlike the
          evenly-spaced solid lines that mean "straight" — an empty body would
          read as straight flutes, which is a claim nobody made. */}
      {r.helix === 'unstated' && tipTopY - bodyTopY > 2 && (
        <path
          d={`M ${cx} ${bodyTopY + 0.5} L ${cx} ${tipTopY - 0.5}`}
          stroke={MUTED}
          strokeWidth={f.stroke * 0.8}
          strokeDasharray={f.dash}
          fill="none"
        />
      )}

      {/* Flute drawn shorter than it is: say so with a break, never by
          squashing. */}
      {bodyBroken && tipTopY - bodyTopY > 2 * f.zig && (
        <path
          d={breakPath(lx, rx, bodyTopY + (tipTopY - bodyTopY) * 0.45, f.zig)}
          fill="none"
          stroke={MUTED}
          strokeWidth={f.stroke * 0.9}
        />
      )}

      {/* The tip — the category, in accent, because it is the cutting end and
          the thing that differs between these tools. */}
      {r.tip.kind === 'flat' && (
        <path
          d={`M ${lx} ${tipY} L ${rx} ${tipY}`}
          stroke={ACCENT}
          strokeWidth={f.stroke * 2}
          strokeLinecap="butt"
          fill="none"
        />
      )}
      {r.tip.kind === 'ball' && (
        <path
          d={`M ${lx} ${tipTopY} A ${halfW} ${halfW} 0 0 0 ${rx} ${tipTopY}`}
          fill={ACCENT}
          stroke={ACCENT}
          strokeWidth={f.stroke * 0.6}
          strokeLinejoin="round"
        />
      )}
      {r.tip.kind === 'cone' &&
        (() => {
          // Half-width the true slope has reached at the drawn height. Clipping
          // keeps the ANGLE true and shortens the cone; scaling would keep the
          // cone and falsify the angle.
          const w = Math.min(tipPx * Math.tan(r.tip.halfRad), halfW);
          return (
            <>
              <path
                d={`M ${cx} ${tipY} L ${cx - w} ${tipTopY} L ${cx + w} ${tipTopY} Z`}
                fill={ACCENT}
                stroke={ACCENT}
                strokeWidth={f.stroke * 0.6}
                strokeLinejoin="round"
              />
              {tipClipped && (
                <path
                  d={breakPath(cx - w, cx + w, tipTopY, f.zig * 0.7)}
                  fill="none"
                  stroke={MUTED}
                  strokeWidth={f.stroke * 0.9}
                />
              )}
            </>
          );
        })()}
      {r.tip.kind === 'none' && (
        <path
          d={`M ${lx} ${tipY} L ${rx} ${tipY}`}
          stroke={MUTED}
          strokeWidth={f.stroke}
          strokeDasharray={f.dash}
          fill="none"
        />
      )}
    </svg>
  );
}

export default ToolShape;
