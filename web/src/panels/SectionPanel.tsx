/**
 * Section panel components — extracted from App.tsx.
 *
 * `EyeIcon` — the eye SVG glyph for show/hide controls.
 * `SectionEye` — tri-state eye button for section headers.
 * `Section` — collapsible panel with persistent open/closed state.
 */

import { useState } from 'react';
import { SectionHeadingContext, labelRepeatsHeading } from '../ObjectPicker';
import type { Layer } from '../Viewport';
import { LAYER_LABEL } from '../Viewport';
import { storedPanelOpen, rememberPanelOpen } from './panelPersistence';

export function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      <path
        d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="8" cy="8" r="2" fill={open ? 'currentColor' : 'none'} stroke="currentColor" />
      {/* The slash is what says HIDDEN. Two strokes so it reads against the
          eye's own outline at this size — a light one over a dark one. */}
      {!open && (
        <>
          <path d="M2.2 13.8 13.8 2.2" stroke="var(--panel)" strokeWidth="2.6" />
          <path d="M2.2 13.8 13.8 2.2" stroke="currentColor" strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}

/**
 * 🔴 THE SECTION HEADER'S EYE — founder, 2026-08-11, and the header is where it
 * has to be rather than a matter of taste. Sections COLLAPSE, and `Verification`
 * is `defaultOpen={false}`: an eye inside the body is unreachable in the state
 * the app starts in, so the one control that must always work is this one.
 *
 * 🔴 IT IS NOT INSIDE THE COLLAPSE BUTTON. A `<button>` inside a `<button>` is
 * invalid HTML and the click would toggle both — you would open the panel every
 * time you hid its layer, which is the obvious bug in this change and would feel
 * broken immediately. The header is a ROW holding two sibling buttons.
 *
 * Tri-state, because a section can own several layers: `aria-pressed` takes
 * `mixed` for a section with some shown and some hidden, and the count is on
 * screen — a group control that renders "off" while two of its six layers are
 * still drawn would be lying about the picture.
 */
export function SectionEye({
  testid,
  section,
  live,
  layers,
  onSet,
}: {
  testid: string;
  section: string;
  live: Layer[];
  layers: Record<Layer, boolean>;
  onSet: (ks: Layer[], on: boolean) => void;
}) {
  const shown = live.filter((k) => layers[k]);
  const all = shown.length === live.length;
  const none = shown.length === 0;
  /* TODO #77, one element further along. A layer whose label IS this section's
     title contributes nothing here — on `Workpiece` the tooltip read
     *"Workpiece — view layers: workpiece"*. Dropped by the SAME comparison
     `ObjectPicker` uses, so `Tool` still survives under `Tooling` and
     `spoilboard (sacrificial material)` still survives under `Spoilboard`,
     because that one carries a fact the heading does not. When the drop empties
     the list the clause goes with it rather than leaving a dangling colon. */
  const names = live
    .map((k) => LAYER_LABEL[k])
    .filter((n) => !labelRepeatsHeading(n, section))
    .join(', ');
  return (
    <button
      type="button"
      className="eye"
      data-testid={testid}
      aria-pressed={all ? 'true' : none ? 'false' : 'mixed'}
      aria-label={`${section} view layers`}
      title={
        `${section} — view layers${names ? `: ${names}` : ''}. ` +
        (all
          ? 'All shown; this hides them.'
          : none
            ? 'All hidden; this shows them.'
            : `${shown.length} of ${live.length} shown; this shows the rest.`) +
        ' It changes the PICTURE only — the program, the checks and the simulation are unaffected by what is on screen.'
      }
      /* 🔴 FROM `mixed`, THIS SHOWS — IT DOES NOT HIDE. Only the all-shown state
         hides. A user staring at a partly-emptied picture has usually lost track
         of what they switched off, and the thing they want one click away is it
         BACK; a mixed control that hides the remainder answers a question nobody
         asked and takes more information off a screen that people judge a
         cutting job from. Hiding stays available — it is one more click, from
         the all-shown state this lands them in.

         ⚠ ONE RULE FOR BOTH EYES. The global eye above `panel-machine` is this
         same component, and two eyes an inch apart resolving `mixed` in opposite
         directions would be worse than either rule on its own. */
      onClick={() => onSet(live, !all)}
    >
      {/* Only when mixed. A count beside a plain on/off state is noise; a
          missing count on a mixed state is the group control claiming to be
          something it is not.

          🔴 THE COUNT LEADS AND THE GLYPH TRAILS — founder, 2026-08-11:
          *"change from (eye) 9/10 to 9/10 (eye), have the eye in the same
          column as the others"*. The glyph is the last thing in every eye,
          mixed or not, so it lands in one column down the whole sidebar; a
          count printed before it pushes the glyph out of that column unless the
          glyph is last. This ordering is what makes `.eye-slot` a column rather
          than a coincidence — nine controls that line up read as one control at
          nine scopes, which is exactly what they are. */}
      {!all && !none ? (
        <span className="eye-count">
          {shown.length}/{live.length}
        </span>
      ) : null}
      <EyeIcon open={!none} />
    </button>
  );
}

/**
 * A collapsible panel.
 *
 * 🔴 ITS OPEN/CLOSED STATE SURVIVES A REFRESH, and the persistence lives in the
 * COMPONENT rather than in eight call sites. The founder asked for *"all menus"*,
 * and the failure mode of threading a prop through every `<Section>` is the
 * thirteenth one that nobody remembers to wire — a panel that quietly does not
 * remember, indistinguishable from one the user left open. Keying on `testid`
 * makes every present and future section persist by construction.
 *
 * ⚠ A `<Section>` with no `testid` is not remembered — `storedPanelOpen` and
 * `rememberPanelOpen` both no-op on `undefined`. Every section in this app has
 * one; this is what happens if one ever does not, and it is a lost preference
 * rather than a crash.
 */
export function Section({
  title,
  children,
  defaultOpen = true,
  testid,
  eye,
  layerRows,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  testid?: string;
  /** The header's show/hide control. Rendered OUTSIDE the collapse button. */
  eye?: React.ReactNode;
  /** Per-layer controls, at the foot of the body. */
  layerRows?: React.ReactNode;
  /**
   * 🔴 WHAT THE HEADER SAYS WHILE THE BODY IS SHUT — and the reason this prop
   * exists at all. Persisting the collapsed state removes an accident that was
   * doing real work: a refresh used to re-open `Notes and warnings`, so a
   * collapsed warnings panel could only hide a warning until the next reload.
   * Sticky state removes that floor — collapse it once and tomorrow's program
   * can carry three warnings the operator has never seen, on a screen that looks
   * EXACTLY like a program with none.
   *
   * So a section that is hiding something has to say it is hiding something,
   * from the header, with nothing to open. This is the same rule the canvas's
   * `hidden-indicator` follows for the view layers, and it is the price of the
   * founder's instruction rather than an argument against it.
   */
  badge?: { text: string; tone: 'bad' | 'warn' | 'muted' } | null;
}) {
  // Seeded ONCE from the store, per mount. A conditionally rendered section
  // (`panel-notes` exists only while a report carries notes) re-reads it when it
  // comes back, which is what makes its preference survive a report with none.
  const [open, setOpen] = useState(() => storedPanelOpen(testid) ?? defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    rememberPanelOpen(testid, next);
  };
  return (
    <section className="panel" data-testid={testid}>
      {/* 🔴 The eye is a SIBLING of the collapse button, never a child of it.
          Nested buttons are invalid HTML and one click would do both jobs —
          opening the panel every time somebody hid its layer. As siblings there
          is nothing to bubble into: pressing the eye cannot toggle the section
          and therefore cannot write the stored open/closed state either.

          The slot is rendered whether or not there is an eye in it, so the
          chevrons line up down the sidebar. A panel that owns no live layer
          shows NOTHING here — see `sectionEye()` for why an empty slot rather
          than a disabled eye. */}
      <div className="panel-head-row">
        <button className="panel-head" onClick={toggle} aria-expanded={open}>
          <span className="panel-title">
            {title}
            {/* 🔴 WHILE SHUT ONLY — 2026-08-11, and it is the prop's own doc
                block above being applied rather than a new rule: this exists to
                say what the header is HIDING. Open, `Notes and warnings
                [2 warnings · 1 note]` sat directly over the two warnings and the
                note, and `Simulation [2 findings]` directly over the rows that
                are red — a count of a list the operator is looking at.

                ⚠ Nothing computes from it; the consumers pass a `badge` and read
                nothing back. If a future caller needs a count VISIBLE while
                open, that is a different control and it needs its own reason —
                not this one widened.

                ⚠ THIS SAID "the three consumers" until 2026-08-12 and there are
                now four — `panel-spoilboard` joined `panel-notes` and
                `panel-sim`. A count of the callers, written into the callee, is a
                fact with nothing watching it; the sentence is about the CONTRACT
                and does not need the census. */}
            {!open && badge ? (
              <span className={`badge badge-${badge.tone}`} data-testid={testid ? `${testid}-badge` : undefined}>
                {badge.text}
              </span>
            ) : null}
          </span>
          <span className="chev">{open ? '−' : '+'}</span>
        </button>
        <span className="eye-slot">{eye}</span>
      </div>
      {open && (
        /* 🔴 TODO #77, founder 2026-08-11: *"most of the menus having the
         * header, then the header repeats … remove the duplicates from
         * everywhere."* The heading is PUBLISHED here rather than being switched
         * off at each call site, so *"do not print a visible label that repeats
         * my heading"* is one rule that also covers the next panel somebody
         * adds. `ObjectPicker` decides — it owns the label and it owns the
         * accessible name that must survive; this only tells it what the heading
         * above it says. */
        <SectionHeadingContext.Provider value={title}>
          <div className="panel-body">
            {children}
            {layerRows}
          </div>
        </SectionHeadingContext.Provider>
      )}
    </section>
  );
}
