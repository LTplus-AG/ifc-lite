---
'@ifc-lite/wasm': patch
---

An element whose material is associated on its `IfcTypeObject` (e.g. `IfcRelAssociatesMaterial` targeting an `IfcWallType`) rather than on the occurrence itself is now coloured by that type's material in the shared prepass resolver (native and browser), unless the occurrence carries its own `IfcRelAssociatesMaterial` (occurrence overrides type). Previously `resolve_prepass` built `element_to_material` only from direct occurrence associations, so a type-associated material was recorded under the type's own express id and never reached any occurrence — a common authoring pattern (material attached at the type) rendered every such element in the default type colour instead of its material's appearance.
