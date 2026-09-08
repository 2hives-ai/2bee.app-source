/* =============================================================================
 * ONE RESIZE, FOR EVERY LIST IN THIS APP
 * =============================================================================
 *
 * Founder, 2026-08-11: *"able to resize the `Open one of these into the editor`
 * and all other lists vertically and horizontally"*.
 *
 * 🔴 THIS FILE EXISTS SO THERE IS ONE OF THESE AND NOT FIVE. A resize written
 * per list is five drags with five floors, five storage keys and five opinions
 * about what happens at the edge of the window — and the fifth one somebody adds
 * is the one that forgets the minimum on the second axis. This lane has spent
 * today finding copies that stopped agreeing with each other (a favicon, a set
 * of gate constants, a viewport path). This is the primitive; every list calls
 * it, nobody re-implements it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A CALLER ADOPTS IT — three lines, no edit to this file
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   const rz = useResizable({ id: 'cad-library-picker', enabled: open });
 *   ...
 *   <div ref={rz.ref} className="op-pop">   // must NOT be position: static
 *     ...your list...
 *     {rz.grips}                            // last child, so it paints on top
 *   </div>
 *
 * `id` is the identity the size is remembered under, so two lists never share a
 * size and a renamed list starts fresh rather than inheriting a stranger's box.
 * `enabled` is for surfaces that come and go (a dialog): the size is applied
 * when it turns true, which is the moment the element exists.
 *
 * A CENTRED dialog passes `anchor: 'center'` — see {@link sizeAfterDrag} for
 * why the pointer delta has to be doubled there, and what it looks like when it
 * is not.
 *
 * ⚠ IF A CALLER NEEDS THIS FILE CHANGED TO FIT IT, THE PRIMITIVE IS WRONG.
 * Everything a list can legitimately differ about — its floors, its identity,
 * its opening size, which axes it offers — is an option. Nothing here knows
 * what a tool, a drawing or a .scad file is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE DRAG DOES NOT GO THROUGH REACT STATE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A drag fires on every pointer move. `Viewport.tsx` had a defect where the
 * scene rebuilt on every render until the rebuild was keyed by value rather than
 * identity (20 renders became 1 rebuild) — and a resize that sets state on every
 * mousemove is exactly the input that defect was worst under. So the drag writes
 * `el.style.width` / `el.style.height` DIRECTLY and sets no state at all. React
 * hears about the new size once, on pointer-up, and only if the caller asked
 * (`onCommit`).
 *
 * That is not an optimisation to be undone later: it is the difference between a
 * drag and a stutter, and if it is ever moved into state the failure will look
 * like a graphics problem rather than a state problem.
 *
 * ⚠ THE CANVAS IS NOT RESIZED FROM HERE, AND MUST NOT BE. `Viewport.tsx` already
 * owns a `ResizeObserver` on its own container (it is what makes a window resize
 * work), and a second observer would be two things telling three.js its size. If
 * a resize here changes the canvas's box, that existing observer is the path it
 * travels; nothing in this file mentions three.js.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIZE IS KEPT, AND WHY NOT IN `SessionValues`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `localStorage`, under its own key, following `PANELS_KEY` in `App.tsx` (which
 * remembers which panels are open) and `REPORT_W_KEY` beside it. That precedent
 * is deliberate and the reasoning is theirs: `SessionValues` is the VALIDATED
 * blob — a field that fails its rule is dropped on restore and the operator is
 * TOLD which machining setting went. A dialog's width is chrome; no value of it
 * can produce a wrong part, and letting a corrupt chrome value contribute to a
 * "field dropped" banner about a machining setting would be a worse outcome than
 * forgetting the size.
 *
 * ⇒ `SESSION_VERSION` in `store.ts` DOES NOT MOVE for this change. Nothing is
 * added to `SessionValues`, no existing name changes meaning, and a build that
 * reads a session written before this feature existed reads exactly the same
 * fields it did yesterday. A bump would invalidate every stored session — and
 * make an operator re-enter machine travels — to record a fact `store.ts` never
 * holds. (The last bump in that file was made because a name's MEANING changed,
 * which is the case that genuinely requires one. This is the other case.)
 * ============================================================================= */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * `useLayoutEffect` in a browser, `useEffect` where there is no DOM.
 *
 * ⚠ Not a style preference. `web/tests/` renders these components with
 * `renderToStaticMarkup` and no jsdom; React warns on every `useLayoutEffect`
 * it sees there, and a suite that prints warnings on a passing run is a suite
 * whose warnings nobody reads. The layout timing matters only where there is
 * something to lay out.
 */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/* ── The numbers, in one place ─────────────────────────────────────────────── */

/** A list narrower than this cannot show a row name and a count on one line. */
export const DEFAULT_MIN_W = 280;
/**
 * 🔴 THE FLOOR THAT MAKES THIS RECOVERABLE. A box dragged to zero is a control
 * with no grip left to drag — the feature would delete itself the first time
 * somebody overshot, and the only way back would be clearing browser storage.
 * The floor is enforced on BOTH axes by the same expression, which is the whole
 * reason {@link clampSize} exists rather than two inline `Math.max` calls: an
 * asymmetry here (width floored, height not) is the easy thing to ship and it
 * looks fine until the one drag that finds it.
 */
export const DEFAULT_MIN_H = 160;

/** Kept off the window edge so the grip itself stays reachable. */
export const VIEWPORT_MARGIN = 16;

/** How far one arrow-key press moves an edge. */
export const KEY_STEP = 24;

export type Size = { w: number; h: number };

export type Bounds = { minW: number; minH: number; maxW: number; maxH: number };

/** Which edges may be dragged. */
export type ResizeAxis = 'both' | 'x' | 'y';

/**
 * Where the element is pinned while it grows.
 *
 * - `'topleft'` — ordinary in-flow box: its top-left stays put, so a pointer
 *   delta IS the size delta.
 * - `'center'` — a dialog centred with `transform: translate(-50%, -50%)`: it
 *   grows in BOTH directions, so the corner only moves half as far as the size.
 */
export type ResizeAnchor = 'topleft' | 'center';

/* ── Pure logic, exported because there is no browser on this box ──────────── */

/**
 * The one clamp. **Both axes, one expression** — see {@link DEFAULT_MIN_H}.
 *
 * 🔴 THE MINIMUM WINS OVER THE MAXIMUM when they cross. On a very short window
 * `maxH` can fall below `minH`, and the two orders give opposite answers: floor
 * last and the box stays usable and overflows the window a little; ceiling last
 * and it collapses to something smaller than its own header. Overflowing is
 * recoverable — the operator resizes the window — and collapsing is the state
 * this floor exists to prevent, so the floor is applied last.
 */
export function clampSize(s: Size, b: Bounds): Size {
  const w = Math.max(b.minW, Math.min(Math.round(s.w), b.maxW));
  const h = Math.max(b.minH, Math.min(Math.round(s.h), b.maxH));
  return { w, h };
}

/**
 * The size a drag asks for, before clamping.
 *
 * 🔴 `anchor: 'center'` DOUBLES THE DELTA, and this is not a fudge factor. A
 * dialog centred by `translate(-50%, -50%)` keeps its middle fixed: add 100px of
 * width and each edge moves out by 50. So dragging the corner 100px right must
 * add 200px of width for the corner to arrive under the pointer. Without it the
 * box tracks at half speed, the grip slides out from under the cursor, and it
 * reads as the drag being laggy or broken rather than as arithmetic.
 */
export function sizeAfterDrag(
  start: Size,
  dx: number,
  dy: number,
  axis: ResizeAxis,
  anchor: ResizeAnchor,
  b: Bounds
): Size {
  const k = anchor === 'center' ? 2 : 1;
  const w = axis === 'y' ? start.w : start.w + dx * k;
  const h = axis === 'x' ? start.h : start.h + dy * k;
  return clampSize({ w, h }, b);
}

/**
 * The bounds a size is held inside, measured from the WINDOW every time rather
 * than remembered.
 *
 * ⚠ It is re-measured at drag start and again on restore, because the window a
 * size was stored on is not the window it comes back on — a size dragged on a
 * 4K monitor and restored on a laptop would otherwise open a dialog whose foot
 * (the line that says what the search took away) is off the bottom of the
 * screen.
 */
export function viewportBounds(minW = DEFAULT_MIN_W, minH = DEFAULT_MIN_H): Bounds {
  const w = typeof window === 'undefined' ? Infinity : window.innerWidth - VIEWPORT_MARGIN * 2;
  const h = typeof window === 'undefined' ? Infinity : window.innerHeight - VIEWPORT_MARGIN * 2;
  return {
    minW,
    minH,
    maxW: Number.isFinite(w) && w > 0 ? w : minW,
    maxH: Number.isFinite(h) && h > 0 ? h : minH,
  };
}

/** One key shape, so a stored size can be found by hand and by a test. */
export function sizeKey(id: string): string {
  return `2bee.app.size.${id}`;
}

/**
 * Read a remembered size.
 *
 * `null` for every unhappy path — never seen, storage disabled, hand-edited,
 * half a pair, a string that parses as a number, `Infinity` out of a JSON that
 * cannot hold it. A caller that gets `null` opens at its own default, which is
 * the same thing that happens on a first visit, so there is no state in which
 * the app is broken by what is in storage.
 */
export function readStoredSize(id: string): Size | null {
  try {
    const raw = localStorage.getItem(sizeKey(id));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { w, h } = v as { w?: unknown; h?: unknown };
    if (typeof w !== 'number' || typeof h !== 'number') return null;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w: Math.round(w), h: Math.round(h) };
  } catch {
    return null;
  }
}

/**
 * Remember a size. A failure here is silent BY DESIGN — a browser with storage
 * disabled gets a resize that works for this session and is forgotten, which is
 * strictly better than a resize that refuses to work at all.
 */
export function writeStoredSize(id: string, s: Size): void {
  try {
    localStorage.setItem(sizeKey(id), JSON.stringify({ w: Math.round(s.w), h: Math.round(s.h) }));
  } catch {
    /* not remembered; the drag still worked. */
  }
}

/** For tests and for a caller that wants a "reset to default" control. */
export function forgetStoredSize(id: string): void {
  try {
    localStorage.removeItem(sizeKey(id));
  } catch {
    /* nothing to do: it is already not remembered. */
  }
}

/* ── The hook ──────────────────────────────────────────────────────────────── */

export type UseResizableOptions = {
  /** Identity the size is remembered under. Stable across renders. */
  id: string;
  /** Apply and offer the grips only while this is true (a dialog's `open`). */
  enabled?: boolean;
  axis?: ResizeAxis;
  anchor?: ResizeAnchor;
  minWidth?: number;
  minHeight?: number;
  /**
   * The size this surface OPENS at when nothing is remembered. Measured, not
   * typed: the picker reads the 3D canvas's own box here, because a pixel
   * constant would be a second copy of a dimension the layout already owns.
   *
   * ⚠ A REMEMBERED SIZE WINS OVER THIS. The opening size is about the first
   * time; overriding a size somebody deliberately dragged would be the control
   * forgetting what it was told.
   */
  initial?: () => Size | null;
  /** Called once, on pointer-up / key-up, with the committed size. */
  onCommit?: (s: Size) => void;
};

export type Resizable = {
  ref: RefObject<HTMLDivElement>;
  /** Render as the LAST child of the element `ref` is on. */
  grips: ReactNode;
};

export function useResizable(opts: UseResizableOptions): Resizable {
  const {
    id,
    enabled = true,
    axis = 'both',
    anchor = 'topleft',
    minWidth = DEFAULT_MIN_W,
    minHeight = DEFAULT_MIN_H,
    initial,
    onCommit,
  } = opts;

  useResizableStyles();

  const ref = useRef<HTMLDivElement>(null);
  /* The live drag. A ref rather than state: nothing here may re-render. */
  const drag = useRef<{
    pointerId: number;
    axis: ResizeAxis;
    startX: number;
    startY: number;
    from: Size;
    bounds: Bounds;
    target: HTMLElement;
  } | null>(null);

  const bounds = useCallback(() => viewportBounds(minWidth, minHeight), [minWidth, minHeight]);

  /** Write a size onto the element. The ONLY place that touches its box. */
  const apply = useCallback((el: HTMLElement, s: Size) => {
    el.style.width = `${s.w}px`;
    el.style.height = `${s.h}px`;
    /* 🔴 THE INLINE CEILINGS ARE PART OF APPLYING A SIZE, NOT DECORATION.
     *
     * A stylesheet cap (`.op-pop` shipped `max-height: min(70vh, 720px)`) beats
     * an inline `height`, so a restored size taller than the cap comes back
     * SILENTLY SHRUNK — and then the next commit stores the shrunken value, so
     * the operator's choice is not merely ignored, it is overwritten. That is a
     * size that does not survive a reload, which is exactly the failure this
     * feature is for. Raising the ceiling to the value already clamped by the
     * window keeps the cap's real job (staying on screen) and removes its
     * ability to argue with a deliberate drag. */
    el.style.maxWidth = `${s.w}px`;
    el.style.maxHeight = `${s.h}px`;
    /* The floors live in one place — here — so CSS and JS cannot disagree about
     * how small is too small. */
    el.style.minWidth = '0px';
    el.style.minHeight = '0px';
  }, []);

  /* Restore (or open at) the size. `useLayoutEffect` so it is in place before
   * the browser paints — applying it after would show the default box for one
   * frame, which reads as the dialog jumping. */
  useIsoLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    /* Grips are absolutely positioned against this element, so a `static` parent
     * would anchor them to whatever ancestor is positioned instead — grips in
     * the wrong place, on the wrong box, silently. Fixed up rather than
     * documented as a caller's duty: the failure is invisible in review. */
    if (typeof getComputedStyle === 'function' && getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
    const stored = readStoredSize(id);
    const seed = stored ?? initial?.() ?? null;
    if (seed) apply(el, clampSize(seed, bounds()));
    // `initial` is a fresh closure every render by construction (it measures the
    // DOM); depending on it would re-seed on every render and fight the drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id, apply, bounds]);

  const finish = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    d.target.classList.remove('rz-dragging');
    const el = ref.current;
    if (!el) return;
    const s = { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
    const c = clampSize(s, d.bounds);
    writeStoredSize(id, c);
    onCommit?.(c);
  }, [id, onCommit]);

  const onPointerDown = useCallback(
    (a: ResizeAxis) => (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      /* Only the primary button, and never a second drag on top of a live one. */
      if (e.button !== 0 || drag.current) return;
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const target = e.currentTarget;
      target.setPointerCapture?.(e.pointerId);
      target.classList.add('rz-dragging');
      drag.current = {
        pointerId: e.pointerId,
        axis: a,
        startX: e.clientX,
        startY: e.clientY,
        from: { w: r.width, h: r.height },
        bounds: bounds(),
        target,
      };
    },
    [bounds]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el || e.pointerId !== d.pointerId) return;
      /* 🔴 NO setState ON THIS PATH. See the header. */
      apply(el, sizeAfterDrag(d.from, e.clientX - d.startX, e.clientY - d.startY, d.axis, anchor, d.bounds));
    },
    [anchor, apply]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.target.releasePointerCapture?.(e.pointerId);
      finish();
    },
    [finish]
  );

  /**
   * Arrow keys on a focused grip.
   *
   * Not a nicety: a pointer drag is the only way to reach this feature
   * otherwise, and this app is used one-handed next to a machine. It is also the
   * only route a driver can take without synthesising a pointer gesture.
   */
  const onKeyDown = useCallback(
    (a: ResizeAxis) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowRight') dx = KEY_STEP;
      else if (e.key === 'ArrowLeft') dx = -KEY_STEP;
      else if (e.key === 'ArrowDown') dy = KEY_STEP;
      else if (e.key === 'ArrowUp') dy = -KEY_STEP;
      else return;
      if (a === 'x' && dy !== 0) return;
      if (a === 'y' && dx !== 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const b = bounds();
      /* `'topleft'` regardless of the surface's anchor: a key press is a request
       * for a SIZE step, not for an edge to follow a pointer, so the doubling
       * that keeps a grip under the cursor would make every press move twice as
       * far as the one before it suggested. */
      const s = sizeAfterDrag({ w: r.width, h: r.height }, dx, dy, a, 'topleft', b);
      apply(el, s);
      writeStoredSize(id, s);
      onCommit?.(s);
    },
    [apply, bounds, id, onCommit]
  );

  /* A pointer that goes away without an up (the tab is hidden, the browser eats
   * the capture) must not leave a drag latched — the next click would resize. */
  useEffect(() => {
    if (!enabled) return;
    const cancel = () => {
      if (drag.current) finish();
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [enabled, finish]);

  const grip = (a: ResizeAxis, cls: string, label: string, testid: string): ReactNode => (
    <div
      key={cls}
      className={`rz-grip ${cls}`}
      data-testid={testid}
      role="separator"
      aria-orientation={a === 'y' ? 'horizontal' : 'vertical'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown(a)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown(a)}
    />
  );

  const grips: ReactNode = !enabled ? null : (
    <>
      {axis !== 'y' && grip('x', 'rz-grip-x', `resize ${id} horizontally`, `${id}-resize-x`)}
      {axis !== 'x' && grip('y', 'rz-grip-y', `resize ${id} vertically`, `${id}-resize-y`)}
      {axis === 'both' && grip('both', 'rz-grip-xy', `resize ${id}`, `${id}-resize`)}
    </>
  );

  return { ref, grips };
}

/* ── The grips' own CSS ────────────────────────────────────────────────────────
 *
 * Injected once, next to the component, on the `ObjectPicker` precedent: this is
 * a self-contained primitive and its handles have no meaning anywhere else, so
 * putting them in `styles.css` would be three rules a reader of that file cannot
 * account for.
 *
 * 🔴 NO BACKTICKS ANYWHERE IN THIS STRING. It is a template literal, and one
 * backtick ends the CSS and turns the rest into TypeScript. `ObjectPicker.tsx`
 * records that happening twice.
 * -------------------------------------------------------------------------- */

const RZ_CSS = `
.rz-grip {
  position: absolute; z-index: 2; touch-action: none;
  background: transparent;
}
/* 🔴 6px, AND THE REASON IS A HAZARD NOBODY HAS BEEN ABLE TO LOOK AT.
   The right edge of a list dialog is also where that list's SCROLLBAR is, so an
   edge grip and a scrollbar compete for the same pixels. 6px leaves most of a
   ~15px scrollbar clear; wider would take it. This has NOT been checked in a
   browser — there is none on this box — so it is written down as a tradeoff
   that was chosen, not as one that was measured. The corner grip is the one
   drawn and the one to reach for; the edges are the single-axis convenience. */
.rz-grip-x { top: 0; right: 0; width: 6px; height: 100%; cursor: ew-resize; }
.rz-grip-y { left: 0; bottom: 0; height: 6px; width: 100%; cursor: ns-resize; }
/* The corner wins where the three overlap, so a diagonal drag is what you get
   when you aim at the corner. */
.rz-grip-xy { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 3; }
/* The only one that is drawn: a grip nobody can find is a feature that is not
   there. The edges stay invisible until hovered so they do not read as borders. */
.rz-grip-xy::after {
  content: ''; position: absolute; right: 3px; bottom: 3px; width: 9px; height: 9px;
  border-right: 2px solid var(--line); border-bottom: 2px solid var(--line);
}
.rz-grip:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.rz-grip-xy:hover::after { border-color: var(--accent); }
/* Keyboard users get the same affordance the pointer gets, plus a ring. */
.rz-grip:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.rz-grip.rz-dragging { background: color-mix(in srgb, var(--accent) 32%, transparent); }
`;

let rzStylesInstalled = false;

function useResizableStyles(): void {
  useEffect(() => {
    if (rzStylesInstalled) return;
    if (typeof document === 'undefined') return;
    rzStylesInstalled = true;
    const el = document.createElement('style');
    el.dataset.rz = 'resizable';
    el.textContent = RZ_CSS;
    document.head.appendChild(el);
  }, []);
}
