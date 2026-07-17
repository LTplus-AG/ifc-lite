---
"@ifc-lite/data": minor
"@ifc-lite/parser": patch
---

Preserve the STEP token kind (Enum vs quoted String) through the columnar parser (#1799). `EntityExtractor` now records which top-level attributes were bare enumeration tokens (`.USERDEFINED.`) in a new optional `IfcEntity.enumAttrIndices` side channel — the value representation is unchanged (enums are still stored as dotted strings), so existing consumers are unaffected. `extractRootAttributesFromEntity` rejects enum tokens on the unknown-type fixed-index fallback by token KIND instead of the #1779 dotted-string shape heuristic: a quoted string that merely looks like an enum (`'.USERDEFINED.'`) now survives, exactly matching the Rust server path's `AttributeValue::String` / `AttributeValue::Enum` split, while a bare `PredefinedType` enum landing on a fallback slot (e.g. IFC4X3 `IfcAlignment` attr 7) is still blanked.
