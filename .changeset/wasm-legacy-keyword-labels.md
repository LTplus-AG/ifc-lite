---
"@ifc-lite/wasm": patch
---

Label legacy IFC keywords with their resolved type in the browser, not `"Unknown"`.

The native pipeline resolves a legacy keyword through `legacy_entities.rs` and labels the node with its real base type. The browser path did not: the jobs wire carries only `(id, start, end)`, so `batch.rs` rebuilt the type from `entity.ifc_type` — the decoder's bare `IfcType::from_str` — and every keyword IFC4X3 dropped arrived as `Unknown` with the Unknown default colour. `IfcProxy`, the eight `*StandardCase` variants, both `*ElementedCase`, `IfcDoorStyle`, `IfcWindowStyle`, `IfcEquipmentElement` and the three IFC4X3 strata leaves were all affected. Type-exact visibility rules and styling consumers skipped them, and nothing threw.

It cannot be recovered from the decoded value: `IfcType::Unknown` stores a CRC32 hash, not the name. It is recomputed from the record instead, which the batch already holds — a short scan to the first `(`, paid only by entities the decoder could not name.

Fixing it surfaced a second defect. `extract_entity_type_name` did not trim, so `#71= IFCCOLUMN(` — legal STEP, and what buildingSMART's own `column-straight-rectangle-tessellation.ifc` writes on all 26 of its entity lines — yielded `" IFCCOLUMN"` with a leading space, matching no lookup. The function had no production caller, so its broken contract had never been exercised.
