<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Per-face geometry export colors (#6601)

The GeoBIM MPL source release `geobim-2026-09-24` exposed per-face colors
through its Python geometry export. This implementation keeps material
association in the canonical Rust exporter and uses a thin Python adapter.
The existing Rust `ExportedElement` and legacy builder remain compatible;
the additional color-aware API supplies optional palette metadata.

`rust/processing/tests/fixtures/issue_6601_multicolor_element.ifc` is a
synthetic geometric/style invariant, not an authoring-tool reproduction.
One product contains two square extrusions, with opaque red and green at
75% transparency. An independent IfcOpenShell 0.8.5 / OpenCascade run
produced 12 triangles in each material, red `(1,0,0)` with transparency 0,
and green `(0,1,0)` with transparency 0.75. The Python wheel test loads
this exact IFC through production processing, compares JSON and buffer
exports, and verifies RGBA alpha 0.25 for green.

Reproduce the independent oracle with IfcOpenShell 0.8.5:

```python
import ifcopenshell
import ifcopenshell.geom

model = ifcopenshell.open(
    "rust/processing/tests/fixtures/issue_6601_multicolor_element.ifc"
)
shape = ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), model.by_id(23))
print("engine", ifcopenshell.version)
for index, material in enumerate(shape.geometry.materials):
    print(index, material.diffuse, material.transparency,
          shape.geometry.material_ids.count(index))
```

Rust regression tests also establish that welding removes material indices
alongside collapsed triangles; optional metadata disappears only when the
fallback color suffices; signed zero does not duplicate a palette entry;
and more than 65,536 materials do not wrap an index.
