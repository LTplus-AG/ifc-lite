---
"@ifc-lite/export": patch
---

A merged STEP export with `normalize` keeps every model's georeference where the viewer put it alone. Coordinate operation offsets stay in the CRS unit; rigid operations used to be rescaled. A map conversion's Scale, which carries project-unit distances into map units, is divided by the length factor, except where the viewer ignores Scale. A CRS without a MapUnit (or HeightUnit) is read as metres, as the viewer reads it, and a normalized model's own CRS is written with an explicit metre unit. Unifying two models' contexts reads a missing MapUnit the same way.
