---
"@ifc-lite/wasm": patch
---

Faster STEP parsing: the entity scanner's `find_entity_end` now uses a SIMD `memchr2` scan for the record terminator instead of a per-byte loop. It runs on every entity of every model, through both the entity-index build and the processor scan loop (they share the scanner), and parse is single-threaded, so it directly reduces time-to-first-geometry. Measured: isolated scanner walk -36% to -64%, full parse phase -12% to -30%, total load -8% to -19% across a range of models (small architecture to a 218 MB MEP model). Output is byte-identical (no mesh-determinism manifest change).
