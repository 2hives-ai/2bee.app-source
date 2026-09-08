# What is left — 2bee.app, 2026-08-12

**Written at `63667c8395`, updated after the render pass.** Every item names what would close it and what it is worth. Ordered by
what blocks what, not by size.

🔴 **The one sentence that frames all of it: nothing this lane has produced has ever cut anything.**
Zero air-cuts, zero coupons, zero ply. Everything below is either a step toward that, or a control
that stops a wrong step being taken.

---

## 🔶 STATE AT `79f581a61b` (2026-08-12, later the same day) — **section C is CLEARED**

**Added as a header rather than by rewriting the sections below, deliberately.** Each item's body is a
**dated measurement**, and this lane has recorded what happens when a correction sweep rewrites the
record instead of bannering it. **Read the bodies for the reasoning; read this block for what is true
now.**

| Item | State at `79f581a61b` | The part worth keeping |
|---|---|---|
| **C1** datum | ✅ closed | The probe published the projected centre of the world bbox as *"the point the raycaster would hit"* — **true of a solid, false of a DXF**, which is drawn as an open ribbon, so the ray sailed to the sheet. ⚠ Residual: a grab in a DXF's **hollow interior** still falls through. |
| **C2** two e2e tests | ✅ closed, 88/88 | The viewport **does** resume — 43 frames / 0 hidden / 43. What freezes is the **marker** on a 120 s dwell. And the cutter needle missed by **one** (`b = 107` vs `[108,158]`) — a lit material never renders its base colour exactly. |
| **C2b** refusal divergence | ✅ closed (`ea6cf254f0`) | Never browser-vs-CLI. `JobConfig::apply` overwrote the fields the plants plant, so **three plants printed `PLANTED:` over a program that no longer contained the plant.** Disarmed plants now **refuse**. |
| **C3** oracle vs our audit | ✅ closed (`a62f3bd312`) | It reported *"tree and solid agree"* about a solid **our own kernel called open and non-manifold**. Step 1 alone moved **0 of 86 rows**, which is what proved the ordering. Two cases move **below the float32 floor**. |
| **C4** `CAD1H` | 🔶 **DECIDABLE, NOT TAKEN** — see below | — |
| **C5** housekeeping | ✅ all closed | `/tmp` leaks · dock tablist · `G2` · the two `.d.ts` · the `@needs-gpu` survivors. |

### 🔴 `CAD1H` — the fork, now with numbers. **Founder's call.**

- All 23 PENDINGs are the overlap class — **checked, not assumed.**
- 🔴 **23 understates it.** Eleven more files have an undecidable mesh leg and score `DIVERGES` only
  because their **tree** leg decides first. ⇒ **34 of 73 models have a solid this gate cannot decide.**
- Unioning resolves **23 of 23** — 16 to agreement, **7 to DISAGREEMENT**: real divergences currently
  hidden behind PENDING.
- ⚠ It also moves **11 files nobody asked about**: ten currently-`DIVERGES` become agreement because
  their solids **touch** where their bboxes do not overlap, so the guard never fired. Volumes agree
  exactly; **the whole divergence is AREA.** 🔴 **The tracked count of 31 is inflated by 10 by the
  measurement itself.**
- **Net:** 31 → 27 · UNDECIDED 23 → 1 · real agreements 2 → 28.
- **Costs:** it changes what the mesh leg *means* (**F5 vs F6 is deliberate**) · it **breaks `CAD1`** on
  one case and costs a named baseline entry · meshing **1,179 ms → 7,507 ms**, one file alone 46 → 4,543.
- ⚠ The `CAD1` cost is a property of **this route** — the only one reachable from outside `mesh.ts` — not
  necessarily of the option.

### What moved in section A

- **A3 — the safe half is DONE.** `panel-spoilboard` now carries a badge, **strictly additive**; the
  unfiltered-record test is still green. Building it found **four alarms the plan did not know were
  hideable**: `spoilboard-reach` (*"THIS BOARD CANNOT COVER THE REACH"*), `spoilboard-assumed`,
  `spoilboard-travel-drift`, `spoilboard-inventory-refused`. 🔴 **The badge makes the filtering question
  ASKABLE — it does not answer it.** Filtering `panel-notes` is still the founder's.
- **A1, A2, A4 — unchanged, still one answer each.**

### New, and not in the original document

- 🔴 **There is no cutter inventory at all** (`bom`, 2026-08-11): *"Nobody yet — there is no inventory to
  update. This is the gap."* ⇒ **every tool in the app is DECLARED, NOT OWNED**, so a "faster" plan may
  be faster with a cutter nobody has. `bom` rules the record waits for delivery — **inventing one now
  would be the assumed-as-entered failure.**
- ⚠ **`machine.collet_mm = 0.0` — undeclared**, against an **ER20** chuck that holds **1–13 mm** shank.
  A real physical bound with no value to check against.
- 🔴 **Two defects in our own `AGPL` gate**, found by reading it: its pass branch awards green for
  **changed**, not **works** — nothing fetches the URL, so **a different 404 passes** — which is exactly
  the outcome its own preamble calls *worse* than the 404 it catches. And *"it must become a FAIL the day
  a deploy target exists"* is carried by a **comment**, so the flip depends on someone remembering.
- ✅ **`2bee.app` is still OWNED, NOT SERVED** — re-measured across three public resolvers with a live
  control. The `AGPL` PENDING rests on a premise that is **still true**. ⚠ And monitoring's *"the dead URL
  also sits in `Cargo.toml:9`"* is **stale**: that hit is inside the comment explaining its own removal.
  **One live copy remains, `App.tsx:12046`.**
- **`PLANT` is RED on purpose.** Its in-gate blindness probe keys on a plant that *"applies, exits 0 and
  changes nothing"* — and `ea6cf254f0` made vacuous plants **refuse**, so that signature no longer exists.
  🔴 **Leaving it red is the honest state**; re-pointing it at a pairing chosen mid-change would be picking
  a needle to make a gate pass.
- **The sheet X / Y arrows were already removed** (`5e7c3f90c8`); `cad`'s relay quoted `cafa41a9d8`. ⚠ And
  their caveat **inverts** — the smear note is about `letter()` sizing its sprite canvas from the text, and
  **the fix outlived the arrows**. They were not a fix; they were what exposed one.

---

## A · Blocked on the founder — 4

These need a decision, not effort. **Each is one answer.**

### A1 · 🔴 `Save as` — the panel, or the row you are looking at?
**Measured:** preview `Desktop 3018` (300 × 180), press `Save as`, and a **600 × 900** record is written
under that name — the *ticked* machine's travels. Confirmed in **three pickers**; `previewItem` follows
the **arrowed** row, not the selected one.

**Why it is not cosmetic:** travel is what refuses a move off the table. **A saved machine whose envelope
is not the machine it is named after passes a 600 × 900 program to a 300 × 180 machine.**

**State:** the two spoilboard save doors currently **refuse and name the two candidates** rather than
guess. ✅ **Nothing is broken while this is open** — it just cannot save in the ambiguous case.

**When answered:** one function, applied to **machines, workpieces, drawings and spoilboards together**.

### A2 · 🔴 The `J49` jumper — eyes on the board
**Blocks the flash, and nothing else does.** The SKR Pro has **one USB data pair** and a 3×2 header
selecting which connector it reaches. **We asserted from behaviour that the caps are on the Type-B side.
Nobody has looked.** `pcb`: *"I cannot answer this and neither can you."*

⚠ **Do not let the behavioural inference stand in for it** — the board enumerating as a device proves the
jumper is on Type-B *today*, which is the same evidence either way.

### A3 · `report.notes` renders three times — and there is no lossless text fix
Four panels **filter** the notes for their subset; *"Notes and warnings"* renders the **whole array**
again, so the spoilboard PENDING sentence lands **three times**.

🔴 **Filtering the Notes panel is a safety regression:** section collapse is **sticky**, a shut section
renders nothing, and `panel-spoilboard` has **no badge** — so a filtered Notes panel lets an operator
**permanently hide a spoilboard PENDING**. Removing the specialist copy instead leaves a bare `PENDING`
with no *why*.

**Two real options, both behaviour changes:** badge the spoilboard panel *then* filter · or collapse the
duplicated status row. A test asserts the unfiltered record **and the reason**, so revisiting goes red
first.

### A4 · `CADT-10` — re-state the row, or leave it red?
The branch is named for a **human accept that no longer exists** — your *"Enter sends, reply applies"*
removed it. Two of its four needles now assert **the opposite**.

⚠ **What replaced it is narrower and is not nothing** — one door, a blocked reply surfaces without
applying, the review survives, one put-back. 🔴 **But that is a weaker guarantee than the row claims.**
**Re-stating the row is yours and the tab owner's; re-pointing the needles blind would be weakening a
gate to make it pass.**

---

## B · Blocked on another lane — 2

- **`pcb` — grblHAL's v1.1 → v1.2 pin aliasing.** Taken, in progress, **result before anyone flashes.**
  ⚠ Our own measurement already says the schematics are pin-identical (111 port pins, 108 identical, 3
  extractor artefacts, two negative controls) — **`pcb` is confirming it in their lane, which is the right
  place for it.**
- **`legal` — the AGPL §13 mechanism.** Both candidate URLs are **measured dead**: the footer's target
  404s and the real remote is **private**. 🔴 **There is no honest string to write until they rule.**
  ⚠ **`.app` is HSTS-preloaded**, so the work is served from the instant a DNS record exists — **a correct
  source offer is a precondition on publishing, not a follow-up.**

---

## C · Unblocked, ready now — in the order I would do them

### C1 · ✅ The datum defect — FIXED. Three of the four were something else entirely
🔴 **The datum one was real and is fixed.** The viewport published `data-part-probe` as **the projected
centre of the world bounding box**, under a comment claiming it was *"the point on the object the
raycaster would actually hit"*. **True of a solid, false of a DXF** — a drawing is drawn as `walls`, a
**ribbon standing on the contour, open at the top and hollow inside**, so the bbox centre is **fresh air
over the middle of the part** and the ray sails through to the sheet underneath. That is why the STL drag
test passed all along.

⚠ **The arithmetic was never wrong — the aim was.** A 4px scan found **3 points** on the whole plate that
hit the drawing; the same gesture at one of them moved the **part** by the same `134.1,7.1` and left the
datum at `0,0`. The probe is now published only once a ray through it returns *that instance* nearest, and
an instance with no reachable point is **absent from the table** rather than carrying a point that refuses.

**Residual, flagged not decided:** a grab in the **hollow interior** of a DXF still falls through to the
sheet. Making the footprint grabbable changes pick semantics nobody asked for.

### C2 · 🔴 Two e2e tests are WRONG, and both had never run
- **"The viewport never resumes" — it resumes.** Measured with counters inside the render loop: **43 frames
  per 700ms showing, 0 hidden, 43 again on return.** What is frozen is the **marker**: the fixture's one
  `M0` is at move 127 of 689 and the report charges **120 s** for it, so at ×10 the playhead reaches the
  dwell ~2.8 s in and stands there for twelve wall-seconds. **Reproduced with no tab switch at all.** The
  test's observable cannot separate *"renderer paused"* from *"the program is legitimately standing still"*.
  A `data-frames` counter was added below the paused return — **+42 / +0 / +42** — and one line repoints it.
- **The cutter chip works; the needle misses by one.** Cutter-teal pixels: **shown 24, hidden 3, back 24**.
  The marker renders `b = 107`; the needle demands `b ∈ [108,158]`. 🔴 **A lit material never renders its
  base colour exactly, and the ±26 tolerance was a guess in a test that had never run.** Only ~16 pixels
  carry it at that framing, so `> 0` has 16 pixels of margin **and moves with the camera**.

⚠ **Both are `web/e2e/**` and were left unedited** — reported by the lane that found them, fixed by the lane
that owns them.

### C2b · 🔴 The refusal divergence is NOT browser-vs-CLI — it is a core defect
**Reproduced entirely at the CLI, browser out of the picture.** `JobConfig::apply` runs **after** the plant
and **overwrites the very fields the plants plant**:

```
job multi-tool --plant oversize-shank                    → exit 1, 5 refusals
  same + --config '{"tool_ids":[...]}'                    → exit 0, program emitted
job clamped --plant cut-clamp                            → exit 1
  same + --config '{"clamps":[]}'                         → exit 0, fixture downgraded to Undeclared
```

🔴 **All three still print their `PLANTED:` note over a program that no longer contains the plant.** The
browser always sends `tool_ids` and `clamps`, so it disarms them on every load — **the browser is behaving
correctly given what it declares.** `wrong-drill` survives because it works through neither field, which is
exactly why it looked like the odd one out.

**Fix belongs in `core/src/fixtures.rs`:** refuse to reassign over a plant, or say loudly that the plant was
overwritten. ⚠ **A web-side fix would mean the UI hard-coding which config fields each plant depends on —
a picture/program disagreement, not a fix.**

### C3 · The oracle ignores our own kernel's audit
Under a face-dropping plant, three cases report *"tree and solid both agree"* **while our own kernel audits
that solid as open and non-manifold** — one dropped face moves volume below tolerance on a curved
primitive. **The harness reports agreement about a solid its own kernel says is not closed.**

**Fix is specified in order** — consume the audit first (unclosed ⇒ **PENDING**, because an undecidable
comparison is not a measured disagreement), **then** wire the plants. The plant is the second half.

### C4 · `CAD1H`'s 21 UNDECIDED — a fork worth taking deliberately
Not a product defect. **Our 42 top-level solids overlap and the mesher deliberately does not union
top-level siblings** — it matches OpenSCAD's F5 preview, not F6 render — **so the summed invariants are
not the union's and the case cannot be decided.**

⚠ **The baseline drop 30 → 29 was bought mostly with silence:** five of the six files that left the tracked
count went to **PENDING**, not to agreement.

**Either** teach the comparison to union top-level siblings (changing what the mesh leg *means*) **or**
accept the class is undecidable and say so in the gate's contract.

### C5 · Housekeeping, all specified, none started
- **Three `/tmp` leak shapes in `web/e2e`** — per-site change written down, not made.
- **The CAD dock's tablist** has the roles and none of the behaviour: no `tabpanel`, no `aria-controls`, no
  roving tabindex, no arrow keys — while `Tabs.tsx` implements the full pattern **and gives a shop-floor
  reason for it.**
- **Gate `G2` cannot see the new off-material comment** — it reads fixtures, and no fixture cuts off the
  material, **so a banned word there would ship past the dialect gate unread.**
- **Two generated `.d.ts` files** untracked from the wasm rebuild.
- **The four `@needs-gpu` survivors** need their tag stripped once C1 lands — **the tag now means nothing
  and its banners say so.**

---

## D · The physical arc — what actually remains before anything is cut

**In order. Each rung needs the one before it.**

1. **Flash grblHAL** — binary built, verified, procedure and recovery written, **not flashed**. Blocked on
   **A2** and **B/pcb**. ⚠ **Flashing while the board is bare is the low-risk moment and it gets worse the
   day motors go on.**
2. **Set `$$`** — 🔴 **it will exist and be WRONG.** Steps/mm, travel, homing direction and spindle config
   are facts about your machine **nobody has measured**. **Before anything is connected.**
3. **`CTRL`'s first transcript** — the gate has **never had one**; nothing this lane emits has ever been
   offered to a real board. Needs the repo and a cross-built binary on the Pi.
4. **Air cut · coupon · ply** — unclimbed.

⚠ **And one fault worth fixing before any of it:** the Pi's `dmesg` recorded **`disabled by hub (EMI?)`
followed by a disconnect.** **During a cut that is not a reconnect — it is a stall with the cutter buried**,
and the sender's own note says its idea of the executing line is at best *"somewhere in the last
buffer-full."* Shielding, ferrite, ground topology and shared supply are **`pcb`'s**, and it is the same
fault whatever happens to the USB arrangement.

---

## E · Standing gaps, accepted rather than open

**Recorded so nobody re-discovers them as findings.**

- 🔴 **Node tests cannot see a render.** `renderToStaticMarkup` runs no effects and never mounts — **1096
  tests and a clean `tsc` were green over a blank app today.** **e2e is the only instrument here that
  renders anything**, which is why its launch flags being wrong cost hours.
- **`use_workpiece_edge` protects nothing about a placement that is already flush** — that is now *noted*
  in the emitted program, **not gated**. **No check in the core asserts a margin**; the ~8 mm in our nests
  is where the layout landed.
- **Two hosts, five declared divergences** — including one that diverges **with identical literals on both
  sides**. Gate `HOST` requires each to be declared with a reason; it does **not** require them to be equal.
- **`REFUSED` is now three-valued** — and **sixteen refusals that were scored as safe are capability gaps,
  zero were agreement.**
- **A second writer on `/dev/ttyACM0` corrupts our byte accounting** and needs no hub. Detected, not
  prevented — **Web Serial has no exclusivity concept and `TIOCEXCL` only stops the *next* opener.**
