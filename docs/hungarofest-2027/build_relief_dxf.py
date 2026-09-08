#!/usr/bin/env python3
"""
Hungarofest 2027 — terraced relief plaque of Hungary.
Turns a Copernicus GLO-30 DEM into ONE CLOSED-POLYLINE DXF PER ELEVATION BAND,
plus the title text as closed glyph outlines.

WHAT THIS DOES NOT DO
  - It does not produce a smooth relief. 2bee.app is 2.5D subtractive CNC only:
    no Z-level roughing, no waterline, no scallop, no ball-nose stepover. The
    output is N discrete terraces, each a closed 2D outline pocketed to ONE
    fixed depth.
  - It does not emit STL for the cutting path. 2bee.app's mesh importer SECTIONS
    a mesh at ONE Z; a relief STL would post and gate green as a single flat
    outline -- a plausible-looking wrong part.
  - It does not emit text() geometry. Glyphs are converted to closed outlines
    here, before the DXF is written.
  - It does not choose a sheet stock. Sheet basis is contested (bom/ops).
  - Nothing here has been cut. This is geometry, not a validated program.

Usage:  python3 build_relief_dxf.py --dem <hu_dem_eov_30m.tif> --out <dir>
"""
import argparse, json, math, os, subprocess, sys, tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from scipy.ndimage import gaussian_filter
from osgeo import ogr, osr
from shapely.geometry import Polygon, MultiPolygon, shape
from shapely.ops import unary_union, transform as shp_transform
from shapely import wkb as shp_wkb
import ezdxf

# ─────────────────────────── DESIGN CONSTANTS ────────────────────────────────
# Every number here is justified in ../hungarofest-2027-relief-plaque.md.

# Elevation clamp. Guards two MEASURED artefacts in the source DSM:
#   low  : Visonta + Bukkabrany open-cast lignite pits reach 26.2 m (2.6 km2
#          below 60 m) -- excavation, not terrain.
#   high : Kekes summit reads 1032.1 m in a SURFACE model vs the surveyed
#          1014 m -- tower/buildings/canopy, not ground.
ELEV_MIN = 76.0     # m, official low point Gyalaret/Szeged ~78 m, rounded down
ELEV_MAX = 1014.0   # m, Kekes, surveyed

# Band breaks (m). NOT linear, NOT quantile -- see the design note S4.
# Round, labellable values; the non-linearity is declared on the plaque legend.
BREAKS = [76.0, 100.0, 130.0, 180.0, 280.0, 480.0, 1014.0]

STEP_MM        = 1.5     # depth per terrace = 0.5 x D for a 3 mm cutter (1 pass)
CUTTER_MM      = 3.0     # primary detail cutter diameter
ROUGH_MM       = 6.0     # roughing cutter, checked separately
STOCK_MM       = 18.0    # nominal stock thickness (blank source NOT chosen here)

MAP_SCALE      = 1_000_000        # 1 : 1 million, a round checkable number
PLAQUE_W_MM    = 570.0
PLAQUE_H_MM    = 420.0
MAP_TOP_MARGIN = 20.0
TEXT           = "Hungarofest 2027"
TEXT_CAP_MM    = 38.0
TEXT_BASE_MM   = 26.0             # baseline y above plaque bottom
FONT           = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# The depth scale is NON-LINEAR (see design note S4). A relief whose vertical
# scale is non-uniform and does NOT say so on its face is a lying object, so the
# legend is part of the deliverable, not decoration.
LEGEND_ORIGIN  = None           # auto-placed into VERIFIED-EMPTY space (see place_legend)
LEGEND_SW_W    = 13.0           # swatch width  mm
LEGEND_SW_H    = 7.0            # swatch height mm
LEGEND_STEP_X  = 2.6            # staircase inset per band, mm
LEGEND_CAP_MM  = 4.5            # legend text cap height -> V-CARVE, not pocket

DEM_SMOOTH_M   = 250.0   # resample ground resolution before contouring
SMOOTH_SIGMA   = 1.5     # gaussian sigma in resampled pixels
MIN_ISLAND_MM2 = None    # computed from cutter: a circle of one cutter diameter


# ─────────────────────────────── helpers ─────────────────────────────────────
def log(msg): print(msg, flush=True)


def prepare_dem(dem_path, work):
    """Resample (nodata-aware, via gdalwarp), clamp to [ELEV_MIN, ELEV_MAX],
    gaussian-smooth inside the valid mask."""
    res = work / "dem_resampled.tif"
    cmd = ["gdalwarp", "-tr", str(DEM_SMOOTH_M), str(DEM_SMOOTH_M), "-r", "average",
           "-srcnodata", "-9999", "-dstnodata", "-9999",
           "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-overwrite",
           str(dem_path), str(res)]
    log("  $ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"gdalwarp FAILED rc={r.returncode}\n{r.stderr}")

    src = rasterio.open(res)
    nd = src.nodata if src.nodata is not None else -9999
    a = src.read(1).astype("float64")
    log(f"  resampled to {src.width}x{src.height} @ {DEM_SMOOTH_M:.0f} m")

    valid = np.isfinite(a) & (a > -1000)
    lo_px = int(((a < ELEV_MIN) & valid).sum())
    hi_px = int(((a > ELEV_MAX) & valid).sum())
    log(f"  valid px {int(valid.sum()):,}; below {ELEV_MIN:.0f} m: {lo_px} ; above {ELEV_MAX:.0f} m: {hi_px}")
    a = np.clip(a, ELEV_MIN, ELEV_MAX)

    filled = np.where(valid, a, ELEV_MIN)
    sm  = gaussian_filter(filled, SMOOTH_SIGMA)
    wgt = gaussian_filter(valid.astype("float64"), SMOOTH_SIGMA)
    sm  = np.where(wgt > 1e-6, sm / np.maximum(wgt, 1e-6), ELEV_MIN)
    sm  = np.clip(sm, ELEV_MIN, ELEV_MAX)
    out = np.where(valid, sm, nd).astype("float32")

    prof = src.profile.copy()
    prof.update(dtype="float32", nodata=nd, compress="DEFLATE", tiled=True)
    p = work / "dem_prepared.tif"
    with rasterio.open(p, "w", **prof) as dst:
        dst.write(out, 1)
    return p, prof


def contour_polygons(prep_tif, work):
    """gdal_contour -p : elevation-band polygons between BREAKS."""
    gpkg = work / "bands.gpkg"
    if gpkg.exists():
        gpkg.unlink()
    cmd = ["gdal_contour", "-p", "-amin", "ELEV_MIN", "-amax", "ELEV_MAX",
           "-fl", *[str(b) for b in BREAKS],
           "-f", "GPKG", str(prep_tif), str(gpkg)]
    log("  $ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"gdal_contour FAILED rc={r.returncode}\n{r.stderr}")
    return gpkg


def read_bands(gpkg):
    """-> {band_index: shapely geometry of the ANNULUS for that band}"""
    ds = ogr.Open(str(gpkg))
    lyr = ds.GetLayer(0)
    buckets = {i: [] for i in range(len(BREAKS) - 1)}
    for feat in lyr:
        lo = feat.GetField("ELEV_MIN")
        g = feat.GetGeometryRef()
        if g is None or lo is None:
            continue
        if lo >= BREAKS[-1] or lo < BREAKS[0] - 1e-6:
            continue
        geom = shp_wkb.loads(bytes(g.ExportToWkb()))
        if not geom.is_valid:
            geom = geom.buffer(0)
        # assign to the band whose lower break matches
        idx = min(range(len(BREAKS) - 1),
                  key=lambda i: abs(BREAKS[i] - max(lo, ELEV_MIN)))
        buckets[idx].append(geom)
    return {i: unary_union(v) if v else None for i, v in buckets.items()}


def make_projector(prof, mm_per_m, origin_x, origin_y, map_x0, map_y0):
    def f(x, y, z=None):
        return ((np.asarray(x) - origin_x) * mm_per_m + map_x0,
                (np.asarray(y) - origin_y) * mm_per_m + map_y0)
    return f


def clean_for_cnc(geom, simplify_mm, min_island_mm2):
    """Simplify to the machine's resolvable detail; drop islands the cutter
    cannot enter at all. Returns (geom, n_dropped, dropped_area)."""
    if geom is None or geom.is_empty:
        return geom, 0, 0.0
    g = geom.simplify(simplify_mm, preserve_topology=True).buffer(0)
    polys = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
    keep, dropped, darea = [], 0, 0.0
    for p in polys:
        if p.is_empty:
            continue
        if p.area < min_island_mm2:
            dropped += 1; darea += p.area; continue
        # drop holes too small to be cut as holes (they'd just be solid)
        ext, holes = p.exterior, []
        for r in p.interiors:
            hp = Polygon(r)
            if hp.area >= min_island_mm2:
                holes.append(r)
            else:
                dropped += 1; darea += hp.area
        keep.append(Polygon(ext, holes))
    return (unary_union(keep) if keep else None), dropped, darea


def min_neck_report(geom, cutter_mm):
    """Erode by the cutter radius: what survives is what the cutter can enter."""
    if geom is None or geom.is_empty:
        return dict(area_mm2=0.0, reachable_mm2=0.0, reachable_pct=0.0)
    a = geom.area
    er = geom.buffer(-cutter_mm / 2.0)
    reach = 0.0 if (er is None or er.is_empty) else er.buffer(cutter_mm / 2.0).intersection(geom).area
    return dict(area_mm2=a, reachable_mm2=reach,
                reachable_pct=(100.0 * reach / a if a else 0.0))


def polys_of(geom):
    if geom is None or geom.is_empty:
        return []
    return list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]


def write_dxf(path, layers):
    """layers: list of (layer_name, geometry, colour_index)"""
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4       # 4 = millimetres
    msp = doc.modelspace()
    n = 0
    for name, geom, colour in layers:
        if name not in doc.layers:
            doc.layers.add(name, color=colour)
        for p in polys_of(geom):
            for ring in [p.exterior, *p.interiors]:
                pts = list(ring.coords)
                if len(pts) < 4:
                    continue
                msp.add_lwpolyline(pts[:-1], close=True, dxfattribs={"layer": name})
                n += 1
    doc.saveas(path)
    return n


# ───────────────────────────── text outlines ─────────────────────────────────
def text_outlines(text, cap_mm, font_path):
    """Glyphs -> CLOSED shapely polygons. text() is REFUSED by 2bee.app's mesh
    kernel (renders no glyphs), so the letters must arrive as outlines."""
    from matplotlib.textpath import TextPath
    from matplotlib.font_manager import FontProperties
    fp = FontProperties(fname=font_path)
    tp = TextPath((0, 0), text, size=1000, prop=fp)   # big, then scale: flattening error scales too
    rings = [np.asarray(r) for r in tp.to_polygons() if len(r) >= 4]
    if not rings:
        raise RuntimeError("font produced no glyph outlines")
    # even-odd -> exterior/hole
    polys = [Polygon(r).buffer(0) for r in rings]
    order = sorted(range(len(polys)), key=lambda i: -polys[i].area)
    used, out = set(), []
    for i in order:
        if i in used:
            continue
        depth = sum(1 for j in order
                    if j != i and polys[j].area > polys[i].area
                    and polys[j].contains(polys[i].representative_point()))
        if depth % 2 == 1:
            continue                       # this ring is a hole, handled below
        holes = []
        for j in order:
            if j == i or j in used or polys[j].area >= polys[i].area:
                continue
            if polys[i].contains(polys[j].representative_point()):
                d2 = sum(1 for k in order
                         if k != j and polys[k].area > polys[j].area
                         and polys[k].contains(polys[j].representative_point()))
                if d2 % 2 == 1:
                    holes.append(rings[j]); used.add(j)
        out.append(Polygon(rings[i], holes)); used.add(i)
    g = unary_union(out)
    # scale so CAP HEIGHT (measured on 'H') == cap_mm
    capref = TextPath((0, 0), "H", size=1000, prop=fp)
    cap_units = capref.get_extents().height
    s = cap_mm / cap_units
    return shp_transform(lambda x, y, z=None: (np.asarray(x) * s, np.asarray(y) * s), g), s


# ────────────────────────────────── main ─────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dem", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", default=None)
    ap.add_argument("--breaks", default=None, help="comma-separated metre breaks")
    ap.add_argument("--scale", type=int, default=None, help="map denominator, e.g. 1500000")
    ap.add_argument("--plaque", default=None, help="WxH mm, e.g. 400x320")
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()

    global BREAKS, MAP_SCALE, PLAQUE_W_MM, PLAQUE_H_MM
    if args.breaks:
        BREAKS = [float(x) for x in args.breaks.split(",")]
    if args.scale:
        MAP_SCALE = args.scale
    if args.plaque:
        PLAQUE_W_MM, PLAQUE_H_MM = [float(v) for v in args.plaque.lower().split("x")]

    out = Path(args.out); (out / "dxf").mkdir(parents=True, exist_ok=True)
    work = Path(args.work) if args.work else Path(tempfile.mkdtemp(prefix="hurelief_"))
    work.mkdir(parents=True, exist_ok=True)

    log("[1/6] preparing DEM")
    prep, prof = prepare_dem(args.dem, work)

    log("[2/6] contouring to band polygons")
    gpkg = contour_polygons(prep, work)
    ann = read_bands(gpkg)

    log("[3/6] projecting EOV metres -> plaque millimetres")
    with rasterio.open(prep) as s:
        b = s.bounds
    ground_w, ground_h = b.right - b.left, b.top - b.bottom
    mm_per_m = 1000.0 / MAP_SCALE
    map_w, map_h = ground_w * mm_per_m, ground_h * mm_per_m
    map_x0 = (PLAQUE_W_MM - map_w) / 2.0
    map_y0 = PLAQUE_H_MM - MAP_TOP_MARGIN - map_h
    log(f"  ground {ground_w/1000:.1f} x {ground_h/1000:.1f} km  @ 1:{MAP_SCALE:,}")
    log(f"  map field {map_w:.1f} x {map_h:.1f} mm  at ({map_x0:.1f}, {map_y0:.1f})")
    proj = make_projector(prof, mm_per_m, b.left, b.bottom, map_x0, map_y0)
    ann = {i: (shp_transform(proj, g) if g is not None else None) for i, g in ann.items()}

    log("[4/6] cleaning for the cutter")
    global MIN_ISLAND_MM2
    MIN_ISLAND_MM2 = math.pi * (CUTTER_MM / 2.0) ** 2
    simplify_mm = CUTTER_MM / 8.0
    stats = []
    for i in sorted(ann):
        g, nd, da = clean_for_cnc(ann[i], simplify_mm, MIN_ISLAND_MM2)
        ann[i] = g
        stats.append(dict(band=i + 1, lo=BREAKS[i], hi=BREAKS[i + 1],
                          depth_mm=round((len(BREAKS) - 2 - i) * STEP_MM, 3),
                          dropped_islands=nd, dropped_mm2=round(da, 2)))

    # CUMULATIVE outlines = the CUT geometry. Pocket "everything below break i"
    # to depth i, in ascending depth: each pass removes exactly STEP_MM.
    cum_below = {}
    acc = None
    for i in sorted(ann):                         # low band first
        acc = ann[i] if acc is None else (unary_union([acc, ann[i]]) if ann[i] is not None else acc)
        cum_below[i] = acc

    log("[5/6] cutter reachability")
    for s in stats:
        i = s["band"] - 1
        # ANNULUS: the ledge that ends up at this one depth.
        for cd, tag in ((CUTTER_MM, "d3"), (ROUGH_MM, "d6")):
            s[f"reach_{tag}_pct"] = round(min_neck_report(ann[i], cd)["reachable_pct"], 2)
        s["area_mm2"] = round(ann[i].area if ann[i] is not None else 0.0, 1)
        # mean ledge width of a ribbon ~= 2*area/perimeter (guards: crumbling terrace)
        g = ann[i]
        s["ledge_w_mm"] = round(2.0 * g.area / g.length, 3) if (g is not None and g.length) else 0.0
        # CUMULATIVE: what the machine actually pockets on this pass.
        cg = cum_below.get(i)
        for cd, tag in ((CUTTER_MM, "d3"), (ROUGH_MM, "d6")):
            s[f"pass_reach_{tag}_pct"] = round(min_neck_report(cg, cd)["reachable_pct"], 2)
        s["pass_area_mm2"] = round(cg.area if cg is not None else 0.0, 1)
        s["area_pct"] = None
        true_mm = (BREAKS[i+1] - BREAKS[i]) * 1000.0 / MAP_SCALE
        s["interval_m"] = BREAKS[i+1] - BREAKS[i]
        s["true_relief_mm"] = round(true_mm, 4)
        s["vert_exag"] = round(STEP_MM / true_mm, 1) if true_mm else None
    tot = sum(s["area_mm2"] for s in stats) or 1.0
    for s in stats:
        s["area_pct"] = round(100.0 * s["area_mm2"] / tot, 2)

    log("[6/6] writing DXF")
    colours = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    written = {}
    # one DXF per band (the ANNULUS - what sits at that one depth)
    for i in sorted(ann):
        name = f"band{i+1:02d}_{int(BREAKS[i])}-{int(BREAKS[i+1])}m_depth{(len(BREAKS)-2-i)*STEP_MM:.1f}mm"
        p = out / "dxf" / f"{name}.dxf"
        written[name] = write_dxf(p, [(f"BAND_{i+1:02d}", ann[i], colours[i % len(colours)])])
    # one DXF per CUT PASS (cumulative "below break" - what the machine pockets)
    for i in sorted(cum_below):
        if i == len(BREAKS) - 2:
            continue                      # top band is the uncut stock face
        d = (len(BREAKS) - 2 - i) * STEP_MM
        name = f"pass{i+1:02d}_below{int(BREAKS[i+1])}m_to_depth{d:.1f}mm"
        p = out / "dxf" / f"{name}.dxf"
        written[name] = write_dxf(p, [(f"PASS_{i+1:02d}", cum_below[i], colours[i % len(colours)])])

    # text
    log("  text -> closed outlines")
    tg, tscale = text_outlines(TEXT, TEXT_CAP_MM, FONT)
    minx, miny, maxx, maxy = tg.bounds
    tg = shp_transform(lambda x, y, z=None: (np.asarray(x) + (PLAQUE_W_MM - (maxx - minx)) / 2.0 - minx,
                                             np.asarray(y) + TEXT_BASE_MM - miny), tg)
    written["text_hungarofest_2027"] = write_dxf(out / "dxf" / "text_hungarofest_2027.dxf",
                                                 [("TEXT_OUTLINE", tg, 7)])
    tstats = min_neck_report(tg, CUTTER_MM)
    tstats_engrave = min_neck_report(tg, 1.0)

    # ── legend: a cut staircase + labels, so the non-linear scale is ON the object
    # Placement is checked against the legend's REAL geometry, not an estimated
    # bounding box: a clearance check that measures a proxy is green about the proxy.
    log("  legend -> swatches + labels")
    nb_ = len(BREAKS) - 1
    mapunion = unary_union([g for g in ann.values() if g is not None])

    def build_legend(ox, oy):
        sw, tx = [], []
        for i in range(nb_):
            row = nb_ - 1 - i                      # highest band on top
            y0 = oy + row * (LEGEND_SW_H + 1.2)
            x0 = ox + i * LEGEND_STEP_X            # inset shows the terrace stepping back
            sw.append(Polygon([(x0, y0), (x0 + LEGEND_SW_W, y0),
                               (x0 + LEGEND_SW_W, y0 + LEGEND_SW_H), (x0, y0 + LEGEND_SW_H)]))
            depth = (nb_ - 1 - i) * STEP_MM
            g, _ = text_outlines(f"{int(BREAKS[i])}-{int(BREAKS[i+1])} m   -{depth:.1f} mm",
                                 LEGEND_CAP_MM, FONT)
            bx, by, _, _ = g.bounds
            dx = ox + nb_ * LEGEND_STEP_X + LEGEND_SW_W + 4.0 - bx
            dy = y0 + (LEGEND_SW_H - LEGEND_CAP_MM) / 2.0 - by
            tx.append(shp_transform(lambda x, y, z=None, dx=dx, dy=dy:
                                    (np.asarray(x) + dx, np.asarray(y) + dy), g))
        return unary_union(sw), unary_union(tx)

    # build once at the origin to learn the TRUE extent, then translate candidates
    sw0, tx0 = build_legend(0.0, 0.0)
    lb = unary_union([sw0, tx0]).bounds
    leg_w, leg_h = lb[2] - lb[0], lb[3] - lb[1]
    CLEAR = 5.0
    log(f"  legend true extent {leg_w:.1f} x {leg_h:.1f} mm (measured, not estimated)")

    cands = []
    for cy in np.arange(map_y0 + 2.0, map_y0 + map_h - leg_h - 2.0, 4.0):
        for cx in np.arange(map_x0 + 2.0, map_x0 + map_w - leg_w - 2.0, 4.0):
            cands.append((float(cx), float(cy)))
    cands.sort(key=lambda c: (c[1] - map_y0) + 0.35 * (c[0] - map_x0))

    lx = ly = None
    legend_swatches = legend_labels = None
    for cx, cy in cands:
        sw, tx = (shp_transform(lambda x, y, z=None, dx=cx - lb[0], dy=cy - lb[1]:
                                (np.asarray(x) + dx, np.asarray(y) + dy), g) for g in (sw0, tx0))
        real = unary_union([sw, tx])
        if real.distance(mapunion) >= CLEAR:
            lx, ly, legend_swatches, legend_labels = cx, cy, sw, tx
            break
    if lx is None:
        sys.exit("LEGEND: no space inside the map field clears the relief by "
                 f"{CLEAR} mm -- place it by hand; do NOT let it overlap the relief")
    gap = unary_union([legend_swatches, legend_labels]).distance(mapunion)
    log(f"  legend at ({lx:.1f}, {ly:.1f}) mm; measured gap to relief {gap:.2f} mm (>= {CLEAR})")

    written["legend"] = write_dxf(out / "dxf" / "legend.dxf",
                                  [("LEGEND_SWATCH", legend_swatches, 7),
                                   ("LEGEND_TEXT", legend_labels, 7)])
    legend_reach_v = min_neck_report(legend_labels, 0.5)

    # combined
    layers = [(f"BAND_{i+1:02d}", ann[i], colours[i % len(colours)]) for i in sorted(ann)]
    layers.append(("TEXT_OUTLINE", tg, 7))
    layers.append(("LEGEND_SWATCH", legend_swatches, 7))
    layers.append(("LEGEND_TEXT", legend_labels, 7))
    layers.append(("PLAQUE_OUTLINE",
                   Polygon([(0, 0), (PLAQUE_W_MM, 0), (PLAQUE_W_MM, PLAQUE_H_MM), (0, PLAQUE_H_MM)]), 7))
    written["ALL_hungarofest_2027_plaque"] = write_dxf(
        out / "dxf" / "ALL_hungarofest_2027_plaque.dxf", layers)

    if args.preview:
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.path import Path as MPath
        from matplotlib.patches import PathPatch

        def compound(geom):
            """Exterior + interiors as ONE even-odd path, so holes are
            TRANSPARENT rather than painted over whatever is beneath."""
            verts, codes = [], []
            for poly in polys_of(geom):
                for ring in [poly.exterior, *poly.interiors]:
                    c = np.asarray(ring.coords)
                    if len(c) < 3:
                        continue
                    verts.append(c)
                    codes.append(np.array([MPath.MOVETO] + [MPath.LINETO]*(len(c)-2) + [MPath.CLOSEPOLY]))
            if not verts:
                return None
            return MPath(np.vstack(verts), np.concatenate(codes))

        fig, ax = plt.subplots(figsize=(PLAQUE_W_MM/25.4, PLAQUE_H_MM/25.4), dpi=110)
        ax.add_patch(plt.Rectangle((0, 0), PLAQUE_W_MM, PLAQUE_H_MM,
                                   facecolor="#f4efe6", edgecolor="k", linewidth=1.2))
        nb = len(BREAKS) - 1
        for i in sorted(ann):
            pth = compound(ann[i])
            if pth is None:
                continue
            t = i / max(nb - 1, 1)
            col = (0.42 + 0.55*t, 0.36 + 0.56*t, 0.28 + 0.58*t)
            ax.add_patch(PathPatch(pth, facecolor=col, edgecolor="0.25",
                                   linewidth=0.3, joinstyle="round"))
        for gg, col in ((legend_swatches, "none"), (legend_labels, "0.12")):
            pp = compound(gg)
            if pp is not None:
                ax.add_patch(PathPatch(pp, facecolor=col, edgecolor="0.25", linewidth=0.4))
        tp = compound(tg)
        if tp is not None:
            ax.add_patch(PathPatch(tp, facecolor="0.12", edgecolor="none"))
        ax.set_xlim(-5, PLAQUE_W_MM+5); ax.set_ylim(-5, PLAQUE_H_MM+5)
        ax.set_aspect("equal"); ax.axis("off"); fig.tight_layout(pad=0.2)
        pv = out / "preview" / f"plaque_{nb}bands_1-{MAP_SCALE}.png"
        pv.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(pv, bbox_inches="tight"); plt.close(fig)
        log(f"  preview -> {pv}")

    report = dict(
        source="Copernicus DEM GLO-30 (COP-DEM_GLO-30-DGED), local mirror",
        crs="EPSG:23700 HD72 / EOV",
        elev_clamp=[ELEV_MIN, ELEV_MAX], breaks=BREAKS,
        step_mm=STEP_MM, total_relief_mm=round((len(BREAKS) - 2) * STEP_MM, 2),
        plaque_mm=[PLAQUE_W_MM, PLAQUE_H_MM],
        map_field_mm=[round(map_w, 2), round(map_h, 2)],
        map_scale=MAP_SCALE, cutter_mm=CUTTER_MM, rough_mm=ROUGH_MM,
        stock_mm=STOCK_MM, min_island_mm2=round(MIN_ISLAND_MM2, 3),
        simplify_mm=simplify_mm, bands=stats,
        text=dict(string=TEXT, font=FONT, cap_mm=TEXT_CAP_MM,
                  reach_d3_pct=round(tstats["reachable_pct"], 2),
                  reach_d1_pct=round(tstats_engrave["reachable_pct"], 2),
                  bounds_mm=[round(v, 2) for v in tg.bounds]),
        legend=dict(origin_mm=[round(lx, 2), round(ly, 2)], cap_mm=LEGEND_CAP_MM,
                    auto_placed=True, size_mm=[round(leg_w,2), round(leg_h,2)],
                    measured_gap_to_relief_mm=round(gap, 2), required_clearance_mm=CLEAR,
                    note="LEGEND_TEXT is for V-CARVE/ENGRAVE, not a 3 mm pocket",
                    reach_d0p5_pct=round(legend_reach_v["reachable_pct"], 2),
                    bounds_mm=[round(v, 2) for v in unary_union([legend_swatches, legend_labels]).bounds]),
        polylines_per_file=written,
    )
    (out / "build-report.json").write_text(json.dumps(report, indent=2))
    log("\n=== BAND TABLE ===")
    log(f"{'bd':>3} {'range m':>11} {'dep':>5} {'area%':>6} | {'LEDGE(annulus)':>22} | {'POCKET(cumulative)':>20}")
    log(f"{'':>3} {'':>11} {'':>5} {'':>6} | {'width_mm':>9}{'d3%':>6}{'d6%':>7} | {'area_mm2':>10}{'d3%':>5}{'d6%':>5}")
    for s in stats:
        log(f"{s['band']:>3} {int(s['lo']):>4}-{int(s['hi']):<6} {s['depth_mm']:>5.1f} "
            f"{s['area_pct']:>6.2f} | {s['ledge_w_mm']:>9.2f}{s['reach_d3_pct']:>6.1f}{s['reach_d6_pct']:>7.1f} | "
            f"{s['pass_area_mm2']:>10.0f}{s['pass_reach_d3_pct']:>5.1f}{s['pass_reach_d6_pct']:>5.1f}")
    log(f"\ntext reachability: d3.0 {report['text']['reach_d3_pct']}%  d1.0 {report['text']['reach_d1_pct']}%")
    log(f"report -> {out/'build-report.json'}")


if __name__ == "__main__":
    main()
