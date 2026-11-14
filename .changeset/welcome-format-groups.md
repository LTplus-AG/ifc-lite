---
"@ifc-lite/viewer": patch
---

The welcome card lists the formats a drop opens by family (IFC, glTF, point clouds, terrain, underlays, splats) instead of one run of 13 extensions. `.xml` is named as LandXML, and `.dxf` and `.splat`, which already opened on drop, are now listed. The rows come from the same definition as the pickers and the drop guard, so the card cannot drift from what loads.
