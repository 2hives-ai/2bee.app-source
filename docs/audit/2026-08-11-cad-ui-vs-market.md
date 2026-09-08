# Audit — `2bee.cad`'s UI against what a CAD user already knows

**Written:** 2026-08-11, 12:26–12:40 +1000 · **Scope:** the `2bee.cad` menu bar, its File
commands, its keyboard policy, and the OpenSCAD surface it is modelled on.
**Reference read:** OpenSCAD's own source on this box.
**Nothing in this audit was changed.** It is a read-only pass over another agent's live files.

---

## 0. What was audited, exactly when, and how — read this before quoting anything below

🔴 **`web/src/cad/**` WAS BEING REWRITTEN WHILE THIS RAN, AND IT MOVED FOUR TIMES.** This is
not a caveat, it is the first finding: three of this lane's findings have gone stale within
hours this week, and a line-level claim about a file that changed twice during the audit is
worthless without the hash it was true of. So every claim below is pinned to a content hash,
not to a date.

**Repository state.** `HEAD` was `8ad69f2e9c864b1f7311288ece32393ad5ec94dd` (2026-08-11
12:26:43 +1000) at the start and `00a68b617a` (12:33:20) at the end. **None of the six commits
in between touched `web/`** — they are other lanes' compliance-pulse commits. Every change to
the CAD tab during this audit was **uncommitted working-tree** work by the live agent. The last
commit that touched `web/src/cad` is `4e9bb8c758` (11:54:55), *"a model can propose a SCAD edit,
and an OpenSCAD-shaped menu — with no key bound and no endpoint baked in"*.

**Per-file pin.** MD5 of what was actually read:

| File | Hash when read | Hash at 12:36 | Moved during the audit? |
|---|---|---|---|
| `web/src/cad/menu.tsx` | `efbda289…` (12:27) | `ad89b80b…` | **yes, twice** (`9f820f35` at 12:35) |
| `web/src/cad/CadTab.tsx` | `685f291d…` (12:27) | `acbefe37…` | **yes, twice** (`d12b4f21` at 12:35) |
| `web/src/App.tsx` | `a3a4cffb…` (12:27) | `c3ce363d…` | **yes** |
| `web/tests/cad-menu.test.ts` | read ≈12:31, **not pinned** | `b6ff9752…` | **yes, twice** — see below |
| `web/src/cad/library.ts` | — | `ee98cefd…` | **did not exist at 12:27** |
| `open.tsx` `preview.tsx` `editor.tsx` `replace.ts` `record.ts` `mesh.ts` `scad.ts` `console.tsx` `ask.tsx` | 12:27 | unchanged | no |

⚠ **One admission of method:** `web/tests/cad-menu.test.ts` was read before I started hashing,
so my description of it is **as-of roughly 12:31 and cannot be pinned**. It has changed twice
since (267 → 318 lines). Treat §4's remark about what that test can and cannot assert as
*probably* still true and *not* verified against the current file.

**Everything here is read from source.** There is no browser and no WebGL on this box, and CDP
port 9222 is the founder's personal browser and is banned absolutely, for reads as well as
writes. **No pixel of this UI was seen.** Nothing below claims that anything rendered, that a
key press did anything, or that a control was reachable with a mouse. Where a claim depends on
browser behaviour it is marked.

**The OpenSCAD reference was read, not remembered.** `/home/gbacs/apps/openscad` at
`2328d12c3a42dd05b94b49fef8e2414edc41dbee` (2026-08-07). `src/gui/MainWindow.ui` was parsed
**as XML**, not grepped — a first grep-based pass mis-assigned menu contents because `.ui`
nests submenu widgets inside their parent and a line-oriented scan cannot see the close tag.
Measured: **six top-level menus in `menubar`'s own `addaction` order** — File, Edit, Design,
View, **Window**, Help — and **105 `<action>` elements**. Shortcuts were read from each
action's `shortcut` property. `src/core/MouseConfig.h` was read for the camera presets.

**Where I describe FreeCAD, Fusion, SolveSpace, Figma, Google Docs or VS Code for Web, I read
no source for any of them.** Every such claim is marked **[unverified — general knowledge]**
inline. A confident description of a UI nobody checked is the failure this lane keeps finding,
and it is not going to be introduced by the audit that was sent to look for it.

### 🔴 A method defect found on the way, recorded because it nearly produced a false finding

`grep` **silently returned no matches on `web/src/App.tsx`** — a 9,345-line file — for every
pattern tried, including `import`. `Read` and a Python scan of the same file at the same moment
found 6 `href`, 3 `onRemoveItem`, and a `<footer className="foot">`. On the strength of the
grep I had begun writing the finding *"the AGPL §13 source offer is not rendered anywhere in
the served UI"*. **It is rendered** — `App.tsx:9340–9349`, in the app-shell footer outside the
tab panels, and `handover/2bee_app/2026-08-11-monitoring-P0-2bee.app-RESOLVES-AGPL-13-offer-is-now-live.md`
says so independently. **Retracted before filing.**

The reason it is written down anyway: a search that reports *"no match"* indistinguishably from
*"did not run"* is the same defect class this lane audits in its own gates, and it produced a
plausible, confident, entirely false finding in about ninety seconds. The probable cause is
environmental — **`/tmp` is a 62 GB tmpfs at 100 % (44 KB free)**, and one Bash call in this
session died outright with `ENOSPC` on its output capture. Anything else running searches on
this box right now is exposed to the same silent-empty result. That is a fleet condition, not
this lane's, and it is reported up rather than fixed here.

⚠ One consequence for this document: **all of my `grep`-derived absence claims were re-run
through Python.** Where I say "there is no X", it was counted with `re.findall`, not grepped.

---

## 1. Menu structure — ours against theirs

### The shapes, measured

| OpenSCAD menu | actions | `2bee.cad` | items |
|---|---|---|---|
| File | 22 (+14 Export, +4 Python, +2 empty submenus) | File | 7 |
| Edit | 36 | Edit | **1** |
| Design | 14 | Design | 3 |
| View | 27 | View | 4 |
| **Window** | 5 | — | **absent** |
| Help | 7 | Help | 1 |
| **6 menus, 105 actions** | | **5 menus, 16 items** | |

*(16 as of `menu.tsx@ad89b80b`, 12:36. It was 14 at 12:27 — `Save as…` and
`Open library folder…` landed mid-audit.)*

OpenSCAD's File order, verbatim from the `addaction` list: `New, Open, OpenRecent, Examples,
Reload | NewWindow, OpenWindow, Close | Save, SaveAs, SaveACopy, SaveAll | Export | Python |
ShowLibraryFolder | Quit`.

Ours: `New, Example | Open…, Save…, Open library folder…, Save as… | Export as STL (binary)…`.

### Divergences, and whether each is a decision

**Deliberate, well-reasoned, and I would not change them:**

- **No Window menu.** Verified at the source: `menuWindow` holds Next Window, Previous Window
  and Jump To — all about multiple OpenSCAD *windows*. Nothing maps onto a browser tab. Correct.
- **No Export submenu, one export item.** OpenSCAD offers 13 formats plus an image export; we
  can write one. A submenu with one child is worse than an item.
- **`Example` as a single item, not an `Examples` submenu.** We ship exactly one model.
- **`Design → Check Validity` keeps OpenSCAD's label and states that it *reports* rather than
  *causes*.** This is the best control in the bar — see §4.
- **`Design → Ask a model to change this source…`, which OpenSCAD does not have.** A divergence
  in the *adding* direction, and the right one; the app has a function OpenSCAD lacks.

**Deliberate, but the reason recorded for it is not the reason that is true** — this is §4's
material, and it is where the real value of this audit sits:

- **`View` carries no camera item, and the omission list says the camera actions are absent.**
  The camera is not absent. It is implemented in `preview.tsx` — orbit, pan, wheel-zoom, and a
  `Fit` control at `data-testid="cad-preview-fit"` — with the directions documented and, per
  the 2026-08-10 audit's F3, measured against OpenSCAD's own convention. See §4, finding A.
- **`Edit` carries one item, and the omission list says the browser owns the rest.** It owns
  five of the eleven things that sentence covers. See §4, finding B.

**Accidental — an append rather than a decision, and cheap to fix:**

- 🔴 **`Open library folder…` sits *between* `Save…` and `Save as…`.** In OpenSCAD,
  `fileShowLibraryFolder` is near the bottom of File, after Export and Python, one separator
  above Quit; `Save` and `Save As` are adjacent, in that order, with no separator between them.
  Every desktop CAD and text application I can name keeps Save/Save As adjacent **[unverified —
  general knowledge for anything other than OpenSCAD, which was read]**. Splitting them with a
  third, unrelated command means the item a user reaches for by *position* is the wrong one.
  **Cost: low but recurring, and it is a two-line move.** This reads as the shape of a menu
  array that got a new entry pushed in beside the one being edited at the time, not as a
  judgement about grouping.
- **`Edit` is where a CAD user's `Ask a model…` would be looked for, and it is in `Design`.**
  The command rewrites *source text*, which is Edit's subject; Design is OpenSCAD's
  evaluate/render menu. Low cost — it is also in `View` as a pane toggle, so it is discoverable
  two ways — but it is a placement nobody argued for in the file's comments, which is the
  signature of an accident rather than a decision.

### Is the recorded omission list honest and complete?

`OMISSIONS` (8 entries, `menu.tsx@ad89b80b`) is rendered in `Help → About`, which is the right
place and a genuinely unusual amount of honesty for a menu bar. Its header makes a strong claim:

> *"We did not get to it" and "the thing it controls does not exist" are different facts, and
> only the second is a decision. **Every line here is the second.**"*

**Five of the eight entries meet that bar** — Preview/Render, the Customizer, the export
formats, Display AST / CSG Products, and the Reload/Recent/Quit family. Each names a capability
that genuinely does not exist, and the reasons are checkable at the code.

**Three do not**, and they are detailed in §4: the camera entry (a scope statement), the
Undo/Find/Indent entry (two different reasons, the weaker asserted for all), and the catch-all
entry's inclusion of *preferences* (which do exist and are persisted).

**Completeness:** nothing material is missing. `Save a Copy`, `Save All`, the Window menu,
the manual and the cheat sheet are all named. One gap opened *during* the audit — the list
still says the `Reload/Open Recent/…` family is absent because *"there is no file handle in a
browser tab"*, and `library.ts` arrived at 12:36 introducing a library-folder concept. I checked:
`library.ts` uses **no** File System Access API (`showDirectoryPicker`, `showOpenFilePicker`,
`FileSystemHandle` — zero occurrences); it is a path map over stored content. **So the stated
reason is still true.** Flagged only because the next person to add a folder feature may make
it false without noticing the sentence that depends on it.

**What checks the honesty claim: almost nothing.** The test asserts each omission is longer
than 60 characters and that five keywords appear somewhere in the joined string. Length is not
a reason and a keyword is not a capability claim. **The strongest sentence in the file is the
one with no control behind it** — and the three entries that fail it are exactly the ones a
length check waves through. *(As-of my ≈12:31 reading; the test has moved twice since.)*

---

## 2. Open and Save

The founder asked for both to bring up a real chooser rather than a prompt. **Measured: there
is no `prompt(`, `confirm(` or `alert(` anywhere in `web/src/cad/**`** (counted with a regex
scan, not grep). The one surviving `alert(` in the app is `App.tsx:7686`, in the CNC tab's tool
import. On that specific ask, the CAD tab is done.

### The conventions, and which earn their place with no filesystem

| Convention | Ours | Earns its place here? |
|---|---|---|
| **Ellipsis = further input required** | `Open…`, `Save as…`, `Export as STL (binary)…` have dots; `New` and `Example` do not; `Save` carries dots **only when the model has no name yet** | ✅ **Yes, and this is better than OpenSCAD**, whose `&Save` never has dots because it always has a path. Ours has a path only sometimes, and the label now says which. |
| **Open opens a chooser immediately** | `file.open` mounts `CadOpen` with `defaultOpen` on the picker | ✅ Yes. The menu item does not scroll to a panel — a command that merely reveals something further down the page reads as a menu item that did nothing. |
| **Save vs Save As are two different commands** | Landed **at 12:35, mid-audit**: `Save` writes straight over the known name; `Save as…` always opens the list | ✅ Yes — see the note below. |
| **Overwrite is warned before it happens** | The save control **relabels** to `Replace "name"` before the press, plus a warn strip, plus the dialog now shows the existing list so a collision is visible *before* naming | ✅ **Better than the market convention**, which is a modal *after* you press Save **[unverified — general knowledge]**. Keep it. |
| **A third state for "I do not know"** | `Save (name list unread)` when the store read failed | ✅ Beyond convention and correct. An empty list and an unreadable one look identical, and the difference decides whether "Save" or "Replace" is the true word. |
| **Recent files** | None, and `store.ts:191` sorts the list **alphabetically by name** | ⚠ *Open Recent* as a **file** concept does not earn its place — there are no paths. **Recency does.** See §3. |
| **A native OS file dialog** (`showOpenFilePicker`) | Not used | ❌ **Do not add it.** It is Chromium-only, and it would make `Open` mean two incompatible things — a browser-store record with source, versus a file on disk with none. The app has no disk story and should not grow half of one to look familiar. |
| **Delete / manage saved files** | None in this tab | ❌ See §3 — and this one is inconsistent with the app's own convention. |

### 🔴 On the Save/Save-As work that landed while this was being written

At `CadTab.tsx@685f291d` (12:27) there was **one** save control and `SaveToDrawings` initialised
its name field to `''` with no seed from the opened record. `openModel` received the name and
used it only for a label. **Every save after an open therefore started from an empty name box**,
so an operator who opened `bracket`, edited it, and saved either retyped `bracket` exactly to
get the Replace affordance, or silently forked their model under a new name.

By `menu.tsx@ad89b80b` / `CadTab.tsx@acbefe37` (12:36) that is **fixed**: `savedName` is state,
set by an open and by a save, cleared by every replacement that does not carry a name, and
`SaveDialog` takes `initialName`. I verified this at the code and I am **not** filing it as an
open defect.

**The lesson survives the fix and is worth more than the defect was:** the missing piece was not
a dialog, it was the *identity* of the thing being edited. A browser store has no path, so
nothing carries a document's name for you; if the tab does not hold it explicitly, Save
degrades into Save As and the operator's model quietly forks. Anything else that behaves like a
document — a saved tool set, a session — has the same hole by default.

**One residual on the new design**, stated as a question rather than a defect because the file
was still being written: `Save "bracket"` writes over the record with no dialog, which is the
correct market behaviour, and the note says so plainly (*"No dialog, and the record it replaces
is gone."*). The comment on `savedName` says every replacement clears it so a blank file cannot
silently overwrite a named record — that reasoning is sound and I could not exercise it.

---

## 3. What a CAD user will reach for and not find, ranked by how often

Ranked by **frequency × cost**, not by distance from OpenSCAD.

**1. Comment / uncomment a block.** OpenSCAD binds `Ctrl+D` and `Ctrl+Shift+D` (read from the
`.ui`). Commenting a module out to isolate a problem is the single most common editing gesture
in SCAD work **[unverified — general knowledge, but see the next sentence]**. **The tab's own
shipped example ends with `// Try uncommenting either line below and watch it get named, not
ignored:`** — the first thing the example asks the user to do is the thing the editor has no
command for. On one line it is a keystroke; on a block it is manual work every time.
**This is a genuinely absent capability, not a delegated one** — the browser owns no such
command — and it is the top of this list.

**2. Undo of typing (`Ctrl+Z`) — status unknown, and the unknown is the cost.** The tab has no
undo and says so repeatedly; the put-back covers *replacements* (New / Example / Open /
accepted proposal) and correctly refuses to call itself undo. Typing-undo is **delegated to the
`<textarea>`'s native stack**, which the omission list states as fact. **That delegation has
never been exercised in a browser** — a controlled React textarea whose value round-trips
through state is exactly the configuration in which native undo is unreliable **[unverified —
general knowledge; there is no browser on this box and no e2e test presses `Ctrl+Z`]**. If it
works the cost is zero; if it does not, the cost is every mis-typed line in a 200-line model.
**Not knowing which is itself the finding**, and it is one e2e assertion away from being known.

**3. Find that moves the caret (`Ctrl+F`).** The browser's find will match the highlight layer —
`editor.tsx` renders the same text into an `aria-hidden` `<pre>` under a transparent textarea —
so a user can *locate* a string **[unverified in a browser]**, but the caret is in the textarea
and find cannot put it there. In a file with several modules this is frequent. Degraded, not
absent; moderate cost.

**4. Deleting a saved model.** `ObjectPicker` supports `onRemoveItem` and **`App.tsx` uses it in
three places** (counted). `open.tsx` passes it nowhere. So the CAD tab is inconsistent with the
app's own convention, the drawings list only ever grows, and the tab's own row text tells the
operator the only remedy: *"Clearing site data deletes it — there is no server copy."* That is
an all-or-nothing remedy for a per-item problem. **Moderate frequency, high cost when it bites.**

**5. Recency.** `store.ts:191` sorts A→Z. With no delete (above) and no Open Recent, the model
you were working on ten minutes ago is wherever the alphabet put it. The save time is already
on every row, so this is a sort key, not a feature.

**6. Camera view presets and orthographic projection.** OpenSCAD gives Top/Bottom/Left/Right/
Front/Back `Ctrl+4`…`Ctrl+9`, Diagonal `Ctrl+0`, Center, View All `Ctrl+Shift+V`, Reset View,
and a perspective/orthogonal toggle. We have orbit, pan, wheel-zoom and `Fit`. For checking a
part before committing it to a cut, "look at it from the top" is constant. **The camera exists;
only the presets do not** — which is why this is in §4 as well.

**7. Indent / unindent a block (`Tab`).** `editor.tsx` deliberately does not trap `Tab`, because
trapping it makes the editor a keyboard trap for anyone who arrived by keyboard. **That call is
correct and I would not reverse it.** The cost is real and the mitigation the market uses —
`Tab` indents, `Esc` then `Tab` escapes **[unverified — general knowledge]** — is a real feature
to build, not a control to copy.

**8. Preferences.** Nothing collects them. Low cost; noted only because the omission list claims
they do not exist (§4, finding C).

**Not on this list, deliberately:** a Customizer, a Render button, an export format list, Open
Recent as a *path* concept, New Window, Quit. Each of those would be a control for a function
this app does not have, and none of them should be built to look familiar.

---

## 4. 🔴 Where "close to the market" conflicts with being honest

**The standard this tab already set, and it is the right one.** OpenSCAD splits `F5` Preview and
`F6` Render because they are two different computations. `mesh.ts` always computes real booleans
and always audits the result — **one evaluation path**. Two buttons would assert a capability
difference that does not exist, so there is one, and `OMISSIONS` says why. **That is the
correct trade every time, and the four findings below are all measured against it.**

### Finding A — the camera omission is a *scope* statement wearing a *capability* statement's clothes

> *"Every camera action — Top/Bottom/Left/Right/Front/Back, zoom, perspective/orthogonal, show
> edges/axes/crosshairs. **The preview owns the camera and this change does not touch it.**"*

That sentence is true. It is also **not the claim the list's header makes about every line in
it** — *"the thing it controls does not exist"*. The camera does exist: `preview.tsx` implements
orbit, pan, wheel-zoom and a `Fit` control, with the drag directions documented in the file and
verified against OpenSCAD's convention in the 2026-08-10 pass (F3). The honest form is *"not yet
wired to the menu"*, which is a different fact with a different consequence: a reader of
`Help → About` currently concludes we **cannot** show a top view.

**Why this matters more than a wording nit:** the whole value of that list is that a reader can
trust *"absent"* to mean *"impossible"*. One entry that means *"unbuilt"* devalues the other
seven, and the reader cannot tell which is which from the outside. **Two clean fixes, both
honest:** say "not wired to the menu, and the camera controls are on the picture" — or wire
Top/Front/Right/Reset, which is permitted precisely *because* the function exists.

### Finding B — one omission line bundles two different reasons and asserts the weaker one for all of them

> *"Undo, Redo, Cut, Copy, Paste, Find, Indent, bookmarks, tab-conversion. The editor is a
> textarea and **the browser already owns those keys**…"*

The browser owns **Undo, Redo, Cut, Copy and Paste**. It does **not** own **Indent, Unindent,
Comment, Uncomment, bookmarks or tab-conversion** — those are editor commands with no native
equivalent, and OpenSCAD binds `Ctrl+I`, `Ctrl+Shift+I`, `Ctrl+D`, `Ctrl+Shift+D`, `Ctrl+F2`,
`F2`, `Shift+F2` for them (read from the `.ui`). Six genuinely absent capabilities are
accounted for by a reason that is true of five different ones. **Cost:** the item at the top of
§3 — comment-toggling — is currently recorded as *someone else's job* rather than as
*something we have not built*, so nobody will build it.

### Finding C — "preferences" are listed as absent while the tab persists three sets of them

> *"Library info, font list, Python venv, 3D Print, measure distance/angle, flush caches,
> **preferences**, the Window menu, the offline manual and the cheat sheet. **Nothing here
> implements what any of them control.**"*

The tab persists a layout preference object under `2bee.app.cad.layout` (split, dock height,
active pane), ships `View → Reset panel layout` — which is a preferences *action* — and
`ask.tsx` persists an endpoint, a model id and optionally a key. **Preferences exist; they are
scattered, which is a different statement.** Smallest cost of the four, and the easiest fix:
drop the word from that line.

### Finding D — the File footnote overstates the coverage of its own guard, and this one has a real cost

The File menu's footnote, verbatim:

> *"No keyboard shortcuts are bound here. **F5 reloads the browser and Ctrl+S saves the page —
> both would be lost work**, and intercepting F5 would take your reload away. **Unsaved changes
> raise the browser's own leave-page warning instead.**"*

The guard is a `beforeunload` handler registered while the editor is dirty (verified at
`CadTab.tsx`, and there is a test asserting it is registered). `beforeunload` fires on
navigation, reload, back and tab close. **It does not fire on `Ctrl+S`** — Save Page does not
unload the document **[platform behaviour; not measured on this box]**.

So the footnote names two keys, calls both lost work, and then offers one guard as the answer to
both. **It covers one of them.** The failure mode of the uncovered one is the worst in this
section: an operator presses `Ctrl+S` out of thirty years of muscle memory, a browser save
dialog appears, they save an `.html` of the application, **and they believe their model is
saved.** Nothing contradicts them — the dirty indicator still says "unsaved changes", but they
have just been shown a save dialog that completed successfully.

**This is a control asserting something untrue about itself in operator-facing text**, which is
this lane's own named defect class. The minimum fix is one clause — *"…and `Ctrl+S` gives you
the browser's Save Page, which does not save your model"*. The better fix is in §5.

### Non-conflicts worth naming, because they are the model to copy

- **`Design → Check Validity` keeps OpenSCAD's exact label for a different mechanism, and says
  so in the control:** *"This audit runs on EVERY evaluation, not only when you ask. The menu
  item reports it; it does not cause it."* OpenSCAD's version computes on demand; ours reports a
  standing verdict. **A familiar label plus one sentence that refuses the implication is the
  cheapest honest way to be familiar**, and it is available to several of the items above.
- **The Export item names its one format in its label** — `Export as STL (binary)…` — rather
  than being a bare `Export…` that opens a list of one.

### Two more the market will tempt this tab into, that would be lies

- **A "rendering…" progress indicator or spinner.** The mesh is debounced 250 ms and the STALE
  marker already tells the truth. A progress bar for a computation with no progress to report is
  the same shape as a Render button that renders nothing new.
- **An auto-reload / "watch file" toggle** (OpenSCAD's `designActionAutoReload`). There is no
  file to watch. It would be a control whose off-state is the only state.

---

## 5. Keyboard — is "bind nothing" the right call, and does it hold for the rest?

**Measured, not assumed:** across `web/src/cad/**` the only global listeners are `beforeunload`
(CadTab), `mousedown` (the menu's click-away), and pointer/wheel/contextmenu (the preview).
**There is no `keydown` handler at document or window level and no accelerator of any kind.**
The `MenuBar`'s `onKeyDown` handlers are the WAI-ARIA menubar pattern — arrow keys *within* an
open menu — not application accelerators. The policy is implemented as described.

**Per key:**

- **`F5` — do not bind. The tab's reasoning is right and I would not change it.** Intercepting
  reload on a page that has needed a reload is a worse trap than the one it prevents, and
  `beforeunload` covers it, plus `Ctrl+W`, back, and tab close, without taking a key from anyone.

- **`Ctrl+S` — this is the one where "bind nothing" costs the most, and I think it is wrong.**
  It is interceptable, unlike `F5` it costs the operator nothing worth having (Save Page in a
  CAD tab is not a thing anyone means), the guard does not cover it (finding D), and the failure
  mode is a *silent false belief that the model was saved* — the most expensive kind of failure
  this tab has. Every browser-based editor in the market intercepts it **[unverified — general
  knowledge]**. **And binding it does not break the rule: `Save` is a function we have.** Post-
  12:35 it has exactly the right shape — on a named model it saves, on an unnamed one it opens
  the dialog — so `Ctrl+S` would map onto `file.save` with no new behaviour invented.

- **`Ctrl+O` — the safest thing to bind, and the second candidate.** Interceptable, the function
  exists, and what intercepting costs is the browser's own open-a-local-file, which a user in a
  CAD tab did not mean. The cost of *not* binding it is mild — a file dialog appears, they
  cancel — so this is an improvement, not a defect.

- **`Ctrl+N` — do not bind, and the reason is different from `F5`'s.** Chrome and Firefox
  reserve `Ctrl+N` for a new browser window and a page **cannot** `preventDefault` it
  **[platform behaviour; not measured here]**. Binding it would produce a key that is advertised
  and does nothing — the exact dead-control defect the bar exists to avoid. **The tab reaches
  the right answer; the reason it records ("F5 reloads and Ctrl+S saves the page") does not
  cover this case**, so the next person to revisit the policy has to rediscover it.

- **`Ctrl+Z` — do not bind, and this is the most important "no" in the section.** A CAD user's
  hands will certainly try it, and it is *already doing something*: inside the focused textarea
  it is the native typing-undo that `OMISSIONS` explicitly delegates to. **Binding it to the
  put-back would steal typing-undo to provide a one-step action-undo** — a strictly worse trade,
  and it would make the delegation in the omission list false. The put-back is correctly labelled
  by the action it reverses and correctly refuses the word "undo"; leaving `Ctrl+Z` to the
  browser is the consistent position. What is missing is not a binding, it is the §3-item-2
  verification that the delegation works at all.

- **`Ctrl+Alt+E`** (OpenSCAD's Jump to next error) — free in every browser **[unverified]**, and
  the one accelerator whose absence costs nothing, because the item is one click away and the
  console rows are already clickable.

**Verdict on the policy:** *bind nothing* is the right default and was reached for good reasons,
but it has been applied as a blanket where the underlying arguments differ per key. Three
distinct situations are being given one answer — *interceptable but shouldn't be* (`F5`), *not
interceptable at all* (`Ctrl+N`), and *interceptable and should be* (`Ctrl+S`, `Ctrl+O`).

🔴 **If any accelerator is ever bound, the test that currently asserts no item advertises a key
must be INVERTED, not deleted** — to *"every advertised key is a bound key"*. Deleting it would
remove the only thing standing between this bar and a printed `Ctrl+S` beside an item that does
nothing, which is the defect the test was written for.

---

## 6. What I could not check

- **Anything visual.** No browser, no WebGL, no screenshot. I do not know that the menu bar
  renders, that a popup appears on click, that the Save dialog is reachable, that the app-shell
  footer is visible while the CAD tab is active (`CadTab` sets `height: 100%`; whether that
  pushes the footer out of view is a layout question I cannot answer), or that any key does
  anything at all.
- **Whether native `Ctrl+Z` works in this controlled textarea.** §3, item 2.
- **Whether `beforeunload` fires as described**, or whether the browser shows its dialog.
- **The AGPL §13 link's target.** `App.tsx:9346` points at `github.com/2bee-farm/2bee.slicer` —
  the lane's **pre-rename** name (renamed to `2bee.app` on 2026-08-09). Whether that URL
  resolves or redirects is a network question I did not and will not test from here. Flagged to
  the lane, not audited.
- **The current state of `web/tests/cad-menu.test.ts`.** Read ≈12:31, changed twice since.
- **FreeCAD, Fusion 360, SolveSpace.** No source read. Every comparison to them in this document
  is marked as general knowledge, and none of my findings depends on one.

---

## 7. Recommendations, ranked by what they cost the user

Looking different is not a defect; being unpredictable is. These are ordered by unpredictability,
not by distance from OpenSCAD.

| # | Change | Why it is worth doing | Cost class |
|---|---|---|---|
| **1** | Fix the File footnote so it does not offer the `beforeunload` guard as cover for `Ctrl+S` | A control that overstates its own coverage, in operator-facing text, protecting against a silent false save | **one clause** |
| **2** | Bind `Ctrl+S` to `file.save` | Removes the failure in #1 rather than documenting it; the function exists, so no rule is broken | small |
| **3** | Re-word the camera omission (or wire Top/Front/Right/Reset) | Restores the meaning of "absent" in a list whose whole value is that "absent" means "impossible" | one line, or a small feature |
| **4** | Split the Undo/Find/Indent omission into *delegated* and *not built* | Six absent editor commands are currently filed as someone else's job, so nobody will build them | one line |
| **5** | Build comment / uncomment | The most frequent SCAD editing gesture; the shipped example asks the user to perform it | small feature |
| **6** | Pass `onRemoveItem` in `CadOpen` | The house picker supports it, the CNC tab uses it three times, and the only current remedy deletes everything | small |
| **7** | Move `Open library folder…` out from between `Save` and `Save as…` | Save/Save As adjacency is positional muscle memory | two lines |
| **8** | Assert native `Ctrl+Z` in an e2e test | Converts the largest unknown in §3 into a fact, either way | one test |
| **9** | Sort the Open list by save time | With no delete and no Open Recent, alphabetical is the wrong default | one line |
| **10** | Drop "preferences" from the catch-all omission | They exist and are persisted | one word |

**Explicitly recommended against**, because each would be a control for a function we do not
have: a Customizer, a second evaluation button, a multi-format export list, an auto-reload
toggle, a render progress indicator, a native OS file picker, and `Ctrl+Z` bound to the put-back.

---

## 8. In-flight during this audit — what changed under me, for the next reader

Between 12:26 and 12:36, in the working tree and uncommitted:

- `Save` split into `Save` / `Save as…`, with `savedName` state carried through open, save and
  every replacement. **This closes what would have been my strongest §2 finding.**
- `Open library folder…` added to File, with a new `web/src/cad/library.ts` (336 lines) hosting
  `include <…>` / `use <…>` resolution against a picked folder.
- `CadTab.tsx` grew 1,208 → 1,611 lines; `menu.tsx` 526 → 557; `cad-menu.test.ts` 267 → 318.
- At 12:36 `CadTab.tsx` carried `case 'file.library'` and `menu.tsx@9f820f35` carried no such
  item; by `ad89b80b` it did. **A transient mid-write state, reported as such and not as a
  defect** — a snapshot of a file being written is not a finding about it.

**Any line-level claim in this document is true of the hash beside it in §0 and of nothing
else.** Where a claim is structural — the shape of the menus, the honesty rule and how it is
checked, the keyboard argument — it should survive the current pass; where it quotes a string,
check the hash first.

**Postscript, 12:44:49** — `menu.tsx` moved a *third* time while this document was being
written (`ad89b80b…` → `38eb9d97…`); `CadTab.tsx` was unchanged at `acbefe37…`. Everything §1
and §4 quote from `menu.tsx` is as-of `ad89b80b` and has not been re-checked against
`38eb9d97`. **Re-read the `OMISSIONS` array and the File item list before actioning
recommendations 3, 4, 7 or 10** — those four are the ones a single edit to that file could
already have closed, and a closed finding re-filed is worse than one never raised.
