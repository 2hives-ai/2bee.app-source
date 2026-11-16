// The build plate in 3D: the printable outline, a grid, and the parts of ONE
// plate at the placements the engine bridge returned (Orca's own read-back, or
// the optimiser's pick). pnp's `app.js` `makeViewer` + `placeMatrix`, in React.
//
// TWO VIEWS, NEVER MIXED (2bee_app 2026-11-12, founder: "Can we see the exact
// sliced object in the 3d? not just the scad object rendered?"):
//   - `show='model'`: the PLAN. Each part is the uploaded STL at the placement the
//     bridge reported. pnp's bridge cross-checks the engine's own object boxes
//     against these placements and reports a mismatch as a warning; that warning,
//     not this picture, is the evidence that the two agree.
//   - `show='sliced'`: the PRINT, read back from the slice's own G-code
//     (gcodePath.ts). Only the toolpath is drawn; the meshes are hidden. When the
//     toolpath is not there (loading, or it could not be read) NOTHING is drawn in
//     its place: a mesh shown under a "Sliced" label would be the plan wearing the
//     print's name.
//
// One WebGL context, drawn on demand (no animation loop): the tab can sit in a
// hidden panel without spending a frame.

import { useEffect, useRef } from 'react';
import { dragMode, noContextMenu, panTarget, type DragMode } from '../view3d/mouse';
import * as THREE from 'three';
import type { Placement } from './model';
import { KIND_COLOR, PATH_KINDS, type PathKind, type Toolpath } from './gcodePath';

export interface PlatePart {
  uid: number;
  /** Triangle vertices (9 per triangle) in the STL's own frame. */
  tri: Float32Array;
  color: string;
  placement: Placement | null;
}

export interface PlateViewProps {
  /** Orca's printable_area, "XxY" strings. */
  area: string[] | null;
  /** Orca's extruder_printable_area: one "XxY,XxY,..." polygon per extruder. The area only one of them reaches is shaded. */
  extruderAreas?: string[] | null;
  parts: PlatePart[];
  selected: number | null;
  onPick?: (uid: number | null) => void;
  /** The prime tower Orca placed, [x0, y0, x1, y1]. */
  tower?: [number, number, number, number] | null;
  /** False while the tab is hidden: nothing is drawn. */
  active: boolean;
  /** 'sliced' hides the parts and draws `toolpath` (or nothing when it is null). Default 'model'. */
  show?: 'model' | 'sliced';
  toolpath?: Toolpath | null;
  /** Layers 0..layer are drawn; `layer` itself in full colour, the ones below dimmed. */
  layer?: number;
  /** Travel moves (off by default). */
  travel?: boolean;
}

interface PathObj {
  kind: PathKind;
  below: THREE.BufferGeometry;
  cur: THREE.BufferGeometry;
  objs: THREE.LineSegments[];
  mats: THREE.Material[];
}

/** One buffer per kind, two geometries sharing it: the layers below (dimmed) and the current one. */
function buildPaths(tp: Toolpath, group: THREE.Group, bg: THREE.Color): PathObj[] {
  const out: PathObj[] = [];
  for (const kind of PATH_KINDS) {
    const b = tp.kinds[kind];
    if (!b.pos.length) continue;
    const attr = new THREE.BufferAttribute(b.pos, 3);
    const below = new THREE.BufferGeometry();
    below.setAttribute('position', attr);
    const cur = new THREE.BufferGeometry();
    cur.setAttribute('position', attr);
    const full = new THREE.Color(KIND_COLOR[kind]);
    const travel = kind === 'travel';
    const mBelow = new THREE.LineBasicMaterial({ color: full.clone().lerp(bg, travel ? 0.7 : 0.45), transparent: travel, opacity: travel ? 0.35 : 1 });
    const mCur = new THREE.LineBasicMaterial({ color: full, transparent: travel, opacity: travel ? 0.6 : 1 });
    const oBelow = new THREE.LineSegments(below, mBelow);
    const oCur = new THREE.LineSegments(cur, mCur);
    for (const o of [oBelow, oCur]) {
      o.frustumCulled = false;
      o.userData.kind = kind;
      group.add(o);
    }
    out.push({ kind, below, cur, objs: [oBelow, oCur], mats: [mBelow, mCur] });
  }
  return out;
}

const FALLBACK_AREA = ['0x0', '256x0', '256x256', '0x256'];

function cssColor(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Geometry centred in XY with z from 0 to h, as pnp's viewer stores it. */
function centred(tri: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tri.slice(), 3));
  g.computeBoundingBox();
  const b = g.boundingBox!;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** pnp `placeMatrix`: T(x,y) · Rz(rot) [· drop-to-plate · Ry · Rx about the box centre when tilted]. */
export function placeMatrix(geo: THREE.BufferGeometry, p: Placement): THREE.Matrix4 {
  const M = THREE.Matrix4;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const h = bb.max.z;
  const rz = new M().makeRotationZ(((p.rot || 0) * Math.PI) / 180);
  const tr = new M().makeTranslation(p.x, p.y, 0);
  if (!(p.tilt && (p.tilt[0] || p.tilt[1]))) return tr.multiply(rz);
  const A = new M()
    .makeRotationY((p.tilt[1] * Math.PI) / 180)
    .multiply(new M().makeRotationX((p.tilt[0] * Math.PI) / 180))
    .multiply(new M().makeTranslation(0, 0, -h / 2));
  const mn = new THREE.Vector3(1e9, 1e9, 1e9);
  const mx = new THREE.Vector3(-1e9, -1e9, -1e9);
  for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
    const v = new THREE.Vector3(x, y, z).applyMatrix4(A);
    mn.min(v);
    mx.max(v);
  }
  return tr.multiply(rz).multiply(new M().makeTranslation(-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)).multiply(A);
}

interface Kit {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  plate: THREE.Group;
  parts: THREE.Group;
  paths: THREE.Group;
  target: THREE.Vector3;
  draw: () => void;
  frame: (w: number, d: number) => void;
}

/** A rectangle of the plate that only extruder `only` (1-based, Orca's numbering) reaches. */
export interface OneNozzleZone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  only: number;
}

const rectOf = (pts: number[][]) => ({ x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) });

/**
 * The parts of the plate that exactly ONE extruder reaches, from Orca's extruder_printable_area (founder 2026-11-13:
 * "in the plate show the area what is accessible by only one of the nozzles"). Two extruders, axis-aligned rectangles
 * only (what the X2D profile states: extruder 1 0..256, extruder 2 20.5..256). Anything else returns [] and is not
 * guessed: a polygon that is not a rectangle, one extruder, or more than two.
 */
export function oneNozzleZones(area: string[] | null, extruderAreas: string[] | null | undefined): OneNozzleZone[] {
  if (!area || !extruderAreas || extruderAreas.length !== 2) return [];
  const parse = (list: string[]) => list.map((s) => s.trim().split('x').map(Number));
  const polys = extruderAreas.map((s) => parse(s.split(',')));
  const isRect = (pts: number[][]) => {
    if (pts.length !== 4 || pts.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return false;
    const r = rectOf(pts);
    return pts.every((p) => (p[0] === r.x0 || p[0] === r.x1) && (p[1] === r.y0 || p[1] === r.y1));
  };
  const bedPts = parse(area);
  if (!isRect(bedPts) || !polys.every(isRect)) return [];
  const bed = rectOf(bedPts);
  const [a, b] = polys.map((p) => {
    const r = rectOf(p);
    return { x0: Math.max(r.x0, bed.x0), y0: Math.max(r.y0, bed.y0), x1: Math.min(r.x1, bed.x1), y1: Math.min(r.y1, bed.y1) };
  });
  // Inside `r` and outside `o`: up to four rectangles.
  const minus = (r: typeof a, o: typeof a, only: number): OneNozzleZone[] => {
    const out: OneNozzleZone[] = [];
    const ix0 = Math.max(r.x0, o.x0), iy0 = Math.max(r.y0, o.y0), ix1 = Math.min(r.x1, o.x1), iy1 = Math.min(r.y1, o.y1);
    if (ix0 >= ix1 || iy0 >= iy1) return r.x1 > r.x0 && r.y1 > r.y0 ? [{ ...r, only }] : [];
    if (r.x0 < ix0) out.push({ x0: r.x0, y0: r.y0, x1: ix0, y1: r.y1, only });
    if (ix1 < r.x1) out.push({ x0: ix1, y0: r.y0, x1: r.x1, y1: r.y1, only });
    if (r.y0 < iy0) out.push({ x0: ix0, y0: r.y0, x1: ix1, y1: iy0, only });
    if (iy1 < r.y1) out.push({ x0: ix0, y0: iy1, x1: ix1, y1: r.y1, only });
    return out;
  };
  return [...minus(a, b, 1), ...minus(b, a, 2)];
}

export function PlateView({ area, extruderAreas = null, parts, selected, onPick, tower, active, show = 'model', toolpath = null, layer = 0, travel = false }: PlateViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<Kit | null>(null);
  const activeRef = useRef(active);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const geoCache = useRef(new Map<Float32Array, THREE.BufferGeometry>());
  const pathObjs = useRef<PathObj[]>([]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = 'This browser has no WebGL, so the 3D plate view is not available. Slicing and upload still work.';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'p3d-canvas');
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(200, -300, 400);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    camera.up.set(0, 0, 1);
    const plate = new THREE.Group();
    const partsG = new THREE.Group();
    const pathsG = new THREE.Group();
    pathsG.visible = false;
    scene.add(plate, partsG, pathsG);
    const target = new THREE.Vector3(128, 128, 0);
    let theta = -Math.PI / 2, phi = Math.PI / 4, radius = 500;
    const place = () => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi),
      );
      camera.lookAt(target);
    };
    const draw = () => {
      if (!activeRef.current) return;
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
    const dom = renderer.domElement;
    let drag: { x: number; y: number; x0: number; y0: number; mode: DragMode } | null = null;
    const ray = new THREE.Raycaster();
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, mode: dragMode(e) };
      dom.setPointerCapture?.(e.pointerId);
    };
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
      drag.x = e.clientX;
      drag.y = e.clientY;
      place();
      draw();
    };
    const up = (e: PointerEvent) => {
      const d = drag;
      drag = null;
      if (!d || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4 || !pickRef.current || !partsG.visible) return;
      const r = dom.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(partsG.children, true)[0];
      pickRef.current(hit ? (hit.object.userData.uid as number) : null);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      radius = Math.min(3000, Math.max(40, radius * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
      place();
      draw();
    };
    const unCtx = noContextMenu(dom);
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    kit.current = {
      renderer,
      scene,
      camera,
      plate,
      parts: partsG,
      paths: pathsG,
      target,
      draw,
      frame: (w, d) => {
        radius = Math.max(w, d) * 1.7;
        place();
        draw();
      },
    };
    place();
    resize();
    const cache = geoCache.current;
    return () => {
      ro.disconnect();
      unCtx();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('wheel', wheel);
      for (const g of cache.values()) g.dispose();
      cache.clear();
      for (const p of pathObjs.current) {
        p.below.dispose();
        p.cur.dispose();
        p.mats.forEach((m) => m.dispose());
      }
      pathObjs.current = [];
      renderer.dispose();
      el.removeChild(dom);
      kit.current = null;
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) kit.current?.draw();
  }, [active]);

  // The plate: outline, grid, a thin slab.
  const areaKey = (area ?? FALLBACK_AREA).join(';');
  const extruderKey = (extruderAreas ?? []).join(';');
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    k.plate.clear();
    const pts = areaKey.split(';').map((s) => s.trim().split('x').map(Number));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, d = Math.max(...ys) - y0;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w, d, 2),
      new THREE.MeshStandardMaterial({ color: cssColor('--color-bg-deep', '#1b2a20'), roughness: 0.9 }),
    );
    slab.position.set(x0 + w / 2, y0 + d / 2, -1.05);
    const grid = new THREE.GridHelper(Math.max(w, d), 16, 0x3a5c4a, 0x2a4a3a);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(x0 + w / 2, y0 + d / 2, 0.02);
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p[0], p[1], 0.05))),
      new THREE.LineBasicMaterial({ color: cssColor('--color-amber', '#f5a623') }),
    );
    k.plate.add(slab, grid, edge);
    // The area only one nozzle reaches: a hatched amber strip on the plate, with its own outline.
    for (const z of oneNozzleZones(areaKey.split(';'), extruderKey ? extruderKey.split(';') : null)) {
      const zw = z.x1 - z.x0, zd = z.y1 - z.y0;
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(zw, zd),
        new THREE.MeshBasicMaterial({ color: cssColor('--color-amber', '#f5a623'), transparent: true, opacity: 0.22, depthWrite: false }),
      );
      fill.position.set(z.x0 + zw / 2, z.y0 + zd / 2, 0.08);
      const hatch: THREE.Vector3[] = [];
      for (let t = -zd; t < zw; t += 4) {
        const ax = Math.max(t, 0), ay = ax - t, bx = Math.min(t + zd, zw), by = bx - t;
        hatch.push(new THREE.Vector3(z.x0 + ax, z.y0 + ay, 0.1), new THREE.Vector3(z.x0 + bx, z.y0 + by, 0.1));
      }
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(hatch), new THREE.LineBasicMaterial({ color: cssColor('--color-amber', '#f5a623') }));
      fill.userData.oneNozzle = z.only;
      k.plate.add(fill, lines);
    }
    k.target.set(x0 + w / 2, y0 + d / 2, 0);
    k.frame(w, d);
  }, [areaKey, extruderKey]);

  // The parts of this plate.
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    for (const c of k.parts.children) {
      const m = c as THREE.Mesh;
      (m.material as THREE.Material).dispose();
      if (m.userData.ownGeo) m.geometry.dispose();
    }
    k.parts.clear();
    const live = new Set<Float32Array>();
    for (const p of parts) {
      if (!p.placement) continue;
      live.add(p.tri);
      let geo = geoCache.current.get(p.tri);
      if (!geo) {
        geo = centred(p.tri);
        geoCache.current.set(p.tri, geo);
      }
      const mat = new THREE.MeshStandardMaterial({
        color: p.color,
        roughness: 0.6,
        emissive: p.uid === selected ? new THREE.Color(0x553300) : new THREE.Color(0x000000),
      });
      const m = new THREE.Mesh(geo, mat);
      m.userData.uid = p.uid;
      m.matrixAutoUpdate = false;
      m.matrix.copy(placeMatrix(geo, p.placement));
      m.matrixWorldNeedsUpdate = true;
      k.parts.add(m);
    }
    if (tower) {
      const [a, b, c, d] = tower;
      const t = new THREE.Mesh(
        new THREE.BoxGeometry(c - a, d - b, 40),
        new THREE.MeshStandardMaterial({ color: cssColor('--color-amber', '#f5a623'), transparent: true, opacity: 0.35 }),
      );
      t.userData.ownGeo = true;
      t.position.set((a + c) / 2, (b + d) / 2, 20);
      k.parts.add(t);
    }
    for (const [key, g] of geoCache.current) {
      if (!live.has(key)) {
        g.dispose();
        geoCache.current.delete(key);
      }
    }
    k.draw();
  }, [parts, selected, tower]);

  // The toolpath: rebuilt only when a different G-code was read.
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    for (const p of pathObjs.current) {
      p.below.dispose();
      p.cur.dispose();
      p.mats.forEach((m) => m.dispose());
    }
    k.paths.clear();
    pathObjs.current = toolpath ? buildPaths(toolpath, k.paths, new THREE.Color(cssColor('--color-bg-deep', '#1b2a20'))) : [];
  }, [toolpath]);

  // Which view, which layers: draw ranges only, no geometry is rebuilt while scrubbing.
  useEffect(() => {
    const k = kit.current;
    if (!k) return;
    const sliced = show === 'sliced';
    k.parts.visible = !sliced;
    k.paths.visible = sliced && !!toolpath;
    if (toolpath) {
      const top = toolpath.layers.length - 1;
      const li = Math.max(0, Math.min(top, layer));
      for (const p of pathObjs.current) {
        const le = toolpath.kinds[p.kind].layerEnd;
        const a = li > 0 ? le[li - 1] : 0;
        const b = le[li];
        p.below.setDrawRange(0, a * 2);
        p.cur.setDrawRange(a * 2, (b - a) * 2);
        const on = p.kind !== 'travel' || travel;
        p.objs.forEach((o) => (o.visible = on));
      }
    }
    k.draw();
  }, [show, toolpath, layer, travel]);

  return (
    <div className="p3d-view-host" data-testid="p3d-view" title="Drag to orbit · wheel to zoom · click a part to select it">
      <div ref={host} className="p3d-view-canvas" />
    </div>
  );
}
