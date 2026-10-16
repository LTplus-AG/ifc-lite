---
"@ifc-lite/wasm": patch
---

Repeated mapped geometry coloured per triangle by an `IfcIndexedColourMap` keeps all of its colours in the viewer; when the viewer instanced repeated geometry, every occurrence used to render in one colour. The pre-pass style wire also now carries each element's material fallback as its first opaque material colour, the colour the server and exports use, instead of the first colour in the list. This only affects elements drawn through the fallback paths (no style of their own and no per-part material split).
