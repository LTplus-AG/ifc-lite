---
'@ifc-lite/export': patch
---

Fix `visibleOnly` STEP and merged exports shipping a hidden element's property sets, quantity sets, type, material and classification.

`getVisibleEntityIds` (`reference-collector.ts`) treats every `IFCREL*` entity as an unconditional root of the reference closure — relationships point at products, never the other way round, so they have to stay reachable for a *visible* element's psets, materials, types etc. to survive. But the closure walk (`collectReferencedEntityIds`) followed every reference an `IFCREL*` root named, including ones only a hidden product used, because a pset/material/type/classification is never itself in `hiddenIds` (it isn't a product). A hidden element's associated data shipped as an "orphan" record — present in the file, byte-identical to what a fully visible export would emit, but named by no relationship the file still contains.

Fixed at the closure walk: a relationship whose own line would be withheld entirely by `filterHiddenRefsFromRelationshipLine` (every id it names is excluded) no longer propagates any of its references, so its otherwise-unreachable target is dropped from the closure too. A relationship that still names at least one visible/kept entity is unaffected — its target (e.g. a pset shared by a visible and a hidden element) still ships. The same fix also closes the equivalent gap for a DELETED (not merely hidden) sole subject, since a deletion is invisible to `hiddenIds` by a different route (the effective index's iteration skips a tombstoned entity outright).

`MergedExporter`'s `visibleOnly` shares the same `getVisibleEntityIds` / `collectReferencedEntityIds` closure code as `StepExporter`, so this fix closes the identical leak there too, with no merged-export-specific change required.

Out of scope: `MergedExporter` does not yet call `filterHiddenRefsFromRelationshipLine` on the relationship's own OUTPUT line the way `StepExporter` does, so a merged `visibleOnly` export can still emit a relationship naming a withheld id (a dangling `#N` with no `#N=` line) — a pre-existing, separate defect tracked elsewhere. IFC5 (`.ifcx`) export was not affected to begin with: `Ifc5Exporter` gates each entity once and keeps properties in a table keyed by owning entity rather than as freestanding entities reached via a relationship. CSV/JSON/Parquet export have no `visibleOnly` concept. glTF/GLB metadata behavior for a hidden mesh was not traced (goes into the WASM geometry pipeline) and is left undetermined.
