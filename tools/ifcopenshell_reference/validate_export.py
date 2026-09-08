#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Schema-conformance check for ifc-lite's STEP/IFC export, against IfcOpenShell.

WHY THIS EXISTS (#4043). Every test in `packages/export` that checks the
STEP/IFC writer's output is `parse(write(x))` through ifc-lite's own
`@ifc-lite/parser` — self-referential by construction, blind to a mandatory
attribute our own tolerant parser accepts but a strict engine rejects. That
exact class of defect was hit once, by hand, and fixed as regression #1839
(see `packages/export/src/step-exporter.test.ts`): a WHOLE number written
into a REAL-backed positional STEP slot, caught by a one-off manual
`ifcopenshell.validate` run that was never wired into CI. This script is that
external authority, wired so it actually runs on every export-touching PR
(see `.github/workflows/export-schema-conformance.yml`).

WHAT IT CHECKS. `ifcopenshell.validate.validate(file, logger,
express_rules=True)` — schema-level conformance (mandatory attributes,
WHERE/uniqueness rules, inverse relationships) — NOT geometry. Geometry
parity against IfcOpenShell already has its own anchor
(`tools/ifcopenshell_reference/compare.py`, the `IfcOpenShell parity`
workflow); this script covers what that comparison explicitly does not.

REFUSES TO PASS VACUOUSLY:
  - zero files given                                   -> exit 2, no ifcopenshell import
  - a named file does not exist                         -> exit 2, no ifcopenshell import
  - `ifcopenshell` cannot be imported                    -> exit 3
  - any file fails validation                            -> exit 1, offending entity + rule printed
  - every file passes                                    -> exit 0, printing how many files were checked

Usage:
    python3 validate_export.py <file1.ifc> [file2.ifc ...]
"""

from __future__ import annotations

import logging
import os
import sys


class _CollectingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record.getMessage())


def _parse_args(argv: list[str]) -> list[str]:
    """Returns the file list, or raises SystemExit(2) with a loud reason.

    Deliberately does not import ifcopenshell before this check, so "zero
    files" and "missing file" are detected even in an environment where
    ifcopenshell itself is unavailable — a caller pointing this script at
    nothing gets a real error, never a silent 0-file success.
    """
    files = [a for a in argv if not a.startswith("-")]
    if not files:
        print(
            "validate_export.py: refusing to validate zero files — pass at least one "
            "IFC path. This is a failure, not a vacuous pass.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    missing = [f for f in files if not os.path.isfile(f)]
    if missing:
        print(
            "validate_export.py: missing fixture(s), refusing to report success:\n  "
            + "\n  ".join(missing),
            file=sys.stderr,
        )
        raise SystemExit(2)
    return files


def _validate_one(path: str) -> list[str]:
    import ifcopenshell
    import ifcopenshell.validate

    logger = logging.getLogger(f"validate_export.{path}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    handler = _CollectingHandler()
    logger.addHandler(handler)

    ifc_file = ifcopenshell.open(path)
    ifcopenshell.validate.validate(ifc_file, logger, express_rules=True)
    return handler.records


def main(argv: list[str]) -> int:
    files = _parse_args(argv)

    try:
        import ifcopenshell  # noqa: F401
    except ImportError as exc:
        print(
            f"validate_export.py: ifcopenshell is not importable ({exc}) — "
            "treating as a failure, not a skip. Install "
            "tools/ifcopenshell_reference/requirements.lock (plus pytest, "
            "needed by ifcopenshell.express.rule_executor).",
            file=sys.stderr,
        )
        return 3

    total_issues = 0
    for path in files:
        issues = _validate_one(path)
        if issues:
            total_issues += len(issues)
            print(f"FAIL {path}: {len(issues)} schema-conformance issue(s)")
            for message in issues:
                print(message)
        else:
            print(f"OK   {path}: no issues")

    if total_issues:
        print(
            f"\nvalidate_export.py: {total_issues} issue(s) across {len(files)} file(s). FAIL.",
            file=sys.stderr,
        )
        return 1

    print(f"\nvalidate_export.py: validated {len(files)} file(s), 0 issues. PASS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
