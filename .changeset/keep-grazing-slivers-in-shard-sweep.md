---
"@ifc-lite/wasm": patch
---

Keep a cut result's sub-millimetre slivers when the stray-shard sweep reads both sides of their centroid as outside the host: a flush cap grazing the host by a few µm leaves such a strip connected to the closed skin, and dropping it tore ISSUE_068 #1401204 open. The centroid verdict now carries the same 1 mm clearance the vertex verdict already had.
