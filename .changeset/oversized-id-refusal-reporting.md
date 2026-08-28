---
'@ifc-lite/parser': minor
'@ifc-lite/geometry': minor
'@ifc-lite/wasm': minor
---

Report a refused oversized express id on every load path, not just one (#3395).

Refusing a record whose instance name does not fit `u32` is only half a guard; the other half is saying so. The first version of this fix wired the report into one TypeScript path and one wasm entry point, which left every other consumer returning a model that was quietly short — a missing bound corrupts, a missing report returns a truncated success, and the second failure is the harder one to notice because a load with nothing to refuse looks identical.

**The canonical viewer path.** For a file at or above 2 MB the geometry pre-pass has already scanned it and hands the parser worker its entity-index columns, so `scanIfcEntities` never scans at all. A refused record is absent from those columns by construction, so nothing downstream can recount it. The count now travels with them: `scanEntityIndexShard` and the pre-pass `entity-index` event carry `oversizedIdCount`, `processParallel`'s `onEntityIndex` callback receives it as a fourth argument (summed across shards on the sharded path), `WorkerParser.setEntityIndex` takes it as an optional fourth parameter, and `PreScannedEntityIndex.oversizedIdCount` feeds it into the existing `console.warn` + `onDiagnostic` report. `EntityScanResult.oversizedIdCount` is therefore trustworthy on the `pre-scanned` path now, where its own documentation previously had to warn that a zero proved nothing.

**The native and second-wasm paths.** `ifc_lite_core::report_oversized_ids` is the one place Rust words this report; `build_entity_index`, `ColumnarEntityIndex::from_scan`, `scan_shard`, the streaming processor scan and both wasm scan entry points call it, so the CLI, server and Python wheel no longer return a model silently missing the record. It goes to stderr by default, and the wasm bindings bind it to the browser console at `IfcAPI` construction because `wasm32` has no stderr to write to.

A refusal stays a **diagnostic, not an error**: `#4294967297` is a legal ISO 10303-21 instance name, so failing the load would turn one lost record into a lost file that is otherwise fine, and would make native refuse a file the browser still opens.

All three additions are optional or additive, so existing callers compile and behave unchanged.
