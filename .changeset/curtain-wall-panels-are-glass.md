---
"@ifc-lite/create": patch
"@ifc-lite/viewer": patch
---

Curtain wall panels are now glass. `addCurtainWallToStore` gives every panel a shared translucent `IfcSurfaceStyle`, so the wall reads as glazing in the viewer and in the exported file. The viewer's re-mesh also picks up styles authored in the session, which it used to ignore until the model was exported and reloaded.
