---
"@ifc-lite/geometry": patch
---

Mask the prepass class byte before comparing it on the host (#2065).

`rust/processing/src/shard_classes.rs` defines the per-record prepass class byte as a named code in the low bits (`PREPASS_CLASS_CODE_MASK` = `0x3F`) with flag bits composed on top (`PREPASS_CLASS_FLAG_GEOMETRY_JOB` = `0x80`, `PREPASS_CLASS_FLAG_TYPE_CANDIDATE` = `0x40`). The Rust consumer masks before matching (`gpu_meshes/prepass_discovery.rs`); the sharded-scan span-list rebuild in `geometry-parallel.ts` compared the whole byte against bare literals `4..10`.

No output changes today: `classify_type_name` returns the named codes early, and the one later flag OR-in (`classify_type_name_with_content`) is gated on a spatial-container predicate that none of those keywords satisfy, so classes 4–10 never carry a flag bit as the classification rules stand. The failure mode if that ever changed was silent and total for the affected record — a flagged byte such as `0x80 | 4 = 132` is an out-of-bounds `Uint32Array` write (discarded without error) and misses the span-list map entirely, so the styled item, void, fill or aggregate would simply never appear.

The span-list rebuild now lives in an exported, unit-tested `extractPrepassSpanLists()` that masks both comparisons, sizes its count table by the code mask rather than by the highest class the host consumes (so a class added on the Rust side can no longer write out of bounds), and names the codes as constants instead of restating them in a comment. A test pins those constants to the Rust source of truth.
