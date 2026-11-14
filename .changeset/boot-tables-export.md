---
"@ifc-lite/export": patch
---

In a bundle, loading `@ifc-lite/export` no longer decodes the schema tables (In a bundle; an unbundled Node import still evaluates the exported table constants when their modules load.) The retype, subset, attribute-slot, STEP-serialization, STEP-token-to-registry-name and non-relationship reference-list lookups built their per-schema maps from the table constants when their modules loaded, and every reference to a table constant kept it decoded at load in a bundle. They now build on first use from the tables' getters and the parser's `getSchemaRegistryForVersion`, with the same contents. `isMaterialDefinition` reads the parser's IFC4 and IFC4X3 registries instead of `@ifc-lite/codegen`'s identical copies, so a bundle decodes each schema once.
