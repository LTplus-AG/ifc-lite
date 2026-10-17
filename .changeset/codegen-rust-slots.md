---
'@ifc-lite/codegen': minor
---

Emit typed Rust attribute slots (`slots.rs`): one zero-sized struct per entity with a `Slot<Kind>` const per attribute, flattened across the supertype chain, and a `SchemaSlot<Kind>` for the attributes whose position moves between IFC releases. New `--rust-slot-schema` and `--rust-slot-renames` options and the validated `schemas/attribute-renames.json` rename table.
