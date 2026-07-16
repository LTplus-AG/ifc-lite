---
"@ifc-lite/parser": patch
---

Fix By Material tab / material totals missing materials associated to TYPE entities (#1755). `buildMaterialUsageIndex` now expands `IfcRelAssociatesMaterial` targets that are type entities (e.g. `IfcDoorType`) to their occurrences via forward `IfcRelDefinesByType` edges, with occurrence-level associations taking precedence (IFC semantics) and no double counting. Previously the usage index keyed such materials to the type entity itself, which the viewer's By Material tree dropped via its geometry filter and the totals panel mis-attributed.
