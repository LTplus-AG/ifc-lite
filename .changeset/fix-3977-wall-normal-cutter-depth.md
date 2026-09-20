---
"@ifc-lite/wasm": patch
---

Fixed a wall tear introduced by the #3977 local-frame selector (0e8a42175): a rectangular cutter whose authored extrusion runs along the wall normal was handed that depth verbatim, so an antiparallel (-Z) opening flipped the rectangular cut's cap extension and left the host open (rvt01 `#10191` went from 0 to 15 open edges in the watertightness census). Only cutters authored across the wall (vertical strips) keep their own axis now; wall-normal cutters use the established +Z fallback again. Also restored the `csg_capture` feature build, which had missed `Mesh.plane_tags` (#4988).
