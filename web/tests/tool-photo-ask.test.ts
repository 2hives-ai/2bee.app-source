// Tools page — "Photo the cutter": the AI reply parser (toolPhotoAsk.ts).
//
// Guards: a readable reply fills ONLY fields the form can hold, in the core's
// spelling; anything else (unknown type, non-number, zero, fractional flutes, an
// angle on a non-angular type, an unknown flute direction) is left EMPTY and
// NAMED, never mapped to the nearest; a reply with nothing readable fills
// nothing; the request carries the photo as an image_url data URL and nothing
// else; an HTTP refusal is a sentence, not a proposal.
//
// What this cannot see: the camera, the canvas downscale, a real model. The
// browser path is in e2e/tool-photo.spec.ts with the endpoint faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoRequest, buildToolRequest, parseToolProposal, readPhotoReply, PHOTO_SYSTEM_INSTRUCTION } from '../src/shop-setup/toolPhotoAsk.ts';
import { validateToolDraft, TOOL_TYPES, EMPTY_DRAFT } from '../src/shop-setup/toolRegistry.ts';

const full = {
  type: 'End Mill',
  diameter_mm: 6,
  flutes: 2,
  cutting_length_mm: 22,
  shank_mm: 6,
  overall_length_mm: 50,
  included_angle_deg: null,
  flute_type: 'up-cut',
  material: 'carbide',
  confidence: 'medium',
  unreadable: [],
  notes: '6 printed on the shank',
};

test('a full, valid reply fills every field and passes the form validation unchanged', () => {
  const r = parseToolProposal(JSON.stringify(full));
  assert.ok(r.ok);
  const p = r.proposal;
  assert.equal(p.draft.type, 'End Mill');
  assert.equal(p.draft.diameter_mm, '6');
  assert.equal(p.draft.flutes, '2');
  assert.equal(p.draft.flute_type, 'up-cut');
  assert.equal(p.draft.material, 'carbide');
  assert.equal(p.draft.label, '', 'the name stays the human\'s');
  assert.equal(p.confidence, 'medium');
  assert.equal(p.notes, '6 printed on the shank');
  assert.deepEqual(p.unread, []);
  assert.ok(validateToolDraft(p.draft).ok);
});

test('a fenced reply with prose around it is read', () => {
  const r = parseToolProposal('Here you go:\n```json\n' + JSON.stringify(full) + '\n```\nHope that helps.');
  assert.ok(r.ok);
  assert.equal(r.proposal.draft.diameter_mm, '6');
});

test('nulls are left empty and named, with the model\'s own reason where it gave one', () => {
  const r = parseToolProposal(
    JSON.stringify({ ...full, cutting_length_mm: null, overall_length_mm: null, unreadable: ['overall_length_mm: no scale in the photo'] }),
  );
  assert.ok(r.ok);
  assert.equal(r.proposal.draft.cutting_length_mm, '');
  assert.equal(r.proposal.draft.overall_length_mm, '');
  const why = Object.fromEntries(r.proposal.unread.map((u) => [u.field, u.why]));
  assert.equal(why.overall_length_mm, 'no scale in the photo');
  assert.equal(why.cutting_length_mm, 'not readable from the photo');
  assert.ok(!('included_angle_deg' in why), 'an angle is not asked of an end mill, so its absence is not news');
});

test('values the form cannot hold are NOT filled and each one says why', () => {
  const r = parseToolProposal(
    JSON.stringify({
      ...full,
      diameter_mm: 'about a quarter inch',
      flutes: 2.5,
      shank_mm: 0,
      overall_length_mm: -3,
      included_angle_deg: 90,
      flute_type: 'spiral',
    }),
  );
  assert.ok(r.ok);
  const d = r.proposal.draft;
  for (const f of ['diameter_mm', 'flutes', 'shank_mm', 'overall_length_mm', 'included_angle_deg', 'flute_type'] as const) {
    assert.equal(d[f], '', `${f} must stay empty`);
    assert.ok(r.proposal.unread.some((u) => u.field === f), `${f} must be named`);
  }
  assert.match(r.proposal.unread.find((u) => u.field === 'diameter_mm')!.why, /not a number/);
  assert.match(r.proposal.unread.find((u) => u.field === 'flutes')!.why, /whole number/);
  assert.match(r.proposal.unread.find((u) => u.field === 'included_angle_deg')!.why, /applies only to/);
  // And the form's own rule then refuses to register it, naming the diameter.
  const v = validateToolDraft(d);
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.problems.some((p) => p.field === 'diameter_mm'));
});

test('an unknown type is never mapped to the nearest one', () => {
  for (const t of ['end mill', 'Router bit', 'flat end mill', 'V bit']) {
    const r = parseToolProposal(JSON.stringify({ ...full, type: t }));
    assert.ok(r.ok);
    assert.equal(r.proposal.draft.type, '', `${t} must not be accepted`);
    assert.match(r.proposal.unread.find((u) => u.field === 'type')!.why, /not a type this app knows/);
  }
  for (const t of TOOL_TYPES) {
    const r = parseToolProposal(JSON.stringify({ ...full, type: t, included_angle_deg: 60 }));
    assert.ok(r.ok);
    assert.equal(r.proposal.draft.type, t);
  }
});

test('a V-bit keeps its angle; numeric strings with units are read', () => {
  const r = parseToolProposal(JSON.stringify({ ...full, type: 'V-Bit', diameter_mm: '6.35 mm', included_angle_deg: '60°' }));
  assert.ok(r.ok);
  assert.equal(r.proposal.draft.included_angle_deg, '60');
  assert.equal(r.proposal.draft.diameter_mm, '6.35');
});

test('nothing readable, or no JSON at all, fills nothing', () => {
  const none = parseToolProposal(JSON.stringify({ type: null, diameter_mm: null, flutes: null, confidence: 'low' }));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.why : '', /nothing was filled/);
  const prose = parseToolProposal('It looks like an end mill, maybe 6 mm.');
  assert.equal(prose.ok, false);
});

test('confidence outside high/medium/low is "not stated", not a guess', () => {
  const r = parseToolProposal(JSON.stringify({ ...full, confidence: 0.9 }));
  assert.ok(r.ok);
  assert.equal(r.proposal.confidence, 'not stated');
});

test('the request: system instruction + one user turn with text and the photo as a data URL', () => {
  const req = buildPhotoRequest(
    { endpoint: 'http://127.0.0.1:8787/v1/chat/completions', model: 'claude-sonnet', apiKey: 'k', rememberKey: false, timeoutMs: 60000 },
    'data:image/jpeg;base64,AAAA',
  );
  assert.equal(req.headers.authorization, 'Bearer k');
  assert.deepEqual(Object.keys(req.body).sort(), ['messages', 'model', 'stream', 'temperature']);
  assert.equal(req.body.messages.length, 2);
  assert.equal(req.body.messages[0].content, PHOTO_SYSTEM_INSTRUCTION);
  const user = req.body.messages[1];
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content));
  assert.deepEqual((user.content as { type: string }[]).map((c) => c.type), ['text', 'image_url']);
  assert.equal((user.content[1] as { image_url: { url: string } }).image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('readPhotoReply: HTTP refusal is a sentence carrying the bridge message; a good reply is a proposal', () => {
  const bad = readPhotoReply({ status: 400, ok: false, text: JSON.stringify({ error: { message: 'image_url must be a data: URL' } }) });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.why : '', /HTTP 400.*data: URL/);
  const good = readPhotoReply({ status: 200, ok: true, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(full) } }] }) });
  assert.ok(good.ok);
  const shape = readPhotoReply({ status: 200, ok: true, text: JSON.stringify({ result: 'x' }) });
  assert.equal(shape.ok, false);
});

const CFG = { endpoint: '/__claude/v1/chat/completions', model: 'claude-sonnet', apiKey: 'dev-server-proxy', rememberKey: false, timeoutMs: 180000 };

test('words only: one text part, no image part; the operator\'s words are in it', () => {
  const req = buildToolRequest(CFG, { text: '6 mm 2-flute up-cut end mill' });
  const user = req.body.messages[1];
  assert.ok(Array.isArray(user.content));
  const parts = user.content as { type: string; text?: string }[];
  assert.deepEqual(parts.map((c) => c.type), ['text']);
  assert.match(parts[0].text!, /Operator: 6 mm 2-flute up-cut end mill/);
});

test('a follow-up carries the form as it stands (and only the fields that hold a value); words + photo send both parts', () => {
  const current = { ...EMPTY_DRAFT, type: 'End Mill', diameter_mm: '6', label: 'my name' };
  const req = buildToolRequest(CFG, { text: 'it has 3 flutes', dataUrl: 'data:image/jpeg;base64,AAAA', current });
  const parts = req.body.messages[1].content as { type: string; text?: string }[];
  assert.deepEqual(parts.map((c) => c.type), ['text', 'image_url']);
  assert.match(parts[0].text!, /Current form values: type="End Mill", diameter_mm="6"/);
  assert.ok(!parts[0].text!.includes('my name'), 'the human\'s label is not sent');
  assert.ok(!parts[0].text!.includes('flutes='), 'an empty field is not sent');
});

test('a SET: variants with sizes are read, diameter stays empty and says why, nothing invented', () => {
  const r = parseToolProposal(JSON.stringify({
    type: 'Drill', diameter_mm: null, flutes: null, material: 'HSS-Co M35', confidence: 'high',
    set: { variants: [{ name: '5pcs', diameters_mm: [4, 5, 6, 8, 10] }, { name: '25pcs', diameters_mm: [1, 1.5, '2.0', 13, -1, 'x'] }] },
  }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.proposal.set?.variants.map((v) => v.name), ['5pcs', '25pcs']);
  assert.deepEqual(r.proposal.set?.variants[1].diameters, [1, 1.5, 2, 13]);
  assert.equal(r.proposal.draft.diameter_mm, '');
  assert.match(r.proposal.unread.find((u) => u.field === 'diameter_mm')?.why ?? '', /a set/);
});
