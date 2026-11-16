// 2bee.cnc — the main CNC page, in pnp's 2bee.3d layout (founder 2026-10-14):
// what you're making and the Cut assistant on the left, the workpiece in 3D
// with one results line in the centre, the machines as cards below.
//
// 🔴 THIS PAGE NEVER STARTS MOTION. "Send to <machine>" appends jobs to that
// machine's queue (`jobs.ts::enqueue`). The only machine control here is Feed
// Hold on a running machine's card. Starting is the Jobs page's, at the machine,
// after the guided steps (founder: *"cnc is not 100% automatic"*).
//
// Reused, not re-implemented: the catalogue (`shop/catalogue.ts`), the Make
// step's automatic plan (`make/autoPlan.ts` via `plan.ts`), the core's import
// plan and setup facts (`cam.ts`), the job-settings validator (`cnc/jobAsk.ts`),
// 2bee.cad's viewport.

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadCatalogue, type CatalogueState, type ShopEntry } from '../shop/catalogue';
import { machineFor } from '../make/setup';
import { toolLibrary } from '../cam';
import { useCncStore } from '../store/cncStore';
import type { JobPatch } from '../cnc/jobAsk';
import { planCandidate, planDesign, resultsLine, type PlanResult } from './plan';
import Workpiece3D from './Workpiece3D';
import { unsendable } from './simController';
import { gcodeLines } from '../runProgram';
import CutAssistant from './CutAssistant';
import MachineCard from './MachineCard';
import { addBridgeMachine, displayName, isSimulated, machineById, profileSummary, proposeHostname, setProfile, SIM_ID } from './machines';
import { activeOn, enqueue, holdJob, newJobId, queueFor } from './jobs';
import { applyBook, getState, sessionFor, setRegistry, useCncJobs, WHO } from './state';

interface Item {
  key: string;
  entry: ShopEntry;
  qty: number;
  patch: JobPatch | null;
  plan: PlanResult | null;
}

function mergePatch(a: JobPatch | null, b: JobPatch): JobPatch {
  return { op: { ...(a?.op ?? {}), ...b.op }, ...(b.tool_ids ? { tool_ids: b.tool_ids } : a?.tool_ids ? { tool_ids: a.tool_ids } : {}) };
}

export default function CncPage({ onJobs, onExpert }: { onJobs: () => void; onExpert: () => void }) {
  const st = useCncJobs();
  const [cat, setCat] = useState<CatalogueState>({ kind: 'loading' });
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [target, setTarget] = useState<string>(SIM_ID);
  const [picking, setPicking] = useState(false);
  const [library, setLibrary] = useState<string[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ host: string; url: string; why: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    void loadCatalogue().then((c) => live && setCat(c));
    void toolLibrary().then((l) => live && setLibrary(l.tools.map((t) => t.id))).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /* The simulated machine's profile, read once by the Analyse step's read-only commands. */
  useEffect(() => {
    const m = machineById(st.reg, SIM_ID);
    const s = sessionFor(SIM_ID);
    if (!m || m.profile || !s) return;
    void s.analyse().then((p) => setRegistry(setProfile(getState().reg, SIM_ID, profileSummary(p, Date.now()))));
  }, [st.reg]);

  const designs = useMemo(() => (cat.kind === 'ready' ? cat.index.entries.filter((e) => machineFor(e.path) === 'router') : []), [cat]);
  const machine = machineById(st.reg, target) ?? st.reg.machines[0];
  // Re-plan when the target's cutters OR its stated limits change (the profile arrives after Analyse),
  // 🔴 OR THE MATERIAL: `planDesign` reads it once from the store, and this page stays mounted
  // while Expert tools is open — a design planned on Plywood was sent with Plywood feeds and a
  // "Material: Plywood" note after the material was changed to MDF (bughunt 2026-11-15).
  const material = useCncStore((s) => `${s.materialStated ? 1 : 0}:${s.material}`);
  const toolKey = (machine?.toolIds ?? []).join('|') + '#' + (machine?.id ?? '') + '#' + (machine?.profile?.analysedAt ?? '') + '#' + material;

  /* Plan every item whose plan is missing: on add, on an applied change, and
   * when the target machine's cutters change (a new generation drops older answers). */
  const inflight = useRef(new Map<string, number>());
  const gen = useRef(0);
  useEffect(() => {
    gen.current += 1;
    inflight.current.clear();
    setItems((xs) => xs.map((x) => ({ ...x, plan: null })));
  }, [toolKey]);
  useEffect(() => {
    for (const it of items) {
      if (it.plan || inflight.current.get(it.key) === gen.current) continue;
      const g = gen.current;
      inflight.current.set(it.key, g);
      void planDesign(it.entry, { toolIds: machine?.toolIds, patch: it.patch, machine }).then((plan) => {
        if (g !== gen.current) return;
        inflight.current.delete(it.key);
        setItems((xs) => xs.map((x) => (x.key === it.key && !x.plan ? { ...x, plan } : x)));
      });
    }
  }, [items, machine?.toolIds, machine?.profile]);

  const add = (e: ShopEntry) => {
    const key = `${e.id}-${Date.now()}`;
    setItems((xs) => [...xs, { key, entry: e, qty: 1, patch: null, plan: null }]);
    setSel(key);
    setPicking(false);
    setSent(null);
  };

  const cur = items.find((x) => x.key === sel) ?? null;
  const ready = items.length > 0 && items.every((x) => x.plan?.ok && x.plan.plan.report.ok && x.plan.plan.sha256 && x.plan.plan.facts);
  const notReady = !items.length
    ? 'Add a design first.'
    : items.some((x) => !x.plan)
      ? 'Planning…'
      : items.some((x) => !x.plan?.ok || !x.plan.plan.report.ok)
        ? 'A design could not be planned.'
        : !ready
          ? 'Setup facts are missing for a design.'
          : null;

  /* 🔴 The plans above are made for ONE machine's cutters (`machine`, the selected card), and every card had an
   * enabled Send: Send on another card queued a program planned for the selected one's tools (bughunt 2026-11-14).
   * Send is offered on the planned-for card only, and refused here for any other. */
  const sendBlocked = (machineId: string): string | null =>
    notReady ?? (machineId !== machine?.id ? `Planned for ${machine?.hostname ?? 'another machine'}'s cutters. Select this machine first; the designs are planned again for it.` : null);
  const send = (machineId: string) => {
    const blocked = sendBlocked(machineId);
    if (blocked) { setSent(blocked); return; }
    let book = getState().book;
    let n = 0;
    const now = Date.now();
    for (const it of items) {
      if (!it.plan?.ok) continue;
      const p = it.plan.plan;
      for (let i = 1; i <= it.qty; i++) {
        const r = enqueue(
          book,
          {
            id: newJobId(book, now),
            title: it.qty > 1 ? `${it.entry.title} (${i} of ${it.qty})` : it.entry.title,
            design: { id: it.entry.id, title: it.entry.title, thumb: it.entry.thumb ?? null },
            machineId,
            plan: { config: p.config, sectionZ: p.sectionZ, chosen: p.chosen },
            stock: p.stock,
            program: {
              gcode: p.report.gcode,
              sha256: p.sha256!,
              lines: p.report.gcode.split('\n').length,
              seconds: p.report.estimated_seconds,
              tools: p.report.tools_used,
              toolChanges: p.report.tool_changes,
              deepestZ: p.report.deepest_z_mm,
              rapidRate: p.report.rapid_mm_min ?? 0,
            },
            facts: p.facts,
            createdAt: now,
          },
          now,
          WHO,
        );
        if (!r.ok) {
          setSent(r.problem);
          return;
        }
        book = r.book;
        n++;
      }
    }
    applyBook({ ok: true, book });
    setSent(`${n} job${n === 1 ? '' : 's'} queued on ${machineId}.`);
  };

  const plan = cur?.plan?.ok ? cur.plan.plan : null;

  return (
    <div className="cj" data-testid="cj-page">
      <div className="cj-top">
        <h1>2bee.cnc</h1>
        <div className="cj-row">
          <button type="button" onClick={onJobs} data-testid="cj-open-jobs">Jobs</button>
          <button type="button" className="cj-link" onClick={onExpert} data-testid="cj-expert">Expert planner</button>
        </div>
      </div>
      <div className="cj-grid">
        <div className="cj-left">
          <section className="cj-panel" aria-label="What you're making" data-testid="cj-making">
            <h2>Making</h2>
            {items.length === 0 && <p className="cj-muted">Nothing yet.</p>}
            <ul className="cj-items">
              {items.map((it) => (
                <li key={it.key} className={it.key === sel ? 'on' : ''} data-testid="cj-item">
                  <button type="button" className="cj-item-pick" onClick={() => setSel(it.key)}>
                    {it.entry.thumb ? <img src={`shop/${it.entry.thumb}`} alt="" /> : <span className="cj-noimg" />}
                    <span>
                      {it.entry.title}
                      <small>
                        {it.plan === null ? 'planning…' : it.plan.ok ? (it.plan.plan.report.ok ? `${it.plan.plan.stock.x} × ${it.plan.plan.stock.y} × ${it.plan.plan.stock.t} mm` : 'refused') : 'not planned'}
                      </small>
                    </span>
                  </button>
                  <span className="cj-qty">
                    <button type="button" aria-label="One fewer" onClick={() => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}>−</button>
                    <span data-testid="cj-qty">×{it.qty}</span>
                    <button type="button" aria-label="One more" onClick={() => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, qty: Math.min(20, x.qty + 1) } : x)))}>+</button>
                    <button type="button" aria-label="Remove" onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}>✕</button>
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setPicking((p) => !p)} data-testid="cj-add">{picking ? 'Close' : '+ Add a design'}</button>
            {picking && (
              <ul className="cj-pick" data-testid="cj-designs">
                {cat.kind === 'loading' && <li className="cj-muted">Loading…</li>}
                {cat.kind === 'absent' && <li className="cj-warn">No designs: {cat.why}</li>}
                {designs.map((e) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => add(e)} data-testid={`cj-design-${e.id}`}>
                      {e.thumb ? <img src={`shop/${e.thumb}`} alt="" loading="lazy" /> : <span className="cj-noimg" />}
                      <span>{e.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {items.some((x) => x.qty > 1) && <p className="cj-muted">One part per workpiece for now: ×N queues N jobs.</p>}
          </section>
          {plan && plan.report.ok && (
            <CutAssistant
              key={cur!.key}
              config={plan.config}
              report={plan.report}
              library={library}
              facts={{ workpiece: plan.stock, material: plan.config.material, machine: machine?.hostname }}
              planCandidate={(c) => planCandidate(plan, c)}
              onApply={(patch) => setItems((xs) => xs.map((x) => (x.key === cur!.key ? { ...x, patch: mergePatch(x.patch, patch), plan: null } : x)))}
            />
          )}
        </div>
        <div className="cj-centre">
          {plan ? (
            <Workpiece3D mesh={plan.mesh} stock={plan.stock} label={`${plan.entry.title} on the workpiece`} />
          ) : (
            <div className="cj-view cj-view-empty">{cur?.plan && !cur.plan.ok ? cur.plan.why : cur ? 'Planning…' : 'Add a design to see it on the workpiece.'}</div>
          )}
          <p className="cj-results" data-testid="cj-results">
            {plan ? (plan.report.ok ? resultsLine(plan.report) : `Refused by the planner (${plan.report.refusals.length}).`) : ' '}
          </p>
          {plan && !plan.report.ok && (
            <details className="cj-details" data-testid="cj-refusals">
              <summary>Why</summary>
              <ul>{plan.report.refusals.map((r) => <li key={r}>{r}</li>)}</ul>
            </details>
          )}
          {plan?.factsWhy && <p className="cj-warn">{plan.factsWhy}</p>}
          {plan?.report.ok && unsendable(gcodeLines(plan.report.gcode)) && (
            <p className="cj-warn" data-testid="cj-unsendable">{unsendable(gcodeLines(plan.report.gcode))}</p>
          )}
          {plan && (
            <details className="cj-details">
              <summary>Chosen for you</summary>
              <ul>{plan.chosen.map((c) => <li key={c}>{c}</li>)}</ul>
            </details>
          )}
          <h2 className="cj-h2">Machines</h2>
          {sent && <p className="cj-ok" data-testid="cj-sent">{sent} <button type="button" className="cj-link" onClick={onJobs}>Open Jobs</button></p>}
          <div className="cj-cards">
            {st.reg.machines.map((m) => {
              const snap = sessionFor(m.id)?.snapshot() ?? null;
              const job = activeOn(st.book, m.id);
              const queued = queueFor(st.book, m.id).filter((j) => j.state === 'queued').length;
              return (
                <MachineCard
                  key={m.id}
                  machine={m}
                  snap={snap}
                  job={job}
                  selected={m.id === machine?.id}
                  onSelect={() => setTarget(m.id)}
                  onFeedHold={() => {
                    void sessionFor(m.id)?.feedHold();
                    if (job) applyBook(holdJob(getState().book, job.id, Date.now(), WHO, 'feed hold (main page)'));
                  }}
                >
                  <button type="button" className="cj-primary" disabled={!!sendBlocked(m.id)} title={sendBlocked(m.id) ?? undefined} onClick={() => send(m.id)} data-testid={`cj-send-${m.id}`}>
                    Send to {m.hostname}
                  </button>
                  <span className="cj-muted">{queued} queued</span>
                </MachineCard>
              );
            })}
            <article className="cj-card cj-card-add">
              {adding ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const r = addBridgeMachine(getState().reg, adding.host, adding.url, Date.now());
                    if (!r.ok) return setAdding({ ...adding, why: r.problem });
                    setRegistry(r.reg);
                    setAdding(null);
                  }}
                >
                  <label>Name <input value={adding.host} onChange={(e) => setAdding({ ...adding, host: e.target.value })} data-testid="cj-add-host" /></label>
                  <label>Bridge URL <input value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} placeholder="http://cnc-01.local:8080" data-testid="cj-add-url" /></label>
                  {adding.why && <p className="cj-warn">{adding.why}</p>}
                  <p className="cj-muted">The bridge is not built yet: the card will say so.</p>
                  <div className="cj-row">
                    <button type="submit" className="cj-primary" data-testid="cj-add-save">Add</button>
                    <button type="button" onClick={() => setAdding(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button type="button" onClick={() => setAdding({ host: proposeHostname(getState().reg), url: '', why: null })} data-testid="cj-add-machine">
                  + Add machine
                </button>
              )}
            </article>
          </div>
          {notReady && items.length > 0 && <p className="cj-muted">{notReady}</p>}
          <p className="cj-muted">{st.reg.machines.filter((m) => !isSimulated(m)).length ? '' : `Only ${displayName(st.reg.machines[0])} can run today.`}</p>
          {st.notes.map((n) => <p key={n} className="cj-warn">{n}</p>)}
        </div>
      </div>
    </div>
  );
}
