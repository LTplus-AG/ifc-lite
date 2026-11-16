---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Diagnostics for #10264: `Renderer.visitCpuGeometry(visit)` hands every CPU geometry array the scene and the raycast index still reference to a visitor, by holder, without copying anything. The viewer uses it for `__ifc_lite_cpu_geometry_held__()`, a debug hook that reports the bytes of CPU geometry held on the main thread, counted once per underlying buffer and split by holder (store, scene, raycast index). Nothing runs unless the hook is called; no behaviour changes.
