---
'@ifc-lite/wasm': patch
---

Fix `ifc-lite export --format step` (and `ifc-lite convert --schema IFC2X3`, both backed by the Rust `wasm` export path) silently corrupting every `IfcDoorType`/`IfcWindowType` on an IFC4/IFC4X3 → IFC2X3 downgrade instead of mapping it to its real IFC2X3 target.

`schema_convert.rs`'s `map_4_to_2x3` had no entry for `IFCDOORTYPE`/`IFCWINDOWTYPE`, so `convert_entity_type` left the type name unchanged and the line was emitted as an unrecognized `IFCDOORTYPE`/`IFCWINDOWTYPE` in an IFC2X3-schema file — invalid STEP, and losing the fact that IFC2X3 has a real target for both: `IfcDoorStyle`/`IfcWindowStyle`. This is the Rust twin of the TS `packages/export/src/schema-converter.ts` fix (#3653); the two converters previously disagreed on this case.

`map_4_to_2x3` now maps `IFCDOORTYPE`/`IFCWINDOWTYPE` to `IFCDOORSTYLE`/`IFCWINDOWSTYLE`. Their attribute lists only partially overlap by name (IFC4 inserted `ElementType`/`PredefinedType` ahead of the attributes it kept), so a new `by_name_attr_remap_names` + `remap_attrs_by_name` pair reconciles them by attribute NAME rather than the generic positional trim, preserving `GlobalId`/`Name`/`Description`/`HasPropertySets`/`RepresentationMaps`/`Tag`/`OperationType`/`ParameterTakesPrecedence` and `$`-ing out only the attributes IFC2X3's `IfcDoorStyle`/`IfcWindowStyle` genuinely don't carry under that name. This is a deliberately narrow allowlist scoped to exactly these two types; every other rename in `map_4_to_2x3` keeps its existing positional trim/pass-through behavior unchanged.
