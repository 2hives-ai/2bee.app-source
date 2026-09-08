# Hungarofest 2027 — terraced relief plaque of Hungary

**Session:** `2bee_app` · **Date:** 2026-09-04 · **Status:** geometry produced and
measured; **nothing cut, nothing simulated, no G-code emitted**

Artefacts: [`hungarofest-2027/`](hungarofest-2027/) — pipeline
`build_relief_dxf.py`, 14 DXF in `dxf/`, `build-report.json`, `preview/`.

🔴 **This lane has never cut anything.** No claim below has been checked against a
physical part. The air-cut → foam/MDF coupon → real-ply rungs are unclimbed. What was
verified is *geometry and intake*, and each section says which.

---

## 0. The three constraints this design was built to

Restated from `AGENTS.md`, because a design note that omits them invites the next reader
to "improve" the design straight through one of them.

1. **2.5D subtractive CNC ONLY.** No Z-level roughing, no waterline, no scallop, no
   ball-nose stepover — deliberate, and *"this is not a step towards them"*. **A smooth
   relief (continuously varying Z) cannot be cut by this toolchain.** ⇒ the model is
   **terraced**: 6 discrete elevation bands, each a closed 2D outline pocketed to one
   fixed depth.
2. **STL is WRONG for the cutting path.** `core/src/mesh.rs` **sections a mesh at ONE Z**
   and hands one flat outline downstream. A relief STL would post, simulate and gate
   **green** while producing a *plausible-looking wrong part*, because every contour
   downstream is a real contour of a real solid. ⇒ **DXF, one closed-polyline set per
   elevation band.**
3. **`text()` is REFUSED by the mesh kernel** — it renders no glyphs. ⇒ "Hungarofest 2027"
   is converted from a font to **closed outlines before the DXF is written**. The DXF
   contains **no `TEXT`/`MTEXT` entity** — verified below.

---

## 1. Elevation data — source, licence, and what was actually fetched

### 1.1 Repo first

The monorepo already runs a geo pipeline (`scripts/geo/`, catalogue
`scripts/geo/geo-data-status.md`). It lists a **Copernicus DEM 30 m global archive,
102 GB / 3491 tiles**, at `global/terrain/copernicus_dem_30m/`, mirrored on
`/mnt/A41A07C21A07908A/2bee-farm-geo/`.

**All 28 tiles covering Hungary (N45–N48 × E016–E022) were already present locally.**
No DEM download was needed. *(Network was up — `github.com` 200, `copernicus-dem-30m.s3`
200, `portal.opentopography.org` 302 — so this was a convenience, not a constraint.)*

| Fact | Value |
|---|---|
| Dataset | **Copernicus DEM GLO-30** (Copernicus WorldDEM-30), TanDEM-X derived |
| Resolution | 1 arcsec ≈ **30 m** |
| Type | 🔴 **DSM — a *surface* model** (canopy + buildings), not a bare-earth DTM |
| Local path | `/mnt/A41A07C21A07908A/2bee-farm-geo/global/terrain/copernicus_dem_30m/` |
| Canonical URL | `s3://copernicus-dem-30m/<TILE>/<TILE>.tif` (AWS Open Data, `eu-central-1`) |
| Tile naming | `Copernicus_DSM_COG_10_N47_00_E019_00_DEM` |
| Registry | https://registry.opendata.aws/copernicus-dem/ |

### 1.2 Licence — read from the licence text, not from a summary

*Licence for Copernicus DEM instance **COP-DEM-GLO-30-F Global 30m Full, Free & Open***
(licence PDF, Articles 3–7 read directly).

- **Art. 4** grants reproduction, distribution, communication to the public, **and
  adaptation/modification**. **Art. 5**: free of charge. **Art. 3**: worldwide, unlimited
  in time.
- ⚠ **There is no non-commercial clause** — commercial use is not restricted by this
  licence. Stated because it is the question a festival plaque raises, and because the
  absence of a restriction is a fact worth citing rather than assuming.
- **Art. 6(b)** — required notice for **modified** data (we modify it), verbatim:

  > "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and
  > Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all
  > rights reserved".

- **Art. 6(c)** also requires: *"The organisations in charge of the Copernicus programme
  by law or by delegation do not incur any liability for any use of the Copernicus
  WorldDEM-30"*. **Art. 6(d)**: must not imply endorsement.

⇒ **Both notices must appear wherever the plaque is shown or sold.** Outward copy is
`brand`/`sales`' call, not this lane's — this note supplies the wording, not the placement.

**National boundary:** Natural Earth **10 m admin-0** (`ne_10m_admin_0_countries`,
`ADM0_A3='HUN'`), downloaded from `https://naciscdn.org/naturalearth/10m/cultural/`.
Natural Earth is **public domain**, no attribution required. Extent measured
16.094 – 22.878 E, 45.741 – 48.569 N. At 1:1 M its vertex spacing is finer than the
cutter, so it is over-resolved rather than limiting.

### 1.3 Hungary's real elevation range — MEASURED, and two artefacts found

Clipped to the Hungary polygon, reprojected to **EPSG:23700 (HD72 / EOV)**, 30 m,
**103,555,877 valid pixels = 93,200 km²** (Hungary is 93,030 km² — a 0.2 % boundary-
generalisation difference).

| Statistic | Value |
|---|---|
| Raw min / max | **26.23 m / 1032.09 m** |
| Mean / median | 150.08 m / 122.09 m |
| 0.01 / 50 / 99.99 pct | 73.55 m / 122.09 m / 911.86 m |
| **below 150 m** | **66.59 % of area** |
| **below 200 m** | **81.97 % of area** |
| below 300 / 400 / 500 m | 94.60 % / 97.81 % / 99.17 % |

🔴 **Neither raw extreme is terrain, and both were traced to source:**

- **min 26.23 m** at 47.7339 N, 20.0590 E. Only **2.6 km² (0.0028 %)** lies below 60 m,
  in two clusters: 47.73/20.06 and 47.88/20.72 — the **Visonta** and **Bükkábrány**
  open-cast lignite pits (Mátra Power Plant). **Excavation, not landscape.** The 0.01th
  percentile is already 73.55 m.
- **max 1032.09 m** at 47.8722 N, 20.0103 E — **exactly Kékes summit** (47.8722, 20.0103),
  surveyed at **1014 m**. The +18 m is the **DSM reading the summit structures/canopy**,
  not the ground. Only 290 px (26 ha) exceed 1000 m.

**Published extremes** (Wikipedia, *Geography of Hungary*): highest **Kékes 1014 m**;
lowest **Gyálarét, Szeged, 78 m**; *"Most of the country has an elevation of less than
200 m"*, mountains ≥300 m *"cover less than 2% of the country"* — the DEM measures 5.4 %
above 300 m (a DSM-vs-DTM and definitional difference; not reconciled, and not load-bearing here).

⇒ **The model is clamped to [76 m, 1014 m]** before banding. Declared, not silent: without
it the mine pits become spurious deepest-band islands inside the Mátra foothills, and the
Kékes tower inflates the top band.

---

## 2. The plaque — numbers

| Parameter | Value | Why |
|---|---|---|
| Plaque blank | **570 × 420 mm** | map 511.25 × 316.0 + 29.4 mm side margins + text band |
| Map field | **511.25 × 316.0 mm** | Hungary's EOV bbox 511.2 × 316.0 km |
| **Map scale** | **1 : 1,000,000** | round and checkable: **1 mm = 1 km** |
| Projection | **EPSG:23700 HD72 / EOV** | Hungary's national grid — the shape Hungarians recognise |
| Bands | **6** | driven by ledge width, §3 |
| **Step per band** | **1.5 mm** | = `max_doc_ratio` 0.50 × Ø3 ⇒ **one full-depth pass** for the finisher |
| **Total relief** | **7.5 mm** | 5 steps |
| Stock | **18 mm** ply/MDF | leaves a **10.5 mm** floor under the deepest terrace |
| Detail cutter | **Ø3.0 mm** flat | 3 mm = 3 km at this scale |
| Rough cutter | **Ø6.0 mm** flat | `max_doc_ratio` 0.50 ⇒ 3 mm/pass = 2 terraces per pass |
| Title | "Hungarofest 2027", cap **38 mm**, DejaVu Sans Bold | outlines, §5 |

**Band table (all figures MEASURED from the built geometry, `build-report.json`):**

| # | range (m) | depth (mm) | area % | ledge width (mm) | pocket Ø3 reach % | pocket Ø6 reach % | local V-exag |
|---|---|---|---|---|---|---|---|
| 1 | 76 – 100 | **7.5** | 30.04 | 24.62 | 98.6 | 96.5 | 62.5× |
| 2 | 100 – 130 | 6.0 | 24.82 | 6.31 | 97.8 | 94.3 | 50.0× |
| 3 | 130 – 180 | 4.5 | 22.03 | 3.84 | 97.4 | 93.5 | 30.0× |
| 4 | 180 – 280 | 3.0 | 16.85 | 3.96 | 99.0 | 97.0 | 15.0× |
| 5 | 280 – 480 | 1.5 | 5.44 | 3.40 | 99.3 | 97.7 | 7.5× |
| 6 | 480 – 1014 | **0.0** (uncut stock face) | 0.82 | 3.06 | 99.4 | 97.7 | 2.8× |

*Ledge width = 2 × area / perimeter of the annulus — the mean width of the terrace that
survives at that one depth. "Pocket reach" = fraction of the cumulative region a cutter of
that diameter can actually enter (erode by r, re-dilate, intersect).*

**Narrowest surviving feature clears the cutter:** the tightest mean ledge is **3.06 mm**
(band 6) — **≥ 1 × Ø3**. That was the binding constraint on every other number.

**Vertical exaggeration is NOT a single number.** True relief at 1:1 M is 0.938 mm; the cut
is 7.5 mm ⇒ **8.0× overall**, but because the breaks are non-uniform the *local* exaggeration
runs **62.5× in the Alföld down to 2.8× on Kékes**. This is why the legend is part of the
deliverable (§4).

**Islands dropped as un-cuttable:** 1,660 totalling **1,098 mm² = 1.18 % of map area**
(anything smaller than a Ø3 circle, 7.07 mm²). Contours simplified to **0.375 mm** (Ø3 / 8).

---

## 3. Linear or quantile bands? — **neither**, and why

Hungary is the case that breaks both defaults.

- **Linear** (e.g. 9 even steps 76 → 1014, ~104 m each): **82 % of the country falls in the
  bottom 1.3 bands.** The plaque is one flat slab with a bump in the north-east. Honest, and
  almost information-free — the Mecsek, Bakony, Bükk and Zemplén all vanish.
- **Quantile / equal-area** (each band = 1/6 of the area): breaks land at 86.6, 92.1, 99.7,
  111.2, 122.1 … m. Maximum contrast — and a **lying object**. It manufactures terraces
  across the Hortobágy that a viewer reads as hills, the break values are unlabellable, and
  it violates *refuse rather than approximate*. **Rejected.**

**Chosen: a declared non-uniform break set on round, labellable values** —
**76 / 100 / 130 / 180 / 280 / 480 / 1014 m** — roughly geometric, fine in the lowlands and
coarse in the mountains, with the **legend cut into the plaque** so the non-linearity is
visible in the object itself. A relief whose vertical scale is non-uniform *and says so on
its face* is not lying; one that stays silent is.

The sweep that chose it (all run, all measured):

| scheme | bands | scale | plaque | min mean ledge | verdict |
|---|---|---|---|---|---|
| A | 9 | 1:1.5 M | 400×320 | **0.98 mm** | ✗ sub-millimetre ledges — crumbles in ply |
| B | 7 | 1:1.5 M | 400×320 | 1.74 mm | ✗ still under Ø3 |
| C | 6 | 1:1.5 M | 400×320 | 2.40 mm | ✗ marginal |
| **D** | **6** | **1:1 M** | **570×420** | **3.06 mm** | ✅ **adopted** |
| E | 7 | 1:1 M | 570×420 | 2.38 mm | ✗ 7th band costs the clearance |

Ledge width scales with map scale, so the fix for A/B/C was **more plaque, not more bands**.

---

## 4. What the machine actually cuts — and the depth-binding hazard

**The cut geometry is the CUMULATIVE outline, not the annulus.** The `pass*.dxf` files each
hold *"everything below break i"*; run them in ascending depth and each pass removes exactly
**1.5 mm** — a staircase, one full-depth Ø3 pass per level. The `band*.dxf` annuli are the
**legend/visualisation** form: as ribbons they are 18–83 % reachable and must **not** be
driven as pockets.

🔴 **Nothing binds a DXF to its depth.** DXF carries 2D geometry only. Fed to
`2bee-slice recommend`, every outline came back as an **18.000 mm deep** profile/pocket —
the *stock default* — because there is no depth in the file. The depth lives **only in the
filename** (`pass03_below180m_to_depth4.5mm.dxf`) and in the table above, and **a human must
set it per operation**. If they set it wrong, the geometry is still valid and **no gate here
will go red.** Before running, assert the **emitted Z per operation** against the filename's
depth token — *assert on the emitted program, never on the setting that was supposed to
produce it.*

**Recommended order:** rough passes 5→1 with Ø6 (2 terraces per 3 mm pass), finish terrace
walls with Ø3, then text, then legend, then perimeter. **Fixture:** undeclared — the export
will warn on every run, and it should; declaring clamps is `ops`' call.

---

## 5. The text

Converted from **DejaVu Sans Bold** (`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`,
Bitstream Vera / DejaVu licence — permissive, commercial use allowed) to closed outlines via
`matplotlib.textpath.TextPath` at size 1000 then scaled to cap height, so flattening error
scales down with it. Even-odd ring nesting resolves counters into holes.

- **"Hungarofest 2027"**, cap **38 mm**, spans **24.96 → 545.04 mm** in X, baseline y = 26 mm.
- **20 closed polylines = 15 glyphs + 5 counters** (`g a o e 0`) — exactly right, which is
  the check that the outline conversion did not silently drop a bowl.
- Reachability **99.55 % with Ø3**, 99.95 % with Ø1. Pocket the title ~2 mm deep with Ø3.
- **Legend text** (cap 4.5 mm) is on its own layer `LEGEND_TEXT` and is for **V-carve /
  engrave** (`V-Bit 6mm 60deg` or `Engraving 0.5mm tip 30deg` in the built-in library) —
  99.26 % reachable at Ø0.5. **Do not pocket it with Ø3.**

---

## 6. What was RUN vs what was only written

**Run, with output read:**

- `gdalinfo` → **GDAL 3.10.3**; DXF driver present (`rw+v`); `ezdxf 1.4.3`, `shapely`,
  `scipy 1.18.0`, `fontTools`, `rasterio`, `matplotlib` all import.
- Located and confirmed **28/28 Hungary DEM tiles** on the local mirror.
- Downloaded Natural Earth 10 m admin-0; extracted `HUN`.
- `gdalwarp` → EOV 30 m clip; `gdalinfo -stats`; full percentile/tail analysis in numpy;
  geographic location of both extremes.
- `build_relief_dxf.py` end-to-end → **14 DXF, 2,098 closed polylines**, `build-report.json`,
  preview PNG. Band/scale sweep A–E all executed.
- **DXF audit:** every file `$INSUNITS = 4` (mm); **2,098/2,098 LWPOLYLINE, 0 open, no
  ARC/SPLINE/TEXT/MTEXT entity.**
- **Intake against this lane's own CLI:** `2bee-slice recommend` read `band06` (15 parts /
  15 features) and the text (15 parts / **20 features**, counters correctly typed as
  `inner-N (pocket)`), both **exit 0**, both logging `$INSUNITS = millimetres`.
- `2bee-slice fit ALL_…dxf` → default machine **600 × 900 mm** travel; plaque needs a
  **+3.0 / +3.0 mm datum shift** to clear the soft limits, **reported, not applied**.
- **Negative control:** legend clearance raised 5 → 400 mm ⇒ pipeline **refuses, exit 1**.
  The guard has been watched going red.
- Licence read from the COP-DEM-GLO-30-F PDF (Articles 3–7 extracted).

**NOT run — do not read this note as claiming otherwise:**

- **No G-code.** No `2bee-slice` post, no simulation, no gate suite (`slicer_gate_check.mjs`
  was **not** run — this work adds no gate and touches no core).
- **No cutting, no air cut, no coupon.** Nothing has been on a machine.
- **No toolpath planning** — so no verified feeds, speeds, entry moves, holding tabs or
  cycle time. `fit`'s own output says its extent is a **FLOOR** that a planned path can still
  exceed.
- **Depth-per-band is unbound and unchecked** (§4).
- **No stock/sheet chosen.** Sheet basis is contested in-repo (2700×1200 / 2400×1200 /
  600×900) — **bom + ops**, not this lane. 18 mm is a *thickness* assumption, not a sheet.

**Could not verify:**

- `spacedata.copernicus.eu` refused the connection (`ECONNREFUSED`); the licence came from
  the mirrored COP-DEM-GLO-30-F PDF instead — same instrument name, but **not fetched from
  the issuer's own domain**.
- The 5.4 %-above-300 m measurement vs the published *"less than 2%"* is **unreconciled**.
- Kékes at 1032.09 m is *consistent with* summit structures/canopy in a DSM; **that
  attribution is inference, not a measurement of what the tower is.**
- No bare-earth DTM was used, so every band edge carries **canopy/building bias** — worst in
  forested hills, where a treeline can shift a contour by a few metres of elevation.

---

## 7. Reproduce

```bash
DEM=/mnt/A41A07C21A07908A/2bee-farm-geo/global/terrain/copernicus_dem_30m

# 1. mosaic the 28 Hungary tiles
ls $DEM/Copernicus_DSM_COG_10_N4[5-8]_00_E0{16,17,18,19,20,21,22}_00_DEM.tif > tiles.txt
gdalbuildvrt -input_file_list tiles.txt hu_src.vrt

# 2. Hungary boundary (Natural Earth, public domain)
curl -sSLO https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip
unzip -oq ne_10m_admin_0_countries.zip
ogr2ogr -f GeoJSON hungary.geojson ne_10m_admin_0_countries.shp \
        -where "ADM0_A3='HUN'" -nlt PROMOTE_TO_MULTI

# 3. clip + reproject to the Hungarian national grid
gdalwarp -t_srs EPSG:23700 -tr 30 30 -r bilinear \
         -cutline hungary.geojson -crop_to_cutline -dstnodata -9999 \
         -co COMPRESS=DEFLATE -co TILED=YES -overwrite hu_src.vrt hu_dem_eov_30m.tif

# 4. bands -> DXF (this step also runs gdalwarp -r average and gdal_contour -p internally)
python3 hungarofest-2027/build_relief_dxf.py \
        --dem hu_dem_eov_30m.tif --out hungarofest-2027 --preview

# alternatives (all measured in S3)
python3 hungarofest-2027/build_relief_dxf.py --dem hu_dem_eov_30m.tif --out /tmp/x \
        --breaks 76,100,125,150,200,250,300,400,600,1014 --scale 1500000 --plaque 400x320
```
