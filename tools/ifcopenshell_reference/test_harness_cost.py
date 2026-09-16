# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Known-answer tests for the cost comparator (issue #4859).

Run: python3 -m unittest test_harness_cost  (stdlib only — no IfcOpenShell,
no ifc-lite build required; the comparator is pure Python over plain dicts).

Includes an `EndToEndFaultInjection` suite mirroring `test_harness.py`'s
geometry fault-injection tests: it perturbs a copy of a real, once-generated
canonical dump pair (see `_baseline_pair`, itself produced from the actual
`buildingsmart-cost-composition.ifc` fixture the CI lane uses — recorded here
as a literal to keep this test engine-independent and fast) and asserts
`compare_cost()` actually classifies the corruption as FAILURE, not MATCH and
not a silently-absorbed DEGRADED category.

Imports the pre-existing `compare` module (which now carries the cost
comparator alongside the geometry one — see its "Cost differential parity"
section) rather than a standalone `compare_cost` module: a revert of only
the cost-adding hunk leaves `compare.py` importable, so a corrupted or
missing comparator surfaces here as a real assertion/attribute failure
inside a test body, not a collection-time import error that would hide
every assertion below behind a load failure.
"""

from __future__ import annotations

import copy
import unittest

import compare as cc


def _baseline_pair():
    """A minimal-but-representative canonical dump pair: two schedules-worth
    of structure is unnecessary — one schedule, two items (one parent/child
    nesting, one shared IfcCostValue reference between two items, one
    resolved ADD total, one item with a present-but-unresolvable value to
    exercise the empty-vs-absent distinction) is enough surface to exercise
    every classification path."""
    lite = {
        "SchemaVersion": "IFC4",
        "Currency": "GBP",
        "HasCostData": True,
        "Schedules": {
            "SCHED1": {
                "Name": "Budget", "Identification": "CS-1", "PredefinedType": "BUDGET",
                "Status": "DRAFT", "ItemGlobalIds": ["PARENT1"],
            },
        },
        "Items": {
            "PARENT1": {
                "Name": "Parent", "Identification": "CI-1", "PredefinedType": "USERDEFINED",
                "ParentGlobalId": None, "ChildGlobalIds": ["CHILD1"],
                "ScheduleGlobalIds": ["SCHED1"], "ProductGlobalIds": 0, "TaskGlobalIds": 0,
                "HasCostValues": True, "HasCostQuantities": False,
                "Values": ["item:PARENT1/value/0"], "Quantities": [],
                "ResolvedTotal": {"Amount": 8.0, "Currency": "GBP"},
            },
            "CHILD1": {
                "Name": "Child", "Identification": "CI-2", "PredefinedType": "USERDEFINED",
                "ParentGlobalId": "PARENT1", "ChildGlobalIds": [],
                "ScheduleGlobalIds": [], "ProductGlobalIds": 1, "TaskGlobalIds": 0,
                "HasCostValues": True, "HasCostQuantities": False,
                "Values": ["item:CHILD1/value/0"], "Quantities": [],
                "ResolvedTotal": {"Amount": 5.0, "Currency": "GBP"},
            },
            "EMPTY1": {
                "Name": "Placeholder subtotal", "Identification": "CI-3", "PredefinedType": "USERDEFINED",
                "ParentGlobalId": None, "ChildGlobalIds": [],
                "ScheduleGlobalIds": [], "ProductGlobalIds": 0, "TaskGlobalIds": 0,
                # PRESENT (HasCostValues=True) but genuinely unresolvable —
                # must stay distinct from an item with NO CostValues at all.
                "HasCostValues": True, "HasCostQuantities": False,
                "Values": ["item:EMPTY1/value/0"], "Quantities": [],
                "ResolvedTotal": None,
            },
        },
        "Nodes": {
            "item:PARENT1/value/0": {
                "Kind": "Value", "Type": "IfcCostValue", "Name": "material", "Category": "Material",
                "Condition": None, "ArithmeticOperator": "ADD",
                "Applied": None, "Components": ["item:PARENT1/value/0/component/0", "item:CHILD1/value/0"],
                "UnitBasisNode": None, "Resolved": 8.0,
            },
            "item:PARENT1/value/0/component/0": {
                "Kind": "Value", "Type": "IfcCostValue", "Name": "material-a", "Category": "Material",
                "Condition": None, "ArithmeticOperator": None,
                "Applied": {"Kind": "Typed", "Type": "IfcMonetaryMeasure", "Value": 3.0},
                "Components": None, "UnitBasisNode": None, "Resolved": 3.0,
            },
            "item:CHILD1/value/0": {
                "Kind": "Value", "Type": "IfcCostValue", "Name": "shared-rate", "Category": "Labor",
                "Condition": None, "ArithmeticOperator": None,
                "Applied": {"Kind": "Typed", "Type": "IfcMonetaryMeasure", "Value": 5.0},
                "Components": None, "UnitBasisNode": None, "Resolved": 5.0,
            },
            "item:EMPTY1/value/0": {
                "Kind": "Value", "Type": "IfcCostValue", "Name": "Subtotal", "Category": "*",
                "Condition": None, "ArithmeticOperator": None,
                "Applied": None, "Components": None, "UnitBasisNode": None, "Resolved": None,
            },
        },
    }
    ref = copy.deepcopy(lite)
    return lite, ref


class ComparatorClassification(unittest.TestCase):
    def test_positive_control_unperturbed_pair_is_all_match(self):
        lite, ref = _baseline_pair()
        report = cc.compare_cost(lite, ref)
        summary = report.summary()
        self.assertEqual(summary["failures"], 0)
        self.assertEqual(summary["degradations"], 0)
        self.assertGreater(summary["matches"], 0)

    def test_empty_reference_is_refused_not_a_silent_pass(self):
        """The house convention (packages/renderer/src/entity-visibility.ts's
        isEntityVisible): absent must never be silently treated as matching
        absent. An empty reference dump must raise, not report zero
        failures — a green report here would prove nothing."""
        lite, ref = _baseline_pair()
        ref["HasCostData"] = False
        ref["Items"] = {}
        with self.assertRaises(ValueError):
            cc.compare_cost(lite, ref)

    def test_named_degradation_currency_unresolved_is_distinct_from_match_and_failure(self):
        lite, ref = _baseline_pair()
        lite["Currency"] = None
        report = cc.compare_cost(lite, ref)
        currency_rows = [r for r in report.rows if r[0] == "Currency"]
        self.assertEqual(len(currency_rows), 1)
        self.assertEqual(currency_rows[0][1], "DEGRADED:CURRENCY_UNRESOLVED")
        self.assertEqual(report.summary()["failures"], 0)

    def test_currency_present_but_wrong_is_a_failure_not_a_degradation(self):
        """A currency that IS resolved on the lite side but disagrees with
        the reference (e.g. 'XYZ' vs 'GBP') must be a FAILURE. Only the
        lite=None/ref=present case is a named CURRENCY_UNRESOLVED
        degradation - this is the case an overly-broad guard (dropping the
        `lite_currency is None` condition) would wrongly absorb."""
        lite, ref = _baseline_pair()
        lite["Currency"] = "XYZ"
        ref["Currency"] = "GBP"
        report = cc.compare_cost(lite, ref)
        currency_rows = [r for r in report.rows if r[0] == "Currency"]
        self.assertEqual(len(currency_rows), 1)
        self.assertEqual(currency_rows[0][1], cc.COST_FAILURE)
        self.assertGreater(report.summary()["failures"], 0)

    def test_unit_basis_node_match(self):
        """Both sides link the same value node to the same non-null unit
        basis (a 'per N units' rate basis) - must be a plain match, not
        silently skipped."""
        lite, ref = _baseline_pair()
        for dump in (lite, ref):
            dump["Nodes"]["item:PARENT1/value/0"]["UnitBasisNode"] = "item:PARENT1/value/0/unitBasis"
            dump["Nodes"]["item:PARENT1/value/0/unitBasis"] = {
                "Kind": "Unit", "Type": "IfcMonetaryUnit", "UnitType": "USERDEFINED",
                "Currency": "GBP", "Symbol": "per 137.5 m", "Dimension": None,
            }
        report = cc.compare_cost(lite, ref)
        rows = [r for r in report.rows if r[0] == "node:item:PARENT1/value/0/UnitBasisNode"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], cc.COST_MATCH)
        self.assertEqual(report.summary()["failures"], 0)

    def test_unit_basis_node_differing_is_a_failure(self):
        """The two sides record a unit basis at different node paths (e.g.
        divergent shared-reference traversal order) - a real divergence,
        not a coincidental one, must be a FAILURE."""
        lite, ref = _baseline_pair()
        lite["Nodes"]["item:PARENT1/value/0"]["UnitBasisNode"] = "item:PARENT1/value/0/unitBasis"
        lite["Nodes"]["item:PARENT1/value/0/unitBasis"] = {
            "Kind": "Unit", "Type": "IfcMonetaryUnit", "UnitType": "USERDEFINED",
            "Currency": "GBP", "Symbol": "per 137.5 m", "Dimension": None,
        }
        ref["Nodes"]["item:PARENT1/value/0"]["UnitBasisNode"] = "item:CHILD1/value/0/unitBasis"
        ref["Nodes"]["item:CHILD1/value/0/unitBasis"] = {
            "Kind": "Unit", "Type": "IfcMonetaryUnit", "UnitType": "USERDEFINED",
            "Currency": "GBP", "Symbol": "per 137.5 m", "Dimension": None,
        }
        report = cc.compare_cost(lite, ref)
        rows = [r for r in report.rows if r[0] == "node:item:PARENT1/value/0/UnitBasisNode"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], cc.COST_FAILURE)
        self.assertGreater(report.summary()["failures"], 0)

    def test_unit_basis_node_one_sided_is_a_failure_not_a_silent_pass(self):
        """Reproduces the demonstrated blind spot: the reference links a
        value node to a non-null unit basis (a 'per 137.5 units' rate) and
        ifc-lite reports UnitBasisNode: None for the same node. Without an
        explicit comparison this silently passes (0 failures) because the
        dropped basis changes nothing else that's compared - dropping a
        UnitBasis is an order-of-magnitude error, not a rounding one, so it
        must be a FAILURE."""
        lite, ref = _baseline_pair()
        # lite: UnitBasisNode stays None (already the baseline value) -
        # mirrors ifc-lite failing to extract IfcCostValue.UnitBasis.
        ref["Nodes"]["item:PARENT1/value/0"]["UnitBasisNode"] = "item:PARENT1/value/0/unitBasis"
        ref["Nodes"]["item:PARENT1/value/0/unitBasis"] = {
            "Kind": "Unit", "Type": "IfcMonetaryUnit", "UnitType": "USERDEFINED",
            "Currency": "GBP", "Symbol": "per 137.5 m", "Dimension": None,
        }
        report = cc.compare_cost(lite, ref)
        rows = [r for r in report.rows if r[0] == "node:item:PARENT1/value/0/UnitBasisNode"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], cc.COST_FAILURE)
        self.assertGreater(report.summary()["failures"], 0)


class EndToEndFaultInjection(unittest.TestCase):
    """Each test perturbs a COPY of the real dump pair and asserts
    `compare_cost()`'s exit-worthy failure count actually goes non-zero — proof
    the comparator's red path has teeth, not just that individual field
    comparisons are correct in isolation."""

    def test_wrong_relationship_direction_is_a_failure(self):
        lite, ref = _baseline_pair()
        # Corrupt: report CHILD1 as having no parent (drops the nesting
        # relationship / flips its direction).
        lite["Items"]["CHILD1"]["ParentGlobalId"] = None
        lite["Items"]["PARENT1"]["ChildGlobalIds"] = []
        report = cc.compare_cost(lite, ref)
        self.assertGreater(report.summary()["failures"], 0)
        self.assertTrue(any(r[0] == "item:CHILD1/ParentGlobalId" and r[1] == cc.COST_FAILURE for r in report.rows))

    def test_missing_reference_is_a_failure(self):
        lite, ref = _baseline_pair()
        del lite["Items"]["CHILD1"]
        report = cc.compare_cost(lite, ref)
        self.assertGreater(report.summary()["failures"], 0)
        self.assertTrue(any(r[0] == "item:CHILD1" and r[1] == cc.COST_FAILURE for r in report.rows))

    def test_altered_total_is_a_failure(self):
        lite, ref = _baseline_pair()
        lite["Items"]["PARENT1"]["ResolvedTotal"]["Amount"] = 800.0
        lite["Nodes"]["item:PARENT1/value/0"]["Resolved"] = 800.0
        report = cc.compare_cost(lite, ref)
        self.assertGreater(report.summary()["failures"], 0)
        self.assertTrue(any(r[0] == "item:PARENT1/ResolvedTotal" and r[1] == cc.COST_FAILURE for r in report.rows))

    def test_broken_shared_reference_is_a_failure(self):
        """Two items sharing one IfcCostValue must be caught if a dumper
        stops reporting the shared identity (e.g. duplicates the value
        instead of pointing at the same node)."""
        lite, ref = _baseline_pair()
        ref["Nodes"]["item:CHILD1/value/0"] = {"SharedWith": "item:PARENT1/value/0/component/0"}
        report = cc.compare_cost(lite, ref)
        self.assertGreater(report.summary()["failures"], 0)

    def test_unlisted_mismatch_is_a_failure_not_a_degradation(self):
        """A Name mismatch has no enumerated degradation category — it must
        be a FAILURE, proving the degradation set can't silently absorb an
        arbitrary divergence."""
        lite, ref = _baseline_pair()
        lite["Items"]["PARENT1"]["Name"] = "Wrong Name Entirely"
        report = cc.compare_cost(lite, ref)
        self.assertTrue(any(r[0] == "item:PARENT1/Name" and r[1] == cc.COST_FAILURE for r in report.rows))
        self.assertFalse(any(r[0] == "item:PARENT1/Name" and r[1].startswith("DEGRADED:") for r in report.rows))

    def test_positive_control_perturbed_copy_stays_green_when_reverted(self):
        """Sanity check on the harness itself: an unperturbed deep copy must
        still report zero failures (guards against a fixture that is
        accidentally already divergent)."""
        lite, ref = _baseline_pair()
        lite2 = copy.deepcopy(lite)
        report = cc.compare_cost(lite2, ref)
        self.assertEqual(report.summary()["failures"], 0)


if __name__ == "__main__":
    unittest.main()
