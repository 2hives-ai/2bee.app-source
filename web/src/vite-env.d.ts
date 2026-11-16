/// <reference types="vite/client" />
// ⚠ THE REFERENCE ABOVE MUST BE THE FIRST LINE. It sat below the
// `__CTRL_TRANSCRIPTS__` declaration until 2026-10-15, where tsc treats a
// triple-slash directive as an ordinary comment — so none of `vite/client`'s
// types loaded and `import.meta.glob` was "not a property of ImportMeta" in every
// file that used it (found by the pnp board list, `src/pnp/boards.ts`).
// Build-time flag: true when committed controller transcripts exist in
// gates/controller/.  Set by the `define` in vite.config.ts.
declare const __CTRL_TRANSCRIPTS__: boolean;


// Raw text imports. The sample drawings are DXF files consumed as TEXT: the
// importer parses the file's own bytes, so a bundler transform between the
// drawing and the parse would be a second thing to be wrong.
declare module '*.dxf?raw' {
  const content: string;
  export default content;
}

// Cognito OIDC auth environment variables (VITE_ prefix = baked into bundle).
// All three must be set for auth to activate; if any is missing, the gate is
// open (dev/CI mode with no Cognito). See .env.example.
interface ImportMetaEnv {
  readonly VITE_COGNITO_DOMAIN: string;
  readonly VITE_COGNITO_CLIENT_ID: string;
  readonly VITE_COGNITO_REDIRECT_URI: string;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly PROD: boolean;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// STL imports as URLs (for mesh samples loaded via fetch).
declare module '*.stl?url' {
  const url: string;
  export default url;
}
