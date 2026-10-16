# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Dump canonical per-element geometry stats from the PINNED reference engine.

Usage:
    python dump_reference.py <model.ifc> [<model2.ifc> ...] --out-dir reference/

Geometry settings match the provenance of the previously hand-transcribed
constants (rust/geometry/tests/door_window_calibration_regression.rs):
world coordinates ON and vertex welding ON, so bboxes/counts are directly
comparable. Elements the engine cannot process become first-class
``skip:<reason>`` records, not silent absences.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import ifcopenshell

import canonical
from reference_validation import InvalidReference, ReferenceSession, ShapeUnavailable


def dump_model(path: Path, diagnostics_dir: Path) -> dict:
    elements = []
    with ReferenceSession(path, {"use-world-coords": True, "weld-vertices": True}, diagnostics_dir) as session:
        for product in session.products:
            try:
                mesh = session.shape(product["id"])
                verts, faces = mesh["positions"], mesh["indices"]
                if not verts or not faces:
                    elements.append(canonical.skip_record(product["id"], product["type"], "empty-geometry"))
                    continue
                elements.append(canonical.element_record(product["id"], product["type"], verts, faces))
            except ShapeUnavailable as exc:
                elements.append(
                    canonical.skip_record(product["id"], product["type"], str(exc))
                )

    sha = session.fixture_hash
    return canonical.document(
        fixture=path.name,
        sha256=sha,
        engine=f"ifcopenshell {ifcopenshell.version}",
        settings={"use_world_coords": True, "weld_vertices": True},
        elements=elements,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="+", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for path in args.models:
        try:
            doc = dump_model(path, args.out_dir / (path.stem + ".reference-diagnostics"))
        except InvalidReference as exc:
            print(f"{path.name}: invalid or unresolved reference: {exc}", file=sys.stderr)
            return 2
        out = args.out_dir / (path.stem + ".reference.json")
        out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
        diagnostic_receipt = args.out_dir / (path.stem + ".reference-diagnostics/receipt.json")
        validation = {
            "status": "ENGINE_DIAGNOSTICS_CHECKED_NOT_BOOLEAN_PROOF",
            "canonicalSHA256": hashlib.sha256(out.read_bytes()).hexdigest(),
            "diagnosticsReceiptSHA256": hashlib.sha256(diagnostic_receipt.read_bytes()).hexdigest(),
            "fixtureSHA256": doc["sha256"],
        }
        (args.out_dir / (path.stem + ".reference-validation.json")).write_text(
            json.dumps(validation, indent=2, sort_keys=True) + "\n")
        ok = sum(1 for e in doc["elements"] if e["status"] == "ok")
        skipped = len(doc["elements"]) - ok
        print(f"{path.name}: {ok} ok, {skipped} skipped -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
