---
"@ifc-lite/viewer": patch
---

Add the data model for snapped linear dimensions on the 2D drawing panel (no tool or drawing yet). Dimensions are stored with the other drawing markup in the existing per-model saved entry as an optional field, so markup saved by earlier versions loads unchanged. A browser tab still running an older viewer version does not know the field and drops any dimensions on its next auto-save of that model; reload old tabs after updating. A dimension remembers the cut it was drawn on; once there is a tool for them, dimensions from another cut are left out of exports. The default dimension value is whole millimetres (4.2624 m reads `4262`); a viewer length unit setting still applies.
