// Node module hooks that let `node --test` load this app's TypeScript directly.
//
// TWO HOOKS, EACH FOR A REASON THE OBVIOUS ALTERNATIVE GETS WRONG:
//
// `resolve` — `src/store.ts` imports `'./workholding'` with no extension,
// because that is what every file in `src/` does and what the bundler expects.
// Node's ESM resolver requires one. The alternative was to add `.ts` to the
// imports in `store.ts` so Node could read it, which would mean EDITING THE
// PRODUCT SO THE TEST CAN RUN — the test would then pass against a file shaped
// by the harness, and the next person to write an import the normal way would
// silently drop out of coverage. The harness adapts to the source. It fires only
// on a resolution FAILURE, so it can never shadow a real module.
//
// `load` — esbuild, not Node's own `--experimental-strip-types`. Strip-only mode
// refuses TypeScript that cannot be erased character-for-character, and this
// codebase uses constructor parameter properties in three places (`scad.ts`'s
// parser, `mesh.ts`'s `CsgLimit` and `Grid`). Node reports that as
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX and loads nothing. esbuild is already in
// `node_modules` as one of Vite's own dependencies, so this adds NO package to
// the lockfile and nothing to licence-check.
//
// ⚠ It is a different transform from the one the app ships through, and that is
// a real difference: what these tests run is esbuild's output, what a user runs
// is Vite's (also esbuild, same version, different options). Nothing here can
// catch a bug that only exists in the bundled build — that is what the browser
// suite in `web/e2e/` is for.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (
      typeof specifier === 'string' &&
      specifier.startsWith('.') &&
      !/\.[cm]?[jt]sx?$/.test(specifier)
    ) {
      // `.ts` first, then `.tsx` — the same order Vite's resolver uses, so a
      // module that resolves here resolves the same way in the bundle.
      //
      // ⚠ `.tsx` was added 2026-08-11. Without it, importing ANY component that
      // imports another component failed with `Cannot find module …/Foo.ts`,
      // which reads as a missing file rather than as a missing extension — and
      // it silently bounded what could be tested at all: `CadTab.tsx` and
      // `preview.tsx` were untestable for this reason, not for a structural one.
      // `load()` below has handled `.tsx` since it was written; only `resolve`
      // was short.
      // A directory specifier (`../samples`) resolves to its `index`, which is
      // how the source already imports it and how Vite resolves it.
      const tries = [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`];
      for (let i = 0; i < tries.length; i++) {
        try {
          return await next(tries[i], context);
        } catch (e) {
          // Report the ORIGINAL specifier's failure, not the last candidate's:
          // "cannot find ../samples/index.tsx" names a file nobody wrote and
          // sends the reader looking for the wrong thing.
          if (i === tries.length - 1) throw err;
        }
      }
    }
    throw err;
  }
}

export async function load(url, context, next) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const file = fileURLToPath(url);
    const source = await readFile(file, 'utf8');
    const out = await transform(source, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'es2022',
      /* 🔴 THE AUTOMATIC RUNTIME, BECAUSE THAT IS WHAT THE APP IS BUILT WITH.
       * `tsconfig.json` sets `"jsx": "react-jsx"` and Vite follows it, so no
       * source file in `src/` imports `React` — the transform is supposed to
       * emit the `react/jsx-runtime` calls itself. esbuild's DEFAULT is the
       * classic `React.createElement`, which compiles the same files into code
       * referencing a binding that is not there: every component rendered under
       * this loader failed with `ReferenceError: React is not defined`, at
       * render time rather than at import, so it looked like a fault in the
       * component. Set here rather than worked around in the test, because the
       * harness is what was wrong with it — and because "add an unused React
       * import so the test passes" is editing the product to suit the test. */
      jsx: 'automatic',
      /* 🔴 `import.meta.env` IS VITE'S, NOT NODE'S. Vite defines it on every
       * build; this loader does not, so the first source file to read it —
       * `cad/CadTab.tsx`'s DEV-only auto-mount — crashed EVERY test that
       * imports the component with `Cannot read properties of undefined
       * (reading 'DEV')`, at import time, before a single assertion ran. The
       * substitution below is the same one Vite performs, with the one value a
       * test harness can honestly claim: an EMPTY env, so `DEV` is falsy and
       * no dev-only path runs under `node --test`. Anything that needs a
       * VITE_* variable is configuration, and configuration belongs to the
       * test that needs it — not faked here, where a default would quietly
       * decide it for every file. */
      define: { 'import.meta.env': '{}' },
      sourcefile: file,
      sourcemap: 'inline',
    });
    return { format: 'module', source: out.code, shortCircuit: true };
  }
  return next(url, context);
}
