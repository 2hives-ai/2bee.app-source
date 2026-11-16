// THE PnP TAB — DECLARED, NOT IMPLEMENTED.
//
// Ruling, founder 2026-10-11, verbatim: *"11 yes"* — against `ceo`'s numbered
// list of pending decisions, whose item 11 read *"2bee_app — PnP app as third
// tab, yes/no."* That is the whole record: answered in the same turn, so no
// founder-queue file exists; the source is `ceo`'s cross-session message to this
// lane, 2026-10-11. The proposal it answers is `ceo` 2026-09-07 `15-29-24`:
// `2bee_app` owns the APPLICATION, `ml` the vision primitives, and `pnp` keeps
// the SPEC and the ACCEPTANCE.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THIS TAB DOES NOTHING, AND SAYS SO. IT IS A SEAT, NOT A FEATURE.
// ═══════════════════════════════════════════════════════════════════════════
//
// It is the same move as `Technology::Fdm` in `core/src/tech.rs`: declared, so
// the seam exists and is visible; unimplemented, and every place that asks gets
// told. No control on this page talks to a machine, reads a BOM, or plans a
// placement. A tab that LOOKED like it did any of those, before `pnp` has said
// what "working" means for a pick-and-place, would be software that satisfies a
// ticket rather than a machine.
//
// The feature list below is `pnp`'s 2026-09-06 software spec
// (`handover/ceo/_done/2026-09-06-16-03-54-pnp-SOFTWARE-SPEC-…`), copied as
// NAMES. Sequencing and acceptance are `pnp`'s: slice 1 (2026-10-11 `08-45-33`)
// is feature 4 plus the manifest it produces — `manifest.ts`, driven below. It
// PLANS lanes; it does not check a tray and does not move anything.
//
// ⚠ WHAT IS DELIBERATELY ABSENT: no Connect button, no reuse of `RunTab`'s
// sender. The sender is the part that transfers (measured 2026-09-07: 5 CAM
// couplings in 4 297 lines), and wiring it here before `pnp`'s acceptance
// exists would give a pick-and-place a jog control nobody has specified.

// 2026-10-15: this is now the EXPERT view, reached by `?pnp=expert` (see
// `PnpTab.tsx`). The default face of the tab is the chat + board + machine view
// (founder: "the pnp should be the same concept (left side AI agent, on top
// select the pcb) below the 3d have the machine"). Nothing below changed.

import { useMemo, useState } from 'react';
import {
  CAPACITY_NOTE,
  parseOverrides,
  assemblyFromSidecar,
  preflight,
  type Overrides,
  type PreflightResult,
  type TrayDef,
  type Vspec,
} from './manifest';
import TAPE_OVERRIDES from './tape-overrides.json';
import { bundledVspec, VSPEC_SOURCE } from './vspec';

/** Read once. A malformed file is a message on the tab, never an empty plan. */
const VSPEC: Vspec | string = (() => {
  try {
    return bundledVspec();
  } catch (e) {
    return `Cannot read ${VSPEC_SOURCE}: ${(e as Error).message}`;
  }
})();

const FEATURES: readonly { name: string; what: string; built?: true }[] = [
  { name: 'Visual servoing loop', what: 'command → photograph → measure → correct → repeat' },
  { name: 'Tray kitting map', what: 'lane → part number, keyed by the tray ID', built: true },
  { name: 'Whole-tray verification', what: 'one photo against the manifest: catches a hole or a double' },
  {
    name: 'Pocket assignment for detectability',
    what: 'never the same part class in adjacent pockets — does NOT apply to lane trays (pnp 2026-10-11)',
  },
  { name: 'Two-machine job split', what: 'one BOM/CPL → a fill job and a place job' },
];

const EXAMPLE_TRAYS = JSON.stringify(
  [
    { trayId: 'T01', variant: '0402' },
    { trayId: 'T02', variant: '8paper' },
    { trayId: 'T03', variant: '8emb' },
    { trayId: 'T04', variant: '12' },
  ],
  null,
  1
);

function readFile(f: File | undefined, set: (s: string) => void) {
  if (f) void f.text().then(set);
}

export default function PnpExpert() {
  const [bom, setBom] = useState('');
  const [cpl, setCpl] = useState('');
  const [traysText, setTraysText] = useState(EXAMPLE_TRAYS);
  const [boards, setBoards] = useState(1);
  const [overridesText, setOverridesText] = useState('{}');
  const [sidecar, setSidecar] = useState('');
  const result = useMemo((): PreflightResult | string | null => {
    if (typeof VSPEC === 'string') return VSPEC;
    if (!bom || !cpl) return null;
    let trays: TrayDef[];
    try {
      trays = JSON.parse(traysText);
      if (!Array.isArray(trays)) return 'Trays must be a JSON array.';
    } catch (e) {
      return `Trays are not valid JSON: ${(e as Error).message}`;
    }
    let overrides: Overrides;
    try {
      overrides = { ...parseOverrides(TAPE_OVERRIDES), ...parseOverrides(JSON.parse(overridesText || '{}')) };
    } catch (e) {
      return `Part overrides are not valid JSON: ${(e as Error).message}`;
    }
    const sc = assemblyFromSidecar(sidecar);
    if (sidecar && sc.problems.length) return sc.problems.join('; ');
    return preflight({ bomCsv: bom, cplCsv: cpl, trays, boards, overrides, vspec: VSPEC, assembly: sidecar ? sc.map : {} });
  }, [bom, cpl, traysText, boards, overridesText, sidecar]);

  return (
    <div className="shop" data-testid="pnp-tab" data-view="expert">
      <div
        data-testid="pnp-unbuilt"
        style={{ border: '1px solid var(--bad)', borderRadius: 'var(--radius)', padding: '10px 12px', marginBottom: 16 }}
      >
        <strong className="bad">Plans trays only. Nothing here talks to a machine.</strong>
        <p style={{ margin: '6px 0 0' }}>
          This tab turns a BOM and CPL into a tray manifest and refuses, by name, what would make it
          wrong. It does not check a physical tray, cannot tell a 10k from a 100k, and its
          package-to-tape table is a <strong>default from tape norms, not measured on our reels</strong>,
          and lane capacities come from <code>cad</code>’s tray spec, computed, not counted on a tape.
          OpenPnP runs the machine; a person reads this manifest.
        </p>
      </div>
      <header className="shop-head">
        <h1>2bee.pnp</h1>
        <p>
          <a href="?pnp=chat" data-testid="pnp-to-chat">
            ← Back to the simple view
          </a>
        </p>
        <p className="shop-sub">
          Pick-and-place application. Specification and acceptance: <code>pnp</code> · vision:{' '}
          <code>ml</code> · this app: <code>2bee_app</code>.
        </p>
      </header>

      <h2 style={{ fontSize: '1.05rem', margin: '16px 0 8px' }}>Job pre-flight</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <label>
          BOM CSV <input type="file" accept=".csv" data-testid="pnp-bom" onChange={(e) => readFile(e.target.files?.[0], setBom)} />
        </label>
        <label>
          CPL CSV <input type="file" accept=".csv" data-testid="pnp-cpl" onChange={(e) => readFile(e.target.files?.[0], setCpl)} />
        </label>
        <label>
          Sidecar <code>-pns.csv</code> (Assembly tier, optional){' '}
          <input type="file" accept=".csv" data-testid="pnp-sidecar" onChange={(e) => readFile(e.target.files?.[0], setSidecar)} />
        </label>
        <label>
          Boards{' '}
          <input
            type="number"
            min={1}
            step={1}
            value={boards}
            data-testid="pnp-boards"
            onChange={(e) => setBoards(Number(e.target.value))}
            style={{ width: 64 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          Trays on hand (JSON)
          <textarea
            rows={6}
            cols={44}
            value={traysText}
            data-testid="pnp-trays"
            onChange={(e) => setTraysText(e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          More tape per Mfr_PN (JSON, optional — over the built-in datasheet values)
          <textarea
            rows={6}
            cols={44}
            value={overridesText}
            data-testid="pnp-overrides"
            placeholder='{ "CL21A226KOQNNNE": { "variant": "8emb", "pocketPitchMm": 4 } }'
            onChange={(e) => setOverridesText(e.target.value)}
          />
        </label>
      </div>
      <PreflightView result={result} />

      <h2 style={{ fontSize: '1.05rem', margin: '24px 0 8px' }}>Features named in the spec</h2>
      <ul data-testid="pnp-features" style={{ margin: 0, paddingLeft: 20 }}>
        {FEATURES.map((f) => (
          <li key={f.name} style={{ margin: '4px 0' }}>
            <strong>{f.name}</strong> — {f.what}.{' '}
            {f.built ? <span>Planning only (slice 1).</span> : <span className="bad">Not built.</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreflightView({ result }: { result: PreflightResult | string | null }) {
  if (result === null) return <p className="shop-sub">Load a BOM and a CPL to plan the trays.</p>;
  if (typeof result === 'string') return <p className="bad" data-testid="pnp-verdict">{result}</p>;
  const c = result.counts;
  const verdict = ['MANIFEST OK', 'REFUSED', 'COULD NOT RUN'][result.exit];
  return (
    <div data-testid="pnp-result" style={{ marginTop: 12 }}>
      <p data-testid="pnp-verdict" className={result.exit ? 'bad' : undefined}>
        <strong>{verdict}</strong> — read BOM {c.bomRows} rows · CPL {c.cplRows} rows · skipped DNP {c.skippedDnp} ·
        Consigned {c.skippedConsigned} · Assembly-tier {c.skippedAssembly} · placed {c.placedLines} lines / {c.placedParts} parts per board
      </p>
      <p className="shop-sub" data-testid="pnp-assembly">
        Assembly read:{' '}
        {Object.entries(c.assembly)
          .map(([k, n]) => `${k} ${n}`)
          .join(' · ')}
      </p>
      {result.refusals.length > 0 && (
        <ul data-testid="pnp-refusals">
          {result.refusals.map((p, i) => (
            <li key={i} className="bad">
              [{p.rule}] {p.message}
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul data-testid="pnp-warnings">
          {result.warnings.map((w, i) => (
            <li key={i} className="warn">{w}</li>
          ))}
        </ul>
      )}
      {result.lanes.length > 0 && (
        <table data-testid="pnp-lanes" style={{ borderCollapse: 'collapse', marginTop: 8 }}>
          <thead>
            <tr>
              {['Tray', 'Lane', 'Package', 'Value', 'Mfr_PN', 'Tape', 'Need', 'Capacity', ''].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '2px 8px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.lanes.map((l) => (
              <tr key={`${l.trayId}-${l.lane}`}>
                <td style={{ padding: '2px 8px' }}>{l.trayId}</td>
                <td style={{ padding: '2px 8px' }}>{l.lane}</td>
                <td style={{ padding: '2px 8px' }}>{l.pkg}</td>
                <td style={{ padding: '2px 8px' }}>{l.value}</td>
                <td style={{ padding: '2px 8px' }}>{l.mfrPn}</td>
                <td style={{ padding: '2px 8px' }}>{l.tape === 'override' ? `${l.variant} (override)` : l.variant}</td>
                <td style={{ padding: '2px 8px' }} className={l.need > l.capacity ? 'bad' : undefined}>{l.need}</td>
                <td style={{ padding: '2px 8px' }}>{l.capacity}</td>
                <td style={{ padding: '2px 8px' }} className="warn">{l.swapUndetectable ? 'swap undetectable by camera' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.lanes.length > 0 && <p className="warn" data-testid="pnp-capacity-note">{CAPACITY_NOTE}</p>}
      {Object.keys(result.lanesNeeded).length > 0 && (
        <p data-testid="pnp-lanes-needed">
          Job needs:{' '}
          {Object.entries(result.lanesNeeded)
            .map(([v, n]) => `${v} ${n.lanes} lane(s) = ${n.trays} tray(s)`)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
