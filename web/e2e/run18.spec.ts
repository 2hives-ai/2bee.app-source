import { test, expect, chromium } from '@playwright/test';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';

/*
 * RUN-18 — throughput survives document.visibilityState === 'hidden'.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES, AND AGAINST WHAT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The REAL, UNMODIFIED `src/run/streamer.worker.ts`, loaded through a TEST-ONLY
 * worker entry (`e2e/run18/streamer-fake.worker.ts`) that prepends a fake
 * `navigator.serial` (`e2e/run18/install-fake-serial.ts` →
 * `e2e/run18/fake-serial-port.ts`, an adapter over `src/run/fake.ts`). The
 * product ships byte-identical: nothing in `src/` references the entry, and the
 * built bundle this suite's other tests run against does not contain it. This
 * spec therefore runs against the vite DEV server, which transforms and serves
 * the entry and its import chain — the one bundler question this mechanism
 * depended on, answered empirically 2026-08-28: vite dev serves it.
 *
 * 🔴 THE TRANSPORT IS `fake.ts` — THIS LANE'S OWN MODEL OF grblHAL. A green
 * here says the I/O-driven pump design survives a hidden tab in a real browser.
 * It says nothing about a machine. CTRL and the physical rungs say that.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY RAW CDP, A SELF-STARTED Xvfb, AND NO PLAYWRIGHT BROWSER FIXTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three environment facts, each measured on 2026-08-28:
 *
 * 1. HEADLESS NEVER HIDES. chromium-headless-shell AND full chromium
 *    `--headless=new` report `visible` for every page, before and after
 *    `bringToFront()` on a second page. CDP `Page.setWebLifecycleState` in this
 *    build accepts only 'active'/'frozen' — and frozen STOPS execution, which
 *    is not the condition under test.
 *
 * 2. PLAYWRIGHT'S ATTACH EMULATES FOCUS. With Playwright driving (launch or
 *    connectOverCDP), every page reports `visible` AND `hasFocus() === true`
 *    simultaneously, so a backgrounded tab is indistinguishable from a front
 *    one. Over a RAW CDP WebSocket the same tab switch reports `hidden` and a
 *    100 ms interval degrades from ~20 to ~3 ticks per 2 s — real hidden, real
 *    timer throttling. So this spec talks CDP itself.
 *
 * 3. PLAYWRIGHT'S DEFAULT ARGS DISABLE THE BEHAVIOUR UNDER TEST.
 *    `--disable-background-timer-throttling`,
 *    `--disable-backgrounding-occluded-windows` and
 *    `--disable-renderer-backgrounding` are in its default set. Chromium is
 *    spawned here by hand with none of them.
 *
 * Also measured 2026-08-28: Chrome on ozone/x11 does NOT hide a page on window
 * minimize (`_NET_WM_STATE_HIDDEN` set, `visibilityState` still `visible`) —
 * the mechanism that works is a second TAB in the same window, activated over
 * `Target.activateTarget`. And 🔴 `WAYLAND_DISPLAY` is scrubbed from the child
 * environment: with it set, Chromium prefers Wayland, and wayland-0 on this box
 * is the founder's desktop — a headed test window opened THERE once already
 * during this investigation.
 *
 * The display is a FRESH Xvfb on the first free number from :102 up — never
 * :87/:99/:100/:101 (other lanes), never :0/:1. Torn down in `finally`.
 */

const DEV = `http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`;
const WORKER_URL = '/e2e/run18/streamer-fake.worker.ts';
/* ~1.5 MB of program per leg: at the measured ~1.2-1.5 MB/s this is a ~10 s
 * leg — long enough to read the instrument, short enough for a suite. */
const LINES = 1_000_000;

function have(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freeDisplay(): number {
  const taken = new Set(
    readdirSync('/tmp/.X11-unix')
      .map((f) => /^X(\d+)$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  let d = 102;
  while (taken.has(d)) d++;
  return d;
}

class RawCdp {
  private ws!: WebSocket;
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async connect(port: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    let version: { webSocketDebuggerUrl: string } | null = null;
    while (Date.now() < deadline) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!version) throw new Error(`chromium CDP on :${port} never answered`);
    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
    await new Promise<void>((r) => this.ws.addEventListener('open', () => r()));
  }

  call<T = Record<string, never>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ ...(sessionId ? { sessionId } : {}), id, method, params }));
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('RUN-18', () => {
  test('RUN-18 — throughput survives document.visibilityState === "hidden" (test-only worker entry, zero product change)', async () => {
    test.setTimeout(300_000);
    test.skip(!have('Xvfb') || !have('openbox'), 'RUN-18 needs Xvfb + openbox for a REAL hidden page; headless chromium cannot produce one (measured 2026-08-28)');

    const disp = freeDisplay();
    const cdpPort = 9000 + disp;
    const profile = `/tmp/run18-profile-${disp}`;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${disp}` };
    delete childEnv.WAYLAND_DISPLAY;
    delete childEnv.XDG_SESSION_TYPE;

    const kids: ChildProcess[] = [];
    const procs = { xvfb: null as ChildProcess | null, wm: null as ChildProcess | null, chrome: null as ChildProcess | null };
    try {
      procs.xvfb = spawn('Xvfb', [`:${disp}`, '-screen', '0', '1280x800x24'], { env: childEnv, stdio: 'ignore' });
      kids.push(procs.xvfb);
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${disp}`); i++) await sleep(200);
      if (!existsSync(`/tmp/.X11-unix/X${disp}`)) throw new Error(`Xvfb :${disp} never came up`);

      procs.wm = spawn('openbox', [], { env: childEnv, stdio: 'ignore' });
      kids.push(procs.wm);
      await sleep(1000);

      /* Raw chromium: NO playwright default args (they disable the throttling
       * under test), X11 forced, Wayland scrubbed above. */
      procs.chrome = spawn(
        chromium.executablePath(),
        [
          '--no-sandbox',
          '--no-first-run',
          '--ozone-platform=x11',
          `--remote-debugging-port=${cdpPort}`,
          `--user-data-dir=${profile}`,
          '--window-size=1100,700',
          'about:blank',
        ],
        { env: childEnv, stdio: 'ignore' },
      );
      kids.push(procs.chrome);

      const cdp = new RawCdp();
      await cdp.connect(cdpPort);

      const { targetId: tab1 } = await cdp.call<{ targetId: string }>('Target.createTarget', { url: DEV, newWindow: false });
      const { sessionId: s1 } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId: tab1, flatten: true });
      const eval1 = async <T>(expression: string, awaitPromise = false): Promise<T> => {
        const r = await cdp.call<{ result: { value: T }; exceptionDetails?: unknown }>(
          'Runtime.evaluate',
          { expression, awaitPromise, returnByValue: true },
          s1,
        );
        if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };

      for (let i = 0; i < 60; i++) {
        const ready = await eval1<boolean>(`location.origin === ${JSON.stringify(DEV)} && document.readyState !== 'loading'`).catch(() => false);
        if (ready) break;
        await sleep(500);
      }

      /* The harness: the test-only worker entry, counters only — two million
       * 'sent' events per leg are NOT hoarded. The throughput read at 'done' is
       * event-driven, never timer-driven, so it works identically hidden. */
      await eval1(`(() => {
        const c = { attached: false, failed: null, stalls: 0, done: null, doneThroughput: null, streamState: null, awaitingTput: false };
        const worker = new Worker(${JSON.stringify(WORKER_URL)}, { type: 'module' });
        worker.addEventListener('message', (e) => {
          const d = e.data;
          if (d.t === 'attached') c.attached = true;
          if (d.t === 'attach-failed') c.failed = d.error;
          if (d.t === 'stall') c.stalls += 1;
          if (d.t === 'stream') { c.streamState = d.state; if (d.state === 'done' && !c.done) { c.done = { sent: d.sent, total: d.total }; c.awaitingTput = true; worker.postMessage({ t: 'throughput' }); } }
          if (d.t === 'throughput' && c.awaitingTput) { c.awaitingTput = false; c.doneThroughput = d; }
        });
        window.__run18 = { worker, c };
        return true;
      })()`);

      await eval1(`window.__run18.worker.postMessage({ t: 'attach', portIndex: 0, baudRate: 115200 }), true`);
      let attached = false;
      for (let i = 0; i < 40 && !attached; i++) {
        const st = await eval1<{ a: boolean; f: unknown }>(`({ a: window.__run18.c.attached, f: window.__run18.c.failed })`);
        if (st.f) throw new Error('attach refused by the REAL worker: ' + JSON.stringify(st.f));
        attached = st.a;
        if (!attached) await sleep(250);
      }
      expect(attached, 'the unmodified streamer.worker attached through the test-only fake-serial entry').toBe(true);

      const runLeg = async (label: string) => {
        await eval1(`(() => {
          const c = window.__run18.c;
          c.done = null; c.doneThroughput = null; c.stalls = 0;
          const lines = Array.from({ length: ${LINES} }, (_, i) => 'G1 X' + ((i % 40) + 1) + '.000 F2000');
          window.__run18.worker.postMessage({ t: 'load', lines, mode: 'character-counting', rxBufferSize: 1024 });
          window.__run18.worker.postMessage({ t: 'start' });
          return true;
        })()`);
        const t0 = Date.now();
        for (;;) {
          const st = await eval1<{ t: { bytes: number; ms: number } | null; state: string; stalls: number }>(
            `({ t: window.__run18.c.doneThroughput, state: window.__run18.c.streamState, stalls: window.__run18.c.stalls })`,
          );
          if (st.t) return { ...st.t, bps: (st.t.bytes * 1000) / st.t.ms, stalls: st.stalls, wallMs: Date.now() - t0 };
          if (st.state === 'aborted') throw new Error(`${label}: stream aborted`);
          if (Date.now() - t0 > 120_000) throw new Error(`${label}: stream did not finish in 120 s (state=${st.state})`);
          await sleep(400);
        }
      };

      /* ── leg A: visible ── */
      expect(await eval1(`document.visibilityState`)).toBe('visible');
      const visible = await runLeg('visible');
      console.log(`RUN-18 leg A (visible): ${visible.bytes} B in ${visible.ms} ms = ${visible.bps.toFixed(0)} B/s, stalls=${visible.stalls}`);

      /* ── leg B: hidden, VERIFIED, never assumed ── */
      const { targetId: tab2 } = await cdp.call<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: false });
      await cdp.call('Target.activateTarget', { targetId: tab2 });
      await sleep(1200);
      const visNow = await eval1<string>(`document.visibilityState`);
      expect(visNow, 'the hidden leg must be measured with the page ACTUALLY hidden — a visible page measured as hidden is how RUN-18 stays fake').toBe('hidden');

      /* The context this branch exists for: page timers must actually be
       * throttled here, or "hidden" is a label and not the condition. */
      const ticks = await eval1<number>(
        `new Promise(r => { let n = 0; const t = setInterval(() => n++, 100); setTimeout(() => { clearInterval(t); r(n); }, 2000); })`,
        true,
      );
      console.log(`RUN-18 hidden-page timer check: ${ticks} ticks/2s (visible ≈ 20)`);
      expect(ticks, 'page timers were NOT throttled — the hidden leg was not the condition under test').toBeLessThanOrEqual(8);

      const hidden = await runLeg('hidden');
      console.log(`RUN-18 leg B (hidden):  ${hidden.bytes} B in ${hidden.ms} ms = ${hidden.bps.toFixed(0)} B/s, stalls=${hidden.stalls}`);

      await cdp.call('Target.activateTarget', { targetId: tab1 });
      await sleep(500);

      const ratio = hidden.bps / visible.bps;
      console.log(
        `RUN-18 RESULT visible=${visible.bps.toFixed(0)} B/s hidden=${hidden.bps.toFixed(0)} B/s ratio=${ratio.toFixed(3)} ` +
          `stalls=${visible.stalls}+${hidden.stalls} — TRANSPORT: FAKE grblHAL (persona=healthy, rx=1024B, autoExecute) ` +
          'through a test-only worker entry; NOT A MACHINE: this proves the I/O-driven pump survives a hidden tab in a real browser, nothing about a controller',
      );

      /* The failure this branch exists for is a COLLAPSE — the stall watchdog
       * firing, or throughput dropping to the throttled-timer floor. A hidden
       * leg within half the visible rate is not a collapse (measured 2026-08-28:
       * ratio 0.771 — the ~23% is the hidden page's event loop being deprioritised,
       * not the pump stalling). */
      expect(hidden.stalls, 'the stall watchdog fired during the hidden leg — the exact failure RUN-18 guards').toBe(0);
      expect(visible.stalls).toBe(0);
      expect(ratio).toBeGreaterThan(0.5);
    } finally {
      for (const k of kids) {
        try {
          k.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      rmSync(profile, { recursive: true, force: true });
      /* SIGKILL leaves the X lock + socket behind, and a stale lock makes the
       * NEXT run's Xvfb refuse that display number. Remove only our own. */
      rmSync(`/tmp/.X${disp}-lock`, { force: true });
      rmSync(`/tmp/.X11-unix/X${disp}`, { force: true });
    }
  });
});
