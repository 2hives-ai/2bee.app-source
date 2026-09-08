// Standard sheet stock — the catalogue behind the sheet picker.
//
// 🔴 THIS FILE DELIBERATELY HAS NO DEFAULT, AND THAT IS THE POINT.
//
// The repo holds THREE live sheet-basis numbers and they disagree:
//
//     cnc_nest/README.md   2700 x 1200
//     ops                   600 x 900
//     bom (2026-07-18)     2400 x 1200
//
// Which one WE buy is `bom` + `ops`'s question, not this lane's. Shipping a
// default here would silently settle an open question by making one of the three
// the answer nobody had to choose. So every entry below is offered, none is
// pre-selected, and `DEFAULT_SHEET` does not exist. If you find yourself adding
// it, that is the decision leaving its owners.
//
// PROVENANCE. Every entry carries `source` (url + the date it was read) or is
// flagged `generic: true`. Generic means: this size is real in the trade but was
// not confirmed at a supplier page, so it must not be shown as though it were
// measured. A size wearing a source it did not earn is worse than one honestly
// labelled unverified — the operator can discount the second and cannot see
// through the first.
//
// 🔴 NOMINAL THICKNESS IS A LABEL, NOT A MEASUREMENT. `thickness_mm` lists what
// the market CALLS the sheet, not what a caliper reads. Two sourced examples:
//
//   * AU structural ply (AS/NZS 2269) has NO 18mm rung — Ecoply's own ladder runs
//     7/9/12/15/17/19/21/25. Yet "18mm" ply is sold here, and CHH's technical note
//     says its 18mm CMPC product substitutes where "17mm (or less) Ecoply has been
//     specified". So "18mm ply" spans at least two real thicknesses.
//   * Cast acrylic per ISO 7823-1 (ACRYLITE table): 18.0mm nominal is permitted
//     anywhere in 15.8-20.2mm. That is +/- 2mm on a through-cut depth.
//
// A through-cut depth taken from a value in this file is a GUESS. Measure the
// sheet. Full audit, with every source URL and read date, and the explicit list
// of what could NOT be sourced: `docs/materials-research.md`.
//
// This file is data only. It asserts nothing about feeds, depths or spindle
// speeds — those live in `core/src/tools.rs` and are a physical decision.

export type Region = 'AU' | 'EU' | 'US' | 'INTL';

export interface SheetSource {
  /** Where the dimension was read. */
  url: string;
  /** ISO date it was read. A live supplier page goes stale; the date says how stale. */
  read: string;
}

export interface SheetSize {
  id: string;
  name: string;
  /** Long dimension, mm. */
  w: number;
  /** Short dimension, mm. */
  h: number;
  /**
   * NOMINAL thicknesses the size is sold in, mm. See the header: nominal is a
   * label. Empty means the size is stocked across a range too wide to enumerate
   * honestly.
   */
  thickness_mm: number[];
  region: Region;
  /**
   * WHAT THE SHEET IS MADE OF — added 2026-08-11, founder: *"move the material
   * into the workpiece list, able to filter workpiece by material via a drop
   * down"*.
   *
   * 🔴 ABSENT MEANS THE SIZE DOES NOT STATE ONE, AND THAT IS A REAL ANSWER.
   * The four `sheet-*` entries are material-agnostic panel sizes — a US 4x8 is
   * sold in ply, MDF, acrylic and aluminium alike — so they carry nothing here
   * and are reported as NOT STATED. They are NOT filled in with the first
   * plausible material: the whole point of this field is that a picker can say
   * what a row is made of, and a guess in this field would make the picker say
   * it confidently.
   *
   * 🔴 IT IS A STRING, NOT A UNION, ON PURPOSE. The authority for what materials
   * exist is `core/src/tools.rs::Material`, reached at runtime through the wasm
   * library. A TypeScript union here would be a second copy of that list, and a
   * second copy DRIFTS SILENTLY — the core renames a material, this file still
   * compiles, and the app sets a material the planner does not have. Instead the
   * value is resolved against the library at runtime by
   * `jobMaterial.ts::resolveMaterial`, which reports a name the core does not
   * carry as UNKNOWN rather than coercing it to a neighbour. Drift is then a
   * visible refusal instead of an invisible substitution.
   *
   * ⚠ And it is NOT a feed input. Nothing here asserts a chipload, an rpm or a
   * depth; the material NAME travels, and every number derived from it stays in
   * `core/src/tools.rs`. That separation is what stops the material becoming a
   * second source of truth for a figure that reaches the spindle.
   */
  material?: string;
  /** Absent iff `generic` is true. */
  source?: SheetSource;
  /** True = real in the trade, NOT confirmed at a supplier page. */
  generic: boolean;
  /** What this size is for, and why it is in the list. Shown next to it. */
  detail: string;
}

const READ = '2026-08-08';

export const SHEET_SIZES: SheetSize[] = [
  // --- Plywood, AU ---------------------------------------------------------
  {
    id: 'ply-au-2400x1200',
    material: 'Plywood',
    name: 'Plywood 2400 x 1200 (AU standard)',
    w: 2400,
    h: 1200,
    thickness_mm: [7, 9, 12, 15, 17, 19, 21, 25],
    region: 'AU',
    source: {
      url: 'https://www.bunnings.com.au/structaply-2400-x-1200mm-19mm-plywood-structural-cd-grade_p0340167',
      read: READ,
    },
    generic: false,
    detail:
      'The dominant AU/NZ local-mill sheet, confirmed at three suppliers. This is ' +
      "bom's 2026-07-18 figure. Note the thickness ladder has NO 18mm rung — it " +
      'goes 15 -> 17 -> 19 (Ecoply AS/NZS 2269 spec guide), yet "18mm" ply is sold ' +
      'here. Do not read 18 into this list.',
  },
  {
    id: 'ply-au-2700x1200',
    material: 'Plywood',
    name: 'Plywood 2700 x 1200 (AU, second standard length)',
    w: 2700,
    h: 1200,
    thickness_mm: [7, 9, 12, 15, 17, 19, 21, 25],
    region: 'AU',
    source: {
      url: 'https://chhply.co.nz/assets/Uploads/EcoplySpecificationInstallationGuideCurrent.pdf',
      read: READ,
    },
    generic: false,
    detail:
      'A REAL second standard length, not a fringe size: the Ecoply specification ' +
      'guide names lengths of "2400mm and 2700mm" with a 1200mm nominal width. ' +
      "Softwood CD structural. This is cnc_nest/README.md's figure. That both it " +
      'and 2400x1200 are genuinely stocked is why the picker offers both rather ' +
      'than resolving them.',
  },
  {
    id: 'ply-au-2440x1220',
    material: 'Plywood',
    name: 'Plywood 2440 x 1220 (AU import / marine)',
    w: 2440,
    h: 1220,
    thickness_mm: [4, 6, 9, 12, 15, 18, 25],
    region: 'AU',
    source: {
      url: 'https://www.bunnings.com.au/2440-x-1220mm-12mm-plywood-hardwood-marine-aa-grade-12mm_p0320024',
      read: READ,
    },
    generic: false,
    detail:
      'The metric-4x8ft import size, sold in AU on marine and imported-hardwood ' +
      'lines ALONGSIDE 2400x1200 at the same retailers. The 40mm/20mm difference ' +
      'is the one that makes a nest overhang: two different sheets, one shop. ' +
      'Thickness list is the import ladder and DOES carry 18mm, unlike the local ' +
      'structural ladder above.',
  },
  {
    id: 'ply-au-1800x1200',
    material: 'Plywood',
    name: 'Plywood 1800 x 1200 (AU)',
    w: 1800,
    h: 1200,
    thickness_mm: [12, 15, 17, 18, 19, 21],
    region: 'AU',
    source: {
      url: 'https://www.blackwoods.com.au/hardware-building-construction-materials/building-essentials/timber-plywood/big-river-group-armourply-hardwood-plywood-structural-f27-dd-2400-x-1200-x-18mm/p/04311136',
      read: READ,
    },
    generic: false,
    detail:
      'Stocked short sheet (ArmourPly hardwood structural, formply). Useful when ' +
      'a hive cut-pack does not fill a full sheet and the offcut would be waste.',
  },
  {
    id: 'ply-au-handy-1200x900',
    material: 'Plywood',
    name: 'Plywood handy panel ~1200 x 900 (AU)',
    w: 1200,
    h: 900,
    thickness_mm: [6, 9, 12, 15, 18],
    region: 'AU',
    generic: true,
    detail:
      'GENERIC — precut panels of about this size ARE sold, but the AU precut range ' +
      'clusters on 1200 x 896/897, not on a round 900. Treat the 900 as approximate ' +
      'and measure the actual panel before nesting to the edge.',
  },
  {
    id: 'ply-au-handy-900x600',
    material: 'Plywood',
    name: 'Plywood handy panel ~900 x 600 (AU)',
    w: 900,
    h: 600,
    thickness_mm: [6, 9, 12, 15, 18],
    region: 'AU',
    generic: true,
    detail:
      "GENERIC, and it is ops' 600x900 figure. Same caveat as above and it matters " +
      'more here: the real AU precuts sit near 896/897 x 600, so this entry is ' +
      'very likely a rounded label rather than a dimension. Offered because ops ' +
      'named it; NOT confirmed as a stocked size.',
  },
  {
    id: 'ply-baltic-1525x1525',
    material: 'Plywood',
    name: 'Baltic birch 1525 x 1525',
    w: 1525,
    h: 1525,
    thickness_mm: [3, 4, 6, 9, 12, 15, 18, 21, 24],
    region: 'INTL',
    source: { url: 'https://www.plyonline.com.au/collections/birch-plywood', read: READ },
    generic: false,
    detail:
      'Baltic mill square, imported into AU. Thickness tolerance here is governed ' +
      'by EN 315, whose numeric band this lane could NOT source — see the ' +
      "could-not-source list in docs/materials-research.md rather than assuming it's tight.",
  },
  {
    id: 'ply-baltic-3050x1525',
    material: 'Plywood',
    name: 'Baltic birch 3050 x 1525 (oversize)',
    w: 3050,
    h: 1525,
    thickness_mm: [6, 9, 12, 15, 18, 21, 24],
    region: 'INTL',
    source: {
      url: 'https://www.plyonline.com.au/products/oversize-baltic-birch-plywood-bb-bb-ext-1525x3050-mm-region-id-888999',
      read: READ,
    },
    generic: false,
    detail: 'Oversize Baltic sheet. Longer than any AU machine travel this lane has facts about — check travel before selecting it.',
  },

  // --- MDF, AU -------------------------------------------------------------
  {
    id: 'mdf-au-2400x1200',
    material: 'MDF',
    name: 'MDF 2400 x 1200 (AU)',
    w: 2400,
    h: 1200,
    thickness_mm: [3, 6, 9, 12, 16, 18, 25, 32],
    region: 'AU',
    source: {
      url: 'https://www.bunnings.com.au/16mm-mdf-panel-standard-2400-x-1200mm_p0590059',
      read: READ,
    },
    generic: false,
    detail:
      'The AU MDF standard. Governed by AS/NZS 1859.2 (Standard / MR / HMR grades). ' +
      'The claim that "MDF is true to nominal thickness" is COMMONLY REPEATED AND ' +
      'UNVERIFIED here — the tolerance figure could not be sourced, so do not treat ' +
      'MDF as the material you can trust the label on.',
  },
  {
    id: 'mdf-au-3600x1200',
    material: 'MDF',
    name: 'MDF 3600 x 1200 (AU)',
    w: 3600,
    h: 1200,
    thickness_mm: [16, 18, 25, 32],
    region: 'AU',
    source: {
      url: 'https://www.bunnings.com.au/3600-x-1200-x-32mm-mdf-standard-panel_p0590014',
      read: READ,
    },
    generic: false,
    detail: 'Long AU MDF sheet, confirmed stocked. Exceeds most hobby-class travel — check the machine envelope.',
  },
  {
    id: 'mdf-au-2700x1200',
    material: 'MDF',
    name: 'MDF 2700 x 1200 (AU)',
    w: 2700,
    h: 1200,
    thickness_mm: [12, 16, 18, 25],
    region: 'AU',
    generic: true,
    detail:
      'GENERIC — listed by suppliers as a standard AU MDF size but not confirmed at ' +
      'a product page. Included because it matches the 2700 ply length, so a shop ' +
      'buying both may see it.',
  },

  // --- Acrylic -------------------------------------------------------------
  {
    id: 'acrylic-au-2440x1220',
    material: 'Acrylic',
    name: 'Acrylic 2440 x 1220 (AU)',
    w: 2440,
    h: 1220,
    thickness_mm: [2, 3, 4.5, 6, 8, 10, 12],
    region: 'AU',
    source: { url: 'https://www.perspex.com.au/shop/item/1', read: READ },
    generic: false,
    detail:
      'Common AU acrylic sheet. CAST acrylic thickness tolerance per ISO 7823-1 is ' +
      'WIDE — 3.0mm nominal is permitted 2.3-3.7mm, 6.0mm is permitted 5.0-7.0mm. ' +
      'Extruded is tighter (+/-10% to 3mm, +/-5% above). On cast sheet, a through-cut ' +
      'depth from nominal is the riskiest guess in this whole file.',
  },
  {
    id: 'acrylic-au-3050x2030',
    material: 'Acrylic',
    name: 'Acrylic 3050 x 2030 (AU, large format)',
    w: 3050,
    h: 2030,
    thickness_mm: [3, 6],
    region: 'AU',
    source: { url: 'https://www.perspexonline.com.au/perspex-cut-to-size/', read: READ },
    generic: false,
    detail:
      'Large-format AU acrylic; 3mm and 6mm clear cast SKUs confirmed at this size. ' +
      'Same cast tolerance caveat as above.',
  },
  {
    id: 'acrylic-intl-2000x1000',
    material: 'Acrylic',
    name: 'Acrylic 2000 x 1000',
    w: 2000,
    h: 1000,
    thickness_mm: [2, 3, 5, 6, 8, 10],
    region: 'INTL',
    generic: true,
    detail: 'GENERIC — a widely used international acrylic size, not confirmed at a supplier page for AU.',
  },

  // --- Aluminium -----------------------------------------------------------
  {
    id: 'alu-au-2400x1200',
    material: 'Aluminium',
    name: 'Aluminium sheet 2400 x 1200 (AU)',
    w: 2400,
    h: 1200,
    thickness_mm: [0.6, 0.8, 1, 1.2, 1.6, 2, 2.5, 3, 4, 5, 6],
    region: 'AU',
    source: {
      url: 'https://www.australwright.com.au/products/aluminium/aluminium-sheet-plate/',
      read: READ,
    },
    generic: false,
    detail:
      'AU aluminium sheet: widths 900/1200/1500, lengths 1800/2400/3000/3600/6000. ' +
      'The alloys AU merchants stock as thin sheet (5005/5052) are rated POOR for ' +
      'machining; 6061, rated good, is mostly stocked as 12mm+ plate. Assume the ' +
      'gummier alloy unless the sheet says otherwise.',
  },
  {
    id: 'alu-au-3000x1500',
    material: 'Aluminium',
    name: 'Aluminium sheet 3000 x 1500 (AU)',
    w: 3000,
    h: 1500,
    thickness_mm: [1, 1.2, 1.6, 2, 2.5, 3, 4, 5, 6],
    region: 'AU',
    source: {
      url: 'https://www.australwright.com.au/products/aluminium/aluminium-sheet-plate/',
      read: READ,
    },
    generic: false,
    detail:
      'Large AU aluminium sheet, same source page. Imperial gauge stock does NOT ' +
      'land on round mm — 18 ga is 1.02mm, 20 ga is 0.81mm — so a "1.0mm" sheet may ' +
      'be a gauge sheet.',
  },

  // --- International reference sizes ---------------------------------------
  {
    id: 'sheet-us-4x8',
    name: 'US 4 x 8 ft (1219 x 2438)',
    w: 2438,
    h: 1219,
    thickness_mm: [6.35, 9.5, 12.7, 15.9, 19.05],
    region: 'US',
    source: { url: 'https://smartcutlist.com/glossary/4x8-sheet', read: READ },
    generic: false,
    detail:
      'The US standard. Exact conversion is 2438.4 x 1219.2; mills round to ' +
      '2440 x 1220 and trimmed panels commonly land just under nominal in BOTH ' +
      'dimensions and thickness. Here as a reference for imported stock, not as an ' +
      'AU option.',
  },
  {
    id: 'sheet-eu-2440x1220',
    name: 'EU 2440 x 1220',
    w: 2440,
    h: 1220,
    thickness_mm: [6, 9, 12, 15, 18, 22, 25],
    region: 'EU',
    generic: true,
    detail:
      'GENERIC — in common European circulation and repeated across secondary ' +
      'sources, not confirmed at a EU standards body. Dimensionally identical to ' +
      'the AU import sheet above, which IS sourced; kept separate because the ' +
      'thickness ladder and grade standards differ.',
  },
  {
    id: 'sheet-eu-3050x1220',
    name: 'EU 3050 x 1220 (4 x 10 ft)',
    w: 3050,
    h: 1220,
    thickness_mm: [12, 15, 18, 22, 25],
    region: 'EU',
    generic: true,
    detail: 'GENERIC — extended-length European commercial panel. Not confirmed at a primary source.',
  },
  {
    id: 'sheet-eu-2500x1250',
    name: 'EU 2500 x 1250',
    w: 2500,
    h: 1250,
    thickness_mm: [6, 9, 12, 15, 18, 22],
    region: 'EU',
    generic: true,
    detail:
      'GENERIC — cited as the European mill standard by several secondary sources ' +
      'and by none this lane could open. Offered so a EU sheet is not forced onto ' +
      'the AU numbers, flagged so it is not trusted.',
  },
];

/** Sheets for one region, longest first. */
export function sheetsForRegion(region: Region): SheetSize[] {
  return SHEET_SIZES.filter((s) => s.region === region).sort((a, b) => b.w - a.w);
}

/** Sheets whose dimensions were confirmed at a supplier page. */
export function sourcedSheets(): SheetSize[] {
  return SHEET_SIZES.filter((s) => !s.generic);
}

/**
 * A sheet by id, or `undefined`.
 *
 * 🔴 Returns `undefined` rather than falling back to a "sensible" sheet. A wrong
 * sheet silently substituted is a nest laid out for stock that is not on the
 * table — and it looks perfect on screen.
 */
export function sheetById(id: string): SheetSize | undefined {
  return SHEET_SIZES.find((s) => s.id === id);
}
