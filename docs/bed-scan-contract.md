# Bed-scan intake contract (agreed with `ml`, 2026-08-09)

**Status: AGREED, NOT BUILT.** No code in this lane parses this today, and that is
deliberate — `ml` ships nothing until the founder confirms budget, and a half-built
consumer for data that does not exist is the kind of scaffold this lane refuses.
This file exists so the agreement does not live only in two inboxes.

Source: `handover/ml/2026-08-09-2bee_app-your-json-works-except-the-one-field-that-decides-how-high-we-fly.md`
and ml's v2 reply. Hardware: 3× ESP32-S3 + OV5640, spindle-mounted, streaming to a
Pi/CM4 running YOLOv8n. The ESP32 is a streamer, not an inference host.

## The payload

```json
{
  "timestamp": "2026-08-09T10:30:00Z",
  "frame_id": 42,
  "frame": "bed_datum",
  "proposed_keepouts": [
    { "type": "clamp", "confidence": 0.87, "bbox_bed_mm": [120, 45, 165, 90],
      "height_mm": null, "height_basis": "unmeasured", "label": "C-clamp" }
  ],
  "part_presence": { "state": "present", "confidence": 0.95 },
  "photo_url": "/captures/job_042_setup.jpg"
}
```

## The three fields that exist because of a physical failure

**`height_mm` — required KEY, `null` means unmeasured, and it may never be `0`.**
`Fixturing::clearance_z()` takes the tallest declared clamp and refuses every rapid
below it. A `0.0` contributes nothing to that maximum, so the rapid falls back to
`Machine::safe_z_mm` — **5mm by default** — and the gantry crosses the bed 5mm up
with a 40–60mm toggle clamp in its path. `RapidBelowClamp` cannot catch it either:
it compares the rapid's Z against `clamp_height`, and 0 is below every Z. So the one
check for "you flew under a clamp" goes silent exactly when nobody measured the
clamp. **"Nobody measured the height" and "the clamp is flat" are different facts and
only the second is safe to fly over.** Guarded on our side by
`FixtureFinding::ClampHeightUndeclared` (`58ce90f59`), planted red.

⚠ **CORRECTED 2026-08-27: `clearance_z` is a THRESHOLD, NOT A LIFT.** It does not raise anything — it takes the tallest declared clamp and **REFUSES** a rapid that would pass below it (`core/src/fixture.rs`, and the module header says so at the top of the file). The wrong wording came from the core's own doc comments, which said *"lifts every rapid above the tallest clamp"* until 2026-08-10; the core corrected itself and two consumers did not. **The difference is what an operator does next**: a lift means the machine gets itself out of the way, a refusal means the program does not come out and somebody has to act. `web/src/workholding.ts` carries the same correction and the reason it was believable — two files independently reached the same reading of the same code.

**`height_basis` — `unmeasured` · `assumed_from_class` · `stereo` · `operator`.**
If height is ever inferred from the clamp class ("toggle clamps are ~55mm") that is a
guess with a good pedigree, and it must not arrive looking like a measurement. ml
confirmed height is **never** computed from bbox size: a wider clamp is not a taller
one, and a plausible number is worse than `null` — `null` warns, a wrong number flies.

**`frame` — required.** `bed_mm` alone is ambiguous across at least three frames this
lane uses: machine coordinates, the spoilboard corner, and the **workpiece** datum,
which moves (stock carries a placement and a rotation, and the corner touch plate
follows it). A wrong frame is a keepout in the wrong place, **which is worse than no
keepout — it draws a clear area over a clamp.** v1 ships `bed_datum` only.

## Not in this contract, on purpose

**`part_lift` was removed.** Frame-differencing for a part breaking loose is a real
and valuable detector, and it is a **safety system, not a CAM input**: a G-code
program is generated before the cut and cannot react during it. Its consumer is
whatever can feed-hold — `ops`/`pcb` at the sender — on its own contract. Agreed
both ways.

**No `confirmed_clear` path, and there never will be.** Every keepout is a
*proposal*. `Fixturing.confirmed_clear` is set only by a human who looked at the
bed; an export with `false` warns every time. A scan may raise the operator's
attention, never stand in for it.

**No stable per-keepout `id` in v1.** Bboxes are cheap to re-propose; diffing a
rescan can wait until something needs it.

## Ours to do when the artifact lands

- Prefix `photo_url` if the camera pipeline and this UI are not same-origin — ml
  emits a relative path and that resolution is our layer's job.
- Render proposals as dashed outlines requiring confirmation, visually distinct from
  a declared clamp. ⚠ **A proposal that renders like a declaration is the whole risk
  of this feature**; `Clamp` has no provenance field today, and adding one is part of
  intake, not something to bolt on after.

## The claim caution, which both lanes hold

*"A bed scanner that proposes clamp positions in a workshop is not a machine-vision
product."* Every outward description carries **proposes** and **operator confirms**.
And unchanged by any of this: **nothing this lane has emitted has ever cut anything.**
