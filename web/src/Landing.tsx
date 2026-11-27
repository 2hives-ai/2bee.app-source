// Landing page — what a logged-out visitor sees on https://2bee.app/.
//
// Founder 2026-11-17 (relayed by ceo, ticket
// handover/2bee_app/2026-11-17-11-27-36-ceo-turn-cognito-login-on-plus-landing-page.md):
// "turn login on! create a landing page". Until then the only thing in front of
// the Cognito sign-in was a card with a button.
//
// Rendered by AuthGate for the `unauth` state ONLY. It never renders the app and
// it never decides who gets in: the gate's state machine is unchanged, and the
// one way forward from here is `onSignIn`, which is AuthGate's existing
// `login()` redirect into Cognito. `isAdmin()` still decides who reaches the app.
//
// 🔴 EVERY SENTENCE BELOW IS OUTWARD COPY, AND IT MUST STAY TRUE.
// Nothing this tool has produced has been cut on a router or printed by its own
// slicer (AGENTS.md § Scope). The status paragraph says so in plain words. Do
// not soften it into a feature claim; change it in the commit that climbs the
// rung, and name the evidence there.

interface LandingProps {
  onSignIn: () => void;
  /** Present only once the passkey server answered (AuthGate's probe). Absent: no button.
   *  Present: the Cognito "Sign in" buttons are NOT shown (2026-11-27). The passkey server
   *  answers only on the jamesave origin, whose CSP is `connect-src 'self'`, so the Cognito
   *  token exchange is blocked there: that button would take the user through the Cognito
   *  login and then fail. On CloudFront (and after a DNS rollback) the probe is 'absent',
   *  so the page shows Cognito as before. */
  onPasskey?: () => void;
  passkeyBusy?: boolean;
  passkeyMsg?: string;
}

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Pick a design',
    body:
      'Start from a design in the catalogue: a 3D part for the printer, or a flat ' +
      'part for the CNC router. The machine follows from the design.',
  },
  {
    n: '2',
    title: 'Change it with AI',
    body:
      'Describe the change in words. The model proposes settings, never machine ' +
      'code. The core re-plans the job and the checks run again on the result.',
  },
  {
    n: '3',
    title: 'Make it',
    body:
      'Before anything is sent, you get a short setup checklist for the person at ' +
      'the machine: which tool to fit, which workpiece to load, a clean build plate.',
  },
];

export default function Landing({ onSignIn, onPasskey, passkeyBusy = false, passkeyMsg = '' }: LandingProps) {
  return (
    <div className="landing" data-testid="landing">
      <header className="landing-top">
        <strong className="landing-brand">2bee.app</strong>
        {onPasskey ? (
          <button className="auth-gate-btn" onClick={onPasskey} type="button" disabled={passkeyBusy} data-testid="landing-passkey-top">
            Sign in with passkey
          </button>
        ) : (
          <button className="auth-gate-btn" onClick={onSignIn} type="button" data-testid="landing-signin-top">
            Sign in
          </button>
        )}
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <h1>From design to machine, in the browser.</h1>
          <p className="landing-lede">
            2bee.app prepares jobs for the CNC router and the 3D printer in the
            2bee.farm workshop. It turns a design into G-code, checks the program
            before it leaves, and tells the operator what to set up.
          </p>
          {onPasskey && (
            <button
              className="auth-gate-btn landing-cta"
              onClick={onPasskey}
              type="button"
              disabled={passkeyBusy}
              data-testid="landing-passkey"
            >
              {passkeyBusy ? 'Waiting for the passkey…' : 'Sign in with passkey'}
            </button>
          )}
          {!onPasskey && (
            <button className="auth-gate-btn landing-cta" onClick={onSignIn} type="button" data-testid="landing-signin">
              Sign in
            </button>
          )}
          {passkeyMsg && <p className="landing-note" role="status">{passkeyMsg}</p>}
          <p className="landing-note">Sign-in is for the 2bee.farm team.</p>
        </section>

        <figure className="landing-shot">
          <img
            src="/landing/app.png"
            alt="The 2bee.app home screen: pick a design, change it, make it."
            width={1280}
            height={800}
            loading="lazy"
          />
        </figure>

        <section className="landing-steps" aria-label="How it works">
          {STEPS.map((s) => (
            <div className="landing-step" key={s.n}>
              <span className="landing-step-n">{s.n}</span>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </div>
          ))}
        </section>

        <section className="landing-why">
          <h2>Why it exists</h2>
          <p>
            Our designs are generated from code and our machines run from G-code.
            The step between them was a person clicking through desktop software and
            saving a file nobody could compare with the last one. 2bee.app replaces
            that step. The same core runs in this page, on the command line and in
            the automated checks, so what is checked is what is sent.
          </p>
        </section>

        <section className="landing-status">
          <h2>Status</h2>
          <p>
            In development. Nothing made with 2bee.app has been cut on a router or
            printed by its own slicer yet. Its programs are checked by automated
            tests, not yet by a machine. Every job still needs a person at the
            machine.
          </p>
        </section>
      </main>

      {/* AGPL §13 source offer — moved here with the sign-in path, because this
          page is now the first thing an anonymous visitor meets. Same verified
          mirror URL as the card it replaces. */}
      <footer className="landing-foot auth-gate-licence">
        AGPL-3.0-or-later &middot;{' '}
        <a href="https://github.com/2hives-ai/2bee.app-source" rel="noreferrer">
          source
        </a>
      </footer>
    </div>
  );
}
