import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { peers, register } from './bridge-registry.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reg-'));

test('register + peers: listed while alive, gone after unregister', () => {
  const d = tmp();
  const un = register('2bee.printer-bridge', 8788, d);
  assert.deepEqual(peers(d), [{ bridge: '2bee.printer-bridge', port: 8788 }]);
  un();
  assert.deepEqual(peers(d), []);
});

test('a dead pid, an unknown kind, a bad port, a renamed file and junk are all ignored', async () => {
  const d = tmp();
  const dead = await new Promise((r) => { const c = spawn(process.execPath, ['-e', '']); c.on('exit', () => r(c.pid)); });
  fs.writeFileSync(path.join(d, '8790.json'), JSON.stringify({ kind: '2bee.printer-bridge', port: 8790, pid: dead }));
  fs.writeFileSync(path.join(d, '8791.json'), JSON.stringify({ kind: 'something-else', port: 8791, pid: process.pid }));
  fs.writeFileSync(path.join(d, '8792.json'), JSON.stringify({ kind: '2bee.printer-bridge', port: 70000, pid: process.pid }));
  fs.writeFileSync(path.join(d, '8793.json'), JSON.stringify({ kind: '2bee.printer-bridge', port: 22, pid: process.pid }));
  fs.writeFileSync(path.join(d, '8794.json'), '{not json');
  // Positive control in the same dir: a good entry IS listed, so the empties above are real refusals.
  register('2bee.print3d-bridge', 8789, d);
  assert.deepEqual(peers(d), [{ bridge: '2bee.print3d-bridge', port: 8789 }]);
});

test('no registry dir: no peers, no throw; an unwritable dir: register is a no-op', () => {
  assert.deepEqual(peers(path.join(tmp(), 'missing')), []);
  const f = path.join(tmp(), 'file');
  fs.writeFileSync(f, '');
  assert.doesNotThrow(() => register('2bee.printer-bridge', 8788, path.join(f, 'sub'))());
});

test('only kinds and ports leave the module: no pid', () => {
  const d = tmp();
  register('2bee.printer-bridge', 8788, d);
  assert.deepEqual(Object.keys(peers(d)[0]).sort(), ['bridge', 'port']);
});
