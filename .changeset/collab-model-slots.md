---
"@ifc-lite/collab": minor
"@ifc-lite/viewer": minor
---

Rooms carry an explicit federation scope: one model slot per shared model (#4444).

- `@ifc-lite/collab`: new top-level `models` map and `doc/model-slot` helpers (`modelSlotRef`, `slotPath`, `pathInSlot`, `prefixPathForSlot`, `createModelSlot`, `listModelSlots`, …). `seedFromStep` / `seedFromIfcx` accept a `slot` option that qualifies every entity path with `/<slotId>` (children and inherits references included); `snapshotToIfcx` accepts `slot` to emit one slot's entities. Slot ids are minted in share order, never from a file name, its bytes or its GlobalIds, so two copies of one file are two slots. Rooms seeded before slots existed keep their unqualified `/<GlobalId>` paths and are read as one implicit legacy slot — no migration, nothing on disk is rewritten.
- Viewer: with several models loaded, the Share dialog asks whether to share the active model only or all loaded models (default: all — the workspace on screen is the federation) and creates the room only on **Create link**, since a room's scope is fixed by its seed. Each model is seeded from its own store and meshes into its own slot, one after another; `collabSeedProgress` carries `modelIndex` / `modelCount` and the upload row reads "model 2 of 3". A recipient reconstructs one federated model per slot (`room:<roomId>:<slotId>`), registered through the federation registry in its own global-id range, so two copies of one file — same GlobalIds, same local express ids — are two selectable, editable, exportable models with their own geometry and textures. Inbound peer edits are routed to the model their path's slot names; outbound mirrors gate per model.
