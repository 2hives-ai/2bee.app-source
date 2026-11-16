/**
 * cnc.machines — the chat's machine patch reader (src/machines/machineAsk.ts).
 * A refusal must refuse the WHOLE patch, and a value outside the bounds or a key
 * outside the list must never reach a setter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMachineRequest, machineRows, readMachineProposal, type MachineFields } from '../src/machines/machineAsk.ts';

const cur: MachineFields = { travelX: 600, travelY: 900, travelZ: 100, safeZ: 5, colletMm: 6, spindleMax: 24000, supportsArcs: true };

test('a fenced JSON reply with in-bounds values is read, and unchanged values drop out', () => {
  const r = readMachineProposal('```json\n{"patch":{"travelX":1200,"travelY":900},"why":"a 1290"}\n```', cur);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.patch, { travelX: 1200 });
  assert.deepEqual(machineRows(cur, { travelX: 1200 }), ['Travel X: 600 mm → 1200 mm']);
});

test('one bad field refuses the whole patch', () => {
  const r = readMachineProposal('{"patch":{"travelX":1200,"colletMm":80}}', cur);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problems.join(' ') : '', /Collet 80 mm is outside/);
});

test('a key outside the list is refused, not ignored', () => {
  const r = readMachineProposal('{"patch":{"feedRate":5000}}', cur);
  assert.equal(r.ok, false);
});

test('strings for numbers are refused', () => {
  assert.equal(readMachineProposal('{"patch":{"travelZ":"120"}}', cur).ok, false);
});

test('safe Z at or above travel Z is refused', () => {
  assert.equal(readMachineProposal('{"patch":{"safeZ":100}}', cur).ok, false);
});

test('a reply that is not JSON is refused with a sentence', () => {
  const r = readMachineProposal('Sure, your machine is 600 by 900.', cur);
  assert.equal(r.ok, false);
});

test('the request carries the current fields and the bearer only when a key is set', () => {
  const req = buildMachineRequest({ endpoint: 'e', model: 'm', apiKey: '', rememberKey: false, timeoutMs: 1000 }, 'hi', cur, 'MakerSpace 6090');
  assert.equal(req.headers.authorization, undefined);
  assert.match(req.body.messages[1].content, /"travelX":600/);
});
