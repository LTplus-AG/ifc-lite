---
"@ifc-lite/codegen": minor
"@ifc-lite/parser": patch
---

The generated schema registries are about a tenth of their former size and are decoded the first time they are used. Each `schema-registry.ts` used to be one object literal (IFC4 1.6 MB of source, IFC4X3 1.9 MB, IFC2X3 1.3 MB) that every bundle carrying it compiled and evaluated on load. It is now a compact string (each name once, each distinct attribute once, inherited attribute lists and ancestry recorded as "derived from the parent" where that is exact) that decodes to the same registry: the same keys in the same order and the same values. `SCHEMA_REGISTRY` and the lookup helpers are unchanged and stay synchronous. The new `getSchemaRegistry()` in `@ifc-lite/codegen/ifc4`, `/ifc4x3` and `/ifc2x3` returns the same object, decoding it on first call, for code that may never need a given schema. The parser's per-version lookup (`getSchemaRegistryForVersion`) goes through it.
