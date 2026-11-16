// pnp-manifest — PnP slice 1 from the command line. See `src/pnp/manifest.ts`.
//
//   npm run pnp:manifest -- --bom outlet-bom.csv --cpl outlet-cpl.csv --trays trays.json --boards 3 [--overrides parts.json] [--sidecar <board>-pns.csv] [--json out.json]
//
// trays.json: [{ "trayId": "T01", "variant": "coupon0402" }, …]
// parts.json (optional): { "<Mfr_PN>": { "variant": "8emb", "pocketPitchMm": 4 }, … } — layered OVER the
//   bundled `src/pnp/tape-overrides.json`, which always applies.
// --sidecar: the board's <board>-pns.csv, for its Assembly tier, when the BOM itself has none.
// Exit: 0 manifest usable · 1 refused (every refusal printed) · 2 could not run,
// including a bad invocation — and zero rows read is 2, never a pass.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CAPACITY_NOTE,
  parseOverrides,
  parseVspec,
  assemblyFromSidecar,
  preflight,
  type Overrides,
  type AssemblyMap,
  type TrayDef,
  type Vspec,
} from '../src/pnp/manifest';

/** `cad`'s generated tray spec — the same file the browser build imports. */
const VSPEC_PATH = fileURLToPath(new URL('../../../../hardware/cad/2bee_pnp/pnp_blinds_vspec.json', import.meta.url));

function die(msg: string): never {
  console.error(`pnp-manifest: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opt: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const k = args[i];
  if (!['--bom', '--cpl', '--trays', '--boards', '--overrides', '--sidecar', '--json'].includes(k) || args[i + 1] === undefined)
    die(`unknown or incomplete argument ${k}`);
  opt[k] = args[i + 1];
}
for (const k of ['--bom', '--cpl', '--trays', '--boards']) if (!opt[k]) die(`missing ${k}`);

let bomCsv: string, cplCsv: string, trays: TrayDef[];
let overrides: Overrides = {};
let vspec: Vspec;
let assembly: AssemblyMap = {};
try {
  bomCsv = readFileSync(opt['--bom'], 'utf8');
  cplCsv = readFileSync(opt['--cpl'], 'utf8');
  trays = JSON.parse(readFileSync(opt['--trays'], 'utf8'));
  vspec = parseVspec(JSON.parse(readFileSync(VSPEC_PATH, 'utf8')));
  overrides = parseOverrides(JSON.parse(readFileSync(new URL('../src/pnp/tape-overrides.json', import.meta.url), 'utf8')));
  if (opt['--overrides'])
    overrides = { ...overrides, ...parseOverrides(JSON.parse(readFileSync(opt['--overrides'], 'utf8'))) };
  if (opt['--sidecar']) {
    const sc = assemblyFromSidecar(readFileSync(opt['--sidecar'], 'utf8'));
    if (sc.problems.length) die(sc.problems.join('; '));
    assembly = sc.map;
  }
} catch (e) {
  die(`could not read input: ${(e as Error).message}`);
}
if (!Array.isArray(trays)) die('--trays must be a JSON array');

const r = preflight({ bomCsv, cplCsv, trays, boards: Number(opt['--boards']), overrides, vspec, assembly });
const c = r.counts;
console.log(
  `Assembly read: ${Object.entries(c.assembly)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')}`
);
console.log(
  `read: BOM ${c.bomRows} rows · CPL ${c.cplRows} rows · skipped DNP ${c.skippedDnp} · Consigned ${c.skippedConsigned} · Assembly-tier ${c.skippedAssembly} · placed ${c.placedLines} lines / ${c.placedParts} parts per board`
);
for (const l of r.lanes)
  console.log(
    `  ${l.trayId} lane ${String(l.lane).padStart(2)}  ${l.pkg.padEnd(22)} ${l.value.padEnd(20)} ${l.mfrPn.padEnd(22)} need ${l.need}/${l.capacity}${l.tape === 'override' ? '  (override)' : ''}${l.swapUndetectable ? '  ⚠ swap undetectable by camera' : ''}`
  );
if (r.lanes.length) console.log(`  ⚠ ${CAPACITY_NOTE}`);
if (r.traysUsed.length) console.log(`trays used: ${r.traysUsed.join(', ')}`);
for (const [v, n] of Object.entries(r.lanesNeeded)) console.log(`job needs: ${v} ${n.lanes} lane(s) = ${n.trays} tray(s)`);
for (const w of r.warnings) console.log(`WARN  ${w}`);
for (const p of r.refusals) console.log(`REFUSE [${p.rule}] ${p.message}`);
console.log(`VERDICT: ${['MANIFEST OK', 'REFUSED', 'COULD NOT RUN'][r.exit]} (exit ${r.exit})`);
if (opt['--json']) writeFileSync(opt['--json'], JSON.stringify(r, null, 2));
process.exit(r.exit);
