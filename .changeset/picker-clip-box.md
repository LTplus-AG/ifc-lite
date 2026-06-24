---
"@ifc-lite/renderer": minor
---

Picking now mirrors the active section plane and clip box from the last render, so geometry clipped away by `RenderOptions.sectionPlane` or `RenderOptions.clipBox` is unpickable (single-click `pick` and rectangle `pickRect`), not just invisible. Both pick paths are covered: the GPU picker shaders and the CPU raycast fallback used for batched / large / released-geometry models (the latter falls through a sectioned/cropped surface to the nearest visible one behind it). No consumer wiring is needed: the renderer stashes what it actually clipped each frame and feeds it to the picker, so selection always matches what is visible. Point clouds are clipped by the section plane (matching the point render); the crop box clips triangle meshes only. (#1329)
