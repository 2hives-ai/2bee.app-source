import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossSiteRefusal } from '../devBridgeGuard.ts';

test('🔴 the dev bridge proxy refuses another site, and lets this one through', () => {
  /* The proxy adds the bridge token to whatever it is sent. A text/plain POST
   * from any page needs no preflight; measured, it uploaded and STARTED a print
   * through /__printer. */
  const host = '127.0.0.1:5178';
  // Positive controls first: a guard that refuses everything passes the rest.
  assert.equal(crossSiteRefusal({ host, origin: 'http://127.0.0.1:5178', 'sec-fetch-site': 'same-origin' }), null);
  assert.equal(crossSiteRefusal({ host }), null, 'curl / a script with no Origin is local and allowed');
  assert.equal(crossSiteRefusal({ host: 'localhost:5178', origin: 'http://localhost:5178' }), null);
  // The attack, every shape of it.
  assert.match(crossSiteRefusal({ host, origin: 'https://evil.example' }) ?? '', /refused/);
  assert.match(crossSiteRefusal({ host, origin: 'null' }) ?? '', /refused/, 'sandboxed iframe / file: page');
  assert.match(crossSiteRefusal({ host, 'sec-fetch-site': 'cross-site' }) ?? '', /refused/, 'an <img> GET carries no Origin');
  assert.match(crossSiteRefusal({ host, 'sec-fetch-site': 'same-site' }) ?? '', /refused/, 'another port on localhost');
  assert.match(crossSiteRefusal({ host, origin: 'http://127.0.0.1:5999' }) ?? '', /refused/, 'another local dev server');
});
