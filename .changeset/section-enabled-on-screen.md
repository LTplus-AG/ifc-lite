---
"@ifc-lite/viewer": patch
"@ifc-lite/viewer-embed": patch
---

The section cut state now matches what the 3D view shows. Leaving the Section tool hides the cut, and the viewer no longer reports it as active: `bim.viewer.getSection()` returns `null` and the view PDF export prints no cut. Reopening the Section tool brings the cut back, face-picked planes included. `bim.viewer.setSection({ enabled: true })` and applying a BCF viewpoint with clipping planes open the Section tool so the cut is visible. Applying a viewpoint without clipping planes clears any cut. The embed `SET_SECTION` command with `enabled: true` now shows the cut too.
