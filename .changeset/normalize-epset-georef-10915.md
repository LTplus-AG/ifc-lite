---
"@ifc-lite/export": patch
---

A merged STEP export with `normalize` keeps an IFC2X3 model's `ePSet_MapConversion` georeference where the viewer put it alone. Its Eastings, Northings and OrthogonalHeight are no longer rescaled. An `ePSet_ProjectedCRS` without a MapUnit gets a `METRE` one, as the viewer reads a missing MapUnit. The Scale property follows the same rule as `IfcMapConversion.Scale`.
