import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdir, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { crossSiteRefusal } from './devBridgeGuard';

// Dev-only: serve hardware/cad/*.scad as a JSON library endpoint so 2bee.cad
// can auto-mount the full SCAD tree without the user picking a folder.
//
// 🔴 THIS IS A DEV CONVENIENCE, NOT A PRODUCTION FEATURE. The endpoint is
// registered on the dev server only; `vite build` and `vite preview` never see
// it. In production the operator picks a folder the normal way.
//
// ⚠ THE SNAPSHOT IS PER-REQUEST. Each GET re-reads the tree, so edits on disk
// are visible after a page refresh. This is the same contract as picking a
// folder (a snapshot), except the "pick" happens automatically.
const SCAD_ROOT = resolve(__dirname, '../../../hardware/cad');

function cadLibraryPlugin(): Plugin {
  return {
    name: 'cad-library',
    configureServer(server) {
      server.middlewares.use('/__cad-library', async (_req, res) => {
        try {
          const files: Record<string, string> = {};
          const walk = async (dir: string) => {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const e of entries) {
              const full = join(dir, e.name);
              if (e.isDirectory()) {
                await walk(full);
              } else if (e.name.endsWith('.scad') || e.name.endsWith('.dxf') || e.name.endsWith('.svg')) {
                const rel = relative(SCAD_ROOT, full).replace(/\\/g, '/');
                files[rel] = await readFile(full, 'utf-8');
              }
            }
          };
          await walk(SCAD_ROOT);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ rootName: 'cad', files }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

// Dev-only: the app's AI goes to the LOCAL claude CLI through tools/claude-bridge
// (founder 2026-10-15: "use the backend claude session for now"). Same-origin, so no
// CORS and no browser-side token: this middleware adds the bridge token from
// ~/.config/claude-bridge.token (or $CLAUDE_BRIDGE_TOKEN) and drops the Origin header.
// The bridge itself stays 127.0.0.1-only, no tools, one request at a time.
// ⚠ Not in `vite build`/`vite preview`. See LOCAL_CLAUDE_CONFIG in src/cad/ask.tsx.
/** One local bridge behind a same-origin dev route; the token is added here, never in the bundle. */
function bridgeProxy(name: string, route: string, target: string, tokenFile: string, tokenEnv: string, hint: string): Plugin {
  return {
    name,
    configureServer(server) {
      server.middlewares.use(route, async (req, res) => {
        // Before the token is even read: see devBridgeGuard.ts.
        const refused = crossSiteRefusal(req.headers);
        if (refused) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { message: `${name}: ${refused}` } }));
          return;
        }
        let token = process.env[tokenEnv] ?? '';
        if (!token) {
          try {
            token = (await readFile(tokenFile, 'utf-8')).split('\n')[0].trim();
          } catch {
            /* no token file: the bridge answers 401 and the app shows it */
          }
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const r = await fetch(target + (req.url ?? ''), {
            method: req.method,
            headers: {
              'content-type': String(req.headers['content-type'] ?? 'application/json'),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          });
          res.statusCode = r.status;
          for (const h of ['content-type', 'content-disposition']) {
            const v = r.headers.get(h);
            if (v) res.setHeader(h, v);
          }
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { message: `${name}: ${target} did not answer (${String(err)}). Start it: ${hint}` } }));
        }
      });
    },
  };
}
const HOME = process.env.HOME ?? '';
const claudeBridgePlugin = () =>
  bridgeProxy('claude-bridge-proxy', '/__claude', process.env.CLAUDE_BRIDGE_URL ?? 'http://127.0.0.1:8787',
    join(HOME, '.config', 'claude-bridge.token'), 'CLAUDE_BRIDGE_TOKEN',
    'node tools/claude-bridge/bridge.mjs --token-file ~/.config/claude-bridge.token');
// 3d tab (founder 2026-10-15: "migrate the 2bee.3d into this app"): the slicer and the
// upload-only printer bridge, same pattern. See src/print3d/bridges.ts DEV_BRIDGES.
const print3dBridgePlugin = () =>
  bridgeProxy('print3d-bridge-proxy', '/__print3d', process.env.PRINT3D_BRIDGE_URL ?? 'http://127.0.0.1:8789',
    join(HOME, '.config', '2bee', 'print3d.token'), 'PRINT3D_BRIDGE_TOKEN',
    'node tools/print3d-bridge/bridge.mjs --token-file ~/.config/2bee/print3d.token');
const printerBridgePlugin = () =>
  bridgeProxy('printer-bridge-proxy', '/__printer', process.env.PRINTER_BRIDGE_URL ?? 'http://127.0.0.1:8788',
    join(HOME, '.config', '2bee', 'printer.token'), 'PRINTER_BRIDGE_TOKEN',
    'node tools/printer-bridge/bridge.mjs --printer <X2D IP> --code-file <access code file> --token-file ~/.config/2bee/printer.token');

// Dev-only: read a web page the operator linked in a chat (founder 2026-10-15:
// "add this cnc machine: https://…" — the bridge runs claude with NO tools, so it
// cannot open links). GET only; http/https only; the host must resolve to a
// PUBLIC address (no loopback/private/link-local: this is a server-side fetch on
// the founder's machine); 3 MB / 15 s cap; scripts/styles/tags stripped; at most
// 12 000 characters of text go back. The chat says which page it read.
function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
// Dev-only web search for the machine chats (founder 2026-10-15: "able to add
// machines from the internet (research and add …)"). DuckDuckGo's HTML endpoint;
// ads (links back into duckduckgo.com) are dropped; the top 5 result URLs go back.
// The pages themselves are then read through /__fetch-page and its public-host rule.
function searchPlugin(): Plugin {
  return {
    name: 'web-search',
    configureServer(server) {
      server.middlewares.use('/__search', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          const q = new URL(req.url ?? '', 'http://x').searchParams.get('q')?.slice(0, 200) ?? '';
          if (!q.trim()) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: 'empty query' }));
          }
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 15000);
          const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (2bee.app research)' } });
          clearTimeout(timer);
          const html = await r.text();
          const urls: string[] = [];
          for (const m of html.matchAll(/class="result__a" href="([^"]+)"/g)) {
            const href = m[1].replace(/&amp;/g, '&');
            const u = /[?&]uddg=([^&]+)/.exec(href)?.[1];
            const target = u ? decodeURIComponent(u) : href;
            if (!/^https?:\/\//.test(target) || /^https?:\/\/([^/]*\.)?duckduckgo\.com\//.test(target)) continue;
            if (!urls.includes(target)) urls.push(target);
            if (urls.length >= 5) break;
          }
          res.end(JSON.stringify({ q, urls }));
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

function pageFetchPlugin(): Plugin {
  return {
    name: 'page-fetch',
    configureServer(server) {
      server.middlewares.use('/__fetch-page', async (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          const target = new URL(new URL(req.url ?? '', 'http://x').searchParams.get('url') ?? '');
          if (req.method !== 'GET' || !/^https?:$/.test(target.protocol)) return send(400, { error: 'only http(s) GET' });
          const { lookup } = await import('node:dns/promises');
          const addrs = await lookup(target.hostname, { all: true });
          if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return send(403, { error: 'that host is not a public address' });
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 15000);
          const r = await fetch(target, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (2bee.app page reader)' } });
          clearTimeout(timer);
          const buf = Buffer.from(await r.arrayBuffer()).subarray(0, 3_000_000).toString('utf8');
          const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buf)?.[1]?.trim() ?? '';
          const text = buf
            .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 12000);
          send(200, { url: target.href, status: r.status, title, text });
        } catch (err) {
          send(502, { error: String(err) });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cadLibraryPlugin(), claudeBridgePlugin(), print3dBridgePlugin(), printerBridgePlugin(), pageFetchPlugin(), searchPlugin()],
  // The wasm-bindgen output lives in `src/wasm/` and the .wasm is fetched at
  // runtime as an emitted asset — never inlined, so its bytes stay identical to
  // the module the parity gate feeds the CLI (the build hashes the FILENAME;
  // a filename is not an identity, the content is, and that is what is checked).
  //
  // 🔴 It used to live in `public/`. That is fine in a production build, where
  // `public/` is copied verbatim, and is a hard 500 under `vite dev`, which
  // refuses to serve a `public/` file that source imports. `npm run dev` could
  // not load the CAM core at all while `npm run build` was healthy — and the
  // browser suite never saw it, because Playwright runs against `preview`.
  // `fs.allow`: the PnP tab imports `cad`'s generated tray spec
  // (`src/pnp/vspec.ts`), which lives outside this app. `vite build` follows the
  // import; `vite dev` refuses to serve a file outside its allow list unless named.
  // Named as the ONE file, not its directory.
  server: {
    port: 5178,
    strictPort: true,
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        resolve(__dirname, '../../../hardware/cad/2bee_pnp/pnp_blinds_vspec.json'),
        // pnp tab: boards discovered from pcb's BOM/placement files (src/pnp/boards.ts), read-only.
        resolve(__dirname, '../../../hardware/pcb'),
        // materials tab, components: bom's part records + supplier stock snapshot (read-only).
        resolve(__dirname, '../../../hardware/bom/sourced_parts.csv'),
        resolve(__dirname, '../../../hardware/bom/stock-snapshot.json'),
      ],
    },
  },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  // 🔴 WORKERS ARE BUILT AS ES MODULES, NOT AS THE `iife` DEFAULT (2026-08-29).
  //
  // `src/cam.worker.ts` loads the CAM core with a dynamic `import()`, which
  // makes its bundle code-split — and rollup refuses that under `iife`:
  //   "Invalid value \"iife\" for option \"output.format\" — UMD and IIFE output
  //    formats are not supported for code-splitting builds."
  // That is a BUILD failure, so it cannot ship silently; it is recorded here
  // anyway because the next person to add a worker will meet it and the error
  // names rollup rather than this setting. Both workers are constructed with
  // `{ type: 'module' }`, so this matches how they are actually instantiated.
  worker: { format: 'es' },
  // Build-time flag: true when committed controller transcripts exist in
  // gates/controller/.  The unproven banner in the Run tab is gated on this.
  define: {
    __CTRL_TRANSCRIPTS__: JSON.stringify(
      (() => { try { return readdirSync(resolve(__dirname, '../gates/controller')).filter(f => f.endsWith('.json')).length > 0; } catch { return false; } })()
    ),
  },
});
