---
"@ifc-lite/ids": minor
"@ifc-lite/ids-authoring": patch
---

Export the IFC2X3 occurrence/type mapping lookup from `@ifc-lite/ids` as `ifc2x3TypeMappingForAlias`. The `@ifc-lite/ids-authoring` grounding gate now uses it, so an IFC2X3 entity facet that names an IFC4 class such as `IfcAirTerminal` is accepted like the audit accepts it, and its predefined type is checked against the mapped type object (`IfcAirTerminalType`).
