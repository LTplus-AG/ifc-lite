---
"@ifc-lite/data": minor
"@ifc-lite/parser": patch
---

The generated schema tables in `@ifc-lite/data` (attributes, entities, property sets and data types per IFC version) are less than half their former size and are decoded the first time they are used. They used to be object literals (`attributes.ts` alone was 1 MB of source) that every bundle carrying them compiled and evaluated on load. Each is now a compact string (every string and every object shape named once) that decodes to the same value: the same keys in the same order, including the `parent: undefined` of a root entity. The exported constants (`ENTITIES_IFC4X3`, `IFC_DATA_TYPES`, …) are unchanged and synchronous. New getters `getEntitiesIfc2x3()`, `getEntitiesIfc4Express()`, `getEntitiesIfc4x3()` and `getIfcDataTypes()` return the same arrays, decoding on first call. The parser's cross-schema entity lookup and the package's versioned lookups (`getEntities`, `getAttributes`, `getPropertySets`, `getAttributeXsdTypes`, …) use them, so loading either package decodes no table until something asks.
