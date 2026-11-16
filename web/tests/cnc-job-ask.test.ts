/**
 * 2bee.cnc "Ask a model" — the job-settings path (founder 2026-10-12, option B).
 * Each rule in `src/cnc/jobAsk.ts`'s header has a test here, and each test was
 * watched red against the defect it names (the plants are in the commit body).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OP_KEYS,
  buildJobRequest,
  candidateConfig,
  jobTransmissionSummary,
  mayApplyJob,
  opOf,
  patchRows,
  readJobProposal,
  type JobContext,
} from '../src/cnc/jobAsk.ts';
import type { JobConfig } from '../src/cam.ts';

const CONFIG: JobConfig = {
  machine: { travel_x_mm: 600, travel_y_mm: 400 },
  stock: { size_x_mm: 300, size_y_mm: 200, thickness_mm: 18 },
  material: 'Plywood',
  clamps: [],
  confirmed_clear: false,
  tool_ids: ['End Mill - Down-cut 6mm 2F'],
  op: {
    depth_per_pass_mm: 3,
    rpm: 18000,
    entry: 'Ramp',
    direction: 'Climb',
    dogbone: 'Corner',
    finish_allowance_mm: 0,
    lead_mm: 0,
    tabs_enabled: true,
    tab_height_mm: 3,
    tab_width_mm: 8,
    tab_min_spacing_mm: 120,
  },
};

const CTX: JobContext = {
  op: opOf(CONFIG),
  toolIds: ['End Mill - Down-cut 6mm 2F'],
  library: ['End Mill - Down-cut 6mm 2F', 'End Mill - Up-cut 3mm 2F'],
  facts: { stock: CONFIG.stock, machine: CONFIG.machine, material: 'Plywood' },
  plan: { ok: true, refusals: [], warnings: [], notes: [], summary: '497 lines' },
};

const reply = (o: unknown) => JSON.stringify(o);

test('a valid proposal keeps only the fields that CHANGE, and names the ones that did not', () => {
  const p = readJobProposal(reply({ changes: { depth_per_pass_mm: 2, entry: 'Ramp' }, why: 'shallower passes' }), CTX);
  assert.ok(p.ok);
  assert.deepEqual(p.patch, { op: { depth_per_pass_mm: 2 } });
  assert.deepEqual(p.unchanged, ['Entry']);
});

test('🔴 a FACT about the shop cannot be patched — thickness, clamps, confirmed_clear, material, machine', () => {
  for (const k of ['thickness_mm', 'confirmed_clear', 'material', 'clamps', 'travel_x_mm', 'stock', 'machine']) {
    const p = readJobProposal(reply({ changes: { [k]: 1 }, why: 'x' }), CTX);
    assert.equal(p.ok, false, k);
    if (!p.ok) assert.match(p.problems.join(' '), new RegExp(`"${k}" may not be changed`));
  }
  // …and not by smuggling it in at the top level either.
  const top = readJobProposal(reply({ changes: {}, confirmed_clear: true, why: 'x' }), CTX);
  assert.equal(top.ok, false);
});

test('🔴 ONE bad field refuses the WHOLE proposal — the valid half is not applied', () => {
  const p = readJobProposal(reply({ changes: { depth_per_pass_mm: 2, entry: 'Spiral' }, why: 'x' }), CTX);
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.problems.join(' '), /Entry must be one of Ramp, Helix, Plunge/);
});

test('types, bounds and zero are checked by name', () => {
  const bad = [
    [{ rpm: '18000' }, /Spindle speed must be a number/],
    [{ depth_per_pass_mm: 0 }, /Depth per pass 0 mm is outside more than 0/],
    [{ depth_per_pass_mm: -1 }, /outside/],
    [{ lead_mm: Number.MAX_VALUE }, /outside/],
    [{ tabs_enabled: 'yes' }, /Tabs must be true or false/],
  ] as const;
  for (const [changes, re] of bad) {
    const p = readJobProposal(reply({ changes, why: 'x' }), CTX);
    assert.equal(p.ok, false, JSON.stringify(changes));
    if (!p.ok) assert.match(p.problems.join(' '), re);
  }
  // Zero IS allowed where zero means "none".
  assert.ok(readJobProposal(reply({ changes: { finish_allowance_mm: 0.2 }, why: 'x' }), CTX).ok);
});

test('tool ids must come from the library, non-empty, no repeats', () => {
  const unknown = readJobProposal(reply({ changes: {}, tool_ids: ['Laser'], why: 'x' }), CTX);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.problems.join(' '), /not in the tool library: "Laser"/);
  assert.equal(readJobProposal(reply({ changes: {}, tool_ids: [], why: 'x' }), CTX).ok, false);
  const twice = ['End Mill - Up-cut 3mm 2F', 'End Mill - Up-cut 3mm 2F'];
  assert.equal(readJobProposal(reply({ changes: {}, tool_ids: twice, why: 'x' }), CTX).ok, false);
  const ok = readJobProposal(reply({ changes: {}, tool_ids: ['End Mill - Up-cut 3mm 2F'], why: 'x' }), CTX);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.patch.tool_ids, ['End Mill - Up-cut 3mm 2F']);
});

test('the reply must be ONE object, bare or in one json fence; prose around it is refused', () => {
  const fenced = '```json\n' + reply({ changes: { rpm: 16000 }, why: 'x' }) + '\n```';
  assert.ok(readJobProposal(fenced, CTX).ok);
  assert.equal(readJobProposal('Sure! ' + reply({ changes: {}, why: 'x' }), CTX).ok, false);
  assert.equal(readJobProposal('[]', CTX).ok, false);
  assert.equal(readJobProposal(reply({ changes: { rpm: 16000 } }), CTX).ok, false, 'no why');
});

test('🔴 the candidate config changes op and tool_ids and NOTHING else', () => {
  const patch = { op: { depth_per_pass_mm: 2 }, tool_ids: ['End Mill - Up-cut 3mm 2F'] };
  const c = candidateConfig(CONFIG, patch);
  for (const k of Object.keys(CONFIG) as (keyof JobConfig)[]) {
    if (k === 'op' || k === 'tool_ids') continue;
    assert.equal(c[k], CONFIG[k], `${k} must be carried through by identity`);
  }
  assert.equal((c.op as Record<string, unknown>).depth_per_pass_mm, 2);
  assert.equal((c.op as Record<string, unknown>).rpm, 18000, 'untouched op fields survive');
  assert.deepEqual(c.tool_ids, ['End Mill - Up-cut 3mm 2F']);
  assert.equal((CONFIG.op as Record<string, unknown>).depth_per_pass_mm, 3, 'the live config is not mutated');
});

test('🔴 a candidate the core REFUSED cannot be applied, and neither can an empty patch', () => {
  const patch = { op: { depth_per_pass_mm: 2 } };
  assert.equal(mayApplyJob({ ok: true, refusals: [] }, patch), true);
  assert.equal(mayApplyJob({ ok: false, refusals: ['6mm does not fit'] }, patch), false);
  assert.equal(mayApplyJob({ ok: true, refusals: ['x'] }, patch), false);
  assert.equal(mayApplyJob(null, patch), false);
  assert.equal(mayApplyJob({ ok: true, refusals: [] }, { op: {} }), false);
});

test('the request carries the instruction, the request and the job — and says what it sends', () => {
  const req = buildJobRequest(
    { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'm', apiKey: 'k', rememberKey: false, timeoutMs: 1 },
    'fewer passes',
    CTX,
  );
  const user = req.body.messages[1].content;
  assert.match(user, /fewer passes/);
  for (const k of OP_KEYS) assert.ok(user.includes(`"${k}"`), k);
  assert.match(req.body.messages[0].content, /You do NOT write G-code/);
  const said = jobTransmissionSummary(req, 'fewer passes', CTX).join('\n');
  assert.match(said, /NOT the drawings, NOT the G-code/);
});

test('the diff rows name each change with its unit', () => {
  const rows = patchRows(CTX.op, CTX.toolIds, { op: { depth_per_pass_mm: 2 }, tool_ids: ['End Mill - Up-cut 3mm 2F'] });
  assert.deepEqual(rows[0], { label: 'Depth per pass', from: '3 mm', to: '2 mm' });
  assert.equal(rows[1].label, 'Cutter set');
});

test('an applied patch sets the SAME store fields the Operation panel sets', async () => {
  const { storeUpdateOf, OP_STORE_FIELD } = await import('../src/cnc/jobAsk.ts');
  const { useCncStore } = await import('../src/store/cncStore.ts');
  const state = useCncStore.getState() as unknown as Record<string, unknown>;
  for (const [k, field] of Object.entries(OP_STORE_FIELD)) {
    assert.ok(field in state, `${k} -> ${field} is not a store field`);
    const setter = `set${field[0].toUpperCase()}${field.slice(1)}`;
    assert.equal(typeof state[setter], 'function', `${field} has no ${setter}: the Operation panel cannot be setting it`);
  }
  assert.deepEqual(storeUpdateOf({ op: { depth_per_pass_mm: 2, tabs_enabled: false }, tool_ids: ['a'] }), {
    depthPerPass: 2,
    tabsEnabled: false,
    toolIds: ['a'],
  });
});
