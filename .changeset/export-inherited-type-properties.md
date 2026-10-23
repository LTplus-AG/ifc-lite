---
"@ifc-lite/wasm": minor
---

Report which property and quantity entries an occurrence inherits from its type. The Rust export model gains `stream_export_model_with_inherited`, which passes an `Inherited` value beside each row; `PropValue`, `QuantityValue` and the existing entry points keep their shape. Type property sets attached through `IfcRelDefinesByProperties` are now inherited as well as those in `HasPropertySets`, the way the browser reads them, and an unnamed inherited set is no longer folded into an unnamed occurrence set, matching the browser's merge. The Python `entity_data` adds an `inherited` key to every property, quantity and attribute dict.
