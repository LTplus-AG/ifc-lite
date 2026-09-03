---
'@ifc-lite/wasm': patch
---

The Rust twin of #3695's TS fix, landing alongside it: `EntityScanner::find_entity_end` (`rust/core`) has no byte to resume from when a record opens a `'` string or a `/* ... */` comment that never closes, so the scan stops there, correctly, but until now with no trace of why. A truncated download, a failed export, or a lossy round-trip through another tool could silently drop every entity after the break on the WASM/native load path, so which path a user hit decided whether they knew their model was incomplete.

`EntityScanner` now exposes `malformed_record_start()`, and every index-building whole-file scan reports it through the existing `report_oversized_ids` sink: `columnar_index.rs`, `decoder.rs`, the streaming processor (`rust/processing/src/processor/mod.rs`), the wasm sharded-prepass path (`rust/wasm-bindings/src/api/gpu_meshes/prepass.rs`), and the wasm parsing entry points (`rust/wasm-bindings/src/api/parsing.rs`), via `ifc_lite_core::report_malformed_records` and the combined `report_scan_diagnostics` convenience both call. The behaviour is unchanged on purpose: an unterminated string leaves no reliable resume point, so the scan still stops there rather than guessing past it, only the silence is fixed.

The native sharded parallel scan (`rust/processing::build_entity_index_parallel`, files 8MB+) now also attributes a malformed stop to the shard whose real (resynchronised) region actually contains it, distinguishing it from a false stop a shard's speculative mid-record start can produce, and reports it once, stitched, exactly like the existing #3395 oversized-id refusal count, byte-identical to the serial scanner's truncation point.

The wasm-bindings columns event (`buildPrePassOnce`'s sharded/columns path) now also carries `malformedRecordFound` alongside the existing `oversizedIdCount`. This is the wasm half only: the TS side does not read this field yet, and wiring the browser host to surface it is a separate, following change.

Two gaps are explicitly NOT covered here, and are deferred to follow-up issues: the browser's sharded pre-pass (`scan_shard_classified_with_refusals` / `stitchShards`) discards a shard's malformed-record offset entirely, so a malformed stop on that path stays silent; and `parse_stream` (`rust/core/src/streaming.rs`) plus the server's `/parse/json` handler run whole-file scans that report neither the #3395 oversized-id count nor a malformed stop.
