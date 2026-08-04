---
"@ifc-lite/renderer": minor
---

Add a 3D DXF reference-layer overlay to the WebGPU renderer: `uploadDxfLines3D` / `clearDxfLines3D` upload a flat `[x,y,z,x,y,z,...]` line-list (mirroring the existing `uploadGridLines3D`/`uploadAlignmentLines3D` pattern — a dedicated buffer, drawn through the shared reference-overlay line pipeline and colour) and render it alongside the grid/alignment/annotation overlays.

Follow-up to the viewer's DXF import feature (issue #1782/#1929), which only ever rendered the imported DXF as a 2D drawing-panel underlay. Issue #2043 adds a 3D viewport toggle for the same DXF data (`apps/viewer`'s `DxfUnderlayPanel`, private package, no changeset needed for that half); this changeset covers the new renderer API those toggles call into.

Only line paths (walls/boundaries) are lifted to 3D in this iteration — DXF fills/hatches and text labels are not yet rendered in the 3D scene, and per-DXF-layer colour is not carried through (the 3D overlay shares one colour with the grid/alignment/annotation line family, same as those already do among themselves).
