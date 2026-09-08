// Sample drawings.
//
// 🔴 THESE ARE REAL DXF FILES AND THEY GO THROUGH THE REAL IMPORTER. They are
// NOT the built-in fixture jobs, which construct geometry in Rust and never
// touch DXF parsing. A demo that takes a different route through the code than
// a user's own file is a demo that can be green while import is broken — which
// is exactly what the `Job` dropdown they replace was doing.
//
// PROVENANCE. Every one of these is a COPY of a file owned by the `cad` lane,
// taken 2026-08-08. They do NOT follow cad's changes: if a panel is revised
// upstream, this copy silently becomes an old revision of a real part, which is
// worse than an obviously synthetic sample. Re-copy deliberately, or replace
// them with a build step that pulls from `hardware/cad/` at package time.
//
//   hive-super-end.dxf     <- hardware/cad/2bee_hive/cnc_nest/super_end.dxf
//   hive-box-prototype.dxf <- hardware/cad/export/hive_box_prototype.dxf
//   metal-nest-a1.dxf      <- hardware/cad/metal_nest/out/A1.dxf
//
// `?raw` keeps them as text: the importer takes the file's own bytes, and a
// bundler transform would be a second thing between the drawing and the parse.
import hiveSuperEnd from './hive-super-end.dxf?raw';
import hiveBoxPrototype from './hive-box-prototype.dxf?raw';
import metalNestA1 from './metal-nest-a1.dxf?raw';

export interface Sample {
  name: string;
  format: 'dxf' | 'svg';
  text: string;
  /** What this one is for. Shown next to it, because two of the three are here
   *  to demonstrate a REFUSAL, and a sample that refuses looks broken unless it
   *  says up front that refusing is the point. */
  detail: string;
}

export const SAMPLES: Sample[] = [
  {
    name: 'Hive super end',
    format: 'dxf',
    text: hiveSuperEnd,
    // Measured through the CLI importer 2026-08-08: 1 part, 21 interior
    // features, 85 tabs, 22.4m of cutting.
    detail:
      'A real 2bee hive panel: 21 interior features. Its geometry starts at ' +
      'x=-3, y=-3.5, so it lands outside the travel until the datum is moved — ' +
      'which is what a drawing straight from CAD normally does.',
  },
  {
    name: 'Hive box prototype',
    format: 'dxf',
    text: hiveBoxPrototype,
    detail:
      'Carries DIMENSION and TEXT entities the importer cannot cut. Each one is ' +
      'named in the notes rather than skipped: a dropped entity is a part cut ' +
      'without a feature, and it looks perfect on screen.',
  },
  {
    name: 'Metal nest A1',
    format: 'dxf',
    text: metalNestA1,
    detail:
      'Holes narrower than a 6mm cutter. The planner refuses them by name and ' +
      'says they must be drilled or interpolated, rather than quietly emitting ' +
      'a path that removes the feature.',
  },
];

// ───────────────────────────── sample MESHES ─────────────────────────────────
//
// 🔴 AN STL IS A 3D TRIANGLE MESH AND THIS IS 2.5D CAM. What the machine cuts
// is ONE FLAT OUTLINE, the section of that mesh at a single Z. The solid a user
// sees on screen after picking one of these is the model, NOT the shape the
// spindle makes — and a user who conflates the two has been misled by the demo,
// which is worse than not shipping the demo. Every `detail` below says this in
// its own words for its own part, because a caveat carried only by this comment
// reaches nobody, and a caveat carried only once at the top is the one people
// scroll past.
//
// PROVENANCE. Copies of files owned by the `cad` lane, taken 2026-08-08, byte
// compared against their sources. Same standing hazard as the DXFs above: they
// do NOT follow cad's changes, so a revised part silently leaves an old
// revision here.
//
//   schools-kit-solar.stl     <- hardware/cad/stl/fleet/schools_kit_solar.stl
//   marker-triangle.stl       <- hardware/cad/stl/fleet/marker_triangle.stl
//   entrance-tray-plate.stl   <- hardware/cad/stl/fleet/entrance_tray_plate.stl
//   hive-super-end.stl        <- GENERATED, not copied. OpenSCAD render of
//                                hardware/cad/2bee_hive/2bee_hive_super_panel_wcnc.scad,
//                                entry `super_panel("front")`, with
//                                `rotate([0, 90, 0])` to lay the panel flat for
//                                CAM. 4786 facets, genus 31, NoError.
//                                (2026-08-09, founder: the STL should be the
//                                super end, not the box.)
//
// ⚠ `hive-super-end.stl` is the one entry here that is a RENDER rather than a
// copy, so it drifts from cad's model differently: a copy goes stale when the
// STL is regenerated, this goes stale when the SCAD changes. Nothing detects
// either — the same gap `BRND` closes for the brand marks, and the same fix
// would work (record the source sha256 and re-compare in a gate). Not built.
//
// 🔴 `hive-box-schools-kit.stl` was REMOVED 2026-08-09 on founder instruction
// ("stls should be hive super end, not the box"). Its catalogue entry described
// a real measured mesh and is gone with it; nothing else referenced the file.
//
// ⚠ `hardware/cad/export/box_body.stl` — the full-size hive box body — was the
// obvious first choice for a hive mesh and is NOT usable here: it is an ASCII
// STL (its bytes 80..84 read as a triangle count of 824,211,557, which would
// need 41GB), and `loadStl` below parses binary only. Recorded so the next
// person does not repeat the attempt and conclude the loader is broken.
//
// 🔴 MECHANISM — `?url`, NOT `?raw`, and the reason is correctness before size.
// These are BINARY STLs. `?raw` is a TEXT import: the bytes are decoded as
// UTF-8, every invalid sequence is replaced with U+FFFD, and what comes out is
// a plausible-looking string that is no longer the file. A mesh corrupted that
// way does not fail loudly — it sections into an outline with a side missing,
// which still looks like a part. So the binary path never touches a string:
// `?url` hands us a URL, `fetch` gives back the file's own bytes, and the
// importer parses exactly what `cad` exported.
//
// What `?url` costs, stated rather than glossed: the file is emitted as a
// separate asset and arrives over the network, so loading a mesh sample is
// ASYNCHRONOUS where loading a DXF sample is not. What it buys: the JS bundle
// carries three short URL strings instead of ~90kB of mesh, and base64 — the
// obvious alternative — would have put 4 bytes in the bundle for every 3 in the
// file, permanently, for every user, whether or not they ever pick a mesh.
//
// ⚠ Vite inlines assets under 4096 bytes as a `data:` URI, so
// `entrance-tray-plate.stl` (684 B) becomes a data URL and the other two become
// real files. `fetch` reads both forms identically, which is the only reason
// that split is allowed to be invisible here.
import schoolsKitSolarUrl from './schools-kit-solar.stl?url';
import markerTriangleUrl from './marker-triangle.stl?url';
import entranceTrayPlateUrl from './entrance-tray-plate.stl?url';
import hiveSuperEndStlUrl from './hive-super-end.stl?url';

/**
 * A sample that is a 3D mesh rather than a drawing.
 *
 * Deliberately a SEPARATE type and a separate array from {@link Sample}: a
 * drawing sample is text that is already in memory, a mesh sample is bytes that
 * have to be fetched, and collapsing the two behind one optional `text` field
 * would make "the file has not loaded yet" and "the file is empty" the same
 * value.
 */
export interface MeshSample {
  name: string;
  format: 'stl';
  /** Bundler-emitted URL. Either a real asset path or a `data:` URI — `bytes()`
   *  does not care which, and neither should any caller. */
  url: string;
  /**
   * The file's own bytes, with the triangle count checked against the source.
   *
   * 🔴 This is a NEGATIVE CONTROL on the byte path, not a formality. The whole
   * failure mode this import mechanism exists to avoid is silent corruption, so
   * the loader re-derives the triangle count from the delivered bytes and
   * REFUSES if it disagrees with the count measured at the source file. A mesh
   * that arrives wrong throws here, where the message names the file, instead
   * of reaching the sectioner and producing a confident outline of the wrong
   * part.
   */
  bytes: () => Promise<Uint8Array>;
  /** Measured at the source file 2026-08-08 — `(bytesOnDisk - 84) / 50`. */
  triangles: number;
  /** Size of the vendored file, in bytes. */
  bytesOnDisk: number;
  /** `[min, max]` in millimetres, from the file's own numbers. An STL declares
   *  no units at all; the core assumes mm and says so on every import. */
  zSpanMm: [number, number];
  /** The Z the core sections at when it is given none — the midpoint of
   *  `zSpanMm`. Precomputed so the picker can name it before anything loads. */
  midHeightZMm: number;
  /** What this one is for, in the same spirit as the drawings above: two of the
   *  three are here to show that the section Z is a REAL DECISION, and one is
   *  here to be refused. */
  detail: string;
}

/** Binary-STL header size: 80-byte header + a `u32` triangle count. */
const STL_HEADER_BYTES = 84;
/** Bytes per triangle in a binary STL: 12 floats + a 2-byte attribute count. */
const STL_TRI_BYTES = 50;

/**
 * Fetch a vendored binary STL and hand back its bytes, or throw.
 *
 * The two checks are different questions and both are asked:
 *  - is this a binary STL at all (does the declared count match the length)?
 *  - is it THE FILE WE VENDORED (does that count match what was measured)?
 * The first catches a mangled transfer; the second catches a file swapped or
 * re-exported upstream without the entry here being updated. A loader that only
 * asked the first would happily load a different part.
 */
async function loadStl(url: string, name: string, expectTriangles: number): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`sample "${name}": ${res.status} fetching its STL — it was NOT loaded`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < STL_HEADER_BYTES) {
    throw new Error(
      `sample "${name}": ${bytes.length} bytes arrived, too short to be a binary STL — NOT loaded`
    );
  }
  // Little-endian, per the format. Read off the buffer rather than assuming the
  // Uint8Array starts at byte 0 of it.
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  const implied = STL_HEADER_BYTES + declared * STL_TRI_BYTES;
  if (implied !== bytes.length) {
    throw new Error(
      `sample "${name}": binary STL declares ${declared} triangles, which needs ${implied} bytes, ` +
        `but ${bytes.length} arrived — the bytes did not survive transfer and it was NOT loaded`
    );
  }
  if (declared !== expectTriangles) {
    throw new Error(
      `sample "${name}": ${declared} triangles arrived but ${expectTriangles} were measured at the ` +
        `source file — this is not the mesh this entry describes and it was NOT loaded`
    );
  }
  return bytes;
}

export const MESH_SAMPLES: MeshSample[] = [
  {
    // 🔴 NOT just "Hive super end" — the DXF sample above already owns that name.
    // Same part, two different things: the DXF is the CUT FILE cad emits, this is
    // the SOLID. In one list they must not read as duplicates, because choosing
    // the wrong one is choosing a section of a solid over a drawn profile, and
    // both produce a program.
    name: 'Hive super end — solid (STL)',
    format: 'stl',
    url: hiveSuperEndStlUrl,
    bytes: () => loadStl(hiveSuperEndStlUrl, 'Hive super end — solid (STL)', 4786),
    triangles: 4786,
    bytesOnDisk: 239384,
    // PROVENANCE, because this file is GENERATED and `cad` owns the model:
    // rendered 2026-08-09 by OpenSCAD from
    // `hardware/cad/2bee_hive/2bee_hive_super_panel_wcnc.scad`, entry point
    // `super_panel("front")` — "front" IS the super end. Genus 31, 4786 facets,
    // NoError.
    //
    // 🔴 ROTATED, AND THE ROTATION IS THE POINT. The model stands UPRIGHT: as
    // modelled it is 19mm thick in X, 407 in Y, 243 in Z, because that is how
    // the panel sits in the assembly. `mesh.rs` sections at a constant Z, so
    // the upright model sliced at its mid-height gives a 19 x 407 STRIP — the
    // panel's EDGE, measured at z=121.5: 1 part, 0 interior features. A router
    // cuts this panel lying flat, so the export applies `rotate([0, 90, 0])`
    // and nothing else. Laid flat the same slice is the panel FACE.
    zSpanMm: [-19.0, 0.0],
    midHeightZMm: -9.5,
    // Measured through the CLI importer 2026-08-09 at the mid-thickness chosen
    // for you (`import hive-super-end.stl --format stl --z -9.5`): 1 part,
    // **31 interior features**, 30,334mm of cutting, 92 tabs, gouge 0.
    // ⚠ It reports ok=false, and for one reason only: the same datum shift
    // every shipped sample hits — `move the datum by X +3.000 Y +3.500`, which
    // is the cutter radius, not a fault in the mesh.
    detail:
      'The part this tool exists for: the super end panel, cut from the same ' +
      'model `hardware/cad` cuts it from. Sectioned at mid-thickness it gives ' +
      'one closed outline and 31 interior features — the finger tails, the ' +
      'frame-rest rabbet, the autoflow bores and the sensor-pod cuts.\n\n' +
      'What the spindle follows is that ONE flat slice, never the solid on ' +
      'screen. This file is exported lying flat BECAUSE of that: the panel is ' +
      'modelled standing upright, and sectioning it as modelled would hand you ' +
      'a 19mm strip of its edge that plans, posts and cuts a plausible wrong ' +
      'part. If you section it somewhere else you get a different part, and ' +
      'nothing downstream will tell you it was the wrong one.',
  },
  {
    name: 'Schools-kit solar plate',
    format: 'stl',
    url: schoolsKitSolarUrl,
    bytes: () => loadStl(schoolsKitSolarUrl, 'Schools-kit solar plate', 1470),
    triangles: 1470,
    bytesOnDisk: 73584,
    zSpanMm: [-6.778, 5.0],
    midHeightZMm: -0.889,
    // Measured through the CLI importer 2026-08-08 (`2bee-slice import … --json`):
    // at the default mid-height z = -0.889 it plans clean — exit 0, 2 parts,
    // 0 interior features, 932mm of cutting. The only STL in the whole repo
    // that does.
    detail:
      'The mesh sample that just works: sectioned at its mid-height it gives two ' +
      'closed outlines that plan and post with no refusal. Remember what you are ' +
      'cutting — the machine follows that ONE flat slice, not the solid on ' +
      'screen. Move the section up to z = 4.5 and the same file gives a single ' +
      'part with 5 interior features instead.',
  },
  {
    name: 'Marker triangle',
    format: 'stl',
    url: markerTriangleUrl,
    bytes: () => loadStl(markerTriangleUrl, 'Marker triangle', 312),
    triangles: 312,
    bytesOnDisk: 15684,
    zSpanMm: [0.0, 12.0],
    midHeightZMm: 6.0,
    // Measured 2026-08-08: at mid-height z = 6.000 → 2 parts, 904mm of cutting
    // (the two Ø4 locating pins). At z = 11.000 → 1 part, 681mm (the triangle
    // head). Both land off the table; at z = 11 the report offers the datum
    // shift X +9.526 Y +10.598.
    detail:
      'Here the section Z decides what the part IS. At the mid-height chosen for ' +
      'you the slice catches two Ø4 pins and you would cut two small discs; at ' +
      'z = 11 the same file is the triangular head it is named after. Neither ' +
      'outline is the 3D shape — an STL only ever enters as one flat slice, and ' +
      '"CHOSEN FOR YOU" is a guess about your intent, not a default that is ' +
      'right. (It also lands outside the travel until the datum is moved.)',
  },
  {
    name: 'Entrance tray plate',
    format: 'stl',
    url: entranceTrayPlateUrl,
    bytes: () => loadStl(entranceTrayPlateUrl, 'Entrance tray plate', 12),
    triangles: 12,
    bytesOnDisk: 684,
    zSpanMm: [0.0, 1.0],
    midHeightZMm: 0.5,
    // Measured 2026-08-08: at mid-height z = 0.500 → 1 part, a 174.4 x 21.6
    // rectangle. At z = 2.000 → "the section at z = 2.000mm crossed no
    // geometry; the mesh spans z = 0.000..1.000mm", and no G-code is emitted.
    detail:
      'A 1mm-thick plate, and the shortest route to the refusal that matters ' +
      'most. Section it at its mid-height and you get the rectangle; ask for ' +
      'z = 2 — an entirely reasonable number on a part 174mm long — and the ' +
      'section misses the solid completely. It says so and names the span it ' +
      'did have, rather than returning an empty job that reads as a part with ' +
      'nothing to cut.',
  },
];
