---
"@ifc-lite/export": patch
---

`StepExporter` no longer emits a relationship record that names an entity the export itself excluded. A hidden PRODUCT under `visibleOnly` keeps its own defining line out of the file, but `IFCREL*` records are unconditional roots and their bytes used to be copied to the output verbatim — so a relationship naming both a kept and a hidden product still named the hidden one, shipping a `#N` reference with no `#N=` defining line. Strict STEP readers reject that file; lenient ones silently mis-place the geometry it pointed at.

A new `filterHiddenRefsFromRelationshipLine` (`reference-collector.ts`) runs on every relationship's line right before it is written, for both source-parsed and overlay-authored relationships: a hidden or deleted id is dropped from a nested list attribute (`RelatedObjects`, `RelatedElements`, …), and the relationship is withheld entirely when a hidden/deleted id sits in a bare scalar attribute (`RelatingSpace`, `RelatedOpeningElement`, …) or when dropping it from a list would leave that list empty.

Two exclusion sources are covered, both previously unhandled:

- **`visibleOnly` hidden products** — the case above.
- **Deleted (tombstoned) entities, on any export, `visibleOnly` or not.** The existing deletion-path guard only withholds an `IfcRelDefinesByProperties` when *every* related object was deleted, and only for that one relationship class — a spatial-containment relation (or any other `IFCREL*` type) still naming a partially-deleted related list shipped the same dangling reference on a plain full export.

The relationship's excluded/effective type is resolved through `EffectiveEntityIndex.effectiveType`, not the record's authored (pre-retype) class: an entity retyped across the `IFCREL*` boundary — into or out of a relationship class — is now classified by what the export actually writes, not by the class it started as. Classifying by the authored class alone let a retyped relationship skip the filter (or apply it wrongly) depending on retype direction.

This is a behaviour change to STEP export output, split out of #2398 to stand on its own: the surrounding source-guard refactor in that PR is a provable no-op and does not touch this code path.
