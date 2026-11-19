// Where the two local bridges are, and their keys. See `bridges.ts` for the
// storage rule (a key is kept only when "remember" is ticked) and the address
// rule (loopback only) and the discovery rule (fills an empty address only,
// from a bridge that named itself; never a key).

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyDiscovery, cleanUrl, discoverBridges, ENGINE_PORT, PRINTER_PORT, type BridgeConfig, type Bridges, type FetchLike } from './bridges';

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

export function Connections({ bridges, onChange, fetchImpl }: { bridges: Bridges; onChange: (b: Bridges) => void; fetchImpl?: FetchLike }) {
  // The reply can land after the person typed: apply it to the LATEST bridges, not the ones at click time.
  const latest = useRef(bridges);
  latest.current = bridges;
  const [look, setLook] = useState<{ busy: boolean; notes: string[] }>({ busy: false, notes: [] });
  const discover = useCallback(async () => {
    setLook({ busy: true, notes: [] });
    const d = await discoverBridges(fetchImpl);
    const next = applyDiscovery(latest.current, d);
    if (next !== latest.current) onChange(next);
    setLook({ busy: false, notes: d.notes });
  }, [fetchImpl, onChange]);
  // Opening the panel with an address missing looks once. A set address is never re-checked here.
  const missing = !bridges.engine.url || !bridges.printer.url;
  const looked = useRef(false);
  useEffect(() => {
    if (missing && !looked.current) {
      looked.current = true;
      void discover();
    }
  }, [missing, discover]);
  return (
    <div className="p3d-conns">
      <div className="p3d-discover" data-testid="p3d-discover">
        <button type="button" onClick={() => void discover()} disabled={look.busy} data-testid="p3d-discover-btn">
          {look.busy ? 'Looking on this computer…' : 'Look for bridges on this computer'}
        </button>
        {look.notes.map((n) => (
          <p key={n} className="p3d-sub" data-testid="p3d-discover-note">
            {n}
          </p>
        ))}
      </div>
      <Row
        title="Slicer bridge"
        what="Slices the parts on this computer with 2bee.fdm, this app’s own engine, which has not printed yet; this app separates, lays flat and arranges them first. It never talks to a printer. (Started with --engine orca it uses the OrcaSlicer CLI instead, for comparison runs.)"
        start={`node tools/print3d-bridge/bridge.mjs --port ${ENGINE_PORT}`}
        port={ENGINE_PORT}
        key={`engine:${bridges.engine.url}`}
        cfg={bridges.engine}
        onChange={(engine) => onChange({ ...bridges, engine })}
        testid="p3d-conn-engine"
      />
      <Row
        title="Printer bridge (upload only)"
        what="Copies a sliced plate onto the X2D over the network. It cannot start, pause or stop a print."
        start={`node tools/printer-bridge/bridge.mjs --printer <X2D IP> --code-file <file>`}
        port={PRINTER_PORT}
        key={`printer:${bridges.printer.url}`}
        cfg={bridges.printer}
        onChange={(printer) => onChange({ ...bridges, printer })}
        testid="p3d-conn-printer"
      />
    </div>
  );
}
