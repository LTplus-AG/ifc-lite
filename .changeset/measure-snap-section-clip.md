---
'@ifc-lite/renderer': patch
'@ifc-lite/viewer': patch
---

Measure magnetic snap now follows the active section: it no longer snaps to geometry or scan points the section removed, snaps to the cut contour, and treats a drawn cut face as the surface under the cursor.
