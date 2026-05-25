---
"@ifc-lite/viewer": patch
---

Fix "Add Model to Scene" hiding the first model when a second is
loaded (issue #661, PR #792). `useIfcFederation.addModel` always
called `setIfcDataStore(parsedDataStore)` and
`setGeometryResult(parsedGeometry)` after `storeAddModel`, with the
new model's data. `modelSlice.addModel` only flips `activeModelId`
for the FIRST model, so on subsequent adds those legacy setters
wrote the new model's data into `models.get(activeModelId)` — i.e.
into the FIRST model's per-model entry — aliasing both Map entries
to the second model's mesh and rendering only one element.

The fix drops those two redundant calls from `addModel`. For the
first model `modelSlice.addModel` already mirrors the data into the
top-level fields, and for subsequent models the legacy top-level
fields must stay pointing at the active (first) model's data; the
existing `setActiveModel` handler updates them on focus change.
