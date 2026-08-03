---
'@ifc-lite/mutations': minor
---

`deleteEntity` now tombstones an overlay-created entity as well as forgetting it (#2012).

It used to only remove the entity from the new-entity list, which made `isDeleted()` answer `false` for something that no longer exists. Every consumer that asks "was this deleted" therefore got the wrong answer about a created-then-deleted entity, and could only work around it by asking a different question instead — which is what `StepExporter` does on main today, and what its comment says it is doing.

The entity is still dropped from `getNewEntities()`, so something created and deleted in one session is emitted nowhere. `restoreNewEntity` lifts the tombstone, so undo of a delete is still a complete inverse.

`getTombstones()` now names created-and-deleted ids as well as source ones. A consumer that counts entities must intersect it with the store's own index rather than subtracting its size, or a created-then-deleted entity is subtracted twice.
