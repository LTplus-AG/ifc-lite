---
"@ifc-lite/viewer": patch
---

With `?compactGeom` on, the camera fit no longer decodes every compact mesh on the main thread while a model streams in: it reads each compact mesh's exact source box from its record row. The fit now reads the same per-mesh boxes as the f32 load, where it used to read the lattice positions (up to half a step off). Each compact mesh weighs by its welded vertex count, so the outlier trim of a model with a far tail can still weigh meshes differently from the f32 load.
