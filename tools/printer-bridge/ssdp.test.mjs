import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import { parseBambuNotify, SeenPrinters, listenBambu, SEEN_TTL_MS } from './ssdp.mjs';
import { createBridge } from './bridge.mjs';

const notify = (o = {}) =>
  [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1990',
    'Server: UPnP/1.0',
    `Location: ${o.location ?? '192.168.50.151'}`,
    `NT: ${o.nt ?? 'urn:bambulab-com:device:3dprinter:1'}`,
    `USN: ${o.usn ?? '20P9BJ611001217'}`,
    'Cache-Control: max-age=1800',
    'DevModel.bambu.com: N6',
    'DevName.bambu.com: Workshop X2D',
    'DevConnect.bambu.com: lan',
    '',
    '',
  ].join('\r\n');

test('parse: a Bambu NOTIFY gives ip, serial, model, name; the ip is the sender, and Location must agree', () => {
  assert.deepEqual(parseBambuNotify(notify(), '192.168.50.151'), { ip: '192.168.50.151', serial: '20P9BJ611001217', model: 'N6', name: 'Workshop X2D', connect: 'lan' });
  assert.equal(parseBambuNotify(notify(), '192.168.50.99'), null, 'a packet claiming another address is not believed');
});

test('parse: anything that is not a Bambu printer NOTIFY is ignored', () => {
  assert.equal(parseBambuNotify(notify({ nt: 'urn:schemas-upnp-org:device:MediaRenderer:1' }), '192.168.50.151'), null);
  assert.equal(parseBambuNotify(notify({ usn: 'x' }), '192.168.50.151'), null);
  assert.equal(parseBambuNotify(notify({ usn: '../../etc' }), '192.168.50.151'), null);
  assert.equal(parseBambuNotify('M-SEARCH * HTTP/1.1\r\n\r\n', '192.168.50.151'), null);
  assert.equal(parseBambuNotify('garbage', '192.168.50.151'), null);
  assert.equal(parseBambuNotify(notify(), 'fe80::1'), null);
});

test('SeenPrinters: one entry per serial (a moved printer replaces its old address), dropped after the TTL', () => {
  let t = 0;
  const s = new SeenPrinters(() => t);
  s.add(parseBambuNotify(notify(), '192.168.50.151'));
  t = 5000;
  s.add(parseBambuNotify(notify({ location: '192.168.50.77' }), '192.168.50.77'));
  assert.deepEqual(s.list().map((p) => p.ip), ['192.168.50.77']);
  t += SEEN_TTL_MS + 1;
  assert.deepEqual(s.list(), []);
});

test('listenBambu: hears a NOTIFY over real UDP; a port already held reports not listening instead of throwing', async () => {
  const holder = dgram.createSocket('udp4');
  await new Promise((r) => holder.bind(0, '127.0.0.1', r));
  const port = holder.address().port;
  holder.close();
  const l = listenBambu({ port });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(l.listening, true);
  const tx = dgram.createSocket('udp4');
  // From 127.0.0.1, so Location must say 127.0.0.1.
  await new Promise((r) => tx.send(notify({ location: '127.0.0.1' }), port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 100));
  tx.close();
  assert.deepEqual(l.seen.list().map((p) => [p.ip, p.serial]), [['127.0.0.1', '20P9BJ611001217']]);
  l.close();
});

function post(port, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': 2 } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('/v1/check lists every printer heard, marks the configured one by serial, sends only the serial tail', async () => {
  const seen = new SeenPrinters();
  seen.add(parseBambuNotify(notify({ location: '192.168.50.77' }), '192.168.50.77'));
  seen.add(parseBambuNotify(notify({ usn: '01P00A999999999', location: '192.168.50.80' }), '192.168.50.80'));
  const token = 'ssdp-test-token-0123456789';
  const srv = createBridge({ token, printer: '127.0.0.1', printerPort: 1, serial: '20P9BJ611001217', discovery: () => ({ listening: true, error: null, seen }), log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await post(srv.address().port, '/v1/check', token);
    assert.equal(r.status, 200);
    assert.equal(r.json.discovery, 'listening');
    const byIp = Object.fromEntries(r.json.seen.map((x) => [x.ip, x]));
    assert.equal(byIp['192.168.50.77'].isThisPrinter, true);
    assert.equal(byIp['192.168.50.80'].isThisPrinter, false);
    assert.equal(byIp['192.168.50.77'].serialTail, '1217');
    assert.doesNotMatch(JSON.stringify(r.json), /20P9BJ611001217|01P00A999999999/, 'no full serial leaves the bridge');
    assert.equal(r.json.printer, '127.0.0.1', 'a printer heard elsewhere is reported, never followed');
  } finally {
    srv.stopCamera?.();
    await new Promise((r) => srv.close(r));
  }
});

test('/v1/check without discovery says off, and seen is null (not an empty list that reads as "none heard")', async () => {
  const token = 'ssdp-test-token-0123456789';
  const srv = createBridge({ token, printer: '127.0.0.1', printerPort: 1, log: () => {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await post(srv.address().port, '/v1/check', token);
    assert.equal(r.json.discovery, 'off');
    assert.equal(r.json.seen, null);
  } finally {
    srv.stopCamera?.();
    await new Promise((r) => srv.close(r));
  }
});
