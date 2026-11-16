/*
 * The 2bee.3d tab (web/src/print3d/), mounted on its own through the DEV-ONLY
 * harness `web/print3d.html` — the tab is not wired into App.tsx yet (another
 * session owns App.tsx). So this spec runs against the DEV server, not preview.
 *
 * What this watches in a real browser, with BOTH bridges and the model replaced
 * by `page.route` fakes that record every request:
 *   · the banner says nothing has printed and that 2bee.fdm (this app's own
 *     engine) slices, not OrcaSlicer; the result names the engine that sliced;
 *   · there is no Start, Pause, Stop or Resume control anywhere on the tab;
 *   · without a slicer bridge the drop zone is disabled and the reason is shown;
 *   · an STL goes up, is arranged onto plate 1 BY THE APP (no /v1/job/plates),
 *     sliced at that placement (bedIndex 1, optimise off), and the result line
 *     shows the fake's numbers; every bridge request carries the bearer token;
 *   · a file holding two solids, one of them tilted, arrives as TWO parts, each
 *     laid flat, arranged apart on the plate; the model's layout actions are
 *     applied on Apply and a reply naming OrcaSlicer loses that sentence;
 *   · a chip answer changes `overrides` in the NEXT slice request;
 *   · the model's G-code key is refused on screen and never reaches a slice;
 *   · the upload button stays disabled until every checklist line is ticked,
 *     INCLUDING the calibration line a person ticks because 2bee.fdm has not
 *     printed (gate ENGINE),
 *     then sends the plate's G-code text to the printer bridge's /v1/upload —
 *     and the printer bridge is asked for /v1/check and /v1/upload, nothing else.
 *
 * 🔴 NOT watched here: a real 2bee.fdm slice and a real model answer (both are
 * run live in the commit body, and the slice is covered by
 * tools/print3d-bridge's own test), and any real printer (there is none to
 * watch: nothing has printed from this code).
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';

const DEV = `http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`;
const ENGINE = 'http://127.0.0.1:8789';
const PRINTER = 'http://127.0.0.1:8788';
const TOKEN = 'e2e-engine-token-0123456789';
const PTOKEN = 'e2e-printer-token-0123456789';
const GCODE = '; HEADER_BLOCK_START\n; total layer number: 50\nG1 X10 Y10 E1\n';

/** A binary STL of a 10 mm cube. */
function cubeStl(): Buffer {
  const v = [
    [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
  ];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const b = Buffer.alloc(84 + 50 * f.length);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((k, j) => v[k].forEach((c, a) => b.writeFloatLE(c, 84 + 50 * i + 12 + 12 * j + 4 * a))));
  return b;
}

/** A binary STL of boxes; `tilt` (radians about X then Y) is applied to the second box. */
function boxesStl(boxes: { o: [number, number, number]; s: [number, number, number]; tilt?: [number, number] }[]): Buffer {
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const tris: number[][][] = [];
  for (const bx of boxes) {
    let v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([x, y, z]) => [x * bx.s[0], y * bx.s[1], z * bx.s[2]]);
    if (bx.tilt) {
      const [a, b] = bx.tilt;
      v = v.map(([x, y, z]) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)]).map(([x, y, z]) => [x * Math.cos(b) + z * Math.sin(b), y, -x * Math.sin(b) + z * Math.cos(b)]);
    }
    v = v.map(([x, y, z]) => [x + bx.o[0], y + bx.o[1], z + bx.o[2]]);
    for (const t of f) tris.push(t.map((k) => v[k]));
  }
  const b = Buffer.alloc(84 + 50 * tris.length);
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((p, j) => p.forEach((c, a) => b.writeFloatLE(c, 84 + 50 * i + 12 + 12 * j + 4 * a))));
  return b;
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

async function fakes(page: Page, opts: { aiReply?: string; haveCode?: boolean; status?: Record<string, unknown> } = {}) {
  const engine: Seen[] = [];
  const printer: Seen[] = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
  const json = (route: Route, obj: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const read = (route: Route): Seen => {
    const r = route.request();
    const u = new URL(r.url());
    let body: unknown = null;
    const pd = r.postData();
    if (pd && (r.headers()['content-type'] ?? '').includes('json')) body = JSON.parse(pd);
    return { method: r.method(), path: u.pathname.replace(/^\/__(print3d|printer)(?=\/)/, '') + u.search, auth: r.headers()['authorization'] ?? null, body };
  };
  let sha = '';
  const engineRoute = async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const s = read(route);
    engine.push(s);
    const p = s.path.split('?')[0];
    if (p === '/v1/health') return json(route, { ok: true, engine: { id: 'twobee-fdm', label: '2bee.fdm', bin: '/fake/fdmslice', found: true, printed: false, defaults: '/fake/defaults', defaultsFound: true }, machine: { name: 'Bambu Lab X2D 0.4 nozzle', found: true } });
    if (p === '/v1/profiles')
      return json(route, {
        process: [{ name: '0.20mm Standard @BBL X2D', source: 'system' }],
        filament: [{ name: 'Generic PETG @BBL X2D 0.4 nozzle', source: 'system' }],
        bedTypes: ['Textured PEI Plate', 'Cool Plate'],
        defaultBed: 'Textured PEI Plate',
        bed: { area: ['0x0', '256x0', '256x256', '0x256'], height: 260 },
      });
    if (p === '/v1/slots')
      return json(route, {
        ok: true,
        bedPlate: 'Textured PEI Plate',
        slots: [
          { id: 'ams1-1', label: 'AMS slot 1', type: '', color: '#ffffff' },
          { id: 'ams1-3', label: 'AMS slot 3', type: 'PETG', color: '#2e9e5b' },
        ],
        types: ['PLA', 'PETG'],
        bedTypes: ['Textured PEI Plate', 'Cool Plate'],
      });
    if (p === '/v1/job/upload') {
      const buf = route.request().postDataBuffer() ?? Buffer.alloc(0);
      sha = createHash('sha256').update(buf).digest('hex');
      const name = new URL(route.request().url()).searchParams.get('name') ?? 'part.stl';
      return json(route, { ok: true, sha256: sha, name, size: buf.length, triangles: Math.max(0, (buf.length - 84) / 50), size3d: { x: 10, y: 10, z: 10 } });
    }
    if (p === '/v1/job/plates')
      return json(route, {
        ok: true,
        strategy: 'fit',
        beds: [{ index: 1, objects: [0], placements: [{ object: 0, x: 128, y: 128, rot: 0 }] }],
        tooBig: [],
        assignment: [{ object: 0, bed: 1 }],
        bed: { w: 256, d: 256, h: 260 },
        summary: '1 plate for 1 of 1 objects',
      });
    if (p === '/v1/job/slice') {
      const ov = ((s.body as { overrides?: Record<string, string> }).overrides) ?? {};
      return json(route, {
        ok: true,
        id: '0123456789abcdef',
        seconds: '1.0',
        engine: 'twobee-fdm',
        bedIndex: 1,
        objects: [{ index: 0, name: 'cube.stl', slot: 'ams1-3', placement: { x: 128, y: 128, rot: 0 } }],
        filaments: [{ id: 1, slot: 'ams1-3', slotLabel: 'AMS slot 3', type: 'PETG', color: '#2E9E5B', preset: 'Generic PETG @BBL X2D 0.4 nozzle' }],
        slotChecks: [{ slot: 'ams1-3', slotType: 'PETG', preset: 'Generic PETG @BBL X2D 0.4 nozzle', presetType: 'PETG', ok: true }],
        warnings: [],
        multiFilament: false,
        stats: { totalTime: ov.enable_support === '0' ? '10m 1s' : '11m 3s', printTime: null, layers: '50', filamentG: '0.63', filamentMm: null, bedType: 'Textured PEI Plate', nozzleTemp: '255', layerHeight: '0.2' },
        analysis: { toolChanges: 0, filaments: [{ grams: 0.63 }] },
        bedRequested: 'Textured PEI Plate',
      });
    }
    if (p === '/v1/gcode/0123456789abcdef') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/plain' }, body: GCODE });
    if (p === '/v1/job/list') return json(route, { ok: true, dir: '/fake', jobs: [] });
    return json(route, { ok: false, error: `no route ${p}` }, 404);
  };
  /* 🔴 In dev the app reaches the bridges through same-origin routes
   * (`bridges.ts` DEV_BRIDGES, since c08a0ae798), which pass straight to the REAL
   * bridges on this computer, and the printer bridge to a real X2D. Both routes
   * are faked, so no run of this file can reach a printer. */
  await page.route(`${ENGINE}/**`, engineRoute);
  await page.route('**/__print3d/**', engineRoute);
  const printerRoute = async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const s = read(route);
    printer.push(s);
    if (s.path === '/v1/check') return json(route, { reachable: true, haveCode: opts.haveCode ?? true, printer: '192.168.50.151', ...(opts.status ? { haveSerial: true } : {}) });
    if (opts.status && ['/v1/status', '/v1/fan', '/v1/fanmode', '/v1/speed', '/v1/skip'].includes(s.path)) return json(route, opts.status);
    if (s.path === '/v1/upload') return json(route, { ok: true, remote: 'cube-plate1_b775c31b.gcode.3mf', bytes: 2048, remoteBytes: 2048, md5: 'x', started: false });
    return json(route, { ok: false, error: 'no route' }, 404);
  };
  await page.route(`${PRINTER}/**`, printerRoute);
  await page.route('**/__printer/**', printerRoute);
  const ai: unknown[] = [];
  await page.route('**/__claude/**', async (route) => {
    ai.push(JSON.parse(route.request().postData() ?? 'null'));
    const content =
      opts.aiReply ??
      JSON.stringify({ reply: 'More walls, and the start G-code you asked for.', overrides: { wall_loops: 4, machine_start_gcode: 'G28' }, reasons: { wall_loops: 'stronger' }, questions: [] });
    return json(route, { choices: [{ message: { role: 'assistant', content } }] });
  });
  return { engine, printer, ai };
}

async function seed(page: Page, withPrinter = true) {
  await page.addInitScript(
    ([t, pt, wp]) => {
      localStorage.setItem(
        '2bee.app.print3d.bridges',
        JSON.stringify({
          engine: { url: 'http://127.0.0.1:8789', token: t, remember: true },
          printer: wp ? { url: 'http://127.0.0.1:8788', token: pt, remember: true } : { url: '', remember: false },
        }),
      );
    },
    [TOKEN, PTOKEN, withPrinter] as const,
  );
}

test('with the slicer bridge not answering the tab says so and refuses parts; it carries no print controls', async ({ page }) => {
  /* Since c08a0ae798 the DEV server always configures its same-origin bridges, so "not set up" is unreachable here,
   * and what the tab showed depended on whether a real bridge happened to listen on 8789. The bridges are now
   * faked as refusing, so this is the same test on every box. */
  await page.route('**/__print3d/**', (r) => r.abort('connectionrefused'));
  await page.route('**/__printer/**', (r) => r.abort('connectionrefused'));
  await page.goto(`${DEV}/print3d.html`);
  await expect(page.getByTestId('print3d-tab')).toBeVisible();
  await expect(page.getByTestId('p3d-banner')).toContainText('Nothing has been printed from this tab');
  await expect(page.getByTestId('p3d-banner')).toContainText('2bee.fdm');
  await expect(page.getByTestId('p3d-banner')).not.toContainText('OrcaSlicer');
  await expect(page.getByTestId('p3d-drop')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('p3d-health')).toContainText('did not answer');
  await expect(page.getByTestId('p3d-printer-badge')).toHaveText('BRIDGE DOWN');
  await expect(page.getByRole('button', { name: /^(start|pause|stop|resume)\b/i })).toHaveCount(0);
});

test('an STL is arranged, sliced, changed by a chip, and uploaded only after the checklist', async ({ page }) => {
  const seen = await fakes(page);
  await seed(page);
  await page.goto(`${DEV}/print3d.html`);
  await expect(page.getByTestId('p3d-drop')).toHaveAttribute('aria-disabled', 'false');
  await page.getByTestId('p3d-file').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: cubeStl() });

  await expect(page.getByTestId('p3d-plate-1')).toContainText('Plate 1 (1 part)');
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 20_000 });
  await expect(page.getByTestId('p3d-resline')).toContainText('11m 3s');
  await expect(page.getByTestId('p3d-resline')).toContainText('50 layers');

  const slices = () => seen.engine.filter((s) => s.path === '/v1/job/slice');
  expect(slices().length).toBe(1);
  const b0 = slices()[0].body as { bedIndex: number; optimise: boolean; objects: { slot: string; bed: number; placement: unknown }[] };
  expect(b0.bedIndex).toBe(1);
  // The app arranged it: the bridge slices exactly there, and its arrange route was never asked.
  expect(b0.optimise).toBe(false);
  expect(b0.objects[0]).toMatchObject({ slot: 'ams1-3', bed: 1, placement: { x: 128, y: 128, rot: 0 } });
  expect(seen.engine.filter((s) => s.path === '/v1/job/plates')).toHaveLength(0);
  // Every request to the engine carried the key.
  expect(seen.engine.length).toBeGreaterThan(4);
  // On the dev server the page carries the DEV_BRIDGES placeholder; the vite proxy swaps in the real key
  // server-side (c08a0ae798). A request with NO key still fails here.
  for (const s of seen.engine) expect(s.auth).toBe('Bearer dev-server-proxy-token');

  // A chip answer is a validated override in the NEXT slice.
  await page.getByTestId('p3d-q-support').click();
  await page.getByTestId('p3d-a-support-none').click();
  await expect(page.getByTestId('p3d-applied')).toContainText('No support');
  await expect(page.getByTestId('p3d-resline')).toContainText('10m 1s', { timeout: 20_000 });
  expect((slices().at(-1)!.body as { overrides: Record<string, string> }).overrides).toMatchObject({ enable_support: '0' });

  // Upload: disabled until every line is ticked; then the G-code TEXT goes to /v1/upload.
  await expect(page.getByTestId('p3d-printer-badge')).toHaveText('REACHABLE');
  const up = page.getByTestId('p3d-upload-btn');
  await expect(up).toBeDisabled();
  await page.getByTestId('p3d-tick-plate').check();
  await page.getByTestId('p3d-tick-slot-ams1-3').check();
  await expect(up).toBeDisabled();
  await page.getByTestId('p3d-tick-human').check();
  // 2bee.fdm has not printed: the calibration line is a person's, and Upload waits for it.
  await expect(page.getByTestId('p3d-engine')).toContainText('Sliced by 2bee.fdm');
  await expect(page.getByTestId('p3d-engine')).toContainText('calibration print');
  await expect(up).toBeDisabled();
  await page.getByTestId('p3d-tick-calibration').check();
  await expect(up).toBeEnabled();
  await up.click();
  await expect(page.getByTestId('p3d-upload-done')).toContainText('Nothing has started');
  const upl = seen.printer.filter((s) => s.path === '/v1/upload');
  expect(upl.length).toBe(1);
  expect(upl[0].auth).toBe('Bearer dev-server-proxy-token'); // DEV_BRIDGES placeholder; the vite proxy adds the real key
  expect((upl[0].body as { gcode: string; name: string }).gcode).toBe(GCODE);
  // The printer bridge was asked two things, and only two.
  expect([...new Set(seen.printer.map((s) => s.path))].sort()).toEqual(['/v1/check', '/v1/upload']);
  /* ⚠ RE-STATED 2026-11-15: this said NO start/pause/stop/resume button after an upload, true under the
   * 2026-10-14 "Upload only" ruling and stale since fa2a01fbc2 (founder 2026-10-20, remote start). What must
   * still hold after an upload: Start exists and is OFF until a person ticks "I am at the printer", and nothing
   * was sent to start it (the printer was asked only /v1/check and /v1/upload, above). */
  await expect(page.getByTestId('p3d-tick-atprinter')).not.toBeChecked();
  await expect(page.getByTestId('p3d-start-btn')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^(pause|stop|resume)\b/i })).toHaveCount(0);
});

test('the model proposes, the G-code key is refused on screen, and only the allowed key is sliced', async ({ page }) => {
  const seen = await fakes(page);
  await seed(page, false);
  await page.goto(`${DEV}/print3d.html`);
  await expect(page.getByTestId('p3d-drop')).toHaveAttribute('aria-disabled', 'false');
  await page.getByTestId('p3d-file').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: cubeStl() });
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 20_000 });

  await page.getByTestId('p3d-ask').fill('make it stronger');
  await page.getByTestId('p3d-send').click();
  const prop = page.getByTestId('p3d-proposal').last();
  await expect(prop).toContainText('Wall loops: 4');
  await expect(prop).toContainText('machine_start_gcode');
  await expect(prop).toContainText('never allowed');
  // The model was given the job as data, not spliced into its instruction.
  const sent = seen.ai[0] as { messages: { role: string; content: string }[] };
  expect(JSON.parse(sent.messages[1].content)).toMatchObject({ user_text: 'make it stronger' });

  const before = seen.engine.filter((s) => s.path === '/v1/job/slice').length;
  await page.getByTestId('p3d-apply').click();
  await expect.poll(() => seen.engine.filter((s) => s.path === '/v1/job/slice').length, { timeout: 20_000 }).toBeGreaterThan(before);
  const ov = (seen.engine.filter((s) => s.path === '/v1/job/slice').at(-1)!.body as { overrides: Record<string, string> }).overrides;
  expect(ov).toMatchObject({ wall_loops: '4' });
  expect(Object.keys(ov)).not.toContain('machine_start_gcode');
});

test('gates column: every gate passes only after the checklist; with no access code Upload stays off (a person gives it)', async ({ page }) => {
  await fakes(page, { haveCode: false });
  await seed(page);
  await page.goto(`${DEV}/print3d.html`);
  await expect(page.getByTestId('gates-panel')).toBeVisible();
  await expect(page.getByTestId('gate-parts')).toHaveAttribute('data-state', 'FAIL');
  await page.getByTestId('p3d-file').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: cubeStl() });
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 20_000 });
  for (const id of ['parts', 'sliced', 'fit', 'filament', 'bridge']) await expect(page.getByTestId(`gate-${id}`)).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('gate-code')).toHaveAttribute('data-state', 'FAIL');
  await expect(page.getByTestId('gate-code')).toContainText('Give the X2D access code');
  await expect(page.getByTestId('gate-code-action')).toBeVisible();
  await expect(page.getByTestId('gate-checklist')).toHaveAttribute('data-state', 'FAIL');
  for (const t of ['plate', 'slot-ams1-3', 'human', 'calibration']) await page.getByTestId(`p3d-tick-${t}`).check();
  await expect(page.getByTestId('gate-checklist')).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('p3d-upload-btn')).toBeDisabled();
  await expect(page.getByTestId('p3d-upload-blocked')).toContainText('access code');
  // Fix with AI cannot give the code: it says so.
  await page.getByTestId('gates-fix').click();
  await expect(page.getByTestId('gates-fix-notes')).toContainText('only you can give it');
  // Collapsed, the strip still counts what fails.
  await page.getByTestId('gates-collapse').click();
  await expect(page.getByTestId('gates-panel')).toContainText('1');
  await page.getByTestId('gates-expand').click();
});

test('two solids in one file, one tilted: separated, laid flat and arranged by the app; the model never sends anyone to OrcaSlicer', async ({ page }) => {
  const seen = await fakes(page, {
    aiReply: JSON.stringify({
      reply: 'Separating, laying flat and arranging. Use OrcaSlicer: Arrange button (A key).',
      overrides: {},
      actions: [{ do: 'separate' }, { do: 'lay_flat' }, { do: 'arrange' }],
    }),
  });
  await seed(page, false);
  await page.goto(`${DEV}/print3d.html`);
  await expect(page.getByTestId('p3d-drop')).toHaveAttribute('aria-disabled', 'false');
  const stl = boxesStl([
    { o: [0, 0, 0], s: [40, 20, 5] },
    { o: [80, 0, 10], s: [30, 30, 4], tilt: [0.6, 0.3] },
  ]);
  await page.getByTestId('p3d-file').setInputFiles({ name: 'kit.stl', mimeType: 'model/stl', buffer: stl });
  await expect(page.getByTestId('p3d-layout-note')).toContainText('kit: 2 objects separated');
  await expect(page.getByTestId('p3d-layout-note')).toContainText('kit_part2: laid on its 900 mm² face');
  await expect(page.getByTestId('p3d-layout-note')).toContainText('Arranged by this app: 2 parts on 1 plate, 5 mm apart, centred');
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Plate 1 (2 parts)');
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Up to date', { timeout: 20_000 });

  // Two uploads, each a laid-flat solid; the slice carries both, placed apart, optimise off.
  const ups = seen.engine.filter((s) => s.path.startsWith('/v1/job/upload'));
  expect(ups.map((u) => new URL(`http://x${u.path}`).searchParams.get('name'))).toEqual(['kit_part1.stl', 'kit_part2.stl']);
  const sl = seen.engine.filter((s) => s.path === '/v1/job/slice').at(-1)!.body as { optimise: boolean; objects: { bed: number; placement: { x: number; y: number } }[] };
  expect(sl.optimise).toBe(false);
  expect(sl.objects).toHaveLength(2);
  const [a, b] = sl.objects.map((o) => o.placement);
  expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThan(20);

  // The founder's request, through the model: actions shown, applied on Apply, OrcaSlicer sentence dropped.
  await page.getByTestId('p3d-ask').fill('separate the objects, lay down, arrange');
  await page.getByTestId('p3d-send').click();
  const prop = page.getByTestId('p3d-proposal').last();
  await expect(prop.getByTestId('p3d-proposal-actions')).toContainText('Separate every part into its solids');
  await expect(prop).not.toContainText('OrcaSlicer');
  await expect(prop.getByTestId('p3d-scrubbed')).toContainText('1 sentence naming another program removed');
  await prop.getByTestId('p3d-apply').click();
  await expect(page.getByTestId('p3d-log')).toContainText('one object, nothing to separate');
  await expect(page.getByTestId('p3d-log')).toContainText('already on its largest flat face');
  await expect(page.getByTestId('p3d-log')).not.toContainText('OrcaSlicer');
  await expect(page.getByTestId('p3d-plate-1')).toContainText('Plate 1 (2 parts)');
});

test('printer card: HMS text, stage, speed, fan mode, fans and skip, each sent as its one command', async ({ page }) => {
  // The status shape the real bridge returned from the X2D on 2026-11-13, plus two objects of a file it uploaded.
  const status = {
    ok: true, state: 'RUNNING', task: 'two cubes', percent: 40, layer: 20, layers: 100, remainMin: 30, nozzle: 260, nozzleTarget: 260, bed: 100, bedTarget: 100,
    error: 0, errorCode: null, errorText: null, slots: [], light: 'on',
    hms: [{ code: '0703-2200-0002-0026', level: 'serious', text: 'AMS D slot 3 assist motor overloaded.' }, { code: '0500-0600-0002-0070', level: 'serious', text: null }],
    stage: { id: 14, name: 'Cleaning nozzle tip' }, speed: { level: 2, name: 'Standard' },
    fanMode: 'Heating', fanModeId: 1, fanModes: [{ id: 0, name: 'Strong Cooling' }, { id: 1, name: 'Heating' }],
    fans: [{ id: 1, name: 'Parts', percent: 40, control: 'set' }, { id: 2, name: 'Left (Heating)', percent: 100, control: 'auto' }],
    skipped: [], objects: [{ id: 55, name: 'cubeA' }, { id: 77, name: 'cubeB' }],
  };
  const { printer } = await fakes(page, { status });
  await seed(page);
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${DEV}/print3d.html`);
  await expect(page.getByTestId('p3d-printer-status')).toContainText('RUNNING (Cleaning nozzle tip)');
  await expect(page.getByTestId('p3d-hms')).toContainText('AMS D slot 3 assist motor overloaded.');
  await expect(page.getByTestId('p3d-hms')).toContainText("Bambu's table has no description for this code · 0500-0600-0002-0070");
  await page.getByTestId('p3d-speed').selectOption('3');
  await expect.poll(() => printer.filter((x) => x.path === '/v1/speed').map((x) => x.body)).toEqual([{ level: 3 }]);
  await page.getByTestId('p3d-fans').locator('summary').click();
  await expect(page.getByTestId('p3d-fans')).toContainText('run by the printer in this mode');
  await page.getByTestId('p3d-fan-1').selectOption('60');
  await expect.poll(() => printer.filter((x) => x.path === '/v1/fan').map((x) => x.body)).toEqual([{ id: 1, percent: 60 }]);
  await page.getByTestId('p3d-fanmode').selectOption('0');
  await expect.poll(() => printer.filter((x) => x.path === '/v1/fanmode').map((x) => x.body)).toEqual([{ mode: 0 }]);
  await page.getByTestId('p3d-objects').locator('summary').click();
  await page.getByTestId('p3d-skip-55').click();
  await expect.poll(() => printer.filter((x) => x.path === '/v1/skip').map((x) => x.body)).toEqual([{ ids: [55], confirm: 'skip' }]);
  // Nothing the card did went anywhere but those routes.
  expect([...new Set(printer.map((x) => x.path))].sort()).toEqual(['/v1/check', '/v1/fan', '/v1/fanmode', '/v1/skip', '/v1/speed', '/v1/status']);
});
