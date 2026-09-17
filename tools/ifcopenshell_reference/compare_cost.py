#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""CLI entry point for the cost differential parity comparator (issue #4859).

The comparator itself - `compare_cost()`, `CostReport`, the classification
rules, and the canonical cost schema both dumpers emit - lives in
`compare.py`'s "Cost differential parity" section, alongside the pre-existing
geometry differential comparator: extending that already-pinned IfcOpenShell
parity pattern in place (rather than a parallel module) means a revert of
only this PR's hunk to `compare.py` leaves the file itself intact, so
`test_harness_cost.py`'s `import compare` always succeeds and a reverted
change shows up as a real test failure, not a collection-time import error.
See `compare.py` for the full schema and classification docstring.

Usage: python3 compare_cost.py --reference ref.json --ifclite lite.json
"""

from __future__ import annotations

import argparse
import json
import sys

from compare import COST_MATCH, compare_cost


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
        report = compare_cost(lite, ref)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)

    summary = report.summary()
    print(json.dumps(summary))
    for path, status, detail in report.rows:
        if status != COST_MATCH:
            print(f"{status}\t{path}\t{detail}", file=sys.stderr)

    sys.exit(1 if summary["failures"] > 0 else 0)


if __name__ == "__main__":
    main()
