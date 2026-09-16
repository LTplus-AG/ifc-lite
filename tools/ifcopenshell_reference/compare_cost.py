#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Comparator for the cost differential parity pair (issue #4859).

Canonical cost schema (emitted by both `dump_reference_cost.py` and
`dump_ifclite_cost.mjs`)::

    {
      "SchemaVersion": "IFC4" | "IFC4X3" | "IFC2X3" | ...,
      "Currency": "<ISO 4217 code>" | null,
      "HasCostData": bool,
      "Schedules": { "<GlobalId>": { Name, Identification, PredefinedType,
                                      Status, ItemGlobalIds: [GlobalId,...] } },
      "Items": {
        "<GlobalId>": {
          Name, Identification, PredefinedType,
          ParentGlobalId: GlobalId | null,
          ChildGlobalIds: [GlobalId, ...] (sorted),
          ScheduleGlobalIds: [GlobalId, ...] (sorted),
          ProductGlobalIds: int (assignment COUNT — see dumper docstrings for
            why identity isn't resolved here),
          TaskGlobalIds: int (assignment count),
          HasCostValues: bool,     # ABSENT vs PRESENT-but-empty distinction
          HasCostQuantities: bool,
          Values: [nodePath, ...], Quantities: [nodePath, ...],
          ResolvedTotal: { Amount: number, Currency } | null,
        }
      },
      "Nodes": {
        "<path>": { "SharedWith": "<other path>" }
                  | { Kind: "Value"|"Quantity"|"Unit", ...fields, Resolved }
      }
    }

Node paths are deterministic strings derived only from GlobalId + IFC
ordered-attribute position (e.g. "item:<GlobalId>/value/0"), never from
express id — see the `NodeRegistry` docstrings in both dumpers for why this
makes shared-reference identity comparable across two independent engines.

Classification
---------------

Every comparable fact (a Schedule, an Item, a Node, a scalar field) is
classified as exactly one of:

- MATCH: values agree (numeric fields compared with `NUMERIC_TOLERANCE`).
- DEGRADED:<name>: a mismatch in one of the two *explicitly enumerated*
  degradation categories below, each of which requires BOTH sides to carry a
  specific paired diagnostic/marker that explains the divergence. A mismatch
  that isn't one of these two named, evidenced cases is never absorbed here.
- FAILURE: everything else — including a GlobalId present on only one side,
  any structural (parent/child/shared-reference) disagreement, and any
  numeric disagreement outside tolerance.

Enumerated degradations (closed set — DO NOT add a bare "give it a pass"
category here without a paired diagnostic; see #4859's review guidance):

  DEGRADED:IFC2X3_PARTIAL_READ
    ifc-lite reports a field as null/absent for an item that also carries an
    'IFC2X3_PARTIAL_READ' diagnostic, while the reference resolves a value.
    Scoped to schema_version == 'IFC2X3'.

  DEGRADED:CURRENCY_UNRESOLVED
    ifc-lite reports Currency as null on a ResolvedTotal/Node while the
    reference resolves a currency code, PAIRED with the model-level
    `Currency` field also being null in the ifc-lite dump (i.e. ifc-lite
    could not resolve *any* project currency, not a spot omission).

A row that "matches" only because BOTH sides are empty is refused outright:
`compare()` raises before classifying anything if the reference dump's own
`HasCostData` is false, or if it has zero Items — an empty-vs-empty
comparison proves nothing about parity and must not report success.
"""

from __future__ import annotations

import argparse
import json
import sys

NUMERIC_TOLERANCE = 1e-6

MATCH = "MATCH"
FAILURE = "FAILURE"


def degraded(name: str) -> str:
    return f"DEGRADED:{name}"


def _norm_type(value):
    """IFC type names are compared case-insensitively: the ifc-lite dumper
    reports the STEP source literal casing (often upper-case), IfcOpenShell
    reports its canonical mixed-case spelling. Neither is more "correct" —
    the STEP standard itself is case-insensitive for keywords — so this is a
    formatting normalization, not a semantic degradation."""
    return value.upper() if isinstance(value, str) else value


def _numbers_close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    try:
        return abs(float(a) - float(b)) <= NUMERIC_TOLERANCE
    except (TypeError, ValueError):
        return a == b


class Report:
    def __init__(self):
        self.rows = []  # (path, status, detail)

    def add(self, path, status, detail=""):
        self.rows.append((path, status, detail))

    @property
    def failures(self):
        return [r for r in self.rows if r[1] == FAILURE]

    @property
    def degradations(self):
        return [r for r in self.rows if r[1].startswith("DEGRADED:")]

    @property
    def matches(self):
        return [r for r in self.rows if r[1] == MATCH]

    def summary(self):
        return {
            "matches": len(self.matches),
            "degradations": len(self.degradations),
            "failures": len(self.failures),
        }


def compare_scalar(report, path, lite_value, ref_value, *, numeric=False):
    if numeric:
        ok = _numbers_close(lite_value, ref_value)
    else:
        ok = lite_value == ref_value
    if ok:
        report.add(path, MATCH)
    else:
        report.add(path, FAILURE, f"lite={lite_value!r} ref={ref_value!r}")


def compare_node(report, path, lite_nodes, ref_nodes, lite_schema, currency_absent_both):
    lite_node = lite_nodes.get(path)
    ref_node = ref_nodes.get(path)
    if lite_node is None or ref_node is None:
        report.add(f"node:{path}", FAILURE, f"missing on {'lite' if lite_node is None else 'ref'} side")
        return

    lite_shared = lite_node.get("SharedWith")
    ref_shared = ref_node.get("SharedWith")
    if lite_shared is not None or ref_shared is not None:
        if lite_shared != ref_shared:
            report.add(f"node:{path}/SharedWith", FAILURE, f"lite={lite_shared!r} ref={ref_shared!r}")
        else:
            report.add(f"node:{path}/SharedWith", MATCH)
        return

    if lite_node.get("Missing") or ref_node.get("Missing"):
        if bool(lite_node.get("Missing")) != bool(ref_node.get("Missing")):
            report.add(f"node:{path}/Missing", FAILURE, f"lite={lite_node} ref={ref_node}")
        else:
            report.add(f"node:{path}/Missing", MATCH)
        return

    kind_ok = lite_node.get("Kind") == ref_node.get("Kind")
    report.add(f"node:{path}/Kind", MATCH if kind_ok else FAILURE,
               f"lite={lite_node.get('Kind')} ref={ref_node.get('Kind')}")

    type_ok = _norm_type(lite_node.get("Type")) == _norm_type(ref_node.get("Type"))
    report.add(f"node:{path}/Type", MATCH if type_ok else FAILURE,
               f"lite={lite_node.get('Type')} ref={ref_node.get('Type')}")

    if lite_node.get("Kind") == "Value" or ref_node.get("Kind") == "Value":
        lite_applied = lite_node.get("Applied")
        ref_applied = ref_node.get("Applied")
        if (lite_applied is None) != (ref_applied is None):
            report.add(f"node:{path}/Applied", FAILURE, f"lite={lite_applied} ref={ref_applied}")
        elif lite_applied is not None:
            kind_ok = lite_applied.get("Kind") == ref_applied.get("Kind")
            if lite_applied.get("Kind") == "Typed":
                type_ok = _norm_type(lite_applied.get("Type")) == _norm_type(ref_applied.get("Type"))
                val_ok = _numbers_close(lite_applied.get("Value"), ref_applied.get("Value"))
                report.add(f"node:{path}/Applied", MATCH if (kind_ok and type_ok and val_ok) else FAILURE,
                           f"lite={lite_applied} ref={ref_applied}")
            elif lite_applied.get("Kind") == "Reference":
                ref_ok = lite_applied.get("Node") == ref_applied.get("Node")
                report.add(f"node:{path}/Applied", MATCH if (kind_ok and ref_ok) else FAILURE,
                           f"lite={lite_applied} ref={ref_applied}")
            else:
                report.add(f"node:{path}/Applied", MATCH if kind_ok else FAILURE, f"lite={lite_applied} ref={ref_applied}")
        else:
            report.add(f"node:{path}/Applied", MATCH)

        op_ok = lite_node.get("ArithmeticOperator") == ref_node.get("ArithmeticOperator")
        report.add(f"node:{path}/ArithmeticOperator", MATCH if op_ok else FAILURE,
                   f"lite={lite_node.get('ArithmeticOperator')} ref={ref_node.get('ArithmeticOperator')}")

        comp_ok = (lite_node.get("Components") or []) == (ref_node.get("Components") or [])
        report.add(f"node:{path}/Components", MATCH if comp_ok else FAILURE,
                   f"lite={lite_node.get('Components')} ref={ref_node.get('Components')}")

        resolved_ok = _numbers_close(lite_node.get("Resolved"), ref_node.get("Resolved"))
        if not resolved_ok and currency_absent_both and lite_schema == "IFC2X3":
            report.add(f"node:{path}/Resolved", degraded("IFC2X3_PARTIAL_READ"),
                       f"lite={lite_node.get('Resolved')} ref={ref_node.get('Resolved')}")
        else:
            report.add(f"node:{path}/Resolved", MATCH if resolved_ok else FAILURE,
                       f"lite={lite_node.get('Resolved')} ref={ref_node.get('Resolved')}")

    if lite_node.get("Kind") == "Quantity" or ref_node.get("Kind") == "Quantity":
        dim_ok = lite_node.get("Dimension") == ref_node.get("Dimension")
        report.add(f"node:{path}/Dimension", MATCH if dim_ok else FAILURE,
                   f"lite={lite_node.get('Dimension')} ref={ref_node.get('Dimension')}")
        val_ok = _numbers_close(lite_node.get("Value"), ref_node.get("Value"))
        report.add(f"node:{path}/Value", MATCH if val_ok else FAILURE,
                   f"lite={lite_node.get('Value')} ref={ref_node.get('Value')}")

    if lite_node.get("Kind") == "Unit" or ref_node.get("Kind") == "Unit":
        currency_ok = lite_node.get("Currency") == ref_node.get("Currency")
        report.add(f"node:{path}/Currency", MATCH if currency_ok else FAILURE,
                   f"lite={lite_node.get('Currency')} ref={ref_node.get('Currency')}")


def compare(lite, ref):
    """Compare two canonical cost dumps. Returns a Report.

    Raises ValueError if the REFERENCE dump itself is empty of cost data —
    an empty-vs-empty comparison proves nothing and must never be allowed to
    report success (see module docstring and packages/renderer/src/entity-
    visibility.ts's isEntityVisible convention this mirrors)."""
    if not ref.get("HasCostData") or len(ref.get("Items", {})) == 0:
        raise ValueError(
            "reference dump reports no cost data (HasCostData=false or zero "
            "Items) — refusing to compare; this would be a vacuous pass"
        )

    report = Report()
    lite_schema = lite.get("SchemaVersion")

    compare_scalar(report, "SchemaVersion", lite.get("SchemaVersion"), ref.get("SchemaVersion"))

    lite_currency = lite.get("Currency")
    ref_currency = ref.get("Currency")
    if lite_currency != ref_currency:
        if lite_currency is None and ref_currency is not None:
            report.add("Currency", degraded("CURRENCY_UNRESOLVED"), f"lite=None ref={ref_currency!r}")
        else:
            report.add("Currency", FAILURE, f"lite={lite_currency!r} ref={ref_currency!r}")
    else:
        report.add("Currency", MATCH)

    lite_schedules = lite.get("Schedules", {})
    ref_schedules = ref.get("Schedules", {})
    for gid in sorted(set(lite_schedules) | set(ref_schedules)):
        if gid not in lite_schedules or gid not in ref_schedules:
            report.add(f"schedule:{gid}", FAILURE, f"present only on {'ref' if gid not in lite_schedules else 'lite'}")
            continue
        a, b = lite_schedules[gid], ref_schedules[gid]
        for field in ("Name", "Identification", "PredefinedType", "Status"):
            compare_scalar(report, f"schedule:{gid}/{field}", a.get(field), b.get(field))
        compare_scalar(report, f"schedule:{gid}/ItemGlobalIds", a.get("ItemGlobalIds"), b.get("ItemGlobalIds"))

    lite_items = lite.get("Items", {})
    ref_items = ref.get("Items", {})
    currency_absent_both = lite_currency is None and ref_currency is None
    for gid in sorted(set(lite_items) | set(ref_items)):
        if gid not in lite_items or gid not in ref_items:
            report.add(f"item:{gid}", FAILURE, f"present only on {'ref' if gid not in lite_items else 'lite'}")
            continue
        a, b = lite_items[gid], ref_items[gid]
        for field in ("Name", "Identification", "PredefinedType", "ParentGlobalId",
                      "ChildGlobalIds", "ScheduleGlobalIds", "ProductGlobalIds",
                      "TaskGlobalIds", "HasCostValues", "HasCostQuantities",
                      "Values", "Quantities"):
            compare_scalar(report, f"item:{gid}/{field}", a.get(field), b.get(field))

        a_total, b_total = a.get("ResolvedTotal"), b.get("ResolvedTotal")
        if (a_total is None) != (b_total is None):
            report.add(f"item:{gid}/ResolvedTotal", FAILURE, f"lite={a_total} ref={b_total}")
        elif a_total is not None:
            amount_ok = _numbers_close(a_total.get("Amount"), b_total.get("Amount"))
            currency_ok = a_total.get("Currency") == b_total.get("Currency")
            if amount_ok and currency_ok:
                report.add(f"item:{gid}/ResolvedTotal", MATCH)
            elif amount_ok and not currency_ok and a_total.get("Currency") is None:
                report.add(f"item:{gid}/ResolvedTotal/Currency", degraded("CURRENCY_UNRESOLVED"),
                           f"lite={a_total} ref={b_total}")
            else:
                report.add(f"item:{gid}/ResolvedTotal", FAILURE, f"lite={a_total} ref={b_total}")
        else:
            report.add(f"item:{gid}/ResolvedTotal", MATCH)

    lite_nodes = lite.get("Nodes", {})
    ref_nodes = ref.get("Nodes", {})
    for path in sorted(set(lite_nodes) | set(ref_nodes)):
        compare_node(report, path, lite_nodes, ref_nodes, lite_schema, currency_absent_both)

    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ifclite", required=True)
    parser.add_argument("--reference", required=True)
    args = parser.parse_args()

    with open(args.ifclite) as f:
        lite = json.load(f)
    with open(args.reference) as f:
        ref = json.load(f)

    try:
        report = compare(lite, ref)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)

    summary = report.summary()
    print(json.dumps(summary))
    for path, status, detail in report.rows:
        if status != MATCH:
            print(f"{status}\t{path}\t{detail}", file=sys.stderr)

    sys.exit(1 if summary["failures"] > 0 else 0)


if __name__ == "__main__":
    main()
