---
"@ifc-lite/parser": minor
"@ifc-lite/sdk": minor
"@ifc-lite/export": minor
"@ifc-lite/viewer": patch
---

`bim.cost` now reports the cost graph the session would export, not the one on disk. Cost extraction read straight from a loaded model's source bytes, so an edit or a deletion staged in the model's edit overlay was invisible to `bim.cost.data()` / `items()` / `values()` / `evaluateItem()` while `bim.export.ifc()` applied it — the read model and the exported file disagreed about the same model. `extractCostOnDemand` takes an optional `CostMutationOverlay`, applied at `CostEntityReader`, the one funnel every cost extractor reads an entity through: a tombstoned entity is gone from the graph, a retyped entity is listed under its pending class, and an edited record is read from the text the exporter will write for it. Nesting, assignments, controlling schedules, unit resolution and every diagnostic recompute from that one read rather than from a second projection.

What an edit becomes in the file is decided once, by the exporter. The new `effectiveSourceRecord` in `@ifc-lite/export` runs the exporter's own retype / named / positional mutation pipeline for one source record, and the SDK builds the cost overlay from it, so enum edits read as the enum the exporter writes, positional edits (`AppliedValue`, `UnitBasis`, `CostValues`, …) are visible, and an edit past the end of a truncated record is skipped exactly as export skips it. `ResolvedCostModel` carries the model's `mutationView`. An edit the exporter declines to write (a non-number in a REAL-typed slot, a record whose arguments do not scan) is reported as a `PENDING_EDIT_NOT_APPLIED` warning instead of the source value being passed off as current.

A cost value deleted while an `IfcCostItem` still lists it in `CostValues` reads back as a `MISSING_REFERENCE` error against that item — the same answer the reader already gives for a file with a genuinely dangling reference — rather than being dropped from the canonical list, which would report a coherent graph the file does not contain.

The cost reads accept `{ includeMutations: false }` for the graph as the file on disk states it. That is the file's own cost data, not an empty graph. It mirrors `bim.export.ifc`'s option of the same name, and `true` (the default) is what makes the two describe one file.
