---
"@ifc-lite/wasm": patch
---

Fix an opening void's CSG-complexity classification (issue #635's high-vertex AABB fallback) reading raw mesh vertex count instead of triangle count. The raw position-buffer length also counts per-`IfcFace` vertex duplication the faceted-brep mesher emits, and welding merges duplicate vertex slots without changing triangle count, so the same cutter geometry could land on either side of the classification threshold depending purely on how redundantly its vertices happened to be stored. Triangle count is invariant to that, so an opening now classifies the same way regardless of authoring or weld state.
