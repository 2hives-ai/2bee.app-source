// The program as line segments for cnc.run's 3D view, and where the tool is
// after each line.
//
// 🔴 A PICTURE OF THE PROGRAM, NOT A CHECK OF IT. It reads the G0/G1/G2/G3
// moves of the lines that are streamed (the air cut's lifted lines during the
// air cut), in absolute millimetres from work zero, so the operator sees the
// path and where the controller has got to. It refuses to draw what it cannot
// read faithfully — G20, an `R`-form arc — and says which line, rather
// than drawing a plausible wrong path. Nothing here decides anything; the
// sender and the core do.

// ⚠ A READER OF THE G-CODE DIALECT (tests/dialect-readers.test.ts). Its word
// rule follows `feeds::word_value_at` (a value may follow its letter after
// spaces: `F 5000`) and its comment rule `feeds::strip_comments` (`( … )` and
// `; …` removed before any word is read, so a Z in comment prose is not a Z).

export interface Toolpath {
  /** xyz,xyz per segment. */
  segs: Float32Array;
  /** Program line index of each segment. */
  lineOf: Int32Array;
  /** 1 for a rapid (G0) segment. */
  rapid: Uint8Array;
  /** Tool tip position after each program line: xyz per line. */
  after: Float32Array;
  /** Why the rest of the path is not drawn, or null. */
  stopped: string | null;
}

function codeOf(line: string): string {
  return line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
}

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi;

export function toolpathOf(lines: readonly string[], start: [number, number, number] = [0, 0, 0]): Toolpath {
  const segs: number[] = [];
  const lineOf: number[] = [];
  const rapid: number[] = [];
  const after = new Float32Array(lines.length * 3);
  let [x, y, z] = start;
  let motion = 0;
  let inc = false;
  let stopped: string | null = null;
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, li: number, r: boolean) => {
    segs.push(ax, ay, az, bx, by, bz);
    lineOf.push(li);
    rapid.push(r ? 1 : 0);
  };
  for (let i = 0; i < lines.length; i++) {
    if (!stopped) {
      const w: Record<string, number> = {};
      const gs: number[] = [];
      for (const m of codeOf(lines[i]).matchAll(WORD)) {
        const L = m[1].toUpperCase();
        const v = Number(m[2]);
        if (L === 'G') gs.push(v);
        else w[L] = v;
      }
      let g10 = false;
      let probe = false;
      for (const g of gs) {
        if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
        if (g === 91) inc = true;
        if (g === 90) inc = false;
        if (g === 10) g10 = true;
        if (g > 38 && g < 39) probe = true;
        if (g === 20) stopped = `Line ${i + 1}: G20 is not drawn (only millimetres are).`;
      }
      const moves = 'X' in w || 'Y' in w || 'Z' in w;
      if (!stopped && g10) {
        /* `G10 L20 P1 Z<v>`: the tip now READS v — the datum moved, the tool did not. */
        if (w.L === 20 && 'Z' in w) z = w.Z;
      } else if (!stopped && moves) {
        const nx = 'X' in w ? (inc ? x + w.X : w.X) : x;
        const ny = 'Y' in w ? (inc ? y + w.Y : w.Y) : y;
        const nz = 'Z' in w ? (inc ? z + w.Z : w.Z) : z;
        /* A probe is drawn to its TARGET; it stops at contact, which no picture knows. */
        if (probe) {
          seg(x, y, z, nx, ny, nz, i, false);
          [x, y, z] = [nx, ny, nz];
        } else {
        if (motion === 2 || motion === 3) {
          if (!('I' in w) && !('J' in w)) {
            stopped = `Line ${i + 1}: an arc without I/J is not drawn.`;
          } else {
            const cx = x + (w.I ?? 0);
            const cy = y + (w.J ?? 0);
            const r = Math.hypot(x - cx, y - cy);
            let a0 = Math.atan2(y - cy, x - cx);
            let a1 = Math.atan2(ny - cy, nx - cx);
            const cw = motion === 2;
            if (cw && a1 >= a0) a1 -= 2 * Math.PI;
            if (!cw && a1 <= a0) a1 += 2 * Math.PI;
            const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
            let px = x, py = y, pz = z;
            for (let k = 1; k <= n; k++) {
              const a = a0 + ((a1 - a0) * k) / n;
              const qx = k === n ? nx : cx + r * Math.cos(a);
              const qy = k === n ? ny : cy + r * Math.sin(a);
              const qz = z + ((nz - z) * k) / n;
              seg(px, py, pz, qx, qy, qz, i, false);
              px = qx; py = qy; pz = qz;
            }
          }
        } else {
          seg(x, y, z, nx, ny, nz, i, motion === 0);
        }
        if (!stopped) [x, y, z] = [nx, ny, nz];
        }
      }
    }
    after[i * 3] = x;
    after[i * 3 + 1] = y;
    after[i * 3 + 2] = z;
  }
  return { segs: Float32Array.from(segs), lineOf: Int32Array.from(lineOf), rapid: Uint8Array.from(rapid), after, stopped };
}

/** The tool tip after `acked` lines have been answered (0 = before the first). */
export function toolAt(tp: Toolpath, acked: number, start: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (acked <= 0) return start;
  const i = Math.min(acked, tp.after.length / 3) - 1;
  return [tp.after[i * 3], tp.after[i * 3 + 1], tp.after[i * 3 + 2]];
}
