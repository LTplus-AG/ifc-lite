---
"@ifc-lite/viewer": patch
---

Fix clash rows being inert in a collaborative session. `useClash` resolved a clash ref back to its model through the `federationRegistry` singleton, which only knows models registered via `registerModelOffset`. The collab recipient's model is put into the store by `collabSlice` with `upsertModel({ id: 'room:<id>', ..., idOffset: 0 })` and never registered, so every ref resolved to `null` and `focusClash` / `selectElement` / `highlightAll` returned before doing anything — clicking a clash row in a room did nothing, while clicking the same element in the 3D view selected it normally.

A `ClashElementRef` already carries the model id it was gathered from, so the ref is now resolved against that model's own `idOffset` (the offset the renderer's id space is built from), falling back to the registry. That also removes the range-search ambiguity between two models whose id ranges overlap.
