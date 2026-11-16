// TEST-ONLY. Installs `RouterSerial` as the worker's `navigator.serial` and
// exposes it as `self.__routerSerial` so the spec can read the received-bytes
// log with `worker.evaluate`. Evaluated before `streamer.worker` (sibling
// imports evaluate in source order); the worker only reads `navigator.serial`
// inside its `attach` handler anyway.

import { RouterSerial } from './router-controller';
import type { PersonaName } from '../../src/run/fake';

/* Persona from the worker's NAME (`new Worker(url, { name: 'persona=…' })`),
 * set by the spec's page init script. Default `no-banner`. */
const named = /persona=([\w.-]+)/.exec((self as unknown as { name?: string }).name ?? '')?.[1];
const serial = new RouterSerial((named ?? 'no-banner') as PersonaName);
const nav = (self as unknown as { navigator: object }).navigator;
try {
  Object.defineProperty(nav, 'serial', { value: serial, configurable: true });
} catch {
  (nav as unknown as { serial: unknown }).serial = serial;
}
(self as unknown as { __routerSerial?: RouterSerial }).__routerSerial = serial;

export {};
