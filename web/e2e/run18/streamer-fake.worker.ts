// TEST-ONLY worker entry. NEVER referenced by the product.
//
// The whole point: `src/run/streamer.worker.ts` ships byte-identical. This
// entry prepends the fake-serial stub and then imports the REAL, UNMODIFIED
// worker module, so gate branch RUN-18 exercises the shipped code path through
// a port the test can drive.

import './install-fake-serial';
import '../../src/run/streamer.worker';

export {};
