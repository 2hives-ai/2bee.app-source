# Plan — store to the server, not the browser

**Founder, 2026-11-17, verbatim:** *"When I store something it should store back to the server,
not into the browser!"* Ticket: `handover/2bee_app/2026-11-17-11-45-20-ceo-store-to-server-not-browser-localstorage-audit.md`.
Backend's proposed store: `handover/2bee_app/2026-11-17-11-45-57-backend-server-store-backend-half-design-awaiting-your-triage.md`.

**How the list was made:** `grep -rlE "localStorage|sessionStorage" web/src` (39 files, auth excluded),
then a census of every storage-key constant:
`grep -rnoE "(const|export const) [A-Z_]*(KEY|PREFIX)[A-Z_]* = '…'" web/src`. The census matters:
**four data files never name `localStorage`**, because the store is passed in as a parameter
(`machines/printers.ts`, `materials/components.ts`, `materials/stock.ts`, `print3d/bridges.ts`), so
ceo's grep missed them. IndexedDB was also not covered: `store.ts` (DB `2bee.slicer`) and
`shop-setup/toolPhotos.ts`. **IndexedDB holds the biggest real data, so it matters most here.**
Sizes are estimates from the data shape. Nothing was measured from a real user's browser.

## (b) Real data — move to the server

These are things the operator made or measured. Losing them by changing browser or device is the
founder's complaint.

| # | Source | Key / store | What it holds | Size (estimate) | Doc kind |
|---|---|---|---|---|---|
| B1 | `store.ts` `saveCadModel` | IDB `2bee.slicer` / `drawings` | **Saved designs** (the CAD Save button) and imported DXFs | KB to several MB per drawing | `drawing`, body in S3 |
| B2 | `store.ts` | IDB `machines`, `workpieces`, `spoilboards`, `operations` | Saved CNC setups the operator built | < 50 KB each | `machine`, `workpiece`, `spoilboard`, `operation` |
| B3 | `store.ts` | IDB `inventory` | Shop inventory imported from bom/ops | up to ~1 MB | `inventory`, body in S3 |
| B4 | `cncjob/jobs.ts` (+ `state.ts`) | `2bee.app.cncjob.jobs` | CNC job book: jobs and their state | < 200 KB | `cncjob` |
| B5 | `cncjob/machines.ts` (+ `state.ts`) | `2bee.app.cncjob.machines` | Router registry (machines, collets) | < 50 KB | `machine-registry` |
| B5b | `machines/printers.ts` (+ `OtherMachines.tsx`) | `2bee.app.machines.printers` | Printers the operator added | < 20 KB | `printers` |
| B12 | `materials/stock.ts` | `2bee.app.materials.sheets`, `…filaments` | Sheet and filament stock on hand | < 50 KB | `stock` |
| B13 | `materials/components.ts` (+ `componentsData.ts`) | `2bee.app.materials.onhand` | Components on hand | < 50 KB | `components-onhand` |
| B6 | `run/RouterPage.tsx` | `2bee.app.router.measured` | Measured router facts | < 10 KB | `router-measured` |
| B7 | `shop-setup/toolPhotos.ts` | IDB `photos` | Photos of the operator's tools | 50–500 KB each | `tool-photo`, body in S3 |
| B8 | `spec/specStore.ts` (+ `SpecPanel.tsx`) | `2bee.app.spec.*` | The operator's own spec text per design | < 50 KB | `spec` |
| B9 | `shop/archive.ts` | `2bee.app.shop.archived` | Designs the operator archived (hidden) | < 100 KB | `shop-archive` |
| B10 | `cad/session.ts` | `2bee.app.cad.session` | **Unsaved** CAD edit buffer + camera | up to ~1 MB | `cad-session` (see note) |
| B11 | `store.ts` `writeSession` | `2bee.app.session` | CNC tab's working session | < 200 KB | `cnc-session` (see note) |

**Note on B10/B11:** these are working state, not saves. Their header says *"WHAT THIS IS NOT: a
save"*. They still go to the server: an edit left half-done on the workshop PC should be there on
the laptop. They are the last to move, after the real saves.

**`materials/componentsData.ts`** only reads the on-hand list (B13). It moves when B13 moves.

## (a) Local UI state — stays in the browser

These are per-device view choices. Moving them would make one screen's layout follow you to a phone.

`App.tsx` (cnc view, report width), `Tabs.tsx` (open tab, panels), `panels/panelPersistence.ts`, `panels/viewPersistence.ts`
(projection, units), `resizable.tsx` (pane sizes), `cad/CadTab.tsx` (cad view/layout),
`pnp/PnpTab.tsx` (view, board, machine picked), `pcbtab/PcbTab.tsx` (board picked),
`materials/MaterialsTab.tsx` and `machines/MachinesTab.tsx` (which list is showing),
`gates/GatesPanel.tsx` (collapsed or open), `loaded.ts` (which tabs are enabled), `cncMenu.tsx`
(comment only), `cad/preview.tsx` (a React key, not storage).

## (c) Device config and caches — stay local, on purpose

| Source | Why it stays |
|---|---|
| `cad/ask.tsx` `2bee.app.cad.ask`, read by every chat panel (`CncAskPanel`, `CncChat`, `CutAssistant`, `MakeFlow`, `PrintJob`, `PnpChat`, `print3d/Assistant`, `RunChat`, `ToolChat`, `ShopChat`) | URL and bearer token of the **local** claude bridge on `127.0.0.1`. A token must not go to a server, and the address only means something on that machine. |
| `print3d/bridges.ts` `2bee.app.print3d.bridges` (via `Print3dTab.tsx`) | LAN address of the printer bridge, which is per network. Candidate for later: the printer's identity could move with B5. |
| `cnc/thumbnail.ts`, `shop/pcbThumb.ts` `2bee.app.thumb.*` | Rendered pictures. A cache; it can be rebuilt. |
| `auth.ts` / `AuthGate.tsx` | PKCE verifier and tokens. Must stay local. |

**Chat history:** no chat panel stores its conversation; the 10 chat files only read the bridge
config. So there is nothing to migrate for "chat history" today.

## Plan — order of work

1. **backend:** `two-bee-app-docs` table + `/app/docs/{kind}` API as proposed (owner-only, versioned
   PUT with 409 on a stale write; S3 presigned PUT for bodies over ~300 KB). The kinds are listed
   above. Nothing is shared across users.
2. **2bee_app — client store module** `web/src/serverStore.ts`: list/get/put/delete with the
   Cognito token, version handling and a visible "saved to server" / "NOT saved — offline" state.
   A save that did not reach the server must say so. It must never look saved.
3. **B1 first** (CAD Save + drawings): the founder's words are about "when I store something".
4. B2–B9, B12, B13 next, one ticket per group, each with the one-time import of local data on first login.
5. B10/B11 last.
6. Local storage stays only as an offline cache, replaced by the server copy on load.

**Not in this plan:** sharing between users, and the dev mode with no login. With no Cognito
config there is no user, so storage stays local and the UI says "local only".
