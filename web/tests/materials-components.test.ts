/**
 * materials tab — PCB components (src/materials/components.ts): aggregation by
 * part, bom status, JLC snapshot, your count, boards buildable, the AI reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONHAND_KEY,
  aggregateComponents,
  buildable,
  readOnHand,
  readOnHandProposal,
  readSourcedParts,
  readStockSnapshot,
  writeOnHand,
} from '../src/materials/components.ts';

const H = '"Reference","Qty","Value","Package","Manufacturer","Mfr_PN","LCSC_PN","Note","DNP"\n';
const A = H + '"R1,R2","2","100k","R0402","UR","0402WGF1003TCE","C25741","",""\n"U1","1","LDO","SOT-23-5","X","XC6206","",""\n"R9","1","0R","R0402","UR","","","","DNP"\n';
const B = H + '"R1,R2,R3","3","100k","R0402","UR","0402WGF1003TCE","c25741","",""\n"J1","1","hdr","2.54","","","","",""\n';
const SOURCED = 'part,value,footprint,lcsc,status,note\n100k,100k,0402,C25741,CONFIRMED,ok\nLDO,LDO,SOT,C99,DEAD,"404, gone"\n';
const SNAP = '{"_meta":{"date":"2026-10-10"},"parts":{"C25741":{"stock":14327249}}}';

const rows = () => aggregateComponents([{ boardId: 'a', bom: A }, { boardId: 'b', bom: B }], readSourcedParts(SOURCED), readStockSnapshot(SNAP));

test('parts aggregate by LCSC (case-insensitive), else MPN, else value · package; DNP left out', () => {
  const r = rows();
  assert.deepEqual(r.map((x) => x.key).sort(), ['C25741', 'XC6206', 'hdr · 2.54'].sort());
  assert.deepEqual(r[0].perBoard, { a: 2, b: 3 });
  assert.equal(r[0].jlcStock, 14327249);
  assert.equal(r[0].bad, false);
  const ldo = r.find((x) => x.key === 'XC6206')!;
  assert.equal(ldo.keyKind, 'mpn');
  assert.equal(ldo.jlcStock, null);
  assert.equal(r.find((x) => x.key === 'hdr · 2.54')!.keyKind, 'none');
});

test('a DEAD bom status marks the part bad', () => {
  const r = aggregateComponents([{ boardId: 'x', bom: H + '"U1","1","LDO","SOT","","","C99","",""\n' }], readSourcedParts(SOURCED), readStockSnapshot(SNAP));
  assert.equal(r[0].bad, true);
  assert.equal(r[0].bom[0].note, '404, gone');
});

test('boards buildable: uncounted counts as zero and is named; short lists the stoppers', () => {
  const r = rows();
  const none = buildable('a', r, {});
  assert.equal(none.boards, 0);
  assert.deepEqual(none.notCounted.sort(), ['C25741', 'XC6206']);
  const some = buildable('a', r, { C25741: 9, XC6206: 3 });
  assert.equal(some.boards, 3); // XC6206 3 / 1 = 3, C25741 9 / 2 = 4
  assert.deepEqual(some.short.map((s) => s.key), ['XC6206']);
  assert.equal(buildable('nope', r, {}).parts, 0);
});

test('JLC stock never counts as yours', () => {
  assert.equal(buildable('b', rows(), {}).boards, 0);
});

test('your count round-trips; a bad store reads as {} and never throws', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(writeOnHand(store, { C25741: 8000 }), null);
  assert.deepEqual(readOnHand(store), { C25741: 8000 });
  m.set(ONHAND_KEY, '[1,2]');
  assert.deepEqual(readOnHand(store), {});
  m.set(ONHAND_KEY, '{"C1":-1,"C2":1.5,"C3":"4","C4":7}');
  assert.deepEqual(readOnHand(store), { C4: 7 });
  m.set(ONHAND_KEY, '{oops');
  assert.deepEqual(readOnHand(store), {});
});

test('the chat sets counts only for parts the boards need, as whole numbers; one bad entry refuses all', () => {
  const r = rows();
  const ok = readOnHandProposal('{"onHand":{"c25741":8000},"why":"2 reels x 4000"}', r);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.set, { C25741: 8000 });
  assert.equal(readOnHandProposal('{"onHand":{"C25741":8000,"C13585":4000}}', r).ok, false);
  assert.equal(readOnHandProposal('{"onHand":{"C25741":2.5}}', r).ok, false);
  assert.equal(readOnHandProposal('{"onHand":{"C25741":-1}}', r).ok, false);
  assert.equal(readOnHandProposal('{"onHand":[1]}', r).ok, false);
  assert.equal(readOnHandProposal('nothing', r).ok, false);
});

test('a broken snapshot / sourced file reads as empty', () => {
  assert.deepEqual(readStockSnapshot('{bad').stock.size, 0);
  assert.equal(readStockSnapshot('{bad').date, null);
  assert.equal(readSourcedParts('').size, 0);
});
