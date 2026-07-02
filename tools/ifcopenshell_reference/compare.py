# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Join a reference dump against an ifc-lite dump and classify every element.

Usage:
    python compare.py --reference ref.json --ifclite lite.json \
        [--allowlist allowlist.json] [--report out.json]

Classes:
    MATCH           both ok, all gated stats within tolerance
    MISMATCH        both ok, a gated stat out of tolerance      -> fails
    IFCLITE_ONLY    ifc-lite produced geometry, reference skipped
    REFERENCE_ONLY  reference produced geometry, ifc-lite skipped -> fails
    BOTH_SKIP       agreement on no-geometry

Gating policy (calibrated against the previously hand-baked constants in
door_window_calibration_regression.rs AND a full duplex run): METRIC truth
gates, topology is advisory.
    bbox min/max   GATED, within 1 mm per axis
    volume         GATED, relative 1%, only when BOTH sides are closed
    tri_count      ADVISORY (flagged in the report beyond a 50%/16-triangle
                   band, never failing): the engines legitimately triangulate
                   identical solids at different densities - duplex wall #5448
                   is 92 vs 308 triangles with the SAME 1 mm bbox and volumes
                   agreeing to 0.001%, and exact-CSG retriangulation densifies
                   cut faces by design. A dropped feature shows up in bbox or
                   volume; triangle counts alone would keep the gate
                   permanently red over healthy divergence.
    vertex_count   NOT EVALUATED: carried in the dumps for human diffing
                   only - welding topology differs legitimately (duplex #6426:
                   identical bbox + tri_count, 56 vs 48 welded verts), so
                   classify() neither gates nor flags it; `closed` likewise
                   feeds only the volume-usability checks above.

An allowlisted MISMATCH/REFERENCE_ONLY is reported but does not fail, so
every accepted divergence is a reviewed, diffable decision. Exit code is
non-zero iff a non-allowlisted MISMATCH or REFERENCE_ONLY exists.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BBOX_TOL_M = 0.001
VOLUME_REL_TOL = 0.01
TRI_REL_TOL = 0.5
TRI_ABS_SLACK = 16


def load(path: Path) -> dict:
    doc = json.loads(path.read_text())
    return {e["express_id"]: e for e in doc["elements"]}, doc


def bbox_close(a: dict, b: dict) -> bool:
    return all(
        abs(a[k][i] - b[k][i]) <= BBOX_TOL_M for k in ("min", "max") for i in range(3)
    )


def classify(ref: dict | None, lite: dict | None) -> tuple[str, list[str], list[str]]:
    """Return (class, failing stats, advisory stats)."""
    ref_ok = ref is not None and ref["status"] == "ok"
    lite_ok = lite is not None and lite["status"] == "ok"
    if not ref_ok and not lite_ok:
        return "BOTH_SKIP", [], []
    if ref_ok and not lite_ok:
        return "REFERENCE_ONLY", [], []
    if lite_ok and not ref_ok:
        return "IFCLITE_ONLY", [], []

    failing: list[str] = []
    advisory: list[str] = []
    if not bbox_close(ref["bbox"], lite["bbox"]):
        failing.append("bbox")
    tri_delta = abs(ref["tri_count"] - lite["tri_count"])
    tri_band = max(TRI_ABS_SLACK, int(ref["tri_count"] * TRI_REL_TOL))
    if tri_delta > tri_band:
        advisory.append("tri_count")
    # A mesh's true volume cannot exceed its bbox volume; a side that reports
    # more has mixed triangle winding poisoning the signed-tetra sum (seen on
    # duplex IfcCoverings: reference 6.34 m3 inside a 0.18 m3 bbox while
    # ifc-lite matched the analytic slab volume). Such a side's volume is
    # unusable evidence, so the gate is skipped and flagged advisory.
    def usable_volume(e: dict) -> bool:
        if not (e.get("closed") and e.get("volume")):
            return False
        ext = [e["bbox"]["max"][i] - e["bbox"]["min"][i] for i in range(3)]
        bbox_vol = ext[0] * ext[1] * ext[2]
        return bbox_vol > 0 and e["volume"] <= bbox_vol * 1.001

    ref_vol_ok = usable_volume(ref)
    lite_vol_ok = usable_volume(lite)
    if ref_vol_ok and lite_vol_ok:
        rv, lv = ref["volume"], lite["volume"]
        if rv > 0 and abs(rv - lv) / rv > VOLUME_REL_TOL:
            failing.append("volume")
    elif (ref.get("closed") and ref.get("volume") and not ref_vol_ok) or (
        lite.get("closed") and lite.get("volume") and not lite_vol_ok
    ):
        # A reported volume exceeding its own bbox volume is a mixed-winding
        # artifact - that side's figure is not evidence of anything.
        advisory.append("volume-unverifiable")
    elif ref_vol_ok != lite_vol_ok:
        # Exactly one side has usable volume evidence (closed vs open).
        # GATING here would turn the calibrated welding-topology asymmetry
        # (duplex: 200+ healthy elements where ifc-lite's edge-pairing reports
        # open while the reference is closed) permanently red, so it stays
        # advisory - but it is the harness's known blind spot: an interior
        # regression that keeps the bbox and only breaks the volume-less side
        # is not gated at the stats level. The nightly report surfaces these
        # rows for review; topology-level comparison is the planned later phase.
        advisory.append("volume-one-sided")
    return ("MISMATCH" if failing else "MATCH"), failing, advisory


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", type=Path, required=True)
    ap.add_argument("--ifclite", type=Path, required=True)
    ap.add_argument("--allowlist", type=Path)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--top", type=int, default=10, help="mismatches to print")
    args = ap.parse_args()

    ref_by_id, ref_doc = load(args.reference)
    lite_by_id, lite_doc = load(args.ifclite)
    if ref_doc["sha256"] != lite_doc["sha256"]:
        print(
            f"FATAL: dumps are from different fixture bytes "
            f"({ref_doc['sha256'][:12]} vs {lite_doc['sha256'][:12]})"
        )
        return 2

    # Allowlist: {"<fixture>": {"<express_id>": "reason", "type:<IfcType>": "reason"}}
    allow: dict = {}
    if args.allowlist and args.allowlist.exists():
        allow = json.loads(args.allowlist.read_text()).get(ref_doc["fixture"], {})

    def allowed(eid: int, ifc_type: str) -> str | None:
        return allow.get(str(eid)) or allow.get(f"type:{ifc_type}")

    counts: dict[str, int] = {}
    failures: list[dict] = []
    allowed_divergences: list[dict] = []
    rows: list[dict] = []
    for eid in sorted(set(ref_by_id) | set(lite_by_id)):
        ref, lite = ref_by_id.get(eid), lite_by_id.get(eid)
        cls, failing, advisory = classify(ref, lite)
        counts[cls] = counts.get(cls, 0) + 1
        if advisory:
            counts["advisory"] = counts.get("advisory", 0) + 1
        ifc_type = (ref or lite)["ifc_type"]
        row = {
            "express_id": eid,
            "ifc_type": ifc_type,
            "class": cls,
            "failing": failing,
            "advisory": advisory,
        }
        rows.append(row)
        if cls in ("MISMATCH", "REFERENCE_ONLY"):
            reason = allowed(eid, ifc_type)
            if reason:
                allowed_divergences.append({**row, "allowlisted": reason})
            else:
                failures.append(row)

    print(f"fixture: {ref_doc['fixture']} ({ref_doc['engine']} vs {lite_doc['engine']})")
    for cls in ("MATCH", "MISMATCH", "IFCLITE_ONLY", "REFERENCE_ONLY", "BOTH_SKIP"):
        if counts.get(cls):
            print(f"  {cls:<15} {counts[cls]}")
    if counts.get("advisory"):
        print(f"  advisory        {counts['advisory']} (tri_count density; see report)")
    if allowed_divergences:
        print(f"  allowlisted     {len(allowed_divergences)}")
    for f in failures[: args.top]:
        print(f"  FAIL #{f['express_id']} {f['ifc_type']}: {', '.join(f['failing']) or f['class']}")
    if len(failures) > args.top:
        print(f"  ... and {len(failures) - args.top} more failures")

    if args.report:
        args.report.write_text(
            json.dumps(
                {
                    "fixture": ref_doc["fixture"],
                    "counts": counts,
                    "failures": failures,
                    "allowlisted": allowed_divergences,
                    "elements": rows,
                },
                indent=1,
                sort_keys=True,
            )
            + "\n"
        )

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
