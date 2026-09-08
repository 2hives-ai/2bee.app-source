import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SAMPLES, MESH_SAMPLES } from './samples';
import ObjectPicker, {
  labelRepeatsHeading,
  type ObjectItem,
  type ObjectProperty,
  type RowClaim,
} from './ObjectPicker';
import ToolShape, { describeToolShape } from './toolShape';
/* The one resize in this app — see `resizable.tsx`'s header for why there is
 * exactly one and what a caller has to do to adopt it. */
import { useResizable } from './resizable';
/* Which SAVED row is ticked — Machine and Workpiece both, and why that is a rule
 * with its own file rather than an expression in the JSX. It was
 * `machineSelection.ts` for exactly one commit; the workpiece picker carried the
 * identical defect, so the second caller is what renamed it. See its header. */
import { selectedIdsWithLoaded } from './savedSelection';
/* An answer is only an answer to the question it was asked. The core's tool and
 * drawing verdicts arrive asynchronously and are FILTERED ON, so a reply held
 * across a setup change is a confident wrong answer rather than a blank one. */
import { answerFor, type Answered } from './askedFor';
/* 🔴 THE RESEARCHED CATALOGUES, REACHED FOR THE FIRST TIME (TODO #34/#35/#40/#45).
 *
 * Measured 2026-08-09 before this change: `grep -rn` across `web/src` found NO
 * importer for `materials.ts`, `workholding.ts`, `touchplates.ts` or
 * `MESH_SAMPLES` — 19 sourced work-holding entries, 20 sheet sizes, 13 touch
 * plates and 4 STL samples, every one of them written, dated, sourced, and
 * unreachable from the product. `App.tsx` shipped three INVENTED clamp
 * arrangements and three inline sheet numbers instead.
 *
 * That is this lane's own "control with no consumer" shape pointing at itself:
 * the code reads as a shipped feature in every audit that greps for the file and
 * in none that asks whether a user can get to it. The two shape modules
 * (`workholdingShape`, `touchplateShape`) were unreachable for the same reason —
 * they draw the catalogue entries, and nothing drew the catalogue.
 */
import { SHEET_SIZES } from './materials';
/* 🔴 ONE ANSWER TO "WHAT MATERIAL IS THIS JOB PLANNED AGAINST" — TODO, founder
 * 2026-08-11: *"move the material into the workpiece list, able to filter
 * workpiece by material via a drop down"*. `jobMaterial.ts` owns every rule;
 * this file asks it and renders what comes back.
 *
 * ⚠ IT IS NOT COSMETIC. `core/src/tools.rs` derives the chipload — and therefore
 * the feed the emitted program carries — from the material, so a workpiece whose
 * recorded material disagrees with the material the job is planned against is
 * two sources of truth for a number that reaches the spindle. That divergence is
 * SURFACED and never resolved here: choosing one would be deciding which of two
 * numbers on screen is a lie. */
import {
  checkMaterialAgreement,
  facetMatches,
  materialFacetOptions,
  materialOfSheet,
  materialOfWorkpiece,
  NOT_STATED_WHY,
} from './jobMaterial';
import { WORKHOLDING } from './workholding';
/* ⚠ `PROJECTION_LABEL` IS NO LONGER IMPORTED — TODO #108. It named the two chips
 * in the sidebar panel that the View menu replaced, in lower case ("these are
 * chips, not sentences"), and a menu item is a sentence. The constant is left
 * where it is rather than deleted from another concern's module while this
 * change is in flight; that it now has no consumer in this file is said here so
 * the next reader does not conclude the menu is driving something it is not. */
import { type Projection } from './projection';
/* 🔴 A SECOND MENUBAR IMPLEMENTATION, DECLARED AS ONE — TODO #108. The CAD tab's
 * `cad/menu.tsx` holds the same WAI-ARIA pattern; it is another lane's file and
 * its `aria-label` is hard-coded to that tab's name, so importing it would give
 * this tab a bar a screen reader announces as the CAD one. The header of
 * `cncMenu.tsx` states the merge condition — a `label` prop over there — so this
 * does not sit as an undeclared fork. */
import { CNC_MENU_ABSENT, cncMenus, MenuBar } from './cncMenu';
/* 🔴 DISPLAY ONLY — TODO #109. Millimetres are canonical everywhere in this file
 * and in everything it sends: `unit` is never in the config object, never in
 * `SessionValues`, never in a job file, and `G20` is emitted by nothing. The
 * three functions below are the whole contact surface — `formatLength` for a
 * readout, `toDisplay`/`fromDisplay` for the two ends of an input box — and
 * `units.ts` explains why the second of those is called on exactly one event. */
import {
  displayStep,
  formatLength,
  formatLengthPair,
  formatLengthTriple,
  fromDisplay,
  INCH_DISPLAY_NOTE,
  toDisplay,
  UNIT_SYMBOL,
  type Unit,
} from './units';
import { TOUCH_PLATES, plateProvenance } from './touchplates';
import { WorkholdingShape } from './workholdingShape';
import { TouchPlateShape } from './touchplateShape';
import {
  save as saveItem,
  saveCadModel,
  list as listSaved,
  load as loadSaved,
  remove as removeItem,
  readSession,
  writeSession,
  clearSession,
  validateLibraryBound,
  /* 🔴 TODO #88 — the travel-fingerprint guard, which had been written and left
   * with ZERO production callers. Both doors into the defect go through these:
   * `readSessionSpoilboard` on the way back from storage, `spoilboardForMachine`
   * when the machine underneath a declared board changes. */
  readSessionSpoilboard,
  spoilboardForMachine,
  SESSION_VERSION,
  /* TODO #108 — the job file. `encodeJob` PICKS its fields rather than spreading
   * what it is handed, which is what makes the bound a property of the code
   * rather than a promise; `parseJobFile` refuses BEFORE anything is replaced. */
  encodeJob,
  hasStoredSession,
  installJob,
  parseJobFile,
  JOB_NOT_SAVED,
  SESSION_KEYS,
  type Collection,
  type SavedItem,
  type DroppedField,
  type DrawingOrigin,
  type SessionValues,
  type SavedSpoilboard,
} from './store';
import {
  fmtDuration,
  listJobs,
  planImportMany,
  listPlants,
  plan,
  planPlacement,
  clearanceFor,
  spoilboardCatalogue,
  toolLibraryFor,
  toolVerdicts,
  drawingVerdicts,
  splitDrawingParts,
  stockFit,
  version,
  type ClampCfg,
  type DrawingVerdict,
  type DrawingVerdictsResult,
  type JobConfig,
  type MaterialRow,
  type Report,
  type SimCounts,
  type SpoilboardCfg,
  type ToolRow,
  type ToolVerdict,
  type ToolVerdictsResult,
} from './cam';
/* 🔴 THE OWNERSHIP LAYER — TODO #83, founder 2026-08-11: *"in machine,
 * spoilboard, Work Holding, Tooling I should able to select what I have in
 * inventory"*. `inventory.ts` owns every rule; this file only asks it, and asks
 * it once per picker.
 *
 * ⚠ IT SITS ON TOP OF THE CATALOGUE AND REPLACES NOTHING. The shipped catalogue
 * still decides what EXISTS; this decides what this shop HAS, and the two
 * answers are rendered as two tags on one row rather than merged into one word.
 * `SHIPPED` is gone from these four pickers for that reason and not for room:
 * `ORIGIN_TAG.catalogue` is the same claim in the vocabulary the ownership
 * verdict is written in, and printing both gave `SHIPPED · OWNED · CATALOGUE` —
 * one fact, twice, in two vocabularies. */
import {
  addOperatorEntry,
  applyImport,
  EMPTY_INVENTORY,
  KIND_LABEL,
  mergeInventory,
  parseInventoryFile,
  readInventory,
  removeEntry,
  resolveSelection,
  writeInventory,
  type CatalogueRow,
  type InventoryKind,
  type InventoryRow,
  type InventoryView,
  type OwnedEntry,
} from './inventory';
/* 🔴 THE WRITE HALF — TODO #105. `inventory.ts` was wired into all four pickers
 * and could only ever be READ: ownership arrived from a file or not at all, so
 * every row said OWNERSHIP UNCHECKED permanently. `ownership.ts` is the control's
 * vocabulary — which of the four verdicts an operator may assert, what the press
 * does to the REST of the list, and the three sentences that are not the same
 * question for all four kinds. It computes nothing about the shop; it says what
 * the model can and cannot record. */
import {
  firstMarkConsequence,
  KIND_NOTE,
  lastUnmarkConsequence,
  NOT_HELD_AND_THE_PLAN,
  machineCountNote,
  ownershipChoices,
  type OwnershipWrite,
} from './ownership';
import {
  Viewport,
  LAYER_LABEL,
  LAYER_SECTION,
  layerTitle,
  liveLayersOf,
  swatch,
  type Layer,
  type LayerScene,
} from './Viewport';
/* THE TABS — founder 2026-08-11, TODO #76. `Tabs.tsx` holds the order, the
 * default, the ARIA wiring and (the part that matters) the rule that an inactive
 * panel is HIDDEN rather than unmounted, so a tab switch cannot reset the
 * machine, the sheet, the placements or the report on this one. Read its header
 * before changing anything about how these three are mounted. */
import {
  TabBar,
  TabPanel,
  readStoredTab,
  rememberTab,
  type TabId,
} from './Tabs';
import CadTab from './cad/CadTab';
import ShopTab from './shop/ShopTab';
import RunTab from './RunTab';
/* 🔴 THE HANDOFF — the CNC tab's emitted program, reaching the Run tab.
 *
 * `RunTab` has taken a `program` prop since it was written and this file
 * rendered it BARE, so its canvas, its line count and its remaining-time
 * estimate had no input at all in the product. The derivation and — the part
 * that matters — the rule about WHEN what the Run tab holds may change live in
 * `runProgram.ts`, not here: this file cannot be imported in node (the loader
 * stops at the sample asset imports), so a rule written inline is a rule no test
 * can watch fail. Read that file's header before changing any of this. */
import {
  heldProgramVerdict,
  programForRunTab,
  runProgramFromReport,
  WHY_FROZEN,
} from './runProgram';
/* The CAD side of the drawings list. A model designed in `2bee.cad` is saved
 * into the SAME collection this tab reads (founder 2026-08-10), so a saved
 * drawing may carry a `cad` payload — the source it was drawn from, the audit
 * verdict, and what was refused. These four functions are how this file reads
 * one without re-deriving any of it. See `cad/record.ts`. */
import {
  cadRowDetail,
  describeCadRecord,
  isCadRecord,
  verifyCadRecord,
  type CadPayload,
} from './cad/record';

const MACHINE_PRESETS = [
  { name: 'Bellwether Lead 1250x670', travel_x_mm: 1250, travel_y_mm: 670, travel_z_mm: 100 },
  // Founder, 2026-08-10: *"make the 6090 travel Z to 200mm"* — his machine, his
  // declaration. ⚠ It is a machine LIMIT, not a label: it feeds the Z-travel
  // check, so raising it makes this machine ACCEPT programs it used to refuse.
  // That is the permissive direction — it cannot manufacture a false red, but it
  // can remove a true one, so the check was measured rather than assumed.
  // Through the CLI (`report plate --config '{"machine":{"travel_z_mm":N}}'`,
  // deepest measured move Z-18): N=17 -> `ok:false`, *"move outside Z travel:
  // -18 (allowed -17 .. 5)"*; N=18, 100 and 200 -> `ok:true`. So the number IS
  // read and IS the limit, and 100 -> 200 removes no refusal any program of this
  // shape was getting — it only raises the ceiling for deeper ones.
  { name: 'MakerSpace 6090', travel_x_mm: 600, travel_y_mm: 900, travel_z_mm: 200 },
  { name: 'Desktop 3018', travel_x_mm: 300, travel_y_mm: 180, travel_z_mm: 45 },
];

/**
 * The picker row that means **a board this lane has never seen**, measured by
 * the shop.
 *
 * 🔴 It is NOT a catalogue id and must never be sent as one — `catalogue_id` and
 * `size_*` are mutually exclusive in the core, and declaring both installs
 * NOTHING. The prefix is deliberately unlike an id so a stray one shows up as
 * the core's "not in the catalogue" refusal rather than resolving to a board.
 */
// SPOILBOARD_CUSTOM, SPOILBOARD_SAVED_PREFIX imported from ./panels/spoilboardHelpers

/**
 * The picker-id prefix for **a board this shop saved** — TODO #104.
 *
 * 🔴 A SAVED BOARD IS A MEASURED BOARD WITH A NAME ON IT, and that is the whole
 * design. Selecting one does not open a second declaration path: it fills the
 * SAME `spoilboardSizeX` / `SizeY` / `Thickness` / `Name` state the
 * `SPOILBOARD_CUSTOM` row already writes, so every rule already built on those
 * fields — the size-edit re-fit that only moves an ASSUMED corner, the
 * `unparseable` report, the measured branch of `spoilboardCfg`, the reach
 * verdict — applies to it without being written a second time. A parallel
 * "saved board" path would be a second set of the same rules, and the two would
 * agree only until one of them was edited.
 *
 * 🔴 Like `SPOILBOARD_CUSTOM`, it is NOT a catalogue id and must never be sent
 * as one. `isMeasuredBoardId` is the one place that decides, so a new sentinel
 * cannot be added in one branch and forgotten in the other four.
 */
// SPOILBOARD_SAVED_PREFIX imported from ./panels/spoilboardHelpers

/** Is this picker id one of the two forms the operator states the size for? */
// isMeasuredBoardId, savedBoardName, SPOILBOARD_CUSTOM, SPOILBOARD_SAVED_PREFIX
// imported from ./panels/spoilboardHelpers

/* ═══ WHAT THIS TAB IS, AND WHAT IT HAS NEVER DONE — TODO #107 ══════════════
 *
 * 🔴 THE CNC TAB IS THE ONE THAT EMITS G-CODE AND IT CARRIED NEITHER HALF OF
 * THIS. The CAD tab has `Help → About` with its `OMISSIONS`/`GAPS` lists; the
 * Run tab opens with a red `run-unproven` banner. The tab in between — the one
 * that produces the file a spindle is handed — said nothing about what it has
 * never done, and `AGENTS.md` puts the never-cut statement *where a reader forms
 * an expectation about the machine*. That is here.
 *
 * ⚠ EVERY LINE IS A CAPABILITY STATEMENT CHECKED AT THE CODE, and the list is
 * short because of it. Three defects on 2026-08-11 came out of an omission list
 * that had drifted away from what it described, so the standard for an entry
 * here is a file and a symbol somebody read, not a recollection:
 *
 *   · never cut          `AGENTS.md` Scope 🔴, and `RunTab`'s own banner: the
 *                        router is ordered and has not arrived.
 *   · CNC only           `core/src/tech.rs` — `implemented()` is
 *                        `matches!(self, Self::Cnc)`, so `Technology::Fdm`
 *                        reports false everywhere it is asked.
 *   · no cutter comp     `core/src/types.rs:1108` — `supports_cutter_comp:
 *                        false` in the machine default, and `post.rs`'s note
 *                        that grblHAL core has no `G41`/`G42`.
 *   · STL is a SECTION   `core/src/mesh.rs::section(mesh, z_mm, tol)` — one
 *                        flat outline at one Z, handed to the 2.5D operations.
 *   · picture ≠ program  `ViewportProps.layers` / `.projection` are documented
 *                        drawing-only and are not in `plan()`'s inputs.
 *   · licence            `web/package.json` `"license": "AGPL-3.0-or-later"`,
 *                        and `LICENSE` is the AGPLv3 text.
 *
 * 🔴 THE §13 LINE ERRS TOWARD UNDER-CLAIMING COMPLIANCE, ON PURPOSE. This build
 * has no network and cannot re-measure the footer link; `AGENTS.md` records it
 * as a 404 against a control, and the one repository holding this source is
 * private. Writing *"the offer is the link below"* would be this panel vouching
 * for a URL nothing here checked — and a link that reads as compliant and
 * delivers nothing is worse than one that visibly does not resolve. So the line
 * states the entitlement, states that it is NOT discharged, and leaves the fix
 * (publishing the Corresponding Source) where `AGENTS.md` puts it: with
 * `legal`, not with a plausible string typed in here.
 */
const CNC_NEVER_CUT =
  'Nothing this app has emitted has ever cut anything. No output has been run on a real ' +
  'controller, and the air-cut → foam/MDF coupon → real ply rungs are unclimbed.';

const CNC_ABOUT_LINES: readonly string[] = [
  'Browser-first CAM for CNC routers: the same Rust core runs here (as WebAssembly), in the ' +
    'command-line harness and in the gates, so what is checked is what you download.',
  'SUBTRACTIVE CNC ONLY. There is no slicer, layer model, extrusion width, retraction, cooling ' +
    'or support generation — the other process reports itself unimplemented everywhere the core ' +
    'asks, rather than half-working.',
  'ONE POST: grblHAL. Cutter compensation is NEVER emitted — grblHAL core has no G41/G42, so ' +
    'every tool-radius offset is applied here, in the path, before the file is written. There is ' +
    'no toggle for it, because there is nothing behind the toggle.',
  'AN STL IS SECTIONED AT ONE Z. You get a single flat outline through the solid, handed to the ' +
    'same 2.5D operations a drawing gets — not the 3D shape you modelled. There is no Z-level ' +
    'roughing, no waterline, no scallop and no ball-nose stepover, and a section posts, ' +
    'simulates and gates green while cutting a plausible-looking wrong part.',
  'THE PICTURE IS NOT THE PROGRAM. The layer eyes, the perspective/orthographic switch and the ' +
    'playback scrubber change what is on screen and nothing else: not the plan, not the checks, ' +
    'not the G-code. Hiding a move does not remove it.',
  'A CHECK THAT COULD NOT RUN REPORTS PENDING, AND PENDING IS NOT A PASS. An undeclared ' +
    'spoilboard thickness, an undeclared clamp and an unmeasured board position each leave a ' +
    'question unanswered rather than answering it favourably.',
  'AGPL-3.0-or-later. If you were served this page over a network, section 13 entitles you to ' +
    'its Corresponding Source — and that offer is NOT DISCHARGED today: the repository the ' +
    'footer link names is not published, so there is no public URL that serves it. That is ' +
    'stated rather than papered over with a plausible link.',
];

/**
 * **Can this board be positioned to cover everything the cutter can reach?**
 *
 * 🔴 READ THE NAME. It is not *"does this board fit this machine"*, and it is
 * not *"is this board the right one"* — **neither of those is answerable from
 * anything this tool models.** A spoilboard is bolted to a TABLE, and
 * `Machine` carries `travel_x_mm` / `travel_y_mm` and **no table, frame or
 * rail dimension at all**. So the frame question is `UNKNOWN` here, always,
 * and it is reported as UNKNOWN rather than guessed. Inventing a frame size to
 * make a picker tidier would be exactly the defect `core/src/spoilboards.rs`'s
 * own header exists to prevent: a plausible number that RUNS.
 *
 * What IS derivable, from the travel envelope alone and with no position:
 *
 * * `size >= travel` on **both** axes ⇒ a position exists that covers the whole
 *   reach. Which position is still the operator's fact.
 * * `size < travel` on **either** axis ⇒ **no** position covers the whole
 *   reach. Some reachable XY has no declared sacrificial material under it, by
 *   construction, wherever the board is bolted.
 *
 * ⚠ The entry is tested **as stated**, and `Spoilboard` has no rotation field —
 * *"square to the machine, deliberately"*. A 1200x600 panel turned on its side
 * would cover a 600x900 reach and this function says it cannot, because the
 * model cannot express the turn. That is a **false red**, and it is the
 * direction to be wrong in: over-declaring reaches the machine, under-declaring
 * costs a warning. Stated rather than silently rounded.
 */
// spoilboardReachVerdict, fitSpoilboard, ReachVerdict, SpoilboardFit
// imported from ./panels/spoilboardHelpers

// The collets a small shop owns beyond the one in the spindle. Mirrors the
// core's reference machine; a tool needing one of these is SELECTABLE and says
// which collet to fit, because a router tool change is routinely a collet
// change too.
const SPARE_COLLETS_MM = [3.175, 6.35, 8.0];

/* 🔴 THE THREE INLINE SHEET NUMBERS ARE GONE — they are `materials.ts` now.
 *
 * What stood here was `[{600 x 900}, {2400 x 1200}, {2700 x 1200}]`: the three
 * CONTESTED figures (`cnc_nest` 2700x1200, ops 600x900, bom's 2026-07-18
 * correction 2400x1200), typed into this file with no source and no date. All
 * three survive in `SHEET_SIZES` **with the supplier page each was read from and
 * the date it was read**, alongside 17 others, and the contest is preserved
 * rather than resolved — `ply-au-2400x1200` and `ply-au-2700x1200` both carry a
 * primary source saying both lengths are genuinely stocked. Settling that is
 * `bom` + `ops`, not this lane.
 *
 * ⚠ NO DEFAULT CHANGED. The app still opens on a 600 x 900 workpiece, because
 * that is `stockX`/`stockY` initial state and this pass did not touch it. What
 * changed is only which catalogue row the picker HIGHLIGHTS as matching it —
 * `ply-au-handy-900x600`, which is ops' figure and says so in its own `detail`.
 */

/* ✅ A HAND-COPIED TOOL-CHANGE CONSTANT STOOD HERE AND IS DELETED (item `#90`).
 * It was named `TOOL_CHANGE_SECONDS` and held sixty.
 *
 * It said of itself: *"THIS IS A COPY OF A CORE CONSTANT … it is a copy only
 * because the core does not put it on the wire … the real fix is a field on
 * `Report`."* The core put it on the wire — `Report.tool_change_seconds` plus
 * `Report.tool_change_rate_declared` — so the fix is the DELETION, not a
 * re-sync to a newer literal.
 *
 * 🔴 It was also WRONG by the time it was read: the core charges a declared
 * rate defaulting to **120**, and this file charged **60**, so the playback
 * clock under-read by a minute per tool change against the estimate printed
 * beside it. The bar's "difference between the playback clock and the estimate"
 * line was supposed to make that visible; it made it visible as *seconds not in
 * the animation*, which is the label for the `G4` dwell and the `G38.2` probe —
 * a real drift wearing an expected one's name.
 *
 * The rate now comes off the report, and **absence is `?? 0` and never a
 * fallback number** — see `timeline` below and `Report.tool_change_seconds` in
 * `cam.ts`. This note stays because a deleted copy leaves no grep hit, and the
 * next person to want a plausible constant here should meet the argument
 * against it rather than the empty space where it was.
 */

/**
 * How the core opens each of its own run-time notes. Used to pull those notes up
 * NEXT TO the number they qualify, verbatim, instead of re-deriving the caveat
 * here.
 *
 * 🔴 Prose matching, and the reason it is tolerable HERE and nowhere else: this
 * is a DISPLAY ROUTE, not a check. If the core rewords a note the match fails,
 * the bar says so out loud, and the note still renders unchanged in *Notes and
 * warnings* — the worst case is a lost duplicate, never a wrong number and never
 * a silent one. It exists because `job::EstimateBasis` — which carries this
 * program's own exposure as DATA (`short_moves`, `motion_blocks`, `unread`,
 * `blind_spots`) — is not `Serialize` and is not a field on `Report`, so those
 * numbers reach the browser only inside these sentences.
 */
const ESTIMATE_NOTE_PREFIXES = [
  'the run time is an ESTIMATE',
  'run time excludes motion the program does not spell out',
  'the run-time estimator did not understand part of the emitted program',
];

const PLAYBACK_SPEEDS = [1, 2, 5, 10];

/**
 * Ceiling on how often playback writes `progress`, in Hz.
 *
 * 🔴 A BOUND ON A KNOWN COST, and it is deliberately NOT described as a
 * measured optimisation, because it is not one.
 *
 * The cost is real and structural, not a guess: `Viewport` rebuilds its ENTIRE
 * scene whenever `progress` changes (`props.progress` is in that effect's
 * dependency list). Without a ceiling the write rate is bounded only by rAF, so
 * a long program at x10 asks for up to 60 full scene rebuilds a second.
 *
 * ⚠ WHAT WAS MEASURED, and what was not. Whole-program runs of the `plate`
 * fixture against the production build gave wall/expected ratios of 0.99–1.07
 * at x1, x2, x5 and x10. But an interleaved A/B of capped-at-20 against
 * effectively-uncapped, three rounds at x10, produced **no difference
 * attributable to this constant** — the spread tracked the box's load average
 * (4.2, a shared machine running other agents) and inverted between rounds. So:
 * the ceiling bounds a worst case that exists in the code; it has NOT been shown
 * to buy anything on a contended box, and this comment does not pretend it has.
 * Anyone tuning it should A/B it on a quiet machine, not read a number here.
 *
 * The clock itself cannot drift either way: it integrates real elapsed time from
 * `performance.now()`, so a starved frame makes the playhead coarse, never the
 * duration wrong.
 */
const PROGRESS_HZ = 20;

/**
 * The stored setup, read ONCE per page load.
 *
 * 🔴 Module scope, and synchronously, for two reasons that are both about what
 * the operator SEES. First, every `useState` initialiser below reads from this
 * one object, so no two fields can disagree about which session they came from.
 * Second, it is available before the first paint — an asynchronous restore would
 * render the defaults and replace them a tick later, and a machining panel that
 * shows `4 mm` and then flips to `12 mm` has shown a number that was never
 * anybody's setting.
 *
 * ⚠ `RESTORED.values` holds ONLY the fields that PASSED validation. `?? default`
 * below is therefore not a fallback that hides a failure: a key missing from it
 * was either never stored or was dropped and is NAMED in the banner. There is no
 * third case where a value is quietly substituted, and there must never be one.
 *
 * `material` and `toolIds` are deliberately absent from `values` — they can only
 * be checked against the tool library, which the core delivers asynchronously.
 * They are restored inside the load effect, BEFORE `ready`, so no unvalidated
 * tool id ever reaches the planner. See `validateLibraryBound`.
 */
const RESTORED = readSession();
const R = RESTORED.status === 'ok' ? RESTORED.values : {};

/**
 * The travels this app opens on when the session has none.
 *
 * 🔴 ONE ARRAY, because two places need the same three numbers and they must not
 * be able to disagree: the `useState` initialisers below, and
 * {@link SPOILBOARD_RESTORE}, which asks whether the board's corner was measured
 * on THESE travels. A second copy of `600 / 900 / 100` typed out beside the
 * restore would make the fingerprint compare against a machine the panel is not
 * showing — a guard that is exactly wrong in the case it exists for.
 */
const DEFAULT_TRAVEL_MM: [number, number, number] = [600, 900, 100];

/**
 * 🔴 THE SPOILBOARD, RECONCILED WITH THE TRAVELS THAT WILL ACTUALLY BE IN EFFECT
 * — TODO #88's second door, closed with the same call as the first.
 *
 * The stored corner is a MACHINE coordinate: it means *"this corner, measured
 * from THIS machine's datum"*. In the ordinary case the travels come back too,
 * they match, and the corner survives with a provenance line. The case worth
 * catching is the one where they come apart — a travel that failed its own rule
 * and was defaulted, or a session written before the fingerprint existed — and
 * then the corner is dropped BY NAME rather than restored onto a machine it was
 * never measured on.
 *
 * ⚠ The travels passed in are the EFFECTIVE ones (`R.travelX ?? default`), not
 * the stored ones. Comparing the stored fingerprint against the stored travels
 * would compare a blob with itself and pass on every input.
 */
const SPOILBOARD_RESTORE = readSessionSpoilboard(
  R,
  [
    R.travelX ?? DEFAULT_TRAVEL_MM[0],
    R.travelY ?? DEFAULT_TRAVEL_MM[1],
    R.travelZ ?? DEFAULT_TRAVEL_MM[2],
  ],
  (RESTORED.status === 'ok' ? RESTORED.savedAt : null) ?? Date.now()
);

/* =========================================================================
 * WHICH PANELS ARE OPEN — remembered across a refresh (founder, 2026-08-11:
 * *"Summary, simulation, Notes, Warning, G-Code, all menus should have the
 * same expanded/collapsed state after refreshing the browser"*).
 *
 * 🔴 DELIBERATELY **NOT** IN `SessionValues`, AND NOT BECAUSE `store.ts` WAS
 * BUSY. `SessionValues` is the VALIDATED blob: a field that fails its rule is
 * dropped on restore and the operator is told which machining setting went. This
 * is UI chrome — no value of it can produce a wrong part — and mixing it in
 * would let a corrupt chrome value contribute to a "field dropped" banner about
 * a machining setting. Two kinds of state, two stores, one of which is allowed
 * to be boring. `REPORT_W_KEY` below is the same pattern and the precedent.
 *
 * 🔴 AN UNKNOWN KEY IS IGNORED, NEVER AN ERROR, and it is also NOT PRUNED.
 * Sections come and go — `panel-notes` only exists while a report carries notes,
 * and `panel-sim` only while there is a report at all — so a key with no section
 * on screen right now is usually a section that will be back, not a stale one.
 * Pruning on write would silently forget the preference for every conditionally
 * rendered panel. So: keep everything, look up only what you recognise.
 *
 * ⚠ Each value is validated at LOOKUP, not at load. One corrupt entry must not
 * discard the other twelve, and a non-boolean is treated as "never seen" — which
 * falls back to the section's own `defaultOpen`, never to open. `Verification`
 * ships `defaultOpen={false}` on purpose.
 * ===================================================================== */
// storedPanelOpen, rememberPanelOpen imported from ./panels/panelPersistence

/* ══════════════════════════════════════════════════════════════════════════
   THE VIEWPORT'S PROJECTION, PERSISTED (founder, 2026-08-11: *"add perspective
   / orthogonal view change capability in all 3d canvas"*)
   ══════════════════════════════════════════════════════════════════════════

   🔴 ITS OWN KEY, NOT `store.ts`'s SESSION BLOB. That blob holds machining
   configuration — the machine, the workpiece, the clamps, the datum — and every
   field in it is an input to a program. A projection is chrome: it changes the
   picture and never the G-code. Putting it in the session would make a viewing
   preference part of what an `Export all` hands to somebody else, and would put
   it under `SESSION_VERSION`, which exists to protect meanings that a plan
   depends on. It follows the `2bee.app.panels.open` precedent instead — one
   small key, read once, written on change, validated at the point of use.

   ⚠ NOT IN `2bee.app.cad.layout` EITHER. That is the CAD tab's file and this is
   the CNC tab's setting; the two tabs default DIFFERENTLY on purpose (see
   `projection.ts`), and one shared key would make the difference impossible to
   express. Two keys, two defaults, one validator. */
// storedCncProjection, rememberCncProjection, storedCncUnit, rememberCncUnit
// imported from ./panels/viewPersistence

/* 🔴 `CLAMP_PRESETS` IS GONE — it is `workholding.ts` now (TODO #34).
 *
 * What stood here was four INVENTED arrangements — `pressure bar`, `cam clamps`,
 * `screws`, `none` — whose heights (40, 35, 6mm) and footprints (40x40, 12x12)
 * came from nowhere. Gate P7 refuses a toolpath that crosses a clamp, so those
 * numbers were the keepout an operator's program was checked against: a made-up
 * height is a made-up safety margin, and it renders identically to a measured
 * one.
 *
 * `WORKHOLDING` carries 19 entries, 18 of them with a vendor URL and the date
 * the page was read — including the one that matters most, a horizontal toggle
 * clamp whose published under-arm clearance (16.5mm) is LESS than the 18mm ply
 * this lane cuts, so it physically cannot close over the stock. An invented
 * catalogue can never tell you that.
 *
 * ⚠ NO DEFAULT CHANGED. `clamps` still starts EMPTY — nothing is declared until
 * someone declares it, and "no clamps declared" still is not "the machine is clear".
 * What is lost is the one-click arrangement, deliberately: this catalogue
 * describes ONE hold-down at a time and does not know where a shop puts four of
 * them. Laying them out is the operator's, and every placed one now carries a
 * real height and a real footprint into P7.
 */

/**
 * A numeric field.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THE UNIT IS A REQUIRED PROP AND `suffix` IS ITS MUTUALLY EXCLUSIVE TWIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every field here is either a LENGTH — canonical millimetres, displayed in the
 * operator's unit — or something else entirely, which today is spindle rpm.
 * The prop type below is a union, so a call site must say which, and the two
 * cannot both be given.
 *
 * ⚠ **NOT A CONTEXT WITH AN `'mm'` DEFAULT**, which was the obvious shape and is
 * the dangerous one: a field whose provider is missing would render millimetres
 * with an `mm` suffix while the menu says inches and every field beside it says
 * `in` — a wrong number that looks exactly like a right one. A required prop
 * makes the same mistake a compile error. Same reasoning as `MenuBarProps.label`
 * and `ViewportProps.zDatum`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THE CONVERSION IS ONE-WAY PER EVENT, WHICH IS WHAT STOPS THE DRIFT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rendering calls `toDisplay(mm)`. **Changing the unit therefore performs no
 * write at all** — `onChange` fires only when a human types or presses the
 * spinner, and then `fromDisplay` converts *what they typed*, once, at full
 * precision. So `0.5 in` stores `12.7`, not the `12.69…` a re-rounded round trip
 * would leave behind, and switching back and forth a hundred times moves
 * nothing.
 *
 * ⚠ THE BOX SHOWS A ROUNDED NUMBER AND THAT IS VISIBLE, NOT HIDDEN. A field
 * holding `12 mm` reads `0.4724` in inches; the unit slot then shows `≈ in` with
 * the stored millimetre value in its tooltip, because a value the operator is
 * about to edit is exactly where "this is not quite the number underneath" has
 * to be said. If they do edit it, `0.4724 in` is what they chose and `12.00 mm`
 * is what they get — an entered value, not a converted one.
 *
 * ⚠ **A CONSEQUENCE THAT IS NOT VERIFIABLE WITHOUT A BROWSER, SO IT IS WRITTEN
 * DOWN RATHER THAN ASSUMED AWAY.** `<input type=number>` validates a value as
 * `min + n·step`, so an inch field holding `0.4724` with a `0.01` step is a
 * `stepMismatch` and its SPINNER will jump to `0.48` rather than to `0.4824`.
 * That is judged acceptable and arguably right — winding a spinner in inches
 * should land on round imperial numbers — and it is an operator ACTION either
 * way, so it stores what they wound to and never drifts on its own. **What no
 * test here can confirm is how each browser renders the mismatch**, and it is in
 * `tests/units.test.ts`'s "what a human still has to confirm" list for that
 * reason. Typing is unaffected: `stepMismatch` does not block input outside a
 * form submit, and this app has no form.
 */
// Num, MmOnlySlot imported from ./panels/NumericInput

/* ──────────────────────────────────────────────────────────────────────────
 * ONE LIST PER PANEL — the shipped catalogue and the user's own, together.
 *
 * 🔴 `SavedSet` IS GONE (TODO #61/#55, founder 2026-08-09: *"in the machine
 * section remove the: saved… ▼ / Delete / Preset"*, and *"tooling, remove the
 * Export tools, Choose File (new) from the left navbar, put this functionality
 * into the list"*).
 *
 * What it was: a component that rendered its OWN `saved… ▼` picker plus a
 * `Delete` button, in three panels, ALONGSIDE the panel's shipped catalogue
 * picker (`Preset`, `Sheet`, `Sample`). So a machine lived in two lists that
 * never mentioned each other, and the panel carried three selection controls
 * where the standing rule says it carries none — properties read-only, every
 * add / import / export / delete in the standardised list.
 *
 * Its own comment already said half of this in 2026-08-08 (*"the name box and
 * the Save button are GONE from the panel"*) and then kept `saved… ▼` and
 * `Delete`. **A partly-applied rule reads as a deliberate exception to whoever
 * arrives next**, which is exactly how it survived a second pass.
 *
 * What replaces it is NOT a component but a hook: the saved objects and the
 * writes that change them, handed to the panel, which composes ONE
 * `ObjectPicker` out of its catalogue and them. The three near-copies the old
 * comment was worried about are still avoided — there is still one definition
 * of "what happens when the name is taken" — but the merge now happens where
 * the catalogue is, instead of in a second dialog beside it.
 *
 * ⚠ AND THE ORIGIN HAS TO STAY VISIBLE PER ROW, which is the constraint the
 * merge inherits from #54 and does not get to drop: a shipped machine preset
 * carries measured travels, a shipped sheet carries the supplier page and the
 * date it was read, a shipped drawing carries "measured through the CLI
 * importer" — and a thing the user saved this morning carries NOTHING. In one
 * list the first must not lend its confidence to the second. See `SHIPPED` /
 * `yours()` below; every merged row is built through them.
 * ────────────────────────────────────────────────────────────────────────── */

/** What one collection of the user's own saved objects can do. */
interface SavedCollection<T> {
  items: SavedItem<T>[];
  note: string;
  /** Write under a name that is NEW to the user. */
  saveAs: (name: string, data: T) => Promise<void>;
  /** Write over a name that already exists. Allowed, and SAID rather than
   *  blocked: a shop renames a machine after a rebuild and expects the name to
   *  follow it. */
  replace: (name: string, data: T) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /**
   * Re-read the collection out of the store.
   *
   * 🔴 FOR WRITES THIS HOOK DID NOT MAKE, and it exists because there is one:
   * `store-import` calls `importAll`, which writes every collection straight
   * into IndexedDB behind all three of these hooks. Measured in the browser
   * 2026-08-11: a store file holding one machine imported cleanly, the panel
   * said **"imported: 1 new"**, and `machine-picker` still listed only the three
   * shipped presets — the row existed in Chrome and did not exist in the app
   * until a reload nobody had a reason to perform.
   *
   * ⚠ That is the founder's own bug wearing a different hat (*"I have saved as a
   * new Machine but I can't select it"*, `savedSelection.ts`): a saved object
   * that reached storage and never reached the picker. A SUCCESS MESSAGE OVER AN
   * INVISIBLE RESULT is worse than the failure, because it tells the operator to
   * stop looking.
   */
  refresh: () => void;
}

/**
 * @param writer Optional replacement for the plain `save()` — see
 *   {@link writeDrawing}, which is the only caller that passes one. It must be
 *   REFERENTIALLY STABLE (module scope, not an inline lambda), because it is a
 *   dependency of the write callback and a new identity every render would
 *   rebuild the whole chain on each keystroke.
 */
function useSaved<T>(
  collection: Collection,
  writer?: (name: string, data: T, now: number) => Promise<void>
): SavedCollection<T> {
  const [items, setItems] = useState<SavedItem<T>[]>([]);
  const [note, setNote] = useState('');

  /* 🔴 A READ THAT FAILED IS NOT AN EMPTY COLLECTION, AND THAT IS THE HALF OF
   * THE FOUNDER'S *"save as does not work: Machine"* THAT LIVES IN THIS FILE.
   *
   * `items` stays `[]` when the store cannot be opened, and `[]` renders exactly
   * like a shop that has saved nothing: the picker shows the three shipped
   * presets and no more. On 2026-08-11 that was the whole visible symptom of a
   * database this build could not open at all (`store.ts::open`, generation 4 vs
   * a fixed 3) — every collection dead, every write refused, and the machine
   * list looking merely new. `Save as` was correctly wired the entire time; it
   * was writing into a door that would not open.
   *
   * ⚠ SO THE FAILURE SAYS WHAT IT COSTS, not just what threw. `String(e)` alone
   * gave the operator `VersionError: The requested version (3) is less than the
   * existing version (4)` next to a list that looked fine — a true sentence with
   * no consequence attached, which is why it read as noise beside a picker that
   * appeared to be working. It now says the list is INCOMPLETE, which is the
   * fact that changes what the operator does next.
   */
  const refresh = useCallback(() => {
    listSaved<T>(collection)
      .then(setItems)
      .catch((e) =>
        setNote(
          `THIS LIST IS INCOMPLETE — the browser's local store could not be READ, so anything you ` +
            `saved is missing from the list rather than absent from your shop, and a save now would ` +
            `fail the same way: ${String(e instanceof Error ? e.message : e)}`
        )
      );
  }, [collection]);
  useEffect(refresh, [refresh]);

  // Refresh when another component (e.g. CAD tab) writes to this collection.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.collection === collection) refresh();
    };
    window.addEventListener('store-changed', handler);
    return () => window.removeEventListener('store-changed', handler);
  }, [collection, refresh]);

  /* 🔴 A FAILED WRITE IS SHOWN, never swallowed — the same rule the session
   * blob follows. A browser that refused the write looks identical to one that
   * accepted it until the operator comes back and the machine is not there. */
  const write = useCallback(
    async (name: string, data: T, verb: string) => {
      try {
        if (writer) await writer(name, data, Date.now());
        else await saveItem(collection, name, data, Date.now());
        setNote(`${verb} "${name}"`);
        refresh();
      } catch (e) {
        setNote(String(e instanceof Error ? e.message : e));
      }
    },
    [collection, refresh, writer]
  );

  const saveAs = useCallback((n: string, d: T) => write(n, d, 'saved'), [write]);
  const replace = useCallback((n: string, d: T) => write(n, d, 'replaced'), [write]);
  const remove = useCallback(
    async (name: string) => {
      try {
        await removeItem(collection, name);
        setNote(`deleted "${name}"`);
        refresh();
      } catch (e) {
        setNote(String(e instanceof Error ? e.message : e));
      }
    },
    [collection, refresh]
  );

  return { items, note, saveAs, replace, remove, refresh };
}

/**
 * The origin tag on a merged row, and the property that spells it out.
 *
 * 🔴 ONE DEFINITION FOR ALL THREE MERGED LISTS, and that is the point rather
 * than tidiness. #54's constraint — *"a merged list must not let a shipped
 * sample's confidence rub off on a file somebody dragged in this morning"* —
 * is a property of every merged list in this app, and three copies of the
 * wording would be three lists that eventually disagree about how loudly they
 * say it. The tag goes at the FRONT of `detail`, where it is read before the
 * numbers it qualifies, and the sentence goes FIRST in `properties`, above
 * everything the row claims.
 */
// SHIPPED_TAG, YOURS_TAG, shipped(), yours() imported from ./panels/originHelpers

/* ── The core's tool verdicts, as a picker row (TODO #66) ──────────────────── */

/**
 * The mark at the FRONT of a tool row — the founder's *"highlight the tool …
 * if it does not work for the current setup, it invalidates the job"*.
 *
 * 🔴 IT NAMES THE RULE, because *"invalidates the job"* is FOUR conditions —
 * `tool-definition`, `collet`, `reach`, `spindle-rpm` — and they send an
 * operator to four different places: a broken tool entry, the collet drawer, a
 * longer cutter, a different material or spindle. A red row that will not say
 * which one fired cannot be acted on.
 *
 * ⚠ `unknown` IS NOT `usable` and is never rendered as cleared. A rule that
 * could not run has vouched for nothing: no workpiece declared means `reach` is
 * UNCHECKED, and `Stock::default()` is 18mm, so judging against it would be
 * confident about a workpiece nobody chose.
 */
// Verdict helpers extracted to panels/verdictHelpers.ts
import {
  usabilityMark,
  colletDisagreement,
  COLLET_DISAGREEMENT_WHY,
  ADVICE_OPTIONS,
  verdictProps,
  drawingUsabilityMark,
  drawingFitMark,
  FIT_OPTIONS,
  worstDrawingFit,
  drawingVerdictProps,
} from './panels/verdictHelpers';
import {
  withTag,
  ownershipProps,
  inventoryOnlyItem,
} from './panels/ownershipHelpers';
import {
  rowId,
  parseRowId,
  drawingRowId,
  parseDrawingRowId,
} from './panels/rowIdHelpers';
import { Num, MmOnlySlot } from './panels/NumericInput';
import { SHIPPED_TAG, YOURS_TAG, shipped, yours } from './panels/originHelpers';
import { rememberCncProjection, rememberCncUnit } from './panels/viewPersistence';
import {
  spoilboardReachVerdict,
  fitSpoilboard,
  SPOILBOARD_CUSTOM,
  SPOILBOARD_SAVED_PREFIX,
  isMeasuredBoardId,
  savedBoardName,
} from './panels/spoilboardHelpers';
import { EyeIcon, SectionEye, Section } from './panels/SectionPanel';
import { typedMm } from './panels/typedMm';
import { SavedDataPanel } from './panels/SavedDataPanel';
import { SummaryPanel } from './panels/SummaryPanel';
import { OperationPanel } from './panels/OperationPanel';
import { SimulationPanel } from './panels/SimulationPanel';
import { useSpoilboardState, type SpoilboardRestore } from './panels/useSpoilboardState';
import { useCncStore } from './store/cncStore';

/* ── The core's DRAWING verdicts, as a picker row ──────────────────────────── */

/**
 * The mark at the FRONT of a drawing row — the founder's *"a filter on the
 * drawings as well like in the tools (selected, usable, not chosen, not for this
 * workpiece …)"*, red half.
 *
 * 🔴 IT NAMES THE RULE, for the same reason {@link usabilityMark} does:
 * *"invalidates the job"* is FOUR conditions — `identity`, `geometry`,
 * `placement`, `pair-clearance` — and they send an operator to four different
 * places: rename a drawing, go back to the CAD file, fix a placement, or move
 * two parts apart on the material. A red row that will not say which one fired
 * cannot be acted on.
 *
 * ⚠ `unknown` IS NOT `usable` and is never rendered as cleared. The commonest
 * case is real and important: with no cutter resolved, NO PAIR OF PARTS WAS
 * CHECKED against another — and an unchecked workpiece is not a clear one.
 */
// drawingUsabilityMark, drawingFitMark, FIT_OPTIONS, worstDrawingFit, drawingVerdictProps
// imported from ./panels/verdictHelpers (extracted to reduce App.tsx size)

/* ── The ownership layer, as a picker row (TODO #83) ───────────────────────── */

// ownershipProps, inventoryOnlyItem, withTag imported from ./panels/ownershipHelpers

/** What the `drawings` collection holds. Mirrors what the panel saves. */
interface SavedDrawing {
  bytes?: Uint8Array;
  text?: string;
  format: 'dxf' | 'svg' | 'stl' | 'auto';
  name: string;
  /**
   * 🔴 PRESENT ⇒ THIS ROW WAS DESIGNED IN `2bee.cad`, and it is the same row
   * shape as any other saved drawing — deliberately. Founder 2026-08-10: *"in
   * the 1st tab (cad) we should able to save the cad files in the same list as
   * drawings"*. `cad/record.ts` chose to reuse the `'saved'` origin rather than
   * add a `'cad'` one, because an origin is a LOOKUP ROUTE and a CAD model is
   * looked up exactly like every other saved drawing; what is CAD-specific rides
   * INSIDE the record, which is this field.
   *
   * It carries the source the mesh was evaluated from, a checksum for each half,
   * the mesh audit's verdict and every construct that was REFUSED and is
   * therefore missing from the solid. Everything this file does with it goes
   * through `record.ts` (`isCadRecord`, `cadRowDetail`, `describeCadRecord`,
   * `verifyCadRecord`) — none of it is re-derived here, for the same reason the
   * collet rule is not.
   */
  cad?: CadPayload;
}

/**
 * How a drawing is WRITTEN — and the one branch in it exists so a claim in
 * `store.ts` stays true.
 *
 * 🔴 A RECORD CARRYING A `cad` PAYLOAD GOES THROUGH `saveCadModel`, WHICH
 * VERIFIES IT AND FAILS CLOSED. That function's section header says the check
 * *"sits at the store boundary, where every route in and out goes past it"* —
 * and the moment `currentDrawing()` started carrying the payload back out (see
 * it, below), the panel's Save / Save-as buttons became a second route in. A
 * generic `save()` on that route would write a CAD record without ever
 * re-deriving its checksums, which is exactly the state the guard exists to
 * refuse: a stored mesh that is not known to be an evaluation of the source
 * stored beside it, picked up days later by the tab that cuts things.
 *
 * ⚠ THE NAME IS REWRITTEN INTO THE RECORD, because `saveCadModel` keys on
 * `rec.name` rather than on an argument. Without this, "Save as" under a new
 * name would write over the OLD one — a rename that silently overwrites the
 * thing it was supposed to leave alone.
 *
 * ⚠ The STL's own 80-byte header still carries the name the model was first
 * saved under; it is a comment inside the bytes, and rewriting it would change
 * the bytes and therefore the checksum. Stated rather than fixed: it is
 * cosmetic, and quietly re-encoding a mesh to tidy a label is not a trade this
 * lane makes.
 */
async function writeDrawing(name: string, data: SavedDrawing, now: number): Promise<void> {
  if (isCadRecord(data)) return saveCadModel({ ...data, name }, now);
  return saveItem('drawings', name, data, now);
}

/** What the `machines` collection holds. */
interface SavedMachine {
  travelX: number;
  travelY: number;
  travelZ: number;
  safeZ: number;
  colletMm: number;
  spindleMax: number;
  probeEnabled: boolean;
  touchPlateMm: string;
  touchPlateId?: string;
  supportsArcs: boolean;
  /* The spoilboard travels with the MACHINE, because that is what it is a
   * property of: a board is bolted to these rails at this corner, and it stays
   * there when the sheet, the drawing and the tool change.
   *
   * ⚠ OPTIONAL, and absent means NO BOARD DECLARED — which is exactly what
   * every machine saved before this field existed had. A restore must not
   * invent one, so these read back through the same `?? ''` the state opens on
   * and a machine saved last week comes back UNCHECKED rather than pretending
   * to a board nobody entered. */
  spoilboardId?: string;
  spoilboardX?: string;
  spoilboardY?: string;
  spoilboardSizeX?: string;
  spoilboardSizeY?: string;
  /* 🔴 THE DEPTH, and absent is NOT DECLARED — the state the core reports as
   * PENDING for "did the cutter go through the board?". Every machine saved
   * before 2026-08-11 has no such key and comes back with none, which is the
   * truth about them: nothing here could state a measured board's thickness
   * until that day, so nobody did. */
  spoilboardThickness?: string;
  spoilboardName?: string;
  /* 🔴 SAVED WITH THE NUMBERS, because without it a reloaded machine's corner
   * is indistinguishable from a measured one. `?? 'assumed'` on restore, which
   * is the honest default: a machine saved before this field existed carries a
   * corner nobody can now vouch for, and reading it back as `'entered'` would
   * manufacture a human's authority out of a missing key. */
  spoilboardPos?: 'assumed' | 'entered';
  /* 🔴 THE MACHINE THE CORNER WAS MEASURED ON, saved beside it — and it is NOT
   * the same fact as `travelX/Y/Z` above, which is the whole reason it is here.
   *
   * A record is written from whatever is on the panels at the moment Save is
   * pressed. An operator who typed new travels and then saved produces a record
   * whose travels and whose corner describe two different machines, and the
   * record has no way to say so. This field is what lets the load path ask
   * `spoilboardForMachine` the question instead of assuming the answer.
   *
   * ⚠ Absent — every machine saved before 2026-08-11 — is "unknown machine",
   * which the guard treats as a MISMATCH: the corner is dropped by name and the
   * board comes back position-not-entered. Under-declaring costs a false red. */
  spoilboardTravels?: [number, number, number];
}

/** What the `workpieces` collection holds. */
interface SavedWorkpiece {
  stockX: number;
  stockY: number;
  thickness: number;
  material: string;
  originX: number;
  originY: number;
  rotation: number;
  zZeroTop: boolean;
}

/**
 * A row id in a merged list: `<surface>:<name>`.
 *
 * 🔴 The surface is part of the id, and it has to be. The shipped DXF and the
 * shipped STL of the same part are two different objects — one is the cut file
 * `cad` emits, the other is the solid, and choosing the wrong one is choosing a
 * SECTION OF A SOLID over a DRAWN PROFILE. Both produce a program that posts
 * and cuts. They were already renamed apart (`Hive super end — solid (STL)`),
 * but a name is a label a user can also re-use: nothing stops someone saving
 * their own drawing as `Hive super end`. `id` is what the picker resolves a
 * click through, so it is the one that must be unique by construction rather
 * than by convention.
 *
 * `'file'` is a legal origin here and deliberately resolves to an id NO ROW
 * CARRIES: a drawing opened from disk and not saved is not in any list, and the
 * picker showing nothing selected is the honest rendering of that.
 */
// rowId, parseRowId, drawingRowId, parseDrawingRowId imported from ./panels/rowIdHelpers

/**
 * The eye glyph. Drawn rather than typed: an emoji renders at whatever size and
 * hue the platform font decides, and this one sits inside a control whose two
 * states have to be told apart at 14px.
 */
// EyeIcon, SectionEye, Section imported from ./panels/SectionPanel

export default function App() {
  /* ── WHICH TAB IS SHOWING ────────────────────────────────────────────────
   *
   * Restored from `localStorage` on the first render, so the app opens where it
   * was left. `readStoredTab()` never throws and never returns anything but a
   * known id — an unknown stored value opens the default rather than an empty
   * screen. The rule about what is MOUNTED behind each tab is in `Tabs.tsx`;
   * this state is only which one is visible.
   *
   * 🔴 `cadSeen` is what keeps a FIRST page load identical to the one that
   * shipped before tabs existed: the CAD tree is not rendered at all until the
   * tab has been opened once, and from then on it stays mounted so the source
   * being typed survives a switch to the CNC tab and back. `Run` is static text
   * and is cheap either way; it is rendered on the same terms for consistency,
   * not because it holds anything. */
  const [tab, setTabState] = useState<TabId>(() => readStoredTab());
  const [cadSeen, setCadSeen] = useState(() => readStoredTab() === 'cad');
  const setTab = useCallback((next: TabId) => {
    setTabState(next);
    rememberTab(next);
    if (next === 'cad') setCadSeen(true);
  }, []);

  /* The shop hands a design to `CadTab` through `shop/handoff.ts` and then asks
   * to be switched. Going through `setTab('cad')` is what MOUNTS the tree — the
   * request is held in the handoff's pending slot until it does, and on a first
   * visit nothing has mounted `CadTab` at all, which is now the normal case
   * because the shop is the landing tab. */
  const onShopOpened = useCallback(() => setTab('cad'), [setTab]);

  // ready, loadError, ver, jobs, plants, lib — migrated to Zustand store

  /* ── WHAT THIS SHOP OWNS (TODO #83) ─────────────────────────────────────────
   *
   * 🔴 IT OPENS EMPTY AND NOTHING FILLS IT IN. `EMPTY_INVENTORY` is not a
   * placeholder waiting for a default — it is the state every shop in the fleet
   * is in today, because `bom` has answered *no cutter inventory exists* and
   * `ops` has no machine on the floor. `inventory.ts` renders that as UNCHECKED
   * on every row and as a source line saying so, and `inventoryDefaultId()`
   * returns `null` for all four kinds. Nothing here may improve on that.
   *
   * ⚠ `unchecked` (no inventory for this kind) and `not-held` (an inventory
   * exists and does not list it) are DIFFERENT and stay different all the way to
   * the row: the first MARKS, the second DISABLES. Collapsing them would either
   * brick every picker in the fleet or quietly vouch for kit nobody counted.
   *
   * `dropped` is what came back out of storage unreadable, by name. Never
   * silent: an inventory that lost three entries on the way back reads exactly
   * like a shop that owns three fewer things. */
  // inventory, inventoryDropped, inventoryError — migrated to Zustand store
  /* ── THE IMPORT ROUTE (TODO #83, the half that was never wired) ─────────────
   *
   * `parseInventoryFile`, `applyImport` and `writeInventory` were written,
   * tested and CALLED BY NOBODY, so every row in every picker read UNCHECKED
   * permanently — honest, and permanently uninformative. This is the caller.
   *
   * 🔴 WHAT AN IMPORT PRODUCES IS NOT A SUCCESS MESSAGE. Three separate facts
   * have to reach the operator and none of them is optional:
   *
   *   `outcome.dropped`  — entries the PREVIOUS import carried that this file no
   *                        longer lists. An import REPLACES the imported set, so
   *                        **every one of these is a saved job that must now
   *                        refuse**. Naming them is the only way somebody finds
   *                        out before the planner does.
   *   `report.refused`   — entries in the file this build could not read, BY
   *                        INDEX AND ID. A bare count is not something a shop
   *                        can act on, and the count also rides inside the
   *                        document so the source line cannot be written
   *                        without stating it.
   *   `undated`/`unsourced` — the file did not say when it was counted, or by
   *                        whom. Marked UNDATED; never back-filled from this
   *                        browser's clock. "When we read it" and "when they
   *                        counted it" are different facts and only the second
   *                        is the one a picker is asserting.
   *
   * 🔴 A FILE THAT CANNOT BE VOUCHED FOR IS REFUSED WHOLE — `status: 'refused'`
   * imports nothing and leaves the registered inventory exactly as it was. Half
   * an inventory is worse than none: it is a shop that believes it declared its
   * tooling and did not. */
  // inventoryImport, inventoryImportRefused, inventoryWriteError — migrated to Zustand store
  const importInventoryRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    let alive = true;
    readInventory()
      .then(({ doc, dropped }) => {
        if (!alive) return;
        setInventory(doc);
        setInventoryDropped(dropped);
      })
      /* A read that FAILED is not an empty inventory, and must not render as
       * one. Both end up showing UNCHECKED rows, but only one of them is a
       * fault the operator can do something about. */
      .catch((e) => alive && setInventoryError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Read an inventory file. THE SEQUENCE IS `inventory.ts`'s AND IS NOT
   * REARRANGED — parse, then apply, then write, then adopt.
   *
   * ⚠ The order matters in one direction: the document is WRITTEN before it is
   * adopted into state, so a storage failure leaves the pickers describing the
   * inventory that is actually stored rather than one that only exists in this
   * tab and disappears on reload. A picker that is right until you refresh is
   * the worst of the three outcomes.
   */
  const importInventory = useCallback(
    async (text: string) => {
      const now = Date.now();
      setInventoryWriteError(null);
      const parsed = parseInventoryFile(text, now);
      if (parsed.status === 'refused') {
        /* 🔴 NOTHING IS IMPORTED AND NOTHING IS CLEARED. The previous outcome is
         * dropped from the screen too, because leaving it there beside a refusal
         * would read as "the last import still stands, and also this failed" —
         * which is true but is the less useful of the two readings. */
        setInventoryImport(null);
        setInventoryImportRefused(parsed.why);
        return;
      }
      setInventoryImportRefused(null);
      const outcome = applyImport(useCncStore.getState().inventory ?? EMPTY_INVENTORY, parsed.doc);
      try {
        await writeInventory(outcome.doc, now);
      } catch (e) {
        /* The file was fine; the store was not. Say which, and do NOT adopt the
         * document — see the ordering note above. */
        setInventoryWriteError(String(e instanceof Error ? e.message : e));
        return;
      }
      setInventory(outcome.doc);
      /* The stored-record casualties belong to the record that has just been
       * replaced. Carrying them forward would attribute them to the new file. */
      setInventoryDropped([]);
      setInventoryError(null);
      /* No "imported at" field here on purpose: it is already IN the document
       * and `describeProvenance` prints it on every picker's source line. A
       * second copy in a second place is a second thing to keep true. */
      setInventoryImport({
        report: parsed.report,
        dropped: outcome.dropped,
        kept: outcome.kept,
      });
    },
    []
  );

  /**
   * Ask the ownership layer about ONE picker's catalogue.
   *
   * 🔴 THE CATALOGUE IDS PASSED IN ARE THE BARE ONES — `m.name`, `s.id`, `w.id`,
   * `t.id` — and NOT the merged-list row ids (`preset:…`, `saved:…`). An
   * inventory file is written by `bom` or `ops` about physical kit; it cannot be
   * expected to know this file's row-id encoding, and an id that only resolves
   * after a UI-local prefix is stripped is an id that stops resolving the day
   * the prefix changes. Where a picker's row id differs from its catalogue id,
   * the row does the mapping — not the file.
   *
   * ⚠ `MACHINE_PRESETS` HAS NO `id`, ONLY A DISPLAY NAME, so a machine entry
   * keys on a string that exists to be read by humans and a rename turns an
   * owned machine into `unresolved`. That FAILS SAFE — a refusal, never a
   * substitution — and it is still a real weakness. Reported by the module's
   * author and left as found: giving those presets ids is a change to what is
   * stored in every saved machine, not a wiring change.
   */
  const inventoryFor = useCallback(
    (kind: InventoryKind, catalogue: CatalogueRow[]) => {
      /* `Date.now()` per call rather than a pinned mount time: the only thing it
       * feeds is the "read N days ago" clause, and a session left open overnight
       * should not keep saying "today". */
      const doc = inventory ?? EMPTY_INVENTORY;
      const view = mergeInventory({ kind, doc, catalogue, now: Date.now() });
      const byId = new Map(view.rows.map((r: InventoryRow) => [r.id, r]));
      return {
        view,
        /** This catalogue row's ownership answer. */
        row: (id: string): InventoryRow | undefined => byId.get(id),
        /** Rows the inventory carries and the catalogue does not. */
        extras: view.rows.filter((r: InventoryRow) => r.catalogue === null).map(inventoryOnlyItem),
        /** How many entries this kind holds. The number every consequence
         *  sentence and every availability rule keys on. */
        heldInKind: (useCncStore.getState().inventory?.entries ?? []).filter((e: OwnedEntry) => e.kind === kind).length,
      };
    },
    []
  );

  /* ── WRITING AN OWNERSHIP CLAIM — TODO #105 ─────────────────────────────────
   *
   * 🔴 THE ONE WRITER. `addOperatorEntry` and `removeEntry` are `inventory.ts`'s
   * and are called from nowhere else in this file, so there is exactly one place
   * that decides what a press does and exactly one that persists it.
   *
   * 🔴 THE STORE IS WRITTEN BEFORE THE STATE IS ADOPTED — the same ordering, for
   * the same reason, as the import path above it: a picker that is right until
   * you refresh is the worst of the three outcomes, because nothing on screen
   * distinguishes it from one that saved.
   *
   * 🔴 IT TOUCHES THE INVENTORY DOCUMENT AND NOTHING ELSE. Not the SELECTION, not
   * `confirmedClear`, not a plan input. Two of those are worth saying rather than
   * assuming:
   *   · `confirmedClear` is an attestation that somebody LOOKED AT THE BED today
   *     — `store.ts` refuses to restore it and `App` asks it again every session.
   *     Owning a clamp is not the bed being clear, so marking a hold-down as
   *     yours must not brush against it in either direction.
   *   · The selection stands. Marking a SELECTED cutter as one you do not have
   *     does not deselect it; the job then carries a refusal naming that cutter,
   *     which `NOT_HELD_AND_THE_PLAN` states as a decision. Editing somebody's
   *     program as a side effect of a stock-take is the alternative, and it is
   *     worse: they would find out at the machine which operation lost its tool.
   *
   * ⚠ `definition: 'operator'` — a claim typed here says so, forever, in its own
   * `asserted_by`, and an import never touches it (`applyImport` keeps operator
   * entries by design). `catalogue` would have laundered a browser click into the
   * vocabulary a sourced file uses. */
  const claimOwnership = useCallback(
    async (kind: InventoryKind, id: string, next: OwnershipWrite) => {
      if (!inventory) return;
      const now = Date.now();
      const doc =
        next === 'held'
          ? addOperatorEntry(inventory, { kind, id }, now)
          : removeEntry(inventory, kind, id);
      setInventoryWriteError(null);
      try {
        await writeInventory(doc, now);
      } catch (e) {
        /* Not adopted. The pickers keep describing what is actually stored. */
        setInventoryWriteError(String(e instanceof Error ? e.message : e));
        return;
      }
      setInventory(doc);
    },
    []
  );

  /**
   * The per-row control, for one row of one picker.
   *
   * 🔴 EVERY WORD IN IT COMES FROM `ownership.ts`. Nothing is composed here: a
   * sentence written at a call site is a sentence the other three call sites do
   * not have, and there are four pickers. `undefined` when the row has no
   * ownership verdict at all — a machine the operator saved in this browser is
   * not a catalogue entry and *"you typed this here"* already answers a stronger
   * version of the question than an inventory file could.
   */
  const ownershipClaim = (
    kind: InventoryKind,
    heldInKind: number,
    row: InventoryRow | undefined,
    /**
     * Is THIS row part of the current setup?
     *
     * 🔴 IT DECIDES WHETHER THE PLANNER SENTENCE IS SHOWN, and that sentence is
     * the stated decision `NOT_HELD_AND_THE_PLAN` carries: marking something you
     * are USING as "not in my shop" neither deselects it nor stops the program.
     * Shown on every row it would be noise, and a warning shown while it is
     * untrue is one the operator learns to ignore; shown on none of them, the
     * decision would live only in a constant nobody reads — a control with no
     * consumer accruing authority it never earned.
     */
    selected: boolean
  ): RowClaim | undefined => {
    if (!row) return undefined;
    const ctx = { kind, heldInKind, state: row.ownership.state };
    const consequence =
      firstMarkConsequence(ctx) ??
      lastUnmarkConsequence(ctx) ??
      machineCountNote(kind, heldInKind) ??
      undefined;
    return {
      label: `Do you have this ${KIND_LABEL[kind]}?`,
      value: row.ownership.state,
      options: ownershipChoices(ctx),
      /* Only the two writable verdicts ever reach here — `ObjectPicker` refuses
       * an option carrying `unavailable` on both the pointer and the keyboard
       * route, and `ownershipChoices` marks `unchecked`/`unresolved` unavailable
       * wherever they are not the row's own current value. The narrowing below is
       * the same rule stated in TypeScript, so a future option that is writable
       * and not one of these two fails the build rather than the machine. */
      onChange: (v) => {
        if (v !== 'held' && v !== 'not-held') return;
        void claimOwnership(kind, row.id, v);
      },
      note: selected ? `${KIND_NOTE[kind]} ${NOT_HELD_AND_THE_PLAN}` : KIND_NOTE[kind],
      consequence,
    };
  };

  /**
   * What the picker prints ABOVE its list: where the list's ownership answers
   * came from, how old they are, and what could not be read.
   *
   * 🔴 SCOPED TO THE KIND, because "we have an inventory" and "we have an
   * inventory of cutters" are different claims and only the second is one a tool
   * picker can act on. `sourceLine()` writes it; nothing here paraphrases it.
   */
  const inventorySource = (kind: InventoryKind, view: InventoryView) => (
    <>
      <p className="note" data-testid={`${kind}-inventory-source`}>
        {view.sourceLine}
      </p>
      {inventoryError && (
        /* 🔴 A FAILED READ IS NOT AN EMPTY INVENTORY. Both show UNCHECKED rows;
           only this one is a fault, and only this one can be fixed. */
        <p className="bad" data-testid={`${kind}-inventory-error`}>
          The stored inventory could NOT be read, so every row above is UNCHECKED for a reason
          that is a fault rather than an absence: {inventoryError}
        </p>
      )}
      {inventoryDropped.length > 0 && (
        <p className="warn" data-testid={`${kind}-inventory-dropped`}>
          {inventoryDropped.length} stored inventory entr
          {inventoryDropped.length === 1 ? 'y' : 'ies'} could not be read back and{' '}
          {inventoryDropped.length === 1 ? 'is' : 'are'} missing from every list —
          something you own may show as not owned: {inventoryDropped.join(' · ')}
        </p>
      )}
      {/* 🔴 THE IMPORT ROUTE. It is in EVERY inventory-backed picker and not in
          one privileged place, because the operator meets the absence in
          whichever picker they opened — "every row here is UNCHECKED" and "here
          is how to stop that being true" belong in the same paragraph. One
          document, one file input (mounted once, below the panel column); four
          buttons that reach it. */}
      <div className="row">
        <button
          type="button"
          data-testid={`${kind}-inventory-import`}
          title="Read a JSON inventory written by bom or ops. It replaces the imported set; anything you typed here is kept."
          onClick={() => importInventoryRef.current?.click()}
        >
          Import an inventory file…
        </button>
      </div>
      {inventoryImportRefused && (
        /* 🔴 THE WHOLE FILE WAS REFUSED. Said in the parser's own words, with
           the consequence spelled out: the inventory already registered is
           untouched, so nothing on screen changed and nothing silently half
           changed. */
        <p className="bad" data-testid={`${kind}-inventory-import-refused`}>
          That inventory file was refused whole and NOTHING was imported — the inventory already
          registered is unchanged: {inventoryImportRefused}
        </p>
      )}
      {inventoryWriteError && (
        <p className="bad" data-testid={`${kind}-inventory-write-error`}>
          That file read correctly and could NOT be stored, so it has not been adopted: every row
          above still describes the inventory that was registered before. {inventoryWriteError}
        </p>
      )}
      {inventoryImport && (
        <div data-testid={`${kind}-inventory-import-report`}>
          <p className="note">
            Imported {inventoryImport.report.accepted} entr
            {inventoryImport.report.accepted === 1 ? 'y' : 'ies'}
            {inventoryImport.kept > 0
              ? `, and kept the ${inventoryImport.kept} entr${inventoryImport.kept === 1 ? 'y' : 'ies'} you typed here — an import replaces what was IMPORTED, never what you entered`
              : ''}
            .
          </p>
          {/* 🔴 EVERY DROPPED ENTRY IS A SAVED JOB THAT MUST NOW REFUSE. This is
              the paragraph the module's author asked for by name: an import
              REPLACES the imported set, so what the new file stopped listing is
              gone, and a job selecting it will be refused rather than
              substituted. Naming them is how somebody finds out before the
              planner tells them. */}
          {inventoryImport.dropped.length > 0 && (
            <p className="warn" data-testid={`${kind}-inventory-import-dropped`}>
              {inventoryImport.dropped.length} previously-imported entr
              {inventoryImport.dropped.length === 1 ? 'y is' : 'ies are'} NOT in the new file and{' '}
              {inventoryImport.dropped.length === 1 ? 'has' : 'have'} been dropped. Any saved job
              that selects{' '}
              {inventoryImport.dropped.length === 1 ? 'it' : 'one of them'} will now be REFUSED, not
              substituted:{' '}
              {inventoryImport.dropped
                .map((d: { kind: InventoryKind; id: string }) => `${KIND_LABEL[d.kind as keyof typeof KIND_LABEL]} "${d.id}"`)
                .join(' · ')}
            </p>
          )}
          {/* BY INDEX AND ID, never a bare count — "3 were dropped" is not
              something a shop can act on. */}
          {inventoryImport.report.refused.length > 0 && (
            <div className="warn" data-testid={`${kind}-inventory-import-refused-entries`}>
              <p style={{ margin: 0 }}>
                {inventoryImport.report.refused.length} entr
                {inventoryImport.report.refused.length === 1 ? 'y' : 'ies'} in that file could NOT be
                read and {inventoryImport.report.refused.length === 1 ? 'is' : 'are'} missing from
                every list — something you own may show as not owned:
              </p>
              <ul className="notes">
                {inventoryImport.report.refused.map((r: { index: number; id: string; why: string }) => (
                  <li key={`ir${r.index}-${r.id}`}>
                    entry #{r.index} ("{r.id}") — {r.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* 🔴 UNDATED IS MARKED, NEVER STAMPED WITH OUR CLOCK. A list read
              today can have been counted a year ago, and only the second date
              says anything about whether the shop still holds the kit. */}
          {inventoryImport.report.undated && (
            <p className="warn" data-testid={`${kind}-inventory-import-undated`}>
              That file did not say WHEN the count was taken, so it is marked UNDATED. It has NOT
              been stamped with today's date — when we read a list and when somebody counted the
              shelf are different facts, and only the second one tells you whether this is still
              true.
            </p>
          )}
          {inventoryImport.report.unsourced && (
            <p className="warn" data-testid={`${kind}-inventory-import-unsourced`}>
              That file did not say WHO produced it, so every row it vouches for is vouched for by
              nobody nameable.
            </p>
          )}
        </div>
      )}
    </>
  );

  /**
   * The refusal path for a selection that is already made — a restored session,
   * an imported job, a shop whose inventory stopped listing something.
   *
   * 🔴 IT REFUSES AND NAMES WHAT IS MISSING. It does not fall back to the
   * nearest diameter, the same category or the first row, and `resolveSelection`
   * carries no field such a suggestion could ride back in — a suggestion is one
   * `??` away from being a substitution, and the substitution is the failure
   * `core/src/fixtures.rs` once shipped a whole program on.
   */
  const inventoryRefusal = (
    kind: InventoryKind,
    id: string,
    catalogue: CatalogueRow[]
  ): string | null => {
    if (!id || !inventory) return null;
    const v = resolveSelection(inventory, kind, id, catalogue, Date.now());
    return v.status === 'refused' ? v.why : null;
  };

  // job, plant, dark — migrated to Zustand store
  // The plant control is a gate instrument, not a machining setting. Visible
  // only with `?plants=1`, which the browser suite passes and an operator never
  // types. Read once: a plant that could appear mid-session would be worse than
  // one that is always there.
  // 🔴 The GATE INSTRUMENTS, off the operator surface — founder, 2026-08-08.
  // `Job` selects a built-in FIXTURE (plate/pocket/socket/...) that is
  // constructed in Rust and never goes near the DXF importer, and `Plant` picks
  // a deliberate defect. Both exist for the gates. An operator picks a DRAWING;
  // the samples in the Drawing panel are real DXF files that take the same path
  // through the code a user's own file does.
  const showFixtures =
    typeof window !== 'undefined' &&
    (new URLSearchParams(window.location.search).has('plants') ||
      new URLSearchParams(window.location.search).has('fixtures'));
  const showPlants = showFixtures;
  /* Restored if it was ever stored — which means the OS preference is only
   * consulted on a first visit or after Discard. Deliberate: the toggle is a
   * choice somebody made, and an OS that flips at dusk should not undo it. */
  // dark — migrated to Zustand store

  // Machine + Operation state from Zustand store
  const {
    depthPerPass, rpm, entry, direction, dogbone,
    tabsEnabled, tabHeight, tabWidth, tabSpacing,
    finishAllowance, leadMm, probeAfterChange,
    useWorkpieceEdge, workpieceEdgeTol,
    travelX, setTravelX,
    travelY, setTravelY,
    travelZ, setTravelZ,
    safeZ, setSafeZ,
    colletMm, setColletMm,
    spindleMax, setSpindleMax,
    probeEnabled, setProbeEnabled,
    touchPlateMm, setTouchPlateMm,
    supportsArcs, setSupportsArcs,
    touchPlateId, setTouchPlateId,
    stockX, setStockX,
    stockY, setStockY,
    thickness, setThickness,
    zZeroTop, setZZeroTop,
    originX, setOriginX,
    originY, setOriginY,
    rotation, setRotation,
    material, setMaterial,
    workpieceMaterialFacet, setWorkpieceMaterialFacet,
    toolIds, setToolIds,
    extraTools, setExtraTools,
    clamps, setClamps,
    confirmedClear, setConfirmedClear,
    workholdingIds, setWorkholdingIds,
    ready, setReady,
    loadError, setLoadError,
    ver, setVer,
    jobs, setJobs,
    plants, setPlants,
    lib, setLib,
    inventory, setInventory,
    inventoryDropped, setInventoryDropped,
    inventoryError, setInventoryError,
    inventoryImport, setInventoryImport,
    inventoryImportRefused, setInventoryImportRefused,
    inventoryWriteError, setInventoryWriteError,
    job, setJob,
    plant, setPlant,
    dark, setDark,
    aboutOpen, setAboutOpen,
    jobNote, setJobNote,
    showRapids,
    busy, setBusy,
    restoreDismissed, setRestoreDismissed,
    progress, setProgress,
    playing, setPlaying,
    speed, setSpeed,
    clockShown, setClockShown,
    simCell, setSimCell,
    report: reportStore, setReport,
    showGcode, setShowGcode,
    reportW, setReportW,
    adviceFilter, setAdviceFilter,
    drawingFitFilter, setDrawingFitFilter,
    pickedWorkpiece, setPickedWorkpiece,
    sectionZ, setSectionZ,
    plannedFrom, setPlannedFrom,
    meshLoadError, setMeshLoadError,
    heldProgram, setHeldProgram,
    streamSignal, setStreamSignal,
    drawingNote, setDrawingNote,
    sampleNote, setSampleNote,
    loadedMachine, setLoadedMachine,
    loadedWorkpiece, setLoadedWorkpiece,
    drawings, setDrawings,
    selected, setSelected,
    activeWorkpiece, setActiveWorkpiece,
    ctxMenu, setCtxMenu,
    dropped,
    layers,
    projection,
    restored,
    saveError, setSaveError,
    unit,
  } = useCncStore();
  // Function-updater aliases — Zustand's simple setters don't support
  // (prev) => newValue, so we wrap them. These read the current value
  // from the store and apply the updater function.
  const setRestoredList = (fn: (prev: string[]) => string[]) => {
    useCncStore.setState({ restored: fn(useCncStore.getState().restored) });
  };
  const updateDrawings = (fn: (prev: LoadedDrawing[]) => LoadedDrawing[]) => {
    useCncStore.setState({ drawings: fn(useCncStore.getState().drawings) });
  };
  const updateSelected = (fn: (prev: number) => number) => {
    useCncStore.setState({ selected: fn(useCncStore.getState().selected) });
  };
  const updateLayers = (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    useCncStore.setState({ layers: fn(useCncStore.getState().layers) });
  };
  const report = reportStore as Report | null;

  // Machine
  /* The three defaults come from `DEFAULT_TRAVEL_MM` rather than from literals,
   * because `SPOILBOARD_RESTORE` compares the board's fingerprint against
   * exactly these numbers. See that constant. */
  // Machine state (travel, safeZ, collet, spindleMax, probe, touchPlate, supportsArcs)
  // — migrated to Zustand store (cncStore.ts)

  /* Spoilboard — the SACRIFICIAL MATERIAL under the work, and where it is
   * bolted. (§2 retires "the sacrificial sheet" by name: a SHEET is a published
   * stock size in a catalogue and this is not one.)
   *
   * 🔴 NOTHING FILLS ANY OF THESE IN. The core's
   * catalogue ships `"default_id":null` explicitly, and says why: an
   * over-declared board — one asserted larger, or nearer the datum, than the
   * real board — tells the check *"there is sacrificial material here"* about
   * bare frame, so a cut that reaches an extrusion reports as an intended
   * through-cut. **Under-declaring costs a false red; over-declaring reaches
   * the machine.** A default is an over-declaration waiting for the one user
   * whose board is smaller.
   *
   * ⚠ `''` on the position fields means NOT DECLARED and the key is OMITTED, in
   * the same way and for a stronger reason than `touchPlateMm` above: `0,0` is a
   * PLAUSIBLE position, and a plausible number runs. It slides the declared
   * board toward the datum, which turns bare rail into declared spoilboard. Text
   * inputs, not `type="number"`, so blank survives as blank.
   *
   * 🔴 `spoilboardId` is THREE-VALUED: `''` = no board declared (the opening
   * state), `SPOILBOARD_CUSTOM` = a board this lane has never seen, measured by
   * the shop, and anything else is a CATALOGUE ID. The two forms are mutually
   * exclusive in the core — declaring both installs NOTHING — so the config
   * builder below sends one or the other and never both.
   *
   * 🔴 THEY OPEN FROM THE STORED SESSION SINCE 2026-08-11 (TODO #89), AND THAT
   * IS NOT A DEFAULT BEING INVENTED. What comes back is what a person put
   * there, through `SPOILBOARD_RESTORE`, which validated every field and
   * dropped by name what it could not. A board that was never declared restores
   * as never declared, and an empty session opens exactly as it always did. The
   * defect fixed here is the opposite one: the declaration was DROPPED on every
   * refresh, so an operator who HAD declared a board silently lost the
   * distinction between *over the sacrificial board* and *into the machine
   * frame* — the failure that reverts to UNCHECKED, costs a false pending
   * rather than a false green, and is therefore invisible on the panel. */
  const {
    spoilboardId, setSpoilboardId,
    spoilboardX, setSpoilboardX,
    spoilboardY, setSpoilboardY,
    spoilboardSizeX, setSpoilboardSizeX,
    spoilboardSizeY, setSpoilboardSizeY,
    spoilboardThickness, setSpoilboardThickness,
    spoilboardSaveNote, setSpoilboardSaveNote,
    spoilboardName, setSpoilboardName,
    spoilboardPos, setSpoilboardPos,
    spoilboardTravels, setSpoilboardTravels,
    spoilboardMachineNote, setSpoilboardMachineNote,
    spoilCat, setSpoilCat,
    spoilboardInPlay,
    stampSpoilboardMachine,
    reconcileSpoilboardWithMachine,
  } = useSpoilboardState(SPOILBOARD_RESTORE as SpoilboardRestore, travelX, travelY, travelZ);

  // Stock — migrated to Zustand store

  // ── MULTIPLE WORKPIECES — TODO #64 ─────────────────────────────────────
  //
  // 🔴 PHASE 1: multiple workpieces on the table, each at its own position.
  // Shared: material, thickness, zZeroTop. Per-workpiece: size, position,
  // rotation, drawings.
  //
  // The existing flat state (stockX, stockY, originX, originY, rotation,
  // drawings) remains as the ACTIVE workpiece's view. The workpieces array
  // holds all of them; switching the active index saves the current state
  // into the old workpiece and loads from the new one.
  //
  // 🔴 PLANNING: only the ACTIVE workpiece is planned. Phase 2 (future)
  // would plan all workpieces and combine G-code with safe rapids between
  // them. Today, switching workpieces triggers a re-plan.
  interface Workpiece {
    stockX: number;
    stockY: number;
    originX: number;
    originY: number;
    rotation: number;
    drawings: LoadedDrawing[];
  }
  const [workpieces, setWorkpieces] = useState<Workpiece[]>(() => {
    const wps = R.workpieces;
    if (Array.isArray(wps) && wps.length > 1) {
      return wps.map((wp) => ({
        stockX: wp.stockX ?? 600,
        stockY: wp.stockY ?? 900,
        originX: wp.originX ?? 0,
        originY: wp.originY ?? 0,
        rotation: wp.rotation ?? 0,
        drawings: [] as LoadedDrawing[],
      }));
    }
    return [{
      stockX: R.stockX ?? 600,
      stockY: R.stockY ?? 900,
      originX: R.originX ?? 0,
      originY: R.originY ?? 0,
      rotation: R.rotation ?? 0,
      drawings: [] as LoadedDrawing[],
    }];
  });
  // activeWorkpiece — migrated to Zustand store

  /* Where the operator has dragged the LOADED OBJECT on the sheet, mm.
   *
   * 🔴 NOT the datum. `originX/originY` move the WORKPIECE on the MACHINE and
   * take the work's relationship to the clamps — and to a touch plate hooked
   * over its corner — with them. This moves the part ON the workpiece and
   * leaves the workpiece where it is. Both reach the emitted coordinates; only one of them moves the
   * datum, and the core keeps them apart for that reason
   * (`Stock::place` vs `Job::place`).
   *
   * Founder, 2026-08-09: *"why I can't move the loaded object in the board?"* */
  /* NOT initialised from the stored blob: a material name means the core's
   * chipload factor, depth-of-cut ratio and rpm cap, and it is only a real
   * setting if the library still carries it. Restored in the load effect once
   * the library has arrived, or dropped and named. */
  // material — migrated to Zustand store
  /* ── WHICH WORKPIECE RECORD THE OPERATOR CHOSE ─────────────────────────────
   *
   * 🔴 NOT DERIVED FROM THE NUMBERS, and it cannot be. The workpiece picker's
   * tick is computed by matching `stockX`/`stockY` against the sheet catalogue,
   * unordered — several rows can match at once and a SAVED workpiece never ticks
   * at all (its own comment says why). That is fine for a tick and useless for
   * this question, because "which record is in the job" is what decides whether
   * there are two material answers to reconcile.
   *
   * `null` means the workpiece is AD-HOC — typed dimensions, no record behind
   * them — which is the common case and, per `jobMaterial.ts`, is NOT a conflict:
   * nothing states a second material, so there is nothing to disagree with.
   *
   * ⚠ Cleared when the operator edits Size X / Size Y / Thickness by hand. Those
   * are the numbers the record set; once one of them is typed over, the record
   * has stopped describing what is on the bed and naming it in a conflict
   * sentence would point at the wrong object. */
  // pickedWorkpiece — migrated to Zustand store
  /** The facet the workpiece list is narrowed by. `''` = every row, and it opens
   *  there: a list that arrives pre-narrowed by a rule nobody chose is the same
   *  defect as a default selection, one control along. */
  // workpieceMaterialFacet — migrated to Zustand store

  // Tooling
  // NOTE: the tool CATEGORY is no longer a filter. It rides on each tool in the
  // list and is matched by the search box, so there is no category state to
  // hold — see the comment where the dropdown used to be.
  /* The tools this job may use. A SET, not one tool.
   *
   * The core assigns them PER FEATURE (`recommend`): a hole gets a drill that
   * matches it exactly, a profile gets an end mill that clears its depth and
   * fits the corners. One tool in the set behaves exactly as the old single
   * `tool_id` did — that equivalence is asserted by a test in `job.rs`, because
   * it is the regression that would otherwise go unnoticed. */
  /* 🔴 NOT initialised from the stored blob, and this is the single most
   * important line in the restore. A tool id the library does not hold does NOT
   * fail loudly in the core: `fixtures.rs:2314` takes an `unwrap_or_else` branch
   * and silently substitutes a Ø6mm end mill, then plans feeds, depths, pass
   * counts and a whole postable program around a cutter nobody picked. So the
   * app opens on its default and the stored selection is applied only after the
   * library has arrived and every id in it has been checked — and `replan` does
   * nothing until then, so the planner never sees an unvalidated one. */
  // toolIds, extraTools — migrated to Zustand store
  const toolId = toolIds[0] ?? '';

  // Operation + Machine — migrated to Zustand store (cncStore.ts)
  // (values already destructured above from useCncStore)

  /* **Leave an outline edge that lies on the workpiece edge UNCUT.**
   *
   * 🔴 OPENS OFF, AND IT IS NOT RESTORED FROM THE SESSION EITHER. Turning it on
   * changes WHAT GEOMETRY GETS CUT away from what the drawing says, and it does
   * so on the strength of three things about the physical setup — that the
   * workpiece edge is straight and square, that the part's dimension on that
   * side may be the material supplier's tolerance, and that the datum on that
   * side is wherever the workpiece actually is. Those are claims about the
   * material on the table TODAY. Restoring the switch would assert them in a
   * session where nobody looked, which is the same argument that keeps
   * `confirmedClear` unrestored one block below. The TOLERANCE would be safe to
   * keep; a tolerance restored without its switch is a stored preference nobody
   * can see, so neither is. */
  // useWorkpieceEdge, workpieceEdgeTol — migrated to Zustand store

  // Fixturing
  // clamps, confirmedClear, workholdingIds — migrated to Zustand store

  /* Which touch plate is fitted. `''` = none chosen. Selecting one FILLS the
   * `Plate top` field from its published figure; it never invents one. */
  // touchPlateId — migrated to Zustand store

  // View
  /* ---- Timed playback -----------------------------------------------------
   *
   * 🔴 NONE OF THIS STATE REACHES THE PROGRAM, and that is structural rather
   * than a promise: `playing`, `speed` and the clock below appear in no
   * dependency list of `config` and none of `replan`, so no amount of pressing
   * play can re-plan, re-feed or re-post anything. `progress` — which playback
   * drives — has never been a plan input either; it is a draw-up-to index.
   * The only thing a speed multiplier scales is wall-clock.
   */
  /* Program-time position of the playhead, in seconds. Held in a ref because it
   * advances every animation frame and almost none of those frames should
   * re-render anything — see the two setState calls in the loop, both guarded. */
  const clockRef = useRef(0);
  /* The clock as SHOWN. Deliberately a coarser signal than `clockRef`: it moves
   * once per displayed second, so a 60fps loop does not re-render the app 60
   * times a second to redraw a label that changes once. */
  // Rapids visibility. The setter went with the bottom bar; the TOP row owns
  // this now, and the state stays so the viewport keeps receiving it. Deleting
  // the state to silence the unused-setter warning is the tidy-looking change
  // that turns rapids on permanently and removes the control from the app.
  // showRapids — migrated to Zustand store

  // An imported drawing REPLACES the reference job. Keeping both live would
  // leave the operator unsure which one the G-code came from.
  /* A loaded drawing. `bytes` for a file the user dropped in (a mesh cannot
   * survive a text round trip); `text` for the built-in samples, which are DXF
   * source held in the bundle. One of the two is always present. */
  /* `origin` exists ONLY so a refresh can find this drawing again, and it is a
   * tag rather than a lookup by name for a reason: a saved drawing named the
   * same as a shipped sample would otherwise resolve to the sample, and the
   * operator would get a different part under a name they recognised. `'file'`
   * is the origin that CANNOT be restored — bytes opened from disk are not kept
   * by this app — and the banner says exactly that, by name, rather than
   * quietly opening with no drawing. */
  /* 🔴 A LIST since 2026-08-10 — founder: *"I should able to add more than 1
   * drawings, I should able to rotate the drawings"*. Each entry carries its own
   * PLACEMENT: an offset in workpiece millimetres that is a DELTA from where the
   * drawing was drawn (so `[0,0]` is as drawn) and a rotation about the
   * drawing's own lower-left corner.
   *
   * 🔴 The placement lives HERE, on the drawing, and not in one pair of panel
   * fields, because with two drawings on the sheet a single pair could only ever
   * describe one of them — and the panel would read as if it described the job.
   * `partX`/`partY` below are a VIEW of the selected entry, not a second store.
   *
   * The core plans every one of these through `planImportMany`, which places
   * them, checks EVERY PAIR for shared material and cutter clearance, and
   * refuses the whole sheet with no G-code if any pair is condemned. */
  type LoadedDrawing = {
    /**
     * 🔴 **THIS COPY**, not this drawing — founder 2026-08-10: *"Drawing: Able
     * to add more than 1 from the same drawing"*. Two copies of one file are two
     * parts with two placements; anything keyed on `origin:name` collapses them,
     * and the collapse is silent — the second copy vanishes, or both move
     * together.
     *
     * It is also the name the emitted program calls this part
     * (`<instance>/<part>`), so it is READABLE rather than a serial number: a
     * refusal that names `d2/part1` is a refusal about a part the operator
     * cannot find on screen. Copies are `Hive super end #2`, `#3`, …
     *
     * ⚠ It carries no `(` or `)` and no ` [`. A paren in a name ends a G-code
     * comment and the rest executes (gate G5 — the post neutralises it, which
     * would then make the id in the program differ from the id in the refusal),
     * and ` [` is where the tool name starts in an operation comment, which is
     * how a reader and every parser find the end of the part name.
     */
    instance: string;
    bytes?: Uint8Array;
    text?: string;
    format: 'dxf' | 'svg' | 'stl' | 'auto';
    name: string;
    origin: DrawingOrigin;
    /**
     * 🔴 CARRIED, so that saving a loaded CAD model back does not STRIP IT.
     * `readDrawingRow` spreads the stored record into this shape, so the payload
     * arrives here on its own; declaring it is what makes `currentDrawing()`
     * able to hand it back. Without both halves, "Save" on a row that came from
     * `2bee.cad` writes a mesh with no source — the design silently destroyed by
     * the button that was meant to keep it.
     */
    cad?: CadPayload;
    /** Delta from as-drawn, sheet mm. */
    offset: [number, number];
    /** Degrees anticlockwise about this drawing's own lower-left corner. */
    rotation: number;
  };
  // drawings — migrated to Zustand store
  /**
   * A unique, readable id for a NEW copy of `name`.
   *
   * 🔴 Readable rather than a serial number, because this string is what the
   * emitted program calls the part and what a refusal names. `#2`, `#3`, … and
   * NOT `(copy 2)`: a paren in a name ends a G-code comment and the rest
   * executes, so the post neutralises it — and a neutralised id in the program
   * no longer matches the id in the refusal beside it.
   *
   * Uniqueness is checked against the ids actually taken, not against a counter,
   * because two DIFFERENT drawings can share a name across surfaces (a shipped
   * `Hive super end` and a saved one), and because a counter drifts the moment
   * anything is removed.
   */
  const mintInstance = (name: string, taken: Iterable<string>) => {
    const used = new Set(taken);
    const base = name.replace(/[()[\]]/g, '').trim() || 'drawing';
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
      const id = `${base} #${n}`;
      if (!used.has(id)) return id;
    }
  };


  /* Which drawing the viewport drag, the Part X/Y fields and the section-Z box
   * are about. An INDEX into `drawings`, clamped on every read: a stale index
   * after a removal would silently edit a different part's placement. */
  // selected — migrated to Zustand store
  /* 🔴 THE SELECTED DRAWING, derived and never stored twice. Everything that
   * shows or edits ONE drawing — the viewport's part drag, the format badge, the
   * save-to-store button, the mesh section Z — reads this, so there is exactly
   * one answer to "which drawing is the panel talking about". */
  /** The clamped selection for a GIVEN list — used by callbacks that fire after
   *  a removal may have shortened it. A stale index would edit another part. */
  const selectedIndexOf = (ds: LoadedDrawing[]) =>
    ds.length ? Math.min(selected, ds.length - 1) : -1;
  const sel = selectedIndexOf(drawings);
  const imported: LoadedDrawing | null = sel >= 0 ? drawings[sel] : null;
  const setImported = useCallback(
    (d: LoadedDrawing | null) => {
      // The single-drawing entry point kept for the file-open path: opening a
      // file REPLACES the sheet, which is what dropping a file has always done.
      setDrawings(d ? [d] : []);
      setSelected(0);
    },
    []
  );

  /* 🔴 A VIEW OF THE SELECTED DRAWING'S OFFSET, not a second store of it.
   *
   * These two used to be the job-level `drawing_offset` — ONE offset for the
   * whole sheet — and with several drawings on the sheet that could only ever
   * describe one of them while reading as though it described the job. They now
   * read and write `drawings[sel].offset`, which is the same number the row in
   * the Drawing list shows and the same number the viewport drag writes. One
   * place the placement lives, so the panel, the picture and the program cannot
   * disagree about where a part is.
   *
   * ⚠ With no drawing loaded they read 0 and writing them does nothing — there
   * is no part to move. That is deliberately not an editable 0: a field that
   * accepts a number and moves nothing is this lane's most-repeated defect. */
  const partX = imported?.offset[0] ?? 0;
  const partY = imported?.offset[1] ?? 0;
  const movePart = useCallback(
    (x: number, y: number) => {
      updateDrawings((ds) =>
        ds.map((d, i) => (i === selectedIndexOf(ds) ? { ...d, offset: [x, y] as [number, number] } : d))
      );
    },
    // `selectedIndexOf` reads the CLAMPED index off the list it is given rather
    // than closing over `sel`, so a removal between render and click cannot
    // move a different drawing than the one on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected]
  );
  const setPartX = useCallback((x: number) => movePart(x, partY), [movePart, partY]);
  const setPartY = useCallback((y: number) => movePart(partX, y), [movePart, partX]);
  /* 🔴 MOVE ONE NAMED DRAWING — the viewport's per-instance drag lands here.
   *
   * Keyed on the INSTANCE, never on an index: the viewport reads the id off the
   * object the ray hit, and that id is the one the core names the part with, so
   * the part under the pointer and the placement that changes are the same part
   * by construction. An index would agree only for as long as the row order and
   * the scene order happened to match.
   *
   * ⚠ ONE WRITE, BOTH AXES, NO CAPTURED STATE. This is the exact shape that was
   * got wrong in `4ae2615c23`: `onPartMove={(x, y) => { setPartX(x); setPartY(y); }}`
   * called two single-axis setters over ONE stored pair, and the second write
   * discarded the first from a stale closure — Part X could never move. A
   * per-instance handler is the same trap one step along, so this takes the pair
   * together, updates functionally, and closes over nothing at all (`[]`). */
  const movePartAt = useCallback((instance: string, x: number, y: number) => {
    updateDrawings((ds) =>
      ds.map((d) => (d.instance === instance ? { ...d, offset: [x, y] as [number, number] } : d))
    );
  }, []);
  /* What the viewport needs to know about each placed drawing: the id the
   * PROGRAM calls its parts by, and where that drawing currently sits.
   *
   * ⚠ MEMOISED because it is in the viewport's scene-effect dependency list. A
   * fresh literal per render would rebuild the 3D scene on every render — the
   * identity churn that broke the sheet drag once already (see the
   * `partOffsetX`/`partOffsetY` note in `Viewport.tsx`). It recomputes exactly
   * when `drawings` changes, which is exactly when the scene must. */
  const partInstances = useMemo(
    () => drawings.map((d) => ({ instance: d.instance, offset: d.offset })),
    [drawings]
  );
  /* The Z a mesh is sectioned at. `null` = NOBODY CHOSE ONE, which is a
   * different fact from any number and is why it is not a `number` with a
   * "sensible" default: the core then sections at mid-height and says, in its
   * own words on the report, that the Z was CHOSEN FOR YOU. A default here
   * would turn its guess into our setting. */
  // sectionZ — migrated to Zustand store

  // ── UNDO — TODO #69 ──────────────────────────────────────────────────────
  //
  // A one-level undo for setup changes. The CNC tab has many independent state
  // variables (stock, datum, material, tools, clamps, drawings), and each one
  // has its own setter. Rather than wrapping every setter, we capture a SNAPSHOT
  // of the whole setup before a significant change and restore it on Ctrl-Z.
  //
  // 🔴 ONE LEVEL, NOT A STACK. The CAD tab's `replace.ts` documents why:
  // browser-native Ctrl-Z in a textarea already handles typing undo; this
  // handles the setup-level changes (picking a tool, moving the datum, etc.)
  // that the browser cannot undo. One level is enough for "I didn't mean to
  // change that" — deeper history is a different feature.
  //
  // 🔴 WHAT IS CAPTURED: everything that affects the emitted program. View-only
  // state (playing, speed, progress, layers) is deliberately excluded — undoing
  // a playback speed change would be surprising.
  type SetupSnapshot = {
    stockX: number; stockY: number; thickness: number;
    originX: number; originY: number; rotation: number;
    material: string; toolIds: string[];
    clamps: ClampCfg[]; drawings: LoadedDrawing[];
    sectionZ: number | null;
  };
  const undoStack = useRef<SetupSnapshot[]>([]);
  const pushSnapshot = useCallback(() => {
    undoStack.current.push({
      stockX, stockY, thickness,
      originX, originY, rotation,
      material, toolIds: [...toolIds],
      clamps: clamps.map((c) => ({ ...c })),
      drawings: drawings.map((d) => ({ ...d, offset: [...d.offset] as [number, number] })),
      sectionZ,
    });
    // Cap at 10 entries to avoid unbounded memory growth.
    if (undoStack.current.length > 10) undoStack.current.shift();
  }, [stockX, stockY, thickness, originX, originY, rotation, material, toolIds, clamps, drawings, sectionZ]);
  const undoSetup = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    setStockX(snap.stockX);
    setStockY(snap.stockY);
    setThickness(snap.thickness);
    setOriginX(snap.originX);
    setOriginY(snap.originY);
    setRotation(snap.rotation);
    setMaterial(snap.material);
    setToolIds(snap.toolIds);
    setClamps(snap.clamps);
    setDrawings(snap.drawings);
    setSectionZ(snap.sectionZ);
  }, []);

  // ── WORKPIECE ACTIONS — TODO #64 ────────────────────────────────────────
  // Placed after drawings/pushSnapshot because they reference both.
  // saveActiveWorkpiece() was removed — it modified workpieces, which is in
  // replan's dependency list, creating an infinite loop. State is saved inline
  // in switch/add/remove instead.

  /** Switch to a different workpiece, saving the current one first. */
  const switchWorkpiece = useCallback((idx: number) => {
    if (idx === activeWorkpiece || idx < 0 || idx >= workpieces.length) return;
    pushSnapshot();
    setWorkpieces((ws) => ws.map((w, i) =>
      i === activeWorkpiece
        ? { ...w, stockX, stockY, originX, originY, rotation, drawings }
        : w
    ));
    const wp = workpieces[idx];
    setStockX(wp.stockX);
    setStockY(wp.stockY);
    setOriginX(wp.originX);
    setOriginY(wp.originY);
    setRotation(wp.rotation);
    setDrawings(wp.drawings);
    setSelected(0);
    setActiveWorkpiece(idx);
  }, [activeWorkpiece, stockX, stockY, originX, originY, rotation, drawings, workpieces, pushSnapshot]);

  /** Add a new workpiece at a default position. */
  const addWorkpiece = useCallback(() => {
    pushSnapshot();
    setWorkpieces((ws) => {
      // Save current state into current workpiece first
      const saved = ws.map((w, i) =>
        i === activeWorkpiece
          ? { ...w, stockX, stockY, originX, originY, rotation, drawings }
          : w
      );
      const next = [...saved, { stockX: 600, stockY: 900, originX: 0, originY: 0, rotation: 0, drawings: [] as LoadedDrawing[] }];
      // Switch to the new workpiece
      setStockX(600); setStockY(900);
      setOriginX(0); setOriginY(0); setRotation(0);
      setDrawings([]); setSelected(0);
      setActiveWorkpiece(next.length - 1);
      return next;
    });
  }, [activeWorkpiece, stockX, stockY, originX, originY, rotation, drawings, pushSnapshot]);

  /** Remove a workpiece. Cannot remove the last one. */
  const removeWorkpiece = useCallback((idx: number) => {
    if (workpieces.length <= 1) return;
    pushSnapshot();
    setWorkpieces((ws) => {
      const next = ws.filter((_, i) => i !== idx);
      if (idx === activeWorkpiece || activeWorkpiece >= next.length) {
        const wp = next[0];
        setStockX(wp.stockX); setStockY(wp.stockY);
        setOriginX(wp.originX); setOriginY(wp.originY);
        setRotation(wp.rotation); setDrawings(wp.drawings);
        setSelected(0); setActiveWorkpiece(0);
      } else if (idx < activeWorkpiece) {
        setActiveWorkpiece(activeWorkpiece - 1);
      }
      return next;
    });
  }, [workpieces.length, activeWorkpiece, pushSnapshot]);

  /* The `name` of the drawing the CURRENT report was planned from, or `null`.
   *
   * 🔴 Exists so a fact taken off the report cannot be printed beside a
   * different file's name. Between `setImported(...)` and the plan landing,
   * `imported` is the NEW file and `report` still describes the OLD one — a
   * window in which "part.stl (DXF)" is renderable and looks authoritative.
   * This lane's rule is to assert on the emitted artefact; the matching rule for
   * a UI is to check the artefact is about the thing you are labelling. */
  // plannedFrom, meshLoadError — migrated to Zustand store
  /* Triangles to ask for when the drawing turns out to be a mesh.
   *
   * 🔴 The mesh is DECLINED by default and this is why: a real 2bee STL runs to
   * 47,328 triangles = 2.17MB per plan at 48 bytes each, and the app re-plans on
   * every setting change. A budget is not politeness, it is the difference
   * between a viewport and a stall. The core reports how many it DELIVERED, not
   * how many were asked for, and a decimated mesh is a different solid — fit for
   * looking at and nothing else. */
  const MESH_BUDGET_TRIS = 20_000;
  /* Display cell for the simulated stock surface. The simulation's own cell is
   * 0.6mm, which on a 600x900 sheet is 1,502,501 samples = 8.0MB of base64 PER
   * PLAN. 3mm is 322KB and is what a viewport can actually draw. The struct
   * reports the resolution it ACHIEVED, so nothing downstream has to guess. */
  const SURFACE_CELL_MM = 3.0;
  /* ── WHAT THE RUN TAB IS HOLDING ────────────────────────────────────────────
   *
   * 🔴 A LATCH, NOT A DERIVATION, AND THAT IS THE WHOLE SAFETY PROPERTY. If this
   * were `runProgramFromReport(report)` evaluated inline, every re-plan would
   * swap the program under the Run tab — its picture, its line total and its
   * remaining estimate would jump to something the machine is not executing,
   * silently, potentially mid-job. Nobody would have chosen that; it would just
   * emerge from where the expression sits.
   *
   * So the Run tab holds what an operator explicitly handed it and NOTHING in
   * this tab changes it. A newer plan is reported as newer (`heldVerdict`) and
   * the hand-over is a second deliberate act.
   *
   * ✅ **CORRECTED 2026-08-11 — THE PARAGRAPH THAT STOOD HERE IS FALSE IN ALL
   * FOUR OF ITS LIMBS, AND IT IS KEPT VISIBLE RATHER THAN DELETED.** It read:
   *
   *   > *"this app cannot tell whether a stream is running, so it cannot REFUSE
   *   > a hand-over during one. `RunTab` exposes no streaming state upward, its
   *   > `sender` prop is fed by nobody, and its `Start` control is not wired to
   *   > the streamer's load/start — so today the Run tab cannot stream at all.
   *   > The guarantee delivered is 'never silently', not 'never'."*
   *
   * What changed it: `RunTab` now exports `StreamingSignal` and calls
   * `onStreaming` with it; `sender` defaults to the live connection's own
   * accounting, fed by the worker's `stream` events; and `Start` is wired
   * through `wiredActions` to `conn.startJob`. So the fact IS observable, the
   * hand-over IS refused during a stream (below), and the guarantee is now
   * **"never during a stream this tab is feeding, and never silently otherwise"**.
   *
   * 🔴 AND THE REMAINING LIMIT IS A DIFFERENT ONE, NOT A WEAKER VERSION OF THE
   * OLD. `streaming === false` is **not** *"the machine is stopped"*. It means
   * this tab is not feeding lines. The controller still holds everything already
   * sent — up to a full RX buffer — and executes it with the spindle turning;
   * after a lost link it is *especially* not stopped, because nothing was told to
   * stop. A stale 🔴 lies exactly like a stale ✅, and this one would have kept a
   * finished job open while hiding the limit that actually survives. */
  // heldProgram, streamSignal, drawingNote — migrated to Zustand store
  // storeNote state moved to SavedDataPanel component
  /* A refusal the SAVE path can produce that the store never sees — "there is no
   * a driver and, more importantly, to a person who lost the dialog. */
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importToolsRef = useRef<HTMLInputElement | null>(null);
  // What the chosen sample is FOR. Two of the three exist to demonstrate a
  // refusal, and a sample that refuses reads as broken unless it says so first.
  // sampleNote, busy — migrated to Zustand store

  /* ---- The G-code listing's own box ----------------------------------------
   *
   * Founder, 2026-08-11: *"able to resize the `Open one of these into the
   * editor` and all other lists vertically and horizontally"*. The pickers are
   * the lists he named; this is the other one in this tab — a program is a list
   * of lines, and `.gcode` capped it at a hard 320px, so reading a 4,000-line
   * program meant scrolling a box eighteen rows tall next to a mostly empty
   * column.
   *
   * ⚠ IT IS THE SAME PRIMITIVE THE PICKERS USE, and that is the point of it
   * being a primitive: an in-flow block in a scrolling column and a centred
   * fixed dialog differ by two option values (`anchor`, the floors) and by
   * nothing else. If this had been written here instead, it would be the second
   * resize in the app and the one that forgot a floor.
   *
   * 🔴 NO CANVAS IS INVOLVED. This box lives in the report column, which is its
   * own grid track — growing it does not change the 3D canvas's width or height,
   * so `Viewport`'s own `ResizeObserver` has nothing to observe and three.js is
   * never told anything. Dragging it wider than the column simply scrolls the
   * column, which `.report` already does. */
  const gcodeBox = useResizable({
    id: 'panel-gcode-view',
    minWidth: 200,
    /* A floor of five or six lines at 11.5px/1.4 — below that the box costs more
     * in chrome than it shows in program. */
    minHeight: 96,
  });

  /* ---- The report column's width, dragged and remembered -------------------
   *
   * 🔴 THIS IS A WINDOW PREFERENCE, NOT MACHINING STATE, and it deliberately
   * does NOT go through `store.ts`. That module holds the SESSION — feeds,
   * depth of cut, the datum, the clamps — and it validates every field it
   * restores because a stale number there cuts a wrong part. A panel width
   * cannot cut anything, so putting it in the same blob would (a) make an
   * export of "your setup" carry the size of a sidebar and (b) add a field to a
   * validator whose whole job is to be suspicious of machining values. Same
   * reasoning, same medium and the same wrapping as `ObjectPicker`'s
   * `2bee.picker.size.*` — a browser with storage disabled gets the default
   * width and nothing else changes, so every access is wrapped.
   *
   * ⚠ Clamped on READ as well as on write. A width saved on a wide monitor and
   * restored on a laptop would otherwise leave the 3D stage a few pixels wide,
   * which reads as a broken app rather than as a remembered preference. */
  const REPORT_W_KEY = '2bee.app.report.width';
  const REPORT_W_DEFAULT = 320;
  const REPORT_W_MIN = 220;
  /* The stage keeps at least this much. `.side` is 290px in `styles.css`, so
   * the widest the report may be is "everything except the left column and a
   * usable viewport" — computed, never hardcoded to a screen size. */
  const STAGE_W_MIN = 320;
  const clampReportW = useCallback((w: number) => {
    const room =
      typeof window === 'undefined' ? Infinity : window.innerWidth - 290 - STAGE_W_MIN;
    return Math.round(Math.max(REPORT_W_MIN, Math.min(w, Math.max(REPORT_W_MIN, room))));
  }, []);
  // reportW — migrated to Zustand store
  /* Saved on every change rather than only on pointer-up: a size that is applied
   * but never saved, and one that is saved but never applied, both LOOK like the
   * feature working right up until the second time the page is opened. */
  useEffect(() => {
    try {
      localStorage.setItem(REPORT_W_KEY, JSON.stringify({ w: reportW }));
    } catch {
      /* storage disabled: the width simply is not remembered. */
    }
  }, [reportW]);
  /* Re-clamped when the WINDOW changes too, not only when the width is read.
   * Clamping on read alone covers a reload on a smaller screen and misses the
   * live case — dragging the browser narrower, or opening dev tools — which
   * would squeeze the 3D stage to nothing while the report stayed at a width
   * nobody could see was now illegal. */
  useEffect(() => {
    const onResize = () => { const s = useCncStore.getState(); s.setReportW(clampReportW(s.reportW)); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampReportW]);
  /* The drag. Pointer capture, so a fast drag that leaves the 6px handle keeps
   * resizing instead of stopping dead — and so the release is heard even if it
   * happens over the 3D canvas, which has its own pointer handlers. */
  const startReportResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = reportW;
      const el = e.currentTarget;
      el.setPointerCapture?.(e.pointerId);
      // Dragging LEFT widens the panel: the handle is on its left edge, so the
      // panel follows the pointer rather than mirroring it.
      const move = (ev: PointerEvent) => setReportW(clampReportW(w0 - (ev.clientX - x0)));
      const end = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    },
    [reportW, clampReportW]
  );

  /* ---- The restore, as the operator has to be able to check it -------------
   *
   * 🔴 ANNOUNCED, NOT SILENT, and that is a safety decision rather than a
   * preference. These values set depth of cut, spindle speed, rapid height, tab
   * retention and probe behaviour. An operator who does not know the numbers on
   * the panel came from last session has no reason to read them, and a stale
   * setup under a fresh-looking form is the failure mode this lane exists to
   * prevent. So the banner states what came back, what did not, and why — and it
   * is dismissed by a click, never by a timer.
   *
   * It grows AFTER first paint: the tool library and the drawing both arrive
   * asynchronously, so their verdicts are appended rather than known up front.
   */
  // restored, dropped, saveError — migrated to Zustand store
  // restoreDismissed — migrated to Zustand store
  /* 🔴 A write that FAILED is shown. A browser with storage disabled or full
   * stops keeping the setup while looking exactly like one that is keeping it,
   * and the operator finds out by rebuilding the shop after the next refresh. */
  // saveError — migrated to Zustand store
  const addDropped = useCallback(
    (d: DroppedField[]) => d.length && useCncStore.getState().setDropped([...useCncStore.getState().dropped, ...d]),
    []
  );

  useEffect(() => {
    (async () => {
      try {
        /* 🔴 `toolLibraryFor`, not `toolLibrary`, and the restore is why: the
         * unfiltered library carries no `fit`/`selectable` verdict, so a
         * restored tool could only have been checked for EXISTENCE, never for
         * whether the collet now fitted can hold it — and the collet is itself a
         * restored value, which makes that pairing exactly what a restore gets
         * wrong. `colletMm` here is the restored one: this effect has no deps
         * and closes over the value the `useState` initialiser above already
         * put in place. (The collet-change effect below re-fetches the same
         * library on first run; that is a duplicate request, not a second
         * source of truth.) */
        const [v, j, p, t, sb] = await Promise.all([
          version(),
          listJobs(),
          listPlants(),
          toolLibraryFor(colletMm, SPARE_COLLETS_MM),
          /* The spoilboard catalogue, from the CORE. Fetched here with the tool
           * library and for the same reason: it is a list of physical objects
           * with sources, and a second copy in TypeScript would drift silently.
           * ⚠ NOTHING is selected from it — `default_id` is `null` and this app
           * honours that. */
          spoilboardCatalogue(),
        ]);
        setVer(v);
        setJobs(j);
        setPlants(p);
        setLib(t);
        setSpoilCat(sb);

        /* 🔴 THE LIBRARY-BOUND RESTORE HAPPENS HERE, BEFORE `ready`, and the
         * ordering is the whole guard. `replan` refuses to run until `ready`,
         * and React 18 batches these updates into one commit, so the first plan
         * this app ever computes already has a CHECKED tool set and a material
         * the library holds. Applying them one render later would hand the core
         * an id it silently substitutes a Ø6mm end mill for. */
        if (RESTORED.status === 'ok') {
          const lb = validateLibraryBound(RESTORED.raw, t.tools, t.materials ?? []);
          if (lb.toolIds) setToolIds(lb.toolIds);
          if (lb.material) setMaterial(lb.material);
          if (lb.restored.length) setRestoredList((prev) => [...prev, ...lb.restored]);
          addDropped(lb.dropped);
        }
        setReady(true);
      } catch (e) {
        // 🔴 A failed load is SHOWN, not swallowed. A blank viewport with a
        // silent console error is indistinguishable from an empty program.
        setLoadError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount.
  }, []);

  /**
   * Put the drawing back — as a REFERENCE resolved against what actually exists.
   *
   * 🔴 The blob stores a name and an origin, never the bytes. A DXF is text and
   * a real one runs to megabytes; a mesh sample is 350 kB before it is decoded.
   * Copying either into the session blob would be a second copy of a thing the
   * `drawings` collection already holds, in a store that fails by THROWING
   * mid-write.
   *
   * ⚠ The consequence is stated rather than hidden: **a file opened from disk
   * and never saved cannot come back**, because this app never kept it. That is
   * reported by name, with the cure ("save it first"), instead of the app
   * opening with no drawing and leaving the operator to work out why.
   */
  useEffect(() => {
    if (RESTORED.status !== 'ok') return;
    const refs = RESTORED.values.drawings;
    if (!refs || !refs.length) return;
    let live = true;
    (async () => {
      const fail = (reason: string) => live && addDropped([{ field: 'drawings', reason }]);
      /* 🔴 RESOLVED IN ORDER, AND A FAILURE DROPS ONE ENTRY BY NAME — never the
       * sheet. Losing four good drawings because a fifth was deleted from the
       * store is a worse outcome than being told which one went; what must
       * never happen is a SILENT drop, because a sheet that comes back with one
       * fewer part looks exactly like the sheet you left. The ORDER is
       * preserved even when an entry in the middle fails, so the drawings that
       * did come back are still the ones the operator recognises. */
      const back: LoadedDrawing[] = [];
      const restoredNames: string[] = [];
      for (const ref of refs) {
        // The placement travels with the entry, so a drawing that comes back
        // comes back WHERE IT WAS. A restored drawing dropped at the datum
        // would be a placement nobody chose, rendered as one somebody did.
        /* 🔴 The INSTANCE comes back from the blob, not re-minted. Re-minting
         * would rename the operator's copies on every refresh — `Hive super end
         * #3` becoming `#2` because `#2` failed to resolve — and the names in a
         * program they downloaded yesterday would no longer be the names on
         * screen. */
        const place = {
          instance: ref.instance,
          offset: ref.offset_mm,
          rotation: ref.rotation_deg,
        };
        try {
          if (ref.origin === 'sample') {
            const smp = SAMPLES.find((s) => s.name === ref.name);
            if (!smp) {
              fail(`the sample drawing "${ref.name}" is not in this build`);
              continue;
            }
            back.push({ text: smp.text, format: smp.format, name: smp.name, origin: 'sample', ...place });
            if (refs.length === 1) setSampleNote(smp.detail);
            restoredNames.push(ref.name);
            continue;
          }
          if (ref.origin === 'mesh-sample') {
            const m = MESH_SAMPLES.find((s) => s.name === ref.name);
            if (!m) {
              fail(`the mesh sample "${ref.name}" is not in this build`);
              continue;
            }
            // `bytes()` re-derives the triangle count and throws BY NAME on a
            // mismatch. A restore is exactly when that matters: the bytes are
            // being fetched again, from a build that may not be the one that
            // stored the name.
            const bytes = await m.bytes();
            back.push({ bytes, format: 'stl', name: m.name, origin: 'mesh-sample', ...place });
            if (refs.length === 1) setSampleNote(m.detail);
            restoredNames.push(ref.name);
            continue;
          }
          /* `saved` and `file` both look in the store — a file opened from disk
           * and THEN saved is in there under its own name, and refusing to look
           * would report a loss that has not happened. */
          const rec = await loadSaved<{
            bytes?: Uint8Array;
            text?: string;
            format: 'dxf' | 'svg' | 'stl' | 'auto';
            name: string;
          }>('drawings', ref.name);
          if (!rec?.data) {
            fail(
              ref.origin === 'file'
                ? `the drawing "${ref.name}" was opened from a file on disk, which this app does not keep. ` +
                    `Load it again, or save it under Drawing first and it will come back.`
                : `the saved drawing "${ref.name}" is no longer in this browser's store`
            );
            continue;
          }
          back.push({ ...rec.data, name: ref.name, origin: 'saved', ...place });
          restoredNames.push(ref.name);
        } catch (e) {
          fail(
            `the drawing "${ref.name}" could not be reloaded: ${e instanceof Error ? e.message : e}`
          );
        }
      }
      if (!live || !back.length) return;
      setDrawings(back);
      setSelected(0);
      setRestoredList((prev) => [
        ...prev,
        back.length === 1
          ? `drawing "${restoredNames[0]}"`
          : `${back.length} drawings (${restoredNames.join(', ')})`,
      ]);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount.
  }, []);

  /* The one loss that is reported as a NUMBER rather than restored as a value.
   * `extraTools` is an imported JSON tool file whose rows drive feed and rpm,
   * and checking it here would be a second copy of the core's tool rules in
   * TypeScript. Storing the count costs nothing and turns "my imported tools
   * vanished" from something discovered at the machine into a line on the
   * banner naming how many and what to do. */
  useEffect(() => {
    if (RESTORED.status !== 'ok') return;
    const n = RESTORED.values.extraToolsCount ?? 0;
    if (n > 0) {
      addDropped([
        {
          field: 'extraTools',
          reason:
            `${n} tool(s) you had loaded from a file are NOT restored — this app does not keep ` +
            `an imported tool library, because it cannot check one. Import the file again.`,
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount.
  }, []);

  /**
   * Write the setup on every change.
   *
   * 🔴 GATED ON `ready`, and not as an optimisation. `toolIds` and `material`
   * are restored asynchronously; a write before that lands would persist the
   * DEFAULT tool over the operator's stored selection, and the loss would be
   * invisible because the file it overwrote is the only record of it.
   */
  /* 🔴 GATHERED ONCE, CONSUMED TWICE — TODO #108. The effect below writes it to
   * `localStorage` on every change; `File → Save job…` writes the SAME object to
   * a file. A second gathering at the menu would be a second list of fields, and
   * the day they drift the job file silently stops carrying something the reload
   * still does — which is invisible until somebody opens the file on another
   * machine and a setting they can see on their own screen is missing. */
  const sessionValues: SessionValues = useMemo(
    () => ({
      travelX, travelY, travelZ, safeZ, colletMm, spindleMax, probeEnabled,
      touchPlateMm, touchPlateId, supportsArcs,
      /* 🔴 THE BOARD (TODO #89). It was absent from this object, so a reload
       * reverted it to UNDECLARED and every below-the-workpiece cut went back to
       * being judged on depth alone. The strings stay strings — `''` is not
       * entered, `'0'` is a measured zero — and the fingerprint travels with
       * them so the restore can ask whether they still mean anything. */
      spoilboardId, spoilboardX, spoilboardY,
      spoilboardSizeX, spoilboardSizeY, spoilboardThickness, spoilboardName, spoilboardPos,
      /* OMITTED rather than written as `null` when there is none: the rule
       * reads an absent key as "unknown machine", which the guard treats as a
       * mismatch, and that is the honest reading of a corner with no machine. */
      ...(spoilboardTravels ? { spoilboardTravels } : {}),
      stockX, stockY, thickness, zZeroTop, originX, originY, rotation,
      // Multi-workpiece: only persist when there's more than one.
      ...(workpieces.length > 1 ? {
        workpieces: workpieces.map(({ stockX: sx, stockY: sy, originX: ox, originY: oy, rotation: r }) => ({
          stockX: sx, stockY: sy, originX: ox, originY: oy, rotation: r,
        })),
        activeWorkpiece,
      } : {}),
      depthPerPass, rpm, entry, direction, dogbone,
      tabsEnabled, tabHeight, tabWidth, tabSpacing,
      finishAllowance, leadMm, probeAfterChange,
      clamps, workholdingId: workholdingIds.length === 1 ? workholdingIds[0] : '', workholdingIds, dark, simCell,
      material, toolIds,
      /* 🔴 EVERY drawing, each with its placement — not just the selected one.
       * A sheet that came back holding one of the two parts you left is a sheet
       * that posts, simulates and cuts, and looks entirely correct. */
      drawings: drawings.map((d) => ({
        instance: d.instance,
        origin: d.origin,
        name: d.name,
        offset_mm: d.offset,
        rotation_deg: d.rotation,
      })),
      extraToolsCount: extraTools?.length ?? 0,
    }),
    [
      travelX, travelY, travelZ, safeZ, colletMm, spindleMax, probeEnabled,
      touchPlateMm, touchPlateId, supportsArcs,
      spoilboardId, spoilboardX, spoilboardY,
      spoilboardSizeX, spoilboardSizeY, spoilboardThickness, spoilboardName, spoilboardPos,
      spoilboardTravels,
      stockX, stockY, thickness, zZeroTop, originX, originY, rotation,
      depthPerPass, rpm, entry, direction, dogbone,
      tabsEnabled, tabHeight, tabWidth, tabSpacing,
      finishAllowance, leadMm, probeAfterChange,
      clamps, workholdingIds, dark, simCell,
      material, toolIds, drawings, extraTools,
      workpieces, activeWorkpiece,
    ]
  );

  useEffect(() => {
    if (!ready) return;
    const err = writeSession(sessionValues);
    const prev = useCncStore.getState().saveError;
    if (prev !== err) setSaveError(err);
  }, [ready, sessionValues]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  /**
   * A number the operator actually typed, or `undefined`.
   *
   * 🔴 BLANK IS NOT ZERO, and neither is a typo. `Number('')` is `0` and `0` is
   * a plausible board corner — the one value the core singles out as dangerous,
   * because it slides the declared board toward the datum and turns bare rail
   * into declared spoilboard. `NaN` cannot survive `JSON.stringify` either (it
   * serialises as `null`, which serde reads as absent), so an unparseable field
   * is refused HERE and reported on the panel rather than travelling as a
   * silent nothing.
   */
  // typedMm imported from ./panels/typedMm

  /**
   * **The board currently in play, as the three strings a measured board is made
   * of** — TODO #104.
   *
   * 🔴 ONE READING, USED BY EVERYTHING THAT ASKS. A catalogue pick's size and
   * thickness live on the catalogue row; a measured or saved board's live in
   * this component's state. Before this, the panel resolved that ternary inside
   * its own render and nothing else could — so the reach verdict was computed
   * for catalogue rows only, `Save as` would have captured empty strings off a
   * catalogue pick, and the live board's fit against travel was never graded at
   * all. Three consumers deriving the same ternary three times is three places
   * for them to disagree about which board is on the machine.
   *
   * ⚠ STRINGS, and `''` still means NOT DECLARED. A catalogue entry whose cited
   * page states no thickness (`thickness_mm == null`) becomes `''` here — the
   * same value a blank field produces, because it is the same fact: nobody
   * stated one. It must never become `'null'` or `'0'`.
   */
  // spoilboardInPlay is now from useSpoilboardState hook

  /**
   * The spoilboard declaration, or **nothing at all**.
   *
   * 🔴 `undefined` when no board is chosen, and the key is then absent from the
   * config — which the core reads as NOT DECLARED and reports as **UNCHECKED**.
   * That is the honest state and it is loud: `notes` carries the core's own
   * sentence on every export. What must never happen is this app inventing a
   * board, a size or a position to make the panel look complete.
   *
   * 🔴 ONE FORM OR THE OTHER, NEVER BOTH. `catalogue_id` and `size_*` are
   * mutually exclusive in `SpoilboardCfg::resolve` — declaring both installs
   * NOTHING and says so — so the branch below is exhaustive by construction
   * rather than by care.
   *
   * ⚠ A partly-filled declaration IS SENT. A board chosen with no position, or
   * a measured board with one axis, reaches the core and comes back as
   * `SPOILBOARD NOT INSTALLED — <why>` in the operator's own terms. Withholding
   * it here would turn "you told me half a fact" into "you told me nothing",
   * and those are different facts.
   */
  const spoilboardCfg = useMemo(() => {
    if (!spoilboardId) return undefined;
    const pos = { ...(typedMm(spoilboardX) === undefined ? {} : { x_mm: typedMm(spoilboardX) }),
                  ...(typedMm(spoilboardY) === undefined ? {} : { y_mm: typedMm(spoilboardY) }) };
    if (isMeasuredBoardId(spoilboardId)) {
      return {
        ...(spoilboardName.trim() === '' ? {} : { name: spoilboardName.trim() }),
        ...pos,
        ...(typedMm(spoilboardSizeX) === undefined ? {} : { size_x_mm: typedMm(spoilboardSizeX) }),
        ...(typedMm(spoilboardSizeY) === undefined ? {} : { size_y_mm: typedMm(spoilboardSizeY) }),
        /* 🔴 OMITTED WHEN BLANK, WHICH IS THE WHOLE POINT OF THE FIELD — TODO
         * #104. `typedMm('')` is `undefined`, the key is absent, and the core
         * installs the board with `thickness_mm: None` ⇒ the depth limb reports
         * PENDING with its reason. Writing `thickness_mm: 0` here — which is
         * what `Number(spoilboardThickness)` would produce from an empty field —
         * would install a board of zero depth and turn *"nobody said"* into a
         * measurement nobody took.
         *
         * ⚠ A TYPED-BUT-UNUSABLE VALUE IS SENT ON PURPOSE, not filtered. `0` or
         * `-4` is a THIRD fact — somebody entered a thickness and it is not one
         * — and the core reports it through `Spoilboard::thickness_faults` while
         * keeping the rectangle valid. Suppressing it here would relabel a typo
         * as an omission, and the operator would never learn which they made.
         *
         * ⚠ MEASURED FORM ONLY. Beside `catalogue_id` this key makes the core
         * refuse the WHOLE board — there is no tie-break between two numbers
         * about one slab — which is why it is inside this branch and not in
         * `pos` above. */
        ...(typedMm(spoilboardThickness) === undefined
          ? {}
          : { thickness_mm: typedMm(spoilboardThickness) }),
      };
    }
    /* No `name` on a catalogue pick, and no `size_*`. The entry's own label
     * travels with its id, so a finding names the board the operator chose from
     * a sourced list rather than a word this app made up beside it. */
    return { catalogue_id: spoilboardId, ...pos };
  }, [spoilboardId, spoilboardX, spoilboardY, spoilboardSizeX, spoilboardSizeY,
      spoilboardThickness, spoilboardName]);

  const config: JobConfig = useMemo(
    () => ({
      machine: {
        travel_x_mm: travelX,
        travel_y_mm: travelY,
        travel_z_mm: travelZ,
        safe_z_mm: safeZ,
        collet_mm: colletMm,
        spindle_max_rpm: spindleMax,
        probe_enabled: probeEnabled,
        /* 🔴 OMITTED when the field is blank, never sent as `0`. `MachineCfg`
         * takes `Option<f64>` and copies it rather than collapsing it
         * (`core/src/fixtures.rs:675` says so in as many words), so an absent
         * key is `None` = NOT DECLARED = refuse, and `0` is a measured "no
         * plate". A spread is used instead of a ternary yielding `undefined`
         * because `JSON.stringify` dropping a key is the mechanism, and a
         * mechanism worth relying on is worth writing down. */
        ...(touchPlateMm.trim() === '' ? {} : { touch_plate_mm: Number(touchPlateMm) }),
        /* 🔴 THE KEY IS ABSENT WHEN NO BOARD IS DECLARED — see `spoilboardCfg`.
         * Absent means UNCHECKED, which the core says out loud on every export.
         * It does NOT mean "a board the size of the travel envelope", and this
         * app must never send one to make the picture tidy. */
        ...(spoilboardCfg ? { spoilboard: spoilboardCfg } : {}),
        supports_arcs: supportsArcs,
      },
      stock: {
        size_x_mm: stockX,
        size_y_mm: stockY,
        thickness_mm: thickness,
        z_zero_at_top: zZeroTop,
        origin_x_mm: originX,
        origin_y_mm: originY,
        rotation_deg: rotation,
      },
      /* 🔴 THE JOB-LEVEL OFFSET IS NOT SENT ON THE IMPORT PATH, and that is the
       * point of this pass rather than an omission. It moves EVERY drawing on
       * the sheet; the operator's drag moves ONE, and that placement now travels
       * per drawing in `planImportMany`. Sending both would be two mechanisms
       * reaching the same coordinates, which is how a picture and a program
       * start disagreeing — one of them gets a fix and the other does not.
       *
       * It is still sent for the FIXTURE jobs, which have no drawings to place
       * and where it is the only way to move the geometry. Gate MOVE holds it
       * there; gate MULTI holds the per-drawing offset here. */
      ...(drawings.length ? {} : { drawing_offset: [partX, partY] as [number, number] }),
      material,
      clamps,
      confirmed_clear: confirmedClear,
      /* ══════════════════════════════════════════════════════════════════════
         🔴 ALWAYS THE SET, EVEN AT ONE TOOL. THIS LINE USED TO READ
         `toolIds.length > 1 ? { tool_ids } : { tool_id }` AND THAT WAS A
         PROGRAM-EMITTING DEFECT, not a style choice.
         ══════════════════════════════════════════════════════════════════════

         The two fields are TWO DIFFERENT DOORS INTO THE CORE and they do not
         agree:

           · `tool_id`  → `core/src/job.rs` sets the tool on every operation and
             returns. `apply_tool_set` gets `None` and returns immediately, so
             `tool_set_refusals` stays EMPTY and the check at `job.rs:1140` has
             nothing to refuse. **The per-feature recommender is never called.**
           · `tool_ids` → `assign_tools_from_set` → `recommend()` per feature,
             whose rejections become `tool_set_refusals` and reach the planner.

         ⇒ 🔴 "ONE TOOL WORKS, SO ONE TOOL CAN MAKE IT" WAS FALSE. The one-tool
         run was not passing the check; it was SKIPPING it.

         MEASURED AT THE CORE, not at this file — the same fixture, the same
         single tool, the two doors (`2bee-slice job pocket --config …`):

           `{"tool_id":  "End Mill - Down-cut 6mm 2F"}` → exit 0, **962 lines of
             G-code, zero refusals**, and the simulator on that very run reports
             `Uncut { x: 120.6, y: 90.6, standing_mm: 6.0 }`. Six millimetres of
             material standing, program declared OK, nothing said.
           `{"tool_ids":["End Mill - Down-cut 6mm 2F"]}` → exit 1, **no G-code**,
             refused: *"6mm does not fit inside this loop; offsetting the loop in
             by the tool radius leaves nothing to cut"*.

         Across the fixtures the two doors also emit DIFFERENT PROGRAMS from the
         same one tool (`plate`: 497 lines singular vs 515 through the set), so
         this is not only about refusals — the singular door was planning a job
         the recommender had never looked at.

         ⚠ THE CORE ALREADY NAMED THIS FAILURE. `job.rs:1134-1139` calls it *"the
         exact shape of failure that made `JobConfig::tool_id` collapse a
         multi-tool job to one tool without saying so"* — the comment was right
         and the caller was the thing that kept it reachable.

         🔴 EXPECT THIS TO REFUSE JOBS THE APP CURRENTLY ACCEPTS. That is the
         point. A new refusal here is a job that was already unmakeable and was
         being posted anyway; it is not a regression, and reading it as one is
         how it would get reverted.

         ⚠ `toolIds` IS NEVER EMPTY ON THIS PATH — the planner returns early at
         `toolIds.length === 0` (see the guard below, and the note there about
         the core silently substituting a 6mm end mill for a missing `tool_id`).
         So this always sends at least one id, and `assign_tools_from_set`'s
         empty-list early return is not reachable from here.

         ⚠ `tool_id` IS NO LONGER SENT AT ALL by this app. The field still exists
         in the core and in the CLI, and the silent-substitution defect the guard
         below describes is still filed against `core/**` — it is simply no
         longer reachable from this door. */
      tool_ids: toolIds,
      ...(extraTools ? { extra_tools: extraTools } : {}),
      probe_after_toolchange: probeAfterChange,
      /* 🔴 A JOB FIELD, DELIBERATELY NOT AN `op` ONE. The decision is taken
       * against the PLACED outline and the workpiece, so it is a fact about the
       * setup — where the part sits on the material — not about how one
       * operation cuts. Per operation it would let a job skip an edge on one
       * profile and cut the same physical edge on another.
       *
       * ⚠ THE KEY IS ALWAYS SENT, including as `false`. Absent and `false` mean
       * the same thing to the core today, and sending the declaration keeps the
       * switch honest if the job's own default ever moves under it. */
      use_workpiece_edge: useWorkpieceEdge,
      /* ⚠ Sent ONLY when the switch is on, and only when the operator has typed
       * a number. Blank is not zero (`typedMm`), and an unparseable field is
       * omitted rather than travelling as a silent `null` — the core then keeps
       * its own starting point, which the panel names. A value it cannot use is
       * REFUSED by `plan_job` with the whole job, in words; nothing is clamped
       * here to make the panel look tidy. */
      ...(useWorkpieceEdge && typedMm(workpieceEdgeTol) !== undefined
        ? { workpiece_edge_tolerance_mm: typedMm(workpieceEdgeTol) }
        : {}),
      op: {
        depth_per_pass_mm: depthPerPass,
        rpm,
        entry,
        direction,
        dogbone,
        finish_allowance_mm: finishAllowance,
        lead_mm: leadMm,
        tabs_enabled: tabsEnabled,
        tab_height_mm: tabHeight,
        tab_width_mm: tabWidth,
        tab_min_spacing_mm: tabSpacing,
      },
    }),
    [
      travelX, travelY, travelZ, safeZ, colletMm, spindleMax, probeEnabled, touchPlateMm, supportsArcs,
      /* 🔴 THE DEP THAT MAKES THE CONTROL LIVE. A setting that reaches the
       * config object but not this list is a control the operator can move while
       * the plan never changes — which this app has shipped before. */
      spoilboardCfg,
      stockX, stockY, thickness, zZeroTop, originX, originY, rotation, partX, partY, material, clamps, confirmedClear,
      drawings.length,
      toolId, toolIds, extraTools, probeAfterChange,
      /* 🔴 THE SAME DEP RULE AS `spoilboardCfg` ABOVE, and this pair is the one
       * that most needs it: the switch decides whether material is REMOVED.
       * Left out, the operator ticks the box, the panel updates, and the emitted
       * program is byte-identical — a setting that changes nothing, which is
       * gate G11's whole class. Both are here because both reach the config. */
      useWorkpieceEdge, workpieceEdgeTol,
      depthPerPass, rpm, entry, direction, dogbone, finishAllowance, leadMm, tabsEnabled, tabHeight,
      tabWidth, tabSpacing,
    ]
  );

  /* ── WHICH CUTTERS WORK HERE, AND WHICH ONE THE PLANNER WOULD CHOOSE ────────
   * TODO #66, founder 2026-08-10: *"filter the tools by recommendation of the
   * system; highlight the tool … if it does not work for the current setup, it
   * invalidates the job"*.
   *
   * 🔴 THE SAME `config` OBJECT THE PLANNER IS HANDED, not a summary of it.
   * That is the whole guarantee `core::recommend::Setup::from_job_config` was
   * built for: a row saying a cutter is usable and a planner refusing that
   * cutter cannot be describing two different machines if they were handed one
   * description. This lane has re-derived a machining rule in TypeScript three
   * times — the material-blind feed (wrong by 4.29x), the `uncut <= 20`
   * threshold, the travel-fit rule — and every one of them was invisible to
   * every gate. Nothing here computes a verdict; it asks and it renders.
   *
   * ⚠ `report?.drawing ?? []` — an empty parts list is a REAL state and returns
   * `advice: 'unknown'` for every tool, which is a different fact from "no tool
   * is recommended". It is never rendered as "not for this job".
   *
   * ⚠ Re-asked whenever the config or the drawing changes, because every rule
   * behind it depends on both: change the sheet thickness and `reach` flips;
   * change the material and `spindle-rpm` does. A verdict cached across a setup
   * change is a red mark describing a machine nobody is looking at.
   *
   * 🔴 AND "RE-ASKED" WAS NOT "NOT SHOWN MEANWHILE" UNTIL 2026-08-11. The reply
   * arrives asynchronously, so between the setup changing and it landing this
   * state still held the PREVIOUS answer and every row rendered it. `toolAsk` is
   * the question — one memo, used as the effect's dependency AND stored beside
   * the reply — and {@link answerFor} hands the reply back only while it is
   * still the question being asked. See `askedFor.ts` for why it is one list and
   * not a second fingerprint. */
  const toolAsk = useMemo(
    () => ({ config, parts: report?.drawing ?? [] }),
    [config, report?.drawing]
  );
  const [heldVerdicts, setHeldVerdicts] =
    useState<Answered<typeof toolAsk, ToolVerdictsResult> | null>(null);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    toolVerdicts(toolAsk.config, toolAsk.parts)
      .then((v) => alive && setHeldVerdicts({ ask: toolAsk, result: v }))
      /* A failed ASK is not "every tool is fine". It is rendered as a refusal
       * with its reason, and every row falls back to UNKNOWN — never to
       * usable. */
      .catch(
        (e) =>
          alive &&
          setHeldVerdicts({
            ask: toolAsk,
            result: { ok: false, why: String(e instanceof Error ? e.message : e) },
          })
      );
    return () => {
      alive = false;
    };
  }, [ready, toolAsk]);
  /** `null` = NOT ASKED YET FOR THIS SETUP, which every row already renders as
   *  UNKNOWN rather than as usable. */
  const verdicts = answerFor(heldVerdicts, toolAsk);

  /* 🔴 OPT-IN, AND IT OPENS OFF (`''` = every cutter). A filter that starts on
   * would mean the list an operator first sees is already narrowed by a rule
   * they did not choose — the same defect as a default selection, one control
   * along. It also never persists into the session blob: a narrowed list
   * restored days later reads as a short library. */

  /** By tool id, so a row is one lookup and never a second `recommend()` run. */
  const verdictById = useMemo(() => {
    const m = new Map<string, ToolVerdict>();
    if (verdicts?.ok) for (const v of verdicts.verdicts) m.set(v.id, v);
    return m;
  }, [verdicts]);

  /* ── THE DRAWING LIST'S VERDICTS — the founder's *"a filter on the drawings as
   *    well like in the tools"* ────────────────────────────────────────────────
   *
   * 🔴 THE SAME `config` OBJECT THE PLANNER IS HANDED, exactly as the tool
   * verdicts above, and for the same reason: a row saying a drawing belongs on
   * this workpiece and a planner refusing that drawing cannot be describing two
   * different workpieces if they were handed one description.
   *
   * 🔴 AND THE GEOMETRY IS THE REPORT'S, NOT A SECOND READ OF THE FILES.
   * `report.drawing` is what `check_interference` was actually run on — placed,
   * qualified `drawing/part`. {@link splitDrawingParts} inverts that
   * qualification and REFUSES when it cannot do so exactly; a refusal there is
   * rendered as NOT ASKED, never as a verdict. See its doc for why both
   * directions of mismatch fail closed.
   *
   * ⚠ `offset_mm`/`rotation_deg` are left at ZERO because the parts are already
   * placed. Sending Part X/Y as well would apply the placement twice and judge a
   * drawing that is nowhere on the machine.
   *
   * ⚠ Re-asked whenever the config, the report's geometry or the list changes —
   * every rule behind it depends on all three: change the workpiece size and
   * `fit` flips; change the cutter and `pair-clearance` goes from a refusal to
   * UNCHECKED. A verdict cached across a setup change is a mark describing a
   * workpiece nobody is looking at. */
  /** The ids in the job, as a stable string — so the ask below changes when
   *  the SET changes and not on every render that rebuilds the array. */
  const drawingInstanceIds = useMemo(() => drawings.map((d) => d.instance), [drawings]);
  const drawingInstanceKey = drawingInstanceIds.join('\0');
  /**
   * 🔴 THE QUESTION, AS ONE OBJECT — and the founder's filter is why it exists.
   * *"available on selected workpiece"* narrows the list by `fit`, and `fit` is
   * computed against the workpiece in `config`. So the moment the workpiece
   * changes, every held verdict describes the PREVIOUS one — and until the reply
   * lands the filter would answer with it: rows that no longer fit still passing
   * *on the workpiece*, and the hidden-count at the foot of the dialog counting
   * them as fitting. That is not a blank control an operator distrusts; it is a
   * confident, sourced, wrong answer.
   *
   * One memo, used as the effect's dependency AND stored beside the reply, so
   * the guard and the trigger cannot drift apart. `askedFor.ts` says why a
   * second fingerprint would be worse than none.
   *
   * `drawingInstanceKey` is what makes the id LIST a value rather than an
   * identity; `drawingInstanceIds` is derived from the same `drawings`.
   */
  const drawingAsk = useMemo(
    () => ({ config, parts: report?.drawing, ids: drawingInstanceIds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, report?.drawing, drawingInstanceKey]
  );
  const [heldDrawingVerdicts, setHeldDrawingVerdicts] =
    useState<Answered<typeof drawingAsk, DrawingVerdictsResult> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const split = splitDrawingParts(drawingAsk.parts, drawingAsk.ids);
    if (!split.ok) {
      /* NOT an error state and NOT a green one. The list and the report describe
       * different workpieces — the ordinary case being a report one plan behind
       * a drawing the operator just added — and the honest answer is that
       * nothing was judged. */
      setHeldDrawingVerdicts({ ask: drawingAsk, result: { ok: false, why: split.why } });
      return;
    }
    let alive = true;
    drawingVerdicts(
      drawingAsk.config,
      drawingAsk.ids.map((id) => ({
        id,
        parts: split.byId.get(id) ?? [],
        offset_mm: [0, 0] as [number, number],
        rotation_deg: 0,
      }))
    )
      .then((v) => alive && setHeldDrawingVerdicts({ ask: drawingAsk, result: v }))
      /* A failed ASK is not "every drawing is fine". */
      .catch(
        (e) =>
          alive &&
          setHeldDrawingVerdicts({
            ask: drawingAsk,
            result: { ok: false, why: String(e instanceof Error ? e.message : e) },
          })
      );
    return () => {
      alive = false;
    };
  }, [ready, drawingAsk]);
  /** `null` = NOT ASKED YET FOR THIS SETUP. Every row renders that as
   *  `⚠ NOT ASKED`, and `worstDrawingFit` returns `undefined`, which the facet
   *  reaches through its own *not asked* option — so a stale answer becomes an
   *  ABSENT one rather than a wrong one. */
  const drawingVerdictsResult = answerFor(heldDrawingVerdicts, drawingAsk);

  /* 🔴 OPT-IN, AND IT OPENS OFF (`''` = every drawing) — the same rule as the
   * tool list's advice filter, and 🔴 **it is on `fit`, NEVER on `usability`**.
   * Hiding the rows that invalidate the job hides exactly what the operator most
   * needs to see: they are the reason the workpiece will be refused. `fit`
   * answers a different question — does this drawing belong on the material —
   * and narrowing by it hides nothing about whether the job can be cut. */

  /** By INSTANCE id — the name the emitted program calls the part, and the name
   *  a refusal uses. One lookup per row. */
  const drawingVerdictById = useMemo(() => {
    const m = new Map<string, DrawingVerdict>();
    if (drawingVerdictsResult?.ok)
      for (const v of drawingVerdictsResult.verdicts) m.set(v.id, v);
    return m;
  }, [drawingVerdictsResult]);

  /** Every instance a CATALOGUE row has put on the workpiece, with its verdict.
   *  A row that has put none maps to an empty list, which is a real state and is
   *  rendered as NOT ASKED. */
  const drawingVerdictsByRow = useMemo(() => {
    const m = new Map<string, DrawingVerdict[]>();
    for (const d of drawings) {
      const v = drawingVerdictById.get(d.instance);
      if (!v) continue;
      const rowId = drawingRowId(d.origin, d.name);
      const list = m.get(rowId);
      if (list) list.push(v);
      else m.set(rowId, [v]);
    }
    return m;
  }, [drawings, drawingVerdictById]);

  /**
   * Which re-plan is the current one.
   *
   * 🔴 THE RACE THIS CLOSES, and it was named as unclosed when the CAM core
   * moved into a Worker (TODO #144, 2026-08-29). `replan` runs from an effect on
   * every dependency change, so changing two settings quickly puts TWO plans in
   * flight. Two things then go wrong and both are silent:
   *
   *   1. The FIRST answer can land after the second and overwrite the newer
   *      report — the panel, the G-code and the download then describe the
   *      older inputs, which is the stale-program defect arriving through the
   *      back door after the front one was shut.
   *   2. The first plan's `finally` clears `busy` while the second is still
   *      running, so the status says `runnable` over a plan still in flight —
   *      re-opening exactly what gating the status on `busy` just closed.
   *
   * ⚠ It was an ARGUMENT before this: the worker processes messages in order, so
   * responses return in order, and `replan` was the only caller. Both halves are
   * true and neither is a check — the ordering argument says nothing about which
   * REQUEST a late answer belongs to, and "the only caller" is a fact about
   * today's code. A generation counter is the check.
   *
   * ⚠ THE GUARD IS ON THE PATHS THAT `await`, AND ONLY THOSE. The two early
   * returns below (`no drawings`, `no tools`) run with nothing awaited before
   * them, so `mine` is necessarily still current and a check there would be
   * vacuous — and `config-wiring.test.ts` asserts the exact shape of the
   * zero-tool guard, which an inserted line breaks. 🔴 IF AN `await` IS EVER
   * MOVED ABOVE EITHER OF THEM, they need `if (!current()) return;` and that
   * test's needle needs re-reading — the hole re-opens silently otherwise,
   * because a stale `setReport(null)` blanks a panel the operator is looking at.
   */
  const planSeq = useRef(0);

  const replan = useCallback(async () => {
    if (!ready) return;
    // Note: saveActiveWorkpiece() is NOT called here — it would modify
    // workpieces, which is in this callback's dependency list, creating
    // an infinite loop. Workpiece state is saved on switch/add/remove.
    const mine = ++planSeq.current;
    /** This answer is still the one being waited for. */
    const current = () => mine === planSeq.current;
    setBusy(true);
    try {
      // 🔴 With the fixtures off the operator surface, an empty app must show
      // NOTHING rather than quietly planning `plate`. A toolpath on screen for a
      // part the user never supplied is the worst kind of wrong: it looks like
      // their work.
      if (!drawings.length && !showFixtures) {
        setReport(null);
        setPlannedFrom(null);
        return;
      }
      /* 🔴 NO TOOL CHOSEN ⇒ NO PROGRAM. Reported by another agent 2026-08-09 and
       * confirmed at the core, which is where the defect actually lives:
       *
       *   core/src/fixtures.rs:2314
       *     let tool = cfg.tool_id.as_ref()
       *       .and_then(|id| default_library().iter().find(|t| &t.id == id) …)
       *       .unwrap_or_else(|| end_mill(6.0));
       *
       * With every tool removed the picker reads `choose…`, this app sent
       * `tool_id: ""`, and the core SILENTLY SUBSTITUTED a Ø6mm end mill — then
       * planned feeds, depths, pass counts and a whole G-code program around a
       * cutter nobody picked. It posts, it downloads, and it would cut. This
       * lane's rule is refuse rather than approximate, and an undeclared collet,
       * plate or fixture all refuse or report UNCHECKED elsewhere; a tool must
       * not be the one undeclared fact that gets guessed.
       *
       * ⚠ THIS IS A UI GUARD OVER A CORE THAT STILL SUBSTITUTES, and saying so is
       * the point rather than a hedge. `2bee-slice` with no `tool_id` — or with a
       * MISTYPED one, which takes the same `unwrap_or_else` branch — still gets a
       * 6mm end mill and still says nothing. The CLI and the gates are unchanged
       * by this line. `core/**` is another session's working tree right now, so
       * the real fix is filed rather than made: the core should refuse, or name
       * the substitute in `notes` as CHOSEN FOR YOU. Do not read this guard as
       * the defect being closed. */
      if (toolIds.length === 0) {
        setReport(null);
        setPlannedFrom(null);
        return;
      }
      /* 🔴 MULTI-WORKPIECE PLANNING — TODO #64 Phase 2.
       *
       * When there are multiple workpieces with drawings, plan each one
       * separately with its own stock config, then combine the G-code.
       * Each workpiece gets a header comment identifying it. Tool changes
       * between workpieces are left as-is — the operator handles M0 stops.
       *
       * When there's only one workpiece (the common case), the existing
       * single-pass path runs unchanged. */
      let r: Report;
      const wpsWithDrawings = workpieces.filter((wp) => wp.drawings.length > 0);
      if (workpieces.length > 1 && wpsWithDrawings.length > 1) {
        // Multi-workpiece: plan each workpiece separately and combine.
        const reports: Report[] = [];
        for (let wi = 0; wi < workpieces.length; wi++) {
          const wp = workpieces[wi];
          if (!wp.drawings.length) continue;
          const wpConfig: JobConfig = {
            ...config,
            stock: {
              size_x_mm: wp.stockX,
              size_y_mm: wp.stockY,
              thickness_mm: thickness,
              z_zero_at_top: zZeroTop,
              origin_x_mm: wp.originX,
              origin_y_mm: wp.originY,
              rotation_deg: wp.rotation,
            },
          };
          const wpReport = await planImportMany(
            wp.drawings.map((d) => ({
              id: `${wi}:${d.instance}`,
              format: d.format,
              bytes: d.bytes ?? new TextEncoder().encode(d.text ?? ''),
              z_section_mm: undefined,
              offset_mm: d.offset,
              rotation_deg: d.rotation,
            })),
            wpConfig,
            simCell,
            SURFACE_CELL_MM,
            MESH_BUDGET_TRIS
          );
          reports.push(wpReport);
        }
        // Combine: use the first report as base, merge others into it.
        if (reports.length === 0) {
          r = await plan(job, plant, config, simCell, SURFACE_CELL_MM);
        } else {
          const base = reports[0];
          const combinedGcode = reports
            .map((rp, i) => `(Workpiece #${i + 1})\n${rp.gcode}`)
            .join('\n');
          const combinedRender = reports.flatMap((rp) => rp.render);
          const combinedRefusals = reports.flatMap((rp) => rp.refusals);
          const combinedNotes = reports.flatMap((rp) => rp.notes);
          const combinedWarnings = reports.flatMap((rp) => rp.warnings);
          // Merge simulation counts across all workpieces so the panel
          // reflects gouges/uncut/spoilboard from every workpiece, not just #1.
          const mergedUncutChecked = reports.some((rp) => rp.sim.uncut_checked === true);
          const mergedSpoilboardChecked = reports.some(
            (rp) => rp.sim.spoilboard_position_checked === true,
          );
          const mergedBoardDepth = (() => {
            const rank: Record<string, number> = {
              'through-board': 3,
              'inside-board': 2,
              'board-depth-unknown': 1,
            };
            let worst: string | null = null;
            let worstRank = 0;
            for (const rp of reports) {
              const v = rp.sim.board_depth;
              if (v && (rank[v] ?? 0) > worstRank) {
                worst = v;
                worstRank = rank[v] ?? 0;
              }
            }
            return worst;
          })();
          const combinedSim: SimCounts = {
            ...base.sim,
            gouge: reports.reduce((s, rp) => s + rp.sim.gouge, 0),
            uncut: reports.reduce((s, rp) => s + rp.sim.uncut, 0),
            spoilboard: reports.reduce((s, rp) => s + rp.sim.spoilboard, 0),
            first: base.sim.first ?? reports.find((rp) => rp.sim.first)?.sim.first ?? null,
            uncut_checked: mergedUncutChecked,
            uncut_cells_tested: reports.reduce(
              (s, rp) => s + (rp.sim.uncut_cells_tested ?? 0),
              0,
            ),
            // Only surface a pending reason when the merged status is actually pending.
            uncut_pending_reason: mergedUncutChecked
              ? null
              : (reports.find((rp) => rp.sim.uncut_pending_reason)?.sim.uncut_pending_reason ?? null),
            spoilboard_position_checked: mergedSpoilboardChecked,
            spoilboard_pending_reason: mergedSpoilboardChecked
              ? null
              : (reports.find((rp) => rp.sim.spoilboard_pending_reason)?.sim.spoilboard_pending_reason ?? null),
            past_spoilboard_edge: reports.reduce(
              (s, rp) => s + (rp.sim.past_spoilboard_edge ?? 0),
              0,
            ),
            // Worst-case board_depth: "through-board" > "inside-board" > "board-depth-unknown" > null.
            board_depth: mergedBoardDepth,
            through_board: reports.reduce(
              (s, rp) => s + (rp.sim.through_board ?? 0),
              0,
            ),
            board_depth_pending_reason: mergedBoardDepth === 'board-depth-unknown'
              ? (reports.find((rp) => rp.sim.board_depth_pending_reason)?.sim.board_depth_pending_reason ?? null)
              : null,
          };
          r = {
            ...base,
            gcode: combinedGcode,
            render: combinedRender,
            refusals: combinedRefusals,
            notes: [...combinedNotes, `${reports.length} workpieces planned`],
            warnings: combinedWarnings,
            sim: combinedSim,
            cutting_distance_mm: reports.reduce((s, rp) => s + rp.cutting_distance_mm, 0),
            rapid_distance_mm: reports.reduce((s, rp) => s + rp.rapid_distance_mm, 0),
            estimated_seconds: reports.reduce((s, rp) => s + rp.estimated_seconds, 0),
            tool_changes: reports.reduce((s, rp) => s + rp.tool_changes, 0),
            deepest_z_mm: Math.min(...reports.map((rp) => rp.deepest_z_mm)),
          };
        }
      } else {
        // Single workpiece: existing path unchanged.
        // 🔴 Use the flat `drawings` state, not the workpiece's copy — the
        // workpiece copy is only synced on switch/add/remove. `[]` is not
        // nullish, so `??` would silently use the empty array instead of the
        // flat state that holds the actual drawings.
        r = drawings.length
          ? await planImportMany(
              drawings.map((d) => ({
                id: d.instance,
                format: d.format,
                bytes: d.bytes ?? new TextEncoder().encode(d.text ?? ''),
                z_section_mm: sel >= 0 && d === drawings[sel] ? sectionZ ?? undefined : undefined,
                offset_mm: d.offset,
                rotation_deg: d.rotation,
              })),
              config,
              simCell,
              SURFACE_CELL_MM,
              MESH_BUDGET_TRIS
            )
          : await plan(job, plant, config, simCell, SURFACE_CELL_MM);
      }
      // A newer re-plan started while this one was in the worker: its answer is
      // about inputs the operator has already replaced. Dropped, not applied.
      if (!current()) return;
      setReport(r);
      setPlannedFrom(imported?.name ?? null);
    } catch (e) {
      if (!current()) return;
      setPlannedFrom(imported?.name ?? null);
      setReport({
        job,
        ok: false,
        gcode: '',
        refusals: [],
        notes: [],
        fixture_findings: [],
        // The machined surface is asked for explicitly and declined by default;
        // an error report has no simulation at all, so it is null rather than
        // an empty one, which would read as "simulated, nothing removed".
        simulated_stock_surface: null,
        warnings: [],
        errors: [String(e)],
        tools_used: [],
        tool_changes: 0,
        cutting_distance_mm: 0,
        rapid_distance_mm: 0,
        estimated_seconds: 0,
        deepest_z_mm: 0,
        tab_lifts: 0,
        dogbones: 0,
        sim: { cell_mm: simCell, gouge: 0, uncut: 0, spoilboard: 0, first: null },
        render: [],
        stock: [stockX, stockY, thickness],
        clamps,
      });
    } finally {
      // Only the NEWEST plan may clear `busy`. An older one finishing first
      // would say "done" over a plan still running.
      if (current()) setBusy(false);
    }
  }, [
    ready, job, plant, config, simCell, stockX, stockY, thickness, clamps, drawings, imported, sel, sectionZ,
    // Named even though `config` already carries it: the guard above reads
    // `toolIds` directly, and a dependency that is only transitively present is
    // a dependency the next edit to `config` can quietly remove.
    toolIds,
    // Multi-workpiece planning reads the full workpieces array.
    workpieces, activeWorkpiece,
  ]);

  useEffect(() => {
    void replan();
  }, [replan]);

  // The travel refusal, as the CORE worded it. Not re-derived here: the rule
  // about what fits lives in one place, and this panel only repeats its answer.
  const fitRefusal = useMemo(
    () => report?.refusals.find((r: string) => r.includes('travel')) ?? null,
    [report]
  );

  /* ── PLACEMENT ADVISOR — TODO #28 ──────────────────────────────────────────
   *
   * When a drawing lands outside the machine's travel, `planPlacement` computes
   * the shift that would bring it inside — or reports that no shift exists.
   * The result is SHOWN, never APPLIED by the core: the button below adds the
   * shift to the drawing's offset, which is the same thing the Part X/Y fields
   * do. `toolRadiusMm = 0` checks the drawing's own extent; the cutter makes
   * it larger, so this is the optimistic case.
   */
  const [placement, setPlacement] = useState<
    { dx: number; dy: number; describe: string } | { willNotFit: true; describe: string } | null
  >(null);

  useEffect(() => {
    if (!fitRefusal || !report?.drawing?.length) {
      setPlacement(null);
      return;
    }
    const split = splitDrawingParts(report.drawing, drawings.map((d) => d.instance));
    if (!split.ok) { setPlacement(null); return; }
    const inputs = drawings.map((d) => ({
      id: d.instance,
      parts: split.byId.get(d.instance) ?? [],
      x_mm: d.offset[0],
      y_mm: d.offset[1],
      rotation_deg: d.rotation,
    }));
    let alive = true;
    planPlacement(inputs, 0, 0, travelX, travelY)
      .then((r) => {
        if (!alive || !r.ok) return;
        const p = r.placement;
        if (p.outcome === 'shift_datum') {
          setPlacement({ dx: p.dx_mm, dy: p.dy_mm, describe: p.describe });
        } else if (p.outcome === 'will_not_fit') {
          setPlacement({ willNotFit: true, describe: p.describe });
        } else {
          setPlacement(null);
        }
      })
      .catch(() => { if (alive) setPlacement(null); });
    return () => { alive = false; };
  }, [fitRefusal, report?.drawing, drawings, travelX, travelY]);

  /**
   * The format the CORE DECIDED, relayed — TODO #48.
   *
   * 🔴 It is not re-sniffed here, and it is not `imported.format`.
   * `imported.format` is what this app ASKED FOR: since the file path switched
   * to bytes it is the literal string `'auto'`, a REQUEST meaning "decide by
   * content". Printing it produced *"hive-super-end.dxf is a 2D AUTO drawing"* —
   * the question rendered as the answer.
   *
   * WHERE THE VERDICT LIVES, measured at `core/src/fixtures.rs:2154` rather than
   * assumed: `plan_report_import_bytes_*` computes
   * `is_mesh = format == "stl" || mesh::looks_like_stl(data)` and then names the
   * report `imported.{label}`, where `label` is `"stl"` when the CONTENT says so
   * and the requested format otherwise. So `report.job` is the core's own label
   * for the route it took, and it is the only place that verdict reaches the
   * browser — `Report` has no format field (checked at the struct, 2026-08-09).
   *
   * ⚠ WHAT THIS STILL CANNOT SAY, named rather than papered over: on the `auto`
   * route a DXF and an SVG both come back labelled `imported.auto`, because
   * `import::parse_bytes` chooses between them on `text.contains("<svg")` and
   * throws that choice away. `'auto'` is therefore mapped to the EMPTY STRING
   * and nothing is printed — an unnamed format is honest, "AUTO" is not.
   * Closing it properly means the core exporting its decision; that is a core
   * change and this pass does not own the core.
   */
  const detectedFormat = useMemo(() => {
    // A report about a DIFFERENT file must not lend its verdict to this one.
    if (!imported || plannedFrom !== imported.name) return '';
    const jobName = report?.job ?? '';
    const label = jobName.startsWith('imported.') ? jobName.slice('imported.'.length) : '';
    return label === 'auto' ? '' : label;
  }, [report, imported, plannedFrom]);

  /** What to PRINT as the format: the core's verdict, else the user's own
   *  declaration, else nothing. Never the word `auto`. */
  const shownFormat =
    detectedFormat || (imported && imported.format !== 'auto' ? imported.format : '');

  // 🔴 The library is re-fetched when the machine's collets change, because the
  // FIT VERDICT it carries is a fact about this machine, not about the tool. A
  // library fetched once and filtered here would be the same duplicated-rule
  // mistake the travel check made.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    toolLibraryFor(colletMm, SPARE_COLLETS_MM)
      .then((t) => live && setLib(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ready, colletMm]);

  // Fit verdict per sheet preset, from the CORE, refreshed when the machine
  // changes. `quarter_turn` is the whole reason this is not a `>` comparison:
  // a 600x900 sheet on 1250x670 does not fit as laid and fits perfectly turned.
  const [sheetFits, setSheetFits] = useState<Record<string, { fits: boolean; turn: number | null }>>(
    {}
  );
  useEffect(() => {
    if (!ready) return;
    let live = true;
    (async () => {
      const out: Record<string, { fits: boolean; turn: number | null }> = {};
      // Keyed by `id`, not by name: two catalogue entries can share a size and a
      // name is a label, while an id is the thing `sheetById` resolves.
      for (const s of SHEET_SIZES) {
        try {
          const f = await stockFit(s.w, s.h, 0, travelX, travelY);
          out[s.id] = { fits: f.fits, turn: f.quarter_turn };
        } catch {
          // A fit that could not be computed is NOT a fit. Leaving the preset
          // out of the map leaves it enabled, which is the safe direction: the
          // plan-time refusal still stands behind it.
        }
      }
      if (live) setSheetFits(out);
    })();
    return () => {
      live = false;
    };
  }, [ready, travelX, travelY]);

  const selectedTool = useMemo(
    () => lib?.tools.find(  (t: ToolRow) => t.id === toolId) ?? null,
    [lib, toolId]
  );

  /* ── CLEARANCE — TODO #32 ──────────────────────────────────────────────────
   *
   * The minimum gap between two parts, computed by the core from the cutter
   * diameter and a margin. Passed to the Viewport so the snap system can offer
   * clearance-aware positions. `marginMm = 0` is the minimum safe gap; a
   * positive margin adds breathing room.
   */
  const [clearance, setClearance] = useState<
    { required_mm: number; cutter_diameter_mm: number; margin_mm: number } | null
  >(null);

  useEffect(() => {
    const diameter = selectedTool?.diameter_mm;
    if (!diameter || diameter <= 0) { setClearance(null); return; }
    let alive = true;
    clearanceFor(diameter, 0)
      .then((r) => { if (alive && r.ok) setClearance(r.clearance); else if (alive) setClearance(null); })
      .catch(() => { if (alive) setClearance(null); });
    return () => { alive = false; };
  }, [selectedTool?.diameter_mm]);

  /* The user's own saved objects, one collection each. See `useSaved`. */
  /* The drawings collection is the one with a custom writer — see
   * {@link writeDrawing}. Machines and workpieces have nothing to verify. */
  const savedDrawings = useSaved<SavedDrawing>('drawings', writeDrawing);
  const savedMachines = useSaved<SavedMachine>('machines');
  const [machineSaveNote, setMachineSaveNote] = useState<string | null>(null);
  const [undoToast, setUndoToast] = useState<string | null>(null);
  const [playbackResetNote, setPlaybackResetNote] = useState<string | null>(null);
  /* 🔴 THE COLLECTION EXISTED AND NOTHING WROTE TO IT — TODO #104. `spoilboards`
   * has been in `COLLECTIONS` since 2026-08-10 and had no producer and no
   * consumer: a store nobody could put a board into, which is indistinguishable
   * on disk from a shop that has never saved one. This hook is the producer. */
  const savedSpoilboards = useSaved<SavedSpoilboard>('spoilboards');
  /* 🔴 WHICH MACHINE THE OPERATOR ACTUALLY CHOSE — founder, 2026-08-11: *"I have
   * saved as a new Machine but I can't select it, why?"*
   *
   * The picker's ticked set was derived from `MACHINE_PRESETS` alone and could
   * not contain a saved machine at all, so choosing one loaded its numbers and
   * left the control reading "choose a machine…". The full trace, and why a
   * latched id ALONE would have been a worse bug, are in `savedSelection.ts`.
   *
   * ⚠ NOT PERSISTED, deliberately. It is a statement about an action taken in
   * THIS session; on reload the panel holds numbers, not a provenance, and
   * restoring a tick would assert that this session's setup came from a record
   * nobody opened here. The session already restores the numbers themselves. */
  // loadedMachine, loadedWorkpiece — migrated to Zustand store
  const savedWorkpieces = useSaved<SavedWorkpiece>('workpieces');
  const [workpieceSaveNote, setWorkpieceSaveNote] = useState<string | null>(null);

  /* ── MATERIAL: ONE ANSWER, AND A CONFLICT THAT IS NEVER RESOLVED ────────────
   *
   * 🔴 THE LIBRARY IS THE CORE'S, READ AT RUNTIME. `SheetSize.material` is a
   * STRING and not a TypeScript union on purpose — a union here would be a
   * second copy of `core/src/tools.rs::Material` that drifts silently. So a name
   * the planner does not carry resolves to UNKNOWN rather than to a neighbour,
   * and drift becomes a visible refusal instead of an invisible substitution.
   * `'Ply'` resolves to nothing; it does not resolve to `'Plywood'`. */
  const materialLibrary = useMemo(() => (lib?.materials ?? []).map(  (m: MaterialRow) => m.name), [lib]);

  /* Every row the workpiece list will show, reduced to the one field the facet
   * asks about. The options and their counts are computed from THE ROWS, never
   * from the library: a filter offering "Aluminium" over a list holding no
   * aluminium sheet is a control that empties the list and explains nothing. */
  const workpieceFacetRows = useMemo(
    () => [
      ...SHEET_SIZES.map((s) => ({ material: materialOfSheet(s) })),
      ...savedWorkpieces.items.map((rec) => ({ material: materialOfWorkpiece(rec.data) })),
    ],
    [savedWorkpieces.items]
  );
  const workpieceMaterialOptions = useMemo(
    () => materialFacetOptions(workpieceFacetRows, materialLibrary),
    [workpieceFacetRows, materialLibrary]
  );

  /**
   * 🔴 THE ONE ANSWER TO "WHAT IS THIS JOB PLANNED AGAINST", AND WHERE IT CAME
   * FROM. `checkMaterialAgreement` returns `agreed` / `unknown` / `conflict`, and
   * a conflict carries BOTH names plus which one the program will actually
   * carry. Nothing here picks between them — the feeds, the chipload and the
   * depth of cut are all derived from the material, so choosing silently would
   * be this file deciding which of two numbers on screen is a lie.
   *
   * ⚠ ONE ARM IS UNREACHABLE TODAY AND IT IS LEFT UNREACHABLE. `jobMaterial.ts`
   * describes a path where the job states nothing and the chosen workpiece
   * SUPPLIES the material. `material` is initialised to `'Plywood'` and no
   * control can empty it, so `not-stated` never occurs on this surface. Giving
   * the job an empty material is a change to what every restored session and
   * every saved workpiece means — not a wiring change — so it is reported rather
   * than made here, and picking a sheet still sets Size X/Y and nothing else.
   */
  /* ⚠ HOISTED 2026-08-11: these were declared ~700 lines below, and `L(...)` is
   * called inside the `drawingItems` useMemo, which evaluates DURING RENDER.
   * `const` in a temporal dead zone threw `Cannot access before initialization`,
   * so <App> never returned and the page was BLANK. tsc could not see it (the
   * call is inside a closure) and 1096 node tests were green over it, because
   * nothing on this box renders a component. Keep these above the first
   * render-time memo that uses them. */
  /* 🔴 THE DISPLAY UNIT — TODO #109. Seeded from storage by the same lazy
   * initialiser and for the same reason: a `useState(DEFAULT_UNIT)` plus an
   * effect would paint one frame of millimetres to somebody who chose inches,
   * and a dimension that changes value a moment after the panel appears is the
   * worst possible first impression for a unit switch.
   *
   * 🔴 NOTHING DOWNSTREAM OF THIS IS A PROGRAM INPUT. It is not in the config
   * object `plan()` receives, not in `sessionValues`, not in `encodeJob`, and it
   * is in no dependency array that rebuilds a plan — deliberately, because a
   * re-plan on a unit switch is exactly the thing that could make the emitted
   * program differ between the two settings. `tests/units.test.ts` asserts the
   * program is byte-identical, and `tests/config-wiring.test.ts` owns the rule
   * that a setting reaching the config must reach the dep list; this one reaches
   * neither, on purpose. */
  // unit — migrated to Zustand store
  const chooseUnit = (u: Unit) => {
    useCncStore.getState().setUnit(u);
    rememberCncUnit(u);
  };
  /** A length, in the operator's unit, with the unit on it. Millimetres in. */
  const L = (mm: number) => formatLength(mm, unit);
  /** `1200 × 600 mm` — one symbol for one fact. Millimetres in. */
  const L2 = (a: number, b: number, sep?: string) => formatLengthPair(a, b, unit, sep);
  /** `1200 × 600 × 18 mm`. Millimetres in. */
  const L3 = (a: number, b: number, c: number) => formatLengthTriple(a, b, c, unit);

  const materialAgreement = useMemo(
    /* 🔴 `null` UNTIL THE CORE'S LIST HAS ARRIVED, and that is not a detail. The
     * verdict is computed AGAINST the library, so with an empty library every
     * material resolves to `unknown` — the app would open on a red "no usable
     * material" that means nothing but "the wasm has not finished loading".
     * A control that false-fires gets muted, and then the real red is muted
     * too. The waiting state is reported as waiting instead. */
    () => (lib ? checkMaterialAgreement(material, pickedWorkpiece, materialLibrary) : null),
    [lib, material, pickedWorkpiece, materialLibrary]
  );

  /**
   * ONE LIST FOR EVERY DRAWING — TODO #54, founder 2026-08-09: *"in the drawings
   * merge the 2 lists, have just 1 list including the sample and user owned
   * drawings"*.
   *
   * Three surfaces collapse into this one: the shipped DXF/SVG samples, the
   * shipped STL samples, and whatever the user has saved in this browser.
   *
   * 🔴 ONE LIST, NOT ONE TYPE, and the difference is the whole safety argument.
   * The two shipped arrays were deliberately kept apart in `samples/index.ts`
   * because a drawing sample is TEXT ALREADY IN MEMORY and IS the shape that
   * gets cut, while a mesh sample is BYTES THAT MUST BE FETCHED and is NOT — the
   * machine cuts one flat section through it, at one Z. Merging the LISTS is
   * what the founder asked for and is right; merging the TYPES would make "has
   * not loaded yet" and "is empty" the same value and put a solid and an outline
   * under one word. So every mesh row says, before it is chosen:
   *   - that it is a 3D solid and only ONE SECTION of it is cut,
   *   - the Z that section is taken at, marked CHOSEN FOR YOU rather than
   *     offered as a default that is correct,
   *   - and that loading it is a fetch that can fail (`bytes()` re-derives the
   *     triangle count and refuses a mismatch BY NAME).
   *
   * 🔴 AND THE ORIGIN IS ON EVERY ROW. A shipped sample carries a measurement
   * made through the CLI importer and a provenance line naming the `cad` file it
   * was copied from. A drawing the user saved carries neither — nobody measured
   * it, because nobody was asked to. In one list the first would otherwise lend
   * its authority to the second, which is a picture of confidence nobody earned.
   *
   * ⚠ IDS ARE PREFIXED BY SURFACE, not bare names, and that is not cosmetic: a
   * DXF sample and an STL sample of the SAME PART already collide by name
   * (`Hive super end` / `Hive super end — solid (STL)` — renamed on 2026-08-09
   * for exactly this reason), and a user is free to save a drawing under a
   * shipped sample's name. Two rows with one id in a list keyed by id is a
   * picker that silently selects the wrong part, and both parts post and cut.
   */
  const drawingItems: ObjectItem[] = useMemo(() => {
    const rows: ObjectItem[] = [];

    for (const smp of SAMPLES) {
      const o = shipped('copied from hardware/cad, 2026-08-08, and measured through the CLI importer');
      rows.push({
        id: drawingRowId('sample', smp.name),
        name: smp.name,
        builtIn: true,
        detail: withTag(o.tag, `2D drawing · ${smp.format.toUpperCase()}`),
        properties: [
          o.prop,
          { label: 'What it is', value: 'a 2D drawing — the outline IS what the machine cuts' },
          { label: 'Format', value: smp.format.toUpperCase() },
          { label: 'Size', value: `${(smp.text.length / 1024).toFixed(0)} kB` },
          { label: 'Loads', value: 'immediately — the text is already in the bundle' },
          { label: 'Why it is listed', value: smp.detail },
        ],
      });
    }

    for (const m of MESH_SAMPLES) {
      const o = shipped('copied from hardware/cad, byte-compared');
      rows.push({
        id: drawingRowId('mesh-sample', m.name),
        name: m.name,
        builtIn: true,
        detail: withTag(
          o.tag,
          `3D solid · ONE section at z = ${L(m.midHeightZMm)}, CHOSEN FOR YOU`
        ),
        properties: [
          o.prop,
          {
            label: 'What it is',
            value: 'a 3D SOLID — the machine cuts ONE flat section of it, never the solid',
          },
          { label: 'Format', value: 'STL (binary)' },
          { label: 'Triangles', value: m.triangles },
          { label: 'File size', value: `${(m.bytesOnDisk / 1024).toFixed(0)} kB` },
          {
            /* Stated on the row because it is the one way a mesh row can fail
               that a drawing row cannot, and a fetch that fails silently is
               indistinguishable from a sample with nothing in it. */
            label: 'Loads',
            value:
              'by FETCHING the file — unlike the 2D samples. The triangle count is ' +
              're-derived from the bytes that arrive and a mismatch is refused by name.',
          },
          { label: 'Solid spans Z', value: `${L(m.zSpanMm[0])} … ${L(m.zSpanMm[1])}` },
          {
            /* 🔴 The words the samples file insists on, carried onto the screen
               rather than paraphrased. It is a GUESS ABOUT INTENT. Calling it a
               default would say the opposite — that someone decided this Z was
               right for this part. */
            label: 'Section Z — CHOSEN FOR YOU',
            value:
              `${L(m.midHeightZMm)}, the mid-height. A different Z is a different ` +
              `part; this one is a guess about your intent, not a reading of your model.`,
          },
          {
            label: 'What the machine cuts',
            value: 'that ONE flat slice, never the solid you see',
          },
          { label: 'Why it is listed', value: m.detail },
        ],
      });
    }

    for (const rec of savedDrawings.items) {
      const o = yours(rec.saved_at);
      const d = rec.data;
      /* 🔴 A ROW DESIGNED IN `2bee.cad` DESCRIBES ITSELF, and does so through
       * `record.ts` rather than through the generic saved-drawing text below.
       * The two say materially different things and only one of them is true of
       * a CAD model:
       *
       *   · The generic row says "Measured? NO — nothing in this app has checked
       *     this drawing". A CAD model HAS been checked, by the mesh audit, and
       *     it could not have been saved unless that audit returned watertight.
       *     Printing "nobody checked it" over a record whose save was gated on a
       *     check understates what is known.
       *   · The CAD row says the things the generic one CANNOT know and that
       *     decide whether this part is safe to cut: that it is a 3D SOLID and
       *     the machine takes ONE FLAT SECTION of it at one Z; which constructs
       *     were REFUSED and are therefore MISSING from the solid; and whether
       *     the stored mesh still checksums to the stored source. `record.ts`
       *     puts those FIRST, above the counts, because a caveat printed under
       *     the numbers it qualifies is read after the decision.
       *
       * This is the "visible when the part is later selected" half of that
       * file's refusal policy — the half that reaches the person who is cutting
       * the part and did not draw it. */
      if (isCadRecord(d)) {
        rows.push({
          id: drawingRowId('saved', rec.name),
          name: rec.name,
          detail: withTag(o.tag, cadRowDetail(d)),
          /* `o.prop` first so the origin line still leads: this is a thing the
           * user made in this browser, with no server copy, exactly like every
           * other saved row. Everything after it is the record's own account of
           * itself, unparaphrased and in its own order. */
          properties: [o.prop, ...describeCadRecord(d, verifyCadRecord(d))],
        });
        continue;
      }
      /* The core decides what a file IS by measuring it; this row can only say
       * what was ASKED FOR when it was saved. `'auto'` is a request, not a
       * format, so it is reported as unknown rather than printed as a verdict —
       * the same rule `shownFormat` follows for the loaded drawing. */
      const declared = d?.format && d.format !== 'auto' ? d.format.toUpperCase() : '';
      rows.push({
        id: drawingRowId('saved', rec.name),
        name: rec.name,
        detail: withTag(o.tag, declared ? `${declared} · saved by you` : 'saved by you'),
        properties: [
          o.prop,
          {
            label: 'What it is',
            value: declared
              ? `declared ${declared} when it was saved — the core decides again on load`
              : 'not declared — the core decides by measuring the file when it loads',
          },
          {
            label: 'Measured?',
            value:
              'NO. Nothing in this app has checked this drawing through the importer, ' +
              'named its dropped entities, or counted its features. The shipped samples ' +
              'above carry those numbers; this one carries none.',
          },
          { label: 'Held as', value: d?.bytes ? 'bytes' : d?.text ? 'text' : 'nothing usable' },
        ],
      });
    }

    return rows;
  }, [savedDrawings.items]);


  /** What "save this machine" writes.
   *
   * 🔴 The plate travels with the machine or it does not survive a reload — and
   * a machine restored WITHOUT its plate thickness comes back undeclared, which
   * refuses at post time. `touchPlateId` rides along so the provenance line
   * comes back too. */
  const currentMachine = useCallback(
    (): SavedMachine => ({
      travelX,
      travelY,
      travelZ,
      safeZ,
      colletMm,
      spindleMax,
      probeEnabled,
      touchPlateMm,
      touchPlateId,
      supportsArcs,
      spoilboardId,
      spoilboardX,
      spoilboardY,
      spoilboardSizeX,
      spoilboardSizeY,
      spoilboardThickness,
      spoilboardName,
      spoilboardPos,
      /* Omitted rather than `null` when there is no position: an absent key is
       * "unknown machine", which is what the load path must treat it as. */
      ...(spoilboardTravels ? { spoilboardTravels } : {}),
    }),
    [travelX, travelY, travelZ, safeZ, colletMm, spindleMax, probeEnabled, touchPlateMm, touchPlateId, supportsArcs,
     spoilboardId, spoilboardX, spoilboardY, spoilboardSizeX, spoilboardSizeY, spoilboardThickness,
     spoilboardName, spoilboardPos, spoilboardTravels]
  );

  /**
   * What **"save this spoilboard"** writes — TODO #104.
   *
   * 🔴 **THIS CALL SITE HAS #102's SHAPE, AND IT REFUSES RATHER THAN DECIDING
   * IT.** `Save as` on the machine / workpiece / drawing pickers writes what the
   * PANEL holds and discards the previewed row, so previewing `Desktop 3018` and
   * pressing Save as writes the ticked machine's 600 × 900 travels under that
   * name. That fork is with the founder and is not settled here.
   *
   * ⚠ **AND MY FIRST READING OF WHY IT DID NOT APPLY WAS WRONG, which is why
   * this paragraph exists rather than a claim of exemption.** I wrote that a
   * saved board is not a second declaration path — selecting one writes the
   * measured fields, so the panel IS the row — and then checked
   * `ObjectPicker`: `previewItem` follows the **ACTIVE** row, and arrowing
   * changes the active row **without selecting it**. So an operator reading one
   * board's properties while another is declared has exactly the two readings
   * #102 is about.
   *
   * ⇒ `saveTargetRefusal` (in the panel) is the answer: the unambiguous cases
   * save, the ambiguous one writes nothing and says which two boards it could
   * not choose between. **Refusing is not deciding the fork** — it declines to
   * guess, which is `AGENTS.md`'s third duty. When the founder rules, that
   * function is where it lands, and it should land on all four pickers at once.
   *
   * ⚠ **THE POSITION AND ITS FINGERPRINT GO IN.** X and Y are MACHINE
   * coordinates, so a record without the travels they were measured against is
   * a corner nobody can check — `readSpoilboard` treats an absent fingerprint as
   * a mismatch and drops the corner on the way back, which is the safe
   * direction and the reason the field exists.
   */
  const currentSpoilboard = useCallback(
    (name: string, board: { sizeX: string; sizeY: string; thickness: string }): SavedSpoilboard => ({
      /* 🔴 SAVED AS THE MEASURED FORM, whatever it was picked as. A record that
       * stored a catalogue id would resolve against a catalogue that can change
       * between builds, and the numbers the operator is looking at when they
       * press Save would not be the numbers that came back. The sizes below are
       * read from the panel, which is where the catalogue's own figures were
       * written when the row was chosen. */
      id: SPOILBOARD_SAVED_PREFIX + name,
      x: spoilboardX,
      y: spoilboardY,
      sizeX: board.sizeX,
      sizeY: board.sizeY,
      /* `''` survives as `''` — see the field. A saved board with no declared
       * depth comes back with no declared depth and the check stays PENDING. */
      thickness: board.thickness,
      name,
      ...(spoilboardTravels ? { machine_travels_mm: spoilboardTravels } : {}),
    }),
    [spoilboardX, spoilboardY, spoilboardTravels]
  );

  /** What "save this workpiece" writes. Placement is part of it: a sheet
   *  restored flat and at the origin is a different setup wearing the same name. */
  const currentWorkpiece = useCallback(
    (): SavedWorkpiece => ({
      stockX,
      stockY,
      thickness,
      material,
      originX,
      originY,
      rotation,
      zZeroTop,
    }),
    [stockX, stockY, thickness, material, originX, originY, rotation, zZeroTop]
  );

  /**
   * `report.loaded_mesh`, but ONLY when the report is about the drawing that is
   * loaded right now.
   *
   * 🔴 The same rule `detectedFormat` follows, applied to the other fact the
   * drawing row prints. Between `setImported(...)` and the plan landing,
   * `imported` is the NEW file and `report` still describes the OLD one — a
   * window in which a DXF's row can show a Section Z, and a mesh's row can show
   * the Z of a DIFFERENT solid, both looking authoritative. This lane's rule is
   * to assert on the emitted artefact; the matching rule for a UI is to check
   * the artefact is about the thing you are labelling.
   *
   * ⚠ The cost is that the Section Z control disappears for the moment a re-plan
   * takes, and that is the right direction: no control is honest about a
   * decision the app cannot yet describe, a stale one is not.
   */
  const loadedMesh = useMemo(
    () => (imported && plannedFrom === imported.name ? (report?.loaded_mesh ?? null) : null),
    [imported, plannedFrom, report]
  );

  /** What "save this drawing" writes: the bytes or text, and what it was called.
   *  `origin` is deliberately NOT stored — see the rewrite in `chooseDrawing`.
   *
   * 🔴 `cad` IS PART OF IT, and it was not until 2026-08-11. This function built
   * a fresh object out of four named fields, so a drawing designed in `2bee.cad`
   * — loaded here, then written back through "Save" or "Save as" — came out the
   * other side as bare STL bytes with its SOURCE GONE. The model is
   * unrecoverable at that point: the mesh cannot be turned back into the
   * `difference()` somebody wrote. It looks like a successful save, the row
   * stays in the list, and the loss is invisible until the model is reopened.
   * A field-by-field copy silently drops whatever it does not know about, which
   * is exactly what makes it the wrong shape for a record that grew a field.
   *
   * ⚠ What travels is the payload EXACTLY AS IT WAS READ. Nothing here rebuilds
   * a checksum or re-audits a mesh: the bytes and the source are both unchanged
   * by a round trip through this app, so the record that verified on the way in
   * verifies on the way out. If either ever stops being true, the fix is in
   * `cad/record.ts`, not a recomputation here. */
  const currentDrawing = useCallback(
    (): SavedDrawing | null =>
      imported
        ? {
            bytes: imported.bytes,
            text: imported.text,
            format: imported.format,
            name: imported.name,
            ...(imported.cad ? { cad: imported.cad } : {}),
          }
        : null,
    [imported]
  );


  /**
   * Read ONE row of the merged drawing list into a loadable drawing, AS DRAWN.
   *
   * `null` when the row does not resolve — a shipped sample this build does not
   * carry, or a saved record with no bytes. The caller REPORTS that; it never
   * substitutes another row, because a drawing quietly swapped for a different
   * one is a part cut under a name the operator recognises.
   */
  const readDrawingRow = useCallback(
    async (rowId: string, taken: Iterable<string> = []): Promise<LoadedDrawing | null> => {
      const parsed = parseDrawingRowId(rowId);
      if (!parsed) return null;
      const place = {
        instance: mintInstance(parsed.name, taken),
        offset: [0, 0] as [number, number],
        rotation: 0,
      };
      if (parsed.origin === 'sample') {
        const smp = SAMPLES.find((x) => x.name === parsed.name);
        return smp
          ? { text: smp.text, format: smp.format, name: smp.name, origin: 'sample', ...place }
          : null;
      }
      if (parsed.origin === 'mesh-sample') {
        const m = MESH_SAMPLES.find((x) => x.name === parsed.name);
        if (!m) return null;
        // Throws BY NAME if what arrives is not the mesh the entry describes.
        // The caller shows it: a sample that silently failed to load is
        // indistinguishable from one that loaded and had nothing in it.
        const bytes = await m.bytes();
        return { bytes, format: 'stl', name: m.name, origin: 'mesh-sample', ...place };
      }
      const rec = savedDrawings.items.find((x) => x.name === parsed.name);
      if (!rec?.data) return null;
      /* `origin: 'saved'` is REWRITTEN here, not taken from the record. A
       * drawing opened from disk and then saved was stored carrying
       * `origin: 'file'`, and a record restored under that tag would be looked
       * for somewhere it is not. Where it came FROM stops mattering the moment
       * it is in the store; where it is NOW is the only thing a reload can act
       * on.
       *
       * 🔴 THE SPREAD IS WHAT CARRIES `cad`, and it is deliberate rather than
       * incidental. A record designed in `2bee.cad` resolves through this one
       * path like any other saved drawing — `bytes` + `format: 'stl'` are what
       * the core is handed, and the payload rides along so that saving it back
       * can return it (see `currentDrawing`). Rewriting this as a field-by-field
       * copy would drop the payload silently, which is the defect that existed
       * on the other side of the round trip until 2026-08-11.
       *
       * ⚠ IT DOES NOT REFUSE A STALE RECORD, and that is `record.ts`'s call, not
       * a gap introduced here: the verdict is spent where it is most actionable
       * — in the CAD tab at save time, and on the ROW at selection time, where
       * `describeCadRecord` prints "STALE — do not cut this" above everything
       * else. A refusal at plan time would be a second, separate decision about
       * what the planner may accept, and it is not this change's to make. */
      return { ...rec.data, name: rec.name, origin: 'saved', ...place };
    },
    [savedDrawings.items]
  );

  /**
   * 🔴 **The multi-select commit: make the sheet hold exactly these rows.**
   *
   * Founder 2026-08-10: *"I should able to add more than 1 drawings"*.
   *
   * 🔴 A DRAWING THAT IS STILL SELECTED KEEPS ITS PLACEMENT. Re-reading every
   * row from the list on every change would silently return every part to where
   * it was drawn the moment the operator added a third one — a placement nobody
   * chose, arriving through a control that looks like it only added something.
   * Existing entries are therefore carried over and only NEW ids are loaded.
   *
   * 🔴 EVERY ROUTE CLEARS `sectionZ`, including the 2D ones. `sectionZ` is the Z
   * the operator chose for A PARTICULAR SOLID: pick a mesh, type a Z, add a
   * second mesh, and that second solid would be sectioned at a number chosen for
   * the first — it plans, it posts, and the panel reads "which you chose", which
   * is true of a choice made about a different part. Clearing it hands the
   * decision back to the core, which sections at mid-height and SAYS it chose.
   *
   * 🔴 AND THE SELECTION IS RE-ANCHORED ON THE DRAWING, not left as a number. A
   * stale index after a removal edits a DIFFERENT part's placement while looking
   * entirely correct.
   */
  const syncDrawings = useCallback(
    async (rowIds: string[]) => {
      pushSnapshot();
      setMeshLoadError('');
      setDrawingNote('');
      const keepInstance = drawings[selectedIndexOf(drawings)]?.instance ?? null;
      const next: LoadedDrawing[] = [];
      for (const id of rowIds) {
        const parsed = parseDrawingRowId(id);
        if (!parsed) continue;
        /* 🔴 EVERY EXISTING INSTANCE OF THIS DRAWING SURVIVES, not the first one.
         * The picker says WHICH DRAWINGS are in the job; how many copies of
         * each is the ⧉ button's business. Keeping only one would delete the
         * operator's copies the next time they ticked anything — a data loss
         * with no message, arriving through a control that looks like it only
         * added something. */
        const existing = drawings.filter(
          (d) => d.origin === parsed.origin && d.name === parsed.name
        );
        if (existing.length) {
          next.push(...existing);
          continue;
        }
        try {
          const loaded = await readDrawingRow(
            id,
            next.map((d) => d.instance)
          );
          if (loaded) next.push(loaded);
          else setDrawingNote(`"${parsed.name}" could not be loaded and is NOT in the job`);
        } catch (err) {
          setMeshLoadError(String(err instanceof Error ? err.message : err));
        }
      }
      /* 🔴 A DRAWING THE PICKER CANNOT LIST IS NOT A DRAWING THE PICKER MAY
       * DELETE. Measured in the browser 2026-08-11: import `plate.dxf`, open the
       * Drawing picker, tick any shipped sample, press Done — and the imported
       * file was GONE from the job, with no message, through a control whose
       * only visible effect was adding something. It is unrecoverable: the row
       * itself says *"FROM DISK · not saved, and this app does not keep it"*.
       *
       * The cause is that this function rebuilt the WHOLE list out of row ids,
       * and `rowId('file', …)` is deliberately an id NO ROW CARRIES (see
       * `rowId`'s header) — so a file drawing could never be in `rowIds` and was
       * dropped by construction on every sync. Exactly the data loss the comment
       * above forbids for COPIES, one object along.
       *
       * So the picker's answer governs only the rows the picker has. Anything
       * with no row is carried across at the position it already held; removing
       * it is the ✕ on its own row, which is a control the operator aimed at.
       *
       * ⚠ The predicate is "does this origin resolve to a row", asked through
       * `parseDrawingRowId` itself rather than by testing for `'file'`, so a
       * fourth origin added later inherits the right answer instead of the
       * silent deletion. */
      for (let i = 0; i < drawings.length; i++) {
        const d = drawings[i];
        if (parseDrawingRowId(drawingRowId(d.origin, d.name))) continue;
        next.splice(Math.min(i, next.length), 0, d);
      }
      setSectionZ(null);
      /* The measured note belongs to ONE shipped sample. With several drawings
         on the sheet there is no single thing it describes, and leaving the last
         one up would attach a measurement to a sheet it was never about. */
      setSampleNote(
        next.length === 1
          ? (SAMPLES.find((x) => x.name === next[0].name)?.detail ??
              MESH_SAMPLES.find((x) => x.name === next[0].name)?.detail ??
              '')
          : ''
      );
      setDrawings(next);
      const back = keepInstance ? next.findIndex((d) => d.instance === keepInstance) : -1;
      setSelected(back >= 0 ? back : 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawings, readDrawingRow, selected]
  );

  /**
   * When each drawn move has FINISHED, in seconds of program time.
   *
   * 🔴 Built from the SAME arithmetic the printed estimate used, on purpose:
   * every move is timed from **its own `feed`** — the number the post wrote as
   * that block's `F` word — and a rapid, which has no `F` word at all, at
   * `report.rapid_mm_min`, which is the rate the core's own estimate charges
   * rapids at. Nothing here picks a feed, invents one, or substitutes a default;
   * a move that carries no rate is counted as taking NO time and is COUNTED as
   * such (`untimed` below), because a quietly-guessed rate is how a playhead
   * ends up telling a confident lie about a program.
   *
   * ⚠ It is not, and cannot be, the same TOTAL as `report.estimated_seconds`.
   * The core reads the emitted G-code; this reads the drawn path, and the
   * program contains seconds that are not moves at all — the `G4` spin-up dwell
   * and the `G38.2` probe search. The gap is measured and PRINTED rather than
   * hidden, because a playhead that finishes early next to a longer number
   * teaches the operator to distrust whichever one they checked last.
   */
  const timeline = useMemo(() => {
    const moves = report?.render ?? [];
    const rapidMmMin = report?.rapid_mm_min ?? null;
    /* 🔴 THE RATE THE CORE ACTUALLY CHARGED, read off the report — never a
     * literal here. `?? 0` on absence and NOT `?? 120`: absent means no job ran
     * or a core older than the field, and a guessed rate is the exact defect
     * this replaced (a hand-copied `60` against the core's `120`). A newer guess
     * would only move it.
     *
     * 🔴 ZERO IS NOT SILENT. `changesUncharged` below counts the `M0` moves that
     * got nothing, and the bar says so on the same footing as `untimed` — a
     * clock that quietly charges nothing for operator time reads as a program
     * that does not have any. */
    const changeSec = report?.tool_change_seconds ?? 0;
    const changeRateKnown = report?.tool_change_seconds != null;
    const n = moves.length;
    const endAt = new Float64Array(n);
    let t = 0;
    let px = 0;
    let py = 0;
    let pz = 0;
    let untimed = 0;
    let untimedMm = 0;
    let changes = 0;
    for (let i = 0; i < n; i++) {
      const m = moves[i];
      let sec = 0;
      if (m.kind === 'change') {
        // An `M0` is ONE move and however long the report says a person takes.
        sec = changeSec;
        changes += 1;
      } else if (i > 0) {
        const d = Math.hypot(m.x - px, m.y - py, m.z - pz);
        // `feed ?? rapid_mm_min` and NOT `feed ?? 0`: `undefined` here means the
        // move carries no `F` word, which for a `G0` means the machine's rapid
        // rate and for a probe means a rate this array does not carry.
        const mmMin = m.feed ?? (m.kind === 'rapid' ? rapidMmMin : null);
        if (mmMin != null && mmMin > 0) {
          sec = d / (mmMin / 60);
        } else if (d > 0) {
          untimed += 1;
          untimedMm += d;
        }
      }
      t += sec;
      endAt[i] = t;
      px = m.x;
      py = m.y;
      pz = m.z;
    }
    return {
      endAt,
      total: t,
      moves: n,
      untimed,
      untimedMm,
      changes,
      changeSec,
      changeRateKnown,
      /** `M0` moves the clock charged NOTHING for, because no rate arrived. */
      changesUncharged: changeRateKnown ? 0 : changes,
      /** Whether the rate is somebody's declaration or the core's own default.
       *  Absent reads as undeclared — the weaker claim, deliberately. */
      changeRateDeclared: report?.tool_change_rate_declared === true,
    };
  }, [report]);

  /** First move not yet finished at program-time `t`. Binary search over `endAt`. */
  const indexAt = useCallback(
    (t: number) => {
      const { endAt } = timeline;
      let lo = 0;
      let hi = endAt.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (endAt[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [timeline]
  );

  /* A new program is a new clock. Without this, pressing play after a re-plan
   * resumes at a second that belonged to a different job. */
  useEffect(() => {
    setPlaying(false);
    clockRef.current = 0;
    setClockShown(0);
    setProgress(1);
    if (report) setPlaybackResetNote('Program changed — playback reset');
  }, [report]);

  /**
   * The playback loop.
   *
   * 🔴 `progress` is written at most {@link PROGRESS_HZ} times a second, and
   * only when the playhead has crossed into a new move — because **the viewport
   * rebuilds its entire scene whenever `progress` changes**, so the write rate
   * is this animation's cost model. See `PROGRESS_HZ` for what that ceiling was
   * and was not measured to buy.
   *
   * 🔴 The clock is integrated from `performance.now()` and NEVER from a frame
   * count, which is what makes the speed multiplier honest: if the main thread
   * stalls, the next frame's `dt` is correspondingly larger and the playhead
   * jumps. A stalled page therefore gets a COARSER animation, never a longer or
   * shorter program. Measured whole-program against the production build
   * (`plate`, 550 moves, 152s): wall/expected 0.995 and 0.992 at x1, 1.019 and
   * 1.004 at x2, 1.064 and 1.002 at x5, 1.071 and 1.068 at x10 — the residual
   * at x10 is render/paint latency under load on a shared box, not clock drift.
   */
  useEffect(() => {
    if (!playing) return;
    const { total, moves } = timeline;
    if (!(total > 0) || moves === 0) return;
    let last = performance.now();
    let lastDraw = 0;
    let raf = 0;
    const step = (now: number) => {
      // Wall-clock, scaled. This multiplier touches NOTHING else.
      clockRef.current = Math.min(total, clockRef.current + ((now - last) / 1000) * speed);
      last = now;
      const t = clockRef.current;
      if (now - lastDraw >= 1000 / PROGRESS_HZ) {
        lastDraw = now;
        const p = Math.min(1, (indexAt(t) + 1) / moves);
        const store = useCncStore.getState();
        if (store.progress !== p) store.setProgress(p);
      }
      const store2 = useCncStore.getState();
      if (Math.floor(store2.clockShown) !== Math.floor(t)) store2.setClockShown(t);
      if (t >= total) {
        // Stop AT the end rather than wrapping. A loop would make a program
        // look shorter than it is to anyone who glanced away.
        setClockShown(total);
        setProgress(1);
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, timeline, indexAt]);

  /* Scrubbing by hand moves the CLOCK too, so the readout can never describe a
   * different point of the program than the playhead is standing on. */
  const scrubTo = useCallback(
    (p: number) => {
      setProgress(p);
      const { endAt, moves } = timeline;
      if (!moves) return;
      const i = Math.min(moves - 1, Math.max(0, Math.floor(p * moves) - 1));
      clockRef.current = i < 0 ? 0 : endAt[i];
      setClockShown(clockRef.current);
    },
    [timeline]
  );

  /**
   * The imported drawing for the viewport, with a STABLE identity per report.
   *
   * ✅ WIRED 2026-08-09 (TODO #59) — it was HELD for nine days behind a reason
   * that had already been fixed. The Viewport call site carries the
   * re-measurement.
   *
   * ⚠ Memoised rather than inlined as `report ? (report.drawing ?? []) : undefined`
   * because `?? []` mints a NEW ARRAY ON EVERY RENDER, `props.drawing` is in the
   * viewport's scene-rebuild dependency list, and playback re-renders this
   * component up to 20 times a second — so inlined it would ask for a full
   * three.js scene rebuild on every one of those renders. A fresh literal in a
   * dependency array is a dependency that has always changed.
   *
   * ⚠ AND THAT IS A HAZARD, NOT A DIAGNOSIS — said plainly because the first
   * version of this comment got it wrong. I suspected identity churn was what
   * killed the rotate drag, wrote it up as measured, and the test STAYED RED
   * after this memo landed. The actual cause was a text overlay covering the
   * handle (see the call site). The churn is real and worth avoiding on its own
   * terms; it was not the defect, and this comment does not claim it was.
   */
  const drawingParts = useMemo(
    () => (report ? (report.drawing ?? []) : undefined),
    [report]
  );

  /** The core's own words about its own estimate, pulled next to the number. */
  const estimateNotes = useMemo(
    () =>
      (report?.notes ?? []).filter((n: string) => ESTIMATE_NOTE_PREFIXES.some((p) => n.startsWith(p))),
    [report]
  );

  /* Runs of same-kind moves for the coloured bar. MEMOISED — playback re-renders
   * this component and rebuilding a few dozen runs out of 9000 moves on every
   * frame is work the animation cannot afford. */
  const programRuns = useMemo(() => {
    const moves = report?.render ?? [];
    const runs: { kind: string; n: number }[] = [];
    for (const m of moves) {
      const last = runs[runs.length - 1];
      if (last && last.kind === m.kind) last.n += 1;
      else runs.push({ kind: m.kind, n: 1 });
    }
    return runs;
  }, [report]);

  /* =======================================================================
   * VIEW LAYERS — the eyes on the section headers (TODO #81)
   *
   * Founder, 2026-08-11: *"Instead of having the hide/show on the top of the 3d
   * what about put it into the left sidebar (Machine — hide/show; Spoilboard
   * hide/show; Workpiece … etc) like a small eye icon? … for all under
   * operation have all the stages of the routing, final is under
   * verification?"*
   *
   * 🔴 THE STATE LIVES HERE NOW, and that is what makes the move safe. It was a
   * `useState` inside `Viewport`. With the controls dispersed across eight
   * panels AND an `all`/`none` left on the canvas, a second copy anywhere would
   * be two controls for one layer that can disagree about what is on screen.
   * There is one record; every control reads and writes it.
   *
   * ⚠ It is DRAWING ONLY and it goes nowhere near the core. It is not in
   * `plan()`'s inputs, not persisted, not exported — hiding a class changes the
   * picture and never the program.
   * ===================================================================== */
  // layers — migrated to Zustand store
  /* 🔴 SEEDED FROM STORAGE, NOT FROM THE CONSTANT. A `useState(default)` plus an
   * effect that reads storage would render one frame in the wrong projection and
   * then jump — and on this tab that first frame is the one an operator glances
   * at to see whether a part fits. The lazy initialiser runs before the first
   * commit, so the persisted choice is the FIRST thing drawn. */
  // projection — migrated to Zustand store
  const chooseProjection = (p: Projection) => {
    useCncStore.getState().setProjection(p);
    rememberCncProjection(p);
  };
  const setLayersTo = (ks: Layer[], on: boolean) =>
    updateLayers((s) => {
      const next = { ...s };
      for (const k of ks) next[k] = on;
      return next;
    });

  /* ── THE MENU BAR — TODO #108 ───────────────────────────────────────────────
   *
   * Founder, 2026-08-11: *"create similar menu in 2bee.cnc what already exists
   * in 2bee.cad (File … etc)"*. The bar itself, what it deliberately does NOT
   * contain, and why it is a second component rather than an extraction, are all
   * in `cncMenu.tsx`. What lives here is the state three of its items drive.
   *
   * 🔴 `about` REPLACES THE SIDEBAR `About` PANEL RATHER THAN JOINING IT. That
   * panel existed because there was no menu — its own comment says so — and
   * leaving both would be two doors to one page of text, which is the
   * duplication this tab spent the day removing. The CONSTANTS did not move: the
   * dialog renders `CNC_NEVER_CUT` and `CNC_ABOUT_LINES`, the same two the
   * never-cut banner and the old panel rendered, so there is no second list.
   *
   * ⚠ The never-cut BANNER is untouched and stays outside every collapsible and
   * dismissible thing on this tab. An About behind a menu is exactly the state
   * the banner exists to be independent of. */
  // aboutOpen — migrated to Zustand store

  // ── CONTEXT MENU — TODO #64 ──────────────────────────────────────────────
  // ctxMenu — migrated to Zustand store
  // Close on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [ctxMenu]);
  /* ⚠ ESCAPE CLOSES IT, AND THE LISTENER IS ON THE DOCUMENT RATHER THAN ON THE
   * DIALOG. A `role="dialog"` that traps a reader with no keyboard way out is
   * the one thing worse than no dialog, and a `onKeyDown` on the box only fires
   * while focus is inside it — which it is not, because the dialog is opened
   * from a menu item that then unmounts. `ObjectPicker`'s popup takes the same
   * route for the same reason. */
  useEffect(() => {
    if (!aboutOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAboutOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [aboutOpen]);

  // Ctrl-Z undoes the last setup change. Only when the CNC tab is active and
  // no text input is focused — inside a textarea or input, Ctrl-Z is the
  // browser's native typing undo and must not be stolen.
  useEffect(() => {
    if (tab !== 'cnc') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') return;
        e.preventDefault();
        undoSetup();
        setUndoToast('Undo: restored previous setup');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tab, undoSetup]);

  // Auto-dismiss the undo toast after 2 seconds.
  useEffect(() => {
    if (!undoToast) return;
    const t = setTimeout(() => setUndoToast(null), 2000);
    return () => clearTimeout(t);
  }, [undoToast]);

  // Auto-dismiss the playback reset note after 3 seconds.
  useEffect(() => {
    if (!playbackResetNote) return;
    const t = setTimeout(() => setPlaybackResetNote(null), 3000);
    return () => clearTimeout(t);
  }, [playbackResetNote]);

  // Space toggles play/pause when the CNC tab is active and no text input is
  // focused — same guard as Ctrl-Z and the arrow keys.
  useEffect(() => {
    if (tab !== 'cnc') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      e.preventDefault();
      if (!playing && clockRef.current >= timeline.total) {
        clockRef.current = 0;
        setClockShown(0);
        setProgress(0);
      }
      const s = useCncStore.getState(); s.setPlaying(!s.playing);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tab, playing, timeline, setClockShown, setProgress]);

  // Arrow keys nudge the sheet position when no text input is focused.
  // Shift+Arrow = 10mm, plain Arrow = 1mm.
  useEffect(() => {
    if (tab !== 'cnc') return;
    const onKey = (e: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      const store = useCncStore.getState();
      store.setOriginX(Math.round((store.originX + dx) * 10) / 10);
      store.setOriginY(Math.round((store.originY + dy) * 10) / 10);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tab, setOriginX, setOriginY]);

  /** What the last job save or open did, in words. `null` = nothing yet. */
  // jobNote — migrated to Zustand store
  const openJobRef = useRef<HTMLInputElement | null>(null);

  /**
   * 🔴 WHAT THE UNCUT COUNTER ACTUALLY IS ON THIS REPORT — TODO #75.
   *
   * Three states, and the two that look identical on screen are the pair this
   * exists to separate: `0` because the test RAN and found nothing standing, and
   * `0` because the test never ran. `SimCounts::uncut_checked` is the only thing
   * that tells them apart, and until 2026-08-11 it crossed neither `cam.ts` nor
   * this file, so the panel keyed on `uncut > 0` and printed "on your job this
   * counter cannot fire" beside the `pocket` fixture's red 3.
   *
   * ⚠ Derived ONCE, here, and read by the row, the note and nothing else. The
   * class and the sentence disagreeing about which state the panel is in is the
   * defect this replaces, in a smaller form.
   */
  const uncutState: 'pending' | 'clean' | 'finding' = !report
    ? 'pending'
    : report.sim.uncut > 0
      ? 'finding'
      : report.sim.uncut_checked === true
        ? 'clean'
        : 'pending';

  /* ═══════════════════════════════════════════════════════════════════════
   * WHAT THE CANVAS DRAWS FOR THE BOARD — five states, not two
   * ═══════════════════════════════════════════════════════════════════════
   *
   * 🔴 FOUNDER, 2026-08-11, USING THE APP: *"I did choose a spoilboard but the
   * eye did not come up."*
   *
   * The cause is one expression. `scene.spoilboard` was `report?.spoilboard ??
   * null` while every other field three lines away falls back to what the
   * operator DECLARED — `clamps: report?.clamps ?? clamps`, `stock: report?.stock
   * ?? [stockX, stockY, thickness]`, `travel: … ?? [travelX, travelY]`. The board
   * was the only one that fell back to nothing. `Viewport`'s `spoilLive =
   * !!s.spoilboard`, so with no report the layer is not live, `liveLayersOf` does
   * not offer it, and — correctly, by the dead-control rule — **no eye is
   * rendered**. The eye was behaving exactly as designed and was being fed
   * nothing. On a fresh session that means the declaration is invisible until a
   * drawing has been chosen and a job has planned.
   *
   * ⚠ A CLAMP AND A BOARD ARE NOT THE SAME EXPOSURE, WHICH IS WHY THIS IS FIVE
   * STATES AND NOT A `??`. A clamp declaration is inert until a job checks it. A
   * board declaration can be **REFUSED BY THE CORE** — a size with no position,
   * both forms at once, an id the catalogue does not hold — and until now the
   * single `null` was doing double duty for *"no job has run"* and *"the core
   * rejected your board"*. Falling back naively would draw a board the core threw
   * away, and the canvas would contradict the panel's own refusal text.
   *
   * ── MEASURED, NOT ASSUMED (through this build's own wasm, 2026-08-11) ──────
   *   · a declaration the core INSTALLS  ⇒ `report.spoilboard` echoes the
   *     rectangle, **including when the plan itself is `ok: false`** — so the
   *     echo means "installed", never "the plan succeeded".
   *   · a declaration the core REFUSES   ⇒ echo `null` **and** a
   *     `SPOILBOARD NOT INSTALLED — …` note. Refusal is therefore
   *     distinguishable from silence, and it is what the panel already prints
   *     verbatim.
   *   · no declaration at all            ⇒ echo `null`, no note.
   *
   * ── WHAT IS DRAWN, PER STATE, AND WHY ─────────────────────────────────────
   *   echoed      the CORE's rectangle. The checked one wins over the declared
   *               one, always — this app reads the report and does not re-derive.
   *   refused     NOTHING. The canvas must agree with the refusal, not argue
   *               with it.
   *   declared    the operator's own declaration, before anything has planned.
   *               It is NOT a check and the panel says so in the same breath:
   *               the counters stay absent, the position limb still reports
   *               UNCHECKED. A picture that agrees with a program is not a check
   *               of it, and a picture with no program behind it is less again.
   *   incomplete  NOTHING — a declaration that has no position yet, or a
   *               catalogue id this build cannot resolve to a size. Which is
   *               also, and not by coincidence, **every case the core refuses**:
   *               the provisional needs a resolvable size and a position, so it
   *               cannot draw a board the core would have thrown away. That is a
   *               strictly weaker condition than the core's, never a copy of it.
   *   none        NOTHING, and no eye — which is the dead-control rule working.
   * ═══════════════════════════════════════════════════════════════════════ */
  const spoilboardNotInstalled = (report?.notes ?? []).filter((n: string) =>
    n.startsWith('SPOILBOARD NOT INSTALLED')
  );


  /**
   * The declaration as a rectangle, or `null` when it is not one yet.
   *
   * ⚠ THE SIZE COMES FROM THE CORE'S CATALOGUE, never from a number in this
   * file. A catalogue pick carries no size in the config — the core resolves it
   * — so drawing it before a plan means looking the row up in `spoilCat`, which
   * IS the core's list. The thickness comes from the same row for the same
   * reason.
   *
   * ⚠ THIS COMMENT ENDED *"a measured board has no thickness form at all, so it
   * stays `null`"* until 2026-08-11 (TODO #104). It was true and it was a
   * MISSING CAPABILITY described as a property — `SpoilboardCfg::thickness_mm`
   * existed in the core the whole time and the browser had no field to fill it.
   * There is one now, so a measured board's declared depth reaches this preview
   * and `boardSlab` draws a slab; a BLANK one still becomes `null` and still
   * renders as UNKNOWN, never as "thick enough".
   */
  const spoilboardDeclaredRect: SpoilboardCfg | null = (() => {
    if (!spoilboardCfg) return null;
    /* A board the SHOP states the size for — the measured row or one it saved.
     * `isMeasuredBoardId` is the one decision; see its header. */
    const measured = isMeasuredBoardId(spoilboardId);
    const row = measured ? null : (spoilCat?.spoilboards.find((s) => s.id === spoilboardId) ?? null);
    const x = typedMm(spoilboardX);
    const y = typedMm(spoilboardY);
    /* Both forms read `spoilboardInPlay`, which already resolved the catalogue
     * row when there is one — so the preview rectangle and what the panel grades
     * are one reading rather than two spellings of the same ternary. */
    const w = typedMm(spoilboardInPlay.sizeX);
    const h = typedMm(spoilboardInPlay.sizeY);
    if (x === undefined || y === undefined) return null;
    if (w === undefined || h === undefined || !(w > 0) || !(h > 0)) return null;
    /* 🔴 A THICKNESS THE OPERATOR TYPED IS DRAWN, and this is where the picture
     * stopped being able to show one. Until 2026-08-11 a measured board's
     * thickness was hard-`null` here — correctly, because there was no field to
     * hold it — so `boardSlab` rendered it as UNKNOWN with its dashed perimeter
     * forever. There is a field now, so a declared depth becomes a SLAB with a
     * visible underside, and a blank one stays UNKNOWN. `typedMm` is what keeps
     * `''` from becoming `0`. */
    const t = typedMm(spoilboardInPlay.thickness);
    return {
      catalogue_id: null,
      name: measured ? spoilboardName.trim() || null : (row?.label ?? null),
      x_mm: x,
      y_mm: y,
      size_x_mm: w,
      size_y_mm: h,
      thickness_mm: t === undefined ? null : t,
    };
  })();

  const spoilboardDrawn: {
    state: 'echoed' | 'refused' | 'declared' | 'incomplete' | 'none';
    board: SpoilboardCfg | null;
    why: string;
  } = (() => {
    if (report?.spoilboard) {
      return {
        state: 'echoed',
        board: report.spoilboard,
        why:
          'Drawn from the CORE — this is the rectangle the checks were run against, not the one ' +
          'typed above. If the two ever differ, the core is right and the panel is stale.',
      };
    }
    if (spoilboardNotInstalled.length) {
      return {
        state: 'refused',
        board: null,
        why:
          'NOTHING IS DRAWN, because the core REFUSED this declaration and installed no board. Its ' +
          'reason is printed below in its own words. A picture of a board the core threw away would ' +
          'be the canvas contradicting the check.',
      };
    }
    if (!spoilboardCfg) {
      /* 🔴 `why` IS EMPTY HERE AND THAT IS THE ANSWER, NOT AN OVERSIGHT — the
       * string that stood here could never reach a screen. `spoilboardDrawn.why`
       * has exactly one consumer and it is guarded by
       * `state !== 'none'`; the branch itself is load-bearing for the eye and the
       * canvas and must stay.
       *
       * ⚠ THE GUARD IS RIGHT AND THE STRING WAS WRONG — checked in that order,
       * because an unreachable REFUSAL would mean a case that can no longer be
       * reported, which is worse than dead code. This is not a refusal: `none`
       * is "nobody declared a board" (`spoilboardCfg` is undefined exactly when
       * `spoilboardId` is empty), the core's refusal is the separate `refused`
       * state above, and the state IS reported — by `spoilboard-no-default`,
       * rendered on the same condition and stronger, because it names the
       * consequence (*"the position check reports UNCHECKED"*) rather than the
       * absence of a control. Two sentences for one state was the defect; the
       * one that survives is the one that says what it costs. */
      return { state: 'none', board: null, why: '' };
    }
    if (!spoilboardDeclaredRect) {
      /* ⚠ A CATALOGUE THAT HAS NOT ARRIVED IS NOT AN INCOMPLETE DECLARATION.
       * `spoilCat` is `null` until the wasm answers, and a catalogue board's
       * size lives in it — so for one moment on load the rectangle cannot be
       * built for a reason that is nothing to do with what the operator typed.
       * Saying "you have not given it a position" then would be this panel
       * blaming the user for its own load order. */
      const waiting = !spoilCat && !isMeasuredBoardId(spoilboardId);
      return {
        state: 'incomplete',
        board: null,
        why: waiting
          ? 'The board catalogue has not arrived from the core yet, so the board this names cannot ' +
            'be drawn. Nothing is wrong with the declaration; nothing has been checked either.'
          : 'NOTHING IS DRAWN YET. This declaration is not a rectangle on the machine — it needs a ' +
            'position (Board X and Board Y) and a size this build can resolve. Those are the same two ' +
            'facts the core needs before it will install anything.',
      };
    }
    return {
      state: 'declared',
      board: spoilboardDeclaredRect,
      why:
        'Drawn from YOUR DECLARATION, because nothing has been planned yet. It is a picture of what ' +
        'you typed and it is NOT a check: the position limb still reports UNCHECKED and no ' +
        'past-the-edge count exists until a job plans. Plan one and this redraws from the core.',
    };
  })();

  /* 🔴 ONE OBJECT, TWO CONSUMERS, AND THE JSX BELOW READS ITS FIELDS.
   *
   * The eyes are rendered from `liveLayersOf(scene)` and the canvas draws from
   * `<Viewport …>`. If those two were fed separately, the sidebar could offer an
   * eye for a layer the scene does not contain — which is exactly the failure
   * the dead-control rule exists to stop, arriving through the back door. So
   * every prop the liveness question depends on is assigned FROM this object,
   * and feeding the two surfaces different values now requires editing a prop to
   * stop using it. */
  const scene: LayerScene = {
    tool: selectedTool,
    drawing: drawingParts,
    loaded: imported ? { name: imported.name, format: shownFormat } : null,
    loadedMesh: report?.loaded_mesh ?? null,
    stockSurface: report?.simulated_stock_surface ?? null,
    touchPlate: {
      enabled: probeEnabled && touchPlateMm.trim() !== '',
      x: 0,
      y: 0,
      thickness_mm: Number(touchPlateMm || 0),
    },
    clamps: report?.clamps ?? clamps,
    /* 🔴 NOT `report?.spoilboard ?? null` — see the five states above. That
     * expression is what made the eye disappear for a board the operator had
     * declared, and a bare `??` to the declaration is what would draw a board
     * the core refused. */
    spoilboard: spoilboardDrawn.board,
    moves: report?.render ?? [],
    travel: report?.travel ? [report.travel[0], report.travel[1]] : [travelX, travelY],
    stock: report?.stock ?? [stockX, stockY, thickness],
  };
  const liveLayers = liveLayersOf(scene);

  /**
   * 🔴 WHAT A SECTION SHOWS WHEN IT OWNS LAYERS AND NONE ARE LIVE: **no eye at
   * all**, and that is a decision rather than an omission.
   *
   * A disabled eye reads as *"this is hidden"*. *"There is none"* and *"there is
   * one and you cannot see it"* are different facts and only one of them is
   * true — and on a bed, reading the second as the first is how a clamp that was
   * never declared becomes a bed somebody believes is clear. It is the same
   * refusal `Fixturing` makes in the core and the same one the chips made
   * (`presentKinds`' rule) before they moved here.
   *
   * The absence is stated in WORDS instead, in the two places that already do
   * it: the canvas reason lines (`loaded-unavailable`, `walls-unavailable`,
   * `result-unavailable`, `spoilboard-undeclared`) and, for the touch plate, the
   * Machine panel's own `touchplate-undeclared`. An absent control with no
   * explanation is a feature nobody thought of; an absent control with one is
   * the honest rendering of nothing being there.
   */
  const sectionEye = (panel: string, title: string) => {
    const live = liveLayers.filter((k) => LAYER_SECTION[k] === panel);
    if (live.length === 0) return undefined;
    return (
      <SectionEye
        testid={`section-eye-${panel.replace(/^panel-/, '')}`}
        section={title}
        live={live}
        layers={layers}
        onSet={setLayersTo}
      />
    );
  };

  /**
   * The per-layer controls, at the foot of the panel that owns them.
   *
   * ⚠ THEY KEEP THE `kind-<layer>` TESTID THE CANVAS CHIPS HAD, because this is
   * the SAME control moved rather than a new one: the thing a caller wants when
   * it asks for `kind-cut` is still "the control for the cut layer". What
   * changed is where it is and when it is reachable — a collapsed section does
   * not render its body, so these exist only while the panel is open. The header
   * eye is the one that works either way.
   *
   * ⚠ The `<i>` swatch is kept, and kept generated by `swatch()` from the same
   * numbers the scene draws with. The chip row was the app's only legend for the
   * move-class colours — the colours that tell a rapid from a cut — so losing
   * the swatch here would have quietly cost that.
   *
   * ⚠ `title` IS THE SECTION HEADING, and it is passed rather than looked up
   * from a table for the same reason `sectionEye` takes one: `LAYER_SECTION` is
   * keyed on the panel's testid precisely because the title is prose. It is used
   * for the TODO #77 comparison below and for nothing else.
   */
  const sectionLayerRows = (panel: string, title: string) => {
    const live = liveLayers.filter((k) => LAYER_SECTION[k] === panel);
    if (live.length === 0) return undefined;
    return (
      <div className="layer-list" data-testid={`layers-${panel.replace(/^panel-/, '')}`}>
        {live.map((k) => {
          const shown = layers[k];
          return (
            <button
              key={k}
              type="button"
              className="layer-row"
              data-testid={`kind-${k}`}
              aria-pressed={shown}
              title={layerTitle(k, scene, shown)}
              onClick={() => setLayersTo([k], !shown)}
            >
              {/* 🔴 Outlined = a reference shape, filled = a solid in the scene.
                  The hue alone would not carry that, and it is the treatment,
                  not the colour, that stops the drawing being read as the
                  machined result. The board is filled with the panel neutral and
                  so needs a line around it to be visible at all. */}
              <i
                style={
                  k === 'walls' || k === 'travel'
                    ? { border: `1px solid ${swatch(k)}`, background: 'transparent' }
                    : k === 'spoilboard'
                      ? { background: swatch(k), border: '1px solid var(--line)' }
                      : { background: swatch(k) }
                }
              />
              <span className="layer-name">
                {/* 🔴 TODO #77 REACHES THE LAYER ROWS TOO. `LAYER_LABEL` must
                    NOT change — it is also the canvas legend and every value in
                    it is a deliberate anti-collapse choice — so the suppression
                    is here, at the render, under the picker's own comparison.
                    One row is affected today (`Workpiece` owns a layer labelled
                    `workpiece`); `Spoilboard` is NOT, because `spoilboard
                    (sacrificial material)` carries a fact the heading does not.

                    🔴 CLIPPED, NOT DELETED. This span is the button's only text
                    and therefore its accessible name — an empty one announces as
                    a swatch and an eye. */}
                <span
                  className={labelRepeatsHeading(LAYER_LABEL[k], title) ? 'op-label-quiet' : undefined}
                  data-quiet={labelRepeatsHeading(LAYER_LABEL[k], title) ? 'true' : 'false'}
                >
                  {LAYER_LABEL[k]}
                </span>
                {/* The cell size rides ON the control, not only in a tooltip. It
                    is the resolution of the thing being drawn, and a feature
                    narrower than one cell is ABSENT from the data. */}
                {k === 'result' && scene.stockSurface
                  ? ` (${L(scene.stockSurface.cell_mm)} cells)`
                  : ''}
              </span>
              <EyeIcon open={shown} />
            </button>
          );
        })}
      </div>
    );
  };

  const download = () => {
    if (!report?.gcode) return;
    const blob = new Blob([report.gcode], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${report.job}-${toolId.replace(/[^\w.-]+/g, '_')}.nc`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ── WHAT THE MENU BAR DOES — TODO #108 ────────────────────────────────────
   *
   * 🔴 EVERY COMMAND DRIVES STATE THAT ALREADY EXISTED, or calls a function that
   * already existed. Nothing in this switch is a second copy of a setting: the
   * projection pair writes the one `projection` state (whose sidebar block is
   * gone in this same change), `discard` is the restore banner's own two lines,
   * and the two job commands are the only genuinely new capability.
   *
   * ⚠ AN UNKNOWN COMMAND IS A NOTED FAILURE, NOT A SILENT ONE. A menu item whose
   * id nothing handles is a control that looks live and is not — the defect both
   * bars exist to avoid — and the way it arrives is somebody adding an item and
   * not the case. `tests/cnc-menu.test.ts` asserts every id in `cncMenus()` has a
   * branch here; this is the runtime half of the same rule. */
  const runMenuCommand = (id: string) => {
    switch (id) {
      case 'file.save-job': {
        /* Refused rather than written while the async restore is in flight —
         * see `CncMenuContext.saveBlocked`. The item is disabled too; this is
         * the second lock, because a disabled item is a picture and a keyboard
         * or a driver can still reach a handler. */
        if (!ready) {
          setJobNote({
            tone: 'bad',
            text:
              'Nothing was written. The tool selection and the material are still being restored, ' +
              'and a job saved now would carry the DEFAULT cutter over the one you chose.',
          });
          return;
        }
        const text = encodeJob(sessionValues, Date.now());
        const blob = new Blob([text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '2bee-job.json';
        a.click();
        URL.revokeObjectURL(a.href);
        setJobNote({
          tone: 'note',
          text:
            `Job written — ${SESSION_KEYS.length} settings. It does NOT carry: ` +
            `${JOB_NOT_SAVED.map((n) => n.field).join(', ')}. Those are stated in the file itself ` +
            `and are asked again wherever it is opened.`,
        });
        return;
      }
      case 'file.open-job':
        openJobRef.current?.click();
        return;
      case 'file.discard-session':
        /* Clear AND reload, in one act — the same pairing the restore banner
         * uses and for its reason: clearing alone would be a lie, because the
         * next change to any field writes the setup straight back. */
        clearSession();
        window.location.reload();
        return;
      case 'view.projection.orthogonal':
        chooseProjection('orthographic');
        return;
      case 'view.projection.perspective':
        chooseProjection('perspective');
        return;
      /* 🔴 THESE TWO WRITE A DISPLAY PREFERENCE AND NOTHING ELSE — TODO #109.
       * No `set*` for a dimension is called here, no re-plan is triggered, and
       * no value is converted on the way in. That is the whole safety property:
       * a unit switch that writes a converted number back into state is a wrong
       * part two switches later. */
      case 'view.units.mm':
        chooseUnit('mm');
        return;
      case 'view.units.in':
        chooseUnit('in');
        return;
      case 'help.about':
        setAboutOpen(true);
        return;
      case 'help.alarm-codes':
        window.open(
          'https://github.com/grblHAL/wiki/blob/master/alarms.md',
          '_blank',
          'noopener,noreferrer'
        );
        return;
      case 'help.error-codes':
        window.open(
          'https://github.com/grblHAL/wiki/blob/master/errors.md',
          '_blank',
          'noopener,noreferrer'
        );
        return;
      default:
        setJobNote({
          tone: 'bad',
          text: `The menu item "${id}" is not wired to anything in this build — nothing happened.`,
        });
    }
  };

  /* ── THE HANDOFF, DERIVED ONCE ──────────────────────────────────────────────
   *
   * What COULD be handed over right now (or the sentence saying why not), and
   * how that relates to what the Run tab is already holding. Both are pure and
   * both live in `runProgram.ts`; nothing here re-derives either.
   *
   * ⚠ `runBuild` is deliberately NOT what the Run tab receives. It is what the
   * hand-over control would give it. The tab receives `programForRunTab`, which
   * is the latch. */
  const runBuild = useMemo(() => runProgramFromReport(report), [report]);
  const heldVerdict = heldProgramVerdict(heldProgram, runBuild);

  if (loadError) {
    return (
      <div className="fatal" data-testid="fatal">
        <h1>The CAM core did not load</h1>
        <pre>{loadError}</pre>
        <p>No program can be produced until this is fixed. Nothing is being computed in its place.</p>
      </div>
    );
  }

  const blocked = report && !report.ok;

  /* ── THE FOUR PICKERS' OWNERSHIP ANSWERS — TODO #83 ─────────────────────────
   *
   * One `mergeInventory` per kind, computed here rather than inside each picker,
   * so a row and the source line above it cannot be built from two different
   * reads of the document.
   *
   * 🔴 BARE CATALOGUE IDS, and each one is a different field: the machine's
   * DISPLAY NAME (those presets have no id — see `inventoryFor`), the
   * spoilboard's `id` from the core's catalogue, the hold-down's `id` from
   * `workholding.ts`, the cutter's `id` from the core's library. `SPOILBOARD_CUSTOM`
   * is deliberately NOT in the spoilboard catalogue: it is not a board, it is the
   * row that says "you measured one", and asking whether the shop owns it is not
   * a question.
   *
   * ⚠ Only the SHIPPED catalogue is handed over. A machine the operator saved in
   * this browser is not a catalogue entry, so it keeps `yours()` and gets no
   * ownership verdict — "you typed this here" already answers a stronger version
   * of the question than an inventory file could. */
  const machineInv = inventoryFor(
    'machine',
    MACHINE_PRESETS.map((m) => ({ id: m.name, name: m.name }))
  );
  const spoilboardCatalogueRows: CatalogueRow[] = (spoilCat?.spoilboards ?? []).map((s) => ({
    id: s.id,
    name: s.label,
  }));
  const spoilboardInv = inventoryFor('spoilboard', spoilboardCatalogueRows);

  /* ═══════════════════════════════════════════════════════════════════════════
   * WHAT `panel-spoilboard` IS HOLDING — decided ONCE, for the badge AND the body
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 🔴 WHY THIS EXISTS: `Section` collapse is STICKY, and a shut section renders
   * NOTHING. Until 2026-08-12 `panel-spoilboard` had no `badge`, so an operator
   * who collapsed it once could carry a `SPOILBOARD POSITION NOT CHECKED`
   * sentence — or `THIS BOARD CANNOT COVER THE REACH` — across every later job,
   * on a screen that looks EXACTLY like one with a measured board under it.
   * `Section`'s `badge` doc block states that rule in general terms; this is the
   * panel it was still open on, and it is named in `docs/plan-2026-08-12` as the
   * thing that has to exist before the notes-duplication question can even be
   * ASKED.
   *
   * ⚠ IT IS DERIVED HERE, ABOVE THE PANEL, FOR ONE REASON: `badge` is a prop on
   * `<Section>` and the sentences are rendered inside its children, so a badge
   * computed at the call site would be a SECOND PRODUCER of the same numbers —
   * the exact defect `112d2e34b9` fixed on the CAD console badge, where a second
   * sum was blind to a whole class the pane listed. The body destructures what it
   * renders FROM HERE. One list; the badge is its length.
   *
   * ── WHAT COUNTS, AS A RULE AND NOT AS A HAND-PICKED SET ───────────────────
   * **Every `<p>` SENTENCE this panel renders in `warn`, `bad` or `pending`** —
   * the three classes this app paints "something is wrong" and "something was not
   * asked" with. A rule rather than a list, because a list goes blind to whatever
   * is added next: `tests/spoilboard-badge.test.ts` enumerates the panel's
   * paragraphs out of this file and goes RED on any alarming one that is neither
   * counted here nor excluded with a reason.
   *
   * ── WHAT IS NOT COUNTED, AND WHY ──────────────────────────────────────────
   *   · The status GRID's cells (`spoilboard-past`, `spoilboard-provenance`,
   *     `spoilboard-bare`). Each alarm state in that grid has one of the counted
   *     SENTENCES behind it — `PENDING` there is the core's PENDING note here,
   *     a red count arrives with the strike note, and an ASSUMED corner prints
   *     `spoilboard-assumed`. Counting a value and its own sentence would inflate
   *     the badge by two with only one thing hidden.
   *   · `spoilboard-save-refused`. It is the answer to a button the operator has
   *     just pressed, which they cannot do with the panel shut, and the next
   *     action clears it. It says nothing about the board under the cutter.
   *   · The depth limb's `THROUGH-THE-BOARD NOT CHECKED` note. This panel does
   *     not print it — it reaches `Notes and warnings` — and a badge counting a
   *     sentence its own body does not show is the failure this block is built
   *     against.
   *
   * ── WHAT THE NUMBER PROMISES ──────────────────────────────────────────────
   * **How many sentences are hidden**, split into warnings and PENDINGs. NOT a
   * hazard count: with no board declared the panel prints the no-default
   * sentence, the "Not declared — position UNCHECKED" status and the core's
   * PENDING note, and the badge says three because three sentences are hidden.
   * That is the promise `112d2e34b9` settled for the console badge — a count of
   * what the pane has to say, never a claim about class — and re-deriving a
   * "distinct hazards" figure here would be the second producer under a new name.
   * ═══════════════════════════════════════════════════════════════════════════ */
  const spoilboardFindings = (() => {
    /* The core's own sentences, selected by the same three filters the body ran
     * inline until 2026-08-12. Moved, not rewritten. */
    const notInstalled = spoilboardNotInstalled;
    const strike = (report?.notes ?? []).filter((n: string) =>
      n.includes('PAST THE EDGE OF THE SPOILBOARD')
    );
    const pending = (report?.notes ?? []).filter((n) =>
      n.startsWith('SPOILBOARD POSITION NOT CHECKED')
    );

    /* A field with something in it that is not a number. It cannot travel — `NaN`
     * serialises as `null` and reads as absent — so it is named rather than
     * turning into a silent "not declared". The body renders ONE sentence naming
     * all of them however many there are, which is why it contributes ONE item.
     *
     * 🔴 THE THICKNESS IS IN THIS LIST AND ITS FAILURE IS THE QUIET ONE. `18mm`
     * typed with the unit reaches the core as nothing at all, and an omitted
     * thickness is a PERFECTLY LEGITIMATE state — the depth limb reports PENDING
     * with a reason and nothing looks broken. So a typo here is indistinguishable
     * from a decision unless it is named, which is exactly the failure this whole
     * list exists for.
     *
     * ⚠ `measured` is `isMeasuredBoardId` — the ONE decision about which board
     * forms state their own size, called rather than re-spelled, so a third form
     * cannot reach four of the five branches. */
    const measured = isMeasuredBoardId(spoilboardId);
    const unparseable = ([
      ['Board X', spoilboardX],
      ['Board Y', spoilboardY],
      ...(measured
        ? ([
            ['Board size X', spoilboardSizeX],
            ['Board size Y', spoilboardSizeY],
            ['Board thickness', spoilboardThickness],
          ] as [string, string][])
        : []),
    ] as [string, string][]).filter(([, v]) => v.trim() !== '' && typedMm(v) === undefined);

    /* The machine every verdict is about. The ECHO first, so the picker, the fit
     * and the status all talk about the machine the core planned with rather than
     * a pending edit. */
    const mTravelX = report?.travel?.[0] ?? travelX;
    const mTravelY = report?.travel?.[1] ?? travelY;
    /* The size currently in play — ONE reading, so the fit, the reach verdict and
     * what `Save as` captures cannot describe three different rectangles. */
    const sizeX = typedMm(spoilboardInPlay.sizeX) ?? NaN;
    const sizeY = typedMm(spoilboardInPlay.sizeY) ?? NaN;
    /* 🔴 RE-ASKED EVERY RENDER, NOT AT SELECTION. The catalogue rows carry this
     * verdict, so a board was graded when it was PICKED; nothing graded the board
     * that is actually declared. A check that ran once and went stale is worse
     * than one that never ran, because the operator remembers seeing it pass. */
    const reach =
      Number.isFinite(sizeX) && Number.isFinite(sizeY)
        ? spoilboardReachVerdict(sizeX, sizeY, mTravelX, mTravelY, unit)
        : null;
    const assumed = spoilboardPos === 'assumed';
    /* A board chosen before the inventory said the shop does not have it. Same
     * expression the panel renders from — a measured or saved board is excluded
     * because it is not a catalogue id. */
    const inventoryRefused = measured
      ? null
      : inventoryRefusal('spoilboard', spoilboardId, spoilboardCatalogueRows);
    const travelDrift =
      spoilboardTravels != null &&
      (spoilboardTravels[0] !== travelX ||
        spoilboardTravels[1] !== travelY ||
        spoilboardTravels[2] !== travelZ);

    const echo = report?.spoilboard ?? null;
    /* One entry per RENDERED SENTENCE, carrying the `data-testid` of the element
     * it is, so the list can be checked against the markup rather than against a
     * second count. `warn` here means the element's class is `warn` or `bad` —
     * the badge splits WRONG from UNASKED, not one shade of wrong from another.
     * The order is the body's reading order. */
    const items: { tone: 'warn' | 'pending'; testid: string }[] = [
      ...(inventoryRefused ? [{ tone: 'warn' as const, testid: 'spoilboard-inventory-refused' }] : []),
      ...(spoilboardId && reach && !reach.covers
        ? [{ tone: 'warn' as const, testid: 'spoilboard-reach' }]
        : []),
      ...(spoilboardId && assumed ? [{ tone: 'warn' as const, testid: 'spoilboard-assumed' }] : []),
      ...(spoilboardId && spoilboardMachineNote && spoilboardMachineNote.tone !== 'note'
        ? [{ tone: 'warn' as const, testid: 'spoilboard-machine-note' }]
        : []),
      ...(spoilboardId && travelDrift
        ? [{ tone: 'warn' as const, testid: 'spoilboard-travel-drift' }]
        : []),
      /* `echoed` is the only state drawn as a plain note — every other one that
       * renders is the canvas explaining what it is NOT showing. */
      ...(spoilboardDrawn.state !== 'none' && spoilboardDrawn.state !== 'echoed'
        ? [{ tone: 'warn' as const, testid: 'spoilboard-drawn' }]
        : []),
      ...(!spoilboardId && spoilCat ? [{ tone: 'warn' as const, testid: 'spoilboard-no-default' }] : []),
      ...(unparseable.length ? [{ tone: 'warn' as const, testid: 'spoilboard-unparseable' }] : []),
      ...notInstalled.map(() => ({ tone: 'warn' as const, testid: 'spoilboard-not-installed' })),
      ...(report && echo == null ? [{ tone: 'pending' as const, testid: 'spoilboard-status' }] : []),
      ...strike.map(() => ({ tone: 'warn' as const, testid: 'spoilboard-strike' })),
      ...pending.map(() => ({ tone: 'pending' as const, testid: 'spoilboard-pending' })),
      ...(!spoilCat ? [{ tone: 'pending' as const, testid: 'spoilboard-catalogue-pending' }] : []),
    ];

    /* 🔴 WHILE SHUT ONLY, and that is `Section`'s existing rule rather than a new
     * one — `453786fe2e`'s `{!open && badge}`, used unchanged.
     *
     * ⚠ THE OTHER PRECEDENT WAS CHECKED AND DOES NOT APPLY. `112d2e34b9` kept the
     * CAD dock's badge visible at all times because that dock's height is clamped
     * to zero in two places AND PERSISTED, so "this tab is selected" did not mean
     * "its pane is on screen" — a guard keyed on the tab alone would have given
     * that state no pane AND no badge, reinstating the no-signal condition through
     * another door. `Section` has no such state: the body is `{open && …}`, there
     * is no height, no clamp and nothing persisted but the boolean itself, so
     * `open` is exactly "the sentences are in the DOM". The condition that made
     * the always-visible badge the safer choice there is absent here, and a number
     * printed an inch above the sentences it counts is the duplicate
     * `453786fe2e` removed.
     *
     * ⚠ WARNINGS LEAD AND ARE COUNTED SEPARATELY from PENDINGs — `panel-notes`'
     * badge settled that: one number would make two warnings and no pending look
     * identical to two pendings and no warning, which is the distinction the whole
     * badge exists for. `null` when there is nothing to say; a badge that is
     * always on is a badge nobody reads. */
    const w = items.filter((i) => i.tone === 'warn').length;
    const p = items.length - w;
    const badge =
      w > 0
        ? {
            text: `${w} warning${w === 1 ? '' : 's'}${p ? ` · ${p} PENDING` : ''}`,
            tone: 'bad' as const,
          }
        : p > 0
          ? { text: `${p} PENDING`, tone: 'warn' as const }
          : null;

    return {
      notInstalled,
      strike,
      pending,
      unparseable,
      measured,
      mTravelX,
      mTravelY,
      sizeX,
      sizeY,
      reach,
      assumed,
      inventoryRefused,
      travelDrift,
      items,
      badge,
    };
  })();

  const workholdingCatalogueRows: CatalogueRow[] = WORKHOLDING.map((w) => ({
    id: w.id,
    name: w.name,
  }));
  const workholdingInv = inventoryFor('workholding', workholdingCatalogueRows);
  /* 🔴 FITNESS IS HANDED IN, NEVER DERIVED IN `inventory.ts` — it is the CORE's
   * collet verdict, passed through verbatim. `blockFor` then keeps the two
   * reasons a row can be unusable APART and prints both when both apply: "you do
   * not own this" sends someone to a purchase order, "no collet holds it" sends
   * them to the drawer, and a row saying only "unusable" sends them nowhere. */
  const toolCatalogueRows: CatalogueRow[] = (lib?.tools ?? []).map(  (t: ToolRow) => ({
    id: t.id,
    name: t.id,
    fitness: { fits: t.selectable !== false, why: t.fit_why },
  }));
  const toolInv = inventoryFor('tool', toolCatalogueRows);

  return (
    <div className="app">
      <header className="topbar">
        {/* 🔴 THE NAME, AND ONLY THE NAME — founder, 2026-08-11: *"remove the
            header: 2bee.slicer CNC CAM · grblHAL to just 2bee.app"*.
            Two separate wrongs went with that string, which is why it is a
            correction and not only a layout change:
              · **`2bee.slicer` IS A DEAD PRODUCT NAME.** The lane was renamed to
                `2bee.app` on 2026-08-09 and this header kept shipping the old one
                to the operator — the same residue a sweep is chasing across the
                rest of the lane. `index.html`'s <title> was already fixed; this
                was the other user-visible copy.
              · **`CNC CAM · grblHAL` WAS A SCOPE CLAIM THAT STOPPED BEING TRUE.**
                The app has a CAD tab and a Run tab. A strapline naming one of the
                three is a header describing an app this is not.
            The MARK is not deleted — it moved to the tab row below, where the
            founder asked for it. It is the same `.mark` span driven by the same
            `--brand-mark` CSS variable; nothing was copied, redrawn or re-themed
            to move it. */}
        <div className="brand">
          <span className="name">
            <strong>2bee.app</strong>
          </span>
        </div>
        <div className="topright">
          {showFixtures ? (
            <label className="inline">
              Job
              <select
                value={job}
                onChange={(e) => setJob(e.target.value)}
                data-testid="job-select"
                title="Built-in gate fixtures. NOT drawings — they bypass the importer."
              >
                {jobs.map((j) => (
                  <option key={j.name} value={j.name}>
                    {j.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {/*
            🔴 OFF THE OPERATOR SURFACE — founder, 2026-08-08, after asking what
            "Plant" meant. That question was the answer: a control nobody outside
            this lane can name does not belong in a machining UI.

            A plant is a DELIBERATE DEFECT, and four of them emit a runnable
            program rather than a refusal, by design — the gates compare a clean
            run against a planted one, so the planted one has to post. Measured:
            `no-tabs` 8276 bytes, `gouge` 10837, `cut-clamp` 10436,
            `shallow-floor` 10436, none refused. In the operator UI that is a
            person one click from exporting a program that drives a cut across
            the part or leaves it untabbed under a 2.2 kW spindle. This lane's
            own rule says a plant path must not leak into a real job; it had been
            leaking since the UI was built.

            Kept behind `?plants=1` rather than deleted, for ONE reason: the
            browser suite proves the SIMULATION catches a planted gouge, and that
            test needs a way to plant one. Deleting the control would delete the
            only route the E2E has to arm that check, and a safety check with no
            way to fire it is the thing this whole lane exists to prevent. It is
            a query parameter, not a build flag, because the suite runs against
            the production build where a dev flag is compiled out.
          */}
          {showPlants ? (
            <label className="inline">
              Plant
              <select
                value={plant}
                onChange={(e) => setPlant(e.target.value)}
                data-testid="plant-select"
                title="Deliberate defects, for proving the checks actually fire. NOT for cutting."
              >
                <option value="">none</option>
                {plants.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </header>

      {/* THE TAB BAR — founder 2026-08-11: *"1st tab cad, 2nd tab CNC, 3rd tab
          operation, this is where I will execute and monitor the CNC router"*.
          Order is his. Which one OPENS is a different question and is answered
          in `Tabs.tsx` (`DEFAULT_TAB`), with the reasons.

          It sits BELOW the header rather than inside it, so the brand, the theme
          toggle and the gate instruments stay app-wide: they are not properties
          of the CNC tab and must not disappear when another tab is showing.

          🔴 THE ROW NOW CARRIES THE MARK AND THE THEME TOGGLE — founder,
          2026-08-11: *"move the dark/light to the 2bee.cad, 2bee.cnc, Run row;
          add the logo to this row"*.

          ⚠ `TabBar` IS NOT MODIFIED AND TAKES NO CHILDREN. The two controls are
          SIBLINGS of it inside `.tabrow`, so the tablist stays exactly the set of
          elements the WAI-ARIA pattern expects — a mark or a button inside
          `role="tablist"` would be announced as part of the tab set, and the
          roving-tabindex arithmetic in `Tabs.tsx` counts `TABS`, not children.

          🔴 AND THE TOGGLE'S BEHAVIOUR IS UNTOUCHED. It is the same `setDark`
          on the same `dark` state, persisted by the same session write and
          applied by the same `document.documentElement.dataset.theme` effect.
          This is a move, not a re-implementation: there is an open `[data-theme]`
          question with `brand`, and a second theme mechanism introduced while
          relocating a button is exactly how that answer would get pre-empted by
          an accident. */}
      <div className="tabrow">
        {/* The 2bee.farm master mark. Which variant renders is decided entirely
            in CSS (`--brand-mark`, styles.css) by the same [data-theme] /
            prefers-color-scheme selectors that resolve every colour here — there
            is deliberately no theme branch in this component to fall out of step
            with the surface.
            🔴 NOT A NEW ASSET AND NOT A COPY. It is the identical `.mark` span
            that stood in the header, moved. `web/public/favicon.svg` is the one
            copied brand file in this app and `web/tests/favicon.test.ts` is what
            keeps it honest against `brand/`; adding a second copy here would have
            been a third mark with nothing comparing it to anything.
            aria-hidden: the mark carries no name a screen reader could use — the
            product name in the header is the real text. */}
        <span className="mark" aria-hidden="true" />
        <TabBar tab={tab} onTab={setTab} />
        <div className="tabrow-right">
          <button onClick={() => setDark(!dark)} title="Toggle theme" data-testid="theme-toggle">
            {dark ? '☀' : '☾'}
          </button>
        </div>
      </div>

      <TabPanel id="cnc" tab={tab}>
      {/* ---- THE MENU BAR — TODO #108 ----------------------------------------

          Founder, 2026-08-11: *"create similar menu in 2bee.cnc what already
          exists in 2bee.cad (File … etc)"*.

          ⚠ IT IS INSIDE THE TAB, not in the app header or the tab row. A menu
          bar describes ONE tab: File saves THIS tab's job and View drives THIS
          tab's camera. Above the tab row it would be a bar whose items changed
          meaning as the tab changed, or worse, did nothing on two of three tabs.

          ⚠ AND IT SITS ABOVE THE NEVER-CUT BANNER RATHER THAN BELOW IT, which is
          the ordinary place for chrome. The property that matters for the banner
          is that it is not collapsible, not dismissible and not conditional —
          all still true — not that it is the topmost pixel. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '2px 10px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <MenuBar
          label="2bee.cnc menu"
          menus={cncMenus({
            projection,
            unit,
            /* 🔴 THE SAME GATE THE SESSION WRITE USES, and for the same reason:
               `toolIds` and `material` are restored asynchronously, so a job
               written before that lands carries the DEFAULT cutter over the
               operator's stored one — into a FILE, where the loss outlives the
               tab. Not an optimisation and not a spinner. */
            saveBlocked: ready
              ? null
              : 'The core and your stored setup are still loading. A job saved now would carry ' +
                'this build’s default cutter and material instead of yours, and the file would ' +
                'look complete.',
            /* 🔴 ASKED AT RENDER, NOT LATCHED AT LOAD. What `Discard` forgets is
               whatever is stored RIGHT NOW, and this app writes the setup on
               every change — so a value captured at mount would say "nothing to
               forget" over a browser that has been storing settings for an hour.
               A control whose enabled state describes a moment that has passed
               is the stale-green shape, in miniature. */
            hasStoredSetup: hasStoredSession(),
          })}
          onCommand={runMenuCommand}
        />
      </div>
      {/* ---- Help → About — TODO #107, now behind the menu it was waiting for --

          🔴 ONE CONSTANT, TWO SURFACES, AND NOT A SECOND LIST. `CNC_NEVER_CUT`
          is the strip below and the first line here; `CNC_ABOUT_LINES` is
          rendered here and nowhere else. The old sidebar `About` section is
          gone in the same change — see the note where it stood — because two
          doors to one page of text is the duplication this tab spent the day
          removing, and the About panel's own comment said it existed only until
          a menu arrived.

          ⚠ THE TESTIDS ARE THE PANEL'S, UNCHANGED (`about-never-cut`,
          `about-line-N`, `about-version`). A move that renames every hook makes
          every assertion about it go blind rather than red — the obligation
          moves with the control, and so do the names it is reached by. */}
      {aboutOpen ? (
        <>
          <div
            data-testid="about-backdrop"
            onClick={() => setAboutOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 39,
              background: 'color-mix(in srgb, var(--bg) 55%, transparent)',
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="About 2bee.cnc"
            data-testid="panel-about"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 40,
              width: 'min(620px, 92vw)',
              maxHeight: 'min(76vh, 760px)',
              overflowY: 'auto',
              padding: 14,
              background: 'var(--panel)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-card-hover)',
            }}
          >
            <h3 style={{ margin: '0 0 8px' }}>About 2bee.cnc</h3>
            <p className="bad" data-testid="about-never-cut">
              <strong>{CNC_NEVER_CUT}</strong>
            </p>
            {CNC_ABOUT_LINES.map((line, i) => (
              <p className="note" key={i} data-testid={`about-line-${i}`}>
                {line}
              </p>
            ))}
            {/* What the CNC bar does NOT have that the CAD bar does, and why
                each is absent rather than present-and-empty. It is here for the
                same reason the CAD tab puts its own omissions in About: a list
                nobody can read is indistinguishable from an oversight. */}
            <p className="note" style={{ marginTop: 10 }}>
              <b>What this tab’s menu does not carry, and why:</b>
            </p>
            {CNC_MENU_ABSENT.map((line, i) => (
              <p className="note" key={`absent${i}`} data-testid={`about-menu-absent-${i}`}>
                {line}
              </p>
            ))}
            {/* The two numbers the footer already carries, repeated here
                because "which build am I looking at" is the first question an
                About panel exists to answer — and they are READ FROM THE CORE
                (`version()`), never from a literal in this file. An empty
                string is the honest pre-load state and renders as one. */}
            <p className="note" data-testid="about-version">
              core {ver.core || '—'} · G-code contract {ver.gcode_contract || '—'}
            </p>
            <div className="row">
              <button data-testid="about-close" onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </>
      ) : null}
      {/* ---- WHAT THIS TAB HAS NEVER DONE — TODO #107 -------------------------

          🔴 IT IS NOT IN A COLLAPSIBLE SECTION AND NOT BEHIND THE MENU, AND THAT
          IS THE POINT. Sections in this sidebar collapse, the collapse is STICKY
          across reloads, and a shut section renders nothing at all — so a
          never-cut statement that lived only inside one could be switched off
          permanently by a click nobody remembers making. That is the same hole
          `#106` records the spoilboard badge existing to close, arriving through
          a different door. `Help → About` has exactly the same property in a
          different form: a dialog nobody opens says nothing. This line is not
          collapsible, not dismissible, not conditional, and not one click away.

          ⚠ ONE SENTENCE, FROM ONE CONSTANT. `CNC_NEVER_CUT` is also the first
          line of the About dialog, so the two surfaces cannot drift into saying
          different things about the same fact — the duplication `#106` warns
          about is a second COPY, not a second rendering of one string.

          It mirrors `RunTab`'s `run-unproven` banner deliberately: same border
          token, same position, same job. An operator who moves between the two
          tabs should not have to learn that a missing red box means something. */}
      <div
        data-testid="cnc-unproven"
        style={{
          borderBottom: '1px solid var(--bad)',
          padding: '6px 14px',
          fontSize: 12,
        }}
      >
        <strong className="bad">{CNC_NEVER_CUT}</strong>
      </div>
      {/* 🔴 THE PERSPECTIVE WARNING MOVED WITH THE CONTROL, AND IT MOVED OUT OF
          THE SIDEBAR RATHER THAN INTO THE MENU — TODO #108.

          The control is now `View → Perspective`/`Orthographic`. Its warning
          could not go with it: a menu note is visible only while the menu is
          open, and this sentence exists precisely because *"a tooltip is a thing
          you find after you already believe the picture"*. So the warning is a
          strip on the tab, shown exactly while perspective is selected — which
          is strictly MORE visible than the sidebar panel it left, because that
          column scrolls and this does not.

          ⚠ The reason for the orthographic DEFAULT travelled too: it is in
          `projection.ts`, in the two menu notes, and in this line. */}
      {projection === 'perspective' ? (
        <div
          data-testid="projection-warning-row"
          style={{ borderBottom: '1px solid var(--line)', padding: '4px 14px', fontSize: 12 }}
        >
          <span className="note" data-testid="projection-warning">
            Perspective converges parallel edges. Judge a fit or a clearance in orthographic — a
            part that fits can look like it overhangs here, and a hold-down the cutter will strike
            can look clear.
          </span>
        </div>
      ) : null}
      {/* 🔴 THE UNIT STRIP — TODO #109, and it is a strip for the perspective
          warning's exact reason. The thing it has to say (*the numbers you are
          reading were converted; the program was not*) is needed precisely when
          the operator is NOT looking at the View menu, and a menu note is
          visible only while the menu is open.

          ⚠ CONDITIONAL ON THE NON-CANONICAL UNIT, not on both. In millimetres
          there is nothing to warn about: every number on the panels IS the
          number the planner holds, and a permanent strip saying so would be
          noise that trains an operator to stop reading strips on this tab —
          which is where the never-cut banner lives.

          ⚠ THE SENTENCE IS ONE CONSTANT, IN `units.ts`, BESIDE THE FUNCTIONS IT
          DESCRIBES. A warning that lives next to the control it warns about goes
          stale with it; this one goes stale with the conversion. */}
      {unit !== 'mm' ? (
        <div
          data-testid="units-note-row"
          style={{ borderBottom: '1px solid var(--line)', padding: '4px 14px', fontSize: 12 }}
        >
          <span className="warn" data-testid="units-note">
            {INCH_DISPLAY_NOTE}
          </span>
        </div>
      ) : null}
      {/* What the last job save or open did. Not a toast and not on a timer: a
          line that removes itself while somebody is looking at the machine has
          not been read — the same rule the restore banner is built on. */}
      {jobNote ? (
        <div
          style={{ borderBottom: '1px solid var(--line)', padding: '4px 14px', fontSize: 12 }}
          data-testid="job-note-row"
        >
          <span className={jobNote.tone} data-testid="job-note">
            {jobNote.text}
          </span>{' '}
          <button data-testid="job-note-dismiss" onClick={() => setJobNote(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {/* 🔴 THE JOB FILE INPUT. Mounted here rather than inside the menu popup,
          for the reason every other file input in this file is: an input that
          exists only while a menu is open cannot be handed a file by anything
          that has not opened the menu, and it is unreachable to a driver.

          🔴 REFUSE, THEN REPLACE, THEN RELOAD — in that order. `parseJobFile`
          validates the envelope and the settings GENERATION before a single byte
          of the operator's own setup is touched; a check that runs after the
          destructive step has destroyed the thing it was protecting. */}
      <input
        ref={openJobRef}
        className="offscreen"
        type="file"
        accept=".json,application/json"
        aria-hidden="true"
        tabIndex={-1}
        data-testid="open-job"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const parsed = parseJobFile(await f.text());
          if (parsed.status === 'refused') {
            setJobNote({ tone: 'bad', text: `That job file was NOT opened. ${parsed.why}` });
            return;
          }
          const err = installJob(parsed);
          if (err) {
            setJobNote({
              tone: 'bad',
              text:
                `That job file read correctly and this browser refused to store it, so NOTHING was ` +
                `replaced: ${err}`,
            });
            return;
          }
          /* The reload is what makes this ONE restore path rather than two. The
             banner on the next load names what came back and what did not. */
          window.location.reload();
        }}
      />
      {/*
        ---- THE RESTORE BANNER ------------------------------------------------

        🔴 A RESTORE THAT IS NOT ANNOUNCED IS NOT SAFE, and that is the whole
        argument for this block existing rather than the feature being four
        lines of `localStorage`. Every number on the panels behind it sets a
        depth of cut, a spindle speed, a rapid height, a tab, or how the machine
        finds its datum. An operator who does not know those came from LAST
        session has no reason to read them — a stale setup under a form that
        looks freshly opened is indistinguishable from one somebody just typed.

        So this states three things and refuses to state a fourth:
          - HOW MANY settings came back, and (behind a disclosure) which;
          - WHAT DID NOT come back, by name and with the reason, because
            silently substituting a default is the one outcome that must never
            happen — on screen it is identical to the value having survived;
          - that the bed-clear confirmation was deliberately NOT restored;
          - and it never says "your setup is ready", because this app cannot
            know that. It knows what it read back.

        It is dismissed by a CLICK and never by a timer: a banner that removes
        itself while somebody is looking at the machine has not been read.
      */}
      {!restoreDismissed &&
      (RESTORED.status === 'incompatible' ||
        RESTORED.status === 'unreadable' ||
        restored.length > 0 ||
        dropped.length > 0 ||
        saveError) ? (
        <div
          data-testid="restore-banner"
          style={{
            /* Inline, and the values still come from the brand tokens via
               `var(--…)`, so the banner is theme-correct in both directions.
               `styles.css` is outside this pass's file scope. */
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel)',
            color: 'var(--ink)',
            padding: '8px 14px',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {RESTORED.status === 'incompatible' ? (
            <p className="bad" data-testid="restore-incompatible" style={{ margin: 0 }}>
              <b>Stored settings were NOT restored.</b> {RESTORED.why}
            </p>
          ) : null}

          {RESTORED.status === 'unreadable' ? (
            <p className="bad" data-testid="restore-unreadable" style={{ margin: 0 }}>
              <b>Stored settings were NOT restored.</b> {RESTORED.why} Everything on the panels is
              at its default.
            </p>
          ) : null}

          {restored.length > 0 ? (
            <p style={{ margin: 0 }}>
              <b data-testid="restore-count">{restored.length}</b> setting
              {restored.length === 1 ? '' : 's'} restored from your last session
              {RESTORED.status === 'ok' && RESTORED.savedAt
                ? ` (saved ${new Date(RESTORED.savedAt).toLocaleString()})`
                : ''}
              . <b>Check them before you cut</b> — they are not this session's decisions.
            </p>
          ) : null}

          {dropped.length > 0 ? (
            <>
              <p className="warn" style={{ margin: 0 }}>
                <b data-testid="restore-dropped-count">{dropped.length}</b> could <b>not</b> be
                restored and {dropped.length === 1 ? 'is' : 'are'} at the default:
              </p>
              <ul
                data-testid="restore-dropped"
                className="notes"
                style={{ margin: 0, paddingLeft: 18 }}
              >
                {dropped.map((d, i) => (
                  <li key={`${d.field}-${i}`} data-testid="restore-dropped-item">
                    <b>{d.field}</b> — {d.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {restored.length > 0 ? (
            <details data-testid="restore-list" style={{ color: 'var(--muted)' }}>
              <summary style={{ cursor: 'pointer' }}>What came back</summary>
              <p style={{ margin: '4px 0 0' }}>{restored.join(', ')}</p>
              {/* 🔴 Said every time, not once. The clamp rectangles are gate
                  P7's keepout and they DO come back; the statement that a human
                  looked at the machine does not, and cannot. */}
              <p className="warn" style={{ margin: '6px 0 0' }} data-testid="restore-not-confirmed">
                Not restored, deliberately: <b>“I have checked the machine is clear”</b>. That checkbox
                records that somebody looked, and nobody has looked in this session. The clamp
                positions came back so they do not have to be retyped; the confirmation is asked
                again.
              </p>
            </details>
          ) : null}

          {saveError ? (
            <p className="bad" data-testid="restore-save-error" style={{ margin: 0 }}>
              <b>Settings are NOT being saved.</b> {saveError} — this browser refused the write, so
              nothing you change now will survive a refresh.
            </p>
          ) : null}

          <div className="row" style={{ marginTop: 2 }}>
            <button data-testid="restore-dismiss" onClick={() => setRestoreDismissed(true)}>
              Dismiss
            </button>
            {/* Clear AND reload, in one act. Clearing alone would be a lie: the
                next change to any field writes the setup straight back, so the
                button would appear to have done something it did not. */}
            <button
              data-testid="restore-discard"
              title={`Forget the stored setup (schema v${SESSION_VERSION}) and reload on defaults.`}
              onClick={() => {
                clearSession();
                window.location.reload();
              }}
            >
              Discard and reload with defaults
            </button>
          </div>
        </div>
      ) : null}

      {/* The report column's width is a CSS variable, so the layout RULE stays in
          `styles.css` and only the number lives here. */}
      <div className="body" style={{ '--report-w': `${reportW}px` } as React.CSSProperties}>
        <aside className="side" data-testid="panels">
          {/* 🔴 ONE FILE INPUT FOR ALL FOUR INVENTORY PICKERS, because there is
              ONE inventory document. Four inputs would be four ways to reach the
              same atomic replace, and the second one somebody wired would be the
              one that forgot to report `dropped`.

              Mounted here rather than inside a picker's dialog for the same
              reason the drawing and tool imports are: an input that only exists
              while a dialog is open cannot be handed a file by anything that has
              not opened the dialog, and it is unreachable to a driver. */}
          <input
            ref={importInventoryRef}
            className="offscreen"
            type="file"
            accept=".json,application/json"
            aria-hidden="true"
            tabIndex={-1}
            data-testid="import-inventory"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              /* Cleared BEFORE the await, so choosing the same file twice fires
                 again — an operator re-importing after a fix must not be met
                 with silence. */
              e.target.value = '';
              if (!f) return;
              try {
                await importInventory(await f.text());
              } catch (err) {
                /* A file that could not even be READ. Distinct from a file that
                   parsed and was refused, and it must not be silent. */
                setInventoryImport(null);
                setInventoryImportRefused(
                  `that file could not be read from disk at all: ${String(
                    err instanceof Error ? err.message : err
                  )}. Nothing was imported.`
                );
              }
            }}
          />
          {/* 🔴 PANEL ORDER IS THE FOUNDER'S, VERBATIM — 2026-08-10:
              *"change order : Machine -> Workpeace -> Drawing -> Work holding ->
              Tooling -> Operation -> Verification -> Import/Export"*.

              ⚠ It SUPERSEDES the same day's *"push the Machine as the 1st group
              from the top above Drawing"*, which this file carried for one edit.
              Both are recorded because the first is not wrong — Machine is still
              first — and a reader finding only the second would not know the
              order had been ruled on twice.

              His list has EIGHT names and this column holds exactly those eight.
              `panel-summary`, `panel-sim`, `panel-notes` and `panel-gcode` are
              NOT missing from it: they live in the other `<aside>`, the results
              column, so there was nothing to decide about them.

              🔴 Nothing in this app reads a panel's POSITION, checked rather than
              assumed before moving anything: `Section` takes `defaultOpen` and
              its testid as PROPS, the session restore keys on field names, the
              empty state names the Drawing panel rather than "the first one", and
              the one e2e that enumerates panels asserts PRESENCE, not order. So
              this is DOM order and nothing else.

              ⚠ One name does not match: the founder's eighth is *"Import/Export"*
              and this section is titled **Saved data**. It IS that surface —
              `Export all` / `Import` over the browser store — so it takes the
              slot; the TITLE is left alone rather than renamed on an inference,
              and the mismatch is reported rather than quietly resolved. */}
          {/* 🔴 THE ONE EYE OVER EVERYTHING, ABOVE `Machine` — founder,
              2026-08-11: *"move the view layers all none above the Machine what
              will control all hide/view (just an eye)"*.

              It replaces the `all` / `none` pair the canvas used to carry. I had
              kept that pair on the argument that a GLOBAL control belongs to no
              panel; he agreed it is global and put it where global lives in this
              app — the top of the sidebar, in the same eye column every section
              eye sits in, so the whole set reads as one instrument.

              🔴 IT IS THE SAME COMPONENT as the section eyes, not a lookalike.
              Tri-state for the same reason: with four of twelve layers hidden, a
              two-state control has to claim either "all visible" or "all hidden"
              and both are false. It writes the same lifted `layers` record, so
              it cannot disagree with the eight eyes below it — that property is
              what the lift out of `Viewport` was FOR, and reusing the component
              is how it survives rather than being re-argued.

              🔴 IT GOVERNS `liveLayers`, NEVER `LAYERS`. "Hide everything" must
              not assert anything about a layer the scene does not contain — the
              dead-control rule one level up.

              ⚠ THE EMPTY CASE IS GUARDED AND, TODAY, UNREACHABLE. `workpiece`
              and `travel` have no liveness predicate in `liveLayersOf`, so the
              set is never empty as the code stands and this guard has never been
              seen to fire. It is here so that if either ever gains a predicate,
              the global eye follows the rule instead of becoming the one control
              that is exempt from it. Said plainly rather than left to read as a
              tested path. */}
          {liveLayers.length > 0 && (
            <div className="panel" data-testid="view-layers-all">
              {/* 🔴 THE SECTION HEADER'S OWN GEOMETRY, REUSED — not a second
                  layout that happens to look the same. This row was
                  `.layers-all` + `.layers-all-title` with its own padding, which
                  duplicated `.panel-head`'s numbers; two rules describing one
                  column drift the next time either is touched, and there is no
                  pixel-alignment test on this box to catch it. Now it is
                  literally `.panel-head-row` + `.panel-head` + `.eye-slot`, so
                  the global eye and the eight section eyes cannot fall out of
                  the same column without every header moving together.

                  ⚠ A `<span>`, not a `<button>`, wearing `.panel-head`. It takes
                  the header's box and NOT its behaviour: this row does not
                  collapse, so it renders no chevron and must not offer a
                  pointer that promises one. `.panel-head-static` removes the
                  cursor and mutes the colour — the label is scope, not a
                  control. The only control in the row is the eye. */}
              <div className="panel-head-row">
                <span className="panel-head panel-head-static">
                  <span className="panel-title">View layers</span>
                </span>
                <span className="eye-slot">
                  <SectionEye
                    testid="section-eye-all"
                    section="Every layer in the picture"
                    live={liveLayers}
                    layers={layers}
                    onSet={setLayersTo}
                  />
                </span>
              </div>
            </div>
          )}

          {/* 🔴 THE PROJECTION CONTROL LEFT THIS COLUMN ON 2026-08-11 — TODO
              #108, and this note is the record that the obligation was
              discharged rather than forgotten.

              `540bab9d66` put a `Projection` panel here, with its move into a
              `View` menu written into the code as a condition of keeping it:
              *"When a CNC menu bar lands, this block moves into its View menu
              and does NOT stay here as well."* The bar landed; the block moved;
              nothing stayed. Both items are `View → Orthographic` /
              `View → Perspective` above, exclusive, driving the same
              `projection` state through the same `chooseProjection`, persisted
              under the same key.

              🔴 THE OLD NOTE CLAIMED A TEST IT DID NOT HAVE. It said
              *"`tests/projection.test.ts` asserts this note exists, so the
              obligation cannot be lost by deleting a comment"* — and no
              assertion anywhere read that sentence (measured 2026-08-11: the
              phrase appears in no file but this one). The obligation was carried
              by a comment claiming to be carried by a test. It is now asserted
              in `tests/cnc-menu.test.ts`, in the form that survives the move:
              the sidebar must NOT hold a second projection control, and the
              perspective warning must still be rendered on the tab.

              ⚠ THE WARNING DID NOT GO INTO THE MENU. A menu note is visible only
              while the menu is open, and that sentence exists because a tooltip
              is something you find after you already believe the picture. It is
              a strip at the top of this tab, shown exactly while perspective is
              selected. */}

          <Section
            title="Machine"
            testid="panel-machine"
            eye={sectionEye('panel-machine', 'Machine')}
            layerRows={sectionLayerRows('panel-machine', 'Machine')}
          >
            {/*
              🔴 ONE LIST — TODO #61, founder 2026-08-09: *"in the machine
              section remove the: saved… ▼ / Delete / Preset"*. All three are
              gone from the panel and the CAPABILITY behind each is in this list:
              `Preset` was the shipped catalogue, `saved… ▼` was a second picker
              holding the user's own machines, and `Delete` was a button whose
              enabled-state depended on a name box that had itself already been
              removed on 2026-08-08 — a control that could only be pressed after
              loading, wired to a `name` state nothing else set any more.

              ⚠ `Preset` AND `saved…` MERGE, AND THE ORIGIN STAYS PER ROW. A
              shipped preset states travels somebody measured; a machine the user
              typed in states travels nobody checked. Collapsing them into one
              list is right and is exactly #54's shape for drawings; letting the
              first lend its authority to the second is not. `shipped()` /
              `yours()` build both, in one place.

              A preset is `builtIn`, so the picker offers no Save-over and no
              delete on it — there would be no way back to the shipped values.
            */}
            <ObjectPicker
              label="Machine"
              testid="machine-picker"
              mode="single"
              placeholder="choose a machine…"
              searchPlaceholder="lead, 6090, 3018, saved…"
              items={[
                ...MACHINE_PRESETS.map((m) => {
                  /* 🔴 THE OWNERSHIP TAGS REPLACE `SHIPPED` — see the import
                     header. `ORIGIN_TAG.catalogue` says the same thing in the
                     vocabulary the ownership verdict is written in, and printing
                     both gave `SHIPPED · OWNED · CATALOGUE`: one fact twice.
                     The row keys on `m.name`, which is the BARE catalogue id an
                     inventory file would name — not `preset:<name>`, which is
                     this file's own row-id encoding. */
                  const inv = machineInv.row(m.name);
                  return {
                    id: rowId('preset', m.name),
                    name: m.name,
                    builtIn: true,
                    detail: withTag(
                      inv ? inv.tags.join(' · ') : SHIPPED_TAG,
                      `${L2(m.travel_x_mm, m.travel_y_mm)} of travel`
                    ),
                    disabled: inv?.disabled,
                    disabledReason: inv?.disabledReason,
                    /* 🔴 THE WRITE HALF OF THE ROW ABOVE — TODO #105. The two
                       properties DESCRIBE the ownership answer; this is where an
                       operator gives one. Same row, same verdict, one source. */
                    claim: ownershipClaim(
                      'machine',
                      machineInv.heldInKind,
                      inv,
                      /* ⚠ "SELECTED" IS TRAVELS-MATCH HERE, not an id, because a
                         machine is ten numbers in this app rather than a
                         reference — the same reason the machine picker is the
                         one that could not raise an inventory refusal until
                         today. Two presets sharing an envelope both count, which
                         over-shows the sentence rather than under-showing it. */
                      m.travel_x_mm === travelX && m.travel_y_mm === travelY
                    ),
                    properties: [
                      ...(inv
                        ? ownershipProps(inv)
                        : [shipped('a machine preset in this build').prop]),
                      {
                        /* ⚠ Says what a preset does NOT carry. It sets three
                           travels and nothing else — not the collet, which
                           decides which tools are selectable, and not the plate
                           thickness, which decides whether anything posts at
                           all. Someone choosing a preset and expecting a machine
                           would be choosing three of ten numbers. */
                        label: 'What choosing it sets',
                        value:
                          'Travel X, Y and Z — and nothing else. Collet, spindle max, touch ' +
                          'plate and arc support stay as they are.',
                      },
                      { label: 'Travel X', value: L(m.travel_x_mm) },
                      { label: 'Travel Y', value: L(m.travel_y_mm) },
                      { label: 'Travel Z', value: L(m.travel_z_mm) },
                    ],
                  } satisfies ObjectItem;
                }),
                ...savedMachines.items.map((rec) => {
                  const o = yours(rec.saved_at);
                  const d = rec.data;
                  return {
                    id: rowId('saved', rec.name),
                    name: rec.name,
                    detail: withTag(o.tag, `${L2(d?.travelX ?? NaN, d?.travelY ?? NaN)} · ${L(d?.colletMm ?? NaN)} collet`),
                    properties: [
                      o.prop,
                      {
                        label: 'What choosing it sets',
                        value:
                          'the WHOLE machine — travels, safe Z, collet, spindle max, probe, ' +
                          'touch plate and arc support.',
                      },
                      { label: 'Travel X', value: L(d?.travelX ?? NaN), input: { kind: 'number', key: 'travelX', step: 1, min: 1, unit: 'mm' } },
                      { label: 'Travel Y', value: L(d?.travelY ?? NaN), input: { kind: 'number', key: 'travelY', step: 1, min: 1, unit: 'mm' } },
                      { label: 'Travel Z', value: L(d?.travelZ ?? NaN), input: { kind: 'number', key: 'travelZ', step: 1, min: 1, unit: 'mm' } },
                      { label: 'Safe Z', value: L(d?.safeZ ?? NaN), input: { kind: 'number', key: 'safeZ', step: 0.5, min: 0, unit: 'mm' } },
                      { label: 'Collet', value: L(d?.colletMm ?? NaN), input: { kind: 'number', key: 'colletMm', step: 0.01, min: 0.1, unit: 'mm' } },
                      { label: 'Spindle max', value: `${d?.spindleMax} rpm`, input: { kind: 'number', key: 'spindleMax', step: 100, min: 1000, unit: 'rpm' } },
                      {
                        /* Empty is NOT zero here either — see `touchPlateMm`.
                           A machine saved with no plate declared comes back
                           undeclared, and undeclared refuses at post time. */
                        label: 'Touch plate top',
                        value:
                          d?.probeEnabled === false
                            ? 'probe off'
                            : (d?.touchPlateMm ?? '').trim() === ''
                              ? 'NOT DECLARED — nothing will post while the probe is on'
                              : L(Number(d?.touchPlateMm)),
                      },
                      { label: 'Arcs (G2/G3)', value: d?.supportsArcs ? 'yes' : 'no' },
                    ],
                  } satisfies ObjectItem;
                }),
                /* Machines the inventory names that this build has no preset
                   for. Listed, disabled, and saying which of the two it is —
                   see `inventoryOnlyItem`. Empty today, and stays that way until
                   somebody imports an inventory. */
                ...machineInv.extras,
              ]}
              /* 🔴 A PRESET TICKS BY TRAVEL; A SAVED MACHINE TICKS BECAUSE IT
                 WAS LOADED AND THE PANEL STILL DESCRIBES IT.
                 ⚠ THIS COMMENT USED TO SAY "A SAVED MACHINE NEVER TICKS, and
                 that asymmetry is deliberate" — it survived the fix by one
                 commit, which is the stale-🔴 failure this lane keeps writing
                 down: a comment defending the behaviour the code no longer has.
                 The half of it that was right is kept and is now enforced in
                 `savedSelection.ts`: a saved machine is TEN numbers, and a tick
                 that survived the operator retyping one of them would claim the
                 panel still describes the saved object when it does not. So the
                 tick is declared AND still true, never merely declared. */
              selectedIds={selectedIdsWithLoaded(
                MACHINE_PRESETS.filter(
                  (m) => m.travel_x_mm === travelX && m.travel_y_mm === travelY
                ).map((m) => rowId('preset', m.name)),
                loadedMachine,
                /* `{ ...x }` rather than a cast: `Snapshot` is an index
                 * signature by design (it must not name the fields — see its
                 * header) and a spread satisfies it without asserting anything
                 * about `SavedMachine` that the compiler has not checked. */
                { ...currentMachine() }
              )}
              onChange={(ids) => {
                const parsed = parseRowId(ids[0] ?? '', ['preset', 'saved']);
                if (!parsed) return;
                if (parsed.kind === 'preset') {
                  const m = MACHINE_PRESETS.find((x) => x.name === parsed.name);
                  if (!m) return;
                  setTravelX(m.travel_x_mm);
                  setTravelY(m.travel_y_mm);
                  setTravelZ(m.travel_z_mm);
                  /* 🔴 TODO #88, THE FIRST DOOR — THIS CALL IS THE WHOLE FIX.
                   *
                   * Until 2026-08-11 this handler set three travels and
                   * returned, touching neither the corner, the size, nor the
                   * provenance flag: measured, ZERO spoilboard references. So a
                   * 2400×1200 board fitted for a 1250×670 machine (corner
                   * `-575,-265`) followed the operator onto a 6090 and reported
                   * `past: 0` — which the panel renders as *"none — the board
                   * covers the whole reach"* — where the honest 6090
                   * declaration on the same job gives 2204 frame-strike cells.
                   * 2204 became a silent zero on one preset click.
                   *
                   * ⚠ THE DANGEROUS PERMUTATION IS `entered`, NOT `assumed`: a
                   * corner a human measured on machine A stayed green on
                   * machine B, and the provenance line said it was measured.
                   *
                   * The guard for this had been WRITTEN AND LEFT UNARMED —
                   * `store.ts::readSpoilboard`, a definition and four test call
                   * sites, no production caller. */
                  reconcileSpoilboardWithMachine([m.travel_x_mm, m.travel_y_mm, m.travel_z_mm]);
                  /* A preset is identified by its travels — the old rule, which
                   * works for presets — so nothing needs latching, and a stale
                   * latch from a previously loaded SAVED machine must not
                   * survive a deliberate change to a different machine. */
                  setLoadedMachine(null);
                  /* ⚠ THE PLATE NOTE IS **NOT** CLEARED HERE, AND THAT IS A
                   * CORRECTION OF AN EARLIER FIX ON THIS LINE.
                   *
                   * A `setMachineSaveNote(null)` was added here hours earlier,
                   * reasoning that a note from a previously loaded machine must
                   * not survive onto a panel now describing a preset. That is
                   * true of the TRAVEL fields this branch changes and false of
                   * the PLATE fields it does not touch: choosing a preset sets
                   * travels and nothing else, so `touchPlateId` and
                   * `touchPlateMm` are still the ones the note is about, still
                   * on the panel, and the picker still renders their
                   * "Z datum offset by N mm, from <plate> (read <date>)"
                   * attribution.
                   *
                   * 🔴 Clearing it removed the WARNING and left the thing it
                   * warned about — a false provenance with its explanation
                   * deleted, which is worse than either alone. A note is stale
                   * when its SUBJECT changes, not when something else on the
                   * panel does. */
                  return;
                }
                const savedRec = savedMachines.items.find((x) => x.name === parsed.name);
                const m = savedRec?.data;
                if (!m) return;
                // Everything the fit checks read has to travel with the config.
                // A machine restored without its collet would silently change
                // which tools are selectable.
                setTravelX(m.travelX);
                setTravelY(m.travelY);
                setTravelZ(m.travelZ);
                setSafeZ(m.safeZ);
                setColletMm(m.colletMm);
                setSpindleMax(m.spindleMax);
                setProbeEnabled(m.probeEnabled);
                // `?? ''` NOT `?? '1.6'`: a machine saved before this field
                // existed genuinely did not declare a plate, and inventing one on
                // load would restore the assumption rather than the machine.
                setTouchPlateMm(m.touchPlateMm ?? '');
                /* 🔴 THE NAME COMES BACK ONLY IF IT IS STILL TRUE OF THE NUMBER.
                 *
                 * `touchPlateMm` and `touchPlateId` restore independently, so a
                 * machine saved against a catalogue entry that has since been
                 * corrected returned wearing the entry's NAME beside a thickness
                 * that is no longer the entry's — and the picker renders the LIVE
                 * catalogue's top next to the SAVED number, while the saved one is
                 * what reaches `touch_plate_mm` and therefore the probe's Z datum.
                 *
                 * The app already applies this rule when the operator TYPES a
                 * thickness, and says why at the input: *"Keeping its name beside
                 * a hand-typed thickness would be a false provenance."* Restoring
                 * is the same fact arriving by a different door.
                 *
                 * ⚠ DROPPED LOUDLY, NEVER SILENTLY. The thickness is kept — it is
                 * the machining number and the operator chose it — and only the
                 * CLAIM about where it came from is withdrawn, with both figures
                 * named. A provenance that disappears without a word is the same
                 * defect wearing the other face. */
                {
                  const prov = plateProvenance(m.touchPlateId, m.touchPlateMm);
                  /* 🔴 CLEAR THE PREVIOUS MACHINE'S NOTE FIRST. It was set here
                   * and at the Save-as refusal, and cleared only on a successful
                   * Save-as — so loading a machine with a diverged plate and then
                   * loading a clean one left the first machine's red note on
                   * screen under the picker, now reading as a statement about the
                   * second. A note that outlives what it accuses is a false
                   * finding, and this one accuses by name. */
                  setMachineSaveNote(null);
                  if (prov.verdict === 'undeclared' && (m.touchPlateId ?? '') !== '') {
                    /* 🔴 `undeclared` IS NOT `agrees`, AND THIS BRANCH IS THE ONE
                     * THAT USED TO SHIP THE FALSE PROVENANCE. The name is kept —
                     * nothing contradicts it — but the panel goes on to render
                     * "Z datum offset by N mm, from <plate> (read <date>)", a
                     * sourced-looking attribution for a figure the catalogue does
                     * not publish. Silence here is right about the THICKNESS and
                     * wrong about the CLAIM. */
                    setTouchPlateId(m.touchPlateId ?? '');
                    /* 🔴 `undeclared` IS TWO WORLDS AND THEY NEED DIFFERENT
                     * SENTENCES. `prov.catalogueTopMm` is the discriminator:
                     * `null` = the catalogue publishes no top; a number = it
                     * does, and THIS MACHINE declares nothing.
                     *
                     * The first version said "The catalogue publishes no plate
                     * top" unconditionally — false in the second world, which is
                     * precisely the premise this ticket rests on (an entry that
                     * publishes no top when the machine is saved, and gains one
                     * later). It also said "the number beside it is yours" when
                     * there IS no number, pushing the operator to type a guess
                     * for the plate top — which is the probe's Z datum, so a
                     * guess there is a wrong Z zero and a wrong depth of cut. */
                    setMachineSaveNote(
                      prov.catalogueTopMm == null
                        ? `The catalogue publishes no plate top for "${m.touchPlateId}". The name is ` +
                          `kept because nothing contradicts it — but the ${
                            m.touchPlateMm ? 'number beside it is yours' : 'thickness is blank'
                          }, not the catalogue's, and nothing here has checked it.`
                        : `The catalogue NOW publishes a top of ${formatLength(
                            prov.catalogueTopMm,
                            unit
                          )} for "${m.touchPlateId}", and this machine declares no thickness. The ` +
                          `name is kept — nothing contradicts it — but the plate top is the probe's ` +
                          `Z datum, so declare it deliberately rather than assuming the catalogue's.`
                    );
                  } else if (prov.verdict === 'diverged' || prov.verdict === 'unknown') {
                    setTouchPlateId('');
                    setMachineSaveNote(
                      prov.verdict === 'unknown'
                        ? `The touch plate this machine names ("${m.touchPlateId}") is no longer in ` +
                          `the catalogue. Its thickness (${
                            m.touchPlateMm ? formatLength(Number(m.touchPlateMm), unit) : 'undeclared'
                          }) is kept — it is what the probe uses — but the name is dropped, because ` +
                          `it now claims a source that cannot be checked.`
                        : `This machine was saved naming "${m.touchPlateId}", whose published top is ` +
                          `${formatLength(prov.catalogueTopMm ?? NaN, unit)}, beside a thickness of ` +
                          `${formatLength(Number(m.touchPlateMm), unit)}. The THICKNESS is kept — it ` +
                          `is what reaches the probe — and the name is dropped, because a catalogue ` +
                          `name beside a number that is not the catalogue's is a false provenance.`
                    );
                  } else {
                    setTouchPlateId(m.touchPlateId ?? '');
                  }
                }
                setSupportsArcs(m.supportsArcs);
                /* The board is a property of THIS machine, so it comes back with
                 * it. `?? ''` for the same reason the plate above uses it, and a
                 * stronger one: a machine saved before this field existed
                 * declared NO BOARD, and restoring it as "unchecked" is the
                 * truth. Filling in a plausible board on load would put an
                 * over-declaration behind a name the operator trusts. */
                /* 🔴 TODO #88, THE SAME DOOR FROM THE OTHER SIDE, AND IT GOES
                 * THROUGH THE SAME CALL. The record's own travels are the
                 * machine being loaded, so the question is whether the corner in
                 * the record was measured on THEM — and it need not have been: a
                 * record is written from whatever is on the panels when Save is
                 * pressed, so an operator who retyped the travels and then saved
                 * produced a record describing two different machines at once.
                 * `spoilboardTravels` is what makes that askable rather than
                 * assumed, and a record from before it existed answers "unknown
                 * machine", which is treated as a mismatch. */
                const board = spoilboardForMachine(
                  {
                    id: m.spoilboardId ?? '',
                    x: m.spoilboardX ?? '',
                    y: m.spoilboardY ?? '',
                    sizeX: m.spoilboardSizeX ?? '',
                    sizeY: m.spoilboardSizeY ?? '',
                    thickness: m.spoilboardThickness ?? '',
                    name: m.spoilboardName ?? '',
                    // A missing key is ASSUMED, never a human's statement.
                    pos: m.spoilboardPos === 'entered' ? 'entered' : 'assumed',
                    travels: m.spoilboardTravels ?? null,
                  },
                  [m.travelX, m.travelY, m.travelZ],
                  savedRec.saved_at
                );
                setSpoilboardId(board.values.id);
                setSpoilboardX(board.values.x);
                setSpoilboardY(board.values.y);
                setSpoilboardSizeX(board.values.sizeX);
                setSpoilboardSizeY(board.values.sizeY);
                setSpoilboardThickness(board.values.thickness);
                setSpoilboardName(board.values.name);
                setSpoilboardPos(board.values.pos);
                setSpoilboardTravels(board.values.travels);
                setSpoilboardMachineNote(
                  board.dropped.length
                    ? { tone: 'warn', text: board.dropped[0].reason }
                    : board.provenance
                      ? { tone: 'note', text: board.provenance }
                      : null
                );
                /* 🔴 THE SNAPSHOT IS WHAT THE PANEL WILL HOLD, NOT WHAT THE
                 * RECORD SAID. The two differ on purpose: the board above is
                 * RECONCILED against this machine's travels and can legitimately
                 * come back dropped. Snapshotting the raw record would make the
                 * tick compare against a setup the app never adopted — it would
                 * never appear, and the fix would look like it did not work.
                 * The field list mirrors `currentMachine()`, including its
                 * omit-rather-than-null rule for the travels fingerprint. */
                setLoadedMachine({
                  id: ids[0],
                  snapshot: {
                    travelX: m.travelX,
                    travelY: m.travelY,
                    travelZ: m.travelZ,
                    safeZ: m.safeZ,
                    colletMm: m.colletMm,
                    spindleMax: m.spindleMax,
                    probeEnabled: m.probeEnabled,
                    touchPlateMm: m.touchPlateMm ?? '',
                    touchPlateId: m.touchPlateId ?? '',
                    supportsArcs: m.supportsArcs,
                    spoilboardId: board.values.id,
                    spoilboardX: board.values.x,
                    spoilboardY: board.values.y,
                    spoilboardSizeX: board.values.sizeX,
                    spoilboardSizeY: board.values.sizeY,
                    spoilboardThickness: board.values.thickness,
                    spoilboardName: board.values.name,
                    spoilboardPos: board.values.pos,
                    ...(board.values.travels ? { spoilboardTravels: board.values.travels } : {}),
                  },
                });
              }}
              onRemoveItem={(it) => {
                const p = parseRowId(it.id, ['preset', 'saved']);
                if (p?.kind === 'saved') void savedMachines.remove(p.name);
              }}
              onSave={(it, draft) => {
                const p = parseRowId(it.id, ['preset', 'saved']);
                if (p?.kind === 'saved') void savedMachines.replace(p.name, { ...currentMachine(), ...draft });
              }}
              onSaveAs={(it, draft, newName) => {
                /* 🔴 TODO #102 — THE SAVE-TARGET REFUSAL, matching the spoilboard
                   picker's pattern. previewItem follows the ACTIVE row (arrowing
                   changes it without selecting), so pressing Save as while looking
                   at "Desktop 3018" with "MakerSpace 6090" still selected would
                   write the ticked machine's travels under that name. Refuse the
                   ambiguous case; name both. */
                if (it) {
                  const p = parseRowId(it.id, ['preset', 'saved']);
                  const isSelectedPreset = p?.kind === 'preset' && MACHINE_PRESETS.some(
                    (m) => m.name === p.name && m.travel_x_mm === travelX && m.travel_y_mm === travelY,
                  );
                  const loaded = useCncStore.getState().loadedMachine as string | null;
                  const isLoadedSaved = p?.kind === 'saved' && p.name === loaded;
                  if (!isSelectedPreset && !isLoadedSaved) {
                    const active = loaded
                      ? `the saved machine "${loaded}"`
                      : `a ${travelX} × ${travelY} machine`;
                    setMachineSaveNote(
                      `Nothing was saved. You are looking at "${it.name}", but the panel holds ` +
                      `${active} — select "${it.name}" first if you meant it, or close and reopen this list, then press Save as without arrowing through it, if you meant to save what is set up now.`,
                    );
                    return;
                  }
                }
                setMachineSaveNote(null);
                void savedMachines.saveAs(newName, { ...currentMachine(), ...draft });
              }}
            />
            {inventorySource('machine', machineInv.view)}
            {(() => {
              /* 🔴 THE ONE PICKER THAT COULD NOT RAISE A REFUSAL, AND THE
                 CONTROL THAT MADE IT REACHABLE — TODO #105.

                 The other three resolve a stored ID (`spoilboardId`,
                 `workholdingId`, `toolIds`) and call `inventoryRefusal`, so a
                 selection the inventory stopped listing is named on the panel.
                 **A machine is not a reference in this app — it is ten numbers**,
                 so there is no id to resolve and no `inventoryRefusal('machine',
                 …)` call anywhere. Until now that was harmless: no machine could
                 be `not-held` without an imported file, and there are none. The
                 per-row control makes it a state an operator can reach in one
                 press, and a not-held machine reaching the plan with nothing said
                 is exactly the case that must not exist.

                 ⚠ THE HEDGE IS IN THE SENTENCE, because matching travels is not
                 identity: two presets can share an envelope, and a machine the
                 operator typed matches nothing. So this says the setup MATCHES a
                 preset the inventory does not list — never "you have selected a
                 machine you do not own", which is more than the numbers say. */
              const unowned = MACHINE_PRESETS.filter(
                (m) => m.travel_x_mm === travelX && m.travel_y_mm === travelY
              )
                .map((m) => ({ m, inv: machineInv.row(m.name) }))
                .filter(
                  ({ inv }) =>
                    inv &&
                    (inv.ownership.state === 'not-held' || inv.ownership.state === 'unresolved')
                );
              return unowned.length ? (
                <p className="bad" data-testid="machine-inventory-refused">
                  The travels set up here match{' '}
                  {unowned.map(({ m }) => `"${m.name}"`).join(' and ')}, which your registered
                  inventory does NOT list. Nothing has been changed for you and the program will
                  still be planned — this app does not silently edit a setup to agree with a
                  stock-take — but it is being planned for a machine your own record says is not in
                  the shop.
                </p>
              ) : null;
            })()}
            {savedMachines.note ? (
              <p className="note" data-testid="machine-note">
                {savedMachines.note}
              </p>
            ) : null}
            {machineSaveNote ? (
              <p className="note bad" data-testid="machine-save-note">
                {machineSaveNote}
              </p>
            ) : null}
            <Num label="Travel X" value={travelX} onChange={setTravelX} testid="travel-x" unit={unit} />
            <Num label="Travel Y" value={travelY} onChange={setTravelY} testid="travel-y" unit={unit} />
            <Num label="Travel Z" value={travelZ} onChange={setTravelZ} unit={unit} />
            <Num label="Safe Z" value={safeZ} onChange={setSafeZ} step={0.5} unit={unit} />
            <Num label="Collet" value={colletMm} onChange={setColletMm} step={0.025} testid="collet" unit={unit} />
            <Num
              label="Spindle max"
              value={spindleMax}
              onChange={setSpindleMax}
              step={1000}
              suffix="rpm"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={probeEnabled}
                onChange={(e) => setProbeEnabled(e.target.checked)}
                data-testid="probe-enabled"
              />
              Touch plate fitted
            </label>
            {/* 🔴 THE RESEARCHED TOUCH-PLATE CATALOGUE (TODO #40), reachable for
                the first time. 13 devices, each with what its vendor publishes
                and — more usefully — what nobody publishes: `null` is a real
                answer here and renders as NOT PUBLISHED, never as a zero.
                Choosing one FILLS the field below from its own figure. */}
            {probeEnabled ? (
              <ObjectPicker
                label="Touch plate"
                testid="touchplate-picker"
                mode="single"
                placeholder="none chosen"
                searchPlaceholder="xyz, z-only, setter, block…"
                items={TOUCH_PLATES.map((p) => ({
                  id: p.id,
                  name: p.name,
                  /* TODO #60 — and this is the catalogue where the drawing earns
                   * its place most: which face the plate registers on, and
                   * whether it follows the workpiece or stays with the machine, is a
                   * picture question. The caption carries the two numbers the
                   * datum is built from, and says NOT PUBLISHED where the vendor
                   * publishes nothing — the drawing refuses in the same place. */
                  shape: {
                    node: <TouchPlateShape id={p.id} />,
                    label:
                      `Plan and side view of ${p.name}. It references ${p.references === 'workpiece' ? 'the WORKPIECE, so it follows the workpiece' : 'the MACHINE, so it stays with the machine'}. ` +
                      `Top thickness ${p.topMm == null ? 'NOT PUBLISHED' : L(p.topMm)}, wall thickness ${p.wallMm == null ? 'NOT PUBLISHED' : L(p.wallMm)}.`,
                  },
                  detail:
                    p.topMm == null
                      ? `${p.axes.toUpperCase()} · top thickness NOT published — measure it`
                      : `${p.axes.toUpperCase()} · ${L(p.topMm)} top · references the ${p.references}`,
                  properties: [
                    { label: 'Axes', value: p.axes.toUpperCase() },
                    {
                      // The #40 field. A plate hooked over the STOCK moves with
                      // the workpiece; one fastened to the machine does not, and
                      // a workpiece nudged after probing leaves the second
                      // describing a corner that is not there.
                      label: 'References',
                      value: p.references === 'workpiece' ? 'the workpiece' : 'the machine',
                    },
                    {
                      label: 'Top thickness (Z term)',
                      value: p.topMm == null ? 'NOT PUBLISHED' : L(p.topMm),
                    },
                    {
                      label: 'Wall thickness (X/Y term)',
                      value: p.wallMm == null ? 'NOT PUBLISHED' : L(p.wallMm),
                    },
                    {
                      label: 'XY probe depth',
                      value:
                        p.xyDepthMm == null
                          ? 'NOT PUBLISHED by anyone — the setup owes this number'
                          : L(p.xyDepthMm),
                    },
                    { label: 'Tool radius enters the datum as', value: p.radiusTerm },
                    { label: 'Continuity', value: p.continuity },
                    { label: 'Conductive stock', value: p.conductiveStock },
                    {
                      label: 'Sourced',
                      value: p.source
                        ? `${p.generic ? 'partly' : 'yes'}, read ${p.source.read}`
                        : 'NO — generic',
                    },
                    ...(p.source ? [{ label: 'Source', value: p.source.url }] : []),
                    { label: 'Why it is listed', value: p.detail },
                    { label: 'Notes', value: p.notes },
                  ],
                }))}
                selectedIds={touchPlateId ? [touchPlateId] : []}
                onChange={(ids) => {
                  const id = ids[0] ?? '';
                  setTouchPlateId(id);
                  const p = TOUCH_PLATES.find((t) => t.id === id);
                  /* 🔴 A plate with no published top thickness CLEARS the field
                   * rather than leaving the previous plate's number under a new
                   * plate's name. Carrying it over would be the worst of both: a
                   * measured-looking datum belonging to a different device. */
                  setTouchPlateMm(p?.topMm != null ? String(p.topMm) : '');
                }}
              />
            ) : null}
            {probeEnabled ? (
              <label className="field">
                <span>Plate top</span>
                <span className="numwrap">
                  {/* TEXT, not `type="number"`, so BLANK survives as blank. See
                      `touchPlateMm`: empty = not declared (the core refuses),
                      `0` = measured, no plate at all. A numeric input cannot
                      hold that difference and would answer for the operator. */}
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="not declared"
                    value={touchPlateMm}
                    data-testid="touch-plate-mm"
                    onChange={(e) => {
                      setTouchPlateMm(e.target.value);
                      // Typing your own number means the catalogue entry no
                      // longer describes what is fitted. Keeping its name beside
                      // a hand-typed thickness would be a false provenance.
                      setTouchPlateId('');
                    }}
                  />
                  <MmOnlySlot unit={unit} />
                </span>
              </label>
            ) : null}
            {probeEnabled ? (
              (() => {
                const p = TOUCH_PLATES.find((t) => t.id === touchPlateId);
                if (touchPlateMm.trim() === '') {
                  return (
                    <p className="warn" data-testid="touchplate-undeclared">
                      <b>Not declared</b>, so nothing will be planned while the probe is on. The
                      thickness between your plate's top face and the workpiece top is a number
                      only you can measure — real plates run 5&nbsp;mm to 15.5&nbsp;mm and the
                      13 in the list above disagree by 10&nbsp;mm. Probing the workpiece directly
                      with no plate? Enter <b>0</b> — that is a different answer from leaving it
                      blank, and it is the one that says so.
                    </p>
                  );
                }
                if (p) {
                  return (
                    <p className="note" data-testid="touchplate-note">
                      Z datum offset by <b>{L(Number(touchPlateMm))}</b>, from {p.name}
                      {p.source ? ` (read ${p.source.read})` : ''}.
                      {p.references === 'machine'
                        ? ' It is fastened to the MACHINE, so it does not follow the workpiece — move the workpiece and this datum stops describing it.'
                        : ' It hooks over the WORKPIECE, so it follows the workpiece.'}
                    </p>
                  );
                }
                return (
                  <p className="note" data-testid="touchplate-measured">
                    Z datum offset by <b>{L(Number(touchPlateMm))}</b>, entered by hand. No catalogue
                    entry is claimed for it — this is your measurement, not a published figure.
                  </p>
                );
              })()
            ) : null}
            <label className="check">
              <input
                type="checkbox"
                checked={supportsArcs}
                onChange={(e) => setSupportsArcs(e.target.checked)}
                data-testid="supports-arcs"
              />
              Controller supports arcs (G2/G3)
            </label>
            <p className="note">
              Cutter compensation (G41/G42) is absent from grblHAL core, so every offset is computed
              here. It is not a setting.
            </p>
          </Section>

          {/* 🔴 SECOND, BETWEEN MACHINE AND WORKPIECE — founder, 2026-08-10:
              *"Machine -> Spoilboard -> Workpiece -> …"*. Sections are plain JSX
              siblings and nothing in this app reads a panel's POSITION (checked,
              not assumed — `Section` takes its testid as a prop, the session
              restore keys on field names, and the one e2e that enumerates panels
              asserts PRESENCE), so this is DOM order and nothing else.

              And the order is the physical one: the board is bolted to the
              MACHINE and the sheet is laid on the BOARD. Reading down the column
              is reading up off the rails.

              🔴 THE PANEL EXISTS TO REFUSE A DEFAULT. It opens with nothing
              chosen and no position, because the core's catalogue ships
              `"default_id":null` deliberately and the argument is a safety one:
              an over-declared board says *"there is sacrificial material here"*
              about bare frame, so a cut that reaches an extrusion reports as an
              intended through-cut. Under-declaring costs a false red;
              over-declaring reaches the machine. */}
          <Section
            title="Spoilboard"
            testid="panel-spoilboard"
            eye={sectionEye('panel-spoilboard', 'Spoilboard')}
            layerRows={sectionLayerRows('panel-spoilboard', 'Spoilboard')}
            /* 🔴 THE COUNT THAT PAYS FOR THE STICKY COLLAPSE ON THIS PANEL — the
                same debt `panel-notes` and `panel-sim` already paid. It is the
                LENGTH of the list the body below renders, computed in one place
                (`spoilboardFindings`, which also feeds that body) so a badge and
                a panel cannot describe different boards. Its full reasoning,
                including what it does NOT count and why, is on that block. */
            badge={spoilboardFindings.badge}
          >
            {(() => {
              /* Everything below is READ OFF THE REPORT, never re-derived here.
               * The echo is the seam: a board that reached the check but not the
               * report would be enforced and invisible, and a board this panel
               * drew from its own state would be visible and unenforced. The
               * clamps taught this lane that lesson; the board inherits it. */
              const echo = report?.spoilboard ?? null;
              const bare = report?.spoilboard_bare_reach ?? null;
              const checked = report?.sim.spoilboard_position_checked === true;
              const past = report?.sim.past_spoilboard_edge ?? 0;
              /* The core's own sentences, VERBATIM. Not reworded, not
               * summarised, not re-cased. They state what was measured, what was
               * not, and the physical failure behind each — a TypeScript
               * paraphrase would be a second, softer copy of a safety message in
               * the one place no gate can see it. */
              /* ONE filter, computed beside the scene it decides — a second copy
               * here would be two answers to "did the core install it", and the
               * disagreement would show up as a canvas and a panel describing
               * different boards.
               *
               * 🔴 EVERY VERDICT BELOW NOW COMES FROM `spoilboardFindings`,
               * WHICH IS ALSO WHAT THE HEADER'S BADGE COUNTS. They were computed
               * here until 2026-08-12; a badge is a prop on `<Section>` and
               * cannot see a `const` inside its children, so leaving them here
               * would have meant the header totalling one set of sentences while
               * the body printed another — two producers, which is the defect
               * `112d2e34b9` traced on the CAD console badge. The badge is the
               * length of THIS list, and the only way to keep that true is for
               * there to be one list.
               *
               * ⚠ `measured` — `isMeasuredBoardId`, TODO #104's single decision
               * about which board forms state their own size — comes from there
               * too, so a third form cannot reach four of the five branches. */
              const {
                notInstalled,
                pending,
                strike,
                unparseable,
                measured,
                mTravelX,
                mTravelY,
                sizeX,
                sizeY,
                reach,
                assumed,
                inventoryRefused,
                travelDrift,
              } = spoilboardFindings;
              const chosen = spoilCat?.spoilboards.find((s) => s.id === spoilboardId) ?? null;
              /* The fit for the board currently in play, recomputed as the
               * machine and the program move. It is only ever WRITTEN into the
               * fields by an explicit action — selecting a board, or pressing
               * Re-fit — never by a render: a value that re-derives itself
               * under a typed number is the defect the provenance flag exists
               * to prevent. */
              const fit =
                Number.isFinite(sizeX) && Number.isFinite(sizeY)
                  ? fitSpoilboard(report?.render ?? [], sizeX, sizeY, mTravelX, mTravelY, unit)
                  : null;

              /* 🔴 `reach` — DOES THE BOARD ON THE MACHINE COVER THE REACH — is
               * RE-ASKED ON EVERY RENDER, NOT AT SELECTION (TODO #104's first
               * constraint), and it is now asked in `spoilboardFindings` with the
               * rest. The catalogue rows below each carry this verdict, so a board
               * was graded when it was PICKED; nothing graded the board that is
               * actually declared. A check that ran once and went stale is worse
               * than one that never ran, because the operator remembers seeing it
               * pass — and a REACH failure hidden behind a collapsed header is the
               * same defect with a different lid, which is why the badge counts
               * it. ⚠ It is the REACH question and not "does this board fit the
               * machine": `spoilboardReachVerdict` refuses the frame question
               * because `Machine` carries no frame dimension. */

              /* ═══ REFUSING TO GUESS WHICH BOARD `Save` MEANT — TODO #102 ═══
               *
               * 🔴 THIS CALL SITE HAS #102's SHAPE AND IS NOT ALLOWED TO DECIDE
               * IT. `ObjectPicker`'s `previewItem` follows the ACTIVE row, and
               * arrowing changes the active row WITHOUT selecting it — so an
               * operator looking at `MDF 2400 × 1200`'s properties while a
               * 600 × 900 board is declared, who then types a name and presses
               * Save as, gets a record holding 600 × 900 under the name of the
               * board on screen. That is exactly what `a4e5ff68be` measured on
               * the machine picker: a saved object whose numbers are not the
               * object it is named after.
               *
               * The fork — does `Save as` mean *the panel as configured* or
               * *this row plus my edits*? — is with the founder and is NOT
               * settled here. What IS settled is that this app must not answer
               * it by guessing: `AGENTS.md`'s third duty is *refuse rather than
               * approximate*, and a record written from the wrong one of two
               * plausible readings is the approximation that reaches a machine
               * (a spoilboard's size decides what is reported as bare rail).
               *
               * ⚠ SO IT REFUSES ONLY THE AMBIGUOUS CASE. Nothing previewed, or
               * the previewed row IS the declared board ⇒ there is one reading
               * and it saves. Two different boards ⇒ it names both and writes
               * nothing. When the founder rules, this function is where the
               * ruling lands — and the ruling should land on all four pickers
               * together, not just here.
               *
               * ⚠ `null` = go ahead. A string is the refusal, said to the
               * operator; it is never a silent no-op, because a Save button that
               * does nothing is indistinguishable from a broken one.
               *
               * 🔴 THE REMEDY THESE SENTENCES NAME MUST BE AN ACTION THAT
               * EXISTS. All three of them said *"close the properties view"*
               * until 2026-08-27, and **there is no such control** — the
               * picker's buttons are `Save as` and `Cancel`. A refusal whose
               * remedy is impossible is a dead end wearing the manners of a
               * hint, and it is the reason a hand-typed machine could not be
               * saved for nineteen days: the operator was told what to do,
               * did not find it, and concluded saving was broken. They now
               * name closing and reopening the list, which really does clear
               * the preview (`openPopup` re-derives it from the selection, and
               * `closePopup` drops the draft with it). */
              const saveTargetRefusal = (it: ObjectItem | null): string | null => {
                if (!it || it.id === spoilboardId) return null;
                const declared = spoilboardId
                  ? (chosen?.label ?? (spoilboardName.trim() || 'the board declared below'))
                  : 'no board at all';
                return (
                  `Nothing was saved. You are looking at “${it.name}”, but the board this panel ` +
                  `holds is ${declared} — and saving would write THIS panel's numbers under that ` +
                  `name, which is a record whose size is not the board it is named after. Select ` +
                  `“${it.name}” first if you meant it, or close and reopen this list and press ` +
                  `Save as without arrowing through it, if you meant to save what is set up now.`
                );
              };

              return (
                <>
                  <ObjectPicker
                    label="Spoilboard"
                    testid="spoilboard-picker"
                    mode="single"
                    /* 🔴 "none declared", not "choose one". The empty state is a
                     * legitimate, reported answer — UNCHECKED — and a
                     * placeholder that reads as an unfinished form invites
                     * somebody to finish it with a guess. */
                    placeholder="none declared — position UNCHECKED"
                    searchPlaceholder="mdf, 2400, 1080, measured…"
                    items={[
                      ...(spoilCat?.spoilboards ?? []).map((s) => {
                        /* 🔴 MARKED, NEVER HIDDEN — founder's rule for the tool
                         * list, verbatim: *"highlight the tool … if it does not
                         * work for the current setup"*. A board that vanishes
                         * from the list looks like a board that does not exist,
                         * and the operator who OWNS that board then has no way
                         * to declare it — which pushes them to UNCHECKED, the
                         * worst of the three states. It is also why the row is
                         * not `disabled`: refusing a true declaration forces a
                         * lie.
                         *
                         * ⚠ THE STYLING IS TEXT, NOT A RED BACKGROUND, and that
                         * is a scope limit rather than a design choice.
                         * `ObjectPicker` exposes `disabled`/`disabledReason` and
                         * no per-row tone, and `ObjectPicker.tsx` is outside
                         * this change's file set. Reported. */
                        const v = spoilboardReachVerdict(
                          s.size_x_mm,
                          s.size_y_mm,
                          mTravelX,
                          mTravelY,
                          unit
                        );
                        const jobFit = fitSpoilboard(
                          report?.render ?? [],
                          s.size_x_mm,
                          s.size_y_mm,
                          mTravelX,
                          mTravelY,
                          unit
                        );
                        const tag = v.covers
                          ? v.overhang
                            ? `⚠ bigger than the reach — ${v.overhang}`
                            : '✅ exactly spans the reach'
                          : `🔴 cannot cover the reach — ${v.short}`;
                        /* THE OWNERSHIP ANSWER, on the bare catalogue id. ⚠ It
                         * can DISABLE a row the reach verdict deliberately does
                         * not, and the two are not in tension: "this board
                         * cannot cover the reach" is a fact about a board that
                         * may well be bolted to the machine, so refusing it would
                         * force a lie; "your inventory does not list it" is a
                         * fact about a board that is not in the shop, and
                         * declaring one you do not have is the lie. */
                        const inv = spoilboardInv.row(s.id);
                        return {
                        id: s.id,
                        name: s.label,
                        detail: (() => {
                          /* 🔴 `thickness_mm` IS NULLABLE — the core made it
                           * `Option<f64>` so an entry whose cited page states no
                           * thickness carries nothing rather than an invented
                           * number. Interpolated straight, that entry reads
                           * "2400 x 1200 x nullmm". All four boards shipped
                           * today have one, so this line was right by luck and
                           * would have gone wrong on the first entry added from
                           * a page that does not state it. Unknown is SAID. */
                          const th =
                            s.thickness_mm == null ? 'thickness unknown' : L(s.thickness_mm);
                          const facts = `${s.size_x_mm} x ${s.size_y_mm} x ${th} ${s.material} · ${tag}`;
                          return inv ? withTag(inv.tags.join(' · '), facts) : facts;
                        })(),
                        disabled: inv?.disabled,
                        disabledReason: inv?.disabledReason,
                        /* TODO #105. ⚠ A BOARD IS STOCK, so this is the one of
                           the four where "do you have it" is a QUANTITY question
                           and the answer recorded is only PRESENCE — the note on
                           the control says so, because a shop with one sheet left
                           and a shop with forty read identically here. It is
                           still three answers and not two. */
                        claim: ownershipClaim('spoilboard', spoilboardInv.heldInKind, inv, spoilboardId === s.id),
                        properties: [
                          ...(inv ? ownershipProps(inv) : []),
                          { label: 'Size X', value: L(s.size_x_mm) },
                          { label: 'Size Y', value: L(s.size_y_mm) },
                          {
                            /* 🔴 THE PREDICATE, NAMED. It is not "does this
                             * board fit this machine" — see
                             * `spoilboardReachVerdict`. */
                            label: 'Can it be positioned to cover the whole reach?',
                            value: v.covers
                              ? `Yes — it is at least as big as the ${L2(mTravelX, mTravelY)} travel envelope on both axes${
                                  v.overhang ? `, and ${v.overhang}` : ''
                                }. Where it is bolted still decides what is bare.`
                              : `NO — ${v.short} against the ${L2(mTravelX, mTravelY)} travel envelope. Wherever it is bolted, some reachable XY has no declared sacrificial material under it.`,
                          },
                          {
                            label: 'Does it fit the machine FRAME?',
                            value:
                              'UNKNOWN — and it is not a question this tool can answer. `Machine` ' +
                              'carries travel limits and NO frame or rail dimension at all, ' +
                              'so a verdict here would be a number invented to make a list tidier. ' +
                              'Measure your frame.',
                          },
                          {
                            label: 'Fit on this job',
                            value: jobFit
                              ? jobFit.why
                                ? `${jobFit.rule} — ${jobFit.why}`
                                : `${jobFit.rule}: selecting it would place its corner at ${L(jobFit.x)}, ${L(jobFit.y)} (ASSUMED, not measured).`
                              : 'no fit could be computed',
                          },
                          {
                            label: 'Turned 90°?',
                            value:
                              'Not expressible. `Spoilboard` has no rotation field — it is square ' +
                              'to the machine, deliberately — so this entry is judged AS STATED. ' +
                              'A panel that would cover the reach turned reads as a red here, ' +
                              'which is the direction to be wrong in.',
                          },
                          {
                            /* 🔴 THE LABEL SAID `nominal — no check reads it`.
                             * THAT IS NOW FALSE, and it was false in the worst
                             * direction: it told the operator that a
                             * safety-bearing figure was decorative.
                             *
                             * `SpoilboardSpec::install_at` carries this number
                             * onto the installed board and `sim::SpoilboardDepth`
                             * uses it to answer "did the cutter go through the
                             * board into the machine?". Absent it, that limb
                             * reports PENDING — so this figure decides whether
                             * the question can be ASKED at all, not merely what
                             * the answer is.
                             *
                             * ⚠ It is still only as good as the page it was read
                             * off — see `Source`/`Read on` in the rows below —
                             * and the value is what the board is SOLD as, not
                             * what a caliper says about the one in your shop. */
                            label: 'Thickness (a check reads it — see below)',
                            value:
                              s.thickness_mm == null
                                ? 'UNKNOWN — the source cited for this entry states no thickness, ' +
                                  'and nothing has been invented in its place. Choosing this board ' +
                                  'installs a slab of unknown depth: the through-the-board check ' +
                                  'reports PENDING, which is NOT a pass.'
                                : `${L(s.thickness_mm)} — the depth the through-the-board check ` +
                                  'measures against. It is the SOLD thickness from the source ' +
                                  'below, not a caliper reading of the board bolted to your machine, ' +
                                  'and the check is only as true as that.',
                          },
                          { label: 'Material', value: s.material },
                          { label: 'Source', value: s.source },
                          { label: 'Read on', value: s.read_on },
                          { label: 'What this entry does NOT tell you', value: s.note },
                        ] as ObjectProperty[],
                        builtIn: true,
                        };
                      }),
                      {
                        id: SPOILBOARD_CUSTOM,
                        name: 'A board you measured',
                        detail: 'not from the catalogue — you state the size',
                        properties: [
                          {
                            label: 'Why this row exists',
                            value:
                              'The catalogue only holds boards whose numbers were read off a ' +
                              'supplier page or a model in this repo. Yours almost certainly is ' +
                              'not one of them, and a nearby board is a rectangle in the wrong ' +
                              'place.',
                          },
                          {
                            label: 'What it needs',
                            value: 'Both sizes and both position numbers. One axis is not a rectangle.',
                          },
                          {
                            /* ⚠ SEPARATE FROM "what it needs", because it is not
                             * needed — the board installs without it and the
                             * rectangle is checked. What it buys is a DIFFERENT
                             * question being askable at all. Listing it with the
                             * required fields would read as "you must guess a
                             * thickness", which is the one thing that must not
                             * happen here. */
                            label: 'What a thickness buys you (optional)',
                            value:
                              'Declaring how thick the board is lets the through-the-board check ' +
                              'run: did the cutter go past the sacrificial material and into the ' +
                              'machine? Leave it blank if you have not measured it — that reports ' +
                              'PENDING, which is honest. A guessed thickness is worse than no ' +
                              'thickness, because PENDING looks like a question and a wrong number ' +
                              'looks like an answer.',
                          },
                        ] as ObjectProperty[],
                      },
                      /* ─── BOARDS THIS SHOP SAVED — TODO #104 ──────────────
                         🔴 THE COLLECTION EXISTED AND NOTHING WROTE TO IT. A
                         `spoilboards` store with no producer is, on disk,
                         indistinguishable from a shop that has never saved one.

                         ⚠ `builtIn: false`, so the picker offers `Save` (write
                         over this record) and a remove control — neither of
                         which a catalogue row may have, because there would be
                         no way back to a sourced figure. A saved board is the
                         operator's own statement and overwriting it is ordinary.

                         ⚠ THE ROW REPORTS WHAT IT HOLDS AND DOES NOT RE-GRADE
                         IT AGAINST THIS MACHINE. Its corner is a MACHINE
                         coordinate and may or may not survive selection —
                         `spoilboardForMachine` decides that on the way in, and
                         a row promising a corner the load then drops would be a
                         list disagreeing with the panel it fills. */
                      ...savedSpoilboards.items.map((rec) => {
                        const d = rec.data;
                        const sx = typedMm(d.sizeX);
                        const sy = typedMm(d.sizeY);
                        const v =
                          sx !== undefined && sy !== undefined
                            ? spoilboardReachVerdict(sx, sy, mTravelX, mTravelY, unit)
                            : null;
                        const th = (d.thickness ?? '').trim();
                        return {
                          id: SPOILBOARD_SAVED_PREFIX + rec.name,
                          name: rec.name,
                          detail:
                            `${d.sizeX || '?'} x ${d.sizeY || '?'} x ` +
                            `${th === '' ? 'thickness not declared' : L(Number(th))} · yours` +
                            (v ? ` · ${v.covers ? '✅ can cover the reach' : `🔴 cannot cover the reach — ${v.short}`}` : ''),
                          properties: [
                            {
                              label: 'Where these numbers came from',
                              value:
                                'You. This is a board your shop entered and saved — nothing here ' +
                                'sourced it, so it is exactly as good as the measurement behind it.',
                            },
                            { label: 'Size X', value: d.sizeX === '' ? 'not declared' : L(Number(d.sizeX)) },
                            { label: 'Size Y', value: d.sizeY === '' ? 'not declared' : L(Number(d.sizeY)) },
                            {
                              /* 🔴 THE `''` CASE IS SPELT OUT RATHER THAN LEFT
                               * BLANK. An empty cell reads as a rendering gap;
                               * this is a recorded state with a consequence. */
                              label: 'Thickness (a check reads it)',
                              value:
                                th === ''
                                  ? 'NOT DECLARED — and it was not declared when this board was ' +
                                    'saved. The through-the-board check reports PENDING for it, ' +
                                    'which is NOT a pass. Select it and type a thickness to arm ' +
                                    'that check.'
                                  : `${L(Number(th))} — the depth the through-the-board check measures ` +
                                    'against, and only as true as your measurement of the board ' +
                                    'actually bolted down.',
                            },
                            {
                              label: 'Can it be positioned to cover the whole reach?',
                              value: v
                                ? v.covers
                                  ? `Yes — it is at least as big as the ${L2(mTravelX, mTravelY)} travel envelope on both axes${v.overhang ? `, and ${v.overhang}` : ''}. Where it is bolted still decides what is bare.`
                                  : `NO — ${v.short} against the ${L2(mTravelX, mTravelY)} travel envelope.`
                                : 'Not answerable — this record does not carry both sizes as numbers.',
                            },
                            {
                              label: 'Position on selecting',
                              value: d.machine_travels_mm
                                ? `Saved with a corner measured against travels ${d.machine_travels_mm.map(L).join(' × ')}. ` +
                                  `If that is not this machine, the corner is DROPPED on selection rather than ` +
                                  `carried over — X and Y are machine coordinates and mean a different place here.`
                                : 'Saved without recording which machine the corner was measured on, so there is ' +
                                  'nothing to check it against and the corner will be dropped on selection.',
                            },
                          ] as ObjectProperty[],
                          builtIn: false,
                        } satisfies ObjectItem;
                      }),
                      /* Boards the inventory names that this build's catalogue
                         does not carry. ⚠ NOT the row above: `SPOILBOARD_CUSTOM`
                         is the route for a board you measured yourself, and it
                         is not an ownership question at all. */
                      ...spoilboardInv.extras,
                    ]}
                    selectedIds={spoilboardId ? [spoilboardId] : []}
                    onChange={(ids) => {
                      const id = ids[0] ?? '';
                      setSpoilboardId(id);
                      /* The refusal was about a disagreement between the row on
                       * screen and the board declared; choosing a row ends that
                       * disagreement, so the sentence goes with it. A refusal
                       * left standing after its cause is fixed is the stale-red
                       * this lane keeps writing down. */
                      setSpoilboardSaveNote(null);
                      /* 🔴 THE POSITION IS NEVER CARRIED OVER. Changing the
                       * board changes the rectangle, and keeping the last
                       * corner under a new size is one board's measurement
                       * wearing another's name. The sizes are cleared leaving
                       * the catalogue too, so the two declaration forms can
                       * never both be populated — the core installs NOTHING if
                       * they are.
                       *
                       * 🔴 AND SELECTING IS WHEN IT GETS FITTED — founder,
                       * 2026-08-10: *"fit the spoil board on the table when I
                       * select one"*. The corner written here is ASSUMED, which
                       * is why `spoilboardPos` is reset with it: a fitted
                       * position that inherited the previous board's `entered`
                       * flag would be this app's arithmetic wearing a human's
                       * authority. */
                      setSpoilboardPos('assumed');
                      const spec = spoilCat?.spoilboards.find((s) => s.id === id) ?? null;
                      const f = spec
                        ? fitSpoilboard(
                            report?.render ?? [],
                            spec.size_x_mm,
                            spec.size_y_mm,
                            mTravelX,
                            mTravelY,
                            unit
                          )
                        : null;
                      setSpoilboardX(f ? String(f.x) : '');
                      setSpoilboardY(f ? String(f.y) : '');
                      /* The fitted corner is a MACHINE coordinate, so it
                       * records which machine — see `stampSpoilboardMachine`.
                       * `null` when no fit was computed, because a corner that
                       * does not exist has no machine. */
                      setSpoilboardTravels(f ? [travelX, travelY, travelZ] : null);
                      setSpoilboardMachineNote(null);

                      /* ─── A BOARD THIS SHOP SAVED — TODO #104 ─────────────
                       *
                       * 🔴 IT LOADS INTO THE MEASURED FIELDS, WHICH IS WHY IT IS
                       * NOT A SECOND DECLARATION PATH. Everything already built
                       * on those fields then governs it for free: the size edit
                       * that re-fits only an ASSUMED corner, the `unparseable`
                       * report, the measured branch of `spoilboardCfg`, the live
                       * reach verdict. A parallel path would be a second copy of
                       * those rules and the two would agree until one was edited.
                       *
                       * 🔴 AND THE CORNER GOES THROUGH `spoilboardForMachine`,
                       * not straight into the fields. X and Y are MACHINE
                       * coordinates: a board saved on a 1250 × 670 and selected
                       * on a 6090 has a corner that means a different place, and
                       * the guard drops it BY NAME rather than this handler
                       * re-fitting one. That is the same door TODO #88 armed for
                       * the machine picker and the session restore; a third door
                       * into the same defect had to use the same guard. */
                      const savedRec = id.startsWith(SPOILBOARD_SAVED_PREFIX)
                        ? savedSpoilboards.items.find(
                            (r) => r.name === savedBoardName(id)
                          ) ?? null
                        : null;
                      if (savedRec) {
                        const read = spoilboardForMachine(
                          {
                            id,
                            x: savedRec.data.x,
                            y: savedRec.data.y,
                            sizeX: savedRec.data.sizeX,
                            sizeY: savedRec.data.sizeY,
                            thickness: savedRec.data.thickness ?? '',
                            name: savedRec.data.name,
                            /* 🔴 `'entered'`, AND ONLY BECAUSE THE GUARD CAN
                             * TAKE IT AWAY. A saved corner was typed by a person
                             * on some machine; claiming it as assumed would
                             * understate it, and claiming it as entered on the
                             * WRONG machine is the dangerous permutation TODO
                             * #88 records. The guard resolves which: on a travel
                             * mismatch it drops the corner and returns
                             * `'assumed'`, so the flag can only survive on the
                             * machine the corner was measured on. */
                            pos: 'entered',
                            travels: savedRec.data.machine_travels_mm ?? null,
                          },
                          [travelX, travelY, travelZ],
                          savedRec.saved_at
                        );
                        setSpoilboardSizeX(read.values.sizeX);
                        setSpoilboardSizeY(read.values.sizeY);
                        setSpoilboardThickness(read.values.thickness);
                        setSpoilboardName(read.values.name);
                        setSpoilboardX(read.values.x);
                        setSpoilboardY(read.values.y);
                        setSpoilboardPos(read.values.pos);
                        setSpoilboardTravels(read.values.travels);
                        setSpoilboardMachineNote(
                          read.dropped.length
                            ? { tone: 'warn', text: read.dropped[0].reason }
                            : read.provenance
                              ? { tone: 'note', text: read.provenance }
                              : null
                        );
                        return;
                      }

                      if (!isMeasuredBoardId(id)) {
                        setSpoilboardSizeX('');
                        setSpoilboardSizeY('');
                        /* 🔴 CLEARED WITH THE SIZES. A catalogue pick carries
                         * its OWN sourced thickness across, so a leftover typed
                         * depth would be a second number about one slab — which
                         * the core refuses the whole board over — and, worse,
                         * one shop's caliper reading wearing a catalogue
                         * entry's name. */
                        setSpoilboardThickness('');
                        setSpoilboardName('');
                      }
                    }}
                    /* ─── SAVING A BOARD — TODO #104 ───────────────────────────
                     *
                     * 🔴 `Save as` HAD NO WIRING AT ALL HERE, which is a
                     * different defect from #102's: the machine picker saves the
                     * WRONG thing, this one saved nothing. Both were reported as
                     * "Save as is broken" and only one of them is the open fork.
                     *
                     * ⚠ IT CAPTURES `spoilboardInPlay`, NOT THE RAW FIELDS. On a
                     * catalogue pick the size fields are empty — the numbers are
                     * on the catalogue row — so saving the fields would have
                     * written a nameless empty rectangle. Saving the board IN
                     * PLAY means `Save as` on a catalogue entry gives you an
                     * editable copy of its numbers, which is the only route to
                     * "the 2400 × 1200 I actually have is 2398 wide".
                     *
                     * ⚠ AND THAT COPY LOSES THE CATALOGUE'S ATTRIBUTION, on
                     * purpose. The record is yours; `Source` / `Read on` describe
                     * an entry, not your board, and carrying them onto a copy the
                     * shop can edit would let a typed number inherit a citation. */
                    onSaveAs={(it, _draft, newName) => {
                      const why = saveTargetRefusal(it);
                      if (why) return setSpoilboardSaveNote(why);
                      setSpoilboardSaveNote(null);
                      void savedSpoilboards.saveAs(
                        newName,
                        currentSpoilboard(newName, spoilboardInPlay)
                      );
                    }}
                    /* Over the SAME record, and offered by the picker only for a
                     * row that is not `builtIn` — so a catalogue entry has no
                     * Save, because there would be no way back to its sourced
                     * figures. */
                    onSave={(it) => {
                      const why = saveTargetRefusal(it);
                      if (why) return setSpoilboardSaveNote(why);
                      const n = savedBoardName(it.id);
                      if (!n) return;
                      setSpoilboardSaveNote(null);
                      void savedSpoilboards.replace(n, currentSpoilboard(n, spoilboardInPlay));
                    }}
                    onRemoveItem={(it) => {
                      const n = savedBoardName(it.id);
                      /* ⚠ THE DECLARATION IS NOT CLEARED WITH THE RECORD. The
                       * board is still bolted to the machine; deleting your note
                       * about it does not remove it from under the cutter, and
                       * silently reverting the job to UNCHECKED because a list
                       * entry went away would be the picture disagreeing with
                       * the shop. The fields keep what they hold. */
                      if (n) void savedSpoilboards.remove(n);
                    }}
                  />
                  {spoilboardSaveNote ? (
                    <p className="warn" data-testid="spoilboard-save-refused">
                      {spoilboardSaveNote}
                    </p>
                  ) : null}
                  {savedSpoilboards.note ? (
                    <p className="note" data-testid="spoilboard-store-note">
                      {savedSpoilboards.note}
                    </p>
                  ) : null}
                  {inventorySource('spoilboard', spoilboardInv.view)}
                  {/* 🔴 THE REFUSAL PATH. A board that was chosen before the
                      inventory said the shop does not have it — a restored
                      session, a machine loaded from the library — is REFUSED by
                      name here rather than quietly re-resolved to a similar
                      rectangle. `SPOILBOARD_CUSTOM` is excluded because it is
                      not a catalogue id and never was one — and since 2026-08-11
                      a SAVED board is excluded for a stronger version of the
                      same reason: it is not a catalogue id either, and a board
                      the shop typed into its own library is the most direct
                      statement of ownership there is. Refusing it on an
                      inventory that does not list it would be this app telling
                      the operator they do not have a board they wrote down.

                      ⚠ THE REFUSAL IS ASKED IN `spoilboardFindings`, not here —
                      the header's badge has to count this sentence, and a second
                      `inventoryRefusal` call at the render site is how a header
                      and a body end up disagreeing about whether the shop owns
                      the board. */}
                  {inventoryRefused ? (
                    <p className="bad" data-testid="spoilboard-inventory-refused">
                      {inventoryRefused}
                    </p>
                  ) : null}

                  {spoilboardId ? (
                    <>
                      {measured ? (
                        <>
                          <label className="field">
                            <span>Board name</span>
                            <span className="numwrap">
                              <input
                                type="text"
                                placeholder="spoilboard"
                                value={spoilboardName}
                                data-testid="spoilboard-name"
                                onChange={(e) => setSpoilboardName(e.target.value)}
                              />
                            </span>
                          </label>
                          {/* TEXT inputs, not `type="number"` — see the state
                              declaration. Blank has to survive as blank, because
                              blank is NOT DECLARED and `0` is a measured zero. */}
                          <label className="field">
                            <span>Board size X</span>
                            <span className="numwrap">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="not declared"
                                value={spoilboardSizeX}
                                data-testid="spoilboard-size-x"
                                /* Re-fits ONLY while the corner is still this
                                 * app's own — a measured board's size changing
                                 * must not move a corner a person typed. */
                                onChange={(e) => {
                                  setSpoilboardSizeX(e.target.value);
                                  const sx = typedMm(e.target.value);
                                  const sy = typedMm(spoilboardSizeY);
                                  if (spoilboardPos !== 'assumed' || sx === undefined || sy === undefined)
                                    return;
                                  const f = fitSpoilboard(report?.render ?? [], sx, sy, mTravelX, mTravelY, unit);
                                  if (f) {
                                    setSpoilboardX(String(f.x));
                                    setSpoilboardY(String(f.y));
                                    stampSpoilboardMachine();
                                    setSpoilboardMachineNote(null);
                                  }
                                }}
                              />
                              <MmOnlySlot unit={unit} />
                            </span>
                          </label>
                          <label className="field">
                            <span>Board size Y</span>
                            <span className="numwrap">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="not declared"
                                value={spoilboardSizeY}
                                data-testid="spoilboard-size-y"
                                onChange={(e) => {
                                  setSpoilboardSizeY(e.target.value);
                                  const sx = typedMm(spoilboardSizeX);
                                  const sy = typedMm(e.target.value);
                                  if (spoilboardPos !== 'assumed' || sx === undefined || sy === undefined)
                                    return;
                                  const f = fitSpoilboard(report?.render ?? [], sx, sy, mTravelX, mTravelY, unit);
                                  if (f) {
                                    setSpoilboardX(String(f.x));
                                    setSpoilboardY(String(f.y));
                                    stampSpoilboardMachine();
                                    setSpoilboardMachineNote(null);
                                  }
                                }}
                              />
                              <MmOnlySlot unit={unit} />
                            </span>
                          </label>
                          {/* 🔴 THE DEPTH, AND IT IS THE FIELD THAT DECIDES
                              WHETHER A CHECK CAN RUN AT ALL — TODO #104.

                              `sim::SpoilboardDepth` answers *"did the cutter go
                              through the board and into the machine?"* only when
                              the slab has a thickness. A catalogue board carries
                              a sourced one; a board the shop measured could not
                              carry any, so that limb reported PENDING forever
                              with no field to fix it. `SpoilboardCfg::thickness_mm`
                              was built in the core for exactly this and nothing
                              in the browser wrote to it.

                              🔴 TEXT, NOT `type="number"`, AND THE REASON IS THE
                              WHOLE POINT OF THE FIELD. A number input hands back
                              `''` as `0` through `Number()`, and `0` is not
                              *"nobody measured this board"* — it is a board with
                              no depth, which answers the question favourably by
                              accident. Blank has to survive as blank all the way
                              to `typedMm`, which returns `undefined`, which omits
                              the key, which is the `Option::None` the core reads
                              as UNKNOWN.

                              ⚠ IT DOES NOT RE-FIT. Depth and position are
                              separate limbs — a board getting thicker does not
                              move its corner — so unlike the two size fields
                              above this one writes nothing else. */}
                          <label className="field">
                            <span>Board thickness</span>
                            <span className="numwrap">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="not declared — depth check stays PENDING"
                                value={spoilboardThickness}
                                data-testid="spoilboard-thickness"
                                title={
                                  'How thick the slab is, in mm. LEAVE IT BLANK if you have not ' +
                                  'measured it: blank is reported as UNKNOWN and the ' +
                                  'through-the-board check says PENDING, which is not a pass. ' +
                                  'A number here is what lets that check run — and it is only as ' +
                                  'true as your measurement of the board actually bolted down.'
                                }
                                onChange={(e) => setSpoilboardThickness(e.target.value)}
                              />
                              <MmOnlySlot unit={unit} />
                            </span>
                          </label>
                        </>
                      ) : null}
                      {/* 🔴 TYPING IN EITHER FIELD MAKES THE WHOLE CORNER THE
                          OPERATOR'S, and it never reverts on its own. The pair
                          is one placement: a board fitted at 40,15 whose X was
                          then corrected to 60 is at 60,15 because a person
                          looked at it, and calling half of that "assumed" would
                          leave the panel qualifying a number nobody disputes.
                          An auto-fit that recomputed over a typed value on the
                          next render would be worse than no auto-fit at all. */}
                      <label className="field">
                        <span>Board X (lower-left)</span>
                        <span className="numwrap">
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="not declared"
                            value={spoilboardX}
                            data-testid="spoilboard-x"
                            onChange={(e) => {
                              setSpoilboardX(e.target.value);
                              setSpoilboardPos('entered');
                              // A typed corner is measured ON THIS MACHINE, and
                              // says so. Without the stamp it is a pair of
                              // numbers nothing can check later.
                              stampSpoilboardMachine();
                              setSpoilboardMachineNote(null);
                            }}
                          />
                          <MmOnlySlot unit={unit} />
                        </span>
                      </label>
                      <label className="field">
                        <span>Board Y (lower-left)</span>
                        <span className="numwrap">
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="not declared"
                            value={spoilboardY}
                            data-testid="spoilboard-y"
                            onChange={(e) => {
                              setSpoilboardY(e.target.value);
                              setSpoilboardPos('entered');
                              stampSpoilboardMachine();
                              setSpoilboardMachineNote(null);
                            }}
                          />
                          <MmOnlySlot unit={unit} />
                        </span>
                      </label>

                      {/* 🔴 THE REACH VERDICT FOR THE BOARD THAT IS ACTUALLY
                          DECLARED, RE-ASKED EVERY RENDER — TODO #104.

                          The picker grades every catalogue ROW; nothing graded
                          the board on the machine. So a board that covered the
                          reach when it was chosen kept reading as fine after its
                          size was edited, after a machine with more travel was
                          loaded, and after a saved board was restored onto a
                          different machine — the check ran once and went stale,
                          which is worse than never running, because the operator
                          remembers watching it pass.

                          ⚠ It answers the REACH question only. Whether the board
                          fits the machine's FRAME is unknown here and stays
                          unknown: `Machine` carries travel limits and no frame or
                          rail dimension at all. */}
                      {reach ? (
                        <p
                          className={reach.covers ? 'note' : 'bad'}
                          data-testid="spoilboard-reach"
                          data-covers={reach.covers ? 'yes' : 'no'}
                        >
                          {reach.covers
                            ? `This board can be positioned to cover the whole ${L2(mTravelX, mTravelY)} reach${
                                reach.overhang ? ` — ${reach.overhang}` : ''
                              }. Where it is bolted still decides what is bare.`
                            : `🔴 THIS BOARD CANNOT COVER THE REACH — ${reach.short} against the ${L2(mTravelX, mTravelY)} travel envelope. Wherever it is bolted, some reachable XY has no declared sacrificial material under it.`}
                        </p>
                      ) : null}

                      {/* 🔴 THE PROVENANCE LINE. It is the whole difference
                          between a fitted board and a measured one, and it is
                          the reason auto-fitting is safe to do at all. */}
                      {assumed ? (
                        <p className="warn" data-testid="spoilboard-assumed">
                          <b>Position ASSUMED — this app fitted it, nobody measured it.</b>{' '}
                          {fit
                            ? `Rule used: ${fit.rule}.${fit.why ? ` ${fit.why}` : ''}`
                            : 'No fit could be computed, so the corner above is whatever was last set.'}{' '}
                          Your board is bolted where the T-slots let it go, not where this
                          arithmetic centred it — <b>a 20mm error here is 20mm of bare rail being
                          reported as spoilboard</b>. Check it against the machine and type the
                          real corner; typing either number makes the pair yours.
                        </p>
                      ) : (
                        <p className="note" data-testid="spoilboard-entered">
                          Position <b>entered by you</b>. Nothing recomputes it — the fit button
                          below is the only thing that will overwrite these two numbers.
                        </p>
                      )}

                      <div className="row">
                        <button
                          type="button"
                          data-testid="spoilboard-refit"
                          disabled={!fit}
                          title={
                            fit
                              ? `Fit the board on the machine: ${fit.rule}. It would go to ${L(fit.x)}, ${L(fit.y)}. This OVERWRITES the two numbers above and marks the position ASSUMED again.`
                              : 'Nothing to fit: this board has no size yet.'
                          }
                          onClick={() => {
                            if (!fit) return;
                            setSpoilboardX(String(fit.x));
                            setSpoilboardY(String(fit.y));
                            stampSpoilboardMachine();
                            setSpoilboardMachineNote(null);
                            // Back to ASSUMED, because that is what it now is.
                            // Leaving it `entered` would launder this app's
                            // arithmetic through a flag that means "a human
                            // looked".
                            setSpoilboardPos('assumed');
                          }}
                        >
                          {fit ? `Re-fit at ${fit.x}, ${fit.y}` : 'Re-fit'}
                        </button>
                      </div>

                      {/* 🔴 WHAT THE LAST MACHINE RECONCILIATION SAID — TODO
                          #88. Either the drop reason (the corner was measured on
                          a machine with different travels, so it means a
                          different place here and was NOT carried over) or the
                          provenance sentence when it survived.

                          ⚠ A MATCH IS NOT A GREEN and the sentence says so:
                          two machines of the same model have identical travels
                          and may have their boards bolted in different places,
                          so a match can only ever prove that a MISMATCH is a
                          different machine. */}
                      {spoilboardMachineNote ? (
                        <p
                          className={spoilboardMachineNote.tone}
                          data-testid="spoilboard-machine-note"
                          data-tone={spoilboardMachineNote.tone}
                        >
                          {spoilboardMachineNote.text}
                        </p>
                      ) : null}

                      {/* 🔴 THE MACHINE WAS EDITED UNDER A DECLARED CORNER, and
                          this WARNS rather than dropping. The two discrete
                          machine changes — picking a preset, loading a saved
                          machine — are single acts and the corner is dropped on
                          them. Typing in a travel field is not one act: `Num`
                          fires on every keystroke, so `600` → `6` → `60` would
                          destroy a corner a person measured before they had
                          finished typing, and nothing brings it back. A guard
                          that fires on the wrong condition is one people learn
                          to work around.

                          So the mismatch is said, loudly, and the corner is
                          left for the operator to keep or re-enter. It is also
                          not silent afterwards: the fingerprint travels in the
                          session, so the next restore drops the corner by name
                          if it was never brought back into step.

                          ⚠ THE COMPARISON IS `spoilboardFindings.travelDrift`,
                          asked once — the badge counts this sentence, and the
                          three-way `!==` written twice is three chances for a
                          header and a body to disagree about which machine the
                          corner was measured on. */}
                      {spoilboardTravels && travelDrift ? (
                        <p className="warn" data-testid="spoilboard-travel-drift">
                          <b>
                            This corner was set against travels{' '}
                            {spoilboardTravels.map(L).join(' × ')} and the machine now reads{' '}
                            {[travelX, travelY, travelZ].map(L).join(' × ')}.
                          </b>{' '}
                          X and Y are MACHINE coordinates, so they mean a different place on the
                          machine you have now described. They were <b>not</b> changed and nothing
                          re-fitted them — check the corner against the machine and type it again,
                          or press Re-fit to let this app place the board and mark it ASSUMED.
                        </p>
                      ) : null}

                      <p className="note">
                        Machine coordinates of the board's lower-left corner, in the same frame
                        every emitted coordinate is in — measured the way you measure the workpiece
                        datum. <b>0,0 is a plausible answer and plausible is the dangerous kind</b>:
                        it slides the declared board toward the datum, and bare rail then reads as
                        spoilboard.
                      </p>
                    </>
                  ) : null}

                  {/* 🔴 WHICH OF THE FIVE STATES THE CANVAS IS IN, SAID IN
                      WORDS — founder, 2026-08-11: *"I did choose a spoilboard
                      but the eye did not come up."* The eye was correct and was
                      being fed nothing; see `spoilboardDrawn`. Stating the state
                      is what makes the difference between *"no job has run"*,
                      *"the core refused your board"* and *"you have not given it
                      a position yet"* visible instead of guessable — all three
                      used to render as one empty canvas with no control. */}
                  {spoilboardDrawn.state !== 'none' ? (
                    <p
                      className={
                        spoilboardDrawn.state === 'echoed'
                          ? 'note'
                          : spoilboardDrawn.state === 'refused'
                            ? 'bad'
                            : 'warn'
                      }
                      data-testid="spoilboard-drawn"
                      data-state={spoilboardDrawn.state}
                    >
                      {spoilboardDrawn.why}
                    </p>
                  ) : null}

                  {chosen ? (
                    <p className="note" data-testid="spoilboard-source">
                      {L2(chosen.size_x_mm, chosen.size_y_mm)}, from{' '}
                      <b>{chosen.source}</b>, read {chosen.read_on}. {chosen.note}
                    </p>
                  ) : null}

                  {/* The core's reason for having no default, in its own words.
                      Shown while nothing is chosen — which is the moment
                      somebody is deciding whether to pick "whatever is first". */}
                  {!spoilboardId && spoilCat ? (
                    <p className="warn" data-testid="spoilboard-no-default">
                      <b>No board is declared, so the position check reports UNCHECKED.</b>{' '}
                      {spoilCat.why_no_default}
                    </p>
                  ) : null}

                  {unparseable.length ? (
                    <p className="warn" data-testid="spoilboard-unparseable">
                      {unparseable.map(([k]) => k).join(' and ')}{' '}
                      {unparseable.length === 1 ? 'is not a number' : 'are not numbers'}, so{' '}
                      {unparseable.length === 1 ? 'it was' : 'they were'} NOT sent. The core is
                      answering as if {unparseable.length === 1 ? 'that field were' : 'those fields were'}{' '}
                      blank.
                    </p>
                  ) : null}

                  {/* 🔴 THE CORE'S REFUSALS AND ITS PENDING SENTENCE, VERBATIM.
                      Every one of these is a sentence the core built so that
                      every host says the same thing; re-writing them in
                      TypeScript would be a second copy of a safety message. */}
                  {notInstalled.map((n, i) => (
                    <p className="warn" data-testid="spoilboard-not-installed" key={`ni${i}`}>
                      {n}
                    </p>
                  ))}

                  {/* THE STATUS, and the three states are kept apart on purpose.
                      `null` echo = nobody declared one; a strike = the cutter
                      reaches bare machine; otherwise the limb RAN and found the
                      board under everything that went deep. */}
                  {report ? (
                    echo == null ? (
                      <p className="pending" data-testid="spoilboard-status">
                        <b>Not declared — position UNCHECKED.</b> This is not a board covering the
                        travel envelope; it is no board at all. Below-the-workpiece cells on this
                        program were judged on DEPTH ALONE.
                      </p>
                    ) : (
                      <div className="grid2" data-testid="spoilboard-status">
                        <span>Board</span>
                        <b>{echo.name}</b>
                        <span>Rectangle</span>
                        <b>
                          {/* `?? NaN` and NOT `?? 0` — three of these four are
                              nullable in the report and `Number(null)` is `0`,
                              which would render a board sitting at the machine
                              origin for a board whose position the core did not
                              report. `formatLength` renders a non-finite length
                              as `—`, which is the absence it is. */}
                          {L2(echo.size_x_mm ?? NaN, echo.size_y_mm ?? NaN)} at{' '}
                          {L(echo.x_mm ?? NaN)}, {L(echo.y_mm ?? NaN)}
                        </b>
                        <span>Reach left BARE</span>
                        {/* 🔴 FROM THE REPORT. `null` (no board) and `[0,0,0,0]`
                            (the board covers everywhere the cutter can go) are
                            DIFFERENT FACTS, and only the second is a covered
                            machine. This app does not subtract two rectangles to
                            find out which. */}
                        <b
                          data-testid="spoilboard-bare"
                          className={bare && bare.some((v) => v > 0) ? 'warnval' : 'ok'}
                        >
                          {bare == null
                            ? 'not measured — no board'
                            : bare.every((v) => v === 0)
                              ? 'none — the board covers the whole reach'
                              : `X- ${L(bare[0])} · X+ ${L(bare[1])} · Y- ${L(bare[2])} · Y+ ${L(bare[3])}`}
                        </b>
                        <span>Position</span>
                        <b
                          data-testid="spoilboard-provenance"
                          className={assumed ? 'warnval' : 'ok'}
                        >
                          {assumed ? 'ASSUMED — fitted, not measured' : 'entered by you'}
                        </b>
                        <span>Past the board's edge</span>
                        {/* 🔴 THE ALARM, AND IT IS THREE-STATE, NOT TWO.
                            `0` with `spoilboard_position_checked === false` is
                            PENDING — the rule `uncut` follows two panels down,
                            for a worse failure. And `0` with an ASSUMED corner
                            is NOT GREEN EITHER: the limb ran, but it ran against
                            a rectangle this app placed, and the placement rule
                            that fills it centres the board on the cuts — which
                            is the arrangement most likely to return zero.
                            Painting that the same green as a measured clear
                            would be the app marking its own homework. */}
                        <b
                          data-testid="spoilboard-past"
                          className={
                            !checked ? 'pending' : past > 0 ? 'bad' : assumed ? 'warnval' : 'ok'
                          }
                        >
                          {!checked ? 'PENDING' : assumed ? `${past} — against an ASSUMED board` : past}
                        </b>
                      </div>
                    )
                  ) : null}

                  {strike.map((n, i) => (
                    <p className="warn" data-testid="spoilboard-strike" key={`sk${i}`}>
                      {n}
                    </p>
                  ))}
                  {pending.map((n, i) => (
                    <p className="pending" data-testid="spoilboard-pending" key={`pd${i}`}>
                      {n}
                    </p>
                  ))}

                  {!spoilCat ? (
                    <p className="pending" data-testid="spoilboard-catalogue-pending">
                      The catalogue has not answered yet — it is built in the core and arrives with
                      the wasm. No board can be chosen until it does, and none is assumed meanwhile.
                    </p>
                  ) : null}
                </>
              );
            })()}
          </Section>

          <Section
            title="Workpiece"
            testid="panel-stock"
            eye={sectionEye('panel-stock', 'Workpiece')}
            layerRows={sectionLayerRows('panel-stock', 'Workpiece')}
          >
            {/* ⚠ THE STANDALONE `material-picker` STOOD HERE UNTIL 2026-08-11
                AND IS GONE — founder: *"merge the material into the Workpiece
                list (have a drop down for the material in the Workpiece list),
                remove the Material selection"*. It was a full `ObjectPicker`
                above the workpiece list, which said by its position that the
                material was a thing chosen BESIDE the workpiece rather than a
                property OF it.

                🔴 WHAT DID **NOT** MOVE IS THE VALUE. `material` is still a
                field of `JobConfig` and still reaches `resolve_feed()` and the
                chipload window in the core; the control moved house, the value
                did not stop existing. The standing test for this change was
                config-in → config-out byte-identical, and it is asserted in
                `web/tests/config-wiring.test.ts` — through the browser's own
                wasm, because that is where a lost material would show up.

                ⚠ AND THE ORDER IS UNCHANGED FOR THE REASON IT WAS CHOSEN
                (founder, 2026-08-08): the material caps rpm, bounds the depth of
                cut and scales the chipload, so it changes the numbers every
                later control is expressed in. It is stated below the list it now
                belongs to and still above every size and feed control. */}
            {/* 🔴 The fit verdict per sheet is the CORE's, orientation-aware:
                "fits turned 90°" is a different answer from "too big", and the
                old dropdown could only grey a row without saying which. */}
            {/* 🔴 THE RESEARCHED SHEET CATALOGUE (TODO #35), reachable for the
                first time. Every row carries the supplier page its dimensions
                were read from and the DATE it was read, or says GENERIC — "real
                in the trade, not confirmed at a page" — because a stale figure
                and an unsourced one fail differently and only one of them can be
                re-checked. The contested 2400 / 2700 / 600x900 numbers are all
                here, all sourced, and NOT resolved: that is `bom` + `ops`. */}
            {/*
              🔴 ONE LIST — the shipped sheet catalogue AND the workpieces the
              user has saved, TODO #61's third panel. What stood above this was a
              `SavedSet`: a second `saved… ▼` picker plus a `Delete` button,
              carrying exactly the leftover the founder objected to in the
              Machine section. Fixing Machine alone would have left the same
              inconsistency one section over.

              ⚠ A SHEET AND A WORKPIECE ARE DIFFERENT OBJECTS AND THE LIST SAYS
              SO PER ROW — the same rule the drawings merge follows. A sheet is a
              PUBLISHED STOCK SIZE and sets two numbers; a saved workpiece is the
              whole setup — size, thickness, material, datum and turn. Both
              belong in one list because both answer "what am I cutting"; letting
              a shipped row's supplier page and read-date rub off on a workpiece
              somebody typed in would not.
            */}
            {/* 🔴 THIS PICKER HAS NO OWNERSHIP CONTROL, AND THAT IS A GAP TO SEE
                RATHER THAN A BLANK TO FILL — TODO #105.

                The founder's four were *"machine, spoilboard, Work Holding,
                Tooling"* and `INVENTORY_KINDS` is exactly those four. A workpiece
                is the fifth thing an operator would reasonably ask *"do I have
                this"* about — it is STOCK, and *"is there a sheet of 18mm ply on
                the rack"* is a real question with a real answer.

                It is not added here because `inventory.ts` states in its own
                scope section that **a fifth kind is a decision, not an
                addition** — and the decision is not this file's: it is whether
                `bom`/`ops` will count stock at all, and whether presence (which
                is all this model records) is a useful answer for a consumable
                that runs out. The spoilboard control already carries that
                limitation in its note, and a board is the same kind of object.

                ⚠ So the absence is stated where somebody would look for the
                control, rather than left as four pickers with one and a fifth
                with none for no visible reason. */}
            {/* ── WORKPIECE TABS — TODO #64 ────────────────────────────────────
                Multiple workpieces on the table, each at its own position.
                Switching saves the current state and loads from the new one.
                Only the active workpiece is planned. */}
            {/* Always show the tab bar so the "+" button is discoverable,
                even with a single workpiece. The "×" remove button is still
                guarded — can't remove the last workpiece. */}
            <div data-testid="workpiece-tabs" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                {workpieces.map((wp, i) => (
                  <button
                    key={i}
                    type="button"
                    data-testid={`workpiece-tab-${i}`}
                    className={i === activeWorkpiece ? 'objrow-x' : ''}
                    style={{
                      padding: '2px 8px',
                      border: `1px solid ${i === activeWorkpiece ? 'var(--accent)' : 'var(--line)'}`,
                      borderRadius: 'var(--radius)',
                      background: i === activeWorkpiece ? 'var(--accent)' : 'transparent',
                      color: i === activeWorkpiece ? 'var(--bg)' : 'var(--ink)',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                    onClick={() => switchWorkpiece(i)}
                    title={`${L(wp.stockX)} × ${L(wp.stockY)} at (${L(wp.originX)}, ${L(wp.originY)})`}
                  >
                    {`#${i + 1} ${L(wp.stockX)}×${L(wp.stockY)}`}
                    {workpieces.length > 1 ? (
                      <span
                        role="button"
                        data-testid={`workpiece-remove-${i}`}
                        title="Remove this workpiece"
                        style={{ marginLeft: 4, opacity: 0.6, cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); removeWorkpiece(i); }}
                      >
                        ×
                      </span>
                    ) : null}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="workpiece-add"
                  title="Add another workpiece"
                  style={{
                    padding: '2px 8px',
                    border: '1px dashed var(--line)',
                    borderRadius: 'var(--radius)',
                    background: 'transparent',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                  onClick={addWorkpiece}
                >
                  +
                </button>
              </div>
            <ObjectPicker
              label="Workpiece"
              testid="workpiece-picker"
              mode="single"
              /* 🔴 NAMED RATHER THAN LEFT AS THE BARE `choose…` DEFAULT — TODO
                 #77. A control with no visible label and a vague placeholder is
                 worse than the duplication the founder is complaining about.

                 ⚠ THE REASON WAS WRONG UNTIL 2026-08-11 and is corrected rather
                 than deleted, because it is the sentence that will be quoted the
                 next time somebody asks whether this placeholder can go. It said
                 this was *"the empty state's only chance to say WHAT is
                 unchosen"*. It was not: the trigger's own action span rendered
                 `Choose Workpiece`, visibly, at the same moment. That span now
                 clips its noun under the same rule (`ObjectPicker`'s
                 `actionVerb`), so the claim is true TODAY — and it is true only
                 while both halves of TODO #77 hold. If either is reverted this
                 placeholder is a third repeat again, not a lone label. */
              placeholder="choose a workpiece…"
              searchPlaceholder="plywood, MDF, acrylic, 2400, EU, saved…"
              items={[
              ...SHEET_SIZES.map((s) => {
                const f = sheetFits[s.id];
                const unusable = !!f && !f.fits && f.turn == null;
                const o = shipped(
                  s.source
                    ? `a researched sheet size, read ${s.source.read}`
                    : 'a sheet size that is real in the trade but was NOT confirmed at a supplier page'
                );
                const sheetMaterial = materialOfSheet(s);
                return {
                  id: rowId('sheet', s.id),
                  builtIn: true,
                  // Region is in the searchable text for the same reason the
                  // tool category is: a property to narrow BY, never a filter to
                  // hide behind.
                  name: `${s.name} · ${s.region}`,
                  /* 🔴 THE ROW'S OWN ANSWER TO THE FACET, and `undefined` is one
                     of the answers. The four material-agnostic panel sizes state
                     nothing — a US 4x8 is sold in ply, MDF, acrylic and
                     aluminium alike — and they are reachable through the
                     facet's own "(material not stated)" option rather than
                     being quietly excluded from every value. */
                  facet: sheetMaterial,
                  detail: withTag(
                    o.tag,
                    `${sheetMaterial ?? 'material not stated'} · ` +
                      (!f
                        ? 'sheet · fit not checked yet'
                        : f.fits
                          ? 'fits this machine as laid'
                          : f.turn != null
                            ? `fits turned ${f.turn}°`
                            : 'too big for this machine, any way round')
                  ),
                  disabled: unusable,
                  disabledReason: 'larger than the machine travel in both orientations',
                  properties: [
                    o.prop,
                    {
                      label: 'What choosing it sets',
                      value:
                        'Size X and Y, and the turn if it only fits turned — nothing else. ' +
                        'Thickness, material and datum stay as they are.',
                    },
                    {
                      /* 🔴 STATED, NOT ASSUMED. A size that says nothing about
                         what it is made of says so; it is not filled in with the
                         first plausible material, because the whole point of the
                         field is that the picker can say what a row is made of
                         — and a guess would make it say so confidently. If this
                         disagrees with the job's material, the panel below the
                         list reports a CONFLICT and resolves nothing. */
                      label: 'Material',
                      value:
                        sheetMaterial ??
                        'NOT STATED — this size is sold in several materials, so the catalogue records none',
                    },
                    { label: 'Size', value: L2(s.w, s.h) },
                    {
                      label: 'On this machine',
                      value: f
                        ? f.fits
                          ? 'fits'
                          : f.turn != null
                            ? `fits turned ${f.turn}°`
                            : 'does not fit'
                        : 'not checked yet',
                    },
                    {
                      // NOMINAL, and the catalogue header says why that word is
                      // load-bearing: a "18mm" sheet is not 18mm, and the AU
                      // structural ladder has no 18 rung at all. Thickness is
                      // typed in below and this list does not set it.
                      /* 🔴 NOT CONVERTED, AND IT IS THE ONE NUMERIC ROW IN
                       * THIS PANEL THAT IS NOT — TODO #109. A NOMINAL is a trade
                       * designation, not a measurement: the comment above says
                       * an "18mm" sheet is not 18mm. Imperial trade names its
                       * own nominals (3/4", 1/2"), and 18 mm is 0.7087 in, which
                       * is not one of them. Converting would invent an imperial
                       * sheet size that no supplier sells, in the one field
                       * whose whole job is to name what a supplier sells. It
                       * keeps its `mm` in its own text. */
                      label: 'Sold in (nominal, mm)',
                      value: s.thickness_mm.length
                        ? `${s.thickness_mm.join(', ')} mm`
                        : 'a range too wide to enumerate honestly',
                    },
                    {
                      label: 'Sourced',
                      value: s.source
                        ? `yes — read ${s.source.read}`
                        : 'NO — generic: real in the trade, not confirmed at a supplier page',
                    },
                    ...(s.source ? [{ label: 'Source', value: s.source.url }] : []),
                    { label: 'Why it is listed', value: s.detail },
                  ],
                } satisfies ObjectItem;
              }),
              ...savedWorkpieces.items.map((rec) => {
                const o = yours(rec.saved_at);
                const d = rec.data;
                /* 🔴 ABSENT IS A THIRD ANSWER AND IT IS SAID OUT LOUD. A record
                   written before this app kept a material — and every record a
                   future field is added to — comes back with `material`
                   undefined. This row USED to interpolate it straight into the
                   detail line, so such a workpiece read
                   `1200 x 600 x 18 mm · undefined`, and the Material property
                   rendered as an empty string: a missing value shown as a blank,
                   which reads as "nothing to see" rather than "this record does
                   not say". `materialOfWorkpiece` is the one place that decides
                   what counts as stated, so it decides here too. */
                const savedMaterial = materialOfWorkpiece(d);
                return {
                  id: rowId('saved', rec.name),
                  name: rec.name,
                  facet: savedMaterial,
                  detail: withTag(
                    o.tag,
                    `${L3(Number(d?.stockX), Number(d?.stockY), Number(d?.thickness))} · ${savedMaterial ?? 'material NOT STATED'}`
                  ),
                  properties: [
                    o.prop,
                    {
                      label: 'What choosing it sets',
                      value: savedMaterial
                        ? 'the WHOLE workpiece — size, thickness, material, datum X/Y, the turn ' +
                          'and where Z zero is.'
                        : 'size, thickness, datum X/Y, the turn and where Z zero is — but NOT the ' +
                          'material, because this record does not state one. The job keeps the ' +
                          'material it is already planned against, and the line under the list ' +
                          'says that nothing here confirmed it.',
                    },
                    { label: 'Size X', value: L(Number(d?.stockX)), input: { kind: 'number', key: 'stockX', step: 1, min: 1, unit: 'mm' } },
                    { label: 'Size Y', value: L(Number(d?.stockY)), input: { kind: 'number', key: 'stockY', step: 1, min: 1, unit: 'mm' } },
                    { label: 'Thickness', value: L(Number(d?.thickness)), input: { kind: 'number', key: 'thickness', step: 0.5, min: 0.5, unit: 'mm' } },
                    {
                      label: 'Material',
                      value: savedMaterial ?? `NOT STATED — ${NOT_STATED_WHY}`,
                    },
                    { label: 'Datum X', value: L(Number(d?.originX)), input: { kind: 'number', key: 'originX', step: 0.5, unit: 'mm' } },
                    { label: 'Datum Y', value: L(Number(d?.originY)), input: { kind: 'number', key: 'originY', step: 0.5, unit: 'mm' } },
                    { label: 'Laid at', value: `${d?.rotation}°`, input: { kind: 'number', key: 'rotation', step: 90, min: 0, max: 270, unit: '°' } },
                    { label: 'Z zero', value: d?.zZeroTop ? 'stock top' : 'spoilboard' },
                    {
                      /* ⚠ The fit verdict every SHIPPED row above carries is
                         absent here, and saying so is the point. `sheetFits` is
                         computed from the catalogue by id; a saved workpiece is
                         not in it, so this app has NOT asked the core whether
                         this one fits the machine. The plan-time refusal still
                         stands behind it — an unchecked row is not an approved
                         row. */
                      label: 'On this machine',
                      value:
                        'NOT CHECKED HERE — the fit verdict beside the shipped sheets is ' +
                        'computed per catalogue row and this is not one. The planner still ' +
                        'refuses a workpiece that does not fit.',
                    },
                  ],
                } satisfies ObjectItem;
              }),
              ]}
              /* Matched UNORDERED. A sheet is the same sheet whichever way it is
                 laid — how it is laid is `rotation`, which is a separate field
                 with its own control — so a 900x600 catalogue entry must still
                 read as selected on a 600x900 workpiece. Ordered matching would
                 have shown NOTHING selected on the app's own opening state.

                 🔴 AND THE SAVED ROWS TICK NOW — this expression WAS the whole
                 ticked set, i.e. the shipped catalogue filtered by dimension,
                 which is structurally incapable of containing a workpiece the
                 operator saved. It is the machine defect verbatim, one section
                 down, and it is fixed by CALLING the machine's module rather
                 than by writing the rule a second time.

                 The comment that stood here defended the old behaviour — *"a
                 saved workpiece never ticks … eight numbers any of which the
                 operator may change after loading"* — and that objection is
                 RIGHT and is kept: `selectedIdsWithLoaded` ticks the loaded row
                 only while all eight still equal the snapshot that was loaded.
                 Retype one dimension, or change the material, and the tick drops
                 itself. */
              selectedIds={selectedIdsWithLoaded(
                SHEET_SIZES.filter(
                  (s) => (s.w === stockX && s.h === stockY) || (s.h === stockX && s.w === stockY)
                ).map((s) => rowId('sheet', s.id)),
                loadedWorkpiece,
                /* The panel as it stands, in exactly the fields a record holds —
                 * `currentWorkpiece()` is what Save writes, so the tick compares
                 * against the same eight values a Save would record. */
                { ...currentWorkpiece() }
              )}
              /* 🔴 THE FOUNDER'S PER-MATERIAL FILTER — *"able to filter workpiece
                 by material via a drop down"*. It obeys `ObjectPicker` rule 1
                 exactly like the search box: it narrows by a value the row
                 STATES and it never sees `disabled`, so it cannot hide a row for
                 being unusable. Whatever it hides is COUNTED at the foot of the
                 dialog, ATTRIBUTED — "12 hidden (9 by the Material filter, 3 by
                 search)" — because a bare total sends the operator to clear the
                 wrong control. */
              /* 🔴 A LIST SINCE 2026-08-11, and the built-in *Selected* facet
                 arrives beside it rather than instead of it. Material and
                 Selected are independent axes and they AND together — see
                 `ObjectPicker`'s `Facet`. */
              facets={[{
                label: 'Material',
                value: workpieceMaterialFacet,
                onChange: setWorkpieceMaterialFacet,
                options: workpieceMaterialOptions,
                /* The host owns the comparison. `ObjectPicker` never learns what
                   a material is, and `facetMatches` is `jobMaterial.ts`'s, so
                   the "states nothing" case is decided in one place. */
                matches: (item: ObjectItem, value: string) => facetMatches(item.facet, value),
              }]}
              onChange={(ids) => {
                const parsed = parseRowId(ids[0] ?? '', ['sheet', 'saved']);
                if (!parsed) return;
                if (parsed.kind === 'sheet') {
                  const s = SHEET_SIZES.find((x) => x.id === parsed.name);
                  if (!s) return;
                  pushSnapshot();
                  setStockX(s.w);
                  setStockY(s.h);
                  const t = sheetFits[s.id]?.turn;
                  setRotation(t == null ? 0 : t);
                  /* 🔴 IT DOES NOT SET THE MATERIAL, and that is the point rather
                     than an omission. The row's own properties say it sets Size X
                     and Y and nothing else, and quietly changing the material
                     here would rescale every feed in the program off a control
                     the operator did not touch. If the sheet states a material
                     and the job is planned against a different one, that is a
                     CONFLICT and it is reported below the list. */
                  setPickedWorkpiece({ name: s.name, material: materialOfSheet(s) });
                  /* A sheet ticks by DIMENSION — the catalogue rule above, which
                     works for a published stock size — so nothing needs latching
                     here. What must not survive is a latch from a saved
                     workpiece the operator has just replaced: that would tick a
                     record that is no longer in the job. The machine arm clears
                     its own latch on a preset for the same reason. */
                  setLoadedWorkpiece(null);
                  return;
                }
                const w = savedWorkpieces.items.find((x) => x.name === parsed.name)?.data;
                if (!w) return;
                /* 🔴 A RECORD THAT STATES NO MATERIAL DOES NOT SET ONE, and the
                   line this replaces did: `setMaterial(w.material)` wrote
                   `undefined` into the job's material for any workpiece saved
                   before this app recorded one. That value goes STRAIGHT into
                   `JobConfig.material` and from there into `resolve_feed()` and
                   the chipload window — a feed scaled by a material nobody
                   chose, which is this lane's worst UI defect wearing a new
                   face. Absent means the job KEEPS the material it is planned
                   against, and the agreement line below says in words that the
                   record neither contradicted nor confirmed it. */
                const stated = materialOfWorkpiece(w);
                pushSnapshot();
                setStockX(w.stockX);
                setStockY(w.stockY);
                setThickness(w.thickness);
                if (stated) setMaterial(stated);
                setOriginX(w.originX);
                setOriginY(w.originY);
                setRotation(w.rotation);
                setZZeroTop(w.zZeroTop);
                /* A saved workpiece that states a material APPLIES it — it
                   always has. Recorded here too so the two agree by construction
                   and the panel below says which surface answered. */
                setPickedWorkpiece({ name: parsed.name, material: stated });
                /* 🔴 THE SNAPSHOT IS WHAT THE PANEL WILL HOLD, NOT WHAT THE
                 * RECORD SAID — the same rule as the machine arm, and here it is
                 * the material that makes the two differ: a record stating none
                 * leaves the job's current material in place, so THAT is the
                 * value the tick must compare against. Snapshotting `w.material`
                 * would compare against a value the app never adopted, the
                 * comparison would fail on the first render, and the tick would
                 * never appear — a fix that looks like it did not work. */
                setLoadedWorkpiece({
                  id: ids[0],
                  snapshot: {
                    stockX: w.stockX,
                    stockY: w.stockY,
                    thickness: w.thickness,
                    material: stated ?? material,
                    originX: w.originX,
                    originY: w.originY,
                    rotation: w.rotation,
                    zZeroTop: w.zZeroTop,
                  },
                });
              }}
              onRemoveItem={(it) => {
                const p = parseRowId(it.id, ['sheet', 'saved']);
                if (p?.kind === 'saved') void savedWorkpieces.remove(p.name);
              }}
              onSave={(it, draft) => {
                const p = parseRowId(it.id, ['sheet', 'saved']);
                if (p?.kind === 'saved') void savedWorkpieces.replace(p.name, { ...currentWorkpiece(), ...draft });
              }}
              onSaveAs={(it, draft, newName) => {
                /* 🔴 TODO #102 — same refusal as the machine picker. previewItem
                   follows the ACTIVE row; arrowing changes it without selecting.
                   The selected set uses DIMENSION for presets, so a previewed
                   sheet with different dimensions is not selected and must not be
                   saved from the stale panel. */
                if (it) {
                  const p = parseRowId(it.id, ['sheet', 'saved']);
                  const isSelectedSheet = p?.kind === 'sheet' && SHEET_SIZES.some(
                    (s) => s.id === p.name && s.w === Number(stockX) && s.h === Number(stockY),
                  );
                  const loaded = useCncStore.getState().loadedWorkpiece as string | null;
                  const isLoadedSaved = p?.kind === 'saved' && p.name === loaded;
                  if (!isSelectedSheet && !isLoadedSaved) {
                    const active = loaded
                      ? `the saved workpiece "${loaded}"`
                      : `a ${stockX} × ${stockY} workpiece`;
                    setWorkpieceSaveNote(
                      `Nothing was saved. You are looking at "${it.name}", but the panel holds ` +
                      `${active} — select "${it.name}" first if you meant it, or close and reopen this list, then press Save as without arrowing through it, if you meant to save what is set up now.`,
                    );
                    return;
                  }
                }
                setWorkpieceSaveNote(null);
                void savedWorkpieces.saveAs(newName, { ...currentWorkpiece(), ...draft });
              }}
            />
            {savedWorkpieces.note ? (
              <p className="note" data-testid="workpiece-note">
                {savedWorkpieces.note}
              </p>
            ) : null}
            {workpieceSaveNote ? (
              <p className="note bad" data-testid="workpiece-save-note">
                {workpieceSaveNote}
              </p>
            ) : null}
            {/* ── THE MATERIAL, AS A PROPERTY OF THE WORKPIECE ────────────────
                Founder, 2026-08-11: *"merge the material into the Workpiece list
                (have a drop down for the material in the Workpiece list), remove
                the Material selection"*. The `material-picker` that stood at the
                top of this section is gone; this is where the value is stated
                now — inside the Workpiece section, under the list that sets it.

                🔴 A DROP DOWN AND NOT AN `ObjectPicker`, deliberately. The
                material is now a FIELD OF THE WORKPIECE, one of the eight things
                `currentWorkpiece()` writes, and it sits beside Size / Thickness /
                Datum, which are all plain fields. A second dialog-based picker
                here would say by its shape that the material is a separate
                object being chosen alongside the workpiece — the exact reading
                this change removes.

                🔴 THE OPTIONS ARE THE CORE'S LIST AND NOTHING ELSE.
                `materialLibrary` is `lib.materials`, read at runtime. The old
                picker fell back to a HARDCODED `[{ name: 'Plywood' }]` while the
                wasm was loading — a control offering a material out of a list
                this app invented, which is a second copy of `Material::as_str`
                by another name. It is `disabled` until the list arrives instead,
                and says so.

                ⚠ AND THE CURRENT VALUE IS ALWAYS AN OPTION, even when the
                library does not carry it, LABELLED. A `<select>` whose `value`
                matches no `<option>` renders BLANK, so a session restored with a
                material this build's planner has dropped would show an empty
                control over a job still planned against that name. Blank reads
                as "nothing set"; it is not. The agreement line under this control
                is what says the job cannot be planned.

                ⚠ NO EMPTY CHOICE, AND THAT IS THE BEHAVIOUR THAT WAS PRESERVED
                RATHER THAN IMPROVED. `material` opens as `'Plywood'` and no
                control could empty it before this change either, so the
                `not-stated` arm of `jobMaterial.ts` stays unreachable from this
                surface. Making the job's material emptiable is a change to what
                every restored session and every saved workpiece MEANS — not a
                wiring change — and it would move `SESSION_VERSION`. It is
                reported here, not made here. */}
            <label className="field">
              <span>Material</span>
              <select
                value={material}
                onChange={(e) => { pushSnapshot(); setMaterial(e.target.value); }}
                data-testid="material"
                disabled={!lib}
              >
                {materialLibrary.includes(material) ? null : (
                  <option value={material}>
                    {material}
                    {lib ? ' — NOT in this build’s planner' : ''}
                  </option>
                )}
                {materialLibrary.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            {/* The numbers the chosen material carries — the CORE's, shown here
                and decided there. They were the old picker's properties panel and
                they are the reason the material is not a free-text field: it caps
                rpm, bounds the depth of cut and scales the chipload, so every
                feed in the emitted program is expressed in them. */}
            {!lib ? (
              <p className="pending" data-testid="material-library-pending">
                The core&rsquo;s material list has not arrived yet — it is built in the core and
                comes with the wasm. Nothing is offered until it does, and no list is assumed
                meanwhile.
              </p>
            ) : (
              (() => {
                const m = lib.materials.find((x) => x.name === material);
                if (!m)
                  return (
                    <p className="bad" data-testid="material-numbers-missing">
                      &ldquo;{material}&rdquo; is not a material this build&rsquo;s planner carries,
                      so it has NO chipload factor, depth-of-cut ratio or rpm cap here. It has not
                      been matched to a similar name: a substituted material scales every feed in
                      the program by somebody else&rsquo;s multiplier.
                    </p>
                  );
                return (
                  <div className="grid2" data-testid="material-numbers">
                    <span>Chipload factor</span>
                    <b>{m.chipload_factor}</b>
                    <span>Max depth of cut</span>
                    <b>{m.max_doc_ratio} x cutter diameter</b>
                    <span>Max rpm</span>
                    <b>{m.max_rpm}</b>
                  </div>
                );
              })()
            )}
            {/* ── WHAT THIS JOB IS PLANNED AGAINST ────────────────────────────
                🔴 A CONFLICT IS SURFACED AND NEVER RESOLVED. Both names are
                printed, plus which one the program will actually carry, and
                nothing here chooses: the core derives chipload — and therefore
                every feed the program emits — from the material, so preferring
                one silently would be deciding which of two numbers on screen is
                a lie. The operator fixes whichever is wrong. */}
            {(() => {
              if (!materialAgreement) {
                return (
                  <p className="note" data-testid="material-pending">
                    The core&rsquo;s material list has not loaded yet, so nothing has been compared.
                    That is a waiting state, not agreement.
                  </p>
                );
              }
              switch (materialAgreement.state) {
                case 'conflict':
                  return (
                    <p className="bad" data-testid="material-conflict">
                      TWO MATERIALS. {materialAgreement.why}
                    </p>
                  );
                case 'unknown':
                  return (
                    <p className="bad" data-testid="material-unknown">
                      NO USABLE MATERIAL. {materialAgreement.why}
                    </p>
                  );
                case 'agreed':
                  return (
                    <p className="note" data-testid="material-agreed">
                      Planned against &ldquo;{materialAgreement.name}&rdquo;, from{' '}
                      {materialAgreement.from}.
                      {materialAgreement.note ? ` ${materialAgreement.note}` : ''}
                      {pickedWorkpiece
                        ? ''
                        : ' No workpiece record is selected — the size below was typed, so nothing' +
                          ' states a second material and there is nothing to disagree with.'}
                    </p>
                  );
              }
            })()}
            {/* 🔴 THESE THREE CLEAR THE SELECTED RECORD. They are the numbers a
                sheet row or a saved workpiece SET; once one is typed over, the
                record has stopped describing what is on the bed, and naming it
                in a material sentence would point at the wrong object.
                `jobMaterial.ts` calls that state ad-hoc and says it is NOT a
                conflict. Datum, turn and Z-zero deliberately do NOT clear it —
                where the board sits says nothing about what it is made of. */}
            <Num
              unit={unit}
              label="Size X"
              value={stockX}
              onChange={(v) => {
                setStockX(v);
                setPickedWorkpiece(null);
              }}
              testid="stock-x"
            />
            <Num
              unit={unit}
              label="Size Y"
              value={stockY}
              onChange={(v) => {
                setStockY(v);
                setPickedWorkpiece(null);
              }}
              testid="stock-y"
            />
            <Num
              unit={unit}
              label="Thickness"
              value={thickness}
              onChange={(v) => {
                setThickness(v);
                setPickedWorkpiece(null);
              }}
              step={0.5}
              testid="thickness"
            />

            <Num label="Datum X" value={originX} onChange={(v) => { pushSnapshot(); setOriginX(v); }} testid="origin-x" unit={unit} />
            <Num label="Datum Y" value={originY} onChange={(v) => { pushSnapshot(); setOriginY(v); }} testid="origin-y" unit={unit} />
            {/* 🔴 A SEPARATE PAIR FROM THE DATUM, and labelled so nobody reads
                them as the same setting. The datum says where the WORKPIECE
                sits on the MACHINE; these say where the PART sits on the
                WORKPIECE. They compose in one direction only, so turning the
                workpiece carries the part round with it and the part's offset
                is unchanged by it.

                🔴 THREE RECTANGLES, THREE WORDS — and until 2026-08-11 this
                comment used TWO. It read *"the part is on the sheet and the
                sheet is on the bed"*, which is the S1 collapse
                (`docs/terminology.md`) written out as a design rule in the one
                place a later reader would take it as one. There is no `sheet`
                and no `bed`: there is the WORKPIECE, the SPOILBOARD and the
                MACHINE, they are three different rectangles, and a message that
                names two of them cannot say which one a number is measured
                from. The spoilboard is absent from this composition entirely —
                nothing here places a part on it.

                ⚠ THE CLAMPS ARE IN NEITHER FRAME. They are declared in MACHINE
                coordinates and do not move with the workpiece or with the part
                (`AGENTS.md`: *the clamps do not move with the parts*), which is
                why `fit` reports a datum shift and refuses to apply one. The
                clause that stood here — *"moving the board does not move the
                part relative to the clamps it is held by"* — asserted the
                opposite and is removed rather than reworded. */}
            {/* 🔴 DEAD WITH NO DRAWING, SO IT SAYS SO. `partX`/`partY` are a
                VIEW of `drawings[sel].offset` (see their declaration) — with an
                empty list they read 0 and `movePart` maps over nothing. Until
                2026-08-11 the inputs were still editable in that state: on a
                fixture job you could type 700 into Part X, the field snapped
                back to 0, the plan never moved, and the status stayed
                `runnable`. Their own header already called that out —
                *"deliberately not an editable 0: a field that accepts a number
                and moves nothing is this lane's most-repeated defect"* — and
                nothing implemented it. It cost an e2e test that had been
                asserting the sim's PAST-THE-EDGE note through a control that
                could not move a part.

                ⚠ The reason is in the tooltip and not only here, because the
                operator reading a greyed field asks WHY, and "there is no part
                to move" is a different answer from "this app cannot do that". */}
            <Num
              unit={unit}
              label="Part X"
              value={partX}
              onChange={setPartX}
              testid="part-x"
              disabled={drawings.length === 0}
              title={
                drawings.length === 0
                  ? 'There is no drawing on the workpiece, so there is no part to move. Add a drawing first.'
                  : undefined
              }
            />
            <Num
              unit={unit}
              label="Part Y"
              value={partY}
              onChange={setPartY}
              testid="part-y"
              disabled={drawings.length === 0}
              title={
                drawings.length === 0
                  ? 'There is no drawing on the workpiece, so there is no part to move. Add a drawing first.'
                  : undefined
              }
            />
            <label className="field">
              <span>Laid at</span>
              <select
                value={String(rotation)}
                onChange={(e) => { pushSnapshot(); setRotation(Number(e.target.value)); }}
                data-testid="stock-rotation"
              >
                {[0, 90, 180, 270].map((d) => (
                  <option key={d} value={d}>
                    {d}&deg;
                  </option>
                ))}
              </select>
            </label>
            <div className="row-buttons">
              <button
                type="button"
                onClick={() => { const s = useCncStore.getState(); s.setRotation((s.rotation + 270) % 360); }}
                data-testid="rotate-ccw"
                title="Turn the workpiece a quarter turn anticlockwise"
              >
                &#8634; 90&deg;
              </button>
              <button
                type="button"
                onClick={() => { const s = useCncStore.getState(); s.setRotation((s.rotation + 90) % 360); }}
                data-testid="rotate-cw"
                title="Turn the workpiece a quarter turn clockwise"
              >
                90&deg; &#8635;
              </button>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={zZeroTop}
                onChange={(e) => setZZeroTop(e.target.checked)}
                data-testid="z-zero-top"
              />
              Z zero on stock top (else spoilboard)
            </label>
            {/*
              🔴 This used to be `stockX > travelX || stockY > travelY` — a
              machining rule written a second time, in TypeScript, where no gate
              could see it. It was also WRONG in the way that mattered: it takes
              no account of how the sheet is laid, so a 600x900 sheet on a
              1250x670 machine was told it did not fit when it fits turned.
              The core owns the rule now; this only shows what the core said.
            */}
            {fitRefusal ? (
              <p className="bad" data-testid="stock-too-big">
                {fitRefusal}
              </p>
            ) : null}
            {fitRefusal && placement && 'dx' in placement ? (
              <p className="warn" data-testid="placement-offer">
                {placement.describe}
                <button
                  type="button"
                  data-testid="placement-apply"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    updateDrawings((ds) =>
                      ds.map((d, j) =>
                        j === sel
                          ? { ...d, offset: [d.offset[0] + placement.dx, d.offset[1] + placement.dy] as [number, number] }
                          : d
                      )
                    );
                    setPlacement(null);
                  }}
                >
                  {`Apply shift X ${placement.dx.toFixed(1)} Y ${placement.dy.toFixed(1)}`}
                </button>
              </p>
            ) : fitRefusal && placement && 'willNotFit' in placement ? (
              <p className="bad" data-testid="placement-will-not-fit">
                {placement.describe}
              </p>
            ) : null}
          </Section>

          <Section
            title="Drawing"
            testid="panel-import"
            eye={sectionEye('panel-import', 'Drawing')}
            layerRows={sectionLayerRows('panel-import', 'Drawing')}
          >
            {/*
              🔴 ONE LIST FOR ALL DRAWINGS — TODO #54. What stood here was THREE
              controls: `sample-picker` (shipped DXF/SVG), `mesh-sample-picker`
              (shipped STL) and a `SavedSet` (the user's own), each with its own
              trigger, its own placeholder and no knowledge of the other two. The
              rows are built in `drawingItems` above, where the reasons live: one
              LIST not one TYPE, the section-Z warning on every mesh row, the
              origin on every row, and ids prefixed by surface so two drawings of
              the same part can never resolve to one id.

              The shipped samples are still REAL DXF FILES PARSED BY THE IMPORTER
              and not the built-in fixtures — a demo that takes a different route
              through the code than a user's own file can be green while import
              is broken.

              🔴 MULTI-SELECT — founder 2026-08-10: *"I should able to add more
              than 1 drawings"*. It was REFUSED on 2026-08-09 and the refusal was
              right at the time: `mode="multi"` would have cost one word and
              produced chips saying two parts over a program containing one. What
              had to exist first, and now does:
                (a) a core that plans N PLACED parts — `plan_report_import_many`,
                    which every import in this app now goes through, including a
                    single drawing, so there is no path on which the check below
                    does not run;
                (b) 🔴 THE OVERLAP REFUSAL, BEFORE ANYTHING ELSE. Drop two
                    drawings on one spot and the program used to cut both,
                    through each other — scrap at best, a loose offcut under a
                    2.2 kW spindle at worst. The core now refuses the sheet, names
                    both parts, and emits ZERO bytes. Gate MULTI holds it, with a
                    paired positive so a check that refused everything could not
                    pass;
                (c) a session store that holds MORE THAN ONE reference —
                    `SessionValues.drawings` is a list, each entry validated and
                    dropped BY NAME. Before, a multi-selection could have been
                    held in memory and would have been dropped on refresh with
                    nothing to say so.
              ⚠ STILL NOT DONE, and named rather than implied: tabs are per JOB,
              not per part (TODO #31 item 2) — three parts with one of them tabbed
              still leaves two loose pieces.
            */}
            <ObjectPicker
              label="Drawing"
              testid="drawing-picker"
              mode="multi"
              placeholder="choose drawings…"
              searchPlaceholder="hive, nest, solid, saved…"
              /* 🔴 THE CORE'S VERDICT, ONTO THE CATALOGUE ROW. A verdict is
                 about an INSTANCE on the workpiece and a row is a CATALOGUE
                 ENTRY, so a row that has put several copies in the job carries
                 several answers: `worstDrawingFit` picks the one value the facet
                 needs, and every instance's own sentence is listed in the
                 properties below it, verbatim. Nothing here is merged. */
              items={drawingItems.map((it) => {
                const vs = drawingVerdictsByRow.get(it.id) ?? [];
                return {
                  ...it,
                  /* The FIT value the filter narrows on — 🔴 never `usability`.
                     `undefined` when this row put nothing on the workpiece,
                     which the facet reaches through its own option rather than
                     dropping the row. */
                  facet: worstDrawingFit(vs),
                  /* The red mark rides on the row, ahead of the catalogue text,
                     with the CORE's sentence attached — because that is the
                     sentence the planner refuses the whole workpiece with, and a
                     row that says "it does not work" without it leaves an
                     operator guessing which of the four rules fired. */
                  detail: [
                    ...vs
                      .filter((v) => v.usability !== 'usable' || v.fit !== 'on-workpiece')
                      .map((v) =>
                        [
                          vs.length > 1 ? `${v.id}:` : '',
                          v.usability !== 'usable'
                            ? `${drawingUsabilityMark(v)}${v.why ? ` — ${v.why}` : ''}`
                            : '',
                          v.fit !== 'on-workpiece'
                            ? `${drawingFitMark(v)}${v.why_fit ? ` — ${v.why_fit}` : ''}`
                            : '',
                        ]
                          .filter((s) => s)
                          .join(' ')
                      ),
                    it.detail ?? '',
                  ]
                    .filter((s) => s)
                    .join(' · '),
                  properties: [
                    /* One block per instance. With two copies of one drawing the
                       two can have DIFFERENT answers — that is the whole reason
                       copies exist and the reason the row's single value is a
                       summary rather than the fact. */
                    ...(vs.length === 0
                      ? drawingVerdictProps(undefined)
                      : vs.flatMap((v) =>
                          vs.length > 1
                            ? [
                                { label: `— in the job as`, value: v.id },
                                ...drawingVerdictProps(v),
                              ]
                            : drawingVerdictProps(v)
                        )),
                    ...(it.properties ?? []),
                  ],
                };
              })}
              /* `'file'` composes to an id no row carries, so a drawing opened
                 from disk shows nothing selected — which is true: it is not in
                 the list until it is saved. */
              selectedIds={drawings.map((d) => drawingRowId(d.origin, d.name))}
              onChange={(ids) => void syncDrawings(ids)}
              /* 🔴 THE FILTER IS ON `fit` AND NEVER ON `usability` — the
                 founder's *"a filter on the drawings as well like in the tools
                 (selected, usable, not chosen, not for this workpiece …)"*, with
                 the tool picker's safety half carried across unchanged. Hiding
                 the `invalidates` rows would hide exactly the rows an operator
                 most needs to see — they are why the workpiece will be refused —
                 which is `ObjectPicker` rule 1 turned against the person using
                 it. `fit` answers a different question and narrowing by it hides
                 nothing about whether the job can be cut.

                 It is OPT-IN (`''` = every drawing) and the picker states what
                 it hid, attributed. The built-in *Selected* facet ANDs with this
                 one — *selected AND not on this workpiece* is exactly the view
                 somebody chasing a refusal wants. */
              facets={[{
                /* NOT "fits" and NOT "can be cut" — see `FIT_OPTIONS`, which
                   names the two questions this value does NOT answer (a turn
                   that would fit it, and every depth/reach/clearance rule). The
                   filter's name is the field it narrows on. */
                label: 'Outline on the workpiece',
                value: drawingFitFilter,
                onChange: setDrawingFitFilter,
                options: FIT_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                  /* Counted over EVERY row this picker shows, and read exactly
                     the way `matches` reads them — a count taken over a
                     different set from the one the filter runs on is a number
                     that disagrees with the list under it. A count of 0 is still
                     listed: an option that disappears when nothing matches it
                     hides the fact that nothing does. */
                  count:
                    o.value === ''
                      ? drawingItems.length
                      : drawingItems.filter(
                          (it) =>
                            (worstDrawingFit(drawingVerdictsByRow.get(it.id) ?? []) ??
                              'unknown') === o.value
                        ).length,
                })),
                /* The host owns the comparison — `ObjectPicker` never learns what
                   a fit value means. A row that states nothing is `unknown`,
                   which is a real answer and is reachable through its own
                   option. */
                matches: (item: ObjectItem, value: string) => (item.facet ?? 'unknown') === value,
              }]}
              /* THE FILE IMPORT LIVES IN THE LIST — founder, 2026-08-09. The
                 `<input type="file">` itself stays mounted below (off screen) so
                 it is a MECHANISM rather than a control: a file input that only
                 exists while a dialog is open cannot be handed a file by
                 anything that has not opened the dialog first. */
              onAdd={() => importFileRef.current?.click()}
              addLabel="+ open a file…"
              onRemoveItem={(it) => {
                const p = parseDrawingRowId(it.id);
                /* Belt and braces with `ObjectItem.removable`: the shipped rows
                   are `builtIn` so they render no delete control at all, and if
                   one ever did, this refuses rather than deleting nothing and
                   reporting success. */
                if (p?.origin === 'saved') void savedDrawings.remove(p.name);
              }}
              onSave={(it) => {
                const p = parseDrawingRowId(it.id);
                const d = currentDrawing();
                if (p?.origin === 'saved' && d) void savedDrawings.replace(p.name, d);
              }}
              onSaveAs={(_it, _draft, newName) => {
                const d = currentDrawing();
                /* 🔴 SAYS SO rather than doing nothing. Everywhere else in this
                   app "Save as" writes the current SETTINGS, which exist whether
                   or not anything is loaded. A drawing is not a setting: with
                   none loaded there is genuinely nothing to write, and a button
                   that silently succeeds at that is the worst of the three
                   possible behaviours. */
                if (!d) {
                  setDrawingNote('nothing to save — no drawing is loaded');
                  return;
                }
                void savedDrawings.saveAs(newName, d);
              }}
            />
            {/* The mechanism behind `+ open a file…`.
              *
              * Off screen rather than `display: none` so it keeps a box a
              * pointer-less driver can reach; it renders nothing a person can
              * see or click.
              *
              * 🔴 `aria-hidden` + `tabIndex={-1}`, and this is a correction
              * rather than a default: the first version left it exposed, and a
              * failing test's accessibility dump showed the Drawing panel
              * announcing a bare **"Choose File"** button with no name, no
              * context and no relationship to the list it belongs to — a second,
              * worse copy of a control that already exists and is labelled. The
              * affordance is `+ open a file…` INSIDE the list; this element is
              * plumbing it clicks. Hiding plumbing is right; hiding a control
              * would not be, and the difference is that the labelled one works
              * for everybody (a programmatic `.click()` opens the file dialog
              * however the button was reached). */}
            <input
              ref={importFileRef}
              className="offscreen"
              type="file"
              accept=".dxf,.svg,.stl,.obj,.3mf,.step,.stp"
              aria-hidden="true"
              tabIndex={-1}
              data-testid="import-file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                // 🔴 BYTES, not text, and the format decided by CONTENT.
                //
                // `f.text()` decodes as UTF-8 and replaces anything
                // undecodable with U+FFFD SILENTLY. A binary STL put through
                // it loses facets with no error, and a mesh missing facets
                // sections into an outline with a side missing — which still
                // looks like a part. The extension is no better: a binary STL
                // whose 80-byte header starts with "solid" is a real export,
                // and so is one named `part.dxf`. The core decides by
                // measuring the file against 84 + 50*triangles.
                const bytes = new Uint8Array(await f.arrayBuffer());
                // A new file is a new part: any Z chosen for the last one is a
                // decision about a different solid. See `chooseDrawing`.
                setSectionZ(null);
                setImported({
                  instance: mintInstance(f.name, []),
                  bytes,
                  format: 'auto',
                  name: f.name,
                  origin: 'file',
                  offset: [0, 0],
                  rotation: 0,
                });
                setSampleNote('');
              }}
            />
            {meshLoadError ? (
              <p className="bad" data-testid="mesh-load-error">
                {meshLoadError}
              </p>
            ) : null}
            {savedDrawings.note || drawingNote ? (
              <p className="note" data-testid="drawing-note">
                {drawingNote || savedDrawings.note}
              </p>
            ) : null}

            {/*
              🔴 THE SELECTED DRAWINGS, ROW BY ROW — TODO #58, founder
              2026-08-09: *"similar to clamps show the selected Tools (like a
              table, row by row); Drawings (row by row)"*.

              ⚠ It is a table of ONE today, and it is written as a table anyway.
              That is deliberate: #31 (several drawings on one sheet) lengthens
              this array and changes nothing else here, whereas a single-drawing
              note — which is what stood here — would have to be thrown away and
              rebuilt. A one-row table is honest about how many drawings the
              planner can take; it is not pretending there could never be more.

              ⚠ AND THE ROW IS READ-ONLY EXCEPT FOR THE SECTION Z. A clamp row is
              editable because clamp geometry is an operator DECLARATION. Nothing
              about a drawing is: its format is the core's verdict, its features
              are counted by the importer, its placement is `Part X/Y` in the
              Workpiece panel. The section Z is the one exception and it is a
              real one — the core takes it as an ARGUMENT, so typing it here is
              answering a question, not overwriting an answer.
            */}
            <div className="objrows" data-testid="drawing-rows">
              {drawings.length ? (
                drawings.map((d, i) => {
                  const isSel = i === sel;
                  const move = (nx: number, ny: number) =>
                    updateDrawings((ds) =>
                      ds.map((x, j) =>
                        j === i ? { ...x, offset: [nx, ny] as [number, number] } : x
                      )
                    );
                  return (
                    <div
                      key={d.instance}
                      className="objrow"
                      data-testid={`drawing-row-${d.instance}`}
                      data-selected={isSel ? 'true' : 'false'}
                    >
                      <div className="objrow-head">
                        {/*
                          🔴 THE FORMAT PRINTED HERE IS THE CORE'S VERDICT, not
                          this app's request — TODO #48. `shownFormat` carries
                          where the verdict is read from and the one case it
                          cannot answer (DXF vs SVG on the `auto` route). It is
                          shown on the SELECTED row only, because the verdict is
                          read off the report and a report now describes a whole
                          SHEET — printing it on every row would attach one
                          drawing's detected format to another drawing.
                        */}
                        {/* 🔴 `imported-name` on the SELECTED row, `drawing-name-N`
                            on every row. The first is what the panel is TALKING
                            ABOUT — the drawing the Part X/Y fields and the
                            section Z belong to — and it kept its name because
                            five existing assertions mean exactly that by it. It
                            follows the selection rather than index 0, because
                            "the drawing the panel is about" is what it always
                            meant and index 0 only happened to be that while
                            there could be one. */}
                        <span
                          className="objrow-name"
                          data-testid={isSel ? 'imported-name' : `drawing-name-${i}`}
                          data-row={`drawing-name-${i}`}
                        >
                          Cutting <b>{d.instance}</b>
                          {/* The instance IS what the program calls this part, so
                              it is what the row says. The file it came from is
                              printed beside it only when they differ — a copy —
                              because repeating the same string twice on every row
                              teaches people to stop reading it. */}
                          {d.instance !== d.name ? <> · from <b>{d.name}</b></> : null}
                          {isSel && shownFormat ? ` (${shownFormat.toUpperCase()})` : ''}
                        </span>
                        {/* 🔴 SELECTING IS NOT REMOVING AND NOT REORDERING. It
                            says which drawing the viewport drag handle, the Part
                            X/Y fields and the section Z are about. With two parts
                            on a sheet those three controls would otherwise be
                            editing whichever one the code happened to pick, and
                            an operator dragging the handle would move a part they
                            were not looking at. */}
                        <button
                          className="objrow-x"
                          data-testid={`drawing-select-${i}`}
                          aria-pressed={isSel}
                          title="Make this the drawing the Part X/Y fields, the drag handle and the section Z are about."
                          onClick={() => setSelected(i)}
                        >
                          {isSel ? '◉' : '○'}
                        </button>
                        {/*
                          🔴 ADD ANOTHER COPY OF THIS DRAWING — founder
                          2026-08-10: *"Drawing: Able to add more than 1 from the
                          same drawing"*. It is a separate control from the
                          picker on purpose: the picker says WHICH DRAWINGS are
                          in the job and its rows TOGGLE, exactly like the tool
                          picker's, so making one picker's row mean "add another"
                          would give two multi-selects in one app two different
                          meanings for the same gesture.

                          🔴 THE COPY LANDS ON TOP OF THE ORIGINAL, AND THE JOB IS
                          THEN REFUSED. That is a decision, not an oversight, and
                          it is recorded here because the next person will read
                          whichever behaviour they find as intentional. Offsetting
                          the copy automatically would be the SOFTWARE moving a
                          part on its own — the one thing this tool does not do,
                          for the reason `fit` reports a datum shift and refuses
                          to apply one: the clamps do not move with the parts, so
                          a part relocated to be convenient is a part relocated
                          into whatever is holding the work down. The refusal
                          names both copies and says MOVE ONE OF THEM.

                          ⚠ THIS SENTENCE IS WORDED OFF `AGENTS.md`, NOT OFF
                          THE CORE, and that is not style. It read "the clamps
                          stay bolted to the TABLE while the parts do not"; the
                          terminology fix for `table` -> `machine` turned it into
                          a character-for-character 8-gram of the core's own
                          overlap refusal, and `drawing-verdicts.test.ts` caught
                          it on the next run. A retired-term correction can move a
                          comment INTO a copy of a core sentence - the shingle
                          guard sits at 8 words precisely because this lane's
                          doctrine and the core's refusals are made of the same
                          phrases.
                        */}
                        <button
                          className="objrow-x"
                          data-testid={`drawing-copy-${i}`}
                          title="Add another copy of this drawing. It lands ON TOP of this one and the job is refused until you move it — nothing here moves a part for you."
                          onClick={() =>
                            updateDrawings((ds) => {
                              const copy: LoadedDrawing = {
                                ...d,
                                instance: mintInstance(
                                  d.name,
                                  ds.map((x) => x.instance)
                                ),
                              };
                              const out = [...ds];
                              out.splice(i + 1, 0, copy);
                              return out;
                            })
                          }
                        >
                          ⧉
                        </button>
                        <button
                          className="objrow-x"
                          data-testid={i === 0 ? 'clear-import' : `drawing-remove-${i}`}
                          title="Take this drawing out of the job."
                          onClick={() => {
                            updateDrawings((ds) => ds.filter((_, j) => j !== i));
                            updateSelected((k) => (k >= i && k > 0 ? k - 1 : k));
                            setSectionZ(null);
                            setSampleNote('');
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="objrow-facts">
                        {/* The origin, on the row and not only in the list. Once
                            the list is closed, "where did this come from" is
                            exactly the question somebody asks while looking at
                            the program it produced. */}
                        <span data-testid={`drawing-row-origin-${i}`}>
                          {d.origin === 'sample' || d.origin === 'mesh-sample'
                            ? `${SHIPPED_TAG} · measured through the CLI importer`
                            : d.origin === 'saved'
                              ? `${YOURS_TAG} · saved in this browser, never measured`
                              : 'FROM DISK · not saved, and this app does not keep it — it cannot come back after a refresh'}
                        </span>
                        <span data-testid={`drawing-row-kind-${i}`}>
                          {d.format === 'stl'
                            ? '3D solid — the machine cuts ONE flat section of it'
                            : '2D drawing — the outline is what the machine cuts'}
                        </span>
                      </div>
                      {/*
                        🔴 THE CORE'S VERDICT FOR **THIS INSTANCE** — one row,
                        one answer, no aggregation. The picker above has to
                        summarise (a catalogue row can be on the table several
                        times); here the row IS the instance the planner names,
                        so the sentence is the one a refusal would carry, printed
                        verbatim beside the part it condemns.

                        🔴 TWO LINES, NOT ONE, AND THEY ARE NOT THE SAME
                        QUESTION. `usability` is *can this be cut at all* — the
                        planner refuses the workpiece and emits zero bytes.
                        `fit` is *does this belong on the declared material* —
                        and the planner does NOT refuse it: it posts, and the
                        cutter goes where the material is not. Painting the
                        second as an invalidation would claim a refusal that
                        never happens; leaving it out would hide a cutter
                        travelling off the board. So: two lines, two tones.

                        ⚠ ABSENT IS "NOT ASKED", NEVER "FINE". A report that has
                        not caught up with this list produces no verdict at all
                        (see `splitDrawingParts`), and that state is printed.
                      */}
                      {(() => {
                        const v = drawingVerdictById.get(d.instance);
                        const askFailed =
                          drawingVerdictsResult && !drawingVerdictsResult.ok
                            ? drawingVerdictsResult.why
                            : '';
                        if (!v)
                          return (
                            <p
                              className="note"
                              data-testid={`drawing-row-verdict-${i}`}
                              data-usability="not-asked"
                            >
                              {drawingUsabilityMark(undefined)}
                              {askFailed ? ` — ${askFailed}` : ''}
                            </p>
                          );
                        return (
                          <>
                            <p
                              className={v.usability === 'invalidates' ? 'bad' : 'note'}
                              data-testid={`drawing-row-verdict-${i}`}
                              data-usability={v.usability}
                            >
                              {drawingUsabilityMark(v)}
                              {v.why ? ` — ${v.why}` : ''}
                            </p>
                            <p
                              className="note"
                              data-testid={`drawing-row-fit-${i}`}
                              data-fit={v.fit}
                            >
                              {drawingFitMark(v)}
                              {v.why_fit ? ` — ${v.why_fit}` : ''}
                            </p>
                          </>
                        );
                      })()}
                      {/*
                        🔴 THE PLACEMENT, PER ROW — founder 2026-08-10: *"I should
                        able to rotate the drawings"*.

                        These three are the only editable cells on a drawing row,
                        and they are editable for exactly the reason the section Z
                        is: they are an operator DECLARATION the core takes as
                        input, not a value the core derived. Everything else on
                        this row is the core's answer and stays read-only.

                        🔴 The offset is a DELTA from where the drawing was drawn,
                        in SHEET millimetres — so 0,0 is as drawn, and turning the
                        board carries the part round with it. It is NOT the datum:
                        `Origin X/Y` moves the SHEET on the bed and takes the
                        clamps' and the touch plate's relationship to the work
                        with it.

                        🔴 The turn is applied to the GEOMETRY THE PROGRAM IS CUT
                        FROM, not to the picture. A part drawn turned whose
                        toolpath is planned unturned cuts the wrong shape, and the
                        picture is the half that looks right — this is gate P7R's
                        lesson one object along. Gate MULTI asserts the quarter
                        turn on the EMITTED PROGRAM.

                        ⚠ Any angle is allowed here, unlike the sheet's four
                        quarter turns, and the difference is real: a sheet is
                        registered against the machine's axes and a part is not.
                        The core PLANS a free angle and WARNS that it cannot be
                        registered; refusing it here would discard a placement the
                        core accepts.
                      */}
                      {/* 🔴 `place`, NOT `row` — and this is the founder's
                          *"the X/Y/rotation inputs are clipped off the panel"*.
                          `.row` is a plain `display:flex` with no wrap, and
                          three label+input+unit fields do not fit a 290px
                          column: measured 2026-08-10 on the running app, the
                          list was 250px wide and 517px of content, with `Turn`
                          starting at x=407 — off the panel, reachable only by
                          horizontally scrolling the whole sidebar.

                          These are machining numbers an operator TYPES, so the
                          fix is not to shrink them. `.place` wraps them into as
                          many columns as the panel can hold at a legible input
                          width, so it fits at 290px and uses the room at any
                          wider one. */}
                      <div className="place" data-testid={`drawing-place-${i}`}>
                        <label className="field">
                          <span>Offset X</span>
                          <span className="numwrap">
                            <input
                              type="number"
                              step={displayStep(1, unit)}
                              data-testid={`drawing-x-${i}`}
                              value={toDisplay(d.offset[0], unit)}
                              onChange={(e) => move(fromDisplay(Number(e.target.value), unit), d.offset[1])}
                            />
                            {/* TODO #109. Not a `Num` because this pair writes
                                BOTH axes through one `move()` call, so it has no
                                single-value `onChange` to hand over. The unit
                                treatment is the same one, kept identical
                                deliberately: display converted, entry converted
                                once, the symbol on the number. */}
                            <em>{UNIT_SYMBOL[unit]}</em>
                          </span>
                        </label>
                        <label className="field">
                          <span>Offset Y</span>
                          <span className="numwrap">
                            <input
                              type="number"
                              step={displayStep(1, unit)}
                              data-testid={`drawing-y-${i}`}
                              value={toDisplay(d.offset[1], unit)}
                              onChange={(e) => move(d.offset[0], fromDisplay(Number(e.target.value), unit))}
                            />
                            <em>{UNIT_SYMBOL[unit]}</em>
                          </span>
                        </label>
                        <label className="field">
                          <span>Turn</span>
                          <span className="numwrap">
                            <input
                              type="number"
                              step={90}
                              data-testid={`drawing-rot-${i}`}
                              value={d.rotation}
                              onChange={(e) =>
                                updateDrawings((ds) =>
                                  ds.map((x, j) =>
                                    j === i ? { ...x, rotation: Number(e.target.value) } : x
                                  )
                                )
                              }
                            />
                            <em>deg</em>
                          </span>
                        </label>
                      </div>
                      {d.rotation % 90 !== 0 ? (
                        <p className="warn" data-testid={`drawing-rot-note-${i}`}>
                          <b>{d.rotation}°</b> is not a quarter turn. It plans and it cuts, but the
                          part cannot be registered against the machine&apos;s own axes, so the
                          whole part inherits whatever angle it actually ends up at.
                        </p>
                      ) : null}
                      {/* The section Z, and the only place the app admits it is a
                          choice. Shown on the SELECTED row only, and only once a
                          mesh is actually loaded: `loaded_mesh` is ONE solid, and
                          the core declines to carry it at all for a sheet holding
                          several — a viewport showing one solid over a program
                          that cuts several sections is a picture disagreeing with
                          the program. The core says so in a note. */}
                      {isSel && loadedMesh ? (
                        <>
                          <div className="row" data-testid="section-z-row">
                            <label className="field">
                              <span>Section Z</span>
                              <span className="numwrap">
                                <input
                                  type="number"
                                  step={displayStep(0.5, unit)}
                                  data-testid="section-z"
                                  /* TODO #109. `sectionZ ?? section_z_mm` is the
                                     "not chosen yet" fallback and it is a
                                     MILLIMETRE either way, so the conversion sits
                                     outside the `??` — converting one arm and not
                                     the other would show the core's chosen Z in a
                                     different unit from the operator's. */
                                  value={toDisplay(sectionZ ?? loadedMesh.section_z_mm, unit)}
                                  onChange={(e) => setSectionZ(fromDisplay(Number(e.target.value), unit))}
                                />
                                <em>{UNIT_SYMBOL[unit]}</em>
                              </span>
                            </label>
                            {sectionZ !== null ? (
                              <button
                                data-testid="section-z-reset"
                                title="Hand the choice back to the core, which sections at mid-height and says so."
                                onClick={() => setSectionZ(null)}
                              >
                                Let it choose
                              </button>
                            ) : null}
                          </div>
                          <p
                            className={sectionZ === null ? 'warn' : 'note'}
                            data-testid="section-z-note"
                          >
                            {sectionZ === null ? (
                              <>
                                Sectioned at <b>z = {L(loadedMesh.section_z_mm)}</b>,{' '}
                                <b>CHOSEN FOR YOU</b> — the mid-height of the solid, which is a
                                guess about your intent and not a reading of your model. The machine
                                cuts that one flat slice; the solid on screen is the <b>input</b>.
                              </>
                            ) : (
                              <>
                                Sectioned at <b>z = {L(loadedMesh.section_z_mm)}</b>,
                                which you chose. The machine cuts that one flat slice; the solid on
                                screen is the <b>input</b>.
                              </>
                            )}
                          </p>
                        </>
                      ) : null}
                      {isSel && sampleNote ? (
                        <p className="note" data-testid="sample-note">
                          {sampleNote}
                        </p>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="note">
                  No drawing in the job. DXF (LINE, LWPOLYLINE, ARC, CIRCLE, POLYLINE) or SVG
                  (rect, circle, polygon, path) or a binary STL, from the list above or your own
                  file. Anything the importer cannot read is listed in the notes rather than
                  skipped — a dropped entity is a part cut without a feature.
                </p>
              )}
            </div>
            {/* 🔴 THE ASK FAILED, SAID SO. Every row above falls back to NOT
                ASKED, and NOT ASKED is not usable. A silent failure here would
                leave a list with no marks at all, which reads as a list where
                nothing invalidates the workpiece. */}
            {drawings.length && drawingVerdictsResult && !drawingVerdictsResult.ok ? (
              <p className="bad" data-testid="drawing-verdicts-failed">
                The core did not judge these drawings against this workpiece, so every row above is
                NOT ASKED rather than cleared: {drawingVerdictsResult.why}
              </p>
            ) : null}
            {/* 🔴 THE SETUP MOVED AND THE ANSWER HAS NOT CAUGHT UP — said, rather
                than left to be inferred from marks that quietly went blank. This
                is the state {@link answerFor} produces, and it is short: the ask
                is a wasm call. It is announced because the *"available on
                selected workpiece"* filter runs on these verdicts, so an
                unannounced pending state is a list narrowing by an answer that
                does not exist yet — a filter swallowing its own reason, which is
                the failure this lane records as *filtering the selection before
                announcing status*. */}
            {drawings.length && ready && !drawingVerdictsResult ? (
              <p className="pending" data-testid="drawing-verdicts-pending">
                The workpiece, the cutters or the list changed and nothing has been judged against
                the NEW setup yet, so every row above reads NOT ASKED. That is a waiting state, not
                a clear one — and the filter above narrows on it, so it is showing what is unjudged
                rather than what fits.
              </p>
            ) : null}
            {/* The core's own caveats about the three mistakes a drawing list is
                most likely to make — merging `usability` with `fit`, rendering
                `unknown` as usable, and expecting `selected` from the core.
                Shown, not rewritten. */}
            {drawings.length && drawingVerdictsResult?.ok && drawingVerdictsResult.caveats.length ? (
              <ul className="notes" data-testid="drawing-verdict-caveats">
                {drawingVerdictsResult.caveats.map((c, i) => (
                  <li key={`dvc${i}`}>{c}</li>
                ))}
              </ul>
            ) : null}
            {drawings.length && drawingVerdictsResult?.ok && drawingVerdictsResult.notes.length ? (
              <ul className="notes" data-testid="drawing-verdict-notes">
                {drawingVerdictsResult.notes.map((n, i) => (
                  <li key={`dvn${i}`}>{n}</li>
                ))}
              </ul>
            ) : null}
          </Section>

          <Section
            title="Work holding"
            testid="panel-clamps"
            eye={sectionEye('panel-clamps', 'Work holding')}
            layerRows={sectionLayerRows('panel-clamps', 'Work holding')}
          >
            {/* 🔴 THE RESEARCHED WORK-HOLDING CATALOGUE (TODO #34), reachable
                for the first time. 19 entries, 18 with a vendor URL and the date
                the page was read; the schematic beside each is drawn to scale
                from the SAME numbers, so a picture and a keepout cannot disagree.

                ⚠ THAT LAST CLAUSE WAS FALSE FOR AS LONG AS IT WAS WRITTEN, and
                is true only since 2026-08-27. `workholdingShape.tsx` carried a
                SECOND hand-keyed copy of every entry's height and footprint.
                Measured by parsing both tables: 19 ids each side, three
                disagreed — and the worst was `machinable-low-profile-clamp`,
                catalogue [25.4, 18.0] against drawing [18, 25.4], **the axes
                transposed on a steel clamp at 43 RC**. The `aria-label` on this
                very row prints the catalogue pair, so the caption and the
                picture beside it contradicted each other inside one control.
                The drawing now DERIVES from the catalogue (`shapeFor`), and
                `web/tests/workholding-drawing.test.ts` is what keeps it that
                way — a second table can grow back, and this sentence asserting
                it had not is the thing that let it. Kept and corrected rather
                than rewritten: the sentence is the evidence.

                🔴 AND THE UNIFICATION PICKED THE WRONG BRANCH — settled
                2026-08-31 by `bom` against the raw vendor table. Making the
                drawing derive from the catalogue removed the DISAGREEMENT
                without answering the QUESTION, and defaulted to the side that
                happened to be the data table: [25.4, 18.0], which is
                transposed. 18.0 mm runs across the clamped edge, 25.4 along it
                — the drawing had been right all along. Corrected in
                `workholding.ts`, and the drawing followed in the same edit
                because it derives. ⚠ Two tables agreeing is not two tables
                being right, and a merge is a ruling even when nobody notices
                making it.

                The height and footprint here are what gate P7 checks a toolpath
                against, so they are the difference between a measured safety
                margin and an invented one — and the invented one renders exactly
                the same. Choosing an entry declares NOTHING; it arms the Add
                button below with real dimensions. */}
            <ObjectPicker
              label="Hold-down"
              testid="workholding-picker"
              mode="multi"
              placeholder="choose a hold-down…"
              searchPlaceholder="toggle, cam, vacuum, tape, dog…"
              items={[...WORKHOLDING.map((w) => {
                const [fw, fh] = w.footprintMm;
                const noFootprint = fw <= 0 || fh <= 0;
                const inv = workholdingInv.row(w.id);
                return {
                  id: w.id,
                  name: w.name,
                  /* TODO #60 — the plan + side schematic, at a size where the
                   * under-arm clearance and the keepout are legible. Its own
                   * `aria-label` names both views and the height above the
                   * spoilboard;
                   * the visible caption below repeats the two numbers that
                   * decide whether it can hold this stock at all, taken from the
                   * same fields the drawing uses. */
                  shape: {
                    node: <WorkholdingShape id={w.id} />,
                    label: noFootprint
                      ? `Plan and side view of ${w.name}, ${L(w.heightMm)} above the spoilboard. It publishes NO footprint, so no keepout is drawn.`
                      : `Plan and side view of ${w.name}: ${L2(fw, fh)} on the spoilboard, ${L(w.heightMm)} tall. The dashed outline is the keepout gate P7 checks a toolpath against.`,
                  },
                  detail: (() => {
                    const facts = noFootprint
                      ? 'takes no area — there is nothing to declare as a keepout'
                      : `${L(w.heightMm)} tall · ${L2(fw, fh)} footprint`;
                    return inv ? withTag(inv.tags.join(' · '), facts) : facts;
                  })(),
                  /* 🔴 NOT disabled FOR A MISSING FOOTPRINT, deliberately, and
                     this is rule 1 of the picker doing real work. A hold-down
                     with no published footprint is exactly the one an operator
                     most needs to READ — "we cannot declare a keepout for this"
                     is a fact about our data, not a verdict that the thing is
                     unusable. Hiding or greying it would say the opposite. The
                     Add button below is what refuses, with the reason.

                     ⚠ OWNERSHIP is a different question and DOES disable, on
                     `not-held` and `unresolved` only — never on `unchecked`,
                     which is every row in every shop today. Declaring a clamp
                     the inventory says is not in the building puts a keepout on
                     the bed for a thing that is not on the bed, and gate P7
                     then checks the toolpath against fiction. */
                  disabled: inv?.disabled,
                  disabledReason: inv?.disabledReason,
                  /* 🔴 TODO #105, AND THIS IS THE ONE THAT LANDS NEAREST TO AN
                     ATTESTATION. `Fixturing::confirmed_clear` says somebody
                     LOOKED AT THE BED today — it is deliberately never restored
                     and it is asked again every session. Owning a clamp is not
                     the bed being clear, this control writes only the inventory
                     document, and the note on it says both out loud rather than
                     leaving the proximity to be read as a connection. */
                  claim: ownershipClaim('workholding', workholdingInv.heldInKind, inv, workholdingIds.includes(w.id)),
                  properties: [
                    ...(inv ? ownershipProps(inv) : []),
                    { label: 'Height above the spoilboard', value: L(w.heightMm) },
                    {
                      label: 'Keepout footprint',
                      value: noFootprint ? 'none published' : L2(fw, fh),
                    },
                    {
                      label: 'In the toolpath’s way',
                      value: w.obstructs
                        ? 'yes — P7 refuses a path that crosses it'
                        : 'no — but see the notes: this flag is coarser than the truth',
                    },
                    {
                      label: 'Resists',
                      value: w.resists.length ? w.resists.join(' + ') : 'nothing by itself',
                    },
                    {
                      label: 'Sourced',
                      value: w.source
                        /* 'not every number is read from the cited page' rather
                         * than 'some fields are stand-ins': a stand-in is one of
                         * TWO things `generic` covers, and naming only that one
                         * sends the reader hunting an obviously invented figure.
                         * In the other kind every number is the vendor's and it
                         * is their MEANING that was inferred — nothing looks
                         * invented, so the scan comes back clean over the real
                         * risk. See the `generic` note in `workholding.ts`. */
                        ? `${w.generic ? 'partly — not every number is read from the cited page' : 'yes'}, read ${w.source.read}`
                        : 'NO — generic, nothing published',
                    },
                    ...(w.source ? [{ label: 'Source', value: w.source.url }] : []),
                    { label: 'Why it is listed', value: w.detail },
                    { label: 'Notes', value: w.notes },
                  ],
                };
              }),
              /* Hold-downs the inventory names and this build has no entry for.
                 Listed and unselectable: without the catalogue's height and
                 footprint there is nothing to declare as a keepout, and a clamp
                 declared without them is the invented-geometry defect again. */
              ...workholdingInv.extras,
              ]}
              selectedIds={workholdingIds}
              onChange={(ids) => setWorkholdingIds(ids)}
            />
            {inventorySource('workholding', workholdingInv.view)}
            {(() => {
              const why = workholdingIds.length > 0
                ? workholdingIds.map((id) => inventoryRefusal('workholding', id, workholdingCatalogueRows)).filter(Boolean).join('; ')
                : null;
              return why ? (
                <p className="bad" data-testid="workholding-inventory-refused">
                  {why}
                </p>
              ) : null;
            })()}
            <div className="clamps" data-testid="clamp-list">
              {clamps.map((c, i) => (
                <div className="clamp" key={i}>
                  <input
                    value={c.name}
                    onChange={(e) =>
                      setClamps(clamps.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)))
                    }
                  />
                  {(['x', 'y', 'w', 'h', 'height_mm'] as const).map((k) => (
                    <input
                      key={k}
                      type="number"
                      title={k}
                      value={c[k]}
                      data-testid={`clamp-${i}-${k}`}
                      onChange={(e) =>
                        setClamps(
                          clamps.map((x, j) => (i === j ? { ...x, [k]: Number(e.target.value) } : x))
                        )
                      }
                    />
                  ))}
                  <button onClick={() => { pushSnapshot(); setClamps(clamps.filter((_, j) => j !== i)); }}>✕</button>
                </div>
              ))}
            </div>
            {/* ONE button, and what it places depends on what is chosen above.
                🔴 With nothing chosen it still places today's generic
                40 x 40 x 35mm clamp — the app's existing behaviour, unchanged,
                because removing the manual route would take away the only way to
                declare a hold-down this catalogue does not have. What it no
                longer does is put those invented numbers on screen with a
                researched entry's NAME next to them. */}
            {(() => {
              const chosen = workholdingIds.length > 0
                ? WORKHOLDING.find((w) => w.id === workholdingIds[workholdingIds.length - 1]) ?? null
                : null;
              const [fw, fh] = chosen?.footprintMm ?? [0, 0];
              const noFootprint = !!chosen && (fw <= 0 || fh <= 0);
              return (
                <>
                  <button
                    className="add"
                    data-testid="add-clamp"
                    disabled={noFootprint}
                    title={
                      chosen
                        ? noFootprint
                          ? 'This entry publishes no footprint, so there is no keepout to declare.'
                          : `Places one ${chosen.name} at 0,0 with its catalogue height and footprint.`
                        : 'Places a generic 40 x 40 x 35mm clamp. Choose a hold-down above to place a researched one instead.'
                    }
                    onClick={() =>
                      setClamps([
                        ...clamps,
                        chosen && !noFootprint
                          ? {
                              // The catalogue's OWN numbers, not a rounding of
                              // them: `heightMm` is what P7 compares safe Z
                              // against, and 42.4 is not 42.
                              name: `${chosen.id}-${clamps.length + 1}`,
                              x: 0,
                              y: 0,
                              w: fw,
                              h: fh,
                              height_mm: chosen.heightMm,
                            }
                          : {
                              name: `clamp-${clamps.length + 1}`,
                              x: 0,
                              y: 0,
                              w: 40,
                              h: 40,
                              height_mm: 35,
                            },
                      ])
                    }
                  >
                    {chosen ? `+ Add ${chosen.name}` : '+ Add clamp'}
                  </button>
                  {noFootprint ? (
                    <p className="warn" data-testid="workholding-no-footprint">
                      {chosen!.name} publishes no footprint, so there is nothing to declare
                      as a keepout — and that is <em>not</em> the same as it being out of the
                      way. Nothing here can check a hold-down whose size we do not know.
                    </p>
                  ) : null}
                  {chosen && !noFootprint && !chosen.obstructs ? (
                    <p className="note" data-testid="workholding-flat">
                      This entry is recorded as not obstructing. It is still declared as a
                      keepout, because <code>obstructs</code> is a boolean over a fact that is
                      not one — see its notes above.
                    </p>
                  ) : null}
                  {/* TODO #68 — workholding validation: does the chosen hold-down
                      actually resist the forces this cutter applies?
                      `resists` is the catalogue's answer; `flute_type` is the
                      tool's. An up-cut cutter pulls the part upward; if the
                      workholding only resists lateral, the part is free to lift.
                      This is a WARNING, not a refusal — the operator may have
                      reasons the catalogue cannot see (tape, onion skin, tabs). */}
                  {chosen && selectedTool?.flute_type === 'up-cut' && !chosen.resists.includes('lift') ? (
                    <p className="warn" data-testid="workholding-lift-risk">
                      Up-cut cutter with {chosen.name} — this hold-down does not resist lift.
                      An up-cut pulls the workpiece upward; if it is not held down, the part
                      can come loose during the cut. Consider a down-cut, tape, or a hold-down
                      that resists lift.
                    </p>
                  ) : null}
                </>
              );
            })()}
            <label className="check">
              <input
                type="checkbox"
                checked={confirmedClear}
                onChange={(e) => setConfirmedClear(e.target.checked)}
                data-testid="confirmed-clear"
              />
              I have checked the machine is clear
            </label>
            <p className="note">
              No clamps declared is <em>not</em> the same as a machine confirmed clear. Only the checkbox
              above says anyone looked.
            </p>
          </Section>

          <Section
            title="Tooling"
            testid="panel-tools"
            eye={sectionEye('panel-tools', 'Tooling')}
            layerRows={sectionLayerRows('panel-tools', 'Tooling')}
          >
            {/*
              🔴 The Category dropdown is GONE — founder, 2026-08-08. It was a
              filter in front of a list, which is the shape this app has been
              removing all night: it hid tools by a property, so a tool you could
              not see was indistinguishable from a tool that did not exist. The
              category now travels WITH each tool, in its detail line and its
              properties, and the search matches it.
            */}

            {/*
              🔴 Every property below is the CORE's answer, passed through
              verbatim. The fit verdict, its reason and the chipload window are
              computed in Rust where a gate can see them. Describing a tool here
              would be the third time this app re-derived a machining fact in
              TypeScript.
            */}
            <ObjectPicker
              label="Tool"
              testid="tool-picker"
              mode="multi"
              items={[...(lib?.tools ?? []).map(  (t: ToolRow) => {
                /* TWO ANSWERS FROM TWO MODULES, AND THEY DO NOT MERGE.
                 * `inv` is *do you own it* (TODO #83) — it decides the tags and
                 * whether the row can be chosen. `v` is *does it work here and
                 * does this drawing want it* (TODO #66) — it decides the red
                 * mark and the filter. A cutter can be owned and useless, or
                 * unowned and perfect for the job, and one word for both would
                 * hide whichever half the operator needed. */
                const inv = toolInv.row(t.id);
                const v = verdictById.get(t.id);
                return {
                id: t.id,
                /* 🔴 THE DRAWING, ON THE PROPERTY PANEL AND NOWHERE ELSE — TODO
                 * #60, and the row copy removed 2026-08-10 (founder).
                 *
                 * A to-scale schematic, not a product photo. Manufacturer images
                 * are copyrighted and this lane is AGPL — and a photo of a shiny
                 * bit hides the three facts that matter here anyway: diameter
                 * against shank, flute length, and which way the flutes spiral.
                 *
                 * `ToolShape` already had a `'pane'` frame and nothing had ever
                 * asked for it, so the drawing existed only at 22x24px in a list
                 * row — the size at which a shank step and a flute length are
                 * exactly the facts you cannot see. That row copy is now gone
                 * rather than kept alongside: a drawing too small to read its own
                 * subject is decoration wearing the clothes of evidence.
                 *
                 * The label is `describeToolShape().title`, which is the SAME
                 * function the svg's own `aria-label` comes from and is composed
                 * from the fields the drawing is drawn from. A caption written
                 * separately would be a second description that drifts. */
                shape: { node: <ToolShape tool={t} size="pane" />, label: describeToolShape(t).title },
                // The category is part of the searchable text, not a filter in
                // front of the list. Typing "drill" or "v-bit" narrows to them.
                name: `${t.id} · ${t.category}`,
                /* THE ROW, FRONT TO BACK: what you own · whether it works here ·
                 * what it is. The red mark carries the CORE's sentence with it
                 * — `v.why` verbatim — because that is the sentence the planner
                 * refuses the whole job with, and an operator reading "it does
                 * not work" without it has to guess which of the four rules
                 * fired. */
                detail: (() => {
                  const facts =
                    t.fit && t.fit !== 'fitted'
                      ? t.fit_why
                      : `${t.category} · ${L(t.diameter_mm)} · ${t.flutes} flute${t.flutes === 1 ? '' : 's'}`;
                  const mark =
                    v && v.usability !== 'usable' ? `${usabilityMark(v)}${v.why ? ` — ${v.why}` : ''}` : '';
                  return [inv ? inv.tags.join(' · ') : '', mark, facts]
                    .filter((s) => s)
                    .join(' · ');
                })(),
                /* 🔴 `usability` IS NOT ALLOWED TO DISABLE A ROW, and that is a
                 * decision rather than an omission. `invalidates` is exactly the
                 * row the operator most needs to reach and read — it is why the
                 * job will be refused — and a control they cannot select is one
                 * they cannot inspect the setup against. What disables is the
                 * CORE's collet verdict (`selectable`) and the OWNERSHIP verdict,
                 * both of which are facts about the cutter rather than about
                 * today's drawing. Both reasons ride in `blockFor`'s two labelled
                 * clauses when both apply. */
                disabled: inv ? inv.disabled : t.selectable === false,
                disabledReason: inv ? inv.disabledReason : t.fit_why,
                /* The ADVICE value the filter narrows on — never `usability`.
                 * `undefined` when the core has not answered, which the facet
                 * offers as its own option rather than dropping. */
                facet: v?.advice,
                /* TODO #105. ⚠ THE TWO REASONS A CUTTER ROW CAN BE BLOCKED STAY
                   APART HERE TOO: this control answers *is it in my shop*, and
                   the collet verdict beside it answers *does it fit this
                   spindle*. One sends somebody to a purchase order and the other
                   to the drawer, and `blockFor` prints both when both apply. */
                claim: ownershipClaim('tool', toolInv.heldInKind, inv, toolIds.includes(t.id)),
                properties: [
                  ...(inv ? ownershipProps(inv) : []),
                  ...verdictProps(v),
                  ...(colletDisagreement(t, v)
                    ? [{ label: '⚠ The two collet answers disagree', value: COLLET_DISAGREEMENT_WHY }]
                    : []),
                  { label: 'Category', value: t.category },
                  { label: 'Diameter', value: L(t.diameter_mm) },
                  { label: 'Flutes', value: t.flutes },
                  { label: 'Shank', value: L(t.shank_mm) },
                  { label: 'Cutting length', value: L(t.cutting_length_mm) },
                  { label: 'Chipload', value: `${L(t.chipload_min_mm)}–${L(t.chipload_max_mm)}` },
                  { label: 'Rpm', value: `${t.rpm_min}–${t.rpm_max}` },
                  {
                    label: 'Fit',
                    /* Read off `fit`, the four-valued verdict, NOT off
                       `fit_why || '…'`. `fit_why` is deliberately the empty
                       string for `Fitted`, and BOTH fields are optional on the
                       wire — so the `||` could not tell "the core says it fits"
                       from "this core never answered", and rendered the reassuring
                       one for both. Same fix as the tool row below. */
                    value:
                      t.fit === undefined
                        ? 'this core did not answer — UNCHECKED'
                        : t.fit === 'fitted'
                          ? 'fits the collet in the spindle'
                          : t.fit_why || t.fit,
                  },
                ],
                };
              }),
              /* Cutters the inventory names and this library does not hold.
                 Listed because a shop that owns one needs to see that this build
                 cannot plan with it; unselectable because none of its numbers —
                 diameter, flutes, cutting length, chipload — are here, and the
                 core substitutes a Ø6mm end mill for an id it cannot find. */
              ...toolInv.extras,
              ]}
              selectedIds={toolIds}
              onChange={(ids) => { pushSnapshot(); setToolIds(ids); }}
              /* 🔴 THE FILTER IS ON `advice` AND NEVER ON `usability` — TODO
                 #66, and the distinction is the safety half of the founder's
                 request. Hiding the `invalidates` rows would hide exactly the
                 rows an operator most needs to see, which is rule 1 of this
                 picker turned against the person using it. `advice` answers a
                 different question — does THIS DRAWING want the cutter — and
                 narrowing by it hides nothing about whether a cutter is safe.

                 It is OPT-IN (`''` = every cutter) and the picker states what it
                 hid, attributed: "N hidden by the Recommendation filter". On
                 screen a hidden item and a non-existent item are identical, and
                 in a machining tool that difference decides whether somebody
                 walks to the drawer or concludes the cutter does not exist. */
              /* 🔴 A LIST SINCE 2026-08-11. *Selected* and *recommended* are
                 INDEPENDENT AXES — a tool can be selected and not recommended,
                 which is exactly the case an operator most wants to look at — so
                 the built-in Selected facet had to AND with this one, never
                 replace it. */
              facets={[{
                label: 'Recommendation',
                value: adviceFilter,
                onChange: setAdviceFilter,
                options: ADVICE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                  /* Counted over EVERY row this picker shows — the library AND
                     the inventory-only rows, which state no advice and are
                     therefore `unknown`, exactly as `matches` reads them. A
                     count taken over a different set from the one the filter
                     runs on is a number that disagrees with the list under it.
                     A count of 0 is still listed: an option that disappears
                     when nothing matches it hides the fact that nothing does. */
                  count:
                    o.value === ''
                      ? (lib?.tools ?? []).length + toolInv.extras.length
                      : (lib?.tools ?? []).filter(
                            (t: ToolRow) => (verdictById.get(t.id)?.advice ?? 'unknown') === o.value
                        ).length + (o.value === 'unknown' ? toolInv.extras.length : 0),
                })),
                /* The host owns the comparison — `ObjectPicker` never learns what
                   an advice value means. A row that states nothing is `unknown`,
                   which is a real answer and is reachable through its own
                   option. */
                matches: (item: ObjectItem, value: string) => (item.facet ?? 'unknown') === value,
              }]}
              /* 🔴 THE TOOL FILE'S CONTROLS ARE IN THE LIST — TODO #55, founder
                 2026-08-09: *"tooling, remove the Export tools, Choose File
                 (new) from the left navbar, put this functionality into the
                 list"*. Tooling was the last panel still carrying its own file
                 controls; machines, workpieces and drawings had already made
                 this move. The `<input type="file">` itself stays mounted below
                 and off screen, for the same reason the drawing import does. */
              onAdd={() => importToolsRef.current?.click()}
              addLabel="+ import a tool file…"
              actions={
                <button
                  type="button"
                  data-testid="export-tools"
                  title="Write this library as JSON, in the same shape the importer accepts."
                  onClick={() => {
                    // Exported in the SAME shape the importer accepts, so a
                    // round-trip is a round-trip rather than two formats that
                    // happen to look alike.
                    const rows = (lib?.tools ?? []).map(  (t: ToolRow) => ({
                      id: t.id,
                      category: t.category,
                      diameter_mm: t.diameter_mm,
                      flutes: t.flutes,
                      shank_mm: t.shank_mm,
                      cutting_length_mm: t.cutting_length_mm,
                      chipload_mm: t.chipload_mm,
                      chipload_min_mm: t.chipload_min_mm,
                      chipload_max_mm: t.chipload_max_mm,
                      rpm_min: t.rpm_min,
                      rpm_max: t.rpm_max,
                      included_angle_deg: t.included_angle_deg,
                      point_angle_deg: t.point_angle_deg,
                    }));
                    const blob = new Blob([JSON.stringify(rows, null, 2)], {
                      type: 'application/json',
                    });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'tool-library.json';
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  Export tools
                </button>
              }
            />
            {/* The mechanism behind `+ import a tool file…`. See the drawing
                import above for why it is mounted rather than rendered in the
                dialog, and why it is hidden from assistive tech rather than
                left to announce itself as a nameless second control. */}
            <input
              ref={importToolsRef}
              className="offscreen"
              type="file"
              accept=".json"
              aria-hidden="true"
              tabIndex={-1}
              data-testid="import-tools"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const rows = JSON.parse(await f.text());
                  setExtraTools(Array.isArray(rows) ? rows : [rows]);
                } catch (err) {
                  // Surfaced, never swallowed: a tool file that failed to
                  // parse must not leave the user believing it loaded.
                  setExtraTools(null);
                  alert(`tool file rejected: ${err}`);
                }
              }}
            />
            {inventorySource('tool', toolInv.view)}
            {(() => {
              /* 🔴 EVERY SELECTED CUTTER IS RESOLVED, NOT JUST THE FIRST. A set
                 whose second tool the inventory dropped is a set that plans one
                 operation against kit the shop does not have, and reporting only
                 `toolIds[0]` is the `toolcard` defect #58 removed. */
              const refusals = toolIds
                .map((id) => inventoryRefusal('tool', id, toolCatalogueRows))
                .filter((w): w is string => !!w);
              return refusals.length ? (
                <p className="bad" data-testid="tool-inventory-refused">
                  {refusals.join(' ')}
                </p>
              ) : null;
            })()}
            {/* 🔴 THE ASK FAILED, SAID SO. Every row falls back to UNKNOWN, and
                UNKNOWN is not usable — see `usabilityMark`. A silent failure
                here would leave a list with no marks at all, which reads as a
                list where nothing invalidates the job. */}
            {verdicts && !verdicts.ok ? (
              <p className="bad" data-testid="tool-verdicts-failed">
                The core could not judge these cutters against this setup, so every row above is
                UNKNOWN rather than cleared: {verdicts.why}
              </p>
            ) : null}
            {/* The core's own caveats about the two mistakes a tool list is most
                likely to make — merging the two verdicts, and rendering
                `unknown` as usable. Shown, not rewritten. */}
            {verdicts?.ok && verdicts.caveats.length ? (
              <ul className="notes" data-testid="tool-verdict-caveats">
                {verdicts.caveats.map((c, i) => (
                  <li key={`vc${i}`}>{c}</li>
                ))}
              </ul>
            ) : null}
            {verdicts?.ok && verdicts.notes.length ? (
              <ul className="notes" data-testid="tool-verdict-notes">
                {verdicts.notes.map((n, i) => (
                  <li key={`vn${i}`}>{n}</li>
                ))}
              </ul>
            ) : null}
            {/* 🔴 WHAT THE VERDICTS WERE JUDGED AGAINST, ECHOED. A verdict quoted
                without its setup is a verdict about a machine the reader has to
                guess at — and `null` on any field is why the matching rule came
                back `unchecked` rather than passed. */}
            {verdicts?.ok ? (
              <p className="note" data-testid="tool-verdict-setup">
                Judged against: {verdicts.setup.machine_declared ? 'this machine' : 'NO machine declared'}
                {' · collet '}
                {verdicts.setup.collet_mm === null ? 'NOT DECLARED' : L(verdicts.setup.collet_mm)}
                {' · workpiece '}
                {verdicts.setup.stock_thickness_mm === null
                  ? 'NOT DECLARED — so reach is UNCHECKED, not passed'
                  : `${L(verdicts.setup.stock_thickness_mm)} thick`}
                {' · material '}
                {verdicts.setup.material === null
                  ? 'NOT DECLARED — so the rpm rule is UNCHECKED'
                  : verdicts.setup.material}
                {' · '}
                {verdicts.setup.parts === 0
                  ? 'NO drawing sent, so every recommendation is UNKNOWN rather than "not recommended"'
                  : `${verdicts.setup.parts} part${verdicts.setup.parts === 1 ? '' : 's'} in the drawing`}
                .
              </p>
            ) : null}
            {toolIds.length === 0 ? (
              /* ⚠ THE Ø6 mm CLAUSE LIVES IN THE REPORT COLUMN, NOT HERE
                 (2026-08-11). `no-tool` renders at the same moment and states
                 the substitution WITH ITS SCOPE — *"in the browser only … the
                 core still substitutes … so `2bee-slice` and the gates still
                 behave the old way"* — which is the fact worth carrying. This
                 copy's history clause said the same substitution with no scope
                 at all, so the two together read as one fact stated twice and
                 the weaker one first. What is NOT duplicated, and stays: this
                 panel is where the trigger is, and *"the trigger above says
                 choose…"* is only true here. */
              <p className="bad" data-testid="no-tool-warning">
                No cutter chosen, so <b>nothing is being planned</b>. The trigger
                above says <em>choose…</em> and that is exactly what it means.
              </p>
            ) : null}
            {extraTools && (
              <p className="note" data-testid="extra-tools-note">
                {extraTools.length} tool(s) loaded from file. Any that are invalid are named in the
                notes and are NOT used.
              </p>
            )}

            {/*
              🔴 THE SELECTED TOOLS, ROW BY ROW — TODO #58, founder 2026-08-09:
              *"similar to clamps show the selected Tools (like a table, row by
              row)"*.

              What this replaces is a single `toolcard` describing `toolIds[0]`.
              With one tool that was fine; with a SET — which is how this app has
              worked since the multi-select landed — it described the first
              cutter and said nothing about the rest, so a job planned with three
              tools showed the facts of one. An omission that looks like a
              complete answer.

              🔴 EVERY VALUE HERE IS THE CORE'S, RENDERED VERBATIM, AND NO CELL
              IS AN INPUT. This is where a clamp row and a tool row part company
              and the difference is the whole reason #58 carries a warning: a
              clamp's geometry is an operator DECLARATION — the shop decides
              where the clamp is, and gate P7 checks the toolpath against what
              they declared. A tool row is the core's ANSWER about that cutter on
              this machine: the fit verdict, its reason, the chipload window, what
              it can and cannot do. Letting the visual similarity make one of
              those typeable would produce a green that means nothing. Changing a
              tool means choosing a different one, which is what the list is for.

              ⚠ THERE IS NO LONGER ANY NUMBER HERE THAT IS NOT THE CORE'S —
              2026-08-10. The feed was the exception, and "labelled with where it
              comes from" turned out to name the SOURCE while hiding the
              OMISSION: it was `rpm * flutes * chipload`, the material-blind
              function, against a planner that scales by the material and caps
              the rpm before it computes anything. The label was true and the
              number was wrong by 4.29x in aluminium, which is the direction an
              operator winds a feed override. It is removed rather than
              recomputed. See the Feed cell below for the measurements.
            */}
            {toolIds.length > 0 && lib ? (
              <div className="objrows" data-testid="tool-rows">
                {toolIds.map((id) => {
                  const t = lib.tools.find(  (x: ToolRow) => x.id === id);
                  if (!t) {
                    /* 🔴 NAMED, not skipped. A selected id the library does not
                       hold is exactly the state the restore guard exists to
                       prevent, and the core substitutes a Ø6mm end mill for it
                       without saying so. A row that silently vanished would hide
                       the one case worth seeing. */
                    return (
                      <div className="objrow" key={id} data-testid={`tool-row-${id}`}>
                        <div className="objrow-head">
                          <span className="objrow-name bad">
                            <b>{id}</b> is selected and is NOT in this machine's library
                          </span>
                          <button
                            className="objrow-x"
                            data-testid={`tool-row-x-${id}`}
                            onClick={() => setToolIds(toolIds.filter((x) => x !== id))}
                          >
                            ✕
                          </button>
                        </div>
                        <div className="objrow-facts">
                          <span className="bad">
                            Nothing here can describe it, and the core substitutes a Ø6&nbsp;mm end
                            mill for an id it cannot find — without saying so. Take it out.
                          </span>
                        </div>
                      </div>
                    );
                  }
                  /* 🔴 THE RED THE FOUNDER ASKED FOR, ON THE ROW HE ASKED FOR IT
                     ON — TODO #66: *"highlight the tool (e.g. red background) if
                     it does not work for the current setup, it invalidates the
                     job"*. It is here rather than in the picker's option list
                     because `ObjectPicker` exposes `disabled`/`disabledReason`
                     and NO per-row tone, and that component is another agent's
                     file today. In the picker the same fact is carried as text
                     at the front of the row; here — where the cutters actually
                     chosen for the job are listed — it is `.bad`, with the
                     core's own sentence and the rule that fired.
                     ⚠ Reported rather than worked around: a row TINT in the
                     picker needs one new prop on `ObjectPicker`. */
                  const v = verdictById.get(id);
                  const invalidates = v?.usability === 'invalidates';
                  return (
                    <div className="objrow" key={id} data-testid={`tool-row-${id}`}>
                      <div className="objrow-head">
                        <span className="objrow-icon" aria-hidden="true">
                          <ToolShape tool={t} />
                        </span>
                        <span className={invalidates ? 'objrow-name bad' : 'objrow-name'}>
                          <b>{t.id}</b>
                          <em>{t.category}</em>
                        </span>
                        <button
                          className="objrow-x"
                          data-testid={`tool-row-x-${id}`}
                          title="Take this cutter out of the job."
                          onClick={() => setToolIds(toolIds.filter((x) => x !== id))}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="grid2">
                        <span>Ø</span>
                        <b>{L(t.diameter_mm)}</b>
                        <span>Flutes</span>
                        <b>{t.flutes}</b>
                        <span>Shank</span>
                        <b>{L(t.shank_mm)}</b>
                        <span>Flute length</span>
                        <b>{L(t.cutting_length_mm)}</b>
                        <span>Chipload</span>
                        <b>
                          {t.chipload_mm} ({t.chipload_min_mm}–{t.chipload_max_mm})
                        </b>
                        <span>Rpm</span>
                        <b>
                          {t.rpm_min}–{t.rpm_max}
                        </b>
                        {t.included_angle_deg !== null && (
                          <>
                            <span>Included angle</span>
                            <b>{t.included_angle_deg}°</b>
                          </>
                        )}
                        {t.point_angle_deg !== null && (
                          <>
                            <span>Point angle</span>
                            <b>{t.point_angle_deg}°</b>
                          </>
                        )}
                        <span>Fit</span>
                        {/* 🔴 THE VERDICT, not a fallback over an absent field.
                            `fit_why` is the empty string for `Fitted` and the
                            field is OPTIONAL — an older core emits neither — so
                            `fit_why || '…fits…'` said "fits the collet" for a
                            check that never ran. The state is read off `fit`,
                            which is the four-valued answer, and the absent case
                            is its own sentence. */}
                        <b className={t.fit === undefined ? 'pending' : undefined}>
                          {t.fit === undefined
                            ? 'this core did not answer — UNCHECKED'
                            : t.fit === 'fitted'
                              ? 'fits the collet in the spindle'
                              : t.fit_why}
                        </b>
                        {/* 🔴 TWO VERDICTS, TWO ROWS, AND THEY NEVER MERGE —
                            TODO #66. `usability` is *can this cutter be used at
                            all here* and is the red one; `advice` is *does this
                            drawing want it*, which a perfectly usable cutter can
                            fail. One row for both would let "not the best
                            choice" and "the job cannot be cut" wear the same
                            colour. Both sentences are the CORE's, verbatim. */}
                        <span>Works in this setup</span>
                        <b
                          data-testid={`tool-row-usability-${id}`}
                          className={
                            invalidates
                              ? 'bad'
                              : v?.usability === 'usable'
                                ? 'ok'
                                : 'pending'
                          }
                        >
                          {usabilityMark(v)}
                        </b>
                        <span>This drawing</span>
                        {/* NO COLOUR. `not-for-this-job` is not a fault and
                            `unknown` is not a warning about the cutter — it is
                            this app not having sent a drawing. A tone here would
                            make a preference look like a verdict. */}
                        <b data-testid={`tool-row-advice-${id}`}>
                          {v ? v.advice : 'not asked'}
                        </b>
                        <span>Feed</span>
                        {/* 🔴 THE NUMBER IS GONE, AND NOTHING REPLACES IT —
                            2026-08-10.
                            This cell used to print
                            `Math.round(rpm * t.flutes * t.chipload_mm)`, which
                            is `core/src/feeds.rs::feed_from_chipload` — the
                            MATERIAL-BLIND function the planner does not use. The
                            planner uses `core/src/tools.rs::feed_for`, which
                            multiplies by `Material::chipload_factor()`, and
                            `core/src/job.rs::plan` caps the rpm at
                            `Material::max_rpm()` and then recomputes the feed
                            from the capped value. Two corrections the panel made
                            neither of.
                            Measured on this box 2026-08-10 (`2bee-slice import
                            web/src/samples/hive-super-end.dxf` with this tool at
                            18000 rpm typed in, F/S words read out of the emitted
                            program): Plywood F3600 S18000 · Softwood F3960 ·
                            Hardwood F2880 · MDF F3600 · Acrylic F2400 S16000 ·
                            Aluminium F840 S12000. The panel printed 3600 for
                            every one of them — 4.29x the program in aluminium,
                            on the side an operator winds the feed override UP.
                            🔴 It is NOT re-implemented correctly here, because a
                            correct copy is the same defect with better
                            arithmetic — this is the third machining fact this
                            app has re-derived in TypeScript and the first two
                            were both wrong. The core has the answer
                            (`feed_for`); it is not on the wasm boundary, and
                            putting it there is a core + wasm change this pass
                            was not allowed to make. So the cell says nothing,
                            and says why. */}
                        {/* ⚠ THE CELL CARRIES THE STATE; THE NOTE BELOW CARRIES
                            THE REASON — 2026-08-11. It read `not shown — the
                            core does not export it`, once per selected cutter,
                            and the panel note under the last row says the same
                            thing at length: three selected cutters put the
                            clause on screen four times.

                            🔴 NOTHING IS LOST ONLY BECAUSE THAT NOTE IS ON THE
                            SAME SCREEN AND CANNOT BE COLLAPSED AWAY. It is a
                            bare `<p className="note">` inside `panel-tools`,
                            with these rows. If it is ever moved, made a
                            `<details>`, or given its own section, PUT THE CLAUSE
                            BACK — a bare `not shown` beside a feed is the one
                            place an operator would read "the app is still
                            working it out". */}
                        <b data-testid={`tool-row-feed-${id}`} className="pending">
                          not shown
                        </b>
                      </div>
                      <div className="caps">
                        <span className={t.can_profile ? 'yes' : 'no'}>profile</span>
                        <span className={t.can_pocket ? 'yes' : 'no'}>pocket</span>
                        <span className={t.can_drill ? 'yes' : 'no'}>drill</span>
                      </div>
                      {/* 🔴 THE CORE'S FOUR VERDICTS, NOT A BOOLEAN — 2026-08-10.
                          This block used to be
                          `Math.abs(t.shank_mm - colletMm) > 0.1`, computed here,
                          two lines under the row that renders the core's own
                          `fit_why`. It got four things wrong at once, and every
                          one of them is a sentence an operator acts on:
                          - it measured against the FITTED collet alone and
                            ignored `SPARE_COLLETS_MM`, which this component
                            passed to `tools_for_machine()` one call earlier —
                            so a tool the shop can hold was reported as a
                            mismatch;
                          - it said "a collet change is needed" for a shank NO
                            collet in the shop holds. That cure does not exist;
                          - with no collet declared, `abs(shank - 0) > 0.1` is
                            true for every tool, so UNCHECKED rendered as a
                            definite mismatch on the whole library;
                          - it dropped the one fact that makes the real case
                            actionable — WHICH collet to fit — which the core's
                            `fit_why` names.
                          `shank_mm` is still printed because it is the core's
                          own field and it is the number an operator checks
                          against the drawer. */}
                      {t.fit === undefined ? (
                        <p className="note pending" data-testid={`tool-row-collet-${id}`}>
                          This core emitted no shank verdict, so the collet fit is{' '}
                          <b>UNCHECKED</b> — not passed. Check the shank against the collet in the
                          spindle by hand.
                        </p>
                      ) : t.fit === 'fitted' ? null : (
                        <p
                          className={t.fit === 'none' ? 'bad' : 'warn'}
                          data-testid={`tool-row-collet-${id}`}
                        >
                          {L(t.shank_mm)} shank — {t.fit_why}
                          {t.fit === 'none'
                            ? '. There is no collet change that fixes this: nothing this machine declared holds that shank.'
                            : ''}
                        </p>
                      )}
                      {/* 🔴 THE PLANNER'S OWN SENTENCE, VERBATIM. For
                          `invalidates` this is the text the planner refuses the
                          whole job with — same predicate, same run — so an
                          operator reading it here and reading the refusal later
                          reads one sentence rather than two that have to be
                          reconciled. Rewriting it into panel English is how the
                          two start disagreeing. */}
                      {v && v.usability !== 'usable' && v.why ? (
                        <p
                          className={invalidates ? 'bad' : 'note pending'}
                          data-testid={`tool-row-verdict-why-${id}`}
                        >
                          {usabilityMark(v)} — {v.why}
                        </p>
                      ) : null}
                      {colletDisagreement(t, v) ? (
                        <p className="warn" data-testid={`tool-row-collet-disagreement-${id}`}>
                          {COLLET_DISAGREEMENT_WHY}
                        </p>
                      ) : null}
                      {/* The recommender's REASON line, and only when it chose
                          this cutter: it is the same text `2bee-slice recommend`
                          prints, read out of ONE `recommend()` run rather than
                          re-derived per tool. */}
                      {v && v.advice === 'recommended' && v.why_advice ? (
                        <p className="note" data-testid={`tool-row-advice-why-${id}`}>
                          {v.why_advice}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <p className="note">
                  Every value above is the core's answer about this cutter on this machine, rendered
                  as it arrived. <b>There is no feed here any more.</b> This panel used to multiply
                  rpm × flutes × chipload, which ignores the material — the planner scales chipload
                  by the material and caps the rpm first, so the same row read 3600 mm/min while the
                  program carried 840 in aluminium. The core knows the number and does not export it
                  across the wasm boundary yet. The <code>F</code> words the program actually carries
                  are in the G-code panel, and the rpm the planner settled on is in the notes.
                </p>
              </div>
            ) : null}
          </Section>

          <OperationPanel
            sectionEye={sectionEye}
            layerRows={sectionLayerRows}
          />

          <Section
            title="Verification"
            testid="panel-verify"
            defaultOpen={false}
            eye={sectionEye('panel-verify', 'Verification')}
            layerRows={sectionLayerRows('panel-verify', 'Verification')}
          >
            <Num
              unit={unit}
              label="Sim cell"
              value={simCell}
              onChange={setSimCell}
              step={0.1}
              min={0.2}
              testid="sim-cell"
            />
            {report && (
              <div className="grid2" data-testid="verify-summary">
                <span>Gouges</span>
                <b className={report.sim.gouge > 0 ? 'bad' : 'ok'}>{report.sim.gouge}</b>
                <span>Uncut</span>
                <b
                  className={
                    uncutState === 'finding'
                      ? 'bad'
                      : uncutState === 'clean'
                        ? 'ok'
                        : 'pending'
                  }
                >
                  {report.sim.uncut_checked === true
                    ? report.sim.uncut
                    : 'PENDING'}
                </b>
                <span>Board</span>
                <b
                  className={
                    report.sim.board_depth === 'through-board'
                      ? report.sim.through_board && report.sim.through_board > 0
                        ? 'bad'
                        : 'ok'
                      : report.sim.board_depth === 'inside-board'
                        ? 'ok'
                        : 'pending'
                  }
                >
                  {report.sim.board_depth === 'through-board'
                    ? report.sim.through_board && report.sim.through_board > 0
                      ? `${report.sim.through_board} cell${report.sim.through_board === 1 ? '' : 's'} through`
                      : 'OK'
                    : report.sim.board_depth === 'inside-board'
                      ? 'OK'
                      : 'PENDING'}
                </b>
              </div>
            )}
            <p className="note">
              The simulation is a height map. A gouge smaller than one cell is below its resolution,
              which is why it is one check among several.
            </p>
          </Section>

          <SavedDataPanel
            savedMachines={savedMachines}
            savedWorkpieces={savedWorkpieces}
            savedDrawings={savedDrawings}
          />

          {/* ---- About LEFT THIS COLUMN ON 2026-08-11 — TODO #107 + #108 ----

              It was a `Section` here, and its own note said why: *"this is the
              panel and not the menu … when #108 lands, `Help → About` should
              render `CNC_ABOUT_LINES` rather than a second list"*. The menu
              landed. It renders those constants, and this column does not carry
              a second copy — the whole point of that note was that the CONTENT
              was never what was missing.

              ⚠ WHAT DID NOT MOVE: the never-cut statement is still the
              undismissable strip at the top of this tab, from the same constant,
              because a dialog nobody opens says exactly as much as a collapsed
              section nobody expands. */}
        </aside>

        <main className="stage">
          <Viewport
            /* 🔴 STOP RENDERING WHEN THIS TAB IS NOT SHOWING. The panel is
               hidden and never unmounted (see `Tabs.tsx`), and `display: none`
               does not stop a `requestAnimationFrame` loop — nor does it shrink
               this canvas, which falls back to 640x480 when its container
               measures zero. Without this the app would draw a full 3D scene
               nobody can see, on every frame, for as long as the CAD tab is
               open. `App` is the authority on which tab is showing, so it is
               told rather than left to infer it from its own box. */
            paused={tab !== 'cnc'}
            stockMaterial={material}
            simCellMm={simCell}
            /* The selected tool row, for the hover panel. Passed through
             * VERBATIM from the core's library — including `fit`/`fit_why`,
             * which is the machine's verdict. The collet rule was got wrong
             * once by being re-derived in the UI; it is not re-derived here. */
            tool={scene.tool}
            /* ✅ WIRED 2026-08-09 — TODO #59. This prop carried a documented
             * HOLD for a week, and the HOLD's own measurement had stopped
             * describing the code.
             *
             * WHAT IT SAID: wiring this DISABLES THE SHEET'S ROTATE HANDLE,
             * because `wallsReason([])` is ~313 characters against
             * `wallsReason(undefined)`'s ~105, the extra wrapped lines grow the
             * top-left overlay by ~34px, its bottom edge crosses the handle, and
             * an informational span eats the grab. Measured at 1280x720:
             *
             *   rotate handle, page coords      886.3, 300.9
             *   element actually under it       SPAN[data-testid=gap-status]
             *   overlay container rect          y 53.8 -> 302.8, full width
             *   container pointer-events        auto        <- THE LOAD-BEARING LINE
             *
             * RE-MEASURED AT THE CODE BEFORE WIRING, not taken from the ticket:
             * `3dab19fdd` ("the snap controls were built, styled and
             * unclickable") changed that container to `pointerEvents: 'none'`
             * with each control row inside it re-enabling `'auto'`. The overlay
             * is TEXT and no longer takes pointer input at all, so the text can
             * grow past the handle without covering it — which was exactly the
             * fix this HOLD was waiting for, made for a different reason, in a
             * commit that never mentioned this prop.
             *
             * ⇒ The blocker's reason is gone, so the blocker goes. The e2e `the
             * sheet can be turned by its handle` is the control that says so —
             * it asserts `elementFromPoint` at the handle is the CANVAS before it
             * drags, precisely so a covered handle cannot masquerade as broken
             * rotation arithmetic again. It was re-run against this change.
             *
             * ⚠ A STALE 🔴 IS AS EXPENSIVE AS A STALE ✅ AND HARDER TO FIND:
             * nobody re-reads a row that already admits it is uncovered, and
             * nobody re-tests a blocker that names a reason. This one was
             * precise, measured, and true when written, which is what let it
             * outlive its own fix by nine days — and it cost the extruded-walls
             * layer, which cannot render without this prop, all of them.
             *
             * 🔴 NOT `?? null`. `ViewportProps.drawing` is a THREE-state contract
             * and `null` is not one of the three: `undefined` means "this
             * viewport was not handed it", `[]` means "the core exported no
             * contours for this report", and an array means real parts.
             * Collapsing the first two would make a reference fixture — which
             * genuinely has no drawing behind it — indistinguishable from a
             * viewport nobody wired, and `wallsReason()` says a different
             * sentence for each. So: no report at all → not wired; a report →
             * exactly what it exported, `[]` included. */
            drawing={scene.drawing}
            /* 🔴 THE CORE'S DETECTED FORMAT, not this app's request — TODO #48.
             *
             * `'auto'` is not a format: it is the REQUEST "decide by content",
             * and forwarding it made `loadedReason()` say *"…is a 2D AUTO
             * drawing"* — our question printed as its answer, with the "2D" half
             * false as well on an STL. It was then patched to pass the empty
             * string, which stopped the lie and said nothing.
             *
             * `shownFormat` above relays what the core ACTUALLY decided, read
             * off `report.job` — the label `plan_report_import_bytes_*` writes
             * from `is_mesh = format == "stl" || looks_like_stl(data)`. So an
             * STL is now NAMED as one however the file was spelled, which is the
             * branch of `loadedReason()` that matters: it is the difference
             * between *"is an STL, but its mesh was not requested"* and *"is a
             * 2D drawing — there is no 3D object to show"*, and only one of
             * those is true of a solid.
             *
             * ⚠ RESIDUAL, unchanged and named rather than quietly dropped: on
             * the `auto` route the core does not report whether it read a DXF or
             * an SVG, so that case still passes an empty string and the sentence
             * still reads "is a 2D  drawing". Closing it needs a detected format
             * on `Report`; that is a core change and this pass does not own the
             * core. */
            loaded={scene.loaded}
            loadedMesh={scene.loadedMesh}
            // The machined surface. Asked for at a 3mm display cell on every
            // plan; `null` when a job produced none (refused, or declined).
            stockSurface={scene.stockSurface}
            // The touch plate is drawn where it is DECLARED. `probe_x`/`probe_y`
            // of 0,0 means "probe where the tool already is" in the core's own
            // definition, which is why the viewport reports it as not declared
            // rather than drawing a plate at the origin as if that were a
            // measurement.
            /* 🔴 DRAWN ONLY WHEN A THICKNESS IS DECLARED. `enabled` is not
             * `probeEnabled` alone: a plate whose top thickness nobody has
             * entered has no geometry we know, and drawing one at the old
             * unsourced 1.6mm would put the assumption decision #43 removed back
             * on screen — where it looks like a measurement. The panel says why
             * instead. */
            touchPlate={scene.touchPlate}
            stockOrigin={[originX, originY]}
            stockRotationDeg={rotation}
            // Dragging the sheet writes the SAME datum fields the panel shows,
            // so the drag and the numbers can never disagree about where the
            // board is. There is one place the datum lives.
            onStockMove={(x, y) => {
              setOriginX(x);
              setOriginY(y);
            }}
            /* 🔴 `onStockRotate` IS GONE with the sphere knob — founder,
               2026-08-10: *"remove the large ball to rotate the workpeace"*. The
               CAPABILITY did not go with it: the `Laid at` select and the
               `rotate-ccw` / `rotate-cw` buttons in the Workpiece panel write the
               same `rotation` state the handle wrote, so there is still exactly
               one place the angle lives and the job still reads that one value.
               Checked before deleting — a knob removed while it was the only way
               to turn a sheet would be a capability regression dressed as a UI
               cleanup. */
            /* The transform the core actually placed the program with. Passed
               through VERBATIM — the viewport draws the imported geometry under
               it, and nothing in the browser rebuilds it from the stock fields.
               `undefined` when no report has landed, which the viewport reads as
               the identity rather than as a zero matrix. */
            drawingPlacement={report?.drawing_placement ?? null}
            /* 🔴 EVERY PLACED DRAWING, BY THE ID THE PROGRAM NAMES IT WITH —
               not one pair of numbers for the sheet. This replaced
               `partOffsetX`/`partOffsetY`, which could only ever describe ONE
               part: the viewport had a single grab target for the whole sheet,
               so a grab on any drawing started a drag that wrote the SELECTED
               drawing's placement. With four parts on the bed that is a gesture
               moving something the operator is not looking at.

               The ids are `LoadedDrawing.instance`, which is exactly what goes
               to the core as `ImportSource::id` and comes back on every part
               name as `<instance>/<part>`. One key, three places, no parallel
               index to drift. */
            partInstances={partInstances}
            /* Which drawing the PANEL is about. It decides only what the
               single-part probes report, never what a drag moves — that is
               whatever was under the pointer. */
            selectedInstance={imported?.instance ?? null}
            /* Dragging a part writes the SAME placement its row shows, for the
               same reason the workpiece drag writes the datum: one place the
               number lives, so the gesture and the readout cannot disagree. The
               value arrives already in workpiece millimetres and rounded.

               🔴 ONE WRITE, NOT TWO — and this line was the founder's *"I can't
               move the loaded object on one of the axes with the mouse"*
               (2026-08-10). It read:

                   onPartMove={(x, y) => { setPartX(x); setPartY(y); }}

               `setPartX`/`setPartY` are SINGLE-AXIS setters over a shared pair:
               `setPartX(x)` is `movePart(x, partY)` and `setPartY(y)` is
               `movePart(partX, y)`, where `partX`/`partY` are captured from the
               render this arrow was created in. Both calls happen inside one
               closure, so the second one writes `[partX_at_render, y]` and
               DISCARDS the x the first one just wrote — every time, in either
               order of flush, batched or not. Part X could never leave the value
               it was typed at; Part Y worked. A dead axis, exactly as reported.

               ⚠ The reason this survived review is that it looks identical to
               `onStockMove` two props up, which really does call two setters —
               but `originX`/`originY` are two INDEPENDENT `useState` hooks, so
               there is no shared value for the second write to clobber. The
               sheet dragged on both axes and the part on one, in code that reads
               the same. The refactor that made `partX/partY` a VIEW of
               `drawings[sel].offset` (`ac6e978eea`) is what turned two states
               into one, and this call site was not moved with them.

               ⚠ NOT the same thing as the crossed-axes effect, which is real and
               is CORRECT: `Job::place` adds the drawing offset BEFORE the
               sheet's rotation, so on a sheet laid at 90° Part X moves the
               machine's Y. Measured at the emitted program, plate.dxf on a
               500x500 sheet: at 90°, `drawing_offset [50,0]` moved the G-code Y
               47..253 -> 97..303 with X unchanged, and `[0,50]` moved X
               327..453 -> 277..403 with Y unchanged. That is the frame doing its
               job; the viewport's axis triad and its frame line are what make it
               legible. It is not why the axis was dead.

               ⚠ AND THE PER-INSTANCE HANDLER IS THE SAME TRAP ONE STEP ALONG.
               `movePartAt` takes the id and BOTH axes in one call and closes
               over nothing; anything of the shape
               `(id, x, y) => { setX(id, x); setY(id, y); }` would reproduce the
               dead axis exactly, keyed by instance. */
            onPartMoveAt={movePartAt}
            onClampMove={(i, x, y) => {
              const s = useCncStore.getState();
              s.setClamps(s.clamps.map((c: ClampCfg, j: number) =>
                j === i
                  ? { ...c, x: Math.round((x - c.w / 2) * 10) / 10, y: Math.round((y - c.h / 2) * 10) / 10 }
                  : c
              ));
            }}
            stock={scene.stock}
            clamps={scene.clamps}
            /* The imported drawing, for the extruded-walls layer.
             *
             * 🔴 NOT `?? null`. `ViewportProps.drawing` is a THREE-state
             * contract and `null` is not one of the three: `undefined` means
             * "this viewport was not handed it", `[]` means "the core exported
             * no contours for this report", and an array means real parts.
             * Collapsing the first two would make a reference fixture — which
             * genuinely has no drawing behind it — indistinguishable from a
             * viewport nobody wired, and `wallsReason()` says a different
             * sentence for each. So: no report at all → not wired; a report →
             * exactly what it exported, `[]` included. */
            /* The selected tool row, for the hover panel. Passed through
             * VERBATIM from the core's library — including `fit`/`fit_why`,
             * which is the machine's verdict. The collet rule was got wrong
             * once by being re-derived in the UI; it is not re-derived here. */
            moves={scene.moves}
            /* 🔴 THE ECHO FIRST, the panel state only until one lands — the same
             * rule `clamps` and `stock` two props up already follow. The core
             * echoes the travel envelope off the `Job` it planned from precisely
             * so the viewport need not remember what it posted, and a picture
             * drawn from a pending edit is a picture of a machine the check does
             * not have. */
            travel={scene.travel}
            /* 🔴 THE BOARD AS THE CORE ECHOED IT, never as this panel holds it.
             * A declaration that was REFUSED (an unknown id, both forms at once,
             * a size with no position) comes back `null` here while the fields
             * on the left still show what was typed — and drawing the typed
             * version would put a board on screen that no check is enforcing.
             * `null` = nobody declared one, and the viewport draws nothing. */
            spoilboard={scene.spoilboard}
            /* 🔴 THE DEPTH VERDICT, WHICH THIS APP WAS NOT PASSING AT ALL.
             * `Viewport` reads `props.boardDepth` to decide whether the slab is
             * painted as a strike on the machine, an intended sacrificial cut,
             * or PENDING — and it treats absent as PENDING, correctly. So an
             * unpassed prop is not a crash and not a blank: it is a permanent
             * *"this was not checked"* over a job the core checked perfectly
             * well, on a canvas where the operator has no way to tell the two
             * apart. Found while typing the three fields onto `SimCounts` in
             * `cam.ts`: the types were the visible half of the gap and this line
             * was the half that decided anything.
             *
             * ⚠ `report?.sim` WHOLE, not three fields copied across. The
             * component takes the shape it reads; picking fields out here would
             * be a place for the two to drift, and the honesty flags are the
             * exact thing that must not be dropped in transit. */
            boardDepth={report?.sim ?? null}
            spoilboardBareReach={report?.spoilboard_bare_reach ?? null}
            /* The provenance rides with the rectangle. A board drawn at a
             * corner this app fitted must not look like one somebody measured
             * — the canvas is the surface where that difference disappears
             * fastest. */
            spoilboardPositionAssumed={spoilboardPos === 'assumed'}
            progress={progress}
            /* ⚠ THE OLDER RAPIDS CONTROL, AND IT IS A WART WORTH NAMING RATHER
               THAN QUIETLY RESOLVING. `showRapids` is `useState(true)` with NO
               SETTER — nothing in this app can make it false — so the viewport's
               `kindOn.rapid && props.showRapids !== false` reduces to the layer
               state alone and the two controls cannot currently disagree,
               because only one of them is reachable. Left as it is: deleting the
               state would be the tidy-looking change that quietly hard-wires
               rapids on, and the viewport's own comment already records that the
               indicator counts a class hidden by either. */
            showRapids={showRapids}
            /* 🔴 THE LAYER STATE IS THIS COMPONENT'S — see the block where it
               is declared. The viewport READS it (to draw, and to count what is
               hidden) and holds no copy; the only thing it writes is `all` /
               `none`, through the callback below. So the sidebar eyes and the
               canvas pair cannot disagree about what is on screen — there is
               one record. */
            layers={layers}
            /* 🔴 DRAWING ONLY, exactly like `layers` — see the prop's own note.
               It reaches the camera and nothing else: not `plan()`, not the
               G-code, not the checks. The default is ORTHOGRAPHIC and it
               deliberately differs from the CAD tab's; the reason is in
               `projection.ts` and it is about reading a fit honestly, not
               taste. */
            projection={projection}
            /* 🔴 THE DECLARED Z DATUM, WHICH THIS APP HELD AND NEVER PASSED —
               TODO #111, fixed 2026-08-11.

               `zZeroTop` has been in this component since the founder's ruling
               (*"0Z should be on the bottom of the workpiece, top of the
               spoilboard"*) and it went to the core (`z_zero_at_top`, three
               props up in `cfg`) and NOWHERE ELSE. So every Z word in the
               emitted program moved by a workpiece thickness while the viewport
               drew its axis triad at plan zero — the one instrument on the
               canvas whose entire job is to say which frame you are looking at,
               drawing the wrong one, with nothing on screen disagreeing.

               🔴 CONVERTED HERE, IN THE OPEN, AND NOT PASSED AS THE BOOLEAN.
               `ViewportProps.zDatum` is a two-name union for the same reason the
               core stopped being a `bool` on the same day: a boolean puts the two
               datums on opposite sides of truthiness, so an unwired prop, an
               empty string and a zero all silently land on ONE of them — and the
               one they land on is the one the founder's ruling made live. The
               names are `ZDatum::label`'s, so the browser, the core and the
               operator's caption all say the same two words.

               ⚠ NOT `report?…` — unlike `stock`, `travel` and `spoilboard`, this
               is not echoed back. The panel's own state is the only copy, so
               there is nothing to prefer it to; when the core starts echoing the
               datum, this line should read the echo for the same reason those
               three do. */
            zDatum={zZeroTop ? 'workpiece-top' : 'spoilboard-top'}
            /* 🔴 THE CUT DEPTH, WHICH THIS VIEWPORT WAS NEVER GIVEN — TODO #47.
               `deepest_z_mm` is negative (below stock top); `cutDepthMm` wants
               positive mm below stock top. `undefined` when no report exists,
               which makes the walls draw at stock thickness labelled ASSUMED. */
            cutDepthMm={
              report?.deepest_z_mm != null && report.deepest_z_mm < 0
                ? -report.deepest_z_mm
                : undefined
            }
            clearance={clearance}
            otherWorkpieces={
              workpieces.length > 1
                ? workpieces
                    .filter((_, i) => i !== activeWorkpiece)
                    .map((wp) => ({
                      stockX: wp.stockX,
                      stockY: wp.stockY,
                      originX: wp.originX,
                      originY: wp.originY,
                      rotation: wp.rotation,
                    }))
                : undefined
            }
            onContextMenu={(info) => setCtxMenu(info)}
            dark={dark}
          />
          {/* Context menu overlay */}
          {ctxMenu ? (
            <div
              data-testid="context-menu"
              style={{
                position: 'fixed',
                left: ctxMenu.x,
                top: ctxMenu.y,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius)',
                padding: 4,
                zIndex: 1000,
                minWidth: 160,
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {ctxMenu.object === 'ghost-workpiece' && ctxMenu.workpieceIndex != null ? (() => {
                // Ghost index maps to workpieces[] index skipping the active one
                const ghostIdx = ctxMenu.workpieceIndex;
                const realIdx = ghostIdx >= activeWorkpiece ? ghostIdx + 1 : ghostIdx;
                return (
                  <>
                    <div style={{ padding: '4px 8px', color: 'var(--muted)', fontSize: 11 }}>
                      {`Workpiece #${realIdx + 1}`}
                    </div>
                    <button
                      data-testid="ctx-switch"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--ink)', border: 'none', cursor: 'pointer' }}
                      onClick={() => { switchWorkpiece(realIdx); setCtxMenu(null); }}
                    >Switch to this workpiece</button>
                    <button
                      data-testid="ctx-clone"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--ink)', border: 'none', cursor: 'pointer' }}
                      onClick={() => {
                        const wp = workpieces[realIdx];
                        if (wp) {
                          pushSnapshot();
                          setWorkpieces((ws) => [...ws, {
                            stockX: wp.stockX, stockY: wp.stockY,
                            originX: wp.originX + wp.stockX + 20,
                            originY: wp.originY, rotation: wp.rotation,
                            drawings: [] as LoadedDrawing[],
                          }]);
                        }
                        setCtxMenu(null);
                      }}
                    >{`Clone (offset +${L(20)} X)`}</button>
                    <button
                      data-testid="ctx-remove"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--bad)', border: 'none', cursor: 'pointer' }}
                      onClick={() => { removeWorkpiece(realIdx); setCtxMenu(null); }}
                    >Remove</button>
                  </>
                );
              })() : ctxMenu.object === 'stock' ? (
                <>
                  <div style={{ padding: '4px 8px', color: 'var(--muted)', fontSize: 11 }}>Active workpiece</div>
                  <button
                    data-testid="ctx-add"
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--ink)', border: 'none', cursor: 'pointer' }}
                    onClick={() => { addWorkpiece(); setCtxMenu(null); }}
                  >Add workpiece here</button>
                </>
              ) : ctxMenu.object === 'clamp' && ctxMenu.clampName ? (() => {
                const clampIdx = clamps.findIndex((c) => c.name === ctxMenu.clampName);
                const clamp = clampIdx >= 0 ? clamps[clampIdx] : null;
                return (
                  <>
                    <div style={{ padding: '4px 8px', color: 'var(--muted)', fontSize: 11 }}>
                      {clamp ? `${clamp.name} (${L(clamp.w)}×${L(clamp.h)}×${L(clamp.height_mm)})` : ctxMenu.clampName}
                    </div>
                    <button
                      data-testid="ctx-clamp-remove"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--bad)', border: 'none', cursor: 'pointer' }}
                      onClick={() => {
                        if (clampIdx >= 0) {
                          pushSnapshot();
                          const s = useCncStore.getState();
                          s.setClamps(s.clamps.filter((_: ClampCfg, j: number) => j !== clampIdx));
                        }
                        setCtxMenu(null);
                      }}
                    >Remove clamp</button>
                    <button
                      data-testid="ctx-clamp-clone"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--ink)', border: 'none', cursor: 'pointer' }}
                      onClick={() => {
                        if (clamp) {
                          pushSnapshot();
                          const s = useCncStore.getState();
                          s.setClamps([...s.clamps, {
                            ...clamp,
                            name: `${clamp.name}-clone-${s.clamps.length + 1}`,
                            x: clamp.x + clamp.w + 10,
                          }]);
                        }
                        setCtxMenu(null);
                      }}
                    >{`Clone (offset +${L(10)} X)`}</button>
                    <button
                      data-testid="ctx-clamp-rotate"
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--ink)', border: 'none', cursor: 'pointer' }}
                      onClick={() => {
                        if (clampIdx >= 0) {
                          pushSnapshot();
                          const s = useCncStore.getState();
                          s.setClamps(s.clamps.map((c: ClampCfg, j: number) =>
                            j === clampIdx
                              ? { ...c, rotation_deg: ((c.rotation_deg ?? 0) + 90) % 360 }
                              : c
                          ));
                        }
                        setCtxMenu(null);
                      }}
                    >Rotate 90°</button>
                  </>
                );
              })() : null}
              <button
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', background: 'transparent', color: 'var(--muted)', border: 'none', cursor: 'pointer', fontSize: 11 }}
                onClick={() => setCtxMenu(null)}
              >Cancel</button>
            </div>
          ) : null}
          {playbackResetNote && (
            <p className="note" data-testid="playback-reset-note">{playbackResetNote}</p>
          )}
          {undoToast && (
            <p className="note" data-testid="undo-toast">{undoToast}</p>
          )}
          <div className="scrub">
            {/*
              The scrubber sits ON a coloured map of the program: every move
              drawn as a slice, in its own colour, in program order. Founder,
              2026-08-08.

              🔴 It is drawn from `report.render`, the SAME array the 3D view
              draws, so the bar and the viewport cannot disagree about what the
              program contains. A bar built from a second source would be a
              picture of a different program.

              ⚠ The axis is MOVE COUNT, not time. A 400mm rapid and a 2mm cut are
              one slice each, and the tool-change stripe is a single move that
              takes a minute at the machine. So this shows WHAT and in what
              ORDER, not how long — the run time is a separate number with its
              own caveats (it does not model acceleration). Anyone reading width
              as duration is reading it wrong, which is why the title says so.
            */}
            <div
              className="progmap"
              data-testid="program-map"
              title="Every move in the program, in order, coloured by kind. Width is move COUNT, not time."
              aria-hidden="true"
            >
              {/* Runs of the same kind, so a 9000-move program is a few dozen
                  DOM nodes rather than 9000 — and the eye reads runs anyway.
                  A tool change or a probe is ONE move and would round to
                  nothing at this width. They are the two a person most wants to
                  find, so `.pm-change`/`.pm-probe` give them a floor in CSS. */}
              {programRuns.map((r, i) => (
                <span key={i} className={`pm pm-${r.kind}`} style={{ flexGrow: r.n }} />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={progress}
              data-testid="scrubber"
              onChange={(e) => scrubTo(Number(e.target.value))}
            />

            {/*
              🔴 WHAT REPLACED THE `100%` — TODO #24, founder 2026-08-08: the
              total cut time and the number of tool changes, plus a play button
              that runs the cut IN TIME.

              The `100%` said nothing an operator could plan a day around. These
              two numbers can be planned around, which is exactly why the word
              ESTIMATE and the direction of its error are on screen beside them
              and not in a tooltip: this figure is a FLOOR, and a floor that
              does not say so gets quoted as a duration.

              (`showRapids` is still in the state and still passed to the
              viewport — the TOP row owns it now. Deleting the state as well
              would have been the tidy-looking change that quietly turned rapids
              on permanently.)
            */}
            <div className="transport" data-testid="transport">
              <button
                className="tbtn play"
                data-testid="play"
                aria-pressed={playing}
                disabled={!(timeline.total > 0)}
                title={
                  timeline.total > 0
                    ? 'Run the program in time. The clock is the same arithmetic as the estimate — each move at its own feed, rapids at the machine rate.'
                    : 'No program to play.'
                }
                onClick={() => {
                  if (!playing && clockRef.current >= timeline.total) {
                    // Play from the end means play again, not stand still.
                    clockRef.current = 0;
                    setClockShown(0);
                    setProgress(0);
                  }
                  const s = useCncStore.getState(); s.setPlaying(!s.playing);
                }}
              >
                {playing ? '❚❚' : '▶'}
                <span className="sr">{playing ? 'Pause' : 'Play'}</span>
              </button>
              <div className="speeds" role="group" aria-label="Playback speed">
                {PLAYBACK_SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={s === speed ? 'on' : ''}
                    data-testid={`speed-x${s}`}
                    aria-pressed={s === speed}
                    // ⚠ Says what it does NOT do, because that is the question a
                    // machinist asks first when a CAM program offers a speed.
                    title={`Play back ${s}x faster. Wall-clock only — it does not change a feed, a program or a plan.`}
                    onClick={() => setSpeed(s)}
                  >
                    x{s}
                  </button>
                ))}
              </div>
              <span className="clock" data-testid="playback-clock">
                {clockShown > 0 ? fmtDuration(clockShown) : '0s'} /{' '}
                {timeline.total > 0 ? fmtDuration(timeline.total) : '—'}
              </span>

              {report ? (
                <span className="estimate" data-testid="estimate">
                  <b data-testid="bar-est-time">{fmtDuration(report.estimated_seconds)}</b>
                  <em>estimate — a floor</em>
                  <b data-testid="bar-tool-changes">
                    {report.tool_changes} tool change{report.tool_changes === 1 ? '' : 's'}
                  </b>
                </span>
              ) : null}

            {/* 🔴 INSIDE the transport row, not under it, and the reason is
                measured rather than aesthetic: this bar sits on the viewport's
                height budget. Every line added here is a line taken off the 3D
                canvas, and a shorter canvas made the sheet's rotate handle
                measurably harder to land on a quarter turn (the e2e drag stopped
                settling). Closed, this costs no line at all; open, CSS gives it
                the full width. */}
            {report ? (
              <details className="estwhy" data-testid="estimate-why">
                <summary>What that time cannot know</summary>
                <ul>
                  <li>
                    <b>It is a floor, not a guess in both directions.</b> It sums each emitted
                    block&rsquo;s distance at that block&rsquo;s commanded feed and does{' '}
                    <b>not model acceleration</b>. grblHAL ramps into and out of every corner, so
                    the real cut takes <b>longer</b> — worst on a program made of many short
                    segments, which is precisely the arc-heavy work this tool produces. Every
                    omission below removes time; none of them invents any.
                  </li>
                  {/* The core's own sentences, verbatim — they carry THIS program's
                      exposure (how many of its blocks are short, what the reader
                      could not measure) rather than a generic disclaimer. */}
                  {estimateNotes.length > 0 ? (
                    estimateNotes.map((n, i) => <li key={`en${i}`}>{n}</li>)
                  ) : (
                    <li className="warn" data-testid="estimate-note-missing">
                      The core&rsquo;s own run-time note was not found in this report, so this
                      program&rsquo;s exposure — how many of its motion blocks are short enough for
                      the missing acceleration model to matter — is not shown here. It has NOT been
                      re-counted off the drawn path: that is a different array with a different
                      number of moves, and a plausible second number is worse than none.
                    </li>
                  )}
                  {/* 🔴 THE RATE IS READ, NOT WRITTEN. Every number in this
                      bullet comes off the report — see `timeline.changeSec`.
                      The `?? 0` case is a WARNING and not a silent zero: a
                      clock charging nothing for operator time looks exactly
                      like a program that has none. */}
                  <li className={timeline.changesUncharged > 0 ? 'warn' : undefined}>
                    <b>A tool change is time from a person, not from a machine.</b> The program
                    says <code>M0</code> and stops; how long someone takes to fit a cutter is not
                    in the file.{' '}
                    {timeline.changes === 0 ? (
                      <span data-testid="tool-change-rate-none">
                        This program never changes tool, so no operator time is in either number.
                      </span>
                    ) : timeline.changeRateKnown ? (
                      <span data-testid="tool-change-rate">
                        Both the figure above and the playback charge{' '}
                        <b>{timeline.changeSec}s</b> per change —{' '}
                        <b>{timeline.changeRateDeclared ? 'declared' : 'assumed'}</b>
                        {timeline.changeRateDeclared
                          ? ', which is this machine’s own figure.'
                          : ': nobody declared a rate for this machine, so the core used its built-in default. That default is an estimate of one shop and has not been measured on any machine — declare yours if this number matters.'}{' '}
                        Playback <b>holds</b> on the red stripe rather than racing past it — use
                        x10 if you would rather not watch it.
                      </span>
                    ) : (
                      <span data-testid="tool-change-rate-missing">
                        This report carries <b>no per-change rate</b>, so the playback clock
                        charged <b>0s</b> for {timeline.changes} change
                        {timeline.changes === 1 ? '' : 's'} and the animation runs straight
                        through the red stripe. Nothing has been substituted: a plausible rate
                        typed in here is what this app used to do, and it disagreed with the
                        estimate beside it by a minute a change.
                      </span>
                    )}
                  </li>
                  <li>
                    <b>Playback runs on the drawn path, the estimate on the emitted program</b>,
                    so the two totals are close but not equal.{' '}
                    <span data-testid="clock-vs-estimate">
                      Playback {fmtDuration(timeline.total)} · estimate{' '}
                      {fmtDuration(report.estimated_seconds)} ·{' '}
                      <b>
                        {report.estimated_seconds - timeline.total >= 0 ? '+' : '−'}
                        {Math.abs(Math.round(report.estimated_seconds - timeline.total))}s
                      </b>{' '}
                      not in the animation
                    </span>
                    . That difference is real program time the drawn path has no move for — the{' '}
                    <code>G4</code> spindle spin-up dwell, and the <code>G38.2</code> probe search,
                    which is one move with no feed on it.
                    {timeline.untimed > 0 ? (
                      <>
                        {' '}
                        A further <b>{timeline.untimed}</b> drawn move
                        {timeline.untimed === 1 ? '' : 's'} carrying{' '}
                        {L(timeline.untimedMm)} of travel had no rate to time
                        {timeline.untimed === 1 ? ' it' : ' them'} at and{' '}
                        {timeline.untimed === 1 ? 'was' : 'were'} charged nothing.
                      </>
                    ) : null}
                  </li>
                  <li>
                    <b>Nothing here has cut anything.</b> This estimate has never been checked
                    against a real cut on a real machine.
                  </li>
                </ul>
              </details>
            ) : null}
            </div>
          </div>
        </main>

        {/* 🔴 A GRID COLUMN OF ITS OWN, not an absolutely-positioned strip over
            the panel edge. The overlay form is what makes a splitter drift out
            of alignment the moment anything around it changes size, and an
            invisible shield over a scrollbar is the same class of defect as the
            pointer-shield the viewport's overlay column documents at length.

            Keyboard as well as pointer, and not as a courtesy: this is the only
            control on the page whose entire affordance is a 6px sliver, so a
            trackpad user who overshoots has no other way back. Arrows step 16px,
            Home restores the default — and `aria-valuenow` means the current
            width is READABLE rather than only draggable. */}
        <div
          className="vsplit"
          data-testid="report-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Report panel width"
          aria-valuenow={reportW}
          aria-valuemin={REPORT_W_MIN}
          aria-valuetext={`${reportW} pixels`}
          tabIndex={0}
          title="Drag to resize the report panel. Arrow keys step 16px; Home restores the default."
          onPointerDown={startReportResize}
          onDoubleClick={() => { const s = useCncStore.getState(); s.setReportW(clampReportW(REPORT_W_DEFAULT)); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { const s = useCncStore.getState(); s.setReportW(clampReportW(s.reportW + 16)); }
            else if (e.key === 'ArrowRight') { const s = useCncStore.getState(); s.setReportW(clampReportW(s.reportW - 16)); }
            else if (e.key === 'Home') { const s = useCncStore.getState(); s.setReportW(clampReportW(REPORT_W_DEFAULT)); }
            else return;
            e.preventDefault();
          }}
        />

        <aside className="report" data-testid="report">
          {busy && <div className="busy">planning…</div>}

          {/*
            🔴 An empty panel is not an empty state. When the `Job` fixtures came
            off the operator surface this app correctly stopped planning `plate`
            behind the user's back — and then showed a blank column, which reads
            as a broken app rather than as "you have not given me a drawing yet".
            Silence about a state the user is IN is the same defect as silence
            about a refusal.
          */}
          {/* TWO empty states, not one, because they are two different facts
              and the fix for each is a different action. Collapsing them into
              "nothing to show" is an absence rendered as a reassuring state. */}
          {!report && !busy && toolIds.length === 0 ? (
            <div className="empty" data-testid="no-tool">
              <strong>No cutter chosen.</strong>
              <p>
                Nothing is planned until one is. Every feed, depth and pass count
                in a program is derived from the cutter, so a program planned
                without one would be arithmetic about a tool you never picked —
                and it would post, download and cut exactly like a real one.
              </p>
              <p>
                Choose a <em>Tool</em> in the Tooling panel.
              </p>
              <p className="warn">
                ⚠ This refusal is in the browser only. The core still substitutes
                a Ø6&nbsp;mm end mill for a missing <code>tool_id</code> — and for
                a mistyped one — without saying so, so <code>2bee-slice</code> and
                the gates still behave the old way. Filed, not fixed.
              </p>
            </div>
          ) : null}
          {!report && !busy && toolIds.length > 0 ? (
            <div className="empty" data-testid="no-drawing">
              <strong>No drawing yet.</strong>
              <p>
                Pick one from the <em>Drawing</em> list — the shipped samples and
                your own saved drawings are in it together — or open a DXF, SVG
                or STL file of your own from the same list. Nothing is planned
                until then: a toolpath on screen for a part you did not supply
                would look like your work.
              </p>
            </div>
          ) : null}

          {blocked && (
            <div className="block" data-testid="blocked">
              <strong>This program will not be produced.</strong>
              <ul>
                {report!.refusals.map((r, i) => (
                  <li key={`r${i}`}>{r}</li>
                ))}
                {report!.errors.map((r, i) => (
                  <li key={`e${i}`}>{r}</li>
                ))}
                {report!.fixture_findings
                  .filter((f) => f !== 'Undeclared')
                  .map((r, i) => (
                    <li key={`f${i}`}>{r}</li>
                  ))}
              </ul>
            </div>
          )}

          {report && (
            <>
              <SummaryPanel report={report} busy={busy} />

              {/* 🔴 THE HEADER CARRIES THE ALARM, because the body may be shut
                  and now STAYS shut across a refresh. Two states only, and both
                  come from the same numbers the rows below are coloured by — a
                  badge computed from a second source would be a summary that can
                  disagree with the panel it summarises.

                  ⚠ THE `Uncut is PENDING` HALF WAS EXCLUDED FROM THIS BADGE ON A
                  REASON THAT IS NO LONGER TRUE, and the reason is why it is now
                  included rather than the exclusion being kept. It said the
                  caveat is *structural* — "that counter can never fire on a user
                  job" — so a badge carrying it would be constant, and a badge
                  that is always on is a badge nobody reads. But the counter DOES
                  fire: `pocket` reports 3 uncut cells over 9,604 tested. What was
                  missing was not the possibility, it was `uncut_checked` reaching
                  the browser at all. Now that it does, this limb VARIES exactly
                  like the spoilboard one — measured on `plate` (false) and
                  `pocket` (true) — so it belongs in the badge on the same terms.
                  Both limbs are read as `!== true`, so an old report that carries
                  neither flag reads PENDING rather than clean. */}
              <SimulationPanel
                report={report}
                uncutState={uncutState}
                spoilboardPos={spoilboardPos}
                sectionEye={sectionEye}
              />

              {/* 🔴 THE COUNT THAT PAYS FOR THE STICKY COLLAPSE. See
                  `Section`'s `badge` prop: a refresh used to re-open this
                  panel, so collapsing it could only ever hide a warning until
                  the next reload. It cannot any more, so the header states
                  what is inside — a shut panel reads "2 warnings", not just
                  "Notes and warnings".

                  ⚠ WARNINGS AND NOTES ARE COUNTED SEPARATELY and the warnings
                  lead. A single number would let two notes and zero warnings
                  look identical to zero notes and two warnings, which is the
                  distinction the whole badge exists for. Fixture findings
                  count as warnings: "no work holding declared" is one. */}
              {(report.notes.length > 0 ||
                report.warnings.length > 0 ||
                report.fixture_findings.length > 0) && (
                <Section
                  title="Notes and warnings"
                  testid="panel-notes"
                  badge={(() => {
                    const w = report.warnings.length + report.fixture_findings.length;
                    const n = report.notes.length;
                    if (w > 0)
                      return {
                        text: `${w} warning${w === 1 ? '' : 's'}${n ? ` \u00b7 ${n} note${n === 1 ? '' : 's'}` : ''}`,
                        tone: 'bad' as const,
                      };
                    return { text: `${n} note${n === 1 ? '' : 's'}`, tone: 'muted' as const };
                  })()}
                >
                  <ul className="notes" data-testid="notes">
                    {report.fixture_findings.map((f, i) => (
                      <li key={`ff${i}`}>
                        {/* ⚠ `web/e2e/slicer.spec.ts:504` and `:510` still assert the
                            pre-2026-08-11 wording *"nobody has confirmed the bed is
                            clear"* and are STALE — both must become `machine`.
                            `web/e2e/**` was outside the sweep's boundary. `machine`
                            is the word `Fixturing::confirmed_clear` uses in the core
                            (*"Set ONLY by a human confirming they looked at the
                            machine"*), which is why it is the one chosen here. */}
                        {f === 'Undeclared'
                          ? 'No work holding declared, and nobody has confirmed the machine is clear.'
                          : f}
                      </li>
                    ))}
                    {report.warnings.map((w, i) => (
                      <li key={`w${i}`}>{w}</li>
                    ))}
                    {report.notes.map((n, i) => (
                      <li key={`n${i}`}>{n}</li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="G-code" testid="panel-gcode" defaultOpen={false} badge={{ text: report.gcode.split('\n').length - 1 + ' lines', tone: 'muted' }}>
                <div className="row">
                  {/* 🔴 DISABLED WHILE A RE-PLAN IS IN FLIGHT (2026-08-29).
                      The status word beside this button had the same defect and
                      was fixed with it, but this is the surface that matters
                      more: a label that is briefly wrong is read again, and a
                      FILE that is briefly wrong is sent to the machine. While
                      `busy`, `report` still holds the LAST COMPLETED plan, so
                      this would save a `.nc` computed from settings the operator
                      has already changed — with the panel next to it showing the
                      new numbers. */}
                  <button onClick={download} disabled={!report.gcode || busy} data-testid="download">
                    Download .nc
                  </button>
                  <button onClick={() => setShowGcode(!showGcode)} data-testid="toggle-gcode">
                    {showGcode ? 'Hide' : 'Show'} ({report.gcode.split('\n').length - 1} lines)
                  </button>
                  {/* 🔴 THE HAND-OVER, AND IT IS THE ONLY THING THAT CHANGES WHAT
                      THE RUN TAB HOLDS. It sits beside Download because this is
                      where the EMITTED PROGRAM lives — the same artefact, going
                      to a second destination.

                      ✅ **IT IS DISABLED WHILE THE RUN TAB IS STREAMING, since
                      2026-08-11.** The comment here used to say the confirm below
                      *"is the only thing standing between a re-plan and a swap
                      while the machine is moving, because this app cannot see
                      whether a stream is running"*. It can see it now:
                      `StreamingSignal` is `RunTab`'s own answer, and its contract
                      says in as many words — **disable it, do not merely
                      confirm.** The confirm stays for the ordinary replace, where
                      it is a speed bump and is named as one.

                      🔴 THE REFUSAL IS KEYED ON `streaming`, WHICH IS NOT
                      "the machine is moving". It is "this tab is feeding lines".
                      The two are different facts and the second is the only one
                      anything here can observe — the sentence rendered below says
                      so rather than letting the button imply otherwise. */}
                  <button
                    data-testid="handover-run"
                    disabled={runBuild.status !== 'ok' || streamSignal?.streaming === true}
                    title={
                      streamSignal?.streaming
                        ? streamSignal.why
                        : runBuild.status === 'ok'
                          ? 'Give this program to the Run tab. Nothing else ever changes what that tab holds.'
                          : runBuild.why
                    }
                    onClick={() => {
                      if (runBuild.status !== 'ok') return;
                      /* Belt as well as braces. `disabled` is the control the
                       * operator sees; this is the one a driver, a stale render
                       * or a keyboard activation goes through. A refusal that
                       * exists only in an attribute is a refusal with one door. */
                      if (streamSignal?.streaming) return;
                      if (
                        heldProgram &&
                        heldProgram.hash !== runBuild.program.hash &&
                        !window.confirm(
                          `The Run tab is holding "${heldProgram.name}" (${heldProgram.lines.length} lines, ${heldProgram.hash}).\n\n` +
                            `Replace it with "${runBuild.program.name}" (${runBuild.program.lines.length} lines, ${runBuild.program.hash})?\n\n` +
                            `⚠ The Run tab is not streaming — but that is a fact about the SENDER, not ` +
                            `about the machine. The controller still executes whatever is already in ` +
                            `its buffer, with the spindle turning, and after a lost link nothing was ` +
                            `ever told to stop.`
                        )
                      ) {
                        return;
                      }
                      setHeldProgram(runBuild.program);
                    }}
                  >
                    {heldProgram ? 'Replace the Run tab’s program' : 'Hand to the Run tab'}
                  </button>
                </div>
                {/* 🔴 THE SIGNAL'S OWN SENTENCE, RENDERED UNCHANGED — and
                    rendered whether or not it is streaming, which is the half a
                    consumer gets wrong.

                    `streaming === false` is NOT "the machine is stopped". It
                    means this tab is not feeding lines; the controller holds
                    everything already sent — up to a full RX buffer, 40–70 of
                    our lines — and keeps executing it with the spindle turning.
                    After a `link-lost` end it is *especially* not stopped,
                    because nothing was told to stop. That is exactly the
                    inference an enabled button invites, so the sentence that
                    forbids it sits beside the button and not in a doc. */}
                {streamSignal ? (
                  <p
                    className={
                      streamSignal.streaming || streamSignal.ended === 'link-lost' ? 'warn' : 'note'
                    }
                    data-testid="handover-streaming"
                    data-streaming={streamSignal.streaming ? 'yes' : 'no'}
                    data-ended={streamSignal.ended}
                  >
                    {streamSignal.why}
                  </p>
                ) : null}
                {/* Where the two stand. `stale` is the state worth reading: a
                    newer plan exists and the Run tab was NOT changed by it. */}
                <p
                  className={heldVerdict.state === 'stale' ? 'warn' : 'note'}
                  data-testid="handover-state"
                  data-state={heldVerdict.state}
                >
                  {heldVerdict.text}
                </p>
                {heldVerdict.state !== 'stale' ? (
                  <p className="note" data-testid="handover-frozen">
                    {WHY_FROZEN}
                  </p>
                ) : null}
                {showGcode && (
                  /* The RESIZED element is the wrapper, not the <pre>: the grips
                     are absolutely positioned children, and inside a scrolling
                     <pre> they would scroll away with the program text. The
                     <pre> fills the wrapper and keeps doing the scrolling. */
                  <div
                    ref={gcodeBox.ref}
                    className="gcode-box"
                    data-testid="gcode-box"
                    style={{ position: 'relative', height: 320 }}
                  >
                    <pre
                      className="gcode"
                      data-testid="gcode"
                      style={{ height: '100%', maxHeight: 'none', margin: 0, boxSizing: 'border-box' }}
                    >
                      {report.gcode}
                    </pre>
                    {gcodeBox.grips}
                  </div>
                )}
              </Section>
            </>
          )}
        </aside>
      </div>
      </TabPanel>

      {/* 🔴 MOUNTED ONLY ONCE THE TAB HAS BEEN OPENED, AND NEVER UNMOUNTED
          AFTER. Before the first visit the CAD tree is not in the document at
          all, which keeps a first page load exactly what it was before this bar
          existed — that is the load every test in `web/e2e/` drives, and none of
          them knows a tab bar is here. After the first visit it stays mounted
          and merely hidden, because its state is the SOURCE somebody is typing
          and unmounting would throw it away.

          `CadTab` is mounted, not modified: it takes no props, adds no CSS to
          the shared sheet and no dependency to the lockfile, and it writes into
          the same `drawings` collection the panel behind this reads from. */}
      {/* The shop is the landing tab, so it is mounted eagerly: gating it behind
          a "seen" flag the way `cad` is gated would put a fetch and a first
          paint in front of the very first screen. It holds no editable state,
          so nothing is lost by it being cheap. */}
      <TabPanel id="shop" tab={tab}><ShopTab onOpened={onShopOpened} /></TabPanel>

      <TabPanel id="cad" tab={tab}>{cadSeen ? <CadTab /> : null}</TabPanel>

      {/* 🔴 THE REASON WAS WRONG AND THE PROP IS RIGHT — corrected 2026-08-11,
          in that order, because the two are separable and only one of them
          moves an operator's hands.

          It said `focusable` was passed *"because this panel is text with
          nothing in it to focus"*. That is false and `Tabs.tsx` had already
          caught it: this panel draws Connect, Start, Hold, Resume, Home, Unlock,
          Jog, Cancel jog, Spindle stop, Zero, Stop, Abort and a console input.

          The APG's tabs pattern gives TWO conditions, and it is the second that
          holds here: *"if the tabpanel does not contain any focusable elements
          OR THE FIRST ELEMENT WITH CONTENT IS NOT FOCUSABLE, the tabpanel
          element should have tabindex=0"*. The first thing in this panel is the
          red `run-unproven` banner — a paragraph, not a control — followed by
          the state line and the DROs. So the stop earns itself on the panel's
          opening content rather than on it being empty, and DROPPING the prop
          would take a keyboard user's only route to that banner.

          The other two panels open with their own controls and must not get one:
          an extra stop in front of the CAM panels would change a keyboard order
          operators already have in their hands. */}
      <TabPanel id="run" tab={tab} focusable>
        {/* 🔴 `programForRunTab` IS THE LATCH, and it is what makes the mid-job
            swap impossible rather than merely unlikely. It reads `heldProgram`
            and nothing else; `runBuild` is passed only so the negative control
            in `runProgram.ts` has something to reach. Writing
            `program={runBuild.status === 'ok' ? runBuild.program : null}` here
            is the defect — it is one expression away and it is the hazard. */}
        {/* 🔴 `onStreaming` IS THE ONE FACT THAT CROSSES BACK. The tab reports;
            this tab owns the hand-over control and decides what to do about it —
            which is to disable it, per `StreamingSignal`'s own contract. Nothing
            else in this file reads the signal, and nothing may use it to decide
            a motion. */}
        <RunTab program={programForRunTab(heldProgram, runBuild)} onStreaming={setStreamSignal} />
      </TabPanel>

      <footer className="foot">
        <span>
          core {ver.core} · G-code contract {ver.gcode_contract}
        </span>
        <span>
          AGPL-3.0-or-later ·{' '}
          {/* 🔴 NOT RENAMED WITH THE REST, DELIBERATELY. This is the AGPL §13
              source offer — a licence obligation — and it is a URL, not a label:
              changing `2bee.slicer` to `2bee.app` here would be guessing at a
              repository name from a product rename and, if wrong, would turn a
              licence obligation into a 404. Nothing on this box can check it (no
              network is assumed), so it is REPORTED rather than edited. Every
              other occurrence of the old name in this file was user-facing text
              and was corrected. */}
          <a href="https://github.com/2bee-farm/2bee.slicer" rel="noreferrer">
            source
          </a>
          {/* AGPL §13: when the Corresponding Source is served over a network,
              it must be offered to every user who interacts with it. With Cognito
              auth, only authenticated admin users reach this footer — they are
              exactly the audience §13 requires the offer for. The link above is
              the mechanism; the auth gate on the login screen also carries it. */}
        </span>
        {/* 🔴 THE DRY-RUN SENTENCE IS GONE — founder, 2026-08-11: *"remove
            this: 'Never run a program that has not been dry-run on the
            machine.' this will be part of the operation tab"*. The dry run
            stops being advice in a footer and becomes a thing the app does: a
            rung on the run tab (#76), where connect → jog → home → air-cut
            above the work → coupon → ply is the sequence to a first real cut.

            ⚠ NOTHING REPLACES IT, deliberately. A footer is not where a safety
            sentence gets relocated to, and inventing a different warning here
            would be this lane asserting something nobody asked for. `.warnfoot`
            went with it — it had no other user, and CSS for a rule that no
            longer exists is the kind of residue that gets re-used by accident. */}
      </footer>
    </div>
  );
}
