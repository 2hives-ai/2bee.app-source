// Millimetres ↔ inches — **DISPLAY ONLY**, and every line here exists to keep it
// that way.
//
// Founder 2026-08-11: *"2bee.app able to change from inch to cm"*. TODO #109.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 HE SAID CENTIMETRES. THE PAIR THAT SHIPS IS MILLIMETRES ↔ INCHES, AND THE
//    UNIT HE NAMED IS NOT REFUSED — IT IS THE SAME SWITCH
// ═══════════════════════════════════════════════════════════════════════════
//
// A CNC shop is metric or imperial, and the metric half is **millimetres**: the
// controller's `G21` word is millimetres, every cutter in this app's catalogue is
// specified in millimetres, sheet stock is sold in millimetres, and grblHAL's own
// `$` settings are millimetres per minute. **Centimetres appear nowhere in that
// chain**, so a `cm` mode would be a third rendering of a quantity that is
// entered in mm and cut in mm — one more place for a decimal point to move.
//
// ⚠ **That is a reason, not a refusal.** The thing asked for was *"change from
// inch to …"* — a unit switch — and the switch is here, in the View menu, with
// both units on it. What is NOT offered is a `cm` row, and {@link UNITS_ABSENT}
// says so in the product, in the same form `CNC_MENU_ABSENT` uses: the reason is
// "the machine does not speak it", never "we did not get to it". If the founder
// wants the third row anyway it is four lines — {@link Unit}, a divisor, a label
// and a menu item — and nothing else in this file changes.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE ONE RULE: MILLIMETRES ARE CANONICAL AND A CONVERTED VALUE IS NEVER
//    WRITTEN BACK
// ═══════════════════════════════════════════════════════════════════════════
//
// This lane is millimetre-native end to end — `x_mm`, `thickness_mm`,
// `feed_mm_min`, `max_feed_mm_min` — and the post emits **`G21`**. Nothing in
// this module reaches `plan()`, the config object, the session blob or the job
// file. The display unit is chrome, in exactly the sense `projection.ts` is
// chrome: it changes the picture and never the program.
//
// **The defect this is written to prevent compounds silently.** Enter `0.5"`,
// display it as `12.7 mm`, store the `12.7`, switch back, get `0.4999"`. Do that
// twice and the number the operator typed is no longer the number the cutter
// gets — on a dimension they entered, which is a wrong part rather than a wrong
// picture.
//
// So the direction of travel is asymmetric and enforced by the shape of the API:
//
//   · {@link toDisplay} — mm → the operator's unit. **Rounded, for a screen.**
//     Its result may be rendered and may be put in an input box. It may never be
//     stored, sent, or handed to a `set*`.
//   · {@link fromDisplay} — the operator's unit → mm. **Called on ONE event
//     only: the operator typed.** What they typed is what is stored, converted
//     once, at full precision.
//
// ⇒ Switching the unit calls `toDisplay` and nothing else. **A unit switch
// performs no write.** `tests/units.test.ts` holds both halves, including the
// witness that proves the round trip is lossy in the direction we forbid.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 A CONVERTED, ROUNDED DISPLAY SAYS SO — `≈` IS PART OF THE NUMBER
// ═══════════════════════════════════════════════════════════════════════════
//
// This lane already distinguishes `assumed` from `entered` and `declared` from
// `measured`, because a number's provenance changes what may be concluded from
// it. A displayed length has a third kind of provenance nobody had needed
// before: **it may not be the number the planner holds.**
//
// `610 mm` is `24.015748031496063 in`. Shown at screen precision that is
// `24.0157 in`, and `24.0157 in` is `609.99878 mm` — a different board. So
// {@link formatLength} prefixes `≈` whenever the rounded display does not
// convert back to the stored millimetre value exactly:
//
//     610      mm-mode →   "610 mm"        exact, it is what is stored
//     610      in-mode →  "≈24.0157 in"    rounded; the planner holds 610 mm
//     12.7     in-mode →   "0.5 in"        exact, and marked as exact
//     11.99896 mm-mode →  "≈11.999 mm"     rounded, and mm mode is not exempt
//
// ⚠ **THE ASYMMETRY IS THE POINT, AND IT IS NOT A BUG IN INCH MODE.** In mm mode
// almost nothing is marked, because millimetres are what is stored and what was
// typed. In inch mode most things are, because most of this setup was entered in
// millimetres and inches cannot express it. **That is a true statement about the
// data, shown on the data**, and it is the honest version of a unit switch on a
// millimetre-native tool.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 EVERY NUMBER CARRIES ITS UNIT, AND THAT IS WHY THIS IS A FORMATTER AND NOT
//    A CONVERTER
// ═══════════════════════════════════════════════════════════════════════════
//
// A half-converted screen — inches in the panels and millimetres inside a
// refusal, with neither labelled — is worse than millimetres everywhere, because
// the operator has to remember a setting to read a number. The defence is not
// discipline: it is that **the only function that produces a length for a screen
// returns the unit with it.** There is no `toDisplay`-then-interpolate path in
// the UI, because `toDisplay` returns a `number` that is useless to JSX without
// {@link formatLength} or an `<input>` whose `<em>` slot holds the unit.
//
// {@link UNITS_NOT_CONVERTED} names, in the product, every surface that stays in
// millimetres and why — and each entry is "it is not ours to convert", never
// "not yet".

/* ── The units ─────────────────────────────────────────────────────────────── */

/**
 * The two the machine speaks.
 *
 * ⚠ `'in'` and not `'inch'`/`'imperial'`: the string is persisted, and it is
 * also the symbol printed after the number, so one value cannot drift from the
 * other. See {@link UNIT_SYMBOL}, which is the identity map on purpose.
 */
export type Unit = 'mm' | 'in';

/**
 * **Exact by definition** — the inch has been exactly 25.4 mm since the 1959
 * international yard and pound agreement, and every standards body since states
 * it as an exact conversion rather than a measurement.
 *
 * 🔴 So a conversion here is never *approximate because the factor is
 * approximate*. It is approximate only because a screen has a finite number of
 * digits, which is the thing `≈` reports and the thing rounding at a declared
 * precision bounds.
 */
export const MM_PER_INCH = 25.4;

/**
 * Decimal places shown, per unit.
 *
 * 🔴 THESE ARE NOT COSMETIC — they are the quantum the `≈` marker is computed
 * against and the precision an input box round-trips at, so changing one changes
 * what the operator can type.
 *
 * · **mm → 3.** The core prints millimetres at three decimals
 *   (`placed_extent_mm[…].toFixed(3)`) and the post emits coordinates at three,
 *   so the UI cannot claim more than the program does.
 * · **in → 4.** `0.0001 in` is the universal imperial DRO and toolroom
 *   resolution: it is what an operator expects to type and what a shop's
 *   drawings are dimensioned to.
 *
 * 🔴 **AND THE INCH DISPLAY IS THEREFORE COARSER THAN THE MILLIMETRE ONE, BY
 * 2.54×.** `0.0001 in` = `0.00254 mm` against the mm view's `0.001 mm`. This
 * comment claimed the opposite until `tests/units.test.ts` was written and the
 * assertion that was supposed to confirm it went red instead.
 *
 * ⚠ **THAT IS NOT A DEFECT, IT IS THE REASON THE `≈` MARKER AND THE NO-WRITE-BACK
 * RULE BOTH EXIST**, and it is bigger than it looks: half an inch quantum is
 * `0.00127 mm`, which is ABOVE the `0.001 mm` the emitted program is written to.
 * So a converted value written back could move a coordinate in the G-code —
 * `12 mm` shown as `0.4724 in` is `11.99896 mm`, and the post rounds that to
 * `11.999` rather than `12.000`. The drift is not sub-resolution noise; it
 * reaches the machine. Going to five decimals would hide it and produce a
 * display no shop reads.
 */
export const DECIMALS: Readonly<Record<Unit, number>> = { mm: 3, in: 4 };

/**
 * What is printed after the number. Identity, deliberately — see {@link Unit}.
 *
 * ⚠ `in` rather than `″` or `"`. The double-prime is the shop convention and it
 * is also the character that reads as an unclosed quote in a monospace column,
 * inside JSON, and in a `title=` attribute. `24 in` cannot be misread as
 * anything; `24"` can be, and this is the one number on the screen that must not
 * be.
 */
export const UNIT_SYMBOL: Readonly<Record<Unit, string>> = { mm: 'mm', in: 'in' };

/** The word on the menu row. Sentence case: these are menu items. */
export const UNIT_LABEL: Readonly<Record<Unit, string>> = {
  mm: 'Millimetres',
  in: 'Inches',
};

/**
 * 🔴 **THE DEFAULT IS MILLIMETRES, AND IT IS NOT A PREFERENCE.**
 *
 * Every stored value in this app is a millimetre, the post emits `G21`, and the
 * catalogue — cutters, sheets, hold-downs, touch plates — is specified in
 * millimetres by its manufacturers. Opening in inches would show a screen full
 * of `≈` on data that is exact, which is the picture of a tool that is unsure of
 * its own numbers.
 */
export const DEFAULT_UNIT: Unit = 'mm';

/**
 * What this switch does NOT offer, and why each is absent rather than
 * present-and-broken. Rendered in the View menu's footnote.
 *
 * 🔴 SAME RULE AS `CNC_MENU_ABSENT`: every line is "the thing it would describe
 * does not exist in this chain", never "we did not get to it".
 */
export const UNITS_ABSENT: readonly string[] = [
  'Centimetres, which is the word the request used. The metric half of a CNC shop is millimetres ' +
    'end to end — the controller’s G21 word, grblHAL’s own $ settings, every cutter in this ' +
    'catalogue, every sheet a supplier quotes — so a centimetre row would be a third rendering of ' +
    'a quantity that is entered in millimetres and cut in millimetres, and one more place for a ' +
    'decimal point to move. Say the word and it is four lines; it is left out on purpose, not ' +
    'by omission.',
  'Feet, metres and thou. Nothing in this app spans a metre of travel or resolves a thou, so each ' +
    'would be a unit in which every number on the screen is either a fraction or a rounding.',
];

/**
 * 🔴 **WHAT THE SWITCH DOES NOT REACH, NAMED IN THE PRODUCT.**
 *
 * A screen where some numbers moved and some did not is only safe if the
 * operator can tell which is which **without having to remember the setting** —
 * so every number carries its unit, and this list says where the millimetres are
 * coming from when they are not this menu's.
 *
 * ⚠ **THE BOUNDARY IS ONE SENTENCE ON PURPOSE:** *the panel column follows this
 * setting; the 3D view, the plan's own text and the program do not.* A boundary
 * an operator can hold in their head is worth more than a boundary that is
 * strictly larger and has to be looked up per number — a per-string frontier is
 * the half-converted screen wearing a longer changelog.
 */
export const UNITS_NOT_CONVERTED: readonly string[] = [
  'The plan’s own notes, warnings and refusals — “12mm of cutting length cannot cut 18mm deep” and ' +
    'every sentence like it. They are formatted in Rust, inside the core, which is shared by the ' +
    'browser, the command-line tool and the release checks. A second unit in there would mean the refusal ' +
    'that stops a cut has two renderings and only one of them is covered by the release checks. They stay in ' +
    'millimetres, and they say “mm” in their own text.',
  'The G-code, the program map and the download. That is the program, not a picture of it: it is ' +
    'G21 millimetres by construction and it is byte-for-byte identical whichever unit this menu is ' +
    'set to. Rendering it in inches would be showing you a file that is not the file.',
  'The 3D view and its captions. The scene IS a millimetre instrument — its grid, its snap ' +
    'increments (off / 1 / 5 / 10 mm) and the rounding the drag applies are millimetre behaviours, ' +
    'and a display switch is not allowed to change what a drag lands on. Inch captions over a ' +
    'millimetre grid would put the label and the instrument in different units, which is worse ' +
    'than a view that is honestly metric throughout. Every string it draws carries its own “mm”.',
  'A nominal sheet thickness (“12, 16, 18 mm”). A nominal is a trade designation and not a ' +
    'measurement — an 18mm sheet is not 18mm, and imperial trade has its own nominals (3/4", ' +
    '1/2") which are not 0.7087". Converting would invent a sheet size no supplier sells, in the ' +
    'one field whose whole job is to name what a supplier sells.',
  'A catalogue entry’s NAME. “End Mill - Down-cut 6mm 2F” is a part number that you will type into ' +
    'a supplier’s search box; the 6 in it is spelling, not a length. Its measured properties — ' +
    'diameter, shank, cutting length, chipload — are lengths and they DO follow this setting.',
  'The Run tab’s live readout. It is the machine talking — grblHAL reports position in the units ' +
    'its own $13 setting selects — so the number there belongs to the controller, not to this menu.',
  'The Summary panel’s FEED row, in mm/min, and its RPM row, which carries NO unit string at all — the label is the unit. Added to this list 2026-08-28, ' +
    'when a review found the feed row hardcoding “mm/min” in a panel that converts every length ' +
    'beside it — so the choice was neither made nor stated. It is stated now: both rows are read ' +
    'back out of the EMITTED PROGRAM, which is G21 millimetres by construction, and they are ' +
    'printed exactly as the program prints them so that the operator can search the G-code for ' +
    'the string on the screen. That is the same reason the download two entries above stays ' +
    'metric, and the same rule the RPM row already stated for itself. ⚠ It does leave one panel ' +
    'showing “Deepest Z 0.472 in” one row above “Feed 4800 mm/min”: a depth is a length you check ' +
    'with a caliper, a feed is a word in the file. Converting the feed would break the search and ' +
    'buy nothing an operator measures.',
  '🔴 SEVEN ENTRY FIELDS, WHICH SAY “mm ONLY” ON THEMSELVES WHILE THIS IS SET TO INCHES: the ' +
    'touch-plate top thickness, the spoilboard’s size, thickness and corner, and the ' +
    'workpiece-edge tolerance. Each of those accepts a BLANK, which means NOT DECLARED and is a ' +
    'different answer from 0 — so the field holds what you type rather than a number, and ' +
    'converting typed text as you type it would eat the decimal point before the digit after it ' +
    'arrived. Type millimetres in those seven. This is a known gap, not a design: closing it ' +
    'needs a field that converts when you leave it rather than as you type, and that is a change ' +
    'to a control which also records whether the spoilboard corner was measured or assumed.',
];

/* ── The conversions ───────────────────────────────────────────────────────── */

/** Round to `places` decimals, without `toFixed`'s string detour. */
function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/**
 * Millimetres → the operator's unit, **at screen precision**.
 *
 * 🔴 THE RESULT OF THIS FUNCTION MAY NOT BE STORED. It is rounded, so it is not
 * the value the planner holds; feeding it back is the drift this module exists
 * to prevent. It goes to {@link formatLength} or into an `<input>`, and nowhere
 * else.
 *
 * ⚠ Non-finite input is returned as-is rather than coerced. A `NaN` that renders
 * as `0` is a dimension nobody entered wearing the face of one somebody did.
 */
export function toDisplay(mm: number, unit: Unit): number {
  if (!Number.isFinite(mm)) return mm;
  return round(unit === 'mm' ? mm : mm / MM_PER_INCH, DECIMALS[unit]);
}

/**
 * The operator's unit → millimetres, **at full precision**.
 *
 * 🔴 CALLED ON EXACTLY ONE EVENT: the operator typed. `v` is then a number a
 * human chose, so converting it once is not a round trip — it is the entry.
 * Nothing rounds afterwards, which is what makes `0.5 in` store `12.7` and not
 * `12.69`.
 */
export function fromDisplay(v: number, unit: Unit): number {
  if (!Number.isFinite(v)) return v;
  return unit === 'mm' ? v : v * MM_PER_INCH;
}

/**
 * Is the screen value the whole truth about the stored one?
 *
 * `false` ⇒ the display is rounded and the planner holds something else, which
 * is what {@link formatLength}'s `≈` reports and what a numeric input marks in
 * its unit slot.
 *
 * ⚠ **THE TOLERANCE SEPARATES FLOAT NOISE FROM DISPLAY ROUNDING, AND NOTHING
 * ELSE.** `24 in` is `609.5999999999999 mm` in binary floating point even though
 * the inch is exactly 25.4 mm; calling that inexact would put `≈` on a number
 * that is exact by definition and make the marker mean nothing. So the epsilon
 * is `1e-9 mm` — four orders of magnitude below the smallest rounding this
 * module can produce (`0.0005 mm` in the millimetre view) and four above the
 * float error at the largest length this app handles.
 *
 * 🔴 THE FIRST VERSION USED HALF THE MILLIMETRE QUANTUM AND WAS WRONG IN A WAY
 * THAT ONLY SHOWED IN ONE MODE: every millimetre rounding is smaller than half a
 * millimetre quantum by construction, so `≈` could never appear in millimetre
 * display and `11.99896 mm` rendered as a confident `11.999 mm`. A marker that
 * one whole mode is structurally unable to show is a marker that lies by
 * omission in that mode. The test caught it; the comment had claimed otherwise.
 */
export const EXACTNESS_EPSILON_MM = 1e-9;

export function isExact(mm: number, unit: Unit): boolean {
  if (!Number.isFinite(mm)) return false;
  const back = fromDisplay(toDisplay(mm, unit), unit);
  return Math.abs(back - mm) <= EXACTNESS_EPSILON_MM;
}

/**
 * Trailing zeros removed. `610.000` is a claim about precision that this app has
 * not measured, and a column of `610.000 mm` is unreadable next to `18.000 mm`.
 */
function trim(v: number, places: number): string {
  if (!Number.isFinite(v)) return String(v);
  return String(round(v, places));
}

/* ── The one way a length reaches a screen ─────────────────────────────────── */

export interface FormatOptions {
  /**
   * Print the unit symbol. **Defaults to `true` and there is no call site that
   * passes `false`** — it exists so {@link formatLengthPair} can put one symbol
   * on a pair (`1200 × 600 mm`) instead of two, which is the only case where a
   * bare number is still unambiguous because the symbol is inside the same
   * phrase.
   */
  symbol?: boolean;
  /** Prefix `≈` when the display is rounded. Defaults to `true`. */
  marker?: boolean;
}

/**
 * 🔴 **THE ONLY WAY A LENGTH IS RENDERED IN THIS TAB.** Millimetres in, a string
 * out, with the unit on it and `≈` when the display is not the stored value.
 *
 * It takes millimetres rather than a display number so no caller can convert
 * first and format after — that ordering is how a value gets rounded twice, and
 * how one gets rendered with the wrong symbol.
 *
 * ⚠ A non-finite length renders as `—` **with no unit**, because there is no
 * length. `NaN mm` reads like a measurement that went wrong; `—` reads like the
 * absence it is, and absence is a state this app has to be able to show
 * (`thickness_mm` is nullable and the `None` is load-bearing).
 */
export function formatLength(mm: number, unit: Unit, opts: FormatOptions = {}): string {
  if (!Number.isFinite(mm)) return '—';
  const { symbol = true, marker = true } = opts;
  const shown = trim(toDisplay(mm, unit), DECIMALS[unit]);
  const near = marker && !isExact(mm, unit) ? '≈' : '';
  return symbol ? `${near}${shown} ${UNIT_SYMBOL[unit]}` : `${near}${shown}`;
}

/**
 * `1200 × 600 mm` / `≈47.2441 × ≈23.622 in` — one symbol for a pair, because a
 * size is one fact.
 *
 * ⚠ THE MARKER STAYS PER-NUMBER. One half of a pair can be exact while the other
 * is not (`609.6 × 610 mm` in inches is `24 × ≈24.0157`), and a single marker on
 * the pair would either overclaim one or underclaim the other.
 */
export function formatLengthPair(a: number, b: number, unit: Unit, sep = ' × '): string {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return `${formatLength(a, unit)}${sep}${formatLength(b, unit)}`;
  }
  return (
    `${formatLength(a, unit, { symbol: false })}${sep}` +
    `${formatLength(b, unit, { symbol: false })} ${UNIT_SYMBOL[unit]}`
  );
}

/**
 * `1200 × 600 × 18 mm` — the third dimension of a sheet, same rule as the pair.
 */
export function formatLengthTriple(a: number, b: number, c: number, unit: Unit): string {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
    return `${formatLength(a, unit)} × ${formatLength(b, unit)} × ${formatLength(c, unit)}`;
  }
  return (
    `${formatLength(a, unit, { symbol: false })} × ` +
    `${formatLength(b, unit, { symbol: false })} × ` +
    `${formatLength(c, unit, { symbol: false })} ${UNIT_SYMBOL[unit]}`
  );
}

/* ── Numeric inputs ────────────────────────────────────────────────────────── */

/**
 * The step ladder an inch input snaps to.
 *
 * 🔴 A STEP IS NOT A LENGTH AND MUST NOT BE CONVERTED LIKE ONE. `step={0.5}`
 * millimetres converted arithmetically is `0.0196850393700787` inches — a
 * spinner that walks a dimension into fifteen significant figures and an
 * `<input type=number>` whose validation rejects everything the operator types,
 * because a value must be an integer multiple of `step` from `min`.
 *
 * So the mm step is converted and then snapped DOWN to the nearest shop-normal
 * inch increment. Down rather than nearest: a finer step can always reach a
 * coarser value, and the reverse is what makes a field refuse a number.
 */
export const INCH_STEPS: readonly number[] = [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1];

/** The spinner increment for a field whose millimetre step is `stepMm`. */
export function displayStep(stepMm: number, unit: Unit): number {
  if (unit === 'mm') return stepMm;
  if (!Number.isFinite(stepMm) || stepMm <= 0) return INCH_STEPS[0];
  const wanted = stepMm / MM_PER_INCH;
  let best = INCH_STEPS[0];
  for (const s of INCH_STEPS) if (s <= wanted) best = s;
  return best;
}

/**
 * A `min`/`max` bound for a display-unit input.
 *
 * ⚠ ROUNDED **OUTWARD**, and that is the whole reason this is not `toDisplay`.
 * A minimum rounded down and a maximum rounded up can never exclude a
 * millimetre value the field would otherwise have accepted — rounding a `min`
 * up by one display quantum silently forbids the smallest legal setting, and
 * the operator sees a field that refuses a number the app itself chose.
 */
export function displayBound(mm: number | undefined, unit: Unit, side: 'min' | 'max'): number | undefined {
  if (mm === undefined || !Number.isFinite(mm)) return undefined;
  const raw = unit === 'mm' ? mm : mm / MM_PER_INCH;
  const f = 10 ** DECIMALS[unit];
  return (side === 'min' ? Math.floor(raw * f) : Math.ceil(raw * f)) / f;
}

/* ── Persistence ───────────────────────────────────────────────────────────── */

/**
 * Validate a persisted value.
 *
 * ⚠ ANYTHING THAT IS NOT ONE OF THE TWO WORDS FALLS BACK — a missing key, a
 * corrupt blob, `'inch'`, `'cm'`, `true`, `1`. Same rule as
 * `readProjection`: a preference store going bad may not put the panels into a
 * unit nobody chose, and on this tab that is not a cosmetic failure.
 */
export function readUnit(v: unknown, fallback: Unit = DEFAULT_UNIT): Unit {
  return v === 'mm' || v === 'in' ? v : fallback;
}

/**
 * The sentence shown on the tab while a non-canonical unit is selected.
 *
 * 🔴 IT IS A STRIP, NOT A TOOLTIP, AND NOT A MENU NOTE. A menu note is visible
 * only while the menu is open, and the thing it has to say — *the numbers you
 * are reading were converted; the program was not* — is exactly the thing an
 * operator needs while they are NOT looking at the menu. Same shape and same
 * reason as the perspective warning strip.
 */
export const INCH_DISPLAY_NOTE =
  'INCHES, DISPLAY ONLY — and only in this panel column. Every dimension is stored, planned and ' +
  'cut in millimetres; the program is G21 millimetres and byte-for-byte identical to the one you ' +
  'would get with this set to millimetres. “≈” on a number means the inch value shown is rounded ' +
  'and the planner holds a different millimetre value — type in a box and what you type is what ' +
  'is stored. 🔴 THE 3D VIEW, THE PLAN’S OWN NOTES AND REFUSALS, THE G-CODE, AND CATALOGUE PART ' +
  'NUMBERS STAY IN MILLIMETRES and say “mm” in their own text. If a number does not carry a unit ' +
  'on it, that is a defect — report it rather than assuming which one it is in.';
