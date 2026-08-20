---
"@ifc-lite/wasm": patch
---

Narrow, rather than drop, a kept `IFCREL*` relationship in the native (Rust) merged/federated IFC exporter's visibility filter when it names an excluded id inside a SET/LIST attribute.

`merged_visibility.rs`'s fixpoint (`compute_keep_set`) previously withheld a kept relationship's entire line the instant it named ANY excluded id, regardless of where that id sat. On real IFC this is not merely conservative: an exporter that lists every element of a storey in one `IFCRELCONTAINEDINSPATIALSTRUCTURE` would lose that storey's containment for every OTHER, still-visible element just because one sibling was hidden -- proven with `#10=IFCRELCONTAINEDINSPATIALSTRUCTURE($,$,$,$,(#1,#2,#3),#20);` where excluding only `#3` used to drop the relationship (and `#1`/`#2`'s containment with it), even though `#1` and `#2` survived as bare entity lines.

`narrow_relationship_line` (`rust/export/src/merged_visibility.rs`) now mirrors `filterHiddenRefsFromRelationshipLine` (`packages/export/src/reference-collector.ts`): a SET/LIST attribute is narrowed to its surviving members, and the whole line is withheld only when an excluded id sits in a single-valued slot (no spelling for "omitted"), or was a SET/LIST's only member (an empty SET/LIST is a different kind of invalid file, not "no reference"). The one schema-optional exception JS carries -- `IfcRelConnectsStructuralMember.ConditionCoordinateSystem`, rewritten to `$` instead of withholding -- is ported too. Reuses `step_text::split_top_level_args` (already `pub(crate)` for `apply_attr_mutations`) rather than adding a second attribute-group parser.

This also corrects `merged_visibility.rs`'s own doc, which claimed the whole-drop approach "can only under-connect, never dangle" -- true only for the `IFCREL*` shape it inspects. A non-`IFCREL*` entity referencing an excluded id (an `IFCSTYLEDITEM.Item`, a product's `Representation`/`ObjectPlacement`) can still dangle; that gap is inherited from the JS reference, which documents it openly (`step-exporter.ts`, 80 dangling refs measured before and after on `tests/models/AB22.ifc`), not introduced here.
