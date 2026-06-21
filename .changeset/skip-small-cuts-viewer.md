---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
---

Decouple the small-cut skip (#1286) from the tessellation tier and use it for the
viewer's on-screen load.

`GeometryProcessor` gains a `skipSmallCuts` option (and the WASM `IfcAPI` a
`setSkipSmallCuts` binding) that drops tiny `IfcBooleanResult` detail cuts (steel
copes/notches) WITHOUT lowering the tessellation tier, so curved geometry keeps
full density while the dominant boolean-heavy load cost is skipped. The viewer
enables it for the streaming display load (boolean-heavy steel models reach
Manifold-class first paint); exporters and drawings leave it off, so their
geometry keeps every cut. Default off everywhere else, so all other output stays
byte-identical.
