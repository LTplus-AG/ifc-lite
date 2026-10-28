---
"@ifc-lite/diff": patch
"@ifc-lite/wasm": patch
---

Add explicit internal retained model snapshots for repeated comparisons, with deterministic disposal and preserved opaque references.

Reduce native fingerprint projection, UTF-16 conversion, sorting and comparison transport allocations without changing canonical hashes or diff outputs.

Bound dense fingerprint transport chunks after the full adapter snapshot to reduce full-model live-memory and packing cost. Sparse validation order remains unchanged.

Stream private packed result entries, restore keys and original references by row index in one pass, and decode typed string dictionaries without an intermediate document graph. Public calls retain explicit per-call ownership.

Avoid building and rebuilding an unused native result lookup index when the destination JavaScript runtime constructs `byKey`. Native callers retain the complete indexed result.
