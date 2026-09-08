// The spoilboard declaration across a refresh, and across a change of machine.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THESE TWO DEFECTS WERE, AND WHY THEY ARE ONE FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 **#89 — the declaration died on every refresh.** `SessionValues` carried no
// spoilboard field at all: not the catalogue id, not the corner, not the size,
// not the assumed/entered flag. A reload silently reverted the board to
// UNDECLARED, and with no board declared every below-the-workpiece cut is judged
// on DEPTH ALONE — *over the sacrificial board* and *into the machine frame*
// then read identically (`docs/terminology.md` §9, S1).
//
// ⚠ It failed in the SAFE direction. Reverting to UNCHECKED costs a false
// pending, never a false green — which is exactly why nobody reading the panel
// would notice, and why a test is the only thing that can see it.
//
// 🔴 **#88 — a board followed you onto a different machine.** `readSpoilboard`
// implemented exactly the right check, a travel fingerprint that drops the
// position BY NAME on a mismatch, and had **zero production callers**: a
// definition, four test call sites, and a `spoilboards` store nothing wrote or
// read. *A guard armed only by its own test.*
//
// They are one file because they are one defect with two doors: a corner that is
// a MACHINE coordinate, carried across a boundary that changed the machine. Both
// doors now go through `spoilboardForMachine`, so both are tested here through
// the same call the product makes.
//
// ⚠ WHAT THIS FILE CANNOT REACH. `App.tsx` cannot be imported in node — the
// loader stops at the sample asset imports (`Unknown file extension ".dxf"`),
// measured again while writing this and recorded three times before. So nothing
// here renders JSX or observes a React state update. The wiring inside `App.tsx`
// is guarded as TEXT in `config-wiring.test.ts`, which proves *"unchanged"* and
// never *"correct"*, and the browser leg is `web/e2e/`'s.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/* A fake `localStorage`, installed BEFORE the module is imported — the same
 * pattern and the same reason as `tabs.test.ts`. `store.ts` touches storage only
 * inside its functions, never at module scope. */
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  SESSION_KEY,
  SESSION_VERSION,
  readSession,
  writeSession,
  readSessionSpoilboard,
  spoilboardForMachine,
} = await import('../src/store.ts');
type SessionValues = import('../src/store.ts').SessionValues;
type SpoilboardState = import('../src/store.ts').SpoilboardState;

/** A complete, valid blob. Every test writes a variation of exactly this, so a
 *  failure is about the field under test and not about a half-built fixture. */
const BASE: SessionValues = {
  travelX: 1250,
  travelY: 670,
  travelZ: 100,
  safeZ: 5,
  colletMm: 6,
  spindleMax: 24000,
  probeEnabled: false,
  touchPlateMm: '',
  touchPlateId: '',
  supportsArcs: true,
  spoilboardId: 'mdf-2400x1200-16',
  spoilboardX: '-575',
  spoilboardY: '-265',
  spoilboardSizeX: '',
  spoilboardSizeY: '',
  /* `''` = NOT DECLARED, which is the state every session written before
   * 2026-08-11 is in and the state the core reports as PENDING. */
  spoilboardThickness: '',
  spoilboardName: '',
  spoilboardPos: 'entered',
  spoilboardTravels: [1250, 670, 100],
  stockX: 600,
  stockY: 900,
  thickness: 18,
  zZeroTop: true,
  originX: 0,
  originY: 0,
  rotation: 0,
  depthPerPass: 4,
  rpm: 18000,
  entry: 'Ramp',
  direction: 'Climb',
  dogbone: 'Corner',
  tabsEnabled: true,
  tabHeight: 3,
  tabWidth: 8,
  tabSpacing: 150,
  finishAllowance: 0,
  leadMm: 0,
  probeAfterChange: true,
  clamps: [],
  workholdingId: '',
  dark: true,
  simCell: 0.6,
  material: 'Plywood',
  toolIds: [],
  drawings: [],
  extraToolsCount: 0,
};

/** Read back what `writeSession` wrote, with a named failure if it did not. */
function roundTrip(v: SessionValues) {
  mem.clear();
  assert.equal(writeSession(v), null, 'the write itself failed');
  const r = readSession();
  assert.equal(r.status, 'ok', `the blob did not read back: ${JSON.stringify(r)}`);
  if (r.status !== 'ok') throw new Error('unreachable');
  return r;
}

/** Edit the stored blob's `values` directly — for the cases a well-behaved
 *  writer cannot produce (a missing key, a hand-edited number, an old schema). */
function storeRaw(values: Record<string, unknown>) {
  mem.set(
    SESSION_KEY,
    JSON.stringify({
      kind: '2bee.app session config',
      /* 🔴 THE CURRENT version, not a literal. These tests exercise the
       * field-by-field restore rules, so the blob must be one this build
       * considers CURRENT — a hardcoded number turns every legitimate
       * SESSION_VERSION bump into five red tests about provenance keys,
       * which is what happened when 2 -> 3 landed for the z-datum meaning
       * change. The incompatible-blob case is asserted separately, on
       * purpose, with a version that is deliberately wrong. */
      version: SESSION_VERSION,
      saved_at: 1_700_000_000_000,
      values,
    })
  );
}

// ---------------------------------------------------------------------------
// #89 — the declaration survives the round trip
// ---------------------------------------------------------------------------

test('#89 — every field of the spoilboard declaration survives a write and a read', () => {
  const r = roundTrip(BASE);
  assert.equal(r.values.spoilboardId, 'mdf-2400x1200-16');
  assert.equal(r.values.spoilboardX, '-575');
  assert.equal(r.values.spoilboardY, '-265');
  assert.equal(r.values.spoilboardPos, 'entered');
  assert.deepEqual(r.values.spoilboardTravels, [1250, 670, 100]);
  for (const k of ['spoilboardId', 'spoilboardX', 'spoilboardY', 'spoilboardPos']) {
    assert.ok(r.restored.includes(k as never), `${k} was not reported as restored`);
  }
  assert.deepEqual(r.dropped, [], 'a clean blob dropped something');
});

test('#89 — the position is a NEGATIVE machine coordinate and must survive as one', () => {
  /* 🔴 THE BOUND THAT WOULD HAVE BEEN WRONG. A spoilboard corner is a MACHINE
   * coordinate: a 2400×1200 board auto-fitted for a 1250×670 machine sits at
   * `-575, -265`. A non-negative rule — the one `touchPlateMm` correctly uses —
   * would drop a perfectly good measured corner and report the board as
   * position-not-entered, a false red manufactured in the browser that no
   * operator could act on. */
  const r = roundTrip({ ...BASE, spoilboardX: '-575.5', spoilboardY: '-265' });
  assert.equal(r.values.spoilboardX, '-575.5');
  assert.equal(r.values.spoilboardY, '-265');
});

test('#89 — blank and zero stay different answers through storage', () => {
  /* `''` is NOT ENTERED, which the core refuses on; `'0'` is a measured corner
   * at the datum, which the core plans from. A number type would collapse them
   * into the dangerous one — `0,0` slides the declared board toward the datum
   * and turns bare rail into declared spoilboard. */
  const blank = roundTrip({ ...BASE, spoilboardX: '', spoilboardY: '' });
  assert.equal(blank.values.spoilboardX, '', 'blank came back as something else');
  assert.equal(blank.values.spoilboardY, '');

  const zero = roundTrip({ ...BASE, spoilboardX: '0', spoilboardY: '0', spoilboardTravels: undefined });
  assert.equal(zero.values.spoilboardX, '0', 'a measured zero came back as blank');
  assert.notEqual(zero.values.spoilboardX, blank.values.spoilboardX);
});

test('#89 — a MISSING provenance key restores as `assumed`, never as `entered`', () => {
  /* 🔴 THE ONE FIELD WHOSE DEFAULT IS A SAFETY PROPERTY. `'entered'` means a
   * human measured this corner and typed it. Manufacturing that out of an absent
   * key launders this app's own arithmetic through a flag that means somebody
   * looked — and `'assumed'` is what every surface reads to decide whether to
   * qualify its answer and withhold the green. */
  storeRaw({ ...BASE, spoilboardPos: undefined });
  const r = readSession();
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.values.spoilboardPos, undefined, 'an absent key must restore NOTHING');

  const applied = readSessionSpoilboard(r.values, [1250, 670, 100], 1);
  assert.equal(applied.values.pos, 'assumed', 'a missing key became a human’s statement');
});

test('#89 — an UNKNOWN provenance word is dropped by name, and lands on `assumed`', () => {
  storeRaw({ ...BASE, spoilboardPos: 'measured-by-eye' });
  const r = readSession();
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.values.spoilboardPos, undefined);
  assert.ok(
    r.dropped.some((d) => d.field === 'spoilboardPos'),
    'an unknown provenance word vanished without a line in the banner'
  );
  assert.equal(readSessionSpoilboard(r.values, [1250, 670, 100], 1).values.pos, 'assumed');
});

test('#89 — a session with no board at all restores no board, and that is not a drop', () => {
  const r = roundTrip({
    ...BASE,
    spoilboardId: '',
    spoilboardX: '',
    spoilboardY: '',
    spoilboardPos: 'assumed',
    spoilboardTravels: undefined,
  });
  const applied = readSessionSpoilboard(r.values, [1250, 670, 100], 1);
  assert.equal(applied.values.id, '');
  assert.deepEqual(applied.dropped, [], 'an undeclared board reported a drop');
  assert.equal(applied.provenance, null);
});

test('#89 — a blob written before these keys existed opens undeclared rather than failing', () => {
  /* The compatibility case that decided NOT to bump `SESSION_VERSION`: adding
   * keys is not a rename and not a change of meaning, and a bump restores
   * NOTHING for every existing user. An old blob must simply come back with no
   * board — which is the state a fresh app is in and the state the core reports
   * as UNCHECKED. */
  const old: Record<string, unknown> = { ...BASE };
  for (const k of Object.keys(old)) if (k.startsWith('spoilboard')) delete old[k];
  storeRaw(old);
  const r = readSession();
  assert.equal(r.status, 'ok', 'an older-but-compatible blob stopped restoring');
  if (r.status !== 'ok') return;
  assert.equal(r.values.travelX, 1250, 'the rest of the session did not come back');
  assert.equal(
    r.dropped.filter((d) => d.field.startsWith('spoilboard')).length,
    0,
    'absent keys were reported as drops, which would put a line in the banner every load'
  );
  const applied = readSessionSpoilboard(r.values, [1250, 670, 100], 1);
  assert.equal(applied.values.id, '');
  assert.equal(applied.values.pos, 'assumed');
  assert.equal(applied.values.travels, null);
});

// ---------------------------------------------------------------------------
// #88 — the guard, armed
// ---------------------------------------------------------------------------

const ON_1250x670: SpoilboardState = {
  id: 'mdf-2400x1200-16',
  x: '-575',
  y: '-265',
  sizeX: '',
  sizeY: '',
  thickness: '',
  name: '',
  pos: 'entered',
  travels: [1250, 670, 100],
};

test('#88 — a board does NOT follow you onto a different machine', () => {
  /* The measured case from the audit: a 2400×1200 board auto-fitted for a
   * 1250×670 machine (corner -575,-265) reported `past: 0` on a 6090 — rendered
   * as "none — the board covers the whole reach" — where the honest 6090
   * declaration on the same job gives 2204 frame-strike cells. */
  const on6090 = spoilboardForMachine(ON_1250x670, [600, 900, 100], 5);
  assert.equal(on6090.values.id, 'mdf-2400x1200-16', 'the board itself must still come back');
  assert.equal(on6090.values.x, '', 'the corner followed the operator to another machine');
  assert.equal(on6090.values.y, '');
  assert.equal(on6090.dropped.length, 1);
  assert.equal(on6090.dropped[0].field, 'spoilboardPosition');
  assert.match(on6090.dropped[0].reason, /MACHINE coordinates/);
  assert.equal(on6090.provenance, null);
});

test('#88 — THE DANGEROUS PERMUTATION: `entered` does not survive the move either', () => {
  /* 🔴 A corner a human measured on machine A staying green on machine B, *with
   * provenance saying it was measured*, is the worst state this app can be in —
   * `'entered'` is the strongest statement it makes about a number. It must not
   * be left attached to two empty fields, and it must not be left attached to a
   * rectangle in the wrong place. */
  const moved = spoilboardForMachine(ON_1250x670, [600, 900, 100], 5);
  assert.equal(moved.values.pos, 'assumed', '“entered by you” survived over an empty corner');
  assert.equal(moved.values.travels, null, 'a stale fingerprint would MATCH on the way back');
});

test('#88 — the same travels keep the corner, and return PROVENANCE rather than a green', () => {
  const same = spoilboardForMachine(ON_1250x670, [1250, 670, 100], 5);
  assert.equal(same.values.x, '-575');
  assert.equal(same.values.pos, 'entered', 'a match must not downgrade a measured corner');
  assert.deepEqual(same.values.travels, [1250, 670, 100]);
  assert.equal(same.dropped.length, 0);
  /* Identical travels cannot prove identity: two machines of the same model in
   * one shop may have their boards bolted in different places. */
  assert.match(same.provenance ?? '', /not proof of the same machine/);
});

test('#88 — an UNKNOWN machine is treated as a different one, not as fine', () => {
  const noFingerprint = spoilboardForMachine(
    { ...ON_1250x670, travels: null },
    [1250, 670, 100],
    5
  );
  assert.equal(noFingerprint.values.x, '');
  assert.equal(noFingerprint.values.pos, 'assumed');
  assert.match(noFingerprint.dropped[0].reason, /without recording which machine/);
});

test('#88 — a board with no position is not a drop, on any machine', () => {
  const noPos = spoilboardForMachine(
    { ...ON_1250x670, x: '', y: '', pos: 'assumed', travels: null },
    [600, 900, 100],
    5
  );
  assert.deepEqual(noPos.dropped, [], 'a board that never had a corner reported losing one');
  assert.equal(noPos.values.id, 'mdf-2400x1200-16');
});

test('#88 — Z counts: a machine that differs ONLY in Z is a different machine', () => {
  /* The fingerprint is all three travels. A shop with two otherwise-identical
   * gantries and a different Z clearance is a real configuration, and the corner
   * is no more transferable there than anywhere else. */
  const zOnly = spoilboardForMachine(ON_1250x670, [1250, 670, 80], 5);
  assert.equal(zOnly.values.x, '');
  assert.equal(zOnly.dropped.length, 1);
});

// ---------------------------------------------------------------------------
// The two doors meet: restore, then change machine
// ---------------------------------------------------------------------------

test('#88/#89 — the restore path and the machine-change path give the same answer', () => {
  /* 🔴 THE POINT OF ROUTING BOTH THROUGH ONE CALL. If these two ever disagree,
   * one of the doors has grown its own copy of the rule — which is how the guard
   * came to have four test call sites and no production caller in the first
   * place. */
  const r = roundTrip(BASE);
  const viaRestore = readSessionSpoilboard(r.values, [600, 900, 100], 5);
  const viaMachine = spoilboardForMachine(ON_1250x670, [600, 900, 100], 5);
  assert.deepEqual(viaRestore.values, viaMachine.values);
  assert.deepEqual(viaRestore.dropped.map((d) => d.field), viaMachine.dropped.map((d) => d.field));
});

test('#88/#89 — a travel that FAILED ITS OWN RULE drops the corner it was measured against', () => {
  /* 🔴 THE CASE THE FINGERPRINT EXISTS FOR INSIDE ONE BLOB. `travelX: 0` fails
   * the `pos` rule, so it is dropped and `App.tsx` opens on its default 600 —
   * while the corner, which is perfectly well-formed, sails through. The corner
   * then means a different place than it did, and nothing but this comparison
   * can tell. */
  storeRaw({ ...BASE, travelX: 0 });
  const r = readSession();
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.values.travelX, undefined, 'a zero travel was accepted');
  assert.ok(r.dropped.some((d) => d.field === 'travelX'));

  // The effective travels are what `App.tsx` will actually hold: the default.
  const applied = readSessionSpoilboard(r.values, [600, 670, 100], r.savedAt ?? 0);
  assert.equal(applied.values.x, '', 'the corner survived onto a machine it was not measured on');
  assert.equal(applied.values.pos, 'assumed');
  assert.equal(applied.dropped.length, 1);
});

test('#88/#89 — a wrecked fingerprint is unknown, and unknown is a mismatch', () => {
  /* Three positive millimetre figures, or nothing. `null`, `NaN`, a zero axis
   * and a two-element array are all "this does not name a machine", and a
   * comparison against a wrecked triple must never come out equal to another
   * wrecked triple. */
  for (const bad of [[1250, 670], [1250, 0, 100], [1250, 'x', 100], null, 'nope', [1250, 670, 100, 5]]) {
    storeRaw({ ...BASE, spoilboardTravels: bad });
    const r = readSession();
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') continue;
    assert.equal(
      r.values.spoilboardTravels,
      undefined,
      `${JSON.stringify(bad)} was accepted as a machine fingerprint`
    );
    const applied = readSessionSpoilboard(r.values, [1250, 670, 100], 1);
    assert.equal(applied.values.x, '', `${JSON.stringify(bad)} let a corner through unchecked`);
  }
});
