---
"@ifc-lite/wasm": patch
---

Fix `detect_schema_version` (`rust/processing/src/processor/schema_detection.rs`) searching the file for `IFC4`/`IFC4X3` case-sensitively. ISO 10303-21 makes STEP keywords and identifiers case-insensitive, so `FILE_SCHEMA(('ifc4'))` is a legal header — and it was not merely undetected, it silently fell through to the `"IFC2X3"` fallback. That value passes schema validation with no warning and then gates behaviour downstream: the viewer's IFC4 authoring target check and appearance-panel gate both treat `"IFC2X3"` as "not IFC4", so a lowercase-header IFC4/IFC4X3 model was silently excluded from appearance authoring.

The search now folds case via the shared `ifc_lite_core::parser::find_keyword`, the same rare-letter-anchored byte scan `find_ifcproject_keyword` uses (#4498) — anchoring the "IFC4" needle on its rarest letter (`F`) rather than its leading `I`, since every IFC keyword and GUID in the file is dense in `I`. The raw-byte, anywhere-in-file predicate and the "IFC4X3 anywhere wins over IFC4" precedence (#3987) are unchanged; this is not a header parser.

Part of the case-sensitivity class tracked in #4497/#4498; this instance is #4661.
