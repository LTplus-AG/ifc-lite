---
'@ifc-lite/wasm': patch
---

Report a refused express-id `#<digits>` reference (an id above `u32::MAX`, issue #3421) instead of dropping it with no trace — a follow-up to merged #3740, which migrated three REFERENCE readers (`rust/geometry/src/router/content_hash.rs`, `rust/export/src/step_text.rs`, `rust/processing/src/prepass.rs`) off wrapping onto the shared `parse_express_id`, but only refused the value; nothing said so.

- `content_hash.rs`'s per-item content-hash walk now counts a refused child reference on the router (`GeometryRouter::take_content_hash_oversized_ref_drops`), surfaced through `GeometryDiagnostics.oversizedRefDrops` (additive field, no schema bump) and logged on both the wasm (`console.warn`) and native (`tracing::warn!`) geometry passes. The dedup hash itself stays correct either way — an oversized ref already folds the same fixed sentinel a genuinely-missing reference uses — this only adds the missing signal.
- `step_text.rs`'s `refs_in_line` gained a counting variant (`refs_in_line_counted`) used by the two reachability-closure callers (`export_step_with_stats`'s filtered-export closure, and the merged exporter's `resolve_included`). A refusal is surfaced in `StepStats.refused_refs` and in `MergedStats.warnings` respectively; it never excludes anything reachable, since the referenced record — being unrepresentable — could never itself be a real entity in the store.
- `prepass.rs`'s `find_ifcproject_id` now reports a refused `IFCPROJECT` id through the same sink the definition scanner uses for issue #3395 (`ifc_lite_core::parser::report_oversized_ids`), since that refusal is on the record's own id, not a reference — left unreported it would silently default the file's unit scales the way issue #1367 did for the "no project found" case.
