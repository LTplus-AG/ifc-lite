---
'@ifc-lite/wasm': patch
---

The Rust entity scanner no longer wraps an express id that does not fit `u32` (#3395).

`EntityScanner::parse_u32_fast` accumulated the digit run with `wrapping_mul`/`wrapping_add`, so `#4294967297` was yielded as id `1`, indistinguishable from a real entity and already wrapped before any JavaScript guard could see it. This scanner feeds `scanEntitiesFast`/`scanEntitiesFastBytes` (the default scan on Node, where there is no `Worker`), `ColumnarIndex::from_scan`, `build_entity_index` and the streaming pre-pass, so a TypeScript-only fix would have left the defect live on every one of those loads.

The record is skipped instead, and the scan continues past it rather than ending there. `EntityScanner::skipped_oversized_ids()` reports how many were skipped, and the wasm `scanEntitiesFast`/`scanEntitiesFastBytes` entry points warn to the console when the count is nonzero. Digit runs of nine characters or fewer, which is every real file, keep the unchecked accumulation, so the hot path is unchanged: measured on a 137.5 MB, 1,600,000-record synthetic file, the scan output is byte-identical and the timing is unchanged within noise.
