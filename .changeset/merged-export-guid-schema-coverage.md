---
"@ifc-lite/wasm": patch
---

Fix the native (Rust) merged/federated IFC exporter still missing GlobalIds
on older-schema (IFC2X3/IFC4) models after the recent GlobalId-misidentification
fix.

`leading_guid` in `rust/export/src/merged.rs` checks whether an entity's type
derives from `IfcRoot` via `IfcType::is_subtype_of`, resolved against
`rust/core`'s generated schema table -- which is generated from IFC4X3 only.
A rooted entity type that exists in IFC2X3 and/or IFC4 but was dropped or
renamed in IFC4X3 (`IFCPROXY`, `IFCDOORSTYLE`, `IFCWINDOWSTYLE`, the IFC4
`*STANDARDCASE`/`*ELEMENTEDCASE` variants, and others -- 54 in total)
resolves to `IfcType::Unknown`, which is never a subtype of anything, so its
GlobalId was skipped entirely. Merging two such models sharing one of these
entities (a shared door/window style, a shared `IFCPROXY`, etc.) emitted that
GlobalId twice into one file -- the same defect the schema-derived check was
meant to close, just on older files.

`leading_guid` now also treats an `Unknown`-resolved type as rooted when it
matches a small supplemental table of IFC2X3/IFC4-only rooted types (derived
by diffing `@ifc-lite/data`'s per-schema entity tables against the
IFC4X3-only generated schema). Anything genuinely unrecognised is still
treated as non-rooted, so the corruption the misidentification fix closed
stays closed.
