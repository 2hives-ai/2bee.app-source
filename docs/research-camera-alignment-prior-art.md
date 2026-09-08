# Camera crosshair alignment — LinuxCNC `camview` and the prior art

Agent research, **read 2026-08-10**, at the request of the `2bee_app` lane. Every claim
below carries the URL it came from and the date it was read. Where a claim comes from a
forum post it is labelled as **what a user did**, never as what is true.

> 🔴 **THIS IS A REFERENCE, NOT A PROPOSAL.** The founder has **stopped the camera
> hardware line**. This document was commissioned to be finished anyway, so that whenever
> the question returns the research does not have to be re-run. **Nothing here recommends
> building anything.** Read §7 as *"if it restarts, here is what is already known"*, not as
> a plan.

> ⚠ **The one thing to take away if you read nothing else:** the mature, decade-old,
> widely-copied version of this technique **does not compute the camera-to-spindle offset,
> does not correct lens distortion, and does not know how many millimetres a pixel is.**
> The crosshair is drawn at the geometric centre of the widget and the offset is a number a
> human measures once with a drill and a jog handle. Every implementation surveyed leaves a
> human at the crosshair. That is the state of the art, not a gap in the search.

---

## 0. What I could not establish

Stated first, deliberately, because a confident synthesis over these gaps would be worth
less than the gaps themselves.

1. **`camview-emc`'s source code is not reachable today.** Its documented home,
   `http://psha.org.ru/cgit/psha/cu-plugins`, returns **404** (checked 2026-08-10), as does
   `http://psha.org.ru/cgit/` itself. The Wayback Machine holds the cgit **summary page
   only** (<https://web.archive.org/web/20190121023438/http://psha.org.ru/cgit/psha/cu-plugins>,
   read 2026-08-10) — no tree, no files. ⇒ **I could not read the licence header of the
   `emc.crosshair` / `emc.halio` camunits plugins, and I do not assert one.** What I *did*
   read is one derived copy of the launcher script (§1.1), which carries no header at all.
2. **The oldest and largest forum thread on this technique — "Another tab for WebCam"
   (`forum.linuxcnc.org/21-axis/2198-...`, ~27 pages) — is gone.** Every URL variant
   returns 404 and the Wayback Machine has no capture of the paginated pages
   (checked 2026-08-10). Search engines still index snippets of it. **I have not read that
   thread and nothing below is sourced from it.** The community's own primary record of how
   this technique developed is partly unreadable.
3. **Nobody has published a measurement of how accurate this technique is.** See §6. This
   is a finding, not a search failure — I looked for one specifically and found claims,
   impressions and vendor specifications instead.
4. **The `-o xscale=`/`yscale=` percentages in `cam_align` are aspect-ratio and flip
   controls, not a pixel-to-millimetre scale.** I am confident of this from the source
   (§2.1) and the official docs, and I flag it because the names invite the opposite
   reading.
5. **The licence conclusions in §4 are measured facts about file headers.** The *legal*
   conclusion drawn from them — what may be copied into an AGPL-3.0-or-later work — is
   this lane's reading and should be confirmed by `legal` before any line of code is
   copied. §4 separates the two.
6. **Three commercial procedures are unobtainable in text** (§5.4): **Trotec's** Vision
   calibration is published **only as video**, which was not opened; **MultiCam's**
   "MultiVision" and **AXYZ's** "AVS IP Vision System" have one-sentence product blurbs and
   no reachable documentation. **Estlcam's** camera zeroing is confirmed by a one-line
   vendor changelog entry and is otherwise vendor-undocumented in text.
7. **Two sources were unreachable on the day** and their absence is not evidence either way:
   the **MachSupport Mach3 wiki** returned HTTP 500 on every page, so Mach3's screen-designer
   video object could not be checked; **forum.cncdrive.com** returned HTTP 403, so **zero
   user evidence was obtained for UCCNC**.
8. 🔴 **This document already got one thing wrong and was corrected mid-write.** §7.1
   asserted that no implementation records the Z at which the offset was measured. **bCNC
   does, and drives back to it.** The claim had been generalised from the LinuxCNC tree to
   "the prior art". The correction is left visible in §7.1 rather than silently edited,
   because an absence claim is the easiest kind to get wrong and the hardest kind for a
   later reader to re-check.

---

## 1. What `camview` actually is

**"camview" names at least four different things**, built by different people, a decade
apart, with different dependencies and different capabilities. Conflating them is the first
mistake available here, and most forum threads make it.

### 1.1 `camview-emc` (2010–2012) — the original, and it is dead

- **What.** A Python program that embeds a live camera image as a tab inside AXIS (or
  Touchy) using the **XEmbed** protocol. Written by **Pavel Shramov (`psha`)**.
- **Built on.** **CamUnits**, a GLib/GTK image-acquisition framework for computer-vision
  research by Albert Huang (`ashuang`), plus Shramov's own **`pycamunits`** Python bindings
  and a **`cu-plugins`** package of extra CamUnits "units".
  Source: <http://psha.org.ru/b/camview-emc.html>, read 2026-08-10; the page's own footer
  gives **last updated 2012-04-15**. The author's description of the approach: *"simple
  camview replacement (without manager/control widgets) may be written in ~30 lines of
  code."*
- **How the overlay is drawn.** The crosshair is **a CamUnits processing unit in the image
  chain**, with id **`emc.crosshair`**, supplied by the `camunits-plugins-emc` package —
  not by LinuxCNC. Verified in the one surviving copy of the launcher script,
  <http://wiki.linuxcnc.org/uploads/camview-emc-f1oat.py> (read 2026-08-10, 359 lines,
  a user-modified copy hosted on the LinuxCNC wiki): `c.add_unit_by_id('emc.crosshair')`,
  with GUI controls bound to the unit's `shape`, circle radius, angle and colour controls.
  The script also references an `emc.halio` unit — a HAL bridge.
- **What the EMC plugin claimed to add.** The Russian-language author page
  (<http://psha.org.ru/b/camview-emc.ru.html>, read 2026-08-10, last updated 2011-05-20)
  describes `camunits-plugins-emc` as providing *"output of current coordinates over video
  or, conversely, transmission of object coordinates"* — i.e. a DRO overlay and a path from
  image coordinates back to the controller. ⚠ **I could not read that plugin's source
  (§0.1), so I cannot say whether the "transmission of object coordinates" was ever more
  than a HAL pin a human drove.** Do not cite it as evidence of automation.
- **How it was installed and invoked.** A third-party Debian repository
  (`deb http://psha.org.ru/debian/ lucid contrib`) and `apt-get install camview-emc`, then
  in the LinuxCNC INI:
  ```ini
  [DISPLAY]
  EMBED_TAB_NAME = camera
  EMBED_TAB_COMMAND = camview-emc -C camview.conf -w {XID}
  ```
  Source: <https://github.com/jieter/linuxcnc-config/blob/master/notes/camview.md>, read
  2026-08-10, quoting the (now unreachable) LinuxCNC wiki page `Adding_Camview`.
- **Status: dead.** CamUnits' last ChangeLog entry is **2010-01-27**
  (<https://raw.githubusercontent.com/ashuang/camunits/master/ChangeLog>, read 2026-08-10).
  `cu-plugins`' last tag was **0.0.37**, roughly 2011 by the Wayback snapshot's relative
  dating. The Ubuntu Lucid/Wheezy repository is long gone. Users were still failing to make
  it work in 2022 — <https://forum.linuxcnc.org/21-axis/45407-camview> (read 2026-08-10),
  where `Henk` (21 Mar 2022, running 2.8.1) reports *"LCNC starts, but the camview tab is
  blank"* after following the wiki page.

### 1.2 The qtvcp `CamView` widget and the `cam_align` panel (2017–present) — the live one

This is what a current LinuxCNC install actually gives you.

- **Where.** `lib/python/qtvcp/widgets/camview_widget.py` (768 lines) and the panel
  `share/qtvcp/panels/cam_align/{cam_align.ui, cam_align_handler.py}` in the LinuxCNC
  repository. Read at `master`, 2026-08-10.
- **Who and when.** `Copyright (c) 2017 Chris Morley`. First commit
  **2017-11-24**, *"qtvcp -add camview widget and dialog"* (`gh api repos/LinuxCNC/linuxcnc/commits`,
  read 2026-08-10). Present in tag **v2.8.0**, released **2020-08-30** — so the first
  LinuxCNC release shipping it is **2.8.0**.
- **How it gets an image.** **OpenCV** (`import cv2`), via a `WebcamVideoStream` helper
  class that runs `cv2.VideoCapture(src, api)` on a background thread. Camera index, OpenCV
  backend (`V4L2`, `ANY`, …) and requested resolution are settable; there is a
  resolution-probing helper and a port-scanner that reports which `/dev/video*` indices
  work. If `python3-opencv` is missing the widget degrades to a blank box reading
  `Missing\npython-opencv\nLibrary` rather than crashing the GUI.
- **How the overlay is drawn.** Qt `QPainter`, in `paintEvent`, in three calls:
  `drawText` (the rotation readout), `drawCircle`, `drawCrossHair`. 🔴 **Both are centred on
  the widget:**
  ```python
  def drawCircle(self, event, gp):
      size = self.size(); w = size.width(); h = size.height()
      ...
      center = QtCore.QPoint(w//2, h//2)

  def drawCrossHair(self, event, gp):
      size = self.size(); w = size.width()//2; h = size.height()//2
      ...
      gp.translate(w, h)
      gp.rotate(-self.rotation)
  ```
  **There is no offset term anywhere in the drawing path.** The crosshair is the geometric
  centre of the widget, always.
- **What it can do.** Digital zoom (crop-and-rescale about the image centre, 1×–5×), a
  rotatable crosshair with selectable increments (5 / 1 / 0.5 / 0.1°), an adjustable
  circle, X/Y image flip via negative scale, save-frame-to-PNG, and one HAL pin —
  `cam-rotation`, a float carrying the crosshair angle in degrees. That pin is the widget's
  **only** output to the rest of the machine.
- **Dead code worth knowing about.** The file contains `findCircles` (a `cv2.HoughCircles`
  call) and `blobInit`/`findBlob` (a `SimpleBlobDetector`). **Both are unreferenced** —
  `blobInit` is commented out in `__init__` and neither is called from any live path. They
  render to a separate `cv2.imshow` debug window, not to the widget, and neither feeds a
  position. **A reader skimming this file can easily conclude LinuxCNC does automatic hole
  detection. It does not.**
- **How it is invoked.** From the official documentation
  (`docs/src/gui/qtvcp-vcp-panels.adoc`, read 2026-08-10):
  ```ini
  [DISPLAY]
  EMBED_TAB_NAME = cam_align
  EMBED_TAB_COMMAND = halcmd loadusr -Wn qtvcp_embed qtvcp -d -c qtvcp_embed -x {XID} cam_align
  EMBED_TAB_LOCATION = ntb_preview   # needed when embedding in GMOCCAPY
  ```
  with `-o` options `size=`, `imagesize=`, `rotincr=`, `xscale=`, `yscale=`, `camnumber=`,
  `api=`, `res=`.
- 🔴 **The official description of the widget is five sentences long and mentions no
  offset, no calibration, no scale and no distortion.** Verbatim, from
  `docs/src/gui/qtvcp-widgets.adoc` (read 2026-08-10):
  > `=== CamView - Workpiece Alignment and Origin Setting Widget`
  > `//TODO CamView widget capture/example`
  > This widget *displays a image from a web camera*. It _overlays an adjustable circular
  > and cross hair target_ over the image. CamView was built with precise visual positioning
  > in mind. This is used to *align the work piece or zero part features using a webcam*. It
  > uses _OpenCV_ vision library.

  The `cam_align` panel's own doc entry is one line: *"A camera display widget for
  rotational alignment."*

### 1.3 QtPlasmaC's `CAMERA` (2021–present) — the only one that owns an offset

QtPlasmaC is the plasma-cutting screen shipped with LinuxCNC. It **reuses the same
`CamView` widget** (patched at runtime to disable mouse rotation) but wraps it in the only
offset machinery in the tree. It is the only implementation in this survey with an
**officially documented** camera-to-spindle (here: camera-to-**torch**) offset procedure.
Details in §2.2. Shipped in **2.9.0** (released 2023-10-05); the offset wizard
`lib/python/qtvcp/lib/qtplasmac/set_offsets.py` was added **2021-11-08**, commit message
*"qtplasmac: add offset setup for laser, camera, and scribe"*.

### 1.4 The `mplayer` trick — no LinuxCNC code at all

Worth recording because it is what several users actually run. From
<https://forum.linuxcnc.org/21-axis/45407-camview> (read 2026-08-10), `strahlensauger`,
21 Mar 2022, after *"a lot of trouble getting camview to work"*:

```ini
[DISPLAY]
EMBED_TAB_NAME = Camera
EMBED_TAB_LOCATION = ntb_preview
EMBED_TAB_COMMAND = mplayer -wid {XID} tv://0 -vf rectangle=-1:2:-1:240,rectangle=2:-1:320:-1
```

The crosshair is two `mplayer` `rectangle` video filters. He reports it *"Worked in 2.7,
2.8 and 2.9 under buster and bullseye... way easier than camview."* **This is evidence of
what one user did**, not a recommendation — and note the crosshair position is two
hard-coded pixel constants, so it, too, is centred by hand and not by a calibration.

---

## 2. 🔴 The camera-to-spindle offset — the question that matters

### 2.1 What the code does: nothing

Established at the artefact, not inferred.

- The `CamView` widget draws the crosshair at `(width//2, height//2)` (§1.2). No offset.
- The widget exports **one** HAL pin, `cam-rotation`. It exports **no** position, no
  offset, no pixel scale.
- `cam_align_handler.py` (175 lines, read 2026-08-10) persists exactly three values to the
  preferences file: crosshair **diameter**, crosshair **rotation**, and **zoom**. There is
  no offset key, and the handler contains no MDI call, no G-code and no motion.
- There is **no pixel-to-millimetre scale anywhere in the widget.** `scaleX`/`scaleY` are
  percentages used for aspect correction and, when negative, image flip — the official
  QTdragon documentation says so plainly: *"Scales are in percent, usually the range will be
  100 - 200 in one axis. Negating these scales can be used to flip the image in X, Y or both
  axes."* (`docs/src/gui/qtdragon.adoc`, read 2026-08-10.) **They are not mm/px and cannot
  be used as such.**

⇒ **In the stock `cam_align` panel, the offset does not exist as a concept.** The panel
shows you a picture with a cross on it. Everything else is the operator's problem.

### 2.2 The one officially documented procedure — QtPlasmaC §15.2

Primary source: the LinuxCNC stable manual, *QtPlasmaC*, §15.2 *"Peripheral Offsets (Laser,
Camera, Scribe, Offset Probe)"*, <https://linuxcnc.org/docs/stable/html/plasma/qtplasmac.html>,
read 2026-08-10. Reproduced close to verbatim:

1. Place a piece of scrap material under the torch.
2. The machine must be **homed and idle**.
3. Open the **SETTINGS** tab.
4. Click **SET OFFSETS**, which opens the *Set Peripheral Offsets* dialog.
5. Click **X0Y0** to set the torch position to zero.
6. **Make a mark on the material** by one of: jog the torch down to pierce height and pulse
   the torch on to make a dimple; or put marking dye on the torch shield and jog down to
   mark the material.
7. Click the button for the peripheral (here, CAMERA). The *Get Peripheral Offsets* dialog
   appears. If more than one camera exists, a camera-selection dialog shows first.
8. Raise Z so torch and peripheral are clear of the material.
9. **Jog X/Y so that the peripheral is centred in the mark made by the torch.**
10. Click **GET OFFSETS**; a confirmation dialog opens.
11. Click **SET OFFSETS**; the offsets are saved. *"By following the above procedure the
    offsets are available for use immediately and no restart of LinuxCNC is required."*

**Where the result is stored.** Not in G-code, not in the tool table, not in the INI — in
the **screen's preferences file**. Manual: *"To modify the offsets manually, the user could
edit either or both the following axes options in the `[CAMERA_OFFSET]` section of the
`<machine_name>.prefs` file"*:

```ini
[CAMERA_OFFSET]
X axis = n.n
Y axis = n.n
Camera port = 0
```

*"where `n.n` is distance from the center line of the torch to the camera's cross hairs."*

**What the code actually captures**, read at
`lib/python/qtvcp/lib/qtplasmac/set_offsets.py` (2026-08-10) — the whole measurement is
two DRO reads:

```python
P.camOffsetX = round(STATUS.get_position()[1][0], 4) + 0
P.camOffsetY = round(STATUS.get_position()[1][1], 4) + 0
prefs.putpref('X axis', P.camOffsetX, float, 'CAMERA_OFFSET')
prefs.putpref('Y axis', P.camOffsetY, float, 'CAMERA_OFFSET')
```

`STATUS.get_position()[1]` is the **relative (work) position**, which is why step 5 zeroes
it first. **No image is looked at. No vision runs. The camera is a viewfinder and the
machine's own encoders do the measuring.**

**How the offset is applied**, read at
`share/qtvcp/screens/qtplasmac/qtplasmac_handler.py`, `sheet_align()` (2026-08-10) — and
this is the part worth stealing:

```python
ACTION.CALL_MDI_WAIT(f'G10 L20 P0 X{offsetX} Y{offsetY}')
ACTION.CALL_MDI_WAIT(f'G10 L2 P0 R{zAngle}')
ACTION.CALL_MDI('G0 X0 Y0')
```

- **`G10 L20 P0 X… Y…`** sets the *current* work coordinate system (`P0` = the active one)
  so that the machine's present position — the position at which the **camera** crosshair
  sits on the feature — *reads as the camera offset*. That places the origin where the
  **torch** would be. One line, no arithmetic in the host.
- **`G10 L2 P0 R…`** applies the work-system **XY rotation**.
- The final `G0 X0 Y0` walks the torch to the new origin, which is also the operator's
  confirmation that it worked.

**The rotation is derived from two crosshair placements, not from the image.** Manual §9.12:
jog the crosshair to a point on the material edge, press **MARK EDGE**; jog the crosshair to
the origin point, press **SET ORIGIN**. The handler takes the difference of the two DRO
readings and computes `math.degrees(math.atan(yDiff / xDiff))` with quadrant fix-ups. Again:
**no pixels are analysed.**

Also note the guard, which is a small piece of good engineering worth copying: before
starting, `cam_mark_clicked()` computes where the *torch* would be
(`position − camOffset`) and refuses with *"Camera is outside the machine boundary"* if
that lands outside the soft limits.

### 2.3 QTdragon — two numbers, and no documented way to get them

QTdragon is the mill screen. Read at `share/qtvcp/screens/qtdragon/qtdragon_handler.py`
and `docs/src/gui/qtdragon.adoc`, 2026-08-10.

- The Settings tab has **`Camera X` and `Camera Y` line edits**, persisted to
  `[CUSTOM_FORM_ENTRIES]` in the preferences file, **defaulting to `10` and `10`**.
- Pressing the camera-reference button runs, verbatim:
  ```python
  command = "G10 L20 P0 X{:3.4f} Y{:3.4f}".format(x, y)
  ACTION.CALL_MDI(command, mode_return=True)
  ```
  — the same `G10 L20` mechanism as QtPlasmaC.
- 🔴 **The QTdragon documentation does not say how to obtain those two numbers.** The camera
  tab section documents the OpenCV backend, resolution, camera index and the aspect/flip
  scales, and the Settings tab section says only that it *"is used to set running options,
  probing/touchplate/laser/camera offsets"*. **The measurement procedure is absent.** On a
  mill — the case closest to ours — the offset is two typed numbers with no documented
  provenance.

### 2.4 The forum procedures — four of them, and they disagree

These are **evidence of what users do**. None is authoritative.

**(a) Bore a hole and move it under the camera** — `cgc` (Frank),
<https://forum.linuxcnc.org/show-your-stuff/30006-spindle-cam>, post **#66665, 09 Dec 2015
06:29**, read 2026-08-10, verbatim:

> *"I have a constant offset between camera and tool center. To measure this offset, bore a
> small hole with the spindle, then zero the axis, then move this hole under the center of
> the camera. This distance is the offset."*

And, separately, the only published **pixel-scale** calibration I found anywhere:

> *"To calibrate the magnification, set the pixelsize to 1, then use a exact hole with known
> diameter, put it under the camera, make a circle and count the pixel diameter of this
> circle. Now divide the real diameter through this number of pixels."*

He stores the result as **hard-coded constants in his own Python script** and emits an
*incremental* move:

```python
#EDIT: mm/pixel
pixelsize = 6.6 / 184
#EDIT: offset center camera to center tool
Xoffset = 100
Yoffset = 10
...
print "G21 G91 G40 G17"
print "G0 X"+str(((X-(width/2))*pixelsize)+Xoffset)+" Y"+str((((height/2)-Y)*pixelsize)+Yoffset)
```

⚠ Note what this is: **not `camview`**. It is a standalone Tkinter + OpenCV script with its
own `HoughCircles` auto-detection, run from LinuxCNC's "open file". It is the closest thing
in this survey to automated feature-finding, and it is one hobbyist's 130-line program from
2015. Note also his distortion answer is **optical, not computational**: *"I use a
telecentric microskop objectiv with long working distance, small deep of sharp and low
distortion."*

**(b) Put the camera in the tool table and load it with `M61`** — `andypugh` (LinuxCNC
moderator), <https://forum.linuxcnc.org/10-advanced-configuration/37903-how-to-practically-use-camera-offset>,
post **#151787, 02 Dec 2019 23:50**, read 2026-08-10:

> *"I imagine that your auto tool length measurement is a G-code remap? In that case just
> add some code to that which returns without a measurement of the tool number = 99 (or
> whatever). Alternatively load the camera "tool" with the M61 command."*

**(c) Calibrate it with an edge finder, once** — `andypugh` again,
<https://web.archive.org/web/20250426003104/https://forum.linuxcnc.org/21-axis/8194-webcam-lens-position-tolerances>,
post **#8255, 29 Mar 2011 12:51**, read 2026-08-10:

> *"Use a camera-tool-offset in X or Y to allow for the offset. (You would need to calibrate
> the offset with a conventional edge-finder, feller gauges or whatever, but only once)"*

**(d) Mark a spot, jog the pointer over it, and bake it into a macro** — `rodw`, same
thread as (b), post **#151513, 29 Nov 2019 17:41**, describing a laser crosshair rather
than a camera but the identical geometry:

> *"I touchedoff at X=0, Y=0 and made a single spot with the plasma cutter. Then I jogged
> the machine so the laser was over that spot and read the XY coordinates. Then I wrote a
> Gmocappy macro that moves the torch from it present position to the laser position and
> execute a XY touchoff."*

**And one that is a calibration for a spindle-mounted camera only** — `andypugh`,
**#8198, 28 Mar 2011 12:35**:

> *"Is the camera mounted in the spindle? If so, then the pixel that doesn't move when you
> turn the spindle back and forth (by hand) is the one aligned exactly with the axis. That
> will always be true, regardless of how the lens moves."*

This is a genuinely different idea from all the others: it finds the **optical centre of
rotation** rather than the offset, and it is robust to the lens sitting crooked in its
mount. It only works if the camera goes *in the spindle*, which means swapping it for the
cutter.

### 2.5 What the sources agree and disagree about

**Agreed by every source:**
- The offset is measured **once**, by a human, using **the machine's own axes** as the
  ruler. Nothing in any implementation derives it from an image.
- The measurement is: **make a physical mark with the tool at a known machine position →
  move the camera crosshair onto that mark → the axis travel is the offset.** QtPlasmaC's
  official wizard and `cgc`'s 2015 forum post are the same procedure, one automated into a
  dialog and one done by eye.
- The offset is **X and Y only**. No source treats it as a 3-vector.

**Disagreed — and this is the honest answer to "how is it stored":**

| Where the offset lives | Source | Applied as |
|---|---|---|
| Screen preferences file, `[CAMERA_OFFSET]` | QtPlasmaC manual §9.12 + `set_offsets.py` | `G10 L20 P0 X.. Y..` (+ `G10 L2 P0 R..`) |
| Screen preferences file, `[CUSTOM_FORM_ENTRIES]` | QTdragon `qtdragon_handler.py` | `G10 L20 P0 X.. Y..` |
| The **tool table**, as a camera "tool" loaded with `M61` | `andypugh`, forum, 2019 | normal tool offset |
| Constants in the user's own script | `cgc`, forum, 2015 | incremental `G91 G0 X.. Y..` |
| A hand-written GUI macro | `rodw`, forum, 2019 | a move plus a touch-off |

🔴 **There is no LinuxCNC-wide answer.** The 2019 thread that asked exactly this question —
*"I can find the offsets in x and y but I cannot think of a way to enter these in to my
system or gcode"* — received three incompatible suggestions and **died with no accepted
answer**. That is the state of the documentation for a general mill. The only place the
question is settled is **inside QtPlasmaC**, where one screen owns the whole loop.

### 2.6 The error terms none of these procedures removes

Named because they are the reason the offset dominates, and because they are properties of
the *mounting*, which no software can see.

- **The offset changes with Z if the camera's optical axis is not parallel to the spindle
  axis.** `0xfred`, comment on
  <https://hackaday.com/2015/03/16/microscope-camera-for-zeroing-cnc-machines/>, 18 Mar 2015
  (read 2026-08-10): *"you need to be sure you can have a fixed, repeatable known offset
  between the camera and the spindle. I'd recommend some grub screws to help align the camera
  exactly parallel with the spindle otherwise this will vary with Z height. These cameras
  don't necessarily have the optics exactly aligned with the outside casing."* **A single
  X/Y pair is only valid at one Z**, and no implementation surveyed records the Z at which
  the offset was taken.
- **The lens moves in its own mount.** `turbospeedskater`, 28 Mar 2011,
  archived thread above: *"if I touch the lens (or the machine vibrates during work), the
  lens is moving inside the lens-mount, and the picture is jumping for about 5-10% of the
  picture resolution. So it is impossible to use the camera for adjusting the machine to
  holes or material edges."* He reports disassembling several cameras and gluing the sensor
  boards down; the residual movement was the lens thread. The community fix is **glue** —
  hot glue or superglue on the focus ring after focusing.
- **A camera that is removed and re-fitted loses the offset.** This is why `0xfred` and
  `cgc` both chose *fixed* mounts, and why `andypugh`'s spindle-mounted variant needs the
  rotation trick (§2.4) instead of a stored number.
- **Thermal.** `Brian Neeley`, Hackaday comment 18 Mar 2015: *"You wouldn't be able to get
  micron-level accuracy because of differing coefficients of thermal expansion"* — an
  opinion, but a correctly-aimed one for a 3D-printed mount.

---

## 3. Lens distortion — it is not corrected, and this is measured

**LinuxCNC master does not correct lens distortion anywhere.** Verified by code search
against the repository (`gh api search/code`, run 2026-08-10), with a control to prove the
search was working:

| Term | Hits in `LinuxCNC/linuxcnc` |
|---|---|
| `camview` (control — must be non-zero) | **49** |
| `HoughCircles` (control — the dead code in §1.2) | **1** |
| `undistort` | **0** |
| `calibrateCamera` | **0** |
| `distCoeffs` | **0** |
| `getOptimalNewCameraMatrix` | **0** |

The widget imports OpenCV and uses it for `VideoCapture`, `resize`, `flip`, `cvtColor` and
`imwrite` — **capture and presentation only**. No camera matrix is ever built, so there is
nothing to undistort with.

CamUnits, the older stack, has no distortion plugin either: its plugin tree is
`convert/` (colourspace, JPEG, Bayer), `dc1394/`, `v4l/`, `v4l2/` and `other/` (a GL
filter, example and logging units) — listed at
<https://api.github.com/repos/ashuang/camunits/contents/plugins>, read 2026-08-10.

**What users do instead — three answers, all hardware:**

1. **Buy the distortion away.** `cgc`, 2015: *"I use a telecentric microskop objectiv with
   long working distance, small deep of sharp and low distortion."* A telecentric lens
   makes magnification independent of object distance, which removes both the distortion
   *and* the parallax/Z-sensitivity problem in one purchase.
2. **Ignore it, because you only use the middle.** This is the implicit answer in every
   crosshair implementation: the crosshair is at the image centre, and **radial distortion
   is zero at the centre by construction**. A user who jogs a feature to the exact centre of
   the frame never leaves the region where distortion is negligible. ⚠ This is a real
   engineering answer, and it is the reason the whole technique survives without
   calibration — **but it stops being true the moment you try to *measure* an offset from
   a feature that is not at the centre**, which is exactly what an automated version would
   do.
3. **Get closer with more magnification**, so the field of view is a few millimetres and
   the distorted periphery is off-screen. This is what the "USB microscope / endoscope"
   choice is really buying.

---

## 4. 🔴 The licence, per component

**`2bee.app` is AGPL-3.0-or-later.** The distinction that decides everything:
**GPL-2.0-*only* cannot be combined with AGPLv3; GPL-2.0-*or-later* can be taken forward to
v3 and then combined.** So the project-level statement "LinuxCNC is GPLv2" is not an answer
— it must be resolved **per file**. It was, below, by reading headers.

### What `COPYING` says, and why it does not decide

`https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/COPYING` (read 2026-08-10) is
the **plain GPL version 2 text, 339 lines**. The phrase *"either version 2 of the License,
or (at your option) any later version"* appears in it exactly once — at line 298, **inside
the "How to Apply These Terms to Your New Programs" appendix**, which is boilerplate
present in every copy of the GPLv2 and is not a statement about LinuxCNC. ⚠ **Reading
`COPYING` alone tells you nothing about whether LinuxCNC is v2-only or v2-or-later.** This
is the trap the question was designed around.

### What the machine-readable manifest says

`debian/copyright` (DEP-5 format, read 2026-08-10) is the project's own per-path licence
map:

- **`Files: *` → `License: GPL-2+`**, whose text stanza reads *"either version 2 of the
  License, or (at your option) any later version."* This is the default for the tree.
- **A large carve-out is `GPL-2` (v2-only)**, and it is the load-bearing part of the
  system: `src/emc/rs274ngc/*` (the G-code interpreter), `src/emc/motion/*`,
  `src/emc/kinematics/*`, `src/emc/task/*`, `src/emc/tp/*`, `src/emc/nml_intf/*`,
  **`src/emc/usr_intf/*` (which contains AXIS and the qtvcp launcher)**, `src/hal/hal.h`,
  `src/hal/utils/*` and many HAL drivers.
- Other carve-outs exist and are real: `lib/python/qtvcp/widgets/stylesheeteditor.py` and
  `nurbs_editor.py` are **BSD-3-Clause**; `src/rtapi/*` is **LGPL-2.1+**;
  `src/emc/tp/cruckig/*` is **Expat**.

### Per component, with the verdict

| Component | Path | Licence evidence | Can we copy it into an AGPL-3.0-or-later work? |
|---|---|---|---|
| **`CamView` widget** — the crosshair, the OpenCV capture | `lib/python/qtvcp/widgets/camview_widget.py` | **Explicit file header**: `Copyright (c) 2017 Chris Morley` … *"either version 2 of the License, or (at your option) any later version"*. Also falls under `Files: *` = GPL-2+. **Two independent sources agree.** | ✅ **Yes — GPL-2.0-or-later.** Take the copy forward to GPLv3, then combine. This is the file that actually matters. |
| **`cam_align` panel handler** | `share/qtvcp/panels/cam_align/cam_align_handler.py` | ⚠ **No copyright line and no licence header at all.** Covered only by `Files: *` = GPL-2+. | ✅ Yes on the project declaration — but note the file itself asserts nothing. There is nothing worth copying in it anyway (§2.1). |
| **`cam_align.ui`** | same directory | Qt Designer XML, no header. `Files: *` = GPL-2+. | ✅ Yes, same basis. Not useful — it is a Qt layout. |
| **QtPlasmaC offset wizard** — the procedure in code | `lib/python/qtvcp/lib/qtplasmac/set_offsets.py` | **Explicit header**: `Copyright (C) 2020 - 2024 Phillip A Carter` / `Gregory D Carl`, *"either version 2 of the License, or (at your option) any later version"*. | ✅ **Yes — GPL-2.0-or-later.** |
| **QtPlasmaC screen handler** — `sheet_align`, the `G10` calls | `share/qtvcp/screens/qtplasmac/qtplasmac_handler.py` | **Explicit header**, same or-later wording, `Copyright (C) 2020-2025 Phillip A Carter` / `2020-2026 Gregory D Carl`. | ✅ **Yes — GPL-2.0-or-later.** |
| **AXIS, the qtvcp launcher, the G-code interpreter, motion, task, HAL** | `src/emc/usr_intf/*`, `src/emc/rs274ngc/*`, `src/emc/motion/*`, `src/hal/*` | `debian/copyright` → **`License: GPL-2`**, v2-**only**. | 🔴 **No.** GPLv2-only is incompatible with AGPLv3. **We could not copy these even if we wanted to** — and we have no reason to. |
| **CamUnits** (the old stack's engine) | `github.com/ashuang/camunits` | `COPYING` = **LGPL-2.1** text; `camunits.spec.in` says `License: LGPL`. ⚠ **No per-file headers** — `camunits/unit.c`, `camunits/pixels.c`, `camview/camview.c` and `camunits-gtk/unit_control_widget.c` all begin at `#include` with no notice (read 2026-08-10). So "2.1-only" vs "2.1-or-later" is **not stated anywhere**. | ⚠ **Probably yes, by a different route.** LGPL-2.1 **§3** permits relicensing a given copy to *"the ordinary GNU General Public License, version 2"* and adds: *"(If a newer version than version 2 of the ordinary General Public License has appeared, then you can specify that version instead if you wish.)"* — i.e. a copy may be taken to **GPLv3**, and thence combined with AGPLv3. **This is a licence-lawyer conclusion, not a header reading — route it to `legal` before relying on it.** Moot in practice: the project is dead since 2010. |
| **`camview-emc` / `cu-plugins`** (the `emc.crosshair` unit) | `psha.org.ru/cgit/psha/cu-plugins` | 🔴 **Source unreachable — 404, and the Wayback capture has no tree (§0.1).** The one derived copy on the LinuxCNC wiki carries **no header**. | 🔴 **Cannot establish. Do not copy.** An unreachable licence is not a permissive one. |

### ⚠ Reading for ideas is always fine

Copyright covers expression, not method. **Everything in §2 — the mark-jog-read procedure,
using `G10 L20` to set the WCS at the camera position, deriving rotation from two crosshair
placements, refusing when the tool would land outside the soft limits — is a *method*, and
methods are free to re-implement.** The licence question only binds if we **copy code**.

Given that the whole useful surface here is (a) a ~50-line drawing routine we would write
differently for a browser anyway and (b) a procedure that is not copyrightable, **the
practical answer is: read it, re-implement it, copy nothing, and the licence question never
arises.** That is also the safer answer, because it does not depend on §4's LGPL-2.1 §3
reasoning being right.

---

## 5. The neighbours

Surveyed by a second agent and **spot-checked against source by this one** where a claim was
load-bearing (noted per row). All read 2026-08-10.

### 5.1 The hobby/prosumer controls — one of ten has a verified offset

| Control | Camera? | Crosshair | Camera-to-tool offset | Automated? |
|---|---|---|---|---|
| **CNCjs** | Yes, "Webcam" widget | Yes, toggleable | 🔴 **The concept does not exist in the code** | No workflow at all |
| **gSender** (Sienci) | 🔴 **No** | — | — | — |
| **Mach3** | Yes, built-in video window since 2006 | Yes, **fixed** | 🔴 No software mechanism — you physically move the camera | No |
| **Mach4** | 🔴 **No** | — | — | — |
| **UCCNC** | Yes, camera tab | Yes, toggleable | 🔴 None documented | No |
| **Candle** (v11) | Yes (not in the common v1.2b, and not in the Candle2 fork) | Yes, **draggable with the mouse** | 🔴 Pixels only — cannot express millimetres | No |
| **OpenBuilds CONTROL** | 🔴 **No** | — | — | — |
| **Carbide Motion / Create** | 🔴 **No** | — | — | — |
| **bCNC** | Yes (OpenCV) | Yes, circle sized from the **active endmill diameter** | ✅ **Yes — the only one** | No (but see §5.3) |
| **Estlcam** | Yes ("Abnullen über Kamera") | not established | ⚠ Exists, but **vendor-undocumented** | No, on user evidence |

**CNCjs — verified at source by this agent.** `src/app/widgets/Webcam/Webcam.jsx` renders the
crosshair as two `Line`s and two `Circle`s of `diameter={20}` and `{40}`, all carrying
`className={styles.center}`, and `index.styl` defines `.center` as
`position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)`. **Pinned to the
geometric centre of the div, sized in CSS pixels.** The widget's entire persisted state is
scale/rotation/flip/crosshair/mute/device — **no offset field, no calibration action, and
none of its actions talk to the controller.** The crosshair is decoration.

**Mach3 — the interesting negative.** The video window with a crosshair has shipped since
`Sept 28/06 RC2.0e` (*"Video windows ticks on crosshair"*, official changelist), but it is
**entirely undocumented**: three official Mach3 PDFs (Install/Config 3,801 lines; Mill
manual 7,643 lines; Macro reference 5,858 lines) contain **zero** camera or video-window
content. Users' answer to the offset, from the MachSupport forum, is to **align the camera
to the spindle physically** and verify by *"rotating the spindle 180 and if it stays on the
same spot it is centered"* — the same optical-centre-of-rotation trick `andypugh` gave for
LinuxCNC in 2011 (§2.4). ⚠ The MachSupport wiki returned HTTP 500 on every page, so the
screen-designer side could not be checked.

**Estlcam — the feature is real but the procedure is not published.** Vendor confirmation is
a single archived changelog line at **v11.035**: *"Abnullen über Kamera wieder
hinzugefügt"* ("zeroing via camera re-added"). All 17 pages of the text manual contain **zero**
camera mentions, and the current manual is YouTube-only (not read). The only description of
the procedure is a user forum post describing parking a bit on a mark, zeroing, raising ~20 mm,
jogging the camera onto the same mark and **typing the coordinates into settings** — the same
two-position subtraction as everyone else. The same user adds *"No-one seems to know much
about it at all."*

### 5.2 bCNC — the one open-source implementation with a real offset, and it is better than LinuxCNC's

**Verified at source by this agent** (`bCNC/ProbePage.py`, read 2026-08-10):

```python
def registerSpindle(self):
    self.spindleX = CNC.vars["wx"];  self.spindleY = CNC.vars["wy"]

def registerCamera(self):
    self.dx.set(str(self.spindleX - CNC.vars["wx"]))
    self.dy.set(str(self.spindleY - CNC.vars["wy"]))
    self.z.set(str(CNC.vars["wz"]))
```

The documented procedure (<https://github.com/vlachoudis/bCNC/wiki/Probe-Camera-Alignment>)
is: drill a 1–2 mm hole in scrap, raise to a safe height — *"All calibration and motion of
the camera will be performed with this height"* — click **Register 1.Spindle**, jog the
camera to centre the hole, click **Register 2.Camera**. **The offset is the difference
between two positions a human parked at.** Identical in shape to QtPlasmaC's wizard and to
`cgc`'s 2015 forum method.

🔴 **Two things bCNC does that nothing in the LinuxCNC tree does, and both matter to us:**

1. **It records the Z at which the offset was taken, and then drives back to it.**
   `switchCommand()` emits `G92X{dx+wx}Y{dy+wy}` to move to the camera and — critically —
   `G0X{wx}Y{wy}Z{z}` using the stored calibration Z, with `cameraZ = None` documented as
   *"if None it will not make any Z movement for the camera"*. **This is the direct fix for
   the Z-dependence error term in §2.6**, and it is the single best idea found in the whole
   survey.
2. **The offset is applied as a temporary `G92`, reverted with `G92.1`** — a *mode* you
   switch into and out of, rather than a permanent change to the work coordinate system.
   Different trade-off from QtPlasmaC's `G10 L20`: reversible, but it clobbers G92 for the
   duration.

Its crosshair circle is sized from the **active endmill diameter**, which is a small, cheap,
genuinely useful idea — the operator sees the cutter's footprint, not an arbitrary ring.

⚠ **No lens-distortion correction.** `Camera.py` uses `cv.warpAffine` for rotation/centring
only; there is no `undistort`. The wiki itself admits *"Focusing at small distances the
camera distorts a lot the image like a fish eye lens"* and offers no software answer.

### 5.3 🔴 The same dead-automation-code pattern appears twice, independently

This is the strongest cross-cutting finding in the survey, and it was found in two unrelated
codebases by two different routes.

- **LinuxCNC's `camview_widget.py`** contains `cv2.HoughCircles` circle detection and a
  `SimpleBlobDetector` blob finder. **Neither is called from any live path** (§1.2).
- **bCNC's `Camera.py`** contains `getCenterTemplate(r)` and `matchTemplate()`
  (`cv.matchTemplate`, `TM_CCOEFF_NORMED`, returning a `(dx,dy)` from the frame centre), with
  wrappers `cameraMakeTemplate` / `cameraMatchTemplate` in `CNCCanvas.py` commented
  *"Crop center of camera and search it in subsequent movements"*. **Verified by this agent
  via repository code search: `cameraMatchTemplate` and `cameraMakeTemplate` each occur in
  exactly one file — their own definition. There is no UI caller, no button, no binding.**

⇒ **Two independent authors built the automatic-registration machinery, and neither wired it
to a button.** That is not a coincidence about laziness. The plausible reading — and it is a
reading, not a measurement — is that the automated version *works in a demo and does not
survive real fixtures, real lighting and real swarf*, so the human stayed in the loop. ⚠ **A
reader who greps either codebase for "OpenCV" will conclude these tools do automatic feature
detection. Both would be wrong.**

### 5.4 The commercial CCD/registration systems — a different problem, solved properly

**First, a correction to a common assumption: three of the four sign-industry plotter vendors
do not use cameras at all.**

- **Graphtec (ARMS)** — a **point photosensor**, not a camera. The CE7000 manual never uses
  "camera", "CCD" or "image"; marks are found by **sweeping a two-stage ~100 mm search box**,
  which an imager with a field of view would not need. Its sensor-to-blade offset is measured
  by a **human with a ruler**: plot an adjustment mark, let the machine plot a comparison
  mark, *"measure the distance of how much the adjustment registration mark needs to be moved
  so both will overlap"*, and key X/Y in — **range −3.0 to +3.0 mm**. Stated accuracy
  *"within 0.3 mm"* (**manufacturer spec**).
- **Roland (AAS)** — also a sensor (error strings include *"AAS ADC Value Error"*). Offset is
  fully human: the machine cuts lines over printed lines, you **measure the shift, type it,
  and iterate**.
- **Mimaki (CG-series MARK sensor)** — a sensor with an **LED aiming pointer**. Its offset
  procedure is a nice middle path: the machine **cuts a vernier — a centre line plus five
  lines at 0.2 mm pitch each side** — and the operator reads off which line coincides. Human
  judgement, but **quantised against a machine-cut scale**.
- **Summa** — the one plotter vendor with a real camera, and it says so itself: a sensor
  *"measure[s] a level of contrast"*; a camera *"takes a picture of the registration marks"*.

🔴 **The important split is not sensor-vs-camera. It is whether the calibration loop is
closed.**

| Loop | Who | How the tool offset is found |
|---|---|---|
| **Open — human measures, human types** | Graphtec, Roland, and every hobby CNC in §5.1–5.2 | measure a discrepancy with an eye or a ruler, key it in, maybe iterate |
| **Quantised human** | Mimaki | machine cuts a 0.2 mm vernier; human reads which line lines up |
| ✅ **Closed — the machine cuts, looks at what it cut, and solves** | **Summa OPOS CAM**, **Thunder Laser Titan** | Summa: cut a 30×30 mm square with a 3×3 mm island, **weed the waste by hand**, and *"the OPOS-camera will read the position of the small rectangle and calibrate itself accordingly"*. Thunder Laser: print a fiducial board, scan the **full field of view** to *"map the camera's scale and geometric relations to the machine"*, ~14 min in two stages. |

**The closed-loop version is categorically better and the reason is worth stating plainly:
it observes what the *tool actually did*, so it captures the whole error chain — mounting
offset, lens centre, backlash, knife deflection — rather than a nominal mounting dimension.**
Every hobby implementation, including bCNC and QtPlasmaC, measures the *nominal* offset and
therefore cannot see any of the rest.

**And the transform is usually richer than translate+rotate.** Graphtec's 4POINTS explicitly
adds *"2 axes warp adjustment"*, applied per segment on long media. Summa exposes a five-mode
ladder and pointedly restricts classic OPOS marks to **rigid** `Cut to shape`, unlocking
node-adding distortion-following only on the camera path. Trotec's JobControl Vision claims
*"all distortions – linear and non-linear – are detected"*. Golden Laser captures contours in
real time and deliberately cuts the **deformed printed shape** rather than the original
geometry — the right call for stretchy dye-sublimated textile.

**Accuracy in the commercial set: two numbers, both manufacturer specs.** Graphtec *"within
0.3 mm"*; Golden Laser *"0.3–0.5 mm"* (on a marketing page). Summa explicitly declines to give
one and offers *"both systems are similar in terms of accuracy"* — an impression. Trotec,
Mimaki, Roland, Thunder Laser, MultiCam and AXYZ state **nothing**. See §6.

**Could not be established:** Trotec's Vision calibration procedure (published **only** as
video, which was not opened); MultiCam's *"MultiVision registration camera"* and AXYZ's
*"AVS IP Vision System"* — both are **one-sentence product blurbs** with no technical
documentation reachable.

### 5.5 The answer to "does anyone automate it?"

**In the CNC/router world — no. Every single one leaves a human at the crosshair.** LinuxCNC,
CNCjs, Mach3, UCCNC, Candle, bCNC, Estlcam and QtPlasmaC all require a human to jog until the
reticle sits on a feature. Two of them contain unreachable code that would have done it
automatically (§5.3).

**In the print-and-cut / sign world — yes, completely, and it has been automatic for
decades.** But note carefully what is being automated: **finding printed fiducial marks that
the same workflow deliberately put there**, on flat sheet, under controlled lighting, with
known geometry. That is a very different problem from *"find the corner of this offcut of
plywood a human clamped down"*. **Do not read the sign industry's success as evidence that
the router case is solved** — it is evidence that the *fiducial* case is solved, and nobody
in this survey has the router case.

---

## 6. Accuracy — nobody has measured it

🔴 **This is the finding.** I looked specifically for a measurement of how accurately a
human can place a crosshair on a feature and have the tool arrive there. **There isn't one.**
Not in the LinuxCNC documentation, not in the source, not in any forum thread I could read.
What exists is claims, impressions and specifications for *other* instruments.

Every figure I found, with its class marked. **These are not averaged, and they must not be.**

| Figure | Source | Date | Class |
|---|---|---|---|
| *"zero out the mill to within a thousandth of an inch"* (≈25 µm) | Hackaday editorial summary of [Chris]'s USB-microscope + Mach3 project, <https://hackaday.com/2015/03/16/microscope-camera-for-zeroing-cnc-machines/> | 2015-03-16 | 🔴 **A journalist's paraphrase of a hobbyist's claim.** No method, no repeat count, no artefact. |
| *"It worked reasonably well, but still not good enough for tiny 0.7mm vias across the whole PCB. Not sure why but have a few ideas."* | `0xfred`, comment on the same article; his own build at <https://0xfred.wordpress.com/2014/02/13/cnc-mill-alignment-camera-version-1-0/> | 2015-03-18 | ⚠ **A first-hand impression of a failure.** More informative than the success claim above, because it names the task it failed. |
| Lens shift *"about 5-10% of the picture resolution"* when touched or vibrated | `turbospeedskater`, LinuxCNC forum #8194 | 2011-03-28 | ⚠ **An impression of an error source**, not of end accuracy. Still the most useful number here, because it bounds what the *mount* contributes. |
| Edge finder: *"A $10,- instrument. <5-10 micrometer repeatability. (Its analog)"* | `steven4601`, Hackaday comment | 2015-03-17 | ⚠ **A claim about a competing instrument**, offered as an argument that the camera is unnecessary. Consistent with typical mechanical edge-finder specifications, but unverified here. |
| *"with plasma, pinpoint accuracy is not required when setting the zero point so a 1-2mm laser dot is more than sufficient"* | `rodw`, <https://forum.linuxcnc.org/plasmac/48022-camera-setup> | 2023-01-20 | ⚠ **A statement of required tolerance, not achieved accuracy** — and it explains why QtPlasmaC, the one implementation with a real offset feature, never needed to be better. |
| *"You wouldn't be able to get micron-level accuracy because of differing coefficients of thermal expansion"* | `Brian Neeley`, Hackaday comment | 2015-03-18 | ⚠ **An opinion**, correctly aimed at a plastic mount. |
| *"accuracies of the order of tens of micrometer"* | bCNC wiki, *Probe-Camera-Alignment*, author's own claim | undated | 🔴 **An unsourced author claim.** No method, no test, no repeat count. |
| *"At 1cm I have a spatial resolution of about 20um and at 4cm around 80um"* | bCNC wiki, same page, first person about the author's own machine | undated | 🔴 **This is the ground footprint of one pixel at a given standoff — NOT achieved alignment error.** It is the most commonly misread number in this whole field: pixel resolution is a *ceiling* on what you could resolve, not a statement of what the machine hits. |
| *"Registration mark scanning accuracy … is within 0.3 mm"* | Graphtec CE7000 user's manual §5.1 | current | ✅ **A manufacturer's specification**, in a manual, for a point-sensor plotter. The most defensible figure in the table — and it is 0.3 mm, not microns. |
| Tolerance *"0.3–0.5 mm"* | Golden Laser, vision-laser marketing page | current | ⚠ **A manufacturer's specification on a marketing page**, alongside speed/acceleration marketing figures. The company's own vision page offers only *"unsurpassed accuracy"*. |
| *"both systems are similar in terms of accuracy"* (sensor vs camera) | Summa, official blog | current | ⚠ **A manufacturer's impression**, explicitly declining to give a number, based on *"experts testing this matter for years"*. |
| — | Trotec, Mimaki, Roland, Thunder Laser, MultiCam, AXYZ | — | 🔴 **State no accuracy figure at all.** Six vendors selling the feature and publishing nothing. |

⚠ **Note what the table looks like when sorted by credibility rather than by size.** The
softest numbers are the smallest (microns, from hobbyists, unsourced) and the firmest are the
largest (0.3 mm, from a manufacturer, in a manual). **Anyone quoting "microns" for this
technique is quoting the least-supported end of the evidence.**

**Two things follow, and both matter more than a number would:**

1. **The published claims and the published failures point in opposite directions and nobody
   reconciled them.** "A thousandth of an inch" and "not good enough for 0.7 mm vias" are
   both about a USB microscope on a hobby mill in 2015. At least one of them is wrong about
   what was actually achieved, and there is no experiment in the record to say which.
2. **The one implementation with an official offset feature was built for a tolerance of
   1–2 mm.** QtPlasmaC's own maintainer, `phillc54`, on being asked about cameras:
   *"TBH I think a laser crosshair is a better proposition for sheet alignment on a plasma
   table."* (<https://forum.linuxcnc.org/plasmac/48022-camera-setup>, 20 Jan 2023, read
   2026-08-10.) **The mature version of this technique is mature at plasma tolerances.** It
   has not been demonstrated at router-trim tolerances by anyone whose evidence I could read.

⚠ **If this lane ever needs an accuracy number, it will have to measure one.** There is
nothing to cite. And the measurement is cheap and obvious once a machine exists: place the
crosshair on a marked point *n* times from different approach directions, record the DRO
each time, report the spread — which separates the operator's placement repeatability from
the offset's correctness, and those are two different failures.

---

## 7. What transfers to this lane, and what does not

Our stack, stated so the mapping is checkable: a **browser** application; **no LinuxCNC, no
HAL, no INI, no preferences file, no MDI channel**; **grblHAL over Web Serial**
(`web/src/run/transport.ts`, `web/src/run/protocol.ts`); a camera that would be either a
USB webcam through `getUserMedia` or a network stream from a small SBC. Note also
`docs/bed-scan-contract.md` — an **AGREED, NOT BUILT** intake contract with `ml` for a
spindle-mounted multi-camera bed scan; that is a *different* proposal from this one and is
not evidence for it.

### 7.1 The calibration procedure — transfers essentially verbatim

**This is the part worth keeping**, because it is a method and not code, and because it
depends on nothing LinuxCNC-specific.

The procedure, restated for a grblHAL/Web Serial host:

1. Fixture scrap. Home the machine.
2. Zero the work coordinate system at the current point (`G10 L20 P1 X0 Y0`, or `G92` — but
   see §7.4 on `G10 L2` availability).
3. Make a **physical mark with the tool at that origin** — a small drilled dimple is the
   version that survives being looked at through a camera.
4. Retract Z clear.
5. Jog until the **camera crosshair sits on the mark**.
6. Read the DRO. **That reading is the offset.** Store it.

And then, in use:

7. Jog the crosshair onto the feature you want as the origin.
8. Issue `G10 L20 P<n> X<offsetX> Y<offsetY>` — the machine now believes the *tool* is at
   the origin, which is exactly what you want.

**What we would keep beyond the bare procedure, because QtPlasmaC learned it the hard way:**

- **The soft-limit guard.** Before applying, compute where the tool would be
  (`position − offset`) and **refuse** if that is outside the machine envelope, with the
  reason named. This lane already refuses rather than approximates; this is the same rule.
- **The two-point rotation.** Mark-edge then set-origin, `atan2` of the two DRO
  differences. It costs nothing, needs no vision, and it is the single feature that turns
  "find the corner" into "align to the sheet". ⚠ Use `atan2`, not QtPlasmaC's
  `atan(y/x)`-plus-quadrant-patches — their version reads as a workaround for a missing
  function.
- **The offset is only valid at one Z — record which one, and return to it.**
  ⚠ *This bullet asserted "no surveyed implementation does this" until the neighbours survey
  came back and falsified it. **bCNC does.** The claim was written from the LinuxCNC tree and
  quietly generalised to everything, which is exactly the error this lane keeps making;
  the correction is kept visible rather than deleted.* bCNC stores the calibration Z beside
  `dx`/`dy` and, on switching to the camera, commands `G0X..Y..Z<calibration z>` — it
  **drives back to the height at which the offset was valid** (§5.2). That is strictly
  better than storing it and warning, and it is the single best idea in the survey. **Take
  this one.** Note the honest limit: it makes the offset valid *by construction* at one Z
  and says nothing about any other, so it manages the error rather than removing it.
- **Size the reticle from the active cutter, not arbitrarily** (bCNC, §5.2). The operator
  should see the cutter's footprint. This lane already owns tool geometry, so it is free.
- ⚠ **Consider closing the loop, and know that nothing in the open-source world does.**
  Every hobby procedure — QtPlasmaC's, bCNC's, `cgc`'s, ours-if-we-copy-them — measures the
  **nominal** offset from a mark the tool made and a crosshair a human placed. The
  commercial closed-loop version (Summa: cut a square with an island, weed it, let the
  camera read *where the knife actually went*; §5.4) captures the whole error chain instead
  — mounting, lens centre, backlash, deflection. 🔴 **This is a genuinely better design and
  it is also strictly harder**: it needs the camera to *measure* a feature off-centre, which
  is exactly where distortion and pixel-scale stop being ignorable (§3). Recorded as the
  known ceiling on the manual approach, **not** as something to build.

### 7.2 What a crosshair overlay would cost in our stack

Small, and smaller than the prior art's, because a browser gives us for free the two things
`camview` had to build.

- **Capture:** `navigator.mediaDevices.getUserMedia({ video: … })` into a `<video>`, or an
  `<img>`/MJPEG element for a network stream. This replaces the whole `WebcamVideoStream`
  class, the OpenCV backend selection, the resolution probe and the `list_ports` scanner —
  roughly **250 of the widget's 768 lines exist only because desktop Linux camera
  enumeration is unpleasant.** The browser's device picker does that job.
- **Overlay:** an absolutely-positioned SVG or a `<canvas>` over the video, with two lines
  and a circle. **CSS `transform: rotate()` replaces the `QPainter.rotate` path entirely.**
  The zoom is `transform: scale()` with `overflow: hidden`, replacing the crop-and-rescale
  arithmetic in `zoom()`. The image flip is `scaleX(-1)`. Honest estimate: **the drawing
  and interaction are a small component, not a project.** The widget's real bulk is device
  handling we do not have to write.
- **What is *not* free:** the offset store, the guard, the `G10` emission and the state
  machine around mark-edge/set-origin. That is the part that would need designing, gating
  and a negative control — and it is the part that touches the wire, which in this lane is
  the part that gets treated as dangerous.
- ⚠ **And a browser-specific hazard the prior art never faced:** this lane already knows
  that a throttled background tab changes streaming behaviour (`transport.ts` header,
  gate branch `RUN-18`, unmeasured). A camera preview is another consumer of the same
  frame budget. **Nobody in the prior art had a UI that could be de-prioritised by the
  operating system mid-alignment.**

### 7.3 🔴 The useful part needs no ML at all

**Stated plainly because it is the answer to the question the founder's larger proposal is
gated on.**

The decade of prior art surveyed here contains, in total, **zero deployed machine learning
and zero deployed computer vision in any CNC/router alignment path.** LinuxCNC's widget
imports OpenCV and uses it as a *camera driver*; its two vision functions are dead code
(§1.2). bCNC does the same — full template matching, written and never wired to a button
(§5.3). QtPlasmaC — the most complete implementation, officially documented, shipped in a
stable release — computes its origin and its rotation **entirely from DRO readings**, with
the image serving only as the operator's eyepiece. Across ten CNC packages surveyed
(§5.1–5.2), **not one has an automated alignment path**, and **two independently built one
and left it unreachable**.

⇒ **The useful 80% of this technique is: show a video, draw a cross on it, store two
numbers, and emit one `G10` line.** No model, no NPU, no inference, no training data, no
labelled dataset, and nothing that `ml` lists as a kill criterion. It would run identically
on a machine with no accelerator at all.

**What the ML would buy, and it is the last 20%:** removing the human from step 5 — having
software find the feature and compute the offset itself. That is the automation **no CNC
package in this survey has**, and §2.6 explains why it is harder than it looks: the moment
the feature stops being at the exact image centre, lens distortion and pixel-scale stop
being ignorable, and both of those need a calibration nobody currently performs.

⚠ **And the sign industry is not the counter-example it looks like.** Print-and-cut
registration has been fully automatic for decades (§5.4) — but it automates *finding printed
fiducials that the same workflow deliberately placed*, on flat sheet, under controlled
lighting, with known geometry. **"Find the mark we printed" and "find the corner of this
offcut a human clamped down" are different problems**, and only the first one is solved
anywhere in this survey.

⚠ **The corollary is a warning, not an endorsement.** If this restarts and the manual 80%
is built first, it will work, and it will be tempting to call the job done. It also will
not, on its own, be evidence that the automated 20% is achievable — the manual version
succeeds *precisely by avoiding* every problem the automated version has to solve. **Two
authors who did try to close that gap shipped the attempt as dead code** (§5.3), which is
the most honest signal in the record about how hard the last 20% is.

### 7.4 What does not transfer

- **`G10 L2 P0 R<angle>` — work-coordinate rotation — must be verified against grblHAL
  before any rotation feature is designed.** It is an RS274NGC/LinuxCNC interpreter feature.
  🔴 **I did not verify grblHAL's support for it and I am not asserting it either way.**
  This lane's standing rule is that controller facts come from `pcb` and are verified rather
  than assumed, and this is exactly such a fact. If `R` is unsupported, the rotation must be
  applied host-side by rotating the toolpath — which is a materially different feature with
  a materially different failure mode, and it belongs to the core, not the UI. *(Compare the
  existing `supports_cutter_comp = false` decision: grblHAL has no `G41/G42`, so offsets are
  host-side. The same question, the same shape of answer.)*
- **Everything structural.** HAL pins, the INI `EMBED_TAB_COMMAND`/XEmbed mechanism, the
  `.prefs` file, `ACTION.CALL_MDI_WAIT`, `STATUS.get_position()`, the tool-table/`M61` route
  — none of these exist for us. The `G10 L20` **idea** transfers; the plumbing does not.
- **CamUnits, `camview-emc`, and anything built on them.** Dead since 2010–2012, source
  partly unreachable, licence unestablishable (§4). **There is nothing here to take.**
- **The claim that this technique is accurate.** §6. If it is ever quoted outward, it must
  be quoted as *"a decade-old manual alignment method with no published measurement"*, which
  is the true and defensible form.

---

## Sources

Every URL below was read on **2026-08-10**.

**Primary — LinuxCNC source and documentation**
- `lib/python/qtvcp/widgets/camview_widget.py` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/lib/python/qtvcp/widgets/camview_widget.py>
- `share/qtvcp/panels/cam_align/cam_align_handler.py` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/share/qtvcp/panels/cam_align/cam_align_handler.py>
- `lib/python/qtvcp/lib/qtplasmac/set_offsets.py` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/lib/python/qtvcp/lib/qtplasmac/set_offsets.py>
- `share/qtvcp/screens/qtplasmac/qtplasmac_handler.py` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/share/qtvcp/screens/qtplasmac/qtplasmac_handler.py>
- `share/qtvcp/screens/qtdragon/qtdragon_handler.py` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/share/qtvcp/screens/qtdragon/qtdragon_handler.py>
- `docs/src/gui/qtvcp-widgets.adoc` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/docs/src/gui/qtvcp-widgets.adoc>
- `docs/src/gui/qtvcp-vcp-panels.adoc` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/docs/src/gui/qtvcp-vcp-panels.adoc>
- `docs/src/gui/qtdragon.adoc` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/docs/src/gui/qtdragon.adoc>
- QtPlasmaC manual (§9.12 CAMERA, §15.2 Peripheral Offsets) — <https://linuxcnc.org/docs/stable/html/plasma/qtplasmac.html>
- `COPYING` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/COPYING>
- `debian/copyright` — <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/debian/copyright>

**Primary — CamUnits / camview-emc**
- CamUnits repository, `COPYING`, `ChangeLog`, `camunits.spec.in`, `plugins/` — <https://github.com/ashuang/camunits>
- camview-emc author page (English) — <http://psha.org.ru/b/camview-emc.html>
- camview-emc author page (Russian) — <http://psha.org.ru/b/camview-emc.ru.html>
- `camview-emc` launcher script, user-modified copy on the LinuxCNC wiki — <http://wiki.linuxcnc.org/uploads/camview-emc-f1oat.py>
- `cu-plugins` cgit summary (archived; tree not captured) — <https://web.archive.org/web/20190121023438/http://psha.org.ru/cgit/psha/cu-plugins>
- Installation notes quoting the (now unreachable) wiki page — <https://github.com/jieter/linuxcnc-config/blob/master/notes/camview.md>

**Secondary — forums and blogs (evidence of what users do, not of what is true)**
- "Spindle Cam", LinuxCNC forum — <https://forum.linuxcnc.org/show-your-stuff/30006-spindle-cam>
- "How to practically use camera offset", LinuxCNC forum — <https://forum.linuxcnc.org/10-advanced-configuration/37903-how-to-practically-use-camera-offset>
- "Webcam lens position tolerances", LinuxCNC forum (archived) — <https://web.archive.org/web/20250426003104/https://forum.linuxcnc.org/21-axis/8194-webcam-lens-position-tolerances>
- "camview" (in AXIS), LinuxCNC forum — <https://forum.linuxcnc.org/21-axis/45407-camview>
- "Camera setup", LinuxCNC PlasmaC forum — <https://forum.linuxcnc.org/plasmac/48022-camera-setup>
- "QTvcp Cam View Dialog", LinuxCNC forum — <https://forum.linuxcnc.org/qtvcp/40032-qtvcp-cam-view-dialog>
- "Microscope Camera For Zeroing CNC Machines" + comments, Hackaday — <https://hackaday.com/2015/03/16/microscope-camera-for-zeroing-cnc-machines/>
- "CNC mill alignment camera version 1.0" — <https://0xfred.wordpress.com/2014/02/13/cnc-mill-alignment-camera-version-1-0/>

**Primary — the neighbours (§5)**
- CNCjs Webcam widget source — <https://github.com/cncjs/cncjs/tree/master/src/app/widgets/Webcam> (`Webcam.jsx`, `index.styl`, `index.jsx` read directly); user guide — <https://cnc.js.org/docs/user-guide/>
- gSender source and docs — <https://github.com/Sienci-Labs/gsender>, <https://github.com/Sienci-Labs/Resources> (searched; no camera feature)
- Mach3 changelist — <https://www.machsupport.com/wp-content/uploads/2013/04/Changelist90.txt>; manuals — `Mach3Mill_Install_Config.pdf`, `Mach3Mill_1.84.pdf`, `Mach3_V3.x_Macro_Prog_Ref.pdf` (all under `machsupport.com/wp-content/uploads/2013/02/`); plugin list — <https://www.machsupport.com/downloads-updates/plugins/>
- KD-Dietz Mach Camera plugin V3 — <https://kd-dietz.com/pages/eng/plugin/webcamv3/description.html>
- Estlcam changelog (archived, v11.035 entry) — <http://web.archive.org/web/20240419061432/https://www.estlcam.de/changelog.php>; manual index — <https://www.estlcam.de/anleitung.php>
- UCCNC user manual §3.11.3 — <https://www.cncdrive.com/UCCNC/UCCNC_usersmanual.pdf>
- Candle camera help + source — <https://raw.githubusercontent.com/Denvi/Candle/master/help/en/mainwindow/windows/camera.md>, `src/designerplugins/cameraplugin/camerawidget.{h,cpp}`
- bCNC — <https://github.com/vlachoudis/bCNC/wiki/Probe-Camera-Alignment>; source `bCNC/ProbePage.py`, `bCNC/Camera.py`, `bCNC/CNCCanvas.py`
- OpenBuilds CONTROL — <https://docs.openbuilds.com/doku.php?id=docs:software:openbuilds-control>, <https://github.com/OpenBuilds/OpenBuilds-CONTROL>
- Carbide 3D — <https://carbide3d.com/carbidemotion/>, <https://carbide3d.com/carbidecreate/>, <https://my.carbide3d.com/pdf/carbide-create-v5.pdf>
- Graphtec ARMS — <https://www.graphteccorp.com/cutting/arms/>; CE7000 manual — <https://mygraphtec.jp/site_download/manual/CE7000-UM-152-ENG.pdf>
- Summa — <https://www.summa.com/en/blog/sensor-or-camera-technology-on-a-vinyl-cutter/>; OPOS CAM offset calibration — <https://support.summa.eu/support/solutions/articles/43000456255-s-class-2-opos-cam-offset-calibration->; GoSign V4 manual — <https://summawebsite.blob.core.windows.net/public-assets/User%20Manuals/gosign_4-0_en.pdf>
- Mimaki CG-AR operation manual (MARK sensor, SENSOR OFS) — <https://mimaki.com/manual/cg-ar-series/operation_manual/en-US/1017776907.html>
- Roland GR2-640 user's manual (AAS offset) — <https://downloadcenter.rolanddg.com/contents/manuals/GR2-640_USE_EN.pdf>
- Trotec JobControl Vision — <https://www.troteclaser.com/en/laser-machines/laser-software/jobcontrol-vision/>
- Thunder Laser automatic camera calibration — <https://support.thunderlaser.com/portal/en/kb/articles/automatic-camera-calibration-guide>
- Golden Laser camera registration — <https://goldenlaser.cc/camera-registration-laser-cutter/>
- MultiCam Apex1R — <https://www.multicam.com/en/cnc-routers/apex1r>; AXYZ AVS IP — <https://www.axyz.com/uk/en/cnc-routers-and-knives-features/>

**Not readable (recorded so nobody assumes I read them)**
- Trotec Vision calibration and print-cut operation — video-only pages; **not opened, not described.**
- Estlcam current manual — YouTube-only; **not opened, not described.**
- MachSupport Mach3 wiki — HTTP 500 on every page.
- forum.cncdrive.com (UCCNC user evidence) — HTTP 403.
- Stepcraft forum "Estlcam mit Kamera" — HTTP 403.
- Summa OPOS-X offset calibration article — HTTP 404.
- "Another tab for WebCam", LinuxCNC forum, ~27 pages — all URL variants 404, no Wayback capture of the paginated pages.
- `http://psha.org.ru/cgit/psha/cu-plugins` tree and file contents — 404; only the summary page is archived.
- LinuxCNC wiki `Adding_Camview` page — the wiki serves a self-signed certificate and the CGI path returns "Invalid URL"; content reached only through the third-party quotation above.
