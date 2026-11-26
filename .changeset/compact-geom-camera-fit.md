---
"@ifc-lite/viewer": patch
---

With `?compactGeom` on, the camera fit no longer decodes every compact mesh on the main thread while a model streams in: it reads each compact mesh's exact source box from its record row. The home view of a compact load now frames the same box as the f32 load, where it used to frame the lattice positions (up to half a step off) and sit a fraction of a millimetre away.
