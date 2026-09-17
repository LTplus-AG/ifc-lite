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


# =============================================================================
# Cost differential parity (issue #4859, parent #4322)
#
# A second, independent comparator sharing this file rather than a parallel
# module: the geometry comparator above and this one are two instantiations
# of the same pattern (two engines, a canonical record, a classifier that
# distinguishes real matches from real divergences), and keeping the cost
# variant IN this pre-existing file - rather than in its own new module -
# means a revert of only the cost-adding hunk leaves `compare.py` itself
# intact and importable, so `test_harness_cost.py`'s `import compare` always
# succeeds; the reverted hunk shows up as a missing attribute inside a test
# BODY (AssertionError/AttributeError - a real red), never as a collection-
# time ImportError that hides every assertion behind a load failure. See
# `scripts/check-test-revert-oracle.mjs` for why that distinction matters.
#
# Canonical cost schema (emitted by both `dump_reference_cost.py` and
# `dump_ifclite_cost.mjs`)::
#
#     {
#       "SchemaVersion": "IFC4" | "IFC4X3" | "IFC2X3" | ...,
#       "Currency": "<ISO 4217 code>" | null,
#       "HasCostData": bool,
#       "DiagnosticCodes": [code, ...]  (ifc-lite dump only; sorted unique
#         read-model diagnostic codes. Never compared as a value - it is the
#         paired marker DEGRADED:IFC2X3_PARTIAL_READ requires, see below),
#       "Schedules": { "<GlobalId>": { Name, Identification, PredefinedType,
#                                       Status, ItemGlobalIds: [GlobalId,...] } },
#       "Items": {
#         "<GlobalId>": {
#           Name, Identification, PredefinedType,
#           ParentGlobalId: GlobalId | null,
#           ChildGlobalIds: [GlobalId, ...] (sorted),
#           ScheduleGlobalIds: [GlobalId, ...] (sorted),
#           ProductGlobalIds: int (assignment COUNT - see dumper docstrings
#             for why identity isn't resolved here),
#           TaskGlobalIds: int (assignment count),
#           HasCostValues: bool,     # ABSENT vs PRESENT-but-empty distinction
#           HasCostQuantities: bool,
#           Values: [nodePath, ...], Quantities: [nodePath, ...],
#           ResolvedTotal: { Amount: number, Currency } | null
#             (the resolution of the item's FIRST CostValue node, not an
#             evaluator total: every value node's own Resolved is compared
#             separately below, so no value escapes comparison),
#         }
#       },
#       "Nodes": {
#         "<path>": { "SharedWith": "<other path>" }
#                   | { Kind: "Value", Type, Name, Category, Condition,
#                       ArithmeticOperator, Applied, Components,
#                       UnitBasisNode, Resolved }
#                   | { Kind: "Measure", Type: "IfcMeasureWithUnit",
#                       ValueType, Value, UnitNode, Resolved }
#                     (an IfcMeasureWithUnit reached as a value's
#                     AppliedValue - Applied {Kind: "Reference", Node:
#                     "<path>/ref"} - or as its UnitBasis at
#                     "<path>/unitBasis"; its UnitComponent is the Unit node
#                     at "<measure path>/unit")
#                   | { Kind: "Quantity", Type, Name, Dimension, Value }
#                   | { Kind: "Unit", Type, UnitType, Currency, Symbol, Dimension }
#                   | { Kind: ..., Missing: true }
#       }
#     }
#
# Node paths are deterministic strings derived only from GlobalId + IFC
# ordered-attribute position (e.g. "item:<GlobalId>/value/0"), never from
# express id - see the `NodeRegistry` docstrings in both dumpers for why this
# makes shared-reference identity comparable across two independent engines.
#
# Classification
# ---------------
#
# Every comparable fact (a Schedule, an Item, a Node, a scalar field) is
# classified as exactly one of:
#
# - COST_MATCH: values agree (numeric fields compared with
#   COST_NUMERIC_TOLERANCE).
# - DEGRADED:<name>: a mismatch in one of the two *explicitly enumerated*
#   degradation categories below, each of which requires BOTH sides to carry
#   a specific paired diagnostic/marker that explains the divergence. A
#   mismatch that isn't one of these two named, evidenced cases is never
#   absorbed here.
# - COST_FAILURE: everything else - including a GlobalId present on only one
#   side, any structural (parent/child/shared-reference) disagreement, and
#   any numeric disagreement outside tolerance.
#
# Enumerated degradations (closed set - DO NOT add a bare "give it a pass"
# category here without a paired diagnostic; see #4859's review guidance):
#
#   DEGRADED:IFC2X3_PARTIAL_READ
#     ifc-lite reports a value node's Resolved as null while the reference
#     resolves a number, PAIRED with the ifc-lite dump's own DiagnosticCodes
#     carrying 'IFC2X3_PARTIAL_READ' (the read model declaring it did not
#     evaluate values). Scoped to schema_version == 'IFC2X3'. A NON-null
#     ifc-lite number that disagrees is a FAILURE even on IFC2X3.
#
#   DEGRADED:CURRENCY_UNRESOLVED
#     ifc-lite reports Currency as null on a ResolvedTotal/Node while the
#     reference resolves a currency code, PAIRED with the model-level
#     `Currency` field also being null in the ifc-lite dump (i.e. ifc-lite
#     could not resolve *any* project currency, not a spot omission). A lite
#     ResolvedTotal missing its currency while the lite model-level Currency
#     IS resolved is a FAILURE.
#
# A row that "matches" only because BOTH sides are empty is refused outright:
# `compare_cost()` raises before classifying anything if the reference
# dump's own `HasCostData` is false, or if it has zero Items - an
# empty-vs-empty comparison proves nothing about parity and must not report
# success.
# =============================================================================

COST_NUMERIC_TOLERANCE = 1e-6

COST_MATCH = "MATCH"
COST_FAILURE = "FAILURE"


def cost_degraded(name: str) -> str:
    return f"DEGRADED:{name}"


def _cost_norm_type(value):
    """IFC type names are compared case-insensitively: the ifc-lite dumper
    reports the STEP source literal casing (often upper-case), IfcOpenShell
    reports its canonical mixed-case spelling. Neither is more "correct" -
    the STEP standard itself is case-insensitive for keywords - so this is a
    formatting normalization, not a semantic degradation."""
    return value.upper() if isinstance(value, str) else value


def _cost_numbers_close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    try:
        return abs(float(a) - float(b)) <= COST_NUMERIC_TOLERANCE
    except (TypeError, ValueError):
        return a == b


class CostReport:
    def __init__(self):
        self.rows = []  # (path, status, detail)

    def add(self, path, status, detail=""):
        self.rows.append((path, status, detail))

    @property
    def failures(self):
        return [r for r in self.rows if r[1] == COST_FAILURE]

    @property
    def degradations(self):
        return [r for r in self.rows if r[1].startswith("DEGRADED:")]

    @property
    def matches(self):
        return [r for r in self.rows if r[1] == COST_MATCH]

    def summary(self):
        return {
            "matches": len(self.matches),
            "degradations": len(self.degradations),
            "failures": len(self.failures),
        }


def compare_cost_scalar(report, path, lite_value, ref_value, *, numeric=False):
    if numeric:
        ok = _cost_numbers_close(lite_value, ref_value)
    else:
        ok = lite_value == ref_value
    if ok:
        report.add(path, COST_MATCH)
    else:
        report.add(path, COST_FAILURE, f"lite={lite_value!r} ref={ref_value!r}")


def compare_cost_node(report, path, lite_nodes, ref_nodes, lite_schema, lite_diagnostic_codes):
    lite_node = lite_nodes.get(path)
    ref_node = ref_nodes.get(path)
    if lite_node is None or ref_node is None:
        report.add(f"node:{path}", COST_FAILURE, f"missing on {'lite' if lite_node is None else 'ref'} side")
        return

    lite_shared = lite_node.get("SharedWith")
    ref_shared = ref_node.get("SharedWith")
    if lite_shared is not None or ref_shared is not None:
        if lite_shared != ref_shared:
            report.add(f"node:{path}/SharedWith", COST_FAILURE, f"lite={lite_shared!r} ref={ref_shared!r}")
        else:
            report.add(f"node:{path}/SharedWith", COST_MATCH)
        return

    if lite_node.get("Missing") or ref_node.get("Missing"):
        if bool(lite_node.get("Missing")) != bool(ref_node.get("Missing")):
            report.add(f"node:{path}/Missing", COST_FAILURE, f"lite={lite_node} ref={ref_node}")
        else:
            report.add(f"node:{path}/Missing", COST_MATCH)
        # Both-missing is only a match for the SAME kind of dangling node: a
        # missing Value and a missing Measure are different divergences.
        kind_ok = lite_node.get("Kind") == ref_node.get("Kind")
        report.add(f"node:{path}/Kind", COST_MATCH if kind_ok else COST_FAILURE,
                   f"lite={lite_node.get('Kind')} ref={ref_node.get('Kind')}")
        type_ok = _cost_norm_type(lite_node.get("Type")) == _cost_norm_type(ref_node.get("Type"))
        report.add(f"node:{path}/Type", COST_MATCH if type_ok else COST_FAILURE,
                   f"lite={lite_node.get('Type')} ref={ref_node.get('Type')}")
        return

    kind_ok = lite_node.get("Kind") == ref_node.get("Kind")
    report.add(f"node:{path}/Kind", COST_MATCH if kind_ok else COST_FAILURE,
               f"lite={lite_node.get('Kind')} ref={ref_node.get('Kind')}")

    type_ok = _cost_norm_type(lite_node.get("Type")) == _cost_norm_type(ref_node.get("Type"))
    report.add(f"node:{path}/Type", COST_MATCH if type_ok else COST_FAILURE,
               f"lite={lite_node.get('Type')} ref={ref_node.get('Type')}")

    if lite_node.get("Kind") == "Value" or ref_node.get("Kind") == "Value":
        for field in ("Name", "Category", "Condition"):
            compare_cost_scalar(report, f"node:{path}/{field}", lite_node.get(field), ref_node.get(field))

        lite_applied = lite_node.get("Applied")
        ref_applied = ref_node.get("Applied")
        if (lite_applied is None) != (ref_applied is None):
            report.add(f"node:{path}/Applied", COST_FAILURE, f"lite={lite_applied} ref={ref_applied}")
        elif lite_applied is not None:
            kind_ok = lite_applied.get("Kind") == ref_applied.get("Kind")
            if lite_applied.get("Kind") == "Typed":
                type_ok = _cost_norm_type(lite_applied.get("Type")) == _cost_norm_type(ref_applied.get("Type"))
                val_ok = _cost_numbers_close(lite_applied.get("Value"), ref_applied.get("Value"))
                report.add(f"node:{path}/Applied", COST_MATCH if (kind_ok and type_ok and val_ok) else COST_FAILURE,
                           f"lite={lite_applied} ref={ref_applied}")
            elif lite_applied.get("Kind") == "Reference":
                ref_ok = lite_applied.get("Node") == ref_applied.get("Node")
                report.add(f"node:{path}/Applied", COST_MATCH if (kind_ok and ref_ok) else COST_FAILURE,
                           f"lite={lite_applied} ref={ref_applied}")
            else:
                report.add(f"node:{path}/Applied", COST_MATCH if kind_ok else COST_FAILURE, f"lite={lite_applied} ref={ref_applied}")
        else:
            report.add(f"node:{path}/Applied", COST_MATCH)

        op_ok = lite_node.get("ArithmeticOperator") == ref_node.get("ArithmeticOperator")
        report.add(f"node:{path}/ArithmeticOperator", COST_MATCH if op_ok else COST_FAILURE,
                   f"lite={lite_node.get('ArithmeticOperator')} ref={ref_node.get('ArithmeticOperator')}")

        comp_ok = (lite_node.get("Components") or []) == (ref_node.get("Components") or [])
        report.add(f"node:{path}/Components", COST_MATCH if comp_ok else COST_FAILURE,
                   f"lite={lite_node.get('Components')} ref={ref_node.get('Components')}")

        # A UnitBasis is a rate ("per N units") - dropping or mismatching it
        # is an order-of-magnitude error, not a rounding one, so any
        # divergence (including None on one side only) is a FAILURE; there
        # is no named degradation for it. None on both sides is a match.
        unit_basis_ok = lite_node.get("UnitBasisNode") == ref_node.get("UnitBasisNode")
        report.add(f"node:{path}/UnitBasisNode", COST_MATCH if unit_basis_ok else COST_FAILURE,
                   f"lite={lite_node.get('UnitBasisNode')} ref={ref_node.get('UnitBasisNode')}")

        resolved_ok = _cost_numbers_close(lite_node.get("Resolved"), ref_node.get("Resolved"))
        partial_read = (
            lite_schema == "IFC2X3"
            and "IFC2X3_PARTIAL_READ" in lite_diagnostic_codes
            and lite_node.get("Resolved") is None
            and ref_node.get("Resolved") is not None
        )
        if not resolved_ok and partial_read:
            report.add(f"node:{path}/Resolved", cost_degraded("IFC2X3_PARTIAL_READ"),
                       f"lite={lite_node.get('Resolved')} ref={ref_node.get('Resolved')}")
        else:
            report.add(f"node:{path}/Resolved", COST_MATCH if resolved_ok else COST_FAILURE,
                       f"lite={lite_node.get('Resolved')} ref={ref_node.get('Resolved')}")

    if lite_node.get("Kind") == "Measure" or ref_node.get("Kind") == "Measure":
        value_type_ok = _cost_norm_type(lite_node.get("ValueType")) == _cost_norm_type(ref_node.get("ValueType"))
        report.add(f"node:{path}/ValueType", COST_MATCH if value_type_ok else COST_FAILURE,
                   f"lite={lite_node.get('ValueType')} ref={ref_node.get('ValueType')}")
        val_ok = _cost_numbers_close(lite_node.get("Value"), ref_node.get("Value"))
        report.add(f"node:{path}/Value", COST_MATCH if val_ok else COST_FAILURE,
                   f"lite={lite_node.get('Value')} ref={ref_node.get('Value')}")
        compare_cost_scalar(report, f"node:{path}/UnitNode", lite_node.get("UnitNode"), ref_node.get("UnitNode"))
        # Resolved is what a parent value's arithmetic reads, so it is compared
        # in its own right even though both dumpers derive it from Value today.
        resolved_ok = _cost_numbers_close(lite_node.get("Resolved"), ref_node.get("Resolved"))
        report.add(f"node:{path}/Resolved", COST_MATCH if resolved_ok else COST_FAILURE,
                   f"lite={lite_node.get('Resolved')} ref={ref_node.get('Resolved')}")

    if lite_node.get("Kind") == "Quantity" or ref_node.get("Kind") == "Quantity":
        compare_cost_scalar(report, f"node:{path}/Name", lite_node.get("Name"), ref_node.get("Name"))
        dim_ok = lite_node.get("Dimension") == ref_node.get("Dimension")
        report.add(f"node:{path}/Dimension", COST_MATCH if dim_ok else COST_FAILURE,
                   f"lite={lite_node.get('Dimension')} ref={ref_node.get('Dimension')}")
        val_ok = _cost_numbers_close(lite_node.get("Value"), ref_node.get("Value"))
        report.add(f"node:{path}/Value", COST_MATCH if val_ok else COST_FAILURE,
                   f"lite={lite_node.get('Value')} ref={ref_node.get('Value')}")

    if lite_node.get("Kind") == "Unit" or ref_node.get("Kind") == "Unit":
        compare_cost_scalar(report, f"node:{path}/UnitType", lite_node.get("UnitType"), ref_node.get("UnitType"))
        currency_ok = lite_node.get("Currency") == ref_node.get("Currency")
        report.add(f"node:{path}/Currency", COST_MATCH if currency_ok else COST_FAILURE,
                   f"lite={lite_node.get('Currency')} ref={ref_node.get('Currency')}")


def compare_cost(lite, ref):
    """Compare two canonical cost dumps. Returns a CostReport.

    Raises ValueError if the REFERENCE dump itself is empty of cost data -
    an empty-vs-empty comparison proves nothing and must never be allowed to
    report success (see module docstring and packages/renderer/src/entity-
    visibility.ts's isEntityVisible convention this mirrors)."""
    if not ref.get("HasCostData") or len(ref.get("Items", {})) == 0:
        raise ValueError(
            "reference dump reports no cost data (HasCostData=false or zero "
            "Items) - refusing to compare; this would be a vacuous pass"
        )

    report = CostReport()
    lite_schema = lite.get("SchemaVersion")

    compare_cost_scalar(report, "SchemaVersion", lite.get("SchemaVersion"), ref.get("SchemaVersion"))
    compare_cost_scalar(report, "HasCostData", lite.get("HasCostData"), ref.get("HasCostData"))

    lite_currency = lite.get("Currency")
    ref_currency = ref.get("Currency")
    if lite_currency != ref_currency:
        if lite_currency is None and ref_currency is not None:
            report.add("Currency", cost_degraded("CURRENCY_UNRESOLVED"), f"lite=None ref={ref_currency!r}")
        else:
            report.add("Currency", COST_FAILURE, f"lite={lite_currency!r} ref={ref_currency!r}")
    else:
        report.add("Currency", COST_MATCH)

    lite_schedules = lite.get("Schedules", {})
    ref_schedules = ref.get("Schedules", {})
    for gid in sorted(set(lite_schedules) | set(ref_schedules)):
        if gid not in lite_schedules or gid not in ref_schedules:
            report.add(f"schedule:{gid}", COST_FAILURE, f"present only on {'ref' if gid not in lite_schedules else 'lite'}")
            continue
        a, b = lite_schedules[gid], ref_schedules[gid]
        for field in ("Name", "Identification", "PredefinedType", "Status"):
            compare_cost_scalar(report, f"schedule:{gid}/{field}", a.get(field), b.get(field))
        compare_cost_scalar(report, f"schedule:{gid}/ItemGlobalIds", a.get("ItemGlobalIds"), b.get("ItemGlobalIds"))

    lite_items = lite.get("Items", {})
    ref_items = ref.get("Items", {})
    lite_diagnostic_codes = set(lite.get("DiagnosticCodes") or ())
    for gid in sorted(set(lite_items) | set(ref_items)):
        if gid not in lite_items or gid not in ref_items:
            report.add(f"item:{gid}", COST_FAILURE, f"present only on {'ref' if gid not in lite_items else 'lite'}")
            continue
        a, b = lite_items[gid], ref_items[gid]
        for field in ("Name", "Identification", "PredefinedType", "ParentGlobalId",
                      "ChildGlobalIds", "ScheduleGlobalIds", "ProductGlobalIds",
                      "TaskGlobalIds", "HasCostValues", "HasCostQuantities",
                      "Values", "Quantities"):
            compare_cost_scalar(report, f"item:{gid}/{field}", a.get(field), b.get(field))

        a_total, b_total = a.get("ResolvedTotal"), b.get("ResolvedTotal")
        if (a_total is None) != (b_total is None):
            report.add(f"item:{gid}/ResolvedTotal", COST_FAILURE, f"lite={a_total} ref={b_total}")
        elif a_total is not None:
            amount_ok = _cost_numbers_close(a_total.get("Amount"), b_total.get("Amount"))
            currency_ok = a_total.get("Currency") == b_total.get("Currency")
            if amount_ok and currency_ok:
                report.add(f"item:{gid}/ResolvedTotal", COST_MATCH)
            elif amount_ok and not currency_ok and a_total.get("Currency") is None and lite_currency is None:
                report.add(f"item:{gid}/ResolvedTotal/Currency", cost_degraded("CURRENCY_UNRESOLVED"),
                           f"lite={a_total} ref={b_total}")
            else:
                report.add(f"item:{gid}/ResolvedTotal", COST_FAILURE, f"lite={a_total} ref={b_total}")
        else:
            report.add(f"item:{gid}/ResolvedTotal", COST_MATCH)

    lite_nodes = lite.get("Nodes", {})
    ref_nodes = ref.get("Nodes", {})
    for path in sorted(set(lite_nodes) | set(ref_nodes)):
        compare_cost_node(report, path, lite_nodes, ref_nodes, lite_schema, lite_diagnostic_codes)

    return report


if __name__ == "__main__":
    sys.exit(main())
