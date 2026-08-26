---
'@ifc-lite/server-client': patch
---

Decode `geometry_item_id` and `material_id` from the Parquet mesh transport, so drill-to-source works on the binary path and not only on JSON (#3215). Both are absent-marked with an explicit `0xFFFFFFFF` sentinel rather than a null, because a nullable UInt32's values buffer is undefined at null rows and parquet-wasm 0.7.x leaks the neighbouring row's id into it.
