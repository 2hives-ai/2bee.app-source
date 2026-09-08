// Workholding catalogue.
//
// 🔴 THE THREE PRESETS THIS REPLACES WERE INVENTED IN THIS LANE. `App.tsx` has
// shipped `pressure bar` / `cam clamps` / `screws` with plausible heights and no
// provenance since the panel existed. A 35mm clamp height with no source is a
// claim about a real object that nobody ever made: it reads as knowledge and
// behaves as a guess, and gate P7 is only ever as good as the geometry it is
// handed.
//
// So: every entry here carries the URL it came from and the date it was read,
// or it is flagged `generic` and wears no manufacturer's name. The research,
// including the sources that could NOT be read and what that cost, is in
// `docs/workholding-research.md`.
//
// WHAT `generic` MEANS HERE, exactly, because a boolean invites a lazy reading:
//   generic: false -> EVERY number in the entry came from the cited page, or is
//                     exact arithmetic on numbers from it, shown in `notes`.
//   generic: true  -> at least ONE number is a stand-in you must replace by
//                     measuring at your own bed. A `source` may still be
//                     present: it backs the numbers `notes` names and not the
//                     others. "Generic" is not "we made it up" — it is "do not
//                     trust every field".
//
// ⚠ AND `generic: true` COVERS A SECOND, DIFFERENT KIND — added 2026-08-31,
// because the sentence above prescribes a remedy that does not reach it.
//
//   (a) a STAND-IN number: no published value, so a plausible one sits there.
//       Remedy: measure at your own spoilboard. It is your setup, so you can.
//   (b) a real published number whose MEANING is inferred — the value is the
//       vendor's, but which axis/datum it belongs to was reasoned, not read.
//       Remedy: measure THE PART. That needs the part.
//
// The difference is not pedantic. An operator told "some fields are stand-ins"
// scans for an obviously invented figure; in a (b) entry every number carries a
// citation, none looks invented, and they conclude the entry is sound — while
// the actual risk is that two REAL numbers are the wrong way round.
// `machinable-low-profile-clamp` is the (b) case, and `bom` confirmed on
// 2026-08-31 that no MB.26077 has ever been bought by this company, so its
// remedy is blocked on a PURCHASE and is not merely outstanding. A remedy
// nobody can perform is not a plan; it is a condition on ever trusting the
// entry, and it is written as one.
//
// 🔴 DATUM. `heightMm` is ALWAYS measured from the BED, because that is what
// `core/src/fixture.rs` `Clamp.height_mm` means and what `clearance_z()`
// converts from. Vendors publish three other datums — "above the material",
// "height under clamp arm", "max stock thickness" — and on 18mm ply those
// differ by more than the whole standing height of a low-profile clamp. Where a
// number here was converted, the arithmetic is written out in `notes`. Nothing
// checks it, which is why it is written down.
//
// 🔴 WHAT `clearance_z()` ACTUALLY DOES — CORRECTED 2026-08-10, measured, and
// three entries below said the opposite of this until today.
//
// They said a tall entry "makes clearance_z() demand 34mm on EVERY rapid". It
// does not. `clearance_z()` LIFTS NOTHING, and no rapid in this tree is ever
// raised by a clamp. Every rapid is emitted at bare `machine.safe_z_mm` — the
// six `Move::rapid(...)` sites in `core/src/toolpath.rs` are the only places a
// rapid's Z is chosen and all six use `machine.safe_z_mm`, and the post's
// retract lines repeat it. Measured on this box 2026-08-10 with the release CLI:
// a 55mm clamp declared clear of the path, and every `G0 Z` in the emitted
// program is 5.0 — the default safe Z. `clearance_z` would have been
// 55 - 18 + 2 = 39, and no Z word carries it.
//
// What it IS: the THRESHOLD inside `Fixturing::check`. A rapid that crosses a
// declared clamp's footprint — widened by the cutter radius, and since
// 2026-08-10 walked as the SWEPT segment rather than sampled at the move's
// destination — while below `clearance_z` becomes
// `FixtureFinding::RapidBelowClamp`. That finding is FATAL:
// `JobResult::is_runnable` excludes only `Undeclared`, so the job is REFUSED.
// The tool refuses rather than flying higher, deliberately: silently raising a
// rapid would be the CAM choosing a hold-down clearance from a height nobody
// verified against the bed. So the consequence of a tall entry is a REFUSED
// PROGRAM, not a raised rapid, and it is scoped to rapids that actually cross
// that footprint rather than to every rapid in the job.
//
// ⚠ WHAT WOULD MAKE THIS PARAGRAPH STALE — one thing, and it is not subtle:
// ⚠ AND THE SWEEP THAT WROTE THIS PARAGRAPH MISSED A PARAPHRASE SEVENTY LINES
// BELOW IT. `toggle-clamp-vertical`'s own `notes` — rendered in the picker's
// property pane, so an operator reads it — said *"why every rapid over this must
// be LIFTED"* until 2026-08-28, in the same file as this correction. It survived
// because the sweep grepped the retracted SENTENCE ("on every rapid") and this
// one is a paraphrase. **Grep the CLAIM, not the wording**: `lift`, `every
// rapid`, `must clear`. Three more paraphrases were found the same way, in
// `workholdingShape.tsx` and in the SVG leader itself.
//
// wiring a lift. `Fixturing::clearance_z`'s own doc names the condition ("it has
// to reach `crate::toolpath`'s rapid emission AND the post's own retract
// lines"). Before quoting this note or the entries below, grep where a rapid's Z
// is chosen in `core/src/toolpath.rs`. That single artefact settles it.
//
// (Provenance, because it is the reason the wrong sentence was believable: the
// core's OWN doc comments on `clearance_z` said "lifts every rapid above the
// tallest clamp" until 2026-08-10, and that is where this file's claim came
// from. The core has since corrected itself and now carries the same "threshold,
// not a lift" wording. Two files independently reached the same reading of the
// same code — which is exactly how a wrong claim survives a review.)
//
// 🔴 `obstructs: false` IS NOT ONE FACT. Three entries below carry it and they
// mean different things: a vacuum table has NOTHING there; tape has something
// there and it is 0.1mm thick; composite nails have something there that is
// full-depth and deliberately cuttable. Gate E5 exists to stop "no clamps
// declared" being read as "clamps checked"; this is the same distinction one
// level down, and the boolean cannot hold it. Read `notes` before trusting it.
//
// 🔴 `resists` IS NOT CONSUMED BY ANYTHING YET, and it is the most important
// field in the file. `Clamp` today is pure geometry-to-avoid, so `Fixturing`
// cannot tell a fence from a toggle clamp — it will bless a side-pressure setup
// whose finishing pass is a full-depth profile with an upcut cutter. P7 protects
// the CLAMP from the tool; nothing yet protects the PART from coming loose.
// The field is here so the catalogue records the fact before the checker exists.
//
// NO PRICES. Purchasing is `bom`'s lane. Items a shop would have to buy are
// listed for a bom ticket at the end of the research doc, not costed here.

/** Where a sourced claim came from, and when it was true. */
export interface WorkholdingSource {
  url: string;
  /** ISO date the page was actually read. Not the date it was published. */
  read: string;
}

export interface Workholding {
  id: string;
  /** Never a manufacturer's name unless the entry earned it — see `generic`. */
  name: string;
  /** What this one is for, and why you would pick it over its neighbours. */
  detail: string;
  generic: boolean;
  source?: WorkholdingSource;
  /** Above the BED, mm. Not above the stock. See the datum note above. */
  heightMm: number;
  /** Keepout footprint [w, h] in mm. `[0, 0]` means it takes no bed area. */
  footprintMm: [number, number];
  /** Whether it puts anything in the toolpath's way. See the note above: this
   *  boolean is coarser than the truth for three of these entries. */
  obstructs: boolean;
  /** What it actually holds against. `[]` is legal and meaningful — a dog-hole
   *  grid holds nothing by itself. */
  resists: ('lift' | 'lateral')[];
  notes: string;
}

export const WORKHOLDING: Workholding[] = [
  // ---------------------------------------------------------------- toggle --
  {
    id: 'toggle-clamp-vertical',
    name: 'Toggle clamp, vertical hold-down',
    detail:
      'The strongest mechanical hold in this list and the tallest obstruction ' +
      'in it. Pick it when the part must not move and you can keep the toolpath ' +
      'well clear; it is the case RapidBelowClamp exists for.',
    generic: true,
    source: { url: 'https://www.destaco.com/210-U', read: '2026-08-08' },
    heightMm: 42.4,
    footprintMm: [141, 45],
    obstructs: true,
    resists: ['lift'],
    notes:
      'SOURCED from DESTACO 210-U: overall length 5.54in = 140.7mm, arm 3.63in ' +
      '= 92.2mm, clamp arm height 1.67in = 42.4mm, capacity 600lbf (~2669N). ' +
      'GENERIC in one field: DESTACO publishes NO base/flange footprint, so the ' +
      '45mm width here is a stand-in — measure your own. Lateral resistance is ' +
      'friction only; the bar presses down, it does not key into the stock. ' +
      '42mm above the spoilboard against a 5mm default safe Z is why a rapid that ' +
      'crosses this footprint is REFUSED rather than raised — clearance_z is a ' +
      'threshold, not a lift, and it is scoped to the moves that actually pass over ' +
      'it. Mounts off the workpiece and reaches over the edge, so ' +
      'it costs perimeter on the edge it grips.',
  },
  {
    id: 'toggle-clamp-horizontal',
    name: 'Toggle clamp, horizontal hold-down (low clearance)',
    detail:
      'Half the height of the vertical clamp — and its published clearance is ' +
      'LESS than an 18mm workpiece, so on this lane’s stock it cannot close at ' +
      'all. Here so the picker can say that before four of them are bought.',
    generic: true,
    source: { url: 'https://www.destaco.com/213-U', read: '2026-08-08' },
    heightMm: 16.5,
    footprintMm: [103, 35],
    obstructs: true,
    resists: ['lift'],
    notes:
      'SOURCED from DESTACO 213-U: overall length 4.05in = 102.9mm, arm 1.42in ' +
      '= 36.1mm, HEIGHT UNDER CLAMP ARM 0.65in = 16.5mm, capacity 150lbf ' +
      '(~667N). GENERIC: no base footprint published; the 35mm width is a ' +
      'stand-in. 🔴 16.5mm < 18mm ply: this clamp will not close over the stock ' +
      'this lane cuts, sitting flat on the spoilboard. "Clamp height" and "the ' +
      'thickness it can clamp" are different numbers that both get called height.',
  },

  // ------------------------------------------------------------ low-profile --
  {
    id: 'edge-clamp-low-profile',
    name: 'Low-profile edge clamp, T-track mounted',
    detail:
      'The only entry whose vendor publishes every number a CAM needs, ' +
      'including how far it intrudes onto the workpiece. Pick it when the toolpath ' +
      'has to pass close to the hold-down.',
    generic: false,
    source: {
      url: 'https://idcwoodcraft.com/products/edgehugger-four-clamp-kit-for-t-track-with-hex-screwdriver-toolquest-brand',
      read: '2026-08-08',
    },
    heightMm: 23.6,
    footprintMm: [25.4, 18.3],
    obstructs: true,
    resists: ['lift', 'lateral'],
    notes:
      'ToolQuest EdgeHugger (IDC Woodcraft). Published: 0.22in = 5.6mm ABOVE ' +
      'THE MATERIAL; footprint 1.00 x 0.72in = 25.4 x 18.3mm; body 0.45in = ' +
      '11.4mm; EDGE INTRUSION 0.23in = 5.8mm; stock 3/16in (5mm) to 1-1/2in ' +
      '(38mm); M6 flat-head 20-60mm; 1/4in or 5/16in T-track. 🔴 DATUM ' +
      'ARITHMETIC: 5.6mm above the material + 18mm ply = 23.6mm above the spoilboard. ' +
      'CHANGE THIS if your stock is not 18mm. The 5.8mm edge intrusion is the ' +
      'one hard answer anywhere in this catalogue to "what does clamping cost me ' +
      'in usable workpiece" — per clamped edge.',
  },
  {
    id: 'machinable-low-profile-clamp',
    name: 'Machinable low-profile wedge clamp',
    detail:
      'The lowest mechanical hold in this catalogue by a factor of six, and one ' +
      'of only two that resists BOTH lift and lateral. 🔴 It is a MILLING ' +
      'fixture part: it wants a tapped hole, not a spoilboard, and "machinable" ' +
      'does not mean a router bit may hit it.',
    generic: true,
    source: { url: 'https://www.newmantools.com/miteebite/m_pitbull.htm', read: '2026-08-08' },
    heightMm: 6.35,
    /* [ACROSS the clamped edge, ALONG it] — CORRECTED 2026-08-31, was
     * [25.4, 18.0]. See the ANSWER paragraph in `notes`. */
    footprintMm: [18.0, 25.4],
    obstructs: true,
    resists: ['lift', 'lateral'],
    notes:
      'Mitee-Bite Pitbull, model MB.26077 (machinable) / MB.26075 (standard, ' +
      'same body). Published on the cited table and its sibling ' +
      'https://www.newmantools.com/miteebite/pitbull.htm (both read 2026-08-08): ' +
      'D = 0.250in = 6.35mm, and the table legend states "D is clamp height"; ' +
      'clamp width C = 1.00in = 25.4mm; screw 3/8-16; torque 30.0 ft-lb; max ' +
      'holding force 6000 lbf (~26.7kN); TOTAL THROW 0.050in = 1.27mm; ' +
      'machinable version is tool steel heat treated to ~43RC. Mechanism, ' +
      'verbatim: "Positive down force", "High vertical and horizontal clamping ' +
      'forces", "High resistance to rip-out" — which is why `resists` carries ' +
      'both, and it is the only entry here besides screws that does. ' +
      'GENERIC IN ONE FIELD: the 18.0mm is E = 0.710in, and the page legends ' +
      'ONLY D — no letter is mapped to depth, so the second footprint number is ' +
      'INFERRED from the dimension letter, not read from a caption. ' +
      '🔴 ANSWERED 2026-08-31 BY `bom`, AND THE ORDER WAS WRONG UNTIL THEN: ' +
      '18.0mm runs ACROSS the clamped edge and 25.4mm runs ALONG it, so this ' +
      'entry read [25.4, 18.0] and was TRANSPOSED. `bom` curl-ed the raw vendor ' +
      'HTML rather than an AI-summarised read (which drops column alignment) and ' +
      'recovered the MB.26077 row with headers intact: C = ClampWidth = 1.00in = ' +
      '25.4mm, named "width" TWICE in the same row, and E = 0.710in = 18.034mm. ' +
      'D = 0.250in = 6.35mm in that same row matches the height this entry ' +
      'already carried, which is what makes it the same table we were trusting. ' +
      '⚠ THE TWO NUMBERS ARE CERTAIN; THE AXIS ASSIGNMENT IS NOT. `bom` rates it ' +
      'moderate-high, read from clamp mechanics and a low-resolution vendor GIF ' +
      'cross-section — the vendor never writes "across" or "along" — and asks ' +
      'for a caliper on a real MB.26077 before this gates a cut. ' +
      '🔴 AND THERE IS NO SUCH UNIT TO CALIPER: `bom` grepped the sourcing ' +
      'ledger, every BOM and every fixturing doc on 2026-08-31 for Pitbull / ' +
      'Mitee-Bite / MB.26077 / MB.26075 / MB.26088 — every hit in the repo is ' +
      'this app\'s own catalogue entry. The company has never bought one. So ' +
      'the check is blocked on a PURCHASE, not scheduled: do not read the ' +
      'caliper line as pending work somebody owns. Nobody owns it, and an ' +
      '"owed by someone else" line that goes stale reads as diligence and stops ' +
      'being re-checked. It is not ' +
      'measured, and a keepout that LOOKS measured is the failure this catalogue ' +
      'exists to avoid, so the open check is stated here rather than closed by ' +
      'the arrival of an answer. ⚠ TRANSPOSING IT BACK IS NOT SAFE-BY-DEFAULT ' +
      'EITHER: the two extents differ by 7.4mm, so whichever way it is wrong, ' +
      'P7 clears a rapid over 7.4mm of steel it thinks is spoilboard. ' +
      '🔴 TWO WARNINGS THE HEIGHT WILL MAKE YOU FORGET. (1) "MACHINABLE" IS A ' +
      'MACHINIST\'S WORD: it means you may mill the jaw to a profile as a setup ' +
      'step, with a metal cutter, at machining speeds. Tool steel at 43RC is ' +
      'NOT a router bit at 18000rpm surviving a strike, and this is a different ' +
      'claim from the composite nails entry below, which is about the CUTTER ' +
      'surviving. (2) It mounts by "Drill and tap a hole for the cap screw" — ' +
      '3/8-16 into MDF is not a fixing. It needs a tapped fixture plate or ' +
      'threaded inserts, which is a mounting surface this lane has not confirmed ' +
      'exists. ' +
      'Its 1.27mm throw is even less than the cam clamp\'s 1.6mm: same silent ' +
      'failure, undersize stock loose while the clamp looks engaged.',
  },
  {
    id: 't-track-hold-down',
    name: 'T-track hold-down clamp, plastic-armed',
    detail:
      'The ordinary bar-over-the-edge clamp, in the version whose arm breaks ' +
      'before your cutter does. Pick it for general work; do not read ' +
      '"bit-saver" as "collision-safe".',
    generic: true,
    source: {
      url: 'https://www.rockler.com/rockler-bit-saver-hold-down-clamps-5-1-2l-x-1-1-4w-2-pack',
      read: '2026-08-08',
    },
    heightMm: 55,
    footprintMm: [139.7, 31.8],
    obstructs: true,
    resists: ['lift'],
    notes:
      'SOURCED from Rockler Bit-Saver: 5-1/2 x 1-1/4in = 139.7 x 31.8mm, reach ' +
      '2-1/2in to 3-5/8in, max stock 2-1/2in = 63.5mm, 5/16"-18 x 4in T-bolt ' +
      'with aluminium threads, glass-filled ABS arms. 🔴 GENERIC IN THE FIELD ' +
      'THAT MATTERS MOST: Rockler publishes NO standing height on any hold-down ' +
      'page read — the 55mm here is a stand-in for stock + arm + knob and MUST ' +
      'be measured. (Re-checked 2026-08-08 at a second Rockler hold-down page, ' +
      'https://www.rockler.com/hold-down-clamp-5-1-2l-x-1-1-8w: length, width ' +
      'and T-bolt given, still NO height. It is not an oversight on one page.) ' +
      '⚠ THE STAND-IN IS PROBABLY LOW: the `t-track-hold-down-cnc` entry above ' +
      'is a comparable clamp whose vendor DOES publish a height, and it is ' +
      '60mm. That is a sanity band, NOT a value to copy here — a family ' +
      'analogue is not this part\'s figure. The vendor claim is that a strike ' +
      'breaks the clamp, not the ' +
      'cutter; that is a claim about the CONSEQUENCE, not about the collision, ' +
      'and the steel T-bolt is what a cutter actually meets.',
  },

  {
    id: 't-track-hold-down-cnc',
    name: 'T-slot hold-down clamp, CNC spoilboard (M6)',
    detail:
      'The same idea as the Rockler bar above, from a CNC-router vendor that ' +
      'actually publishes the height. Here because it is the ONLY hold-down ' +
      'anywhere in this research whose standing height is a fact.',
    generic: false,
    source: {
      url: 'https://www.nymolabs.com/products/2pcs-t-track-hold-down-clamp-for-m6-t-slot-nut-15-x-16mm0-6-x-0-6-80mm-length',
      read: '2026-08-08',
    },
    heightMm: 60,
    footprintMm: [79, 20],
    obstructs: true,
    resists: ['lift'],
    notes:
      'Published verbatim: "Dimensions: 79mm length x 20mm width x 60mm ' +
      'height."; "Made of Aluminum Alloy with high durability and wear ' +
      'resistance."; for an M6 T-slot nut and a 6mm (0.24in) threaded hole; ' +
      'spring-loaded. 🔴 THIS IS THE NUMBER THE ROCKLER ENTRY IS MISSING, AND ' +
      'IT IS BIGGER THAN THE GUESS. The 55mm stand-in on `t-track-hold-down` ' +
      'was LOW: a comparable clamp measures 60mm. ⚠ DO NOT COPY 60mm ONTO THE ' +
      'ROCKLER ENTRY — a family-analogue figure is not the part\'s figure, and ' +
      'the two clamps differ in bolt size, arm material and reach. It is a ' +
      'sanity band for the guess, not a replacement for a measurement. ' +
      'INTERNAL INCONSISTENCY ON THE VENDOR\'S OWN PAGE, recorded rather than ' +
      'resolved: the title says "80mm-Length" and the body says 79mm; the ' +
      'title\'s "15 x 16mm" is the T-SLOT it fits, not the clamp. ' +
      'NOT PUBLISHED: holding force, maximum stock thickness, and the reach ' +
      'onto the workpiece — so the intrusion cost of this one is still unknown.',
  },

  // --------------------------------------------------------- side pressure --
  {
    id: 'inline-cam-clamp',
    name: 'Inline cam clamp, T-track (side pressure)',
    detail:
      'Pushes sideways against a fence and stays low. 🔴 Resists NOTHING in Z — ' +
      'pick it only when the part cannot lift, and read the cam-throw note ' +
      'before trusting it on undersize stock.',
    generic: false,
    source: { url: 'https://www.rockler.com/rockler-t-track-inline-cam-clamp', read: '2026-08-08' },
    heightMm: 31.8,
    footprintMm: [38.1, 54.0],
    obstructs: true,
    resists: ['lateral'],
    notes:
      'Rockler T-track inline cam clamp. Published: 1-1/2in W x 2-1/8in L x ' +
      '1-1/4in H = 38.1 x 54.0 x 31.8mm; clamp face 1-1/2 x 5/8in = 38.1 x ' +
      '15.9mm; CAM THROW 1/16in = 1.6mm; 5/16in T-bolt; rubber-faced. ' +
      '🔴 TWO SILENT FAILURES. (1) It does nothing about lift: an upcut cutter ' +
      'in 18mm ply pulls up, and the offcut is free the instant it is severed. ' +
      '(2) Total throw is 1.6mm, so stock 2mm undersize is not held at all AND ' +
      'THE CLAMP STILL LOOKS ENGAGED. Costs perimeter on at least two edges — ' +
      'the fence side and the pressure side.',
  },
  {
    id: 'fence-and-side-pressure',
    name: 'Fence + side pressure (setup, not a part)',
    detail:
      'A strip screwed to the spoilboard with the stock pushed against it. The ' +
      'cheapest way to keep the top of the workpiece completely clear — and the ' +
      'setup that most needs a lift check the app does not yet have.',
    generic: true,
    heightMm: 14,
    footprintMm: [30, 400],
    obstructs: true,
    resists: ['lateral'],
    notes:
      'GENERIC THROUGHOUT — no product, no published dimensions. Both numbers ' +
      'are stand-ins: a fence is whatever strip is to hand and must be THINNER ' +
      'than the stock or the cutter hits it, and its length is whatever edge it ' +
      'runs along. Set both from your own machine. 🔴 Resists lateral only. ' +
      'Toolstoday’s survey (read 2026-08-08) also warns it works only on ' +
      'flat stock — bowed material defeats it entirely. Eats one whole edge of ' +
      'the workpiece plus the pressure side.',
  },

  // ---------------------------------------------------------------- vacuum --
  {
    id: 'vacuum-pod-console',
    name: 'Vacuum pod, console type',
    detail:
      'A tall block the workpiece sits ON TOP OF. 🔴 The obstruction is UNDER ' +
      'the stock, not beside it — which is the one case the app’s clamp ' +
      'model gets actively wrong. Read the notes before declaring one.',
    generic: false,
    source: {
      url: 'https://www.ricocnc.com/products/178-VCBL-K1-125x75x50-R-Longways-Schmalz-1-circuit-Console-Vacuum-Suction-Cups-for-CNC.html',
      read: '2026-08-08',
    },
    heightMm: 50,
    footprintMm: [125, 75],
    obstructs: true,
    resists: ['lift', 'lateral'],
    notes:
      'Schmalz VCBL-K1 125x75x50, 1-circuit console pod: the part number ' +
      'encodes 125 x 75mm footprint, 50mm tall. K2 (2-circuit) variants are ' +
      '100mm tall. 🔴 DO NOT FEED THIS TO `Fixturing` AS AN ORDINARY CLAMP. A ' +
      'rapid over a pod is completely safe (the pod is below the workpiece), but ' +
      'height_mm = 50 puts clearance_z() at 50 - 18 + 2 = 34mm, and any rapid ' +
      'crossing the pod\'s footprint at the 5mm safe Z is then RapidBelowClamp — ' +
      'which REFUSES the whole program. A false red, and false reds get muted. ' +
      '⚠ CORRECTED 2026-08-10: this note used to say the 34mm was "demanded on ' +
      'EVERY rapid". It is demanded on none — clearance_z lifts no rapid, it is ' +
      'only the threshold the check compares against, and it is scoped to ' +
      'rapids over THIS footprint. See the clearance_z note at the top of this ' +
      'file. Meanwhile the real ' +
      'failure, a through-cut into the pod, is caught in XY only by accident ' +
      'because the model has no notion of depth. The core cannot say "under" yet.',
  },
  {
    id: 'vacuum-block-low-profile',
    name: 'Vacuum block, low-profile (grid table)',
    detail:
      'Half the height of the console pod and the same idea: the workpiece sits ON ' +
      'it. Pick it when the pod has to be short — but note it wants a GRID ' +
      'table, not a console, so it is not a drop-in for the pod above.',
    generic: false,
    source: {
      url: 'https://www.schmalz.com/en-us/products/vacuum-clamping-technology-309409/vacuum-clamping-technology-for-wood-309410/clamping-equipment-for-grid-table-systems-309674/vacuum-blocks-vcbl-r-50-309675/10.01.12.02674',
      read: '2026-08-08',
    },
    heightMm: 25,
    footprintMm: [160, 160],
    obstructs: true,
    resists: ['lift', 'lateral'],
    notes:
      'Schmalz VCBL-R 160x160x25 30/50 TV, part number 10.01.12.02674. Read ' +
      'off the vendor\'s OWN design-data table (not a reseller, unlike the ' +
      'console pod above): L 160mm, W 160mm, H 25mm, weight 0.63kg, grid 30/50, ' +
      'recommended slot 6.5mm wide x 7.5mm deep; plastic main body with top ' +
      '(VCDR) and bottom sealing frames. The family page lists heights 25 / 45 ' +
      '/ 125mm and footprints 160x160 or 160x96mm. 🔴 SAME "UNDER, NOT BESIDE" ' +
      'WARNING AS THE CONSOLE POD, and it is milder but not gone: at 25mm, ' +
      'height_mm = 25 puts clearance_z() at 25 - 18 + 2 = 9mm instead of 34mm, ' +
      'so a rapid crossing this footprint at the 5mm safe Z still trips ' +
      'RapidBelowClamp and still refuses the program. A smaller false red is ' +
      'still a false red. ⚠ CORRECTED 2026-08-10 with the pod above: nothing is ' +
      '"demanded on every rapid" — see the clearance_z note at the top of this ' +
      'file for what it does and what it does not. ' +
      '⚠ NOT A SUBSTITUTE FOR THE POD ABOVE: VCBL-R mounts on a GRID table, ' +
      'VCBL-K1 on a CONSOLE. Every VCBL-K1 variant found is 50mm or taller, so ' +
      'the short option only exists by changing families — and the machine has ' +
      'to have the matching table. 🔴 NO HOLDING FORCE ANYWHERE: no Schmalz ' +
      'page read publishes N or bar for any of these blocks. The catalogue has ' +
      'a force figure for every mechanical clamp and NONE for vacuum.',
  },
  {
    id: 'vacuum-table-full',
    name: 'Full vacuum table (plenum + gasket + bleeder board)',
    detail:
      'The only entry that genuinely puts nothing above the spoilboard. Pick it for ' +
      'sheet goods — but note that its hold is proportional to sealed area, and ' +
      'the cut destroys the seal as it goes.',
    generic: true,
    source: { url: 'https://www.cnccookbook.com/router-vacuum-table-cnc-diy/', read: '2026-08-08' },
    heightMm: 0,
    footprintMm: [0, 0],
    obstructs: false,
    resists: ['lift', 'lateral'],
    notes:
      'GENERIC: a machine feature, not a product, so no model number and no ' +
      'dimensions. SOURCED figures: 18inHg ~= 9psi and 24inHg ~= 12psi of ' +
      'hold-down (Woodworking Network, read 2026-08-08); a shop vac over an MDF ' +
      'spoilboard gives roughly 2-3psi, a venturi ~13psi but needs high CFM ' +
      'because the board leaks; sea-level ceiling is 14.7psi. 🔴 THIS IS THE ' +
      'ONE HONEST `obstructs: false` — nothing is there. But the danger has no ' +
      'geometry: THE LAST SMALL PART CUT FROM A WORKPIECE IS HELD BY THE LEAST ' +
      'FORCE IT WILL EVER HAVE, at the moment it is most free to move. The ' +
      'mitigation is onion-skin/tabs, which this lane already emits. Porous ' +
      'stock (particle board, unsealed MDF) leaks enough that the pump rating ' +
      'is not the holding force.',
  },

  // -------------------------------------------------------------- adhesive --
  {
    id: 'double-sided-tape',
    name: 'Double-sided tape',
    detail:
      'Zero height, no keepout, no perimeter cost — and it needs area under the ' +
      'part, which a tight nest does not leave. Strong in shear, weak in peel.',
    generic: false,
    source: { url: 'https://shop.carbide3d.com/products/double-side-tape', read: '2026-08-08' },
    /* 0.127mm = the published 5 mil. CORRECTED 2026-08-31, was `0.13` — a
     * rounding of this entry's own cited figure that had become the fact, with
     * the real number sitting three lines below it in `notes`. */
    heightMm: 0.127,
    footprintMm: [0, 0],
    obstructs: false,
    resists: ['lateral'],
    notes:
      'Carbide 3D CNC tape, published: 0.75in = 19.05mm wide x 36yd, 5 mil = ' +
      '0.127mm thick, adhesion 66 oz/in. 0.127mm is below spoilboard flatness, ' +
      'so it is not a clearance concern. 🔴 `obstructs: false` HERE MEANS ' +
      '"0.1mm of something", not "nothing" — different from the vacuum table. ' +
      'Listed as resisting lateral only: it holds well in shear and fails in ' +
      'PEEL, and an upcut cutter at a freshly severed edge applies peel exactly ' +
      'where the bond is thinnest. NOT SOURCED: no published shear or lift ' +
      'figure for tape on plywood was found anywhere.',
  },
  {
    id: 'tape-and-ca-glue',
    name: 'Painter’s tape + CA glue',
    detail:
      'Tape on both faces, glued to each other. Same profile as double-sided ' +
      'tape and stronger; the failure surface is tape-to-wood, so dusty ply or a ' +
      'dirty spoilboard halves it.',
    generic: true,
    source: {
      url: 'https://millrightcnc.proboards.com/thread/2034/first-blue-tape-clamping-method',
      read: '2026-08-08',
    },
    heightMm: 0.3,
    footprintMm: [0, 0],
    obstructs: false,
    resists: ['lateral'],
    notes:
      'GENERIC: a method, not a product. The 0.3mm is a stand-in for two tape ' +
      'layers plus glue — no tape thickness was sourced (3M’s 410M data ' +
      'sheets both timed out and reseller listings disagree, 5.0 vs 6 mil). ' +
      'SOURCED practice (MillRight forum, read 2026-08-08): CA gel in ~1/4in ' +
      'drops every ~2in, pressed ~20s; blue tape peels cleaner than beige; used ' +
      'on plywood and solid wood to 1.250in. Same peel weakness as tape above, ' +
      'and it is not numerically sourced either.',
  },

  {
    id: 'hot-glue-bead',
    name: 'Hot-melt glue bead (perimeter fillet)',
    detail:
      'A bead run into the corner where the part edge meets the spoilboard. ' +
      'Not under the part — BESIDE it, on the line the profile pass takes. ' +
      '🔴 Nothing numeric is published about it anywhere.',
    generic: true,
    source: { url: 'https://info.lagunatools.com/cnc-hold-down-strategies', read: '2026-08-08' },
    heightMm: 5,
    footprintMm: [8, 130],
    obstructs: true,
    resists: ['lift', 'lateral'],
    notes:
      'GENERIC IN EVERY DIMENSION — the 5mm height and the 8mm bead width are ' +
      'both stand-ins and there is nothing to replace them with but a rule at ' +
      'your own machine. SOURCED TECHNIQUE ONLY (Laguna Tools, read 2026-08-08): ' +
      '"lay a bead of hot glue in the inside corner formed where the edges of ' +
      'the workpiece meet the surface of the spoil board", and explicitly ' +
      '"DO NOT put hot glue on the back of the workpiece". 🔴 THAT INSTRUCTION ' +
      'IS WHY THIS IS NOT A SECOND TAPE ENTRY. Tape lives UNDER the part and ' +
      'costs area; a glue bead lives AT THE PERIMETER and costs the toolpath — ' +
      'it sits exactly where a profile finishing pass runs, at full depth. ' +
      'Its keepout is therefore the part outline itself, which the app cannot ' +
      'express as a rectangle. 🔴 NO NUMBER EXISTS TO FIND: searched to a ' +
      'clean negative — Laguna gives no bond strength or bead size, and ' +
      'CNCCookbook\'s workholding guide does not list hot glue at all ' +
      '(both read 2026-08-08). Treat every figure here as a placeholder, and ' +
      'treat the method as untested by this lane.',
  },

  // ------------------------------------------------------------- fasteners --
  {
    id: 'screws-into-spoilboard',
    name: 'Screws into the spoilboard',
    detail:
      'The only method here that resists BOTH lift and lateral — and it pays ' +
      'for that by putting steel exactly where the cutter must not go, at full ' +
      'depth. Declare the positions and the app will refuse a path through them.',
    generic: true,
    source: {
      url: 'https://woodweb.com/knowledge_base/Screwing_Down_a_Spoilboard.html',
      read: '2026-08-08',
    },
    heightMm: 0,
    footprintMm: [20, 20],
    obstructs: true,
    resists: ['lift', 'lateral'],
    notes:
      'GENERIC: no product. The 20 x 20mm is a KEEPOUT, not a screw head — it ' +
      'must cover placement error plus the cutter radius, and the preset this ' +
      'replaces used 12mm, which is a head. SOURCED practice (WoodWeb + ' +
      'CNCCookbook, read 2026-08-08): countersink heads ~3/16in = 4.8mm below ' +
      'the surface, some prefer 3/8in = 9.5mm; use screws SHORTER than the ' +
      'spoilboard is thick; coarse-thread pocket screws grip MDF; and "hitting ' +
      'one of the screws with a cutter will often break the cutter". ' +
      '🔴 heightMm is 0 ON PURPOSE: a countersunk screw stands nothing above ' +
      'the spoilboard, so it must force no rapid lift. ITS KEEPOUT POINTS DOWN, not ' +
      'up — the whole danger is in XY at full depth, which CutsClamp does catch.',
  },
  {
    id: 'composite-nails',
    name: 'Composite nails (polymer/fibreglass)',
    detail:
      'Driven flush, hold like nails, and are meant to be cut straight through ' +
      'without damaging the cutter. The one entry where something IS in the ' +
      'path and that is deliberately fine.',
    generic: true,
    source: { url: 'https://raptornails.com/product-applications/cnc-woodwork.php', read: '2026-08-08' },
    heightMm: 0,
    footprintMm: [0, 0],
    obstructs: false,
    resists: ['lift'],
    notes:
      'SOURCED claims (raptornails.com applications page): polymer/fibreglass ' +
      'blend, square profile, dedicated pneumatic guns, "can be machined ' +
      'through without damage to your CNC tooling", roughly twice the tensile ' +
      'holding of conventional nails. ✅ THE LENGTH TABLE, MISSING ON THE FIRST ' +
      'PASS, WAS SOURCED ON RETRY at https://raptornails.com/store/product/' +
      '18-gauge-brad/ (read 2026-08-08): RAPTOR B/18 18-gauge composite brads ' +
      'B/18-044 = 7/16in (11.1mm), B/18-063 = 5/8in (15.9mm), B/18-080 = 3/4in ' +
      '(19.05mm), B/18-100 = 1in (25.4mm); "Completely Non-Metal"; "Sawable, ' +
      'Sandable & Stainable"; driven by an OMER 12P.25H. The 14/15-gauge F/14 ' +
      'and F/15 finish nails run 1/2in to 2-1/4in (12.7-57.2mm). ' +
      '🔴 LENGTH IS A CAM FACT, NOT A PURCHASING ONE: the longest 18-gauge brad ' +
      'is 25.4mm, so through 18mm ply it leaves ~7mm IN THE SPOILBOARD — which ' +
      'is where the surfacing pass goes. A 2-1/4in F/14 leaves ~39mm. ' +
      'STILL GENERIC, AND NOW FOR EXACTLY ONE REASON: no shank diameter is ' +
      'published in mm or inches on any page read, only the gauge, so the ' +
      '[0, 0] footprint is a deliberate "no keepout declared" and not a ' +
      'measurement. ⚠ NOTE THE TWO VENDOR CLAIMS ARE NOT THE SAME CLAIM: ' +
      '"machined through without damage to your CNC tooling" (applications ' +
      'page) is about the CUTTER surviving; "Sawable, Sandable & Stainable" ' +
      '(product page) is about the NAIL yielding. Only the first is a safety ' +
      'claim, and it is still only the vendor\'s word. 🔴 THIRD MEANING OF ' +
      '`obstructs: false`: vacuum = nothing is there; tape = 0.1mm is there; ' +
      'THIS = something full-depth and nail-shaped is there and is cuttable ON ' +
      'THE VENDOR’S WORD. Flattening those three into one boolean is the ' +
      'error gate E5 exists to prevent, one level down.',
  },

  // ----------------------------------------------------------------- grids --
  {
    id: 'dog-hole-grid-20mm',
    name: '20mm dog-hole grid (the grid, not the clamp)',
    detail:
      'A spoilboard pattern, not a hold-down: it holds nothing and blocks nothing. It ' +
      'is here because it QUANTISES where any clamp can go — 96mm or not at all.',
    generic: true,
    source: {
      url: 'https://festoolownersgroup.com/threads/mft-bench-dog-hole-clamping.59396/',
      read: '2026-08-08',
    },
    heightMm: 0,
    footprintMm: [0, 0],
    obstructs: false,
    resists: [],
    notes:
      'SOURCED (Festool Owners Group + Sawmill Creek, read 2026-08-08): 20mm ' +
      'holes on 96mm centres, the Festool MFT pattern, commonly CNC-cut at ' +
      '20.05mm for a slip fit; Bessey auto-adjust toggle clamps ship with 20mm ' +
      'and 3/4in mounting plates. GENERIC: whatever goes IN a hole has its own ' +
      'height and is a different entry. `resists: []` is deliberate and legal — ' +
      'an empty list is the honest answer for a feature that holds nothing. The ' +
      'CAM consequence is placement, not clearance: a clamp cannot be nudged ' +
      '20mm to clear a toolpath, it moves 96mm or it does not move.',
  },

  {
    id: 'dog-hole-bench-dog',
    name: 'Bench dog + opposing wedges (what goes IN the grid)',
    detail:
      'The grid above holds nothing; this is the thing that does. Dogs are ' +
      'stops, the wedges squeeze against them — so the top of the workpiece stays ' +
      'clear and NOTHING holds it down.',
    generic: true,
    source: { url: 'https://www.woodpeck.com/2096-workholding-kit-19.html', read: '2026-08-08' },
    heightMm: 17.8,
    footprintMm: [20, 20],
    obstructs: true,
    resists: ['lateral'],
    notes:
      'Woodpeckers 2096 workholding kit. Published verbatim: "Above the table ' +
      'the dogs stand 1/8", 3/8", 0.7" or 2"." = 3.2 / 9.5 / 17.8 / 50.8mm, ' +
      'four INTERCHANGEABLE dogs plus an adjustable support dog to 2-1/2in; ' +
      '"The shafts of the solid aluminum dogs are turned ... to a 20mm diameter ' +
      'for the first 7/8 of an inch"; 20mm holes on 96mm centres; wedges are ' +
      '1/4in solid phenolic, one fixed and one floating, tapped together. ' +
      '🔴 heightMm IS A CONFIGURATION, NOT A PROPERTY — the object has FOUR ' +
      'published heights and this entry carries the 0.7in one. SET IT TO THE ' +
      'DOG YOU ACTUALLY FITTED; the 2in dog is 50.8mm, TALLER THAN THE DESTACO ' +
      'TOGGLE CLAMP, and entering 17.8 while a 2in dog is in the spoilboard is a false ' +
      'green on the tallest obstruction in the whole catalogue. ' +
      '⚠ THE 0.7in DOG IS 17.8mm AND THE STOCK IS 18mm, so it sits 0.2mm BELOW ' +
      'the surface. That is the one case the current model handles CORRECTLY ' +
      'and by construction: clearance_z() is ' +
      'safe_z.max((17.8 - 18).max(0) + 2) = max(5, 2) = 5mm, exactly the ' +
      'default safe Z, so a rapid crossing this dog at 5mm is NOT below the ' +
      'threshold and RapidBelowClamp does not fire — while CutsClamp still ' +
      'refuses a full-depth path through solid aluminium. Right answer, both ' +
      'directions, for once. ⚠ CORRECTED 2026-08-10: this read ' +
      '"17.8 - 18 + 2 = 1.8mm ... so no rapid is lifted", which got the ' +
      'arithmetic wrong (the negative is clamped to 0 before the +2, and the ' +
      'result is then floored at safe_z) and implied that a TALLER entry would ' +
      'lift a rapid. None of them do — see the clearance_z note at the top of ' +
      'this file. GENERIC: no head/body diameter is published ' +
      'anywhere read — the 20 x 20mm is the SHAFT diameter used as a stand-in, ' +
      'and the head is wider than the shaft. NO CLAMPING FORCE IS PUBLISHED. ' +
      'A separate route exists if a toggle clamp is wanted on the grid: the ' +
      'Bessey STC-SET-T20 adapter post is 20mm dia x 17mm tall with an M8 x ' +
      '8.2mm bolt, for 19-25mm table thickness (Lee Valley 110687, read ' +
      '2026-08-08) — but that is the POST; the clamp stacked on it is the ' +
      'obstruction and its height was not published on any page read.',
  },

  // -------------------------------------------------------- not a bed part --
  {
    id: 'spindle-pressure-foot',
    name: 'Spindle pressure foot',
    detail:
      'A plate on the spindle that presses the workpiece down AT the cut and travels ' +
      'with the tool. Not a machine-mounted feature at all — included so the ' +
      'catalogue does ' +
      'not imply every holding method is a rectangle on the machine.',
    generic: true,
    source: {
      url: 'https://www.ricocnc.com/products/74-DIY-CNC-Pressure-Foot-Clamping-Tool-Kit-for-CNC-Router-Spindle.html',
      read: '2026-08-08',
    },
    heightMm: 0,
    footprintMm: [0, 0],
    obstructs: false,
    resists: ['lift'],
    notes:
      'GENERIC: no dimensions sourced. 🔴 THIS CANNOT BE A `Clamp` IN ANY FORM ' +
      '— its position is a function of the toolpath, not a constant, so a ' +
      'fixed x/y/w/h is meaningless for it. Today it is expressible only by ' +
      'ticking `confirmed_clear`, which conflates "I have a holding method with ' +
      'no keepout" with "I looked and the machine is clear". Those are different ' +
      'facts and only one of them is a measurement. It also needs clearance ' +
      'around the cut, so it does not coexist with tall clamps.',
  },
];

/** Everything whose numbers all came from the cited page. */
export const SOURCED_WORKHOLDING = WORKHOLDING.filter((w) => !w.generic);

/** Everything carrying at least one stand-in number that must be measured. */
export const GENERIC_WORKHOLDING = WORKHOLDING.filter((w) => w.generic);
