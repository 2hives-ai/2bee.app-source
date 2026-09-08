// A LATE ANSWER MUST NOT OVERWRITE A NEWER ONE.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE RACE THIS GUARDS
// ═══════════════════════════════════════════════════════════════════════════
//
// `App.tsx`'s `replan` runs from an effect on every dependency change, so
// changing two settings quickly puts TWO plans in flight. Since the CAM core
// moved into a Worker (TODO #144) each one is a real round trip, and two things
// go wrong if nothing orders them — both silent:
//
//   1. The FIRST answer can land after the second and overwrite the newer
//      report. The panel, the G-code view and the download button then describe
//      the OLDER inputs — the stale-program defect arriving through the back
//      door after the front one was shut by gating them on `busy`.
//   2. The first plan's `finally` clears `busy` while the second is still
//      running, so the status reads `runnable` over a plan still in flight.
//
// ⚠ IT WAS AN ARGUMENT BEFORE THIS, AND THE ARGUMENT WAS TRUE: the worker
// processes messages in order, so responses return in order, and `replan` was
// the only caller. Neither is a check. Ordering says nothing about which REQUEST
// a late answer belongs to — a rejected promise, a retry, or a second caller
// added later all break it — and "the only caller" is a fact about today's code.
//
// ⚠ WHAT THIS FILE IS. `App.tsx` cannot be imported in node (the loader stops at
// the sample asset imports — see `config-wiring.test.ts`, which records the same
// boundary), so this does NOT render React. It models the generation rule in
// isolation and asserts the behaviour, and separately asserts that `App.tsx`
// still CONTAINS the guard — a text check, which proves "unchanged" and never
// "correct". Gate `I1` drives the real thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(WEB, 'src', 'App.tsx'), 'utf8');

/** The rule as `replan` implements it, with the async plan injectable. */
function makeReplan(plan: (n: number) => Promise<string>) {
  const state = { report: null as string | null, busy: false };
  let seq = 0;
  return {
    state,
    async replan(n: number) {
      const mine = ++seq;
      const current = () => mine === seq;
      state.busy = true;
      try {
        const r = await plan(n);
        if (!current()) return;
        state.report = r;
      } finally {
        if (current()) state.busy = false;
      }
    },
  };
}

test('an older plan finishing LAST does not overwrite the newer report', async () => {
  // Plan 1 takes longer than plan 2 — the exact interleaving a worker makes
  // possible and a synchronous call never could.
  const delays: Record<number, number> = { 1: 40, 2: 1 };
  const h = makeReplan(
    (n) => new Promise<string>((res) => setTimeout(() => res(`report-${n}`), delays[n])),
  );

  const first = h.replan(1);
  const second = h.replan(2);
  await Promise.all([first, second]);

  assert.equal(
    h.state.report,
    'report-2',
    'the FIRST plan finished last and overwrote the newer report — the panel, the G-code view ' +
      'and the download button would all describe inputs the operator has already replaced',
  );
});

test('an older plan finishing first does not clear busy while a newer one runs', async () => {
  let releaseSecond: (() => void) | null = null;
  const h = makeReplan((n) =>
    n === 1
      ? Promise.resolve('report-1')
      : new Promise<string>((res) => {
          releaseSecond = () => res('report-2');
        }),
  );

  void h.replan(1);
  const second = h.replan(2);
  await new Promise((r) => setTimeout(r, 10)); // let plan 1 settle

  assert.equal(
    h.state.busy,
    true,
    'the first plan cleared `busy` while the second was still running — the status would read ' +
      '`runnable` over a plan in flight, re-opening exactly what gating it on `busy` closed',
  );
  (releaseSecond as unknown as () => void)();
  await second;
  assert.equal(h.state.busy, false, 'busy was never cleared by the newest plan');
  assert.equal(h.state.report, 'report-2');
});

test('App.tsx still carries the generation guard', () => {
  // The model above proves the RULE. This proves the rule is still wired into
  // the component the browser runs — the two halves fail differently and only
  // both together mean anything.
  for (const needle of [
    'const planSeq = useRef(0)',
    'const mine = ++planSeq.current',
    'const current = () => mine === planSeq.current',
    'if (!current()) return;',
    'if (current()) setBusy(false);',
  ]) {
    assert.ok(
      APP.includes(needle),
      `App.tsx no longer contains ${JSON.stringify(needle)} — the re-plan generation guard has ` +
        'been removed or rewritten, and a late answer can overwrite a newer one again.',
    );
  }
});
