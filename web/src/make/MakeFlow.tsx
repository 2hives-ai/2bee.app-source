// The first screen: Design → Change → Make.
//
// Founder 2026-10-14, verbatim in AGENTS.md § Scope: pick a design (3D or CNC),
// change it with AI, send it to the machine and be told the setup it needs.
// *"Simple as possible! Everything else is configured by AI."* Confirmed shape:
// "3 steps, keep expert tabs" — the five existing tabs sit behind one link.
//
// 🔴 THE RULE FOR ANYTHING ADDED HERE: if a control is not needed for one of the
// three steps, it does not go on this screen. Settings are not asked for here.
//
// What this screen reuses rather than re-implements, so the checks are the same
// ones the expert tabs run:
//   · the catalogue (`shop/catalogue.ts`) for the designs and their pictures;
//   · `askOnce` + `ProposalView` (`cad/ask.tsx`) for the AI change — the same
//     preflight, the same parser and audit of the model's reply, the same
//     refusals. The design's import closure is passed as a library host, so the
//     review sees the whole part (see `evaluate` in ask.tsx);
//   · `setup.ts` for the machine, the checklist and why Send cannot send yet.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadCatalogue, loadDesign, type CatalogueState, type ShopEntry } from '../shop/catalogue';
import { catalogueSubject, DesignViewer, ThumbButton } from '../shop/DesignViewer';
import {
  askConfigured,
  askOnce,
  fetchTransport,
  mayApply,
  ProposalView,
  readAskConfig,
  STALE_FAILURE,
  type AskFailure,
  type ProposalReview,
} from '../cad/ask';
import { makeLibraryHost, type ScadLibrary } from '../cad/library';
import { fitBlocker, MACHINE_NAME, machineFor, makeable, sendBlocker, setupChecklist, type SetupStep } from './setup';
import { CLAMP_MARGIN_MM, cutSolids, flatStl, jobFor, layFlat, measuredOnlyTools, ownedToolIds, planSteps, summarise, type PlanSummary } from './autoPlan';
import { evaluateForMachine } from '../cad/machine';
import { planImportBytes, setupFactsForImport, toolLibrary, type SetupFacts } from '../cam';
import { useCncStore } from '../store/cncStore';
import { readInventory } from '../inventory';
import { operatorMaterial } from '../jobMaterial';
import { PrintChange, PrintSummary } from './printJob/PrintJob';
import { isWorkpieceTopDatum } from '../cncjob/airCut';
import { shopFields } from '../cncjob/machines';
import { buildPrintJob, printChecklist, PRINT_SEND_BLOCKER, resolveChoices, type Choice, type Resolved, type SlotId } from './printJob/job';
import { designFile } from './printJob/file';

type Step = 1 | 2 | 3;

interface Design {
  entry: ShopEntry;
  path: string;
  files: Record<string, string>;
  /** The source as it stands now: the design, plus any AI change applied. */
  source: string;
}

interface Change {
  prompt: string;
  review: ProposalReview;
  raw: string;
  applied: boolean;
  /** The source before this change, so it can be put back. */
  previous: string;
}

export interface MakeFlowProps {
  /** Open the expert tabs. */
  onExpert: () => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

const STEPS: readonly { n: Step; label: string }[] = [
  { n: 1, label: 'Design' },
  { n: 2, label: 'Change' },
  { n: 3, label: 'Make' },
];

/* 🔴 THE FLOW OUTLIVES ITS OWN MOUNT. App renders this screen only while the Simple view is
 * shown, so "Expert tools" and back unmounted it and dropped the design, the AI change and
 * every choice — and the Make step itself sends people to Expert tools to add cutters
 * (journey test, 2026-10-15). The state is kept here, in memory for this page load only. It is
 * not written to storage: a design's sources are large, and a reload starting fresh is the
 * honest default. */
interface Snapshot {
  step: Step;
  design: Design | null;
  change: Change | null;
  printChoices: Choice[];
  printSlot: SlotId | null;
  ticked: Record<string, boolean>;
}
let snapshot: Snapshot | null = null;
/** Tests only: start the next mount fresh. */
export function resetMakeFlowSnapshot(): void {
  snapshot = null;
}

export default function MakeFlow({ onExpert, fetchImpl }: MakeFlowProps) {
  const [step, setStepState] = useState<Step>(() => (snapshot?.design ? snapshot.step : 1));
  const [cat, setCat] = useState<CatalogueState>({ kind: 'loading' });
  const [design, setDesign] = useState<Design | null>(() => snapshot?.design ?? null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState<string | null>(null);
  /** The design whose 3D view is open from its picture, if any. */
  const [viewing, setViewing] = useState<ShopEntry | null>(null);
  /* Memoised: the viewer rebuilds when its subject's IDENTITY changes, so a fresh object per render would restart it forever. */
  const viewingSubject = useMemo(() => (viewing ? catalogueSubject(viewing, fetchImpl) : null), [viewing, fetchImpl]);
  /* Held HERE, not in ChangeStep: a step remounts when the user goes Make →
   * Change, and a change record kept inside it was lost, leaving an applied
   * change with no Undo (found 2026-10-14 by journey J3). */
  const [change, setChange] = useState<Change | null>(() => snapshot?.change ?? null);
  /* The printer path's choices: held here for the same reason as `change`. */
  const [printChoices, setPrintChoices] = useState<Choice[]>(() => snapshot?.printChoices ?? []);
  const [printSlot, setPrintSlot] = useState<SlotId | null>(() => snapshot?.printSlot ?? null);
  /* Checklist ticks, held here because the Make step unmounts on Make → Change. */
  const [ticked, setTicked] = useState<Record<string, boolean>>(() => snapshot?.ticked ?? {});
  /* A changed design is a different part: every setup line is confirmed again. */
  const tickedFor = useRef(design?.source);
  useEffect(() => {
    if (design?.source === tickedFor.current) return;
    tickedFor.current = design?.source;
    setTicked({});
  }, [design?.source]);
  useEffect(() => {
    snapshot = { step, design, change, printChoices, printSlot, ticked };
  }, [step, design, change, printChoices, printSlot, ticked]);

  /* 🔴 THE BROWSER'S BACK BUTTON MOVES BETWEEN STEPS. The steps added no history entries, so
   * Back from step 2 left the app altogether (journey test, 2026-10-15). Moving forward pushes
   * an entry, and Back/Forward restore the step it recorded. Only this screen's own entries are
   * read: one without `makeStep` is not ours, and is left to the browser. */
  // Not inside a state updater: StrictMode runs updaters twice in development, which would push two entries.
  const setStep = (n: Step) => {
    if (n > step && typeof window !== 'undefined') window.history.pushState({ ...(window.history.state ?? {}), makeStep: n }, '');
    setStepState(n);
  };
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = (e: PopStateEvent) => {
      const n = (e.state as { makeStep?: unknown } | null)?.makeStep;
      setStepState(n === 2 || n === 3 ? (n as Step) : 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const printResolved = useMemo(() => resolveChoices(printChoices), [printChoices]);

  useEffect(() => {
    let live = true;
    loadCatalogue(fetchImpl).then((s) => live && setCat(s));
    return () => {
      live = false;
    };
  }, [fetchImpl]);

  const designs = useMemo(() => (cat.kind === 'ready' ? makeable(cat.index.entries) : []), [cat]);

  const pick = async (e: ShopEntry) => {
    setOpening(e.id);
    setOpenFailed(null);
    try {
      const d = await loadDesign(e.id, fetchImpl);
      setDesign({ entry: e, path: d.path, files: d.sources, source: d.sources[d.path] });
      setChange(null);
      setPrintChoices([]);
      setPrintSlot(null);
      setTicked({});
      setStep(2);
    } catch (err) {
      setOpenFailed(`${e.title} could not be opened: ${String((err as Error).message ?? err)}`);
    } finally {
      setOpening(null);
    }
  };

  const restart = () => {
    setDesign(null);
    setChange(null);
    setPrintChoices([]);
    setPrintSlot(null);
    setTicked({});
    setStep(1);
  };

  return (
    <div className="make" data-testid="make-flow">
      <nav className="make-steps" aria-label="Steps">
        <ol>
          {STEPS.map((s) => (
            <li key={s.n} aria-current={s.n === step ? 'step' : undefined} className={s.n === step ? 'on' : s.n < step ? 'done' : ''}>
              {s.n < step && design ? (
                <button type="button" onClick={() => (s.n === 1 ? restart() : setStep(s.n))}>
                  {s.n}. {s.label}
                </button>
              ) : (
                <span>
                  {s.n}. {s.label}
                </span>
              )}
            </li>
          ))}
        </ol>
        <button type="button" className="make-expert" onClick={onExpert} data-testid="make-expert">
          Expert tools
        </button>
      </nav>

      {step === 1 && (
        <section className="make-body" aria-label="Pick a design">
          <h1>Pick a design</h1>
          {cat.kind === 'loading' && <p className="make-muted">Loading designs…</p>}
          {cat.kind !== 'loading' && cat.kind !== 'ready' && (
            <p className="make-warn">No designs to show. {'why' in cat ? cat.why : ''}</p>
          )}
          {openFailed && <p className="make-warn">{openFailed}</p>}
          <div data-testid="make-designs">
            {(['printer', 'router'] as const).map((machine) => {
              const group = designs.filter((e) => machineFor(e.path) === machine);
              if (!group.length) return null;
              return (
                <section key={machine} className="make-group" aria-label={machine === 'printer' ? 'Print on the 3D printer' : 'Cut on the CNC router'}>
                  <h2>{machine === 'printer' ? '3D print' : 'CNC cut'}</h2>
                  <ul className="shop-grid">
                    {group.map((e) => (
                      <li key={e.id} className="shop-card shop-card-split">
                        {/* Founder 2026-10-15: the picture opens the 3D view; the card below picks. */}
                        <ThumbButton entry={e} onView={setViewing} />
                        <button
                          type="button"
                          className="shop-card-btn"
                          onClick={() => pick(e)}
                          disabled={opening !== null}
                          data-testid={`make-design-${e.id}`}
                        >
                          <span className="shop-card-body">
                            <span className="shop-card-title">{e.title}</span>
                            <span className="shop-card-family">{machine === 'printer' ? '3D print' : 'CNC cut'}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          {viewingSubject ? <DesignViewer entry={viewingSubject} onClose={() => setViewing(null)} /> : null}
        </section>
      )}

      {step === 2 && design && (
        <ChangeStep
          design={design}
          setDesign={setDesign}
          change={change}
          setChange={setChange}
          onNext={() => setStep(3)}
          printer={
            machineFor(design.path) === 'printer' ? (
              <PrintChange
                design={design.entry.title}
                choices={printChoices}
                setChoices={setPrintChoices}
                slot={printSlot}
                setSlot={setPrintSlot}
                resolved={printResolved}
              />
            ) : null
          }
        />
      )}

      {step === 3 && design && <MakeStep design={design} change={change} ticked={ticked} setTicked={setTicked} onRestart={restart} print={{ slot: printSlot, resolved: printResolved }} />}
    </div>
  );
}

function ChangeStep({
  design,
  setDesign,
  change,
  setChange,
  onNext,
  printer,
}: {
  design: Design;
  setDesign: (d: Design) => void;
  change: Change | null;
  setChange: (c: Change | null) => void;
  onNext: () => void;
  /** The printer path's questions, filament and print AI. Null for the router. */
  printer: ReactNode;
}) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AskFailure | null>(null);
  const abort = useRef<AbortController | null>(null);
  /* The design NOW, read when a reply lands: "Undo this change" stays live while the model works,
   * and a reply applied over an Undo silently brought the undone change back (bughunt 2026-11-15). */
  const latestDesign = useRef(design);
  const reportRef = useRef<HTMLDetailsElement>(null);
  latestDesign.current = design;
  /* 🔴 THE STORE MUST BE PASSED. `readAskConfig()` with no argument returns
   * NO_ASK_CONFIG — so this step said "AI is not connected" even with AI set up
   * in 2bee.cad (found 2026-10-14 by the AI-change journey, e2e/journeys.spec.ts).
   * Same read as CadTab.tsx:1426 and CncAskPanel.tsx:74. */
  const cfg = useMemo(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  }, []);
  const connected = askConfigured(cfg);

  useEffect(() => () => abort.current?.abort(), []);
  /* Founder 2026-11-13: show what the AI is doing and for how long, with a way to stop. */
  const [stage, setStage] = useState('');
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setSecs(0);
    const id = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const scad = useMemo(() => {
    const lib: ScadLibrary = { files: new Map(Object.entries(design.files)), rootName: '', pickedAt: 0, skipped: [] };
    return { path: design.path, host: makeLibraryHost(lib) };
  }, [design.path, design.files]);

  const send = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    const controller = new AbortController();
    abort.current = controller;
    /* 🔴 THE CONFIGURED TIMEOUT, AS IN 2bee.cad (ask.tsx's own send). This step had none, so a
     * bridge that never answered left "Asking the model…" up for ever, with Next disabled and
     * no way out but throwing the design away (journey test, 2026-10-15). */
    let out: Awaited<ReturnType<typeof askOnce>>;
    try {
      out = await askOnce({
        timeoutMs: cfg.timeoutMs,
        onStage: setStage,
        cfg,
        prompt,
        source: design.source,
        online: typeof navigator === 'undefined' ? true : navigator.onLine,
        transport: fetchTransport,
        signal: controller.signal,
        scad,
      });
    } finally {
      abort.current = null;
    }
    setBusy(false);
    if (controller.signal.aborted) {
      setFailure({ kind: 'timeout', headline: 'stopped, nothing was changed', detail: 'You pressed Stop.' });
      return;
    }
    if (!out.ok) {
      setFailure(out.failure);
      return;
    }
    /* Applied straight away when the review allows it, as in 2bee.cad (founder
     * 2026-08-11, "no extra click needed"). The review stays on screen, and
     * "Put it back" restores the source from before. */
    if (latestDesign.current.source !== design.source || latestDesign.current.path !== design.path) {
      setFailure(STALE_FAILURE);
      return;
    }
    const ok = mayApply(out.review);
    if (!ok && change?.applied) {
      /* A refused second ask must not replace the record of the change that IS in the source:
       * that record is its Undo and the cautions the Make step shows beside the checklist. */
      setFailure(out.review.blocked ?? { kind: 'still-broken', headline: 'the change was not applied', detail: '' });
      return;
    }
    setChange({ prompt, review: out.review, raw: out.raw, applied: ok, previous: design.source });
    if (ok) setDesign({ ...design, source: out.source });
    setPrompt('');
  };

  const putBack = () => {
    if (change?.applied) setDesign({ ...design, source: change.previous });
    setChange(null);
  };

  return (
    <section className="make-body" aria-label="Change it">
      <h1>{design.entry.title}</h1>
      <div className="make-pic">
        {design.entry.thumb ? <img src={`shop/${design.entry.thumb}`} alt={design.entry.title} /> : null}
      </div>
      {connected ? (
        <form
          className="make-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="make-prompt">What should change? (optional)</label>
          <textarea
            id="make-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="e.g. make it 10 mm taller"
            rows={2}
            disabled={busy}
            data-testid="make-prompt"
          />
          {busy && (
            <p className="make-muted" role="status" aria-live="polite">
              <span className="cad-chat-spin" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
              {stage || 'Asking the model'}… {secs} s{' '}
              <button type="button" className="make-link" onClick={() => abort.current?.abort()} data-testid="make-ask-cancel">
                Stop
              </button>
            </p>
          )}
        </form>
      ) : (
        <p className="make-muted" data-testid="make-ai-off">
          AI is not connected yet, so this design is made as it is. (It is set up once, under Expert tools → 2bee.cad.)
        </p>
      )}
      {failure && (
        <p className="make-warn" data-testid="make-ask-failure">
          {sentenceCase(failure.headline)}. {failure.detail.replace(/the Key field/g, 'the Key field under Expert tools → 2bee.cad')}
        </p>
      )}
      {change && (
        <div className="make-change" data-testid="make-change">
          <p className="make-muted">Asked: “{change.prompt}”</p>
          {change.applied ? (
            <>
              <p data-testid="make-change-summary">
                <strong>Changed.</strong> {change.review.shape.sentence.replace(/^Changed\.\s*/, '')}
              </p>
              {change.review.cautions.length > 0 && (
                <ul className="make-warn">
                  {change.review.cautions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              <button type="button" className="make-link" onClick={putBack} data-testid="make-undo">
                Undo this change
              </button>
            </>
          ) : (
            <p className="make-warn" data-testid="make-change-refused">
              <strong>Not changed.</strong> {change.review.blocked?.headline}. {change.review.blocked?.detail}
            </p>
          )}
          {/* The full review (diff, refusals, the model's raw reply) stays one
              click away, but it is the expert view, written for 2bee.cad. */}
          {/* "Clear this report" on an APPLIED change only folds it: dropping the record lost the
              change's Undo and its cautions on the Make step while the change stayed in the source. */}
          <details className="make-details" ref={reportRef}>
            <summary>{change.applied ? 'What the model changed' : 'What the model replied'}</summary>
            <ProposalView review={change.review} raw={change.raw} applied={change.applied} onDiscard={() => (change.applied ? reportRef.current?.removeAttribute('open') : setChange(null))}
            />
          </details>
        </div>
      )}
      {printer}
      <button type="button" className="make-next" onClick={onNext} disabled={busy} data-testid="make-next">
        Next: make it
      </button>
    </section>
  );
}

type RouterPlan =
  | { state: 'planning' }
  | { state: 'none'; why: string; measuredOnly: string[] }
  | { state: 'planned'; summary: PlanSummary; stock: { x: number; y: number; t: number }; chosen: string[]; facts: SetupFacts | null; factsWhy: string | null };

/**
 * Plan a CNC design automatically: the design laid flat, the cutters the shop
 * registered, the core's own import plan. See `autoPlan.ts` for what is chosen
 * and what is refused.
 */
function useRouterPlan(design: Design, enabled: boolean): RouterPlan | null {
  const [plan, setPlan] = useState<RouterPlan | null>(enabled ? { state: 'planning' } : null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const lib: ScadLibrary = { files: new Map(Object.entries(design.files)), rootName: '', pickedAt: 0, skipped: [] };
        const ev = evaluateForMachine(design.source, { path: design.path, host: makeLibraryHost(lib) });
        if (ev.exhausted !== null) throw new Error(`The design is too large for the in-browser kernel at every resolution: ${ev.exhausted}`);
        const flat = layFlat(cutSolids(ev.mesh.parts), CLAMP_MARGIN_MM);
        if (!flat) throw new Error('The design produced no solid to cut.');
        const inv = await readInventory().catch(() => null);
        const doc = inv?.doc ?? null;
        const toolLib = await toolLibrary();
        const libIds = toolLib.tools.map((t) => t.id);
        const job = jobFor(flat, ownedToolIds(doc, libIds));
        if (!job.ok) {
          if (live) setPlan({ state: 'none', why: job.why, measuredOnly: measuredOnlyTools(doc, libIds) });
          return;
        }
        const mv = operatorMaterial(useCncStore.getState(), (toolLib.materials ?? []).map((m) => m.name));
        if (mv.state !== 'known') {
          if (live) setPlan({ state: 'none', why: `Material: ${mv.why} Set it in Expert tools (Material).`, measuredOnly: [] });
          return;
        }
        /* Material is the OPERATOR'S: the one saved in 2bee.cnc (Expert tools),
         * never chosen here. Unstated or not in the library: refused above. */
        const material = mv.name;
        const config = { ...job.config, material, machine: shopFields(useCncStore.getState()) };
        const chosen = [...job.chosen, `Material: ${material}, from your 2bee.cnc settings (Expert tools).`];
        const stl = flatStl(flat, design.entry.title);
        const report = await planImportBytes(stl, 'stl', config, job.sectionZ);
        const st = config.stock as { size_x_mm: number; size_y_mm: number; thickness_mm: number };
        let facts: SetupFacts | null = null;
        let factsWhy: string | null = null;
        if (report.ok) {
          const ans = await setupFactsForImport(stl, 'stl', config, job.sectionZ);
          const sha = await sha256Hex(report.gcode);
          if (!ans.facts) factsWhy = `Setup could not be read: ${ans.refused.join('; ')}`;
          else if (ans.gcode_sha256 !== sha) factsWhy = 'The setup facts were read from a different program than the one planned, so they are not shown.';
          else facts = ans.facts;
        }
        if (live) setPlan({ state: 'planned', summary: summarise(report), stock: { x: st.size_x_mm, y: st.size_y_mm, t: st.thickness_mm }, chosen, facts, factsWhy });
      } catch (e) {
        if (live) setPlan({ state: 'none', why: `The job could not be planned: ${String((e as Error).message ?? e)}`, measuredOnly: [] });
      }
    })();
    return () => {
      live = false;
    };
  }, [design, enabled]);
  return plan;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checklist lines only the setup facts can give: where zero is, spindle speed. */
function factSteps(f: SetupFacts): SetupStep[] {
  /* 🔴 PLAIN WORDS IN THE LINE, THE CORE'S WORDS IN THE SMALL PRINT. The declared datum and the
   * XY convention are written by the core for engineers ("Stock::z_datum", "ZDatum::surface_z_mm",
   * "(Stock::place)"), and they were the checklist text itself (journey test, 2026-10-15). They
   * stay, verbatim, in `why`, so nothing is hidden. */
  const top = isWorkpieceTopDatum(f.z_datum.declared);
  const xyUnstated = /not defined/i.test(f.xy_zero.convention);
  const out: SetupStep[] = [
    {
      text: top ? 'Set Z zero on the top surface of the workpiece.' : 'Set Z zero where the job says (details below).',
      why: `${f.z_datum.declared}. Source: ${f.z_datum.source}`,
    },
    {
      text: xyUnstated ? 'Check where XY zero goes: the program does not state it.' : 'Set XY zero where the job says (details below).',
      why: `${f.xy_zero.convention}. Source: ${f.xy_zero.source}`,
    },
  ];
  if (f.spindle.rpm.length) {
    out.push({ text: `The spindle runs at ${f.spindle.rpm.join(', ')} rpm. Check the speed control is set to follow the controller.`, why: 'S words in the planned program.' });
  }
  for (const m of [...f.mismatches, ...f.pending]) {
    out.push({ text: `Check: ${m}`, why: 'The program and the job disagree here, or a fact is not known.' });
  }
  return out;
}

/** The design as the printable file the print job names (STL bytes, hashed). */
function usePrintFile(design: Design, enabled: boolean) {
  const [state, setState] = useState<Awaited<ReturnType<typeof designFile>> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState(null);
    void designFile({ id: design.entry.id, title: design.entry.title, path: design.path, source: design.source, files: design.files }).then(
      (r) => live && setState(r),
    );
    return () => {
      live = false;
    };
  }, [design, enabled]);
  return state;
}

function sentenceCase(t: string): string {
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/**
 * The design's size AS IT STANDS. With no AI change this is the catalogue's measured
 * `sizeMm`. With one, it is measured again from the changed source, because the checklist
 * and the fit check used the catalogue size and described the part from BEFORE the change
 * (a 300 × 300 mm plate added by the AI passed as fitting the X2D; journey test 2026-10-15).
 * `null` when the changed design cannot be measured, which every caller treats as unknown.
 */
function currentSize(design: Design): [number, number, number] | null {
  if (design.source === design.files[design.path]) return design.entry.sizeMm ?? null;
  try {
    const lib: ScadLibrary = { files: new Map(Object.entries(design.files)), rootName: '', pickedAt: 0, skipped: [] };
    const ev = evaluateForMachine(design.source, { path: design.path, host: makeLibraryHost(lib) });
    if (ev.exhausted !== null) return null; // too large at every resolution: no size is stated
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of ev.mesh.parts) {
      if (p.dim !== 3 || p.triangles <= 0) continue;
      for (let i = 0; i < p.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = p.positions[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
    }
    if (!Number.isFinite(min[0])) return null;
    const r = (k: number) => Math.round((max[k] - min[k]) * 100) / 100;
    return [r(0), r(1), r(2)];
  } catch {
    return null;
  }
}

function MakeStep({
  design,
  change,
  ticked,
  setTicked,
  onRestart,
  print,
}: {
  design: Design;
  change: Change | null;
  ticked: Record<string, boolean>;
  setTicked: (f: (t: Record<string, boolean>) => Record<string, boolean>) => void;
  onRestart: () => void;
  print: { slot: SlotId | null; resolved: Resolved };
}) {
  const m = machineFor(design.path)!;
  const size = useMemo(() => currentSize(design), [design]);
  const tooBig = fitBlocker(design.path, size);
  const plan = useRouterPlan(design, m === 'router');
  const printFile = usePrintFile(design, m === 'printer');
  const printJob = useMemo(
    () =>
      m === 'printer'
        ? buildPrintJob({
            name: design.entry.title,
            objects: [{ file: printFile && 'file' in printFile ? printFile.file : null, slot: print.slot }],
            resolved: print.resolved,
          })
        : null,
    [m, design.entry.title, printFile, print.slot, print.resolved],
  );
  /* With a plan, the workpiece, cutter and depth lines come FROM the planned
   * program; without one, the design-size lines stand and say so. */
  const steps: SetupStep[] = useMemo(() => {
    const base = setupChecklist({ ...design.entry, sizeMm: size });
    if (printJob) return printChecklist(base, printJob, [print.slot], print.resolved.todo);
    /* 🔴 ONLY A PLAN THE CORE ACCEPTED SUPPLIES NUMBERS. A refused plan's summary is all zeros,
     * and it was read anyway: "It cuts 0 mm deep … Z 0 mm" under "The planner refused this job",
     * with the cutter line gone (journey test, 2026-10-15). */
    if (plan?.state !== 'planned' || !plan.summary.ok) return base;
    // In the order a person does it: workpiece, clamps, cutter, zero, then what happens during the run.
    const [workpiece, ...runSteps] = planSteps(plan.summary, plan.stock);
    const fit = runSteps.filter((x) => x.text.startsWith('Fit '));
    const during = runSteps.filter((x) => !x.text.startsWith('Fit '));
    const warn = base.filter((x) => x.text.startsWith('Check the picture'));
    const clamp = base.filter((x) => x.text.startsWith('Clamp'));
    return [
      ...warn,
      workpiece,
      ...clamp,
      ...fit,
      ...(plan.facts ? factSteps(plan.facts) : [{ text: 'Set zero where the job says.', why: 'The setup facts for this program could not be read.' }]),
      ...during,
      { text: 'Stand at the machine with a hand near the stop button.', why: 'Nothing from this app has cut anything yet.' },
    ];
  }, [design.entry, size, plan, printJob, print.slot, print.resolved.todo]);
  /* Ticks are kept BY LINE, not by position, so going Make → Change → Make with nothing
   * changed does not untick everything (it did: a re-plan made a new list object). A line
   * whose text changed is a new instruction and starts unticked. Two lines with the same
   * text are told apart by occurrence, so one tick cannot answer both; and every tick is
   * cleared when the design's source changes (MakeFlow, below the state) — "Clamp…" read
   * the same for the part before and after an AI change and stayed ticked for a part
   * nobody had checked (bughunt 2026-11-15). */
  const keys = steps.map((s, i) => `${s.text}#${steps.slice(0, i).filter((o) => o.text === s.text).length}`);
  const done = keys.map((k) => !!ticked[k]);
  /* The printer's reason is the print job's: slicing is not in the app yet. */
  const blocker = tooBig ?? (m === 'printer' ? PRINT_SEND_BLOCKER : sendBlocker(m));
  const changed = design.source !== design.files[design.path];
  return (
    <section className="make-body" aria-label="Make it">
      <h1>
        {design.entry.title} → {MACHINE_NAME[m]}
      </h1>
      <div className="make-pic">
        {design.entry.thumb ? <img src={`shop/${design.entry.thumb}`} alt={design.entry.title} /> : null}
      </div>
      {changed && (
        <p className="make-muted" data-testid="make-includes-change">
          Includes your AI change. The picture shows the design from before it
          {size ? `; the changed part measures ${size.map((v) => Math.round(v * 10) / 10).join(' × ')} mm.` : '; the changed part could not be measured.'}
        </p>
      )}
      {changed && change?.applied && change.review.cautions.length > 0 && (
        <ul className="make-warn" data-testid="make-change-cautions">
          {change.review.cautions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {tooBig && (
        <p className="make-warn" data-testid="make-too-big">
          {tooBig}
        </p>
      )}
      {printFile && 'why' in printFile && (
        <p className="make-warn" data-testid="print-file-why">
          {printFile.why}
        </p>
      )}
      {printJob && <PrintSummary outcome={printJob} resolved={print.resolved} />}
      {plan?.state === 'planning' && <p className="make-muted" data-testid="make-planning">Planning the job…</p>}
      {plan?.state === 'none' && (
        <p className="make-warn" data-testid="make-plan-none">
          {plan.why}
          {plan.measuredOnly.length > 0 && ` (${plan.measuredOnly.length} measured-only cutter${plan.measuredOnly.length > 1 ? 's are' : ' is'} registered; the planner can use only cutters picked from the app's list for now.)`}
        </p>
      )}
      {plan?.state === 'planned' && (
        <div data-testid="make-plan">
          {plan.summary.ok ? (
            <p>
              <strong>Planned.</strong> {plan.summary.tools.length} cutter{plan.summary.tools.length === 1 ? '' : 's'}, about{' '}
              {Math.max(1, Math.round(plan.summary.seconds / 60))} min.
            </p>
          ) : (
            <div className="make-warn" data-testid="make-plan-refused">
              <strong>The planner refused this job:</strong>
              <ul>
                {plan.summary.refusals.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.factsWhy && <p className="make-warn" data-testid="make-facts-why">{plan.factsWhy}</p>}
          <details className="make-details">
            <summary>What was chosen for you</summary>
            <ul>
              {plan.chosen.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
      <h2>Before you send it</h2>
      <ol className="make-check" data-testid="make-checklist">
        {steps.map((s, i) => (
          <li key={i}>
            <label>
              <input
                type="checkbox"
                checked={done[i]}
                onChange={() => setTicked((t) => ({ ...t, [keys[i]]: !t[keys[i]] }))}
              />{' '}
              {s.text}
            </label>
            <small>{s.why}</small>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="make-send"
        disabled={blocker !== null || !done.every(Boolean) || (plan !== null && !(plan.state === 'planned' && plan.summary.ok))}
        data-testid="make-send"
      >
        Send to the {m === 'printer' ? 'printer' : 'router'}
      </button>
      {blocker && (
        <p className="make-warn" data-testid="make-send-blocked">
          {blocker}
        </p>
      )}
      <p>
        <button type="button" className="make-link" onClick={onRestart}>
          Pick another design
        </button>
      </p>
    </section>
  );
}
