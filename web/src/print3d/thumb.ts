// A small picture of a part for the object list, drawn with Canvas 2D.
//
// pnp's page rendered thumbnails through one shared WebGL renderer. This tab
// already holds a WebGL context for the plate view, and a browser allows only a
// handful per page, so the list uses no WebGL at all: triangles are projected
// to a fixed three-quarter view, sorted back to front and filled with a flat
// shade. It is a recognisable silhouette, not a render — nothing is measured
// from it.

const MAX_TRIS = 40000;

export function thumbDataUrl(tri: Float32Array, color: string, size = 96): string {
  if (typeof document === 'undefined' || !tri.length) return '';
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  if (!g) return '';
  const n = Math.floor(tri.length / 9);
  const step = Math.max(1, Math.ceil(n / MAX_TRIS));
  // view: turned 35° about Z, camera in front and 35° above. [screen x, screen up, depth toward the camera]
  const cz = Math.cos(-0.61), sz = Math.sin(-0.61), ce = Math.cos(0.61), se = Math.sin(0.61);
  const proj = (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cz - y * sz, y1 = x * sz + y * cz;
    return [x1, y1 * se + z * ce, -y1 * ce + z * se];
  };
  const faces: { p: [number, number, number][]; depth: number; shade: number }[] = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let t = 0; t < n; t += step) {
    const o = 9 * t;
    const p = [proj(tri[o], tri[o + 1], tri[o + 2]), proj(tri[o + 3], tri[o + 4], tri[o + 5]), proj(tri[o + 6], tri[o + 7], tri[o + 8])];
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const shade = 0.35 + 0.65 * Math.abs((nx * 0.3 + ny * 0.5 + nz * 0.8) / len);
    for (const q of p) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    faces.push({ p, depth: (p[0][2] + p[1][2] + p[2][2]) / 3, shade });
  }
  faces.sort((a, b) => a.depth - b.depth);
  const s = (size * 0.84) / Math.max(x1 - x0, y1 - y0, 1e-6);
  const ox = (size - (x1 - x0) * s) / 2, oy = (size - (y1 - y0) * s) / 2;
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [76, 175, 136];
  for (const f of faces) {
    g.fillStyle = `rgb(${rgb.map((c) => Math.round(c * f.shade)).join(',')})`;
    g.beginPath();
    f.p.forEach((q, i) => {
      const X = ox + (q[0] - x0) * s, Y = size - (oy + (q[1] - y0) * s);
      if (i) g.lineTo(X, Y);
      else g.moveTo(X, Y);
    });
    g.closePath();
    g.fill();
  }
  return cv.toDataURL('image/png');
}
