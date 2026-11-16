// One small 3D view: a 2D <canvas> that a SINGLE shared WebGLRenderer draws
// into. A picker can show many previews over a session, and browsers cap live
// WebGL contexts at ~16 (the app already holds several), so each view does NOT
// get its own context: the shared renderer renders the view, then the pixels
// are copied into the view's own 2D canvas.
//
// Only views on screen are rendered (IntersectionObserver), the loop stops when
// none are, and the shared renderer is disposed a few seconds after the last
// view unmounts. Colours are read from the brand CSS custom properties and
// re-read when the theme changes.

import * as THREE from 'three';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { disposeTree, type Role } from './geometry';
import { markWebglLost, onWebglLost, webglAvailable } from './webgl';
import './tool3d.css';

interface View {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  dist: number;
  theta: number;
  phi: number;
  visible: boolean;
  lastInteract: number;
  dirty: boolean;
}

const TOKENS = ['--accent', '--muted', '--ink', '--line', '--warn'] as const;
type Token = (typeof TOKENS)[number];

/** Resolve a CSS colour token to sRGB by painting it — works for any CSS colour syntax. */
function readColours(): Record<Token, THREE.Color> {
  const out = {} as Record<Token, THREE.Color>;
  const cs = getComputedStyle(document.documentElement);
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const t of TOKENS) {
    const raw = cs.getPropertyValue(t).trim();
    const col = new THREE.Color(0.5, 0.5, 0.5);
    if (ctx && raw) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#808080';
      ctx.fillStyle = raw;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      col.setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace);
    }
    out[t] = col;
  }
  return out;
}

const ROLE_TOKEN: Record<Role, Token> = {
  cut: '--accent',
  'cut-assumed': '--accent',
  shank: '--muted',
  'shank-assumed': '--muted',
  refuse: '--muted',
  body: '--ink',
  assumed: '--warn',
  stock: '--muted',
  spoilboard: '--line',
  steel: '--warn',
  cuttable: '--accent',
  hidden: '--ink',
  keepout: '--warn',
  eaten: '--warn',
  edge: '--ink',
};

/** Mesh look per role: opacity, metalness. */
const MESH_LOOK: Partial<Record<Role, { opacity?: number; metal?: number; rough?: number; wire?: boolean }>> = {
  cut: { metal: 0.45, rough: 0.32 },
  'cut-assumed': { opacity: 0.35, metal: 0.3, rough: 0.4 },
  shank: { metal: 0.55, rough: 0.3 },
  'shank-assumed': { opacity: 0.3, metal: 0.4, rough: 0.4 },
  body: { metal: 0.15, rough: 0.6, opacity: 0.92 },
  assumed: { opacity: 0.16 },
  stock: { opacity: 0.32, rough: 0.9 },
  spoilboard: { opacity: 0.45, rough: 0.9 },
  steel: { metal: 0.6, rough: 0.3 },
  cuttable: { metal: 0.3, rough: 0.4 },
  hidden: { opacity: 0.45, rough: 0.7 },
  keepout: { opacity: 0.05 },
  eaten: { opacity: 0.5 },
};

const DASHED: ReadonlySet<Role> = new Set(['refuse', 'assumed', 'keepout']);

class Shared {
  renderer: THREE.WebGLRenderer | null = null;
  views = new Set<View>();
  raf = 0;
  last = 0;
  colours: Record<Token, THREE.Color> | null = null;
  materials = new Map<string, THREE.Material>();
  disposeTimer: ReturnType<typeof setTimeout> | null = null;
  themeObs: MutationObserver | null = null;
  mql: MediaQueryList | null = null;
  reduced = false;

  ensure(): boolean {
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    if (this.renderer) return true;
    try {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
      r.setClearColor(0x000000, 0);
      r.setPixelRatio(1); // sizes below are already in device pixels
      r.domElement.addEventListener('webglcontextlost', () => {
        this.teardown();
        markWebglLost();
      });
      this.renderer = r;
    } catch {
      markWebglLost();
      return false;
    }
    this.colours = readColours();
    const refresh = () => {
      this.colours = readColours();
      this.applyColours();
      for (const v of this.views) v.dirty = true;
      this.kick();
    };
    this.themeObs = new MutationObserver(refresh);
    this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (document.body) this.themeObs.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    this.mql = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this.mql?.addEventListener?.('change', refresh);
    this.reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return true;
  }

  material(role: Role, line: boolean): THREE.Material {
    const key = `${role}:${line ? 'l' : 'm'}`;
    let m = this.materials.get(key);
    if (m) return m;
    if (line) {
      const opacity = role === 'edge' ? 0.55 : 0.95;
      m = DASHED.has(role)
        ? new THREE.LineDashedMaterial({ dashSize: 2, gapSize: 1.5, transparent: true, opacity })
        : new THREE.LineBasicMaterial({ transparent: true, opacity });
    } else {
      const look = MESH_LOOK[role] ?? {};
      const transparent = look.opacity !== undefined && look.opacity < 1;
      m = new THREE.MeshStandardMaterial({
        metalness: look.metal ?? 0.1,
        roughness: look.rough ?? 0.6,
        transparent,
        opacity: look.opacity ?? 1,
        depthWrite: !transparent,
        side: transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
    }
    this.materials.set(key, m);
    this.applyColour(key, m);
    return m;
  }

  applyColour(key: string, m: THREE.Material): void {
    if (!this.colours) return;
    const role = key.split(':')[0] as Role;
    const c = this.colours[ROLE_TOKEN[role]];
    (m as THREE.MeshStandardMaterial | THREE.LineBasicMaterial).color.copy(c);
  }

  applyColours(): void {
    for (const [k, m] of this.materials) this.applyColour(k, m);
  }

  dress(root: THREE.Object3D): void {
    root.traverse((o) => {
      const role = o.userData.role as Role | undefined;
      if (!role) return;
      if ((o as THREE.Line).isLine) (o as THREE.Line).material = this.material(role, true);
      else if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = this.material(role, false);
    });
  }

  add(v: View): void {
    this.views.add(v);
    this.kick();
  }

  remove(v: View): void {
    this.views.delete(v);
    if (this.views.size === 0 && !this.disposeTimer) {
      this.disposeTimer = setTimeout(() => this.teardown(), 5000);
    }
  }

  kick(): void {
    if (!this.raf && this.renderer) this.raf = requestAnimationFrame(this.tick);
  }

  tick = (t: number): void => {
    this.raf = 0;
    const dt = this.last ? Math.min((t - this.last) / 1000, 0.1) : 0;
    this.last = t;
    let any = false;
    for (const v of this.views) {
      if (!v.visible) continue;
      any = true;
      const idle = performance.now() - v.lastInteract > 2500;
      if (!this.reduced && idle) {
        v.theta += dt * 0.35;
        v.dirty = true;
      }
      if (v.dirty) this.draw(v);
    }
    if (any) this.raf = requestAnimationFrame(this.tick);
    else this.last = 0;
  };

  draw(v: View): void {
    const r = this.renderer;
    if (!r) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(v.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(v.canvas.clientHeight * dpr));
    if (v.canvas.width !== w || v.canvas.height !== h) {
      v.canvas.width = w;
      v.canvas.height = h;
    }
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) r.setSize(w, h, false);
    v.camera.aspect = w / h;
    const cp = Math.cos(v.phi);
    v.camera.position.set(
      v.target.x + v.dist * cp * Math.sin(v.theta),
      v.target.y + v.dist * Math.sin(v.phi),
      v.target.z + v.dist * cp * Math.cos(v.theta)
    );
    v.camera.lookAt(v.target);
    v.camera.updateProjectionMatrix();
    r.render(v.scene, v.camera);
    v.ctx.clearRect(0, 0, w, h);
    v.ctx.drawImage(r.domElement, 0, 0, w, h, 0, 0, w, h);
    v.dirty = false;
  }

  teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.disposeTimer = null;
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.themeObs?.disconnect();
    this.themeObs = null;
  }
}

const shared = new Shared();

export interface Scene3DProps {
  /** Build the object. Called when `buildKey` changes. `null` = nothing to build. */
  build: () => THREE.Object3D | null;
  /** Rebuild when this string changes (the numbers the object is built from). */
  buildKey: string;
  /** Accessible name — the same sentence the drawing carried. */
  label: string;
  /** Shown instead while WebGL is unavailable, lost, or nothing could be built. */
  fallback: ReactNode;
  /** Starting elevation of the camera, radians. */
  elevation?: number;
  className?: string;
  testid?: string;
  /** Extra `data-*` attributes on the wrapper — what the scene is OF, for a reader that cannot read a canvas. */
  data?: Record<`data-${string}`, string>;
  children?: ReactNode;
}

export function Scene3D({ build, buildKey, label, fallback, elevation = 0.35, className, testid, data, children }: Scene3DProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [lost, setLost] = useState(() => !webglAvailable());
  const [empty, setEmpty] = useState(false);
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => onWebglLost(() => setLost(true)), []);

  useEffect(() => {
    const canvas = ref.current;
    if (lost || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || !shared.ensure()) {
      setLost(true);
      return;
    }
    const obj = buildRef.current();
    if (!obj) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    shared.dress(obj);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(-1.5, 0.5, -1);
    scene.add(rim);
    scene.add(obj);

    const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
    const fov = 30;
    const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 10_000);
    const dist = (Math.max(sphere.radius, 1) / Math.sin(((fov / 2) * Math.PI) / 180)) * 1.02;
    camera.near = Math.max(dist / 100, 0.05);
    camera.far = dist * 10;

    const v: View = {
      canvas,
      ctx,
      scene,
      camera,
      target: sphere.center.clone(),
      dist,
      theta: 0.7,
      phi: elevation,
      visible: false,
      lastInteract: 0,
      dirty: true,
    };

    const io = new IntersectionObserver((es) => {
      for (const e of es) v.visible = e.isIntersecting;
      v.dirty = true;
      shared.kick();
    });
    io.observe(canvas);

    let drag: { x: number; y: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      v.lastInteract = performance.now();
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      v.theta -= (e.clientX - drag.x) * 0.012;
      v.phi = Math.max(-1.3, Math.min(1.45, v.phi + (e.clientY - drag.y) * 0.01));
      drag.x = e.clientX;
      drag.y = e.clientY;
      v.lastInteract = performance.now();
      v.dirty = true;
      shared.kick();
    };
    const up = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) drag = null;
      v.lastInteract = performance.now();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    const ro = new ResizeObserver(() => {
      v.dirty = true;
      shared.kick();
    });
    ro.observe(canvas);

    shared.add(v);
    return () => {
      io.disconnect();
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      shared.remove(v);
      disposeTree(obj);
    };
  }, [buildKey, lost, elevation]);

  if (lost || empty) return <>{fallback}</>;
  return (
    <div className={className ? `t3d ${className}` : 't3d'} data-testid={testid} data-t3d="3d" {...data}>
      <canvas ref={ref} className="t3d-canvas" role="img" aria-label={label} title={label} />
      {children}
    </div>
  );
}
