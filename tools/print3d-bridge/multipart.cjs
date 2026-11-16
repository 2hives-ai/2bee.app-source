// VENDORED from pnp's 2bee.3d: /home/gbacs/build/web-slicer/multipart.js.js at commit 65227d3 (unchanged vs HEAD on 2026-10-15).
// Source sha256: 1fddd5f78e895232fc1d419f5fc28a7649f3fa9d91ff4e929f0ba39c9fae896b
// Only edits: this 3-line header and require('./x') -> require('./x.cjs'). Re-vendor rather than edit; see README.md.
'use strict';
// multipart.js - build ONE Orca/Bambu 3MF object from several STLs (a "group": e.g. an inlay base + its modules).
// The STLs keep their ORIGINAL coordinates relative to each other; the group's union-bbox XY centre is what gets
// placed (placement.x/y, rotation about that centre), and the lowest point of the union sits on the bed.
// Each part is one volume with its own `extruder` (1-based filament index), exactly like Orca's own multi-part export:
//   3D/3dmodel.model            <object> = <components>, one <component> per part (offset = part centre - group origin)
//   3D/Objects/<part>_N.model   one mesh per part, vertices centred on the part's bbox centre
//   Metadata/model_settings.config  <object extruder><part extruder name matrix source_offset_*>  + <plate><model_instance>
// (This Orca 2.5 writes model_settings.config, not the legacy Metadata/Slic3r_PE_model.config; it reads both.)
const fs = require('fs'), path = require('path'), zlib = require('zlib');

// ---------- STL ----------
function parseStl(buf) {
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (n > 0 && buf.length === 84 + 50 * n) {
      const out = new Float64Array(n * 9);
      for (let i = 0; i < n; i++) { const o = 84 + 50 * i + 12; for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(o + 4 * k); }
      return out;
    }
  }
  const txt = buf.toString('latin1');
  if (!/^\s*solid/.test(txt)) throw new Error('not an STL');
  const v = []; const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
  while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
  if (!v.length || v.length % 9) throw new Error('bad ASCII STL');
  return Float64Array.from(v);
}
function loadTris(p) {
  if (p.tris) return p.tris;
  const buf = p.buffer || fs.readFileSync(p.stlPath);
  return parseStl(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}
function bboxOf(t) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const v = t[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  return { min: mn, max: mx };
}
const mid = (b, k) => (b.min[k] + b.max[k]) / 2;

// describeGroup(parts[, rot]) -> union bbox / footprint and per-part offsets from the group centre (XY: bbox centre; Z: from group floor).
// With rot (deg, about the group centre) footprint/bbox are those of the rotated group; offsets are rotated too.
function describeGroup(parts, rot) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('group needs at least one part');
  const loaded = parts.map((p, i) => { const tris = loadTris(p); return { p, i, tris, bb: bboxOf(tris) }; });
  const ub = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const l of loaded) for (let k = 0; k < 3; k++) { ub.min[k] = Math.min(ub.min[k], l.bb.min[k]); ub.max[k] = Math.max(ub.max[k], l.bb.max[k]); }
  const centre = [mid(ub, 0), mid(ub, 1)], th = (rot || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  const rotXY = (dx, dy) => [dx * c - dy * s, dx * s + dy * c];
  let rb = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  for (const l of loaded) for (let i = 0; i < l.tris.length; i += 3) {
    const [rx, ry] = rotXY(l.tris[i] - centre[0], l.tris[i + 1] - centre[1]);
    rb.min[0] = Math.min(rb.min[0], rx); rb.max[0] = Math.max(rb.max[0], rx); rb.min[1] = Math.min(rb.min[1], ry); rb.max[1] = Math.max(rb.max[1], ry);
  }
  const out = {
    bbox: { min: ub.min.slice(), max: ub.max.slice() }, centre,
    footprint: { w: rb.max[0] - rb.min[0], d: rb.max[1] - rb.min[1], h: ub.max[2] - ub.min[2] },
    // bbox of the rotated group relative to its centre (what the arranger needs to clear the bed edges)
    rotatedExtent: { min: rb.min.slice(), max: rb.max.slice() },
    parts: loaded.map((l) => {
      const pc = [mid(l.bb, 0), mid(l.bb, 1)], [ox, oy] = rotXY(pc[0] - centre[0], pc[1] - centre[1]);
      return { name: l.p.name || `part${l.i + 1}`, extruder: l.p.extruder || 1, bbox: l.bb,
        offset: { x: ox, y: oy, z: l.bb.min[2] - ub.min[2] }, size: { w: l.bb.max[0] - l.bb.min[0], d: l.bb.max[1] - l.bb.min[1], h: l.bb.max[2] - l.bb.min[2] } };
    }),
  };
  return out;
}

// ---------- zip (store/deflate, no deps) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(entries) { // [{name, data:Buffer}]
  const locals = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'), def = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, def);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(def.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name); off += 30 + name.length + def.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- 3MF ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const num = (v) => { const r = Math.round(v * 1e6) / 1e6; return String(Object.is(r, -0) ? 0 : r); };
const safe = (s) => String(s).replace(/[^\w.\-]/g, '_').slice(0, 60) || 'part';
const uuid = (a, b) => `${String(a).padStart(8, '0')}-${String(b).padStart(4, '0')}-4c03-9d28-80fed5dfa1dc`;

function meshXml(id, tris, c, ux) {
  const idx = new Map(), vs = [], ts = [];
  const key = (x, y, z) => Math.fround(x) + ',' + Math.fround(y) + ',' + Math.fround(z);
  const ix = [];
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i] - c[0], y = tris[i + 1] - c[1], z = tris[i + 2] - c[2], k = key(x, y, z);
    let n = idx.get(k); if (n === undefined) { n = vs.length; idx.set(k, n); vs.push(`     <vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`); }
    ix.push(n);
  }
  for (let i = 0; i < ix.length; i += 3) if (ix[i] !== ix[i + 1] && ix[i + 1] !== ix[i + 2] && ix[i] !== ix[i + 2]) ts.push(`     <triangle v1="${ix[i]}" v2="${ix[i + 1]}" v3="${ix[i + 2]}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="${id}" p:UUID="${uuid(ux, 1)}" type="model">
   <mesh>
    <vertices>
${vs.join('\n')}
    </vertices>
    <triangles>
${ts.join('\n')}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build/>
</model>
`;
}

// buildPlate3mf({objects:[{parts:[{stlPath|buffer|tris, name, extruder}], placement:{x,y,rot}, name?}], plateSize:{w,d}|[w,d], outPath})
//   -> {outPath, bytes, objects:[{index, objectId, bbox:{min:[x,y,z],max}, group}], warnings[]}
// One 3MF = the whole plate: every object has its fixed placement (build item transform) and per-volume extruders.
// A single-part object is just one volume. bbox = placed world bbox (rotation applied, floor z=0).
function buildPlate3mf(opts) {
  const objs = (opts && opts.objects) || [];
  if (!objs.length) throw new Error('plate needs at least one object');
  if (!opts.outPath) throw new Error('outPath required');
  const ps = Array.isArray(opts.plateSize) ? { w: opts.plateSize[0], d: opts.plateSize[1] } : opts.plateSize;
  const warnings = [], entries = [], resources = [], items = [], cfgObjs = [], insts = [], outObjs = [], relFiles = [];
  let nextId = 1;
  objs.forEach((o, oi) => {
    const parts = o.parts || [];
    const pl = Object.assign({ x: null, y: null, rot: 0 }, o.placement || {});
    const loaded = parts.map((p, i) => {
      const ext = p.extruder === undefined ? 1 : Number(p.extruder);
      if (!Number.isInteger(ext) || ext < 1 || ext > 64) throw new Error(`object ${oi + 1} part ${i + 1}: extruder must be a 1-based integer`);
      const tris = loadTris(p); if (!tris.length) throw new Error(`object ${oi + 1} part ${i + 1}: empty mesh`);
      return { name: p.name || (p.stlPath ? path.basename(p.stlPath) : `part${i + 1}`), ext, tris, bb: bboxOf(tris) };
    });
    const g = describeGroup(loaded.map((l) => ({ tris: l.tris, name: l.name, extruder: l.ext })), pl.rot);
    const gx = g.centre[0], gy = g.centre[1], gz = g.bbox.min[2];
    const px = pl.x === null || pl.x === undefined ? (ps ? ps.w / 2 : 0) : Number(pl.x), py = pl.y === null || pl.y === undefined ? (ps ? ps.d / 2 : 0) : Number(pl.y);
    const e = g.rotatedExtent;
    if (ps && (px + e.min[0] < -1e-6 || px + e.max[0] > ps.w + 1e-6 || py + e.min[1] < -1e-6 || py + e.max[1] > ps.d + 1e-6)) warnings.push(`object ${oi + 1} extends beyond the plate at this placement`);
    const th = (pl.rot || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const comps = [], partsXml = [];
    loaded.forEach((l, i) => {
      const meshId = nextId++, centre = [mid(l.bb, 0), mid(l.bb, 1), mid(l.bb, 2)];
      const off = [centre[0] - gx, centre[1] - gy, centre[2] - gz]; // volume offset inside the object (origin = group XY centre, floor z)
      const fname = `3D/Objects/o${oi + 1}_${safe(l.name)}_${i + 1}.model`;
      entries.push({ name: fname, data: meshXml(meshId, l.tris, centre, meshId) });
      relFiles.push(fname);
      comps.push(`    <component p:path="/${fname}" objectid="${meshId}" p:UUID="${uuid(meshId, 2)}" transform="1 0 0 0 1 0 0 0 1 ${num(off[0])} ${num(off[1])} ${num(off[2])}"/>`);
      partsXml.push(`    <part id="${meshId}" subtype="normal_part">
      <metadata key="name" value="${esc(l.name)}"/>
      <metadata key="matrix" value="1 0 0 ${num(off[0])} 0 1 0 ${num(off[1])} 0 0 1 ${num(off[2])} 0 0 0 1"/>
      <metadata key="source_file" value="${esc(l.name)}"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="${i}"/>
      <metadata key="source_offset_x" value="${num(off[0])}"/>
      <metadata key="source_offset_y" value="${num(off[1])}"/>
      <metadata key="source_offset_z" value="${num(off[2])}"/>
      <metadata key="extruder" value="${l.ext}"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`);
    });
    const OBJ = nextId++;
    resources.push(`  <object id="${OBJ}" p:UUID="${uuid(OBJ, 3)}" type="model">
   <components>
${comps.join('\n')}
   </components>
  </object>`);
    items.push(`  <item objectid="${OBJ}" p:UUID="${uuid(OBJ, 4)}" transform="${num(c)} ${num(s)} 0 ${num(-s)} ${num(c)} 0 0 0 1 ${num(px)} ${num(py)} 0" printable="1"/>`);
    cfgObjs.push(`  <object id="${OBJ}">
    <metadata key="name" value="${esc(o.name || loaded.map((l) => l.name.replace(/\.stl$/i, '')).join('+'))}"/>
    <metadata key="extruder" value="${loaded[0].ext}"/>
${partsXml.join('\n')}
  </object>`);
    insts.push(`    <model_instance>
      <metadata key="object_id" value="${OBJ}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="${OBJ * 11}"/>
    </model_instance>`);
    // placed world bbox (rotation about the group centre, floor at z=0)
    const wb = { min: [px + e.min[0], py + e.min[1], 0], max: [px + e.max[0], py + e.max[1], g.footprint.h] };
    outObjs.push({ index: oi, objectId: OBJ, bbox: wb, group: g });
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">web-slicer multipart</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${resources.join('\n')}
 </resources>
 <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">
${items.join('\n')}
 </build>
</model>
`;
  const cfg = `<?xml version="1.0" encoding="UTF-8"?>
<config>
${cfgObjs.join('\n')}
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
${insts.join('\n')}
  </plate>
  <assemble>
  </assemble>
</config>
`;
  const all = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>` },
    { name: '3D/3dmodel.model', data: model },
    { name: '3D/_rels/3dmodel.model.rels', data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relFiles.map((f, i) => ` <Relationship Target="/${f}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('\n')}
</Relationships>` },
    ...entries,
    { name: 'Metadata/model_settings.config', data: cfg },
  ];
  const buf = zip(all);
  fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true });
  fs.writeFileSync(opts.outPath, buf);
  return { outPath: opts.outPath, bytes: buf.length, objects: outObjs, warnings };
}

// buildMultipart3mf({parts, placement:{x,y,rot}, plateSize, outPath, name?}) = a plate with ONE grouped object.
// -> {outPath, bytes, objectId, group, placement, warnings}
function buildMultipart3mf(opts) {
  const r = buildPlate3mf({ objects: [{ parts: opts.parts, placement: opts.placement, name: opts.name }], plateSize: opts.plateSize, outPath: opts.outPath });
  const pl = Object.assign({ x: null, y: null, rot: 0 }, opts.placement || {}), ps = Array.isArray(opts.plateSize) ? { w: opts.plateSize[0], d: opts.plateSize[1] } : opts.plateSize;
  return { outPath: r.outPath, bytes: r.bytes, objectId: r.objects[0].objectId, group: r.objects[0].group, placement: { x: pl.x == null ? (ps ? ps.w / 2 : 0) : pl.x, y: pl.y == null ? (ps ? ps.d / 2 : 0) : pl.y, rot: pl.rot || 0 }, warnings: r.warnings };
}

module.exports = { buildPlate3mf, buildMultipart3mf, describeGroup, parseStl };
