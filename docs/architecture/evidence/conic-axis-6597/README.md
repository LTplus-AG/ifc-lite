<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Downward-axis profile conics (#6597)

The publicly available fork commit `christof2304/ifc-lite@2cf6747b` identified
an ignored negative circle Axis in FreeCAD composite profiles. Its real
FreeCAD reproduction was not available in the published repository/archive;
no authoring-tool provenance is claimed for the fixture added here.

`rust/geometry/tests/fixtures/downward_axis_half_cylinder.ifc` is a synthetic
geometric invariant: a unit-radius lower half disc, extruded one metre. Its
analytic bounds are `[-1,-1,0]` to `[1,0,1]`; its closed surface area is
`2π + 2`. The new tests fail on unchanged base `4fbff072` (the extrusion instead
reaches `y=1`) and pass with canonical placement handedness.

An independent IfcOpenShell 0.8.5 / OpenCascade run on this exact fixture
returned bounds `[-1,-1,0]` to `[1,1.49e-15,1]` and surface area `8.2806018843`
(analytic `8.2831853072`; tessellation explains the difference). It generated
102 vertices and 200 triangles, with volume `1.5697629882` (analytic `π/2`).
The test also checks outward triangle winding and stored normals. This verifies the desired geometry independently
of the ifc-lite implementation; it is not a real-model interoperability claim.

Reproduce the oracle from the repository root with IfcOpenShell 0.8.5 installed:

```python
import ifcopenshell
import ifcopenshell.geom
from ifcopenshell.util.shape import get_area, get_volume

model = ifcopenshell.open(
    "rust/geometry/tests/fixtures/downward_axis_half_cylinder.ifc"
)
shape = ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), model.by_id(16))
vertices = list(zip(*[iter(shape.verts)] * 3))
print("engine", ifcopenshell.version)
print("min", [min(v[i] for v in vertices) for i in range(3)])
print("max", [max(v[i] for v in vertices) for i in range(3)])
print("area", get_area(shape))
print("volume", get_volume(shape))
```

The regression tests also cover both normal signs, rotated placements,
circles/ellipses, Cartesian/parameter trims and both `SenseAgreement` values.
The shared profile processor serves native and WASM production paths.
