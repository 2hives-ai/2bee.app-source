// bridge-registry — how one 2bee.app bridge on this computer names the others.
//
// Founder 2026-11-19: "I open 2bee.app 3d and automatically scans and find all
// printers/bridges". A browser page can only find a loopback bridge by asking a
// port, and every port that is NOT a bridge logs a red net::ERR_CONNECTION_REFUSED
// in the console that no page code can silence (20 blind probes = 18 red lines).
// So the page asks only the two default ports, and each bridge's GET /v1/hello
// lists the OTHER bridges running here, from this registry.
//
// Each bridge writes <dir>/<port>.json = { kind, port, pid } when it listens and
// removes it when it stops. A file whose pid is no longer alive is ignored (a
// bridge killed with SIGKILL cannot clean up). The page still asks every listed
// port itself and believes only the hello it gets back, so a stale or forged
// entry costs one probe, never a wrong address.
//
// Only kinds and loopback port numbers leave this module: no pid, no path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KINDS = ['2bee.print3d-bridge', '2bee.printer-bridge'];

export function registryDir(env = process.env) {
  return env.TWOBEE_BRIDGE_REGISTRY || path.join(os.homedir(), '.local', 'state', '2bee-bridges');
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Record this bridge. Returns the function that removes the record. Never throws: discovery is a convenience. */
export function register(kind, port, dir = registryDir()) {
  if (!KINDS.includes(kind) || !validPort(port)) return () => {};
  const file = path.join(dir, `${port}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ kind, port, pid: process.pid }), { mode: 0o600 });
  } catch {
    return () => {};
  }
  return () => {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (r.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}

/** The bridges recorded here whose process is alive, as { bridge, port }, sorted by port. */
export function peers(dir = registryDir()) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (KINDS.includes(r.kind) && validPort(r.port) && `${r.port}.json` === n && alive(r.pid)) out.push({ bridge: r.kind, port: r.port });
    } catch {
      /* unreadable entry: skip */
    }
  }
  return out.sort((a, b) => a.port - b.port);
}
