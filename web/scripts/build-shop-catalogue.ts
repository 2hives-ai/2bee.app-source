// THE SHOP CATALOGUE IS GENERATED, NEVER COMMITTED, AND ADMITS WHAT IT DROPPED.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS A BUILD STEP AND NOT A CHECKED-IN LIST
// ═══════════════════════════════════════════════════════════════════════════
//
// The designs belong to `cad` and live in `hardware/cad/`. A copy of them in
// this lane's `src/` would be a SECOND source of truth for someone else's
// files, and it would drift the instant cad edits a model — silently, in the
// direction that looks fine, because a stale design still opens and still
// draws. There is no checksum a browser could use to notice.
//
// So nothing is copied into git. This script reads cad's tree at BUILD time and
// writes into `public/shop/`, which is `.gitignore`d. The shop is therefore
// exactly as fresh as the build, and a design cad deletes disappears from the
// catalogue on the next one instead of becoming a card that opens nothing.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 A DESIGN IS LISTED ONLY IF *THIS READER* OPENS IT
// ═══════════════════════════════════════════════════════════════════════════
//
// The catalogue is filtered by running each candidate through `parseScad` with
// the SAME host the tab uses (`makeLibraryHost`), and keeping only those that
// draw geometry with ZERO errors and ZERO unsupported constructs. The shop's
// whole promise is "pick this and it opens in 2bee.cad"; a card for a design
// this reader cannot read would break that promise at the only moment the user
// is watching. What is dropped is COUNTED and written into the index as
// `dropped`, so "the catalogue is small" and "the reader got worse" are
// different observable facts and not the same silent number.
//
// ⚠ THE FILTER IS THE READER'S OPINION, NOT A QUALITY JUDGEMENT ON THE DESIGN.
// A dropped model is very often a perfectly good part using an OpenSCAD feature
// this subset has not implemented. The index says so in `droppedReasons` rather
// than implying cad shipped something broken.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE THUMBNAIL IS RENDERED FROM OUR OWN MESH, ON PURPOSE
// ═══════════════════════════════════════════════════════════════════════════
//
// `openscad` is installed on this box and would produce prettier pictures. It
// is NOT used. A thumbnail from OpenSCAD would show what OpenSCAD makes of the
// source, while the tab shows what `mesh.ts` makes of it — and where those two
// disagree the shop would be advertising a part the app will not produce. That
// is the "plausible-looking wrong part" failure this lane exists to refuse, in
// the one place a user makes their choice. So the picture comes from
// `meshScene`, the same mesher the viewport uses, and it is allowed to look
// worse.
//
// The card also carries `meshScene`'s own `trust` verdict, unmodified.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { parseScad, type SceneNode } from '../src/cad/scad.ts';
import { makeLibraryHost, normalisePath, importEdges, type ScadLibrary } from '../src/cad/library.ts';
import { meshScene } from '../src/cad/mesh.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAD_ROOT = join(WEB, '..', '..', '..', 'hardware', 'cad');
const OUT = join(WEB, 'public', 'shop');

/** Families we offer, in the order a catalogue should read. Anything outside
 *  this list is not a product surface (vendored libs, archives, scratch). */
const FAMILIES: { dir: string; label: string; blurb: string }[] = [
  { dir: '2bee_hive', label: 'Hive', blurb: 'Brood and super bodies, floors, rails and inserts.' },
  { dir: '2bee_entrance', label: 'Entrance', blurb: 'Entrance panels, dividers, scrubbers and trays.' },
  { dir: '2bee_feeder', label: 'Feeder', blurb: 'Feeder bodies, panels and moulded halves.' },
  { dir: '2bee_honey_tank', label: 'Honey tank', blurb: 'Tank, strainer, lid and outlet parts.' },
  { dir: '2bee_schools_kit', label: 'Schools kit', blurb: 'The 1:5 snap-together teaching kit.' },
  { dir: '2bee_vent_node', label: 'Vent node', blurb: 'In-wall vent node bodies and flaps.' },
  { dir: '2bee_sensor_pod_v1', label: 'Sensor pod', blurb: 'Sensor pod enclosures.' },
  { dir: '2bee_sensor_pod_v2', label: 'Sensor pod', blurb: 'Sensor pod enclosures.' },
  /* 🔴 ADDED 2026-09-05, and the reason is worth more than the row. `unlistedFamilies`
   * had been reporting `2bee_sensor_pod_v3` with 4 openable designs for days and
   * nobody acted on it — a measurement that is published and unread is not much
   * better than one never taken. Found while reading cad's correction that the v1
   * pod's "superseded" status was inferred rather than sourced.
   * ⚠ The catalogue's pod offering was ANTI-CORRELATED with the registry:
   * fleet_parts.yaml registers v1 (body, lid) and v3 (enclosure, lid) and registers
   * NO v2 part at all — and this page was offering three v2 designs and no v3. It
   * showed the unregistered generation and hid the registered one. The v2 half is
   * cad's status question, not mine to resolve by deleting cards; this row fixes
   * only the half that is unambiguously a gap in MY hand-maintained list. */
  { dir: '2bee_sensor_pod_v3', label: 'Sensor pod', blurb: 'Sensor pod enclosures.' },
  { dir: '2bee_solar_box', label: 'Solar box', blurb: 'Solar enclosure parts.' },
  { dir: '2bee_markers', label: 'Markers', blurb: 'Machine-vision fiducials.' },
  { dir: '2bee_packaging', label: 'Packaging', blurb: 'Fill, weigh and label station parts.' },
  { dir: '2bee_autoframe_automation', label: 'Autoframe', blurb: 'Autoframe automation enclosures.' },
  { dir: '2bee_autoframe_controller', label: 'Autoframe', blurb: 'Autoframe controller parts.' },
  { dir: '2bee_cnc_table', label: 'CNC table', blurb: 'Table, enclosure and cable-management parts.' },
  { dir: '2bee_cnc_machine', label: 'CNC machine', blurb: 'Probe and gantry study models.' },
  { dir: '2bee_qr', label: 'Marking', blurb: 'QR and identification plates.' },
  { dir: 'metal_nest', label: 'Metal nest', blurb: 'Nest layouts for steel stock.' },
];

/**
 * 🔴 A HAND-MAINTAINED FAMILY LIST SILENTLY NARROWS THE CATALOGUE, so the
 * narrowing is MEASURED and published rather than trusted.
 *
 * `FAMILIES` is the offer, and it is written by hand — which means a directory
 * `cad` adds tomorrow is not "excluded", it is INVISIBLE: no card, no dropped
 * reason, no difference on the page. The catalogue would keep looking complete
 * while answering a smaller question than the one it appears to answer, and the
 * only person who could notice is the one who already knows the tree.
 *
 * `metal_nest` is exactly that case, caught 2026-08-31 by comparing this list
 * against a sweep of what the reader can actually open — 101 openable designs
 * across 17 directories, 16 of them listed here.
 *
 * So the generator records every directory that HAS an openable design and is
 * not in `FAMILIES`, and the index carries it. An omission then has to be a
 * decision somebody can see, which is the difference between a scope and a gap.
 */

// ---------------------------------------------------------------------------
// PNG. Written here rather than pulled in, because a thumbnail encoder is 60
// lines and a dependency in an AGPL tree is a licence question (see AGENTS.md).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Isometric render of a triangle soup, z-buffered, flat-shaded.
// ---------------------------------------------------------------------------

const W = 384;
const H = 288;

/** Camera basis for OpenSCAD's default-ish 3/4 view. */
function basis() {
  const az = (25 * Math.PI) / 180;
  const el = (55 * Math.PI) / 180;
  const d: [number, number, number] = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  // right = normalize(world_up x d); up = d x right
  let r: [number, number, number] = [-d[1], d[0], 0];
  const rl = Math.hypot(r[0], r[1], r[2]) || 1;
  r = [r[0] / rl, r[1] / rl, r[2] / rl];
  const u: [number, number, number] = [
    d[1] * r[2] - d[2] * r[1],
    d[2] * r[0] - d[0] * r[2],
    d[0] * r[1] - d[1] * r[0],
  ];
  return { d, r, u };
}

interface Rendered { png: Buffer; triangles: number }

function render(parts: { positions: Float32Array; colour: unknown }[]): Rendered | null {
  const { d, r, u } = basis();
  // Pass 1 — screen-space extent, so the fit is measured, not guessed.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let tris = 0;
  for (const p of parts) {
    const q = p.positions;
    tris += q.length / 9;
    for (let i = 0; i < q.length; i += 3) {
      const x = q[i] * r[0] + q[i + 1] * r[1] + q[i + 2] * r[2];
      const y = q[i] * u[0] + q[i + 1] * u[1] + q[i + 2] * u[2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || tris === 0) return null;
  const pad = 16;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const s = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const ox = (W - spanX * s) / 2 - minX * s;
  const oy = (H - spanY * s) / 2 - minY * s;

  const rgba = new Uint8Array(W * H * 4);
  const zbuf = new Float32Array(W * H).fill(Infinity);

  for (const p of parts) {
    const q = p.positions;
    for (let i = 0; i < q.length; i += 9) {
      const sx: number[] = [], sy: number[] = [], sz: number[] = [];
      for (let k = 0; k < 3; k++) {
        const a = i + k * 3;
        sx.push(q[a] * r[0] + q[a + 1] * r[1] + q[a + 2] * r[2] * 1);
        sy.push(q[a] * u[0] + q[a + 1] * u[1] + q[a + 2] * u[2]);
        sz.push(q[a] * d[0] + q[a + 1] * d[1] + q[a + 2] * d[2]);
      }
      // Face normal in world space, for flat shading against a headlight.
      const ax = q[i + 3] - q[i], ay = q[i + 4] - q[i + 1], az2 = q[i + 5] - q[i + 2];
      const bx = q[i + 6] - q[i], by = q[i + 7] - q[i + 1], bz = q[i + 8] - q[i + 2];
      let nx = ay * bz - az2 * by, ny = az2 * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const lambert = Math.abs(nx * d[0] + ny * d[1] + nz * d[2]);
      const shade = 0.30 + 0.70 * lambert;
      const cr = Math.round(214 * shade), cg = Math.round(178 * shade), cb = Math.round(84 * shade);

      const px = sx.map((v) => v * s + ox);
      const py = sy.map((v) => H - (v * s + oy));
      const x0 = Math.max(0, Math.floor(Math.min(...px)));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(...px)));
      const y0 = Math.max(0, Math.floor(Math.min(...py)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(...py)));
      const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const cx = x + 0.5, cy = y + 0.5;
          const w0 = ((px[1] - cx) * (py[2] - cy) - (px[2] - cx) * (py[1] - cy)) / area;
          const w1 = ((px[2] - cx) * (py[0] - cy) - (px[0] - cx) * (py[2] - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
          const idx = y * W + x;
          if (z >= zbuf[idx]) continue;
          zbuf[idx] = z;
          const o = idx * 4;
          rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb; rgba[o + 3] = 255;
        }
      }
    }
  }
  return { png: encodePng(W, H, rgba), triangles: tris };
}

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

/** A human title from a cad filename, with this tree's suffixes spelled out. */
function titleOf(path: string): string {
  const base = path.split('/').pop()!.replace(/\.scad$/, '');
  const stripped = base
    .replace(/^2bee_/, '')
    .replace(/_(3d|wcnc|acnc)$/, '')
    .replace(/_/g, ' ')
    .trim();
  const sentence = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  /* Acronyms this tree actually uses. Sentence-casing alone renders these as
   * "Cnc", "Qr", "Pcb" — which reads as a typo on a card and, for `PCB`, as a
   * different word. Kept as an explicit list rather than an all-caps heuristic:
   * a rule like "≤3 letters" would also shout at `Lid` and `Box`. */
  return sentence.replace(/\b(cnc|qr|pcb|led|usb|sc133|mppt|io)\b/gi, (m) => m.toUpperCase());
}

/** What the filename suffix promises about the part, stated not guessed. */
function kindOf(path: string): string {
  /* 'flat part', never 'sheet part'. `sheet` is a RETIRED term in this app's
   * operator-facing vocabulary (`tests/terminology.test.ts` — it is the word
   * that collapsed the spoilboard and the travel, canon S1). These strings are
   * read off a card by an operator, and until 2026-09-02 they escaped that
   * sweep entirely because it reached only `web/src` — this file is `web/`
   * but not `web/src`. Ten cards carried the retired word. The sweep now
   * covers `web/scripts` too, so this cannot recur silently. */
  if (/_wcnc\.scad$/.test(path)) return 'flat part — cut on the CNC';
  if (/_acnc\.scad$/.test(path)) return 'flat part — cut on the CNC (alt)';
  if (/_3d\.scad$/.test(path)) return '3D-printed part';
  if (/_assembly\.scad$/.test(path)) return 'assembly — several parts in place';
  if (/_pcb\.scad$/.test(path)) return 'board outline / PCB stand-in';
  return 'model';
}

// ---------------------------------------------------------------------------
// DESCRIPTIONS + WITHHOLDING.
//
// `cad` writes the beekeeper-facing sentence for each part, sourced from that
// part's own .scad header (hardware/cad/shop_descriptions.yaml, 2026-09-05).
// This lane does NOT write them: a confident description of another lane's
// part, written by someone who did not design it, is a claim wearing a fact's
// clothes. A part with no entry gets NO sentence — never a generated one.
//
// 🔴 AND WITHHOLDING THE SENTENCE DOES NOT WITHHOLD THE CARD. `cad` refused to
// describe four DUAL-QUEEN entrance parts, because the founder ruled 2026-08-10
// *"no dual queen setup, simple 1 queen setup"* and those rows still read as
// live. That refusal reached their file and NOT this generator, which builds a
// card per .scad FILE — so all four were on the page anyway, with a title and a
// thumbnail and no sentence, which reads as "a design you could make". The
// missing sentence was the only visible difference, and a missing sentence is
// exactly what an undescribed part looks like.
//
// ⚠ THE TWO POPULATIONS ARE NOT THE SAME. `cad` withholds by REGISTERED PART
// NAME; this file walks FILES. `2bee_entrance_dual_queen_assembly.scad` has no
// registered name, so it is outside their list entirely — and it is the one
// whose TITLE states the cancelled configuration. A withhold list inherited
// from another lane's population is a withhold list with holes in it.
//
// This is not a ruling on the parts: nothing here is deleted, and whether those
// rows should be withdrawn is `ceo`'s scope call and `cad`'s geometry. It only
// stops publishing a cancelled configuration to strangers who cannot know it
// was cancelled, while that question is open. The withholding is PUBLISHED in
// the index, so it is a decision someone can see rather than a gap.
// ---------------------------------------------------------------------------

/** Registered part names `cad` has withheld, and this catalogue must not list. */
const WITHHELD_PART_NAMES = [
  'entrance_vertical_divider_closed',
  'entrance_half_scrubber',
  'entrance_center_closer',
  'entrance_center_divider',
];

/**
 * ⚠ WITHHOLDING A DESCRIPTION IS NOT A REASON TO WITHHOLD A CARD, and this lane
 * has now met both directions of that in one day.
 *
 * The dual-queen parts are withheld because the FOUNDER cancelled the
 * configuration: a card publishes a thing that was called off. But `cad` also
 * withholds descriptions for `sensor_pod_v1_body` / `_lid` for a completely
 * different reason — `fleet_parts.yaml:499,512` register both as LIVE while the
 * CAD prose had been calling v1 superseded, a status `cad` corrected as
 * unsourced. 🔴 THOSE CARDS STAY LISTED. The registry is the canonical statement
 * of what is a fab part; pulling them would settle a live disagreement in favour
 * of the prose that was already retracted, which is exactly the inference `cad`
 * corrected themselves for. Withholding is not the safe default — it is a claim
 * that something should not be offered, and it needs its own evidence.
 *
 * ⇒ The rule these two cases share is NOT "no sentence, no card". It is: a card
 * is withheld when publishing the DESIGN is wrong, never when someone declined
 * to write prose about it. Most of this catalogue has no sentence at all.
 */

/**
 * Withheld BY PATH — the publishing population's own key. Each carries its OWN
 * reason, because these are different decisions and a shared string would let
 * one group's justification silently cover another's.
 */
const WITHHELD_PATHS: Record<string, string> = {
  /* No registered name covers this one — see the "two populations" note above. */
  '2bee_entrance/2bee_entrance_dual_queen_assembly.scad': '',
  /* 🔴 RULED by ceo 2026-09-05, and the reason is an ABSENCE, not a status.
   * fleet_parts.yaml registers v1 (2 rows) and v3 (4 rows) and registers NO v2
   * part; v2 has zero references outside its own directory, v3 never names it as
   * a predecessor, and its only "replaced by" notes are internal to itself.
   * ⇒ NOTHING IN THE TREE SAYS WHAT v2 IS — which is the finding, not an
   * inconvenience, and it is why nobody may infer the answer from it. Withheld so
   * an unregistered generation is not offered to strangers while its own tree
   * cannot say whether it is live. Reversible in one line and decides nothing;
   * `cad` states the status, and it must cover the boards too
   * (sensor_pod_v2.kicad_pcb, sensor_pod_v2_soc.kicad_pcb). */
  '2bee_sensor_pod_v2/pod_v2_carrier.scad': '',
  '2bee_sensor_pod_v2/pod_v2_devboard.scad': '',
  '2bee_sensor_pod_v2/pod_v2_enclosure.scad': '',
};
/* ⚠ REWRITTEN 2026-09-05 — this said the status was ABSENT and that nothing in
 * the tree stated whether v2 was live. True when written, and false hours later:
 * `cad` found the statement one directory away in a file class their lane does
 * not read. A withhold reason that describes a question as open, after it has
 * been answered, is the same stale-reason defect this file has now hit twice in
 * one day — and it is worse here, because the reason is PUBLISHED and a reader
 * would take "nobody knows" from an index that could have told them. */
const WITHHELD_V2_WHY =
  'SUPERSEDED sensor-pod generation. hardware/pcb/sensor_pod_v2/_SUPERSEDED.md records the ' +
  'founder ruling of 2026-08-25 — "v2 is not needed, we are working on v3" — and it governs the ' +
  'boards as well as the enclosure. Not a deletion: the files stay, retained for reference, and ' +
  'cad has stated that status in all six headers. ⚠ The withholding began before that statement ' +
  'was found, on ceo\'s 2026-09-05 ruling that an unregistered generation must not be offered ' +
  'while its own tree could not say what it was; the ruling was right and the reason has changed ' +
  'under it.';

/* ⚠ RULED 2026-09-05 by ceo: NEITHER describe NOR delete. This reason used to
 * say the status was "open", which was true when written and stale hours later
 * — and a withhold reason that describes the question as open is read as a job
 * nobody has done, not a decision somebody made. The deletion half is not a
 * formality: `2bee_hive/side_hive_bottom_board.scad:7` declines to be a varroa
 * tray BECAUSE this part carries the drop, so removing it would strand another
 * part's stated reason for not having that function. */
const WITHHELD_WHY =
  'dual-queen entrance part. The founder ruled 2026-08-10 "no dual queen setup, simple 1 queen ' +
  'setup"; ceo ruled 2026-09-05 that these are neither described nor deleted, because the ' +
  'mite-removal function has no full-width part to move to yet. Not a deletion and not a ' +
  'withdrawal — the row stays registered; this catalogue simply does not publish a cancelled ' +
  'configuration to a reader who has no way to know it was cancelled.';

// ---------------------------------------------------------------------------
// PROHIBITED CLAIMS IN THE REPUBLISHED SOURCE.
//
// 🔴 THE HOOK'S EXEMPTION DOES NOT TRANSFER TO THIS MEDIUM, and that is the
// whole finding. `.githooks/pre-commit` §3c deliberately scopes the claim check
// in a `.scad` to RENDERED text — `text()` plates and KiCad silk — with the
// reasoning, correct for its own purpose, that "comments and .md prose render
// to nothing". It also measured that in hardware "opening" usually means opening
// the ENCLOSURE, not the hive, and widening the path would cry wolf on seven
// legitimate engineering lines.
//
// ⇒ Both hold for a physical part and BOTH FAIL HERE, because this generator
// copies each design's whole `.scad` closure — comments included — into
// public/shop/d/<id>.json and serves it. A comment that renders to nothing on a
// moulded plate renders to a paragraph on a web page.
//
// ⚠ IT WAS NOT HYPOTHETICAL. ceo found the founder's banned phrasing in the
// shipped JSON on 2026-09-05: `lib/components/luckfox_pico_zero.scad:157` says a
// card and camera "are reachable from outside the hive without opening
// anything" — referent THE HIVE, which is the claim banned since 2026-05-26,
// not the enclosure sense the hook measured.
//
// 🔴 AND IT LEFT THE OUTPUT BY ACCIDENT. That library is imported only by
// `2bee_sensor_pod_v2/` files, and those cards were withheld hours later on
// ceo's ruling about an UNREGISTERED GENERATION — a completely unrelated reason.
// Nothing checked, nothing reported, and the phrase would return the moment any
// listed design includes that shared component. A leak that closes as a side
// effect of an unrelated decision has not been fixed; it has been unobserved.
//
// So the check runs on the PRODUCER, per ceo's ruling: tracking public/shop/
// would recreate the second-source-of-truth problem the ignore exists to avoid.
// ---------------------------------------------------------------------------

/** Founder rule 2026-05-26, stated in CLAUDE.md: never "non-invasive" / "no
 *  opening". Kept as a phrase family rather than literals — the banned claim has
 *  no single spelling, and this medium republishes prose nobody wrote for it. */
const PROHIBITED_CLAIMS = [
  /\bnon[-\s]?invasive\b/i,
  /\bno opening\b/i,
  /\bwithout opening\b/i,
  /\bnever open(?:ing)? the hive\b/i,
  /\bwithout disturbing the (?:bees|colony|hive)\b/i,
];

/**
 * Lines allowed through, each with the REFERENT that makes it safe.
 *
 * ⚠ The referent is the whole question. "without opening the enclosure lid" is
 * an engineering fact; "without opening the hive" is the banned claim. Same
 * words, different subject — which is why this is a human judgement recorded
 * per string, not a pattern, and why an entry has to say what the subject IS.
 */
/* ⚠ EMPTY, and it did not start that way. The one entry this list was written
 * for — an ASA connector face with "no opening", a solid moulding rather than a
 * hive — lives in a 2bee_sensor_pod_v2/ file, and those cards are withheld. The
 * stale-exemption check below caught that on the first run: an exemption for a
 * line nothing publishes is a note that reads as diligence and would silently
 * cover a future line matching the same words. Empty is the honest state. */
const CLAIM_EXEMPT: { match: string; why: string }[] = [];

/**
 * 🔴 A WITHHOLD LIST MUST BE KEYED ON THE PUBLISHING POPULATION (ceo, 2026-09-05).
 *
 * `cad` withheld by REGISTERED PART NAME and this generator publishes FILES, so
 * their list could not reach `2bee_entrance_dual_queen_assembly.scad` — a fit
 * view, correctly absent from `fleet_parts.yaml` because it is not fabricable,
 * and the one card whose TITLE stated the cancelled configuration outright.
 * ⇒ The two populations differ BY CONSTRUCTION: the registry lists things you
 * can make, this page lists files that render. A list inherited from the
 * authoring side is structurally unable to cover the publishing side.
 *
 * So the named list above is no longer trusted to be complete. This sweeps the
 * population this file actually publishes and REFUSES THE BUILD if a design
 * names the cancelled configuration and is neither withheld nor exempted.
 *
 * ⚠ IT DETECTS, IT DOES NOT WITHHOLD. Auto-withholding on the phrase would be
 * wrong twice over: `inwall_panel_cut.scad` names it because it APPLIES the
 * ruling, and `2bee_entrance_vertical_divider_3d.scad` names it only to
 * cross-reference the closed variant while being an ordinary single-queen part.
 * Same shape as the alias gate's teaching-mention problem — a mention is not an
 * assertion — and the resolution is the same: a human decides, once, in writing.
 */
const CANCELLED_CONFIG = /dual[-\s]queen/i;

/** Listed designs that name it and are NOT withheld, each with a sourced why. */
const CANCELLED_EXEMPT: Record<string, string> = {
  '2bee_entrance/2bee_entrance_vertical_divider_3d.scad':
    'header reads "Vertical divider for mite scrubber" — an ordinary single-queen Mite Scrubber ' +
    'part. Its only two mentions (lines 61, 92) CROSS-REFERENCE the closed variant, which is ' +
    'withheld; neither says this part is one. Checked against the file 2026-09-05.',
};

/** `- { name: x, scad: y, ... }` rows in cad's registry. Commented rows are NOT
 *  entries — the file carries several as worked examples. */
function readRegisteredParts(text: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*-\s*\{\s*name:\s*([A-Za-z0-9_]+)\s*,\s*scad:\s*([^\s,}]+)/.exec(line);
    if (m) byName.set(m[1], m[2]);
  }
  return byName;
}

/** The `descriptions:` map. Keys at one indent level, values folded (`>`) or
 *  plain. Written here rather than pulled in: a YAML dependency in an AGPL tree
 *  is a licence question (see AGENTS.md), and this reads two known shapes.
 *  🔴 A line this reader does not understand is REPORTED, not skipped — an
 *  unreadable entry and an absent one look identical on the page otherwise. */
function readDescriptions(text: string): { map: Map<string, string>; unread: string[] } {
  const map = new Map<string, string>();
  const unread: string[] = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^descriptions:\s*$/.test(l));
  if (start < 0) return { map, unread: ['no `descriptions:` block'] };
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key) map.set(key, buf.join(' ').replace(/\s+/g, ' ').trim());
    key = null;
    buf = [];
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break; // dedented out of the block
    const k = /^\s{2}([A-Za-z0-9_]+):\s*(>[-+]?|\|[-+]?)?\s*(.*)$/.exec(line);
    if (k) {
      flush();
      key = k[1];
      if (k[3]) buf.push(k[3]);
      continue;
    }
    if (key && /^\s{4,}\S/.test(line)) { buf.push(line.trim()); continue; }
    unread.push(line.trim().slice(0, 80));
  }
  flush();
  return { map, unread };
}

const registered = readRegisteredParts(readFileSync(join(CAD_ROOT, 'fleet_parts.yaml'), 'utf8'));
const { map: DESCRIPTIONS, unread: DESC_UNREAD } = readDescriptions(
  readFileSync(join(CAD_ROOT, 'shop_descriptions.yaml'), 'utf8'),
);
if (DESC_UNREAD.length > 0) {
  throw new Error(
    `shop_descriptions.yaml: ${DESC_UNREAD.length} line(s) this reader does not understand, and a ` +
      `misread description is invisible on the page: ${DESC_UNREAD.slice(0, 3).join(' | ')}`,
  );
}

/** name -> path, so a withhold expressed in cad's population lands in ours. */
const withheldPaths = new Map(Object.entries(WITHHELD_PATHS));
for (const [p, why] of withheldPaths) {
  if (why) continue;
  withheldPaths.set(p, p.startsWith('2bee_sensor_pod_v2/') ? WITHHELD_V2_WHY : WITHHELD_WHY);
}
for (const name of WITHHELD_PART_NAMES) {
  const scad = registered.get(name);
  /* 🔴 FAIL-CLOSED. If the name stops resolving — renamed, or the row removed —
   * the withhold must not quietly degrade into publishing. A withhold that
   * silently stops applying is worse than none, because the page looks the same
   * either way and the list still reads as though it is doing something. */
  if (!scad) {
    throw new Error(
      `withheld part '${name}' is no longer a registered part in fleet_parts.yaml. It may have ` +
        'been withdrawn (then drop it from WITHHELD_PART_NAMES) or renamed (then update it) — ' +
        'but this build will not publish it by default.',
    );
  }
  withheldPaths.set(scad, WITHHELD_WHY);
}
/* The other direction: a withheld part that acquires a description means cad
 * changed its mind, and this list is then stale in the direction that publishes. */
for (const name of WITHHELD_PART_NAMES) {
  if (DESCRIPTIONS.has(name)) {
    throw new Error(
      `withheld part '${name}' now HAS a description in shop_descriptions.yaml. cad withheld it ` +
        'over the 2026-08-10 dual-queen ruling; if that is settled, clear it here in the same change.',
    );
  }
}

/* 🔴 ONE FILE CAN BE SEVERAL REGISTERED PARTS, so this is a map to a LIST.
 * `2bee_feeder/feeder_box_panel_wcnc.scad` is registered twice, as
 * `feeder_box_end` and `feeder_box_side` — one sheet, two parts on it, and cad
 * wrote a sentence for each. A `Map<path, name>` inverted from the registry
 * keeps whichever row it read last and drops the other WITHOUT ERROR: the card
 * still shows a description, so the page looks right and one part's sentence is
 * simply gone. Caught 2026-09-05 only because the number of keys that resolve
 * to a listed design (17) disagreed with the number of described cards (13). */
const pathToNames = new Map<string, string[]>();
for (const [name, scad] of registered) {
  const at = pathToNames.get(scad);
  if (at) at.push(name);
  else pathToNames.set(scad, [name]);
}

// ---------------------------------------------------------------------------
// BANNED PATENT ALIASES, CHECKED ON THE PUBLISHED ARTEFACT.
//
// 🔴 THE FLEET'S ALIAS GATE CANNOT SEE THIS PAGE. `.githooks/pre-commit` scans
// files being COMMITTED; `web/public/shop/` is gitignored on purpose (a
// committed copy of another lane's designs would be a second source of truth).
// ⇒ The most outward-facing artefact this lane produces is the one artefact
// that control never reads. Nothing was wrong when this was written — the
// catalogue measured zero alias hits on 2026-09-05 — which is exactly when a
// gap is cheap to close and impossible to notice.
//
// ⚠ THE REMEDIATION TEXT IS PART OF THE CONTROL, and it was wrong until
// 2026-09-06. It said only "fix it THERE rather than here" — so a hit on a
// CORRECTION NOTE (cad's file carries four, explaining this very ban) would have
// instructed someone to delete the record of the fix it documents. ceo hit the
// same shape the same day in monitoring's date check, where "fix this FIRST"
// pointed at ten lines that were prose QUOTING a bad date.
//
// 🔴 The resolution here is the OPPOSITE of theirs, and deliberately so. They
// added a DISCUSSED bucket that stops firing on a mention. This gate must still
// fire: on an outward page a quoted ban IS the ban, because the publisher strips
// the context that made the quote safe. ⇒ Same defect class, different medium,
// opposite correct answer — so what changed is the INSTRUCTION, not the trigger.
//
// ⚠ AND THE COPY IS NOT OURS. Every description is `cad`'s text, rendered
// verbatim to strangers. Their gate checks their YAML at their commit; between
// that and this page there is nothing. `ceo` demonstrated the failure the same
// day, on themselves: they wrote "varroa scrubber" — a banned alias — inside a
// RULING about a banned phrase, and the hook caught it, not the reading. A
// careful author writing about the ban still produced one.
//
// The alias LITERALS come from legal/canon/facts.yaml, never retyped here:
// that list is legal's data and they add to it without telling this lane.
// ⚠ The STEM RULE is a re-implementation of the hook's interpretation
// (.githooks/pre-commit `_alias_pattern`, ceo 2026-08-11) and is therefore a
// second expression of one rule. It is kept deliberately identical and narrow —
// only the LAST word is stemmed, only when >=4 characters remain — and it errs
// toward matching: a false positive here costs one build, a miss costs a
// published patent alias.
// ---------------------------------------------------------------------------

/** `forbidden_aliases` plus the ACCEPTED forms, read out of legal's canon. */
function readPatentNames(text: string): { banned: string[]; accepted: string[] } {
  const banned: string[] = [];
  const accepted: string[] = [];
  let inPatents = false;
  let key: 'banned' | 'accepted' | null = null;
  for (const line of text.split('\n')) {
    if (/^patents:\s*$/.test(line)) { inPatents = true; continue; }
    if (inPatents && /^\S/.test(line)) break; // dedented out of `patents:`
    if (!inPatents) continue;
    const name = /^\s{4}name:\s*(.+?)\s*$/.exec(line);
    if (name) { accepted.push(name[1]); key = null; continue; }
    if (/^\s{4}forbidden_aliases:\s*$/.test(line)) { key = 'banned'; continue; }
    if (/^\s{4}aliases:\s*$/.test(line)) { key = 'accepted'; continue; }
    const item = /^\s{4}-\s+(.+?)\s*$/.exec(line);
    if (item && key) { (key === 'banned' ? banned : accepted).push(item[1]); continue; }
    if (/^\s{4}\w[\w_]*:/.test(line)) key = null;
  }
  return { banned, accepted };
}

/** The hook's stem rule: inflect the LAST word only. See the note above. */
function aliasPattern(alias: string): RegExp {
  const words = alias.split(/\s+/);
  let last = words[words.length - 1];
  for (const suf of ['ers', 'er', 's']) {
    if (last.toLowerCase().endsWith(suf) && last.length - suf.length >= 4) {
      last = last.slice(0, -suf.length);
      break;
    }
  }
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = [...words.slice(0, -1).map(esc), esc(last) + '\\w*'];
  return new RegExp('\\b' + parts.join('[\\s-]+') + '\\b', 'i');
}

const PATENTS = readPatentNames(
  readFileSync(join(CAD_ROOT, '..', '..', 'legal', 'canon', 'facts.yaml'), 'utf8'),
);
/* 🔴 AN EMPTY LIST WOULD MAKE EVERY PAGE CLEAN. A reader that silently returns
 * nothing — the key renamed, the block moved — is indistinguishable from copy
 * with no aliases in it, and this check would report a pass forever. */
if (PATENTS.banned.length < 5 || PATENTS.accepted.length < 3) {
  throw new Error(
    `read only ${PATENTS.banned.length} forbidden and ${PATENTS.accepted.length} accepted patent ` +
      'name(s) from legal/canon/facts.yaml — too few to be the real list, so this check would ' +
      'pass on anything. Fix the reader before publishing.',
  );
}
const BANNED = PATENTS.banned.map((a) => ({ alias: a, re: aliasPattern(a) }));
/* Accepted forms are stripped FIRST, because one banned alias is a proper
 * substring of its own canonical name by design (facts.yaml records the
 * exemption), so a naive search flags the CORRECT name as wrong. The hook
 * strips accepted forms before searching; so does this. Longest first, or a
 * short form eats a long one.
 * ⚠ This comment could not name the alias it is about: writing the banned form
 * here — even to explain why it is exempt — is itself a violation, and the
 * pre-commit gate blocked this very file for it. Third time in one day the copy
 * nearest the rule broke the rule. The example lives in facts.yaml, which is an
 * exception path, and that is the right place for it. */
const ACCEPTED = PATENTS.accepted
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));

/** Every banned alias in `text`, after the accepted names are removed. */
export function bannedAliasesIn(text: string): string[] {
  let stripped = text;
  for (const re of ACCEPTED) stripped = stripped.replace(re, ' ');
  return BANNED.filter((b) => b.re.test(stripped)).map((b) => b.alias);
}

const files = new Map<string, string>();
(function walk(dir: string) {
  for (const e of readdirSync(dir)) {
    if (e === '__pycache__' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.scad')) {
      const k = normalisePath(relative(CAD_ROOT, p));
      if (k) files.set(k, readFileSync(p, 'utf8'));
    }
  }
})(CAD_ROOT);

const lib: ScadLibrary = { files, rootName: 'cad', pickedAt: Date.now(), skipped: [] };

// ---------------------------------------------------------------------------
// BOARDS MARKED DO-NOT-FAB, SURFACED ON THE CARD.
//
// ceo, 2026-09-05: `hardware/pcb/sensor_pod/_SUPERSEDED.md` says "Do not fab",
// and `sensor_pod_pcb_sync.scad` was extracted from that board EIGHT DAYS AFTER
// the marker was written. 🔴 The marker's own text is *"gate_check.py skips this
// board while this file exists"* — it was built to make one tool STOP CHECKING
// and read by a second tool as nothing at all, so the board stopped being
// verified and did not stop being used.
//
// This page is a third reader, and it was doing neither: it republishes those
// syncs inside the design bundles and offers the parts as designs you could
// make, with nothing anywhere saying the PCB underneath is one we have said we
// will not fabricate.
//
// 🔴 RULING EXTENDED 2026-09-05: WITHHELD, not annotated. This lane first
// surfaced it on the card, reasoning from ceo's "the contradiction must be
// visible rather than resolved by deletion" — but that sentence was about a
// REGISTRY ROW, which engineers read, not about a catalogue card, which
// strangers read. ceo ruled the page must refuse: same treatment as the other
// withheld groups, reason published, nothing deleted.
//
// ⚠ THE CAVEAT BELOW WAS PUT TO ceo BEFORE THE RULING AND THEY RULED ANYWAY, so
// it is recorded, not re-litigated: closure membership is a REFERENCE, not proof
// of a geometric dependency, and this removes 8 designs including a hive cut
// file and both v3 enclosure parts — v3 having been ADDED to the catalogue hours
// earlier to close a different gap. Triaging which are load-bearing is cad's,
// and each one they clear comes back by deleting a line.
//
// ⚠ WHAT THIS DOES NOT ESTABLISH, and the number is meaningless without it: a
// sync being in a design's CLOSURE is not proof the design's geometry DEPENDS on
// that board. A params chain can pull one in transitively. So the field names
// the board and the file it came in through, and claims exactly that — a
// reference, not a dependency. Deciding which are load-bearing needs cad.
// ---------------------------------------------------------------------------

/**
 * 🔴 EVERY PUBLISHED SOURCE MUST EXIST IN GIT.
 *
 * This generator walks the FILESYSTEM, so an untracked file in cad's working
 * tree is published exactly like a committed one — served to strangers while
 * being absent from the repository and from every gate whose population is
 * tracked files. `cad` found one on 2026-09-05: an orphaned
 * `sensor_pod_v2_pcb_sync.scad`, dated ten days before the board it syncs was
 * superseded, sitting in live CAD and invisible to `git`.
 *
 * ⚠ IT MEASURED ZERO WHEN THIS WAS WRITTEN, AND THAT IS WHY IT EXISTS. The
 * orphan is out of the published set only because the v2 cards are withheld —
 * a ruling made for an unrelated reason. That is the SECOND leak today to close
 * as a side effect of an unrelated decision rather than because anything checked
 * (the first was a banned claim in a library header). A clean number produced by
 * luck and a clean number produced by a control are indistinguishable, so this
 * turns the second one into something that stays true.
 */
/* ⚠ `-z` AND SPLIT ON NUL, never newline (ceo `§18z-b`, 2026-09-09).
 * `git ls-files` QUOTES a path containing non-ASCII bytes — wrapping it in
 * double quotes with backslash escapes — so a newline-split set holds
 * `"hardware/cad/caf\303\251.scad"` while `files` holds the real name. The
 * entry then misses, the design is reported UNTRACKED, and it is withheld with
 * a reason that is FALSE: git does track it.
 * ⚠ Direction matters: this over-withholds. A design vanishes from the page
 * carrying a stated reason that is wrong, which is worse than vanishing without
 * one, because the reason forecloses the question.
 * 🟢 MEASURED 2026-09-09 before changing it: 0 quoted entries and 13 containing
 * a space today, and both split methods returned the same 1,226 paths — so this
 * is latent, not live, and the fix is cheap now and invisible later. */
const TRACKED = new Set(
  execFileSync('git', ['-C', join(CAD_ROOT, '..', '..'), 'ls-files', '-z', '--', 'hardware/cad'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .map((l) => l.replace(/^hardware\/cad\//, '')),
);
if (TRACKED.size < 100) {
  throw new Error(`git ls-files returned only ${TRACKED.size} path(s) under hardware/cad — that reads as a broken invocation, and an empty set would mark every source untracked or none`);
}

const PCB_ROOT = join(CAD_ROOT, '..', 'pcb');
const SYNC_BOARD = /AUTO-GENERATED from pcb\/([A-Za-z0-9_]+)\//;

/** board -> the marker's own first meaningful line, for boards marked do-not-fab. */
const SUPERSEDED_BOARDS = new Map<string, string>();
try {
  for (const d of readdirSync(PCB_ROOT)) {
    const marker = join(PCB_ROOT, d, '_SUPERSEDED.md');
    if (!existsSync(marker)) continue;
    const line = readFileSync(marker, 'utf8')
      .split('\n')
      .map((l) => l.replace(/^[#>\s*-]+/, '').trim())
      .find((l) => l.length > 20);
    SUPERSEDED_BOARDS.set(d, line ?? '_SUPERSEDED.md present, no summary line');
  }
} catch {
  /* 🔴 NOT SILENT. pcb/ is another lane's tree and may be absent in a partial
   * checkout; an empty map would make every card read as clean, which is the
   * empty-population trap this file has already been bitten by once today. */
  throw new Error(`could not read ${PCB_ROOT} to check for superseded boards — refusing to publish`);
}
if (SUPERSEDED_BOARDS.size === 0) {
  /* 🔴 NOT KEYED ON A COUNT. ceo, ruling this: "do not key the check on 4 — key
   * it on the marker's presence, or it becomes the next name-list that rots."
   * So this asserts only that the scan FOUND SOMETHING; zero means the scan
   * broke, because an empty result and a clean tree are the same output. The
   * top level is the right scope: a sync names its board as `pcb/<board>/`, and
   * the 5 further markers under pcb/archive/ are not addressable that way. */
  throw new Error('no _SUPERSEDED.md found under hardware/pcb — an empty scan and a clean tree produce the same number, so this is treated as broken rather than good news');
}

/** Superseded boards referenced anywhere in a design's source closure. */
function supersededIn(closure: string[]): { board: string; via: string; marker: string }[] {
  const out: { board: string; via: string; marker: string }[] = [];
  for (const f of closure) {
    if (!f.endsWith('_pcb_sync.scad')) continue;
    const m = SYNC_BOARD.exec(files.get(f) ?? '');
    if (!m) continue;
    const marker = SUPERSEDED_BOARDS.get(m[1]);
    if (marker) out.push({ board: m[1], via: f, marker });
  }
  return out;
}
const host = makeLibraryHost(lib);
const edges = importEdges(lib);

function closureOf(start: string): string[] {
  const seen = new Set<string>();
  const q = [start];
  while (q.length) {
    const p = q.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const e of edges.get(p) ?? []) if (e.resolved && files.has(e.resolved)) q.push(e.resolved);
  }
  return [...seen].sort();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'd'), { recursive: true });
mkdirSync(join(OUT, 't'), { recursive: true });

interface Entry {
  id: string; path: string; title: string; family: string; familyBlurb: string;
  kind: string; parts: number; triangles: number; trust: string; trustDetail: string;
  sizeMm: [number, number, number] | null; files: number; bytes: number; thumb: string | null;
  /** cad's sentence per registered part on this file — a file can carry several.
   *  Empty when cad has written none: NEVER generated here, see the note above. */
  describes: { part: string; text: string }[];
  /** Registered part names this file produces; empty if it is not registered. */
  partNames: string[];
}

const entries: Entry[] = [];
/** Prohibited-claim hits in the SOURCE this page republishes — see the note above. */
const claimOffences: string[] = [];
/** Lines actually fed to the prohibited-claim patterns. See WITNESSES below. */
let claimLinesScanned = 0;
/** Untracked files in the CURRENT design's closure — see the note above TRACKED. */
let untrackedInClosure: string[] = [];
const dropped: { path: string; why: string }[] = [];
const withheld: { path: string; why: string }[] = [];
/** Directories holding an openable design that `FAMILIES` does not offer. */
const unlisted = new Map<string, number>();

for (const fam of FAMILIES) {
  for (const path of [...files.keys()].sort()) {
    if (path.split('/')[0] !== fam.dir) continue;
    if (/\/(archive|lib)\//.test(path)) continue;
    if (withheldPaths.has(path)) { withheld.push({ path, why: withheldPaths.get(path)! }); continue; }

    const parsed = parseScad(files.get(path)!, { host, path });
    /* ⚠ A DROP PRE-EMPTS EVERY WITHHOLDING ASSESSMENT, and that is stated rather
     * than fixed. Swept 2026-09-06 on ceo's prompt — three instances of the
     * else-if masking shape in this lane is a rate, so: every `fail(` chain in
     * the gate branches on mutually exclusive readings of ONE state and masks
     * nothing, but the drops below `continue` before any withholding runs. So a
     * design that both fails to parse AND sits on a do-not-fab board is recorded
     * only as unreadable, and fixing the parse error would return it with the
     * board question never having been shown.
     *
     * NOT reordered, and the reason is a real one rather than cost: a design
     * this reader cannot open has no trustworthy closure, and every withholding
     * here is computed FROM the closure. Reporting a policy verdict derived from
     * a source we could not read would be the more confident error. ⇒ Naming it
     * so the next reader knows the drop list is "what we could not assess", not
     * "what was assessed and found readable-but-fine". */
    if (parsed.counts.primitives === 0) continue; // a library of modules, not a design
    if (parsed.errors.length > 0) {
      dropped.push({ path, why: `this reader reported ${parsed.errors.length} error(s): ${parsed.errors[0].message.slice(0, 120)}` });
      continue;
    }
    if (parsed.unsupported.length > 0) {
      const names = [...new Set(parsed.unsupported.map((u) => u.name))];
      /* 🔴 `%` ALONE IS NOT A PARSER GAP, and saying so matters because the
       * obvious "fix" is wrong. A `%` subtree is BACKGROUND: OpenSCAD ghosts it
       * in the preview and leaves it out of the render AND the export, which is
       * exactly what our core does — so the exported geometry is right and only
       * the ghost is absent.
       *
       * ⚠ INVESTIGATED 2026-09-05 and DELIBERATELY NOT CHANGED. Listing these
       * with a trust caveat looked correct from the geometry alone, until the
       * population was read: all ten are `_assembly`, `_viz`, `_lookmodel`,
       * `anim_*` or a table view — VIEW files, which is precisely where `%` is
       * used to show surrounding context. For those the ghost is not a missing
       * reference shape, it is most of the picture, so a card would carry a
       * confident thumbnail of an assembly with its context silently gone.
       * ⇒ The refusal is MORE right for exactly the files it catches, and the
       * argument for relaxing it came from reasoning about geometry while the
       * whole purpose of the file is the view. Recorded so it is not re-derived.
       * 21 of the 25 `%`-only designs across the whole tree DO mesh, so the
       * tempting evidence is real and still does not license the change. */
      const why = names.length === 1 && names[0] === 'modifier %'
        ? 'reads correctly — this is a REFUSAL, not a gap. It uses `%` (background), which OpenSCAD ' +
          'ghosts in the preview and excludes from the export, as we do; but this is a view file, ' +
          'and the ghost is the context it exists to show. A thumbnail without it would be ' +
          'confidently wrong rather than incomplete.'
        : `uses ${parsed.unsupported.length} construct(s) this reader does not implement: ${names.slice(0, 3).join(', ')}`;
      dropped.push({ path, why });
      continue;
    }

    const t0 = Date.now();
    const meshed = meshScene(parsed.scene as SceneNode);
    const ms = Date.now() - t0;
    const drawable = meshed.parts.filter((p) => p.positions.length > 0);
    if (drawable.length === 0) {
      dropped.push({ path, why: 'parses, but the mesher produced no triangles' });
      continue;
    }

    let lo: [number, number, number] = [Infinity, Infinity, Infinity];
    let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const p of drawable) {
      if (!p.bounds) continue;
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p.bounds.min[a]);
        hi[a] = Math.max(hi[a], p.bounds.max[a]);
      }
    }
    const sizeMm: [number, number, number] | null = Number.isFinite(lo[0])
      ? [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((v) => Math.round(v * 10) / 10) as [number, number, number]
      : null;

    const id = path.replace(/\.scad$/, '').replace(/[^a-zA-Z0-9]+/g, '-');

    /* 🔴 THE CLOSURE AND EVERY WITHHOLDING DECISION COME BEFORE ANY WRITE.
     *
     * They used to come after. The card vanished from the index and the design's
     * FULL SOURCE BUNDLE and rendered THUMBNAIL were still written to
     * public/shop/{d,t}/ — six of each, for the designs withheld over a
     * do-not-fab board. ⇒ I withheld the LISTING and produced the ARTEFACT.
     *
     * ⚠ WORDING CORRECTED 2026-09-06: this said "and served at guessable URLs".
     * That asserted a deploy nobody had checked. public/shop/ is gitignored
     * BUILD OUTPUT, so its exposure is a property of the deploy history, not of
     * the tree — measured after the fact: this lane has no deploy path (no S3,
     * CloudFront, CI or publish step; only dev/build/preview), vite binds
     * loopback with no host override, and 2bee.app does not resolve. So nothing
     * reached anyone, and that is a property of there being no way to ship it
     * rather than of this fix. ⚠ TRUE OF THE APP, NOT OF THE TREE — the geo lane
     * has a real S3/CloudFront pipeline, so "no deploy path exists" is the kind
     * of sentence that loses its scope in a retelling (ceo 2026-09-06). The opposite claim — "it was only local" — would
     * have been just as unearned.
     *
     * ⚠ That is precisely the shape this lane found in cad's descriptions and
     * wrote up twice — *withholding the sentence did not withhold the card* —
     * committed one layer down by the person who found it: withholding the card
     * did not withhold the source. Knowing a failure mode is not immunity from
     * it, and the second instance was mine.
     *
     * Found 2026-09-06 by deriving a count instead of asserting a floor: the
     * scan reported 79,358 lines and the bundles accounted for 67,744, and the
     * 11,614-line gap WAS the leak. A `> 10_000` threshold would have passed. */
    const closure = closureOf(path);
    untrackedInClosure = [];
    const sources: Record<string, string> = {};
    let bytes = 0;
    for (const f of closure) {
      sources[f] = files.get(f)!;
      bytes += sources[f].length;
      if (!TRACKED.has(f)) untrackedInClosure.push(f);
    }
    /* ⚠ WITHHELD, NOT A BUILD FAILURE — changed the same day it first fired.
     * This began as an offence that refused the whole catalogue, and on its
     * first real hit that was wrong: seven `_probe_s7_*` scratch files in cad's
     * working tree took the entire page down. An untracked source is a reason
     * not to publish THAT design, not a reason to stop publishing every other
     * one — and this is a shared tree where another lane's work-in-progress is
     * normal, not exceptional. Withholding also matches how every other group
     * here is handled: reason published, nothing deleted, and it reappears on
     * its own the moment the file is committed. */
    /* 🔴 EVERY REASON, NOT THE FIRST. These used to be two `continue`s, so a
     * design that was BOTH untracked and on a do-not-fab board published only
     * the untracked reason — the else-if masking shape this lane has now been
     * bitten by three times (the CAD1H ratchet limbs were the last). Nothing
     * leaked, because either reason withholds; what was lost is the SECOND
     * reason, and a reader who commits the file would see the design return with
     * no hint that a board question was ever attached to it.
     *
     * ⚠ AND THE ORDER IS THE THING TO STATE, because ceo watched me get it
     * backwards on 2026-09-06: I claimed supersession withheld first and the
     * untracked check never ran. It was the reverse. A conclusion gets cited; a
     * MECHANISM gets REUSED, and the next reader applying my version to a design
     * that IS in a closure would have been wrong exactly here. */
    const reasons: string[] = [];
    if (untrackedInClosure.length > 0) {
      const names = [...new Set(untrackedInClosure)];
      reasons.push(
          `source closure includes ${names.length} file(s) git does not track: ${names.slice(0, 3).join(', ')}` +
          `${names.length > 3 ? ` (+${names.length - 3} more)` : ''}. This generator walks the ` +
          'FILESYSTEM, so an uncommitted file would be served to strangers while absent from the ' +
          'repository and from every gate whose population is tracked files. Not a deletion and ' +
          'not a judgement on the design: commit the file and it returns on the next build.',
      );
    }

    const onSuperseded = supersededIn(closure);
    if (onSuperseded.length > 0) {
      const boards = [...new Set(onSuperseded.map((b) => b.board))];
      reasons.push(
          `source closure references ${boards.join(', ')} — ` +
          `${boards.length === 1 ? 'a board' : 'boards'} carrying _SUPERSEDED.md, which says: ` +
          `"${onSuperseded[0].marker}". A card offers a design to make, and the PCB under this one ` +
          'is one we have said we will not fabricate. ceo ruled 2026-09-05 that the page must ' +
          'refuse rather than annotate. Not a deletion: the design stays in cad\'s tree, and this ' +
          'is a REFERENCE in the source closure, not proof the geometry depends on that board — ' +
          'each one cad clears comes back.',
      );
    }

    if (reasons.length > 0) {
      withheld.push({ path, why: reasons.join(' ALSO: ') });
      continue;
    }

    /* 🔴 THE CLAIM SCAN COVERS EXACTLY WHAT SHIPS, and that is what makes its
     * witness an identity rather than a threshold. It used to run inside the
     * closure walk above — before the withholding decisions — so it counted
     * lines that were never published, and `linesScanned` could never equal
     * anything derivable from the artefact. Scanning a withheld design for
     * claims it will not publish is also work for nothing. */
    for (const f of closure) {
      for (const line of sources[f].split('\n')) {
        claimLinesScanned++;
        if (CLAIM_EXEMPT.some((e) => line.includes(e.match))) continue;
        for (const re of PROHIBITED_CLAIMS) {
          if (re.test(line)) claimOffences.push(`${path} republishes ${f}: ${line.trim().slice(0, 120)}`);
        }
      }
    }

    /* Only now — nothing withheld reaches disk. */
    const shot = render(drawable);
    if (shot) writeFileSync(join(OUT, 't', `${id}.png`), shot.png);
    writeFileSync(join(OUT, 'd', `${id}.json`), JSON.stringify({ id, path, entry: path, sources }));

    entries.push({
      id, path, title: titleOf(path), family: fam.label, familyBlurb: fam.blurb,
      kind: kindOf(path), parts: drawable.length, triangles: shot?.triangles ?? 0,
      trust: meshed.trust, trustDetail: meshed.trustDetail,
      sizeMm, files: closure.length, bytes, thumb: shot ? `t/${id}.png` : null,
      partNames: pathToNames.get(path) ?? [],
      describes: (pathToNames.get(path) ?? [])
        .filter((n) => DESCRIPTIONS.has(n))
        .map((n) => ({ part: n, text: DESCRIPTIONS.get(n)! })),
    });
    process.stdout.write(`  ${entries.length.toString().padStart(3)}. ${path} (${drawable.length}p, ${ms}ms)\n`);
  }
}

/* The narrowing check: every openable design OUTSIDE the offered families.
 * Run over the same reader, so "not offered" cannot hide behind "not readable". */
const offered = new Set(FAMILIES.map((f) => f.dir));
for (const path of files.keys()) {
  const dir = path.split('/')[0];
  if (offered.has(dir)) continue;
  if (/^(archive|lib|3dmodels)$/.test(dir) || /\/(archive|lib)\//.test(path)) continue;
  if (!path.includes('/')) continue; // a loose file at the root is not a family
  const parsed = parseScad(files.get(path)!, { host, path });
  if (parsed.counts.primitives === 0 || parsed.errors.length > 0 || parsed.unsupported.length > 0) continue;
  unlisted.set(dir, (unlisted.get(dir) ?? 0) + 1);
}

/**
 * 🔴 THE LISTED COUNT IS A RATCHET IN BOTH DIRECTIONS (ceo, 2026-09-05).
 *
 * Every other guard here catches UNDER-withholding: a design that should be off
 * the page and is not. Nothing caught the opposite. ⇒ If a future change withheld
 * sixty designs, `withheld > 0` still passes, `entries` shrinks quietly, and the
 * page narrows with every check green — which is precisely the risk this lane
 * recorded in prose ("closure membership is a REFERENCE, not proof of a
 * geometric dependency; 8 is a population to triage, not a defect count") and
 * could not see in code.
 *
 * ⚠ FAILS ON GROWTH TOO, and that is deliberate rather than tidy. A floor alone
 * goes stale upward: at 120 listed, a floor of 81 permits a silent loss of 39.
 * Raising it automatically would be the build ratifying its own baseline. So the
 * band is narrow and BOTH edges are a build failure — never a warning line,
 * because this lane spent days reading past `unlistedFamilies` printing a real
 * finding at the foot of a run that ended in a success line. A warning nobody
 * acts on is not much better than a measurement nobody took.
 */
/* 🔴 THIS CONSTANT'S COMMIT HISTORY IS THE POPULATION'S ONLY HISTORY (ceo,
 * 2026-09-06, after trying to measure the headroom and finding there was nothing
 * to measure against). `public/shop/index.json` is gitignored — deliberately, so
 * a committed copy of cad's designs cannot become a second source of truth — so
 * `git log` on the artefact returns ZERO commits and the published population has
 * never been recorded anywhere that survives a rebuild.
 *
 * ⇒ "Declare it and lower the floor in the same change" is therefore NOT
 * discipline, it is the record. A band moved without its reason in the same
 * commit erases the only evidence of what the population was, and unlike a stale
 * comment there is no artefact left to catch it against. THE COMMIT MESSAGE IS
 * THE DELIVERABLE; the number is just what it happens to say.
 *
 * ⚠ And no second copy of that history belongs here. A dated table of past
 * values beside this line would be the same fact in two stores, and the one that
 * is not enforced is the one that rots.
 *
 * ⚠ WHETHER +15 IS THE RIGHT WIDTH IS UNMEASURED, and it depends on the
 * legitimate growth rate — which is exactly what the missing history would have
 * told us. If the ceiling starts firing often, do NOT reflexively raise it: that
 * is the build ratifying its own baseline through a human instead of directly,
 * which is the failure this band was built to refuse. How often it fires is the
 * measurement nobody has yet. */
/* 🔴 READ THIS BEFORE ACTING ON A FIRING (ceo, 2026-09-06). The first two
 * firings were both cases where the MEASUREMENT was wrong, not the tree: one was
 * another lane's uncommitted files, one was a gap in our own OpenSCAD reader.
 * ⇒ Two for two trains the reflex that a fire means "fix the check".
 *
 * ⚠ THE NEXT ONE IS MORE LIKELY TO MEAN THE HARDWARE IS WRONG, and it will look
 * identical. A newly listed design that takes a dimension from a board marked
 * do-not-fab is a REAL withholding: the count drops, nothing is broken, and the
 * page is telling the truth about a question nobody has answered. Measured
 * 2026-09-06: the superseded v1 pod outline is 43.688 x 45.974 and the live v3
 * board is 66.27 x 65.0 — half again in both axes, reached through two live hops
 * into a fabbable hive panel. That dependency is not cosmetic.
 *
 * So on a firing: find the design, and ask what CHANGED about it — never start
 * from the constant. */
const LISTED_FLOOR = 81; // measured 2026-09-05, after ceo's superseded-board refusal
const LISTED_CEILING = LISTED_FLOOR + 15;
/* 🔴 BANDED ON THE COMMITTED-TREE POPULATION, not on what this run happened to
 * list. Caught the first time the band fired for real: it reported 80 against a
 * floor of 81, and the missing design was withheld because a file in its closure
 * was sitting uncommitted in another lane's working tree. That is a TRANSIENT
 * dip — it reverses on their next commit — and lowering the floor to absorb it
 * would have been the mirror image of the reflexively-raised ceiling this band
 * was built to refuse: a real narrowing permanently permitted, to accommodate a
 * state that was never a loss.
 *
 * ⇒ The number that must not shrink is the population a COMMITTED tree would
 * publish. `withheldUntracked` is added back because those designs are held only
 * by someone's unfinished work; every other withholding is a decision and stays
 * subtracted. On a shared tree that thirty lanes edit, this is the difference
 * between banding the product and banding the moment. */
/** Publish-blocking problems, declared here so the index's witness fields can
 *  report the count the run measured rather than a literal someone typed. */
const offencesFound: string[] = [];
const bandable = entries.length + withheld.filter((w) => w.why.includes('git does not track')).length;
if (bandable < LISTED_FLOOR || bandable > LISTED_CEILING) {
  throw new Error(
    `the catalogue lists ${entries.length} design(s) (${bandable} on a committed tree), outside the declared band ` +
      `${LISTED_FLOOR}..${LISTED_CEILING}. ` +
      (bandable < LISTED_FLOOR
        ? 'The page NARROWED. If that is intended — a new withholding, a ruling, a reader ' +
          'regression — say which in the commit and lower LISTED_FLOOR in the same change. A ' +
          'narrowing that nobody declared is the failure this band exists to catch.'
        : 'The page GREW past its band, so the floor is now stale and would permit a silent loss ' +
          'of everything above it. Raise LISTED_FLOOR to the new measured value.'),
  );
}

const index = {
  generatedAt: new Date().toISOString(),
  cadRoot: 'hardware/cad',
  note:
    'Generated by web/scripts/build-shop-catalogue.ts at build time from cad’s tree. ' +
    'A design is listed only if THIS reader opens it with zero errors and zero unsupported ' +
    'constructs; what was dropped is listed below and is usually an OpenSCAD feature this ' +
    'subset has not implemented, not a defect in the design. ' +
    'A design is one .scad FILE and may be SEVERAL registered parts (cad, 2026-09-05: normal in ' +
    'their lane, not an edge case), so `partNames` and `describes` are lists and the file path is ' +
    'never a safe key for anything joined per part. `descriptionsWritten` vs `descriptionsShown` ' +
    'is recomputed every build, never snapshotted — several of the unshown parts are nest sheets ' +
    'this reader may gain, so the gap moves on its own.',
  scanned: files.size,
  listed: entries.length,
  dropped: dropped.length,
  droppedReasons: dropped.slice(0, 60),
  /** Listed designs carrying cad's sentence, and those carrying none. An
   *  undescribed card is a VISIBLE gap on purpose — the alternative is a
   *  plausible sentence nobody sourced (see the note above readDescriptions). */
  described: entries.filter((e) => e.describes.length > 0).length,
  undescribed: entries.filter((e) => e.describes.length === 0).length,
  /** Sentences cad wrote that no LISTED card carries — they name a real part,
   *  but one this reader cannot open, so it is dropped and the sentence is
   *  invisible. cad's own guard checks a key names a REGISTERED part; it cannot
   *  see this, because being registered and being renderable are different
   *  facts. Published so the shortfall is measured and not assumed to be zero. */
  descriptionsWritten: DESCRIPTIONS.size,
  descriptionsShown: entries.reduce((n, e) => n + e.describes.length, 0),
  /** The alias check that ran over this artefact, and how big its list was — a
   *  check reporting zero hits from an empty list looks exactly like a clean
   *  page. See the note above readPatentNames. */
  /**
   * 🔴 WITNESSES — every check emits something on SUCCESS that only a run can
   * produce (ceo/cad, 2026-09-06: *"a check whose PASS state produces no
   * artefact cannot prove it ran"*; three lanes hit this independently in one
   * night). Refusing on failure is not enough: empty `PROHIBITED_CLAIMS`, or
   * delete the loop, and this build passes byte-identically with nothing saying
   * the check ever existed.
   *
   * ⚠ `hits` USED TO BE THE LITERAL `0` I typed here. It reported zero whether
   * or not the check ran — a check supplying its own expected value, which is
   * the exact defect a witness is supposed to prevent, sitting inside the field
   * that was meant to be the witness.
   *
   * `linesScanned` is the load-bearing one: a count of lines actually fed to
   * the patterns. A number no static edit can fake, and it collapses to 0 the
   * moment the scan stops happening.
   */
  aliasCheck: {
    forbidden: PATENTS.banned.length,
    accepted: PATENTS.accepted.length,
    hits: offencesFound.filter((o) => o.startsWith('the index note') || o.includes('alias')).length,
  },
  /* ⚠ `linesExpected` is DERIVED, and it replaced a floor I had typed.
   * `cad`, 2026-09-06, measuring their own witness: *a tolerance nobody
   * converted back into a physical quantity is a blind spot sized by whoever
   * typed it* — their asserted `TOL = 0.5` was permitting 67 µm of wood.
   * ⇒ My guard asserted `linesScanned > 10_000` against a real value near
   * 80,000. Arbitrary, and blind in the way that matters: a scan covering ONE
   * FAMILY would clear 10,000 and pass while missing most of the page.
   * `linesExpected` is counted from the BUNDLES ACTUALLY WRITTEN to disk, a
   * different derivation from the counter incremented during the scan, so the
   * guard is an identity between two chains rather than a threshold. */
  claimCheck: {
    patterns: PROHIBITED_CLAIMS.length,
    exemptions: CLAIM_EXEMPT.length,
    linesScanned: claimLinesScanned,
    linesExpected: entries.reduce((n, e) => {
      const b = JSON.parse(readFileSync(join(OUT, 'd', `${e.id}.json`), 'utf8')) as { sources: Record<string, string> };
      return n + Object.values(b.sources).reduce((m, t) => m + t.split('\n').length, 0);
    }, 0),
    hits: claimOffences.length,
  },
  /** The band, published so the number a run measured is recorded rather than
   *  only the constant a human wrote. */
  listedBand: { floor: LISTED_FLOOR, ceiling: LISTED_CEILING, measured: bandable },
  /** ⚠ `descriptionsShown` counts sentences that reached a card. It says
   *  NOTHING about whether they are right — those are independent properties
   *  (ceo 2026-09-05), and closing the 28-vs-17 gap will not report on the
   *  second. Nothing here checks a description against its part. */
  descriptionsVerified: 0,
  /** Designs whose source closure references a PCB marked do-not-fab. Published
   *  because the card offers a design to make and the board under it is one we
   *  have said we will not fabricate — a contradiction that must be VISIBLE
   *  rather than resolved by deletion (ceo 2026-09-05). Counted, not judged:
   *  closure membership is a reference, not a dependency. */
  /* ⚠ COUNTED ON THE WITHHELD, not on the listed. This was `onSupersededBoard`
   * over `entries` until ceo extended the ruling to a refusal — at which point
   * it necessarily read 0, and a zero that is true only because the population
   * was emptied is worse than no number: it says "nothing here is on a
   * do-not-fab board" while meaning "we stopped listing the ones that are". */
  withheldOnSupersededBoard: withheld.filter((w) => w.why.includes('closure references')).length,
  /** Designs held back because part of their source is not committed. Expected
   *  to be NON-ZERO on a shared tree with work in progress — a snapshot of
   *  another lane's uncommitted state, not a defect count. */
  withheldUntracked: withheld.filter((w) => w.why.includes('git does not track')).length,
  supersededBoardsSeen: [...SUPERSEDED_BOARDS.keys()].sort(),
  /** Designs deliberately NOT offered. Published so the narrowing is a decision
   *  someone can see rather than a gap, exactly as `unlistedFamilies` is. */
  withheld,
  /** Openable designs in directories `FAMILIES` does not offer — see its note. */
  unlistedFamilies: [...unlisted].map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count),
  entries,
};
/* The publishing-population sweep. Runs on what was LISTED, so a design `cad`
 * adds tomorrow is caught by the same rule that caught the fit view. */
{
  const unhandled: string[] = [];
  for (const e of index.entries) {
    const src = files.get(e.path) ?? '';
    if (!CANCELLED_CONFIG.test(src) && !CANCELLED_CONFIG.test(e.title)) continue;
    if (CANCELLED_EXEMPT[e.path]) continue;
    unhandled.push(e.path);
  }
  if (unhandled.length > 0) {
    throw new Error(
      `${unhandled.length} LISTED design(s) name the configuration the founder cancelled ` +
        '2026-08-10, and are neither withheld nor exempted. A mention is not an assertion — read ' +
        'each file and either add it to WITHHELD_PATHS or record why it is fine in ' +
        `CANCELLED_EXEMPT with the lines you checked:\n  ${unhandled.join('\n  ')}`,
    );
  }
  /* An exemption for a design that is no longer published is a stale note that
   * reads as diligence, and it would let a future file inherit the entry. */
  const listedPaths = new Set(index.entries.map((e) => e.path));
  for (const p of Object.keys(CANCELLED_EXEMPT)) {
    if (!listedPaths.has(p)) throw new Error(`CANCELLED_EXEMPT has '${p}', which this build did not list`);
  }
}

/* 🔴 CHECKED ON THE ARTEFACT, NOT ON THE INPUTS — the page is what a stranger
 * reads, and it is assembled from three lanes' text (cad's sentences, this
 * file's titles and kinds, FAMILIES' blurbs). Checking any one source would be
 * green about that source. Fails the build: a catalogue is publication. */
{
  const offences = offencesFound;
  for (const e of index.entries) {
    for (const [what, text] of [
      ['title', e.title], ['kind', e.kind], ['family blurb', e.familyBlurb],
      ...e.describes.map((d) => [`description of ${d.part}`, d.text] as [string, string]),
    ] as [string, string][]) {
      for (const a of bannedAliasesIn(text)) offences.push(`${e.path} ${what}: "${a}" — ${text.slice(0, 90)}`);
    }
  }
  for (const a of bannedAliasesIn(index.note)) offences.push(`the index note: "${a}"`);
  for (const c of claimOffences) offences.push(`prohibited claim — ${c}`);
  /* An exemption for a line that is no longer republished is a stale note that
   * reads as diligence, and would silently cover a future line that matched it. */
  for (const e of CLAIM_EXEMPT) {
    if (!entries.some((x) => Object.keys(JSON.parse(readFileSync(join(OUT, 'd', `${x.id}.json`), 'utf8')).sources)
      .some((f) => (files.get(f) ?? '').includes(e.match)))) {
      offences.push(`CLAIM_EXEMPT holds "${e.match}", which nothing this build published`);
    }
  }
  if (offences.length > 0) {
    throw new Error(
      `${offences.length} problem(s) would be PUBLISHED by this catalogue — banned patent ` +
        'aliases (canonical names in legal/canon/facts.yaml) and/or prohibited claims (founder ' +
        'rule 2026-05-26). The text is cad\'s, so it is fixed THERE, not here — but read the ' +
        'line before editing it:\n' +
        '  · a line that ASSERTS the claim is the defect; reword the claim.\n' +
        '  · a line that DISCUSSES the ban — a correction note, a header rule — is EVIDENCE, and ' +
        'deleting it destroys the record of the fix it documents. It still cannot ship verbatim, ' +
        'because this page strips the context that made it safe: reword it to DESCRIBE the ' +
        'phrasing instead of quoting it, as cad already did once in shop_descriptions.yaml.\n  ' +
        offences.join('\n  '),
    );
  }
}
/* 🔴 THE ORDERING GUARANTEE, ASSERTED ON THE FILESYSTEM ITSELF.
 *
 * The withholding decisions now precede the writes, and a test checks the result
 * — but a deploy runs `npm run build`, not the test suite. ceo, 2026-09-06:
 * *safety by absence of capability is not safety, it is an unexercised hazard*,
 * and this lane's orphaned bundles reached nobody only because no publish step
 * exists. That expires on a change nobody would flag as risky: adding a deploy
 * is normal, welcome work, and it would have turned a 12-hour artefact defect
 * into a publication with nothing here objecting.
 *
 * ⇒ So the BUILD refuses. This is an identity between two chains — what the
 * index lists, and what is actually on disk — not a restatement of the rule
 * that was already broken once. ceo's own close on that: *a named shape helps a
 * reader recognise a defect they are already looking at; an identity finds one
 * nobody was looking for.*
 */
{
  const ids = new Set(entries.map((e) => e.id));
  const strays: string[] = [];
  /* ⚠ THE POPULATION IS WALKED, NOT ENUMERATED (ceo, 2026-09-06). This listed
   * `[['d','.json'], ['t','.png']]` while the build CREATES those directories
   * eighty lines away — two lists that must agree, with nothing making them
   * agree. Complete by construction today, and silently partial the day someone
   * adds a third output directory: the new files would belong to no listed
   * design and this check would not look at them.
   * ⇒ Walk `OUT` and derive the id from each file's own name, so the check's
   * population IS the output rather than a copy of it. */
  const walk = (dir: string, prefix: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p, `${prefix}${f}/`); continue; }
      if (prefix === '' && f === 'index.json') continue; // the index is not a per-design artefact
      const stem = f.replace(/\.[^.]+$/, '');
      if (!ids.has(stem)) strays.push(`${prefix}${f}`);
    }
  };
  walk(OUT, '');
  if (strays.length > 0) {
    throw new Error(
      `${strays.length} file(s) in public/shop/ belong to no listed design — whatever they are, ` +
        `they would be served to anyone this output is served to, and no card accounts for them: ` +
        `${strays.slice(0, 6).join(', ')}`,
    );
  }
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(
  `\nscanned ${files.size} .scad · listed ${entries.length} · dropped ${dropped.length}` +
    ` · withheld ${withheld.length} · described ${index.described}/${entries.length}`,
);
if (unlisted.size > 0) {
  console.log(
    `⚠ ${[...unlisted.values()].reduce((a, b) => a + b, 0)} openable design(s) are in directories ` +
      `FAMILIES does not offer: ${[...unlisted.keys()].join(', ')}`,
  );
}
console.log(`-> ${relative(WEB, OUT)}/index.json`);
