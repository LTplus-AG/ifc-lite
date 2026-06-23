---
"@ifc-lite/renderer": minor
---

Add `RenderOptions.clipBox` — an axis-aligned, world-space clip box (section / crop box). The fragment shader discards geometry outside the six box planes, so consumers can crop to a real geometry cut instead of bounding-box element isolation. Independent of `sectionPlane`; both can be active. (#1329)
