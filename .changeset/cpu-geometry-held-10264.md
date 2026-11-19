---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Diagnostics for #10264: `Renderer.visitCpuGeometry(visit)` hands typed-array geometry and index buffers held by the scene and raycast index to a visitor, by holder, without copying anything. This includes streaming fragment pieces and recorded stream runs. The viewer uses it for `__ifc_lite_cpu_geometry_held__()`, which counts each underlying buffer once among the measured holders. JavaScript heap structures are outside the figure. Nothing runs unless the hook is called; no behaviour changes.
