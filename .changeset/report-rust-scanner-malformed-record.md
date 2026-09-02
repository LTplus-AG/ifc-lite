---
'@ifc-lite/wasm': patch
---

The Rust twin of #3695's TS fix: `EntityScanner::find_entity_end` (`rust/core`) has no byte to resume from when a record opens a `'` string or a `/* ... */` comment that never closes, so the scan stops there — correctly, but until now with no trace of why. A truncated download, a failed export, or a lossy round-trip through another tool could silently drop every entity after the break on the WASM/native load path while the TS fallback (post-#3695) reported it, so which path a user hit decided whether they knew their model was incomplete.

`EntityScanner` now exposes `malformed_record_start()`, and every whole-file scan in `rust/core`, `rust/processing`, and `rust/wasm-bindings` reports it through the existing `report_oversized_ids` sink (`ifc_lite_core::report_malformed_records`, and the combined `report_scan_diagnostics` convenience both call). The behaviour is unchanged on purpose: an unterminated string leaves no reliable resume point, so the scan still stops there rather than guessing past it — only the silence is fixed.

The native sharded parallel scan (`rust/processing::build_entity_index_parallel`, files 8MB+) now also attributes a malformed stop to the shard whose real (resynchronised) region actually contains it, distinguishing it from a false stop a shard's speculative mid-record start can produce, and reports it once, stitched, exactly like the existing #3395 oversized-id refusal count — byte-identical to the serial scanner's truncation point.

The wasm-bindings columns event (`buildPrePassOnce`'s sharded/columns path) now also carries `malformedRecordFound` alongside the existing `oversizedIdCount`, so the browser host can surface the same warning it already gets for a refused oversized id.

The browser's sharded pre-pass (`prepass_sharded.rs` / `scan_shard_classified_with_refusals`) is unchanged: the stitch for that path lives in the host's TypeScript, not this crate, so wiring the same attribution through there is a separate, larger change.
