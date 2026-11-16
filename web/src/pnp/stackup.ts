// Reading the gerber render `scripts/build-pnp-stackup.ts` writes into
// `public/pnp-stackup/` (generated, not committed). Absent — a dev tree where
// `npm run pnp:stackup` has not run — is a SAID state ("no gerber render"),
// never an error that hides the board: the 3D falls back to the part-extent plate.

export interface StackupEntry {
  id: string;
  source: string;
  /** Gerber coordinates (mm) — the same frame as pcb's CPL. */
  box?: { minX: number; minY: number; w: number; h: number };
  layers: string[];
  missing: string[];
  error?: string;
  parts?: { glb: boolean; kicadPcb: string; footprints: number; withModel: number; placeholder: number; error?: string };
}

export interface StackupSides {
  entry: StackupEntry;
  top: HTMLCanvasElement;
  bottom: HTMLCanvasElement;
}

const base = () => `${import.meta.env.BASE_URL ?? '/'}pnp-stackup/`;

let index: Promise<Map<string, StackupEntry> | null> | null = null;

/** The index, or null when nothing has been generated. */
export function stackupIndex(): Promise<Map<string, StackupEntry> | null> {
  index ??= fetch(`${base()}index.json`)
    .then(async (r) => {
      if (!r.ok) return null;
      const j = (await r.json()) as { boards?: StackupEntry[] };
      return Array.isArray(j.boards) ? new Map(j.boards.map((b) => [b.id, b])) : null;
    })
    .catch(() => null);
  return index;
}

/** Rasterise one side's SVG to a canvas, longest side `px` pixels. */
async function side(id: string, which: 'top' | 'bottom', px: number): Promise<HTMLCanvasElement> {
  const r = await fetch(`${base()}${id}-${which}.svg`);
  if (!r.ok) throw new Error(`${id}-${which}.svg: HTTP ${r.status}`);
  let svg = await r.text();
  // The SVG says its size in mm; an <img> would rasterise it at ~4 px/mm. Give it
  // pixels so the texture is sharp enough to read the silkscreen.
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  const w = vb ? Number(vb[3]) : 1;
  const h = vb ? Number(vb[4]) : 1;
  const k = px / Math.max(w, h);
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  svg = svg.replace(/width="[^"]*mm" height="[^"]*mm"/, `width="${W}" height="${H}"`);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d')!.drawImage(img, 0, 0, W, H);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadStackup(id: string, px = 2048): Promise<StackupSides | null> {
  const idx = await stackupIndex();
  const entry = idx?.get(id);
  if (!entry || !entry.box || entry.error) return null;
  const [top, bottom] = await Promise.all([side(id, 'top', px), side(id, 'bottom', px)]);
  return { entry, top, bottom };
}

/** The board's component models (kicad-cli GLB), as the object whose children
 *  are the parts, named by reference; null when not generated for this board. */
export async function loadPartsGlb(id: string): Promise<import('three').Object3D | null> {
  const idx = await stackupIndex();
  if (!idx?.get(id)?.parts?.glb) return null;
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(`${base()}${id}-parts.glb`);
  const sc = gltf.scene;
  return sc.children.length === 1 && !sc.children[0].name ? sc.children[0] : sc;
}
