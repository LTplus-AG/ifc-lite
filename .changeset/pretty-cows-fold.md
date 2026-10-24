---
"@ifc-lite/wasm": patch
---

Accept a bare RepresentationMaps reference on type products in browser pre-pass discovery and geometry batches, matching the native reader: a list's references or one bare reference. A typed wrapper such as `IFCPROPERTYSETDEFINITIONSET((#16))` still draws no type geometry, as natively. List-form type geometry keeps its existing behavior.
