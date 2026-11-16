/** Which pcb spec file serves a board — pure, so node tests reach it (`pcbSpecs.ts` is browser-only). */

/** The board's directory under hardware/pcb, from its CPL path. */
export function boardDir(cplPath: string): string | null {
  const m = /^hardware\/pcb\/([^/]+)\//.exec(cplPath);
  return m ? m[1] : null;
}

/** Which spec file serves a board, from a list of available paths (pure; tested). */
export function pickPcbSpec(dir: string, available: readonly string[]): { kind: 'per-file' | 'directory'; path: string } | null {
  const own = `hardware/pcb/${dir}/SPEC.md`;
  if (available.includes(own)) return { kind: 'per-file', path: own };
  const fallback = available.filter((p) => p.startsWith(`hardware/pcb/${dir}/`) && /-spec\.md$/i.test(p)).sort();
  return fallback.length ? { kind: 'directory', path: fallback[0] } : null;
}
