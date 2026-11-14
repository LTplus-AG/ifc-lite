---
"@ifc-lite/parser": patch
---

In a bundle, loading the parser no longer decodes all three schema registries. The hierarchy relationship gate (every concrete `IfcRelationship` subtype across IFC2X3, IFC4 and IFC4X3, minus the property and association relationships) was built when its module loaded, which walked all three registries, so every bundle that loaded the parser (the browser parser worker before it could accept a parse) decoded them whatever schema the file declared. It is now built the first time a parse needs it, with the same contents. (An unbundled Node import still decodes the three registries when it loads their modules, because their exported `SCHEMA_REGISTRY` constants are evaluated there.)
