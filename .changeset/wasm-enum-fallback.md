---
"@ifc-lite/parser": patch
---

Fix `extractRootAttributesFromEntity` leaking STEP bare-enum tokens into string display attributes for types the schema registry doesn't recognise (#1779). On the unknown-type fixed-index fallback, a PredefinedType enum landing on attribute 7 (e.g. IFC4X3 `IfcAlignment`) is stored by the extractor as a dotted string (`.USERDEFINED.`) and used to surface as the element's `Tag`. It's now rejected (rendered blank), mirroring the Rust server path — so the `Tag`, `Description`, and `ObjectType` list columns match across parse paths. Known types are unaffected (their schema indices point at genuine string slots).
