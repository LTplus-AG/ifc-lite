---
"@ifc-lite/wasm": patch
---

Faster STEP parsing: build the entity index in a single file walk instead of two. The pipeline previously scanned the whole file once in `build_entity_index` and again in the processor scan loop (both drive the same `EntityScanner`). The index is now built inline during the existing scan loop, so the file is traversed once. Parse is single-threaded, so this shaves the time-to-first-geometry gate; the saving is one full scanner traversal and scales with file size (measured -9% on the entity-scan phase and -7% on total load for a 47 MB model; larger on bigger files). Output is byte-identical (no mesh-determinism manifest change): the inline index is provably the same map `build_entity_index` produced, and the scan-phase decoder only needs local `decode_at` (no index) until the completed index is installed before the first reference resolution.
