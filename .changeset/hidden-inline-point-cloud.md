---
"@ifc-lite/renderer": patch
---

An inline point cloud whose entity is hidden, or left out of an isolation, is no longer drawn or clickable, and is drawn again once shown (#10215). Seen with a Rhino .3dm whose point cloud sits on a layer that is off. Streamed scans are unchanged.
