// TEST-ONLY worker entry for the router journey. NEVER referenced by the product.
//
// Same shape as `../run18/streamer-fake.worker.ts`: install a fake
// `navigator.serial` on the worker, then import the REAL, UNMODIFIED
// `src/run/streamer.worker`. The difference is the port — `RouterSerial`
// records every received byte and answers the four analysis reads in grblHAL
// format (see `router-controller.ts`). The page swaps this entry in for the
// product's worker URL from an init script; `src/` is not touched.
//
// Persona comes from the worker's name (see `install-router-serial.ts`):
//   `no-banner` — grblHAL that has been running a while and says nothing on
//                 connect, so the journey must go through identify-consent;
//   `healthy`   — announces `GrblHAL 1.1f` on connect, identified by banner.

import './install-router-serial';
import '../../src/run/streamer.worker';

export {};
