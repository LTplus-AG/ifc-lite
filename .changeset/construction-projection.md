---
"@ifc-lite/drawing-2d": minor
---

Construction projection for 2D floor plans (#979). Project geometry beyond the
section cut as architectural reference lines — thin solid for the visible floor
side, dashed for overhead elements (beams, roofs, eaves).

New public API:
- `SectionConfig.projectionBelowDepth` / `projectionAboveDepth` — band depths
  for the visible/overhead split (default to `projectionDepth`).
- `GeneratorOptions.outlineProvider` — inject a winding-robust footprint outline
  (the Rust `meshOutline2d` binding) for non-extruded geometry; falls back to
  the mesh silhouette when absent.
- `projection-bands` exports: `classifyDepthRange`, `classifySegmentBand`,
  `signedDepth`, `bandVisibility`, `projectPointForPlane`,
  `getViewDirectionForPlane`, `outlineToProjectionLines`, and the
  `ProjectionBand` / `ProjectionBandDepths` / `MeshOutline2D` types.

`Drawing2DGenerator.generate`'s projection stage now sources lines from
profile boundaries + mesh silhouettes (replacing the noisy crease-edge path)
and classifies them into the below/above bands.
