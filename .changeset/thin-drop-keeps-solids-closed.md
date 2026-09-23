---
"@ifc-lite/wasm": patch
---

Closed solids no longer come out of the mesher with a T-junction crack when source hygiene drops a sub-grid sliver whose apex the neighbouring faces still use (#5313). This affects a profile with a near-collinear vertex, such as a tiny arc on a large circle, and brep faces with collinear loop points. The triangle across the dropped sliver is now split at that apex. Across the public fixture corpus, 6,088 element meshes that were open are now closed. Boolean operands (void hosts and opening cutters) keep the previous hygiene, so void-cut output is unchanged.
