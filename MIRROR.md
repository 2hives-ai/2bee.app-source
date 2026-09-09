# Corresponding Source mirror — `2bee.app`

This repository is the **AGPL-3.0-or-later §13 Corresponding Source offer** for the application
served at `https://2bee.app/`. It is a mirror of the `software/2bee.app/` subtree of 2BEE FARM
PTY LTD's private monorepo, published to discharge the §13 obligation that attaches when the work
is made available to users over a network.

| | |
|---|---|
| Licence | **AGPL-3.0-or-later** (`LICENSE`) |
| Mirrored subtree | `software/2bee.app/` |
| Source revision | `691558f97f94f2b078ca35329a866a3048867e43` |
| Mechanism ruling | 2026-09-04, adopting the 2026-08-11 analysis |

## What is here

The Rust core (`core/`), its WASM binding (`wasm/`), the CLI (`cli/`), the React UI (`web/`), the
grblHAL post-processor (`grblhal/`), the gate runner (`gates/`), and the design and audit records
under `docs/`.

## What is deliberately NOT here, and why

- **The rest of the monorepo.** It holds financial records, contracts and patent material that are
  not Corresponding Source for this application and are not published.
- **`AGENTS.md`.** Internal operating instructions for the automated sessions that maintain this
  code. It is not source needed to generate, install or run the work.

## Known completeness caveat — stated rather than discovered

`npm run build` runs `npm run shop`, which **reads a CAD tree (`hardware/cad/`) that is not in this
mirror**. Built from this repository alone, the application compiles and runs, but its Designs
catalogue is empty. Whether that generator input is itself Corresponding Source is an open question
routed to counsel; it is recorded here rather than left for a reader to trip over.

## Requesting anything absent

If you believe a file needed to build or run the served application is missing from this mirror,
open an issue. Requests for Corresponding Source under §13 are answered.
