---
"@ifc-lite/viewer": patch
---

A streamed IFC is no longer uploaded to the GPU a second time when a model without meshes (a point-cloud scan) joins after it, or when its camera first fits at the end of streaming. Its triangle count no longer doubles or depends on load order (#6953).
