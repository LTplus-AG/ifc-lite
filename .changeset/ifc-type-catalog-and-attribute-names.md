---
"@ifc-lite/codegen": patch
---

The Rust generator now emits the schema catalog and each entity's attribute names.

`IfcType::ALL` (re-exported as `ifc_lite_core::IFC_TYPES`) is every entity the
EXPRESS schema declares: the enum is exhaustive but not enumerable, so anything
reasoning about the whole schema previously had to re-parse the EXPRESS file or
scrape the generated source.

`attribute_names()` / `attribute_index(name)` come from the same inheritance-aware
walk the TypeScript generator uses, so a positional index can be looked up by name
instead of hardcoded with a comment beside it.

Also emits two attributes the committed Rust file carried but the generator never
produced, so regenerating no longer silently drops them.
