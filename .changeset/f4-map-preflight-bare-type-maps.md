---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Scaled map-conversion normalization (the Cesium ion compatibility export) now accepts a bare `IfcTypeProduct.RepresentationMaps` reference (`#n`) and wraps that map exactly as the list form `(#n)`, matching how geometry and EntityRows already read it. It used to refuse the whole normalization with "type RepresentationMaps is not a list". Typed wrappers such as `IFCREPRESENTATIONMAP(#n)` and lists with non-reference members are still refused atomically, with no patches.
