# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""PROJ oracle vectors for the viewer's globe placement helpers.

Writes apps/viewer/src/lib/geo/__fixtures__/proj-oracle.json. The viewer tests
compare proj4js-based helpers against these values, so the expected numbers are
PROJ's, never proj4js's own.

Run (any Python with pyproj >= 3.6, PROJ >= 9; no network, no grids needed):

    python -I scripts/geo/generate-proj-oracle.py

Every CRS is a PROJ string that proj4js parses to the same definition, so both
libraries compute the same transformation and any difference is the helper's.

Per point the fixture records, at the grid point (E, N):
  lon, lat         WGS84 position (PROJ, +towgs84 applied where the CRS has one)
  gammaTrueNorth   radians, CCW-positive rotation from the true-north ENU frame
                   to the grid frame on the WGS84 ellipsoid: minus the geodesic
                   azimuth of grid north, from a central difference of +/-10 m.
                   This is the frame Cesium places the model in.
  kWgs84           grid distance / WGS84 geodesic distance for +/-10 m grid steps
                   (geometric mean of the east and north steps): the point scale
                   factor as seen from WGS84, datum scale included.
  getFactors       PROJ Proj.get_factors on the projection's own ellipsoid:
                   meridianConvergence (deg, PROJ sign), meridionalScale,
                   parallelScale. Equal to the two above when the CRS is
                   WGS84/GRS80 without a datum shift; documented, not asserted,
                   otherwise.

`warp` holds per-vertex vectors (E, N, H -> lon, lat, h, ECEF) along a 20 km
line for the GeoWarp tests; `warpGeoid` is the stated geoid plane they use.

Each case's `edges` start at its first point and list grid offsets (metres)
with PROJ's WGS84 lon/lat of the offset point: the ground truth an anchor
placement of a grid-coordinate model is measured against.
"""
import json
import math
import os
import sys

import pyproj
from pyproj import CRS, Geod, Proj, Transformer

pyproj.network.set_network_enabled(False)

GEOD = Geod(ellps="WGS84")
WGS84 = CRS.from_proj4("+proj=longlat +datum=WGS84 +no_defs")

CASES = [
    {
        "name": "UTM 32N (WGS84)",
        "proj4": "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs",
        "lonlat": [[9.0, 50.0], [11.9, 50.0], [12.0, 55.0], [6.1, 48.0]],
        "sameEllipsoid": True,
    },
    {
        "name": "ETRS89 / UTM 33N (GRS80)",
        "proj4": "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
        "lonlat": [[12.1264, 54.0794], [15.0, 52.0]],
        "sameEllipsoid": True,
    },
    {
        "name": "RGF93 / Lambert-93 (GRS80)",
        "proj4": "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 "
                 "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
        "lonlat": [[2.35, 48.85], [7.5, 43.7], [-4.4, 48.4]],
        "sameEllipsoid": True,
    },
    {
        "name": "DHDN / 3-degree Gauss-Krueger zone 4 (Bessel, 7-parameter shift)",
        "proj4": "+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel "
                 "+towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs",
        "lonlat": [[12.0, 51.0], [10.6, 52.4]],
        "sameEllipsoid": False,
    },
    {
        "name": "S-JTSK / Krovak East North (Bessel, 7-parameter shift)",
        "proj4": "+proj=krovak +axis=enu +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 "
                 "+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel "
                 "+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs",
        "lonlat": [[14.42, 50.08], [17.25, 49.6]],
        "sameEllipsoid": False,
    },
]


EDGE_OFFSETS = [[500.0, 0.0], [0.0, 500.0], [-350.0, 350.0], [2000.0, -1500.0]]


def geodesic(lon1, lat1, lon2, lat2):
    """Azimuth at the MIDPOINT (mean of the forward azimuths at both ends) and length.

    A geodesic's azimuth turns by about dlon*sin(lat) along it, so the start
    azimuth of a probe centred on the point would be off by half of that.
    """
    az12, az21, dist = GEOD.inv(lon1, lat1, lon2, lat2)
    az2 = az21 + 180.0
    if az2 - az12 > 180.0:
        az2 -= 360.0
    elif az12 - az2 > 180.0:
        az2 += 360.0
    return (az12 + az2) / 2.0, dist


def point_vector(case, fwd, inv, proj, lon, lat):
    e, n = fwd.transform(lon, lat)
    lon0, lat0 = inv.transform(e, n)
    d = 10.0
    ln_s, lt_s = inv.transform(e, n - d)
    ln_n, lt_n = inv.transform(e, n + d)
    ln_w, lt_w = inv.transform(e - d, n)
    ln_e, lt_e = inv.transform(e + d, n)
    az_north, dist_north = geodesic(ln_s, lt_s, ln_n, lt_n)
    _, dist_east = geodesic(ln_w, lt_w, ln_e, lt_e)
    k = math.sqrt((2 * d / dist_north) * (2 * d / dist_east))
    # get_factors takes the projection's own geodetic coordinates.
    src_geog = CRS.from_proj4(case["proj4"]).geodetic_crs
    to_src = Transformer.from_crs(CRS.from_proj4(case["proj4"]), src_geog, always_xy=True)
    slon, slat = to_src.transform(e, n)
    f = proj.get_factors(slon, slat)
    return {
        "E": e,
        "N": n,
        "lon": lon0,
        "lat": lat0,
        "gammaTrueNorth": -math.radians(az_north),
        "kWgs84": k,
        "getFactors": {
            "meridianConvergence": f.meridian_convergence,
            "meridionalScale": f.meridional_scale,
            "parallelScale": f.parallel_scale,
        },
    }


# Per-vertex warp vectors: a 20 km diagonal line through the anchor, every
# 500 m, at two orthometric heights. The geoid is a stated test plane (metres,
# degrees from the anchor) so the oracle and the viewer use the same N; the
# viewer's own EGM96 grid is not under test here.
WARP_CASES = [
    ("UTM 32N (WGS84)", 9.0, 50.0),
    ("UTM 32N (WGS84)", 11.9, 50.0),
    ("DHDN / 3-degree Gauss-Krueger zone 4 (Bessel, 7-parameter shift)", 10.6, 52.4),
    ("RGF93 / Lambert-93 (GRS80)", 2.35, 48.85),
]
WARP_HALF_M = 10_000.0
WARP_STEP_M = 500.0
WARP_HEIGHTS = [100.0, 150.0]
ANCHOR_H = 120.0
GEOID = {"n0": 47.0, "perDegLat": 0.8, "perDegLon": -0.5}
TO_ECEF = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)


def test_geoid(lon, lat, lon0, lat0):
    return GEOD_N0 + GEOID["perDegLat"] * (lat - lat0) + GEOID["perDegLon"] * (lon - lon0)


GEOD_N0 = GEOID["n0"]


def warp_case(name, lon0, lat0):
    case = next(c for c in CASES if c["name"] == name)
    crs = CRS.from_proj4(case["proj4"])
    fwd = Transformer.from_crs(WGS84, crs, always_xy=True)
    inv = Transformer.from_crs(crs, WGS84, always_xy=True)
    e0, n0 = fwd.transform(lon0, lat0)
    alon, alat = inv.transform(e0, n0)
    anchor_h = ANCHOR_H + test_geoid(alon, alat, alon, alat)
    points = []
    steps = int(round(2 * WARP_HALF_M / WARP_STEP_M))
    for i in range(steps + 1):
        s = -WARP_HALF_M + i * WARP_STEP_M
        de, dn = s / math.sqrt(2.0), s / math.sqrt(2.0)
        lon, lat = inv.transform(e0 + de, n0 + dn)
        for big_h in WARP_HEIGHTS:
            h = big_h + test_geoid(lon, lat, alon, alat)
            x, y, z = TO_ECEF.transform(lon, lat, h)
            points.append({"dE": de, "dN": dn, "H": big_h, "lon": lon, "lat": lat, "h": h, "ecef": [x, y, z]})
    ax, ay, az = TO_ECEF.transform(alon, alat, anchor_h)
    return {
        "case": name,
        "proj4": case["proj4"],
        "anchor": {"E": e0, "N": n0, "H": ANCHOR_H, "lon": alon, "lat": alat, "h": anchor_h, "ecef": [ax, ay, az]},
        "points": points,
    }


def main():
    out_cases = []
    for case in CASES:
        crs = CRS.from_proj4(case["proj4"])
        fwd = Transformer.from_crs(WGS84, crs, always_xy=True)
        inv = Transformer.from_crs(crs, WGS84, always_xy=True)
        proj = Proj(case["proj4"])
        points = [point_vector(case, fwd, inv, proj, lon, lat) for lon, lat in case["lonlat"]]
        e0, n0 = points[0]["E"], points[0]["N"]
        edges = []
        for de, dn in EDGE_OFFSETS:
            lon1, lat1 = inv.transform(e0 + de, n0 + dn)
            edges.append({"dE": de, "dN": dn, "lon": lon1, "lat": lat1})
        out_cases.append({
            "name": case["name"],
            "proj4": case["proj4"],
            "sameEllipsoid": case["sameEllipsoid"],
            "points": points,
            "edges": edges,
        })
    doc = {
        "generator": "scripts/geo/generate-proj-oracle.py",
        "proj": pyproj.proj_version_str,
        "pyproj": pyproj.__version__,
        "cases": out_cases,
        "warpGeoid": GEOID,
        "warp": [warp_case(*c) for c in WARP_CASES],
    }
    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(here, "..", "..", "apps", "viewer", "src", "lib", "geo", "__fixtures__", "proj-oracle.json")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")
    print(f"wrote {os.path.normpath(target)}", file=sys.stderr)


if __name__ == "__main__":
    main()
