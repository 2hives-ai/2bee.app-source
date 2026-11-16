/* Measure3D — a small 3D picture of WHAT TO MEASURE.
 *
 * Founder, 2026-10-14: *"if measurement needed the system will show what needs
 * to be measured and how"*, *"show it in an image"*, *"not svg, show it in 3d!"*.
 *
 * Renders a {@link MeasureScene} (`measureSpec.ts`, pure data) with three.js:
 * body parts in --muted, the measured part and its dimension line in --accent,
 * the dimension's label as an HTML overlay at the projected midpoint. Slow
 * auto-rotate until touched; drag to orbit. Reused by any page that needs a
 * "measure this" picture — the scene is the caller's, this file only draws it.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * - It is an illustration. Nothing reads a number out of it.
 * - 🔴 It never leaves a blank box. With no WebGL (probed before the first paint,
 *   and again by the real renderer construction in `makeRenderer`) it shows the caller's how-to text and says the 3D view is
 *   unavailable. A server render (no `document`) takes the same path, which is
 *   what the node test exercises.
 * - Colours are read from CSS custom properties at mount. A theme switch while
 *   the picture is open keeps the old colours until it is next mounted; the
 *   picture is mounted per field, so that window is one field.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as THREE from 'three';
import type { MeasureScene, Vec3 } from './measureSpec';

export const MEASURE3D_UNAVAILABLE = '3D view unavailable on this browser.';

/* Styles are INLINE, not in a stylesheet: this component is imported by more
 * than one page, and a node test cannot load a `.css` import. Tokens only. */
const BOX: CSSProperties = {
  position: 'relative',
  maxWidth: '100%',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  background: 'var(--bg)',
  overflow: 'hidden',
};
const LABEL: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  visibility: 'hidden',
  transform: 'translate(-50%, -130%)',
  padding: '1px 5px',
  borderRadius: 'var(--radius)',
  background: 'var(--panel)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  fontSize: 11,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

const DEFAULT_W = 260;
const DEFAULT_H = 200;

/**
 * Construct the renderer, or `null`. A local copy of `Viewport.tsx`'s
 * `tryRenderer` idea, NOT an import of it: `Viewport.tsx` reads
 * `window.location` at module load, so importing it from here broke every node
 * test that (transitively) imports this component.
 */
function makeRenderer(params: THREE.WebGLRendererParameters): THREE.WebGLRenderer | null {
  if (typeof document === 'undefined') return null;
  try {
    return new THREE.WebGLRenderer(params);
  } catch {
    return null;
  }
}

/** Cheap synchronous probe so the first paint is already the right one. */
function webglProbablyAvailable(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** A CSS custom property as a three colour. Tokens that compute to
 *  `color(srgb …)` / `color-mix()` are not parsed by three's `setStyle`; for
 *  those we fall back to the given hex rather than paint an unchanged colour. */
function cssVarColor(el: Element, name: string, fallback: string): THREE.Color {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (raw.startsWith('#') || raw.startsWith('rgb')) {
    try {
      return new THREE.Color(raw);
    } catch {
      /* fall through */
    }
  }
  return new THREE.Color(fallback);
}

export interface Measure3DProps {
  scene: MeasureScene;
  /** What the picture shows: the aria-label, and the heading of the no-3D
   *  fallback. E.g. "Where to measure the cutting diameter". */
  label: string;
  /** CSS pixels. Default 260 × 200. */
  width?: number;
  height?: number;
  /** Shown only when there is no 3D view, so the fallback still says how. */
  howTo?: ReactNode;
}

export default function Measure3D({ scene, label, width, height, howTo }: Measure3DProps) {
  const W = width ?? DEFAULT_W;
  const H = height ?? DEFAULT_H;
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const [gl, setGl] = useState<boolean>(() => webglProbablyAvailable());
  /* 🔴 KEYED ON THE SCENE'S CONTENT, NOT ITS IDENTITY. Callers build the scene inline
   * (`routerScene(...)` in RouterPage, `endMillScene(k)` in ToolsPage), so every re-render handed
   * over a NEW object and the effect below tore down and rebuilt the renderer: on the router page
   * the 200 ms status poll made a new WebGL context each time, 18-68 canvases in 10 s, and Chrome
   * logged "Too many active WebGL contexts" 77+ times (journey test, 2026-10-15). A scene is plain
   * data, so its JSON is its identity. */
  const sceneKey = JSON.stringify(scene);

  useEffect(() => {
    const el = host.current;
    if (!gl || !el) return;
    const renderer = makeRenderer({ antialias: true, alpha: true });
    if (!renderer) {
      setGl(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.display = 'block';
    el.prepend(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';

    const muted = cssVarColor(el, '--muted', '#8a8f98');
    const accent = cssVarColor(el, '--accent', '#f5a524');

    const junk: { dispose(): void }[] = [];
    const s = new THREE.Scene();
    s.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(30, 50, 40);
    s.add(sun);

    const root = new THREE.Group();
    s.add(root);
    const box = new THREE.Box3();

    const bodyMat = new THREE.MeshStandardMaterial({ color: muted, roughness: 0.6, metalness: 0.3 });
    const hiMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.2, emissive: accent, emissiveIntensity: 0.15 });
    junk.push(bodyMat, hiMat);

    for (const p of scene.parts) {
      let g: THREE.BufferGeometry;
      if (p.shape === 'box') g = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
      else g = new THREE.CylinderGeometry(p.size[0], p.size[1], p.size[2], 32);
      junk.push(g);
      const m = new THREE.Mesh(g, p.role === 'highlight' ? hiMat : bodyMat);
      m.position.set(...p.at);
      if (p.rot) m.rotation.set(...p.rot);
      root.add(m);
      m.updateMatrixWorld(true);
      box.expandByObject(m);
    }

    /* Dimension lines: the line, plus a small cone arrowhead at each end. */
    const lineMat = new THREE.LineBasicMaterial({ color: accent });
    const arrowMat = new THREE.MeshBasicMaterial({ color: accent });
    junk.push(lineMat, arrowMat);
    const size = box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length();
    const arrowGeo = new THREE.ConeGeometry(size * 0.018, size * 0.05, 12);
    junk.push(arrowGeo);
    const mids: THREE.Vector3[] = [];
    for (const d of scene.dims) {
      const a = new THREE.Vector3(...d.from);
      const b = new THREE.Vector3(...d.to);
      const lg = new THREE.BufferGeometry().setFromPoints([a, b]);
      junk.push(lg);
      root.add(new THREE.Line(lg, lineMat));
      const dir = b.clone().sub(a).normalize();
      for (const [at, toward] of [
        [b, dir],
        [a, dir.clone().negate()],
      ] as const) {
        const cone = new THREE.Mesh(arrowGeo, arrowMat);
        cone.position.copy(at);
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toward);
        root.add(cone);
      }
      box.expandByPoint(a).expandByPoint(b);
      mids.push(a.clone().add(b).multiplyScalar(0.5));
    }

    /* Frame: look at the bounding-box centre from the scene's camera direction. */
    const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const camPos: Vec3 = scene.camera ?? [centre.x + 20, centre.y + 15, centre.z + 40];
    const offset = new THREE.Vector3(...camPos).sub(centre);
    const radius = Math.max(offset.length(), 1);
    let theta = Math.atan2(offset.x, offset.z);
    let phi = Math.acos(Math.min(1, Math.max(-1, offset.y / radius)));
    const camera = new THREE.PerspectiveCamera(35, W / H, radius / 100, radius * 10);
    const place = () => {
      camera.position.set(
        centre.x + radius * Math.sin(phi) * Math.sin(theta),
        centre.y + radius * Math.cos(phi),
        centre.z + radius * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(centre);
    };

    /* Orbit by drag; auto-rotate until the first touch. */
    let touched = false;
    let drag: { x: number; y: number } | null = null;
    const canvas = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      touched = true;
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture?.(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      theta -= (e.clientX - drag.x) * 0.01;
      phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => {
      drag = null;
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    const v = new THREE.Vector3();
    let raf = 0;
    const frame = () => {
      if (!touched) theta += 0.006;
      place();
      renderer.render(s, camera);
      mids.forEach((m, i) => {
        const lab = labels.current[i];
        if (!lab) return;
        v.copy(m).project(camera);
        lab.style.left = `${((v.x + 1) / 2) * W}px`;
        lab.style.top = `${((1 - v.y) / 2) * H}px`;
        lab.style.visibility = v.z < 1 ? 'visible' : 'hidden';
      });
      raf = requestAnimationFrame(frame);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      for (const j of junk) j.dispose();
      renderer.dispose();
      // dispose() alone leaves the context for the browser to reclaim later; release it now.
      renderer.forceContextLoss();
      canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneKey IS the scene's identity (see above).
  }, [gl, sceneKey, W, H]);

  if (!gl) {
    return (
      <div
        className="measure3d measure3d--fallback"
        role="note"
        aria-label={label}
        data-testid="measure3d-fallback"
        style={{ ...BOX, width: W, padding: '10px 12px', fontSize: 12.5 }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
        {howTo ? <div>{howTo}</div> : null}
        <div style={{ color: 'var(--warn)', marginTop: 4 }}>{MEASURE3D_UNAVAILABLE}</div>
      </div>
    );
  }

  return (
    <div
      ref={host}
      className="measure3d"
      role="img"
      aria-label={label}
      data-testid="measure3d"
      style={{ ...BOX, width: W, height: H }}
    >
      {scene.dims.map((d, i) => (
        <div
          key={i}
          ref={(n) => {
            labels.current[i] = n;
          }}
          className="measure3d__label"
          aria-hidden="true"
          style={LABEL}
        >
          {d.label}
        </div>
      ))}
    </div>
  );
}
