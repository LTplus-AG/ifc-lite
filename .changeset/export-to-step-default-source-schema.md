---
'@ifc-lite/export': minor
---

fix(export): default `exportToStep` to the source schema instead of a hardcoded `IFC4`

`exportToStep(store)` called without an explicit `schema` hardcoded
`schema: 'IFC4'`, so it silently schema-CONVERTED every non-IFC4 model: an
IFC2X3 or IFC4X3 file came back out under a `FILE_SCHEMA(('IFC4'))` header —
the wrong schema token, and an invalid file wherever the source used
schema-specific entities (e.g. an IFC4X3 model's `IfcRoad` / `IfcCourse` /
`IfcPavement`, which have no IFC4 equivalent). The default now falls back to
`dataStore.schemaVersion`, matching `StepExporter.export()`'s own fallback and
the `?? store.schemaVersion ?? 'IFC4'` guard every internal caller already
spelled out, so a plain `exportToStep(store)` round-trip preserves the model's
schema. Pass `schema` explicitly to convert, exactly as before.
