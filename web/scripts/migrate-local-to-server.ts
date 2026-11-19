// Move one browser's saved 2bee.app data to the server document store.
//
// Founder 2026-11-19: "Can you migrate all mine from localhost to the 2bee.app
// server?" Logic and rules: src/serverMigrate.ts (never overwrites, never
// touches local storage, every doc reported).
//
// USAGE (from web/):
//   node --import ./tests/register.mjs scripts/migrate-local-to-server.ts \
//        --snapshot <export.json> [--token-from-cdp] [--apply] [--base <url>]
//
//   Default is a DRY RUN: it reads the server and reports what it WOULD
//   create. Nothing is written without --apply.
//
// SNAPSHOT: JSON {origin, exported_at, localStorage: {key: string},
//   indexedDB: {db: {store: [{key, value}]}}}, binary fields as
//   {__bytes, b64} / {__blob, b64}. Taken from the browser over CDP.
//
// TOKEN: the Cognito ID token of the person whose data this is.
//   --token-from-cdp reads it from a signed-in https://2bee.app tab in the
//   browser on CDP 127.0.0.1:9222 (sessionStorage `2bee.app.auth.tokens`).
//   Otherwise it is read from env TWOBEE_ID_TOKEN. It is never printed.
//
// EXIT: 0 every doc created or already there · 1 any doc failed or in
//   conflict · 2 bad invocation, unreadable snapshot, or no token.

import { readFileSync } from 'node:fs';
import { createServerStore, DEFAULT_DOCS_BASE } from '../src/serverStore.ts';
import { planMigration, runMigration, type Snapshot } from '../src/serverMigrate.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const known = new Set(['--snapshot', '--token-from-cdp', '--apply', '--base']);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(2);
  }
  if (args[i] === '--snapshot' || args[i] === '--base') i++;
}

const snapPath = val('--snapshot');
if (!snapPath) {
  console.error('--snapshot <export.json> is required');
  process.exit(2);
}
let snap: Snapshot;
try {
  snap = JSON.parse(readFileSync(snapPath, 'utf8'));
} catch (e) {
  console.error(`could not read the snapshot: ${(e as Error).message}`);
  process.exit(2);
}

async function tokenFromCdp(): Promise<string | null> {
  const { chromium } = await import('@playwright/test');
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    for (const ctx of b.contexts()) {
      for (const p of ctx.pages()) {
        if (!p.url().startsWith('https://2bee.app/')) continue;
        const raw = await p.evaluate(() => sessionStorage.getItem('2bee.app.auth.tokens'));
        if (!raw) continue;
        const t = JSON.parse(raw) as { id_token?: string; expires_in?: number; received_at?: number };
        if (t.id_token && t.expires_in && t.received_at && Date.now() < t.received_at + t.expires_in * 1000 - 60_000) return t.id_token;
      }
    }
    return null;
  } finally {
    await b.close();
  }
}

const token = flag('--token-from-cdp') ? await tokenFromCdp() : process.env.TWOBEE_ID_TOKEN ?? null;
if (!token) {
  console.error('no usable ID token: sign in at https://2bee.app in the CDP 9222 browser, or set TWOBEE_ID_TOKEN');
  process.exit(2);
}

const { docs, skipped } = planMigration(snap);
const apply = flag('--apply');
console.log(`snapshot: ${snap.origin} exported ${snap.exported_at}`);
console.log(`${docs.length} doc(s) planned, ${skipped.length} source(s) not moved${apply ? '' : ' — DRY RUN, nothing is written'}`);
for (const s of skipped) console.log(`  not moved: ${s}`);

const store = createServerStore({ base: val('--base') ?? DEFAULT_DOCS_BASE, getIdToken: () => token });
const { lines, ok } = await runMigration(store, docs, {
  apply,
  onLine: (l) => console.log(`  ${l.outcome.padEnd(13)} ${l.kind}/${l.docId}  <- ${l.source}  (${l.detail})`),
});
const count = (o: string) => lines.filter((l) => l.outcome === o).length;
console.log(
  `created ${count('created')} · already there ${count('already-there')} · would create ${count('would-create')} · ` +
    `conflict ${count('conflict')} · failed ${count('failed')}`,
);
process.exit(ok ? 0 : 1);
