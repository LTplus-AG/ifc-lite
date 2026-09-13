---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

The server pipeline and the browser pre-pass now choose the RTC frame through one shared selector (#4611). A model whose only coordinate evidence is the placement-bounds scan, with a bbox centre inside 10 km and a corner past it, is no longer shifted by that centre when the server parses it (`mesh_coordinate_space` is `raw_ifc`, as the browser and the 2D overlays already assumed). The server cache keys are not bumped, so a response already cached for such a file keeps its old frame until the cache entry is removed. The browser pre-pass reports `rtcOffset` as zero whenever `needsShift` is false. The `mesh_coordinate_space` strings (`site_local`, `model_rtc`, `raw_ifc`) are unchanged.
