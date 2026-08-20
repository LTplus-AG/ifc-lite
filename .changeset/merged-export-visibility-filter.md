---
"@ifc-lite/wasm": patch
---

Add per-model visibility filtering to the native (Rust) merged/federated IFC exporter (#2951).

`export_merged_with_stats` (`rust/export/src/merged.rs`) previously had no way to exclude entities from a federated export -- every entity from every input model was always written, unlike `step.rs`'s single-model exporter, which already honors a `StepOptions.included` allowlist. `MergedOptions.included` closes that gap for the merged path: an optional, per-model (index-aligned with the `models` slice) `VisibilityFilter { roots, excluded }` (`rust/export/src/merged_visibility.rs`), mirroring `computeIncludedEntityIds`'s role in `packages/export/src/merged-exporter.ts`.

An absent `included` field, or an absent per-model entry, includes that model in full (unchanged default behavior). An explicit empty filter (`roots: vec![]`) includes nothing from that model -- deliberately a different outcome from omitting the filter, pinned by dedicated tests, since collapsing the two would silently ship either an empty or a complete file.

The closure never walks into an `excluded` id, so a hidden product's geometry cannot re-enter through a relationship that also names it. A kept `IFCREL*` entity that still names an excluded id is dropped entirely (its own root is excluded and the closure is recomputed to a fixpoint) rather than emitted with a dangling `#ref` -- this repo's Rust STEP writer has no per-SET/LIST-attribute narrowing (unlike `relationshipRefsSurviveExclusion`/`filterHiddenRefsFromRelationshipLine` on the JS side), so the whole-relationship-drop is a conservative, correctness-first simplification for this increment rather than a byte-for-byte port of the JS narrowing behavior.

Also fixes a latent interaction: a visibility filter that excludes model 0's own `IfcProject` used to leave every later model's own `IfcProject` dropped anyway (in favor of a "canonical" project that was never actually written), producing a merged file with no `IfcProject` at all. `canonical_project` is now invalidated when model 0's filter excludes it, so later models keep their own project instead of redirecting to nothing.
