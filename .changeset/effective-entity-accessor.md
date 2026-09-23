---
"@ifc-lite/data": minor
---

Add `effectiveEntityIds` and `effectiveEntityIdsOfType`, the shared effective-entity enumeration for a live model session (#5249). Given a store's entity index and its mutation overlay (a `MutablePropertyView`, or any object with the same `getTombstones`/`getNewEntities`/`getTypeMutations` shape, such as a worker snapshot), they list every source entity except tombstoned ones plus every overlay-created entity exactly once, with retyped entities under their new class. A created-then-deleted entity is absent. Order is deterministic: source order, then overlay additions by ascending express id.
