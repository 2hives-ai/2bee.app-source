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
import os from 'node:os';

export const BAMBU_NT = 'urn:bambulab-com:device:3dprinter:1';
export const SSDP_PORT = 2021;
/** A printer not heard for this long is dropped from the list. Bambu printers repeat every few seconds. */
export const SEEN_TTL_MS = 60_000;

/** Parse one datagram. Returns { ip, serial, model, name, connect } or null for anything that is not a Bambu printer NOTIFY. */
export function parseBambuNotify(text, fromIp) {
  // A NOTIFY the printer sends by itself, or the 200 OK it sends back to an M-SEARCH (searchBambu).
  if (typeof text !== 'string') return null;
  const notify = /^NOTIFY \* HTTP\/1\.1\r?\n/i.test(text);
  const reply = /^HTTP\/1\.1 200 OK\r?\n/i.test(text);
  if (!notify && !reply) return null;
  const h = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if ((notify ? h.nt : h.st) !== BAMBU_NT) return null;
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

export const SEARCH_MS = 20_000;
export const SEARCH_GROUPS = [
  ['239.255.255.250', 1990],
  ['255.255.255.255', 1990],
];

/** Interfaces that are never the workshop LAN: loopback, containers, VMs. */
const NOT_LAN = /^(lo|docker|br-|veth|virbr|mpqemu|tun|tap|wg|tailscale|zt)/;

/**
 * Every host address in the /24 of each LAN interface (prefix /24 or longer only; a bigger subnet is
 * searched in the /24 around this computer's own address, never in full).
 *
 * Why unicast: measured 2026-11-20, an M-SEARCH sent to the multicast group or a broadcast address got
 * NO reply through ufw "deny (incoming)", while the same M-SEARCH sent to 192.168.50.151 itself got the
 * X2D's 200 OK back. The firewall lets a reply in only when it can pair it with what we sent to that host.
 */
export function lanUnicastTargets(ifaces = os.networkInterfaces()) {
  const out = new Set();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (NOT_LAN.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const [x, y, z, w] = a.address.split('.').map(Number);
      const lan = x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
      if (!lan) continue;
      for (let i = 1; i < 255; i++) if (i !== w) out.add(`${x}.${y}.${z}.${i}`);
    }
  }
  return [...out].sort();
}

export const SEARCH_TARGETS = () => [...SEARCH_GROUPS, ...lanUnicastTargets().map((h) => [h, 1990])];
export const M_SEARCH = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ${BAMBU_NT}\r\n\r\n`;

/**
 * ASK the LAN for Bambu printers (M-SEARCH) from our own UDP socket, every `everyMs`.
 *
 * Why both this and listenBambu: measured 2026-11-20 on jamesave, ufw "deny (incoming)" dropped
 * every NOTIFY the X2D sent to UDP 2021, so listening alone heard nothing while the printer was on.
 * Only a reply to a search sent to THAT HOST is let back in (the firewall pairs it with our request); a
 * multicast or broadcast search got no reply (see lanUnicastTargets). A search needs no open port or rule.
 * It sends only the M-SEARCH line above: no code, no serial, nothing about this computer.
 */
export function searchBambu({ seen = new SeenPrinters(), everyMs = SEARCH_MS, targets = SEARCH_TARGETS, log = () => {} } = {}) {
  const state = { seen, searching: false, error: null, close: () => {} };
  let sock;
  try {
    sock = dgram.createSocket({ type: 'udp4' });
  } catch (e) {
    state.error = e.message;
    return state;
  }
  let timer = null;
  const send = () => {
    for (const [host, port] of typeof targets === 'function' ? targets() : targets) sock.send(M_SEARCH, port, host, () => {});
  };
  sock.on('error', (e) => {
    state.searching = false;
    state.error = e.message;
    log(`printer search stopped: ${e.message}`);
    clearInterval(timer);
    try { sock.close(); } catch { /* closed */ }
  });
  sock.on('message', (buf, rinfo) => seen.add(parseBambuNotify(buf.toString('latin1'), rinfo.address)));
  sock.bind(0, () => {
    try { sock.setBroadcast(true); } catch { /* broadcast target fails; multicast still goes */ }
    state.searching = true;
    log(`printer discovery: searching for Bambu printers every ${Math.round(everyMs / 1000)} s (SSDP M-SEARCH)`);
    send();
    timer = setInterval(send, everyMs);
    timer.unref?.();
  });
  state.close = () => { clearInterval(timer); try { sock.close(); } catch { /* closed */ } };
  return state;
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
