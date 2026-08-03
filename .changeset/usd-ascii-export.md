---
"@ifc-lite/geometry": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Add OpenUSD ASCII (`.usda`) export — a real Z-up USD stage, distinct from the existing IFCX (USD-flavored JSON) export.

The stage mirrors the IFC spatial hierarchy as `Xform` prims with `UsdGeomMesh` geometry, `UsdPreviewSurface` materials, and IFC metadata (`ifc:class`, `ifc:GlobalId`, property/quantity sets) as custom attributes; it opens in usdview / Blender / Omniverse. Geometry outside the spatial tree (opening elements, type-product meshes) is placed under a synthetic `Unassigned` prim rather than dropped, and each mesh carries its placement as a `double3 xformOp:translate` so georeferenced models keep full precision.

- `@ifc-lite/geometry`: `GeometryProcessor.exportUsd(bytes)` (and `IfcLiteBridge.exportUsd`) returning the `.usda` bytes.
- `@ifc-lite/cli`: `ifc-lite export --format usd` (whole-model; entity filters do not apply).
- `@ifc-lite/mcp`: the `export_usd` tool.
