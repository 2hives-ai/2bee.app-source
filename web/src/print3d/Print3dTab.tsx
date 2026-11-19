// 2bee.3d, migrated into 2bee.app (founder 2026-10-15: "migrate the 2bee.3d
// into this app" · "use the design of http://127.0.0.1:8765/").
//
// Same layout as pnp's page: LEFT — the parts (drop STL files, a filament slot
// and a quantity per row) and the print assistant; CENTRE — plate tabs, the
// plate in 3D, one result line, the printer card.
//
// What does the work:
//   · `layout3d.ts` — this tab's own SEPARATE / LAY FLAT / ARRANGE, run
//     automatically on every part that arrives (founder 2026-10-16). The bridge
//     slices at the placements it chose (optimise off) unless the person asks
//     for a bridge strategy or objective (`job.layout = 'bridge'`).
//   · `tools/print3d-bridge/` — slices on this computer with 2bee.fdm, the
//     app's own Rust engine (fdm/, crate twobee-fdm), by default (founder
//     2026-10-16: "no orcaslicer anymore!"); pnp's job engine (plates, the
//     objective optimiser) runs on top of it. The OrcaSlicer CLI is used only
//     when the bridge is started with `--engine orca`. 🔴 2bee.fdm has not
//     printed anything: gate ENGINE makes the first print a calibration print,
//     ticked by a person.
//   · `tools/printer-bridge/` — upload only. Never starts a print.
//   · the app's AI path (`cad/ask.tsx` → `tools/claude-bridge`) for free text.
//
// 🔴 NOTHING HAS PRINTED FROM THIS TAB. The banner says so on screen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Assistant } from './Assistant';
import {
  BridgeError,
  client,
  configured,
  LONG_MS,
  readBridges,
  writeBridges,
  type Bridges,
  type FetchLike,
  engineName,
  healthProblems,
  type Health,
  type PlanReply,
  type Profiles,
  type SliceReply,
  type SlotsReply,
  type UploadReply,
} from './bridges';
import { Connections } from './Connections';
import {
  baseName,
  EMPTY_JOB,
  finishAt,
  gramsTotal,
  hms,
  jobBody,
  OBJECTIVES,
  parseStl,
  plateFp,
  plateNumbers,
  plateObjects,
  rows,
  saveBody,
  secsOf,
  STRATEGIES,
  usedSlots,
  waitingReason,
  OBJECT_KEY_LABEL,
  OBJECT_KEYS,
  withClonedRow,
  withoutRow,
  withQty,
  withRowOverrides,
  splitObjectKeys,
  writeBinaryStl,
  type JobState,
  type Obj,
  type Objective,
  type Placement,
  type SlotDecl,
  type Strategy,
  syncSlots,
} from './model';
import { oneNozzleZones, PlateView, type PlatePart } from './PlateView';
import { KIND_COLOR, KIND_LABEL, PATH_KINDS, parseGcode, type Toolpath } from './gcodePath';
import {
  arrange,
  bbox,
  checkLayout,
  contactArea,
  footprintOf,
  layFlat,
  plateFromArea,
  rotatePart,
  separate,
  separationText,
  sizeOf,
  sizeText,
  type LayoutAction,
} from './layout3d';
import { PrinterCard, type PrinterCardState } from './PrinterCard';
import { plateKey } from './startGate';
import { assignSlots, mayUpload, printGates } from './printGates';
import { GatesPanel } from '../gates/GatesPanel';
import { fetchTransport, readAskConfig, readReply } from '../cad/ask';
import { thumbDataUrl } from './thumb';
import type { AskTransport } from '../cad/ask';
import { claimPendingFor, subscribeHandoffFor, type Pending3d, type PendingDesign } from '../shop/handoff';
import { designToStl } from '../shop/toCnc';
import { ParamsPanel } from '../cad/ParamsPanel';
import { setParam, type Param, type ParamValue } from '../cad/params';
import './print3d.css';

export interface Print3dTabProps {
  /** False while the tab is hidden: the 3D view stops drawing. Default true. */
  active?: boolean;
  /** Injected in tests: replaces `fetch` for both bridges. */
  fetchImpl?: FetchLike;
  /** Injected in tests: the AI transport. */
  transport?: AskTransport;
}

type PlateStatus = 'slicing' | 'current' | 'stale' | 'failed' | 'waiting';
interface PlateState {
  status: Exclude<PlateStatus, 'waiting'>;
  fp: string;
  result: SliceReply | null;
  error: string | null;
}
interface Plan {
  tooBig: PlanReply['tooBig'];
  note: string;
}

const STATUS_TEXT: Record<PlateStatus, string> = { slicing: 'Slicing…', current: 'Up to date', stale: 'Out of date', waiting: 'Waiting', failed: 'Failed' };
const DEFAULT_PROCESS = '0.20mm Standard @BBL X2D';
/** mm between parts when this tab arranges them. */
const GAP = 5;

let uidN = 0;
let gidN = 0;
const nextUid = () => ++uidN;

function readStoredBridges(): Bridges {
  try {
    return readBridges(globalThis.localStorage);
  } catch {
    return readBridges(null);
  }
}

const msg = (e: unknown) => (e instanceof BridgeError || e instanceof Error ? e.message : String(e));

/** Slot id per filament in the G-code's order (filament 1 first), for the printer's ams_mapping.
 *  Ids that are not exactly 1..n give [] — order unknown, and the printer card then refuses to start. */
export function filamentSlotsOf(r: { filaments: { id: number; slot: string }[] } | null): string[] {
  if (!r) return [];
  const fs = [...r.filaments].sort((a, b) => a.id - b.id);
  if (!fs.every((f, i) => f.id === i + 1)) return [];
  return fs.map((f) => f.slot);
}

export function Print3dTab({ active = true, fetchImpl, transport }: Print3dTabProps) {
  /* ── connections ─────────────────────────────────────────────────────── */
  const [bridges, setBridgesState] = useState<Bridges>(readStoredBridges);
  const setBridges = (b: Bridges) => {
    setBridgesState(b);
    try {
      writeBridges(b, globalThis.localStorage);
    } catch {
      /* storage off */
    }
  };
  const engine = useMemo(() => client(bridges.engine, 'slicer bridge', fetchImpl), [bridges.engine, fetchImpl]);
  const printer = useMemo(() => client(bridges.printer, 'printer bridge', fetchImpl), [bridges.printer, fetchImpl]);
  const engineSet = configured(bridges.engine);
  const [showConn, setShowConn] = useState(!engineSet);

  /* ── engine facts ────────────────────────────────────────────────────── */
  const [health, setHealth] = useState<{ kind: 'unset' | 'checking' | 'ok' | 'bad'; text: string }>({ kind: 'unset', text: '' });
  /** The bridge's own statement that its engine has printed. False until a bridge says otherwise. */
  const [enginePrinted, setEnginePrinted] = useState(false);
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [slotsReply, setSlotsReply] = useState<SlotsReply | null>(null);
  const slots: SlotDecl[] = useMemo(() => slotsReply?.slots ?? [], [slotsReply]);
  const buildPlate = slotsReply?.bedPlate ?? 'Textured PEI Plate';

  /* ── the job ─────────────────────────────────────────────────────────── */
  const [job, setJobState] = useState<JobState>(EMPTY_JOB);
  const jobRef = useRef(job);
  const setJob = useCallback((j: JobState) => {
    jobRef.current = j;
    setJobState(j);
  }, []);
  const tris = useRef(new Map<string, Float32Array>());
  const thumbs = useRef(new Map<string, string>());
  const [plan, setPlan] = useState<Plan>({ tooBig: [], note: '' });
  const [plates, setPlatesState] = useState<Record<number, PlateState>>({});
  const platesRef = useRef(plates);
  const setPlate = (b: number, st: PlateState | null) => {
    const next = { ...platesRef.current };
    if (st) next[b] = st;
    else delete next[b];
    platesRef.current = next;
    setPlatesState(next);
  };
  const [curPlate, setCurPlate] = useState(1);
  const [sel, setSel] = useState<number | null>(null);
  const [planning, setPlanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [rowNote, setRowNote] = useState('');
  const arrangeToken = useRef(0);
  const sliceRun = useRef(0);
  const sliceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctx = useRef({ slots, buildPlate, area: null as string[] | null });
  ctx.current = { slots, buildPlate, area: profiles?.bed?.area ?? null };
  const [layoutNote, setLayoutNote] = useState('');

  /* ── load the engine's facts when it is set up ───────────────────────── */
  useEffect(() => {
    if (!engineSet) {
      setHealth({ kind: 'unset', text: 'The slicer bridge is not set up.' });
      return;
    }
    let live = true;
    setHealth({ kind: 'checking', text: 'Checking the slicer bridge…' });
    (async () => {
      try {
        const h = await engine.json<Health>('GET', '/v1/health');
        const [pr, sl] = await Promise.all([engine.json<Profiles>('GET', '/v1/profiles'), engine.json<SlotsReply>('GET', '/v1/slots')]);
        if (!live) return;
        setProfiles(pr);
        setSlotsReply(sl);
        const j = jobRef.current;
        if (!j.process || !pr.process.some((x) => x.name === j.process)) {
          const want = pr.process.find((x) => x.name === DEFAULT_PROCESS) ?? pr.process[0];
          if (want) setJob({ ...jobRef.current, process: want.name });
        }
        const missing = healthProblems(h);
        setEnginePrinted(h.engine && typeof h.engine === 'object' ? h.engine.printed === true : false);
        setHealth(missing.length ? { kind: 'bad', text: `The slicer bridge answers, but ${missing.join(' and ')}: slicing cannot run.` } : { kind: 'ok', text: `${engineName(h.engine.id)} ready` });
      } catch (e) {
        if (live) setHealth({ kind: 'bad', text: msg(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [engine, engineSet, setJob]);

  /* ── arrange (plates) ────────────────────────────────────────────────── */
  const rearrange = useCallback(
    async (j: JobState): Promise<string> => {
      if (!j.objects.length) {
        setPlan({ tooBig: [], note: '' });
        return '';
      }
      const tok = ++arrangeToken.current;
      if (sliceTimer.current) clearTimeout(sliceTimer.current);
      sliceRun.current++;
      setPlanning(true);
      try {
        const r = await engine.json<PlanReply>('POST', '/v1/job/plates', { ...jobBody(j, ctx.current.buildPlate, true), strategy: j.strategy }, LONG_MS);
        if (tok !== arrangeToken.current) return '';
        const cur = jobRef.current;
        const objects = cur.objects.map((o, i) => {
          const a = r.assignment[i];
          return { ...o, plate: a && a.bed ? a.bed : null, placement: null as Placement | null };
        });
        for (const b of r.beds) for (const pl of b.placements) {
          const o = objects[pl.object];
          if (o) o.placement = { x: pl.x, y: pl.y, rot: pl.rot || 0, ...(pl.tilt ? { tilt: pl.tilt } : {}) };
        }
        setJob({ ...cur, objects });
        setPlan({ tooBig: r.tooBig, note: r.packNote ?? '' });
        for (const k of Object.keys(platesRef.current).map(Number)) if (k > r.beds.length) setPlate(k, null);
        // (written without a less-than sign: tests/terminology.test.ts reads `> … <` in code as JSX text)
        const plateCount = r.beds.length;
        setCurPlate((c) => (c >= 1 && plateCount >= c ? c : 1));
        setProblems((ps) => ps.filter((x) => !x.startsWith('Arranging failed')));
        return r.summary;
      } catch (e) {
        if (tok === arrangeToken.current) setProblems((ps) => [...ps.filter((x) => !x.startsWith('Arranging failed')), `Arranging failed: ${msg(e)}`]);
        return `Arranging failed: ${msg(e)}`;
      } finally {
        if (tok === arrangeToken.current) setPlanning(false);
      }
    },
    [engine, setJob],
  );

  /* ── this tab's own arrangement (founder 2026-10-16: "auto arrangement should
   * happen automatically", and no OrcaSlicer for the person to open) ──────────
   * Footprints come from the meshes this page holds (already laid flat), the plate
   * from the printer profile the bridge reads. `checkLayout` re-measures the result
   * before it is used: a packer defect becomes a refusal on screen, never a job. */
  const autoArrange = useCallback(
    (j: JobState): { job: JobState; text: string } => {
      arrangeToken.current++; // a bridge arrange still in flight must not overwrite this one
      setPlanning(false);
      if (!j.objects.length) {
        setPlan({ tooBig: [], note: '' });
        return { job: { ...j, layout: 'app' }, text: '' };
      }
      const plate = plateFromArea(ctx.current.area);
      const unplace = (why: string) => {
        setProblems((ps) => [...ps.filter((x) => !x.startsWith('Arranging failed')), `Arranging failed: ${why}`]);
        return { job: { ...j, layout: 'app' as const, objects: j.objects.map((o) => ({ ...o, plate: null, placement: null })) }, text: `Arranging failed: ${why}` };
      };
      if (!plate) return unplace('the printer profile gives no build plate size, so nothing is placed.');
      const fps = j.objects.map((o) => {
        const t = tris.current.get(j.files[o.file]?.sha256 ?? '');
        return t && t.length ? footprintOf(t) : { w: NaN, d: NaN };
      });
      const a = arrange(fps, plate, { gap: GAP });
      const bad = checkLayout(fps, a.placed, plate, GAP);
      if (bad.length) return unplace(`the layout check refused the arrangement (${bad.slice(0, 3).join('; ')}).`);
      const objects = j.objects.map((o, i) => {
        const p = a.placed[i];
        return p ? { ...o, plate: p.plate, placement: { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, rot: p.rot } } : { ...o, plate: null, placement: null };
      });
      const tooBig = a.tooBig.map((t) => ({ index: t.index, name: baseName(j.files[j.objects[t.index].file]?.name ?? `part ${t.index + 1}`), reason: t.reason }));
      const n = j.objects.length - tooBig.length;
      const note =
        `Arranged by this app: ${n} part${n === 1 ? '' : 's'} on ${a.plates} plate${a.plates === 1 ? '' : 's'}, ${GAP} mm apart, centred.` +
        (a.plates > 1 ? ` They do not fit on one plate, so ${a.plates} plates are used.` : '');
      setPlan({ tooBig, note });
      for (const k of Object.keys(platesRef.current).map(Number)) if (k > a.plates) setPlate(k, null);
      const plateCount = a.plates;
      setCurPlate((c) => (c >= 1 && plateCount >= c ? c : 1));
      setProblems((ps) => ps.filter((x) => !x.startsWith('Arranging failed')));
      return { job: { ...j, layout: 'app', objects }, text: note };
    },
    [],
  );

  /** Place the parts again: this tab's arrangement, or the bridge's when the person chose a bridge strategy. */
  const relayout = useCallback(
    async (j: JobState): Promise<string> => {
      if (j.layout === 'bridge') return rearrange(j);
      const r = autoArrange(j);
      setJob(r.job);
      return r.text;
    },
    [autoArrange, rearrange, setJob],
  );

  /* ── background slicing, one plate at a time ─────────────────────────── */
  const runSlice = useCallback(async () => {
    const run = ++sliceRun.current;
    const j0 = jobRef.current;
    if (!j0.objects.length || !j0.process || j0.objects.some((o) => !o.plate) || !configured(bridges.engine)) return;
    const { slots: sl, buildPlate: bp } = ctx.current;
    const todo = plateNumbers(j0).filter((b) => {
      const st = platesRef.current[b];
      return !(st && st.fp === plateFp(j0, b, bp, sl) && (st.status === 'current' || st.status === 'failed')) && !waitingReason(j0, b, sl);
    });
    if (!todo.length) return;
    setProgress({ done: 0, total: todo.length });
    try {
      for (const b of todo) {
        if (run !== sliceRun.current) return;
        const j = jobRef.current;
        const fp = plateFp(j, b, bp, sl);
        const prev = platesRef.current[b];
        setPlate(b, { status: 'slicing', fp, result: prev?.result ?? null, error: null });
        let r: SliceReply;
        try {
          // optimise only when the bridge arranged: it re-arranges inside the plate, which would undo this tab's layout.
          r = await engine.json<SliceReply>('POST', '/v1/job/slice', { ...jobBody(j, bp, false), bedIndex: b, optimise: j.layout === 'bridge' }, LONG_MS);
        } catch (e) {
          r = { ok: false, error: msg(e) } as SliceReply;
        }
        if (run !== sliceRun.current || plateFp(jobRef.current, b, bp, sl) !== fp) {
          const c = platesRef.current[b];
          if (c && c.fp === fp && c.status === 'slicing') setPlate(b, { ...c, status: 'stale' });
          return;
        }
        if (!r.ok) {
          setPlate(b, { status: 'failed', fp, result: null, error: `${r.error || 'slice failed'}${r.log ? `\n${r.log}` : ''}` });
        } else {
          let jj = jobRef.current;
          if (r.optimise) {
            const objects = jj.objects.slice();
            for (const ro of r.objects) if (objects[ro.index]) objects[ro.index] = { ...objects[ro.index], placement: { ...ro.placement } };
            jj = { ...jj, objects };
            setJob(jj);
          }
          setPlate(b, { status: 'current', fp: plateFp(jj, b, bp, sl), result: r, error: null });
        }
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    } finally {
      if (run === sliceRun.current) setProgress(null);
    }
  }, [engine, bridges.engine, setJob]);

  const scheduleSlice = useCallback(() => {
    if (sliceTimer.current) clearTimeout(sliceTimer.current);
    sliceTimer.current = setTimeout(() => void runSlice(), 1000);
  }, [runSlice]);
  const flushSlice = useCallback(() => {
    if (sliceTimer.current) clearTimeout(sliceTimer.current);
    return runSlice();
  }, [runSlice]);

  // Anything a plate's G-code depends on changed: slice again in the background.
  useEffect(() => {
    if (!planning) scheduleSlice();
  }, [job, slots, buildPlate, planning, scheduleSlice]);
  useEffect(() => () => {
    if (sliceTimer.current) clearTimeout(sliceTimer.current);
  }, []);

  /* ── parts ───────────────────────────────────────────────────────────── */
  const defaultSlot = () => slots.find((s) => s.type)?.id ?? 'ams1-1';

  const uploadStl = async (name: string, buf: ArrayBuffer) => {
    const r = await engine.postRaw<UploadReply>(`/v1/job/upload?name=${encodeURIComponent(name)}`, buf, 120000);
    tris.current.set(r.sha256, parseStl(buf));
    return r;
  };

  /** Upload a mesh and add it as `copies` new objects in one new row. */
  const addMesh = async (j: JobState, name: string, tri: Float32Array, slot: string, copies = 1): Promise<JobState> => {
    const r = await uploadStl(name, writeBinaryStl(tri));
    let fi = j.files.findIndex((x) => x.sha256 === r.sha256);
    if (fi < 0) {
      j = { ...j, files: [...j.files, { name: r.name, size: r.size, sha256: r.sha256, size3d: r.size3d, triangles: r.triangles }] };
      fi = j.files.length - 1;
    }
    const gid = ++gidN;
    const add: Obj[] = Array.from({ length: Math.max(1, copies) }, () => ({ uid: nextUid(), gid, file: fi, slot, placement: null, plate: null }));
    return { ...j, objects: [...j.objects, ...add] };
  };

  /**
   * SEPARATE + LAY FLAT one mesh (founder 2026-10-16: automatic). Every solid
   * becomes its own part, laid on its best face; a degenerate fragment is not
   * added and is NAMED in the returned text, never dropped silently.
   */
  const prepare = (name: string, tri: Float32Array): { parts: { name: string; tri: Float32Array; flat: string }[]; text: string[] } => {
    const comps = separate(tri);
    const base = baseName(name);
    const partName = (k: number) => (comps.length === 1 ? base : `${base}_part${k + 1}`);
    const parts: { name: string; tri: Float32Array; flat: string }[] = [];
    comps.forEach((c, k) => {
      if (c.degenerate) return;
      const f = layFlat(c.tri);
      parts.push({ name: `${partName(k)}.stl`, tri: f.tri, flat: `${partName(k)}: ${f.text}` });
    });
    const text = [separationText(base, comps, partName), ...parts.map((p) => `${p.flat}.`)];
    if (!comps.length) text.splice(0, 1, `${base}: no triangles could be read, nothing added.`);
    return { parts, text };
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files];
    const errs: string[] = list.filter((f) => !/\.stl$/i.test(f.name)).map((f) => `${f.name}: STL files only, skipped`);
    let j = jobRef.current;
    let added = 0;
    const notes: string[] = [];
    for (const f of list.filter((x) => /\.stl$/i.test(x.name))) {
      try {
        const prep = prepare(f.name, parseStl(await f.arrayBuffer()));
        notes.push(...prep.text);
        for (const p of prep.parts) {
          j = await addMesh(j, p.name, p.tri, defaultSlot());
          added++;
        }
      } catch (e) {
        errs.push(`${f.name}: ${msg(e)}`);
      }
    }
    if (added) {
      if (j.name === 'job') j = { ...j, name: list.length === 1 ? baseName(list[0].name) : `${j.files.length}-part job` };
      setJob(j);
    }
    setProblems(errs);
    if (added) notes.push(await relayout(j));
    setLayoutNote(notes.filter(Boolean).join(' '));
  };

  /* ── a design sent here from the design page (founder 2026-10-15: "open in 3d") ──
   * It arrives as an STL built by 2bee.cad's mesher (shop/toCnc.ts designToStl) and goes
   * through `addFiles`, the same door as a dropped file. It is HELD until the slicer
   * bridge is ready, because the upload goes to the bridge — and the wait is said on screen. */
  const [incoming, setIncoming] = useState<Pending3d | null>(null);
  useEffect(() => {
    const held = claimPendingFor('3d');
    if (held) setIncoming(held);
    return subscribeHandoffFor('3d', setIncoming);
  }, []);
  /* Founder 2026-11-13: "the cad and 3d should able to handle variables like turn on/off
   * features". A design that came with its source keeps it here, with the rows its STL
   * became, so a variable change rebuilds the STL (same mesher, same refusals) and swaps
   * those rows. A dropped STL has no source and gets no variables. */
  const [designs, setDesigns] = useState<{ design: PendingDesign; gids: number[]; busy: boolean; note: string }[]>([]);
  /** Add an STL and return the row ids it became. */
  const addStlRows = async (stl: Pending3d['stl']): Promise<number[]> => {
    const before = gidN;
    await addFiles([new File([stl.bytes.slice().buffer as ArrayBuffer], stl.name, { type: 'model/stl' })]);
    return Array.from({ length: gidN - before }, (_, k) => before + 1 + k);
  };
  useEffect(() => {
    if (!incoming || !engineSet || !slotsReply || !profiles) return;
    const d = incoming;
    setIncoming(null);
    void (async () => {
      const gids = await addStlRows(d.stl);
      const { stl: _stl, ...design } = d;
      if (gids.length) setDesigns((old) => [...old, { design, gids, busy: false, note: '' }]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, engineSet, slotsReply, profiles]);
  const changeDesignParam = async (k: number, p: Param, v: ParamValue) => {
    const cur = designs[k];
    if (!cur || cur.busy) return;
    let source: string;
    try {
      source = setParam(cur.design.source, p, v);
    } catch (e) {
      setDesigns((old) => old.map((x, i) => (i === k ? { ...x, note: msg(e) } : x)));
      return;
    }
    const design = { ...cur.design, source, files: { ...cur.design.files, [cur.design.path]: source } };
    setDesigns((old) => old.map((x, i) => (i === k ? { ...x, busy: true, note: '' } : x)));
    const r = await designToStl(design);
    if (!r.ok) {
      setDesigns((old) => old.map((x, i) => (i === k ? { ...x, busy: false, note: `${p.name} was NOT changed: ${r.why}` } : x)));
      return;
    }
    /* The old rows go, the new STL comes in through the same door, on the slot the old rows used. */
    const slot = jobRef.current.objects.find((o) => cur.gids.includes(o.gid))?.slot;
    /* Each old row's OWN settings (walls 5 for this part, say) are carried to the rebuilt rows: by
     * position when the rebuild has the same number of parts, to every row when all old rows agreed,
     * and otherwise dropped WITH a note, never silently (bughunt 2026-11-13: they were always lost). */
    const ownOf = (g: number) => jobRef.current.objects.find((o) => o.gid === g)?.overrides;
    const oldOwn = cur.gids.map(ownOf);
    let j = jobRef.current;
    for (const g of cur.gids) j = withoutRow(j, g);
    setJob(j);
    const gids = await addStlRows(r.stl);
    const same = (a?: Record<string, string>, b?: Record<string, string>) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
    const anyOwn = oldOwn.some((o) => o && Object.keys(o).length > 0);
    const ownFor: (i: number) => Record<string, string> | undefined =
      !anyOwn ? () => undefined
      : gids.length === oldOwn.length ? (i) => oldOwn[i]
      : oldOwn.every((o) => same(o, oldOwn[0])) ? () => oldOwn[0]
      : () => undefined;
    const lostOwn = anyOwn && gids.length !== oldOwn.length && !oldOwn.every((o) => same(o, oldOwn[0]));
    setJob({
      ...jobRef.current,
      objects: jobRef.current.objects.map((o) => {
        const i = gids.indexOf(o.gid);
        if (i < 0) return o;
        const own = ownFor(i);
        return { ...o, ...(slot ? { slot } : {}), ...(own && Object.keys(own).length ? { overrides: { ...own } } : {}) };
      }),
    });
    const note = !gids.length
      ? 'The rebuilt STL added no parts.'
      : lostOwn
        ? `The rebuild has ${gids.length} part(s) where there were ${oldOwn.length}, so the parts' own settings could not be matched and were dropped.`
        : '';
    setDesigns((old) => old.map((x, i) => (i === k ? { design, gids, busy: false, note } : x)));
  };

  const changeQty = async (gid: number, n: number) => {
    setRowNote('');
    const j = withQty(jobRef.current, gid, n, nextUid);
    if (j === jobRef.current) return;
    setJob(j);
    await relayout(j);
  };
  // Clone = a NEW row of the same part, with its own settings from then on (founder 2026-11-13). Quantity keeps
  // making identical copies inside one row.
  const cloneRow = async (gid: number) => {
    setRowNote('');
    const j = withClonedRow(jobRef.current, gid, nextUid, ++gidN);
    if (j === jobRef.current) return;
    setJob(j);
    await relayout(j);
  };
  const removeRow = async (gid: number) => {
    const j = withoutRow(jobRef.current, gid);
    setJob(j);
    setRowNote('');
    // The layout note describes the parts as they were added (founder 2026-10-20: it stayed
    // after every part was removed). It is cleared with the last part and rewritten otherwise.
    if (!j.objects.length) {
      setPlan({ tooBig: [], note: '' });
      platesRef.current = {};
      setPlatesState({});
      setLayoutNote('');
      return;
    }
    setLayoutNote(await relayout(j));
  };
  const setRowSlot = (gid: number, slot: string) => {
    setJob({ ...jobRef.current, objects: jobRef.current.objects.map((o) => (o.gid === gid ? { ...o, slot } : o)) });
  };
  /** The mesh of a row, from this page or (after a reload) from the bridge. */
  const meshOf = async (sha: string): Promise<Float32Array> => {
    const have = tris.current.get(sha);
    if (have && have.length) return have;
    const t = parseStl(await engine.bytes('GET', `/v1/job/file/${sha}`));
    tris.current.set(sha, t);
    return t;
  };

  /**
   * The assistant's layout actions (separate / lay flat / rotate / arrange),
   * already through `validateLayoutActions`. Each one goes through the path a
   * new part takes, and the parts are arranged again at the end.
   */
  const onLayout = async (actions: LayoutAction[]): Promise<string> => {
    const out: string[] = [];
    let j = jobRef.current;
    let changed = false;
    try {
      for (const a of actions) {
        if (a.do === 'arrange') {
          j = { ...j, layout: 'app' };
          changed = true;
          continue;
        }
        const rs = rows(j);
        const targets = a.do === 'separate' || (a.do === 'lay_flat' && a.part === null) ? rs : [rs[(a.part ?? 0) - 1]].filter(Boolean);
        for (const r of targets) {
          const f = j.files[r.first.file];
          const tri = await meshOf(f.sha256);
          const nm = baseName(f.name);
          let next: { name: string; tri: Float32Array }[] | null = null;
          if (a.do === 'separate') {
            const prep = prepare(f.name, tri);
            if (prep.parts.length < 2 && !prep.text.some((t) => /Not added/.test(t))) {
              out.push(`${nm}: one object, nothing to separate.`);
              continue;
            }
            out.push(...prep.text);
            next = prep.parts.map((p) => ({ name: p.name, tri: p.tri }));
          } else if (a.do === 'lay_flat') {
            const fl = layFlat(tri);
            out.push(`${nm}: ${fl.text}.`);
            if (fl.angle === 0) continue;
            next = [{ name: f.name, tri: fl.tri }];
          } else if (a.do === 'rotate') {
            const t2 = rotatePart(tri, a.axis, a.deg);
            const ca = contactArea(t2);
            out.push(
              `${nm}: turned ${a.deg}° about ${a.axis.toUpperCase()}, now ${sizeText(sizeOf(bbox(t2)))}, ${Math.round(ca)} mm² on the plate.` +
                (ca < 1 ? ' It now stands on an edge or a point: lay it flat or turn it back before printing.' : ''),
            );
            next = [{ name: f.name, tri: t2 }];
          }
          if (!next) continue;
          const copies = r.copies.length;
          const slot = r.first.slot;
          j = withoutRow(j, r.gid);
          for (const p of next) j = await addMesh(j, p.name, p.tri, slot, copies);
          changed = true;
        }
      }
    } catch (e) {
      out.push(`Stopped: ${msg(e)}. What was done before this is kept.`);
    }
    if (changed) {
      if (!actions.some((a) => a.do === 'arrange') && j.layout === 'bridge') out.push('Placed by the bridge strategy you chose; ask "arrange" to have this app place them again.');
      setJob(j);
      out.push(await relayout(j));
    }
    const text = out.filter(Boolean).join(' ') || 'Nothing to change.';
    setLayoutNote(text);
    return text;
  };

  /* ── what the assistant changes ──────────────────────────────────────── */
  const arrangementText = (moved: number, appText = '') => {
    const j = jobRef.current;
    const nums = plateNumbers(j);
    const lead = moved ? `${moved} part${moved > 1 ? 's' : ''} moved. ` : 'Already the best layout I found: nothing moved. ';
    const per = nums
      .map((b) => {
        const st = platesRef.current[b];
        const op = st?.result?.optimise;
        if (op) return `${nums.length > 1 ? `Plate ${b}: ` : ''}${op.reason}`;
        return st?.status === 'current' ? '' : `Plate ${b}: ${st?.status === 'failed' ? `failed (${(st.error ?? '').split('\n')[0]})` : 'not sliced yet'}.`;
      })
      .filter(Boolean);
    if (j.layout === 'app') return `${lead}${appText || 'Arranged by this app.'} ${per.join(' ')}`.trim();
    const strat = STRATEGIES.find((s) => s.id === j.strategy)?.label ?? j.strategy;
    const obj = OBJECTIVES.find((o) => o.id === j.objective)?.label ?? j.objective;
    return `${lead}${strat}; arranged for ${obj}${j.allowTilt ? '' : '; every part stays upright'}. ${nums.length} plate${nums.length === 1 ? '' : 's'}. ${per.join(' ')}`.trim();
  };
  const snap = () => JSON.stringify(jobRef.current.objects.map((o) => [o.plate ?? 0, o.placement]));
  const movedCount = (before: string) => {
    const a = JSON.parse(before) as unknown[];
    const b = JSON.parse(snap()) as unknown[];
    return b.filter((x, i) => JSON.stringify(x) !== JSON.stringify(a[i])).length + Math.max(0, b.length - a.length);
  };

  const onArrange = async (o: { strategy?: Strategy; objective?: Objective; allowTilt?: boolean }) => {
    const before = snap();
    // A bridge strategy or objective is the person's explicit choice: from here the bridge arranges (and may move parts within a plate).
    const j: JobState = {
      ...jobRef.current,
      layout: 'bridge',
      ...(o.strategy ? { strategy: o.strategy } : {}),
      ...(o.objective ? { objective: o.objective } : {}),
      ...(typeof o.allowTilt === 'boolean' ? { allowTilt: o.allowTilt } : {}),
    };
    setJob(j);
    if (o.strategy || jobRef.current.objects.some((x) => !x.plate)) await rearrange(j);
    await flushSlice();
    return arrangementText(movedCount(before));
  };
  const onReset = async () => {
    const before = snap();
    const j: JobState = { ...jobRef.current, strategy: 'fit', objective: 'balanced', allowTilt: true, layout: 'app' };
    setJob(j);
    const t = await relayout(j);
    await flushSlice();
    return arrangementText(movedCount(before), t);
  };

  /* ── save / load ─────────────────────────────────────────────────────── */
  const [jobMsg, setJobMsg] = useState('');
  const [saved, setSaved] = useState<{ id: string; name: string; saved?: string; objects: number; error?: string }[] | null>(null);
  const refreshSaved = async () => {
    try {
      const r = await engine.json<{ jobs: { id: string; name: string; saved?: string; objects: number; error?: string }[] }>('GET', '/v1/job/list');
      setSaved(r.jobs);
    } catch (e) {
      setJobMsg(`Saved jobs unavailable: ${msg(e)}`);
    }
  };
  const saveJob = async () => {
    setJobMsg('Saving…');
    try {
      const r = await engine.json<{ id: string; path: string }>('POST', '/v1/job/save', { job: saveBody(jobRef.current, buildPlate) }, 60000);
      setJobMsg(`Saved as ${r.id} (${r.path}).`);
      void refreshSaved();
    } catch (e) {
      setJobMsg(`Not saved: ${msg(e)}`);
    }
  };
  const loadJob = async (src: { id: string } | { job: unknown }) => {
    setJobMsg('Loading…');
    try {
      const r = await engine.json<{ job: { name: string; process?: string; files: JobState['files']; objects: { file: number; slot: string; placement: Placement | null; bed?: number; qty?: number; overrides?: Record<string, string> }[]; slotPresets?: Record<string, string>; overrides?: Record<string, string>; objective?: Objective; allowTilt?: boolean } }>(
        'POST',
        '/v1/job/load',
        src,
        120000,
      );
      const J = r.job;
      for (const f of J.files) if (!tris.current.has(f.sha256)) tris.current.set(f.sha256, parseStl(await engine.bytes('GET', `/v1/job/file/${f.sha256}`)));
      const objects: Obj[] = [];
      for (const o of J.objects) {
        const q = Math.max(1, Math.round(Number(o.qty)) || 1);
        const gid = ++gidN;
        for (let k = 0; k < q; k++)
          objects.push({ uid: nextUid(), gid, file: o.file, slot: o.slot, placement: q === 1 ? o.placement : null, plate: q === 1 && o.bed ? o.bed : null, ...(o.overrides ? { overrides: { ...o.overrides } } : {}) });
      }
      const procOk = J.process && profiles?.process.some((x) => x.name === J.process);
      const j: JobState = {
        ...EMPTY_JOB,
        name: J.name,
        files: J.files,
        objects,
        slotPresets: J.slotPresets ?? {},
        overrides: J.overrides ?? {},
        process: procOk ? J.process! : jobRef.current.process,
        objective: OBJECTIVES.some((x) => x.id === J.objective) ? J.objective! : 'balanced',
        allowTilt: J.allowTilt !== false,
      };
      platesRef.current = {};
      setPlatesState({});
      setJob(j);
      setJobMsg(`Loaded "${J.name}" (${objects.length} part${objects.length === 1 ? '' : 's'}).${procOk || !J.process ? '' : ` Its process "${J.process}" is not on this computer; using "${j.process}".`}`);
      if (!objects.every((o) => o.placement && o.plate)) await relayout(j);
    } catch (e) {
      setJobMsg(`Not loaded: ${msg(e)}`);
    }
  };
  const download = async (path: string, name: string) => {
    try {
      const text = await engine.text(path, 60000);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setProblems((ps) => [...ps, `Download failed: ${msg(e)}`]);
    }
  };

  /* ── derived ─────────────────────────────────────────────────────────── */
  const nums = plateNumbers(job);
  const effStatus = (b: number): PlateStatus => {
    if (waitingReason(job, b, slots) && platesRef.current[b]?.status !== 'slicing') return 'waiting';
    const st = plates[b];
    if (!st) return 'stale';
    if ((st.status === 'current' || st.status === 'failed') && st.fp !== plateFp(job, b, buildPlate, slots)) return 'stale';
    return st.status;
  };
  const statusText = (b: number) => {
    const e = effStatus(b);
    if (e === 'waiting') return waitingReason(job, b, slots);
    if (e === 'failed') return `Failed: ${(plates[b]?.error ?? 'slice failed').split('\n')[0].slice(0, 90)}`;
    return STATUS_TEXT[e];
  };
  const showPlate = nums.includes(curPlate) ? curPlate : (nums[0] ?? 1);
  const cur = plates[showPlate];
  const curEff = nums.length ? effStatus(showPlate) : null;
  const result = cur?.result ?? null;

  const slotOf = (id: string) => slots.find((s) => s.id === id);
  const colorOf = (id: string) => slotOf(id)?.color ?? '#4caf88';
  const parts: PlatePart[] = useMemo(
    () =>
      plateObjects(job, showPlate)
        .map((o) => ({ uid: o.uid, tri: tris.current.get(job.files[o.file]?.sha256 ?? '') ?? new Float32Array(0), color: colorOf(o.slot), placement: o.placement }))
        .filter((p) => p.tri.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job, showPlate, slots],
  );

  const tooBigOf = new Map(plan.tooBig.map((t) => [t.index, t]));
  const thumb = (sha: string, color: string) => {
    const key = `${sha}|${color}`;
    if (!thumbs.current.has(key)) {
      const t = tris.current.get(sha);
      thumbs.current.set(key, t ? thumbDataUrl(t, color) : '');
    }
    return thumbs.current.get(key) ?? '';
  };

  let totals = '';
  if (nums.length > 1) {
    let tot = 0, fil = 0, have = 0;
    for (const b of nums) {
      const r = plates[b]?.result;
      if (r && effStatus(b) === 'current') {
        have++;
        tot += secsOf(r.stats.totalTime);
        fil += gramsTotal(r.stats.filamentG);
      }
    }
    totals = `${nums.length} plates, ${have === nums.length ? `total ${hms(tot)}, ${fil.toFixed(1)} g` : `${have} of ${nums.length} sliced${have ? `, so far ${hms(tot)}, ${fil.toFixed(1)} g` : ''}`}`;
  }

  const busyText = planning ? 'Arranging…' : progress ? (progress.total > 1 ? `Slicing plate ${Math.min(progress.total, progress.done + 1)} of ${progress.total}…` : 'Slicing…') : '';
  const used = usedSlots(job);
  // The selected part's row (null when nothing is selected): the AI's per-part settings go there.
  const selRow = (() => {
    const all = rows(job);
    const k = all.findIndex((r) => r.copies.some((c) => c.uid === sel));
    if (k < 0) return null;
    return { row: all[k], n: k + 1, name: baseName(job.files[all[k].first.file]?.name ?? '') };
  })();
  const slotsUsedHere = [...new Set(plateObjects(job, showPlate).map((o) => o.slot))].map((id) => slotOf(id) ?? { id, label: id, type: '', color: '#ffffff' });
  const notReady = !nums.length
    ? 'Add a part: the plates are arranged and sliced automatically.'
    : curEff === 'waiting'
      ? waitingReason(job, showPlate, slots)
      : curEff === 'failed'
        ? 'This plate did not slice; see the reason above the printer card.'
        : 'The plate is being arranged and sliced; the upload opens when it is up to date.';

  const r1 = result && curEff === 'current' ? result : null;
  const warnings = r1
    ? [
        ...r1.warnings,
        ...r1.slotChecks.filter((c) => !c.ok).map((c) => `Slot ${c.slot} holds ${c.slotType} but its preset "${c.preset}" is ${c.presetType}.`),
        ...(r1.stats.bedType && r1.bedRequested && r1.stats.bedType !== r1.bedRequested ? [`The G-code names "${r1.stats.bedType}", not the requested "${r1.bedRequested}".`] : []),
      ]
    : [];

  /* ── sliced view (founder 2026-11-12: "Can we see the exact sliced object in the 3d?") ──
   * The toolpath is read from THIS slice's G-code (GET /v1/gcode/<id>), fetched when "Sliced" is chosen. When it
   * cannot be fetched or parsed the view says so and draws nothing: never the mesh under the "Sliced" label. */
  const [view3d, setView3d] = useState<'model' | 'sliced'>('model');
  const [tp, setTp] = useState<{ id: string; path: Toolpath | null; error: string | null } | null>(null);
  const [layerSel, setLayerSel] = useState<number | null>(null);
  const [showTravel, setShowTravel] = useState(false);
  const wantTp = useRef<string | null>(null);
  const slicedView = view3d === 'sliced' && !!r1;
  const tpHere = r1 && tp && tp.id === r1.id ? tp : null;
  useEffect(() => {
    if (view3d !== 'sliced' || !r1 || wantTp.current === r1.id) return;
    const id = r1.id;
    wantTp.current = id;
    setTp({ id, path: null, error: null });
    setLayerSel(null);
    void (async () => {
      let next: { id: string; path: Toolpath | null; error: string | null };
      try {
        next = { id, path: parseGcode(await engine.text(`/v1/gcode/${id}`, 60000)), error: null };
      } catch (e) {
        next = { id, path: null, error: msg(e) };
      }
      if (wantTp.current === id) setTp(next);
    })();
  }, [view3d, r1, engine]);
  useEffect(() => {
    // a failed read is retried on the next "Sliced" click, not in a loop
    if (view3d === 'model' && tp?.error) wantTp.current = null;
  }, [view3d, tp]);
  const tpTop = tpHere?.path ? tpHere.path.layers.length - 1 : 0;
  const tpLayer = layerSel === null ? tpTop : Math.min(layerSel, tpTop);

  /* ── gates (founder 2026-10-16: the right column; Upload stays off until all pass) ── */
  const [printerState, setPrinterState] = useState<PrinterCardState>({ check: { kind: 'checking' }, ticked: false, calibrated: false, reported: null });

  /* ── filament slots follow the printer (founder 2026-10-22) ──────────────
   * Whenever the printer card reads the printer, the stored slots are brought in line with its report and saved to
   * the slicer bridge, so the slicer, the checklist and the gates all see the spool that is really loaded. A type the
   * slicer does not know is refused (the slot stays empty) and said here. Gate FILAMENT stays red while the two disagree. */
  const [slotSyncNote, setSlotSyncNote] = useState('');
  const syncing = useRef(false);
  useEffect(() => {
    const rep = printerState.reported;
    if (!rep || !slotsReply || syncing.current) return;
    const r = syncSlots(slotsReply.slots, rep, slotsReply.types ?? []);
    setSlotSyncNote(r.unknown.length ? `The printer reports ${r.unknown.map((u) => `${u.type} in ${u.label}`).join(', ')}: not a filament type the slicer knows, so that slot counts as empty.` : '');
    if (!r.changed) return;
    syncing.current = true;
    (async () => {
      try {
        const out = await engine.json<SlotsReply>('PUT', '/v1/slots', { bedPlate: slotsReply.bedPlate, slots: r.slots.map((s) => ({ id: s.id, type: s.type, color: s.color })) });
        setSlotsReply({ ...out, types: out.types ?? slotsReply.types ?? [], bedTypes: out.bedTypes ?? slotsReply.bedTypes ?? [] });
        thumbs.current.clear();
      } catch (e) {
        setSlotSyncNote(`The printer's filament slots could not be saved to the slicer bridge: ${msg(e)}`);
      } finally {
        syncing.current = false;
      }
    })();
  }, [printerState.reported, slotsReply, engine]);
  const slicedBy = r1?.engine ? { name: engineName(r1.engine), printed: enginePrinted } : null;
  const [recheck, setRecheck] = useState(0);
  const gates = printGates({
    parts: job.objects.length,
    plate: nums.length ? showPlate : null,
    slice:
      r1
        ? { status: 'current', warnings: r1.warnings, slotChecks: r1.slotChecks, bedType: r1.stats.bedType, bedRequested: r1.bedRequested ?? null, layers: r1.stats.layers ? Number(r1.stats.layers) : null }
        : curEff === 'failed'
          ? { status: 'failed', error: cur?.error ?? 'slice failed' }
          : { status: curEff === 'waiting' ? 'waiting' : curEff === 'slicing' ? 'slicing' : 'stale', detail: nums.length ? statusText(showPlate) : '' },
    tooBig: plan.tooBig.map((t) => ({ name: t.name, reason: t.reason })),
    unplaced: job.objects.filter((o) => !o.plate && !tooBigOf.has(job.objects.indexOf(o))).length,
    arrangeError: problems.find((x) => x.startsWith('Arranging failed')) ?? null,
    partSlots: job.objects.map((o) => o.slot),
    slots: slotsReply ? slots.map((x) => ({ id: x.id, label: x.label, type: x.type })) : null,
    reported: printerState.reported,
    printer: printerState.check,
    checklistTicked: printerState.ticked,
    engine: slicedBy,
    calibrationAck: printerState.calibrated,
  });
  const firstBlock = gates.find((x) => x.state !== 'PASS');
  const [fixing, setFixing] = useState(false);
  const [fixNotes, setFixNotes] = useState<string[]>([]);
  /* "Fix with AI" (founder: "automatically fix the issues with the ai agent where
   * possible"). Every fix goes through the path a hand change takes (re-slice,
   * arrange, the slot select) and the gates re-check the result. Anything at the
   * printer is said, never set. */
  const fixPrint = async () => {
    setFixing(true);
    const notes: string[] = [];
    try {
      const g = Object.fromEntries(gates.map((x) => [x.id, x]));
      if (g.parts?.state === 'FAIL') notes.push('Parts: drop an STL on the left; there is nothing to fix without one.');
      if (g.filament?.state === 'FAIL') {
        const decl = slots.filter((x) => x.type);
        const bad = [...new Set(job.objects.map((o) => o.slot))].filter((id) => !decl.some((x) => x.id === id));
        if (bad.length) {
          let pick: string | null = null;
          if (decl.length > 1) {
            /* The AI picks among DECLARED slots only; `assignSlots` ignores anything else. */
            try {
              const cfg = (() => { try { return readAskConfig(globalThis.localStorage); } catch { return readAskConfig(null); } })();
              const names = [...new Set(job.objects.filter((o) => bad.includes(o.slot)).map((o) => baseName(job.files[o.file]?.name ?? '')))];
              const res = await (transport ?? fetchTransport)(
                {
                  url: cfg.endpoint,
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
                  body: {
                    model: cfg.model,
                    messages: [
                      { role: 'system', content: 'Choose ONE filament slot for these 3D-printed parts, from the list. Answer JSON only: {"slot": "<id from the list>", "why": "<short>"}.' },
                      { role: 'user', content: `Parts: ${names.join(', ')}. Process: ${job.process}. Slots: ${decl.map((x) => `${x.id} (${x.label}: ${x.type})`).join(' | ')}` },
                    ],
                    temperature: 0,
                    stream: false,
                  },
                },
                AbortSignal.timeout(cfg.timeoutMs || 30000),
              );
              const r = readReply(res);
              if (r.ok) pick = /"slot"\s*:\s*"([^"]+)"/.exec(r.raw)?.[1] ?? null;
            } catch {
              /* no AI: the first declared slot, said below */
            }
          }
          const next = assignSlots(jobRef.current.objects.map((o) => o.slot), slots, pick);
          if (next) {
            setJob({ ...jobRef.current, objects: jobRef.current.objects.map((o, k) => ({ ...o, slot: next[k] })) });
            const to = decl.find((x) => x.id === pick) ?? decl[0];
            notes.push(`Filament: parts on ${bad.join(', ')} moved to ${to.label} (${to.type})${pick && pick === to.id ? ', chosen by the AI' : decl.length > 1 ? ', the first declared slot (the AI did not choose one)' : ''}. Check that spool is really in it.`);
          } else notes.push(printerState.reported ? 'Filament: the printer reports no loaded slot the slicer knows. Load a spool; it shows here within 30 s.' : 'Filament: no slot is declared. Load a spool and declare it (Printers → Build plate and filament slots); the printer is not read without --serial.');
        } else if (r1) {
          const mis = r1.slotChecks.filter((c) => !c.ok);
          const sp = { ...jobRef.current.slotPresets };
          const cleared = mis.filter((c) => sp[c.slot]).map((c) => c.slot);
          for (const id of cleared) delete sp[id];
          if (cleared.length) {
            setJob({ ...jobRef.current, slotPresets: sp });
            notes.push(`Filament: the preset chosen for ${cleared.join(', ')} did not match the declared filament; it is back to the preset for that filament.`);
          } else notes.push('Filament: the declared filament and its preset disagree; correct the slot declaration (Printers).');
        }
      }
      if (g.fit?.state === 'FAIL' || g.fit?.state === 'PENDING') {
        if (plan.tooBig.length) notes.push(`Fit: ${plan.tooBig.map((t) => t.name).join(', ')} fits on no plate; scale it in the design or remove it. Not changed unseen.`);
        else if (job.objects.length) {
          notes.push(`Fit: arranged again. ${await relayout(jobRef.current)}`.trim());
        }
      }
      if (g.sliced?.state === 'FAIL' && nums.length) {
        setPlate(showPlate, null);
        await flushSlice();
        notes.push(`Slice: plate ${showPlate} sliced again; the gate shows the new result.`);
      }
      if (g.bridge?.state === 'FAIL') {
        if (printerState.check.kind === 'unset') {
          setShowConn(true);
          notes.push('Printer: the printer bridge is not set up; Connections is open.');
        } else {
          setRecheck((n) => n + 1);
          notes.push('Printer: asked the printer bridge again.');
        }
      }
      if (g.code?.state === 'FAIL') notes.push('Access code: only you can give it (restart the printer bridge with --code-file). Then press "check again" on the gate.');
      if (g.checklist?.state === 'FAIL') notes.push('Checklist: only a person at the printer can tick it.');
      if (g.engine?.state === 'FAIL') notes.push('Engine: only a person at the printer can mark the first print as a calibration print.');
    } finally {
      setFixNotes(notes);
      setFixing(false);
    }
  };
  const panelGates = gates.map((x) =>
    x.id === 'code' && x.state === 'FAIL'
      ? { ...x, action: { label: 'I gave the code: check again', onClick: () => setRecheck((n) => n + 1) } }
      : (x.id === 'checklist' || x.id === 'engine') && x.state === 'FAIL'
        ? { ...x, action: { label: 'Go to the checklist', onClick: () => document.querySelector('[data-testid="p3d-upload"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) } }
        : x,
  );

  return (
    <div className="p3d" data-testid="print3d-tab">
      <header className="p3d-top">
        <div className="p3d-title">
          <strong>2bee.3d</strong>
          <span className="p3d-sub">3D printing for the Bambu Lab X2D</span>
        </div>
        <button type="button" className="p3d-connbtn" onClick={() => setShowConn((s) => !s)} aria-expanded={showConn} data-testid="p3d-conn-toggle">
          <span className={`p3d-dot ${health.kind === 'ok' ? 'p3d-up' : 'p3d-down'}`} aria-hidden="true" /> Connections
        </button>
      </header>
      <p className="p3d-banner" role="note" data-testid="p3d-banner">
        Nothing has been printed from this tab. Parts are separated, laid flat and arranged by this app; slicing runs on this computer with 2bee.fdm, this app’s own
        engine, which has not printed yet: the first print is a calibration print. It only uploads: the print is started on the printer’s screen, after the checklist.
      </p>
      {showConn && <Connections bridges={bridges} onChange={setBridges} fetchImpl={fetchImpl} />}
      {health.kind !== 'ok' && (
        <p className={health.kind === 'bad' ? 'p3d-err' : 'p3d-sub'} data-testid="p3d-health">
          {health.text}
        </p>
      )}

      <div className="p3d-main">
        <aside className="p3d-left">
          <section className="p3d-panel">
            <DropZone disabled={!engineSet || !slotsReply || !profiles} onFiles={(f) => void addFiles(f)} />
            {incoming ? (
              <p className="p3d-sub" role="status" data-testid="p3d-incoming">
                "{incoming.title}" from the design page is waiting for the slicer bridge — it is added as soon as the bridge answers.
              </p>
            ) : null}
            {designs.map((x, k) =>
              x.gids.some((g) => job.objects.some((o) => o.gid === g)) ? (
                <div key={`${x.design.id}:${k}`} data-testid="p3d-params">
                  <ParamsPanel
                    source={x.design.source}
                    busy={x.busy}
                    note={`${x.design.title}: a change rebuilds its STL and replaces its parts (copies go back to one).`}
                    onChange={(p, v) => void changeDesignParam(k, p, v)}
                  />
                  {x.note ? <p className="p3d-sub" role="alert">{x.note}</p> : null}
                </div>
              ) : null,
            )}
            <div aria-label="Parts in this job" data-testid="p3d-objects">
              {rows(job).map((r, n) => {
                const f = job.files[r.first.file];
                const qty = r.copies.length;
                const big = r.copies.map((c) => tooBigOf.get(job.objects.indexOf(c))).find(Boolean);
                const s = slotOf(r.first.slot);
                const nm = baseName(f?.name ?? '');
                const t = f ? thumb(f.sha256, colorOf(r.first.slot)) : '';
                return (
                  <div
                    key={r.gid}
                    className={`p3d-obj${r.copies.some((c) => c.uid === sel) ? ' p3d-sel' : ''}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('select,input,button')) return;
                      // A second click on the selected part deselects it: the AI's settings go to the whole plate again.
                      if (r.copies.some((c) => c.uid === sel)) return setSel(null);
                      setSel(r.first.uid);
                      if (r.first.plate) setCurPlate(r.first.plate);
                    }}
                    data-testid={`p3d-row-${n + 1}`}
                  >
                    {t ? <img src={t} alt="" /> : <div className="p3d-noimg" />}
                    <div className="p3d-objbody">
                      <div className="p3d-nm">
                        {n + 1}. {nm}
                        {qty > 1 && <b className="p3d-qtyx"> x{qty}</b>} <small>{f?.size3d ? `${f.size3d.x} x ${f.size3d.y} x ${f.size3d.z} mm` : ''}</small>
                      </div>
                      <div className="p3d-ctl">
                        <span className="p3d-sw" style={{ background: colorOf(r.first.slot) }} aria-hidden="true" />
                        <select value={r.first.slot} onChange={(e) => setRowSlot(r.gid, e.target.value)} aria-label={`Filament slot for ${nm}`} data-testid={`p3d-row-slot-${n + 1}`}>
                          {slots.map((sl) => (
                            <option key={sl.id} value={sl.id}>
                              {sl.label}: {sl.type || 'empty'}
                            </option>
                          ))}
                        </select>
                        <span className="p3d-qty" role="group" aria-label={`Quantity of ${nm}`}>
                          <button type="button" disabled={qty <= 1} onClick={() => void changeQty(r.gid, qty - 1)} aria-label={`One copy less of ${nm}`}>
                            -
                          </button>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            defaultValue={qty}
                            key={qty}
                            onBlur={(e) => void changeQty(r.gid, Number(e.target.value))}
                            aria-label={`Quantity of ${nm}`}
                            data-testid={`p3d-row-qty-${n + 1}`}
                          />
                          <button type="button" onClick={() => void changeQty(r.gid, qty + 1)} aria-label={`One copy more of ${nm}`}>
                            +
                          </button>
                        </span>
                        <button type="button" onClick={() => void cloneRow(r.gid)} title={`A new row of ${nm}, whose settings can differ`} data-testid={`p3d-row-clone-${n + 1}`}>
                          Clone
                        </button>
                        <button type="button" onClick={() => void removeRow(r.gid)} aria-label={`Remove ${nm}`} data-testid={`p3d-row-rm-${n + 1}`}>
                          Remove
                        </button>
                      </div>
                      {r.first.overrides && Object.keys(r.first.overrides).length > 0 && (
                        <div className="p3d-sub" data-testid={`p3d-row-own-${n + 1}`}>
                          Own settings: {Object.entries(r.first.overrides).map(([k, v]) => `${OBJECT_KEY_LABEL[k] ?? k} ${v}`).join(' · ')}{' '}
                          <button type="button" onClick={() => setJob(withRowOverrides(jobRef.current, r.gid, {}))} data-testid={`p3d-row-own-clear-${n + 1}`}>
                            Use the plate's
                          </button>
                        </div>
                      )}
                      {big && <div className="p3d-err">{big.reason}. Remove it or scale it down; nothing is sliced until then.</div>}
                      {s && !s.type && (
                        <div className="p3d-warn">
                          {(() => {
                            const rp = printerState.reported?.find((x) => x.id === s.id);
                            if (!rp) return `Declare the filament in ${s.label} (Printers, Build plate and filament slots).`;
                            return rp.type
                              ? `The printer reports ${rp.type} in ${s.label}, which the slicer does not know. Pick another slot.`
                              : `The printer reports ${s.label} empty. Load a spool there or pick a loaded slot.`;
                          })()}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {rowNote && <p className="p3d-warn">{rowNote}</p>}
              {layoutNote && (
                <p className="p3d-sub" role="status" data-testid="p3d-layout-note">
                  {layoutNote}
                </p>
              )}
            </div>
            <details
              className="p3d-jobs"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) void refreshSaved();
              }}
            >
              <summary>Job: save and load</summary>
              <div className="p3d-row">
                <button type="button" disabled={!job.objects.length || !engineSet} onClick={() => void saveJob()}>
                  Save job
                </button>
                <label className="p3d-filebtn">
                  Load from file
                  <input
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      try {
                        await loadJob({ job: JSON.parse(await f.text()) });
                      } catch (err) {
                        setJobMsg(`Not loaded: ${msg(err)}`);
                      }
                    }}
                  />
                </label>
              </div>
              {jobMsg && <p className="p3d-sub">{jobMsg}</p>}
              {saved && saved.length === 0 && <p className="p3d-sub">No saved jobs yet.</p>}
              {saved?.slice(0, 12).map((x) =>
                x.error ? null : (
                  <div key={x.id} className="p3d-row">
                    <span className="p3d-grow">
                      {x.name} <small className="p3d-sub">{x.objects} parts, {(x.saved ?? '').slice(0, 16).replace('T', ' ')}</small>
                    </span>
                    <button type="button" onClick={() => void loadJob({ id: x.id })}>
                      Load
                    </button>
                    <button type="button" onClick={() => void download(`/v1/job/saved/${encodeURIComponent(x.id)}`, `${x.id}.job.json`)}>
                      Download
                    </button>
                  </div>
                ),
              )}
            </details>
          </section>
          {selRow && (
            <p className="p3d-sub" data-testid="p3d-settings-scope">
              Settings for {OBJECT_KEYS.map((k) => OBJECT_KEY_LABEL[k]).join(', ')} go to part {selRow.n}. {selRow.name} only; everything else
              is for the whole plate. Click the part again to set them for the whole plate.
            </p>
          )}
          <Assistant
            overrides={selRow ? { ...job.overrides, ...(selRow.row.first.overrides ?? {}) } : job.overrides}
            setOverrides={(o) => {
              const cur = jobRef.current;
              // A part is selected: its own keys go to that part, the rest to the plate (and the plate keeps its own values of those keys).
              const row = selRow ? rows(cur).find((x) => x.gid === selRow.row.gid) : null;
              if (!row) return setJob({ ...cur, overrides: o });
              const { object, plate } = splitObjectKeys(o);
              const own = Object.fromEntries(Object.entries(object).filter(([k, v]) => cur.overrides[k] !== v));
              const keepPlate = splitObjectKeys(cur.overrides).object;
              setJob(withRowOverrides({ ...cur, overrides: { ...plate, ...keepPlate } }, row.gid, own));
            }}
            jobName={job.name}
            hasParts={job.objects.length > 0}
            slotText={used.map((id) => { const s = slotOf(id); return s ? `${s.label} (${s.type || 'nothing declared'})` : id; }).join(' + ') || null}
            strategy={job.strategy}
            objective={job.objective}
            allowTilt={job.allowTilt}
            onArrange={onArrange}
            onReset={onReset}
            layout={job.layout}
            onLayout={onLayout}
            parts={rows(job).map((r) => {
              const f = job.files[r.first.file];
              const t = tris.current.get(f?.sha256 ?? '');
              return { name: `${baseName(f?.name ?? '')}${r.copies.length > 1 ? ` x${r.copies.length}` : ''}`, size: t ? sizeText(sizeOf(bbox(t))) : '', plate: r.first.plate };
            })}
            processes={profiles?.process.map((x) => x.name) ?? []}
            process={job.process}
            setProcess={(name) => setJob({ ...jobRef.current, process: name })}
            filaments={profiles?.filament.map((x) => x.name) ?? []}
            slotsInUse={used.map((id) => slotOf(id) ?? { id, label: id, type: '', color: '#ffffff' })}
            slotPresets={job.slotPresets}
            setSlotPreset={(slot, preset) => {
              const sp = { ...jobRef.current.slotPresets };
              if (preset) sp[slot] = preset;
              else delete sp[slot];
              setJob({ ...jobRef.current, slotPresets: sp });
            }}
            transport={transport}
          />
        </aside>

        <section className="p3d-centre">
          {nums.length > 0 && (
            <div className="p3d-panel p3d-plates">
              <div className="p3d-tabs" role="tablist" aria-label="Plates" data-testid="p3d-plate-tabs">
                {nums.map((b) => {
                  const n = plateObjects(job, b).length;
                  const e = effStatus(b);
                  return (
                    <button key={b} type="button" role="tab" className="p3d-platetab" aria-selected={b === showPlate} onClick={() => setCurPlate(b)} data-testid={`p3d-plate-${b}`}>
                      <b>
                        Plate {b} ({n} part{n === 1 ? '' : 's'})
                      </b>
                      <small className={`p3d-st-${e}`} data-status={e}>
                        {statusText(b)}
                      </small>
                    </button>
                  );
                })}
              </div>
              {totals && <div className="p3d-sub" role="status">{totals}</div>}
            </div>
          )}
          <div className="p3d-view">
            <PlateView
              area={profiles?.bed?.area ?? null}
              extruderAreas={profiles?.bed?.extruderAreas ?? null}
              parts={parts}
              selected={sel}
              onPick={setSel}
              tower={r1?.wipeTower?.bbox ?? null}
              active={active}
              show={slicedView ? 'sliced' : 'model'}
              toolpath={slicedView ? (tpHere?.path ?? null) : null}
              layer={tpLayer}
              travel={showTravel}
            />
            {oneNozzleZones(profiles?.bed?.area ?? null, profiles?.bed?.extruderAreas).map((z) => (
              <div key={`${z.x0},${z.y0},${z.only}`} className="p3d-sub p3d-nozzlezone" data-testid="p3d-nozzle-zone">
                Hatched: x {z.x0}–{z.x1} mm, y {z.y0}–{z.y1} mm is reached by nozzle {z.only} only (Orca's extruder {z.only}). A filament on the
                other nozzle cannot print there.
              </div>
            ))}
            {r1 && (
              <div className="p3d-viewmode" role="group" aria-label="3D view">
                <button type="button" aria-pressed={!slicedView} onClick={() => setView3d('model')} data-testid="p3d-view-model">
                  Model
                </button>
                <button type="button" aria-pressed={slicedView} onClick={() => setView3d('sliced')} data-testid="p3d-view-sliced">
                  Sliced
                </button>
              </div>
            )}
            {slicedView && !tpHere?.path && (
              <div className="p3d-viewmsg" role="status" data-testid="p3d-sliced-msg">
                {tpHere?.error ? `The sliced G-code could not be shown: ${tpHere.error}. Nothing is drawn in its place.` : 'Reading the sliced G-code…'}
              </div>
            )}
            {slicedView && tpHere?.path && (
              <div className="p3d-layerbar" data-testid="p3d-layerbar">
                <input
                  type="range"
                  min={1}
                  max={tpTop + 1}
                  value={tpLayer + 1}
                  onChange={(e) => {
                    const v = Number(e.target.value) - 1;
                    setLayerSel(v >= tpTop ? null : v);
                  }}
                  aria-label="Layer"
                  data-testid="p3d-layer"
                />
                <span className="p3d-layernum" data-testid="p3d-layer-label">
                  Layer {tpLayer + 1} / {tpTop + 1} · Z {tpHere.path.layers[tpLayer].z.toFixed(2)} mm
                </span>
                <label className="p3d-travel">
                  <input type="checkbox" checked={showTravel} onChange={(e) => setShowTravel(e.target.checked)} data-testid="p3d-travel" /> Travel
                </label>
                <span className="p3d-legend">
                  {PATH_KINDS.filter((k) => k !== 'travel' && tpHere.path!.kinds[k].pos.length > 0).map((k) => (
                    <span key={k} title={k === 'other' && tpHere.path!.unknownFeatures.length ? `Not recognised: ${tpHere.path!.unknownFeatures.join(', ')}` : undefined}>
                      <i style={{ background: KIND_COLOR[k] }} />
                      {KIND_LABEL[k]}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {!job.objects.length && <div className="p3d-viewmsg">{engineSet ? 'Drop an STL file on the left' : 'Set up the slicer bridge (Connections) to start'}</div>}
            {busyText && (
              <div className="p3d-busy" role="status" aria-live="polite" data-testid="p3d-busy">
                <span className="p3d-spin" aria-hidden="true" />
                {busyText}
                {progress && progress.total > 1 && <progress max={progress.total} value={progress.done} aria-label="Slicing progress" />}
              </div>
            )}
          </div>
          {(problems.length > 0 || plan.tooBig.length > 0 || plan.note) && (
            <div className="p3d-problems" data-testid="p3d-problems">
              {problems.map((p, i) => (
                <p key={i} className="p3d-err">
                  {p}
                </p>
              ))}
              {plan.tooBig.length > 0 && (
                <p className="p3d-err">
                  {plan.tooBig.length === 1 ? '1 part does not fit on any plate: ' : `${plan.tooBig.length} parts do not fit on any plate: `}
                  {plan.tooBig.map((t) => `${t.name} (${t.reason})`).join('; ')}
                </p>
              )}
              {plan.note && <p className="p3d-sub">{plan.note}</p>}
            </div>
          )}
          {nums.length > 0 && (
            <div className={`p3d-panel p3d-results${curEff !== 'current' ? ' p3d-stale' : ''}`} data-testid="p3d-results">
              {r1 ? (
                <>
                  <div className="p3d-resline" data-testid="p3d-resline">
                    {nums.length > 1 && <b>Plate {showPlate} · </b>}
                    {[r1.stats.totalTime, finishAt(secsOf(r1.stats.totalTime)), gramsTotal(r1.stats.filamentG) ? `${gramsTotal(r1.stats.filamentG).toFixed(2)} g` : '', r1.stats.layers ? `${r1.stats.layers} layers` : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <p className="p3d-sub" data-testid="p3d-engine">
                    {slicedBy
                      ? `Sliced by ${slicedBy.name}${slicedBy.printed ? '.' : ' — this engine has not printed yet: the first print is a calibration print.'}`
                      : 'The slicer bridge did not say which engine sliced this plate.'}
                  </p>
                  {warnings.map((w, i) => (
                    <p key={i} className="p3d-warn">
                      {w}
                    </p>
                  ))}
                  <details>
                    <summary>Details</summary>
                    <table className="p3d-table">
                      <thead>
                        <tr>
                          <th>slot</th>
                          <th>type</th>
                          <th>preset</th>
                          <th>filament</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r1.filaments.map((f, i) => (
                          <tr key={f.id}>
                            <td>
                              <span className="p3d-sw" style={{ background: f.color }} aria-hidden="true" /> {f.slotLabel}
                            </td>
                            <td>{f.type}</td>
                            <td>{f.preset}</td>
                            <td>{(r1.analysis.filaments[i]?.grams ?? 0).toFixed(2)} g</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <dl className="p3d-dl">
                      {r1.stats.layerHeight && (
                        <>
                          <dt>Layer height</dt>
                          <dd>{r1.stats.layerHeight} mm</dd>
                        </>
                      )}
                      {r1.stats.nozzleTemp && (
                        <>
                          <dt>Nozzle</dt>
                          <dd>{r1.stats.nozzleTemp} °C</dd>
                        </>
                      )}
                      {r1.multiFilament && (
                        <>
                          <dt>Tool changes</dt>
                          <dd>{r1.analysis.toolChanges} (prime tower shown in amber)</dd>
                        </>
                      )}
                      {r1.optimise && (
                        <>
                          <dt>Arrangement</dt>
                          <dd>{r1.optimise.reason}</dd>
                        </>
                      )}
                      <dt>Slice took</dt>
                      <dd>{r1.reusedSlice ? 'reused an identical plate' : `${r1.seconds} s`}</dd>
                    </dl>
                    <button type="button" onClick={() => void download(`/v1/gcode/${r1.id}`, `${job.name}-plate${showPlate}.gcode`)} data-testid="p3d-download">
                      Download G-code
                    </button>
                  </details>
                </>
              ) : curEff === 'failed' ? (
                <div className="p3d-err" data-testid="p3d-resline">
                  Failed: {(cur?.error ?? 'slice failed').split('\n')[0].slice(0, 200)}
                  {(cur?.error ?? '').includes('\n') && <pre className="p3d-log-pre">{cur?.error}</pre>}
                </div>
              ) : (
                <div className="p3d-warn" data-testid="p3d-resline">
                  {curEff ? statusText(showPlate) : ''}
                </div>
              )}
            </div>
          )}
          {slotSyncNote && (
            <p className="p3d-warn" data-testid="p3d-slot-sync-note">
              {slotSyncNote}
            </p>
          )}
          <PrinterCard
            printerBridge={bridges.printer}
            printer={printer}
            plate={nums.length ? showPlate : null}
            plateReady={curEff === 'current' && !!r1}
            sliceKey={plateKey({
              plate: nums.length ? showPlate : null,
              sliceId: curEff === 'current' && r1 ? r1.id : null,
              buildPlate,
              objects: [r1?.objects ?? null, plateObjects(job, showPlate).map((o) => [o.uid, job.files[o.file]?.sha256 ?? null, o.slot, o.placement])],
              filaments: r1?.filaments ?? null,
              filamentSlots: filamentSlotsOf(r1),
              types: filamentSlotsOf(r1).map((id) => slots.find((s) => s.id === id)?.type ?? ''),
              settings: [job.process, job.overrides, job.slotPresets, job.objective, job.strategy, job.allowTilt, job.layout, r1?.engine ?? null],
            })}
            notReady={notReady}
            buildPlate={buildPlate}
            slotsUsed={slotsUsedHere}
            filamentSlots={filamentSlotsOf(r1)}
            jobName={job.name}
            getGcode={() => engine.text(`/v1/gcode/${r1?.id ?? ''}`, 60000)}
            slots={slots}
            types={slotsReply?.types ?? []}
            plates={slotsReply?.bedTypes ?? [buildPlate]}
            engine={slicedBy}
            onState={setPrinterState}
            recheck={recheck}
            blocked={mayUpload(gates) ? null : firstBlock ? `${firstBlock.name}: ${firstBlock.why}` : 'no gates'}
            onSaveSlots={async (next) => {
              const r = await engine.json<SlotsReply>('PUT', '/v1/slots', { bedPlate: next.bedPlate, slots: next.slots.map((s) => ({ id: s.id, type: s.type, color: s.color })) });
              setSlotsReply({ ...r, types: r.types ?? slotsReply?.types ?? [], bedTypes: r.bedTypes ?? slotsReply?.bedTypes ?? [] });
              thumbs.current.clear();
            }}
          />
        </section>
        <GatesPanel
          gates={panelGates}
          storeKey="2bee.app.print3d.gates"
          onFix={() => void fixPrint()}
          fixing={fixing}
          fixNotes={fixNotes}
          foot={'Upload stays off until every gate passes. "…" means not checked yet, which is not a pass.'}
        />
      </div>
    </div>
  );
}

/* Founder 2026-10-16: no "Drop one or several STL" area on the 3d tab — parts
 * arrive from design / cad ("Open in 3d"). The file input stays, invisible and
 * unreachable from the page, as the seam the browser tests add STLs through. */
function DropZone({ disabled, onFiles }: { disabled: boolean; onFiles: (f: File[]) => void }) {
  return (
    <span hidden aria-disabled={disabled} data-testid="p3d-drop">
      <input
        type="file"
        accept=".stl"
        multiple
        hidden
        tabIndex={-1}
        disabled={disabled}
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = '';
          if (fs.length && !disabled) onFiles(fs);
        }}
        data-testid="p3d-file"
      />
    </span>
  );
}

export default Print3dTab;
