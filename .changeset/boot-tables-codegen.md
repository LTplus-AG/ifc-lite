---
"@ifc-lite/codegen": patch
---

Each generated `SCHEMA_REGISTRY` constant carries a marker (`ifc-lite-eager-table:SCHEMA_REGISTRY:<schema>`) that survives in a built bundle exactly where the constant does, so a bundler build can check that its startup chunks do not decode a registry at load. The registry, `getSchemaRegistry()` and the lookup helpers are unchanged.
