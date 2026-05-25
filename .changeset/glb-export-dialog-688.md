---
"@ifc-lite/viewer": minor
"@ifc-lite/export": minor
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
---

Add GLB export dialog with colour-source selection and visibility
filtering (PR #688).

The new `GLBExportDialog` in the viewer replaces the inline GLB
export handler in `MainToolbar` with a dedicated dialog. Features:

- **Model picker** for federated multi-model scenes.
- **Colour source** selector: "Rendering" (the apparent display
  colour — `IfcSurfaceStyleRendering.DiffuseColour` if authored,
  falling back to `IfcSurfaceStyleShading.SurfaceColour`) or
  "Shading" (the raw `SurfaceColour`, only available when the file
  authored a distinct `DiffuseColour`).
- **Visible-only filter** that respects the viewer's hidden /
  isolated entity sets. Mesh-vs-set comparison runs in global ID
  space so federated models with non-zero `idOffset` filter
  correctly.
- **Metadata inclusion** toggle for IFC GlobalId / type / name
  side-tables.

Pipeline changes underneath:

- `MeshData` / `MeshDataJs` carry an optional `shadingColor`
  alongside `color`. The Rust styling module now extracts both
  `IfcSurfaceStyleRendering.DiffuseColour` (rendering) and
  `IfcSurfaceStyleShading.SurfaceColour` (shading) in a single
  pre-pass and returns them as separate maps; `shadingColor` is
  only populated when it actually differs from the rendering
  colour, so memory cost stays sparse on the common case.
- The streaming geometry path
  (`convertMeshCollectionToBatch`) and the worker collector
  (`IfcLiteMeshCollector`) both copy `shadingColor` end-to-end so
  the dialog's "Shading" source works on every load path, not just
  the batch path.
- `GLTFExporter` gains `colorSource`, `visibleOnly`,
  `hiddenEntityIds`, and `isolatedEntityIds` options. Visibility
  filtering compares mesh `expressId` (global) against the dialog-
  supplied sets (also global) — no offset arithmetic in the
  exporter.
