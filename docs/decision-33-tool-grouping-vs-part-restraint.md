# Decision #33 — tool grouping vs. keeping the part held down

**Read date for every external source in this file: 2026-08-09.** Where a claim could
not be traced to a vendor document it is marked **SECONDARY** or **NOT ESTABLISHED**
and says so, rather than wearing an authority it did not earn.

**This document changes nothing.** No code was edited to write it. It is research plus
one recommendation; the change is the founder's to authorise.

**No prices, no purchasing.** That is `bom`'s lane.

⚠ **Every line number below is read at `19056dc6a`.** `core/` was being edited by another
agent while this was written, so the numbers will drift; the **symbol names** are the
durable reference and the line numbers are a convenience. If a citation does not land,
`grep` the function name — do not assume the code changed.

---

## Part 0 — The condition, measured at the code rather than taken from the ticket

`TODO.md` #33 states the hazard as *"operations are grouped by tool, so on a part cut
with tool A (outline) and tool B (holes), ALL of tool A runs first."* That is true of
the failing case but it is **not the general shape of the defect**, and the difference
decides which options are even on the table. So the first thing this document does is
re-derive the trigger from the source.

### What actually happens

`core/src/job.rs:922-925` runs the pipeline in this order:

```
let (ops, route) = optimise_route(ops);
let groups = crate::toolpath::group_by_tool(ops);
```

`toolpath::group_by_tool` (`core/src/toolpath.rs:751`) groups **in first-appearance
order** — the tool of the first operation in the list gets the first group. It does not
sort, score or choose; whichever tool happens to appear first, runs first.

`toolpath::order_operations` (`core/src/toolpath.rs:734`) already puts every interior
feature before its own outer profile, and `optimise_route`'s constraint 1
(`core/src/optimise.rs:31-36`) is a hard precedence edge saying the same thing. Both are
correct. **Neither survives the regroup**, because the regroup is keyed on tool name and
the precedence is keyed on part.

### The trigger is the ORDER of the tool groups, not the fact of grouping

The lane's own negative test is the cleanest statement of the case
(`core/src/optimise.rs:975-990`):

```rust
fn an_outline_cut_before_its_holes_by_tool_grouping_is_reported_not_repaired() {
    let mut plate = outline("plate", …);  plate.tool = tool6();
    let mut h1 = hole("h1", …);  h1.tool = tool3();
    let mut h2 = hole("h2", …);  h2.tool = tool3();
    // 6mm group first because the outline appears first.
    let (out, report) = optimise_route(vec![plate, h1, h2]);
```

Read the comment on line 982: *"6mm group first **because the outline appears first**."*
Swap the input order — holes first — and the same three operations, the same two tools
and **the same single tool change** produce a safe program. The hazard is not the cost of
grouping. It is that nothing chooses **which group goes first**, and first-appearance
order is a property of how the caller happened to build the vector.

⚠ **This is why the ticket's framing — "safety against machine time" — overstates the
trade.** It is a real trade in one narrow case (Part 3, option 4, cyclic row) and no trade
at all in the ordinary sheet job. A founder asked to spend machine time should be told how
often the bill actually arrives, and the honest answer is: usually never.

### The detection is already reliable, and its refusal to act is deliberate

`verify_interior_before_outer` (`core/src/optimise.rs:732`) runs on the **final** order,
not the intent — which is the lane's standing rule (`AGENTS.md`: *assert on the emitted
program, never on the setting that was supposed to produce it*) applied correctly. It
names the part and every late feature. Its doc comment states the position this decision
is being asked to revisit:

> *"Tool grouping is not tradeable, so the answer is to SAY SO, not to break the grouping
> — the fix is upstream, in which tool is assigned to which feature."*

Two supporting facts the options depend on:

- **"Outer profile" is already a machining fact, not a naming convention.**
  `attribute()` keys on `CutSide::Outside` (`core/src/optimise.rs:302-307`) precisely
  because a name string does not survive an imported DXF. So a phase partition has a
  classifier already.
- **Unattributable operations are barriers, named in `RouteReport::pinned`**
  (constraint 4, `core/src/optimise.rs:56-61`). Any reordering proposal must respect them
  or it silently overturns a rule that exists to stop exactly that.

---

## Part 1 — What the industry actually does

### 1.1 The ordering rule itself is universal. Its ENFORCEMENT is not.

Every package examined agrees that interior features come before the outer profile.
**Not one of them enforces it across a tool change.** The guarantee, where it exists at
all, is scoped to a single toolpath — which by construction is a single tool.

| Package | Who decides operation order | Is "interior before outer" automatic? | Scope of the guarantee |
|---|---|---|---|
| **Vectric VCarve / Aspire** | User orders the toolpath list ("Use the Up and Down arrows to order the toolpath list in the cutting sequence required") | **Yes — but only within one profile toolpath**, i.e. one tool | Nested vectors inside a single toolpath |
| **Fusion 360 / Autodesk CAM** | User's operation list order is the default; tool grouping is **opt-in** ("Reorder to minimize tool changes" in the NC-program dialog) | No — user responsibility, though the reorder respects dependencies | Whole setup, manual |
| **Carbide Create** | Strictly the list order — *"cutting order is based on order or arrangement"* | No | Whole file, manual |
| **Estlcam** | Automatic sort by default | **Yes, and it is documented as a hazard** — auto-sorting holes first floats parts nested inside those holes | Whole file, auto, overridable by grouping |
| **FreeCAD Path/CAM** | The Job Workflow list order; additions append at the end and must be reordered by hand | No | Whole job, manual |

Sources (all read 2026-08-09):

- **Vectric, *2D Profile Toolpath* (vendor documentation — PRIMARY)** —
  <https://docs.vectric.com/docs/V10.0/VCarvePro/ENU/Help/form/uiProfileMachineForm/>
  Verbatim: *"the program will always cut the inner vectors before the outer vectors to
  ensure **the part remains attached to the original material as long as possible**."*
  And: *"If you have vectors which are nested (like the letter 'O'), the program will
  automatically determine the nesting and cut the correct side of the inner and outer
  vectors."* And on tabs: *"Tabs are added to open and closed vector shapes to hold parts
  in place when cutting them out of material."*
  Order-tab options are travel heuristics only — *Vector Selection Order*, *Left to
  Right*, *Bottom to Top*, *Grid* — none of them is a safety rule.
- **Vectric, *Save Toolpaths* (vendor documentation — PRIMARY)** —
  <https://docs.vectric.com/docs/V10.0/VCarvePro/ENU/Help/form/Save%20Toolpaths/>
  Multiple toolpaths go into one file only when they share a tool, **or** when the post
  emits ATC commands; otherwise it is one file per tool. Verbatim on ordering: *"Use the
  Up and Down arrows to order the toolpath list in the cutting sequence required."*
  ⇒ **Vectric's answer to our exact question is to hand it to the operator.**
- **Autodesk, "Reorder to minimize tool changes…" support articles** —
  <https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Reorder-to-minimize-tool-change-does-not-find-the-most-efficient-order-of-operations-in-Autodesk-HSM-and-Fusion-360.html>
  and
  <https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Reorder-to-minimize-tool-changes-does-not-work-with-multiple-instances-of-Multiple-WCS-Offsets-in-Fusion-360.html>
  🔴 **Both returned HTTP 403 to direct fetch. Everything asserted about them below is
  SECONDARY**, from search-index content, and is flagged as such — the same treatment
  `materials-research.md` gave the Amana chart. Two facts recur across the indexed
  content and the Autodesk community threads: the reorder is an **option you tick**, not
  the default; and *"some operations are not reordered due to the need for another
  operation to be completed first"* — i.e. **the tool-change minimiser is subordinate to
  operation dependencies, not the other way round.** Autodesk community threads:
  <https://forums.autodesk.com/t5/fusion-manufacture-forum/reorder-to-minimize-tool-changes-not-working-correctly/td-p/10640348>
- **Autodesk, "How to reorder toolpath operations in a CAM setup in Fusion"** —
  <https://knowledge.autodesk.com/support/fusion-360/learn-explore/caas/sfdcarticles/sfdcarticles/How-to-change-the-order-of-toolpath.html>
  (drag-to-reorder; manual.)
- **Protohaven, *Fusion 360 CAM Handout* (SECONDARY — a makerspace class handout, not
  Autodesk)** — <https://wiki.protohaven.org/books/class-handouts/page/fusion-360-cam-handout>
  Verbatim: *"Facing should be first, then Profile, then Spot Drill (**or Spot Drill
  before profile if you need holes established before cutting the outer profile**)."*
  Also records that free-tier Fusion users *"output one file per tool type"* —
  ⚠ **tool grouping there is a LICENCE restriction, not a safety choice.**
- **Carbide 3D community, *Toolpath order in CC programing* (SECONDARY — vendor-hosted
  forum, one answer from Carbide's own William Adams)** —
  <https://community.carbide3d.com/t/toolpath-order-in-cc-programing/33618>
  Verbatim: *"cutting order is based on order or arrangement, so will cut Toolpath 2
  before Toolpath 1, if Toolpath 1 has been moved below Toolpath 2 in the list."* And
  from a user: *"Always cut least intrusive cuts first keeping cutouts for last."*
- **V1 Engineering forum, *EstlCam Cutting Order* (SECONDARY — user forum)** —
  <https://forum.v1e.com/t/estlcam-cutting-order/14023>
  Estlcam *"always cuts the holes first so the parts in the piece that was cut out are
  floating"* — the automatic sort creates a **different** release hazard: a small part
  nested in a large part's hole is released when that hole is cut. Worth recording
  because it is the failure mode of naive automation of the same rule.
- **FreeCAD wiki, *Path Workbench* / *Path FAQ* (PRIMARY — project documentation)** —
  <https://wiki.freecadweb.org/index.php?title=Path_Workbench> ·
  <https://wiki.freecadweb.org/Path_FAQ/en>
  The Job Workflow lists operations in execution order; additions append at the end and
  must be reordered in the Workflow tab. No automatic safety ordering.

### 1.2 The machinist rule of thumb

The nearest thing to an authoritative published statement of sequencing discipline is
**Modern Machine Shop**, *6 Steps to Take Before Creating a CNC Program* —
<https://www.mmsonline.com/articles/6-steps-to-take-before-creating-a-cnc-program>
(trade press, PRIMARY for the trade). Verbatim:

> *"One general rule of thumb is to rough everything before finishing anything. If this
> rule is broken, it may be impossible to consistently produce acceptable workpieces."*

⚠ **That article does NOT state an interior-before-profile rule**, and it does not
mention tool changes. Do not cite it for more than it says. It establishes only that
**process sequence is treated in the trade as a correctness constraint, not a preference**
— which is the principle at issue, one step above the specific rule.

For the specific sheet-goods rule the sourcing is weaker and it is honest to say so. The
strongest statement found is Vectric's own, quoted above (*"so the part remains attached
to the original material as long as possible"*), which is a vendor documenting the reason
in its own product. **No Onsrud, Shopbot or CNCCookbook document was found that states
the rule in those words** — see Part 5.

### 1.3 Parts breaking loose — what the shops actually do about it

The failure is well documented and the remedies are consistent.

- **WOODWEB CNC forum, *Small parts moving* (SECONDARY — trade forum)** —
  <https://woodweb.com/cgi-bin/forums/cnc.pl?read=803126>
  Verbatim on the failure: *"When it is making the final through cuts, that's when the
  parts start moving and of course the ones that move get ruined."* Remedies given:
  cut small parts first while vacuum is at maximum; onion skin ≈0.03″ and **halve the
  feed on the final cut-out pass**; tabs ≈1/8″ thick × 1¼″ long; keep the spoilboard
  clean and flycut it (*"dust acts like little ball bearings"*).
- **Laguna Tools, *Onion Skinning for Small Parts on Your CNC* (vendor blog — PRIMARY for
  the technique, promotional in tone)** —
  <https://info.lagunatools.com/onion-skinning-for-small-parts-on-your-cnc>
  Verbatim: *"Using tabs is common but, because of their size, they may not work well for
  small parts."* Method: set *"the cut depth to .020″ less than the thickness of your
  material."* Downside named by the vendor itself: releasing the parts afterwards by
  knife is *"a slow process"* with the risk that a *"slip of the knife"* damages the piece.
- **WOODWEB knowledge base, onion-skin cleanup articles (SECONDARY)** —
  <https://woodweb.com/knowledge_base/Troubleshooting_a_Lip_on_the_Finish_Cut.html> ·
  <https://woodweb.com/knowledge_base/Precision_in_the_OnionSkin_Cleanup_Cut_Pass.html>
  Onion skinning trades a release hazard for an **edge-quality** problem (a lip at the
  skin line) and a **secondary operation**.

⇒ **The industry's answer to "the part is loose" is a hierarchy, not a single fix:**
order the cuts so it stays attached → tabs → onion skin → vacuum/tape/screws. Ordering is
the first line of defence everywhere, and it is the only one that costs no material,
no consumable and no secondary operation.

---

## Part 2 — The cost of an extra tool change on this machine

Our machine has **no ATC**. A change is a human at the machine, plus a Z re-reference —
and `job.rs:989-998` already refuses to leave that implicit: if `probe_after_toolchange`
is false the job emits *"Z was NOT re-referenced after the tool change — every cut with
this tool is wrong by the difference in tool length."*

🔴 **The per-change time cost could NOT be established from any published source.**
Searches across ATC-vendor marketing, Vectric and CNCZone forums, and touch-plate
documentation returned only qualitative claims — automatic changes happen *"within
seconds"* and manual changes *"interrupt production"* — with no measured figure for a
manual change plus re-probe. Representative of the class, and cited only as evidence that
the number is marketing rather than measurement:
<https://www.acctekgroup.com/how-to-choose-automatic-tool-changers-for-cnc-routers/>.

The lane's own working figure — *"a minute of operator time plus a Z re-reference"*
(`core/src/optimise.rs:39-40`, restated in `TODO.md` #33) — is a **GENERIC** estimate with
no citation, in exactly the sense `materials-research.md` uses the word. It is plausible
and it is unverified.

⚠ **This matters less than it looks**, and it is worth saying plainly before the options
table: the analysis below shows the recommended option costs **zero** extra changes on
every ordinary job on this machine, so the accuracy of the per-change figure does not move
the decision. It would only matter for the pathological case in the last row.

---

## Part 3 — The options

Two options exist that the ticket does not list. Both come out of Part 0's finding that
the trigger is group **order**, not grouping.

### Option 4 — order the tool GROUPS instead of breaking them

Keep every operation grouped by tool. Choose **which group runs first** so that a tool
cutting a part's interior features precedes the tool cutting that part's outer profile.
Formally: build a precedence graph over tool groups (edge `tool(interior of P)` →
`tool(outer of P)` for every part where they differ) and topologically sort it, breaking
ties by first appearance so determinism — and therefore gate **K3** — is preserved.

The simple always-correct implementation of the same idea is a **two-phase partition**:
every operation that does not release a part first, every release operation last, grouped
by tool inside each phase, with the phase-1 and phase-2 group orders chosen so the last
tool of phase 1 is the first tool of phase 2 wherever a tool appears in both.

**Cost, worked through rather than asserted:**

| Job shape | Today | Option 4 | Extra changes |
|---|---|---|---|
| One tool does everything | 0 changes | 0 | **0** |
| 6 mm outlines, 3 mm holes (the ticket's case, and our hive panels) | 1 | 1 (3 mm then 6 mm) | **0** |
| 6 mm outlines + 6 mm pockets, 3 mm holes | 1 | 1 (3 mm → 6 mm pockets → 6 mm outlines, no boundary between the last two) | **0** |
| Interleaved: A cuts P's outline and Q's interior, B cuts Q's outline and P's interior (a cycle) | 1 | 2 (B → A → B) | **1** |

**The first three rows are every job this lane has ever been asked to produce.** The
fourth requires two tools each doing interior work on one part and release work on
another — constructible, and not a shape any hive panel produces.

### Option 5 — defer the release, not the operation (onion skin / final release pass)

Cut the outer profile to *stock thickness minus a skin* in its own tool group wherever it
falls, then emit a **final full-depth release pass** for every part at the very end of the
program, after all other work, regardless of tool. This is the industry's own escalation
(Part 1.3) and it is the only option that also protects against the failure tabs are bad
at — a small part released by its own tabs breaking.

It is listed for completeness and **is not recommended as the answer to #33**: it changes
emitted geometry (a new operation, a new depth), it introduces the lip/cleanup problem
the WOODWEB articles document, and it needs its own gate and its own coupon. It is a
future ticket, and it composes with option 4 rather than replacing it.

### The table

Safety column = what the operator is protected from. "Wrong" column = the failure mode of
the option's own mechanism, which is the column that decides this.

| # | Option | Safety | Machine time | Implementation cost here | What happens when it is wrong |
|---|---|---|---|---|---|
| 1 | **Refuse the job** | Highest — the program cannot run | Infinite: the job does not run at all | Low — a `Refusal` alongside the existing warning in `job.rs` | 🔴 **Refuses the ordinary case.** The ticket's own example (6 mm outline, 3 mm holes) is the standard hive-panel job, and per Part 0 it is *already safe* if the groups are ordered — so refusal blocks work the machine can do correctly. A tool that refuses routine work gets bypassed, and a bypassed gate protects nobody. |
| 2 | **Break tool grouping for the affected part** | High — that part's holes precede its outline | 1 extra change **per affected part**, and it un-groups a tool that was grouped for a reason | Medium — a per-part exception inside `optimise_route`, cutting across constraint 2 | Pays a change per part where option 4 pays none; on a 20-part sheet this is 20 extra manual changes and 20 re-probes to fix something a group swap fixes for free. The extra changes are themselves a hazard: every one is a fresh chance to fit the wrong cutter or skip the probe. |
| 3 | **Keep warning** (status quo) | Lowest — depends on a human reading a warning about a program that will run | 0 | 0 | The failure P1 exists to prevent, arriving with a green-ish program in hand. `AGENTS.md`: *"a stale 🔴 is as expensive as a stale ✅"* — a warning that fires on ordinary jobs is one the operator learns to scroll past, and then it is not a control. |
| **4** | **Order the tool groups (two-phase partition)** | High — the property `verify_interior_before_outer` checks becomes structurally true, not merely reported | **0 on every ordinary job**; ≤1 extra change in the cyclic case | Medium — a topological/phase sort in `optimise_route` before the existing grouping; classifier (`CutSide::Outside`) and trigger already exist; must honour pinned barriers | If the constraint graph has a cycle **or** a pinned operation sits between the phases, no grouped order satisfies the rule — so it must still refuse or still warn. **That residual is the honest limit and it must be reported, not hidden;** an option-4 that silently returns the old order in the hard case would be the worst outcome of all four. |
| 5 | **Onion skin + deferred release pass** | Highest of the runnable options — protects against tab failure too | 0 extra changes, but a second pass over every profile | High — new geometry, new op type, new gate, needs a coupon on a real machine (`ops`) | Changes the emitted part: a mis-set skin either does not release (a rubbing pass at full depth) or releases early. Unlike 1–4 this one **moves coordinates**, so it is outside `optimise.rs`'s safety argument entirely. |

---

## Part 4 — 🔴 The recommendation

> **Take option 4: order the tool GROUPS so that interior work precedes release work, and
> keep the refusal for the residue that option 4 cannot fix.**
>
> Concretely: partition operations into "does not release a part" and "releases a part",
> group by tool within each phase, and order the two phases' groups to merge at the
> boundary. Then re-run `verify_interior_before_outer` on that output — unchanged, it is
> already the right check in the right place — and **REFUSE** any job it still flags,
> rather than warn. Do not implement option 2. Do not implement option 5 under this
> ticket.

**Why it beats the others.**

The ticket asks the founder to buy safety with machine time. **On every job this lane
actually produces, option 4's price is zero** — same operations, same tools, same single
tool change, different group order (Part 3 table, rows 1–3; and the lane's own test at
`core/src/optimise.rs:975` proves it, since its failing case becomes safe purely by which
operation appears first in the input vector). Option 2 buys the same safety and pays a
change per part for it. Option 1 refuses the standard hive-panel job. Option 3 leaves a
warning in front of a program that will run, which is the arrangement the lane's first
duty exists to reject.

The industry evidence points the same way and is worth stating as the negative finding it
is: **no CAM package examined subordinates safety ordering to tool grouping — but none of
them enforces the safety order across tools either.** Vectric guarantees inner-before-outer
inside one toolpath and then hands the cross-tool question to the operator's list order.
Fusion makes tool grouping an **opt-in** that yields to operation dependencies, per the
SECONDARY Autodesk material. Carbide Create and FreeCAD do exactly what the list says.
Estlcam automates the rule and thereby invents a new release hazard. So option 4 is not us
inventing something: **it is us doing automatically, and checking, what every one of these
packages leaves to a human — which is precisely the gap this lane exists to close** (the
CAM step is *"the only manual, proprietary, unversioned link"*).

**Does this honour *refuse rather than approximate*?**

**Yes, and it is important that it is not a departure.** The rule forbids approximating a
safe answer when the safe answer is unavailable; it does not require refusing a job for
which a *correct* order exists. Option 4 emits an order that is **exactly right**, not
approximately safe — and where no correct grouped order exists (a cycle, or a pinned
barrier between the phases), the recommendation is to **refuse, not to warn**, which is
strictly stricter than today. The lane ends up refusing *more* jobs than it does now, and
refusing them for a reason it can name.

⚠ The one place a departure could sneak in: if option 4 is built and the residual case is
left as a warning "because option 4 handles almost everything", the net effect is a
control that is quieter than today's while covering less than it claims. **The refusal
half is not optional and is not a follow-up ticket.**

**The cost of being wrong.**

If option 4 is wrong, it is wrong in one of three ways, and none is silent:

1. **The phase classifier is wrong** — an operation that releases a part is not
   `CutSide::Outside` (e.g. an interior cut that frees a nested small part, the Estlcam
   failure in Part 1.1). Then a part is released in phase 1 and the whole scheme has
   bought nothing for that part. ⇒ **`verify_interior_before_outer` still runs on the
   output and still catches it**, because the check is on the emitted order and is keyed
   on part attribution, not on the phase. This is the reason to keep the check rather than
   delete it once the ordering is "fixed".
2. **A pinned operation blocks the required move** — reported today, must stay reported.
3. **The extra tool change in the cyclic case is mis-costed** — the worst case is one
   change, on a job shape our parts do not produce (Part 2: the per-change figure is
   unverified, and does not move the decision).

The failure mode option 4 **cannot** protect against is the one it never claimed: a part
correctly ordered and still inadequately held. That is tabs (P1), fixturing (P7, E5) and
the workholding catalogue (#34) — and it is why option 5 stays on the list as a separate
future ticket rather than being folded in here.

**One thing the founder should decide alongside this**, because it is the same physical
question one layer up: `verify_interior_before_outer`'s doc comment currently says *"the
fix is upstream, in which tool is assigned to which feature"*. Adopting option 4 makes
that sentence wrong and it must be corrected in the same change — **a stale comment
explaining why a control is right is, per the lane's own memory, the least-audited thing
in the repo.**

---

## Part 5 — What could not be established

Named rather than guessed, in the order they would change the analysis.

1. 🔴 **The time cost of a manual tool change plus Z re-reference on a router.** No
   published measurement was found. ATC vendors say "seconds" for automatic changes and
   nothing quantified for manual ones. The lane's "a minute plus a re-reference" is
   **GENERIC**. *(Does not change the recommendation — option 4 costs zero changes on our
   jobs — but it would decide between options 2 and 4 if that were ever the live question,
   and it is the number to measure first if it becomes one. `ops` can measure it in one
   afternoon; nobody needs to publish it.)*
2. 🔴 **A primary, quotable statement of the sheet-goods rule from a tooling or machine
   vendor** — Onsrud, Shopbot or CNCCookbook. Searched; not found in those words. The
   strongest primary is **Vectric's own product documentation**, which states the rule and
   its reason. Everything else found is trade forum or class handout. *The rule is
   universally practised and thinly documented, and those are different facts.*
3. 🔴 **Autodesk's own words on "Reorder to minimize tool changes".** Both support
   articles returned **HTTP 403** to direct fetch and every Autodesk domain refused. The
   two claims made from them — that the reorder is opt-in, and that it yields to operation
   dependencies — are **SECONDARY** and consistent across several independent community
   threads, but they are not quoted from Autodesk. If this decision ever turns on Fusion's
   exact behaviour, someone with a Fusion seat should read the dialog.
4. 🔴 **Whether any commercial CAM enforces interior-before-outer ACROSS a tool change.**
   Five packages were examined and none does. That is **five negatives, not a survey** —
   Mastercam, PowerMill, SolidCAM, RhinoCAM and Alphacam were not examined, and a
   production package may well have the constraint under another name (Fusion's
   "dependencies" hints at the shape of it). **Do not restate this as "no CAM does this."**
5. 🟡 **How often the condition actually fires in this lane's own fixtures.** The
   pipeline was read but no job was run to count real occurrences, because running the
   fixtures means building the core and the core is being edited by another agent right
   now. The frequency would sharpen the argument in Part 3 but cannot reverse it: option 4
   is free in the cases that matter whether they are 5% of jobs or 95%.
6. 🟡 **Whether the two-phase partition can ever fight constraint 3** (shallow before deep
   within a part). It should not — depth precedence is applied only *between two interior
   features*, and both stay in phase 1 — but this was reasoned from the code, not proven
   by a test. **Whoever implements option 4 must plant it** (`--plant`) rather than trust
   this paragraph.

---

*Written by a research pass on 2026-08-09 for the `2bee_slicer` lane. No code, gate,
spec or TODO row was modified. The decision is the founder's; the reasoning above is
meant to be attacked, and Part 5 is where to start.*
