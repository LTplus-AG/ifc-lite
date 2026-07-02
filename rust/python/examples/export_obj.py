# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Export every element of an IFC file to a single Wavefront .obj.

Each IFC element becomes an `o <step_id>_<ifc_type>` group. Only numpy is
required. The .obj keeps IFC Z-up world coordinates in metres.

Usage:
    pip install ifclite-geom numpy
    python export_obj.py path/to/model.ifc out.obj
"""

import sys

import numpy as np

import ifclite_geom


def main(in_path: str, out_path: str) -> None:
    with open(in_path, "rb") as f:
        ifc_bytes = f.read()

    data = ifclite_geom.geometry_data_buffers(ifc_bytes)

    vertex_offset = 1  # .obj indices are 1-based and run across the whole file
    with open(out_path, "w", encoding="utf-8") as out:
        out.write(f"# ifclite-geom export ({data['element_count']} elements, "
                  f"{data['units']}, up={data['up_axis']})\n")
        for step_id, el in data["elements"].items():
            verts = np.frombuffer(el["vertices"], dtype=np.float64).reshape(-1, 3)
            faces = np.frombuffer(el["faces"], dtype=np.uint32).reshape(-1, 3)

            out.write(f"o {step_id}_{el['ifc_type']}\n")
            for x, y, z in verts:
                out.write(f"v {x:.6f} {y:.6f} {z:.6f}\n")
            for a, b, c in faces + vertex_offset:
                out.write(f"f {a} {b} {c}\n")
            vertex_offset += len(verts)

    print(f"wrote {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python export_obj.py path/to/model.ifc out.obj")
    main(sys.argv[1], sys.argv[2])
