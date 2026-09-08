# UI text sweep — `2bee.cnc` and `Run`

**REPORT ONLY. Nothing in `web/` was edited by this pass.** Founder, 2026-08-11: *"Audit all apps:
be tidy, no unnecessary text, make it clean end to end, messages, menus, navbar, help… etc."*

**Measured against the tree at 2026-08-11 ~15:15**, with `App.tsx`, `Viewport.tsx`,
`ObjectPicker.tsx`, `store.ts` and `savedSelection.ts` live under another agent. Every finding is
quoted **by its text**, never by line number alone — three agents are committing here and a line
number is stale before this file is read.

---

## 0. The constraint this sweep worked under, stated before the findings

🔴 **Shorter is not the goal. Unnecessary is.** A refusal that names what it refused and why, a
caution that says `assumed` rather than `entered`, a status line that separates *"we did not check"*
from *"it is not there"* — **those distinctions are the product**, and a recommendation to compress
one of them is a recommendation to make the tool lie more quietly.

So the categories below are not severity tiers. **Category 3 is a "do not touch" list**, and it is
here because the largest risk in acting on a tidiness instruction is that somebody deletes a
provenance clause to satisfy it. Two of the duplications found below are **deliberate and
documented in the code** — they are listed as keeps, with the comment that defends them, so a later
pass cannot mistake them for residue.

### Categories

| # | Meaning | Recommendation given? |
|---|---|---|
| **1 DUPLICATE** | The same words twice on one screen, or a header repeating its own section name. | ✅ replacement proposed |
| **2 DECORATIVE** | Tells the operator nothing they cannot already see. | ✅ replacement proposed |
| **3 REASON / PROVENANCE / SCOPE** | 🔴 **Keep.** Tighter wording only where no fact is lost, both versions shown. | only where lossless |
| **4 UNSURE** | Listed. **No recommendation.** | 🔴 none |

### ⚠ What this sweep could not do, said plainly

**There is no browser here.** *"Is this text unnecessary?"* is partly a question about how much of it
lands in one visual field at once, and I could not look at a screen. Every finding below was reached
by reading **both render conditions in the code** and confirming they can be true at the same time —
which establishes that the text **co-occurs**, not that it *reads* as clutter. Findings whose weight
depends on layout are tagged **[text-only]**. A session acting on those should open the app first.

### Tooling honesty

⚠ `grep` in this repo is `ugrep 7.5.0`, and it has silently dropped `App.tsx` before. **Verified
against a Python reader on two needles in two files before trusting any count:**

| Needle | file | `grep -o \| wc -l` | Python `re.findall` |
|---|---|---:|---:|
| `Spoilboard` | `web/src/App.tsx` | 97 | 97 |
| `sheet` (case-ins.) | `web/src/App.tsx` | 119 | 119 |
| `spoilboard` (case-ins.) | `web/src/Viewport.tsx` | 95 | 95 |

`App.tsx` reads as 521,335 bytes / 9,914 lines / **0 NUL bytes**. The tool is reading the file.

---

## 1. Tab bar, header and footer

### 1.1 🔴 CONTRADICTION — the Run panel's `focusable` reason describes an app from two commits ago

**`web/src/App.tsx`**, immediately above the Run `TabPanel`:

> `{/* `focusable` because this panel is text with nothing in it to focus — the WAI-ARIA pattern gives such a panel its own tab stop so a keyboard user can read it. …`

The panel it guards renders `<RunTab …>`, which draws **Connect, Start, Hold (feed), Resume, Home
($H), Unlock ($X), Jog, Cancel jog, Spindle stop, Zero (G10 L20), Stop, Abort** and a console input.
The premise — *"nothing in it to focus"* — is false.

**`web/src/Tabs.tsx` already records this** in `TabPanel`'s own doc block (*"AND THE ONE CALLER THAT
PASSES IT NO LONGER MEETS THAT CONDITION … the fix is at the call site, which this file does not
own"*). It is repeated here because the call site is in `App.tsx` and nothing has closed it.

⚠ **The prop is not the bug — the reason is.** Dropping `focusable` changes the keyboard order an
operator has in their hands, so this is a decision for the lane, not a tidy-up. **Category: 3
(a reason, and it is wrong).** Fix the sentence or the prop, deliberately.

### 1.2 Category 4 UNSURE — the `Run` tab's tooltip describes itself

**`web/src/Tabs.tsx`**, `TABS[2].hint`:

> `Execute and monitor the machine. NEVER RUN AGAINST A CONTROLLER — the tab says so, and says what it needs first.`

The trailing clause is a claim about the tab's own copy rather than about the machine. The
comparable `2bee.cad` hint does the same (*"the tab says what it is not"*). It may be doing real
work — telling someone the warning is inside rather than absent — or it may be a hedge. **[text-only]**,
no recommendation.

### 1.3 Nothing to report in the header or footer

Verified: the header renders **`2bee.app`** and nothing else on the operator path (`Job`/`Plant` are
behind `?fixtures=` / `?plants=`); the footer is `core <v> · G-code contract <v>` plus the AGPL §13
`source` link. The dead `2bee.slicer CNC CAM · grblHAL` strapline and the dry-run sentence are
already gone. 🔴 **The `source` link still points at a 404 repo** — that is a live §13 problem owned
by `legal` per `AGENTS.md`, **not** a text-tidiness finding, and this sweep did not touch it.

---

## 2. The left sidebar — the founder's own complaint, and where it still stands

The eight panel titles are `Machine · Spoilboard · Workpiece · Drawing · Work holding · Tooling ·
Operation · Verification`, plus `Saved data`. They match `docs/terminology.md` exactly.

✅ **The exact-repeat label defect (TODO #77) is fixed and I confirmed the mechanism rather than the
claim.** `ObjectPicker.tsx`'s `labelRepeatsHeading()` is exact, case- and space-insensitive, with no
stemming; `SectionHeadingContext` publishes the heading from `Section`; the repeated `<span
className="op-label op-label-quiet">` is **visually hidden and still announced** (`position:
absolute; width: 1px; … clip-path: inset(50%)`). `Tool` does not match `Tooling` and `Hold-down`
does not match `Work holding`, as intended.

🔴 **But the word survives on the same row in three other places the fix does not reach.**

### 2.1 🔴 Category 1 DUPLICATE — the trigger's action label repeats the heading

**`web/src/ObjectPicker.tsx`**:

> ```
> const actionLabel =
>   mode === 'multi' ? `Add ${label}` : selectedItems.length > 0 ? `Change ${label}` : `Choose ${label}`;
> ```

rendered into a **visible** span — `.op-trigger-action { flex: 0 0 auto; white-space: nowrap;
font-size: 0.72rem; color: var(--accent); }` — inside the trigger button, beside the caret.

So on the four panels whose picker label equals the heading, the screen reads:

| Panel heading | trigger, nothing chosen | trigger, something chosen |
|---|---|---|
| **Machine** | `choose a machine…` **`Choose Machine`** ▼ | `MakerSpace 6090` **`Change Machine`** ▼ |
| **Spoilboard** | `none declared — position UNCHECKED` **`Choose Spoilboard`** ▼ | … **`Change Spoilboard`** ▼ |
| **Workpiece** | `choose a workpiece…` **`Choose Workpiece`** ▼ | … **`Change Workpiece`** ▼ |
| **Drawing** | `choose drawings…` **`Add Drawing`** ▼ | (chips) **`Add Drawing`** ▼ |

**This is the founder's `Machine / Machine / MakerSpace 6090` verbatim** — the heading, the noun
again, and the value. Suppressing the label moved one of the two repeats behind a screen reader; it
did not remove it from the screen.

🔴 **Do NOT simply delete the noun.** `aria-labelledby={`${uid}-action`}` points at this span, so it
is the trigger button's **accessible name**. Deleting the noun leaves a button announced as
*"Change, button"* — the exact trade `ObjectPicker.tsx`'s own header refuses for the label.

**Proposed replacement** — the mechanism this file already owns, applied one element along:

```
<span className="op-trigger-action" id={`${uid}-action`} data-testid={`${testid}-action`}>
  {verb}
  <span className={quietLabel ? 'op-label-quiet' : undefined}> {label}</span>
</span>
```

Visible: `Change` · announced: `Change Machine` · unchanged wherever the picker is used outside a
provider (`web/src/cad/`), where `quietLabel` is `false`. **One rule, at the component, covering the
ninth panel somebody adds** — which is the argument the existing fix was built on.

### 2.2 🔴 Category 1 DUPLICATE — and in the empty state the noun is on screen *three* times

With nothing chosen, `triggerText` falls back to `placeholder`. On **Machine** that is:

> heading `Machine` · `choose a machine…` · `Choose Machine`

Three renderings of one noun in one column-width. Applying 2.1 removes one; the remaining pair is
the placeholder against the heading, which is legible and should stay.

### 2.3 🔴 CONTRADICTION — the comment that justifies the placeholder is false about the code beside it

**`web/src/App.tsx`**, over the Workpiece picker's `placeholder="choose a workpiece…"`:

> `🔴 NAMED RATHER THAN LEFT AS THE BARE `choose…` DEFAULT — TODO #77. With the repeated heading suppressed above, **this is the empty state's only chance to say WHAT is unchosen**, and a control with no visible label and a vague placeholder is worse than the duplication the founder is complaining about.`

It is **not** the only chance. The sibling `op-trigger-action` span inside the same `<button>`
renders `Choose Workpiece`, visibly, at the same moment. The comment reasons from a screen that has
one naming surface when it has two — and it is the comment that will be quoted the next time
somebody asks whether the placeholder can go. **Category: 3 (a reason, and it is wrong).**

### 2.4 🔴 Category 1 DUPLICATE — the Workpiece panel's layer row is the panel's own title

`LAYER_SECTION` (in `web/src/Viewport.tsx`) assigns exactly one layer to `panel-stock`:
`workpiece: 'panel-stock'`. `LAYER_LABEL` gives that layer the label:

> `workpiece: 'workpiece',`

and `sectionLayerRows()` in `App.tsx` renders `{LAYER_LABEL[k]}` as the row's visible text. So the
**Workpiece** panel's only layer row reads **`workpiece`**.

⚠ **`LAYER_LABEL` must not change.** It is also the canvas legend, and every one of its values is a
deliberate anti-collapse choice (`travel: 'travel envelope (reach)'`, `result: 'simulated stock after
machining'`, `clamps: 'work holding / clamps'`) with the reason in a comment beside it. **The fix
belongs in `sectionLayerRows`**, not in the label table.

**Proposed replacement:** reuse the rule that already exists — in `sectionLayerRows`, when a row's
`LAYER_LABEL` equals the section title under `labelRepeatsHeading`'s comparison, render the row's
swatch + eye and put the word in the same visually-hidden span used by `op-label-quiet`. One panel
is affected today (`panel-stock`); `Spoilboard` is **not**, because `spoilboard (sacrificial
material)` carries a fact the heading does not.

### 2.5 Category 1 DUPLICATE — the section eye's tooltip says it twice **[text-only]**

**`web/src/App.tsx`**, `SectionEye`'s `title`:

> `` `${section} — view layers: ${names}. ` ``

For `panel-stock` this resolves to **`Workpiece — view layers: workpiece. All shown; this hides
them. …`**. Same collision as 2.4, in a tooltip. **Proposed replacement:** it falls out of 2.4 for
free if the suppression is applied to `names` as well; otherwise leave it — a tooltip is a lower
cost than the row.

### 2.6 Category 2 DECORATIVE — a `Section` badge counting a list the operator is looking at

**`web/src/App.tsx`**, `Section`, renders `badge` inside `.panel-title` **outside** the `{open && …}`
guard:

> ```
> <span className="panel-title">
>   {title}
>   {badge ? (<span className={`badge badge-${badge.tone}`} …>{badge.text}</span>) : null}
> </span>
> ```

The prop's own documentation says what it is for:

> `🔴 WHAT THE HEADER SAYS WHILE THE BODY IS SHUT — and the reason this prop exists at all. … So a section that is hiding something has to say it is hiding something, from the header, with nothing to open.`

While the body is **open**, `Notes and warnings [2 warnings · 1 note]` sits directly above the two
warnings and the note; `Simulation [2 findings]` sits directly above the rows that are red. The
badge then states a number the operator can read off the list under it.

**Proposed replacement:** render the badge only while shut — `{!open && badge ? … : null}` — which is
exactly what the prop's doc block already claims it does. ⚠ The three consumers (`panel-sim`,
`panel-notes`, and any future one) are unaffected; nothing computes from the badge.
**[text-only]** — a summary above an open list is a judgement about scanning, and the code's own
stated purpose is the shut state.

### 2.7 Category 4 UNSURE — the properties panel echoes the row's `detail`

`ObjectPicker.tsx` renders `<h4 className="op-props-name">{previewItem.name}</h4>` then
`<p className="op-props-detail">{previewItem.detail}</p>`, while the list row beside it renders the
same `name` and the same `detail`. For a spoilboard the detail is
`2400 x 1200 x 16mm MDF · ✅ exactly spans the reach`, and the property rows below restate `Size X`,
`Size Y`, `Material` and `Can it be positioned to cover the whole reach?`. **Master/detail panes
normally echo the name deliberately.** Listed, no recommendation. **[text-only]**

### 2.8 Category 4 UNSURE — the empty-list message and the footer both attribute the narrowing

When a filter empties a list, `ObjectPicker.tsx` renders both:

> `No name matches “…” among the rows the Material filter is showing. Nothing was dropped for being unusable — clear the search and the filters to see all 20.`

and, in `.op-foot`:

> `20 hidden (18 by the Material filter, 2 by search)`

One names, one counts, and each has a comment arguing it exists so the user does not clear the wrong
control. They overlap heavily and are ~200px apart. Listed, no recommendation. **[text-only]**

---

## 3. 🔴 The largest single source of duplicated text on the CNC screen: `report.notes` is rendered twice, by construction

**Four specialised panels filter `report.notes` for their own subset, and `Notes and warnings`
renders the whole array again.** A filter does not remove; every note a specialist panel shows is
also in the list below it.

| Consumer in `web/src/App.tsx` | Selects | Rendered at |
|---|---|---|
| `estimateNotes` | `ESTIMATE_NOTE_PREFIXES` | `estimate-why` (`<details>`, over the viewport) |
| `spoilboardNotInstalled` | `startsWith('SPOILBOARD NOT INSTALLED')` | Spoilboard panel |
| `pending` | `startsWith('SPOILBOARD POSITION NOT CHECKED')` | Spoilboard panel |
| `strike` | `includes('PAST THE EDGE OF THE SPOILBOARD')` | Spoilboard panel |
| — | **everything, unfiltered** | `Notes and warnings` |

`panel-spoilboard`, `panel-sim` and `panel-notes` are all `defaultOpen` (only `panel-verify`,
`panel-store` and `panel-gcode` default shut), so these co-occur on a first-run screen.

### 3.1 🔴 Category 1 DUPLICATE — the spoilboard PENDING sentence, three times

Traced to the core: `core/src/fixtures.rs` builds the note as
`format!("SPOILBOARD POSITION NOT CHECKED ON THIS JOB — {why}.")` from the same
`spoilboard_pending_reason` it exports separately. On one screen that produces:

1. **Spoilboard panel** — the full note, verbatim (`data-testid="spoilboard-pending"`).
2. **Simulation panel** — `Past the board's edge is PENDING, not a pass.` + the bare `why`
   (`data-testid="sim-spoil-pending"`).
3. **Notes and warnings** — the full note again, from `report.notes.map(…)`.

⚠ **(1)+(2) are DELIBERATE and documented.** `App.tsx`, above the Simulation copy:

> `The core's own sentence, verbatim, on the panel that shows the number it qualifies. It also appears in Notes; both exist because either alone can be missed — the flag by a human, the note by a gate.`

**That reason covers two copies, not three.** The third — the Spoilboard panel's — has no such note.

**Proposed replacement:** `Notes and warnings` renders `report.notes` **minus the notes a specialist
panel has already claimed**, with the claimed prefixes named in one place beside the filters that
claim them. ⚠ **Two consequences a session must decide, not inherit:** the `panel-notes` badge
counts `report.notes.length` and would change meaning; and the gate-facing argument above (*"the note
by a gate"*) is about a note being **present in the DOM**, so removing it from `panel-notes` must not
remove it from the specialist panel that keeps it. **Do not delete a note from every surface.**

### 3.2 Category 1 DUPLICATE — the strike note, twice

`🔴 PAST THE EDGE OF THE SPOILBOARD — …` renders in the Spoilboard panel
(`data-testid="spoilboard-strike"`) and again in `Notes and warnings`. Same mechanism, same fix as
3.1. No comment defends this pair.

### 3.3 Category 1 DUPLICATE — the run-time estimate notes, twice

`estimateNotes` renders inside `What that time cannot know`; the same strings render in `Notes and
warnings`. ⚠ Lower cost than 3.1/3.2 because `estimate-why` is a `<details>` that is **shut by
default** — they only co-occur once the operator opens it. Same fix.

---

## 4. Spoilboard panel

### 4.1 🔴 Category 1 DUPLICATE — "ASSUMED" is on screen four times, twice word-for-word

| Where | Exact text |
|---|---|
| `Viewport.tsx`, `spoilboard-position-assumed` | `The spoilboard is drawn at an ASSUMED corner — **this app fitted it, nobody measured it.** Your board is bolted where the T-slots allowed.` |
| `App.tsx`, `spoilboard-assumed` | `**Position ASSUMED — this app fitted it, nobody measured it.** … Your board is bolted where the T-slots let it go, not where this arithmetic centred it — **a 20mm error here is 20mm of bare rail being reported as spoilboard**. Check it against the machine and type the real corner; typing either number makes the pair yours.` |
| `App.tsx`, `spoilboard-provenance` (status grid) | `Position` \| `ASSUMED — fitted, not measured` |
| `App.tsx`, `spoilboard-past` and `sim-past-spoil` | `— against an ASSUMED board` / `(ASSUMED board)` |

All four read the **same variable**, `const assumed = spoilboardPos === 'assumed'`.

⚠ **The canvas/panel pair is deliberate and documented.** `Viewport.tsx`:

> `🔴 A DRAWN BOARD WHOSE CORNER NOBODY MEASURED. The rectangle on the canvas is the most convincing thing in this app — it looks like a photograph of the machine … Said on the canvas rather than only in the panel, because this is where the operator decides the board is "obviously" under the work.`

**Keep that pair.** The actionable duplicate is **inside one panel**: the `spoilboard-assumed` warn
and the `Position` status row are ~15 lines apart and both spell out the provenance in full.

**Proposed replacement:** the status row loses its explanatory suffix and reads `ASSUMED`, because
the warn immediately above defines the word in full and the two are never rendered apart (both are
inside the `spoilboardId ?` / `report && echo != null` region of the same panel). **Both versions:**

- now: `Position` \| `ASSUMED — fitted, not measured`
- proposed: `Position` \| `ASSUMED`

🔴 **This one needs a screen before it is applied.** If the status grid can scroll away from the
warn, the suffix is the only definition in view and must stay. **[text-only]**

### 4.2 🔴 Category 2 DECORATIVE — a sentence that can never reach a screen

**`web/src/App.tsx`**, `spoilboardDrawn`, the `'none'` branch:

> `why: 'No board is declared, so there is nothing to draw and no control to offer for it.',`

`spoilboardDrawn.why` has exactly one consumer, and it is guarded:

> `{spoilboardDrawn.state !== 'none' ? (` … `{spoilboardDrawn.why}` … `) : null}`

`grep`ed the whole of `App.tsx` and `Viewport.tsx` for `spoilboardDrawn`: `.board` feeds the scene,
`.state` feeds the class and `data-state`, `.why` is read once, behind that guard. **The string is
unreachable.**

It is also redundant on its own terms: for the same state the panel renders
`No board is declared, so the position check reports UNCHECKED.` (`spoilboard-no-default`), which is
the stronger sentence — it names the consequence rather than the absence of a control.

**Proposed replacement:** `why: ''` in the `'none'` branch, with a one-line comment saying the state
is reported by `spoilboard-no-default` and this branch exists only to satisfy the return type.
⚠ Do **not** remove the branch — `state: 'none'` is load-bearing for the eye and the canvas.

### 4.3 Category 3 KEEP — everything else in this panel

`Position ASSUMED`'s consequence clause, `0,0 is a plausible answer and plausible is the dangerous
kind`, `Not declared — position UNCHECKED. This is not a board covering the travel envelope; it is no
board at all.`, `PENDING` at zero, `— against an ASSUMED board`, `Can it be positioned to cover the
whole reach?`, `Does it fit the machine FRAME? — UNKNOWN — and it is not a question this tool can
answer`, `Thickness (a check reads it — see below)`, `What this entry does NOT tell you`.

Every one of these is the `assumed`/`entered`, `UNCHECKED`/`PENDING`, `declared`/`measured`
distinction the brief protects. **None should be shortened.** ✅ The retired-terminology carry-forward
row `label: 'Does it fit the machine TABLE?'` from `docs/audit/2026-08-11-terminology-sweep.md` §13d
has been fixed — it now reads `FRAME`, which is the §10 X5 word. Re-measured, not taken from the
sweep doc.

---

## 5. Workpiece, Drawing and Work holding panels

### 5.1 Category 4 UNSURE — `Cutting <instance>` on every drawing row

**`web/src/App.tsx`**, `objrow-name`: `Cutting <b>{d.instance}</b>` … `· from <b>{d.name}</b>`.

Every row in `drawings` is in the job, so `Cutting` does not distinguish one row from another. It
may be doing work an operator wants — *this is a thing that will be cut, not a thing that is loaded*
— which is a real distinction elsewhere in this app (`loaded_mesh` is the **input**). Listed, no
recommendation.

### 5.2 Category 3 KEEP — the Work holding pair that looks like a duplicate and is not

> panel: `No clamps declared is *not* the same as a machine confirmed clear. Only the checkbox above says anyone looked.`
> report: `No work holding declared, and nobody has confirmed the machine is clear.`

The first explains **the control**; the second reports **the job's state**. They co-occur and they
are different claims. **Keep both.**

### 5.3 Category 3 KEEP — `workholding-no-footprint`

> `{name} publishes no footprint, so there is nothing to declare as a keepout — and that is *not* the same as it being out of the way. Nothing here can check a hold-down whose size we do not know.`

Textbook S3 (`absent ≠ safe`). Untouchable.

---

## 6. Tooling panel

### 6.1 🔴 Category 1 DUPLICATE — the Feed cell repeats itself once per selected tool, plus once more

Every tool row renders:

> `Feed` \| `not shown — the core does not export it`

and the panel note under the last row says the same thing at length:

> `Every value above is the core's answer about this cutter on this machine, rendered as it arrived. **There is no feed here any more.** This panel used to multiply rpm × flutes × chipload, which ignores the material — the planner scales chipload by the material and caps the rpm first, so the same row read 3600 mm/min while the program carried 840 in aluminium. The core knows the number and does not export it across the wasm boundary yet. The `F` words the program actually carries are in the G-code panel, and the rpm the planner settled on is in the notes.`

With the tool list being multi-select, three selected cutters put *"the core does not export it"* on
screen **four times**.

**Proposed replacement** — the reason survives intact in the note directly below, so the cell can
carry the state and drop the explanation:

- now: `not shown — the core does not export it`
- proposed: `not shown`

🔴 **Nothing is lost only because the note is on the same screen and cannot be collapsed away** — it
is a bare `<p className="note">`, not a `<details>`, and it is inside `panel-tools` with the rows.
If the note is ever moved or made collapsible, **put the clause back**. Say so in the commit.

### 6.2 🔴 Category 1 DUPLICATE — "No cutter chosen" and the Ø6 mm substitution, both twice

With no tool selected and no report, two blocks render at once:

**Tooling panel** (`no-tool-warning`):
> `No cutter chosen, so **nothing is being planned**. The trigger above says *choose…* and that is exactly what it means — until this pass, an empty set was sent to the core as an empty `tool_id` and came back as a full program cut with a **Ø6 mm end mill** nobody selected.`

**Report column** (`no-tool`):
> `**No cutter chosen.** Nothing is planned until one is. Every feed, depth and pass count in a program is derived from the cutter, so a program planned without one would be arithmetic about a tool you never picked — and it would post, download and cut exactly like a real one.`
> `Choose a *Tool* in the Tooling panel.`
> `⚠ This refusal is in the browser only. The core still substitutes a **Ø6 mm end mill** for a missing `tool_id` — and for a mistyped one — without saying so, so `2bee-slice` and the gates still behave the old way. Filed, not fixed.`

Duplicated: the headline `No cutter chosen`, and the Ø6 mm substitution fact. **Not** duplicated: the
Tooling copy's *"until this pass"* history and the report copy's *"the browser only … the gates still
behave the old way"* scope — those are different facts and both must survive.

**Proposed replacement:** the Tooling panel's copy loses the Ø6 mm clause (it is the report column's
scope caveat, stated better there) and becomes:

> `No cutter chosen, so **nothing is being planned**. The trigger above says *choose…* and that is exactly what it means.`

and the report column's pointer sentence `Choose a *Tool* in the Tooling panel.` is the one line
worth questioning — it directs the operator to a panel that is, on the same screen, already saying
the same thing. 🔴 **Only remove the pointer if the Tooling panel is reliably in view.** It is
`defaultOpen` but the sidebar scrolls. **[text-only]**

### 6.3 Category 3 KEEP

`is selected and is NOT in this machine's library` / `the core substitutes a Ø6 mm end mill for an id
it cannot find — without saying so. Take it out.` — a refusal naming what and why, plus the route
forward. `This core emitted no shank verdict, so the collet fit is UNCHECKED — not passed.` — S3.
`There is no collet change that fixes this` — the fix that does not exist, named. `not asked` for the
per-drawing advice. **All keeps.**

---

## 7. The report column — Summary, Simulation, Notes, G-code

### 7.1 Category 3 KEEP — the whole PENDING apparatus

`Uncut is PENDING, not a pass.` · `Past the board's edge is PENDING, not a pass.` ·
`Uncut was MEASURED, and nothing was left standing. The core tested 9,604 cells inside the regions
this job declares as *must be removed to a depth*. That is a result rather than a PENDING — and it
says nothing about anything outside those regions, or about anything the simulation does not model.`
· `Below the workpiece` with no colour class · `PENDING` at zero.

This is S9 rendered. **Nothing here is compressible.** The `data-uncut-state` three-state
(`pending` / `clean` / `finding`) exists precisely so a colour is never the only carrier.

### 7.2 Category 3 KEEP — the hand-over sentences

`⚠ The Run tab is not streaming — but that is a fact about the SENDER, not about the machine.` and
`streaming === false is NOT "the machine is stopped"`. These are the difference between a fact about
this app and a fact about a spindle. **Keep verbatim.**

### 7.3 Category 4 UNSURE — `Est. time` and `Tool changes` also live in the transport bar

`Summary` renders `Est. time` and `Tool changes`; the playback bar over the viewport renders
`bar-est-time` and `bar-tool-changes` from the same `report`. The bar's copy carries the qualifier
`estimate — a floor`, which the Summary's does not — so the two are not identical claims and the
weaker one is in the Summary. Whether they are ever in one visual field is a layout question.
Listed, no recommendation. **[text-only]**

---

## 8. The viewport overlay

### 8.1 🔴 NOT a duplicate — a finding I withdrew after re-measuring, and one stale comment that stands

Three warn boxes can stack in the same overlay column:

> `clamps-hidden`: `3 clamps declared and HIDDEN — this machine is not clear. The fixture check still runs against them all.`
> `spoilboard-hidden`: `A spoilboard IS declared and HIDDEN — so is the bare reach beside it. The check still runs against both.`
> `hidden-indicator`: `<n> of <m> view layers hidden (work holding / clamps, spoilboard (sacrificial material)) — the picture only. The program is unchanged.`

**I first wrote this up as a Category 1 duplicate** — the third box names every hidden layer and says
the program is unaffected, which looked like the second half of both of the others. It is not, and
the reason is worth recording rather than quietly dropping.

- `clamps-hidden` carries a **count of clamps**. `hidden-indicator` counts **layers**. Its own
  comment says exactly that, and it is right.
- `spoilboard-hidden` carries **`— so is the bare reach beside it`**, and that fact exists nowhere
  else. Checked at the code: `Layer` has **no bare-reach member**; `bareReach` rides the
  `spoilboard` layer (the scene objects are named `spoilboard`, `spoilboard-unknown` and
  `spoilboard-bare`, and all three are gated on `visible.spoilboard`). So `hidden-indicator` would
  print `spoilboard (sacrificial material)` and the operator would never learn that the bare-reach
  annotation went dark with it — **which is the one thing on that canvas that separates a
  sacrificial through-cut from a cutter in the frame.**

⇒ **No recommendation. Both per-layer boxes stay.** Recorded because *"two boxes say a layer is
hidden"* is exactly what a tidiness pass reaches for, and the second one is load-bearing.

🔴 **One thing here IS wrong, and it is a comment.** `Viewport.tsx`, over `clamps-hidden`:

> `🔴 **THE ONE HIDDEN LAYER THAT GETS ITS OWN LINE**, because it is the one whose absence from the picture is a claim about the MACHINE rather than about the drawing.`

There are **two**. `spoilboard-hidden` was added afterwards and its own comment positions it as
*"The clamps' argument, one rung along"* — so the uniqueness claim above it is stale, and a stale
uniqueness claim is what makes the next person delete the second box. ⚠ The same comment also says
*"hide the work holding and **the bed** looks CLEAR"* and *"a human confirmed **the bed** is clear"* —
two retired terms in the sentence that argues for the box (see §10.3). **Category: 3 (a reason, and
it is stale).**

### 8.2 Category 1 DUPLICATE — the walls caption points at what the line below it says

> `walls-basis`: `extruded walls — what the drawing asks for, {why}. Square inside corners no cutter can make and no dogbones: **the simulated stock surface is what the machine would leave.**`
> `result-resolution`: `simulated stock after machining at 3mm cells — **the stock the machine would leave, not the part.** {caveats}`

Adjacent lines in the same column, both live when both layers are live.

**Proposed replacement:** `walls-basis` keeps its own fact and drops the pointer —

> `extruded walls — what the drawing asks for, {why}. Square inside corners no cutter can make and no dogbones.`

The claim it was pointing at is stated better one line down, by the layer that owns it. **[text-only]**
— if the two layers are rarely live together, the pointer is doing work.

### 8.3 Category 3 KEEP

`loaded object drawn from 20,000 of 239,384 triangles — a display copy with facets missing. Fit for
looking at, not for measuring.` · `No spoilboard declared — position UNCHECKED. Nothing is drawn under
the work because nothing was declared, and that is not a board covering the travel envelope.` · the
axes note. All provenance. ✅ **The axes note is now `workpiece`, not `sheet`** — the founder's own
example from the terminology sweep is fixed; re-measured at the string, not taken from the doc.

---

## 9. The Run tab

The Run tab has no `Section` wrapper, so **it has no repeated-header defect**: `Program`, `Progress`,
`Controls`, `Console`, `Refused right now, and why` and `What is not wired yet` each appear once.
Checked, because that was the founder's named complaint.

### 9.1 🔴 Category 1 DUPLICATE — the biggest one on this tab: 7 of 8 refusal families render twice

Traced through three files:

- **`RunTab.tsx`, `controlRefusals()`**: `for (const r of refusalsFor(action, s)) out.push({ id: r.id, why: `${r.fact} ${r.why}` });`
- **`RunTab.tsx`, `Control`**, under every disabled button: `{refusals.map((r) => `${r.id} — ${r.why}`).join(' ')}`
- **`RunTab.tsx`, `RefusalList`**, in `Refused right now, and why`: `{r.id} ({action}) — {r.fact} {r.why}`
- **`RunTab.tsx`, `ConsolePanel`**, under the disabled input: `{refusals.map((r) => `${r.id} — ${r.why}`).join(' ')}`

`ACTION_OF` maps six controls onto six of the eight `RunAction`s (`start-job`, `resume`, `jog`,
`jog-cancel`, `spindle-stop`, `unlock`); `consoleRefusals()` covers a seventh (`console-gcode`).
**`RunAction` has exactly eight members** — verified at `run/protocol.ts`, not inferred — so:

| Refusal family | rendered under a control? | rendered in `Refused right now`? |
|---|---|---|
| `start-job`, `resume`, `jog`, `jog-cancel`, `spindle-stop`, `unlock` | ✅ under the button | ✅ again |
| `console-gcode` | ✅ under the console input | ✅ again |
| `auto-resume` | ❌ no control | ✅ **only here** |

In a disconnected or alarmed state — the states an operator actually meets — the same
`fact` + `why` sentence is on screen twice, a few hundred pixels apart.

⚠ **Both placements have a written defence and they collide:**

> `Control`: `🔴 THE REASON IS RENDERED, NOT HIDDEN IN A TOOLTIP. A disabled button whose reason lives only in a `title` is a control that fails silently for anyone on a touch screen or a keyboard — which in a shop is most people, because the other hand is on the machine.`
> `RefusalList`: `An operator who clears one refusal and meets another has been told the truth in the least useful order, which is why the whole set is on screen rather than the first one.`

**Proposed replacement:** keep the per-control reason — it is attached to the thing being pressed,
which is the argument that wins in a shop — and reduce `Refused right now, and why` to **the
refusals with no control of their own** (`auto-resume` today) plus a compact index of the ids that
are already answered beside their button, e.g.:

> `Also refused, beside their own controls: R1 (start-job) · R7 (unlock) · R13 (console-gcode).`

🔴 **Do not do the reverse.** Removing the per-button reason to keep the list would put a disabled
control's explanation somewhere the operator has to go looking for it, which is the failure
`Control`'s comment names. **And nothing may reduce a refusal to an id alone anywhere** — the id
must keep its `fact` and `why` at whichever surface is chosen as the survivor.

### 9.2 🔴 Category 1 DUPLICATE — the hidden-tab polling caveat, twice, in near-identical words

> beside the DRO (`run-poll-caveat`, rendered unconditionally): `The poll timer runs in the streamer worker rather than in this page, because Chrome throttles timers in a hidden page. ⚠ Whether a worker of a hidden page is throttled too has **not been measured by this lane** — so the readouts above carry the age of the report that actually arrived, and do not assume the poll happened.`
> in `What is not wired yet`: `**Status polling is wired; the hidden-tab half of it is not measured.** The worker polls with `?` and asks for a full report (`0x87`) periodically, at a rate decided from this controller's own `$481`. The timer is in the worker rather than in this page because Chrome throttles page timers when the tab is hidden — but **whether a worker of a hidden page is throttled too has not been measured by this lane**, and it is the same open question as `RUN-18`. That is why the DRO renders the age of the report that actually arrived, and marks itself as last-known rather than current when one is overdue…`

The bolded clause is word-for-word identical. Both blocks are unconditional; both are on the same
scrollable page.

🔴 **This is provenance, so the recommendation is placement, not compression.** Keep the copy
**beside the DRO** — the number and the claim about the number are read together or the claim is not
read at all, which is this file's own rule (`🔴 THE STALENESS CLAIM, BESIDE THE DIGITS`). The
`What is not wired yet` bullet then keeps only what the DRO copy does not carry — the `0x87`/`$481`
mechanism and the `RUN-18` link:

> `**Status polling is wired; the hidden-tab half of it is not measured.** The worker polls with `?` and asks for a full report (`0x87`) periodically, at a rate decided from this controller's own `$481`. The unmeasured half is the same open question as `RUN-18`; the DRO carries the caveat beside the digits.`

**No fact is lost:** the *"not been measured by this lane"* claim, the *"Chrome throttles"* reason and
the *"do not assume the poll happened"* consequence all survive in the DRO copy verbatim.

### 9.3 Category 1 DUPLICATE — "only ever run in node against a simulated controller", three times

> banner (`run-unproven`): `**Nothing here has ever run a machine.** The router is **ordered and has not arrived**. Every check this tab has runs against a simulated controller in node — this lane's own model of grblHAL — so it can show that the tab agrees with our reading of the firmware and can never show that the reading is right. **Nothing in this app has cut anything.**`
> `What is not wired yet`, bullet 1: `… every byte of that path has only ever run in node against a simulated controller.`
> `What is not wired yet`, bullet 3: `… Every byte of that has only run in node against a simulated controller.`
> `What is not wired yet`, bullet 7: `… this tab has never been on the other end of a USB cable.`

The banner is a **red-bordered box at the top of the tab** and it states the fact for the whole tab.
The two bullet trailers repeat it with no narrowing.

**Proposed replacement:** the per-item wiring facts stay — `Start is wired and has never streamed to
a machine.` and `The console input is wired and has never reached a controller.` are **different**
per-item claims and are the point of the list — and the two trailing sentences that restate the
banner go:

- bullet 1 now: `… every byte of that path has only ever run in node against a simulated controller.` → **drop the sentence**
- bullet 3 now: `… Every byte of that has only run in node against a simulated controller.` → **drop the sentence**

🔴 **Keep bullet 7's `never been on the other end of a USB cable`** — it is tied to gate `CTRL`
pending and gate `RUN` not existing, which is a different claim from *"our checks run in node"*.

### 9.4 🔴 SCOPE ERROR — "Seven things **Stop** does not guarantee" includes an item about **Abort**

**`web/src/RunTab.tsx`**, `StopPanel`:

> `Seven things Stop does not guarantee:`

The sixth bullet is:

> `**Abort does not decelerate.** It kills the steppers; whatever the gantry's inertia does next is not controlled by anything.`

Abort is a different control, with a different byte (`0x18` vs `!`), a different confirmation and a
different cost. The heading scopes the list to `Stop`. ⚠ The seventh (`Nothing here stops the
spindle at the wall`) is about neither button specifically.

⚠ **This is not a verbosity finding and the fix is not deletion** — the Abort sentence is
safety-bearing and must stay on this panel, which is where Abort lives. **The heading is what is
wrong.** Two options, both lossless:

- `Seven things these controls do not guarantee:` (widen the heading), or
- move the Abort bullet down beside `run-abort-cost`, which is already the Abort paragraph, and make
  the heading `Six things Stop does not guarantee:`.

⚠ **And the count is hardcoded beside a literal list.** It is correct today — I counted seven `<li>`.
It is the same shape as the *"0 real agreements"* defect the brief cites: the next bullet added makes
the number a lie with nothing to catch it. Prefer a heading with no count.

### 9.5 Category 4 UNSURE — the Stop headline and its first bullet

> headline: `Stop asks the controller to stop. It is not an emergency stop and **does not cut power**. Use the machine's physical emergency stop.`
> bullet 1: `**It cuts power to nothing.** Not the spindle, not the drivers, not the VFD. A feed hold leaves the spindle turning and the tool in the work.`

The headline states the fact and the instruction; the bullet enumerates what "nothing" covers. This
is a permanent, deliberately non-dismissible safety line (`🔴 THE PERMANENT LINE BELOW IS NOT A
TOOLTIP AND NOT A DISMISSIBLE MODAL`). **Listed, no recommendation.** Repetition on this particular
panel may be the design.

### 9.6 Category 3 KEEP — the whole of `Refused right now`, the DRO staleness copy, and the console rules

`Nothing is refused. That is a statement about the machine's last reported state, and it is only as
good as that report.` · `Machine — last known` · `not reported — the override controls would be
asserting a state they cannot see` · `not reported — character counting cannot be calibrated from
it` · `Line executing … · sent … · acknowledged …` (two true numbers, and the comment explains why
showing one hides the buffer) · `the tool has passed here, which is not the same claim as "material
was removed here"` · `Arbitrary g-code is refused: none of the Start preflight … would have run` ·
`/reset is a soft reset and it is **Abort by another route**` · `⚠ Status polls … are **not echoed
here**`.

**Every one of these is a "we did not check" vs "it is not there" distinction, or a fact about the
sender vs a fact about the machine. None may be shortened.**

---

## 10. Retired terminology still in the tree

`docs/audit/2026-08-11-terminology-sweep.md` §11a states its own limits: **comments were out of the
gate's scope**, and `cam.ts`, `jobMaterial.ts`, `materials.ts`, `samples/index.ts` and `cad/record.ts`
hold adjudicated findings that are unguarded. This section reports what remains. **The 38 adjudicated
keeps were not re-opened.**

### 10.1 ✅ Live operator strings in `App.tsx` and `Viewport.tsx` are clean for `sheet` / `bed` / `table`

Extracted every string and template literal outside comments and matched the whole-word needles.
`Viewport.tsx`: **zero** hits. `App.tsx`: five, and all five are §10 X1 — catalogue/product sense
(`a researched sheet size, read {date}`, `a sheet size that is real in the trade but was NOT
confirmed at a supplier page`, `sheet · fit not checked yet`, `the fit verdict beside the shipped
sheets`). **The founder's own example — the axes note — is fixed.**

### 10.2 🔴 Live operator strings that still carry a retired term

| File | Exact text | Should be |
|---|---|---|
| `web/src/jobMaterial.ts` | `` the sheet "${workpiece!.name}" says it is ${wp.why} `` | **the workpiece** — §3, this is the object in the job |
| `web/src/jobMaterial.ts` | `` the sheet "${workpiece.name}" states none either `` / `the sheet was typed rather than picked, so it states none` | **the workpiece** |
| `web/src/cam.ts` | `` ${ids.length} drawing(s) are on the table and the report carries no imported geometry at all `` | **in the job** — §13c's `"a drill is on the table for it"` precedent |
| `web/src/cam.ts` | `` ${empty.length} drawing(s) on the table (${empty.join(', ')}) appear nowhere in the report's geometry `` | **in the job** |
| `web/src/materials.ts` | `Oversize Baltic sheet. Longer than any AU **table** this lane has facts about — check travel before selecting it.` | **travel** (already named in §13d and still present) |
| `web/src/materials.ts` | `Long AU MDF sheet, confirmed stocked. Exceeds most hobby-class **table** travel — check the machine envelope.` | **travel** |
| `web/src/samples/index.ts` | `x=-3, y=-3.5, so it lands outside the **table** until the datum is moved` | **the travel** |
| `web/src/samples/index.ts` | `(It also lands outside the **table** until the datum is moved.)` | **the travel** |

All eight reach an operator: the `jobMaterial` pair is the Workpiece panel's material-conflict note,
the `cam.ts` pair is a refusal, the `materials.ts` pair is the Workpiece picker's row detail, the
`samples` pair is the Drawing picker's row detail.

✅ **Correctly kept, checked and not re-opened:** `workholding.ts`'s vendor quotations (`grid table`,
`design-data table`, `Above the table`, `Full vacuum table`), `materials.ts`'s `sheet` product lines
(X1), and the CSS class names `.whs-bed` / `.tps-bed` in `workholdingShape.tsx` /
`touchplateShape.tsx` (X4 — identifiers).

### 10.3 Comments — the class the gate cannot see

`sheet` / `bed` / `table` as whole words, in comments only, in the four files this sweep owns:

| File | comment lines with a hit |
|---|---:|
| `web/src/App.tsx` | 110 |
| `web/src/RunTab.tsx` | 7 |
| `web/src/ObjectPicker.tsx` | 7 |
| `web/src/Tabs.tsx` | 0 |
| **total** | **124** |

🔴 **Hand-adjudicated a seeded random sample of 40 against `docs/terminology.md` §1–§8 and the
X1–X12 exceptions: 24 true, 16 false. Precision ≈ 60%.** ⇒ **an estimated ~74 genuine retired-term
comment defects** across these four files. That is consistent with the sweep doc's own hand-measured
57% for `sheet`+`bed` — mine is a shade higher because it excludes the low-precision `stock`/`board`
needles and a shade lower than it would be because it includes `table`.

The false positives are the ones a gate would fire on and get itself switched off: `the shared
sheet` (a **stylesheet**), `the design's §15 table` / `the realtime byte table` (protocol tables),
`A one-row table is honest about how many drawings the planner can take` (a UI table), `the
RESEARCHED SHEET CATALOGUE` (X1), `plywood sheets` (a material).

**The true positives worth fixing first, because they are the ones that will be quoted back as
design intent:**

- `App.tsx`: `/* Spoilboard — the SACRIFICIAL SHEET, and where it is bolted.` — 🔴 §2 retires
  *"the sacrificial sheet"* by name, and this comment sits on the spoilboard state itself.
- `App.tsx`: `the bed; these say where the PART is on the board. They compose in one direction only —
  the part is on the sheet and the sheet is on the bed` — 🔴 **this is the S1 collapse written out as
  a design rule.** Three rectangles, two words. It is the single most dangerous comment found.
- `App.tsx`: `move the SHEET on the bed and take the …` (twice, in two different state blocks).
- `App.tsx`: `an offset in sheet millimetres` / `arrives already in sheet millimetres` — §3 retires
  *"sheet millimetres"* explicitly.
- `App.tsx`: `"which record is on the bed"` · `a record that is no longer on the bed` · `somebody
  looked at the bed in this session` · `"no clamps declared" still is not "the bed is clear"` — all
  ⇒ **machine**, matching `Fixturing::confirmed_clear`'s core wording and the live string
  `I have checked the machine is clear`. 🔴 **The panel already says `machine` and the comments
  behind it still say `bed`** — which is how the next edit reintroduces the old word into a string.
- `App.tsx`: `the height above the bed` (touch-plate aria-label comment) ⇒ **spoilboard**.
- `App.tsx`: `may well be bolted to the table` · `one fastened to the table does not` · `whether it
  follows the sheet or stays with the table` ⇒ **machine** / **workpiece**.
- `App.tsx`: `Inventing a table size to …` ⇒ **frame** (X5) — the live string beside it already says
  `Does it fit the machine FRAME?`.
- `ObjectPicker.tsx`: `a sheet too big for the machine, a sheet that only fits turned` · `the sheet's
  footprint` · `A sheet's size is an input` ⇒ **workpiece**.
- `App.tsx`: `the ids on the table` · `several copies on the table` · `WHICH DRAWINGS are on the
  table` ⇒ **in the job** (§13c).

⚠ **X11 quotations found and left alone:** the founder's `"fit the spoil board on the table when I
select one"` and `"similar to clamps show the selected Tools (like a table, row by row)"`. A
quotation is a record.

---

## 11. False-positive estimate for **this** report

The brief asks for a number, and there are two different kinds of claim here.

**(a) Does the text co-occur on one screen?** Every Category 1 and 2 finding was reached by reading
**both render conditions** and confirming they can be simultaneously true — not by pattern-matching
two similar strings. Concretely: I traced `report.notes` to all five of its consumers; I traced
`refusalsFor` → `ACTION_OF` → `Control` → `RefusalList` → `consoleRefusals` and checked the
`RunAction` union has exactly eight members rather than assuming it; I confirmed `spoilboardDrawn.why`
has exactly one guarded consumer before calling the string dead; I confirmed `op-label-quiet` is
`clip-path: inset(50%)` (hidden) while `.op-trigger-action` has no hiding rule.

**There are 16 Category 1/2 findings** (14 duplicates: 2.1, 2.2, 2.4, 2.5, 3.1, 3.2, 3.3, 4.1, 6.1,
6.2, 8.2, 9.1, 9.2, 9.3 — plus 2 decorative: 2.6, 4.2). **I expect 0 of the 16 to be wrong about
co-occurrence**, because each was established from the render conditions rather than from string
similarity.

🔴 **It was 17, and §8.1 is the one I withdrew.** It survived the co-occurrence test and failed on
the substance: the second box carries `— so is the bare reach beside it`, and only checking the
`Layer` union showed there is no bare-reach layer for `hidden-indicator` to name. **That is the real
error rate of this pass — 1 in 17 written up and retracted before shipping**, and it is left visible
in §8.1 rather than deleted, because a deleted finding is indistinguishable from one that was never
made and the next sweep would re-file it.

**(b) Is the co-occurring text actually unnecessary?** This is the visual half and I could not see a
screen. **5 of the 16** turn on how much lands in one visual field and are tagged **[text-only]**:
2.5 (the eye tooltip), 2.6 (the badge on an open panel), 4.1 (the ASSUMED status row), 6.2 (the
pointer to the Tooling panel), 8.2 (the walls caption). Treating those as coin-flips gives a
realistic **~15% chance that any given Category 1/2 recommendation is rejected on sight of the
screen**, concentrated entirely in the tagged five.

**The other 11 do not depend on layout** — they are one sentence rendered by two different
expressions, and that is true whatever the page looks like. 🔴 **The three largest (9.1, 3.1, 2.1)
are all in that untagged group**, so the top of the priority list survives a browser check even if
every tagged finding is thrown out.

⚠ **And the §8.1 retraction is the shape to expect for the rest**: the failure mode of this audit is
not *"these two strings are not both on screen"* — it is *"the second one carries a fact I did not
look for."* **Before deleting any string named here, check what only it says.**

**(c) The terminology count**: precision hand-measured at **60% (24/40)**, stated as an estimate of
~74 real defects rather than as a defect count. **The 124 is a measurement; the 74 is an inference,
and the two are not the same claim.**

**(d) What this sweep did not cover:** `web/src/cad/**` (the CAD tab, a different lane's audit),
`styles.css`, `web/e2e/**` and `web/tests/**`. ⚠ `web/e2e/slicer.spec.ts` is already recorded in
`App.tsx` as asserting the **pre-2026-08-11** wording *"nobody has confirmed the bed is clear"* —
**any session acting on §10.3 must check the e2e assertions first**, because a string this sweep
calls a comment defect has a live test twin two directories away.

---

## 12. What to do first, if only one thing gets done

1. **§9.1** — the Run tab's double refusals. Largest volume, entirely layout-independent, and the
   duplicated text is the text an operator reads under pressure.
2. **§3.1–3.3** — `report.notes` rendered twice by construction. One mechanism, four symptoms.
3. **§2.1** — the trigger's action label. It is the founder's literal complaint, still on screen, and
   the fix is the mechanism the lane already built for the label beside it.
4. **§9.4** — the `Stop` heading scoping an `Abort` bullet, and its hardcoded count.
5. **§10.2** — eight retired terms in strings an operator reads today.

🔴 **And two things that must NOT be done in the name of tidiness:** the canvas/panel ASSUMED pair
(§4.1) and the Simulation/Notes PENDING pair (§3.1) are **deliberate, documented duplications with
safety arguments behind them.** They are in this report so that a later pass can tell an exception
from an escape.
