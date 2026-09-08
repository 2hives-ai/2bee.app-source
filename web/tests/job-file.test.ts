// The job file — `File → Save job… / Open job…`, `web/src/store.ts`. TODO #108.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS FILE IS FOR: THE BOUND
// ═══════════════════════════════════════════════════════════════════════════
//
// `SessionValues` is NOT "everything the planner reads". Three values the
// planner genuinely uses are deliberately outside it, and a job file that
// carried any of them would be worse than no job file at all, because the file
// LOOKS complete:
//
//   · `confirmedClear`   — an attestation that somebody looked at the machine TODAY;
//   · `useWorkpieceEdge` — a statement about the stock on the machine right now;
//   · `plant`            — a deliberate defect, four of which post a runnable program.
//
// The bound is enforced by CONSTRUCTION — `encodeJob` picks `SESSION_KEYS`
// rather than spreading what it is handed — so the plant below is the whole
// point of this file: an object carrying all three goes in, and none of them
// comes out. A rule nobody has watched fail is not a rule.
//
// ⚠ WHAT IS NOT ASSERTED HERE: that opening a job restores anything. That is the
// ORDINARY session restore, which `store.ts` already owns and which is exercised
// where it lives — the job path deliberately has no second restore of its own,
// because two would disagree the first time a field changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodeJob,
  JOB_FILE_KIND,
  JOB_FILE_VERSION,
  JOB_NOT_SAVED,
  parseJobFile,
  SESSION_KEYS,
  SESSION_VERSION,
  type SessionValues,
} from '../src/store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...p: string[]) => readFileSync(join(HERE, '..', 'src', ...p), 'utf8');

/** A setup with a few recognisable values in it. Partial and cast: `encodeJob`
 *  picks the keys it knows, which is exactly the property under test. */
const VALUES = {
  travelX: 1250,
  travelY: 670,
  travelZ: 120,
  depthPerPass: 3.5,
  rpm: 18000,
  toolIds: ['End Mill - Down-cut 6mm 2F'],
  material: 'plywood',
  spoilboardThickness: '',
  clamps: [],
  drawings: [],
} as unknown as SessionValues;

/* ════════════════════════════════════════════════════════════════════════════
   1. THE PLANT: something that must never be saved, handed straight in
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 WATCHED RED. Replacing the pick loop in `encodeJob` with a spread fails
 * this on all three fields — confirmed by doing exactly that before the loop was
 * written. It is the shape of the failure that matters: nobody would ever DECIDE
 * to save an attestation; it arrives because a state object grew a key and
 * somebody wrote `{ ...values }`.
 */
test('a job file cannot carry the bed-clear attestation, the edge switch or a plant', () => {
  const rogue = {
    ...VALUES,
    confirmedClear: true,
    useWorkpieceEdge: true,
    plant: 'gouge',
    job: 'pocket',
    sectionZ: 12,
  } as unknown as SessionValues;

  const text = encodeJob(rogue, 1);
  const file = JSON.parse(text);
  for (const banned of ['confirmedClear', 'useWorkpieceEdge', 'plant', 'job', 'sectionZ']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(file.session.values, banned),
      false,
      `"${banned}" was written into a job file`,
    );
  }
  /* And not anywhere else in the envelope either — a value smuggled into a
   * summary line is still a value that travelled. */
  assert.doesNotMatch(JSON.stringify(file.session), /gouge|"confirmedClear"/);
});

/**
 * 🔴 THE BOUND IS STATED AT SAVE TIME, IN THE FILE. The person opening this in
 * six months is holding the artefact, not the source, and a file that looks
 * complete is precisely the failure.
 */
test('the file states what it does not carry, and names each one', () => {
  const file = JSON.parse(encodeJob(VALUES, 1));
  assert.equal(file.kind, JOB_FILE_KIND);
  assert.equal(file.version, JOB_FILE_VERSION);
  assert.ok(Array.isArray(file.not_saved) && file.not_saved.length >= 3);
  const fields = file.not_saved.map((n: { field: string }) => n.field).join(' ');
  for (const f of ['confirmedClear', 'useWorkpieceEdge', 'plant']) {
    assert.match(fields, new RegExp(f), `the file does not say it omits ${f}`);
  }
  for (const n of JOB_NOT_SAVED) {
    assert.ok(n.why.length > 40, `"${n.field}" is listed with no reason — a bare list is not a bound`);
  }
  assert.match(file.note, /setup, not the program/);
});

/** ⚠ AND THE LIST THE PICK RUNS ON HOLDS NONE OF THEM — the mechanical half. If
 *  one is ever added to `SessionValues`, this fails before anybody ships it. */
test('SESSION_KEYS names nothing that must not be saved', () => {
  for (const banned of ['confirmedClear', 'useWorkpieceEdge', 'plant']) {
    assert.ok(
      !(SESSION_KEYS as readonly string[]).includes(banned),
      `"${banned}" entered SessionValues — a job file now carries it`,
    );
  }
  assert.ok(SESSION_KEYS.includes('toolIds') && SESSION_KEYS.includes('material'));
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The round trip, over exactly the bound
   ════════════════════════════════════════════════════════════════════════════ */

test('what is written is what is read back — over SESSION_KEYS and nothing else', () => {
  const parsed = parseJobFile(encodeJob(VALUES, 7));
  assert.equal(parsed.status, 'ok');
  if (parsed.status !== 'ok') return;
  const session = JSON.parse(parsed.session);
  assert.equal(session.kind, '2bee.app session config');
  assert.equal(session.version, SESSION_VERSION);
  for (const k of Object.keys(VALUES as unknown as Record<string, unknown>)) {
    assert.deepEqual(
      session.values[k],
      (VALUES as unknown as Record<string, unknown>)[k],
      `"${k}" did not survive the round trip`,
    );
  }
  /* Nothing extra rode along. */
  assert.deepEqual(
    Object.keys(session.values).sort(),
    Object.keys(VALUES as unknown as Record<string, unknown>).sort(),
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   3. Refuse BEFORE replacing
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE ORDER IS THE CONTROL. A check that runs after the destructive step has
 * destroyed the thing it was protecting: opening a job overwrites the operator's
 * stored setup, and a file whose settings generation this build cannot read
 * would then restore NOTHING over a setup that was fine.
 */
test('every refusal says nothing was replaced, and names why', () => {
  const cases: [string, RegExp][] = [
    ['not json at all', /not readable JSON/],
    [JSON.stringify({ kind: 'something else' }), /not a job for this app/],
    [JSON.stringify({ kind: JOB_FILE_KIND }), /NEWER version/],
    [JSON.stringify({ kind: JOB_FILE_KIND, version: 99 }), /NEWER version/],
    [JSON.stringify({ kind: JOB_FILE_KIND, version: 1 }), /no setup this app recognises/],
    [
      JSON.stringify({
        kind: JOB_FILE_KIND,
        version: 1,
        session: { kind: '2bee.app session config', version: SESSION_VERSION + 1, values: {} },
      }),
      /different version of this app/,
    ],
  ];
  for (const [text, why] of cases) {
    const r = parseJobFile(text);
    assert.equal(r.status, 'refused', `this was accepted: ${text.slice(0, 60)}`);
    if (r.status !== 'refused') continue;
    assert.match(r.why, why);
    assert.match(
      r.why,
      /[Nn]othing was replaced|discarded the setup you have now/,
      `a refusal that does not say the current setup is untouched: ${r.why}`,
    );
  }
});

/** ⚠ AND THE PARSER TOUCHES NO STORAGE. It is the half that runs first, so it
 *  must be incapable of the destructive step it guards. */
test('parseJobFile cannot write anything', () => {
  const src = source('store.ts');
  const fn = /export function parseJobFile\(text: string\): JobRead \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, 'parseJobFile was renamed — blind, not green');
  assert.doesNotMatch(fn![1], /localStorage|installJob|setItem/, 'the parser writes');
});

/**
 * 🔴 AND THE CALLER KEEPS THE ORDER. `App.tsx` must return on a refusal before
 * `installJob` is reached — the runtime half of the same rule.
 */
test('the open handler refuses before it installs', () => {
  const app = source('App.tsx');
  const handler = /const parsed = parseJobFile\(await f\.text\(\)\);([\s\S]*?)window\.location\.reload\(\);/.exec(
    app,
  );
  assert.ok(handler, 'the open-job handler moved — blind, not green');
  const body = handler![1];
  const refuse = body.indexOf("parsed.status === 'refused'");
  const install = body.indexOf('installJob(parsed)');
  assert.ok(refuse >= 0 && install >= 0, 'the handler no longer both refuses and installs');
  assert.ok(refuse < install, 'a job is installed before the file is checked');
  assert.match(body, /return;[\s\S]*?installJob/, 'the refusal branch does not stop');
});

/* ════════════════════════════════════════════════════════════════════════════
   4. One gathering, two consumers
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE SAVE AND THE SESSION WRITE READ ONE OBJECT. Two gatherings would be two
 * lists of fields, and the day they drift the job file quietly stops carrying
 * something the reload still does — invisible until somebody opens the file on
 * another machine.
 */
test('the job file and the stored session are built from the same object', () => {
  const app = source('App.tsx');
  assert.match(app, /const sessionValues: SessionValues = useMemo\(/, 'the gathering moved — blind');
  assert.match(app, /writeSession\(sessionValues\)/, 'the session write no longer uses it');
  assert.match(app, /encodeJob\(sessionValues, Date\.now\(\)\)/, 'the job file gathers its own fields');
});
