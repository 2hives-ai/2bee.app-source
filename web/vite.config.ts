import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdir, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

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

export default defineConfig({
  plugins: [react(), cadLibraryPlugin()],
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
  server: { port: 5178, strictPort: true },
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
