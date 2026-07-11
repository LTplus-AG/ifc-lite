---
"@ifc-lite/wasm": patch
---

Nearly-sorted fast path for entity-index construction (sharded pre-pass stage 3). STEP exporters emit ids in ascending file order except a handful of appended footer entities (measured: 57 ascending runs across 19.1M records on a real CATIA model), so `ColumnarEntityIndex` now detects the runs and k-way merges them — O(n·log runs) with streak streaming instead of a full argsort — with byte-identical output (same (id, original-index) order, same last-wins duplicate collapse). Every consumer of the stitched file-order columns (geometry workers, the sharded pre-pass, the parser) skips its multi-second sort.
