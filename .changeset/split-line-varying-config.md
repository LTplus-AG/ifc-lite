---
"@ifc-lite/export": patch
---

An IFC4 to IFC2X3 export now refuses a file where an `IfcStructuralLoadConfiguration` is named by a record split over several lines. The writer passes such a record through as it is, so it kept naming a configuration the IFC2X3 file never holds (#10715).
