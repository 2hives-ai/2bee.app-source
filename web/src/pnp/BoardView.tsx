/**
 * The selected board in 3D: every CPL part at its position and rotation, drawn
 * from `boardModel.ts`. Orbit by dragging, zoom with the wheel, hover a part
 * for its Ref, value and package.
 *
 * Colours say what the TRAY PLAN did with each part: amber = it has a lane,
 * grey = it does not (skipped by tier/DNP, or refused). Bottom-side parts hang
 * under the plate. The plate is the extent of the part centres, NOT the board
 * outline, and the legend says so.
 *
 * Rendered on demand (no animation loop), like the machines view.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { BoardModel } from './boardModel';
import type { StackupSides } from './stackup';
import { dragMode, noContextMenu, panTarget, type DragMode } from '../view3d/mouse';

function cssColor(name: string, fallback: string): THREE.Color {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return new THREE.Color(v || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

const PLATE_T = 1.6;

/**
 * `hot` is the part highlighted from EITHER side — a row hovered/focused in the
 * component list, or a part under the pointer here (reported by `onHot`). One
 * value, owned by the tab, so the list and the 3D cannot disagree about it.
 */
export function BoardView({
  model,
  laned,
  hot = null,
  onHot,
  travel = null,
  at = { x: 0, y: 0 },
  onMove,
  onDropBoard,
  stackup = null,
  extent,
  dimmed,
  partsGlb = null,
  describe,
  onModelled,
}: {
  model: BoardModel | null;
  laned: ReadonlySet<string>;
  hot?: string | null;
  onHot?(ref: string | null): void;
  /** The machine's X/Y travel (mm), drawn under the board; null = not stated. */
  travel?: { x: number; y: number } | null;
  /** Lower-left of the board's part extent, in machine mm (`placeOnTravel`). */
  at?: { x: number; y: number };
  /** A drag asks for a new position; the tab clamps it and passes it back as `at`. */
  onMove?(asked: { x: number; y: number }): void;
  /** Something was dropped on the view (a board row, or files). */
  onDropBoard?(e: React.DragEvent): void;
  /** The board rendered from pcb's gerbers (`stackup.ts`); null = plate fallback. */
  stackup?: StackupSides | null;
  /** The box `at` refers to: the gerber outline when rendered, else the plate. */
  extent?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Parts the list's filter hides: drawn faint, still hoverable. */
  dimmed?: ReadonlySet<string>;
  /** pcb's component models: kicad-cli's GLB scene, nodes named by reference. */
  partsGlb?: THREE.Object3D | null;
  /** The hover card's rows for a part: [label, value][] (value, package, side,
   *  placed by, X/Y/rot, tray lane). */
  describe?(ref: string): [string, string][];
  /** How many parts got a 3D model (the rest are boxes) — for the line below the view. */
  onModelled?(n: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const kit = useRef<{
    scene?: THREE.Scene;
    group?: THREE.Group;
    draw?: () => void;
    frame?: (cx: number, cy: number, r: number) => void;
    look?: (phi: number, theta: number) => void;
    pick?: (x: number, y: number) => THREE.Object3D | null;
    /** Every mesh of a part (a box, or all meshes of its 3D model), by reference. */
    meshes?: Map<string, THREE.Mesh[]>;
    /** The object that stands for a part's position (box, or model node). */
    anchors?: Map<string, THREE.Object3D>;
    outline?: THREE.LineSegments;
    camera?: THREE.PerspectiveCamera;
    travel?: THREE.Group;
  }>({});
  const onHotRef = useRef(onHot);
  onHotRef.current = onHot;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const atRef = useRef(at);
  atRef.current = at;
  const modelRef = useRef(model);
  modelRef.current = model;
  const travelRef = useRef(travel);
  travelRef.current = travel;
  const ext = extent ?? model?.plate ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const extRef = useRef(ext);
  extRef.current = ext;
  const [flipped, setFlipped] = useState(false);
  const onModelledRef = useRef(onModelled);
  onModelledRef.current = onModelled;
  /* Where the hover card sits (canvas px), and which part the POINTER is on —
   * a hot part the pointer is not on came from the list, and its card is
   * anchored to the part's projection instead. */
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const pointerOn = useRef<string | null>(null);
  const onPointerRef = useRef((at: { x: number; y: number }) => setCard(at));
  const flippedRef = useRef(flipped);
  flippedRef.current = flipped;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      // preserveDrawingBuffer: "Save thumbnail" (shop/PcbSaveThumb.tsx, founder 2026-10-16) reads
      // the canvas back after the frame; without it the read is blank. Same as cad/preview.tsx.
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      el.textContent = 'This browser has no WebGL, so the 3D view is not available.';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'pnp-board-canvas');
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(1, -1.5, 3);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    let theta = -Math.PI / 2.4,
      phi = Math.PI / 4.5,
      radius = 150;
    const target = new THREE.Vector3();
    const place = () => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi)
      );
      camera.lookAt(target);
      /* 🔴 DEPTH RANGE FOLLOWS THE ORBIT (founder: "when I rotate the pcb the
       * components are disappear and appear again"). With a fixed near = 0.1 mm
       * and far = 10 m, a 24-bit depth buffer resolves ~0.15 mm at the 500 mm the
       * machine view sits at — LESS than an 0402's 0.35 mm height and far less
       * than the 0.02 mm between a part's underside and the gerber face. Parts lost
       * the depth test to the board in patches that moved as the camera did.
       * near = radius/50 and far = radius·20 keep the resolution near 0.003 mm
       * at any zoom; the scene is never deeper than the travel, well inside far. */
      camera.near = Math.max(0.05, radius / 50);
      camera.far = radius * 20 + 1000;
      camera.updateProjectionMatrix();
    };
    const draw = () => renderer.render(scene, camera);
    const resize = () => {
      const w = el.clientWidth || 640,
        h = el.clientHeight || 400;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const ray = new THREE.Raycaster();
    const pick = (cx: number, cy: number) => {
      const g = kit.current.group;
      if (!g) return null;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      // Recursive: a part with a 3D model is a node tree under its wrap group.
      // The nearest thing hit wins — a board face in front of a part (a
      // bottom-side part seen from above) means the part is NOT under the
      // pointer. The highlight outline is ignored.
      const hit = ray
        .intersectObjects(g.children, true)
        .find((h) => h.object.userData.ref || h.object.userData.face);
      return hit && hit.object.userData.ref ? hit.object : null;
    };
    /* Board dragging: a left press ON the board (plate or a part) moves it over
     * the machine plane z = 0; anywhere else, or with the right button, orbits. */
    const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const onGround = (cx: number, cy: number) => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      return ray.ray.intersectPlane(ground, new THREE.Vector3());
    };
    const onBoard = (cx: number, cy: number) => {
      const g = kit.current.group;
      if (!g) return false;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      return ray.intersectObjects(g.children, true).some((h) => !(h.object as THREE.LineSegments).isLineSegments);
    };
    let moving: { p0: THREE.Vector3; at0: { x: number; y: number } } | null = null;
    let drag: { x: number; y: number; mode: DragMode } | null = null;
    let lastHover: string | null = null;
    const dom = renderer.domElement;
    const leave = () => {
      pointerOn.current = null;
      if (lastHover !== null) {
        lastHover = null;
        onHotRef.current?.(null);
      }
    };
    /* TEST HOOK, on the canvas node only (no global): where part `ref` is on
     * screen, so a browser test can point at a real part rather than guess. */
    /* TEST HOOK: set the orbit (polar, azimuth) directly, so a browser test can
     * render the board from fixed angles and compare what it sees. */
    (dom as unknown as { __look?: (phi: number, theta: number) => void }).__look = (p: number, t: number) => kit.current.look?.(p, t);
    /* TEST HOOK: how many parts have at least one pixel on screen right now.
     * Renders an ID image off-screen — every part mesh a flat colour that is its
     * index, everything else black but still depth-tested — and counts distinct
     * colours, returning those parts' refs. A part lost to the depth test drops out. */
    (dom as unknown as { __visibleParts?: () => string[] }).__visibleParts = () => {
      const meshes = kit.current.meshes;
      if (!meshes) return [];
      const w = dom.width;
      const h = dom.height;
      const rt = new THREE.WebGLRenderTarget(w, h);
      const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
      const saved: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
      const hidden: THREE.Object3D[] = [];
      let i = 0;
      const idOf = new Map<THREE.Mesh, number>();
      const refOf: string[] = [];
      for (const [ref, list] of meshes) {
        i++;
        refOf[i] = ref;
        for (const m of list) idOf.set(m, i);
      }
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if ((o as THREE.LineSegments).isLineSegments || (o as THREE.Light).isLight) {
          if (o.visible) hidden.push(o);
          return;
        }
        const isPts = (o as THREE.Points).isPoints;
        if (!m.isMesh && !isPts) return;
        saved.push([m, m.material]);
        const id = idOf.get(m);
        const col = id ? new THREE.Color((id & 255) / 255, ((id >> 8) & 255) / 255, 1) : null;
        m.material = isPts
          ? new THREE.PointsMaterial({ color: col ?? 0x000000, size: 4, sizeAttenuation: false })
          : col
            ? new THREE.MeshBasicMaterial({ color: col })
            : black;
      });
      for (const o of hidden) o.visible = false;
      const bg = scene.background;
      scene.background = new THREE.Color(0, 0, 0);
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      const px = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
      renderer.setRenderTarget(null);
      scene.background = bg;
      for (const o of hidden) o.visible = true;
      for (const [m, mat] of saved) {
        if (m.material !== black) (m.material as THREE.Material).dispose();
        m.material = mat;
      }
      black.dispose();
      rt.dispose();
      const seen = new Set<number>();
      for (let k = 0; k < px.length; k += 4) if (px[k + 2] > 200) seen.add(px[k] | (px[k + 1] << 8));
      renderer.render(scene, camera);
      return [...seen].map((k) => refOf[k]).filter(Boolean).sort();
    };
    (dom as unknown as { __screenOf?: (ref: string) => { x: number; y: number } | null }).__screenOf = (ref: string) => {
      const m = kit.current.anchors?.get(ref);
      if (!m) return null;
      const v = m.getWorldPosition(new THREE.Vector3()).project(camera);
      const r = dom.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
    /* The app's mouse convention (`view3d/mouse.ts`, founder: "on every 3d: left
     * click -> move the object, right click : rotate"): left-drag ON the board
     * moves the board, left-drag elsewhere pans the view; right-drag (or
     * shift + left) orbits; the wheel zooms. */
    const down = (e: PointerEvent) => {
      dom.setPointerCapture?.(e.pointerId);
      const mode = dragMode(e);
      if (mode === 'pan' && onMoveRef.current && onBoard(e.clientX, e.clientY)) {
        const p0 = onGround(e.clientX, e.clientY);
        if (p0) {
          moving = { p0, at0: { ...atRef.current } };
          dom.style.cursor = 'grabbing';
          return;
        }
      }
      drag = { x: e.clientX, y: e.clientY, mode };
    };
    const move = (e: PointerEvent) => {
      if (moving) {
        const p = onGround(e.clientX, e.clientY);
        if (p) onMoveRef.current?.({ x: moving.at0.x + (p.x - moving.p0.x), y: moving.at0.y + (p.y - moving.p0.y) });
        return;
      }
      if (!drag) {
        const o = pick(e.clientX, e.clientY);
        const ref = (o?.userData.ref as string | undefined) ?? null;
        pointerOn.current = ref;
        if (ref) {
          const r = dom.getBoundingClientRect();
          onPointerRef.current?.({ x: e.clientX - r.left, y: e.clientY - r.top });
        }
        if (ref !== lastHover) {
          lastHover = ref;
          onHotRef.current?.(ref);
        }
        dom.style.cursor = onMoveRef.current && onBoard(e.clientX, e.clientY) ? 'grab' : '';
        return;
      }
      if (drag.mode === 'pan') {
        panTarget(camera, target, e.clientX - drag.x, e.clientY - drag.y, radius, dom.clientHeight);
        drag = { x: e.clientX, y: e.clientY, mode: 'pan' };
        place();
        draw();
        return;
      }
      theta -= (e.clientX - drag.x) * 0.008;
      // Free azimuth, and the polar angle runs from just off straight-down to
      // just off straight-up (founder: "able to 360 rotate the object"): the
      // board is seen from BELOW as easily as from above. Only the two poles are
      // excluded, where `lookAt` with Z-up has no defined heading.
      phi = Math.min(Math.PI - 0.02, Math.max(0.02, phi - (e.clientY - drag.y) * 0.008));
      drag = { x: e.clientX, y: e.clientY, mode: 'orbit' };
      place();
      draw();
    };
    const up = () => {
      drag = null;
      if (moving) dom.style.cursor = 'grab';
      moving = null;
    };
    const offMenu = noContextMenu(dom);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      radius *= e.deltaY > 0 ? 1.1 : 1 / 1.1;
      place();
      draw();
    };
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    dom.addEventListener('pointerleave', leave);

    kit.current = {
      scene,
      draw,
      pick,
      camera,
      look: (p, t) => {
        phi = p;
        theta = t;
        place();
        draw();
      },
      frame: (cx, cy, r) => {
        target.set(cx, cy, 0);
        // A narrow view (a phone) needs the camera further out to fit the width.
        radius = r / Math.min(1, camera.aspect || 1);
        place();
        draw();
      },
    };
    place();
    resize();
    return () => {
      ro.disconnect();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('wheel', wheel);
      dom.removeEventListener('pointerleave', leave);
      offMenu();
      renderer.dispose();
      el.removeChild(dom);
      kit.current = {};
    };
  }, []);

  useEffect(() => {
    const { scene, draw } = kit.current;
    if (!scene) return;
    if (kit.current.group) {
      scene.remove(kit.current.group);
      kit.current.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        ((m.material as THREE.MeshBasicMaterial | undefined)?.map as THREE.Texture | undefined)?.dispose?.();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      kit.current.group = undefined;
      kit.current.meshes = undefined;
      kit.current.anchors = undefined;
      kit.current.outline = undefined;
    }
    if (!model || model.parts.length === 0) {
      draw?.();
      return;
    }
    const g = new THREE.Group();
    if (stackup?.entry.box) {
      /* The real board: pcb's gerbers rendered by pcb-stackup, top face seen
       * from above, bottom face from below (that SVG is mirrored in X, so its
       * plane is turned about Y, not X). Transparent outside the Edge_Cuts
       * outline, so the board has its real shape. The two faces are PLATE_T
       * apart; a thin edge band is not drawn. */
      const b = stackup.entry.box;
      const face = (c: HTMLCanvasElement, z: number, flip: boolean) => {
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(b.w, b.h),
          new THREE.MeshBasicMaterial({
            map: t,
            transparent: true,
            alphaTest: 0.5,
            side: THREE.FrontSide,
            // Pushed back in depth so a part sitting ON the face (its underside
            // 0.02 mm away) never fights it for the same pixels.
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 4,
          })
        );
        m.position.set(b.minX + b.w / 2, b.minY + b.h / 2, z);
        if (flip) m.rotation.y = Math.PI;
        m.userData.face = true;
        return m;
      };
      g.add(face(stackup.top, 0.02, false));
      g.add(face(stackup.bottom, -PLATE_T - 0.02, true));
    } else {
      const { maxX, maxY } = model.plate;
      const pw = maxX - model.plate.minX,
        ph = maxY - model.plate.minY;
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(pw, ph, PLATE_T),
        new THREE.MeshStandardMaterial({ color: 0x3d6b4a, roughness: 0.8, transparent: true, opacity: 0.92 })
      );
      plate.position.set(model.plate.minX + pw / 2, model.plate.minY + ph / 2, -PLATE_T / 2);
      g.add(plate);
    }
    const amber = cssColor('--color-amber', '#c47a14');
    const grey = cssColor('--color-text-muted', '#8a8a8a');
    const handC = cssColor('--pnp-hand', '#8b5cf6');
    const meshes = new Map<string, THREE.Mesh[]>();
    const anchors = new Map<string, THREE.Object3D>();
    /* pcb's 3D models (kicad-cli's GLB of the board, `partsGlb`): glTF is metres
     * and Y-up, with x = page x and z = page y, so (x, y, z) → (x, −z, y)·1000,
     * a +90° turn about X and ×1000; KiCad seats top parts at y = board top
     * (1.615 mm in every export measured) — that height goes to z = 0. */
    const byName = new Map<string, THREE.Object3D>();
    let seat = 1.615;
    if (partsGlb) {
      for (const n of partsGlb.children) if (n.name) byName.set(n.name, n);
      const ys = [...byName.values()].map((n) => n.position.y * 1000);
      if (ys.length && Math.max(...ys) > 0.5) seat = Math.max(...ys);
    }
    let modelled = 0;
    for (const p of model.parts) {
      const onLane = laned.has(p.ref);
      const by = (p as { by?: string }).by ?? 'machine';
      const col = by !== 'machine' ? handC : onLane ? amber : grey;
      const node = byName.get(p.ref);
      if (node) {
        const wrap = new THREE.Group();
        wrap.rotation.x = Math.PI / 2;
        wrap.scale.setScalar(1000);
        wrap.position.z = -seat;
        const c = node.clone(true);
        wrap.add(c);
        const list: THREE.Mesh[] = [];
        c.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const src = mesh.material as THREE.MeshStandardMaterial;
          const mat = src.clone();
          // The model keeps its own colours; a part our machine does not place
          // is tinted towards the hand colour so the two read apart in 3D too.
          if (by !== 'machine') mat.color.lerp(handC, 0.55);
          mesh.material = mat;
          mesh.userData = { ref: p.ref, value: p.value, pkg: p.pkg, base: mat.color.clone() };
          list.push(mesh);
        });
        meshes.set(p.ref, list);
        anchors.set(p.ref, c);
        g.add(wrap);
        modelled++;
        continue;
      }
      const geo = new THREE.BoxGeometry(p.body.l, p.body.w, p.body.h);
      const mat =
        p.body.from === 'unknown'
          ? new THREE.MeshBasicMaterial({ color: col, wireframe: true })
          : new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 });
      const m = new THREE.Mesh(geo, mat);
      const z = p.side === 'top' ? p.body.h / 2 : -PLATE_T - p.body.h / 2;
      m.position.set(p.x, p.y, z);
      m.rotation.z = (p.rot * Math.PI) / 180;
      m.userData = { ref: p.ref, value: p.value, pkg: p.pkg, base: (mat as THREE.MeshBasicMaterial).color.clone() };
      meshes.set(p.ref, [m]);
      anchors.set(p.ref, m);
      g.add(m);
    }
    /* 🔴 A MARKER PER PART, NEVER SMALLER THAN 4 px (founder: "when I rotate
     * the pcb the components are disappear and appear again"). Measured with the
     * ID render below: at the machine view an 0402 is ~2×1 px, and whether a
     * triangle that small covers a pixel centre changes with the angle — 80 to 96
     * of outlet's 98 parts on screen across eight azimuths, the missing ones
     * different each time. A screen-size point on each part's top face keeps
     * every part visible at any zoom; it is depth-tested, so a part hidden
     * behind a taller one stays hidden, as it should. */
    g.updateMatrixWorld(true);
    const gInv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    for (const list of meshes.values()) {
      const box = new THREE.Box3();
      for (const m of list) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(gInv, m.matrixWorld)));
      }
      if (box.isEmpty()) continue;
      const c = box.getCenter(new THREE.Vector3());
      const bottom = c.z < -PLATE_T / 2;
      const geo = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute([c.x, c.y, bottom ? box.min.z - 0.01 : box.max.z + 0.01], 3)
      );
      const base = (list[0].userData.base as THREE.Color).clone();
      const pt = new THREE.Points(geo, new THREE.PointsMaterial({ color: base, size: 4, sizeAttenuation: false }));
      pt.userData = { ...list[0].userData, base };
      list.push(pt as unknown as THREE.Mesh);
      g.add(pt);
    }
    placeGroup(g, atRef.current);
    scene.add(g);
    kit.current.group = g;
    kit.current.meshes = meshes;
    kit.current.anchors = anchors;
    onModelledRef.current?.(modelled);
    // The board, not the whole travel: parts are what this view is for. "Fit
    // machine" shows the travel.
    fit('board');
  }, [model, laned, stackup, partsGlb]);

  /* The board's place on the machine: moved, never rebuilt. */
  useEffect(() => {
    const { group, draw } = kit.current;
    if (!group || !modelRef.current) return;
    placeGroup(group, at);
    draw?.();
  }, [at.x, at.y, ext.minX, ext.minY, flipped]);

  /* Flip board: turned over about its X axis, as an operator turns a PCB to
   * place the second side. The extent stays at `at`, the old underside on top. */
  function placeGroup(g: THREE.Group, a: { x: number; y: number }) {
    const e = extRef.current;
    if (flippedRef.current) {
      g.rotation.set(Math.PI, 0, 0);
      g.position.set(a.x - e.minX, a.y + e.maxY, -PLATE_T);
    } else {
      g.rotation.set(0, 0, 0);
      g.position.set(a.x - e.minX, a.y - e.minY, 0);
    }
  }

  /* The machine's travel, under the board: a faint area and its outline at z
   * just below the board's underside. Absent when `pnp` states no travel. */
  useEffect(() => {
    const { scene, draw } = kit.current;
    if (!scene) return;
    if (kit.current.travel) {
      scene.remove(kit.current.travel);
      kit.current.travel.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      kit.current.travel = undefined;
    }
    if (travel) {
      const t = new THREE.Group();
      const z = -PLATE_T - 3;
      const area = new THREE.Mesh(
        new THREE.PlaneGeometry(travel.x, travel.y),
        new THREE.MeshBasicMaterial({ color: cssColor('--color-bg-secondary', '#eee8dc'), transparent: true, opacity: 0.9 })
      );
      area.position.set(travel.x / 2, travel.y / 2, z);
      t.add(area);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(travel.x, travel.y)),
        new THREE.LineBasicMaterial({ color: cssColor('--color-amber', '#c47a14') })
      );
      edge.position.set(travel.x / 2, travel.y / 2, z + 0.05);
      t.add(edge);
      scene.add(t);
      kit.current.travel = t;
    }
    draw?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travel?.x, travel?.y]);

  function fit(what: 'board' | 'machine') {
    const { frame } = kit.current;
    const m = modelRef.current;
    const t = travelRef.current;
    if (what === 'machine' && t) frame?.(t.x / 2, t.y / 2, Math.max(t.x, t.y) * 1.25);
    else if (m && m.parts.length) {
      const e = extRef.current;
      const w = e.maxX - e.minX,
        h = e.maxY - e.minY;
      frame?.(atRef.current.x + w / 2, atRef.current.y + h / 2, Math.max(w, h) * 1.35 + 10);
    }
  }

  /* The highlight: the hot part turns the highlight colour and gets an outline
   * box a little larger than its body, so even a 0402 under a cluster is found.
   * Applied without rebuilding the board. */
  useEffect(() => {
    const { meshes, group, draw } = kit.current;
    if (!meshes || !group) return;
    const hi = cssColor('--pnp-hot', '#2563eb');
    for (const [ref, list] of meshes)
      for (const m of list) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.copy(ref === hot ? hi : (m.userData.base as THREE.Color));
        const faint = !!dimmed?.has(ref) && ref !== hot;
        mat.transparent = faint;
        mat.opacity = faint ? 0.15 : 1;
        mat.needsUpdate = true;
      }
    if (kit.current.outline) {
      group.remove(kit.current.outline);
      kit.current.outline.geometry.dispose();
      (kit.current.outline.material as THREE.Material).dispose();
      kit.current.outline = undefined;
    }
    const list = hot ? meshes.get(hot) : undefined;
    if (list?.length) {
      /* The outline: the part's bounds in the board group's own frame (so it
       * moves and flips with the board), padded so a 0402 is still findable. */
      group.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
      const box = new THREE.Box3();
      for (const m of list) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)));
      }
      const size = box.getSize(new THREE.Vector3());
      const pad = 0.8;
      const o = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x + pad, size.y + pad, size.z + pad)),
        new THREE.LineBasicMaterial({ color: hi })
      );
      box.getCenter(o.position);
      group.add(o);
      kit.current.outline = o;
    }
    draw?.();
  }, [hot, model, laned, dimmed, stackup, partsGlb]);

  useEffect(() => {
    if (!hot) return setCard(null);
    if (pointerOn.current === hot) return;
    const a = kit.current.anchors?.get(hot);
    const cam = kit.current.camera;
    const el = host.current;
    if (!a || !cam || !el) return setCard(null);
    const v = a.getWorldPosition(new THREE.Vector3()).project(cam);
    setCard({ x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight });
  }, [hot]);

  const hotPart = hot && model ? model.parts.find((p) => p.ref === hot) : undefined;
  return (
    <div
      className="pnp-view"
      data-testid="pnp-board-view"
      data-hot={hot ?? ''}
      data-flipped={flipped ? 'yes' : 'no'}
      data-dimmed={dimmed?.size ?? 0}
      title={
        onMove
          ? 'Left-drag the board to move it · left-drag elsewhere to pan · right-drag (or shift + drag) to rotate · wheel to zoom'
          : 'Left-drag to pan · right-drag (or shift + drag) to rotate · wheel to zoom'
      }
      onDragOver={(e) => {
        if (onDropBoard) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        if (onDropBoard) {
          e.preventDefault();
          onDropBoard(e);
        }
      }}
    >
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {model && model.parts.length ? (
        <div className="pnp-view-fit">
          <button type="button" onClick={() => fit('board')} data-testid="pnp-fit-board">
            Fit board
          </button>
          {travel ? (
            <button type="button" onClick={() => fit('machine')} data-testid="pnp-fit-machine">
              Fit machine
            </button>
          ) : null}
          <button type="button" onClick={() => kit.current.look?.(0.02, -Math.PI / 2)} data-testid="pnp-view-top" title="Look straight down">
            Top
          </button>
          <button type="button" onClick={() => kit.current.look?.(Math.PI - 0.02, -Math.PI / 2)} data-testid="pnp-view-bottom" title="Look straight up, from under the board">
            Bottom
          </button>
          <button type="button" onClick={() => kit.current.look?.(Math.PI / 4.5, -Math.PI / 2.4)} data-testid="pnp-view-iso">
            Iso
          </button>
          <button
            type="button"
            aria-pressed={flipped}
            onClick={() => setFlipped((f) => !f)}
            data-testid="pnp-flip"
            title="Turn the board over (bottom side up)"
          >
            {flipped ? 'Unflip board' : 'Flip board'}
          </button>
        </div>
      ) : null}
      {hotPart && card ? (
        /* The ONE text on the canvas (founder: "remove the comments from the 3d"
         * · "when I hover the mouse on top of a component show it"): a card
         * beside the pointer — or beside the part, when the row is hovered in
         * the list — offset so it never covers the part, and flipped to the
         * other side near an edge. pointer-events: none, so it cannot steal the
         * hover that made it. */
        <div
          className="pnp-hover-card"
          data-testid="pnp-hover-card"
          style={{
            left: card.x > (host.current?.clientWidth ?? 0) - 260 ? undefined : card.x + 18,
            right: card.x > (host.current?.clientWidth ?? 0) - 260 ? (host.current?.clientWidth ?? 0) - card.x + 18 : undefined,
            top: card.y > (host.current?.clientHeight ?? 0) - 170 ? undefined : card.y + 18,
            bottom: card.y > (host.current?.clientHeight ?? 0) - 170 ? (host.current?.clientHeight ?? 0) - card.y + 18 : undefined,
          }}
        >
          <strong>{hotPart.ref}</strong>
          <dl>
            {(describe?.(hotPart.ref) ?? [
              ['Value', hotPart.value],
              ['Package', hotPart.pkg],
              ['Side', hotPart.side],
            ]).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd data-testid={`pnp-hover-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

export default BoardView;
