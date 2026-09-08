/* =============================================================================
 * AN ANSWER IS ONLY AN ANSWER TO THE QUESTION IT WAS ASKED
 * =============================================================================
 *
 * The core's verdicts — which cutters work here (`tool_verdicts`), which
 * drawings are on this workpiece (`drawing_verdicts`) — are fetched
 * ASYNCHRONOUSLY from the wasm and held in React state. Between the setup
 * changing and the new answer landing, the state still holds the OLD one.
 *
 * 🔴 THAT WINDOW IS NOT A COSMETIC ONE, because the drawing list FILTERS on the
 * answer. Shrink the workpiece and, until the reply arrives, a row that no
 * longer fits still reads `on the workpiece`, still passes the *on the
 * workpiece* filter, and — the worse direction — a row that now fails still
 * counts as fitting in the hidden-count at the foot of the dialog. **A cached
 * verdict is confidently wrong rather than obviously broken**: nothing on screen
 * is blank, nothing is spinning, and every mark is a real sentence the core once
 * wrote about a workpiece nobody is looking at any more.
 *
 * The app already carries this rule in two other places and both are written
 * down: `loadedMesh` is `report.loaded_mesh` ONLY while `plannedFrom` still
 * names the loaded drawing, and `splitDrawingParts` REFUSES when the report and
 * the drawing list describe different sheets. This is the same rule, applied to
 * the axis those two do not cover — the SETUP moving under an answer about it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW, AND WHY IT IS AN IDENTITY RATHER THAN A FINGERPRINT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The caller builds ONE `useMemo` holding everything the ask depends on, uses it
 * as the effect's dependency AND stores it beside the reply. The comparison is
 * then `Object.is` on that memo:
 *
 *   const ask = useMemo(() => ({ config, parts, ids }), [config, parts, idsKey]);
 *   useEffect(() => { …fetch…; setHeld({ ask, result }); }, [ready, ask]);
 *   const result = answerFor(held, ask);
 *
 * 🔴 ONE DEPENDENCY LIST, USED TWICE, IS THE WHOLE POINT. A second list — a
 * hash, a JSON fingerprint, a hand-written tuple — is a copy of the first, and
 * the failure mode of a copy is that it goes stale by omitting the input that
 * was added last. Then the guard passes an answer that the effect has already
 * decided is out of date, which is worse than no guard: it looks checked.
 *
 * ⚠ WHAT THIS DOES **NOT** DO. It does not make the answer fresh, and it cannot.
 * It converts a WRONG answer into NO answer — and every consumer of these
 * verdicts already renders "no answer" as `⚠ NOT ASKED`, never as usable, which
 * is the property that makes returning `null` safe here. If a consumer is ever
 * added that reads absence as agreement, this guard becomes the thing that hides
 * the problem. There is no way for this file to check that; it is stated so the
 * next reader knows what to look at.
 * ============================================================================= */

/** A reply, remembered together with the question it answers. */
export interface Answered<A, R> {
  /** The exact `ask` object that was in force when the reply was requested. */
  ask: A;
  result: R;
}

/**
 * The held reply, but ONLY if it answers the question being asked right now.
 *
 * `null` means NOT ASKED YET FOR THIS SETUP — a real state, and the one the
 * rows already render. It is never "fine".
 */
export function answerFor<A, R>(held: Answered<A, R> | null | undefined, ask: A): R | null {
  if (!held) return null;
  return Object.is(held.ask, ask) ? held.result : null;
}
