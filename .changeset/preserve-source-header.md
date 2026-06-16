---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/export": minor
"@ifc-lite/codegen": patch
---

Preserve source IFC HEADER fields on round-trip export. Re-exporting an
imported file previously regenerated a fresh ifc-lite header, silently dropping
the source `FILE_DESCRIPTION` items (any `ViewDefinition [...]` label and vendor
identifier / coordinate-reference strings) and flattening the exact
`FILE_SCHEMA` token (e.g. `IFC4X3_ADD2` → `IFC4X3`, which some toolchains
reject).

The parser now captures the verbatim HEADER onto a new
`IfcDataStore.sourceHeader` (`IfcSourceHeader`, exported from `@ifc-lite/data`;
parser also exports `parseSourceHeader`), threaded through the worker transport.
`StepExporter` reproduces the source `FILE_DESCRIPTION` items and the exact
`FILE_SCHEMA` token when not converting schemas, falling back to parsing the
source bytes for cache-restored stores. Provenance stays honest:
`preprocessor_version` is set to `ifc-lite` while the source authoring tool is
kept as `originating_system`, and when mutations exist exactly one
`Re-exported by ifc-lite, N modification(s)` item is appended without removing
the source items. `generateHeader` now accepts description/author/organization
arrays plus a free-form schema token and STEP-escapes all fields; it also emits
a properly parenthesised `FILE_DESCRIPTION` list (the prior single-string form
was malformed STEP). Created-from-scratch (`IfcCreator`) and federated/merged
exports are unaffected — they keep their own provenance headers by design.
