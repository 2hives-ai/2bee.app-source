let wasm;

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
/**
 * @returns {string}
 */
export function tools() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.tools();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}
/**
 * 🔴 **N drawings, placed, checked against each other, and posted — or
 * refused.**
 *
 * # The bytes
 *
 * `blobs` is every drawing's file content CONCATENATED, and each descriptor
 * carries its own `byte_len`. The lengths must sum to exactly `blobs.len()`, and
 * a mismatch is **REFUSED** rather than truncated or padded: slicing on from a
 * wrong length hands the parser one file's tail joined to the next file's head,
 * and that composite still parses into *something* — a drawing built from two
 * files, which posts and cuts.
 *
 * A concatenated buffer rather than an array of arrays because this boundary
 * takes `&[u8]` and nothing else; an STL is routinely megabytes and must not be
 * base64'd through a JSON string on every re-plan.
 *
 * # Reading the answer
 *
 * The same [`twobee_cam::fixtures::Report`] every other planning export returns.
 * **`ok: false` means no program**, and `gcode` is empty on every such path —
 * including the overlap refusal, which is the one this export exists for.
 * `refusals` then holds one sentence per condemned pair, naming both parts.
 * @param {string} drawings_json
 * @param {Uint8Array} blobs
 * @param {string} config_json
 * @param {number} sim_cell_mm
 * @param {number | null} [surface_cell_mm]
 * @param {number | null} [mesh_budget_tris]
 * @returns {string}
 */
export function plan_import_many(drawings_json, blobs, config_json, sim_cell_mm, surface_cell_mm, mesh_budget_tris) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(drawings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(blobs, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.plan_import_many(ptr0, len0, ptr1, len1, ptr2, len2, sim_cell_mm, !isLikeNone(surface_cell_mm), isLikeNone(surface_cell_mm) ? 0 : surface_cell_mm, isLikeNone(mesh_budget_tris) ? 0x100000001 : (mesh_budget_tris) >>> 0);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Version of the core and of the G-code contract it emits.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 🔴 **The drawing list's verdicts — usable / invalidates / unknown per
 * drawing, and whether it belongs on the declared workpiece.**
 * `core/src/recommend.rs` decides all of it.
 *
 * The sibling of [`tool_verdicts`], with the same guarantee and the same two
 * arguments' meaning: `config_json` is **the same [`JobConfig`] the browser
 * sends to [`plan`] and [`plan_import_many`]**, so a row saying a drawing
 * belongs here and a planner refusing that drawing cannot be describing two
 * different workpieces. A config that will not parse is REFUSED
 * (`{ ok: false, why }`), never replaced with defaults.
 *
 * `drawings_json` is `VerdictDrawingIn[]`. `"[]"` — or an empty string — is a
 * legitimate answer of **zero rows**: the drawing list exists before a file is
 * dropped, and zero rows is not the same fact as every row being fine.
 *
 * # Reading the answer
 *
 * Each verdict carries **two** answers and they are not interchangeable:
 *
 * * `usability` — `"usable" | "invalidates" | "unknown"`. **This is the red
 *   mark.** `invalidates` means the planner refuses the job because of this
 *   drawing; `why` is the core's sentence and `rules` says which of the four
 *   conditions fired (`identity`, `geometry`, `placement`, `pair-clearance`).
 * * `fit` — `"on-workpiece" | "off-workpiece" | "unknown"`. **This is the
 *   filter, and it is a SEPARATE AXIS.** 🔴 The planner does **not** refuse an
 *   off-workpiece drawing today — it posts, and the cutter goes where the
 *   material is not. Rendering `fit` as an invalidation would claim a refusal
 *   that does not exist.
 *
 * 🔴 `"unknown"` is **not** usable, in either field, and `selected` / `not
 * chosen` are the HOST's own state and are deliberately absent from the
 * payload. Both sentences travel in `caveats`, in the core's words; show them
 * rather than rewriting them.
 * @param {string} config_json
 * @param {string} drawings_json
 * @returns {string}
 */
export function drawing_verdicts(config_json, drawings_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(drawings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.drawing_verdicts(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {string}
 */
export function jobs() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.jobs();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Can this machine hold this workpiece, and if not, would a quarter turn fix it?
 *
 * The UI asks; it does not re-derive. The last time a fit rule was written a
 * second time in TypeScript it was orientation-blind and refused a workpiece that
 * fits turned.
 * @param {number} size_x_mm
 * @param {number} size_y_mm
 * @param {number} rotation_deg
 * @param {number} travel_x_mm
 * @param {number} travel_y_mm
 * @returns {string}
 */
export function stock_fit(size_x_mm, size_y_mm, rotation_deg, travel_x_mm, travel_y_mm) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.stock_fit(size_x_mm, size_y_mm, rotation_deg, travel_x_mm, travel_y_mm);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 🔴 **The UNION extent of everything on the workpiece** — the question a per-pair
 * check cannot ask.
 *
 * `drawings_json` is the same `PlacedDrawingIn[]` [`check_layout`] takes, so a
 * caller sends back exactly what it was given. Nothing is held between calls
 * and there is no layout handle: the caller already knows where its drawings
 * sit, and a second copy on this side of the wire would be a second source of
 * truth about where parts are.
 *
 * # Two extents come back and they are NOT interchangeable
 *
 * * `extent` — the placed GEOMETRY, outer boundaries only, exactly as drawn.
 * * `cut_extent` — that window grown by `tool_radius_mm` on every side: where
 *   the tool CENTRE goes. This is the one to compare against a workpiece when the
 *   outer profile is cut on the outside. Comparing `extent` instead is wrong by
 *   a whole cutter diameter, and wrong in the direction that says a job fits
 *   when it does not.
 *
 * `tool_radius_mm` is a **parameter with no default** — see [`NO_TOOL_RADIUS`].
 * Pass `0.0` deliberately when the coordinates already carry the offset.
 *
 * ⚠ **This does not answer workpiece fit and must not be read as doing so.** It
 * hands back a window; the caller compares it against whichever workpiece it holds.
 * See [`SHEET_FIT_IS_A_DIFFERENT_QUESTION`] — the sheet basis is contested in
 * this repo and belongs to bom + ops, so nothing here picks one.
 *
 * An empty workpiece is a **refusal**, not a zero extent — see [`EMPTY_SHEET`].
 * @param {string} drawings_json
 * @param {number} tool_radius_mm
 * @returns {string}
 */
export function layout_extent(drawings_json, tool_radius_mm) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(drawings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.layout_extent(ptr0, len0, tool_radius_mm);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @returns {string}
 */
export function plants() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.plants();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 🔴 **Does the whole set fit the machine's travel — and if not, what would?**
 *
 * The union extent from [`layout_extent`], handed to
 * `core/src/placement.rs::plan_datum_shift`, which owns this question. Nothing
 * is decided here.
 *
 * # Reading the answer
 *
 * `placement` is a **tagged union on `outcome`**, never a boolean:
 *
 * * `already_inside` — `{ extent }`. The program is inside travel as it stands.
 *   Nothing is offered because there is nothing to offer.
 * * `shift_datum` — `{ dx_mm, dy_mm, current, shifted }`. A datum shift would
 *   put the whole program inside travel. **Offer it; do not apply it** — see
 *   [`SHIFT_IS_OFFERED_NEVER_APPLIED`]. Applying it means adding `dx_mm` to the
 *   workpiece's `origin_x_mm` and `dy_mm` to its `origin_y_mm`, and that is a
 *   decision about the CLAMPS, which no program can see.
 * * `will_not_fit` — `{ current, overhangs }`. One `overhang` per failing axis,
 *   naming the axis and by how much, and **carrying no shift at all**. Both
 *   axes can fail at once and that is two facts, not one. Do not build a shift
 *   out of it — see [`THE_THREE_OUTCOMES_ARE_DIFFERENT_FACTS`].
 *
 * `describe` on the placement is the core's own sentence, worded so a refusal
 * names the axis and the overhang rather than saying "it does not fit", which
 * is not something anyone can act on.
 *
 * ⚠ Travel, not workpiece. The machine reaching every coordinate and the material
 * being big enough are different questions; this answers the first only.
 * @param {string} drawings_json
 * @param {number} tool_radius_mm
 * @param {number} margin_mm
 * @param {number} travel_x_mm
 * @param {number} travel_y_mm
 * @returns {string}
 */
export function plan_placement(drawings_json, tool_radius_mm, margin_mm, travel_x_mm, travel_y_mm) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(drawings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.plan_placement(ptr0, len0, tool_radius_mm, margin_mm, travel_x_mm, travel_y_mm);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 🔴 **The tool list's verdicts — usable / invalidates / unknown per tool, and
 * whether the drawing wants it.** `core/src/recommend.rs` decides all of it.
 *
 * `config_json` is **the same [`JobConfig`] the browser sends to [`plan`] and
 * [`plan_import_many`]** — deliberately the same object, so a row saying a
 * cutter is usable and a planner refusing that cutter cannot be describing two
 * different machines. Send the config you are about to plan with, not a
 * hand-built summary of it.
 *
 * `parts_json` is `DrawingPart[]` — exactly what came back as
 * `Report.drawing`, returned rather than rebuilt. `"[]"` (or an empty string)
 * means **no drawing**, and every `advice` comes back `"unknown"`.
 *
 * # Reading the answer
 *
 * Each verdict carries **two** answers and they are not interchangeable:
 *
 * * `usability` — `"usable" | "invalidates" | "unknown"`. **This is the red
 *   mark.** `invalidates` means the job cannot be cut with this tool; `why` is
 *   the core's sentence and `rules` says which of the four conditions fired
 *   (`tool-definition`, `collet`, `reach`, `spindle-rpm`) — because
 *   "invalidates the job" is not one condition and a red square that will not
 *   say which one cannot be acted on.
 * * `advice` — `"recommended" | "usable" | "not-for-this-job" | "unknown"`.
 *   **This is the filter.** A tool can be perfectly valid and simply not the
 *   best choice.
 *
 * 🔴 `"unknown"` is **not** usable, in either field. It means a rule could not
 * run — no workpiece thickness declared, no material chosen, no collet on the
 * machine — so nothing has vouched for that tool, and the planner may still
 * refuse it. Render it as unjudged. The payload's `caveats` carry this in the
 * core's own words; show them rather than rewriting them.
 *
 * ⚠ Every sentence here is composed in the core. A host renders `why`,
 * `why_advice` and each rule's `why` verbatim; a TypeScript paraphrase of a
 * safety message is a second copy that drifts.
 * @param {string} config_json
 * @param {string} parts_json
 * @returns {string}
 */
export function tool_verdicts(config_json, parts_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(parts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.tool_verdicts(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Plan a job from a drawing the user supplied, as TEXT.
 *
 * `format` is `"dxf"` or `"svg"`. Everything the importer could not read comes
 * back in `notes`, and a drawing that yields nothing cuttable comes back with
 * `ok: false` and a reason — never as an empty program that looks finished.
 *
 * ⚠ Text only. A mesh must go through [`plan_import_bytes`]; an STL forced
 * through here is either rejected or silently corrupted by the UTF-8 decode
 * that happened before it ever reached this function.
 *
 * ⚠ And so there is deliberately **no `mesh_budget_tris` here**. A DXF or an
 * SVG contains no 3D object — that is what the format is, not a gap — so a
 * parameter asking for one would be a setting that can be turned on and does
 * nothing, which reads to the next person as a broken feature. `loaded_mesh`
 * comes back `null` from this export, always.
 * @param {string} text
 * @param {string} format
 * @param {string} config_json
 * @param {number} sim_cell_mm
 * @param {number | null} [surface_cell_mm]
 * @returns {string}
 */
export function plan_import(text, format, config_json, sim_cell_mm, surface_cell_mm) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.plan_import(ptr0, len0, ptr1, len1, ptr2, len2, sim_cell_mm, !isLikeNone(surface_cell_mm), isLikeNone(surface_cell_mm) ? 0 : surface_cell_mm);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * The tool library WITH a fit verdict per tool for this machine's collets.
 *
 * Kept separate from `tools()` rather than replacing it: a caller that has no
 * machine yet still needs the catalogue, and a library that silently reported
 * every tool as unfittable because no collet was declared would be worse than
 * one that does not answer the question at all.
 * @param {number} collet_mm
 * @param {string} spares_json
 * @returns {string}
 */
export function tools_for_machine(collet_mm, spares_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(spares_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tools_for_machine(collet_mm, ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Fingerprint of the `core/src` this wasm was compiled from — 12 hex chars.
 *
 * 🔴 This is the ONE export whose value must NOT be produced here. It is
 * `twobee_cam::BUILD_ID`, baked in at compile time by the core's `build.rs`, so
 * a wasm built from an older core keeps saying the older id no matter how new
 * the page around it is. Gate K3 compares it against `2bee-slice buildid`.
 *
 * Prints bare, with nothing wrapped around it: the gate compares strings, and a
 * JSON envelope invites a future "helpful" field that changes the comparison.
 * @returns {string}
 */
export function build_id() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.build_id();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Plan a job from a FILE the user dropped in — the bytes, exactly as read.
 *
 * 🔴 **Bytes, not a string, and this is the export a drop-zone should call.**
 * A binary STL is a header plus 50 bytes per triangle of little-endian float.
 * Reading it as text in JS (`FileReader.readAsText`, `Response.text()`) decodes
 * it as UTF-8 and **replaces every byte that does not decode with U+FFFD** — no
 * error, no exception, a string that arrives here looking like a file. The
 * facets it destroyed come back as a mesh with holes, which sections into an
 * outline with a side missing, and that still looks like a part. Use
 * `readAsArrayBuffer` / `new Uint8Array(await file.arrayBuffer())`.
 *
 * `format` is `"dxf" | "svg" | "stl" | "auto"`; `"auto"` decides by content and
 * is what a drop-zone wants, since the user's filename is not evidence.
 *
 * `z_section_mm` applies to a MESH only. 🔴 An STL is a 3D triangle mesh and
 * this core is 2.5D profile/pocket CAM: it can only enter as ONE FLAT SECTION
 * at a single Z, which is **not 3D surfacing** and never will be here. Pass
 * `undefined` and the core sections at the mesh's mid-height and puts that fact
 * in `notes` — the UI must render those notes, because a user who believes they
 * got 3D machining and got a slice will cut a plausible-looking wrong part and
 * nothing downstream can tell.
 *
 * # `mesh_budget_tris` — the LOADED MODEL, and why it is opt-in
 *
 * Pass `undefined` (or omit it) and `loaded_mesh` comes back `null`. Pass a
 * triangle count and the report carries the imported solid's triangles — at
 * most that many — as base64 `f32`, for drawing.
 *
 * 🔴 Opt-in because an STL of a real part is routinely 100k+ triangles, which
 * is **4.8MB of base64 on every call**. Nothing shared, nothing indexed: an STL
 * has no topology, so it is 36 raw bytes of vertex per triangle. Ask when
 * something is about to draw it, at a budget that thing can afford, and decline
 * the rest of the time.
 *
 * 🔴 And say the right thing about it. What comes back is **the model as
 * loaded — the INPUT**. It is NOT what the machine will make: the machine cuts
 * the flat section at `loaded_mesh.section_z_mm`, one outline through that
 * solid. A viewer shown a 3D object assumes the machine produces it, and a
 * picture asserts that far more strongly than a note can withdraw it.
 * @param {Uint8Array} data
 * @param {string} format
 * @param {number | null | undefined} z_section_mm
 * @param {string} config_json
 * @param {number} sim_cell_mm
 * @param {number | null} [surface_cell_mm]
 * @param {number | null} [mesh_budget_tris]
 * @returns {string}
 */
export function plan_import_bytes(data, format, z_section_mm, config_json, sim_cell_mm, surface_cell_mm, mesh_budget_tris) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.plan_import_bytes(ptr0, len0, ptr1, len1, !isLikeNone(z_section_mm), isLikeNone(z_section_mm) ? 0 : z_section_mm, ptr2, len2, sim_cell_mm, !isLikeNone(surface_cell_mm), isLikeNone(surface_cell_mm) ? 0 : surface_cell_mm, isLikeNone(mesh_budget_tris) ? 0x100000001 : (mesh_budget_tris) >>> 0);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * How much clear material two parts must have between them, for this cutter.
 *
 * 🔴 **Returns the refusal, never a fallback number.** A clearance that cannot
 * be built is `{ ok: false, why }` with no `required_mm` at all — a check that
 * cannot run is not a check that passed, and a caller reading a plausible
 * number off a failed call would place parts against it.
 *
 * This is the export that exists so nobody adds a cutter diameter to a margin
 * in TypeScript. The sum is [`Clearance::required_mm`]'s, in the core, where
 * the gates can see it.
 * @param {number} cutter_diameter_mm
 * @param {number} margin_mm
 * @returns {string}
 */
export function clearance_for(cutter_diameter_mm, margin_mm) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.clearance_for(cutter_diameter_mm, margin_mm);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 🔴 **The check.** Every pair of parts on the workpiece, against every other.
 *
 * `drawings_json` is an array of [`PlacedDrawingIn`] — id, position, rotation,
 * and the parts as [`DrawingPart`], which is what `Report.drawing` already
 * hands out. There is no layout OBJECT on this boundary and no handle to keep:
 * the caller already knows where its drawings are, and a second copy of that
 * on the far side of the wire would be a second source of truth about where
 * parts sit.
 *
 * # Reading the answer
 *
 * * `ok: false` — the check **did not run**. Nothing was examined.
 * * `ok: true, clear: true` — every pair was examined and every pair is clear.
 *   An empty `findings` array is the only clear result.
 * * `ok: true, clear: false` — `findings` holds one entry per condemned pair.
 *
 * Each finding carries its own numbers and a `finding` tag which is one of:
 *
 * * `overlap` — the parts share material. **Fix: re-nest.** Also carries
 *   `false_red_note`; see [`OUTER_BOUNDARY_ONLY`].
 * * `too_close` — they share no material but the channel between them is
 *   narrower than the tool. **Fix: nudge them apart.** A different failure with
 *   a different fix, which is why it is a different tag and never a shared
 *   "collision" flag.
 * * `not_checked` — the pair could not be examined. **This is a REFUSAL, not a
 *   warning.** An unchecked pair is not a clear pair.
 *
 * `describe` on each finding is the core's own sentence, which is worded so an
 * overlap can never read as a spacing problem. Render the numbers; use the
 * sentence when a sentence is wanted, rather than composing one here.
 * @param {string} drawings_json
 * @param {number} cutter_diameter_mm
 * @param {number} margin_mm
 * @returns {string}
 */
export function check_layout(drawings_json, cutter_diameter_mm, margin_mm) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(drawings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.check_layout(ptr0, len0, cutter_diameter_mm, margin_mm);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Plan a job and return the full report as JSON.
 *
 * Errors are RETURNED as JSON with `ok: false`, never thrown: a UI that has to
 * catch to find out a program was refused will eventually forget to catch, and
 * the refusal becomes invisible.
 *
 * # `surface_cell_mm` — the simulated stock surface, and why it is opt-in
 *
 * Pass `undefined` (or omit it) and `simulated_stock_surface` comes back
 * `null`. Pass a millimetre value and the report carries the machined surface
 * as a base64 `f32` height map resampled to about that display cell.
 *
 * 🔴 It is opt-in because the honest size is punishing: at the default 0.6mm
 * simulation cell a 600x900 workpiece is 1,001 x 1,501 samples — **8.0MB of base64
 * on every single call**. A panel that re-plans while a slider moves would send
 * that on every frame. Ask for it when something is going to draw it, at a cell
 * that thing can afford (3mm on that workpiece is ~322KB), and decline it the rest
 * of the time.
 *
 * 🔴 And name it correctly downstream. What comes back is the **simulated stock
 * surface**, not the part: it cannot see a feature narrower than one cell, and
 * on a through-cut it shows removed material without knowing which side of the
 * cut is the part and which is the offcut.
 * @param {string} job
 * @param {string} plant
 * @param {string} config_json
 * @param {number} sim_cell_mm
 * @param {number | null} [surface_cell_mm]
 * @returns {string}
 */
export function plan(job, plant, config_json, sim_cell_mm, surface_cell_mm) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(job, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(plant, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.plan(ptr0, len0, ptr1, len1, ptr2, len2, sim_cell_mm, !isLikeNone(surface_cell_mm), isLikeNone(surface_cell_mm) ? 0 : surface_cell_mm);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * The sourced spoilboard catalogue, for a host that has to draw a picker.
 *
 * 🔴 IT IS THE CORE'S LIST OR IT IS A SECOND LIST. `core/src/spoilboards.rs`
 * says so in as many words: *"a catalogue re-typed in TypeScript is a second
 * list that can drift, and the drift would be invisible: both sides would
 * render confidently and only the machine would disagree"*. Every entry
 * carries its `source` and the date it was read, so a picker can show WHERE a
 * number came from rather than only how big it is — which is the difference
 * between a measured board and an invented one.
 *
 * ⚠ The payload's `default_id` is `null` **on purpose**, and a host must not
 * improve on that. Nothing here ranks the entries and `[0]` is not a
 * recommendation; an over-declared board reports the machine's own frame as
 * sacrificial material, so the operator picks the board they own.
 * @returns {string}
 */
export function spoilboards() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.spoilboards();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('twobee_cam_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
