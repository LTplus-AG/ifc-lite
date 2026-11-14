---
"@ifc-lite/viewer": patch
---

Model info on a server-loaded model shows its real counts. "Building Storeys" and "Elements with Geometry" read 0 beside a hierarchy that listed the storeys: the server data model's type index was keyed by `IfcTypeEnum` member names (`IfcBuildingStorey`), while every lookup uses the uppercase STEP name a parsed store carries, and classes the enum lacks were all filed under `Unknown`. The index now holds each declared class under its uppercase name.
