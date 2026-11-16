/*
 * START-STALE in a real browser (reviewer P0, 2026-11-12; modelled on the
 * reviewer's repro `stale_start.mjs`). Runs against the DEV harness
 * `print3d.html`, like print3d.spec.ts.
 *
 * Physical failure guarded: a plate is uploaded for PETG in AMS slot 3, then its
 * part is moved to slot 1 (PLA) and re-sliced. Before the fix Start stayed on and
 * sent the OLD file with the NEW slice's mapping [0] and types ['PLA'].
 *
 * Watched: after the re-slice the old upload is gone and Start is not offered;
 * no /v1/start reaches the printer fake; uploading again sends the NEW mapping
 * WITH the file, and Start then sends exactly the mapping and types of that
 * upload, for that upload's remote file.
 *
 * 🔴 BOTH bridges are page.route fakes (and `/__print3d`, `/__printer` too): no
 * run of this file can reach a real printer bridge or a real X2D.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Route } from '@playwright/test';

const DEV = `http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };

function cubeStl(): Buffer {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const b = Buffer.alloc(84 + 50 * f.length);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((k, j) => v[k].forEach((c, a) => b.writeFloatLE(c, 84 + 50 * i + 12 + 12 * j + 4 * a))));
  return b;
}

test('START-STALE: a re-slice drops the upload; Start only ever sends the mapping of the file it starts', async ({ page }) => {
  const json = (route: Route, obj: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const printerSeen: { path: string; body: Record<string, unknown> }[] = [];
  let sliceN = 0;
  const engine = async (route: Route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const p = new URL(r.url()).pathname.replace(/^\/__print3d/, '');
    if (p === '/v1/health') return json(route, { ok: true, engine: { id: 'twobee-fdm', label: '2bee.fdm', bin: '/f', found: true, printed: false, defaults: '/f', defaultsFound: true }, machine: { name: 'Bambu Lab X2D 0.4 nozzle', found: true } });
    if (p === '/v1/profiles') return json(route, { process: [{ name: '0.20mm Standard @BBL X2D', source: 'system' }], filament: [{ name: 'Generic PETG @BBL X2D 0.4 nozzle', source: 'system' }], bedTypes: ['Textured PEI Plate'], defaultBed: 'Textured PEI Plate', bed: { area: ['0x0', '256x0', '256x256', '0x256'], height: 260 } });
    if (p === '/v1/slots') return json(route, { ok: true, bedPlate: 'Textured PEI Plate', slots: [{ id: 'ams1-1', label: 'AMS slot 1', type: 'PLA', color: '#ffffff' }, { id: 'ams1-3', label: 'AMS slot 3', type: 'PETG', color: '#2e9e5b' }], types: ['PLA', 'PETG'], bedTypes: ['Textured PEI Plate'] });
    if (p === '/v1/job/upload') {
      const buf = r.postDataBuffer() ?? Buffer.alloc(0);
      return json(route, { ok: true, sha256: createHash('sha256').update(buf).digest('hex'), name: 'cube.stl', size: buf.length, triangles: 12, size3d: { x: 10, y: 10, z: 10 } });
    }
    if (p === '/v1/job/slice') {
      sliceN++;
      const body = JSON.parse(r.postData() || '{}');
      const slot = body.objects?.[0]?.slot ?? 'ams1-3';
      const type = slot === 'ams1-1' ? 'PLA' : 'PETG';
      return json(route, {
        ok: true, id: `slice${sliceN}-${slot}`, seconds: '1.0', engine: 'twobee-fdm', bedIndex: 1,
        objects: [{ index: 0, name: 'cube.stl', slot, placement: { x: 128, y: 128, rot: 0 } }],
        filaments: [{ id: 1, slot, slotLabel: slot, type, color: '#2E9E5B', preset: `Generic ${type} @BBL X2D 0.4 nozzle` }],
        slotChecks: [{ slot, slotType: type, preset: `Generic ${type}`, presetType: type, ok: true }], warnings: [], multiFilament: false,
        stats: { totalTime: '10m 1s', printTime: null, layers: '50', filamentG: '0.63', filamentMm: null, bedType: 'Textured PEI Plate', nozzleTemp: type === 'PLA' ? '220' : '255', layerHeight: '0.2' },
        analysis: { toolChanges: 0, filaments: [{ grams: 0.63 }] }, bedRequested: 'Textured PEI Plate',
      });
    }
    if (p.startsWith('/v1/gcode/')) {
      const id = p.slice('/v1/gcode/'.length);
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/plain' }, body: `; HEADER_BLOCK_START\n; ${id}\n; filament_type = ${id.endsWith('ams1-1') ? 'PLA' : 'PETG'}\nM83\nG1 X10 Y10\nG1 X20 Y10 E1\n` });
    }
    if (p === '/v1/job/list') return json(route, { ok: true, dir: '/f', jobs: [] });
    return json(route, { ok: false, error: `no route ${p}` }, 404);
  };
  let uploads = 0;
  const printer = async (route: Route) => {
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const p = new URL(r.url()).pathname.replace(/^\/__printer/, '');
    const body = JSON.parse(r.postData() || '{}');
    printerSeen.push({ path: p, body });
    if (p === '/v1/check') return json(route, { reachable: true, haveCode: true, haveSerial: true, printer: '192.0.2.1' });
    if (p === '/v1/status') return json(route, { ok: true, state: 'IDLE', task: '', percent: null, layer: null, layers: null, remainMin: null, nozzle: 25, nozzleTarget: 0, bed: 25, bedTarget: 0, error: 0, light: 'off', slots: [{ id: 'ams1-1', type: 'PLA' }, { id: 'ams1-3', type: 'PETG' }] });
    if (p === '/v1/upload') { uploads++; return json(route, { ok: true, remote: `cube-plate1_UP${uploads}.gcode.3mf`, bytes: 2048, remoteBytes: 2048, md5: `md5-${uploads}`, started: false }); }
    if (p === '/v1/start') return json(route, { ok: true, started: true, state: 'PREPARE' });
    return json(route, { ok: false, error: 'no route' }, 404);
  };
  // SAFETY: every bridge-shaped request is answered here; anything else bridge-like is aborted, never continued.
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (/127\.0\.0\.1:8789|__print3d/.test(u)) return engine(route);
    if (/127\.0\.0\.1:8788|__printer/.test(u)) return printer(route);
    if (/:878\d|:9222|:9334|__claude/.test(u)) return route.abort();
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('2bee.app.print3d.bridges', JSON.stringify({ engine: { url: 'http://127.0.0.1:8789', token: 'e2e-engine-token-0123456789', remember: true }, printer: { url: 'http://127.0.0.1:8788', token: 'e2e-printer-token-0123456789', remember: true } }));
  });
  const starts = () => printerSeen.filter((s) => s.path === '/v1/start');
  const ups = () => printerSeen.filter((s) => s.path === '/v1/upload');
  const tickAll = async () => {
    const ids = await page.$$eval('[data-testid^="p3d-tick-"]', (els) => els.map((e) => e.getAttribute('data-testid')!).filter((t) => t !== 'p3d-tick-atprinter'));
    for (const t of ids) await page.getByTestId(t).check();
  };

  await page.goto(`${DEV}/print3d.html`);
  await page.getByTestId('p3d-file').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: cubeStl() });
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 30_000 });
  await page.getByTestId('p3d-row-slot-1').selectOption('ams1-3');
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 30_000 });

  // Upload #1 (PETG in slot 3): the mapping goes WITH the file.
  await tickAll();
  await page.getByTestId('p3d-upload-btn').click();
  await expect(page.getByTestId('p3d-upload-done')).toBeVisible();
  expect(ups()[0].body).toMatchObject({ amsMapping: [2], expectTypes: ['PETG'] });
  // Positive control: Start IS offered for the file that matches the plate.
  await page.getByTestId('p3d-tick-atprinter').check();
  await expect(page.getByTestId('p3d-start-btn')).toBeEnabled();

  // The plate changes: the part moves to slot 1 (PLA) and is re-sliced.
  await page.getByTestId('p3d-row-slot-1').selectOption('ams1-1');
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 30_000 });
  await page.waitForTimeout(500);
  await expect(page.getByTestId('p3d-upload-done')).toHaveCount(0);
  await expect(page.getByTestId('p3d-start-btn')).toHaveCount(0);
  expect(starts()).toHaveLength(0);

  // Upload #2, then Start: exactly the mapping and types of upload #2, for upload #2's file.
  await tickAll();
  await page.getByTestId('p3d-upload-btn').click();
  await expect(page.getByTestId('p3d-upload-done')).toContainText('UP2');
  expect(ups()[1].body).toMatchObject({ amsMapping: [0], expectTypes: ['PLA'] });
  await page.getByTestId('p3d-tick-atprinter').check();
  await page.getByTestId('p3d-start-btn').click();
  await expect(page.getByTestId('p3d-action-done')).toContainText('PREPARE');
  expect(starts()).toHaveLength(1);
  expect(starts()[0].body).toMatchObject({ remote: 'cube-plate1_UP2.gcode.3mf', amsMapping: [0], expectTypes: ['PLA'], confirm: 'at-printer' });
});
