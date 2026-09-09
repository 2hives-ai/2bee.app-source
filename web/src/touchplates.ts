// 🔴 FIELD NAMES CORRECTED 2026-08-09. This file was written against a core in
// which the plate, the setup and the machine were ONE struct. They are three now
// (`a447e25fa`), for the reason this research itself established: the deciding
// property is "is it fastened to the table?", not "Z-only or XYZ".
//
//   the PLATE  — top thickness, wall            -> `TouchPlate`
//   the SETUP  — corner, XY probe depth         -> `Stock::corner_plate`
//   the MACHINE— a fixed setter's position/height, feeds, travel bounds
//
// A doc comment naming a field that no longer exists sends the next reader to
// grep for it, find nothing, and conclude the catalogue is stale in ways it is
// not.
// Touch plate catalogue.
//
// The research, including every source that could NOT be read and what that
// cost, is in `docs/touchplate-research.md`. Read that before changing a number
// here.
//
// 🔴 THE ONE DISTINCTION THIS FILE EXISTS TO CARRY.
//
// `core/src/types.rs` puts six probe fields on `Machine`. Two different physical
// devices are being stored in that one field set:
//
//   1. A **fixed tool setter**, bolted to the table. It never touches the work,
//      and it does not move when the sheet moves. That genuinely IS a machine
//      property.
//   2. An **XYZ corner plate**, hooked over the corner of the WORKPIECE. It
//      moves with the sheet. `ProbeCorner`'s own doc says so. That is a property
//      of the SETUP.
//
// So every entry declares `references`, and the split is the evidence TODO #40
// asked for. ⚠ It did NOT come out along the axis everyone expected: it is not
// Z-only-vs-XYZ. A Z-only plate laid on the stock is workpiece-referenced too —
// its datum is the top face of THIS sheet. The property that decides it is
// "is it fastened to the table?", and nothing else.
//
// ⚠ AND `references` IS A DEFAULT, NOT A VERDICT. The Triquetra is a
// workpiece-referenced corner plate in XYZ mode and a put-it-anywhere Z plate
// when turned upside down — the vendor's own instructions say so. The entry
// records what the device is DESIGNED for; the setup records what it is being
// USED as. A catalogue cannot settle the second.
//
// ---------------------------------------------------------------------------
// 🔴 WHY `topMm` AND `wallMm` ARE TWO NUMBERS AND NOT ONE.
//
// A Z probe touches with the TIP of the cutter: the contact point is on the tool
// axis, so the offset carries no term for the tool's width. An X or Y probe
// touches with the SIDE: the contact point is one TOOL RADIUS off the axis, so
// the offset carries the radius. gSender — the sender this lane's output is fed
// to — computes exactly `-(toolRadius) - xyThickness`, and its own header
// comment shouts `XY_THICKNESS - PRE COMPENSATE FOR TOOL THICKNESS`.
//
// Enter a wall figure where the top belongs and every X and Y coordinate in the
// program is displaced, in a direction that looks perfect on screen.
//
// ---------------------------------------------------------------------------
// 🔴 `null` IS A FIRST-CLASS VALUE HERE AND IT MEANS "NOT PUBLISHED".
//
// It is NOT "zero", NOT "not applicable", and NOT a licence to substitute
// something plausible. Twelve of the thirteen entries below have a `null`
// `wallMm`, because **no vendor publishes a wall thickness**. The one number
// that exists (10 mm) comes out of gSender's shipped defaults, where it is a
// single value applied to five different plate types — a shop setting wearing a
// product dimension's clothes.
//
// An entry with `wallMm: null` CANNOT drive an XYZ probe, and the core already
// refuses one (an undeclared wall is refused, not defaulted). That
// refusal is the correct behaviour and this catalogue is the evidence for why it
// is the common case rather than the corner case.
//
// WHAT `generic` MEANS, exactly:
//   generic: false -> the entry names a real product and EVERY non-null number
//                     came from the cited source, or is exact arithmetic on it.
//   generic: true  -> the entry is a CLASS, not a product, or its numbers are
//                     third-party measurements rather than published figures.
//                     `notes` says which. Nothing is invented in either case.
//
// NO PRICES. Purchasing is `bom`'s lane.

/** Where a sourced claim came from, and when it was true. */
export interface TouchPlateSource {
  url: string;
  /** ISO date the page was actually read. Not the date it was published. */
  read: string;
}

/**
 * What the device's datum is attached to.
 *
 * `'workpiece'` — it registers against the stock, so it MOVES when the stock is
 * moved or turned. Belongs to the setup.
 * `'machine'` — it is fastened to the table and never touches the work. Belongs
 * to the machine.
 */
export type PlateReference = 'workpiece' | 'machine';

/** Which axes the device can set. Mirrors `core`'s `ProbePlate`. */
export type PlateAxes = 'z' | 'xyz';

/**
 * How the X/Y offset relates to the cutter's width. 🔴 This is the field that
 * decides whether a program is cut in the right place.
 *
 * `'radius'`   — the cutter's SIDE touches a wall. The offset carries the tool
 *                radius and the radius must be KNOWN. The ordinary case.
 * `'bore'`     — the cutter descends into a bore and finds its CENTRE from
 *                opposing touches, so the radius terms cancel. There is no wall
 *                to declare and `wallMm` is meaningless, not merely unpublished.
 * `'measured'` — the plate measures the tool itself (a chamfer the tool slides
 *                down), so no radius need be declared at all.
 * `'none'`     — Z only. The tip touches; there is no radius term.
 */
export type ToolRadiusTerm = 'radius' | 'bore' | 'measured' | 'none';

/**
 * How the probe circuit is completed.
 *
 * `'magnet'` — a magnet on the collet nut or the tool. `'clip'` — a sprung
 * alligator clip. `'plug'` — a lead into the device only, no tool-side
 * connection. `'switch'` — a mechanical/electronic contact, no continuity
 * circuit at all. `'none'` — nothing to connect.
 */
export type Continuity = 'magnet' | 'clip' | 'plug' | 'switch' | 'none';

/**
 * What happens when the STOCK is conductive.
 *
 * ⚠ The usual question — "must the workpiece be conductive?" — is the wrong way
 * round. The TOOL must be conductive; a conductive workpiece is the HAZARD,
 * because a bare metal plate resting on an aluminium sheet shorts the circuit
 * and the probe triggers before it touches anything.
 *
 * `'ok'` — the device is insulated from the stock by design. `'shorts'` — a
 * conductive workpiece defeats it. `'na'` — it never touches the stock.
 * `'unstated'` — the vendor does not say, which is the honest majority.
 */
export type ConductiveStock = 'ok' | 'shorts' | 'na' | 'unstated';

export interface TouchPlate {
  id: string;
  /** Never a manufacturer's name unless the entry earned it — see `generic`. */
  name: string;
  /** What it is for, and why you would pick it over its neighbours. */
  detail: string;
  generic: boolean;
  source?: TouchPlateSource;

  /** Workpiece or machine. The #40 field. */
  references: PlateReference;
  axes: PlateAxes;

  /** TOP thickness, mm — `TouchPlate::top_mm` on a corner plate, or
   *  `Machine::touch_plate_mm` on a fixed one. The Z term and only the Z term:
   *  material between the plate's top face and the workpiece top face.
   *  `null` = NOT PUBLISHED, and it stays null — the core carries the same fact
   *  as `Option<f64> = None`, which is REFUSED rather than defaulted
   *  (decision #43 P0, 2026-08-09). A catalogue value written in here to fill a
   *  gap becomes a datum the operator never declared. */
  topMm: number | null;
  /** WALL thickness, mm — the plate's own `TouchPlate::wall`. The X and Y term:
   *  material between the outer reference face and the workpiece edge.
   *  `null` = NOT PUBLISHED, or meaningless for a bore-probing device. */
  wallMm: number | null;
  /** How far BELOW the plate's top face the cutter descends before probing
   *  sideways — the SETUP's `Stock::corner_plate`, not the machine's. `null` on every entry: nobody
   *  publishes it, and gSender does not expose it as a setting either. */
  xyDepthMm: number | null;
  /** Diameter of the bore an `'bore'` device centres in, mm. */
  boreMm: number | null;
  /** Plan footprint [x, y], mm. `null` = NOT PUBLISHED. */
  footprintMm: [number, number] | null;
  /** Standing height above the BED in use, mm. For a corner plate this is the
   *  obstruction height gate P7 would want and NO vendor publishes it. For a
   *  fixed setter it is the machine-Z datum, which is a different quantity
   *  wearing the same units — see `notes`. */
  standingHeightMm: number | null;
  /** Cap on the seek travel, mm — `Machine::probe_max_mm`. */
  probeMaxMm: number | null;

  radiusTerm: ToolRadiusTerm;
  continuity: Continuity;
  conductiveStock: ConductiveStock;
  notes: string;
}

export const TOUCH_PLATES: TouchPlate[] = [
  // ------------------------------------------------ workpiece · XYZ corner --
  {
    id: 'sienci-standard-block',
    name: 'Sienci Standard Block',
    detail:
      'The only entry in this catalogue whose plate geometry is knowable ' +
      'before you own it — top, wall and both footprint sides. If you want an ' +
      'XYZ probe without a caliper pass first, it is this one. You still owe ' +
      'the setup an XY probe depth; nobody publishes that.',
    generic: false,
    source: {
      url: 'https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/store/defaultState/index.ts',
      read: '2026-08-08',
    },
    references: 'workpiece',
    axes: 'xyz',
    topMm: 15,
    wallMm: 10,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: [50, 50],
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'radius',
    continuity: 'magnet',
    conductiveStock: 'unstated',
    notes:
      'SOURCED from gSender’s shipped defaultState: zThickness.standardBlock ' +
      '= 15, xyThickness = 10, plateWidth = 50, plateLength = 50 — all mm. ' +
      'Confirmed independently in imperial from a user’s gSender screen: ' +
      '"Z thickness .59", XY Thickness .393", Length/Width 1.968"" = ' +
      '14.99 / 9.98 / 49.99 mm, i.e. the same 15/10/50 plate through an inch ' +
      'conversion (forum.sienci.com/t/.../5959, read 2026-08-08). 🔴 THE WALL ' +
      'IS NOT A VENDOR FIGURE. gSender stores ONE xyThickness for all five of ' +
      'its plate types while storing a per-type zThickness — six Z numbers, ' +
      'one XY number — so 10 mm is a shop setting that happens to be right for ' +
      'this plate, not a published dimension. Sienci’s own touch plate pages ' +
      'publish no dimension of any kind. Continuity: banana plug into the ' +
      'plate, magnet at the collet nut. Standing height above the spoilboard is ' +
      'not ' +
      'published by anyone, so this plate cannot be declared as an obstruction.',
  },
  {
    id: 'sienci-autozero',
    name: 'Sienci AutoZero',
    detail:
      'Designed to delete the tool-radius problem rather than manage it: a ' +
      '170° chamfer the cutter slides down lets the plate MEASURE the tool, so ' +
      'nothing has to declare a diameter. Pick it if your bits change often.',
    generic: false,
    source: {
      url: 'https://sienci.com/2022/03/16/everything-you-need-to-know-about-the-autozero-touchplate/',
      read: '2026-08-08',
    },
    references: 'workpiece',
    axes: 'xyz',
    topMm: 5,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'measured',
    continuity: 'magnet',
    conductiveStock: 'unstated',
    notes:
      'SOURCED: zThickness.autoZero = 5 mm (gSender defaultState). The 170° ' +
      'chamfer at the bottom of the plate, and its purpose — letting v-bits, ' +
      'tapered bits and ball noses be used — are from the vendor’s own design ' +
      'write-up. 🔴 NO WALL EXISTS TO PUBLISH: gSender’s AutoZero routine ' +
      'never reads xyThickness at all; it uses fixed literals X_OFF = 22.5 / ' +
      'Y_OFF = 22.5 mm, which are plate-centre offsets and NOT a wall ' +
      'thickness. Entering 22.5 as a wall would be a plausible number that ' +
      'produces a wrong program. FOOTPRINT DELIBERATELY NULL: the 60x60x20 and ' +
      '80x80x20 mm figures in the vendor’s article are labelled design ' +
      'CONCEPTS; no production size is stated. Two probe modes exist — Auto ' +
      '(the plate measures the tool) and Diameter (you declare it); this entry ' +
      'records Auto, which is the one that removes the radius term.',
  },
  {
    id: 'carbide3d-bitzero-v2',
    name: 'Carbide 3D BitZero V2',
    detail:
      'Probes X and Y inside a 15 mm BORE instead of against a wall, so the ' +
      'tool radius cancels rather than adds. That makes it the safest of these ' +
      'in principle — and the one this app cannot currently drive, because it ' +
      'has no wall to declare.',
    generic: false,
    source: { url: 'https://shop.carbide3d.com/products/bitzero-v2', read: '2026-08-08' },
    references: 'workpiece',
    axes: 'xyz',
    topMm: 13,
    wallMm: null,
    xyDepthMm: null,
    boreMm: 15,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'bore',
    continuity: 'magnet',
    conductiveStock: 'ok',
    notes:
      'VENDOR CLAIMS, verbatim: "a bore to probe in the X/Y directions so tool ' +
      'diameter doesn’t matter", "a magnetic ground connection rather than an ' +
      'alligator clip", "a plastic base to insulate it from the workpiece so ' +
      'it’s now possible to probe conductive materials", "1/4" reference pin ' +
      'to eliminate tool flutes as a source of accuracy problems". Carbide 3D ' +
      'publishes NO dimension. 🔴 TWO Z THICKNESSES FOR ONE OBJECT, and the ' +
      'app can only hold one: gSender carries bitZero = 13 mm (the inset used ' +
      'for XYZ probing) and bitZeroZOnly = 15.5 mm (overall, used when probing ' +
      'Z alone), named BITZERO_INSET_THICKNESS and BITZERO_PROBE_THICKNESS. ' +
      'The 13 here is the XYZ figure. ⚠ AND IT IS KNOWN TO BE 0.1 mm WRONG: ' +
      'users measured 13.10 mm and concluded "the CM probing process assumes ' +
      'that the V2 probe is 13mm thick, where as it is actually 13.1mm thick" ' +
      '(community.carbide3d.com/t/.../45548, read 2026-08-08) — Carbide staff ' +
      'in that thread declined to give a number. boreMm = 15 is gSender’s ' +
      'BITZERO_BORE_DIAMETER. wallMm is null because there IS no wall, not ' +
      'because nobody published one.',
  },
  {
    id: 'carbide3d-bitzero-v1',
    name: 'Carbide 3D BitZero V1',
    detail:
      'The older plate, and NOT interchangeable with the V2 — it is taller, ' +
      'clips on, probes edges rather than a bore, and shorts on a conductive ' +
      'workpiece. Here so a shop that owns one does not enter a V2 number.',
    generic: false,
    source: { url: 'https://shop.carbide3d.com/products/bitzero-v2', read: '2026-08-08' },
    references: 'workpiece',
    axes: 'xyz',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'radius',
    continuity: 'clip',
    conductiveStock: 'shorts',
    notes:
      '🔴 EVERY DIMENSION IS UNPUBLISHED and none is guessed here. What IS ' +
      'known is known only by reading the V2 page backwards: the V2 is sold as ' +
      '"lower profile", using "a magnetic ground connection RATHER THAN an ' +
      'alligator clip", "a bore to probe in the X/Y directions SO TOOL ' +
      'DIAMETER DOESN’T MATTER", and "a plastic base to insulate it from the ' +
      'workpiece so it’s NOW possible to probe conductive materials". Each ' +
      '"rather than" / "now" is a statement about this device: taller, clip, ' +
      'edges (so the radius DOES enter), no insulation (so aluminium stock ' +
      'shorts it). The entry exists because a V1 owner reading a V2 thickness ' +
      'gets a wrong program and nothing on either page warns them.',
  },
  {
    id: 'openbuilds-xyz-probe-plus',
    name: 'OpenBuilds XYZ Touch Probe Plus',
    detail:
      'The one XYZ plate with a published size — and the size published is ' +
      'the wrong number. 54 x 54 x 12 mm is the OVERALL block, not the top ' +
      'thickness this app needs, so it still cannot run an XYZ probe.',
    generic: false,
    source: {
      url: 'https://www.makertechstore.com/products/xyz-touch-probe-plus',
      read: '2026-08-08',
    },
    references: 'workpiece',
    axes: 'xyz',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: [54, 54],
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'radius',
    continuity: 'magnet',
    conductiveStock: 'unstated',
    notes:
      'SOURCED, verbatim: "Size: 54mmx54mmx12mm (not including connector)", ' +
      '"Material: Aluminum", "Machined to 0.1mm tolerance, coating thickness ' +
      '2um", plus a magnet for tool contact and LEDs to indicate contact. ' +
      'Confirmed at a second reseller (3dware.ch, read 2026-08-08) with the ' +
      'same wording. 🔴 DATUM WARNING — THE 12 mm IS NOT topMm. It is the ' +
      'overall height of the block. Recording it as the top thickness would be ' +
      'the same error the workholding research found in clamp heights: a real ' +
      'published number measured from a datum the code does not use. ' +
      'OpenBuilds’ own documentation page publishes no dimensions at all, and ' +
      'the manufacturer’s store page is 403. So the footprint is sourced and ' +
      'both thicknesses stay null.',
  },
  {
    id: 'triquetra-3axis',
    name: 'Triquetra 3-axis touch plate',
    detail:
      'The plate that makes the radius dependency impossible to ignore: its ' +
      'own instructions tell you to generate a SEPARATE g-code file for every ' +
      'bit diameter. Use the wrong file and the origin is out by the ' +
      'difference in radii, with nothing on screen to say so.',
    generic: false,
    source: {
      url: 'https://triquetra-cnc.com/wp-content/uploads/2017/07/Triquetra%20FAQ.pdf',
      read: '2026-08-08',
    },
    references: 'workpiece',
    axes: 'xyz',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: 25.4,
    radiusTerm: 'radius',
    continuity: 'clip',
    conductiveStock: 'unstated',
    notes:
      'SOURCED from the vendor FAQ: "the only g-code files you need to create ' +
      'are files for each bit diameter"; the seek is capped at "1 inch in any ' +
      'given direction ... to prevent it from continuing to search until it ' +
      'crashes into your limits" (= probeMaxMm 25.4); it "will work with ' +
      'material as thin as 0.22 inches" (5.588 mm — a BOUND on the XY probe ' +
      'depth, since the wall must be engaged below the top face and above the ' +
      'spoilboard, but NOT the depth itself, so xyDepthMm stays null); and "The touch ' +
      'plate will still be used at the front left corner as always". ⚠ THAT ' +
      'LAST ONE IS A PRODUCT DEFAULT, NOT A LAW — the corner stays a required ' +
      'setting in this app, because a plate hooked over the wrong corner ' +
      'drives the cutter INTO it. 🔴 REFERENCE IS MODE-DEPENDENT: in Z-only ' +
      'use the vendor says to "Place your Touch Plate upside down at any ' +
      'location you prefer", which makes the same object machine-placed rather ' +
      'than workpiece-referenced. No thickness of any kind is published.',
  },
  {
    id: 'onefinity-touch-probe',
    name: 'Onefinity 3-Axis XYZ Touch Probe',
    detail:
      'Made by Triquetra for Onefinity. Its numbers exist only as third-party ' +
      'measurements — and the vendor’s own software disagrees with its own ' +
      'hardware by 0.4 mm, which is the second time that has happened in this ' +
      'catalogue.',
    generic: true,
    source: {
      url: 'https://forum.onefinitycnc.com/t/dimensions-of-onefinity-3-axis-xyz-touch-probe/21219',
      read: '2026-08-08',
    },
    references: 'workpiece',
    axes: 'xyz',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: [63.5, 63.5],
    standingHeightMm: 19,
    probeMaxMm: null,
    radiusTerm: 'radius',
    continuity: 'clip',
    conductiveStock: 'unstated',
    notes:
      'GENERIC IN EVERY NUMBER, and the fields it is generic in are the ' +
      'footprint and the standing height: "Dimensions are 63.5mm x 63.5mm x ' +
      '19mm" is a USER MEASUREMENT (Tuvix72, 2023-06-26) taken while designing ' +
      'a 3D-printed holder, not a vendor figure. The 19 mm is therefore the ' +
      'overall block height, recorded as standingHeightMm because that is what ' +
      'an overall height is when the plate sits on the stock — it is NOT topMm ' +
      'and must not be entered as one. ⚠ A SECOND USER measured "the probe ' +
      'itself it is 15mm" against a software setting of "15.4mm" and was told ' +
      'it "should match" (forum.onefinitycnc.com/t/.../4949, read 2026-08-08). ' +
      'Two users, two numbers, one vendor publishing neither. topMm stays ' +
      'null rather than take either.',
  },

  // ------------------------------------ workpiece · the generic classes ----
  {
    id: 'generic-alu-xyz-block',
    name: 'Unbranded aluminium XYZ block',
    detail:
      'The plate most small shops actually own: a machined anodised block off ' +
      'a marketplace listing, with a photo and no drawing. Nothing about it is ' +
      'published, so this entry asks for a caliper instead of pretending. See ' +
      'MEASURE_YOUR_PLATE for the two numbers and the order to take them in.',
    generic: true,
    source: { url: 'https://bulkman3d.com/product/xyz-touch-probe/', read: '2026-08-08' },
    references: 'workpiece',
    axes: 'xyz',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'radius',
    continuity: 'clip',
    conductiveStock: 'shorts',
    notes:
      '🔴 EVERY DIMENSION IS null AND NONE IS A STAND-IN. That is the point of ' +
      'the entry. The absence is VERIFIED rather than assumed: the same ' +
      'physical product sold by a named vendor with a real product page ' +
      '(BulkMan3D, read 2026-08-08) publishes "Manufactured from Aluminium ' +
      'with a premium conductive anodised coating", a sprung clip, ' +
      'compatibility with "end mills up to 10mm", and a weight of "0.08 kg" — ' +
      'and NO dimension whatsoever. A figure scraped off a listing describes ' +
      'a batch, and the batch in your drawer may not be it. ⚠ conductiveStock ' +
      'is "shorts" on the reasoning that a bare anodised-aluminium block has ' +
      'no insulating base — the anodising is described as CONDUCTIVE — but no ' +
      'vendor states it, so treat that as the cautious reading and not a ' +
      'sourced fact. Both thicknesses and the XY depth must be measured off ' +
      'the plate in your hand before this app will run an XYZ probe, and it ' +
      'refuses rather than guessing until they are.',
  },
  {
    id: 'generic-z-plate-on-stock',
    name: 'Unbranded Z-only plate, laid on the stock',
    detail:
      'A flat conductive plate you set on the workpiece top. No wall, no ' +
      'corner, no radius term — the simplest thing that works, and still ' +
      'workpiece-referenced: its datum is the top face of THIS workpiece.',
    generic: true,
    references: 'workpiece',
    axes: 'z',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: null,
    radiusTerm: 'none',
    continuity: 'clip',
    conductiveStock: 'shorts',
    notes:
      'GENERIC: no product, no source, and topMm deliberately null. ' +
      '✅ FIXED 2026-08-09 (decision #43 P0) — THE APP DEFAULT THIS ENTRY WAS ' +
      'WRITTEN TO FLAG IS GONE. Machine::default().touch_plate_mm was 1.6 mm, ' +
      'unsourced, and it RAN; it is now Option<f64> = None, which means NOBODY ' +
      'HAS DECLARED IT and is REFUSED before any motion. Some(0.0) stays legal ' +
      'if TYPED — "no plate, zero on the surface the tip touches" — because ' +
      'None and 0 are different facts and only one of them is safe to run. ' +
      'NOTHING in this research supported 1.6: the real Z figures found are 5, ' +
      '13, 15, 15.4 and 15.5 mm. The asymmetry that made it a defect: a wrong ' +
      'wall REFUSED, because 0.0 meant "not declared" — a wrong top RAN, ' +
      'because 1.6 is non-zero. 🔴 THE ARGUMENT WAS NEVER "1.6 IS DANGEROUS", ' +
      'AND THE DIRECTION IS THE ' +
      'OPPOSITE OF THE OBVIOUS ONE: the probe emits G10 L20 P1 Z<value> at the ' +
      'moment of contact, where the tip already stands the true plate thickness ' +
      'above the work, so UNDER-declaring puts work-zero ABOVE the work top and ' +
      'the machine cuts roughly 13 mm SHALLOWER than intended on a real plate — ' +
      'a scrapped part, not a crash. OVER-declaring is the direction that puts ' +
      'work-zero BELOW the work top and drives the cut, and the safe-Z retract ' +
      'with it, toward the spoilboard. ⇒ 1.6 failed SHALLOW, i.e. safe, and ' +
      'replacing it with a plausible catalogue figure would have failed toward ' +
      'the spoilboard: 15 mm, the most-published number, over-declares by 10 mm for ' +
      'anyone holding a 5 mm AutoZero. That is why the fix is a REFUSAL and not ' +
      'a better number — an unmeasured number must not be guessed, in either ' +
      'direction. Do NOT fill topMm here from a catalogue to "complete" this ' +
      'entry; a value inserted on load is a declaration the operator never ' +
      'made, which is the exact defect gSender ships. Direction confirmed at ' +
      'Carbide 3D community — "the ' +
      'virtual zero surface is now above the actual surface" ' +
      '(community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548, ' +
      'read 2026-08-09); this note said "plunges roughly 13 mm deeper" until ' +
      'then and had it backwards. Measure yours. ⚠ This entry is ' +
      'also the counter-example to the obvious reading of the Z-only rule: it is ' +
      'Z-only AND workpiece-referenced, so "Z-only means it belongs to the ' +
      'machine" is false.',
  },

  // ------------------------------------------- machine · fixed tool setter --
  {
    id: 'fixed-tool-setter-90',
    name: 'Fixed tool setter, 90 mm',
    detail:
      'Bolted to the machine and never touches the work. This is the device ' +
      'that genuinely belongs to the MACHINE: move the workpiece, turn it, cut a ' +
      'different job — the setter has not moved and its number is still true.',
    generic: false,
    source: { url: 'https://www.ato.com/tool-setter-90mm', read: '2026-08-08' },
    references: 'machine',
    axes: 'z',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: [20, 20],
    standingHeightMm: 90,
    probeMaxMm: 5,
    radiusTerm: 'none',
    continuity: 'switch',
    conductiveStock: 'na',
    notes:
      'SOURCED, verbatim: "Height 90mm", "Contact Surface Diameter 20mm", ' +
      '"Tool Setting Travel 5.0mm", "Accuracy 0.001mm", "Parallelism ' +
      '0.005/10mm", "Weight 1kg", contact type NC (4 wire) or NO (6 wire), ' +
      '"DC 10-30V, 10-20mA". The footprint here is the 20 mm CONTACT SURFACE, ' +
      'not the base — no base diameter is published, so the true keepout is ' +
      'larger than declared. probeMaxMm = 5 is the plunger travel: the ' +
      'distance the device survives being driven past trigger, which is a ' +
      'different quantity from a seek cap and we have no field for it. 🔴 ' +
      'topMm IS NULL AND MUST STAY NULL. On a corner plate that field is a ' +
      'thickness you subtract to reach the workpiece top; here the 90 mm is a ' +
      'standing height in MACHINE coordinates, which is what converts a ' +
      'tool-length measurement into a work offset. Same units, different ' +
      'quantity — putting 90 into touch_plate_mm would zero the tool 90 mm ' +
      'above where it should be. It has no continuity circuit at all: it is a ' +
      'mechanical contact, so the stock’s conductivity is irrelevant and the ' +
      'tool need not be conductive either.',
  },
  {
    id: 'fixed-tool-setter-72',
    name: 'Fixed tool setter, 72 mm',
    detail:
      'The same family one size shorter, and the one that publishes the specs ' +
      'that matter for a dusty workshop: IP67, a stated contact force, and a ' +
      'tungsten contact rather than plated steel.',
    generic: false,
    source: { url: 'https://www.ato.com/tool-setter-72mm', read: '2026-08-08' },
    references: 'machine',
    axes: 'z',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: [20, 20],
    standingHeightMm: 72,
    probeMaxMm: 5,
    radiusTerm: 'none',
    continuity: 'switch',
    conductiveStock: 'na',
    notes:
      'SOURCED, verbatim: "Height 72mm", "Contact Surface Diameter 20mm", ' +
      '"Tool Setter Travel 5.0mm", "Accuracy 0.001mm", "Parallelism ' +
      '0.005/10mm", "IP67", contact force "2.5N", contact material "Tungsten ' +
      'steel alloy", cable "1.5m", tool speed "50-200mm/min", "DC 10-30V, ' +
      '10-20mA". The stated tool speed band is the vendor’s own probe feed ' +
      'guidance and brackets this app’s 200 mm/min seek and 25 mm/min slow ' +
      'pass at the top and bottom respectively. Same datum warning as the ' +
      '90 mm entry: the height is a machine-Z figure, not a plate thickness.',
  },
  {
    id: 'wireless-z-probe',
    name: 'Wireless Z probe, machine-mounted',
    detail:
      'A tool setter with no cable to snag or wear through — the failure mode ' +
      'that eventually kills a wired probe on a moving gantry. Mounts to the ' +
      'machine with screws, so it is machine-referenced like the setters.',
    generic: false,
    source: {
      url: 'https://www.nymolabs.com/products/nymolabs-wireless-probe',
      read: '2026-08-08',
    },
    references: 'machine',
    axes: 'z',
    topMm: null,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: null,
    standingHeightMm: null,
    probeMaxMm: 0.95,
    radiusTerm: 'none',
    continuity: 'switch',
    conductiveStock: 'na',
    notes:
      'SOURCED, verbatim: plunger travel "0.95 mm", repeatability "0.02 mm", ' +
      'contact "SUS304 stainless steel", CR2032 giving "Approx.3000" probing ' +
      'cycles, 20 m range, transmitter "DC 2.4V-3.6V" / receiver "DC 5-24V ' +
      '(Max current 500 mA)"; the transmitter has "pre-drilled screw holes ' +
      'for direct mounting on the machine", which is what makes it ' +
      'machine-referenced. 🔴 THE 0.95 mm TRAVEL IS THE THING TO NOTICE: it is ' +
      'a fifth of the 5.0 mm the wired setters allow, so it is far less ' +
      'forgiving of an overshoot. Our probe_seek_feed default is 200 mm/min, ' +
      'which covers 0.95 mm in under 0.3 s. OVERALL HEIGHT AND FOOTPRINT ARE ' +
      'NOT PUBLISHED, so this cannot be declared as an obstruction either.',
  },
  {
    id: 'bed-datum-no-plate',
    name: 'No plate — zero Z on the spoilboard',
    detail:
      'The honest answer to "can the touch plate go under the workpiece?": no ' +
      'plate can, because the cutter cannot reach it through the workpiece — but ' +
      'the DATUM can. Zero Z on the spoilboard and the cut depth stops inheriting ' +
      'the ' +
      'workpiece’s thickness variation. For a through cut this is usually right.',
    generic: false,
    references: 'machine',
    axes: 'z',
    topMm: 0,
    wallMm: null,
    xyDepthMm: null,
    boreMm: null,
    footprintMm: [0, 0],
    standingHeightMm: 0,
    probeMaxMm: null,
    radiusTerm: 'none',
    continuity: 'none',
    conductiveStock: 'na',
    notes:
      'NOT A PRODUCT — it is this repo’s own Stock::z_zero_at_top = false, ' +
      'listed in the picker so it sits beside the plates rather than hiding in ' +
      'a checkbox. topMm is a genuine 0: there is no plate, so there is ' +
      'nothing to subtract. Machine-referenced because the machine does not move ' +
      'when the workpiece does. ⚠ THE ARGUMENT FOR IT IS IN docs/materials-' +
      'research.md: "18mm ply" spans at least two real thicknesses in AU, so a ' +
      'depth measured from the top of the workpiece inherits that variation while ' +
      'one measured from the spoilboard does not. The cost is the mirror image — ' +
      'anything referenced to the STOCK TOP (a pocket depth, a chamfer) is now ' +
      'the thing that moves. Pick per job, not per machine.',
  },
];

/**
 * The on-screen instructions for a plate with no published dimensions — which
 * is most of them, and is certainly the unbranded block in the drawer.
 *
 * 🔴 THIS TEXT IS THE DELIVERABLE FOR THE GENERIC CLASS. It is exported rather
 * than written into a panel so the research doc and the UI cannot drift: the
 * same words appear in `docs/touchplate-research.md`.
 *
 * The order matters and is not arbitrary. Step 1 comes first because both
 * numbers are about how the plate REGISTERS, and a plate measured loose in the
 * hand gives you the block's dimensions rather than the datum's. Step 4 exists
 * because measuring the top twice is the single likeliest way to get this
 * wrong, and it is silent.
 */
export const MEASURE_YOUR_PLATE: readonly string[] = [
  'Sit the plate on a flat offcut and hook it over the edge, the way you use it. ' +
    'Measure both numbers in that position, not with the plate loose in your hand — ' +
    'the numbers are about how it registers, not about the block.',
  'TOP thickness → Z. From the plate’s top face down to the face resting on the ' +
    'workpiece. This is the only number a Z-only probe uses.',
  'WALL thickness → X and Y. From the outer face the cutter will touch, in to the ' +
    'face that registers against the workpiece edge. It is a different number from ' +
    'the top and it is usually the larger of the two.',
  'Check they are different. If you measured the same figure twice you almost ' +
    'certainly measured the top twice. A wall entered as the top displaces every X ' +
    'and Y coordinate in the program, and the toolpath on screen still looks right.',
  'Then set the XY probe depth — how far below the plate’s top face the cutter ' +
    'drops before it moves sideways. It must clear the top leg and still be on the wall.',
];

/** The one line to put under the fields, in the warning colour. */
export const MEASURE_YOUR_PLATE_WHY =
  'Nothing here is guessed for you. A plausible default would make the probe RUN ' +
  'using dimensions nobody measured, and the resulting error is invisible in the preview.';

/** Lookup by id. Returns `undefined` rather than a fallback — a wrong plate is
 *  worse than no plate, because a wrong one produces a program. */
export function findTouchPlate(id: string): TouchPlate | undefined {
  return TOUCH_PLATES.find((p) => p.id === id);
}

/**
 * Whether this entry supplies the geometry an XYZ probe needs from the PLATE.
 *
 * 🔴 Deliberately a function and not a stored boolean: it re-derives from the
 * same nulls the core checks, so it cannot drift from the core's own refusal.
 * `false` here and a refusal in `post_grblhal` must be the same event.
 *
 * ⚠ It does NOT check `xyDepthMm`, and that is not an oversight. How far below
 * the plate's top face the cutter descends is a SETUP choice — bounded by the
 * plate (Triquetra: nothing thinner than 5.6 mm) but not determined by it, and
 * no vendor publishes it. So `true` here means "the plate's part is known"; the
 * setup still owes a depth, and the core still refuses without one.
 *
 * ⚠ And `false` covers two different situations that must not be confused: a
 * plate whose wall is merely UNPUBLISHED (measure it), and a bore-probing plate
 * that HAS no wall (measuring will not help — the app has no bore model). Check
 * `radiusTerm` before telling anyone to reach for a caliper.
 */
export function suppliesXyzGeometry(p: TouchPlate): boolean {
  return p.axes === 'xyz' && p.topMm !== null && p.wallMm !== null;
}

/**
 * Whether a saved `touchPlateId` is still honest provenance for a saved
 * thickness.
 *
 * 🔴 THE DEFECT THIS ANSWERS. The app already gets the TYPING case right, and
 * says why at the input: *"Typing your own number means the catalogue entry no
 * longer describes what is fitted. Keeping its name beside a hand-typed
 * thickness would be a false provenance."* The RESTORE path had no equivalent —
 * `touchPlateMm` and `touchPlateId` come back independently — so a machine saved
 * against a catalogue entry that has since been corrected returns wearing the
 * entry's NAME beside a number that is no longer the entry's. The picker then
 * renders the LIVE catalogue's `topMm` next to the SAVED thickness, and the
 * saved one is what reaches `touch_plate_mm` and therefore the probe's Z datum
 * in the emitted program.
 *
 * ⚠ A NAME IS NOT A CHECK. That is the whole class: #135 is the same shape one
 * level up (a clamp keeps its catalogue id while carrying a snapshot of the
 * catalogue's numbers), and the reason it is worth a function rather than an
 * inline comparison is that the answer has to be the same wherever it is asked.
 *
 * `'unnamed'` — no id, so nothing is claimed and nothing can be false.
 * `'unknown'` — an id the catalogue no longer lists at all.
 * `'undeclared'` — nothing to compare, and it is TWO WORLDS. **Read
 *                  `catalogueTopMm` to tell them apart:** `null` means the
 *                  entry publishes no top; a NUMBER means it does and the
 *                  machine declares no thickness. A caller that ignores that
 *                  discriminator writes a sentence that is false in one of the
 *                  two — which is what happened on 2026-08-28, in the world
 *                  this whole ticket rests on.
 *
 *                  **Not the same as agreeing**, either: a caller that treats
 *                  it as agreement restores a catalogue NAME beside a number
 *                  the catalogue does not vouch for, which is the false
 *                  provenance this function exists to withdraw.
 * `'agrees'`    — the saved thickness is the entry's published one.
 * `'diverged'`  — the entry exists, publishes a top, and it is NOT this number.
 */
export type PlateProvenance = 'unnamed' | 'unknown' | 'undeclared' | 'agrees' | 'diverged';

export function plateProvenance(
  id: string | null | undefined,
  thicknessMm: string | number | null | undefined
): { verdict: PlateProvenance; catalogueTopMm: number | null } {
  if (!id || String(id).trim() === '') return { verdict: 'unnamed', catalogueTopMm: null };
  const entry = TOUCH_PLATES.find((p) => p.id === id);
  if (!entry) return { verdict: 'unknown', catalogueTopMm: null };
  if (entry.topMm == null) return { verdict: 'undeclared', catalogueTopMm: null };
  /* 🔴 BLANK IS NOT ZERO, AND `Number('')` IS 0. The first version coerced
   * first and guarded with `isFinite` — which never sees a blank, because
   * `Number('')`, `Number(null)` and `Number(undefined ?? '')` are all a finite
   * 0. So a machine saved against one of the catalogue's nine `topMm: null`
   * entries (where the app deliberately sets the thickness to `''`) came back
   * accused of declaring **0 mm**, and the operator was quoted a number they
   * never typed beside a name that was in fact honest. This app treats
   * blank ≠ 0 as load-bearing in three other places and says so in each. */
  const raw = String(thicknessMm ?? '').trim();
  if (raw === '') return { verdict: 'undeclared', catalogueTopMm: entry.topMm };
  const saved = typeof thicknessMm === 'number' ? thicknessMm : Number(raw);
  if (!Number.isFinite(saved)) return { verdict: 'diverged', catalogueTopMm: entry.topMm };
  // 1e-9 rather than ===: these arrive through JSON and a text input.
  return Math.abs(saved - entry.topMm) < 1e-9
    ? { verdict: 'agrees', catalogueTopMm: entry.topMm }
    : { verdict: 'diverged', catalogueTopMm: entry.topMm };
}
