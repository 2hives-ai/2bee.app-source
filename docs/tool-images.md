# Pictures for the tool library

**Status:** the tool picker draws **SVG schematics generated from the tool record**
(`web/src/toolShape.tsx`). **No photograph is stored in this repo, and none should be.**

This file records *why*, what was searched, and the only three openly-licensed photographs
that were actually found — as **links, not copies**.

---

## 1. Why not manufacturer product photographs

Router-bit product shots on Amana, Onsrud, Whiteside, Freud, CMT, Carbitool, Bits&Bits,
supplier catalogues and marketplace listings are **copyrighted works owned by those
companies**. Being reachable is not being licensed — the same distinction this lane already
applies to controller capabilities and platform APIs.

The consequence here is sharper than usual because of the licence:

> This app is **AGPL-3.0-or-later**, and **§13 means that serving it over a network obliges us
> to offer its complete corresponding source to every user**. Any image committed to this repo
> therefore travels *with* that offer, to everyone, forever, as part of a package we assert we
> are entitled to convey. A copied product photo makes that assertion false — for the whole
> distribution, not just for the file.

An image is a dependency with no compiler to catch it. `CLAUDE.md` already requires every
dependency to be licence-checked before it lands; this is that rule applied to an asset.

**So: do not download product photographs into this tree.** Not into `web/public/`, not
base64-inlined, not "temporarily for the mockup", and not scaled down (a thumbnail of a
copyrighted photo is a copyrighted photo).

## 2. Why the schematics are also the better answer

This is not only the lawful route, it is the more useful one. A photograph of a router bit is
a shiny cylinder against a white background. Held against the numbers we already have in
`core/src/tools.rs`, the photo loses on every fact an operator is actually choosing between:

| Fact | Product photo | `toolShape.tsx` |
|---|---|---|
| Diameter **against other tools** | no — every photo is cropped to fill its frame | yes — one shared px/mm across the whole list, so 3mm is a third of 9mm |
| Shank stepping up or down from the cutter | sometimes, at an unknown scale | yes, to the same scale, and it is a **fitting fact this app refuses jobs over** |
| Flute length against diameter | no | yes, at true scale, broken when it will not fit |
| Which way the helix runs | **no** — an up-cut and a down-cut 6mm two-flute are the same photograph to anyone not holding both | yes, opposite hatch; compression draws both meeting |
| Tip angle (60° vs 90° vs 120° vee, 118° vs 180° point) | not measurable from the image | drawn at the stated angle, or **not drawn at all** |
| Whether we *hold* a number for any of the above | invisible — a photo looks equally authoritative either way | a missing number produces a missing feature plus a sentence saying so |

And the schematic changes when the tool record changes. A photo of last year's part does not.

## 3. Openly-licensed photographs that DO exist (links only — nothing downloaded)

All read **2026-08-08**. Recorded so nobody has to re-run the search, **not** as an approval to
copy them in.

| Image | Licence (as stated on its Commons file page) | Author / date | What it shows |
|---|---|---|---|
| [`File:Routerbits.jpg`](https://commons.wikimedia.org/wiki/File:Routerbits.jpg) | **Public domain** — released by the copyright holder | BTDenyer (Tristan Denyer), 2006-01-16 | Two ¼″-shank bits: a Roman ogee with bearing, and a dovetail bit |
| [`File:MillingCutterSlotEndMillBallnose.jpg`](https://commons.wikimedia.org/wiki/File:MillingCutterSlotEndMillBallnose.jpg) | **CC BY-SA 2.0** | Glenn McKechnie, 2005-03-26 | Three cutters together: slot drill, end mill, ball nose |
| [`File:Oberfraese_Fraeser_1.jpg`](https://commons.wikimedia.org/wiki/File:Oberfraese_Fraeser_1.jpg) | **CC BY-SA 4.0** | D-Platoon, 2023-01-01 | Assorted router cutters, collets and reducers, numbered with specs |

Useful starting points if the search is ever repeated:
[`Category:Router bits`](https://commons.wikimedia.org/wiki/Category:Router_bits) (17 files),
[`Category:Endmill tools`](https://commons.wikimedia.org/wiki/Category:Endmill_tools) (24 files),
[`Category:Milling tools`](https://commons.wikimedia.org/wiki/Category:Milling_tools).

🔴 **None of these is a picture of a tool in our library.** They are group shots of *other*
people's cutters at unstated diameters. Even with a perfect licence, putting one beside
"End Mill – Down-cut 6mm 2F" would be a picture of a different tool sitting in the row for
ours — the failure mode is *"a true fact about the wrong artefact reads as a finding"*, drawn
at 24px. They are fine as illustration in a document. They are **not** per-row tool images,
and that is a second, independent reason the schematics exist.

⚠ **A trap worth writing down:** searching "ball mill" returns a **grinding drum for ore**, not
a ball-nose end mill. Two of the four search paths landed there. Check what the photograph is
*of* before checking its licence.

## 4. If a real photograph is genuinely wanted

Two lawful routes, in order of preference:

1. **Link out, copy nothing.** A row's properties can carry an outbound link to the
   manufacturer's own product page. Their servers, their image, their licence, our zero
   copies. This is the only route that is free of an ongoing obligation.
2. **An explicitly-licensed image, with the licence recorded next to the file.** CC0 / public
   domain is the clean case. **CC BY and CC BY-SA carry obligations that follow the file**
   (attribution, licence notice, link, and for -SA the share-alike terms) and those obligations
   must be satisfied *in the served page*, not only in a README — §13 means the served page is
   where users meet it.
   - Any image landing under route 2 gets a row in a table in **this file** — source URL,
     licence, author, date read — created **in the same commit as the image**. An asset whose
     provenance is recorded later is an asset that was, for a while, unprovenanced.
   - **The AGPL-compatibility call on a CC BY-SA asset is not this lane's to make.** Route it
     to `legal` before it lands. This lane can say the schematic route needs no such call,
     which is the point.

**A third route that is not a route:** re-drawing a manufacturer's photograph closely enough to
be recognisable, or feeding it to an image generator. That is a derivative work with the
provenance filed off, and it is worse than the copy because nothing in the repo shows where it
came from.

## 5. What the schematics deliberately do NOT draw

`toolShape.tsx` refuses rather than approximates, and `describeToolShape()` returns each refusal
as a sentence so a caller can show it in words. Silence in a drawing reads as "fine".

| Missing number | What is drawn instead |
|---|---|
| `included_angle_deg` on a V-bit / chamfer / countersink / engraver | **No tip.** The body ends in a dashed line. A drawn 90° vee on a tool whose angle we never read would be the picture lying about the tool being chosen — and it would lie most convincingly on the tools where the angle matters most |
| `point_angle_deg` on a drill | same — no cone |
| `flute_type` | **No helix.** A dashed centre line, deliberately unlike the evenly-spaced solid lines that mean "straight" |
| `shank_mm` | **No shank.** The body's top edge is dashed and nothing is drawn above it |
| `diameter_mm` | **Nothing.** An empty dashed frame |
| overall tool length (not a field at all) | the shank is **always** drawn broken — the drafting zig-zag for "shortened, not shown to length" |
| the height a compression cutter's two helices meet at (not a field) | drawn meeting mid-flute, and the description says that is not a measurement |

🔴 **One live gap, in the core rather than here.** `Tool::flute_type`
(`Flute::{Straight, UpCut, DownCut, Compression}`) exists in `core/src/tools.rs` and every stock
end mill sets it — but it is **not** among the fields
`core/src/fixtures.rs::tool_library_json_for()` ships to the UI. So today **every tool takes the
"direction unstated" branch**, and the helix — the single most useful thing a drawing shows that
a photograph cannot — is dark for the whole library. `toolShape.tsx` already handles all four
values; one field in that JSON turns it on. That is a core change and is not this file's to make.
