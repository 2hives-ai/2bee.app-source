// The printer card: pnp's 2bee.3d "Printers" panel, cut down to what this app
// is allowed to do with a printer.
//
// 🔴 REMOTE START, PAUSE, RESUME AND STOP (founder 2026-10-20, at this lane's
// terminal: "add remote start", then "remote pause, remote stop"). This
// SUPERSEDES the 2026-10-14 ruling "Upload only". The card copies one plate's
// G-code onto the X2D through `tools/printer-bridge/`, then offers Start. Start
// needs its own tick, "I am at the printer now", given AFTER the upload: the
// upload checklist ticks reset when the file lands, so the person confirms
// presence at the moment the printer heats, not minutes before. The bridge
// re-reads the printer's state and AMS slot types before it sends the start.
// Pause and Stop are never gated: they are the safe direction. Resume asks a
// confirm. No AMS write.
//
// FILAMENT SLOTS ARE READ FROM THE PRINTER (founder 2026-10-22: a spool was
// changed on the X2D and the app could not follow). Whenever `/v1/status` is
// read, its slot list goes up through onState; Print3dTab stores it with the
// slicer bridge (syncSlots). The status is read every 30 s while idle, so a
// spool change shows within that. A slot the printer reports cannot be edited
// here; only slots it does not report (no --serial, no AMS) are declared by hand.
//
// CAMERA (founder 2026-10-20: "can I see the video stream in 3d?"). A toggle,
// off on every load because the stream costs the printer bandwidth. When on,
// the card asks the bridge for the latest JPEG frame, one request at a time,
// the next ~500 ms after the last finished. It is a view, never a control.
//
// ⚠ TWO DIFFERENT STATUSES. `/v1/check` is a TCP connect to port 990:
// "Reachable" says the X2D answers on the LAN, nothing more. `/v1/status` is
// the printer's own state read over its LAN MQTT, and exists only when the
// bridge was started with --serial (check says haveSerial). Without it the
// card shows no printer state and Start stays off with that reason.

import { useEffect, useRef, useState } from 'react';
import { BridgeError, configured, type BridgeConfig, type Client, type PrinterCheck, type PrinterStart, type PrinterStatus, type PrinterUpload } from './bridges';
import type { ReportedSlot, SlotDecl } from './model';
import { hoursMin } from './model';
import { plateMap } from './plateMap';
import { startBlock, startBody, type UploadRecord } from './startGate';

export interface PrinterCardProps {
  printerBridge: BridgeConfig;
  printer: Client;
  /** The plate the upload would send, or null. */
  plate: number | null;
  /** True when that plate's slice is current. */
  plateReady: boolean;
  /** plateKey() of that plate as sliced now (slice id + objects, placements, slots, settings); null = no up-to-date slice.
   *  An upload is tied to this key: when it changes, the upload is dropped and Start stays off until the plate is uploaded again. */
  sliceKey?: string | null;
  /** Why the plate is not ready, in words. */
  notReady: string;
  buildPlate: string;
  /** The declared slots this plate uses. */
  slotsUsed: SlotDecl[];
  /** Slot id per filament, in the G-code's filament order (filament 1 first). Empty = order unknown: Start stays off. */
  filamentSlots: string[];
  jobName: string;
  /** Fetches the plate's G-code from the engine bridge. */
  getGcode: () => Promise<string>;
  /** Declared slots + build plate (edited here, stored by the engine bridge). */
  slots: SlotDecl[];
  types: string[];
  plates: string[];
  onSaveSlots: (next: { bedPlate: string; slots: SlotDecl[] }) => Promise<void>;
  /** The engine that sliced this plate, and whether it has printed. An engine that has not printed adds the
   *  calibration line below, which only a person ticks (gate ENGINE reads it). null = not known. */
  engine?: { name: string; printed: boolean } | null;
  /** Told the printer check, whether every checklist line is ticked, and whether the calibration line is (the gates read all three). */
  onState?: (s: PrinterCardState) => void;
  /** Set when a gate holds the upload back: the button stays off and this is said. */
  blocked?: string | null;
  /** A new value asks the printer bridge again. */
  recheck?: number;
}

export interface PrinterCardState {
  check: PrinterCheckState;
  ticked: boolean;
  calibrated: boolean;
  /** The slots the printer reported on its last status read, or null when it has not been read. */
  reported: ReportedSlot[] | null;
}

export type PrinterCheckState = { kind: 'unset' } | { kind: 'checking' } | { kind: 'done'; reachable: boolean; haveCode: boolean; printer: string } | { kind: 'failed'; why: string };

type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'done'; r: PrinterCheck } | { kind: 'failed'; why: string };
type Up = { kind: 'idle' } | { kind: 'uploading' } | { kind: 'done'; r: PrinterUpload; plate: number; rec: UploadRecord } | { kind: 'failed'; why: string };
type Act = { kind: 'idle' } | { kind: 'busy'; what: string } | { kind: 'done'; text: string } | { kind: 'failed'; why: string };

/** States in which the printer is working on a job: status is polled, and Pause/Stop apply. */
const ACTIVE = ['PREPARE', 'RUNNING', 'PAUSE', 'SLICING'];

/** AMS tray index the printer's `ams_mapping` wants for a slot id: 'ams1-N' -> N-1, 'ext' -> 254. null = not a slot it knows. */
export function trayIndex(slotId: string): number | null {
  if (slotId === 'ext') return 254;
  const m = /^ams1-([1-4])$/.exec(slotId);
  return m ? Number(m[1]) - 1 : null;
}

/** Plate temperature as the printer reports it (its MQTT field names it `bed`; the operator reads "plate"). */
const plateTemp = (s: PrinterStatus) => {
  const now = s.bed;
  const target = s.bedTarget;
  return `${fmt(now)}/${fmt(target)}`;
};
const fmt = (v: number | null | undefined, unit = '') => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}${unit}` : '–');

export function PrinterCard(p: PrinterCardProps) {
  const ready = configured(p.printerBridge);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  /* The object under the pointer, in the plate picture or the list: the two light up together. */
  const [hotObj, setHotObj] = useState<number | null>(null);
  const [up, setUp] = useState<Up>({ kind: 'idle' });
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<{ bedPlate: string; slots: SlotDecl[] } | null>(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [atPrinter, setAtPrinter] = useState(false);
  const [act, setAct] = useState<Act>({ kind: 'idle' });
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [statusErr, setStatusErr] = useState('');
  const [camOn, setCamOn] = useState(false);
  const [camUrl, setCamUrl] = useState<string | null>(null);
  const [camErr, setCamErr] = useState('');
  const printerRef = useRef(p.printer);
  printerRef.current = p.printer;

  // Camera loop: no overlapping requests, no setInterval. Stops and frees the frame on toggle off and unmount.
  useEffect(() => {
    if (!camOn || !ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastUrl: string | null = null;
    const next = async () => {
      if (cancelled) return;
      let wait = 500;
      try {
        const buf = await printerRef.current.bytes('POST', '/v1/camera.jpg', undefined, 20000);
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url;
        setCamUrl(url);
        setCamErr('');
      } catch (e) {
        if (cancelled) return;
        setCamErr(e instanceof Error ? e.message : String(e));
        wait = 3000;
      }
      if (!cancelled) timer = setTimeout(() => void next(), wait);
    };
    void next();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      setCamUrl(null);
      setCamErr('');
    };
  }, [camOn, ready]);

  const runCheck = async () => {
    if (!ready) return;
    setCheck({ kind: 'checking' });
    try {
      setCheck({ kind: 'done', r: await p.printer.json<PrinterCheck>('POST', '/v1/check', {}) });
    } catch (e) {
      setCheck({ kind: 'failed', why: e instanceof Error ? e.message : String(e) });
    }
  };
  useEffect(() => {
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.printerBridge.url, p.printerBridge.token, p.recheck]);

  // The checklist is for ONE plate as sliced now: anything that changes it starts the list again.
  const items = [
    { id: 'plate', text: `The build plate is clear, and the ${p.buildPlate} is on the printer` },
    ...p.slotsUsed.map((s) => ({ id: `slot-${s.id}`, text: `${s.label} holds ${s.type || 'the filament this plate needs'}`, color: s.color })),
    { id: 'human', text: 'I will stay with the printer while it prints' },
  ];
  // An engine that has never printed: the first print is a calibration print, said by a person, per plate.
  const needCal = !!p.engine && !p.engine.printed;
  const calItem = { id: 'calibration', text: `This is a calibration print: ${p.engine?.name ?? 'this engine'} has not printed yet, so I watch the first layer and stop it if it goes wrong` };
  // 🔴 An upload belongs to ONE slice. Any change to the plate or its slice drops it (START-STALE, see startGate.ts).
  const sliceKey = p.sliceKey ?? null;
  const sliceKeyRef = useRef(sliceKey);
  sliceKeyRef.current = sliceKey;
  useEffect(() => {
    setUp((u) => (u.kind === 'done' && u.rec.key !== sliceKey ? { kind: 'idle' } : u));
    setAtPrinter(false);
  }, [sliceKey]);
  const listKey = `${p.plate}|${p.buildPlate}|${p.slotsUsed.map((s) => `${s.id}:${s.type}`).join(',')}|${p.engine?.name ?? ''}`;
  useEffect(() => setTicks({}), [listKey]);
  const calibrated = p.plateReady && needCal && !!ticks[calItem.id];
  const allTicked = items.every((it) => ticks[it.id]) && (!needCal || !!ticks[calItem.id]);
  const ticked = p.plateReady && items.every((it) => ticks[it.id]);
  const haveSerial = check.kind === 'done' && !!check.r.haveSerial;
  // The plate as sliced NOW, filament by filament. These go into an UPLOAD (and its record), never straight into a start.
  const mapping = p.filamentSlots.map((id) => trayIndex(id));
  const types = p.filamentSlots.map((id) => p.slots.find((s) => s.id === id)?.type ?? '');
  const startable = mapping.length > 0 && mapping.every((n) => n !== null) && types.every((t) => !!t);
  const onState = p.onState;
  useEffect(() => {
    onState?.({
      check: !ready
        ? { kind: 'unset' }
        : check.kind === 'done'
          ? { kind: 'done', reachable: check.r.reachable, haveCode: check.r.haveCode, printer: check.r.printer }
          : check.kind === 'failed'
            ? { kind: 'failed', why: check.why }
            : { kind: 'checking' },
      ticked,
      calibrated,
      reported: haveSerial && status ? status.slots : null,
    });
  }, [onState, ready, check, ticked, calibrated, haveSerial, status]);

  const upload = async () => {
    if (!p.plate || !p.plateReady || !allTicked || p.blocked || !sliceKey) return;
    const plate = p.plate;
    // What THIS file is for, fixed now from the slice the G-code is fetched from (getGcode is this render's slice).
    const rec: UploadRecord = { key: sliceKey, slots: [...p.filamentSlots], amsMapping: [...mapping], expectTypes: [...types] };
    setUp({ kind: 'uploading' });
    try {
      const gcode = await p.getGcode();
      const r = await p.printer.json<PrinterUpload>('POST', '/v1/upload', { name: `${p.jobName}-plate${plate}`, gcode, ...(startable ? { amsMapping: mapping, expectTypes: types } : {}) }, 180000);
      // The plate changed while the file was on its way: the file is the old slice, so it is not offered for Start.
      if (sliceKeyRef.current !== rec.key) {
        setUp({ kind: 'failed', why: 'the plate changed while uploading, so that file is not offered for Start: upload again' });
        return;
      }
      setUp({ kind: 'done', r, plate, rec });
      setTicks({});
      setAtPrinter(false);
      setAct({ kind: 'idle' });
    } catch (e) {
      setUp({ kind: 'failed', why: e instanceof BridgeError || e instanceof Error ? e.message : String(e) });
    }
  };


  const readStatus = async () => {
    try {
      const s = await p.printer.json<PrinterStatus>('POST', '/v1/status', {}, 20000);
      setStatus(s);
      setStatusErr('');
      return s;
    } catch (e) {
      setStatusErr(e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  // Read once whenever the bridge says it can; then every 5 s while a job is active and every 30 s while idle,
  // so a spool changed on the printer reaches the slots without a button.
  useEffect(() => {
    if (!ready || !haveSerial) return;
    void readStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, haveSerial, p.recheck]);
  const active = !!status && ACTIVE.includes(status.state);
  // Tell the person when a print ends (founder 2026-11-13): a browser notification with one camera frame,
  // when the state goes from active to FINISH or FAILED. Only while this page is open; permission is asked on Start.
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastState.current;
    lastState.current = status?.state ?? prev;
    if (!status || !prev || !ACTIVE.includes(prev) || !['FINISH', 'FAILED'].includes(status.state)) return;
    const N = globalThis.Notification;
    if (!N || N.permission !== 'granted') return;
    const title = status.state === 'FINISH' ? 'X2D: print finished' : 'X2D: print failed';
    const body = `${status.task || 'The print'}${status.errorCode ? ` · error ${status.errorCode}${status.errorText ? `: ${status.errorText}` : ''}` : ''}`;
    void (async () => {
      let image: string | undefined;
      try {
        image = URL.createObjectURL(new Blob([await p.printer.bytes('POST', '/v1/camera.jpg', undefined, 20000)], { type: 'image/jpeg' }));
      } catch {
        /* no frame: the notification still goes */
      }
      try {
        new N(title, { body, icon: image, ...(image ? { image } : {}) } as NotificationOptions);
      } catch {
        /* a browser that refuses Notification outside a service worker: nothing to do */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state]);
  useEffect(() => {
    if (!ready || !haveSerial) return;
    const t = setInterval(() => void readStatus(), active ? 5000 : 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, haveSerial, active]);

  // Start: the uploaded file, mapped filament by filament onto the slots it was UPLOADED for (startGate.ts).
  const startIn = { up: up.kind === 'done' ? up.rec : null, plateReady: p.plateReady, currentKey: sliceKey, haveSerial, printerState: status?.state ?? null };
  const startWhy = startBlock(startIn);
  const command = async (what: string, path: string, body: Record<string, unknown>, done: (r: PrinterStart) => string) => {
    setAct({ kind: 'busy', what });
    try {
      const r = await p.printer.json<PrinterStart>('POST', path, body, 60000);
      setAct({ kind: 'done', text: done(r) });
    } catch (e) {
      setAct({ kind: 'failed', why: e instanceof Error ? e.message : String(e) });
    }
    await readStatus();
  };
  const start = async () => {
    if (up.kind !== 'done' || !atPrinter || startWhy || !up.r.remote) return;
    // Asked here, on a click, so the end-of-print notification can be shown later.
    if (globalThis.Notification?.permission === 'default') void globalThis.Notification.requestPermission().catch(() => undefined);
    await command(
      'Starting',
      '/v1/start',
      startBody(startIn, up.r.remote, up.r.md5, p.buildPlate),
      (r) => `Plate ${up.plate} started: the printer reports ${r.state}. Watch the first layer.`,
    );
    setAtPrinter(false);
  };
  const stop = async () => {
    if (!globalThis.confirm?.('Stop the print? A stopped print cannot be resumed.')) return;
    await command('Stopping', '/v1/stop', {}, (r) => `Stopped: the printer reports ${r.state}.`);
  };
  const busy = act.kind === 'busy';

  const badge =
    !ready ? { s: 'unset', t: 'NOT SET UP' } : check.kind === 'done' ? (check.r.reachable ? { s: 'online', t: 'REACHABLE' } : { s: 'offline', t: 'NOT REACHABLE' }) : check.kind === 'failed' ? { s: 'offline', t: 'BRIDGE DOWN' } : { s: 'loading', t: 'CHECKING' };

  const d = draft ?? { bedPlate: p.buildPlate, slots: p.slots };
  const liveIds = new Set(haveSerial && status ? status.slots.map((x) => x.id) : []);

  return (
    <section className="p3d-printers" aria-label="Printers" data-testid="p3d-printers">
      <div className="p3d-printers-bar">
        <h3>Printers</h3>
        <button type="button" onClick={() => void runCheck()} disabled={!ready || check.kind === 'checking'}>
          Check again
        </button>
      </div>
      <div className="p3d-card" data-testid="p3d-printer-card">
        <div className="p3d-card-head">
          <div>
            <div className="p3d-card-name">Bambu Lab X2D</div>
            <div className="p3d-sub">
              {check.kind === 'done' ? `${check.r.printer} · LAN upload` : 'through the printer bridge'}
            </div>
          </div>
          <span className="p3d-badge" data-s={badge.s} data-testid="p3d-printer-badge">
            {badge.t}
          </span>
        </div>
        {!ready && <p className="p3d-sub">Set up the printer bridge under Connections to upload. Slicing works without it.</p>}
        {check.kind === 'failed' && <p className="p3d-err">{check.why}</p>}
        {check.kind === 'done' && !check.r.haveCode && (
          <p className="p3d-warn">The printer bridge has no access code, so an upload would be refused. Start it with --code-file.</p>
        )}
        <p className="p3d-sub">
          Reachable means the printer answers on the network. The status line below is read from the printer itself, when the printer bridge can reach its command channel.
        </p>
        {haveSerial && (
          <div className="p3d-sub" data-testid="p3d-printer-status">
            {status
              ? /* Founder 2026-11-13, "0 mins left?": after the last layer a Bambu printer runs its end
                 * G-code (wipe, park, cool) and still reports RUNNING, 99 %, 0 min until FINISH. Said so
                 * here; the state word the printer sent is kept, and nothing that acts on it changes. */
                `Printer: ${status.state}${status.stage && status.stage.name !== status.state ? ` (${status.stage.name})` : ''}${status.state === 'RUNNING' && status.layer != null && status.layer === status.layers && status.remainMin === 0 ? ' (last layer done, end sequence: wipe, park, cool; waits for FINISH)' : ''}${status.task ? ` · ${status.task}` : ''} · ${fmt(status.percent, '%')} · layer ${fmt(status.layer)}/${fmt(status.layers)} · ${hoursMin(status.remainMin)} left · nozzle ${fmt(status.nozzle)}/${fmt(status.nozzleTarget)} °C · plate ${plateTemp(status)} °C${status.error ? ` · error ${status.errorCode ?? status.error}${status.errorText ? `: ${status.errorText}` : ''}` : ''}`
              : statusErr
                ? `Printer state not read: ${statusErr}`
                : 'Reading the printer state…'}
          </div>
        )}
        {haveSerial && status?.hms && status.hms.length > 0 && (
          /* The printer's own HMS messages, described from Bambu's X2D table (founder 2026-11-13). */
          <ul className="p3d-warn" data-testid="p3d-hms">
            {status.hms.map((h) => (
              <li key={h.code}>
                Printer message ({h.level}): {h.text ?? "Bambu's table has no description for this code"} · {h.code}
              </li>
            ))}
          </ul>
        )}
        {haveSerial && (
          <div className="p3d-row">
            {status && (status.state === 'RUNNING' || status.state === 'PREPARE') && (
              <button type="button" disabled={busy} onClick={() => void command('Pausing', '/v1/pause', {}, (r) => `Paused: the printer reports ${r.state}.`)} data-testid="p3d-pause-btn">
                Pause
              </button>
            )}
            {status && status.state === 'PAUSE' && (
              <button type="button" disabled={busy} onClick={() => {
                  // Resume moves and heats the machine again: a person says they are there.
                  if (!globalThis.confirm?.('Resume the print? Only if you are at the printer.')) return;
                  void command('Resuming', '/v1/resume', { confirm: 'at-printer' }, (r) => `Resumed: the printer reports ${r.state}.`);
                }} data-testid="p3d-resume-btn">
                Resume
              </button>
            )}
            {/* SLICING too: the bridge counts it active and stops it; without this the card offered no control at all. */}
            {status && ['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(status.state) && (
              <button type="button" onClick={() => void stop()} data-testid="p3d-stop-btn">
                Stop
              </button>
            )}
            {status?.speed && ['RUNNING', 'PAUSE', 'PREPARE'].includes(status.state) && (
              <label>
                Speed{' '}
                <select
                  value={status.speed.level}
                  disabled={busy}
                  data-testid="p3d-speed"
                  onChange={(e) => {
                    const level = Number(e.target.value);
                    void command('Speed', '/v1/speed', { level }, (r) => `Speed: the printer reports ${r.speed?.name ?? 'no value'}.`);
                  }}
                >
                  {[[1, 'Silent'], [2, 'Standard'], [3, 'Sport'], [4, 'Ludicrous']].map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {status && status.light != null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void command('Light', '/v1/light', { on: status.light !== 'on' }, (r) => `Chamber light: ${r.light ?? 'not reported'}.`)}
                data-testid="p3d-light-btn"
              >
                {status.light === 'on' ? 'Light off' : 'Light on'}
              </button>
            )}
          </div>
        )}
        {haveSerial && status?.fans && status.fans.length > 0 && (
          /* Fans (founder 2026-11-13: "able to change the fan options"). Each value is read from the
           * printer; a change is sent as one set_fan and shown only once the printer reports it. The
           * mode (Strong Cooling / Heating) is switched after a confirm: it moves the duct doors. */
          <details className="p3d-slots" data-testid="p3d-fans">
            <summary>Fans · {status.fanMode ?? 'mode not reported'}</summary>
            {status.fanModes && status.fanModes.length > 1 && status.fanModeId != null && (
              <label className="p3d-slotrow">
                <span className="p3d-slotname">Mode</span>
                <select
                  value={status.fanModeId}
                  disabled={busy}
                  aria-label="Fan mode"
                  data-testid="p3d-fanmode"
                  onChange={(e) => {
                    const mode = Number(e.target.value);
                    const name = status.fanModes?.find((m) => m.id === mode)?.name ?? String(mode);
                    // The mode moves the duct doors and changes which fans the printer runs itself.
                    if (!globalThis.confirm?.(`Switch the fans to ${name}? The printer moves its air duct doors.${['RUNNING', 'PREPARE'].includes(status.state) ? ' This can change how the print comes out.' : ''}`)) return;
                    void command('Fan mode', '/v1/fanmode', { mode }, (r) => `Fan mode: the printer reports ${r.fanMode ?? 'no value'}.`);
                  }}
                >
                  {status.fanModes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {status.fans.map((f) => (
              <label key={f.id} className="p3d-slotrow">
                <span className="p3d-slotname">{f.name}</span>
                {f.control === 'set' ? (
                  <select
                    value={f.percent ?? ''}
                    disabled={busy || f.percent == null}
                    aria-label={`${f.name} fan speed`}
                    data-testid={`p3d-fan-${f.id}`}
                    onChange={(e) => {
                      const percent = Number(e.target.value);
                      // Bambu Studio warns the same way: a fan change mid-print can change the print.
                      if (['RUNNING', 'PREPARE'].includes(status.state) && !globalThis.confirm?.(`Set ${f.name} to ${percent} % during the print? It can change how the print comes out.`)) return;
                      void command('Fan', '/v1/fan', { id: f.id, percent }, (r) => `${f.name}: the printer reports ${r.fans?.find((x) => x.id === f.id)?.percent ?? 'no value'} %.`);
                    }}
                  >
                    {f.percent != null && f.percent % 10 !== 0 && <option value={f.percent}>{f.percent} %</option>}
                    {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v) => (
                      <option key={v} value={v}>
                        {v} %
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="p3d-sub">
                    {f.percent ?? '?'} % · {f.control === 'off' ? 'off in this mode' : 'run by the printer in this mode'}
                  </span>
                )}
              </label>
            ))}
          </details>
        )}
        {haveSerial && status && ['RUNNING', 'PAUSE'].includes(status.state) && status.objects && status.objects.length > 1 && (
          /* Skip one object of the running plate (founder 2026-11-13). Only for a file this printer bridge
           * uploaded: its object list comes from that G-code. A skip cannot be undone. */
          <details className="p3d-slots" data-testid="p3d-objects">
            <summary>Objects on the plate · {status.skipped?.length ?? 0} skipped</summary>
            {(() => {
              /* Top view of THE PRINTING FILE's objects (plateMap.ts says why it is not the 3d tab's view). */
              const map = plateMap(status.objects, status.printableArea);
              if (!map) return <p className="p3d-sub">The file gives no object outlines, so there is no plate picture.</p>;
              return (
                <figure className="p3d-platemap" data-testid="p3d-platemap">
                  <svg viewBox={map.viewBox} role="img" aria-label="Top view of the objects on the plate">
                    {map.plate && <path d={map.plate} className="p3d-platemap-area" />}
                    {map.shapes.map((sh) => {
                      const skipped = !!status.skipped?.includes(sh.id);
                      return (
                        <g
                          key={sh.id}
                          className={`p3d-platemap-obj${skipped ? ' skipped' : ''}${hotObj === sh.id ? ' hot' : ''}`}
                          onMouseEnter={() => setHotObj(sh.id)}
                          onMouseLeave={() => setHotObj(null)}
                          data-testid={`p3d-platemap-${sh.id}`}
                        >
                          <title>{`${sh.name}${skipped ? ' (skipped)' : ''}`}</title>
                          <path d={sh.path} />
                          <text x={sh.label[0]} y={sh.label[1]}>{sh.id}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <figcaption className="p3d-sub">
                    Top view, read from the printing file: each outline is the area the object's extrusion covers (its convex outline, not its exact shape).
                    {!map.plate && ' The file does not state the printable area, so the picture frames the objects only.'}
                    {map.unplaced.length > 0 && ` No outline in the file for: ${map.unplaced.map((u) => u.name).join(', ')}.`}
                  </figcaption>
                </figure>
              );
            })()}
            {status.objects.map((o) => {
              const skipped = !!status.skipped?.includes(o.id);
              const left = status.objects!.filter((x) => !status.skipped?.includes(x.id));
              return (
                <div
                  key={o.id}
                  className={`p3d-slotrow${hotObj === o.id ? ' p3d-hot' : ''}`}
                  onMouseEnter={() => setHotObj(o.id)}
                  onMouseLeave={() => setHotObj(null)}
                >
                  <span className="p3d-slotname">
                    <span className="p3d-objid">{o.id}</span> {o.name}
                  </span>
                  {skipped ? (
                    <span className="p3d-sub">skipped</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || left.length < 2}
                      title={left.length < 2 ? 'The last object left: use Stop' : undefined}
                      data-testid={`p3d-skip-${o.id}`}
                      onClick={() => {
                        if (!globalThis.confirm?.(`Skip "${o.name}" (number ${o.id} on the plate picture)? The printer stops printing it for the rest of this print. This cannot be undone.`)) return;
                        void command('Skipping', '/v1/skip', { ids: [o.id], confirm: 'skip' }, (r) => (r.skipped?.includes(o.id) ? `Skipped: ${o.name}.` : `The printer does not report ${o.name} as skipped.`));
                      }}
                    >
                      Skip
                    </button>
                  )}
                </div>
              );
            })}
          </details>
        )}
        {ready && (
          <div className="p3d-camera">
            <div className="p3d-row">
              <button type="button" onClick={() => setCamOn((v) => !v)} aria-pressed={camOn} data-testid="p3d-camera-toggle">
                {camOn ? 'Hide camera' : 'Show camera'}
              </button>
            </div>
            {camOn && camErr && (
              <p className="p3d-err" data-testid="p3d-camera-err">
                Camera: {camErr}
              </p>
            )}
            {camOn && camUrl && (
              <>
                <img src={camUrl} alt="X2D camera" data-testid="p3d-camera-img" style={{ width: '100%' }} />
                <p className="p3d-sub">Live view from the printer, about 2 frames a second.</p>
              </>
            )}
          </div>
        )}

        <details className="p3d-slots">
          <summary>
            Build plate and filament slots · {p.buildPlate}
          </summary>
          <p className="p3d-sub" data-testid="p3d-slots-source">
            {liveIds.size
              ? 'Filament is read from the printer: change a spool there and it shows here within 30 s. Slots the printer does not report are declared by you.'
              : 'Declared by you: which filament is loaded where. The printer is not read (the printer bridge needs --serial for that).'}
          </p>
          <label>
            Build plate
            <select value={d.bedPlate} onChange={(e) => setDraft({ ...d, bedPlate: e.target.value })} data-testid="p3d-buildplate">
              {p.plates.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {d.slots.map((s, i) => (
            <div key={s.id} className="p3d-slotrow">
              <span className="p3d-sw" style={{ background: s.color }} aria-hidden="true" />
              <span className="p3d-slotname">{s.label}</span>
              <select
                value={s.type}
                disabled={liveIds.has(s.id)}
                title={liveIds.has(s.id) ? 'Read from the printer' : undefined}
                aria-label={`Filament in ${s.label}`}
                onChange={(e) => setDraft({ ...d, slots: d.slots.map((x, k) => (k === i ? { ...x, type: e.target.value } : x)) })}
                data-testid={`p3d-slot-type-${s.id}`}
              >
                <option value="">empty</option>
                {p.types.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                type="color"
                value={s.color}
                aria-label={`Colour of the filament in ${s.label}`}
                disabled={liveIds.has(s.id)}
                onChange={(e) => setDraft({ ...d, slots: d.slots.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)) })}
              />
              {liveIds.has(s.id) && <span className="p3d-sub">from the printer</span>}
            </div>
          ))}
          <div className="p3d-row">
            <button
              type="button"
              disabled={!draft}
              onClick={async () => {
                if (!draft) return;
                setSaveMsg('Saving…');
                try {
                  await p.onSaveSlots(draft);
                  setDraft(null);
                  setSaveMsg('Saved.');
                } catch (e) {
                  setSaveMsg(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}
              data-testid="p3d-slots-save"
            >
              Save slots
            </button>
            <span className="p3d-sub">{saveMsg}</span>
          </div>
        </details>

        <div className="p3d-upload" data-testid="p3d-upload">
          <strong>{p.plate ? `Send plate ${p.plate}` : 'Send a plate'}</strong>
          {!p.plateReady && <p className="p3d-sub">{p.notReady}</p>}
          {p.plateReady && (
            <>
              <p className="p3d-sub">Before the file goes to the printer, check at the printer:</p>
              <ul className="p3d-check">
                {(needCal ? [...items, calItem] : items).map((it) => (
                  <li key={it.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!ticks[it.id]}
                        onChange={(e) => setTicks((t) => ({ ...t, [it.id]: e.target.checked }))}
                        data-testid={`p3d-tick-${it.id}`}
                      />
                      {'color' in it && it.color ? <span className="p3d-sw" style={{ background: it.color }} aria-hidden="true" /> : null}
                      {it.text}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="p3d-primary"
            disabled={!ready || !p.plateReady || !allTicked || !!p.blocked || up.kind === 'uploading'}
            onClick={() => void upload()}
            data-testid="p3d-upload-btn"
          >
            {up.kind === 'uploading' ? 'Uploading…' : `Upload${p.plate ? ` plate ${p.plate}` : ''} to the printer`}
          </button>
          {p.blocked && p.plateReady && allTicked ? (
            <p className="p3d-err" data-testid="p3d-upload-blocked">
              Upload stays off: {p.blocked}
            </p>
          ) : null}
          {up.kind === 'done' && (
            <p className="p3d-ok" data-testid="p3d-upload-done">
              Plate {up.plate} is on the printer as {up.r.remote} ({up.r.remoteBytes} bytes, size confirmed). Nothing has started yet.
            </p>
          )}
          {up.kind === 'done' && (
            <div className="p3d-start" data-testid="p3d-start">
              <label>
                <input type="checkbox" checked={atPrinter} onChange={(e) => setAtPrinter(e.target.checked)} data-testid="p3d-tick-atprinter" />
                I am at the printer now, and I will watch the first layer
              </label>
              <button type="button" className="p3d-primary" disabled={!atPrinter || !!startWhy || busy} onClick={() => void start()} data-testid="p3d-start-btn">
                {act.kind === 'busy' && act.what === 'Starting' ? 'Starting…' : `Start plate ${up.plate} on the printer`}
              </button>
              {startWhy && <p className="p3d-sub" data-testid="p3d-start-why">Start stays off: {startWhy}.</p>}
            </div>
          )}
          {act.kind === 'done' && (
            <p className="p3d-ok" data-testid="p3d-action-done">
              {act.text}
            </p>
          )}
          {act.kind === 'failed' && (
            <p className="p3d-err" data-testid="p3d-action-failed">
              Printer refused or did not answer: {act.why}
            </p>
          )}
          {up.kind === 'failed' && (
            <p className="p3d-err" data-testid="p3d-upload-failed">
              Not uploaded: {up.why}
            </p>
          )}
          <p className="p3d-sub">Start, pause and stop work from here and from the printer’s own screen. Stop is always on the printer’s screen too.</p>
        </div>
      </div>
    </section>
  );
}
