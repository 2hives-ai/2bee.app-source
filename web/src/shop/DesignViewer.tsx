// CLICK THE PICTURE, TURN THE PART — a 3D viewer for one catalogue design.
//
// Founder 2026-10-15, verbatim: *"when I click on the preview it should open the
// 3d visualization"*. Used by the Designs tab (`ShopTab.tsx`) and the Simple
// flow's "Pick a design" step (`make/MakeFlow.tsx`). Only the IMAGE opens it; the
// card's own action (open in 2bee.cad / pick) is a separate button, unchanged.
//
// 🔴 WHAT IS SHOWN IS WHAT THIS APP BUILDS, NOT THE PART. The mesh comes from the
// same `parseScad` + `meshScene` the expert tab runs, with the design's import
// closure as the library host (see `viewer.worker.ts`), and it is drawn by the
// same `CadPreview` — so the mesher's verdict rides on the picture exactly as it
// does in 2bee.cad. The catalogue's own standing caveat ("Not checked against
// OpenSCAD") is repeated here, because a rotatable 3D model reads as MORE
// authoritative than a thumbnail, not less.
//
// ⚠ IT IS BUILT IN A WORKER AND CAN BE ABANDONED. A 300-part design meshes for
// many seconds. On the page that would be a frozen tab with no way to close the
// dialog; here the elapsed time is on screen, a slow build says so, Close
// terminates the worker, and a build that runs past VIEWER_GIVE_UP_MS is stopped
// and reported — never left spinning.

import { useEffect, useReducer, useRef, useState } from 'react';
import { CadPreview } from '../cad/preview';
import { ParamsPanel } from '../cad/ParamsPanel';
import { setParam } from '../cad/params';
import { applyVariant, currentVariant, variantLabel, type Variant } from './variants';
import { requestOpenIn } from './handoff';
import { captureCanvas, saveThumbnail, THUMB_SAVED_EVENT } from '../cnc/thumbnail';
import type { MeshResult } from '../cad/mesh';
import { loadDesign, trustLine, type ShopEntry } from './catalogue';

import { DESIGN_GIVE_UP_MS, runDesignWorker } from './designWorker';
import { DesignSpec } from './DesignSpec';
import { ARCHIVE_TITLE } from './archive';
import './DesignViewer.css';

/** After this long the dialog says the build is slow, and why. */
export const VIEWER_SLOW_MS = 4000;
/** The viewer stops waiting here — see `DESIGN_GIVE_UP_MS`. */
export const VIEWER_GIVE_UP_MS = DESIGN_GIVE_UP_MS;

/**
 * What the viewer shows. A catalogue design ({@link catalogueSubject}) or one of
 * the user's own saved models (`mine.ts`). `badge`/`note` are the verdict the
 * CARD carried, shown while the mesh builds; once drawn, CadPreview states the
 * live mesher's verdict on the picture itself.
 */
export interface ViewerSubject {
  id: string;
  title: string;
  /** A path-like label under the title. */
  path: string;
  /** Top-level parts, when known — used to say why a build is slow. */
  parts: number | null;
  badge: { cls: string; text: string };
  /** One sentence: the card's verdict in the words of whoever made it. */
  note: string;
  /** Fetch the source and its import closure. */
  load: () => Promise<{ path: string; sources: Record<string, string> }>;
  /** The parts this one file makes (fleet_parts.yaml defines), for the "which part" switch. */
  variants?: Variant[];
  /** A mesh that already exists (a user's saved model) — shown instead of building one. */
  saved?: () => MeshResult;
  /** A cad catalogue design: it has a functional specification (keyed by `path`). */
  catalogue?: boolean;
  /** The key "Save thumbnail" stores the picture under: the key the CARD reads
   *  (`savedPicture`). Defaults to `path`. A saved design's `path` is a label
   *  ("your design · X.scad") while its card reads its title, so the two must be
   *  named here, or the picture is saved where no card looks (bug fixed 2026-11-19). */
  thumbKey?: string;
}

export function catalogueSubject(e: ShopEntry, fetchImpl?: typeof fetch): ViewerSubject {
  return {
    id: e.id,
    title: e.title,
    path: e.path,
    parts: e.parts,
    badge: { cls: e.trust, text: e.trust === 'trusted' ? 'mesh closed' : e.trust },
    note: trustLine(e),
    load: () => loadDesign(e.id, fetchImpl ?? fetch),
    ...(e.variants ? { variants: e.variants } : {}),
    catalogue: true,
  };
}

const partsLabel = (n: number | null) => (n === null ? 'parts not counted' : `${n} part${n === 1 ? '' : 's'}`);

type Phase =
  | { kind: 'fetching' }
  | { kind: 'building'; files: number }
  | { kind: 'ready'; result: MeshResult }
  | { kind: 'failed'; why: string };

export { savedPicture } from './savedPicture';
import { savedPicture } from './savedPicture';

/** Re-render whenever a picture is saved anywhere on the page. */
export function useThumbSaves(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(THUMB_SAVED_EVENT, bump);
    return () => window.removeEventListener(THUMB_SAVED_EVENT, bump);
  }, []);
}

/** The clickable thumbnail. Its only job is to open the viewer. */
export function ThumbButton<E extends { id: string; title: string; thumb: string | null; path?: string }>({
  entry,
  onView,
  fallback,
}: {
  entry: E;
  onView: (e: E) => void;
  /** A picture drawn by this page when there is neither a saved nor a catalogue one. */
  fallback?: () => string | null;
}) {
  useThumbSaves();
  const saved = savedPicture(entry);
  const auto = !saved && !entry.thumb && fallback ? fallback() : null;
  return (
    /* 🔴 role="button", NOT <button>, and on purpose: every card already has its action as
     * a <button>, and journeys/make/designs specs (other lanes' files) find "the card's
     * button" with a CSS `button` query. A second native button made those ambiguous. This
     * is a full button to assistive tech and the keyboard: focusable, named, Enter/Space. */
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onView(entry);
        }
      }}
      className="shop-thumb shop-thumb-btn"
      onClick={() => onView(entry)}
      aria-label={`View ${entry.title} in 3D`}
      title={`View ${entry.title} in 3D`}
      data-testid={`view-3d-${entry.id}`}
    >
      {/* Founder 2026-10-15: a picture the user saved (from cad's "Save thumbnail") replaces the
          catalogue render, labelled as theirs: it is a picture of a view, not this page's render. */}
      {saved ? (
        <>
          <img src={saved.dataUrl} alt="" data-testid={`thumb-saved-${entry.id}`} />
          <span className="shop-thumb-src" aria-hidden="true">
            your picture
          </span>
        </>
      ) : entry.thumb ? (
        <img src={`shop/${entry.thumb}`} alt="" loading="lazy" />
      ) : auto ? (
        <>
          <img src={auto} alt="" data-testid={`thumb-auto-${entry.id}`} />
          <span className="shop-thumb-src" aria-hidden="true">
            default picture
          </span>
        </>
      ) : (
        <span className="shop-thumb-none">no picture</span>
      )}
      <span className="shop-thumb-3d" aria-hidden="true">
        3D
      </span>
    </div>
  );
}

export function DesignViewer({
  entry,
  onClose,
  onOpenInCad,
  onArchive,
  onOpenWith,
}: {
  entry: ViewerSubject;
  onClose: () => void;
  onOpenInCad?: () => void;
  /** Hide this design from the list in this browser (`archive.ts`); the dialog closes. Nothing is deleted. */
  onArchive?: () => void;
  /**
   * Send THIS source (the variables as set here, the chosen part included) to the 3d or cnc tab.
   * Resolves to the failure sentence, or null when it was handed over.
   */
  onOpenWith?: (target: '3d' | 'cnc', source: string, label: string) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'fetching' });
  const [elapsed, setElapsed] = useState(0);
  const [thumbNote, setThumbNote] = useState('');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /* Open as a real modal: the browser traps focus, inerts the page behind it and
   * turns Esc into `cancel` → `close`. Focus goes back to whatever opened it. */
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    /* 🔴 ONLY IF STILL CLOSED. `close` is dispatched ASYNCHRONOUSLY. Under React StrictMode (the
     * dev server) this effect runs mount → cleanup → mount: the cleanup's `close()` queues a
     * `close` event, the second mount re-opens the dialog and re-subscribes, and the queued event
     * then reached the NEW listener and unmounted the viewer — on the dev server a click on the
     * picture did nothing (founder, 2026-10-15), while the production build, which has no double
     * mount, passed every test. A real Esc/Close leaves the dialog closed when the event lands. */
    const onCloseEv = () => {
      if (!d.open) closeRef.current();
    };
    d.addEventListener('close', onCloseEv);
    return () => {
      d.removeEventListener('close', onCloseEv);
      if (d.open) d.close();
      opener?.focus?.();
    };
  }, []);

  /* The design as fetched, and its main file as the variables have it now
   * (founder 2026-11-13: "Add variables to the design as well (preview)"). */
  const [loaded, setLoaded] = useState<{ path: string; sources: Record<string, string> } | null>(null);
  const [mainSrc, setMainSrc] = useState<string | null>(null);

  /* Fetch the design (or read the saved mesh). Unmount (Close, Esc) drops the result. */
  useEffect(() => {
    let live = true;
    /* The clock runs while FETCHING too. bec9e7df65 (design variables) moved it into the build step only, so a slow
     * fetch read "Fetching the design… 0 s" with no "This is slow" and no word that Close stops it (e2e
     * design-viewer.spec.ts:75, red since; found 2026-11-15 when the browser suite could run again). The build
     * effect restarts it from 0 when the build begins. */
    const t0 = performance.now();
    setElapsed(0);
    const tick = setInterval(() => live && setElapsed(performance.now() - t0), 500);
    setLoaded(null);
    setMainSrc(null);
    setPhase({ kind: 'fetching' });
    (async () => {
      if (entry.saved) {
        let r: MeshResult;
        try {
          r = entry.saved();
        } catch (e) {
          if (live) setPhase({ kind: 'failed', why: `The saved mesh could not be read — ${String((e as Error)?.message ?? e)}` });
          return;
        }
        if (live) setPhase({ kind: 'ready', result: r });
        return;
      }
      let d: { path: string; sources: Record<string, string> };
      try {
        d = await entry.load();
      } catch (e) {
        if (live) setPhase({ kind: 'failed', why: `${entry.title} could not be fetched — ${String((e as Error)?.message ?? e)}` });
        return;
      }
      if (!live) return;
      setLoaded(d);
      setMainSrc(d.sources[d.path]);
    })().finally(() => clearInterval(tick));
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [entry]);

  /* Mesh it off the page; again on every variable change. A newer build aborts the older one. */
  useEffect(() => {
    if (!loaded || mainSrc === null) return;
    let live = true;
    const ctl = new AbortController();
    const t0 = performance.now();
    setElapsed(0);
    const tick = setInterval(() => live && setElapsed(performance.now() - t0), 500);
    setPhase({ kind: 'building', files: Object.keys(loaded.sources).length });
    (async () => {
      const r = await runDesignWorker(
        { path: loaded.path, source: mainSrc, files: { ...loaded.sources, [loaded.path]: mainSrc } },
        { signal: ctl.signal, giveUpMs: VIEWER_GIVE_UP_MS, parts: entry.parts ?? undefined },
      );
      clearInterval(tick);
      if (!live) return;
      setPhase(
        r.ok
          ? { kind: 'ready', result: r.result }
          : { kind: 'failed', why: `The 3D view could not be built — ${r.why} Open it in 2bee.cad to see it.` },
      );
    })();
    return () => {
      live = false;
      clearInterval(tick);
      ctl.abort();
    };
  }, [loaded, mainSrc, entry.parts]);

  const changed = loaded !== null && mainSrc !== null && mainSrc !== loaded.sources[loaded.path];

  const secs = Math.floor(elapsed / 1000);
  const result = phase.kind === 'ready' ? phase.result : null;
  const refused = result ? result.issues.filter((i) => i.severity === 'refused') : [];

  return (
    <dialog
      ref={ref}
      className="dv"
      aria-labelledby="dv-title"
      data-testid="design-viewer"
      data-state={phase.kind}
      data-triangles={result ? result.stats.triangles : undefined}
      onClick={(ev) => {
        /* A click on the backdrop (the dialog element itself, outside its box) closes. */
        if (ev.target === ref.current) ref.current?.close();
      }}
    >
      <div className="dv-box">
        <header className="dv-head">
          <div>
            <h2 id="dv-title" className="dv-title">
              {entry.title}
            </h2>
            <p className="dv-sub">
              {entry.path} · {partsLabel(entry.parts)}
            </p>
            {/* Founder 2026-10-16: the design's functional spec, here as in cad and cnc. */}
            {entry.catalogue ? (
              <DesignSpec
                path={entry.path}
                title={entry.title}
                onOpenInCad={
                  onOpenInCad
                    ? () => {
                        ref.current?.close();
                        onOpenInCad();
                      }
                    : undefined
                }
              />
            ) : null}
          </div>
          {onArchive ? (
            <button
              type="button"
              className="dv-close"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                ref.current?.close();
                onArchive();
              }}
              title={ARCHIVE_TITLE}
              data-testid="design-viewer-archive"
            >
              Archive
            </button>
          ) : null}
          <button type="button" className="dv-close" onClick={() => ref.current?.close()} data-testid="design-viewer-close" autoFocus>
            Close
          </button>
        </header>

        <div className="dv-trust" data-testid="design-viewer-trust">
          <span className={`shop-badge shop-badge-${entry.badge.cls}`}>{entry.badge.text}</span>{' '}
          {/* Once drawn, a non-trusted verdict is stated ON the picture by CadPreview
              (the live mesher's own sentence); repeating it here was the same text twice. */}
          {!result || result.trust === 'trusted' ? <span>{entry.note}</span> : null}
          <p className="dv-oracle">
            🔴 <strong>Not checked against OpenSCAD.</strong> This is what this app builds, not the part.
          </p>
          {refused.length > 0 ? (
            <details className="dv-refused" data-testid="design-viewer-refused">
              <summary>
                {refused.length} construct{refused.length === 1 ? ' was' : 's were'} refused and {refused.length === 1 ? 'is' : 'are'} missing from this view
              </summary>
              <ul>
                {refused.slice(0, 20).map((i, n) => (
                  <li key={n}>
                    <code>{i.name}</code> (line {i.line}) — {i.detail}
                  </li>
                ))}
                {refused.length > 20 ? <li>…and {refused.length - 20} more (open in 2bee.cad for the full list)</li> : null}
              </ul>
            </details>
          ) : null}
        </div>

        {loaded && mainSrc !== null && entry.variants && entry.variants.length > 1 ? (
          <VariantSwitch
            variants={entry.variants}
            source={mainSrc}
            base={loaded.sources[loaded.path]}
            busy={phase.kind === 'building'}
            onSource={setMainSrc}
          />
        ) : null}
        {loaded && mainSrc !== null && onOpenWith ? (
          <OpenWith
            label={entry.variants ? (() => { const v = currentVariant(mainSrc, entry.variants); return v ? variantLabel(v, entry.variants) : 'as set here'; })() : changed ? 'as set here' : ''}
            onOpen={async (t) => {
              const why = await onOpenWith(t, mainSrc, entry.variants ? (currentVariant(mainSrc, entry.variants)?.part ?? 'edited') : changed ? 'edited' : '');
              if (!why) ref.current?.close();
              return why;
            }}
          />
        ) : null}
        {loaded && mainSrc !== null ? (
          <div className="dv-params">
            <ParamsPanel
              source={mainSrc}
              busy={phase.kind === 'building'}
              note={changed ? 'Changed here only. Open in cad keeps these settings; the catalogue file is not touched.' : 'Change a variable to see the design rebuilt.'}
              onChange={(p, v) => {
                try {
                  setMainSrc(setParam(mainSrc, p, v));
                } catch {
                  /* the variable moved under the control; the panel re-reads on the next render */
                }
              }}
            />
            {changed ? (
              <div className="dv-params-actions">
                <button type="button" onClick={() => setMainSrc(loaded.sources[loaded.path])} data-testid="design-viewer-params-reset">
                  Reset
                </button>
                {onOpenInCad ? (
                  <button
                    type="button"
                    className="primary"
                    data-testid="design-viewer-params-open-cad"
                    onClick={() => {
                      requestOpenIn('cad', {
                        id: entry.id,
                        title: entry.title,
                        path: loaded.path,
                        source: mainSrc,
                        files: { ...loaded.sources, [loaded.path]: mainSrc },
                      });
                      ref.current?.close();
                      onOpenInCad();
                    }}
                  >
                    Open in cad with these settings
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="dv-stage">
          {result ? (
            <>
              {/* Founder 2026-10-16: "open up in 3d in colored (able to save the thumb there)". */}
              <CadPreview result={result} stale={false} showAxes={true} showScaleMarkers={false} projection="perspective" partHues />
              <div className="dv-thumb-bar">
                <span className="note">Colours tell the parts apart; they are not materials.</span>
                <button
                  type="button"
                  data-testid="design-viewer-save-thumb"
                  onClick={(e) => {
                    const stage = (e.currentTarget as HTMLElement).closest('.dv-stage');
                    const cv = stage?.querySelector<HTMLCanvasElement>('[data-testid="cad-preview-canvas"]');
                    const url = cv ? captureCanvas(cv) : null;
                    const ok = !!url && saveThumbnail(entry.thumbKey ?? entry.path, url);
                    setThumbNote(ok ? 'Saved as this design’s picture.' : 'Not saved: this browser refused it, or nothing was drawn yet.');
                  }}
                >
                  Save thumbnail
                </button>
                {thumbNote ? <span className="note" data-testid="design-viewer-thumb-note">{thumbNote}</span> : null}
              </div>
            </>
          ) : phase.kind === 'failed' ? (
            <p className="dv-msg dv-msg-bad" role="alert" data-testid="design-viewer-failed">
              {phase.why}
            </p>
          ) : (
            <div className="dv-msg" role="status" aria-live="polite" data-testid="design-viewer-building">
              {/* No value ⇒ indeterminate: the mesher reports no fraction done, so none is invented. */}
              <progress className="dv-bar" aria-label={phase.kind === 'fetching' ? 'Fetching the design' : 'Building the 3D view'} data-testid="design-viewer-progress" />
              <span>
                {phase.kind === 'fetching' ? `Fetching the design… ${secs} s` : `Building the 3D view of ${partsLabel(entry.parts)}… ${secs} s`}
              </span>
              {elapsed >= VIEWER_SLOW_MS ? (
                <span className="dv-slow" data-testid="design-viewer-slow">
                  This is slow: {partsLabel(entry.parts)}
                  {phase.kind === 'building' ? ` from ${phase.files} file${phase.files === 1 ? '' : 's'}` : ''}. The page still works; Close stops it.
                </span>
              ) : null}
            </div>
          )}
        </div>
        {result ? <p className="dv-hint">Left-drag to move · right-drag to rotate · wheel to zoom · Esc to close</p> : null}
      </div>
    </dialog>
  );
}

/**
 * Which of this file's registered parts to build (founder 2026-11-20: "a Variable to switch to buck
 * holder"). The choices are cad's rows in fleet_parts.yaml; picking one rewrites the variables it
 * defines, exactly as the Variables panel would. A part that cannot be applied is shown, disabled, with why.
 */
function VariantSwitch({ variants, source, base, busy, onSource }: { variants: Variant[]; source: string; base: string; busy: boolean; onSource: (s: string) => void }) {
  const now = currentVariant(source, variants);
  const tried = variants.map((v) => ({ v, r: applyVariant(base, v) }));
  return (
    <div className="dv-variants" role="group" aria-label="Which part" data-testid="design-viewer-variants">
      <span className="dv-variants-label">This file makes {variants.length} parts. Build:</span>
      {tried.map(({ v, r }) => (
        <button
          key={v.part}
          type="button"
          aria-pressed={now?.part === v.part}
          disabled={busy || !r.ok}
          title={r.ok ? `${v.part}: ${Object.entries(v.defines).map(([k, t]) => `${k} = ${t}`).join(', ') || 'the file as it stands'}` : r.why}
          onClick={() => {
            // Onto the variables as set now (other edits kept); onto the catalogue file if that fails.
            const a = applyVariant(source, v);
            if (a.ok) onSource(a.source);
            else if (r.ok) onSource(r.source);
          }}
          data-testid={`design-viewer-variant-${v.part}`}
        >
          {variantLabel(v, variants)}
        </button>
      ))}
      {now === null ? <span className="dv-variants-note">(variables changed by hand: none of these exactly)</span> : null}
    </div>
  );
}

/** Send what is built here, as set here, to the 3d or cnc tab. */
function OpenWith({ label, onOpen }: { label: string; onOpen: (t: '3d' | 'cnc') => Promise<string | null> }) {
  const [busy, setBusy] = useState<'' | '3d' | 'cnc'>('');
  const [why, setWhy] = useState('');
  const go = async (t: '3d' | 'cnc') => {
    setBusy(t);
    setWhy('');
    const w = await onOpen(t);
    setBusy('');
    if (w) setWhy(w);
  };
  return (
    <div className="dv-openwith" data-testid="design-viewer-open-with">
      <button type="button" className="primary" disabled={!!busy} onClick={() => void go('3d')} data-testid="design-viewer-open-3d">
        {busy === '3d' ? 'Building the STL…' : `3D print${label ? ` (${label})` : ''}`}
      </button>
      <button type="button" disabled={!!busy} onClick={() => void go('cnc')} data-testid="design-viewer-open-cnc">
        {busy === 'cnc' ? 'Saving for cnc…' : `Open in cnc${label ? ` (${label})` : ''}`}
      </button>
      {why ? <p className="p3d-err" role="alert">{why}</p> : null}
    </div>
  );
}

