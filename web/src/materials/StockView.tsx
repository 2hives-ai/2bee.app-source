/**
 * The materials tab's 3D: a stock panel as a box X × Y × thickness, a filament
 * as a spool, a PCB part as its package body. Same mouse as every 3D view
 * (`view3d/mouse.ts`: left-drag pan, right-drag orbit, wheel zoom).
 *
 * Only STATED sizes are drawn. A panel with no stated size, or a part whose
 * package size is unknown, draws nothing — the parent shows why instead.
 * The spool is the one shape not to scale (a spool's dimensions are not a
 * recorded fact), and its legend says so.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { dragMode, noContextMenu, panTarget, type DragMode } from '../view3d/mouse';

export type StockShape =
  | { kind: 'box'; x: number; y: number; z: number; color: string; opacity?: number; metal?: boolean }
  | { kind: 'spool'; color: string };

/** Display colour per planner material. Not data: a hint so panels are told apart. */
export const MATERIAL_COLOURS: Record<string, { color: string; opacity?: number; metal?: boolean }> = {
  plywood: { color: '#d9b77e' },
  mdf: { color: '#a8805e' },
  hardwood: { color: '#8b5a2b' },
  softwood: { color: '#e6c991' },
  acrylic: { color: '#bfe3ee', opacity: 0.55 },
  aluminium: { color: '#b9bec4', metal: true },
};

export function StockView({ shape, active, legend }: { shape: StockShape; active: boolean; legend: string }) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<{ scene?: THREE.Scene; group?: THREE.Group; draw?: () => void; frame?: (r: number, t: THREE.Vector3) => void; active?: boolean }>({});

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
    renderer.domElement.setAttribute('data-testid', 'materials-canvas');
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(1, -1.5, 2);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100000);
    camera.up.set(0, 0, 1);
    let theta = -Math.PI / 3, phi = Math.PI / 3.2, radius = 2000;
    const target = new THREE.Vector3();
    const place = () => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi),
      );
      camera.near = radius / 1000;
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
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
      if (drag.mode === 'pan') panTarget(camera, target, e.clientX - drag.x, e.clientY - drag.y, radius, dom.clientHeight);
      else {
        theta -= (e.clientX - drag.x) * 0.008;
        phi = Math.min(Math.PI / 2 - 0.02, Math.max(0.05, phi - (e.clientY - drag.y) * 0.008));
      }
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
      scene,
      draw,
      frame: (r, t) => { radius = r; target.copy(t); place(); draw(); },
    };
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

  const sig = JSON.stringify(shape);
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
    const g = new THREE.Group();
    let r = 100;
    const t = new THREE.Vector3();
    if (shape.kind === 'box') {
      const { x, y, z } = shape;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(shape.color),
        roughness: shape.metal ? 0.35 : 0.85,
        metalness: shape.metal ? 0.7 : 0,
        transparent: shape.opacity !== undefined,
        opacity: shape.opacity ?? 1,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
      box.position.set(x / 2, y / 2, z / 2);
      g.add(box);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z)), new THREE.LineBasicMaterial({ color: 0x555555 }));
      edges.position.copy(box.position);
      g.add(edges);
      t.set(x / 2, y / 2, z / 2);
      r = Math.max(x, y, z) * 1.8;
    } else {
      /* A nominal 1 kg spool (≈200 mm flange, 70 mm wide), NOT to scale with any record. */
      const col = new THREE.Color(shape.color);
      const flangeMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6 });
      const wound = new THREE.Mesh(new THREE.CylinderGeometry(90, 90, 62, 64), new THREE.MeshStandardMaterial({ color: col, roughness: 0.55 }));
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(27, 27, 72, 48), flangeMat);
      const f1 = new THREE.Mesh(new THREE.CylinderGeometry(100, 100, 4, 64), flangeMat);
      const f2 = f1.clone();
      f1.position.y = 33;
      f2.position.y = -33;
      for (const m of [wound, hub, f1, f2]) g.add(m);
      g.rotation.x = Math.PI / 2;
      g.position.z = 100;
      t.set(0, 0, 100);
      r = 520;
    }
    scene.add(g);
    kit.current.group = g;
    frame?.(r, t);
    draw?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return (
    <div className="machine-view" data-testid="materials-view" title="Left-drag to move · right-drag to rotate · wheel to zoom">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div className="machine-view-legend">{legend}</div>
    </div>
  );
}
