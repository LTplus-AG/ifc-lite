---
"@ifc-lite/export": patch
---

A merged STEP export with `normalize` keeps every model's georeference where the viewer put it alone, at the same scale. Coordinate operation offsets stay in the CRS unit; rigid operations used to be rescaled. A map conversion's Scale is divided by the length factor unless keeping it as written is what keeps the viewer's scale. A CRS without a MapUnit (or HeightUnit) is read as metres, as the viewer reads it, and a normalized model's own CRS is written with an explicit metre unit. Unifying two models' contexts reads a missing MapUnit the same way and compares the scale the viewer gives each model.
