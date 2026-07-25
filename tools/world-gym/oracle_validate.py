# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""IfcOpenShell differential oracle for World Gym labels (M2 midterm:
"labels spot-validated against the IfcOpenShell differential oracle").

Reads a sample descriptor JSON (written by oracle-validate.mjs) listing
regenerated model files plus their World Gym labels, and validates each
label against IfcOpenShell - the same pinned engine
(tools/ifcopenshell_reference/requirements.lock: ifcopenshell==0.8.5) the
repo's geometry parity harness uses.

Per-model checks (each an independent read of the bytes by a foreign
engine, never by ifc-lite code):

  parse            file opens at all; schema string matches the label
  entity-counts    per-type entity counts match entityCountsByType,
                   adjusted for planted text-level defects (missing-site
                   removes the IfcSite, multiple-project adds an IfcProject)
  guid-dups        duplicate GlobalId count matches the planted
                   duplicate-globalid defect (0 for clean models)
  quantities       GymQuantities totals summed by IfcOpenShell match the
                   labeler's independently extracted totals to 1e-6 rel
  geometry-volume  mesh volumes (signed tetra sum over IfcOpenShell's own
                   triangulation, world coords) for slabs/columns/beams
                   match the ground-truth gross volumes to 1 percent;
                   walls compared net of planted openings
  clash-pairs      planted overlapping footing pairs actually overlap in
                   IfcOpenShell's geometry by the recorded penetration
  degenerate       planted zero-height columns fail to produce a shape in
                   IfcOpenShell too

Usage: python oracle_validate.py --sample sample.json --out report.json
"""

import argparse
import json
import sys
from collections import Counter

import ifcopenshell
import ifcopenshell.geom

REL_TOL_QTO = 1e-6
REL_TOL_VOLUME = 0.01
ABS_TOL_OVERLAP = 1e-3

GEOM_SETTINGS = ifcopenshell.geom.settings()
try:
    GEOM_SETTINGS.set("use-world-coords", True)
except Exception:  # older settings API
    GEOM_SETTINGS.set(GEOM_SETTINGS.USE_WORLD_COORDS, True)


def mesh_volume_and_bbox(shape):
    verts = shape.geometry.verts
    faces = shape.geometry.faces
    vol = 0.0
    xs = verts[0::3]
    ys = verts[1::3]
    zs = verts[2::3]
    for i in range(0, len(faces), 3):
        a, b, c = faces[i] * 3, faces[i + 1] * 3, faces[i + 2] * 3
        ax, ay, az = verts[a], verts[a + 1], verts[a + 2]
        bx, by, bz = verts[b], verts[b + 1], verts[b + 2]
        cx, cy, cz = verts[c], verts[c + 1], verts[c + 2]
        vol += (
            ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx)
        ) / 6.0
    bbox = (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)) if xs else None
    return abs(vol), bbox


def aabb_overlap_depth_x(b1, b2):
    """Overlap depth along x for two AABBs that share y/z extent (the planted pairs)."""
    if b1 is None or b2 is None:
        return None
    ox = min(b1[3], b2[3]) - max(b1[0], b2[0])
    oy = min(b1[4], b2[4]) - max(b1[1], b2[1])
    oz = min(b1[5], b2[5]) - max(b1[2], b2[2])
    if ox <= 0 or oy <= 0 or oz <= 0:
        return 0.0
    return ox


def rel_close(a, b, tol):
    if b == 0:
        return abs(a) <= tol
    return abs(a - b) / abs(b) <= tol


def defect_types(entry):
    return {d["type"] for d in entry.get("defects", [])}


def check_model(entry):
    checks = {}
    path = entry["file"]
    planted = defect_types(entry)

    try:
        f = ifcopenshell.open(path)
    except Exception as err:  # noqa: BLE001
        return {"parse": {"ok": False, "error": str(err)}}
    checks["parse"] = {"ok": True, "schema": f.schema,
                       "schemaMatches": f.schema == entry.get("schema", "IFC4")}

    # --- entity counts (adjusted for planted text-level defects) ---
    expected_counts = dict(entry["entityCountsByType"])
    if "missing-site" in planted:
        expected_counts["IfcSite"] = expected_counts.get("IfcSite", 1) - 1
    if "multiple-project" in planted:
        expected_counts["IfcProject"] = expected_counts.get("IfcProject", 1) + 1
    mismatches = {}
    for ifc_type, expected_n in expected_counts.items():
        actual = len(f.by_type(ifc_type, include_subtypes=False))
        if actual != expected_n:
            mismatches[ifc_type] = {"expected": expected_n, "actual": actual}
    checks["entity-counts"] = {"ok": not mismatches, "mismatches": mismatches}

    # --- GlobalId duplicates ---
    guids = Counter(e.GlobalId for e in f.by_type("IfcRoot"))
    dup_count = sum(1 for _, n in guids.items() if n > 1)
    expected_dups = 1 if "duplicate-globalid" in planted else 0
    checks["guid-dups"] = {"ok": dup_count == expected_dups,
                           "expected": expected_dups, "actual": dup_count}

    # --- quantity totals vs the labeler's independent extraction ---
    sums = Counter()
    for rel in f.by_type("IfcRelDefinesByProperties"):
        qset = rel.RelatingPropertyDefinition
        if not qset.is_a("IfcElementQuantity") or qset.Name != "GymQuantities":
            continue
        for obj in rel.RelatedObjects:
            for q in qset.Quantities:
                if q.is_a("IfcQuantityVolume") and q.Name == "GrossVolume":
                    if obj.is_a("IfcWall"):
                        sums["wallGrossVolume"] += q.VolumeValue
                    elif obj.is_a("IfcSlab"):
                        sums["slabGrossVolume"] += q.VolumeValue
                    elif obj.is_a("IfcColumn"):
                        sums["columnGrossVolume"] += q.VolumeValue
                    elif obj.is_a("IfcBeam"):
                        sums["beamGrossVolume"] += q.VolumeValue
                elif q.is_a("IfcQuantityArea") and q.Name == "NetFloorArea" and obj.is_a("IfcSpace"):
                    sums["roomNetFloorArea"] += q.AreaValue
    labeler = entry.get("quantitiesExtracted") or {}
    qto_mismatches = {}
    for key in ["wallGrossVolume", "slabGrossVolume", "columnGrossVolume",
                "beamGrossVolume", "roomNetFloorArea"]:
        if key not in labeler:
            continue
        if not rel_close(sums.get(key, 0.0), labeler[key], REL_TOL_QTO):
            qto_mismatches[key] = {"oracle": sums.get(key, 0.0), "labeler": labeler[key]}
    checks["quantities"] = {"ok": not qto_mismatches, "mismatches": qto_mismatches}

    # --- geometry: mesh every product once, keep volumes and bboxes ---
    volumes = {}   # ifc type -> summed mesh volume
    bboxes = {}    # element Name -> bbox
    unmeshable = []
    degenerate_expected = {d for d in entry.get("degenerateElements", [])}
    for product in f.by_type("IfcProduct"):
        if not product.Representation:
            continue
        if product.is_a("IfcOpeningElement") or product.is_a("IfcSpace"):
            continue
        try:
            shape = ifcopenshell.geom.create_shape(GEOM_SETTINGS, product)
            vol, bbox = mesh_volume_and_bbox(shape)
        except Exception:  # noqa: BLE001
            unmeshable.append(product.Name)
            continue
        if vol == 0.0:
            unmeshable.append(product.Name)
            continue
        for t in ("IfcWall", "IfcSlab", "IfcColumn", "IfcBeam", "IfcFooting"):
            if product.is_a(t):
                volumes[t] = volumes.get(t, 0.0) + vol
        if product.Name:
            bboxes[product.Name] = bbox

    totals = entry.get("groundTruthTotals") or {}
    params = entry.get("params") or {}
    vol_mismatches = {}
    # Walls: ground truth is GROSS; the mesh is net of planted openings.
    if "wallGrossVolume" in totals:
        opening_vol = 0.0
        if params.get("family") == "frame":
            opening_vol = (entry.get("openingCount", 0)
                           * params.get("openingWidth", 0)
                           * params.get("openingHeight", 0)
                           * params.get("wallThickness", 0))
        expected_wall = totals["wallGrossVolume"] - opening_vol
        if not rel_close(volumes.get("IfcWall", 0.0), expected_wall, REL_TOL_VOLUME):
            vol_mismatches["wallNetVolume"] = {
                "oracle": volumes.get("IfcWall", 0.0), "expected": expected_wall}
    for key, t in (("slabGrossVolume", "IfcSlab"), ("columnGrossVolume", "IfcColumn"),
                   ("beamGrossVolume", "IfcBeam")):
        if key in totals:
            if not rel_close(volumes.get(t, 0.0), totals[key], REL_TOL_VOLUME):
                vol_mismatches[key] = {"oracle": volumes.get(t, 0.0), "expected": totals[key]}
    checks["geometry-volume"] = {"ok": not vol_mismatches, "mismatches": vol_mismatches}

    # --- planted clash pairs overlap in the oracle's geometry too ---
    pair_results = []
    for pair in entry.get("clashPairs", []):
        depth = aabb_overlap_depth_x(bboxes.get(pair["a"]), bboxes.get(pair["b"]))
        ok = depth is not None and abs(depth - pair["penetration"]) <= ABS_TOL_OVERLAP
        pair_results.append({"a": pair["a"], "b": pair["b"],
                             "expected": pair["penetration"], "oracleOverlap": depth, "ok": ok})
    checks["clash-pairs"] = {"ok": all(p["ok"] for p in pair_results), "pairs": pair_results}

    # --- planted degenerates are degenerate for the oracle too ---
    degen_missing = sorted(degenerate_expected - set(unmeshable))
    phantom = sorted(set(unmeshable) - degenerate_expected)
    checks["degenerate"] = {"ok": not degen_missing and not phantom,
                            "plantedNotDegenerateForOracle": degen_missing,
                            "unexpectedlyUnmeshable": phantom}

    return checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", required=True)
    ap.add_argument("--out")
    args = ap.parse_args()

    with open(args.sample) as fh:
        sample = json.load(fh)

    results = []
    check_totals = Counter()
    check_failures = Counter()
    for entry in sample["models"]:
        checks = check_model(entry)
        all_ok = all(c.get("ok") for c in checks.values())
        for name, c in checks.items():
            check_totals[name] += 1
            if not c.get("ok"):
                check_failures[name] += 1
        results.append({"seed": entry["seed"], "family": entry["family"],
                        "corrupted": entry["corrupted"], "allOk": all_ok,
                        "checks": checks})

    report = {
        "engine": f"IfcOpenShell {ifcopenshell.version}",
        "models": len(results),
        "clean": sum(1 for r in results if not r["corrupted"]),
        "corrupted": sum(1 for r in results if r["corrupted"]),
        "modelsAllOk": sum(1 for r in results if r["allOk"]),
        "perCheck": {name: {"evaluated": check_totals[name],
                            "failed": check_failures[name]}
                     for name in sorted(check_totals)},
        "failures": [r for r in results if not r["allOk"]][:50],
    }
    out_json = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(out_json)
    print(out_json)
    return 0 if report["modelsAllOk"] == report["models"] else 1


if __name__ == "__main__":
    sys.exit(main())
