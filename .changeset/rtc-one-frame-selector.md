---
"@ifc-lite/wasm": patch
---

The browser pre-pass now chooses the RTC frame through the same selector as the server pipeline (#4611). A model whose only coordinate evidence is the placement-bounds scan, with a bbox corner past 10 km and the bbox centre inside it, is now re-based by that centre in the browser (`needsShift` is true), as the server already did; before, the browser cast those coordinates straight to f32. The browser pre-pass reports `rtcOffset` as zero whenever `needsShift` is false, and `MeshCollection.hasRtcOffset()` now answers whether any offset was applied (it can be under 10 km) instead of whether the offset is past 10 km. Server output and the `mesh_coordinate_space` strings (`site_local`, `model_rtc`, `raw_ifc`) are unchanged.
