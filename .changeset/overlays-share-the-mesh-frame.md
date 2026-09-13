---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

The grid lines, alignment lines and symbolic overlays now choose their RTC offset with the same fallback ladder and frame selector as the browser meshes (#4665). They used their own detector, which had no placement-bounds fallback, and the symbolic overlay tested the offset against 10 km a second time. A model whose elements give the sampler no placement to read, with a bbox corner past 10 km, had its meshes shifted by the bbox centre while `parseGridLines`, `parseAlignmentLines` and `parseSymbolicRepresentations` (and the server's `symbolic_data`) were not shifted, so they drew up to the full offset away from the meshes. Models the sampler can read are unchanged. On native, `symbolic_data` still does not remove the site translation and rotation that site-local meshes drop (#4706).
