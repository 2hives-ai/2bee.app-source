// cnc.run's 3D: the workpiece, the clamp border, the program's path and the
// tool where the controller has got to.
//
// The path is `toolpath.ts` over the lines being streamed (the lifted air-cut
// lines during the air cut), coloured in two parts: answered by the controller
// and still to come. The tool is drawn at the position after the last answered
// line — what the SENDER knows, not a measured position (the simulated
// controller has no position worth showing; a real one is not connected).
// Renders on change only, so a hidden tab costs nothing.

import { useEffect, useMemo, useRef } from 'react';
import { dragMode, noContextMenu, panTarget, type DragMode } from '../view3d/mouse';
import * as THREE from 'three';
import { CLAMP_MARGIN_MM } from '../make/autoPlan';
import { toolAt, toolpathOf } from './toolpath';

function cssColor(name: string, fallback: string): THREE.Color {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

export interface RunView3DProps {
  lines: readonly string[];
  /** Lines the controller has answered (0 when nothing is streaming). */
  acked: number;
  stock: { x: number; y: number; t: number };
  toolDiameter: number;
  clamps: boolean;
  /** Short words over the view, e.g. "AIR CUT (SIMULATED)". */
  label: string;
  active?: boolean;
  /**
   * The tool where the CONTROLLER reports it (work X, Y, Z). When given, the tool is drawn here and
   * not at the last answered line: grblHAL answers a line when it enters the planner, a planner's
   * worth of moves ahead of the cutter. The coloured path still runs to the answered line.
   */
  toolPos?: readonly [number, number, number] | null;
}

interface Kit {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: THREE.Group;
  path: THREE.LineSegments | null;
  tool: THREE.Mesh;
  draw: () => void;
  frame: (cx: number, cy: number, cz: number, r: number) => void;
  active: boolean;
}

export default function RunView3D({ lines, acked, stock, toolDiameter, clamps, label, active = true, toolPos = null }: RunView3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<Kit | null>(null);
  const tp = useMemo(() => toolpathOf(lines), [lines]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = 'This browser has no WebGL, so the 3D view is not available. The steps below still work.';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'rs-canvas');
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(1, -1, 2);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 100000);
    camera.up.set(0, 0, 1);
    const world = new THREE.Group();
    scene.add(world);
    const tool = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24), new THREE.MeshStandardMaterial({ color: 0xb0b6bf, metalness: 0.6, roughness: 0.35 }));
    tool.rotation.x = Math.PI / 2;
    scene.add(tool);
    let theta = -Math.PI / 2.6, phi = Math.PI / 3.4, radius = 500;
    const target = new THREE.Vector3();
    const place = () => {
      camera.position.set(target.x + radius * Math.sin(phi) * Math.cos(theta), target.y + radius * Math.sin(phi) * Math.sin(theta), target.z + radius * Math.cos(phi));
      camera.lookAt(target);
    };
    const draw = () => {
      if (!kit.current?.active) return;
      renderer.render(scene, camera);
    };
    const frame = (cx: number, cy: number, cz: number, r: number) => {
      target.set(cx, cy, cz);
      radius = Math.max(50, r * 2.4);
      place();
    };
    const resize = () => {
      const w = el.clientWidth || 640, h = el.clientHeight || 360;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const dom = renderer.domElement;
    let drag: { x: number; y: number; mode: DragMode } | null = null;
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
    kit.current = { renderer, scene, camera, world, path: null, tool, draw, frame, active: true };
    resize();
    return () => {
      ro.disconnect();
      unCtx();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('wheel', wheel);
      renderer.dispose();
      dom.remove();
      kit.current = null;
    };
  }, []);

  /* Workpiece, clamp border and path: rebuilt when the program or the stock changes. */
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    for (const c of [...k.world.children]) {
      k.world.remove(c);
      (c as THREE.Mesh).geometry?.dispose?.();
    }
    const { x, y, t } = stock;
    const wood = new THREE.Mesh(
      new THREE.BoxGeometry(x, y, t),
      new THREE.MeshStandardMaterial({ color: 0xd9b27c, transparent: true, opacity: 0.45, roughness: 0.9 }),
    );
    wood.position.set(x / 2, y / 2, -t / 2);
    k.world.add(wood);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(wood.geometry), new THREE.LineBasicMaterial({ color: 0x8a6a3c }));
    edges.position.copy(wood.position);
    k.world.add(edges);
    if (clamps) {
      const m = CLAMP_MARGIN_MM;
      const mat = new THREE.MeshBasicMaterial({ color: cssColor('--accent', '#e8a33a'), transparent: true, opacity: 0.55 });
      const strip = (sx: number, sy: number, px: number, py: number) => {
        const s = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.6), mat);
        s.position.set(px, py, 0.4);
        k.world.add(s);
      };
      strip(x, m, x / 2, m / 2);
      strip(x, m, x / 2, y - m / 2);
      strip(m, y - 2 * m, m / 2, y / 2);
      strip(m, y - 2 * m, x - m / 2, y / 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tp.segs, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tp.segs.length), 3));
    const path = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    k.world.add(path);
    k.path = path;
    const r = Math.hypot(x, y, t) / 2;
    k.frame(x / 2, y / 2, 0, r);
    const d = Math.max(1, toolDiameter);
    k.tool.scale.set(d / 2, 30, d / 2);
  }, [tp, stock, clamps, toolDiameter]);

  /* Progress: colour the answered part, move the tool. */
  useEffect(() => {
    const k = kit.current;
    if (!k || !k.path) return;
    const done = cssColor('--ok', '#2e7d4f');
    const todo = cssColor('--accent', '#e8a33a');
    const fast = cssColor('--muted', '#888888');
    const col = k.path.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let s = 0; s < tp.lineOf.length; s++) {
      const c = tp.lineOf[s] < acked ? done : tp.rapid[s] ? fast : todo;
      col.setXYZ(2 * s, c.r, c.g, c.b);
      col.setXYZ(2 * s + 1, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    const [px, py, pz] = toolPos ?? toolAt(tp, acked);
    k.tool.position.set(px, py, pz + 15);
    k.draw();
  }, [tp, acked, stock, clamps, toolDiameter, toolPos]);

  useEffect(() => {
    if (!kit.current) return;
    kit.current.active = active;
    if (active) kit.current.draw();
  }, [active]);

  return (
    <div className="rs-view" aria-label={`3D: ${label}`}>
      <div ref={host} className="rs-canvas" />
      <p className="rs-view-label" data-testid="rs-view-label">{label}</p>
      {tp.stopped ? <p className="rs-view-note warn" data-testid="rs-path-stopped">{tp.stopped}</p> : null}
    </div>
  );
}
