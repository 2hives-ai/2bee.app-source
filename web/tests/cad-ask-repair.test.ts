// The AI change is CHECKED, and sent back until it builds (founder 2026-11-13:
// "when AI is changing the object make sure the end result is working!"). These
// drive `askOnce` with a scripted transport: a broken first reply, then a fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askOnce, buildProblems, evaluate, mayApply, NO_ASK_CONFIG, REPAIR_ROUNDS } from '../src/cad/ask';

const CFG = { ...NO_ASK_CONFIG, endpoint: 'http://localhost:9/v1/chat/completions', model: 'm', apiKey: 'k' };
const body = (scad: string) => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```openscad\n' + scad + '```' } }] });
/** `text()` is refused by name in 2bee.cad: a part that silently would not exist. */
const BROKEN = 'cube([12, 10, 10]);\ntext("x");\n';
const FIXED = 'cube([12, 10, 10]);\n';

function scripted(replies: string[]) {
  const sent: string[] = [];
  const transport = async (req: unknown) => {
    sent.push(JSON.stringify(req));
    const scad = replies[Math.min(sent.length - 1, replies.length - 1)];
    return { status: 200, ok: true, text: body(scad) };
  };
  return { transport: transport as Parameters<typeof askOnce>[0]['transport'], sent };
}
const run = (source: string, t: ReturnType<typeof scripted>) =>
  askOnce({ cfg: CFG, prompt: 'make it 12 wide', source, online: true, transport: t.transport, signal: new AbortController().signal });

test('a working design has no problems; a refused construct is one', () => {
  assert.deepEqual(buildProblems(evaluate(FIXED)), []);
  assert.ok(buildProblems(evaluate(BROKEN)).some((p) => /text/.test(p)));
});

test('a broken reply is sent back with its problems, and the fixed one is what is applied', async () => {
  const t = scripted([BROKEN, FIXED]);
  const out = await run('cube([10, 10, 10]);\n', t);
  assert.ok(out.ok);
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[1], /does NOT build correctly/);
  assert.match(t.sent[1], /text/);
  assert.equal(out.source.trim(), FIXED.trim());
  assert.equal(out.repairs, 1);
  assert.ok(mayApply(out.review));
});

test('still broken after every round, and worse than before: NOT applied', async () => {
  const t = scripted([BROKEN]);
  const out = await run('cube([10, 10, 10]);\n', t);
  assert.ok(out.ok);
  assert.equal(t.sent.length, 1 + REPAIR_ROUNDS);
  assert.equal(out.review.blocked?.kind, 'still-broken');
  assert.equal(mayApply(out.review), false);
});

test('a design that was already broken the same way is not blocked, and says so', async () => {
  const before = 'cube([10, 10, 10]);\ntext("x");\n';
  const out = await run(before, scripted([BROKEN]));
  assert.ok(out.ok);
  assert.equal(out.review.blocked, null);
  assert.ok(out.review.cautions.some((c) => /no more than the design had before/.test(c)));
});

test('a working first reply is not sent back at all', async () => {
  const t = scripted([FIXED]);
  const out = await run('cube([10, 10, 10]);\n', t);
  assert.ok(out.ok);
  assert.equal(t.sent.length, 1);
  assert.equal(out.repairs, 0);
});

test('Stop pressed during a repair round: a failure, never the first reply as ok (bughunt 2026-11-13)', async () => {
  // A design already broken the same way, so the first reply is NOT blocked and a
  // panel that applies on `ok` would have written it into the editor.
  const before = 'cube([10, 10, 10]);\ntext("x");\n';
  const stop = new AbortController();
  const sent: string[] = [];
  const transport = (async (req: unknown, signal: AbortSignal) => {
    sent.push(JSON.stringify(req));
    if (sent.length === 1) return { status: 200, ok: true, text: body(BROKEN) };
    stop.abort(); // the operator presses Stop while the repair request is out
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { status: 200, ok: true, text: body(FIXED) };
  }) as Parameters<typeof askOnce>[0]['transport'];
  const out = await askOnce({ cfg: CFG, prompt: 'p', source: before, online: true, transport, signal: stop.signal });
  assert.equal(sent.length, 2, 'the repair request was sent');
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.failure.kind, 'timeout');
});

test('a reply that builds NO solid from a design that built one is NOT applied, whatever the counts (bughunt 2026-11-15)', async () => {
  /* The old rule compared problem COUNTS. One refused text() counts twice (refused + "not
   * trusted"), so "no solid at all" (1) read as no worse than it, and an empty part replaced
   * the design with "Changed." — on the router "nothing to cut", on the printer a failed file. */
  const EMPTY = 'difference(){cube(10); cube(20, center=true);}\n';
  const t = scripted([EMPTY]);
  const out = await run(BROKEN, t);
  assert.ok(out.ok);
  assert.equal(out.review.blocked?.kind, 'still-broken');
  assert.equal(mayApply(out.review), false);
});
