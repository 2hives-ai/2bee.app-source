// Whether the printer card may offer Start, as a pure function (gate START-STALE).
//
// 🔴 THE FAILURE IT GUARDS (reviewer P0, 2026-11-12): a plate was uploaded, then
// changed (a part moved to another AMS slot) and re-sliced. Start stayed on and
// sent the OLD file with the NEW slice's AMS mapping and types, past the upload
// checklist and gates: a PLA program heating to PLA temperatures on PETG, or an
// earlier program printing while the stats and the Sliced view showed the new one.
//
// So an upload is tied to the slice it came from by a key (slice id + everything
// on the plate that the file depends on), and it carries the AMS mapping and
// types it was made for. Start is allowed only while the current up-to-date
// slice has the same key, and it sends the mapping and types of the UPLOAD,
// never of whatever is sliced now. The printer bridge re-checks both against the
// file it built (defence in depth): this function is the page half.

export interface UploadRecord {
  /** plateKey() of the slice the file was made from. */
  key: string;
  /** Slot id per filament, in the file's filament order (filament 1 first). Empty = order unknown. */
  slots: string[];
  /** Tray per filament, same order (null = not an AMS slot or the external spool). */
  amsMapping: (number | null)[];
  /** Filament type per filament, in the same order, as sent with the upload. */
  expectTypes: string[];
}

export interface PlateKeyInput {
  plate: number | null;
  /** The slice id the engine bridge gave this plate, or null when the plate is not sliced up to date. */
  sliceId: string | null;
  buildPlate: string;
  /** What was sliced: objects with their slot and placement, filaments with slot, type and preset. */
  objects: unknown;
  filaments: unknown;
  /** Slot id per filament in G-code order (the source of amsMapping). */
  filamentSlots: string[];
  /** Declared type per filament in the same order (the source of expectTypes). */
  types: string[];
  /** Process, overrides, presets: anything else the slice was made with. */
  settings: unknown;
}

/** A stable string for one plate as sliced now. null when there is no up-to-date slice: nothing can match it. */
export function plateKey(x: PlateKeyInput): string | null {
  if (!x.sliceId || !x.plate) return null;
  return JSON.stringify([x.plate, x.sliceId, x.buildPlate, x.objects, x.filaments, x.filamentSlots, x.types, x.settings]);
}

export interface StartInput {
  up: UploadRecord | null;
  plateReady: boolean;
  /** plateKey() of the plate as it is now. */
  currentKey: string | null;
  haveSerial: boolean;
  /** The printer's own state from its last status read, or null when not read. */
  printerState: string | null;
}

const ACTIVE = ['PREPARE', 'RUNNING', 'PAUSE', 'SLICING'];

/** Why Start stays off, in plain words, or '' when it may be offered. The upload record is the ONLY source of what Start sends. */
export function startBlock(s: StartInput): string {
  if (!s.up) return 'nothing has been uploaded for this plate';
  if (!s.haveSerial) return 'the printer bridge was started without --serial, so it cannot talk to the printer’s command channel';
  if (!s.plateReady || !s.currentKey) return 'the plate is not sliced up to date: wait for the slice, then upload again';
  if (s.up.key !== s.currentKey) return 'the plate changed since upload: upload again';
  if (!s.up.slots.length || s.up.amsMapping.length !== s.up.slots.length || s.up.expectTypes.length !== s.up.slots.length) return 'filament order unknown: slice the plate again';
  const bad = s.up.amsMapping.findIndex((n) => n === null || !Number.isInteger(n));
  if (bad >= 0) return `slot ${s.up.slots[bad]} is not an AMS slot or the external spool`;
  if (s.up.expectTypes.some((t) => !t)) return 'a filament this plate uses has no declared type in its slot';
  if (s.printerState && ACTIVE.includes(s.printerState)) return `the printer is busy (${s.printerState})`;
  return '';
}

/** The /v1/start body, built from the upload record alone. Throws when Start is not allowed, so a caller cannot skip startBlock(). */
export function startBody(s: StartInput, remote: string, md5: string | undefined, bedType: string) {
  const why = startBlock(s);
  if (why) throw new Error(`Start refused: ${why}`);
  const up = s.up!;
  return { remote, md5, amsMapping: up.amsMapping.map((n) => n as number), expectTypes: [...up.expectTypes], bedType, confirm: 'at-printer' as const };
}
