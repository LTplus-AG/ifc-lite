# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Tessellate an IFC file and write the geometry-data JSON document to disk.

No numpy needed: the JSON variant returns vertices/faces as plain arrays.

Usage:
    pip install ifclite-geom
    python dump_json.py path/to/model.ifc out.json
"""

import sys

import ifclite_geom


def main(in_path: str, out_path: str) -> None:
    with open(in_path, "rb") as f:
        ifc_bytes = f.read()

    # geometry_data_json already returns a JSON string; write it straight out.
    doc = ifclite_geom.geometry_data_json(ifc_bytes)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(doc)

    print(f"wrote {out_path} ({len(doc)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python dump_json.py path/to/model.ifc out.json")
    main(sys.argv[1], sys.argv[2])
