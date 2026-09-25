---
"@ifc-lite/wasm": patch
---

Plan-rotated walls whose openings are cut in the wall's own frame no longer come back with T-junction seams. When that cut returns an open mesh, it is retried on operands whose coincident planes (scattered by the f32 world quantum) are snapped back onto one value. The retry is kept only if it is closed and consistently wound. Walls whose cut was already closed are unchanged.
