---
"@ifc-lite/wasm": patch
---

Label legacy IFC keywords with their resolved type in the browser, not `"Unknown"`.

The native pipeline resolves a legacy keyword through `legacy_entities.rs` and labels the node with its real base type. The browser path did not: the jobs wire carries only `(id, start, end)`, so `batch.rs` rebuilt the type from `entity.ifc_type` — the decoder's bare `IfcType::from_str` — and a legacy keyword that reached that path arrived as `Unknown` with the Unknown default colour. The 22 `legacy_entities.rs` arms that carry geometry are fixed here, among them `IfcProxy`, the eight `*StandardCase` variants, both `*ElementedCase`, `IfcEquipmentElement`, the three IFC4X3 strata leaves and the six #3172 added. Type-exact visibility rules and styling consumers skipped them, and nothing threw.

`IfcDoorStyle` and `IfcWindowStyle` are NOT fixed by this change. The pre-passes gate type-geometry candidates on a bare `IfcType::from_str(name).is_subtype_of(IfcTypeProduct)`, which is false for any keyword IFC4X3 dropped, so both are discarded before a geometry job exists and never reach the corrected line. That is the same defect one layer up; #3187 enumerates the sites.

It cannot be recovered from the decoded value: `IfcType::Unknown` stores a CRC32 hash, not the name. It is recomputed from the record instead, which the batch already holds — a short scan to the first `(`, paid only by entities the decoder could not name.

Fixing it surfaced a second defect. `extract_entity_type_name` did not trim, so `#71= IFCCOLUMN(` — legal STEP, and what buildingSMART's own `column-straight-rectangle-tessellation.ifc` writes on all 26 of its entity lines — yielded `" IFCCOLUMN"` with a leading space, matching no lookup. The function had no production caller, so its broken contract had never been exercised. `extract_entity_type_name` is `pub` in `ifc-lite-core`, so that is a behaviour change on a published Rust surface: it now returns the trimmed name, and `None` rather than `Some(" ")` for a record with only whitespace between `=` and `(`.
