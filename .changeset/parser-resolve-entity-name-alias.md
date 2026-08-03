---
'@ifc-lite/parser': minor
---

Export `resolveEntityNameAlias(type)`, which resolves an entity name through the legacy-alias table (`IfcSolidStratum` / `IfcVoidStratum` / `IfcWaterStratum` → `IfcGeotechnicalStratum`) and returns the name unchanged otherwise.

Consumers that index the bundled schema union themselves — the STEP exporter's enum-slot resolution is the first — have to canonicalize exactly the way `getAttributeNamesAcrossSchemas` does, or their slot indices refer to a different attribute list than the names those indices are meant to index into. The table already has two homes (here and `rust/core/src/legacy_entities.rs`); exporting the resolver keeps a third from appearing. `getAttributeNamesAcrossSchemas` and the union inheritance walk now route through it too, so it is the one code path rather than a copy that can drift.
