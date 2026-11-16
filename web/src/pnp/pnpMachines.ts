// THE PICK-AND-PLACE MACHINES THIS APP KNOWS — as `pnp` documents them in
// `hardware/pnp/`, cited line by line. `pnp` owns every fact here; this file
// only carries them to the UI (2bee.pnp's machine card, and the machines tab).
//
// 🔴 NOTHING HERE IS BUILT OR BOUGHT. The DIY machine is DESIGNED ONLY
// (`DUAL-Y-GANTRY.md:10-12`, *"NOTHING IS BUILT"*), LumenPnP is a REFERENCE the
// founder chose not to buy (`README.md:12`, *"we will not buy for now"*). A field
// the docs do not state is `null` and is shown as "not stated" — never filled in
// from a vendor page or a guess.
//
// ⚠ TRAVEL X/Y/Z ARE RAIL STROKES, NOT A PLACEMENT AREA. No document states a
// placement area for any of these machines. `travel.basis` says what each number is;
// a 3D view that draws them must label them the same way.
//
// ⚠ The tray PLAN on the 2bee.pnp tab uses `cad`'s blinds tray spec
// (`pnp_blinds_vspec.json`), not the dual-Y gantry's own 3-lane component tray
// (`DUAL-Y-GANTRY.md:107-110`). Both are real `cad` artefacts; which one a given
// machine carries is `pnp`'s question, and this file does not settle it.
//
// ⚠ `hardware/pnp/` is no longer in this repo: it moved to 2hives-ai/2bee-smt-manufacturing
// (db8fb08ace, 2026-10-19), byte-identical at every cited line. The paths below are paths in THAT
// repo; tests/pnp-ask.test.ts resolves them against a checkout beside this one.
//
// Re-checked against the cited lines 2026-10-15. If `pnp` moves a line, the
// citation goes stale silently — nothing gates it.

export type PnpMachineStatus = 'designed' | 'alternate' | 'reference';

export interface PnpMachine {
  id: string;
  name: string;
  status: PnpMachineStatus;
  statusNote: string;
  /** Millimetres. `null` = not stated in `hardware/pnp/`. */
  travel: { x: number | null; y: number | null; z: number | null; basis: string };
  nozzles: string | null;
  feeders: string | null;
  cameras: string | null;
  controller: string | null;
  accuracy: string | null;
  /** `hardware/pnp/<file>:<line>` for the facts above. */
  sources: string[];
}

export const PNP_MACHINES: readonly PnpMachine[] = [
  {
    id: 'diy-dual-y',
    name: '2bee DIY dual-Y gantry',
    status: 'designed',
    statusNote: 'Active design (Milestone 1). Designed only: nothing ordered, nothing built.',
    travel: {
      x: 410,
      y: 210,
      z: 60,
      basis: 'rail strokes: X rail 500 → 410 mm, Y2 rail 300 → 210 mm (Y1 not stated), Z 60 mm available. Not a placement area.',
    },
    nozzles: 'One head, NEMA 8 JUKI hollow-shaft rotation; nozzles N045 / N08 / N14, changed from a rack on Y2',
    feeders: 'No feeders: a hand-loaded component tray, 3 lanes (0402 / 0603 / 0805)',
    cameras: 'Down camera on Z; up camera fixed between Y1 and Y2 (OV9281)',
    controller: 'Not named for this design. SKR Pro V1.2 permitted (founder 2026-09-01); OpenPnP, simulation only',
    accuracy: '~±62 µm placement budget: derived, not measured',
    sources: [
      'hardware/pnp/DUAL-Y-GANTRY.md:10-12',
      'hardware/pnp/DUAL-Y-GANTRY.md:69-73',
      'hardware/pnp/DUAL-Y-GANTRY.md:107-110',
      'hardware/pnp/DUAL-Y-GANTRY.md:128-131',
      'hardware/pnp/DUAL-Y-GANTRY.md:441',
      'hardware/pnp/DUAL-Y-GANTRY.md:505',
      'hardware/pnp/TOOL-HEADS.md:72',
      'hardware/pnp/MILESTONE-1.md:122',
      'hardware/pnp/MILESTONE-1.md:126',
      'hardware/pnp/README.md:63',
      'hardware/pnp/STATUS.md:38',
    ],
  },
  {
    id: 'eins-kk60',
    name: 'Eins + KK60 (alternate DIY)',
    status: 'alternate',
    statusNote: 'Alternate design, tracked; not the founder’s stated goal.',
    travel: { x: 525, y: null, z: null, basis: 'X stroke 525 mm (custom twin-rail). Y and Z strokes not stated.' },
    nozzles: null,
    feeders: 'MAX Feeder at 14.53 mm pitch; bank layout not drawn',
    cameras: null,
    controller: null,
    accuracy: null,
    sources: ['hardware/pnp/README.md:45', 'hardware/pnp/EINS-KK60-DESIGN-LOG.md:25', 'hardware/pnp/EINS-KK60-DESIGN-LOG.md:395'],
  },
  {
    id: 'lumenpnp-v4',
    name: 'Opulo LumenPnP v4',
    status: 'reference',
    statusNote: 'Reference machine only. Not bought (founder: "we will not buy for now").',
    travel: { x: null, y: null, z: null, basis: 'Work area not stated in hardware/pnp/.' },
    nozzles: '2 nozzles, shared Z, rotation per nozzle',
    feeders: 'Photon feeders, 50 slots at 15.8 mm; 8/12 mm tape 1 slot, 16/24 mm 2 slots (8 mm production, wider beta)',
    cameras: 'Fixed upward (bottom) camera; down camera not stated',
    controller: 'OpenPnP; controller board not stated',
    accuracy: 'Vendor gives none; one owner reports ~50 µm repeatability',
    sources: [
      'hardware/pnp/README.md:12',
      'hardware/pnp/feasibility-2026-08-31.md:561-573',
      'hardware/pnp/REQUIREMENTS.md:13006-13008',
      'hardware/pnp/feeder-survey.md:37',
      'hardware/pnp/larger-components-feasibility-2026-09-22.md:30-31',
    ],
  },
];

export const DEFAULT_PNP_MACHINE_ID = 'diy-dual-y';

export function pnpMachineById(id: string | null | undefined): PnpMachine {
  return PNP_MACHINES.find((m) => m.id === id) ?? PNP_MACHINES.find((m) => m.id === DEFAULT_PNP_MACHINE_ID)!;
}

/** One line for an AI context or a picker subtitle. */
export function describePnpMachine(m: PnpMachine): string {
  const n = (v: number | null) => (v === null ? '?' : String(v));
  return `${m.name} (${m.status}; ${m.statusNote}) travel ${n(m.travel.x)}×${n(m.travel.y)}×${n(m.travel.z)} mm [${m.travel.basis}]; nozzles: ${
    m.nozzles ?? 'not stated'
  }; feeders: ${m.feeders ?? 'not stated'}; cameras: ${m.cameras ?? 'not stated'}`;
}
