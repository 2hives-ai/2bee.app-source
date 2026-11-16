// The home page: what 2bee.app is, shown when the "2bee.app" name in the header
// is clicked (founder 2026-10-16: "Create a marketing landing page on home (when
// I click on the 2bee.app)").
//
// It is a VIEW like `make` and `cncjob`, not a tab in `TABS`.
//
// 🔴 THE COPY IS A DRAFT FOR `sales` + `brand`, who own outward words. Every line
// below was written against the lane's own records (AGENTS.md § Scope, setup.ts
// `sendBlocker`, cncjob/safety.ts) and says nothing the records do not hold:
// nothing made with this app has been cut, printed or placed, Send is switched off
// on the three-step screen, and the X2D path is upload only. If one of those
// changes, the sentence here that states it is now false and must change with it.
//
// 🔴 NO SOURCE URL IS WRITTEN HERE. The AGPL §13 offer is the footer's link, which
// stays on screen under this page; a second copy of the URL is a second thing to
// go stale.
//
// URL: `#home`. Entering pushes one history entry, so the browser's Back returns
// to the view the person came from (`onBack`). Leaving by any other route clears
// the hash in App's `setTab`.

import { useEffect, type ReactNode } from 'react';
// Styles: home.css, imported in main.tsx beside styles.css (it also styles the header's name button).

export const HOME_HASH = '#home';

export interface HomeProps {
  /** "Pick a design": the three-step screen, step 1. */
  onPickDesign: () => void;
  /** "Open the expert tools": the expert tabs. */
  onExpert: () => void;
  /** Browser Back from this page. */
  onBack: () => void;
}

/**
 * Open home when the address changes to `#home` without a reload (typed into the
 * address bar, a link on the page, or browser Forward back onto the home entry).
 * A fresh load is handled by `readStoredTab`.
 */
export function useHomeLink(open: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHash = () => {
      if (window.location.hash === HOME_HASH) open();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [open]);
}

/* ── Small line pictures, drawn in the theme's own colours ─────────────────── */

const Pic = ({ children, label }: { children: ReactNode; label: string }) => (
  <svg className="home-pic" viewBox="0 0 64 48" role="img" aria-label={label}>
    {children}
  </svg>
);

const PicDesign = () => (
  <Pic label="A grid of designs">
    <rect x="6" y="6" width="22" height="16" rx="2" />
    <rect x="36" y="6" width="22" height="16" rx="2" className="hl" />
    <rect x="6" y="28" width="22" height="16" rx="2" />
    <rect x="36" y="28" width="22" height="16" rx="2" />
  </Pic>
);

const PicChange = () => (
  <Pic label="A request and a changed part">
    <path d="M6 8h30a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H16l-6 5v-5H6a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z" />
    <rect x="34" y="26" width="24" height="16" rx="2" className="hl" />
    <path d="M44 26v-6" />
  </Pic>
);

const PicMake = () => (
  <Pic label="A checklist next to a machine">
    <path d="M6 10l3 3 5-6M6 22l3 3 5-6M6 34l3 3 5-6" className="hl" />
    <rect x="30" y="8" width="28" height="34" rx="2" />
    <path d="M30 18h28M44 18v14" />
  </Pic>
);

const PicRouter = () => (
  <Pic label="A CNC router">
    <path d="M6 40h52M10 40V12h44v28" />
    <path d="M10 18h44" />
    <rect x="28" y="18" width="8" height="12" className="hl" />
    <path d="M32 30v4" />
  </Pic>
);

const PicPrinter = () => (
  <Pic label="A 3D printer">
    <rect x="10" y="6" width="44" height="36" rx="3" />
    <path d="M16 34h32" />
    <path d="M24 34v-6h16v6" className="hl" />
    <path d="M30 14h4v6h-4z" />
  </Pic>
);

const PicBoard = () => (
  <Pic label="A circuit board">
    <rect x="8" y="8" width="48" height="32" rx="2" />
    <rect x="24" y="16" width="14" height="14" className="hl" />
    <path d="M14 14h4M14 22h4M14 30h4M44 14h6M44 22h6M44 30h6" />
  </Pic>
);

/* ── The page ─────────────────────────────────────────────────────────────── */

export default function Home({ onPickDesign, onExpert, onBack }: HomeProps) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    /* One entry, once: StrictMode mounts twice in development, and the second
     * mount finds the hash already set. */
    if (window.location.hash !== HOME_HASH) {
      window.history.pushState({ ...(window.history.state ?? {}), home: true }, '', HOME_HASH);
    }
    const onPop = () => {
      if (window.location.hash !== HOME_HASH) onBack();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onBack]);

  return (
    <main className="home" data-testid="home">
      <section className="home-hero" aria-labelledby="home-title">
        <p className="home-badge" data-testid="home-preview">
          Early preview. Nothing made with it has been cut, printed or placed yet.
        </p>
        <h1 id="home-title">Pick a design. Change it with AI. Make it.</h1>
        <p className="home-lede">
          2bee.app is a maker's workshop in the browser. It plans a design for a CNC router, a 3D printer or a
          pick-and-place machine.
        </p>
        <div className="home-cta">
          <button type="button" className="home-primary" onClick={onPickDesign} data-testid="home-pick">
            Pick a design
          </button>
          <button type="button" className="home-secondary" onClick={onExpert} data-testid="home-expert">
            Open the expert tools
          </button>
        </div>
      </section>

      <section className="home-section" aria-labelledby="home-steps">
        <h2 id="home-steps">Three steps</h2>
        <ol className="home-steps">
          <li className="home-card">
            <PicDesign />
            <h3>1. Design</h3>
            <p>Start from a design in the catalogue. Each one says whether it is cut or printed.</p>
          </li>
          <li className="home-card">
            <PicChange />
            <h3>2. Change with AI</h3>
            <p>
              Say what you want different, in plain words. An AI model proposes the edit, the app checks it, and you
              decide whether to keep it.
            </p>
          </li>
          <li className="home-card">
            <PicMake />
            <h3>3. Make</h3>
            <p>
              The app plans the job and gives you a short list of things to do first, like fitting a cutter or
              cleaning the build plate.
            </p>
          </li>
        </ol>
      </section>

      <section className="home-section" aria-labelledby="home-makes">
        <h2 id="home-makes">What it makes with</h2>
        <ul className="home-machines">
          <li className="home-card">
            <PicRouter />
            <h3>CNC router</h3>
            <p>2.5D cuts from flat designs, written as G-code for grblHAL controllers. It has not cut anything yet.</p>
          </li>
          <li className="home-card">
            <PicPrinter />
            <h3>3D printer</h3>
            <p>
              For the Bambu Lab X2D, upload only: you start the print on the printer itself. Slicing runs on
              2bee.app’s own engine, which has not printed yet: the first print is a calibration print.
            </p>
          </li>
          <li className="home-card">
            <PicBoard />
            <h3>PCB assembly</h3>
            <p>Shows a circuit board's parts in 3D and plans the feeder lanes. It does not drive a machine yet.</p>
          </li>
        </ul>
      </section>

      <section className="home-section home-trust" aria-labelledby="home-safety">
        <h2 id="home-safety">A person stays at the machine</h2>
        <ul>
          <li>The app checks the programs it writes before they can be sent. A check that cannot run says so. It never counts as a pass.</li>
          <li>Before anything is sent you get a setup checklist, and you tick each item yourself.</li>
          <li>On the router, a real cut needs an air cut of the same program first and your confirmation that you are standing at the machine.</li>
          <li>Nothing starts on its own. Sending from the three steps is switched off until the machines have been tested.</li>
        </ul>
      </section>

      <section className="home-section" aria-labelledby="home-source">
        <h2 id="home-source">Open source</h2>
        <p>
          2bee.app is free software under the AGPL-3.0-or-later licence. The source link is at the bottom of this
          page.
        </p>
      </section>
    </main>
  );
}
