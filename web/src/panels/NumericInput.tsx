/**
 * Numeric input components — extracted from App.tsx.
 *
 * `Num` handles unit conversion (mm ↔ inches) with a ≈ marker for rounded values.
 * `MmOnlySlot` marks fields that stay in mm regardless of display setting.
 */

import {
  displayBound,
  displayStep,
  fromDisplay,
  isExact,
  toDisplay,
  UNIT_SYMBOL,
  type Unit,
} from '../units';

type NumProps = {
  label: string;
  /** 🔴 MILLIMETRES when `unit` is given. The canonical value, never a display one. */
  value: number;
  /** 🔴 Receives MILLIMETRES when `unit` is given. Already converted; store it as-is. */
  onChange: (v: number) => void;
  /** In millimetres for a length; in the field's own unit otherwise. */
  step?: number;
  min?: number;
  max?: number;
  testid?: string;
  /** A number this field cannot change. See the Part X/Y call site: a field
   *  that accepts a value and moves nothing is this lane's most-repeated
   *  defect, and the only honest rendering of that state is a refusal. */
  disabled?: boolean;
  /** Why, when `disabled`. A greyed control with no reason reads as broken. */
  title?: string;
} & (
  | { unit: Unit; suffix?: never }
  | { suffix: string; unit?: never }
);

export function Num({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
  suffix,
  testid,
  disabled,
  title,
}: NumProps) {
  const isLength = unit !== undefined;
  const shown = isLength ? toDisplay(value, unit) : value;
  /* `≈` on an input's unit slot, not on its value — you cannot type `≈` into a
   * number box, and a marker that made the field unparseable would be a defect
   * dressed as a warning. */
  const rounded = isLength && Number.isFinite(value) && !isExact(value, unit);
  const slot = isLength ? UNIT_SYMBOL[unit] : suffix;
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <span className="numwrap">
        <input
          type="number"
          value={Number.isFinite(shown) ? shown : 0}
          step={isLength ? displayStep(step, unit) : step}
          min={isLength ? displayBound(min, unit, 'min') : min}
          max={isLength ? displayBound(max, unit, 'max') : max}
          disabled={disabled}
          data-testid={testid}
          data-rounded={rounded ? 'true' : undefined}
          onChange={(e) =>
            onChange(isLength ? fromDisplay(Number(e.target.value), unit) : Number(e.target.value))
          }
        />
        <em
          title={
            rounded
              ? `Shown rounded for an ${slot} display. This app is storing ${value} mm and will ` +
                `plan and cut that. Type here and what you type becomes the stored value.`
              : undefined
          }
        >
          {rounded ? `≈ ${slot}` : slot}
        </em>
      </span>
    </label>
  );
}

/**
 * The unit slot on a field that is **always millimetres**, whatever the display
 * setting says — TODO #109.
 *
 * 🔴 SEVEN FIELDS IN THE APP DO NOT FOLLOW THE UNIT SETTING, AND THE REASON IS
 *    STRUCTURAL RATHER THAN UNFINISHED
 *
 * They are the ones whose state is a **STRING whose empty value is
 * load-bearing** — the touch-plate top, the spoilboard's size, thickness and
 * corner, and the workpiece-edge tolerance. `''` there means **NOT DECLARED**,
 * which is a different fact from `0` and the one that makes the core refuse
 * rather than assume. That is why they are `type="text"` holding what the
 * operator typed instead of a number.
 *
 * **A unit conversion on a field that holds typed TEXT rewrites the box on every
 * keystroke.** Typing `0.5` in inches would go `"0"` → `0` → `0 mm` → the box
 * redisplays `0`, and the `.` is gone before the `5` arrives. Closing it needs an
 * uncommitted display buffer that converts on blur — a real change to a control
 * that also stamps the spoilboard's `assumed`/`entered` provenance, and one no
 * test on this box can exercise because there is no browser here.
 *
 * ⇒ **They stay in millimetres and they SAY SO ON THE NUMBER**, which is the
 * rule this feature is held to: while the display is not millimetres the slot
 * reads `mm ONLY`, so an operator cannot read one of these as an inch value by
 * forgetting a setting.
 */
export function MmOnlySlot({ unit }: { unit: Unit }) {
  return unit === 'mm' ? (
    <em>mm</em>
  ) : (
    <em
      className="warn"
      data-testid="mm-only-slot"
      title={
        'This field is always millimetres, whatever the display is set to. It accepts a blank — ' +
        'which means NOT DECLARED and is a different answer from 0 — so it holds what you type ' +
        'rather than a number, and converting typed text as you type it would eat the decimal ' +
        'point. Type millimetres here.'
      }
    >
      mm ONLY
    </em>
  );
}
