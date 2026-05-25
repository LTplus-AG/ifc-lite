---
"@ifc-lite/viewer": minor
"@ifc-lite/renderer": minor
"@ifc-lite/wasm": minor
---

Render IfcAnnotation 2D representations as a 3D drawing-layer overlay
(closes #653). Implements the BIMVision-style "model + annotations =
engineering drawing" effect described by the OP.

What's covered:

- **Rust WASM**: new `SymbolicText` and `SymbolicFillArea` types
  carried alongside the existing symbolic polyline output. The parser
  walks `IfcTextLiteralWithExtent.Placement` and
  `IfcAnnotationFillArea.OuterBoundary`/`InnerBoundaries` (across
  `IfcPolyline` and `IfcIndexedPolyCurve`).
- **TS hook**: `useSymbolicAnnotationsRichData()` returns 3D-lifted
  texts + fills with per-storey resolution. Module-level parse cache
  is now keyed on `byteLength + FNV-1a fingerprints of head/mid/tail`,
  so federated views with same-size IFCs no longer alias each other.
  Storey elevation handling distinguishes "no authored elevation"
  from "elevation = 0.0" (the previous sentinel collapsed both to
  the fallback Y).
- **Renderer**: two new WebGPU pipelines — `SymbolicFillPipeline`
  (ear-clipping triangulation with rightmost-vertex bridge-edge
  hole stitching, premultiplied-alpha blend) and
  `SymbolicTextPipeline` (Canvas2D glyph atlas → instanced WebGPU
  quads). Both declare matching MSAA sample count + the 2-color-
  target attachment shape used by the main render pass, and run with
  reverse-Z `greater-equal` depth compare so they composite correctly
  against the scene.
- **Viewport wiring**: `Viewport.tsx` calls the new hook unconditionally
  whenever the user enables the IFC Annotations toggle — no section-
  plane gating, since annotations are a free-floating drawing layer.

Deferred (no behaviour change, follow-up):

- `IfcStyledItem` → `IfcFillAreaStyleHatching` resolution. The parser
  stubs in a default opaque dark-grey solid fill; the renderer is
  ready to consume a hatch style once the styled-item index lands.
