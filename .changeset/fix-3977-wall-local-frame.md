---
"@ifc-lite/wasm": patch
---

Fixed open boundaries when a narrow, vertically extruded opening trims the mitred tip of a plan-rotated wall (#3977). Wall-like hosts whose cutters all carry an authored vertical extrusion direction are now cut in the wall-local frame, while inferred directions and non-wall hosts remain on the established path. The local-frame rectangular fast path also preserves each cutter's authored penetration axis so a partial-thickness vertical slot is not extended through the wall.
