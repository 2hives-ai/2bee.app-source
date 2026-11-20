// The Upload button as a progress bar (src/print3d/uploadProgress.ts).
//
// 🔴 What these guard: the bar must not claim more than the bridge measured. 100 % only
// once every byte is sent and the printer is checking it; no bar at all when the bridge
// gives no numbers (an older bridge), never a made-up one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadProgressView } from '../src/print3d/uploadProgress.ts';

test('no reply or no upload in flight: plain "Uploading…", no bar', () => {
  assert.deepEqual(uploadProgressView(null), { label: 'Uploading…', pct: null });
  assert.deepEqual(uploadProgressView({ upload: null, queued: 0 }), { label: 'Uploading…', pct: null });
});

test('queued behind another upload says so, at 0', () => {
  assert.deepEqual(uploadProgressView({ upload: null, queued: 1 }), { label: 'Waiting for the upload before this one…', pct: 0 });
});

test('connecting is 0; sending shows the measured share and size; it never reads 100 while sending', () => {
  assert.deepEqual(uploadProgressView({ upload: { phase: 'connecting', sent: 0, total: 5_000_000 } }), { label: 'Connecting to the printer…', pct: 0 });
  assert.deepEqual(uploadProgressView({ upload: { phase: 'sending', sent: 2_160_000, total: 5_000_000 } }), { label: 'Uploading 43 % (2.2 of 5.0 MB)', pct: 43 });
  const nearly = uploadProgressView({ upload: { phase: 'sending', sent: 5_000_000, total: 5_000_000 } });
  assert.equal(nearly.pct, 99, 'sent but not yet confirmed must not fill the bar');
});

test('confirming fills the bar and says the printer is checking, not done', () => {
  const v = uploadProgressView({ upload: { phase: 'confirming', sent: 28_000_000, total: 28_000_000 } });
  assert.equal(v.pct, 100);
  assert.match(v.label, /printer is checking/);
  assert.doesNotMatch(v.label, /done|uploaded|on the printer/i);
});

test('a counter past the total, or a zero total, is clamped or ignored, never over 100', () => {
  assert.equal(uploadProgressView({ upload: { phase: 'sending', sent: 9e9, total: 1000 } }).pct, 99);
  assert.deepEqual(uploadProgressView({ upload: { phase: 'sending', sent: 10, total: 0 } }), { label: 'Uploading…', pct: null });
});
