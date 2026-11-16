/**
 * Gates for an upload on the 2bee.3d tab (founder 2026-10-16: "create similar
 * navbar on pnp and 3d) add the gates there"). The same contract as
 * cnc/runGates.ts:
 *
 * THREE STATES, NEVER TWO. PASS = checked and holds. FAIL = checked and does
 * not. PENDING = could not be checked yet (still slicing, printer not asked
 * yet). PENDING is NOT a pass: the Upload button needs `mayRun`, every gate PASS.
 *
 * DIRECTION OF ERROR: over-block. A false FAIL costs a click; a false PASS puts
 * a file on the X2D that prints on a dirty plate, with the wrong filament, or
 * off the bed. Every unrecognised input lands on FAIL or PENDING, never PASS —
 * with ONE stated exception: a slicer warning this module does not recognise is
 * listed and does not fail the slice gate (founder brief 2026-10-16: "warnings
 * listed but PASS-with-note unless they say the print fails"). `PRINT_FAILS`
 * is the list of words that make a warning a FAIL; it starts from the words
 * the slicer bridge itself rejects a packing on (tools/print3d-bridge/engine.cjs).
 *
 * The gates cover THE PLATE THE UPLOAD SENDS (the one on screen) for slicing,
 * filament and checklist, and EVERY part for fit, because a part that fits on no
 * plate is a part that will not be printed.
 *
 * 🔴 A SLICE IS NOT EVIDENCE BY ITSELF (2026-10-16, the switch to 2bee.fdm). G-code
 * coming back proves the engine ran, not that it prints: the slice gate also needs
 * a layer count from the file, and gate ENGINE stays FAIL for an engine that has
 * never printed until a PERSON ticks "this is a calibration print" on the
 * printer card. Nothing in the app or the AI can tick it.
 *
 * Passing every gate opens the upload. Starting it is a separate step on the
 * printer card (founder 2026-10-20, "add remote start"). Start needs its own
 * "I am at the printer" tick, and the bridge re-reads the printer's state and
 * AMS slots before it sends the command.
 */

export type PrintGateState = 'PASS' | 'FAIL' | 'PENDING';

export interface PrintGate {
  id: 'parts' | 'sliced' | 'engine' | 'fit' | 'filament' | 'bridge' | 'code' | 'checklist';
  name: string;
  /** The physical failure it guards. */
  guards: string;
  state: PrintGateState;
  why: string;
  /** True when only a PERSON can clear it (never set by the app). */
  person?: boolean;
}

/** Words that make a slicer/bridge warning mean "this print fails". */
export const PRINT_FAILS = /printable|outside|beyond the plate|collision|conflict|clearance|prime tower|cannot|fail|not support|exceed/i;

export interface PrintGateInput {
  /** Number of parts (copies) in the job. */
  parts: number;
  /** The plate the upload would send, or null when there is none. */
  plate: number | null;
  /** That plate's slice: 'current' with its warnings, or why not. */
  slice:
    | {
        status: 'current';
        warnings: string[];
        slotChecks: { slot: string; slotType: string; preset: string; presetType: string; ok: boolean }[];
        bedType: string | null;
        bedRequested: string | null;
        /** The layer count the G-code states. null/0 = the file says nothing: not a pass. */
        layers: number | null;
      }
    | { status: 'failed'; error: string }
    | { status: 'slicing' | 'stale' | 'waiting'; detail: string };
  /** Parts no plate holds: the arranger's tooBig list, plus any part left with no plate. */
  tooBig: { name: string; reason: string }[];
  unplaced: number;
  /** Arranging failed (bridge error), if it did. */
  arrangeError: string | null;
  /** Every part's slot id, and the declared slots. null = slots not loaded from the bridge. */
  partSlots: string[];
  slots: { id: string; label: string; type: string }[] | null;
  /** The slots the printer itself reports (printer bridge `/v1/status`), or null when it was not read. */
  reported?: { id: string; type: string }[] | null;
  /** The printer bridge: not set up, not asked yet, answered, or failed. */
  printer: { kind: 'unset' } | { kind: 'checking' } | { kind: 'done'; reachable: boolean; haveCode: boolean; printer: string } | { kind: 'failed'; why: string };
  /** Every checklist line ticked for THIS plate, by a person. */
  checklistTicked: boolean;
  /** The engine that sliced the plate on screen (from the slice reply) and whether it has printed (from the bridge).
   *  null = the reply did not name one. */
  engine: { name: string; printed: boolean } | null;
  /** A PERSON ticked "first print from this engine: a calibration print, I stay for the first layer" for this plate. */
  calibrationAck: boolean;
}

const first = (s: string) => s.split('\n')[0].slice(0, 160);

export function printGates(i: PrintGateInput): PrintGate[] {
  const g: PrintGate[] = [];

  g.push({
    id: 'parts',
    name: 'Parts are loaded',
    guards: 'an empty or half-uploaded job sent to the printer',
    ...(i.parts > 0 ? { state: 'PASS' as const, why: `${i.parts} part(s).` } : { state: 'FAIL' as const, why: 'No part in the job. Drop an STL on the left.' }),
  });

  // G-SLICED (the plate on screen)
  const s = i.slice;
  const failing = s.status === 'current' ? s.warnings.filter((w) => PRINT_FAILS.test(w)) : [];
  const bedMismatch = s.status === 'current' && s.bedType && s.bedRequested && s.bedType !== s.bedRequested;
  g.push({
    id: 'sliced',
    name: i.plate ? `Plate ${i.plate} sliced with no error` : 'The plate is sliced with no error',
    guards: 'G-code the slicer flagged as unprintable (outside the plate, collisions), or a file with no layers, reaching the printer',
    ...(i.plate === null
      ? { state: 'PENDING' as const, why: 'No plate yet.' }
      : s.status === 'failed'
        ? { state: 'FAIL' as const, why: `The slicer failed: ${first(s.error)}` }
        : s.status !== 'current'
          ? { state: 'PENDING' as const, why: s.detail || 'Not sliced yet.' }
          : !s.layers || !(s.layers > 0)
            ? { state: 'FAIL' as const, why: 'The G-code came back without a layer count: it is not treated as a slice.' }
          : failing.length
            ? { state: 'FAIL' as const, why: `The slicer says: ${first(failing[0])}${failing.length > 1 ? ` (+${failing.length - 1} more)` : ''}` }
            : bedMismatch
              ? { state: 'FAIL' as const, why: `The G-code is for "${s.bedType}", not the "${s.bedRequested}" asked for. Slice again.` }
              : s.warnings.length
                ? { state: 'PASS' as const, why: `Sliced. Note (${s.warnings.length}): ${first(s.warnings[0])}` }
                : { state: 'PASS' as const, why: 'Sliced, no warnings.' }),
  });

  // G-ENGINE — a person, never the app: an engine that has never printed makes calibration prints only.
  g.push({
    id: 'engine',
    name: 'The slicing engine has printed on this printer',
    guards: 'G-code from an engine that has never produced a print being trusted like a proven one: wrong temperature, flow or first layer on the real printer',
    ...(s.status !== 'current' || i.plate === null
      ? { state: 'PENDING' as const, why: 'Known when the plate is sliced.' }
      : !i.engine
        ? { state: 'FAIL' as const, why: 'The slice does not say which engine made it. Restart the slicer bridge and slice again.' }
        : i.engine.printed
          ? { state: 'PASS' as const, why: `Sliced by ${i.engine.name}.` }
          : i.calibrationAck
            ? { state: 'PASS' as const, why: `Sliced by ${i.engine.name}, which has not printed yet: you marked this as a calibration print.` }
            : {
                state: 'FAIL' as const,
                why: `Sliced by ${i.engine.name}, which has not printed yet. The first print is a calibration print: stay at the printer for the first layer, then tick that line on the printer card.`,
                person: true,
              }),
  });

  // G-FIT (every part)
  g.push({
    id: 'fit',
    name: 'Every part fits on a plate',
    guards: 'a part left off the print, or printed hanging over the plate edge',
    ...(i.parts === 0
      ? { state: 'PENDING' as const, why: 'No parts.' }
      : i.arrangeError
        ? { state: 'FAIL' as const, why: i.arrangeError }
        : i.tooBig.length
          ? { state: 'FAIL' as const, why: `${i.tooBig[0].name}: ${i.tooBig[0].reason}${i.tooBig.length > 1 ? ` (+${i.tooBig.length - 1} more)` : ''}. Scale it down or remove it.` }
          : i.unplaced
            ? { state: 'PENDING' as const, why: `${i.unplaced} part(s) not arranged yet.` }
            : { state: 'PASS' as const, why: 'All parts are on a plate.' }),
  });

  // G-FILAMENT (every part's slot declared non-empty; the plate's slot/preset types agree)
  const declared = new Map((i.slots ?? []).map((x) => [x.id, x]));
  const undeclared = [...new Set(i.partSlots.filter((id) => !declared.get(id)?.type))];
  const mismatch = s.status === 'current' ? s.slotChecks.filter((c) => !c.ok) : [];
  // What the app holds against what the printer says is loaded. The app syncs the slots from the report, so this
  // stays red only while a sync is pending or failed, or the printer holds a type the slicer does not know.
  const rep = new Map((i.reported ?? []).map((x) => [x.id, x.type]));
  const disagree = [...new Set(i.partSlots)].filter((id) => rep.has(id) && rep.get(id) !== (declared.get(id)?.type ?? ''));
  const fromPrinter = !!i.reported && i.partSlots.every((id) => rep.has(id));
  g.push({
    id: 'filament',
    name: 'Every part has a filament, and its slot is loaded',
    guards: 'a part printed from an empty AMS slot, or at the temperature of a different filament',
    ...(i.slots === null
      ? { state: 'PENDING' as const, why: 'The filament slots have not loaded from the slicer bridge.' }
      : i.partSlots.length === 0
        ? { state: 'PENDING' as const, why: 'No parts.' }
        : disagree.length
          ? {
              state: 'FAIL' as const,
              why: disagree
                .map((id) => `The printer reports ${rep.get(id) || 'nothing'} in ${declared.get(id)?.label ?? id}, the app holds ${declared.get(id)?.type || 'nothing'}`)
                .join('; ') + '. Press Check again on the printer card; a type the slicer does not know stays refused.',
            }
          : undeclared.length
          ? { state: 'FAIL' as const, why: `No filament in ${undeclared.map((id) => declared.get(id)?.label ?? id).join(', ')}${fromPrinter ? ' (read from the printer): load a spool there' : ''}.` }
          : mismatch.length
            ? { state: 'FAIL' as const, why: `Slot ${mismatch[0].slot} holds ${mismatch[0].slotType} but its preset "${mismatch[0].preset}" is ${mismatch[0].presetType}.` }
            : { state: 'PASS' as const, why: `${[...new Set(i.partSlots)].map((id) => `${declared.get(id)!.label}: ${declared.get(id)!.type}`).join(' · ')} (${fromPrinter ? 'read from the printer' : 'declared by you; the printer is not asked'}).` }),
  });

  // G-BRIDGE
  const p = i.printer;
  g.push({
    id: 'bridge',
    name: 'The printer answers',
    guards: 'an upload to a printer that is off or not on this network',
    ...(p.kind === 'unset'
      ? { state: 'FAIL' as const, why: 'The printer bridge is not set up (Connections).' }
      : p.kind === 'checking'
        ? { state: 'PENDING' as const, why: 'Asking the printer bridge…' }
        : p.kind === 'failed'
          ? { state: 'FAIL' as const, why: `The printer bridge did not answer: ${first(p.why)}` }
          : p.reachable
            ? { state: 'PASS' as const, why: `${p.printer} answers on the network (a TCP connect; its state is not read).` }
            : { state: 'FAIL' as const, why: `${p.printer || 'The X2D'} does not answer on the network. Is it on?` }),
  });

  // G-CODE — the access code is the person's to give; the app never holds it.
  g.push({
    id: 'code',
    name: 'The printer bridge has the X2D access code',
    guards: 'a job that looks ready and is refused at upload (the bridge answers 409 without a code)',
    ...(p.kind === 'done'
      ? p.haveCode
        ? { state: 'PASS' as const, why: 'The bridge holds an access code.' }
        : { state: 'FAIL' as const, why: 'Give the X2D access code: restart the printer bridge with --code-file PATH (or X2D_ACCESS_CODE). The app never holds the code.', person: true }
      : p.kind === 'checking'
        ? { state: 'PENDING' as const, why: 'Asking the printer bridge…' }
        : { state: 'PENDING' as const, why: 'Known once the printer bridge answers.' }),
  });

  // G-CHECKLIST — a person at the printer.
  g.push({
    id: 'checklist',
    name: 'Build plate clean, filament loaded: checklist ticked',
    guards: 'a print on a dirty or missing plate, or from the wrong spool',
    ...(s.status !== 'current' || i.plate === null
      ? { state: 'PENDING' as const, why: 'The checklist opens when the plate is sliced.' }
      : i.checklistTicked
        ? { state: 'PASS' as const, why: 'Ticked by you for this plate.' }
        : { state: 'FAIL' as const, why: 'At the printer: clear the plate, check each slot, then tick the checklist on the printer card.', person: true }),
  });

  return g;
}

/** Upload is allowed only when EVERY gate is PASS. PENDING is not a pass. */
export function mayUpload(gates: readonly { state: PrintGateState }[]): boolean {
  return gates.length > 0 && gates.every((x) => x.state === 'PASS');
}

/** For "Fix with AI": parts on undeclared slots → a declared slot. `pick` may name
 *  one (the AI's choice); anything it names that is not declared non-empty is
 *  ignored and the first declared slot is used. null = no slot is declared at all
 *  (a person has to load and declare one). */
export function assignSlots(partSlots: readonly string[], slots: readonly { id: string; type: string }[], pick?: string | null): string[] | null {
  const ok = slots.filter((s) => s.type);
  if (!ok.length) return null;
  const to = ok.find((s) => s.id === pick)?.id ?? ok[0].id;
  return partSlots.map((id) => (ok.some((s) => s.id === id) ? id : to));
}
