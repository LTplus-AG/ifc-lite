---
"@ifc-lite/export": patch
---

A merged STEP export with `normalize` keeps every model's georeference in place. A coordinate operation is no longer rescaled with the model's lengths; rigid operations used to be. A CRS without a MapUnit (or HeightUnit) is read as metres, as the viewer reads it, and a normalized model's CRS is written with an explicit metre unit, so a spec reader agrees with the viewer. Unifying two models' contexts reads a missing MapUnit the same way.
