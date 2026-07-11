---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": major
---

Sharded pre-pass stage 2: columns-driven discovery + column-based styles flatten.

The shard scan now classifies every record (geometry job, type candidate, project/site, all support-span kinds), so the pre-pass fills its collectors from the stitched class columns in ~100ms and never byte-scans the file — meta and ALL job chunks arrive right after the stitch instead of behind a multi-second scan. The styles finalize keeps the shard-merged geometry styles as columns end to end (`flat_styles_rgba8_from_geometry_columns`): no 4M-entry hashmap seed, no hashmap rebuild in the flatten, byte-identical wire output. Same flag (`__IFC_LITE_SHARD_SCAN`), same serial fallback. BREAKING (@ifc-lite/wasm): `buildPrePassStreamingSharded` gains a required `index_classes` parameter (the class column is what makes columns discovery possible).
