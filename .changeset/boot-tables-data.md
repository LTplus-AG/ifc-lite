---
"@ifc-lite/data": minor
---

Schema-table constants no longer have to be decoded at load. Each generated table's exported constant (`ENTITIES_IFC4X3`, `IFC_DATA_TYPES`, …) is now written `eagerSchemaTable('ifc-lite-eager-table:<NAME>', getter)`, which returns the same object the getter does. The new exports `eagerSchemaTable` and `eagerSchemaTablesEvaluated` let a bundle's build-tail check tell where a constant was kept (its marker string survives exactly where the constant does) and a test see which constants a realm evaluated. Values and the existing exports are unchanged.
