---
"@ifc-lite/wasm": patch
---

Plan-rotated walls cut in their own frame no longer come back with T-junction seams. The wall and its openings reach that frame as f32 world positions, so one authored face landed on many depth values a few micrometres apart, and the cut split along all of them. Coordinates that coincide to within the world f32 quantum are now put back on one plane before the cut. On the reporting model every layer of both curtain walls comes back closed (from 29 to 203 open edges per layer before).
