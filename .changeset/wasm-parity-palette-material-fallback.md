---
"@ifc-lite/wasm": patch
---

Repeated mapped geometry coloured per triangle by an `IfcIndexedColourMap` keeps all of its colours in the viewer. Previously, when the viewer instanced repeated geometry, every occurrence rendered in one colour. An element with no style of its own now falls back to the first opaque colour of its materials, as the server and exports already did, instead of the first colour in the list. A window listing glass before frame used to render as translucent glass.
