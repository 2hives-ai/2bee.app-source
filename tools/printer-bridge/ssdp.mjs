// ssdp — hear Bambu Lab printers announce themselves on the LAN.
//
// Founder 2026-11-19: "I open 2bee.app 3d and automatically scans and find all
// printers/bridges". A browser cannot listen for UDP, so the printer bridge does.
// A Bambu printer in LAN mode sends an SSDP NOTIFY every few seconds to UDP 2021
// (broadcast). It looks like:
//
//   NOTIFY * HTTP/1.1
//   Location: 192.168.50.151
//   NT: urn:bambulab-com:device:3dprinter:1
//   USN: <serial>
//   DevModel.bambu.com: <model code>
//   DevName.bambu.com: <name set on the printer>
//   DevConnect.bambu.com: lan | cloud
//
// What this module does NOT do: it never contacts a printer, never sends the
// access code anywhere, and never changes which printer the bridge talks to. A
// printer heard at a new address is REPORTED; repointing the bridge stays a person's
// decision (the access code goes wherever --printer points).

import dgram from 'node:dgram';
import net from 'node:net';

export const BAMBU_NT = 'urn:bambulab-com:device:3dprinter:1';
export const SSDP_PORT = 2021;
/** A printer not heard for this long is dropped from the list. Bambu printers repeat every few seconds. */
export const SEEN_TTL_MS = 60_000;

/** Parse one datagram. Returns { ip, serial, model, name, connect } or null for anything that is not a Bambu printer NOTIFY. */
export function parseBambuNotify(text, fromIp) {
  if (typeof text !== 'string' || !/^NOTIFY \* HTTP\/1\.1\r?\n/i.test(text)) return null;
  const h = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (h.nt !== BAMBU_NT) return null;
  const serial = h.usn || '';
  if (!/^[A-Za-z0-9]{6,32}$/.test(serial)) return null;
  // The address is the one the packet came from. `Location` is the printer's own claim; it must agree.
  const ip = fromIp;
  if (!net.isIPv4(ip) || (h.location && h.location !== ip)) return null;
  const clean = (v) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').slice(0, 64) : '');
  return { ip, serial, model: clean(h['devmodel.bambu.com']), name: clean(h['devname.bambu.com']), connect: clean(h['devconnect.bambu.com']) };
}

/** Keeps the printers heard recently, keyed by serial. */
export class SeenPrinters {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }
  add(p) {
    if (p) this.map.set(p.serial, { ...p, at: this.now() });
  }
  /** Printers heard within SEEN_TTL_MS, newest first. */
  list() {
    const t = this.now();
    return [...this.map.values()].filter((p) => t - p.at <= SEEN_TTL_MS).sort((a, b) => b.at - a.at);
  }
}

/**
 * Listen on UDP `port` for Bambu NOTIFYs. Returns { seen, close, listening }. Never throws: a port
 * another program holds (Bambu Studio / OrcaSlicer also listen on 2021) leaves `listening` false and
 * the reason in `error`, and the bridge carries on without discovery.
 */
export function listenBambu({ port = SSDP_PORT, seen = new SeenPrinters(), log = () => {} } = {}) {
  const state = { seen, listening: false, error: null, close: () => {} };
  let sock;
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) {
    state.error = e.message;
    return state;
  }
  sock.on('error', (e) => {
    state.listening = false;
    state.error = e.message;
    log(`printer discovery (UDP ${port}) stopped: ${e.message}`);
    try { sock.close(); } catch { /* closed */ }
  });
  sock.on('message', (buf, rinfo) => seen.add(parseBambuNotify(buf.toString('latin1'), rinfo.address)));
  sock.bind(port, () => {
    state.listening = true;
    log(`printer discovery: listening for Bambu printers on UDP ${port}`);
  });
  state.close = () => { try { sock.close(); } catch { /* closed */ } };
  return state;
}
