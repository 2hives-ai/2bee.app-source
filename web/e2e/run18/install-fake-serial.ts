// TEST-ONLY. Installs the fake Web Serial shim on the WORKER's own
// `navigator`, so the real `streamer.worker` module — imported after this one,
// and evaluated after it, because sibling ES modules evaluate in source order —
// finds `navigator.serial` exactly where the product expects the browser's.
//
// ⚠ Even the ordering is belt-and-braces: the worker reads `navigator.serial`
// inside its `attach` command handler, not at module scope, so this stub only
// has to exist before the first `attach` message arrives. Source-order
// evaluation just makes that trivially true.

import { FakeSerial } from './fake-serial-port';

const serial = new FakeSerial('healthy');
const nav = (self as unknown as { navigator: object }).navigator;
try {
  // `WorkerNavigator` in Chromium has no `serial` (or a proto getter we shadow
  // on the instance). defineProperty on the instance wins either way.
  Object.defineProperty(nav, 'serial', { value: serial, configurable: true });
} catch {
  (nav as unknown as { serial: unknown }).serial = serial;
}

/* Exposed for the harness's gate line: the subject of any green must be named. */
(self as unknown as { __fakeSerial?: FakeSerial }).__fakeSerial = serial;

export {};
