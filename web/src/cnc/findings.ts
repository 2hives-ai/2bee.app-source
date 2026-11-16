/**
 * The core's fixture findings, in words (founder 2026-10-16: "what is this
 * issue? … RapidBelowClamp { clamp: "toggle-clamp-vertical-2", z: 5.0,
 * clamp_height: 42.4 }"). They reach the app as Rust `{:?}` text; this turns
 * the kinds core/src/fixture.rs defines into a sentence and, where one exists,
 * the fix. Unknown text is passed through unchanged, never hidden.
 */
export interface FindingText {
  text: string;
  /** Safe Z that clears the clamp by 5 mm, for a RapidBelowClamp. */
  safeZNeeded?: number;
  clamp?: string;
}

const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));

export function describeFinding(raw: string): FindingText {
  let m = /RapidBelowClamp\s*\{\s*clamp:\s*"([^"]*)",\s*z:\s*([-\d.]+),\s*clamp_height:\s*([-\d.]+)\s*\}/.exec(raw);
  if (m) {
    const z = num(m[2]), h = num(m[3]);
    const need = Math.ceil(h + 5);
    return {
      text: `A fast move at ${z} mm height would cross clamp "${m[1]}", which stands ${h} mm tall: the cutter would hit it. Raise the safe Z to at least ${need} mm, or move or remove that clamp.`,
      safeZNeeded: need,
      clamp: m[1],
    };
  }
  m = /CutsClamp\s*\{\s*clamp:\s*"([^"]*)",\s*x:\s*([-\d.]+),\s*y:\s*([-\d.]+)\s*\}/.exec(raw);
  if (m) {
    return {
      text: `The cut passes through clamp "${m[1]}" at X ${num(m[2]).toFixed(1)}, Y ${num(m[3]).toFixed(1)}: the cutter would cut the clamp. Move or remove that clamp, or place the part away from it.`,
      clamp: m[1],
    };
  }
  m = /ClampHeightUndeclared\s*\{\s*clamp:\s*"([^"]*)"\s*\}/.exec(raw);
  if (m) return { text: `Clamp "${m[1]}" has no height, so nothing can check that the cutter clears it. Declare its height or remove it.`, clamp: m[1] };
  return { text: raw };
}
