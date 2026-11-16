/**
 * cnc.machines — the machine, decoupled from cnc (founder 2026-10-15:
 * "Decouple the machine from 2bee.cnc into 2bee.cnc.machines (same view as all
 * others - AI chat + 3d view)").
 *
 * Left: the machine picker and a chat that turns what the operator says into
 * the Machine fields (`machineAsk.ts` refuses anything outside its keys and
 * bounds). Right: the travel envelope in 3D, drawn from the same values the
 * planner uses. The values themselves still live in App.tsx, so cnc plans with
 * exactly what this tab shows; this tab owns no second copy.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dragMode, noContextMenu, panTarget, type DragMode } from '../view3d/mouse';
import * as THREE from 'three';
import {
  AskSettings,
  askConfigured,
  classifyThrow,
  fetchTransport,
  preflight,
  readAskConfig,
  readReply,
  writeAskConfig,
  type AskConfig,
  type AskTransport,
} from '../cad/ask';
import { pagesBlock, pagesBlockFromSearch, readLinkedPages, researchPages, researchQuery, wantsResearch } from '../ai/linkedPages';
import { PnpSection, PrintersSection } from './OtherMachines';
import { MACHINE_FIELDS, MACHINE_KEYS, buildMachineRequest, machineRows, readMachineProposal, type MachineFields } from './machineAsk';

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'undone' | 'note'; text: string; notes: string[]; undo?: Partial<MachineFields>; undoFor?: string };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

export interface MachinesTabProps {
  name: string;
  fields: MachineFields;
  onPatch(patch: Partial<MachineFields>): void;
  /** Save the fields (after this patch) as a named machine in the machine list. */
  onSaveAs(name: string): void;
  /** The machine chooser — the same element the cnc tab shows. */
  picker: ReactNode;
  /** False while the tab is hidden: the 3D loop stops. */
  active: boolean;
  transport?: AskTransport;
}

function cssColor(name: string, fallback: string): THREE.Color {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

/** The travel envelope: machine table, wire box to Travel Z, safe-Z plane, axes. */
export function MachineView({ fields, active, legend }: { fields: MachineFields; active: boolean; legend?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<{ renderer?: THREE.WebGLRenderer; scene?: THREE.Scene; camera?: THREE.PerspectiveCamera; group?: THREE.Group; draw?: () => void; frame?: (r: number) => void; active?: boolean }>({});

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = 'This browser has no WebGL, so the 3D view is not available.';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'machine-canvas');
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(1, -1, 2);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    let theta = -Math.PI / 3, phi = Math.PI / 3.2, radius = 2000;
    const target = new THREE.Vector3();
    const place = () => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi),
      );
      camera.lookAt(target);
    };
    const draw = () => {
      if (kit.current.active === false) return;
      renderer.render(scene, camera);
    };
    const resize = () => {
      const w = el.clientWidth || 640, h = el.clientHeight || 400;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let drag: { x: number; y: number; mode: DragMode } | null = null;
    const dom = renderer.domElement;
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, mode: dragMode(e) }; dom.setPointerCapture?.(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      if (drag.mode === 'pan') {
        panTarget(camera, target, e.clientX - drag.x, e.clientY - drag.y, radius, dom.clientHeight);
        drag.x = e.clientX;
        drag.y = e.clientY;
        place();
        draw();
        return;
      }
      theta -= (e.clientX - drag.x) * 0.008;
      phi = Math.min(Math.PI / 2 - 0.02, Math.max(0.05, phi - (e.clientY - drag.y) * 0.008));
      drag = { ...drag, x: e.clientX, y: e.clientY };
      place();
      draw();
    };
    const up = () => { drag = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); radius *= e.deltaY > 0 ? 1.1 : 1 / 1.1; place(); draw(); };
    const unCtx = noContextMenu(dom);
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    kit.current = {
      ...kit.current,
      renderer, scene, camera, draw,
      frame: (r: number) => { radius = r; place(); draw(); },
    };
    Object.defineProperty(kit.current, 'target', { value: target, configurable: true });
    place();
    resize();
    return () => {
      ro.disconnect();
      unCtx();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('wheel', wheel);
      renderer.dispose();
      el.removeChild(dom);
      kit.current = {};
    };
  }, []);

  useEffect(() => {
    kit.current.active = active;
    if (active) kit.current.draw?.();
  }, [active]);

  useEffect(() => {
    const { scene, draw, frame } = kit.current;
    if (!scene) return;
    if (kit.current.group) {
      scene.remove(kit.current.group);
      kit.current.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    const { travelX: x, travelY: y, travelZ: z, safeZ } = fields;
    const g = new THREE.Group();
    const accent = cssColor('--color-amber', '#c47a14');
    const line = cssColor('--color-text-muted', '#777');
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(x, y, 12),
      new THREE.MeshStandardMaterial({ color: cssColor('--color-bg-card', '#d8cfc0'), roughness: 0.9 }),
    );
    table.position.set(x / 2, y / 2, -6);
    g.add(table);
    const env = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)),
      new THREE.LineBasicMaterial({ color: accent }),
    );
    env.position.set(x / 2, y / 2, z / 2);
    g.add(env);
    const safe = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(x, y)),
      new THREE.LineBasicMaterial({ color: line, transparent: true, opacity: 0.6 }),
    );
    safe.position.set(x / 2, y / 2, safeZ);
    g.add(safe);
    const axisLen = Math.max(x, y) * 0.12;
    for (const [dir, col] of [[new THREE.Vector3(1, 0, 0), 0xd23c3c], [new THREE.Vector3(0, 1, 0), 0x3c9a3c], [new THREE.Vector3(0, 0, 1), 0x3c6ad2]] as const) {
      g.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), axisLen, col));
    }
    scene.add(g);
    kit.current.group = g;
    const t = (kit.current as unknown as { target?: THREE.Vector3 }).target;
    t?.set(x / 2, y / 2, z / 4);
    frame?.(Math.max(x, y, z) * 2.4);
    draw?.();
  }, [fields.travelX, fields.travelY, fields.travelZ, fields.safeZ]);

  return (
    <div className="machine-view" data-testid="machine-view" title="Left-drag to move · right-drag to rotate · wheel to zoom">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div className="machine-view-legend">
        {legend ?? `Travel ${fields.travelX} × ${fields.travelY} × ${fields.travelZ} mm · safe Z ${fields.safeZ} mm (grey plane)`}
      </div>
    </div>
  );
}

export function MachinesTab({ name, fields, onPatch, onSaveAs, picker, active, transport = fetchTransport }: MachinesTabProps) {
  const [cfg, setCfg] = useState<AskConfig>(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  });
  const patchCfg = (p: Partial<AskConfig>) =>
    setCfg((c) => {
      const next = { ...c, ...p };
      try {
        writeAskConfig(next, globalThis.localStorage);
      } catch {
        /* Storage blocked: the setting holds for this page only. */
      }
      return next;
    });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  /* The machine ON SCREEN now, read when a reply lands. 🔴 The picker stays live while the
   * model works: a reply checked against machine A (travel Z 100 -> safe Z 80 OK) was written
   * into machine B (travel Z 60), and its Undo put A's old values onto whatever was selected
   * (bughunt 2026-11-15). */
  const onScreen = useRef({ name, fields });
  onScreen.current = { name, fields };
  const connected = askConfigured(cfg);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, busy]);

  const lastUndoable = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'ai' && m.undo) return m.id;
    }
    return -1;
  }, [msgs]);
  const push = (m: NewMsg) => setMsgs((old) => [...old, { ...m, id: nextId.current++ } as Msg]);

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ role: 'user', text: ask });
    setPrompt('');
    const pre = preflight(cfg, ask, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) {
      push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail] });
      return;
    }
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      /* A link is READ by the dev server and its text sent along: the local
       * claude has no tools and cannot open it itself. */
      /* A link is read; "add <model>" with no link is RESEARCHED (dev web search). */
      const research = wantsResearch(ask) && researchQuery(ask) !== '';
      const linked = research ? await researchPages(researchQuery(ask), ctl.signal) : await readLinkedPages(ask, ctl.signal);
      const pagesText = research ? pagesBlockFromSearch(linked.pages) : pagesBlock(linked.pages);
      const r = readReply(await transport(buildMachineRequest(cfg, ask, fields, name, pagesText), ctl.signal));
      if (!r.ok) {
        push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. The machine is unchanged.`, notes: [r.failure.detail] });
        return;
      }
      if (onScreen.current.name !== name || JSON.stringify(onScreen.current.fields) !== JSON.stringify(fields)) {
        push({
          role: 'ai',
          tone: 'bad',
          text: 'Not changed: the machine on screen changed while the AI was working.',
          notes: ['Its answer was checked against the machine you asked about. Ask again for this one.'],
        });
        return;
      }
      const p = readMachineProposal(r.raw, fields);
      if (!p.ok) {
        push({ role: 'ai', tone: 'bad', text: 'Not changed: the proposal broke the rules.', notes: p.problems });
        return;
      }
      const keys = Object.keys(p.patch) as (keyof MachineFields)[];
      const missingNote = p.missing.length ? [`Not stated, so not set: ${p.missing.join(', ')}. Tell me those, or measure them.`] : [];
      if (keys.length === 0) {
        push({ role: 'ai', tone: 'note', text: p.why || 'Nothing to change.', notes: [...linked.notes, ...missingNote] });
        return;
      }
      const undo: Partial<MachineFields> = {};
      for (const k of keys) (undo as Record<string, unknown>)[k] = fields[k];
      const rows = machineRows(fields, p.patch);
      onPatch(p.patch);
      if (p.name) onSaveAs(p.name);
      push({
        role: 'ai',
        tone: 'ok',
        text: `Done. ${p.why}`.trim(),
        notes: [
          ...linked.notes,
          ...(p.name ? [`Saved as "${p.name}" in the machine list.`] : []),
          ...rows,
          ...missingNote,
          'Measure the machine to confirm these. A chat cannot check a machine.',
        ],
        undo,
        undoFor: p.name ?? name,
      });
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: `${f.headline}. The machine is unchanged.`, notes: [f.detail] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  const undo = (id: number, patch: Partial<MachineFields>, undoFor?: string) => {
    if (undoFor !== undefined && undoFor !== name) {
      push({ role: 'ai', tone: 'bad', text: `Not undone: that change was to "${undoFor}", and "${name || 'no machine'}" is on screen.`, notes: [] });
      return;
    }
    onPatch(patch);
    setMsgs((old) => old.map((m) => (m.id === id && m.role === 'ai' ? { ...m, tone: 'undone', undo: undefined, text: `Undone. ${m.text.replace(/^Done\.\s*/, '')}` } : m)));
  };

  /* Founder 2026-10-15: "able to filter cnc, 3d , pnp machines". */
  const [kind, setKind] = useState<'cnc' | '3d' | 'pnp'>(() => {
    try {
      const v = globalThis.localStorage?.getItem('2bee.app.machines.kind');
      return v === '3d' || v === 'pnp' ? v : 'cnc';
    } catch {
      return 'cnc';
    }
  });
  const pills = (
    <div className="machine-kinds" role="tablist" aria-label="Machine kind">
      {(['cnc', '3d', 'pnp'] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={kind === k}
          data-testid={`machines-kind-${k}`}
          onClick={() => {
            setKind(k);
            try {
              globalThis.localStorage?.setItem('2bee.app.machines.kind', k);
            } catch {
              /* remembered for this page only */
            }
          }}
        >
          {k}
        </button>
      ))}
    </div>
  );
  if (kind === '3d') return <PrintersSection active={active} kindPills={pills} />;
  if (kind === 'pnp') return <PnpSection active={active} kindPills={pills} />;

  return (
    <div className="cad-simple" data-testid="machines-tab">
      <section className="cad-chat" aria-label="Machine assistant" data-testid="machines-chat">
        <header className="cad-chat-head">
          <strong>Machine assistant</strong>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="machines-chat-clear"
          disabled={msgs.length === 0 && !abort.current}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
          <button type="button" className="cad-chat-status" onClick={() => setSetup((s) => !s)} title="AI connection settings">
            <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
            {connected ? 'AI ready' : 'Connect AI'}
          </button>
        </header>
        {pills}
        <div className="cnc-chat-designs">{picker}</div>
        <dl className="machine-facts" data-testid="machine-facts">
          {MACHINE_KEYS.map((k) => (
            <div key={k}>
              <dt>{MACHINE_FIELDS[k].label}</dt>
              <dd>
                {k === 'supportsArcs' ? (fields[k] ? 'yes' : 'no') : `${fields[k]} ${MACHINE_FIELDS[k].unit}`}
              </dd>
            </div>
          ))}
        </dl>
        {setup ? (
          <div className="cad-chat-setup">
            <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
          </div>
        ) : null}
        <div className="cad-chat-log" ref={log} aria-live="polite">
          {msgs.length === 0 ? (
            <div className="cad-chat-msg ai">
              {connected ? (
                'Tell me about your machine, e.g. "my router travels 1200 by 1200, 6 mm collet". I fill in the fields; you confirm them at the machine.'
              ) : (
                <>
                  The AI is not connected yet.{' '}
                  {setup ? null : (
                    <button type="button" className="cad-chat-undo" onClick={() => setSetup(true)}>
                      Set up AI
                    </button>
                  )}
                </>
              )}
            </div>
          ) : null}
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="cad-chat-msg user">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="machines-chat-reply">
                <div>{m.text}</div>
                {m.notes.length ? (
                  <ul>
                    {m.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                ) : null}
                {m.undo && m.id === lastUndoable ? (
                  <button type="button" className="cad-chat-undo" data-testid="machines-chat-undo" onClick={() => undo(m.id, m.undo!, m.undoFor)}>
                    Undo
                  </button>
                ) : null}
              </div>
            ),
          )}
          {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
        </div>
        <form
          className="cad-chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(prompt);
          }}
        >
          <textarea
            data-testid="machines-chat-prompt"
            rows={2}
            value={prompt}
            placeholder={connected ? 'Describe your machine…' : 'Connect the AI first'}
            disabled={!connected}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(prompt);
              }
            }}
          />
          {busy ? (
            <button type="button" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="machines-chat-send">
              Send
            </button>
          )}
        </form>
      </section>
      <div className="cad-simple-view">
        <div className="cad-simple-canvas">
          <MachineView fields={fields} active={active} />
        </div>
      </div>
    </div>
  );
}

export default MachinesTab;
