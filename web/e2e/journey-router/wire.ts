// TEST-ONLY. The assertion the router journey exists for: from the bytes the
// fake controller RECEIVED, what did the app write?
//
// 🔴 It reads the WIRE, never the app's own echo. The console's `out` lines are
// the app describing itself; the worker posts `sent` after a write resolves,
// but a realtime byte or the status poller posts nothing. The only record that
// cannot omit a byte is the one taken inside the port's `writable` — which is
// where `router-controller.ts` takes it.
//
// Pure: no browser, no Playwright. The negative control in the spec feeds it a
// planted log and asserts the VERDICT (`ok === false`), not a message.

/** One `write()` the port received, as recorded inside its `writable`. */
export interface WireWrite {
  /** Monotonic index of the write. */
  seq: number;
  /** `Date.now()` in the worker when the write arrived. */
  at: number;
  bytes: number[];
}

export type WireItem = { kind: 'line'; text: string; seq: number } | { kind: 'realtime'; byte: number; seq: number };

/**
 * Split a received byte stream the way grblHAL does: a realtime byte is picked
 * off wherever it lands (even mid-line), everything else is assembled into
 * lines on `\n`, with `\r` dropped. A trailing partial line is returned
 * separately — bytes that never became a line are still bytes that were sent.
 */
export function splitWire(writes: readonly WireWrite[]): { items: WireItem[]; unterminated: string | null } {
  const items: WireItem[] = [];
  let line = '';
  let lineSeq = -1;
  for (const w of writes) {
    for (const b of w.bytes) {
      if (isRealtime(b)) {
        items.push({ kind: 'realtime', byte: b, seq: w.seq });
        continue;
      }
      if (b === 0x0a) {
        items.push({ kind: 'line', text: line, seq: lineSeq < 0 ? w.seq : lineSeq });
        line = '';
        lineSeq = -1;
        continue;
      }
      if (b === 0x0d) continue;
      if (lineSeq < 0) lineSeq = w.seq;
      line += String.fromCharCode(b);
    }
  }
  return { items, unterminated: line.length ? line : null };
}

/** grblHAL's realtime set: `0x18 ? ! ~` and everything from `0x80`. */
export function isRealtime(b: number): boolean {
  return b === 0x18 || b === 0x3f || b === 0x21 || b === 0x7e || b >= 0x80;
}

/** The lines the router page documents sending (`ANALYSE_COMMANDS`). */
export const ANALYSIS_LINES = ['$I', '$$', '$#', '$PINS'] as const;

/**
 * The only realtime bytes allowed anywhere in this journey: status-report
 * requests. `?` (legacy), `0x80` and `0x87` (full report). Every other realtime
 * byte — reset, hold, cycle start, override, spindle stop — is a violation.
 */
export const ALLOWED_REALTIME: ReadonlySet<number> = new Set([0x3f, 0x80, 0x87]);

/** Why a line is forbidden, named by the physical consequence class. */
export function forbiddenReason(line: string): string | null {
  const t = line.trim();
  if (/^\$\d+\s*=/.test(t)) return 'SETTING WRITE ($N=)';
  if (/^\$J\s*=/i.test(t)) return 'JOG ($J=)';
  if (/^\$H/i.test(t)) return 'HOMING CYCLE ($H)';
  if (/^\$X$/i.test(t)) return 'ALARM UNLOCK ($X)';
  if (/^\$RST/i.test(t)) return 'SETTINGS RESET ($RST)';
  if (/(^|[^A-Z$])G\s*-?\d/i.test(t) && !t.startsWith('$')) return 'G-CODE (motion/modal word)';
  if (/(^|[^A-Z$])M\s*\d/i.test(t) && !t.startsWith('$')) return 'M-CODE (spindle/coolant/program word)';
  if (/(^|[^A-Z$])S\s*\d/i.test(t) && !t.startsWith('$')) return 'SPINDLE SPEED WORD (S)';
  return null;
}

export interface WireVerdict {
  ok: boolean;
  lines: string[];
  realtime: number[];
  violations: string[];
}

/**
 * Check a slice of the received log.
 *
 * @param exact   when given, the lines must equal this list IN ORDER — not a
 *                subset: a missing `$PINS` is as much a defect as an extra one.
 * @param allowed when given, every line must be one of these (used for the
 *                whole-session check, where the identify step repeats `$$`).
 */
export function checkWire(
  writes: readonly WireWrite[],
  opts: { exact?: readonly string[]; allowed?: readonly string[] },
): WireVerdict {
  const { items, unterminated } = splitWire(writes);
  const lines = items.filter((i): i is Extract<WireItem, { kind: 'line' }> => i.kind === 'line').map((i) => i.text);
  const realtime = items.filter((i): i is Extract<WireItem, { kind: 'realtime' }> => i.kind === 'realtime').map((i) => i.byte);
  const violations: string[] = [];

  for (const l of lines) {
    const why = forbiddenReason(l);
    if (why) violations.push(`FORBIDDEN ${why}: ${JSON.stringify(l)}`);
    else if (opts.allowed && !opts.allowed.includes(l)) violations.push(`UNLISTED LINE: ${JSON.stringify(l)}`);
  }
  for (const b of realtime) {
    if (!ALLOWED_REALTIME.has(b)) violations.push(`FORBIDDEN REALTIME BYTE 0x${b.toString(16).padStart(2, '0')}`);
  }
  if (unterminated !== null) violations.push(`UNTERMINATED BYTES on the wire: ${JSON.stringify(unterminated)}`);
  if (opts.exact) {
    const same = lines.length === opts.exact.length && lines.every((l, i) => l === opts.exact![i]);
    if (!same) violations.push(`LINES ${JSON.stringify(lines)} != EXPECTED ${JSON.stringify(opts.exact)}`);
  }
  return { ok: violations.length === 0, lines, realtime, violations };
}

/** One human-readable line for the run log. */
export function describeVerdict(label: string, v: WireVerdict): string {
  const rt = v.realtime.map((b) => '0x' + b.toString(16)).join(',');
  return (
    `WIRE ${label}: VERDICT=${v.ok ? 'PASS' : 'FAIL'} lines=${JSON.stringify(v.lines)} realtime=[${rt}]` +
    (v.violations.length ? ` violations=${JSON.stringify(v.violations)}` : '')
  );
}
