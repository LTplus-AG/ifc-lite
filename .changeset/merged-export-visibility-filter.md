---
"@ifc-lite/wasm": patch
---

Add per-model visibility filtering to the native (Rust) merged/federated IFC exporter (#2951).

`export_merged_with_stats` (`rust/export/src/merged.rs`) previously had no way to exclude entities from a federated export -- every entity from every input model was always written, unlike `step.rs`'s single-model exporter, which already honors a `StepOptions.included` allowlist. `MergedOptions.included` closes that gap for the merged path: an optional, per-model (index-aligned with the `models` slice) `VisibilityFilter { roots, excluded }` (`rust/export/src/merged_visibility.rs`), mirroring `computeIncludedEntityIds`'s role in `packages/export/src/merged-exporter.ts`.

An absent `included` field, or an absent per-model entry, includes that model in full (unchanged default behavior). An explicit empty filter (`roots: vec![]`) includes nothing from that model -- deliberately a different outcome from omitting the filter, pinned by dedicated tests, since collapsing the two would silently ship either an empty or a complete file.

The closure never walks into an `excluded` id, so a hidden product's geometry cannot re-enter through a relationship that also names it. A kept `IFCREL*` entity that still names an excluded id is **narrowed**, not dropped whole: `narrow_relationship_line` (`rust/export/src/merged_visibility.rs`) mirrors `filterHiddenRefsFromRelationshipLine` (`packages/export/src/reference-collector.ts`) -- a SET/LIST attribute is narrowed to its surviving members via `step_text::split_top_level_args`, and the whole line is withheld only when an excluded id sits in a single-valued slot (no spelling for "omitted"), or was a SET/LIST's only surviving member. Excluding just one sibling out of a storey's `IFCRELCONTAINEDINSPATIALSTRUCTURE` no longer drops that storey's containment for every other, still-visible element. The one schema-optional exception JS carries -- `IfcRelConnectsStructuralMember.ConditionCoordinateSystem`, rewritten to `$` instead of withholding -- is ported too.

Also fixes a latent interaction: a visibility filter that excludes model 0's own `IfcProject` used to leave every later model's own `IfcProject` dropped anyway (in favor of a "canonical" project that was never actually written), producing a merged file with no `IfcProject` at all. `canonical_project` is now invalidated when model 0's filter excludes it, so later models keep their own project instead of redirecting to nothing.

`merged_visibility.rs`'s own doc no longer claims the narrowing approach "can only under-connect, never dangle" -- true only for the `IFCREL*` shape it inspects. A non-`IFCREL*` entity referencing an excluded id (an `IFCSTYLEDITEM.Item`, a product's `Representation`/`ObjectPlacement`) can still dangle; that gap is inherited from the JS reference, which documents it openly (`step-exporter.ts`, 80 dangling refs measured before and after on `tests/models/AB22.ifc`), not introduced here.
