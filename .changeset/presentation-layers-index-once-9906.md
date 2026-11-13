---
"@ifc-lite/viewer": patch
"@ifc-lite/parser": patch
---

Opening the hierarchy's Presentation layers grouping no longer blocks for tens of seconds on a large BREP model (#9906). The viewer now builds the `IfcPresentationLayerAssignment` membership index once per model and overlay revision instead of once per tree build, and reads only the records a product owns down to its shape representations unless a layer is assigned to an item below one. In `@ifc-lite/parser`, a schema entity-name lookup without a snapshot (`getCanonicalEntityName`, `getAttributeNamesForSchema`, `effectiveMetadataRecord` on a model with no overlay) compares the registry's ordered keys directly instead of serialising them on every call; results are unchanged.
