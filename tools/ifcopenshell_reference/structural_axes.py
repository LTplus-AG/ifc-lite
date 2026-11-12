#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent centre lines of beams and columns, for the axis pins in
`packages/create/src/in-store/structural-check-axes.test.ts` (#9930).

For each element: IfcOpenShell meshes its body in world coordinates; the
line runs along the principal axis of the mesh vertices, through the centre
of the section's bounds (the vertices projected onto the plane normal to that
axis, bounded along that plane's principal axes), from end face to end face.
For a doubly symmetric section that is the centroid line. It is not for
angles or other asymmetric sections, whose principal axes are diagonal.

    uv run --no-project --with ifcopenshell==0.9.0.post1 --with numpy \\
      python -I tools/ifcopenshell_reference/structural_axes.py <file.ifc> <id,id,...>

Prints one line per element: id, class, Name, start, end (metres).
"""

import sys

import ifcopenshell
import ifcopenshell.geom
import numpy as np


def centre_line(model, settings, element_id):
    shape = ifcopenshell.geom.create_shape(settings, model.by_id(element_id))
    v = np.array(shape.geometry.verts).reshape(-1, 3)
    mean = v.mean(0)
    axis = np.linalg.svd(v - mean)[2][0]
    along = (v - mean) @ axis
    across = (v - mean) - np.outer(along, axis)
    plane = np.linalg.svd(across)[2][:2]
    flat = across @ plane.T
    centre = mean + plane.T @ ((flat.min(0) + flat.max(0)) / 2)
    return centre + axis * along.min(), centre + axis * along.max()


def main():
    model = ifcopenshell.open(sys.argv[1])
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    for element_id in (int(i) for i in sys.argv[2].split(",")):
        element = model.by_id(element_id)
        start, end = centre_line(model, settings, element_id)
        print(element_id, element.is_a(), element.Name, [float(c) for c in start], [float(c) for c in end])


if __name__ == "__main__":
    main()
