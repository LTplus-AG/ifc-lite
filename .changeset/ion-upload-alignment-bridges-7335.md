---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Cesium ion compatibility export now carries alignments and `IfcLinearPlacement` elements with the rigid root-placement map transform, and reads unit records written with spaces after commas (`IFCSIUNIT(*, .LENGTHUNIT., $, .METRE.)`). Linear placements without `PlacementRelTo` still refuse atomically.
