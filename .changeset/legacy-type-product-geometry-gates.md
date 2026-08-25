---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": patch
---

Render the type geometry of IFC2X3 `IfcDoorStyle`, `IfcWindowStyle` and `IfcBuildingElementType`, which every pass silently dropped.

`schema_helpers.rs` states the rule: a pass that *classifies* a keyword must resolve it through `legacy_aware_ifc_type`, because `DecodedEntity.ifc_type` is a bare `IfcType::from_str` and is deliberately literal. Six type-geometry candidate gates did not — the native processor, the streaming and sharded browser pre-passes, the sharded discovery pass, the styling pre-pass, and the attribute export's type-product pass. Five of the six ran `IfcType::from_str(keyword).is_subtype_of(IfcTypeProduct)` behind an `ends_with("TYPE") || ends_with("STYLE")` pre-filter. The sixth, the sharded discovery pass, ran neither: it re-labels a span some other pass already flagged, so it pushed a bare `IfcType::from_str(keyword)` unconditionally and put `Unknown` on the wire instead of dropping the entity.

For the three IFC2X3 type products IFC4X3 dropped, `from_str` answers `Unknown`, `Unknown` is a subtype of nothing, and the entity was discarded before it could become a job. They also carry `has_geometry: false` in `legacy_entities.rs`, so the ordinary product route did not reach them either. An IFC2X3 file that authors its door geometry on an `IfcDoorStyle`'s `RepresentationMaps` — the IFC2X3 spelling of the #957 orphan-type case — rendered nothing at all, in the browser, the CLI and every exporter alike.

The six gates now share one predicate, `ifc_lite_core::type_product_ifc_type`, so a keyword one admits and another drops is no longer expressible. Sweeping the generated schema catalog and the whole legacy table shows it widens by exactly those three keywords and narrows nowhere; none of the three is also an ordinary geometry job or an `IfcProduct`, so nothing is double-counted, and no bundled fixture contains one, so no existing mesh or element count moves.
