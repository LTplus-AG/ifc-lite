---
"@ifc-lite/wasm": patch
---

Render `IfcSolarDevice` (and any future `IfcEnergyConversionDevice` / `IfcDistributionElement` subtype) without code changes.

The geometry pipeline previously gated entities through a hand-maintained leaf-level whitelist (`has_geometry_by_name`) and a hand-maintained leaf-level "secondary priority" blacklist (`is_simple_geometry_type`). New IFC4X3 subtypes silently fell through both — `IfcSolarDevice`, which inherits from `IfcEnergyConversionDevice`, was the latest casualty (PR #585).

Both functions now derive their answer from the EXPRESS inheritance graph via `IfcType::is_subtype_of`, so any subtype of an already-supported parent is picked up automatically. The legacy IFC2x3 / removed-in-IFC4x3 names not in the modern enum are resolved through the existing `legacy_entities` registry, which already carries a `has_geometry` flag per entry.

`has_geometry_by_name` also moved out of `rust/core/src/generated/schema.rs` (which is marked "DO NOT EDIT — auto-generated") into a new sibling module `schema_helpers.rs`, so a future re-run of `@ifc-lite/codegen` won't wipe it.

Co-authored with @geronimi73 (PR #585).
