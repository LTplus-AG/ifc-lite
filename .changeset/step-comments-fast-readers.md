---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

A STEP comment (`/* ... */`) inside a coordinate or index list, or between attributes, is now skipped by the fast readers instead of read as data. A digit in a comment inside an `IfcCartesianPointList3D` no longer becomes an extra coordinate that shifts every vertex after it, a comma or apostrophe in a comment no longer shifts the attributes the quick spatial tree reads from `IfcRelAggregates` and the containment relationships, and a comment beside a `-0` in `IfcSite.RefLatitude` or `RefLongitude` no longer loses the southern or western sign.
