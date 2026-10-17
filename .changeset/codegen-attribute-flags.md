---
'@ifc-lite/codegen': minor
---

The Rust emitter writes `IfcType::attribute_flags()` beside `attribute_names()`: one byte per attribute holding the resolved value kind, an aggregate bit and an optional bit, resolved through defined types and selects. A type name that resolves to nothing now fails generation instead of defaulting. `IfcType::attribute_index` is no longer emitted; `SchemaVersion::attribute` in `ifc-lite-core` replaces it.
