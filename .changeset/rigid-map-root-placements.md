---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Preserve rigid map rotation through original root placement frames without wrapping representation geometry. Supported openings, fills, annotations and endpoint-local boundaries retain their coordinate ownership; TrueNorth metadata rotates with the engineering frame. Invalid or unsupported ownership still refuses atomically.
