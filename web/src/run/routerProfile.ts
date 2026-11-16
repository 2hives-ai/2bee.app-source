// The router, as the controller describes it, and the measurements a human
// still has to take.
//
// Founder 2026-10-14: *"I attach the cnc router, it will analize, show the router
// in a page and I will do the remaining measurements test been adviced on the
// page"* · *"if measurement needed the system will show what needs to be
// measured and how"* · *"show it in an image"*.
//
// 🔴 READ-ONLY. The analysis sends only report commands (`$I`, `$$`, `$#`,
// `$PINS`). It NEVER writes a setting. Where a measurement says a setting is
// wrong, the page shows the value a human would type and leaves the typing to
// them. A tab that silently reconfigured a machine someone else set up would be
// the failure `RunTab.tsx` § useSerialConnection rule 4 already refuses.
//
// 🔴 THE MEASUREMENT STEPS MOVE THE MACHINE, AND THIS FILE DOES NOT. Each one is
// an instruction to the operator standing at the machine. The page reads the
// controller's reports while they do it (position, pins) and does arithmetic on
// what they type in. Nothing here sends a motion command.
//
// ⚠ NEVER RUN AGAINST OUR ROUTER. The only board that has ever answered this app
// was a bare bench rig on 2026-08-20 (no motors). Formats here come from the
// grblHAL source; the first real readout must be compared by eye with what `pcb`
// configured.

/** The read-only commands the analysis sends, in order. */
export const ANALYSE_COMMANDS: readonly string[] = ['$I', '$$', '$#', '$PINS'];

export type Axis = 'X' | 'Y' | 'Z';
export const AXES: readonly Axis[] = ['X', 'Y', 'Z'];
const AXIS_INDEX: Record<Axis, number> = { X: 0, Y: 1, Z: 2 };

/** Setting numbers, from grblHAL `settings.h`. */
export const SETTING = {
  stepsPerMm: { X: 100, Y: 101, Z: 102 },
  maxRate: { X: 110, Y: 111, Z: 112 },
  accel: { X: 120, Y: 121, Z: 122 },
  maxTravel: { X: 130, Y: 131, Z: 132 },
  spindleMax: 30,
  spindleMin: 31,
  softLimits: 20,
  hardLimits: 21,
  homing: 22,
} as const;

export interface RawAnalysis {
  /** `$N=V` lines, by setting number, value text as sent. */
  settings: Map<number, string>;
  /** `[VER:…]` text, or null. */
  version: string | null;
  /** `[OPT:…]` text, or null. */
  options: string | null;
  /** `[G54:x,y,z]` etc, by name. */
  offsets: Map<string, number[]>;
  /** Tool length offset from `[TLO:…]`, or null. */
  tlo: number | null;
  /** `[PRB:x,y,z:ok]`, or null. */
  probe: { at: number[]; ok: boolean } | null;
  /** Lines from `$PINS`, as sent. */
  pins: string[];
  /** `[NEWOPT:…]` tokens, e.g. `NOPROBE`, `PROBES=1`, `HOME`. */
  newopt: string[] | null;
}

export function emptyAnalysis(): RawAnalysis {
  return { settings: new Map(), version: null, options: null, offsets: new Map(), tlo: null, probe: null, pins: [], newopt: null };
}

const nums = (s: string) => s.split(',').map((v) => Number(v.trim()));

/**
 * Fold one controller line into the analysis. Lines that are not part of an
 * analysis reply are ignored, so this can be fed the whole console.
 */
export function readLine(a: RawAnalysis, raw: string): RawAnalysis {
  const line = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+)=(.*)$/.exec(line))) {
    a.settings.set(Number(m[1]), m[2].trim());
  } else if ((m = /^\[VER:(.*)\]$/.exec(line))) {
    a.version = m[1];
  } else if ((m = /^\[OPT:(.*)\]$/.exec(line))) {
    a.options = m[1];
  } else if ((m = /^\[NEWOPT:(.*)\]$/.exec(line))) {
    /* Probe presence is reported HERE, not in OPT (report.c:996-1003). */
    a.newopt = m[1].split(',').map((t) => t.trim());
  } else if ((m = /^\[TLO:(.*)\]$/.exec(line))) {
    /* grblHAL prints ALL axes here (TOOL_LENGTH_OFFSET_AXIS -1, config.h:289,
     * report.c:543-546). The tool length is the Z component. */
    const v = nums(m[1])[AXIS_INDEX.Z];
    a.tlo = Number.isFinite(v) ? v : null;
  } else if ((m = /^\[PRB:([^:\]]*):(\d)\]$/.exec(line))) {
    a.probe = { at: nums(m[1]), ok: m[2] === '1' };
  } else if ((m = /^\[(G5[4-9](?:\.\d)?|G28|G30|G92):([^\]]*)\]$/.exec(line))) {
    a.offsets.set(m[1], nums(m[2]));
  } else if ((m = /^\[PIN:(.*)\]$/.exec(line))) {
    a.pins.push(m[1]);
  }
  return a;
}

export function analyse(lines: readonly string[]): RawAnalysis {
  const a = emptyAnalysis();
  for (const l of lines) readLine(a, l);
  return a;
}

export type Flag = { level: 'stop' | 'check'; text: string };

export interface RouterProfile {
  firmware: string | null;
  stepsPerMm: Record<Axis, number | null>;
  /** mm/min. */
  maxRate: Record<Axis, number | null>;
  /** Units as the firmware states them; grblHAL documents mm/sec². */
  accel: Record<Axis, number | null>;
  /** Configured travel, mm. NOT measured. */
  travel: Record<Axis, number | null>;
  spindleRpm: { min: number | null; max: number | null };
  softLimits: boolean | null;
  hardLimits: boolean | null;
  homing: boolean | null;
  /** True when `$PINS` names a probe input. Null before `$PINS` was read. */
  probeWired: boolean | null;
  flags: Flag[];
}

const num = (a: RawAnalysis, n: number): number | null => {
  const s = a.settings.get(n);
  if (s === undefined) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const bit0 = (a: RawAnalysis, n: number): boolean | null => {
  const v = num(a, n);
  return v === null ? null : (v & 1) === 1;
};
const perAxis = (a: RawAnalysis, map: Record<Axis, number>) =>
  ({ X: num(a, map.X), Y: num(a, map.Y), Z: num(a, map.Z) }) as Record<Axis, number | null>;

export function profileOf(a: RawAnalysis): RouterProfile {
  const p: RouterProfile = {
    firmware: a.version,
    stepsPerMm: perAxis(a, SETTING.stepsPerMm),
    maxRate: perAxis(a, SETTING.maxRate),
    accel: perAxis(a, SETTING.accel),
    travel: perAxis(a, SETTING.maxTravel),
    spindleRpm: { min: num(a, SETTING.spindleMin), max: num(a, SETTING.spindleMax) },
    softLimits: bit0(a, SETTING.softLimits),
    hardLimits: bit0(a, SETTING.hardLimits),
    homing: bit0(a, SETTING.homing),
    /* `$PINS` lists CONFIGURED pins (`[PIN:PA1,Probe]`), not what is plugged
     * in; `NOPROBE` in `[NEWOPT:…]` is the firmware saying there is none. The
     * live switch test is what proves a probe is actually connected. */
    probeWired: a.newopt?.includes('NOPROBE')
      ? false
      : a.pins.length
        ? a.pins.some((l) => /,\s*probe\b/i.test(l))
        : null,
    flags: [],
  };
  if (a.settings.size === 0) {
    p.flags.push({ level: 'stop', text: 'No settings were read. Connect and identify the router first.' });
    return p;
  }
  if (p.homing === false) {
    p.flags.push({ level: 'stop', text: 'Homing is off ($22). Without it the machine does not know where it is, and the travel numbers mean nothing.' });
  }
  if (p.softLimits === false) {
    p.flags.push({ level: 'check', text: 'Soft limits are off ($20). The controller will not stop a move that runs past the travel.' });
  }
  if (p.hardLimits === false) {
    p.flags.push({ level: 'check', text: 'Hard limits are off ($21). A limit switch hit during a move will not stop it.' });
  }
  for (const ax of AXES) {
    if (p.travel[ax] === null) p.flags.push({ level: 'check', text: `Travel for ${ax} ($${SETTING.maxTravel[ax]}) was not reported.` });
    else if (p.travel[ax]! <= 0) p.flags.push({ level: 'stop', text: `Travel for ${ax} is ${p.travel[ax]} mm, which is not a real machine.` });
  }
  /* Firmware defaults (config.h:2253-2389): 250 steps/mm, 200 mm travel on
   * every axis. A board still carrying them was never configured for THIS
   * machine, and every distance it moves is a guess. */
  if (AXES.every((ax) => p.stepsPerMm[ax] === 250)) {
    p.flags.push({ level: 'stop', text: 'Steps per mm are the firmware default (250) on every axis. The board was never set up for this machine.' });
  }
  if (AXES.every((ax) => p.travel[ax] === 200)) {
    p.flags.push({ level: 'check', text: 'Travel is the firmware default (200 mm) on every axis. It has not been set for this machine.' });
  }
  if (p.spindleRpm.max === null) {
    p.flags.push({ level: 'check', text: 'No spindle speed range was reported ($30). grblHAL lists it only for a variable-speed spindle.' });
  }
  if (p.probeWired === false) {
    p.flags.push({ level: 'check', text: 'No probe input is listed by $PINS. Z zero must be set by hand.' });
  }
  return p;
}

// ── The measurements ────────────────────────────────────────────────────────

export type Diagram = 'switches' | 'homing' | 'travel' | 'steps' | 'spoilboard' | 'collet' | 'spindle';

export interface MeasureInput {
  key: string;
  label: string;
  unit: string;
}

export interface Measurement {
  id: string;
  title: string;
  /** What is measured, one sentence. */
  what: string;
  /** How, as numbered steps for the person at the machine. */
  how: string[];
  /** True when the operator has to move the machine. */
  moves: boolean;
  diagram: Diagram;
  inputs: MeasureInput[];
}

export type Verdict = { status: 'ok' | 'adjust' | 'stop' | 'pending'; text: string };

const STEP_TEST_MM = 100;

/** Which measurements this router needs, given what it reported. */
export function measurementsFor(p: RouterProfile): Measurement[] {
  const out: Measurement[] = [
    {
      id: 'switches',
      title: 'Limit switches and probe',
      what: 'That each limit switch and the probe are wired to the input the controller expects.',
      how: [
        'Leave the machine still. Do not jog.',
        'Press each limit switch by hand, one at a time, and watch its letter light on this page.',
        p.probeWired === false ? 'No probe is listed, so skip the probe.' : 'Touch the probe plate to the cutter (or press the probe) and watch P light.',
      ],
      moves: false,
      diagram: 'switches',
      inputs: [],
    },
  ];
  if (p.homing !== false) {
    out.push({
      id: 'homing',
      title: 'Homing',
      what: 'That the machine finds its home switches and stops there.',
      how: ['Clear the work area. Stand at the machine, hand near the stop button.', 'Send $H from the console.', 'Watch every axis move to its switch and stop. The page shows "homed" when the controller says so.'],
      moves: true,
      diagram: 'homing',
      inputs: [],
    });
  }
  out.push({
    id: 'travel',
    title: 'Real travel',
    what: 'How far each axis really goes, compared with the travel the controller is set to.',
    how: [
      'Home first.',
      'Jog slowly to the far end of X, stop just before the frame, and press "Use position" for X.',
      'Do the same for Y, and for Z downwards to just above the spoilboard.',
    ],
    moves: true,
    diagram: 'travel',
    inputs: AXES.map((ax) => ({ key: `travel${ax}`, label: `${ax} reached`, unit: 'mm' })),
  });
  for (const ax of AXES) {
    out.push({
      id: `steps${ax}`,
      title: `Distance check, ${ax}`,
      what: `That a ${STEP_TEST_MM} mm move on ${ax} really moves ${STEP_TEST_MM} mm. If not, $${SETTING.stepsPerMm[ax]} (steps per mm) is wrong and every part comes out the wrong size.`,
      how: [
        `Put a mark (tape) on the frame next to the ${ax} carriage and line up a steel rule with it.`,
        `Jog ${ax} exactly ${STEP_TEST_MM}.000 mm (the page shows the controller's position).`,
        'Read how far the carriage really moved against the rule, to 0.1 mm, and type it in.',
      ],
      moves: true,
      diagram: 'steps',
      inputs: [{ key: `moved${ax}`, label: `${ax} really moved`, unit: 'mm' }],
    });
  }
  out.push(
    {
      id: 'spoilboard',
      title: 'Spoilboard thickness and flatness',
      what: 'How thick the spoilboard is at each corner. Uneven corners mean cuts that are deeper on one side.',
      how: ['Use calipers at the four corners, about 20 mm in from the edge.', 'Type the four readings.'],
      moves: false,
      diagram: 'spoilboard',
      inputs: ['front left', 'front right', 'back right', 'back left'].map((c, i) => ({ key: `board${i}`, label: c, unit: 'mm' })),
    },
    {
      id: 'collet',
      title: 'Collet size',
      what: 'Which collet is in the spindle, so only cutters with that shank are offered.',
      how: ['Read the size engraved on the collet (for example "ER20 6 mm"). Type the shank size.'],
      moves: false,
      diagram: 'collet',
      inputs: [{ key: 'collet', label: 'Collet shank', unit: 'mm' }],
    },
  );
  if (p.spindleRpm.max !== null) {
    out.push({
      id: 'spindle',
      title: 'Spindle speed',
      what: `That the spindle really turns at the speed asked for (the controller allows up to ${p.spindleRpm.max} rpm).`,
      how: [
        'No cutter in the collet. Guards on.',
        'Send M3 S12000 from the console. Measure with a tachometer on reflective tape on the nut.',
        'Type the reading, then send M5.',
      ],
      moves: true,
      diagram: 'spindle',
      inputs: [{ key: 'rpm', label: 'Measured at S12000', unit: 'rpm' }],
    });
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** What a measurement means. Pure: arithmetic on the profile and the inputs. */
export function verdictFor(m: Measurement, p: RouterProfile, inputs: Record<string, number | undefined>, seenPins = ''): Verdict {
  if (m.id === 'switches') {
    const want = ['X', 'Y', 'Z', ...(p.probeWired === false ? [] : ['P'])];
    const missing = want.filter((c) => !seenPins.includes(c));
    return missing.length
      ? { status: 'pending', text: `Not seen yet: ${missing.join(', ')}.` }
      : { status: 'ok', text: 'Every switch was seen.' };
  }
  if (m.id === 'homing') return { status: 'pending', text: 'Shown live while you home.' };
  if (m.id === 'travel') {
    const parts: string[] = [];
    let worst: Verdict['status'] = 'ok';
    for (const ax of AXES) {
      const got = inputs[`travel${ax}`];
      const set = p.travel[ax];
      if (got === undefined) return { status: 'pending', text: 'Enter all three axes.' };
      const reach = Math.abs(got);
      if (set === null) {
        parts.push(`${ax}: reached ${r1(reach)} mm; no travel setting to compare.`);
        worst = 'adjust';
      } else if (reach > set + 1) {
        parts.push(`${ax}: reached ${r1(reach)} mm but $${SETTING.maxTravel[ax]} is ${set}. Soft limits would stop short; set it to about ${Math.floor(reach)}.`);
        worst = 'adjust';
      } else if (reach < set - 1) {
        parts.push(`${ax}: reached only ${r1(reach)} mm but $${SETTING.maxTravel[ax]} is ${set}. The machine would be allowed past what it can do; set it to ${Math.floor(reach)} or less.`);
        worst = 'stop';
      } else parts.push(`${ax}: ${r1(reach)} mm, matches.`);
    }
    return { status: worst, text: parts.join(' ') };
  }
  if (m.id.startsWith('steps')) {
    const ax = m.id.slice(5) as Axis;
    const moved = inputs[`moved${ax}`];
    const cur = p.stepsPerMm[ax];
    if (moved === undefined || moved <= 0) return { status: 'pending', text: 'Enter how far it really moved.' };
    const err = (moved - STEP_TEST_MM) / STEP_TEST_MM;
    if (Math.abs(err) <= 0.002) return { status: 'ok', text: `${moved} mm for ${STEP_TEST_MM} mm, within 0.2%.` };
    const fix = cur === null ? 'the steps-per-mm setting was not read' : `$${SETTING.stepsPerMm[ax]}=${(cur * STEP_TEST_MM / moved).toFixed(3)} (now ${cur})`;
    return { status: 'adjust', text: `${moved} mm for ${STEP_TEST_MM} mm is ${(err * 100).toFixed(1)}% off. Correct value: ${fix}. Type it in the console yourself, then repeat this check.` };
  }
  if (m.id === 'spoilboard') {
    const v = [0, 1, 2, 3].map((i) => inputs[`board${i}`]);
    if (v.some((x) => x === undefined || x <= 0)) return { status: 'pending', text: 'Enter all four corners.' };
    const xs = v as number[];
    const spread = Math.max(...xs) - Math.min(...xs);
    const mean = xs.reduce((s, x) => s + x, 0) / 4;
    return spread <= 0.2
      ? { status: 'ok', text: `${r1(mean)} mm thick, corners within ${spread.toFixed(2)} mm.` }
      : { status: 'adjust', text: `Corners differ by ${spread.toFixed(2)} mm. Surface the spoilboard (flatten it with a large cutter) before cutting parts.` };
  }
  if (m.id === 'collet') {
    const c = inputs.collet;
    return c === undefined || c <= 0 ? { status: 'pending', text: 'Enter the collet size.' } : { status: 'ok', text: `Only ${c} mm shank cutters will be offered.` };
  }
  if (m.id === 'spindle') {
    const rpm = inputs.rpm;
    if (rpm === undefined || rpm <= 0) return { status: 'pending', text: 'Enter the measured speed.' };
    const err = (rpm - 12000) / 12000;
    return Math.abs(err) <= 0.05
      ? { status: 'ok', text: `${rpm} rpm, within 5% of 12000.` }
      : { status: 'adjust', text: `${rpm} rpm is ${(err * 100).toFixed(0)}% off 12000. Feeds will be wrong by the same amount until the spindle range ($30/$31 or the VFD) is corrected.` };
  }
  return { status: 'pending', text: '' };
}

/** Letters of the `Pn:` field, for the live switch check. */
export function pinsSeen(prev: string, pn: string | null): string {
  if (!pn) return prev;
  return [...new Set((prev + pn).split(''))].sort().join('');
}

export { AXIS_INDEX };
