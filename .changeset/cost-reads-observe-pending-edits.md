---
"@ifc-lite/parser": minor
"@ifc-lite/sdk": minor
"@ifc-lite/export": patch
"@ifc-lite/viewer": patch
---

`bim.cost` now reports the cost graph the session would export, not the one on disk. Cost extraction read straight from a loaded model's source bytes, so a rename or a deletion staged in the model's edit overlay was invisible to `bim.cost.data()` / `items()` / `values()` / `evaluateItem()` while `bim.export.ifc()` applied it — the read model and the exported file disagreed about the same model. `extractCostOnDemand` takes an optional `CostMutationOverlay`, applied at `CostEntityReader`, the one funnel every cost extractor reads an entity through: a tombstoned entity is gone from the graph, and a pending attribute edit is already in the slot the exporter will write it into. Nesting, assignments, controlling schedules, unit resolution and every diagnostic recompute from that one read rather than from a second projection.

A cost value deleted while an `IfcCostItem` still lists it in `CostValues` reads back as a `MISSING_REFERENCE` error against that item — the same answer the reader already gives for a file with a genuinely dangling reference — rather than being dropped from the canonical list, which would report a coherent graph the file does not contain.

The cost reads accept `{ includeMutations: false }` for the graph as the file on disk states it. That is the file's own cost data, not an empty graph. It mirrors `bim.export.ifc`'s option of the same name, and `true` (the default) is what makes the two describe one file.

`attrIndex` / `stepSourceSchema` / `SourceStepSchema` move from `@ifc-lite/export` down into `@ifc-lite/parser`, which re-exports them from the same names in `@ifc-lite/export`'s `subset-entity-reader`. The overlay and the STEP exporter have to resolve an edited attribute name to the same positional slot for the same type under the same schema, and one implementation over one set of tables is the only way that stays true.
