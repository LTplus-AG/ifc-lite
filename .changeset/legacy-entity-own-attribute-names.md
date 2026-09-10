---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": patch
---

Stop silently dropping a legacy (IFC2X3/IFC4, removed-by-IFC4X3) entity's own attributes from the Rust attribute exporter.

`rust/export/src/model_props.rs`'s `render_attributes` read `entity.ifc_type.attribute_names()`, and `entity.ifc_type` is decoded via a bare `IfcType::from_str` in the tokenizer — `Unknown` for any legacy entity, whose `attribute_names()` is `&[]`. So a legacy product or type product (`IFCDOORSTYLE`, `IFCPROXY`, `IFCSLABSTANDARDCASE`, …) already got a correctly-typed, correctly-meshed row — `model.rs` resolves the row's DISPLAY type legacy-aware — but every own-class attribute on that row (`IfcDoorType.OperationType`, `IfcBuildingElementProxy`'s attributes, …) silently vanished from the attribute export, for all 26 names `legacy_entities.rs` already resolves.

The fix is not "use the resolved base type's attribute names" — that is unsafe. `IFCDOORSTYLE` (IFC2X3/IFC4) ends `…, OperationType, ConstructionType, ParameterTakesPrecedence, Sizeable`; its resolved base type `IfcDoorType` (IFC4X3) ends `…, PredefinedType, OperationType, ParameterTakesPrecedence, UserDefinedOperationType` — same length, different names from index 8 on, so borrowing the base type's names would rename `Sizeable`'s value to `UserDefinedOperationType` instead of merely dropping it.

`scripts/generate-legacy-attribute-names.mjs` (#4203) generates `rust/core/src/generated/legacy_attribute_names.rs`: each legacy entity's OWN positional attribute names, read from the same EXPRESS-derived tables the TypeScript side already generates (`packages/data/src/ifc-schema/generated/entities-ifc2x3.ts`, `entities-ifc4.ts`) — not a new EXPRESS parser, and not an approximation. `render_attributes` now consults this table first and falls back to the modern enum's `attribute_names()` unchanged for every name the generated schema already resolves, so an ordinary IFC4X3 class's export is untouched.

This addresses one half of #4203 (generating attribute data per schema version for the classes IFC4X3's `from_str` cannot resolve). It does not change `IfcType::from_str` itself, which still returns `Unknown(u32)` for these names — only the attribute-export path now has a version-correct answer. `legacy_entities.rs` and `rooted_type.rs`'s `LEGACY_ROOTED_TYPES` are unchanged and not attempted for deletion in this PR.
