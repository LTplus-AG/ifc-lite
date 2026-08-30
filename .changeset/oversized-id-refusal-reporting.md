---
'@ifc-lite/parser': major
'@ifc-lite/geometry': minor
'@ifc-lite/wasm': minor
---

Report a refused oversized express id on every load path, not just one (#3395).

Refusing a record whose instance name does not fit `u32` is only half a guard; the other half is saying so. The first version of this fix wired the report into one TypeScript path and one wasm entry point, which left every other consumer returning a model that was quietly short — a missing bound corrupts, a missing report returns a truncated success, and the second failure is the harder one to notice because a load with nothing to refuse looks identical.

**The canonical viewer path.** For a file at or above 2 MB the geometry pre-pass has already scanned it and hands the parser worker its entity-index columns, so `scanIfcEntities` never scans at all. A refused record is absent from those columns by construction, so nothing downstream can recount it. The refusal now travels with them: the pre-pass `entity-index` event carries `oversizedIdCount`, `processParallel`'s `onEntityIndex` callback receives it as a fourth argument, `WorkerParser.setEntityIndex` takes it as an optional fourth parameter, and `PreScannedEntityIndex.oversizedIdCount` feeds it into the existing `console.warn` + `onDiagnostic` report. `EntityScanResult.oversizedIdCount` is therefore trustworthy on the `pre-scanned` path now, where its own documentation previously had to warn that a zero proved nothing.

**A shard hands back offsets, not a count, and does not report.** `scanEntityIndexShard` returns `oversizedIdStarts`, the global start byte of each record that shard refused. A shard begins at an arbitrary byte, so it can start inside a quoted value, and `EntityScanner` has no quote context — its only guard is the shape `#<digits>[ws]*=`, which a string literal containing `#4294967297=IFCWALL(` satisfies. A shard therefore refuses records the file never declared, arbitrarily many of them, and a per-shard report would warn "skipped N records" about a file that is fine. The main-thread stitch keeps only the offsets at or after the boundary it validated for that shard — the same boundary its records are cut at — and reports once per load. Native does the same: `build_entity_index_parallel` reports after its stitch, and `ifc_lite_processing::scan_shard_with_refusals` / `scan_shard_classified_with_refusals` hand the offsets to whoever stitches them.

**The native and second-wasm paths.** `ifc_lite_core::report_oversized_ids` is the one place Rust words this report; `build_entity_index`, `ColumnarEntityIndex::from_scan`, `build_entity_index_parallel`, the streaming processor scan and both wasm scan entry points call it, so the CLI, server and Python wheel no longer return a model silently missing the record. It goes to stderr by default, and the wasm bindings point it at the browser console from `#[wasm_bindgen(start)] init()`, which runs when the module loads, because `wasm32` has no stderr to write to.

A refusal stays a **diagnostic, not an error**: `#4294967297` is a legal ISO 10303-21 instance name, so failing the load would turn one lost record into a lost file that is otherwise fine, and would make native refuse a file the browser still opens.

The `@ifc-lite/geometry` and `@ifc-lite/wasm` additions are optional or additive, so their
callers compile and behave unchanged. `@ifc-lite/parser` is NOT: `EntityScanResult` gains a
REQUIRED `oversizedIdCount`, so anything constructing that shape must supply it. See the
`parser-express-id-u32-bound` entry for the breaking notice and migration.
