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


class ReviewFindingRegressions(unittest.TestCase):
    """Each test reproduces a divergence the comparator used to report as a
    pass (0 failures, or an absorbed DEGRADED row) and asserts it is now a
    FAILURE."""

    @staticmethod
    def rows(report, path):
        return [r for r in report.rows if r[0] == path]

    def assert_failure_at(self, report, path):
        rows = self.rows(report, path)
        self.assertEqual(len(rows), 1, f"expected exactly one row at {path}: {report.rows}")
        self.assertEqual(rows[0][1], cc.COST_FAILURE, rows[0])
        self.assertGreater(report.summary()["failures"], 0)

    def test_value_node_name_category_condition_are_compared(self):
        for field, wrong in (("Name", "renamed"), ("Category", "Equipment"), ("Condition", "Winter rate")):
            with self.subTest(field=field):
                lite, ref = _baseline_pair()
                lite["Nodes"]["item:CHILD1/value/0"][field] = wrong
                self.assert_failure_at(cc.compare_cost(lite, ref), f"node:item:CHILD1/value/0/{field}")

    def test_has_cost_data_is_compared(self):
        lite, ref = _baseline_pair()
        lite["HasCostData"] = False
        self.assert_failure_at(cc.compare_cost(lite, ref), "HasCostData")

    def test_quantity_name_and_unit_type_are_compared(self):
        lite, ref = _baseline_pair()
        for dump in (lite, ref):
            dump["Nodes"]["item:CHILD1/quantity/0"] = {
                "Kind": "Quantity", "Type": "IfcQuantityArea", "Name": "Scaffolding area",
                "Dimension": "area", "Value": 100.0,
            }
            dump["Nodes"]["item:CHILD1/value/0/unitBasis/unit"] = {
                "Kind": "Unit", "Type": "IfcSIUnit", "UnitType": "AREAUNIT",
                "Currency": None, "Symbol": None, "Dimension": None,
            }
        lite["Nodes"]["item:CHILD1/quantity/0"]["Name"] = "Brick wall volume"
        lite["Nodes"]["item:CHILD1/value/0/unitBasis/unit"]["UnitType"] = "VOLUMEUNIT"
        report = cc.compare_cost(lite, ref)
        self.assert_failure_at(report, "node:item:CHILD1/quantity/0/Name")
        self.assert_failure_at(report, "node:item:CHILD1/value/0/unitBasis/unit/UnitType")

    @staticmethod
    def measure_pair():
        """A value whose AppliedValue is an IfcMeasureWithUnit (7 GBP)."""
        lite, ref = _baseline_pair()
        for dump in (lite, ref):
            node = dump["Nodes"]["item:CHILD1/value/0"]
            node["Applied"] = {"Kind": "Reference", "Node": "item:CHILD1/value/0/ref"}
            node["Resolved"] = 7.0
            dump["Nodes"]["item:CHILD1/value/0/ref"] = {
                "Kind": "Measure", "Type": "IfcMeasureWithUnit", "ValueType": "IfcMonetaryMeasure",
                "Value": 7.0, "UnitNode": "item:CHILD1/value/0/ref/unit", "Resolved": 7.0,
            }
            dump["Nodes"]["item:CHILD1/value/0/ref/unit"] = {
                "Kind": "Unit", "Type": "IfcMonetaryUnit", "UnitType": None,
                "Currency": "GBP", "Symbol": None, "Dimension": None,
            }
        return lite, ref

    def test_measure_with_unit_node_matches_across_casing(self):
        lite, ref = self.measure_pair()
        lite["Nodes"]["item:CHILD1/value/0/ref"]["ValueType"] = "IFCMONETARYMEASURE"
        report = cc.compare_cost(lite, ref)
        self.assertEqual(report.summary()["failures"], 0, report.failures)
        self.assertEqual(self.rows(report, "node:item:CHILD1/value/0/ref/Value")[0][1], cc.COST_MATCH)

    def test_measure_with_unit_value_type_and_unit_are_compared(self):
        for field, wrong in (("Value", 70.0), ("ValueType", "IfcAreaMeasure"), ("UnitNode", "elsewhere"),
                             ("Resolved", 70.0)):
            with self.subTest(field=field):
                lite, ref = self.measure_pair()
                lite["Nodes"]["item:CHILD1/value/0/ref"][field] = wrong
                self.assert_failure_at(cc.compare_cost(lite, ref), f"node:item:CHILD1/value/0/ref/{field}")

    def test_both_missing_with_different_kinds_is_a_failure(self):
        lite, ref = self.measure_pair()
        lite["Nodes"]["item:CHILD1/value/0/ref"] = {"Kind": "Value", "Missing": True}
        ref["Nodes"]["item:CHILD1/value/0/ref"] = {"Kind": "Measure", "Missing": True}
        self.assert_failure_at(cc.compare_cost(lite, ref), "node:item:CHILD1/value/0/ref/Kind")

    def test_both_missing_with_the_same_kind_matches(self):
        lite, ref = self.measure_pair()
        for dump in (lite, ref):
            dump["Nodes"]["item:CHILD1/value/0/ref"] = {"Kind": "Measure", "Missing": True}
        rows = self.rows(cc.compare_cost(lite, ref), "node:item:CHILD1/value/0/ref/Kind")
        self.assertEqual(rows[0][1], cc.COST_MATCH)

    def test_measure_with_unit_dumped_as_missing_is_a_failure(self):
        """The shape the ifc-lite dumper used to emit for a measure-with-unit
        AppliedValue: a Missing Value node where the reference has a body."""
        lite, ref = self.measure_pair()
        lite["Nodes"]["item:CHILD1/value/0/ref"] = {"Kind": "Value", "Missing": True}
        self.assert_failure_at(cc.compare_cost(lite, ref), "node:item:CHILD1/value/0/ref/Missing")

    @staticmethod
    def ifc2x3_pair():
        lite, ref = _baseline_pair()
        for dump in (lite, ref):
            dump["SchemaVersion"] = "IFC2X3"
            dump["Currency"] = None
            for item in dump["Items"].values():
                if item["ResolvedTotal"] is not None:
                    item["ResolvedTotal"]["Currency"] = None
        return lite, ref

    def test_ifc2x3_wrong_number_is_a_failure_not_partial_read(self):
        lite, ref = self.ifc2x3_pair()
        lite["DiagnosticCodes"] = ["IFC2X3_PARTIAL_READ"]
        lite["Nodes"]["item:CHILD1/value/0"]["Resolved"] = 999.0
        self.assert_failure_at(cc.compare_cost(lite, ref), "node:item:CHILD1/value/0/Resolved")

    def test_ifc2x3_null_without_the_partial_read_diagnostic_is_a_failure(self):
        lite, ref = self.ifc2x3_pair()
        lite["Nodes"]["item:CHILD1/value/0"]["Resolved"] = None
        self.assert_failure_at(cc.compare_cost(lite, ref), "node:item:CHILD1/value/0/Resolved")

    def test_ifc2x3_null_with_the_partial_read_diagnostic_is_degraded(self):
        lite, ref = self.ifc2x3_pair()
        lite["DiagnosticCodes"] = ["IFC2X3_PARTIAL_READ"]
        lite["Nodes"]["item:CHILD1/value/0"]["Resolved"] = None
        rows = self.rows(cc.compare_cost(lite, ref), "node:item:CHILD1/value/0/Resolved")
        self.assertEqual(rows[0][1], "DEGRADED:IFC2X3_PARTIAL_READ")

    def test_spot_currency_omission_with_resolved_model_currency_is_a_failure(self):
        lite, ref = _baseline_pair()
        lite["Items"]["CHILD1"]["ResolvedTotal"]["Currency"] = None
        self.assert_failure_at(cc.compare_cost(lite, ref), "item:CHILD1/ResolvedTotal")

    def test_total_currency_omission_with_unresolved_model_currency_is_degraded(self):
        lite, ref = _baseline_pair()
        lite["Currency"] = None
        lite["Items"]["CHILD1"]["ResolvedTotal"]["Currency"] = None
        rows = self.rows(cc.compare_cost(lite, ref), "item:CHILD1/ResolvedTotal/Currency")
        self.assertEqual(rows[0][1], "DEGRADED:CURRENCY_UNRESOLVED")


if __name__ == "__main__":
    unittest.main()
