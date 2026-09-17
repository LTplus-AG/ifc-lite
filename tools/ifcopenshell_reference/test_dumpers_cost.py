# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Known-answer tests for the two cost DUMPERS (issue #4859), as opposed to
`test_harness_cost.py`, which tests the comparator over plain dicts.

Run: python3 -m unittest test_dumpers_cost

Each suite needs a real engine and skips (never fails) without it:

- `ReferenceDumper` needs IfcOpenShell (`pip install -r requirements.lock`),
  so it runs in the `cost-full` lane.
- `IfcLiteDumper` needs node plus a built `@ifc-lite/sdk` chain
  (`pnpm turbo build --filter=@ifc-lite/sdk`), so it runs in `cost-quick`
  and `cost-full`.

The IfcMeasureWithUnit AppliedValue / UnitBasis shapes and the Components
arithmetic are covered end to end by the committed
`cost_fixtures/buildingsmart-cost-composition.ifc` differential instead.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SDK_DIST = os.path.join(HERE, "..", "..", "packages", "sdk", "dist", "index.js")

try:
    import ifcopenshell
except ImportError:  # the stdlib-only lanes have no reference engine
    ifcopenshell = None

# Deeper than CPython's default recursion limit (1000), and deeper than the
# old recursive JS walk survives under `--stack-size=200` (measured: it threw
# RangeError at this depth; the iterative walk does not).
CHAIN_DEPTH = 1500


def _ifc(data_lines, schema="IFC4"):
    return "\n".join([
        "ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('cost dumper test'),'2;1');",
        "FILE_NAME('t.ifc','2026-09-16T00:00:00',(''),(''),'','','');",
        f"FILE_SCHEMA(('{schema}'));", "ENDSEC;", "DATA;",
        *data_lines,
        "ENDSEC;", "END-ISO-10303-21;", "",
    ])


def chain_model(depth):
    """One cost item whose value is `depth` IfcCostValues, each taking the
    next as its AppliedValue, ending in a 5.0 monetary leaf."""
    base = 100
    lines = [
        "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,#2);",
        "#2=IFCUNITASSIGNMENT((#3));",
        "#3=IFCMONETARYUNIT('GBP');",
    ]
    for i in range(depth):
        lines.append(f"#{base + i}=IFCCOSTVALUE('v{i}',$,#{base + i + 1},$,$,$,$,$,$,$);")
    lines.append(f"#{base + depth}=IFCCOSTVALUE('leaf',$,IFCMONETARYMEASURE(5.),$,$,$,$,$,$,$);")
    lines.append(f"#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'deep',$,$,'CI-1',.USERDEFINED.,(#{base}),$);")
    return _ifc(lines)


def currency_model(assigned_units, extra_units=""):
    """`extra_units` are IfcMonetaryUnits placed BEFORE the assigned ones in
    STEP order but not listed in IfcProject.UnitsInContext."""
    lines = ["#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,#2);"]
    if extra_units:
        lines.append(extra_units)
    ids = []
    for idx, code in enumerate(assigned_units):
        ids.append(f"#{20 + idx}")
        lines.append(f"#{20 + idx}=IFCMONETARYUNIT('{code}');")
    lines.append(f"#2=IFCUNITASSIGNMENT(({','.join(ids)}));")
    lines += [
        "#30=IFCCOSTVALUE('v',$,IFCMONETARYMEASURE(5.),$,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$,'CI-1',.USERDEFINED.,(#30),$);",
    ]
    return _ifc(lines)


def number_quantity_model():
    """An IFC4X3 cost item with one IfcQuantityNumber (3.0)."""
    return _ifc([
        "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,$);",
        "#20=IFCQUANTITYNUMBER('Fixings',$,$,3.,$);",
        "#30=IFCCOSTVALUE('v',$,IFCMONETARYMEASURE(5.),$,$,$,$,$,$,$);",
        "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$,'CI-1',.USERDEFINED.,(#30),(#20));",
    ], schema="IFC4X3_ADD2")


def _number_quantity(dump):
    return dump["Nodes"]["item:1JYq7Z8qH3nP9JjM4fLg2A/quantity/0"]


def _chain_root(dump):
    return dump["Nodes"]["item:1JYq7Z8qH3nP9JjM4fLg2A/value/0"]


@unittest.skipIf(ifcopenshell is None, "IfcOpenShell not installed (pip install -r requirements.lock)")
class ReferenceDumper(unittest.TestCase):
    @staticmethod
    def dump(text):
        import dump_reference_cost
        return dump_reference_cost.build_canonical_dump(ifcopenshell.file.from_string(text))

    def test_currency_comes_from_units_in_context_not_step_order(self):
        dump = self.dump(currency_model(["GBP"], extra_units="#5=IFCMONETARYUNIT('EUR');"))
        self.assertEqual(dump["Currency"], "GBP")
        self.assertEqual(dump["Items"]["1JYq7Z8qH3nP9JjM4fLg2A"]["ResolvedTotal"]["Currency"], "GBP")

    def test_conflicting_assigned_currencies_resolve_to_none(self):
        dump = self.dump(currency_model(["GBP", "EUR"]))
        self.assertIsNone(dump["Currency"])

    def test_empty_category_is_kept_distinct_from_absent(self):
        def category(label):
            dump = self.dump(_ifc([
                "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,$);",
                f"#30=IFCCOSTVALUE('v',$,IFCMONETARYMEASURE(5.),$,$,$,{label},$,$,$);",
                "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$,'CI-1',.USERDEFINED.,(#30),$);",
            ]))
            return _chain_root(dump)["Category"]
        self.assertEqual(category("''"), "")
        self.assertIsNone(category("$"))
        self.assertEqual(category("'Labor'"), "Labor")

    def test_quantity_number_carries_its_value_and_dimension(self):
        quantity = _number_quantity(self.dump(number_quantity_model()))
        self.assertEqual((quantity["Dimension"], quantity["Value"]), ("number", 3.0))

    def test_deep_applied_value_chain_does_not_hit_the_recursion_limit(self):
        dump = self.dump(chain_model(CHAIN_DEPTH))
        self.assertEqual(_chain_root(dump)["Resolved"], 5.0)

    def test_modulo_operator_evaluates_non_trivially(self):
        """IfcArithmeticOperatorEnum.MODULO is IFC4X3-only (see
        IFC4X3.exp's TYPE IfcArithmeticOperatorEnum). 5 MODULO 2 = 1 is
        chosen so neither operand nor a null-resolution coincidentally
        produces the right answer (unlike `x MODULO 1`, always 0)."""
        dump = self.dump(_ifc([
            "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,#2);",
            "#2=IFCUNITASSIGNMENT((#3));",
            "#3=IFCMONETARYUNIT('GBP');",
            "#31=IFCCOSTVALUE('a',$,IFCMONETARYMEASURE(5.),$,$,$,$,$,$,$);",
            "#32=IFCCOSTVALUE('b',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
            "#30=IFCCOSTVALUE('total',$,$,$,$,$,$,$,.MODULO.,(#31,#32));",
            "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$,'CI-1',.USERDEFINED.,(#30),$);",
        ], schema="IFC4X3_ADD2"))
        self.assertEqual(_chain_root(dump)["Resolved"], 1.0)

    def test_quantity_weight_dimension_is_mass_not_weight(self):
        """IfcQuantityWeight.WeightValue is typed IfcMassMeasure and its
        Unit is constrained to MASSUNIT (IFC4X3.exp's ENTITY
        IfcQuantityWeight, WR21); "mass" also matches ifc-lite's own read
        model (packages/parser/src/cost-quantities.ts maps
        IFCQUANTITYWEIGHT -> 'mass')."""
        dump = self.dump(_ifc([
            "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,$);",
            "#20=IFCQUANTITYWEIGHT('Steel',$,$,42.5,$);",
            "#30=IFCCOSTVALUE('v',$,IFCMONETARYMEASURE(5.),$,$,$,$,$,$,$);",
            "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$,'CI-1',.USERDEFINED.,(#30),(#20));",
        ], schema="IFC4X3_ADD2"))
        quantity = _number_quantity(dump)
        self.assertEqual((quantity["Dimension"], quantity["Value"]), ("mass", 42.5))

    def test_unit_basis_si_unit_carries_a_real_symbol_and_dimension(self):
        """Before #4882 the reference dumper hardcoded every unit node's
        Symbol/Dimension to null; a prefixed millimetre unit must now
        report its real symbol ("mm") and dimension ("length"), matching
        ifc-lite's own read model (packages/parser/src/cost-units.ts)."""
        dump = self.dump(_ifc([
            "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,#2);",
            "#2=IFCUNITASSIGNMENT((#3));",
            "#3=IFCMONETARYUNIT('GBP');",
            "#40=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);",
            "#41=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1000.),#40);",
            "#30=IFCCOSTVALUE('v',$,IFCMONETARYMEASURE(5.),#41,$,$,$,$,$,$);",
            "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$,'CI-1',.USERDEFINED.,(#30),$);",
        ]))
        unit = dump["Nodes"]["item:1JYq7Z8qH3nP9JjM4fLg2A/value/0/unitBasis/unit"]
        self.assertEqual((unit["Symbol"], unit["Dimension"]), ("mm", "length"))

    def test_ifc2x3_legacy_formula_resolves_via_applied_value_relationship(self):
        """IFC2X3's IfcAppliedValue carries neither Components nor
        ArithmeticOperator directly (see IFC2X3_TC1.exp's ENTITY
        IfcAppliedValue); a total's components/operator instead live on the
        IfcAppliedValueRelationship reachable via the inverse
        `ValueOfComponents`. Exercises NodeRegistry.register_value directly
        (white-box, bypassing IfcCostItem->value linkage): IFC2X3's
        IfcCostItem carries no CostValues attribute at all (5 own attributes
        - GlobalId, OwnerHistory, Name, Description, ObjectType - confirmed
        via ifcopenshell's schema declaration), and ifc-lite's own IFC2X3
        extractItems() deliberately never populates item.CostValues either
        (packages/parser/src/cost-extractor.ts's schemaIs2x3 branch returns
        early) - see packages/parser/test/cost-read-model-4854.test.ts's
        'keeps IFC2X3 metadata and legacy edges inspectable but refuses
        evaluation', which asserts CostItems[0].CostValues is undefined.
        Item-level IFC2X3 value linkage is therefore a separate, larger gap
        on both dumpers, out of scope here; this test targets only the
        formula-resolution machinery the review thread flagged
        (dump_reference_cost.py's _enter/resolve_node, previously emitting
        Resolved: null for a resolvable IFC2X3 formula)."""
        import dump_reference_cost

        text = _ifc([
            "#1=IFCPROJECT('0JYq7Z8qH3nP9JjM4fLg2A',$,'p',$,$,$,$,$,#2);",
            "#2=IFCUNITASSIGNMENT((#3));",
            "#3=IFCMONETARYUNIT(.GBP.);",
            "#30=IFCCOSTVALUE('total',$,$,$,$,$,'CostType',$);",
            "#31=IFCCOSTVALUE('a',$,IFCMONETARYMEASURE(7.),$,$,$,'CostType',$);",
            "#32=IFCCOSTVALUE('b',$,IFCMONETARYMEASURE(3.),$,$,$,'CostType',$);",
            "#33=IFCAPPLIEDVALUERELATIONSHIP(#30,(#31,#32),.ADD.,$,$);",
            "#10=IFCCOSTITEM('1JYq7Z8qH3nP9JjM4fLg2A',$,'i',$,$);",
        ], schema="IFC2X3")
        model = ifcopenshell.file.from_string(text)
        registry = dump_reference_cost.NodeRegistry()
        registry.register_value("test", model.by_id(30))
        node = registry.nodes["test"]
        self.assertEqual(node["ArithmeticOperator"], "ADD")
        self.assertEqual(node["Components"], ["test/component/0", "test/component/1"])
        self.assertEqual(node["Resolved"], 10.0)


@unittest.skipIf(shutil.which("node") is None or not os.path.exists(SDK_DIST),
                 "node or the built @ifc-lite/sdk chain is unavailable (pnpm turbo build --filter=@ifc-lite/sdk)")
class IfcLiteDumper(unittest.TestCase):
    @staticmethod
    def dump(text, *node_flags):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "model.ifc")
            out = os.path.join(tmp, "dump.json")
            with open(src, "w", newline="\n") as f:
                f.write(text)
            run = subprocess.run(
                ["node", *node_flags, os.path.join(HERE, "dump_ifclite_cost.mjs"), src, "--out", out],
                capture_output=True, text=True, check=False,
            )
            if run.returncode != 0:
                raise AssertionError(f"dump_ifclite_cost.mjs exited {run.returncode}: {run.stderr[-2000:]}")
            with open(out) as f:
                return json.load(f)

    def test_currency_comes_from_units_in_context_not_step_order(self):
        dump = self.dump(currency_model(["GBP"], extra_units="#5=IFCMONETARYUNIT('EUR');"))
        self.assertEqual(dump["Currency"], "GBP")

    def test_quantity_number_carries_its_value_and_dimension(self):
        quantity = _number_quantity(self.dump(number_quantity_model()))
        self.assertEqual((quantity["Dimension"], quantity["Value"]), ("number", 3))

    def test_deep_applied_value_chain_does_not_overflow_the_stack(self):
        dump = self.dump(chain_model(CHAIN_DEPTH), "--stack-size=200")
        self.assertEqual(_chain_root(dump)["Resolved"], 5)


if __name__ == "__main__":
    unittest.main()
