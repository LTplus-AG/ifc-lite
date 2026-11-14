---
"@ifc-lite/ids": patch
---

In a bundle, loading `@ifc-lite/ids` no longer decodes the schema registries (In a bundle; an unbundled Node import still evaluates the exported table constants when their modules load.) The resource-classification predicate reads the parser's IFC4 and IFC4X3 registries, built on first use, instead of `@ifc-lite/codegen`'s identical copies, and the defined-type walk reads the IFC4 pin through `getSchemaRegistryForVersion`. Same answers; one decode of each schema per bundle.
