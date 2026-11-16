// Where the two local bridges are, and their keys. See `bridges.ts` for the
// storage rule (a key is kept only when "remember" is ticked) and the address
// rule (loopback only).

import { useState } from 'react';
import { cleanUrl, ENGINE_PORT, PRINTER_PORT, type BridgeConfig, type Bridges } from './bridges';

function Row({
  title,
  what,
  start,
  port,
  cfg,
  onChange,
  testid,
}: {
  title: string;
  what: string;
  start: string;
  port: number;
  cfg: BridgeConfig;
  onChange: (c: BridgeConfig) => void;
  testid: string;
}) {
  const [url, setUrl] = useState(cfg.url);
  const bad = url.trim() !== '' && cleanUrl(url) === '';
  return (
    <fieldset className="p3d-conn" data-testid={testid}>
      <legend>{title}</legend>
      <p className="p3d-sub">{what}</p>
      <p className="p3d-sub">
        Start it: <code>{start}</code>
      </p>
      <label>
        Address
        <input
          type="text"
          value={url}
          placeholder={`http://127.0.0.1:${port}`}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => onChange({ ...cfg, url: cleanUrl(url) })}
          data-testid={`${testid}-url`}
        />
      </label>
      {bad && <span className="p3d-warn">Only a 127.0.0.1 or localhost address with a port is accepted: the bridges listen on this computer only.</span>}
      <label>
        Key (the token it printed when it started)
        <input
          type="password"
          value={cfg.token}
          autoComplete="off"
          onChange={(e) => onChange({ ...cfg, token: e.target.value.trim() })}
          data-testid={`${testid}-token`}
        />
      </label>
      <label className="p3d-inline">
        <input type="checkbox" checked={cfg.remember} onChange={(e) => onChange({ ...cfg, remember: e.target.checked })} />
        Remember the key in this browser
      </label>
    </fieldset>
  );
}

export function Connections({ bridges, onChange }: { bridges: Bridges; onChange: (b: Bridges) => void }) {
  return (
    <div className="p3d-conns">
      <Row
        title="Slicer bridge"
        what="Slices the parts on this computer with 2bee.fdm, this app’s own engine, which has not printed yet; this app separates, lays flat and arranges them first. It never talks to a printer. (Started with --engine orca it uses the OrcaSlicer CLI instead, for comparison runs.)"
        start={`node tools/print3d-bridge/bridge.mjs --port ${ENGINE_PORT}`}
        port={ENGINE_PORT}
        cfg={bridges.engine}
        onChange={(engine) => onChange({ ...bridges, engine })}
        testid="p3d-conn-engine"
      />
      <Row
        title="Printer bridge (upload only)"
        what="Copies a sliced plate onto the X2D over the network. It cannot start, pause or stop a print."
        start={`node tools/printer-bridge/bridge.mjs --printer <X2D IP> --code-file <file>`}
        port={PRINTER_PORT}
        cfg={bridges.printer}
        onChange={(printer) => onChange({ ...bridges, printer })}
        testid="p3d-conn-printer"
      />
    </div>
  );
}
