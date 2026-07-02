# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Dump canonical per-element geometry stats from ifc-lite.

Usage:
    python dump_ifclite.py <model.ifc> [...] --out-dir out/

Uses the shipped ``ifclite_geom`` Python binding, whose
``geometry_data_buffers`` already returns per-STEP-id WELDED, absolute-world,
Z-up metres - apples-to-apples with the reference engine's world-coords +
weld-vertices settings by construction, requiring zero new kernel code. All
stats come from the SAME canonical.py functions as the reference side.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

import ifclite_geom

import canonical


def dump_model(path: Path) -> dict:
    data = path.read_bytes()
    doc = ifclite_geom.geometry_data_buffers(data)
    elements = []
    for step_id, el in doc["elements"].items():
        express_id = int(step_id)
        ifc_type = str(el.get("ifc_type", ""))
        vbytes = el["vertices"]
        fbytes = el["faces"]
        verts = list(struct.unpack(f"<{len(vbytes) // 8}d", vbytes))
        faces = list(struct.unpack(f"<{len(fbytes) // 4}I", fbytes))
        if not verts or not faces:
            elements.append(canonical.skip_record(express_id, ifc_type, "empty-geometry"))
            continue
        elements.append(canonical.element_record(express_id, ifc_type, verts, faces))

    sha = hashlib.sha256(data).hexdigest()
    return canonical.document(
        fixture=path.name,
        sha256=sha,
        engine=f"ifclite_geom {getattr(ifclite_geom, '__version__', 'unknown')}",
        settings={"welded": True, "world_coords": True, "frame": "z-up-metres"},
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
        out = args.out_dir / (path.stem + ".ifclite.json")
        out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
        ok = sum(1 for e in doc["elements"] if e["status"] == "ok")
        print(f"{path.name}: {ok} ok, {len(doc['elements']) - ok} skipped -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
