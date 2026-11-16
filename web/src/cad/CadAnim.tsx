// Play control for a 2bee.cad design that reads `$t` (see anim.worker.ts).
//
// ⚠ "Mentions `$t`" is the trigger for SHOWING the button, not proof the design
// moves (scad.ts ScadOptions.t says the same). If every built frame is the same
// size the control says so instead of pretending to animate.
import { useEffect, useRef, useState } from 'react';
import type { MeshResult } from './mesh';
import type { AnimReply, AnimRequest } from './anim.worker';

export const ANIM_FRAMES = 24;
const FPS = 8;
/** Workers per animation: cores minus one for the page, capped. Shown on screen. */
export function animWorkers(cores: number | undefined): number {
  return Math.max(1, Math.min(8, (cores ?? 4) - 1, ANIM_FRAMES));
}

export function mentionsT(source: string): boolean {
  return /\$t\b/.test(source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
}

/** A cheap fingerprint of where the geometry IS: a moving part changes the sum. */
function sig(m: MeshResult): string {
  let acc = 0;
  for (const p of m.parts) for (let i = 0; i < p.positions.length; i += 7) acc += p.positions[i];
  return `${m.stats.triangles}:${acc.toFixed(3)}`;
}

export function CadAnim({
  source,
  path,
  files,
  onFrame,
}: {
  source: string;
  path: string;
  files: Record<string, string>;
  /** A frame to show instead of the static mesh, or null to go back to it. */
  onFrame: (m: MeshResult | null) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [built, setBuilt] = useState(0);
  const [msPer, setMsPer] = useState(0);
  const [error, setError] = useState('');
  const frames = useRef<MeshResult[]>([]);
  const workers = useRef<Worker[]>([]);
  const cursor = useRef(0);
  const started = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const nWorkers = animWorkers(typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency);

  const stopWorkers = () => {
    for (const w of workers.current) w.terminate();
    workers.current = [];
  };

  /* A new source makes every built frame stale: drop them and stop. */
  useEffect(() => {
    stopWorkers();
    frames.current = [];
    setBuilt(0);
    setPlaying(false);
    setError('');
    onFrame(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, path]);
  useEffect(() => () => stopWorkers(), []);

  const start = () => {
    setPlaying(true);
    if (workers.current.length || frames.current.filter(Boolean).length === ANIM_FRAMES) return;
    started.current = performance.now();
    for (let k = 0; k < nWorkers; k++) {
      const indices: number[] = [];
      for (let i = k; i < ANIM_FRAMES; i += nWorkers) indices.push(i);
      const w = new Worker(new URL('./anim.worker.ts', import.meta.url), { type: 'module' });
      workers.current.push(w);
      w.onmessage = (ev: MessageEvent<AnimReply>) => {
        const r = ev.data;
        if (r.kind === 'frame') {
          frames.current[r.index] = r.result;
          setBuilt(frames.current.filter(Boolean).length);
          setMsPer(r.ms);
          setElapsed(performance.now() - started.current);
        } else if (r.kind === 'failed') {
          setError(`Frame ${r.index + 1} could not be built: ${r.why}`);
          stopWorkers();
        } else {
          w.terminate();
          workers.current = workers.current.filter((x) => x !== w);
        }
      };
      w.postMessage({ path, source, files, frames: ANIM_FRAMES, indices } satisfies AnimRequest);
    }
  };

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      /* Frames arrive out of order across workers: play the ones that exist, in t order. */
      const ready = frames.current.filter(Boolean);
      if (ready.length === 0) return;
      cursor.current = (cursor.current + 1) % ready.length;
      onFrame(ready[cursor.current]);
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, [playing, onFrame]);

  const still =
    built === ANIM_FRAMES && new Set(frames.current.map(sig)).size === 1
      ? 'Every frame is the same: this design reads $t but nothing moves.'
      : '';

  return (
    <div className="cad-anim" data-testid="cad-anim">
      <button
        type="button"
        data-testid="cad-anim-play"
        onClick={() => {
          if (playing) {
            setPlaying(false);
            onFrame(null);
          } else start();
        }}
        aria-label={playing ? 'Stop the animation' : 'Play the animation'}
      >
        {playing ? '■ Stop' : '▶ Play'}
      </button>
      {built < ANIM_FRAMES && (playing || built > 0) && !error ? (
        <span className="note">
          Building frames {built}/{ANIM_FRAMES} on {nWorkers} worker{nWorkers === 1 ? '' : 's'}
          {msPer ? ` · ${(msPer / 1000).toFixed(1)} s each` : ''}
        </span>
      ) : null}
      {built === ANIM_FRAMES && elapsed ? (
        <span className="note">
          {ANIM_FRAMES} frames in {(elapsed / 1000).toFixed(1)} s
        </span>
      ) : null}
      {error ? <span className="bad">{error}</span> : null}
      {still ? <span className="note">{still}</span> : null}
    </div>
  );
}
