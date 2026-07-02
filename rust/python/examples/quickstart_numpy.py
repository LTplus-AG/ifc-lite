# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Load an IFC file and inspect its meshes with numpy.

Usage:
    pip install ifclite-geom numpy
    python quickstart_numpy.py path/to/model.ifc
"""

import sys

import numpy as np

import ifclite_geom


def main(path: str) -> None:
    with open(path, "rb") as f:
        ifc_bytes = f.read()

    data = ifclite_geom.geometry_data_buffers(ifc_bytes)

    print(f"{data['element_count']} elements")
    print(f"up axis: {data['up_axis']}  units: {data['units']}")
    print(f"rtc offset: {data['rtc_offset']}")

    total_tris = 0
    for step_id, el in data["elements"].items():
        verts = np.frombuffer(el["vertices"], dtype=np.float64).reshape(-1, 3)
        faces = np.frombuffer(el["faces"], dtype=np.uint32).reshape(-1, 3)
        total_tris += len(faces)
        # Print a one-line summary for the first few elements.
        if step_id in list(data["elements"])[:5]:
            label = el["name"] or el["global_id"] or "-"
            print(f"  #{step_id} {el['ifc_type']:<20} {label:<24} "
                  f"{len(verts):>6} verts  {len(faces):>6} tris")

    print(f"total triangles: {total_tris}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python quickstart_numpy.py path/to/model.ifc")
    main(sys.argv[1])
