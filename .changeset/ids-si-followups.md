---
"@ifc-lite/ids": patch
---

IDS: compare measure-typed attributes (for example `IfcDoor.OverallHeight`) in SI, inherit predefined property sets (for example `IfcDoorLiningProperties`) from a type object's `HasPropertySets` onto its occurrences in SI, and leave an area or volume unconverted when a multi-project file's owning project declares an AREAUNIT or VOLUMEUNIT it cannot resolve (#7395).
