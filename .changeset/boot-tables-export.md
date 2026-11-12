---
"@ifc-lite/export": patch
---

Loading `@ifc-lite/export` no longer decodes the schema tables. The retype, subset, attribute-slot and STEP-serialization lookups built their per-schema maps from the table constants when their modules loaded, and every reference to a table constant kept it decoded at load in a bundle. They now build on first use from the tables' getters and the parser's `getSchemaRegistryForVersion`, with the same contents. `isMaterialDefinition` reads the parser's IFC4 and IFC4X3 registries instead of `@ifc-lite/codegen`'s identical copies, so a bundle decodes each schema once.
