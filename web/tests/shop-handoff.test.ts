// THE SHOP → 2bee.cad HANDOFF, AND THE TWO WAYS IT COULD LOSE WORK.
//
// `shop/handoff.ts` exists instead of a write to the CAD session store. The
// header there explains why; these are the properties that make it true, and
// each one corresponds to a way the storage route fails:
//
//   1. A request made with nothing listening is HELD — the shop is the landing
//      tab, so on a first visit `CadTab` is not mounted and a fire-and-forget
//      publish would be dropped. The user clicks "Open in 2bee.cad", lands in
//      the CAD tab, and sees the example file: a click that silently did
//      nothing.
//   2. Claiming is DESTRUCTIVE. `CadTab` is mounted lazily and a remount is an
//      ordinary event; a peek would re-apply the same design later, on top of
//      whatever the user had typed since.
//   3. One slot, not a queue. Two clicks before the tab mounts is a user
//      changing their mind, and replaying both would open the first design and
//      then immediately replace it — with the SECOND one's undo entry pointing
//      at the first, which is not text the user ever had.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimPending,
  requestOpen,
  resetHandoff,
  subscribeHandoff,
  type PendingDesign,
} from '../src/shop/handoff.ts';

function design(id: string): PendingDesign {
  return {
    id,
    title: id,
    path: `2bee_hive/${id}.scad`,
    source: `// ${id}\ncube(1);`,
    files: { [`2bee_hive/${id}.scad`]: `// ${id}\ncube(1);` },
  };
}

test('a request with nothing listening is HELD, not dropped', () => {
  resetHandoff();
  requestOpen(design('quilt'));
  const got = claimPending();
  assert.equal(got?.id, 'quilt');
});

test('claiming CLEARS the slot — a remount must not re-open the design', () => {
  resetHandoff();
  requestOpen(design('quilt'));
  assert.equal(claimPending()?.id, 'quilt');
  assert.equal(claimPending(), null, 'a second claim must find nothing');
});

test('with a listener the design is delivered and nothing is left pending', () => {
  resetHandoff();
  const seen: string[] = [];
  subscribeHandoff((d) => seen.push(d.id));
  requestOpen(design('floor'));
  assert.deepEqual(seen, ['floor']);
  assert.equal(claimPending(), null, 'a delivered design must not ALSO be pending');
});

test('the slot holds ONE request — a second click replaces the first', () => {
  resetHandoff();
  requestOpen(design('first'));
  requestOpen(design('second'));
  assert.equal(claimPending()?.id, 'second');
  assert.equal(claimPending(), null);
});

test('unsubscribing restores the held-request behaviour', () => {
  resetHandoff();
  const off = subscribeHandoff(() => {});
  off();
  requestOpen(design('later'));
  assert.equal(claimPending()?.id, 'later', 'with no listener left it must be held again');
});

test('the entry source is carried IN the files map under its own path', () => {
  // `CadTab` installs `files` as the library and sets `selfPath` to `path`.
  // If the entry were not in its own closure the editor would open text that
  // the library cannot resolve, and a `use <./sibling.scad>` relative to it
  // would resolve against a file the host does not have.
  const d = design('rail');
  assert.equal(d.files[d.path], d.source);
});
