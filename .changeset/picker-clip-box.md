---
"@ifc-lite/renderer": minor
---

The GPU picker now mirrors the active section plane and clip box from the last render, so geometry clipped away by `RenderOptions.sectionPlane` or `RenderOptions.clipBox` is unpickable (both single-click `pick` and rectangle `pickRect`), not just invisible. No consumer wiring is needed: the renderer stashes what it actually clipped each frame and feeds it to the picker, so selection always matches what is visible. Points are not clipped, matching the render pass. (#1329)
