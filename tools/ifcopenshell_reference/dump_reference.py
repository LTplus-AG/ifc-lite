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
import ifcopenshell.geom

import canonical


def dump_model(path: Path) -> dict:
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.WELD_VERTICES, True)

    model = ifcopenshell.open(str(path))
    elements = []
    for product in model.by_type("IfcProduct"):
        if not getattr(product, "Representation", None):
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
            verts = list(shape.geometry.verts)
            faces = list(shape.geometry.faces)
            if not verts or not faces:
                elements.append(
                    canonical.skip_record(product.id(), product.is_a(), "empty-geometry")
                )
                continue
            elements.append(
                canonical.element_record(product.id(), product.is_a(), verts, faces)
            )
        except Exception as exc:  # noqa: BLE001 - the failure IS the datum
            reason = type(exc).__name__
            elements.append(canonical.skip_record(product.id(), product.is_a(), reason))

    sha = hashlib.sha256(path.read_bytes()).hexdigest()
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
        doc = dump_model(path)
        out = args.out_dir / (path.stem + ".reference.json")
        out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
        ok = sum(1 for e in doc["elements"] if e["status"] == "ok")
        skipped = len(doc["elements"]) - ok
        print(f"{path.name}: {ok} ok, {skipped} skipped -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
