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
