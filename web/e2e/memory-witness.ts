/**
 * WHAT THE BOX LOOKED LIKE WHILE THIS SUITE RAN — TODO #168.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 WHY A RUN HAS TO CARRY ITS OWN MEMORY CONTEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Between 2026-09-13 and 2026-09-17 this suite never completed: the runner was
 * relaunched before reaching an assertion, three times, and this lane had ZERO
 * browser coverage for four days. On 2026-09-17 it completed — repeatedly —
 * shortly after two lanes killed orphaned processes and freed ~1.8 GB.
 *
 * ⚠ THAT IS A CORRELATION AND IT IS STILL ONLY A CORRELATION, because **nobody
 * measured the box on the failing side.** Not once, over four days, by anyone.
 * The standing action *"capture `/proc/meminfo` in the same minute as the next
 * failure"* was written down three times and never performed — ***a manual step
 * that depends on someone being present at the moment of failure is not a
 * measurement, it is a hope.***
 *
 * So the run records it itself, at start and at end. A future failure then
 * arrives with its own evidence, and a future PASS carries the level it passed
 * at — which is the half everyone forgets: **a pass tells you nothing about
 * headroom unless you know what the headroom was.**
 *
 * ⚠ WHAT THIS IS NOT. It does not detect, diagnose, or explain anything, and it
 * must never be read as having done so. It is two timestamped readings in a log.
 * The mechanism behind #168 remains unestablished, and this file exists so that
 * the NEXT person to look has something the last four days did not produce.
 *
 * ⚠ AND IT MUST NEVER FAIL A RUN. A witness that can red the suite would make
 * the coverage it is trying to explain even scarcer, so every read is wrapped
 * and a failure to measure is reported and swallowed.
 */
import { readFileSync } from 'node:fs';

/** The fields that separate "harness defect" from "capacity fact". */
const WANTED = ['MemTotal', 'MemFree', 'MemAvailable', 'SwapTotal', 'SwapFree', 'Shmem'];

export function memorySnapshot(): string {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const kb = new Map<string, number>();
    for (const line of meminfo.split('\n')) {
      const m = /^(\w+):\s+(\d+) kB/.exec(line);
      if (m && WANTED.includes(m[1])) kb.set(m[1], Number(m[2]));
    }
    if (kb.size === 0) return 'meminfo parsed but matched no expected field — the format changed';
    const gb = (k: string) => {
      const v = kb.get(k);
      return v === undefined ? `${k}=?` : `${k}=${(v / 1024 / 1024).toFixed(2)}G`;
    };
    /* 🔴 `SwapFree` IS THE ONE THAT MATTERS and it is why this is not just
     * `free -m`. With swap exhausted, page cache counted by `MemAvailable` is
     * the only thing left to reclaim and tmpfs cannot go anywhere — so a large
     * `MemAvailable` beside a zero `SwapFree` is not the headroom it looks like.
     * This lane published "50 G available" on 2026-09-17 and had to withdraw it
     * for exactly that reason. */
    return WANTED.map(gb).join(' ');
  } catch (e) {
    return `could not read /proc/meminfo: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export default async function globalSetup(): Promise<void> {
  process.stdout.write(`[mem] suite start  ${memorySnapshot()}\n`);
}
