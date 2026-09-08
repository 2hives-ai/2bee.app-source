/**
 * Gate `RUN`'s instrument: WHICH FAKE ANSWERED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS NOT A GREP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `docs/design-76-run-tab.md` §18 makes one demand of gate `RUN` that no other
 * gate in this suite has to satisfy:
 *
 *   > `RUN` prints, on every run, that its transport was the fake — with the
 *   > fake's configuration (buffer size, `$10`, persona) in the line. *A green
 *   > whose subject is unnamed is a green nobody can audit.*
 *
 * The obvious implementation is to scan `web/tests/run*.test.ts` for
 * `new FakeController('…')` and print the strings found. That is a scan of the
 * SOURCE, and it answers a different question from the one the design asks: it
 * says which personas are WRITTEN, not which ones ANSWERED. A persona
 * constructed inside a branch that never executes, or one whose test was
 * renamed out of the runner's glob, would be printed exactly the same way — and
 * the line would then vouch for coverage that did not happen.
 *
 * So this is instrumentation, not a scan. Loaded with `--import` ahead of the
 * suite, it wraps two `FakeController` prototype methods — `onData` and `write`
 * — and records `describe()` the first time either is called on an instance.
 * Both are on the path of every test that drives a fake at all: a test either
 * listens to it, writes at it, or does neither, and one that does neither has
 * not used the transport.
 *
 * ⚠ WHAT THIS DOES NOT CLAIM. It records that a persona was DRIVEN, not that
 * anything was asserted about what it said. A test that constructs a fake,
 * writes one byte and asserts nothing appears here identically to one that
 * exercises the whole handshake. The per-branch assertions are the gate's other
 * limb; this limb only names the subject.
 *
 * ⚠ AND IT CANNOT SEE A FAKE IT NEVER LOADS. If `--import` is dropped from the
 * command line the log is empty, which the gate treats as a FAILURE of the
 * instrument rather than as "no personas were driven" — the two are
 * indistinguishable from the file alone, and only one of them is safe to
 * report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO MODES, ONE FILE
 * ─────────────────────────────────────────────────────────────────────────────
 *   --import  : installs the recorder. Appends one JSON line per fake driven to
 *               `$RUN_FAKE_LOG`. Append, not write: `node --test a.ts b.ts`
 *               forks a child per file and both children have this loaded.
 *   as main   : prints the registries (`PERSONAS`, `PROTOCOL_PLANTS`,
 *               `RUN_TAB_PLANTS`) as JSON, so the gate reads the plant list
 *               FROM THE MODULE rather than from a copy of it. A gate holding
 *               its own copy of the list it checks cannot see the list change.
 *
 * Both modes need `web/tests/register.mjs` imported first — it installs the
 * TypeScript loader hook. That is the caller's job and there is no fallback: a
 * silent fallback to "no TypeScript" would report an empty registry as a fact.
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FAKE = new URL('../web/src/run/fake.ts', import.meta.url).href;
const PROTOCOL = new URL('../web/src/run/protocol.ts', import.meta.url).href;
const RUNTAB = new URL('../web/src/RunTab.tsx', import.meta.url).href;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PLANT PROBE — the gate watching its own reds, not reading about them
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Gate `PLANT`'s row in `slicer_gate_check.mjs` records the measurement that
 * makes this necessary: `wrong-drill` announced `PLANTED:` while changing
 * nothing, and ten of eighteen plants were inert on most targets. The design's
 * own §18 closes with the same warning about the eighteen `--plant` names it
 * lists for `RUN`.
 *
 * `web/tests/run*.test.ts` already exercise every one of the sixteen protocol
 * plants — but a gate that reads a TEST TITLE and calls the plant verified has
 * asserted an announcement. So each probe below drives the REAL module both
 * ways and returns both answers. The gate asserts:
 *
 *   - `clean` is the safe value (named per probe), and
 *   - `planted` DIFFERS from it.
 *
 * A plant that has gone inert makes the two equal and the gate goes red. That
 * is the whole point, and it is a consequence rather than a message.
 *
 * ⚠ WHAT A PROBE DOES NOT PROVE. That the planted value is the *specific*
 * historical defect — only that the switch still moves the product. The tests
 * carry the specific assertions; this is the liveness check on the controls
 * themselves, and the gate says so in its own message.
 */
async function plantProbes() {
  const P = await import(PROTOCOL);
  const F = await import(FAKE);
  const {
    LineAssembler,
    Streamer,
    classifyInbound,
    deriveDro,
    describeAlarm,
    identify,
    initialTrackedState,
    parseStatusReport,
    positionTrustAfterAlarm,
    realtimeBytes,
    refusalsFor,
  } = P;
  const { FakeController, pumpStream } = F;

  const enc = (s) => new TextEncoder().encode(s);
  const rep = (s) => parseStatusReport(s).report;
  const line12 = (i) => 'G1X' + String(i % 1000000000).padStart(9, '0');
  const program = (n) => Array.from({ length: n }, (_, i) => line12(i));
  const ready = () => ({
    ...initialTrackedState(),
    tab: 'Idle',
    controllerState: 'Idle',
    controllerSubstate: null,
    identification: 'grblHAL',
    homingSeen: true,
    homingEnabled: true,
    positionTrusted: true,
    positionUntrustedWhy: null,
    wcoKnown: true,
    currentWorkZ: 5,
    programFirstZ: 5,
    programLoaded: true,
    programDirty: false,
    reportUnits: 'mm',
    streamMode: 'character-counting',
    measuredRxBuffer: 1024,
  });
  const ids = (rs) => rs.map((r) => r.id).sort().join(',');

  /** Stream `program(n)` at the fake and report what the FAKE saw, not what the
   *  sender believes. The overrun counter is the controller's, which is the only
   *  side of that argument that matters. */
  async function stream(plant, persona, opts) {
    const fake = new FakeController(persona, { autoExecute: false, ...(opts?.fake ?? {}) });
    const s = new Streamer({
      lines: program(opts?.lines ?? 5000),
      mode: 'character-counting',
      rxBufferSize: opts?.rx ?? 64,
      ...(plant ? { plant } : {}),
    });
    const out = await pumpStream(fake, s, { linesPerRound: 1, maxRounds: opts?.maxRounds ?? 20000 });
    return { overruns: fake.overruns, state: s.state, wrote: out.wrote.length, stalled: out.stalled };
  }

  const probes = {};
  const add = (name, safe, clean, planted) => {
    probes[name] = { safe, clean, planted };
  };

  // RUN-1. The controller's own overrun counter, end to end.
  add(
    'overcount',
    'the fake records ZERO overruns',
    await stream(null, 'tiny-buffer'),
    await stream('overcount', 'tiny-buffer', { maxRounds: 200 })
  );

  // RUN-2. A status report is not an acceptance.
  add(
    'count-status-as-ok',
    'isLineReply=false for a <…> report',
    { isLineReply: classifyInbound('<Idle|MPos:0,0,0>').isLineReply },
    { isLineReply: classifyInbound('<Idle|MPos:0,0,0>', 'count-status-as-ok').isLineReply }
  );

  // RUN-3. The first error: ends the stream.
  add(
    'keep-going-past-error',
    "state='aborted' and fewer lines written than the program holds",
    await stream(null, 'rejects-a-line', { lines: 20, rx: 64 }),
    await stream('keep-going-past-error', 'rejects-a-line', { lines: 20, rx: 1024 })
  );

  // RUN-4. One byte on the wire, not two.
  add(
    'utf8-realtime',
    'exactly one byte, 0x90',
    { bytes: [...realtimeBytes('feedOverrideReset')] },
    { bytes: [...realtimeBytes('feedOverrideReset', 'utf8-realtime')] }
  );

  // RUN-5. A zero is a number and reads as a measurement.
  {
    const r = rep('<Idle|MPos:-100.000,-200.000,-5.000|FS:0,0>');
    add(
      'assume-zero-wco',
      'work.values=null with a reason',
      { work: deriveDro(r, null).work.values },
      { work: deriveDro(r, null, 'assume-zero-wco').work.values }
    );
  }

  // RUN-6. WPos already has the offset applied.
  {
    const r = rep('<Idle|WPos:0.000,0.000,20.000|WCO:-100.000,-200.000,-25.000>');
    add(
      'double-subtract-wco',
      'work=[0,0,20], the position as sent',
      { work: deriveDro(r, null).work.values },
      { work: deriveDro(r, null, 'double-subtract-wco').work.values }
    );
  }

  // RUN-7. 0x85 flushes the controller's RX buffer.
  {
    const s = { ...ready(), controllerState: 'Run' };
    add(
      'cancel-while-streaming',
      'R7 refuses jog-cancel outside Jog',
      { refusals: ids(refusalsFor('jog-cancel', s)) },
      { refusals: ids(refusalsFor('jog-cancel', s, 'cancel-while-streaming')) }
    );
  }

  // RUN-8. No homing evidence, and an untrusted position.
  {
    const s = { ...ready(), homingSeen: false, positionTrusted: false, positionUntrustedWhy: 'hard limit' };
    add(
      'stream-unhomed',
      'R1 and R2 both refuse start-job',
      { refusals: ids(refusalsFor('start-job', s)) },
      { refusals: ids(refusalsFor('start-job', s, 'stream-unhomed')) }
    );
  }

  // RUN-9. The first motion is a descent — and the blind case.
  {
    const descending = { ...ready(), currentWorkZ: 40, programFirstZ: 5 };
    const blind = { ...ready(), wcoKnown: false, currentWorkZ: null };
    add(
      'descend-first',
      'R3 refuses a descent AND refuses when the comparison cannot be made',
      { descending: ids(refusalsFor('start-job', descending)), blind: ids(refusalsFor('start-job', blind)) },
      {
        descending: ids(refusalsFor('start-job', descending, 'descend-first')),
        blind: ids(refusalsFor('start-job', blind, 'descend-first')),
      }
    );
  }

  // RUN-10. $X on error:46.
  {
    const s = { ...ready(), lastUnlockError: 46 };
    add(
      'unlock-optimism',
      'R9 refuses the unlock',
      { refusals: ids(refusalsFor('unlock', s)) },
      { refusals: ids(refusalsFor('unlock', s, 'unlock-optimism')) }
    );
  }

  // RUN-11. Alarms 1 and 3 lose position; 2 does not.
  add(
    'trust-after-hardlimit',
    'alarm 1 is NOT trusted',
    { a1: positionTrustAfterAlarm(1).trusted, a3: positionTrustAfterAlarm(3).trusted, a2: positionTrustAfterAlarm(2).trusted },
    {
      a1: positionTrustAfterAlarm(1, 'trust-after-hardlimit').trusted,
      a3: positionTrustAfterAlarm(3, 'trust-after-hardlimit').trusted,
      a2: positionTrustAfterAlarm(2, 'trust-after-hardlimit').trusted,
    }
  );

  // RUN-12. No auto-resume, ever.
  {
    const s = { ...ready(), reconnectedMidJob: true };
    add(
      'auto-resume',
      'R11 refuses auto-resume',
      { refusals: ids(refusalsFor('auto-resume', s)) },
      { refusals: ids(refusalsFor('auto-resume', s, 'auto-resume')) }
    );
  }

  // RUN-13. ALARM:N is not ordinary output.
  add(
    'ignore-async-alarm',
    "kind='alarm'",
    { kind: classifyInbound('ALARM:3').kind },
    { kind: classifyInbound('ALARM:3', 'ignore-async-alarm').kind }
  );

  // RUN-14. An unknown code renders as unknown.
  add(
    'swallow-unknown-code',
    'known=false for alarm 99',
    { known: describeAlarm(99).known },
    { known: describeAlarm(99, 'swallow-unknown-code').known }
  );

  // RUN-15. Marlin is not grblHAL.
  add(
    'accept-anything',
    "verdict='unknown' for a Marlin banner",
    { verdict: identify(['start', 'echo:Marlin 2.1.2']).verdict },
    { verdict: identify(['start', 'echo:Marlin 2.1.2'], 'accept-anything').verdict }
  );

  // RUN-16. A read boundary falls anywhere.
  add(
    'assume-read-is-line',
    'a partial line is held in the carry buffer, not delivered',
    { lines: new LineAssembler().push(enc('<Idle|MPos:0.0')) },
    { lines: new LineAssembler().push(enc('<Idle|MPos:0.0'), 'assume-read-is-line') }
  );

  return probes;
}

if (isMain) {
  const fake = await import(FAKE);
  const protocol = await import(PROTOCOL);
  const runtab = await import(RUNTAB);
  console.log(
    JSON.stringify({
      personas: fake.PERSONAS,
      protocolPlants: protocol.PROTOCOL_PLANTS,
      runTabPlants: runtab.RUN_TAB_PLANTS,
      // The line the design requires, for the persona the suite leans on most.
      // Printed from the module so it cannot drift from what the tests get.
      healthy: new fake.FakeController('healthy').describe(),
      probes: await plantProbes(),
    })
  );
} else {
  const log = process.env.RUN_FAKE_LOG;
  if (!log) {
    // A recorder with nowhere to record is the "control that silently does
    // nothing" this lane keeps finding. Refuse loudly instead.
    throw new Error('run_fake_probe.mjs was imported with no RUN_FAKE_LOG set — it would record nothing and look like it worked');
  }
  const { FakeController } = await import(FAKE);
  const seen = new WeakSet();
  const record = (self) => {
    if (seen.has(self)) return;
    seen.add(self);
    try {
      appendFileSync(log, JSON.stringify({ describe: self.describe() }) + '\n');
    } catch {
      /* A test process that cannot append must still run its assertions. The
       * gate fails on an EMPTY log, which is what a broken append produces. */
    }
  };
  for (const name of ['onData', 'write']) {
    const orig = FakeController.prototype[name];
    if (typeof orig !== 'function') {
      throw new Error(`FakeController.prototype.${name} is not a function — this recorder is wrapping a method that no longer exists, so it would record nothing and read as "no personas driven"`);
    }
    FakeController.prototype[name] = function patched(...args) {
      record(this);
      return orig.apply(this, args);
    };
  }
}
