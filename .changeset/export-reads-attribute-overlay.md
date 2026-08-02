---
"@ifc-lite/mutations": minor
"@ifc-lite/export": patch
---

Fix undone attribute edits being resurrected on STEP export (#1957).

`StepExporter` reconstructed attribute values by replaying `MutablePropertyView.getMutations()` — the append-only mutation history. Undo applies its reverse edit with `skipHistory: true`, so a superseded `UPDATE_ATTRIBUTE` record keeps its stale `newValue` forever and the exporter baked the pre-undo value into the output. The editor showed the reverted value; the file did not. Silent, with no error and nothing in the output signalling it, and directional: it restored data the user had explicitly reverted.

The exporter now reads attribute values from the overlay via the new `MutablePropertyView.getAttributeMutationsByEntity()`, which returns the current state — an undone edit has had its overlay entry reset to the pre-edit value, or removed outright when the attribute was newly set. This makes attributes consistent with every other overlay-backed path in the exporter: property sets (`getForEntity`), quantities (`getQuantitiesForEntity`), positional attributes (`getPositionalMutationsForEntity`) and retypes (`getEntityTypeMutation`) already read current state, so attributes were the sole outlier rather than an instance of a general pattern.

**Scope.** Only the attribute path was affected. Property and quantity edits take their *values* from the overlay and use the history only to decide which pset names to re-emit, so an undone property edit was already re-emitted with its correct current value. Georeferencing edits reach the exporter through `ExportOptions.georefMutations`, not through the view, and are untouched.

`getAttributeMutationsByEntity()` and the existing `getAttributeMutationsForEntity()` are both backed by a new entityId-keyed secondary index, mirroring the one already used for property and quantity mutations. That also removes a full-map `startsWith` scan from the per-entity accessor, which the properties panel calls on every selection.

No migration: the overlay and the history are both in-process state, and any edit that was not undone exports exactly as before.
