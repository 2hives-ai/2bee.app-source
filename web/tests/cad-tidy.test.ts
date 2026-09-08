// 2bee.cad — what the 2026-08-11 tidiness pass may NOT take away.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHY IT IS PHRASED AS A SET OF REFUSALS
// ═══════════════════════════════════════════════════════════════════════════
//
// Founder, 2026-08-11: *"be tidy, no unnecessary text, make it clean end to
// end"*. Six things came off this tab that day. Every one of them was a notice
// that always says yes — a success alert, a green audit banner, a stats line, a
// header saying its own name.
//
// 🔴 THE FAILURE MODE OF THAT INSTRUCTION IS THE ONE THING NOTHING GUARDS.
// A refusal shortened into a label, a caution stripped of the `assumed` /
// `unchecked` word that made it a caution, an omission entry deleted instead of
// moved, the outbound disclosure trimmed — each of those is a **safety
// regression that looks exactly like tidiness in a diff**, and reads as an
// improvement in review. Deleting text leaves nothing behind to notice, which
// is why it needs a test rather than a convention.
//
// So this file asserts the OPPOSITE of the other cad tests: not that a feature
// works, but that a sentence somebody could reasonably delete is still there,
// and that a duplicate somebody could reasonably re-add is still gone.
//
// ⚠ WHAT IS NOT CLAIMED HERE. Nothing in this file was seen on a screen. It
// renders components to static markup in node. Whether a heading is legible,
// whether removing one leaves the row looking unmoored, and whether a note is
// "unnecessary" in the visual sense a person means by it — none of that is
// reachable from here and none of it is asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAD = join(HERE, '..', 'src', 'cad');

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
const { CadConsole } = await import('../src/cad/console.tsx');
const {
  AskSettings,
  OUTBOUND_DISCLOSURE,
  PROMPT_LABEL,
  ProposalView,
  NO_ASK_CONFIG,
  classifyThrow,
  evaluate,
  preflight,
  readReply,
  reviewProposal,
} = await import('../src/cad/ask.tsx');
const { GAPS, OMISSIONS, cadMenus } = await import('../src/cad/menu.tsx');
const { buildCadRecord } = await import('../src/cad/record.ts');

/* ════════════════════════════════════════════════════════════════════════════
   1. The duplicate header that was removed, and must not come back
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The adjudication standard is not this file's invention. `ObjectPicker.tsx`
 * settled it for TODO #77 in the same week: **exact, case- and space-insensitive
 * equality, and no stemming** — `Tool` does not match `Tooling`, because a
 * heading and a thing inside it are not a heading said twice. This file applies
 * the same rule to the CAD tab's dock, which has three panes.
 */
const sameWords = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const analyse = (src: string) => {
  const parse = parseScad(src);
  return { parse, mesh: meshScene(parse.scene) };
};

/**
 * 🔴 PLANT: put `<strong>Console</strong>` back at the head of the console pane
 * and this goes red.
 *
 * The dock tab immediately above that row IS the word `Console`, so the heading
 * was the pane saying its own name twice — the `Machine / Machine` shape the
 * founder named on 2026-08-11 and the one `ObjectPicker.tsx` already suppresses
 * on the CNC side.
 */
test('the console pane does not print the name of the dock tab that opened it', () => {
  const { parse, mesh } = analyse('cube(10);\nhulls() cube(5);\n');
  const html = renderToStaticMarkup(
    h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }),
  );
  assert.ok(
    !/>\s*Console\s*</.test(html),
    'the pane is heading itself `Console` under a dock tab already labelled `Console`',
  );
});

/**
 * ⚠ AND THE HALF THE TAB CANNOT CARRY MUST SURVIVE THE DELETION. The tab shows
 * ONE total; this row shows the split by CLASS, which one number cannot say —
 * an error (not understood), a refusal (understood, named, contributing
 * nothing) and a warning are three different facts and the badge deliberately
 * does not pretend to distinguish them. Deleting the row along with the heading
 * would have been the real loss, so it is asserted separately from the heading
 * it sat beside.
 *
 * 🔴 CORRECTED 2026-08-11: this note used to say the two numbers "are not even
 * the same number — the tab totals the PARSE diagnostics, this row totals parse
 * AND mesh". That was a true measurement of a DEFECT, and it stopped being true
 * when the defect was fixed; both now come from {@link consoleBadge} over the
 * same rows. A stale red lies exactly like a stale green.
 */
test('removing the heading did not take the per-class counts with it', () => {
  const { parse, mesh } = analyse('cube(10);\nhulls() cube(5);\n');
  const html = renderToStaticMarkup(
    h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }),
  );
  assert.match(html, /error/, 'the error count is gone from the console header');
  assert.match(html, /refused/, 'the refused count is gone from the console header');
  assert.match(html, /warning/, 'the warning count is gone from the console header');
});

/**
 * 🔴 INVERTED 2026-08-11 — this was the pin on the defect; it is now the test of
 * the fix, at the same fixture, with the same measurement.
 *
 * As written it asserted that the parse-only sum is `0` for a source whose only
 * diagnostic is a MESH refusal, and it was introduced as a pin that "goes red
 * when someone fixes it". ⚠ **IT WOULD NOT HAVE.** It re-derived the badge
 * expression inside the test body instead of reading the badge, so it measured
 * the FIXTURE and never the control — the parse-only sum stays `0` for this
 * source no matter what the tab renders. A pin that recomputes its own input
 * measures sensitivity to the input, not to the fix, and this one would have sat
 * green through the very change it was written to catch.
 *
 * So both halves are kept and the missing half is added: the fixture's property
 * (no parse diagnostic, one mesh refusal) is the precondition, and the assertion
 * is now on {@link consoleBadge} — the number the dock tab is required to show.
 * Delete the mesh rows from `consoleLines`, or reinstate the parse-only sum in
 * `consoleBadge`, and this goes red.
 */
test('a mesh-only refusal reaches the tab badge, not just the console row', async () => {
  const { consoleLines, consoleBadge } = await import('../src/cad/console.tsx');
  const { parse, mesh } = analyse('difference() { cube(10); circle(3); }');
  const parseOnly = parse.errors.length + parse.unsupported.length + parse.warnings.length;
  const rows = consoleLines(parse, mesh);

  /* The two preconditions, or the assertion below proves nothing. */
  assert.equal(parseOnly, 0, 'the fixture must produce no PARSE diagnostic, or it proves nothing');
  assert.ok(
    rows.some((r: { severity: string }) => r.severity === 'refused'),
    'the fixture stopped producing a mesh refusal, so this measurement is vacuous',
  );

  const badge = consoleBadge(rows);
  assert.equal(badge.count, rows.length, 'the badge and the pane are counting different lists');
  assert.ok(badge.count > 0, 'a refused construct is invisible while another pane is showing');
  assert.equal(badge.counts.refused, 1, 'the refusal is not in the split the tab hands to its title');
  assert.equal(badge.worst, 'refused');
});

/**
 * The rule stated as a rule, over the dock's own tab labels, so a fourth pane
 * added later is covered without anybody remembering this file.
 *
 * ⚠ It reads the labels out of `CadTab.tsx` by regex rather than importing
 * `BOTTOM_TABS`, which is module-private. A regex over a source file proves the
 * characters are there, not that the strip renders them — stated rather than
 * left to be assumed.
 */
test('no dock tab label is also a heading inside the pane it opens', () => {
  const tab = readFileSync(join(CAD, 'CadTab.tsx'), 'utf8');
  const labels = [...tab.matchAll(/id: '(console|tree|ask)', label: '([^']+)'/g)].map((m) => m[2]);
  assert.ok(labels.length >= 2, `expected the dock tab labels, found ${JSON.stringify(labels)}`);

  const { parse, mesh } = analyse('cube(10);');
  const panes: { label: string; html: string }[] = [
    {
      label: 'Console',
      html: renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: false })),
    },
  ];
  for (const pane of panes) {
    for (const label of labels) {
      if (!sameWords(label, pane.label)) continue;
      assert.ok(
        !new RegExp(`>\\s*${label}\\s*<`).test(pane.html),
        `the ${pane.label} pane heads itself with its own dock tab label`,
      );
    }
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The outbound disclosure — the one paragraph a tidiness pass may not touch
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 PLANT: delete any clause of {@link OUTBOUND_DISCLOSURE} and this goes red.
 *
 * It is the only place this app states what leaves the operator's machine. This
 * is an AGPL bundle, so a reader can check every word of it against the source —
 * which is exactly why an untrue or a shortened version is worse here than in a
 * closed product. Four separable claims, asserted separately so a partial trim
 * cannot pass on the strength of the sentences it kept.
 */
test('the outbound disclosure still makes all four of its claims', () => {
  const d = OUTBOUND_DISCLOSURE;
  assert.match(d, /only thing in this app that sends anything anywhere/i, 'the sole-outbound-path claim');
  assert.match(d, /works with no network at all/i, 'the offline claim about everything else');
  assert.match(d, /no endpoint and no key in this app/i, 'the nothing-is-baked-in claim');
  assert.match(d, /they are yours|stay in this browser/i, 'the whose-credentials claim');
});

/**
 * 🔴 AND IT MUST REACH BOTH SURFACES. `AskSettings` is one component rendered
 * from two places — `File → Settings…` and, while nothing is configured, inline
 * in the Ask pane. A disclosure that survives in the constant and stops being
 * rendered is deleted in the only way that matters.
 */
test('the disclosure is on screen in both places AskSettings appears', () => {
  const withClose = renderToStaticMarkup(
    h(AskSettings, { cfg: NO_ASK_CONFIG, onPatch: () => {}, onClose: () => {} }),
  );
  const inline = renderToStaticMarkup(
    h(AskSettings, { cfg: NO_ASK_CONFIG, onPatch: () => {}, onClose: null }),
  );
  for (const [where, html] of [['File → Settings…', withClose], ['the inline copy', inline]] as const) {
    assert.ok(
      html.includes('only thing in this app that sends anything anywhere'),
      `the outbound disclosure is missing from ${where}`,
    );
  }
});

/**
 * ⚠ THE SECOND HALF OF THE PROMPT LABEL IS A DISCLOSURE WEARING A LABEL'S
 * CLOTHES, and it is the half a tidiness pass would take: it looks like the kind
 * of explanatory tail that gets cut. It says the WHOLE FILE in the editor
 * travels, not only the words typed in the box.
 */
test('the prompt label still says the source travels with the prompt', () => {
  assert.match(PROMPT_LABEL, /source in the editor is sent with it/i);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. Refusals keep their reasons
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 PLANT: shorten any of these details to a label and the matching line goes
 * red.
 *
 * A refusal in this app names WHAT it refused and WHY — *"a lead-in on an inside
 * cut has nowhere to go"*, not *"refused"*. The reason is the part that is
 * useless to the person deleting text and load-bearing to the person at the
 * machine, which is precisely the asymmetry that lets it get cut. Each entry
 * below names the FACT the detail carries, not its wording, so a rewrite passes
 * and a removal does not.
 */
const REFUSAL_REASONS: { what: string; detail: string; must: RegExp }[] = [
  {
    what: 'preflight · no endpoint',
    detail: preflight(NO_ASK_CONFIG, 'do a thing', true)!.detail,
    must: /AGPL|published to everyone/i,
  },
  {
    what: 'preflight · no model id',
    detail: preflight({ ...NO_ASK_CONFIG, endpoint: 'https://x.test/v1/chat/completions' }, 'p', true)!
      .detail,
    must: /no default|a guess/i,
  },
  {
    what: 'preflight · no key',
    detail: preflight(
      { ...NO_ASK_CONFIG, endpoint: 'https://x.test/v1/chat/completions', model: 'm' },
      'p',
      true,
    )!.detail,
    must: /unauthenticated/i,
  },
  {
    what: 'preflight · offline',
    detail: preflight(
      { ...NO_ASK_CONFIG, endpoint: 'https://x.test/v1/chat/completions', model: 'm', apiKey: 'k' },
      'p',
      false,
    )!.detail,
    must: /the rest of the tab|work(s)? offline/i,
  },
  {
    what: 'transport · timeout',
    detail: classifyThrow({ name: 'AbortError' }).detail,
    must: /raise the timeout/i,
  },
  {
    what: 'transport · never reached an endpoint',
    detail: classifyThrow(new TypeError('failed to fetch')).detail,
    must: /CORS/,
  },
  {
    what: 'reply · the endpoint refused it',
    detail: (readReply({ status: 401, ok: false, text: '{}' }) as { failure: { detail: string } })
      .failure.detail,
    must: /401 or 403/,
  },
  {
    what: 'reply · not JSON',
    detail: (readReply({ status: 200, ok: true, text: '<html>' }) as { failure: { detail: string } })
      .failure.detail,
    must: /proxy or a login page/i,
  },
  {
    what: 'reply · a shape this app does not read',
    detail: (readReply({ status: 200, ok: true, text: '{"nope":1}' }) as {
      failure: { detail: string };
    }).failure.detail,
    must: /choices\[0\]\.message\.content/,
  },
];

for (const r of REFUSAL_REASONS) {
  test(`the refusal "${r.what}" still carries its reason`, () => {
    assert.match(r.detail, r.must);
  });
}

/**
 * 🔴 THE SAVE/EXPORT REFUSAL IS THE ONE WITH A SPINDLE BEHIND IT. `record.ts`
 * refuses to write a model the mesh audit will not vouch for, because the CNC
 * tab sections what is stored — and a solid with holes still sections into a
 * closed-looking outline that posts, simulates and cuts. That whole causal chain
 * lives in the `detail`, and a headline alone would not carry it.
 */
test('the save refusal still explains what an unaudited solid does downstream', () => {
  const src = 'cube(10);';
  const parse = parseScad(src);
  const built = buildCadRecord({ name: '', source: src, parse, mesh: meshScene(parse.scene), now: 0 });
  assert.equal(built.ok, false, 'an unnamed model must still be refused');
  if (built.ok) return;
  assert.ok(built.refusal.detail.length > built.refusal.headline.length, 'the reason is now shorter than the label');
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The omission and gap lists — entries move, they do not vanish
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 PLANT: delete one entry from either array and this goes red.
 *
 * The two lists are the app's statement of what it does NOT have, printed in
 * `Help → About`. They are split in two on purpose — {@link OMISSIONS} is
 * *"the thing this controls does not exist here"*, {@link GAPS} is *"this is
 * simply not built"* — and one entry of the wrong kind devalues every other,
 * because a reader cannot tell them apart from the outside.
 *
 * ⚠ THE COUNTS ARE THE ASSERTION, deliberately. An entry is allowed to move
 * between the arrays, and is allowed to be rewritten; what may not happen
 * silently is the TOTAL going down, because that is a capability whose absence
 * stopped being stated. If a capability is genuinely built, its entry leaves in
 * the same commit that builds it — and this number changes in that commit, with
 * the reason in the message. A number that has to be edited on purpose is the
 * point, not a nuisance.
 */
/* ⚠ BOTH NUMBERS WERE MEASURED BY RUNNING THE MODULE, not counted by reading it.
 * The first draft of this file asserted 7 omissions from a read-through and went
 * red against the real 8 — which is the whole reason a count belongs in a test
 * rather than in a comment. */
const OMISSIONS_AT_2026_08_11 = 8;
const GAPS_AT_2026_08_11 = 5;

test('nothing was quietly dropped from the omission list', () => {
  assert.equal(
    OMISSIONS.length,
    OMISSIONS_AT_2026_08_11,
    'an omission entry appeared or disappeared — if a capability was built, say so in the commit and move this number',
  );
});

test('nothing was quietly dropped from the gap list', () => {
  assert.equal(
    GAPS.length,
    GAPS_AT_2026_08_11,
    'a gap entry appeared or disappeared — if it was built or wired, say so in the commit and move this number',
  );
});

/** ⚠ An entry that survives as an empty string is a deletion that passed a count. */
test('every omission and every gap is a sentence, not a placeholder', () => {
  for (const [name, list] of [['OMISSIONS', OMISSIONS], ['GAPS', GAPS]] as const) {
    list.forEach((entry: string, i: number) => {
      assert.ok(entry.trim().length > 40, `${name}[${i}] is not a sentence: ${JSON.stringify(entry)}`);
    });
  }
});

/**
 * 🔴 AND BOTH LISTS MUST REACH THE SCREEN. They are printed by `Help → About`
 * and nowhere else, so an array kept intact while the report stops spreading it
 * is the same deletion arriving through the renderer.
 */
test('Help → About is still the thing that prints both lists', () => {
  const tab = readFileSync(join(CAD, 'CadTab.tsx'), 'utf8');
  const about = tab.slice(tab.indexOf("case 'help.about'"), tab.indexOf("case 'help.about'") + 2600);
  assert.match(about, /\.\.\.OMISSIONS/, 'Help → About no longer spreads OMISSIONS');
  assert.match(about, /\.\.\.GAPS/, 'Help → About no longer spreads GAPS');
  assert.match(about, /WHAT DOES NOT EXIST HERE/, 'the omission heading is gone');
  assert.match(about, /SIMPLY MISSING/, 'the gap heading — the thing that keeps the two kinds apart — is gone');
});

/* ════════════════════════════════════════════════════════════════════════════
   5. The two blocks that used to restate their own headings
   ══════════════════════════════════════════════════════════════════════════ */

const CURRENT = 'cube([10, 10, 10]);\n';
const proposal = (source: string) => {
  const review = reviewProposal(evaluate(CURRENT), source);
  return {
    review,
    html: renderToStaticMarkup(
      h(ProposalView, { review, raw: 'x', applied: review.blocked === null, onDiscard: () => {} }),
    ),
  };
};

/**
 * 🔴 PLANT: put *"This replaced everything in the editor. The source it replaced
 * is kept, and the toolbar offers to put it back — one step"* back in the footer
 * and this goes red.
 *
 * The heading at the top of the same block already says both halves. A block
 * whose foot restates its own head is the shape the founder removed six times on
 * 2026-08-11 — *"most of the menus have the header, then the Header repeats"*.
 */
test('the applied proposal states the put-back once, at the top', () => {
  const { html } = proposal('cube([20, 10, 10]);\n');
  assert.match(html, /data-testid="cad-ask-applied"/, 'this fixture must actually apply');
  const said = html.match(/offers to put/g) ?? [];
  assert.equal(said.length, 1, `the put-back is stated ${said.length} times in one block`);
});

/**
 * ⚠ AND WHAT THE FOOTER UNIQUELY CARRIED SURVIVED THE TRIM. Two limits, neither
 * derivable from the heading: the put-back is not an undo for typing, and the
 * button beside it does NOT put anything back. Both are the kind of sentence a
 * tidiness pass takes because it reads as a hedge.
 */
test('the applied proposal keeps the two limits only the footer stated', () => {
  const { html } = proposal('cube([20, 10, 10]);\n');
  assert.match(html, /not an undo for your typing/i, 'the typing-undo limit was trimmed away');
  assert.match(html, /clearing this report does not put anything back/i, 'the Clear limit was trimmed away');
});

/**
 * 🔴 THE REFUSED SIDE KEEPS ITS REFUSAL AND ITS HEADING, and loses only the
 * third copy. `Nothing here reached the editor.` was the deleted one; the
 * heading and the refusal's own sentence both stay, and the refusal is the one
 * carrying the reason.
 */
test('a refused proposal still says the editor is untouched, and says it with the reason', () => {
  const { html } = proposal('this is prose, not source');
  assert.match(html, /Nothing has changed in the editor/, 'the heading was deleted, not the duplicate');
  assert.match(html, /data-testid="cad-ask-blocked"/, 'the refusal element is gone');
  assert.match(html, /The editor\s+is untouched/, 'the refusal stopped saying the editor is untouched');
  assert.ok(
    !/Nothing here reached the editor/.test(html),
    'the third copy came back',
  );
});

/**
 * 🔴 PLANT: put `Nothing was changed here.` back into a failure detail and this
 * goes red.
 *
 * The failure box appends `The editor is untouched.` to EVERY detail, so three
 * kinds — refused, empty, timeout — printed the same fact twice in one
 * paragraph. The invariant belongs at the renderer, where a failure kind added
 * next month inherits it; a copy inside a detail is a second statement that can
 * only ever go out of step.
 *
 * ⚠ THIS IS TWO HALVES AND NEITHER IS SUFFICIENT ALONE. The first half is a
 * source regex, which proves the characters are in the renderer and NOT that the
 * path runs; the second is over real values. Together they say "exactly once";
 * separately they say less, and this note is here so nobody reads the pair as
 * one strong check.
 */
test('the failure box supplies "the editor is untouched", and no detail says it too', () => {
  const src = readFileSync(join(CAD, 'ask.tsx'), 'utf8');
  assert.match(
    src,
    /\{state\.failure\.detail\}\s*The editor is untouched\./,
    'the renderer stopped supplying the untouched-editor sentence',
  );

  const details = [
    classifyThrow({ name: 'AbortError' }).detail,
    classifyThrow(new TypeError('boom')).detail,
    (readReply({ status: 401, ok: false, text: '{}' }) as { failure: { detail: string } }).failure.detail,
    (readReply({ status: 200, ok: true, text: '{"choices":[{"message":{"content":"   "}}]}' }) as {
      failure: { detail: string };
    }).failure.detail,
  ];
  for (const d of details) {
    assert.ok(
      !/editor is untouched|Nothing was changed here/i.test(d),
      `this detail duplicates the sentence the renderer already appends: ${JSON.stringify(d)}`,
    );
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   6. Menu items keep the reason a disabled control owes the operator
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 A DISABLED ITEM WITH NO REASON IS A PUZZLE, and the reason is the first
 * thing a tidiness pass deletes because the item already looks self-explanatory
 * to whoever wrote it. `menu.tsx` renders `disabledReason` INSTEAD of `note`, so
 * dropping one leaves a grey row and nothing else.
 */
test('every disabled menu item says why, in every state this tab can be in', () => {
  const states = [
    {
      dirty: false, saveBlocked: null, errorCount: 0, undoLabel: null, redoLabel: null,
      bottomTab: 'console', askVisible: true, savedName: null, axes: true, scaleMarkers: true,
    },
    {
      dirty: true, saveBlocked: 'the preview is catching up', errorCount: 3,
      undoLabel: 'Put back what New replaced', redoLabel: 'Redo New',
      bottomTab: 'tree', askVisible: true, savedName: 'bracket', axes: false, scaleMarkers: true,
    },
  ];
  let seen = 0;
  for (const ctx of states) {
    for (const menu of cadMenus(ctx as never)) {
      for (const item of menu.items) {
        if (!item.disabled) continue;
        seen++;
        assert.ok(
          (item.disabledReason ?? '').trim().length > 20,
          `${item.id} is disabled with no reason worth reading`,
        );
      }
    }
  }
  assert.ok(seen >= 3, `expected several disabled items across these states, saw ${seen}`);
});

/**
 * ⚠ AND AN ACCELERATOR MAY STILL ONLY NAME A KEY THE BAR BINDS. Not a tidiness
 * property, but it is the neighbouring invariant most easily broken by an edit
 * to this menu tree, and a printed key with no binding is a dead control drawn
 * as a live one.
 */
test('no menu item advertises a key outside BOUND_KEYS', async () => {
  const { BOUND_KEYS } = await import('../src/cad/menu.tsx');
  const ctx = {
    dirty: false, saveBlocked: null, errorCount: 1, undoLabel: null, redoLabel: null,
    bottomTab: 'console', askVisible: true, savedName: null, axes: true, scaleMarkers: true,
  };
  for (const menu of cadMenus(ctx as never)) {
    for (const item of menu.items) {
      if (!item.accel) continue;
      assert.ok(item.accel in BOUND_KEYS, `${item.id} prints ${item.accel}, which nothing binds`);
    }
  }
});
