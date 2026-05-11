# @ifc-lite/collab

## 0.1.0

### Minor Changes

- Initial release. v0.1 Foundation per `docs/architecture/collab-plan.md`:
  - Y.Doc schema with `entities`, `relationships`, `geometry` top-level maps.
  - IFCX seed (`from-ifcx`) and snapshot (`to-ifcx`) round-trip.
  - Per-user layer extraction.
  - IndexedDB and websocket providers.
  - Awareness / presence helpers (3D + 2D cursors, selection, camera).
  - Y.UndoManager wrapper scoped to local origin.
  - Conflict detector + UI-bridge event emitter.
  - `createCollabSession` public API binding the above together.
