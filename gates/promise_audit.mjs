#!/usr/bin/env node
/**
 * PROMISE AUDIT — which gates make a contract that NO plant tests?
 *
 * `pnp`'s method, relayed by ceo 2026-09-06: audit the DOCSTRING CONTRACT against
 * the PLANT LIST. Not the code against the tests — the PROMISES against the tests.
 *
 * 🔴 WHY IT REACHES WHERE THE REVERT SWEEP CANNOT. A revert sweep reverts
 * behaviours that EXIST. A promised control that was never written has nothing to
 * revert, so it is invisible to BOTH instruments and never appears in any `N of N`
 * — not missed through weakness, missed because nobody listed it.
 *
 * ⚠ THE PLANTS LIVE IN TWO REGISTRIES AND READING ONE IS A MIS-MEASUREMENT.
 * The `--self-plant` HARNESS controls are declared here in `slicer_gate_check.mjs`;
 * the `--plant` PRODUCT plants are declared in the RUST binary, `core/src/fixtures.rs`.
 * Reading only the first reported 42 naked gates on the first run of this script —
 * a mis-scoped measurement, not a finding, and caught before it was reported.
 *
 * ⚠ WHAT A CLEAN RUN WOULD NOT MEAN, in the author's own bound: it only reaches
 * clauses somebody bothered to write down as a GATE. A control neither built nor
 * promised is invisible to this too. Never report "audited" as though it closed
 * the gap.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateSrc = readFileSync(join(ROOT, 'gates/slicer_gate_check.mjs'), 'utf8');
const rustSrc = readFileSync(join(ROOT, 'core/src/fixtures.rs'), 'utf8');

/* 🔴 THE POPULATION IS SCRAPED WITH A REGEX AND WAS NOT PINNED (found
 * 2026-09-07). `gates` comes out of another file's SOURCE. If that table is
 * reformatted — a row wrapped, double quotes, an id gaining a character the
 * class does not allow — rows leave this population silently, and in the limit
 * `gates` is empty, `naked` is empty, `real` is empty, and this prints
 * "0 GENUINE GAPS" and exits 0: every promise has a negative control.
 *
 * ⚠ THE ASYMMETRY IS WHAT MAKES IT DANGEROUS. If the three regexes that build
 * `covered` break, `covered` empties, every gate reads as naked and this exits 1
 * — loud. Only the POPULATION regex fails silently green.
 *
 * The runner it audits floors every one of its own registries — REGISTRY_FLOOR,
 * DISCLOSURES_PINNED, FILE_FLOOR. This file is the newest here and had none. */
const GATE_FLOOR = 50;
const gates = [...gateSrc.matchAll(/^\s*\['([A-Z0-9]+)',\s*'([^']*)',\s*'(HARD|SOFT)'/gm)].map((m) => ({
  id: m[1],
  title: m[2],
  hard: m[3] === 'HARD',
}));

const covered = new Set();
for (const m of gateSrc.matchAll(/'[a-z0-9-]+':\s*\{\s*moves:\s*\[([^\]]*)\]/g))
  for (const g of m[1].matchAll(/'([A-Z0-9]+)'/g)) covered.add(g[1]);
for (const m of gateSrc.matchAll(/gate:\s*'([A-Z0-9]+)'/g)) covered.add(m[1]);
for (const m of rustSrc.matchAll(/gate:\s*"([A-Z0-9]+)"/g)) covered.add(m[1]);

/**
 * 🔴 A JUDGEMENT, RECORDED, BECAUSE A SKIPPED CLAUSE AND A JUDGED-NOT-A-GAP
 * CLAUSE LOOK IDENTICAL AFTERWARDS. ceo relaying `voice`, 2026-09-06: distinguish
 * an EXECUTABLE PROMISE from a DESIGN-CHOICE NOTE — a clause describing a
 * property of code that does not exist cannot be guarded, only asserted, and
 * planting it manufactures a control that passes forever.
 *
 * ⚠ Every entry here is a claim that can be WRONG and re-checked. Absence from
 * this map means "genuine gap", so the default is the accusing one.
 */
const JUDGED = {
  // ⚠ NOT AN EXEMPTION — a measured reason why this one is HARD, recorded so the
  // next person does not rediscover it. ENT stays in the GENUINE GAPS list.
  //   ENT: 'STRUCTURAL — see the note under GENUINE GAPS'

  PLANT: 'NOT A GAP — controlled by a different mechanism this audit cannot see: PLANT carries in-gate ' +
    'BLINDNESS PROBES that assert its checker still objects to a known-inert pairing, one per checker arm. ' +
    'Declared inside the gate rather than in a plant registry.',
  CTRL: 'BLOCKED, not unplanted — needs a real controller on a USB cable. The gate is PENDING by construction ' +
    'and no transcript has ever existed, so a plant has nothing to fire against on this box.',
  I1: 'BLOCKED — needs a browser with a working display; the gate reports could-not-run under --quick.',
  K3: 'BLOCKED — same as I1: browser-vs-CLI parity cannot be exercised without the browser half.',
  TECH: 'PARTIAL, and the unplantable half is already DECLARED: its own contract says "no product path takes a ' +
    'technology, so that failure CANNOT OCCUR and this gate cannot go red for the reason it exists" — planting ' +
    'the headline promise would assert the absence of a code path. \u26a0 BUT the residual checks it does make ' +
    '(the declaration, refusal of an unknown technology, each ban list biting the other) ARE plantable, so this ' +
    'stays counted as a gap for those.',
};

const naked = gates.filter((g) => !covered.has(g.id));
const judged = naked.filter((g) => JUDGED[g.id] && !JUDGED[g.id].startsWith('PARTIAL'));
const real = naked.filter((g) => !JUDGED[g.id] || JUDGED[g.id].startsWith('PARTIAL'));
console.log(
  `${gates.length} gate(s); ${gates.length - naked.length} have a declared plant; ${naked.length} have NONE — ` +
    `of those, ${judged.length} JUDGED not a gap (with reasons) and ${real.length} GENUINE GAPS\n`
);
console.log(`GENUINE GAPS (${real.length}) — a promise with no negative control:`);
console.log(
  '  🔴 WHY THIS SET IS THE PHYSICAL ONE, measured 2026-09-04 while trying to close `ENT`:\n' +
    '     EVERY existing product plant corrupts an INPUT — a depth, a loop count, a clamp, a tab —\n' +
    '     and the engine then faithfully emits the bad program the gate catches. But `ENT` guards an\n' +
    '     ENGINE-LOGIC invariant: that `EntryMode::Ramp` never produces a vertical plunge. NO input\n' +
    '     corruption can reach it, because the engine is correct — that is the whole point of it.\n' +
    '     ⇒ The unplanted gates are not the ones nobody got to. They are the ones the plant\n' +
    '     framework STRUCTURALLY cannot reach, and physical consequence correlates with exactly that.\n' +
    '     Closing them needs a test seam threaded into the engine (measured: 24 call sites across 3\n' +
    '     layers for `plan_profile_with_edge_rule`), which is a design decision, not a missing plant.\n'
);
for (const g of real) {
  console.log(`  ${g.hard ? 'HARD' : 'SOFT'}  ${g.id.padEnd(6)} ${g.title}`);
  if (JUDGED[g.id]) console.log(`        \u26a0 ${JUDGED[g.id]}`);
}
console.log(`\nJUDGED NOT A GAP (${judged.length}) — reason recorded so the judgement is reviewable:`);
for (const g of judged) console.log(`  ${g.id.padEnd(6)} ${JUDGED[g.id]}`);
console.log(
  '\n⚠ A gate here is not necessarily UNTESTABLE — some need hardware (CTRL) or a browser (I1, K3),\n' +
    '  and PLANT audits the plants themselves. The rest are promises with no negative control.\n' +
    '⚠ And this says nothing about controls nobody thought to promise.'
);
if (gates.length < GATE_FLOOR) {
  console.error(
    `\n🔴 SCRAPED ONLY ${gates.length} GATE(S) FROM THE RUNNER, below the floor of ${GATE_FLOOR}. ` +
      'That is a broken population, not a small suite — every number above is over a set this ' +
      'file failed to read, and an empty set would have printed "0 GENUINE GAPS" and exited 0.',
  );
  process.exit(2);
}
process.exit(real.length ? 1 : 0);
