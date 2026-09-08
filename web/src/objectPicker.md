# ObjectPicker — the standard way to put a list of objects in front of a user

**Status:** built in `web/src/ObjectPicker.tsx` (2bee.app), wired to several
single-mode call sites in `App.tsx`, and **exercised in a real browser on
2026-08-08** — see *What is verified, and how* at the end. Multi mode has been
driven end-to-end; the browser run found two defects that static rendering could
not, both recorded below.

Written for a reader who has never seen this app, because `brand` may lift it
into the design system and bind it to surfaces that are not this one.

---

## What it is

One component that replaces every dropdown. The user clicks a field, a panel
opens with a **searchable list** of objects on the left and the **properties of
the object under the cursor** on the right. It selects **one** thing (a machine,
a workpiece) or a **set** of things (tools, drawings) from the same component,
with the same appearance and the same keys.

Founder, 2026-08-08, verbatim:

> "There should be a standard way to add objects to the app: All files, objects
> (Drawing, Machine, Workpiece, Tools … etc). When I click on it should bring up
> a list (same style), when I select one show the properties of the object, this
> list should be searchable, able to add one (e.g. machine) or more (e.g. tools,
> Drawings) to the app. I do not like the drop down, can't search in it. This
> list became a standard (branding)."

---

## Props

```ts
interface ObjectProperty { label: string; value: string | number }

interface ObjectItem {
  id: string;                  // stable identity; selection and ARIA key on it
  name: string;                // the ONLY field search reads
  detail?: string;             // one short line under the name
  disabled?: boolean;          // listed, readable, not selectable
  disabledReason?: string;     // why not — in the core's words
  properties?: ObjectProperty[]; // rendered verbatim, in order
}

interface ObjectPickerProps {
  label: string;                          // field label; also names the search box for AT
  items?: ObjectItem[];                   // the FULL set — never pre-filtered to "the usable ones"
  mode?: 'single' | 'multi';              // default 'single'
  selectedIds?: string[];                 // an array in BOTH modes; single uses [0]
  onChange: (ids: string[]) => void;      // REQUIRED
  placeholder?: string;                   // trigger text when nothing is selected
  searchPlaceholder?: string;
  onAdd?: () => void;                     // the "+" affordance; absent ⇒ no "+" is shown
  addLabel?: string;                      // default '+ add'
  onRemoveItem?: (item: ObjectItem) => void; // host's delete flow; absent ⇒ no remove control
  emptyMessage?: string;                  // shown when items is empty
  disabled?: boolean;                     // disables the whole control
  defaultOpen?: boolean;                  // test-reachability only (see below)
  defaultQuery?: string;                  // test-reachability only (see below)
  testid?: string;                        // data-testid root; children are suffixed
}
```

Three deliberate choices worth stating, because each one could reasonably have
gone the other way:

- **`selectedIds` is an array in both modes.** Five call sites (machines,
  workpieces, drawings, tools, samples) use one shape, so a reader never has to
  check which mode a given call site is in to know what the value is.
- **`onChange` is required.** A picker with a no-op change handler renders
  perfectly and does nothing — a control that looks live and is not. Making it
  required means that failure cannot compile.
- **`onAdd` / `onRemoveItem` are optional and unimplemented here.** This
  component never invents an add or a delete flow; if the host does not pass
  one, the affordance does not exist. Adding and removing an *object* is the
  host's business; selecting one is this component's.

The props are **unchanged** by the multi-mode work below. Everything it needed —
`mode`, `selectedIds`, `onChange`, `label` — was already in the signature; the
change is in what the component *does* with them.

---

## Multi mode — a row's action is ADD, and the popup stays open

Founder, 2026-08-08, verbatim:

> "when I can select more than one from the list able to Add instead of select
> just 1 (like in the drawings able to add more than 1) AND SHOW THE SELECTED
> OBJECTS IN THE LEFT SIDEBAR"

**The rule.** In `multi`, a press on a row (mouse or `Enter`) **adds** it and the
popup **stays open**, so a set is built in one visit. A press on a row already in
the set **removes** it.

**Every row says which of the two the next press will do.** An added row shows
`✓ added` and its pill reads **Remove**; a row not in the set has a pill reading
**Add**. This is not decoration:

> A row that says "Add" and silently toggles off is a control that lies on the
> second press.

The pill is `aria-hidden`. `role="option"` already carries `aria-selected`, which
is what assistive tech announces in an `aria-multiselectable` listbox; repeating
it in the option's accessible *name* would make every row read its own verb.

**A `disabled` row gets no pill at all.** Rule 1 keeps it listed and readable
with its reason — an Add affordance on it would suggest the search result is
actionable when the core has already refused it. It is still unaddable: `commit`
returns early on `item.disabled`, and a **forced** click (Playwright refuses
`aria-disabled` rows on its own, so the click had to be forced past it) left the
selection unchanged.

### The exits, and why there are now three

Add-and-stay-open changes what "leaving the dialog" means. Before, choosing a row
*was* leaving. Now someone can add five things before changing their mind:

| Exit | Effect |
|---|---|
| **Done** (multi only) | close, **keep** the set |
| **Cancel** | close, **revert** to the selection as it was when the popup opened |
| **Escape** | same as Cancel, deliberately |
| click outside / backdrop | close, keep |
| `Tab` | close, keep — `Tab` means "I am done here", not "forget it" |

**`Done` exists because the other two obvious buttons both revert.** Without it
the only way to keep a set you just built was to click somewhere else, which
reads as an accident rather than a decision. Single mode has no `Done` — there,
choosing a row is already the commit.

⚠ **Recorded asymmetry, not an oversight:** backdrop-click and `Tab` **keep**,
while `Cancel`/`Escape` **revert**. Reverting on a stray click outside would
discard work the user did on purpose; that felt like the worse of the two
surprises, given `Done` now makes "keep" an explicit, labelled action. Both
readings are defensible — **this is the one behaviour here worth a founder
ruling**, and it is written down rather than left to be discovered.

### The selected set is visible without opening anything

The closed trigger renders the set as removable chips (`op-chip` / `op-chip-x`,
which already existed — extended, not duplicated), so the left sidebar shows what
is currently selected.

The trigger lives in a **290px** side panel, so the chip row **does not wrap**.
It shows the first `MAX_CHIPS` (3) and then a **`+N more`** count, which carries
the remaining names in its `title`. A wrapping row would push the controls below
it down the panel and eventually off screen; a row that quietly *clipped* would
make "four selected" and "six selected" look identical — the same
absence-reads-as-reassurance failure rule 1 exists to stop.

The **dialog header also carries `N selected`, untruncated**, so the two counts
can never disagree about the size of the set.

---

## The dialog says what list it is

The popup renders `label` as a header row. It used to carry that name **only in
`aria-label`**, which meant a screen-reader user was told which list they were in
and a sighted user was not — the wrong way round. It stopped being survivable
once the popup moved to the **centre of the viewport** (founder, 2026-08-08),
because at that point nothing on screen ties the dialog back to the field that
opened it. The dialog is now `aria-labelledby` that visible header, so the two
audiences read the same string.

---

## Rule 1 — search must never hide an item for being unusable

**The rule.** Search narrows by **`name`** and nothing else. A `disabled` item
stays in the list, in place, showing its `disabledReason`. Anything the search
string removes is **counted in the footer**, with how many of those were
unusable, next to a *show all N* button.

**Why.** This app deliberately lists things it will not let you use, with the
reason:

- a tool no collet can hold — *"12mm shank; the shop's collets are 6mm,
  3.175mm, 6.35mm, 8mm"*
- a sheet too big for the machine — *"too big for this machine"*
- a sheet that only fits rotated — *"fits turned 90°"*

On screen, **a hidden item and a non-existent item are identical**. In a
machining tool that difference decides whether someone goes and finds a collet,
or concludes the tool does not exist and buys another one. A search box that
quietly drops the unusable rows re-creates exactly the defect those labels were
built to kill: *absence reading as reassurance*.

**How it is enforced in the code.** The filter closure reads `it.name` and has
no access to `disabled` — it cannot hide something for being unusable even by
accident. Three states are worded differently on purpose, because they are three
different facts:

| State | What the user sees |
|---|---|
| Some rows hidden by the search string | `3 hidden by search (2 of them unusable)` + *show all 4* |
| Search matches nothing, but objects exist | *"No name matches “zzz”. Nothing was dropped for being unusable — clear the search to see all 4."* |
| No objects exist at all | the caller's `emptyMessage`, e.g. *"Nothing here yet."* |

The count sits in an `aria-live="polite"` region, because a screen-reader user
cannot see a footer they were never sent to.

**Selecting a disabled item does nothing.** It is there to be read, not chosen —
handing the core an object it has already refused is not a kindness.

---

## Rule 2 — keyboard is a regression, not a nicety

**The rule.** A native `<select>` gives type-ahead, arrow keys, Enter and Escape
for free. A hand-rolled list loses all four unless they are built, so all four
are built, on the ARIA combobox/listbox model.

**Why.** This is a tool used with one hand on a machine. *"Find the mouse"* is a
bad instruction in a workshop, and replacing a working native control with a
prettier broken one is a regression however good it looks.

### Keyboard contract

**Closed (focus on the trigger)**

| Key | Behaviour |
|---|---|
| `Enter`, `Space`, `↓`, `↑` | opens the list |
| any printable character | opens the list **and becomes the first character of the search** — native `<select>` type-ahead, rebuilt |

**Open (focus is in the search box; the list is driven by `aria-activedescendant`)**

| Key | Behaviour |
|---|---|
| typing | filters by name; the active row resets to the first match |
| `↓` / `↑` | move the active row by one, clamped at the ends (no wrap, like a native select) |
| `PageDown` / `PageUp` | move by ten |
| `Home` / `End` | first / last row |
| `Enter` | commit the active row — **single:** select and close · **multi:** add (or remove, if already added) and stay open, matching the mouse exactly |
| `Escape` | **revert** to the open-time selection, close, clear the search, return focus to the trigger |
| `Tab` | close and let focus move on — focus is **not** trapped |
| `Shift`+`Delete` | call `onRemoveItem` for the active row, if the host passed one |

Two of those are worth defending:

- **Arrow keys land on disabled rows.** A native `<select>` skips them. Here
  they are stops, because skipping them would hand keyboard users exactly the
  invisibility rule 1 exists to prevent — the reason is unreadable if you can
  never reach the row. `Enter` on such a row does nothing.
- **Removal is never a bare key.** `Delete` alone edits text in the search box;
  `Shift`+`Delete` collides with no text-editing gesture. A destructive action
  on a single keystroke, in a list, next to arrow keys, is a defect waiting for
  a distracted operator.

### 🔴 The keyboard defect add-and-stay-open exposed (found in a browser, 2026-08-08)

`Escape` was handled **only** by the search input's `onKeyDown`. Clicking a row
moves focus to `<body>` — an `<li>` is not focusable, so the mousedown blurs the
input — after which **`Escape` reached nothing, type-ahead typed nowhere, and the
dialog could not be dismissed from the keyboard at all.** Measured:

```
focus after open      : INPUT.op-search
focus after row click : BODY.(none)
search value after typing 'vbit': ''      <- keystrokes went nowhere
```

**Single mode hid this completely.** There, clicking a row closes the popup, so
*"a row has been clicked and the dialog is still open"* was an unreachable state.
Add-and-stay-open makes it the **normal** state — and the state in which `Escape`
matters most, because by then five things may have been added.

Two fixes, both kept:

1. **`onMouseDown` on each row calls `preventDefault()`**, so focus never leaves
   the search box. This is also what keeps **type-ahead alive between adds** —
   add a tool, type to find the next one.
2. **A document-level `keydown` listener handles `Escape` while open**, for focus
   that left some other way (a property field, the *save as* box). It stands down
   on `e.defaultPrevented`, so when focus *is* in the search box the input's own
   handler wins and the cancel does not fire twice off a stale closure.

*This is the general shape worth keeping: a behaviour whose only failure state
was unreachable in the old mode is not "working", it is untested. Changing the
mode is what made it reachable.*

---

## Layout — the popup is a resizable flex column, and every child names its behaviour

The dialog is `resize: both`. Drag it taller and the extra height must land
somewhere; whichever child is allowed to grow takes it.

Founder, 2026-08-08: *"when I select the tool and I resize it the bottom section
became large (51 shown Cancel), check it."*

**Cause.** `.op-body` was capped at a fixed `max-height: 320px` and had no
`flex-grow`, so it could not absorb the extra height. The free space piled up
**below the footer**, which — with the footer's `border-top` sitting at the top of
a large empty region — reads exactly as *"the bottom section became large"*.

**The contract now:**

| Element | flex | why |
|---|---|---|
| `.op-head`, `.op-search-row`, `.op-foot` | `0 0 auto` | fixed furniture; never absorbs resize |
| `.op-body` | `1 1 auto` + **`min-height: 0`** | the only growing child |
| `.op-list`, `.op-props` | `min-width: 0`, `min-height: 0` | so a long tool name scrolls instead of pushing the layout |

**`min-height: 0` is the part that gets left out.** A flex item defaults to
`min-height: auto`, which refuses to shrink below its content — so without it a
long list makes the body refuse to fit and the layout breaks in the *other*
direction.

**Verified by measuring, not by looking** — at 1500×1000, dialog dragged
420px → 640px high, with a tool selected so the properties pane had content:

```
FIXED (shipping CSS)
  pop grew 220px  ->  list +220  body +220  foot +0   empty space under footer  1 -> 1

PLANTED (pre-fix .op-body: max-height 320px, flex 0 0 auto)   <- negative control
  pop grew 220px  ->  list +0    body +0    foot +0   empty space under footer -9 -> 211
```

The planted run is the point: **211px of dead space under the footer is the
founder's bug, reproduced on demand.** A green with no red beside it would only
have shown that one size looked fine.

⚠ Two harness lessons from getting there, both worth repeating:

- The first attempt resized the dialog and every number came back **unchanged** —
  which looked like a pass. It was not: the viewport made `max-height: min(70vh,
  720px)` equal 700px, the dialog was **already at that cap**, and nothing
  resized at all. *A uniform result across cases is a harness fault, not a
  finding.* The test now resizes strictly inside the cap.
- The first metric measured the gap **between the list and the footer**, which is
  0 in both the fixed and the broken case, because free space in a flex column
  lands *after* the last child. Measuring `pop.bottom - foot.bottom` is what
  makes the defect visible. *Assert on the geometry the complaint describes.*

### ARIA

- trigger — `<button aria-haspopup="listbox" aria-expanded aria-controls aria-labelledby>`
- search box — `<input role="combobox" aria-expanded aria-controls aria-autocomplete="list" aria-activedescendant aria-label>`
- list — `<ul role="listbox" aria-multiselectable={mode === 'multi'}>`
- rows — `<li role="option" aria-selected aria-disabled>`

`role="combobox"` sits on the **input**, not the trigger, because that is where
the text is typed and where `aria-activedescendant` must live; the trigger is a
disclosure button. Putting the role in both places would announce two comboboxes
for one control.

---

## Rule 3 — this component renders what it is given

The tool's fit verdict, the sheet's footprint and turn, the machine's collets
are facts the **Rust core** owns. They arrive as `detail`, `disabledReason` and
`properties` **data** and are rendered verbatim. Nothing in the component
computes a verdict, formats a dimension, or decides that an object is usable — an
item is `disabled` because the caller said so.

This is not tidiness. This app has twice had a machining rule re-derived in
TypeScript, where no gate could see it and no test could fail on it. A rule that
exists in two languages is a rule that will disagree with itself, and the copy
that disagrees is always the one on screen.

The properties panel therefore also refuses to flatter: when `properties` is
absent it says *"No properties were supplied for this object"* — because "the
caller supplied none" and "this object has none" are different facts, and only
the first is one this component can know.

### `claim` — a statement the operator makes, as opposed to a property of the row

Added 2026-08-11 for the ownership axis (TODO #105). It is **not** an
`ObjectProperty` with an `input`, and the difference is the whole reason it is a
separate field:

- a property with `input` is an **edit to the object** — it lands in `draft` and
  does nothing until Save or Save as, which is right, because a half-typed
  diameter must not reach a plan;
- a claim is an assertion about **the shop** (*I have this cutter*). It belongs
  to no draft, there is nothing to save it under, and putting it behind a Save
  button would be a control that appears to answer a question and does not. It
  writes immediately, through the host.

```ts
interface RowClaimOption { value: string; label: string; unavailable?: string }
interface RowClaim {
  label: string;                    // names the control for sighted users and AT
  value: string;                    // the row's CURRENT value; MUST be in options
  options: RowClaimOption[];
  onChange(value: string): void;    // never called for an `unavailable` option
  note?: string;                    // what this control means here
  consequence?: string;             // what a press does BEYOND this row
}
```

Four rules, each of which is a defect if broken:

1. **It is not a boolean.** The first host has four verdicts including
   *nobody has said*, which a checkbox cannot express and would merge into "no".
2. **An unavailable option is listed with its reason, never dropped** — rule 1
   applied to a control instead of a row.
3. **The host must include the current value among the options.** A `<select>`
   whose `value` is absent silently displays the *first* option, i.e. a state
   nobody is in. The component says so on screen rather than picking one.
4. **It renders on the properties panel, not in the list.** A `role="option"`
   must not contain a focusable control, and a claim is not a mouse-only
   shortcut like the row's remove `×` — a keyboard operator has to be able to
   answer it.

⚠ **THE PROPS BLOCK NEAR THE TOP OF THIS FILE IS OUT OF DATE and this section is
not what made it so.** It predates `facets`, `shape`, `builtIn`, `removable`,
`onSave`, `onSaveAs`, `actions` and `ObjectProperty.input`, none of which appear
in it. Read `ObjectPicker.tsx`'s own types as the signature; read this file for
the rules. Said here rather than left to be discovered, because a props list a
reader trusts to be complete is worse than no list.

---

## Styling

Every colour, radius, font and shadow resolves to `brand/tokens.css` through the
custom properties this app already defines: `--bg`, `--panel`, `--ink`,
`--muted`, `--line`, `--accent`, `--ok`, `--bad`, `--warn`, `--radius`, `--mono`,
plus brand's `--shadow-card-hover` for the popup's elevation.

**There is no hex literal in the component, deliberately.** A hex here would be
the one value that stops matching the moment brand changes anything.

The CSS is currently carried inside `ObjectPicker.tsx` and injected once into
`<head>`, so the component is self-contained and can be dropped into another
surface without moving a stylesheet. If `brand` canonises this pattern, the
natural move is to lift that block into the shared stylesheet unchanged — the
class names are all `op-` prefixed for exactly that.

---

## Test-reachability props

`defaultOpen` and `defaultQuery` exist for one reason: the popup and the
hidden-count are the halves of this component that a renderer with no pointer
and no keyboard can otherwise never reach, and **a behaviour no test can reach is
a behaviour nobody has watched work**. They set initial state only; after mount
the component owns both values. They are not a controlled-component API and must
not be used as one.

---

## What is verified, and how

Stated precisely, because "it works" and "these specific things were watched
happening" are different claims and only the second is ours.

- ✅ **Type-checks** — `npx tsc -b` clean, and proven to be a real check by
  planting a type error and watching it go red.
- ✅ **Renders** — static render (`react-dom/server`) of the closed, open, empty,
  no-match and partially-filtered states. Confirmed in the markup:
  `role="listbox"`, `role="combobox"`, `role="option"`,
  `aria-multiselectable`, `aria-activedescendant`, `aria-disabled="true"` on the
  unusable row **with its reason text present**, the properties `<dl>`, and the
  footer reading `3 hidden by search (2 of them unusable)`.
- ✅ **Driven in a real browser, 2026-08-08** (Chromium/Playwright against the
  dev server). Multi mode on a throwaway harness; header and layout on the real
  app's `tool-picker`. Observed:
  - dialog header reads `Tool`, and the dialog's `aria-labelledby` resolves to
    that same visible string;
  - a row's pill reads `ADD`, becomes `REMOVE` after adding, and the row reads
    `… ✓ added … REMOVE`;
  - **the popup stayed open across three adds** — two by mouse, one by `End` +
    `Enter` — reaching `["flat-6","vbit-90","ball-4"]`, header `3 selected`;
  - a **forced** click on the `aria-disabled` row left the selection unchanged
    (Playwright refuses such rows unaided, which is its own small confirmation);
  - chips render on the closed trigger, one row, **266×31px inside a 290px
    panel**; at five selected it showed three chips + `+2 more`;
  - **`Escape` after adding two more reverted to the pre-open set** — the
    before/after selection strings are identical;
  - chip `×` removes just that item; search still reports `1 hidden by search`
    and the disabled row stays listed while filtered.
- ✅ **Two defects the static render could not see, both found by that run and
  both fixed here** — the focus/`Escape` failure and the resize/footer layout
  bug. Each is written up above **with its negative control**, because a fix
  nobody has watched fail is not yet known to be a fix.
- 🔴 **No multi-mode call site exists yet.** Every `ObjectPicker` in `App.tsx` is
  `mode="single"` as of this commit, so multi mode was exercised on a throwaway
  harness that has been deleted. **Nothing in the shipping app uses it**, and
  until something does, this section describes a component that works in
  isolation, not a feature a user can reach.
- 🔴 **No gate covers any of it.** Nothing in `gates/` or the Playwright suite
  goes red if this regresses; the browser runs above were one-off scripts, not a
  spec that will run again. **That is the single biggest gap here** — the
  `Escape` defect had been shipped and invisible, and only a browser found it.
- 🔴 **Not reviewed by `brand`.** The founder called the list a branding
  standard; canonising it is `brand`'s call, not this lane's.

The next thing anyone picking this up should do is turn the two throwaway runs
into a committed Playwright spec: add-and-stay-open across three rows, `Escape`
reverting all of them, the forced click on a disabled row, and the resize
measurement **with its planted control** — that last one is the check the founder
had to find by hand.

## Known limits, named rather than left to be discovered

- **`selectedIds` naming ids not present in `items` is silently dropped** from
  the chips and from `N selected`. That is currently invisible: a tool deleted
  from the library disappears from the trigger with no trace. Nothing depends on
  it today, and it is the caller's data, but it is the obvious next honesty gap.
- **`MAX_CHIPS` is 3, tuned by eye to a 290px panel** at the app's current font
  size. It is a constant in the component, not a measurement, and a larger font
  or a narrower panel would overflow before the count kicks in.
